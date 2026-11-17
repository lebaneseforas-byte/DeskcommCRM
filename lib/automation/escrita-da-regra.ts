/**
 * ESCREVER UMA REGRA AUTOMÁTICA — a parte que `app/api/v1/automation-rules` e o
 * MCP do CRM (o dono pelo ChatGPT) fazem igual: criar e alterar.
 *
 * Saiu das rotas para não haver duas réguas. As recusas são as de sempre: fonte
 * de webhook de outra empresa, etapa de perda sem motivo (#4297), o laço de lead
 * (#1528) e a condição `campo_alterado` fora do gatilho (#1749) no PATCH
 * parcial, gatilho de data num campo do contato (#2791), e o segredo de
 * `call_webhook` que nunca fica em claro (0041). A regra nasce PAUSADA (o schema
 * de criação não tem `is_active`).
 *
 * ⚠️ A organização vem de quem chama, nunca do corpo, e vai explícita em toda
 * consulta — o client pode ser o de serviço (MCP). As mensagens saem em
 * português com `traduzivel`, como em `lib/followup/escrita-do-fluxo.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/api/handlers/types";
import {
  MENSAGEM_CAMPO_DE_DATA_DO_CONTATO,
  campoDoGatilhoDeDataEhDoContato,
} from "@/lib/automation/campo-do-gatilho-de-data";
import type { Conditions } from "@/lib/automation/conditions";
import {
  CAMPO_DO_MOTIVO_DA_PERDA,
  acoesDePerdaSemMotivo,
  lerEtapasDasAcoes,
  mensagemDaEtapaDePerdaSemMotivo,
} from "@/lib/automation/motivo-da-perda-na-acao";
import type { Idioma } from "@/lib/i18n/idiomas";
import { autoriaDaMudanca } from "@/lib/operacao/autoria";
import type { createAutomationRuleSchema, updateAutomationRuleSchema } from "@/lib/schemas";
import {
  acoesQueFechamLaco,
  condicoesQueSoExistemNoNegocioAlterado,
  MENSAGEM_DO_CAMPO_ALTERADO_FORA_DO_GATILHO,
  MENSAGEM_DO_LACO_DE_LEAD,
} from "@/lib/schemas/webhooks";
import { encryptRuleActionSecrets } from "@/lib/webhooks/secrets";

export interface AtorDaRegra {
  actor: Actor;
  apiTokenId: string | null;
  requestId: string;
  idioma: Idioma;
}

export interface FalhaDaRegra {
  ok: false;
  codigo: string;
  mensagem: string;
  traduzivel: boolean;
  status: number;
  details?: Record<string, unknown>;
}

type CriarRegra = z.infer<typeof createAutomationRuleSchema>;
type AtualizarRegra = z.infer<typeof updateAutomationRuleSchema>;
type Acoes = CriarRegra["actions"];

const SEM_CIFRA =
  "Não foi possível guardar o segredo do webhook com segurança: a chave de cifra desta instalação não está ativa. Quem administra o servidor resolve rodando o update.sh, que gera e ativa a chave.";

function falha(
  codigo: string,
  mensagem: string,
  status: number,
  extra: { traduzivel?: boolean; details?: Record<string, unknown> } = {},
): FalhaDaRegra {
  return {
    ok: false,
    codigo,
    mensagem,
    status,
    traduzivel: extra.traduzivel ?? true,
    ...(extra.details ? { details: extra.details } : {}),
  };
}

function autorUsuario(actor: Actor): string | null {
  return actor.type === "user" ? actor.id : null;
}

async function fonteDaOrganizacao(
  db: SupabaseClient,
  orgId: string,
  triggerConfig: Record<string, unknown> | undefined,
): Promise<FalhaDaRegra | null> {
  const webhookSourceId = triggerConfig?.webhook_source_id;
  if (typeof webhookSourceId !== "string") return null;
  const { data, error } = await db
    .from("webhook_sources")
    .select("id")
    .eq("id", webhookSourceId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return falha("internal_error", error.message, 500, { traduzivel: false });
  if (!data) return falha("invalid_request", "A fonte escolhida não pertence a esta empresa.", 422);
  return null;
}

/**
 * ── A ETAPA DE PERDA EXIGE MOTIVO — RECUSADA NO CADASTRO (#4297) ───────────
 *
 * A ação não tinha como informar o motivo, então a regra que apontava para a
 * etapa de perda era SALVA e falhava em toda execução (o #917 recusa mover sem
 * motivo). A pergunta é da porta: a etapa de destino fecha o negócio como
 * perdido e a ação não diz por quê?
 */
async function perdaSemMotivo(
  db: SupabaseClient,
  orgId: string,
  acoes: Acoes,
  idioma: Idioma,
): Promise<FalhaDaRegra | null> {
  const etapas = await lerEtapasDasAcoes(db, orgId, acoes);
  if ("erro" in etapas) return falha("internal_error", etapas.erro, 500, { traduzivel: false });
  const semMotivo = acoesDePerdaSemMotivo(acoes, etapas.etapas);
  if (semMotivo.length === 0) return null;
  return falha(
    "invalid_request",
    mensagemDaEtapaDePerdaSemMotivo(
      semMotivo.map((achado) => achado.etapa),
      idioma,
    ),
    422,
    { details: { campo: CAMPO_DO_MOTIVO_DA_PERDA } },
  );
}

async function gatilhoDeDataDoContato(
  db: SupabaseClient,
  orgId: string,
  triggerEvent: string,
  triggerConfig: unknown,
): Promise<FalhaDaRegra | null> {
  const campoDeData = await campoDoGatilhoDeDataEhDoContato(
    db,
    orgId,
    triggerEvent as Parameters<typeof campoDoGatilhoDeDataEhDoContato>[2],
    triggerConfig as Parameters<typeof campoDoGatilhoDeDataEhDoContato>[3],
  );
  if ("erro" in campoDeData)
    return falha("internal_error", campoDeData.erro, 500, { traduzivel: false });
  if (campoDeData.doContato)
    return falha("invalid_request", MENSAGEM_CAMPO_DE_DATA_DO_CONTATO, 422);
  return null;
}

// ---------------------------------------------------------------------------
// criar
// ---------------------------------------------------------------------------

export async function criarRegra(
  db: SupabaseClient,
  args: { orgId: string; admin: SupabaseClient; regra: CriarRegra; ator: AtorDaRegra },
): Promise<{ ok: true; regra: Record<string, unknown> & { id: string } } | FalhaDaRegra> {
  const { orgId, regra, ator } = args;

  // Secrets de call_webhook nunca ficam em claro no jsonb (migration 0041).
  const acoesSeguras = await encryptRuleActionSecrets(args.admin, regra.actions);
  if (acoesSeguras === null) {
    return falha(
      "encryption_unavailable",
      `${SEM_CIFRA} Enquanto isso, você pode criar a ação sem segredo.`,
      422,
    );
  }

  const recusa =
    (await perdaSemMotivo(db, orgId, regra.actions, ator.idioma)) ??
    (await fonteDaOrganizacao(db, orgId, regra.trigger_config)) ??
    (await gatilhoDeDataDoContato(db, orgId, regra.trigger_event, regra.trigger_config));
  if (recusa) return recusa;

  const { data: criada, error } = await db
    .from("automation_rules")
    .insert({
      organization_id: orgId,
      created_by_user_id: autorUsuario(ator.actor),
      name: regra.name,
      trigger_event: regra.trigger_event,
      conditions: regra.conditions,
      actions: acoesSeguras,
      // O gatilho de data do funil (#989) precisa que a regra guarde o funil, o
      // campo e o N assinado; os outros gatilhos gravam o objeto vazio.
      trigger_config: regra.trigger_config ?? {},
    })
    .select("*")
    .single();
  if (error || !criada) {
    return falha("internal_error", error?.message ?? "automation_rule_insert_failed", 500, {
      traduzivel: false,
    });
  }

  void audit({
    action: "automation.rule_created",
    actorUserId: autorUsuario(ator.actor),
    actorApiTokenId: ator.apiTokenId,
    organizationId: orgId,
    resourceType: "automation_rule",
    resourceId: criada.id as string,
    requestId: ator.requestId,
    metadata: { name: regra.name, trigger_event: regra.trigger_event },
  });
  return { ok: true, regra: criada as Record<string, unknown> & { id: string } };
}

// ---------------------------------------------------------------------------
// alterar
// ---------------------------------------------------------------------------

export interface RegraGravada {
  id: string;
  is_active: boolean;
  trigger_event: string;
  trigger_config: unknown;
  actions: { type: string }[] | null;
  conditions: Conditions | null;
}

export async function lerRegraGravada(
  db: SupabaseClient,
  orgId: string,
  id: string,
): Promise<{ ok: true; regra: RegraGravada } | FalhaDaRegra> {
  const { data, error } = await db
    .from("automation_rules")
    .select("id, is_active, trigger_event, trigger_config, actions, conditions")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return falha("internal_error", error.message, 500, { traduzivel: false });
  if (!data) return falha("not_found", "Regra não encontrada.", 404);
  return { ok: true, regra: data as unknown as RegraGravada };
}

export async function atualizarRegra(
  db: SupabaseClient,
  args: {
    orgId: string;
    id: string;
    admin: SupabaseClient;
    patch: AtualizarRegra;
    ator: AtorDaRegra;
    /** Já lida por quem chama (o MCP lê antes para conferir se está pausada). */
    gravada?: RegraGravada;
  },
): Promise<{ ok: true; regra: Record<string, unknown> } | FalhaDaRegra> {
  const { orgId, id, patch, ator } = args;

  let gravada = args.gravada;
  if (!gravada) {
    const lida = await lerRegraGravada(db, orgId, id);
    if (!lida.ok) return lida;
    gravada = lida.regra;
  }

  const fonte = await fonteDaOrganizacao(db, orgId, patch.trigger_config);
  if (fonte) return fonte;

  // O PATCH parcial (só o gatilho, ou só as ações) monta o laço de #1528 pela
  // porta do lado: o schema só o vê quando os dois vêm juntos. Desligar a regra
  // (só `is_active`) nunca é barrado.
  if (
    (patch.trigger_event !== undefined || patch.actions !== undefined) &&
    acoesQueFechamLaco(
      patch.trigger_event ?? gravada.trigger_event,
      patch.actions ?? gravada.actions ?? [],
    ).length
  ) {
    return falha("invalid_request", MENSAGEM_DO_LACO_DE_LEAD, 400);
  }

  // Mesma régua do criar, e só quando o PATCH TRAZ ações: regra antiga que
  // aponta para a etapa de perda sem motivo continua sendo salva quando o que
  // muda é o nome ou o interruptor — ela é que falha em execução, com o código
  // real no recibo (`lost_reason_required`). Depois do laço de propósito: aquele
  // veto é estrutural e não custa banco.
  if (patch.actions !== undefined) {
    const perda = await perdaSemMotivo(db, orgId, patch.actions, ator.idioma);
    if (perda) return perda;
  }

  // A condição `campo_alterado` (#1749) lê `event.fields`, que só o gatilho de
  // "negócio alterado" carrega. Aqui é o par MESCLADO: no PATCH parcial o schema
  // não vê os dois lados, e trocar `lead.updated` por outro gatilho deixaria a
  // condição gravada e a regra decorativa, sem erro nenhum.
  if (
    (patch.trigger_event !== undefined || patch.conditions !== undefined) &&
    condicoesQueSoExistemNoNegocioAlterado(
      patch.trigger_event ?? gravada.trigger_event,
      patch.conditions ?? gravada.conditions ?? undefined,
    ).length
  ) {
    return falha("invalid_request", MENSAGEM_DO_CAMPO_ALTERADO_FORA_DO_GATILHO, 400);
  }

  // Gatilho por data num campo do contato (#2791) nunca dispara: a regra que
  // chega assim — regravada ou religada — é recusada. Desligar e renomear não
  // passam por aqui.
  if (
    patch.trigger_event !== undefined ||
    patch.trigger_config !== undefined ||
    patch.is_active === true
  ) {
    const data = await gatilhoDeDataDoContato(
      db,
      orgId,
      patch.trigger_event ?? gravada.trigger_event,
      patch.trigger_config ?? gravada.trigger_config,
    );
    if (data) return data;
  }

  // A autoria vai junto de TODA escrita: uma regra ligada é o estado mais
  // perigoso do sistema, e a tela precisa dizer quem a ligou (migration 0101).
  const mudanca: Record<string, unknown> = {
    ...patch,
    updated_at: new Date().toISOString(),
    ...autoriaDaMudanca(ator.actor),
  };
  if (patch.actions !== undefined) {
    // secret_enc existente (round-trip do editor) passa intacto.
    const acoesSeguras = await encryptRuleActionSecrets(args.admin, patch.actions);
    if (acoesSeguras === null) return falha("encryption_unavailable", SEM_CIFRA, 422);
    mudanca.actions = acoesSeguras;
  }

  const { data: atualizada, error } = await db
    .from("automation_rules")
    .update(mudanca)
    .eq("id", id)
    .eq("organization_id", orgId)
    .select("*")
    .single();
  if (error || !atualizada) {
    return falha("internal_error", error?.message ?? "automation_rule_update_failed", 500, {
      traduzivel: false,
    });
  }

  const { actions: _acoesComSegredo, ...auditavel } = patch;
  void audit({
    action: "automation.rule_updated",
    actorUserId: autorUsuario(ator.actor),
    actorApiTokenId: ator.apiTokenId,
    organizationId: orgId,
    resourceType: "automation_rule",
    resourceId: id,
    requestId: ator.requestId,
    // actions fora do audit: config de call_webhook carrega secret plaintext no input.
    metadata: { ...auditavel, ...(patch.actions !== undefined ? { actions_changed: true } : {}) },
  });
  return { ok: true, regra: atualizada as Record<string, unknown> };
}
