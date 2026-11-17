/**
 * REGRAS AUTOMÁTICAS PELO MCP — o dono criando e ajustando, pelo ChatGPT, o que
 * o sistema faz sozinho quando algo acontece.
 *
 * ⚠️ NENHUMA REGRA DE NEGÓCIO MORA AQUI. Criar e alterar são
 * `lib/automation/escrita-da-regra.ts`, as mesmas das rotas de
 * `automation-rules`, com os mesmos esquemas (`createAutomationRuleSchema`,
 * `updateAutomationRuleSchema`).
 *
 * ⚠️ TRÊS TRAVAS A MAIS, PORQUE QUEM ESCREVE É UM MODELO. A doutrina de
 * `lib/operacao/regras-automaticas.ts` recusa ao assistente escrever ação de
 * regra: seria deixá-lo escolher para onde a empresa manda dados. Aqui a pessoa
 * confirma cada chamada no aplicativo, mas o modelo do aplicativo lê conversas
 * de cliente pelas outras ferramentas, e um texto plantado numa conversa pode
 * pedir uma regra. Então:
 *
 *   1. ação que SAI DA EMPRESA é recusada — `call_webhook` (endereço externo) e
 *      `send_email` para endereço fixo. Essas continuam só pela tela;
 *   2. a regra criada nasce PAUSADA (o schema de criação não tem `is_active`),
 *      e o interruptor não está nestas ferramentas: ligar é
 *      `crm_set_automation_rule_active`, `critico`, uma confirmação à parte;
 *   3. gatilho, condições e ações só mudam com a regra PAUSADA — mudar uma regra
 *      ligada seria mudar o que já roda sozinho, sem o passo de ligar.
 *
 * ⚠️ A ORGANIZAÇÃO SAI DE `ctx.organizationId`. Apagar regra não está aqui.
 * Papel `manager`, o da tela.
 */
import { z } from "zod";

import { createAutomationRuleSchema, updateAutomationRuleSchema } from "@/lib/schemas";
import { TRIGGER_EVENTS } from "@/lib/schemas/webhooks";

import type { McpContext, McpToolDefinition } from "../types";

const carregarEscrita = () => import("@/lib/automation/escrita-da-regra");

function ator(ctx: McpContext) {
  return {
    actor: ctx.actor,
    apiTokenId: ctx.apiTokenId,
    requestId: ctx.requestId,
    idioma: "pt-BR" as const,
  };
}

function problemasDoZod(e: z.ZodError) {
  return e.issues.map((i) => ({ campo: i.path.join("."), problema: i.message }));
}

/** As ações que mandam algo para FORA da empresa — ver a trava 1 do topo. */
export function acoesQueSaemDaEmpresa(acoes: unknown): string[] {
  if (!Array.isArray(acoes)) return [];
  const fora: string[] = [];
  acoes.forEach((a, i) => {
    const acao = a as { type?: unknown; config?: { destinatario?: unknown } };
    if (acao?.type === "call_webhook") fora.push(`actions.${i} (call_webhook)`);
    if (acao?.type === "send_email" && acao.config?.destinatario === "fixo") {
      fora.push(`actions.${i} (send_email to a fixed address)`);
    }
  });
  return fora;
}

const RECUSA_DE_SAIDA =
  "Actions that send data outside the company (webhook, or e-mail to a fixed address) can only be set on the " +
  "Automations screen.";

/** Tira segredo da configuração antes de devolver a regra ao modelo. */
function semSegredo(acoes: unknown): unknown {
  if (!Array.isArray(acoes)) return acoes;
  return acoes.map((a) => {
    const acao = a as { config?: Record<string, unknown> };
    if (!acao?.config || typeof acao.config !== "object") return a;
    const { secret: _s, secret_enc: _e, ...config } = acao.config;
    return { ...acao, config };
  });
}

// ---------------------------------------------------------------------------
// crm_get_automation_rule
// ---------------------------------------------------------------------------

const lerShape = { rule_id: z.string().uuid() };

export const crmGetAutomationRule: McpToolDefinition<typeof lerShape> = {
  name: "crm_get_automation_rule",
  description:
    "Reads ONE automation rule in full: name, whether it is on, trigger_event, trigger_config, conditions and the " +
    "actions with their settings (secrets removed). Use it before crm_update_automation_rule; list rules with " +
    "crm_list_automation_rules.",
  inputSchema: lerShape,
  category: "read",
  requiresRole: "manager",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const { data, error } = await ctx.supabase
      .from("automation_rules")
      .select(
        "id, name, is_active, trigger_event, trigger_config, conditions, actions, last_run_at, run_count, updated_at",
      )
      .eq("id", input.rule_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (error) return { erro: "falha_na_leitura", mensagem: error.message };
    if (!data)
      return {
        erro: "regra_nao_encontrada",
        mensagem: "No automation rule with this id in this company.",
      };
    const linha = data as Record<string, unknown>;
    return { regra: { ...linha, actions: semSegredo(linha.actions) } };
  },
};

// ---------------------------------------------------------------------------
// crm_create_automation_rule
// ---------------------------------------------------------------------------

const criarShape = {
  name: z.string().min(1).max(120),
  trigger_event: z.enum(TRIGGER_EVENTS).describe("The event that fires the rule."),
  conditions: z
    .unknown()
    .optional()
    .describe("Same shape as crm_get_automation_rule returns. Default: none."),
  actions: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .max(10)
    .describe("Same shape as crm_get_automation_rule returns: [{type, config}]."),
  trigger_config: z.record(z.string(), z.unknown()).optional(),
};

export const crmCreateAutomationRule: McpToolDefinition<typeof criarShape> = {
  name: "crm_create_automation_rule",
  description:
    "Creates an automation rule, always PAUSED: nothing runs until someone turns it on with " +
    "crm_set_automation_rule_active. Checked with the same rules as the Automations screen; problems come back with " +
    "the field to fix. Webhook actions and e-mails to a fixed address are refused here (screen only). Look at an " +
    "existing rule with crm_get_automation_rule to copy the shape of trigger, conditions and actions.",
  inputSchema: criarShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const fora = acoesQueSaemDaEmpresa(input.actions);
    if (fora.length)
      return { erro: "acao_externa_so_pela_tela", mensagem: RECUSA_DE_SAIDA, acoes: fora };
    const regra = createAutomationRuleSchema.safeParse(input);
    if (!regra.success) {
      return {
        erro: "regra_invalida",
        mensagem: "The rule does not follow the rules of the screen.",
        problemas: problemasDoZod(regra.error),
      };
    }
    const { criarRegra } = await carregarEscrita();
    const r = await criarRegra(ctx.supabase, {
      orgId: ctx.organizationId,
      admin: ctx.supabase,
      regra: regra.data,
      ator: ator(ctx),
    });
    if (!r.ok)
      return {
        erro: r.codigo,
        mensagem: r.mensagem,
        ...(r.details ? { detalhes: r.details } : {}),
      };
    return {
      rule_id: r.regra.id,
      ligada: false,
      proximo_passo: "Turn it on with crm_set_automation_rule_active after the person confirms.",
    };
  },
};

// ---------------------------------------------------------------------------
// crm_update_automation_rule
// ---------------------------------------------------------------------------

const alterarShape = {
  rule_id: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  trigger_event: z.enum(TRIGGER_EVENTS).optional(),
  conditions: z.unknown().optional(),
  actions: z.array(z.record(z.string(), z.unknown())).min(1).max(10).optional(),
  trigger_config: z.record(z.string(), z.unknown()).optional(),
};

export const crmUpdateAutomationRule: McpToolDefinition<typeof alterarShape> = {
  name: "crm_update_automation_rule",
  description:
    "Changes an automation rule: name, trigger, conditions or actions (send the COMPLETE new list). Renaming works " +
    "any time; trigger, conditions and actions only change while the rule is PAUSED — pause it first with " +
    "crm_set_automation_rule_active. This tool never turns a rule on. Webhook actions and e-mails to a fixed " +
    "address are refused here (screen only).",
  inputSchema: alterarShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { rule_id, ...campos } = input;
    const pedido = Object.fromEntries(Object.entries(campos).filter(([, v]) => v !== undefined));
    if (Object.keys(pedido).length === 0)
      return { erro: "pedido_vazio", mensagem: "Nothing to change." };
    const fora = acoesQueSaemDaEmpresa(pedido.actions);
    if (fora.length)
      return { erro: "acao_externa_so_pela_tela", mensagem: RECUSA_DE_SAIDA, acoes: fora };

    const patch = updateAutomationRuleSchema.safeParse(pedido);
    if (!patch.success) {
      return {
        erro: "regra_invalida",
        mensagem: "The change does not follow the rules of the screen.",
        problemas: problemasDoZod(patch.error),
      };
    }

    const { atualizarRegra, lerRegraGravada } = await carregarEscrita();
    const lida = await lerRegraGravada(ctx.supabase, ctx.organizationId, rule_id);
    if (!lida.ok) {
      return lida.codigo === "not_found"
        ? {
            erro: "regra_nao_encontrada",
            mensagem: "No automation rule with this id in this company.",
          }
        : { erro: lida.codigo, mensagem: lida.mensagem };
    }
    const mexeNoQueRoda = Object.keys(patch.data).some((k) => k !== "name");
    if (mexeNoQueRoda && lida.regra.is_active) {
      return {
        erro: "regra_ligada",
        mensagem:
          "This rule is ON. Pause it with crm_set_automation_rule_active before changing trigger, conditions or actions.",
      };
    }
    const r = await atualizarRegra(ctx.supabase, {
      orgId: ctx.organizationId,
      id: rule_id,
      admin: ctx.supabase,
      patch: patch.data,
      ator: ator(ctx),
      gravada: lida.regra,
    });
    if (!r.ok)
      return {
        erro: r.codigo,
        mensagem: r.mensagem,
        ...(r.details ? { detalhes: r.details } : {}),
      };
    return { rule_id, campos_salvos: Object.keys(patch.data), ligada: Boolean(r.regra.is_active) };
  },
};
