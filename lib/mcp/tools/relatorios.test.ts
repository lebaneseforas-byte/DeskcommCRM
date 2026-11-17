/**
 * As ferramentas de relatório do dia: a organização sai do contexto, o dia no
 * futuro é recusado antes de ler, e o relatório salvo inexistente diz o
 * caminho. As regras (montar o dia, hidratar, o texto) são de `lib/operacao/`
 * e têm testes próprios; aqui só a tradução.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpContext } from "../types";

const h = vi.hoisted(() => ({ montado: [] as Array<{ orgId: string; dia: string }>, filtros: [] as Array<[string, unknown]> }));

vi.mock("@/lib/operacao/relatorio-diario", () => ({
  TABELA_DOS_RELATORIOS: "relatorios_operacao_diarios",
  contextoDaOrganizacao: async () => ({ fuso: "Asia/Beirut", idioma: "pt-BR", config: {} }),
  urlPublicaDoApp: () => "https://crm.exemplo.com",
}));
vi.mock("@/lib/operacao/operacao-do-dia", () => ({
  montarOperacaoDoDia: async (e: { orgId: string; dia: string }) => {
    h.montado.push({ orgId: e.orgId, dia: e.dia });
    return { dia: e.dia, fuso: "Asia/Beirut", contadores: { novas: { total: 3 } }, aguardando: [1, 2] };
  },
  nomesPelaFuncao: () => async () => new Map(),
}));
vi.mock("@/lib/operacao/texto-do-relatorio", () => ({ textoDoRelatorio: () => "Operação do dia — texto" }));
vi.mock("@/lib/operacao/conteudo", () => ({ lerConteudo: (c: unknown) => c, hidratar: async (c: unknown) => c }));
vi.mock("@/lib/operacao/hidratar-do-banco", () => ({ leitorDoBanco: () => ({}) }));

const ORG = "11111111-1111-4111-8111-111111111111";

function ctx(linha: unknown = null): McpContext {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.order = () => chain;
  chain.limit = () => chain;
  chain.eq = (k: string, v: unknown) => {
    h.filtros.push([k, v]);
    return chain;
  };
  chain.maybeSingle = async () => ({ data: linha, error: null });
  chain.then = (ok: (v: unknown) => unknown) => ok({ data: linha ? [linha] : [], error: null });
  return {
    organizationId: ORG,
    role: "admin",
    actor: { type: "api_token", id: "t", role: "admin" },
    apiTokenId: "t",
    requestId: "r",
    supabase: { from: () => chain } as unknown as McpContext["supabase"],
  } as McpContext;
}

beforeEach(() => {
  h.montado = [];
  h.filtros = [];
});

describe("relatórios do dia pelo MCP", () => {
  it("o dia ao vivo é montado para a organização do CONTEXTO", async () => {
    const { crmGetDailyOperation } = await import("./relatorios");
    const r = (await crmGetDailyOperation.handler({ dia: "2026-11-16" }, ctx())) as Record<string, unknown>;
    expect(h.montado).toEqual([{ orgId: ORG, dia: "2026-11-16" }]);
    expect(r).toMatchObject({ dia: "2026-11-16", aguardando_uma_pessoa: 2, relatorio: "Operação do dia — texto" });
  });

  it("dia no futuro é recusado sem montar nada", async () => {
    const { crmGetDailyOperation } = await import("./relatorios");
    const r = (await crmGetDailyOperation.handler({ dia: "2999-01-01" }, ctx())) as Record<string, unknown>;
    expect(r.erro).toBe("dia_no_futuro");
    expect(h.montado).toHaveLength(0);
  });

  it("relatório salvo inexistente aponta a leitura ao vivo", async () => {
    const { crmGetDailyReport } = await import("./relatorios");
    const r = (await crmGetDailyReport.handler({ dia: "2026-11-10" }, ctx(null))) as Record<string, unknown>;
    expect(r.erro).toBe("relatorio_nao_encontrado");
    expect(h.filtros).toContainEqual(["organization_id", ORG]);
  });

  it("relatório salvo existente vem com o texto e quem gerou", async () => {
    const { crmGetDailyReport } = await import("./relatorios");
    const linha = { dia: "2026-11-15", fuso: "Asia/Beirut", gerado_em: "2026-11-15T21:00:00Z", gerado_por: "cron", conteudo: { contadores: {} } };
    const r = (await crmGetDailyReport.handler({ dia: "2026-11-15" }, ctx(linha))) as Record<string, unknown>;
    expect(r).toMatchObject({ dia: "2026-11-15", gerado_por: "automatico", relatorio: "Operação do dia — texto" });
  });

  it("só leitura, papel de gestão", async () => {
    const m = await import("./relatorios");
    for (const f of [m.crmGetDailyOperation, m.crmListDailyReports, m.crmGetDailyReport]) {
      expect(f.category).toBe("read");
      expect(f.requiresRole).toBe("manager");
      expect(f.requiresScope).toBe("mcp:read");
    }
  });
});
