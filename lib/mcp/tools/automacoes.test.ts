/**
 * Regras automáticas pelo MCP — as três travas que o MCP põe a mais sobre a
 * régua da tela: ação que sai da empresa é recusada, a regra nasce pausada e
 * esta ferramenta nunca a liga, e gatilho/condições/ações só mudam com a regra
 * pausada. A régua da tela (`escrita-da-regra`) é exercitada pelas rotas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpContext } from "../types";

const h = vi.hoisted(() => ({
  chamadas: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  gravada: {
    id: "r1",
    is_active: false,
    trigger_event: "lead.created",
    trigger_config: {},
    actions: [],
    conditions: [],
  },
  linha: null as unknown,
}));

vi.mock("@/lib/automation/escrita-da-regra", () => ({
  criarRegra: async (_db: unknown, args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "criarRegra", args });
    return { ok: true, regra: { id: "r-nova", is_active: false } };
  },
  lerRegraGravada: async () => ({ ok: true, regra: h.gravada }),
  atualizarRegra: async (_db: unknown, args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "atualizarRegra", args });
    return { ok: true, regra: { id: "r1", is_active: h.gravada.is_active } };
  },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const REGRA = "44444444-4444-4444-8444-444444444444";
const ETIQUETA = { type: "add_tag", config: { tags: ["vip"] } };

function ctx(): McpContext {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => ({ data: h.linha, error: null });
  return {
    organizationId: ORG,
    role: "admin",
    actor: { type: "api_token", id: "tok", role: "admin" },
    apiTokenId: "tok",
    requestId: "req",
    supabase: { from: () => chain } as unknown as McpContext["supabase"],
  } as McpContext;
}

beforeEach(() => {
  h.chamadas = [];
  h.gravada = {
    id: "r1",
    is_active: false,
    trigger_event: "lead.created",
    trigger_config: {},
    actions: [],
    conditions: [],
  };
  h.linha = null;
});

describe("ações que saem da empresa", () => {
  it("webhook e e-mail para endereço fixo são as únicas que saem", async () => {
    const { acoesQueSaemDaEmpresa } = await import("./automacoes");
    expect(
      acoesQueSaemDaEmpresa([
        ETIQUETA,
        { type: "call_webhook", config: { url: "https://fora.exemplo" } },
        { type: "send_email", config: { destinatario: "fixo", email_fixo: "x@fora.exemplo" } },
        { type: "send_email", config: { destinatario: "contato" } },
        { type: "send_whatsapp_message", config: {} },
      ]),
    ).toEqual(["actions.1 (call_webhook)", "actions.2 (send_email to a fixed address)"]);
  });

  it("criar com webhook é recusado antes de qualquer gravação", async () => {
    const { crmCreateAutomationRule } = await import("./automacoes");
    const r = (await crmCreateAutomationRule.handler(
      {
        name: "Manda pra fora",
        trigger_event: "lead.created",
        actions: [{ type: "call_webhook", config: { url: "https://x" } }],
      },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("acao_externa_so_pela_tela");
    expect(h.chamadas).toHaveLength(0);
  });

  it("alterar trocando as ações por um e-mail fixo é recusado", async () => {
    const { crmUpdateAutomationRule } = await import("./automacoes");
    const r = (await crmUpdateAutomationRule.handler(
      {
        rule_id: REGRA,
        actions: [{ type: "send_email", config: { destinatario: "fixo", email_fixo: "a@b.co" } }],
      },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("acao_externa_so_pela_tela");
    expect(h.chamadas).toHaveLength(0);
  });
});

describe("criar", () => {
  it("nasce pausada, na organização do contexto, com o token como autor", async () => {
    const { crmCreateAutomationRule } = await import("./automacoes");
    const r = (await crmCreateAutomationRule.handler(
      { name: "Marca VIP", trigger_event: "lead.created", actions: [ETIQUETA] },
      ctx(),
    )) as Record<string, unknown>;
    expect(r).toMatchObject({ rule_id: "r-nova", ligada: false });
    const { args } = h.chamadas[0]!;
    expect(args.orgId).toBe(ORG);
    expect(args.ator).toMatchObject({ apiTokenId: "tok", requestId: "req" });
    expect(args.regra).not.toHaveProperty("is_active");
  });

  it("regra fora da régua da tela volta com o campo", async () => {
    const { crmCreateAutomationRule } = await import("./automacoes");
    const r = (await crmCreateAutomationRule.handler(
      { name: "X", trigger_event: "evento.que.nao.existe" as "lead.created", actions: [ETIQUETA] },
      ctx(),
    )) as { erro: string; problemas: Array<{ campo: string }> };
    expect(r.erro).toBe("regra_invalida");
    expect(r.problemas.map((p) => p.campo)).toContain("trigger_event");
  });
});

describe("alterar", () => {
  it("o esquema não tem interruptor: is_active não entra", async () => {
    const { crmUpdateAutomationRule } = await import("./automacoes");
    expect(Object.keys(crmUpdateAutomationRule.inputSchema)).not.toContain("is_active");
  });

  it("regra LIGADA: renomear passa, mexer nas ações não", async () => {
    h.gravada = { ...h.gravada, is_active: true };
    const { crmUpdateAutomationRule } = await import("./automacoes");
    const acoes = (await crmUpdateAutomationRule.handler(
      { rule_id: REGRA, actions: [ETIQUETA] },
      ctx(),
    )) as Record<string, unknown>;
    expect(acoes.erro).toBe("regra_ligada");
    expect(h.chamadas).toHaveLength(0);

    const nome = (await crmUpdateAutomationRule.handler(
      { rule_id: REGRA, name: "Novo nome" },
      ctx(),
    )) as Record<string, unknown>;
    expect(nome).toMatchObject({ campos_salvos: ["name"], ligada: true });
    expect(h.chamadas[0]!.args).toMatchObject({
      orgId: ORG,
      id: REGRA,
      patch: { name: "Novo nome" },
    });
  });

  it("regra pausada: troca as ações", async () => {
    const { crmUpdateAutomationRule } = await import("./automacoes");
    const r = (await crmUpdateAutomationRule.handler(
      { rule_id: REGRA, actions: [ETIQUETA] },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.campos_salvos).toEqual(["actions"]);
  });

  it("pedido vazio é recusado", async () => {
    const { crmUpdateAutomationRule } = await import("./automacoes");
    const r = (await crmUpdateAutomationRule.handler({ rule_id: REGRA }, ctx())) as Record<
      string,
      unknown
    >;
    expect(r.erro).toBe("pedido_vazio");
  });
});

describe("ler", () => {
  it("devolve as ações sem segredo", async () => {
    h.linha = {
      id: REGRA,
      actions: [
        {
          type: "call_webhook",
          config: { url: "https://x", secret_enc: "cifrado", secret: "claro" },
        },
      ],
    };
    const { crmGetAutomationRule } = await import("./automacoes");
    const r = (await crmGetAutomationRule.handler({ rule_id: REGRA }, ctx())) as {
      regra: { actions: Array<{ config: Record<string, unknown> }> };
    };
    expect(r.regra.actions[0]!.config).toEqual({ url: "https://x" });
  });
});
