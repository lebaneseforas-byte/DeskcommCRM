/**
 * Campanhas pelo MCP: toda ação passa pelo MESMO despacho da tela
 * (`executarAcaoDaCampanha`), na organização do contexto e com o token como
 * autor; o rascunho fora da régua volta com o campo SEM gravar; e duplicar —
 * que leva autor pessoa — não existe por aqui.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpContext } from "../types";

const h = vi.hoisted(() => ({
  chamadas: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  resultado: null as unknown,
}));

vi.mock("@/lib/campanhas/executar-acao", () => ({
  executarAcaoDaCampanha: async (_db: unknown, args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "executarAcaoDaCampanha", args });
    return h.resultado ?? { ok: true, data: { status: "running" } };
  },
}));
vi.mock("@/lib/campanhas/criar-campanha", () => ({
  COLUNAS_DA_LISTA_DE_CAMPANHAS: "id",
  criarCampanha: async (_db: unknown, args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "criarCampanha", args });
    return { ok: true, campanha: { id: "c1", status: "draft" } };
  },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CAMPANHA = "77777777-7777-4777-8777-777777777777";
const CANAL = "88888888-8888-4888-8888-888888888888";

function ctx(): McpContext {
  return {
    organizationId: ORG,
    role: "admin",
    actor: { type: "api_token", id: "tok", role: "admin" },
    apiTokenId: "tok",
    requestId: "req",
    supabase: {} as McpContext["supabase"],
  } as McpContext;
}

beforeEach(() => {
  h.chamadas = [];
  h.resultado = null;
});

describe("ações de campanha", () => {
  it("cada ferramenta pede a ação certa ao despacho da tela, na organização do contexto", async () => {
    const m = await import("./campanhas");
    await m.crmPrepareCampaign.handler({ campaign_id: CAMPANHA }, ctx());
    await m.crmStartCampaign.handler({ campaign_id: CAMPANHA }, ctx());
    await m.crmPauseCampaign.handler({ campaign_id: CAMPANHA }, ctx());
    await m.crmCancelCampaign.handler({ campaign_id: CAMPANHA }, ctx());
    await m.crmTestCampaign.handler({ campaign_id: CAMPANHA, contact_id: CANAL }, ctx());
    await m.crmScheduleCampaign.handler(
      { campaign_id: CAMPANHA, scheduled_at: "2026-12-01T10:00:00-03:00" },
      ctx(),
    );
    expect(h.chamadas.map((c) => [c.args.acao, c.args.orgId, c.args.campanhaId])).toEqual([
      ["preparar", ORG, CAMPANHA],
      ["iniciar", ORG, CAMPANHA],
      ["pausar", ORG, CAMPANHA],
      ["cancelar", ORG, CAMPANHA],
      ["testar", ORG, CAMPANHA],
      ["agendar", ORG, CAMPANHA],
    ]);
    expect(h.chamadas[4]!.args.corpo).toEqual({ contact_id: CANAL });
    expect(h.chamadas[5]!.args.corpo).toEqual({ scheduled_at: "2026-12-01T10:00:00-03:00" });
    for (const c of h.chamadas) {
      expect(c.args.ator).toEqual({ userId: null, apiTokenId: "tok", requestId: "req" });
    }
  });

  it("a recusa da máquina de estados volta com o código dela", async () => {
    h.resultado = {
      ok: false,
      codigo: "campanha_estado_invalido",
      mensagem: "Prepare antes de iniciar.",
      status: 409,
    };
    const { crmStartCampaign } = await import("./campanhas");
    const r = await crmStartCampaign.handler({ campaign_id: CAMPANHA }, ctx());
    expect(r).toEqual({ erro: "campanha_estado_invalido", mensagem: "Prepare antes de iniciar." });
  });

  it("duplicar não existe pelo aplicativo conectado", async () => {
    const m = (await import("./campanhas")) as Record<string, unknown>;
    expect(Object.keys(m).some((k) => /duplic/i.test(k))).toBe(false);
  });
});

describe("rascunho", () => {
  it("fora da régua da tela volta com o campo e não grava", async () => {
    const { crmCreateCampaignDraft } = await import("./campanhas");
    const r = (await crmCreateCampaignDraft.handler(
      // Interesse legítimo sem a referência da avaliação (LIA).
      {
        name: "Black Friday",
        channel_session_id: CANAL,
        message_body: "Oi!",
        base_legal: "legitimate_interest",
      } as never,
      ctx(),
    )) as { erro: string; problemas: Array<{ campo: string }> };
    expect(r.erro).toBe("campanha_invalida");
    expect(r.problemas.map((p) => p.campo)).toContain("lia_ref");
    expect(h.chamadas).toHaveLength(0);
  });

  it("válido nasce rascunho, sem pessoa como autora", async () => {
    const { crmCreateCampaignDraft } = await import("./campanhas");
    const r = (await crmCreateCampaignDraft.handler(
      {
        name: "Black Friday",
        channel_session_id: CANAL,
        message_body: "Oi!",
        base_legal: "consent",
      } as never,
      ctx(),
    )) as Record<string, unknown>;
    expect(r).toEqual({ campaign_id: "c1", status: "draft" });
    expect(h.chamadas[0]!.args).toMatchObject({ orgId: ORG, autorUserId: null, apiTokenId: "tok" });
  });
});
