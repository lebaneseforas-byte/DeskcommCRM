/**
 * `data.request` no webhook de saída — o pedido do cliente, só por opt-in.
 *
 * Medido pelo corpo que chega a um receptor HTTP de verdade (mesmo método de
 * `call-webhook.test.ts`), com o banco dublado por tabela. Cada consulta é
 * registrada para provar o filtro de organização.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { executeCallWebhook } from "@/lib/automation/actions/call-webhook";
import {
  canalDoPedido,
  LIMITES_DO_PEDIDO,
  pedidoPublico,
  textoDoPedido,
} from "@/lib/automation/actions/pedido-do-webhook";
import type { ActionCtx } from "@/lib/automation/types";

const ORG = "org-1";
const CONTATO = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const CONVERSA_DO_EVENTO = "33333333-3333-4333-8333-333333333333";

type Linhas = Record<string, unknown>;
interface Banco {
  leads?: Linhas | null;
  conversas?: Record<string, Linhas | null>; // por id; "_recente" = a mais recente do contato
  mensagens?: Linhas[];
  quebra?: boolean;
}

/** Dublê do supabase: devolve por tabela e registra cada filtro aplicado. */
function admin(b: Banco, consultas: Array<{ tabela: string; filtros: Record<string, unknown> }>) {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      consultas.push({ tabela, filtros });
      const resolver = () => {
        if (b.quebra) throw new Error("banco fora");
        if (tabela === "crm_leads") return { data: b.leads ?? null, error: null };
        if (tabela === "conversations") {
          const id = filtros.id as string | undefined;
          return { data: (id ? b.conversas?.[id] : b.conversas?._recente) ?? null, error: null };
        }
        if (tabela === "messages") return { data: b.mensagens ?? [], error: null };
        return { data: null, error: null };
      };
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        eq: (c: string, v: unknown) => {
          filtros[c] = v;
          return cadeia;
        },
        order: () => cadeia,
        limit: () => cadeia,
        maybeSingle: async () => resolver(),
        then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) =>
          Promise.resolve().then(resolver).then(ok, erro),
      };
      return cadeia;
    },
  } as unknown as ActionCtx["admin"];
}

function ctxDeEtiqueta(b: Banco, consultas: Array<{ tabela: string; filtros: Record<string, unknown> }>, payload: Record<string, unknown> = {}): ActionCtx {
  return {
    admin: admin(b, consultas),
    organizationId: ORG,
    ruleId: "rule-1",
    ruleName: "Pedido para o sistema de operações",
    requestId: "req-1",
    event: {
      id: "evt-1",
      organization_id: ORG,
      event_type: "contact.tag_added",
      entity_kind: "contact",
      entity_id: CONTATO,
      payload: { added_tags: ["projeto"], ...payload },
      metadata: {},
      consumed_by: [],
      attempts: 0,
    },
    context: { contact: { id: CONTATO, name: null, display_name: "Wb" } },
  };
}

const BANCO_COMPLETO: Banco = {
  leads: { title: "Outdoor green wall – Baabda", description: "Project: green wall 4 m × 2.5 m, outdoor, afternoon sun." },
  conversas: { _recente: { id: CONVERSA, channel: "whatsapp" } },
  mensagens: [{ body: "About 4 m wide and 2.5 m high", media_derived_text: null }],
};

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function corpo(ctx: ActionCtx, config: Record<string, unknown>): Promise<Record<string, unknown>> {
  let body = "";
  server = createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on("data", (c) => partes.push(c));
    req.on("end", () => {
      body = Buffer.concat(partes).toString("utf8");
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const end = server.address();
  const porta = typeof end === "object" && end ? end.port : 0;
  const r = await executeCallWebhook(ctx, { url: `http://127.0.0.1:${porta}/hook`, ...config }, { skipUrlCheck: true });
  expect(r.status).toBe("success");
  return JSON.parse(body).data as Record<string, unknown>;
}

describe("data.request no corpo do webhook", () => {
  it("sem include_request, a chave não nasce e o banco nem é consultado", async () => {
    const consultas: Array<{ tabela: string; filtros: Record<string, unknown> }> = [];
    const data = await corpo(ctxDeEtiqueta(BANCO_COMPLETO, consultas), {});
    expect(data).not.toHaveProperty("request");
    expect(consultas).toEqual([]);
  });

  it("com include_request, etiqueta de CONTATO leva título, resumo, última mensagem, canal e conversa", async () => {
    const consultas: Array<{ tabela: string; filtros: Record<string, unknown> }> = [];
    const data = await corpo(ctxDeEtiqueta(BANCO_COMPLETO, consultas), { include_request: true });
    expect(data.request).toEqual({
      title: "Outdoor green wall – Baabda",
      summary: "Project: green wall 4 m × 2.5 m, outdoor, afternoon sun.",
      last_message: "About 4 m wide and 2.5 m high",
      channel: "whatsapp",
      conversation_id: CONVERSA,
    });
    // O contato e o resto do envelope continuam como antes.
    expect(data.contact).toMatchObject({ id: CONTATO, display_name: "Wb" });
  });

  it("toda consulta filtra a organização da regra", async () => {
    const consultas: Array<{ tabela: string; filtros: Record<string, unknown> }> = [];
    await pedidoPublico(ctxDeEtiqueta(BANCO_COMPLETO, consultas), { include_request: true });
    expect(consultas.length).toBeGreaterThanOrEqual(3);
    for (const c of consultas) expect(c.filtros.organization_id, c.tabela).toBe(ORG);
    // O negócio escolhido é o ABERTO do contato.
    expect(consultas.find((c) => c.tabela === "crm_leads")!.filtros).toMatchObject({ contact_id: CONTATO, status: "open" });
  });

  it("a conversa do evento vence a mais recente do contato", async () => {
    const consultas: Array<{ tabela: string; filtros: Record<string, unknown> }> = [];
    const b: Banco = { ...BANCO_COMPLETO, conversas: { [CONVERSA_DO_EVENTO]: { id: CONVERSA_DO_EVENTO, channel: "instagram" }, _recente: { id: CONVERSA, channel: "whatsapp" } } };
    const r = await pedidoPublico(ctxDeEtiqueta(b, consultas, { conversation_id: CONVERSA_DO_EVENTO }), { include_request: true });
    expect(r).toMatchObject({ conversation_id: CONVERSA_DO_EVENTO, channel: "instagram" });
  });

  it("mensagem sem texto é pulada; mídia transcrita conta", async () => {
    const consultas: Array<{ tabela: string; filtros: Record<string, unknown> }> = [];
    const b: Banco = { ...BANCO_COMPLETO, mensagens: [{ body: "  ", media_derived_text: null }, { body: null, media_derived_text: "I want an olive tree for the garden" }] };
    const r = await pedidoPublico(ctxDeEtiqueta(b, consultas), { include_request: true });
    expect(r?.last_message).toBe("I want an olive tree for the garden");
  });

  it("o negócio do contexto é usado sem consulta a crm_leads", async () => {
    const consultas: Array<{ tabela: string; filtros: Record<string, unknown> }> = [];
    const ctx = ctxDeEtiqueta(BANCO_COMPLETO, consultas);
    ctx.context.lead = { id: "lead-1", contact_id: CONTATO, title: "Neon sign – Jounieh", description: null };
    const r = await pedidoPublico(ctx, { include_request: true });
    expect(r?.title).toBe("Neon sign – Jounieh");
    expect(r).not.toHaveProperty("summary");
    expect(consultas.some((c) => c.tabela === "crm_leads")).toBe(false);
  });

  it("banco fora do ar: a entrega sai mesmo assim, sem a chave", async () => {
    const consultas: Array<{ tabela: string; filtros: Record<string, unknown> }> = [];
    const data = await corpo(ctxDeEtiqueta({ ...BANCO_COMPLETO, quebra: true }, consultas), { include_request: true });
    expect(data).not.toHaveProperty("request");
  });

  it("contato sem negócio nem conversa: nada a dizer, a chave não nasce", async () => {
    const consultas: Array<{ tabela: string; filtros: Record<string, unknown> }> = [];
    const r = await pedidoPublico(ctxDeEtiqueta({ leads: null, conversas: {}, mensagens: [] }, consultas), { include_request: true });
    expect(r).toBeUndefined();
  });
});

describe("forma dos campos", () => {
  it("canal fora do vocabulário vira other", () => {
    expect(canalDoPedido("whatsapp")).toBe("whatsapp");
    expect(canalDoPedido("instagram")).toBe("instagram");
    expect(canalDoPedido("facebook")).toBe("facebook");
    expect(canalDoPedido("telegram")).toBe("other");
    expect(canalDoPedido(null)).toBe("other");
  });

  it("texto longo é cortado dentro do limite do contrato", () => {
    const longo = "a".repeat(5000);
    const cortado = textoDoPedido(longo, LIMITES_DO_PEDIDO.summary)!;
    expect(cortado.length).toBeLessThanOrEqual(LIMITES_DO_PEDIDO.summary);
    expect(cortado.endsWith("…")).toBe(true);
    expect(textoDoPedido("  curto  ", LIMITES_DO_PEDIDO.title)).toBe("curto");
    expect(textoDoPedido("   ", 10)).toBeNull();
  });
});
