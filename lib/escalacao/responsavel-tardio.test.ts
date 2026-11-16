/**
 * `completarResponsavel` — a passagem viva sem responsável ganha um na
 * varredura, sem sobrescrever ninguém e auditando só o que gravou.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const audit = vi.hoisted(() => vi.fn(async (_entrada: Record<string, unknown>) => undefined));
vi.mock("@/lib/audit", () => ({ audit }));

import type { PassagemLida } from "@/lib/escalacao/escalonamento-da-passagem";
import { completarResponsavel } from "@/lib/escalacao/responsavel-tardio";

const ORG = "11111111-1111-4111-8111-111111111111";
const WALID = "22222222-2222-4222-8222-222222222222";
const OUTRA = "33333333-3333-4333-8333-333333333333";

function lida(sobre: Partial<PassagemLida> = {}): PassagemLida {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    organization_id: ORG,
    conversation_id: "55555555-5555-4555-8555-555555555555",
    contact_id: "66666666-6666-4666-8666-666666666666",
    estado: "pendente",
    urgente: false,
    responsavel_user_id: null,
    lembretes_enviados: 1,
    ultimo_lembrete_em: null,
    escalada_em: null,
    criado_em: "2026-11-16T19:04:40Z",
    ...sobre,
  };
}

interface Cena {
  rpc?: { data: unknown; error: unknown };
  gravada?: Record<string, unknown> | null;
  lanca?: boolean;
}

function admin(c: Cena) {
  const chamadas = { rpc: [] as unknown[], update: [] as unknown[], filtros: {} as Record<string, unknown> };
  const cadeia: Record<string, unknown> = {
    update: (v: unknown) => {
      chamadas.update.push(v);
      return cadeia;
    },
    eq: (k: string, v: unknown) => {
      chamadas.filtros[k] = v;
      return cadeia;
    },
    is: (k: string, v: unknown) => {
      chamadas.filtros[`is:${k}`] = v;
      return cadeia;
    },
    in: (k: string, v: unknown) => {
      chamadas.filtros[`in:${k}`] = v;
      return cadeia;
    },
    select: () => cadeia,
    maybeSingle: async () => ({ data: c.gravada ?? null, error: null }),
  };
  return {
    chamadas,
    cliente: {
      rpc: async (nome: string, args: unknown) => {
        if (c.lanca) throw new Error("rede");
        chamadas.rpc.push([nome, args]);
        return c.rpc ?? { data: null, error: null };
      },
      from: () => cadeia,
    } as never,
  };
}

beforeEach(() => audit.mockClear());

describe("completarResponsavel", () => {
  it("já tem responsável: não pergunta nada", async () => {
    const a = admin({});
    const l = lida({ responsavel_user_id: OUTRA, estado: "atribuida" });
    expect(await completarResponsavel(a.cliente, l, "req")).toBe(l);
    expect(a.chamadas.rpc).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem responsável e a rota acha Walid: grava com CAS, vira atribuída e audita", async () => {
    const a = admin({ rpc: { data: WALID, error: null }, gravada: { responsavel_user_id: WALID, estado: "atribuida" } });
    const r = await completarResponsavel(a.cliente, lida(), "req-1");
    expect(r.responsavel_user_id).toBe(WALID);
    expect(r.estado).toBe("atribuida");
    expect(a.chamadas.rpc[0]).toEqual([
      "fn_passagem_responsavel_inicial",
      { p_organization_id: ORG, p_conversation_id: lida().conversation_id, p_contact_id: lida().contact_id },
    ]);
    expect(a.chamadas.update[0]).toEqual({ responsavel_user_id: WALID, estado: "atribuida" });
    expect(a.chamadas.filtros).toMatchObject({ organization_id: ORG, "is:responsavel_user_id": null });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toMatchObject({ action: "handoff.responsible_assigned", organizationId: ORG });
  });

  it("reaberta continua reaberta", async () => {
    const a = admin({ rpc: { data: WALID, error: null }, gravada: { responsavel_user_id: WALID, estado: "reaberta" } });
    await completarResponsavel(a.cliente, lida({ estado: "reaberta" }), "req");
    expect(a.chamadas.update[0]).toEqual({ responsavel_user_id: WALID, estado: "reaberta" });
  });

  it("alguém decidiu no meio-tempo (CAS perdido): não sobrescreve nem audita", async () => {
    const a = admin({ rpc: { data: WALID, error: null }, gravada: null });
    const l = lida();
    expect(await completarResponsavel(a.cliente, l, "req")).toBe(l);
    expect(audit).not.toHaveBeenCalled();
  });

  it("a rota não acha ninguém: nada é gravado", async () => {
    const a = admin({ rpc: { data: null, error: null } });
    const l = lida();
    expect(await completarResponsavel(a.cliente, l, "req")).toBe(l);
    expect(a.chamadas.update).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("erro ou valor torto da função: devolve como estava, nunca lança", async () => {
    for (const cena of [{ rpc: { data: null, error: { message: "x" } } }, { rpc: { data: "não-uuid", error: null } }, { lanca: true }]) {
      const a = admin(cena);
      const l = lida();
      await expect(completarResponsavel(a.cliente, l, "req")).resolves.toBe(l);
    }
    expect(audit).not.toHaveBeenCalled();
  });
});
