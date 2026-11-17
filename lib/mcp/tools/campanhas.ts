/**
 * CAMPANHAS PELO MCP — o dono montando, conferindo e soltando envios em massa
 * pelo ChatGPT.
 *
 * ⚠️ NENHUMA REGRA MORA AQUI. Criar o rascunho é `lib/campanhas/criar-campanha.ts`
 * e toda ação (preparar, testar, iniciar, agendar, pausar, retomar, cancelar) é
 * `lib/campanhas/executar-acao.ts` — os mesmos das rotas de `campaigns`, com a
 * máquina de estados, o anti-banimento (ritmo, janela, tetos), a base legal e a
 * supressão de quem pediu para sair intactos. Os esquemas são os da tela.
 *
 * ⚠️ O QUE MANDA MENSAGEM: `iniciar`/`retomar` e `agendar` (a lista inteira) são
 * `critico`; `testar` manda UMA mensagem a um contato escolhido. Preparar só
 * fotografa o público — e é o que dá o número de destinatários que a pessoa
 * confirma antes de iniciar. Duplicar e apagar ficam na tela.
 *
 * ⚠️ A ORGANIZAÇÃO SAI DE `ctx.organizationId`. Papel `manager`, o da tela.
 */
import { z } from "zod";

import { baseDaCampanha, criarCampanhaSchema, ritmoSchema } from "@/lib/campanhas/schemas";

import type { McpContext, McpToolDefinition } from "../types";

const carregarCriacao = () => import("@/lib/campanhas/criar-campanha");
const carregarAcao = () => import("@/lib/campanhas/executar-acao");

function problemasDoZod(e: z.ZodError) {
  return e.issues.map((i) => ({ campo: i.path.join("."), problema: i.message }));
}

const identidade = (texto: string) => texto;

async function executar(
  ctx: McpContext,
  campanhaId: string,
  acao: "preparar" | "iniciar" | "agendar" | "pausar" | "retomar" | "cancelar" | "testar",
  corpo: unknown = null,
) {
  const { executarAcaoDaCampanha } = await carregarAcao();
  const r = await executarAcaoDaCampanha(ctx.supabase, {
    orgId: ctx.organizationId,
    campanhaId,
    acao,
    corpo,
    ator: { userId: null, apiTokenId: ctx.apiTokenId, requestId: ctx.requestId },
    t: identidade,
  });
  if (!r.ok) return { erro: r.codigo, mensagem: r.mensagem };
  return { campaign_id: campanhaId, ...r.data };
}

// ---------------------------------------------------------------------------
// leitura
// ---------------------------------------------------------------------------

const listarShape = { limite: z.number().int().min(1).max(50).default(20) };

export const crmListCampaigns: McpToolDefinition<typeof listarShape> = {
  name: "crm_list_campaigns",
  description:
    "Lists the company's bulk-message campaigns, newest first: name, status (draft, ready, running, scheduled, " +
    "paused, completed, cancelled), number of recipients and dates.",
  inputSchema: listarShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { COLUNAS_DA_LISTA_DE_CAMPANHAS } = await carregarCriacao();
    const { data, error } = await ctx.supabase
      .from("campaigns")
      .select(COLUNAS_DA_LISTA_DE_CAMPANHAS)
      .eq("organization_id", ctx.organizationId)
      .order("created_at", { ascending: false })
      .limit(input.limite);
    if (error) return { erro: "falha_na_leitura", mensagem: error.message };
    return { campanhas: data ?? [] };
  },
};

const idShape = { campaign_id: z.string().uuid() };

export const crmGetCampaign: McpToolDefinition<typeof idShape> = {
  name: "crm_get_campaign",
  description:
    "Reads ONE campaign: status, message, channel, legal basis, audience filter, pace (interval, window, caps) and " +
    "the recipient counts from the last preparation.",
  inputSchema: idShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { carregarCampanha } = await import("@/lib/campanhas/acoes");
    const r = await carregarCampanha(ctx.supabase, ctx.organizationId, input.campaign_id);
    if (!r.ok) return { erro: r.codigo, mensagem: r.mensagem };
    const { data: contagem } = await ctx.supabase
      .from("campaigns")
      .select(
        "snapshot_total, snapshot_eligible, snapshot_excluded, started_at, completed_at, cancelled_at",
      )
      .eq("id", input.campaign_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    return { campanha: { ...r.campanha, ...(contagem ?? {}) } };
  },
};

// ---------------------------------------------------------------------------
// crm_create_campaign_draft
// ---------------------------------------------------------------------------

const criarShape = { ...baseDaCampanha, ...ritmoSchema.shape };

export const crmCreateCampaignDraft: McpToolDefinition<typeof criarShape> = {
  name: "crm_create_campaign_draft",
  description:
    "Creates a campaign as a DRAFT: nothing is sent. Same rules as the Campaigns screen (the channel must belong to " +
    "the company, WhatsApp official numbers need an approved template, a legal basis is required). Next steps: " +
    "crm_prepare_campaign to count the recipients, crm_test_campaign to send one test, then crm_start_campaign.",
  inputSchema: criarShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const entrada = criarCampanhaSchema.safeParse(input);
    if (!entrada.success) {
      return {
        erro: "campanha_invalida",
        mensagem: "The campaign does not follow the rules of the screen.",
        problemas: problemasDoZod(entrada.error),
      };
    }
    const { criarCampanha } = await carregarCriacao();
    const r = await criarCampanha(ctx.supabase, {
      orgId: ctx.organizationId,
      entrada: entrada.data,
      autorUserId: null,
      apiTokenId: ctx.apiTokenId,
      requestId: ctx.requestId,
      t: identidade,
    });
    if (!r.ok) return { erro: r.codigo, mensagem: r.mensagem };
    return { campaign_id: r.campanha.id, status: r.campanha.status };
  },
};

// ---------------------------------------------------------------------------
// ações
// ---------------------------------------------------------------------------

export const crmPrepareCampaign: McpToolDefinition<typeof idShape> = {
  name: "crm_prepare_campaign",
  description:
    "Prepares a draft campaign: takes a snapshot of who will receive it (people who opted out are excluded) and " +
    "returns the counts. Sends nothing. Show the person how many will receive it before starting.",
  inputSchema: idShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => executar(ctx, input.campaign_id, "preparar"),
};

const testarShape = { campaign_id: z.string().uuid(), contact_id: z.string().uuid() };

export const crmTestCampaign: McpToolDefinition<typeof testarShape> = {
  name: "crm_test_campaign",
  description:
    "Sends the campaign message ONCE to one chosen contact (e.g. the owner's own number) to check how it looks. " +
    "WhatsApp campaigns only.",
  inputSchema: testarShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    executar(ctx, input.campaign_id, "testar", { contact_id: input.contact_id }),
};

export const crmStartCampaign: McpToolDefinition<typeof idShape> = {
  name: "crm_start_campaign",
  description:
    "STARTS (or resumes) a prepared campaign: messages go out to every recipient, at the safe pace and inside the " +
    "sending window the campaign has. Cannot be undone for messages already sent. Confirm the recipient count with " +
    "the person right before calling.",
  inputSchema: idShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => executar(ctx, input.campaign_id, "iniciar"),
};

const agendarShape = {
  campaign_id: z.string().uuid(),
  scheduled_at: z
    .string()
    .datetime({ offset: true })
    .describe("ISO-8601 date and time, with time zone."),
};

export const crmScheduleCampaign: McpToolDefinition<typeof agendarShape> = {
  name: "crm_schedule_campaign",
  description:
    "Schedules a prepared campaign to START by itself at scheduled_at; from then on it sends to every recipient. " +
    "Confirm the date, time and recipient count with the person before calling.",
  inputSchema: agendarShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) =>
    executar(ctx, input.campaign_id, "agendar", { scheduled_at: input.scheduled_at }),
};

export const crmPauseCampaign: McpToolDefinition<typeof idShape> = {
  name: "crm_pause_campaign",
  description:
    "Pauses a running campaign: no more messages go out until it is resumed with crm_start_campaign.",
  inputSchema: idShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => executar(ctx, input.campaign_id, "pausar"),
};

export const crmCancelCampaign: McpToolDefinition<typeof idShape> = {
  name: "crm_cancel_campaign",
  description:
    "Cancels a campaign for good: messages not yet sent are dropped. It cannot be restarted (create a new one).",
  inputSchema: idShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => executar(ctx, input.campaign_id, "cancelar"),
};
