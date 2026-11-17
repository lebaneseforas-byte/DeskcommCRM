/**
 * Follow-ups e respostas prontas pelo MCP: a organização sai do CONTEXTO, o
 * autor é o token, o rascunho inválido volta com o caminho do campo SEM gravar,
 * e resposta pronta pelo MCP é sempre compartilhada (nunca alcança a pessoal).
 * As regras de publicar/salvar são de `lib/followup/escrita-do-fluxo.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpContext } from "../types";

const h = vi.hoisted(() => ({
  chamadas: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  resultado: null as unknown,
  filtros: [] as Array<[string, string, unknown]>,
  linha: { id: "t1" } as unknown,
}));

vi.mock("@/lib/followup/escrita-do-fluxo", () => ({
  criarFluxo: async (_db: unknown, args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "criarFluxo", args });
    return h.resultado ?? { ok: true, fluxo: { id: "f1", status: "draft" } };
  },
  salvarFluxo: async (_db: unknown, args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "salvarFluxo", args });
    return h.resultado ?? { ok: true, fluxo: { id: "f1", status: "draft" } };
  },
  publicarFluxo: async (_db: unknown, args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "publicarFluxo", args });
    return (
      h.resultado ?? {
        ok: true,
        data: { id: "f1", status: "active", active_version_id: "v1", avisos: [] },
      }
    );
  },
  desligarFluxo: async (_db: unknown, args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "desligarFluxo", args });
    return h.resultado ?? { ok: true, data: { id: "f1", status: "disabled" } };
  },
}));
vi.mock("@/lib/followup/editar", () => ({
  carregarFluxoParaEdicao: async (_db: unknown, args: { orgId: string; id: string }) => {
    h.chamadas.push({ fn: "carregarFluxoParaEdicao", args });
    return h.resultado ?? null;
  },
}));
vi.mock("@/lib/templates/escrita-da-resposta", () => ({
  COLUNAS_DA_RESPOSTA: "id",
  criarRespostaRapida: async (_db: unknown, args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "criarRespostaRapida", args });
    return { id: "t1", title: args.title };
  },
}));
vi.mock("@/lib/templates/grupo-da-resposta", () => ({
  grupoDaOrganizacao: async (_db: unknown, _org: string, grupo: string | null | undefined) =>
    grupo === undefined || grupo === null || grupo === "g-da-org",
}));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

const ORG = "11111111-1111-4111-8111-111111111111";
const FLUXO = "33333333-3333-4333-8333-333333333333";

function ctx(): McpContext {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "update", "order"]) chain[m] = () => chain;
  chain.eq = (k: string, v: unknown) => {
    h.filtros.push(["eq", k, v]);
    return chain;
  };
  chain.is = (k: string, v: unknown) => {
    h.filtros.push(["is", k, v]);
    return chain;
  };
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
  h.resultado = null;
  h.filtros = [];
  h.linha = { id: "t1" };
});

describe("sequências de follow-up pelo MCP", () => {
  it("abrir um fluxo lê pela organização do contexto; de fora é 'não encontrado'", async () => {
    const { crmGetFollowupFlow } = await import("./sequencias");
    const r = (await crmGetFollowupFlow.handler({ flow_id: FLUXO }, ctx())) as Record<
      string,
      unknown
    >;
    expect(h.chamadas[0]!.args).toEqual({ orgId: ORG, id: FLUXO });
    expect(r.erro).toBe("fluxo_nao_encontrado");
  });

  it("rascunho com desenho inválido volta com o campo e NÃO grava", async () => {
    const { crmSaveFollowupFlowDraft } = await import("./sequencias");
    const r = (await crmSaveFollowupFlowDraft.handler(
      { flow_id: FLUXO, draft_graph: { nodes: "isto não é uma lista" } },
      ctx(),
    )) as { erro: string; problemas: Array<{ campo: string }> };
    expect(r.erro).toBe("rascunho_invalido");
    expect(r.problemas.some((p) => p.campo.startsWith("draft_graph"))).toBe(true);
    expect(h.chamadas).toHaveLength(0);
  });

  it("rascunho válido salva na organização do contexto, com o token como autor", async () => {
    const { crmSaveFollowupFlowDraft } = await import("./sequencias");
    const r = (await crmSaveFollowupFlowDraft.handler(
      {
        flow_id: FLUXO,
        nome: "Retomada 3 dias",
        handoff_policy: "pause",
        trigger_config: { kind: "manual" },
      },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.campos_salvos).toEqual(
      expect.arrayContaining(["name", "trigger_config", "handoff_policy"]),
    );
    const { args } = h.chamadas[0]!;
    expect(args).toMatchObject({
      orgId: ORG,
      id: FLUXO,
      ator: { userId: null, apiTokenId: "tok", requestId: "req" },
    });
  });

  it("pedido vazio é recusado sem gravar", async () => {
    const { crmSaveFollowupFlowDraft } = await import("./sequencias");
    const r = (await crmSaveFollowupFlowDraft.handler({ flow_id: FLUXO }, ctx())) as Record<
      string,
      unknown
    >;
    expect(r.erro).toBe("pedido_vazio");
    expect(h.chamadas).toHaveLength(0);
  });

  it("publicar recusado devolve os problemas da validação da tela", async () => {
    h.resultado = {
      ok: false,
      codigo: "validation_failed",
      mensagem: "Fluxo reprovado na validação de publish.",
      erros: [{ node_id: "n1", code: "orphan", message: "Passo solto." }],
    };
    const { crmPublishFollowupFlow } = await import("./sequencias");
    const r = (await crmPublishFollowupFlow.handler({ flow_id: FLUXO }, ctx())) as Record<
      string,
      unknown
    >;
    expect(r).toEqual({
      erro: "validation_failed",
      mensagem: "Fluxo reprovado na validação de publish.",
      problemas: [{ node_id: "n1", code: "orphan", message: "Passo solto." }],
    });
  });

  it("publicar e desligar usam a organização do contexto", async () => {
    const m = await import("./sequencias");
    const pub = (await m.crmPublishFollowupFlow.handler({ flow_id: FLUXO }, ctx())) as Record<
      string,
      unknown
    >;
    expect(pub.versao_no_ar).toBe("v1");
    await m.crmDisableFollowupFlow.handler({ flow_id: FLUXO }, ctx());
    expect(h.chamadas.map((c) => [c.fn, c.args.orgId, c.args.id])).toEqual([
      ["publicarFluxo", ORG, FLUXO],
      ["desligarFluxo", ORG, FLUXO],
    ]);
  });
});

describe("respostas prontas pelo MCP", () => {
  it("criar é sempre COMPARTILHADA e sem pessoa como autora", async () => {
    const { crmCreateMessageTemplate } = await import("./sequencias");
    await crmCreateMessageTemplate.handler(
      { title: "Boas-vindas", body: "Olá {{primeiro_nome}}!" },
      ctx(),
    );
    expect(h.chamadas[0]!.args).toMatchObject({
      orgId: ORG,
      donoUserId: null,
      criadorUserId: null,
      apiTokenId: "tok",
      title: "Boas-vindas",
    });
  });

  it("grupo de outra organização é recusado sem gravar", async () => {
    const { crmCreateMessageTemplate } = await import("./sequencias");
    const r = (await crmCreateMessageTemplate.handler(
      { title: "X", body: "Y", grupo_id: "g-de-outra-org" },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("grupo_invalido");
    expect(h.chamadas).toHaveLength(0);
  });

  it("alterar só alcança a COMPARTILHADA desta organização", async () => {
    const { crmUpdateMessageTemplate } = await import("./sequencias");
    const r = (await crmUpdateMessageTemplate.handler(
      { template_id: FLUXO, body: "Texto novo" },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.campos_salvos).toEqual(["body"]);
    expect(h.filtros).toEqual(
      expect.arrayContaining([
        ["eq", "organization_id", ORG],
        ["eq", "id", FLUXO],
        ["is", "owner_user_id", null],
      ]),
    );

    h.linha = null; // a pessoal (ou de outra org) não volta do update
    const fora = (await crmUpdateMessageTemplate.handler(
      { template_id: FLUXO, title: "T" },
      ctx(),
    )) as Record<string, unknown>;
    expect(fora.erro).toBe("resposta_nao_encontrada");
  });

  it("alterar sem campo é recusado", async () => {
    const { crmUpdateMessageTemplate } = await import("./sequencias");
    const r = (await crmUpdateMessageTemplate.handler({ template_id: FLUXO }, ctx())) as Record<
      string,
      unknown
    >;
    expect(r.erro).toBe("pedido_invalido");
  });
});
