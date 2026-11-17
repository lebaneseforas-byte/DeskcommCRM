/**
 * ESCREVER UM FLUXO DE FOLLOW-UP — a parte que as rotas de
 * `app/api/v1/ai/followup-flows` e o MCP do CRM (o dono pelo ChatGPT) fazem
 * igual: criar, salvar o rascunho, publicar e desligar.
 *
 * Saiu das rotas para não haver duas réguas de publicação. As regras são as de
 * sempre: o gatilho tem de ter motor, a etapa do gatilho tem de existir e estar
 * ativa, o rascunho passa por `validateFlowForPublish`, e a publicação é a função
 * atômica `fn_publish_followup_flow_version` (por isso `publicarFluxo` exige o
 * client de SERVIÇO — o EXECUTE dela é só do service_role).
 *
 * ⚠️ A organização vem de quem chama (sessão ou linha do token), nunca do corpo,
 * e vai explícita em toda consulta. Cada escrita audita com o autor que houver:
 * a pessoa (`userId`) ou a conexão (`apiTokenId`).
 *
 * As mensagens saem em português, com `traduzivel` dizendo se a frase é fixa
 * (a rota a passa por `traduzir`) ou montada com um nome (vai como está — era
 * assim antes da extração).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import {
  triggerConfigSchema,
  type FollowupFlowSurface,
  type patchFollowupFlowSchema,
} from "@/lib/followup/api-schemas";
import { carregaEtapasCitadas } from "@/lib/followup/etapas-citadas";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import { carregaModelosCitados } from "@/lib/followup/modelos-citados";
import { publishFollowupFlowVersion } from "@/lib/followup/publish";
import {
  algumCanalExigeModeloForaDaJanela,
  proximosDoGrafo,
  validateFlowForPublish,
  type RoteiroDoPublish,
} from "@/lib/followup/validate-publish";
import { moduloLigado } from "@/lib/instalacao/modulos";
import type { z } from "zod";

export interface AtorDoFluxo {
  userId: string | null;
  apiTokenId: string | null;
  requestId: string;
}

export interface FalhaDoFluxo {
  ok: false;
  codigo: string;
  mensagem: string;
  traduzivel: boolean;
  status: number;
  /** Os erros da validação de publicação, quando for ela que recusou. */
  erros?: Array<{ node_id: string | null; code: string; message: string }>;
}

export const COLUNAS_DO_FLUXO =
  "id, name, status, active_version_id, draft_graph, handoff_policy, send_when_assigned, trigger_config, surface, created_at, updated_at";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ⚠️ ALLOWLIST, NÃO DENYLIST — e a diferença não é estilo.
 *
 * `trigger_config` é `jsonb` SEM CHECK, e a publicação lê a linha CRUA do banco
 * — não passa pelo Zod do PATCH. Uma linha escrita por SQL à mão, por um clone
 * open-source ou por uma versão futura publicaria `status='active'` e nunca
 * inscreveria ninguém: fluxo morto com cara de vivo.
 *
 * Kind entra aqui só DEPOIS de ter motor de inscrição vivo: `manual`/`webhook`
 * (POST enroll + ação de regra), `silence` (silence-sweep), `stage_change`
 * (gatilho-etapa), `case_opened` (gatilho-caso), `appointment_no_show`
 * (gatilho-presenca, confirmação humana), `inbound_after_silence`
 * (gatilho-retorno) e `lead_created` (gatilho-lead).
 */
const KINDS_COM_MOTOR = new Set([
  "manual",
  "webhook",
  "silence",
  "stage_change",
  "case_opened",
  "appointment_no_show",
  "inbound_after_silence",
  "lead_created",
]);

const ROTEIRO_COMECA_POR_PALAVRA =
  "Roteiro de atendimento começa por palavra-gatilho ou pelo roteador, não por gatilho de follow-up.";

function falha(
  codigo: string,
  mensagem: string,
  status: number,
  extra: { traduzivel?: boolean; erros?: FalhaDoFluxo["erros"] } = {},
): FalhaDoFluxo {
  return {
    ok: false,
    codigo,
    mensagem,
    status,
    traduzivel: extra.traduzivel ?? true,
    ...(extra.erros ? { erros: extra.erros } : {}),
  };
}

const naoEncontrado = () => falha("not_found", "Fluxo não encontrado.", 404);

// ---------------------------------------------------------------------------
// salvar (o PATCH da tela)
// ---------------------------------------------------------------------------

export async function salvarFluxo(
  db: SupabaseClient,
  args: {
    orgId: string;
    id: string;
    patch: z.infer<typeof patchFollowupFlowSchema>;
    ator: AtorDoFluxo;
  },
): Promise<{ ok: true; fluxo: Record<string, unknown> } | FalhaDoFluxo> {
  const { data: existente, error: erroLeitura } = await db
    .from("followup_flow_pointers")
    .select("id")
    .eq("id", args.id)
    .eq("organization_id", args.orgId)
    .maybeSingle();
  if (erroLeitura) return falha("internal_error", erroLeitura.message, 500, { traduzivel: false });
  if (!existente) return naoEncontrado();

  if (Object.keys(args.patch).length === 0) {
    const { data, error } = await db
      .from("followup_flow_pointers")
      .select(COLUNAS_DO_FLUXO)
      .eq("id", args.id)
      .eq("organization_id", args.orgId)
      .single();
    if (error || !data)
      return falha("internal_error", error?.message ?? "reload_failed", 500, { traduzivel: false });
    return { ok: true, fluxo: data as Record<string, unknown> };
  }

  const { data: atualizado, error } = await db
    .from("followup_flow_pointers")
    .update({ ...args.patch, updated_at: new Date().toISOString() })
    .eq("id", args.id)
    .eq("organization_id", args.orgId)
    .select(COLUNAS_DO_FLUXO)
    .single();
  if (error || !atualizado) {
    if (error?.code === "23505") return falha("conflict", "Já existe um fluxo com este nome.", 409);
    if (error?.code === "23514") return falha("validation_failed", ROTEIRO_COMECA_POR_PALAVRA, 422);
    return falha("internal_error", error?.message ?? "followup_flow_update_failed", 500, {
      traduzivel: false,
    });
  }

  void audit({
    action: "followup_flow.updated",
    actorUserId: args.ator.userId,
    actorApiTokenId: args.ator.apiTokenId,
    organizationId: args.orgId,
    resourceType: "followup_flow_pointer",
    resourceId: args.id,
    requestId: args.ator.requestId,
    metadata: { fields_changed: Object.keys(args.patch) },
  });
  return { ok: true, fluxo: atualizado as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// publicar
// ---------------------------------------------------------------------------

export async function publicarFluxo(
  admin: SupabaseClient,
  args: { orgId: string; id: string; ator: AtorDoFluxo },
): Promise<
  | {
      ok: true;
      data: {
        id: string;
        status: string;
        active_version_id: string | null;
        updated_at: string;
        avisos: unknown[];
      };
    }
  | FalhaDoFluxo
> {
  const { orgId, id } = args;
  const { data: pointer, error: fetchErr } = await admin
    .from("followup_flow_pointers")
    .select("id, draft_graph, trigger_config, surface")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (fetchErr) return falha("internal_error", fetchErr.message, 500, { traduzivel: false });
  if (!pointer) return naoEncontrado();

  const surface = (pointer.surface ?? "followup") as FollowupFlowSurface;
  // Roteiro de atendimento: só existe com o módulo ligado (mesma resposta de
  // quem não tem a porta), e só começa por palavra-gatilho ou roteador — nunca
  // pelo relógio. Gatilho de relógio num roteiro criaria inscrição que o banco
  // recusa (`trg_enrollment_superficie_coerente`, 0394); a recusa é AQUI.
  if (surface === "atendimento") {
    if (!(await moduloLigado(admin, "fluxos_atendimento"))) return naoEncontrado();
    const kind = (pointer.trigger_config as { kind?: string } | null)?.kind ?? "manual";
    if (kind !== "manual")
      return falha("trigger_kind_not_implemented", ROTEIRO_COMECA_POR_PALAVRA, 422);
  }

  const trigger = (pointer.trigger_config ?? { kind: "manual" }) as {
    kind?: string;
    params?: { stage_id?: string };
  };
  const triggerKind = trigger.kind ?? "manual";
  if (!KINDS_COM_MOTOR.has(triggerKind)) {
    return falha(
      "trigger_kind_not_implemented",
      `O gatilho «${triggerKind}» não está disponível — use Etapa do funil, Silêncio ou Manual.`,
      422,
      { traduzivel: false },
    );
  }

  // ⚠️ ETAPA QUE NÃO EXISTE MAIS É FLUXO MORTO COM CARA DE VIVO. O gatilho casa
  // o `to_stage_id` do evento com este `stage_id`: apontando para etapa apagada,
  // arquivada ou de outra org, o fluxo fica `active` e nunca inscreve ninguém.
  if (triggerKind === "stage_change") {
    const stageId = trigger.params?.stage_id;
    if (!stageId || !UUID_RX.test(stageId)) {
      return falha(
        "trigger_stage_missing",
        "Escolha a etapa do funil que dispara este fluxo antes de publicar.",
        422,
      );
    }
    const { data: stage, error: stageErr } = await admin
      .from("crm_stages")
      .select("id, name, is_archived")
      .eq("id", stageId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (stageErr) return falha("internal_error", stageErr.message, 500, { traduzivel: false });
    if (!stage) {
      return falha(
        "trigger_stage_not_found",
        "A etapa escolhida para o gatilho não existe mais neste funil — escolha outra.",
        422,
      );
    }
    if (stage.is_archived) {
      return falha(
        "trigger_stage_archived",
        `A etapa «${stage.name}» está arquivada e nunca receberia um negócio — escolha uma etapa ativa.`,
        422,
        { traduzivel: false },
      );
    }
  }

  if (!pointer.draft_graph) {
    return falha("validation_failed", "Fluxo não tem rascunho pronto para publicar.", 422, {
      erros: [
        {
          node_id: null,
          code: "no_trigger",
          message: "draft_graph ausente — monte o fluxo antes de publicar.",
        },
      ],
    });
  }

  const graph = pointer.draft_graph as unknown as FlowGraph;
  // A regra de etapa guarda o `stage_id`, e só o banco diz se a etapa existe e
  // está ativa. O motor lança a cada envio quando o modelo do passo não existe
  // NESTA org (fluxo importado de outra conta, ou modelo apagado — #3056).
  const citadas = await carregaEtapasCitadas(admin, orgId, graph.nodes);
  if (!citadas.ok) return falha("internal_error", citadas.mensagem, 500, { traduzivel: false });
  const modelos = await carregaModelosCitados(admin, orgId, graph.nodes);
  if (!modelos.ok) return falha("internal_error", modelos.mensagem, 500, { traduzivel: false });

  // Roteiro: para onde os OUTROS roteiros ativos encadeiam — para recusar a
  // publicação que fecharia um ciclo A → B → A (revisão do #1573).
  let roteiro: RoteiroDoPublish | undefined;
  if (surface === "atendimento") {
    const { data: ativos, error: ativosErr } = await admin
      .from("followup_flow_pointers")
      .select("id, name, active_version_id")
      .eq("organization_id", orgId)
      .eq("surface", "atendimento")
      .eq("status", "active")
      .neq("id", id);
    if (ativosErr) return falha("internal_error", ativosErr.message, 500, { traduzivel: false });
    const versoes = (ativos ?? []).flatMap((r) =>
      r.active_version_id ? [r.active_version_id as string] : [],
    );
    const grafos = new Map<string, unknown>();
    if (versoes.length > 0) {
      const { data: vs, error: vsErr } = await admin
        .from("followup_flow_versions")
        .select("id, graph")
        .eq("organization_id", orgId)
        .in("id", versoes);
      if (vsErr) return falha("internal_error", vsErr.message, 500, { traduzivel: false });
      for (const v of vs ?? []) grafos.set(v.id as string, v.graph);
    }
    roteiro = {
      pointerId: id,
      encadeamentos: new Map(
        (ativos ?? []).map((r) => [
          r.id as string,
          {
            nome: r.name as string,
            proximos: proximosDoGrafo(grafos.get(r.active_version_id as string)),
          },
        ]),
      ),
    };
  }

  const { data: conexoes, error: conexoesErr } = await admin
    .from("channel_sessions")
    .select("provider")
    .eq("organization_id", orgId)
    .is("archived_at", null);
  if (conexoesErr) return falha("internal_error", conexoesErr.message, 500, { traduzivel: false });
  const exigeModeloForaDaJanela = algumCanalExigeModeloForaDaJanela(
    (conexoes ?? []).map((c) => c.provider as string | null),
  );
  const gatilho = triggerConfigSchema.safeParse(pointer.trigger_config);
  const validation = validateFlowForPublish(graph, {
    etapas: citadas.etapas,
    surface,
    roteiro,
    exigeModeloForaDaJanela,
    modelos: modelos.modelos,
    ...(gatilho.success ? { trigger: gatilho.data } : {}),
  });
  if (!validation.ok) {
    return falha("validation_failed", "Fluxo reprovado na validação de publish.", 422, {
      erros: validation.errors as FalhaDoFluxo["erros"],
    });
  }

  const result = await publishFollowupFlowVersion(admin, {
    orgId,
    pointerId: id,
    graph,
    createdBy: args.ator.userId,
  });
  if (!result.ok) {
    if (result.code === "pointer_not_found") return naoEncontrado();
    return falha("internal_error", result.message, 500, { traduzivel: false });
  }

  const { data: updatedPointer, error: reloadErr } = await admin
    .from("followup_flow_pointers")
    .select("id, status, active_version_id, updated_at")
    .eq("id", id)
    .eq("organization_id", orgId)
    .single();
  if (reloadErr || !updatedPointer) {
    return falha("internal_error", reloadErr?.message ?? "followup_flow_reload_failed", 500, {
      traduzivel: false,
    });
  }

  void audit({
    action: "followup_flow.published",
    actorUserId: args.ator.userId,
    actorApiTokenId: args.ator.apiTokenId,
    organizationId: orgId,
    resourceType: "followup_flow_pointer",
    resourceId: id,
    requestId: args.ator.requestId,
    metadata: { version_id: result.version_id },
  });

  return {
    ok: true,
    data: {
      ...(updatedPointer as {
        id: string;
        status: string;
        active_version_id: string | null;
        updated_at: string;
      }),
      avisos: validation.warnings ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// desligar
// ---------------------------------------------------------------------------

export async function desligarFluxo(
  db: SupabaseClient,
  args: { orgId: string; id: string; ator: AtorDoFluxo },
): Promise<{ ok: true; data: { id: string; status: string; updated_at?: string } } | FalhaDoFluxo> {
  const { data: existente, error: fetchErr } = await db
    .from("followup_flow_pointers")
    .select("id, status")
    .eq("id", args.id)
    .eq("organization_id", args.orgId)
    .maybeSingle();
  if (fetchErr) return falha("internal_error", fetchErr.message, 500, { traduzivel: false });
  if (!existente) return naoEncontrado();
  if (existente.status === "disabled")
    return { ok: true, data: { id: args.id, status: "disabled" } };

  const { data: atualizado, error } = await db
    .from("followup_flow_pointers")
    .update({ status: "disabled", updated_at: new Date().toISOString() })
    .eq("id", args.id)
    .eq("organization_id", args.orgId)
    .select("id, status, updated_at")
    .single();
  if (error || !atualizado) {
    return falha("internal_error", error?.message ?? "followup_flow_disable_failed", 500, {
      traduzivel: false,
    });
  }

  void audit({
    action: "followup_flow.disabled",
    actorUserId: args.ator.userId,
    actorApiTokenId: args.ator.apiTokenId,
    organizationId: args.orgId,
    resourceType: "followup_flow_pointer",
    resourceId: args.id,
    requestId: args.ator.requestId,
  });
  return { ok: true, data: atualizado as { id: string; status: string; updated_at: string } };
}

// ---------------------------------------------------------------------------
// criar (o POST da tela)
// ---------------------------------------------------------------------------

/**
 * Nasce `status='draft'`, sem rascunho, gatilho `manual` (defaults do banco).
 * A superfície `atendimento` só com o módulo ligado — e a resposta, sem ele, é
 * "não encontrado", como a da rota.
 */
export async function criarFluxo(
  db: SupabaseClient,
  args: {
    orgId: string;
    nome: string;
    surface?: FollowupFlowSurface;
    moduloDb: SupabaseClient;
    ator: AtorDoFluxo;
  },
): Promise<{ ok: true; fluxo: Record<string, unknown> } | FalhaDoFluxo> {
  if (
    args.surface === "atendimento" &&
    !(await moduloLigado(args.moduloDb, "fluxos_atendimento"))
  ) {
    return naoEncontrado();
  }
  const { data: criado, error } = await db
    .from("followup_flow_pointers")
    .insert({
      organization_id: args.orgId,
      name: args.nome,
      ...(args.surface !== undefined ? { surface: args.surface } : {}),
    })
    .select("*")
    .single();
  if (error || !criado) {
    if (error?.code === "23505") return falha("conflict", "Já existe um fluxo com este nome.", 409);
    return falha("internal_error", error?.message ?? "followup_flow_insert_failed", 500, {
      traduzivel: false,
    });
  }
  void audit({
    action: "followup_flow.created",
    actorUserId: args.ator.userId,
    actorApiTokenId: args.ator.apiTokenId,
    organizationId: args.orgId,
    resourceType: "followup_flow_pointer",
    resourceId: criado.id as string,
    requestId: args.ator.requestId,
    metadata: { name: args.nome },
  });
  return { ok: true, fluxo: criado as Record<string, unknown> };
}
