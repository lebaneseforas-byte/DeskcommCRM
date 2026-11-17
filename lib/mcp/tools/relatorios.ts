/**
 * RELATÓRIOS PELO MCP — o dono revisando o dia da operação pelo ChatGPT.
 *
 * ⚠️ NENHUMA REGRA MORA AQUI. A leitura do dia é `montarOperacaoDoDia`
 * (`lib/operacao/operacao-do-dia.ts`), o relatório salvo é a linha de
 * `relatorios_operacao_diarios` hidratada por `hidratar` + `leitorDoBanco`, e o
 * texto é `textoDoRelatorio` — os mesmos da tela Operação do dia e do cron que
 * grava o relatório. Aqui só há tradução de argumento.
 *
 * ⚠️ A ORGANIZAÇÃO SAI DE `ctx.organizationId`. O client é service-role, como o
 * do cron: cada consulta daqueles módulos filtra `organization_id` à mão.
 *
 * Só leitura, papel `manager` — a mesma régua da tela (`/app/operacao`).
 */
import { z } from "zod";

import { hidratar, lerConteudo } from "@/lib/operacao/conteudo";
import { leitorDoBanco } from "@/lib/operacao/hidratar-do-banco";
import { montarOperacaoDoDia, nomesPelaFuncao } from "@/lib/operacao/operacao-do-dia";
import { diaNoFuso, diaValido, resolverDia } from "@/lib/operacao/regras";
import { contextoDaOrganizacao, TABELA_DOS_RELATORIOS, urlPublicaDoApp } from "@/lib/operacao/relatorio-diario";
import { textoDoRelatorio } from "@/lib/operacao/texto-do-relatorio";

import type { McpToolDefinition } from "../types";

const DIA = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Day as YYYY-MM-DD in the company's time zone.");

// ---------------------------------------------------------------------------
// crm_get_daily_operation
// ---------------------------------------------------------------------------

const operacaoShape = {
  dia: DIA.optional().describe("Day as YYYY-MM-DD in the company's time zone. Default: today."),
};

export const crmGetDailyOperation: McpToolDefinition<typeof operacaoShape> = {
  name: "crm_get_daily_operation",
  description:
    "The day's operation, read LIVE (same as the CRM's 'Operação do dia' screen): new conversations and conversations " +
    "with customer messages per channel, who is waiting for a person, big projects, complaints/urgent, product " +
    "requests, deals won/lost/in proposal, and failures (messages, AI runs, channels). Returns a ready-to-read report " +
    "text with links plus the counters. Default day: today in the company's time zone.",
  inputSchema: operacaoShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const contexto = await contextoDaOrganizacao(ctx.supabase, ctx.organizationId);
    const agora = new Date();
    const pedido = resolverDia(input.dia, contexto.fuso, agora);
    if (!pedido.ok) {
      return {
        erro: pedido.motivo,
        mensagem: pedido.motivo === "dia_no_futuro" ? "Choose today or a past day." : "Invalid day; use YYYY-MM-DD.",
      };
    }
    const operacao = await montarOperacaoDoDia({
      db: ctx.supabase,
      orgId: ctx.organizationId,
      dia: pedido.dia,
      fuso: contexto.fuso,
      config: contexto.config,
      agora,
      nomesDaEquipe: nomesPelaFuncao(ctx.supabase, ctx.organizationId),
    });
    return {
      dia: operacao.dia,
      fuso: operacao.fuso,
      hoje: diaNoFuso(agora, contexto.fuso),
      contadores: operacao.contadores,
      aguardando_uma_pessoa: operacao.aguardando.length,
      relatorio: textoDoRelatorio(operacao, { idioma: contexto.idioma, baseUrl: urlPublicaDoApp(), geradoEm: agora }),
    };
  },
};

// ---------------------------------------------------------------------------
// crm_list_daily_reports
// ---------------------------------------------------------------------------

const listaShape = {
  limite: z.number().int().min(1).max(60).default(14).describe("How many of the latest saved daily reports."),
};

export const crmListDailyReports: McpToolDefinition<typeof listaShape> = {
  name: "crm_list_daily_reports",
  description:
    "Lists the SAVED daily reports (the CRM saves one per day automatically, and people can regenerate them): day, " +
    "when it was generated, by whom (automatic or a person) and the headline counters. Read one in full with " +
    "crm_get_daily_report.",
  inputSchema: listaShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { data, error } = await ctx.supabase
      .from(TABELA_DOS_RELATORIOS)
      .select("dia, fuso, gerado_em, gerado_por, conteudo")
      .eq("organization_id", ctx.organizationId)
      .order("dia", { ascending: false })
      .limit(input.limite);
    if (error) return { erro: "falha_na_leitura", mensagem: error.message };
    return {
      relatorios: ((data ?? []) as Array<{ dia: string; fuso: string; gerado_em: string; gerado_por: string; conteudo: unknown }>).map(
        (l) => {
          const c = lerConteudo(l.conteudo);
          return {
            dia: l.dia,
            gerado_em: l.gerado_em,
            gerado_por: l.gerado_por === "cron" ? "automatico" : "pessoa",
            contadores: c?.contadores ?? null,
            aguardando_uma_pessoa: c ? c.aguardando.length : null,
            ganhos: c ? c.funil.ganhos.length : null,
            perdidos: c ? c.funil.perdidos.length : null,
          };
        },
      ),
    };
  },
};

// ---------------------------------------------------------------------------
// crm_get_daily_report
// ---------------------------------------------------------------------------

const relatorioShape = { dia: DIA };

export const crmGetDailyReport: McpToolDefinition<typeof relatorioShape> = {
  name: "crm_get_daily_report",
  description:
    "Reads ONE saved daily report in full (same text as the CRM's report page), with names re-read from the CRM. " +
    "Use crm_list_daily_reports to see which days exist, or crm_get_daily_operation for a live view of today.",
  inputSchema: relatorioShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    if (!diaValido(input.dia)) return { erro: "dia_invalido", mensagem: "Invalid day; use YYYY-MM-DD." };
    const { data, error } = await ctx.supabase
      .from(TABELA_DOS_RELATORIOS)
      .select("dia, fuso, gerado_em, gerado_por, conteudo")
      .eq("organization_id", ctx.organizationId)
      .eq("dia", input.dia)
      .maybeSingle();
    if (error) return { erro: "falha_na_leitura", mensagem: error.message };
    if (!data) {
      return { erro: "relatorio_nao_encontrado", mensagem: `No saved report for ${input.dia}. Use crm_get_daily_operation for a live view.` };
    }
    const linha = data as { dia: string; fuso: string; gerado_em: string; gerado_por: string; conteudo: unknown };
    const guardado = lerConteudo(linha.conteudo);
    if (!guardado) return { erro: "relatorio_ilegivel", mensagem: "This saved report has a format this version cannot read." };
    const conteudo = await hidratar(
      guardado,
      leitorDoBanco(ctx.supabase, ctx.organizationId, nomesPelaFuncao(ctx.supabase, ctx.organizationId)),
    );
    const contexto = await contextoDaOrganizacao(ctx.supabase, ctx.organizationId);
    return {
      dia: linha.dia,
      gerado_em: linha.gerado_em,
      gerado_por: linha.gerado_por === "cron" ? "automatico" : "pessoa",
      contadores: conteudo.contadores,
      relatorio: textoDoRelatorio(conteudo, {
        idioma: contexto.idioma,
        baseUrl: urlPublicaDoApp(),
        geradoEm: new Date(linha.gerado_em),
      }),
    };
  },
};
