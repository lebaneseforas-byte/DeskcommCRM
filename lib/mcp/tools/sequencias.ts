/**
 * FOLLOW-UPS E RESPOSTAS PRONTAS PELO MCP — o dono montando, pelo ChatGPT, as
 * sequências automáticas de retomada e as respostas prontas da equipe.
 *
 * ⚠️ NENHUMA REGRA MORA AQUI. Fluxo: `lib/followup/escrita-do-fluxo.ts` (criar,
 * salvar, publicar, desligar — as mesmas das rotas de `ai/followup-flows`) e
 * `lib/followup/editar.ts` (a leitura que o editor desenha). Resposta pronta:
 * `lib/templates/escrita-da-resposta.ts` e os esquemas da tela. O desenho do
 * fluxo é validado pelo MESMO `patchFollowupFlowSchema` da tela; o que ele recusa
 * volta com o caminho do campo, para o modelo consertar.
 *
 * ⚠️ A ORGANIZAÇÃO SAI DE `ctx.organizationId`. Apagar fluxo ou resposta NÃO
 * está aqui (decisão do dono: apagar fica na tela). Resposta pronta pelo MCP é
 * sempre COMPARTILHADA — um token não tem resposta pessoal — e mídia continua só
 * pela tela, que confere os bytes.
 *
 * Papel `manager` — a régua das rotas de fluxo e de resposta compartilhada.
 */
import { z } from "zod";

import { patchFollowupFlowSchema } from "@/lib/followup/api-schemas";
import { createTemplateSchema, updateTemplateSchema } from "@/lib/schemas/templates";

import type { McpContext, McpToolDefinition } from "../types";

const carregarEscrita = () => import("@/lib/followup/escrita-do-fluxo");
const carregarLeitura = () => import("@/lib/followup/editar");
const carregarResposta = () => import("@/lib/templates/escrita-da-resposta");
const carregarGrupo = () => import("@/lib/templates/grupo-da-resposta");

function ator(ctx: McpContext) {
  return { userId: null, apiTokenId: ctx.apiTokenId, requestId: ctx.requestId };
}

function recusa(r: { codigo: string; mensagem: string; erros?: unknown }) {
  return { erro: r.codigo, mensagem: r.mensagem, ...(r.erros ? { problemas: r.erros } : {}) };
}

function problemasDoZod(e: z.ZodError) {
  return e.issues.map((i) => ({ campo: i.path.join("."), problema: i.message }));
}

// ---------------------------------------------------------------------------
// crm_list_followup_flows
// ---------------------------------------------------------------------------

const listarShape = {
  superficie: z
    .enum(["followup", "atendimento"])
    .default("followup")
    .describe(
      '"followup" = automatic follow-up sequences (default); "atendimento" = service scripts.',
    ),
};

export const crmListFollowupFlows: McpToolDefinition<typeof listarShape> = {
  name: "crm_list_followup_flows",
  description:
    "Lists the company's automatic follow-up sequences (flows): id, name, status (draft/active/disabled), whether " +
    "a version is live, and when it last changed. Open one with crm_get_followup_flow.",
  inputSchema: listarShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const base = ctx.supabase
      .from("followup_flow_pointers")
      .select("id, name, status, active_version_id, handoff_policy, updated_at")
      .eq("organization_id", ctx.organizationId);
    const { data, error } = await (
      input.superficie === "atendimento"
        ? base.eq("surface", "atendimento")
        : base.neq("surface", "atendimento")
    ).order("updated_at", { ascending: false });
    if (error) return { erro: "falha_na_leitura", mensagem: error.message };
    return { fluxos: data ?? [] };
  },
};

// ---------------------------------------------------------------------------
// crm_get_followup_flow
// ---------------------------------------------------------------------------

const lerShape = { flow_id: z.string().uuid() };

export const crmGetFollowupFlow: McpToolDefinition<typeof lerShape> = {
  name: "crm_get_followup_flow",
  description:
    "Reads ONE follow-up flow as the editor shows it: name, status, trigger_config (what starts it), handoff_policy, " +
    "send_when_assigned and draft_graph (the steps: nodes and edges). When there is no separate draft, draft_graph " +
    "is the LIVE version. Use this output as the starting point for crm_save_followup_flow_draft: change it and send " +
    "the whole graph back.",
  inputSchema: lerShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { carregarFluxoParaEdicao } = await carregarLeitura();
    const fluxo = await carregarFluxoParaEdicao(ctx.supabase, {
      orgId: ctx.organizationId,
      id: input.flow_id,
    });
    if (!fluxo)
      return {
        erro: "fluxo_nao_encontrado",
        mensagem: "No follow-up flow with this id in this company.",
      };
    return { fluxo };
  },
};

// ---------------------------------------------------------------------------
// crm_create_followup_flow
// ---------------------------------------------------------------------------

const criarShape = {
  nome: z.string().trim().min(1).max(80).describe("Unique name of the new flow."),
};

export const crmCreateFollowupFlow: McpToolDefinition<typeof criarShape> = {
  name: "crm_create_followup_flow",
  description:
    "Creates an EMPTY follow-up flow (status draft, manual trigger, no steps). Nothing is sent: build it with " +
    "crm_save_followup_flow_draft and turn it on with crm_publish_followup_flow.",
  inputSchema: criarShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { criarFluxo } = await carregarEscrita();
    const r = await criarFluxo(ctx.supabase, {
      orgId: ctx.organizationId,
      nome: input.nome,
      moduloDb: ctx.supabase,
      ator: ator(ctx),
    });
    if (!r.ok) return recusa(r);
    return { flow_id: r.fluxo.id, status: r.fluxo.status };
  },
};

// ---------------------------------------------------------------------------
// crm_save_followup_flow_draft
// ---------------------------------------------------------------------------

const salvarShape = {
  flow_id: z.string().uuid(),
  nome: z.string().trim().min(1).max(80).optional(),
  draft_graph: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "The COMPLETE graph ({nodes, edges, ...}) in the same shape crm_get_followup_flow returns.",
    ),
  trigger_config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'What starts the flow, same shape as crm_get_followup_flow returns (e.g. {"kind":"manual"}).',
    ),
  handoff_policy: z.enum(["pause", "cancel", "allow"]).optional(),
  send_when_assigned: z.boolean().optional(),
};

export const crmSaveFollowupFlowDraft: McpToolDefinition<typeof salvarShape> = {
  name: "crm_save_followup_flow_draft",
  description:
    "Saves changes to a follow-up flow's DRAFT: name, steps (draft_graph), trigger, handoff_policy, " +
    "send_when_assigned. Customers are NOT affected until crm_publish_followup_flow. The draft is checked with the " +
    "same rules as the editor screen; problems come back with the field path to fix.",
  inputSchema: salvarShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { flow_id, nome, ...resto } = input;
    const pedido = { ...(nome !== undefined ? { name: nome } : {}), ...resto };
    if (Object.keys(pedido).length === 0)
      return { erro: "pedido_vazio", mensagem: "Nothing to change." };
    const patch = patchFollowupFlowSchema.safeParse(pedido);
    if (!patch.success) {
      return {
        erro: "rascunho_invalido",
        mensagem: "The draft does not follow the flow rules.",
        problemas: problemasDoZod(patch.error),
      };
    }
    const { salvarFluxo } = await carregarEscrita();
    const r = await salvarFluxo(ctx.supabase, {
      orgId: ctx.organizationId,
      id: flow_id,
      patch: patch.data,
      ator: ator(ctx),
    });
    if (!r.ok) return recusa(r);
    return { flow_id, status: r.fluxo.status, campos_salvos: Object.keys(patch.data) };
  },
};

// ---------------------------------------------------------------------------
// crm_publish_followup_flow / crm_disable_followup_flow
// ---------------------------------------------------------------------------

const idShape = { flow_id: z.string().uuid() };

export const crmPublishFollowupFlow: McpToolDefinition<typeof idShape> = {
  name: "crm_publish_followup_flow",
  description:
    "PUBLISHES the flow's current draft: from now on it runs for real and SENDS MESSAGES to customers when its " +
    "trigger fires. Checked with the same rules as the editor's Publish button; if refused, the problems list says " +
    "what to fix. Confirm with the person before calling.",
  inputSchema: idShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { publicarFluxo } = await carregarEscrita();
    const r = await publicarFluxo(ctx.supabase, {
      orgId: ctx.organizationId,
      id: input.flow_id,
      ator: ator(ctx),
    });
    if (!r.ok) return recusa(r);
    return {
      flow_id: r.data.id,
      status: r.data.status,
      versao_no_ar: r.data.active_version_id,
      avisos: r.data.avisos,
    };
  },
};

export const crmDisableFollowupFlow: McpToolDefinition<typeof idShape> = {
  name: "crm_disable_followup_flow",
  description:
    "Turns a follow-up flow OFF: it stops starting for new customers. Nothing is deleted; publish again to turn it back on.",
  inputSchema: idShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { desligarFluxo } = await carregarEscrita();
    const r = await desligarFluxo(ctx.supabase, {
      orgId: ctx.organizationId,
      id: input.flow_id,
      ator: ator(ctx),
    });
    if (!r.ok) return recusa(r);
    return { flow_id: r.data.id, status: r.data.status };
  },
};

// ---------------------------------------------------------------------------
// crm_create_message_template / crm_update_message_template
// ---------------------------------------------------------------------------

const criarRespostaShape = createTemplateSchema.omit({ shared: true }).shape;

export const crmCreateMessageTemplate: McpToolDefinition<typeof criarRespostaShape> = {
  name: "crm_create_message_template",
  description:
    "Creates a SHARED quick reply (message template) the whole team sees: title, body (may use {{...}} markers, " +
    "see crm_list_message_templates for examples) and an optional shortcut. Images and audio are added on the screen.",
  inputSchema: criarRespostaShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { grupoDaOrganizacao } = await carregarGrupo();
    if (!(await grupoDaOrganizacao(ctx.supabase as never, ctx.organizationId, input.grupo_id))) {
      return { erro: "grupo_invalido", mensagem: "This group does not belong to this company." };
    }
    const { criarRespostaRapida } = await carregarResposta();
    try {
      const resposta = await criarRespostaRapida(ctx.supabase, {
        orgId: ctx.organizationId,
        donoUserId: null,
        criadorUserId: null,
        apiTokenId: ctx.apiTokenId,
        requestId: ctx.requestId,
        title: input.title,
        body: input.body,
        ...(input.shortcut !== undefined ? { shortcut: input.shortcut } : {}),
        ...(input.mostrar_na_barra !== undefined
          ? { mostrar_na_barra: input.mostrar_na_barra }
          : {}),
        ...(input.grupo_id !== undefined ? { grupo_id: input.grupo_id } : {}),
      });
      return { template_id: resposta.id, title: resposta.title };
    } catch {
      return { erro: "falha_ao_salvar", mensagem: "The quick reply could not be saved." };
    }
  },
};

const camposDaResposta = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().max(4096),
  shortcut: z.string().trim().min(1).max(40).nullable(),
  mostrar_na_barra: z.boolean(),
  grupo_id: z.string().trim().min(1).max(64).nullable(),
});
const atualizarRespostaShape = {
  template_id: z.string().uuid(),
  ...camposDaResposta.partial().shape,
};

export const crmUpdateMessageTemplate: McpToolDefinition<typeof atualizarRespostaShape> = {
  name: "crm_update_message_template",
  description:
    "Changes a SHARED quick reply: title, body, shortcut (null removes it), whether it shows in the Inbox bar, " +
    "its group. Only the fields sent change. Personal quick replies of team members cannot be changed here.",
  inputSchema: atualizarRespostaShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { template_id, ...campos } = input;
    // A mesma régua do PATCH da tela, sem `midias` (mídia é só pela tela).
    const conferidos = updateTemplateSchema.safeParse(campos);
    if (!conferidos.success) {
      return {
        erro: "pedido_invalido",
        mensagem: "Send at least one valid field.",
        problemas: problemasDoZod(conferidos.error),
      };
    }
    const { midias: _m, midias_esperadas: _e, ...mudancas } = conferidos.data;
    if (mudancas.grupo_id !== undefined) {
      const { grupoDaOrganizacao } = await carregarGrupo();
      if (
        !(await grupoDaOrganizacao(ctx.supabase as never, ctx.organizationId, mudancas.grupo_id))
      ) {
        return { erro: "grupo_invalido", mensagem: "This group does not belong to this company." };
      }
    }
    const { COLUNAS_DA_RESPOSTA } = await carregarResposta();
    const { data, error } = await ctx.supabase
      .from("message_templates")
      .update({ ...mudancas, updated_at: new Date().toISOString() })
      .eq("id", template_id)
      .eq("organization_id", ctx.organizationId)
      // O client é de serviço e não tem a RLS de dono: só as COMPARTILHADAS.
      .is("owner_user_id", null)
      .select(COLUNAS_DA_RESPOSTA)
      .maybeSingle();
    if (error) return { erro: "falha_ao_salvar", mensagem: "The quick reply could not be saved." };
    if (!data) {
      return {
        erro: "resposta_nao_encontrada",
        mensagem: "No SHARED quick reply with this id in this company.",
      };
    }
    const { audit } = await import("@/lib/audit");
    void audit({
      action: "template.updated",
      actorUserId: null,
      actorApiTokenId: ctx.apiTokenId,
      organizationId: ctx.organizationId,
      resourceType: "message_template",
      resourceId: template_id,
      requestId: ctx.requestId,
      metadata: { fields: Object.keys(mudancas), removidas: 0 },
    });
    return { template_id, campos_salvos: Object.keys(mudancas) };
  },
};
