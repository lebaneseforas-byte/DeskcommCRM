/**
 * CRIAR O RASCUNHO DE UMA CAMPANHA — a parte que `POST /api/v1/campaigns` e o
 * MCP do CRM (o dono pelo ChatGPT) fazem igual.
 *
 * Saiu da rota para não haver duas réguas: a conexão é conferida CONTRA A
 * ORGANIZAÇÃO, o conteúdo segue o que o canal aceita (`decidirConteudo`: texto
 * livre no QR, modelo aprovado no oficial, assunto + corpo no e-mail), a
 * velocidade passa por `decidirVelocidade`, o pool de números é gravado sem
 * derrubar a criação, e a criação audita `campaign.created`. Nada é enviado: a
 * campanha nasce `draft`.
 *
 * ⚠️ `admin` é o client de SERVIÇO (a 0375 dá a `authenticated` só SELECT em
 * `campaigns`), e a organização vem de quem chama — nunca do corpo — e entra em
 * toda consulta. `t` traduz as frases (a rota passa o idioma da pessoa; o MCP,
 * a identidade).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import { audit } from "@/lib/audit";
import { FILTRO_VAZIO } from "@/lib/campanhas/audiencia";
import {
  camposDeGravacao,
  decidirConteudo,
  decidirVelocidade,
  fraseDaRecusa,
  lerModoDoCanal,
} from "@/lib/campanhas/conteudo-do-canal";
import { gravarPool } from "@/lib/campanhas/pool-de-numeros";
import type { criarCampanhaSchema } from "@/lib/campanhas/schemas";

export const COLUNAS_DA_LISTA_DE_CAMPANHAS =
  "id, name, status, channel_session_id, snapshot_total, snapshot_eligible, snapshot_excluded, " +
  "scheduled_at, started_at, completed_at, cancelled_at, created_at, created_by, " +
  "pipeline_id, stage_id, agent_id, message_mode, email_subject, provider_template_name";

export type ResultadoDaCriacao =
  | { ok: true; campanha: Record<string, unknown> & { id: string } }
  | { ok: false; codigo: string; mensagem: string; status: number };

export async function criarCampanha(
  admin: SupabaseClient,
  args: {
    orgId: string;
    entrada: z.infer<typeof criarCampanhaSchema>;
    /** Só quando é uma pessoa: o token não é usuário, e `created_by` aceita NULL. */
    autorUserId: string | null;
    apiTokenId: string | null;
    requestId: string;
    t: (texto: string) => string;
  },
): Promise<ResultadoDaCriacao> {
  const { orgId, entrada, t } = args;

  // A conexão é conferida CONTRA A ORGANIZAÇÃO: a FK composta da 0375 recusaria
  // o número de outro tenant, mas a recusa do banco chegaria como erro genérico.
  // Sem número, o canal é E-MAIL.
  const canal = await lerModoDoCanal(admin, orgId, entrada.channel_session_id ?? null);
  if (!canal.existe) {
    return {
      ok: false,
      codigo: "campanha_canal_indisponivel",
      mensagem: t("Escolha uma conexão de WhatsApp desta organização."),
      status: 409,
    };
  }
  const conteudo = await decidirConteudo(admin, {
    organizationId: orgId,
    channelSessionId: entrada.channel_session_id ?? null,
    extras: entrada.channel_session_ids ?? [],
    modoDoCanal: canal.modo,
    pedido: entrada,
  });
  if (!conteudo.ok)
    return {
      ok: false,
      codigo: conteudo.codigo,
      mensagem: t(conteudo.mensagem),
      status: conteudo.status,
    };

  // Rápida e broadcast só com modelo aprovado (0711 e 0712); o broadcast, só no
  // número que o faz e com variáveis de texto fixo.
  const velocidade = decidirVelocidade({
    pedida: entrada.velocidade,
    atual: "gradual",
    modo: conteudo.modo,
    transmissao: canal.transmissao,
    variaveis: conteudo.colunas.provider_template_variables,
  });
  if (!velocidade.ok) {
    return {
      ok: false,
      codigo: velocidade.codigo,
      mensagem: fraseDaRecusa(velocidade, t),
      status: velocidade.status,
    };
  }

  const { data, error } = await admin
    .from("campaigns")
    .insert({
      organization_id: orgId,
      name: entrada.name,
      description: entrada.description ?? null,
      channel_session_id: entrada.channel_session_id ?? null,
      // A MESMA decisão que validou vira linha (`camposDeGravacao`).
      ...camposDeGravacao(conteudo, entrada.message_body),
      base_legal: entrada.base_legal,
      lia_ref: entrada.lia_ref ?? null,
      audience_filter: entrada.audience_filter ?? FILTRO_VAZIO,
      intervalo_segundos: entrada.intervalo_segundos ?? null,
      janela_inicio_hora: entrada.janela_inicio_hora ?? null,
      janela_fim_hora: entrada.janela_fim_hora ?? null,
      teto_diario: entrada.teto_diario ?? null,
      teto_horario: entrada.teto_horario ?? null,
      velocidade: velocidade.velocidade,
      split_messages: entrada.split_messages ?? false,
      pipeline_id: entrada.pipeline_id ?? null,
      stage_id: entrada.stage_id ?? null,
      agent_id: entrada.agent_id ?? null,
      created_by: args.autorUserId,
    })
    .select(COLUNAS_DA_LISTA_DE_CAMPANHAS)
    .single();
  if (error || !data) {
    return {
      ok: false,
      codigo: "internal_error",
      mensagem: error?.message ?? t("Não foi possível criar a campanha."),
      status: 500,
    };
  }
  const criada = data as unknown as Record<string, unknown> & { id: string };

  if ((entrada.channel_session_ids ?? []).length > 0 && entrada.channel_session_id) {
    // Falha do pool NÃO derruba a criação: a campanha existe e fala pelo número
    // principal. Devolver erro faria o operador criar de novo.
    try {
      await gravarPool(admin, {
        organizationId: orgId,
        campanhaId: criada.id,
        principal: entrada.channel_session_id,
        extras: entrada.channel_session_ids ?? [],
      });
    } catch {
      // A tela mostra o pool salvo quando recarrega, que é a fonte da verdade.
    }
  }

  void audit({
    action: "campaign.created",
    actorUserId: args.autorUserId,
    actorApiTokenId: args.apiTokenId,
    organizationId: orgId,
    resourceType: "campaign",
    resourceId: criada.id,
    requestId: args.requestId,
    metadata: {
      base_legal: entrada.base_legal,
      numeros: 1 + (entrada.channel_session_ids ?? []).length,
      modo: conteudo.modo,
      ...(conteudo.colunas.provider_template_name
        ? { modelo: conteudo.colunas.provider_template_name }
        : {}),
    },
  });
  return { ok: true, campanha: criada };
}
