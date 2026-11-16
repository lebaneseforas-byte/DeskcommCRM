/**
 * OS EFEITOS DO ESCALONAMENTO DA PASSAGEM — o mundo real de
 * `aplicarEscalonamento` (`./escalonamento-da-passagem.ts`).
 *
 * Três saídas, nenhuma nova:
 *
 *   · **Central** — um aviso `handoff` com DONO (`para_user_id`, 0689). O
 *     gatilho `trg_aviso_da_central_criado` (0442) anuncia o aviso no
 *     barramento, e `lib/notifications/push-dos-avisos.ts` leva o push ao
 *     celular SÓ daquela pessoa, com o link da conversa. Não há segundo caminho
 *     de push para manter.
 *   · **WhatsApp** — pelo transporte do AVISO DE PASSAGEM
 *     (`criarTransporteDoAviso`, o mesmo de `aviso-de-handoff.ts`), com o texto
 *     dele (`textoDoAvisoHandoff`: sem nome, sem motivo, só o link, no idioma da
 *     organização, com `URGENTE:` na frente quando é urgente). Sai só se o
 *     aviso no WhatsApp está LIGADO (`config_aviso_de_caso`), se as
 *     transferências não foram desligadas, e se o responsável cadastrou o
 *     próprio WhatsApp. O destino é o número de um MEMBRO da equipe — nunca um
 *     contato: o número de uma conexão da própria organização é recusado
 *     (`destinoEhDaPropriaOrganizacao`), e o contato anonimizado cala o aviso.
 *   · **Auditoria** — uma linha por lembrete ou escalada, nunca por varredura.
 *
 * O `organization_id` é filtrado À MÃO em toda leitura e escrita: o client é o
 * de service role, que bypassa a RLS. A organização vem da linha da passagem
 * (fonte do servidor), nunca de um corpo de requisição.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { avisoDeTransferenciaLigado } from "@/lib/schemas/settings";

import { textoDoAvisoHandoff } from "./aviso-de-handoff";
import { ESTADOS_EM_ABERTO, type EfeitosDoEscalonamento, type PassagemLida } from "./escalonamento-da-passagem";

type Admin = SupabaseClient;

/** O que o cron já leu da organização — idioma e settings, uma vez por rodada. */
export interface OrganizacaoDoEscalonamento {
  idioma: Idioma;
  settings: unknown;
}

export function idiomaDaLinha(locale: string | null | undefined): Idioma {
  return normalizarIdioma(locale ?? null);
}

/**
 * O título do aviso. Frase NOSSA, no idioma da organização, sem dado de
 * cliente: o push leva este título à tela bloqueada (`push-dos-avisos.ts`).
 */
export function tituloDoLembrete(
  entrada: { tipo: "lembrete" | "escalada"; urgente: boolean; ultimo: boolean },
  idioma: Idioma,
): string {
  const t = (texto: string) => traduzir(texto, idioma);
  if (entrada.tipo === "escalada") return t("Um atendimento urgente passou para você");
  return entrada.urgente
    ? t("Atendimento urgente esperando você aceitar")
    : t("Um atendimento espera você aceitar");
}

export function corpoDoLembrete(
  entrada: { tipo: "lembrete" | "escalada"; ultimo: boolean },
  idioma: Idioma,
): string {
  const t = (texto: string) => traduzir(texto, idioma);
  const base =
    entrada.tipo === "escalada"
      ? t("O responsável não aceitou a tempo e esta conversa agora é sua. Abra a conversa e toque em Aceitar.")
      : t("A IA passou esta conversa para uma pessoa e ninguém aceitou ainda. Abra a conversa e toque em Aceitar.");
  return entrada.ultimo ? `${base} ${t("Este é o último aviso automático sobre esta conversa.")}` : base;
}

export function criarEfeitosDoEscalonamento(
  admin: Admin,
  opcoes: {
    requestId: string;
    urlPublica: string;
    organizacao: (orgId: string) => OrganizacaoDoEscalonamento;
  },
): EfeitosDoEscalonamento {
  const { requestId, urlPublica } = opcoes;

  return {
    async reivindicar(lida: PassagemLida, novo) {
      let q = admin
        .from("passagens_de_atendimento")
        .update(novo)
        .eq("id", lida.id)
        .eq("organization_id", lida.organization_id)
        .eq("lembretes_enviados", lida.lembretes_enviados)
        .in("estado", [...ESTADOS_EM_ABERTO]);
      q = lida.ultimo_lembrete_em === null
        ? q.is("ultimo_lembrete_em", null)
        : q.eq("ultimo_lembrete_em", lida.ultimo_lembrete_em);
      q = lida.escalada_em === null ? q.is("escalada_em", null) : q.eq("escalada_em", lida.escalada_em);
      const { data, error } = await q.select("id");
      if (error) {
        logger.error("[passagem-escalonamento] reivindicação falhou", {
          passagem_id: lida.id,
          error: error.message,
          requestId,
        });
        return false;
      }
      return (data?.length ?? 0) === 1;
    },

    async avisarNaCentral({ lida, para, tipo, numero, ultimo }) {
      const { idioma } = opcoes.organizacao(lida.organization_id);
      // O lembrete anterior DESTA série sai da lista antes do novo entrar: dois
      // avisos sobre o mesmo atendimento fazem a pessoa resolver um e continuar
      // vendo o outro. O aviso da EMPRESA (sem dono, o da passagem) fica.
      await admin
        .from("agent_inbox_items")
        .update({ status: "resolved", resolved_at: new Date().toISOString() })
        .eq("organization_id", lida.organization_id)
        .eq("kind", "handoff")
        .eq("ref_kind", "conversation")
        .eq("ref_id", lida.conversation_id)
        .eq("status", "open")
        .not("para_user_id", "is", null);
      const { error } = await admin.from("agent_inbox_items").insert({
        organization_id: lida.organization_id,
        kind: "handoff",
        // Urgente é `critical`: o cliente marcou como urgente/reclamação e há
        // um prazo de 15 minutos correndo. O normal continua `warn`.
        severity: lida.urgente ? "critical" : "warn",
        title: tituloDoLembrete({ tipo, urgente: lida.urgente, ultimo }, idioma),
        body: corpoDoLembrete({ tipo, ultimo }, idioma),
        ref_kind: "conversation",
        ref_id: lida.conversation_id,
        para_user_id: para,
      });
      if (error) {
        logger.error("[passagem-escalonamento] aviso da Central não foi aberto", {
          passagem_id: lida.id,
          numero,
          error: error.message,
          requestId,
        });
      }
    },

    async enviarWhatsapp({ lida, para }) {
      try {
        return await enviarPeloAvisoDePassagem(admin, {
          organizationId: lida.organization_id,
          conversationId: lida.conversation_id,
          contactId: lida.contact_id,
          userId: para,
          urlPublica,
          settings: opcoes.organizacao(lida.organization_id).settings,
          idioma: opcoes.organizacao(lida.organization_id).idioma,
          urgente: lida.urgente,
        });
      } catch {
        // Sem telefone, motivo livre ou detalhe de provedor no log.
        return "falha_no_transporte";
      }
    },

    async auditar({ action, lida, metadata }) {
      await audit({
        action,
        organizationId: lida.organization_id,
        resourceType: "conversation",
        resourceId: lida.conversation_id,
        requestId,
        metadata: { passagem_id: lida.id, ...metadata },
      });
    },
  };
}

/**
 * O WhatsApp do RESPONSÁVEL, pelo transporte do aviso de passagem. Devolve o
 * motivo (vocabulário fechado, vai à auditoria) e nunca lança por regra —
 * só por falha de leitura, que o chamador converte.
 */
async function enviarPeloAvisoDePassagem(
  admin: Admin,
  e: {
    organizationId: string;
    conversationId: string;
    contactId: string;
    userId: string;
    urlPublica: string;
    settings: unknown;
    idioma: Idioma;
    urgente: boolean;
  },
): Promise<string> {
  if (!avisoDeTransferenciaLigado(e.settings)) return "desligado_em_transferencias";
  const texto = textoDoAvisoHandoff(e.urlPublica, e.conversationId, e.idioma, { urgente: e.urgente });
  if (!texto) return "endereco_publico_invalido";

  const [{ createSupabaseAvisoDb }, { criarTransporteDoAviso }, { criarPacingDoCanal }, { carregaWhatsappsDosMembros }] =
    await Promise.all([
      import("./aviso-ao-suporte"),
      import("./aviso-ao-suporte.handler"),
      import("@/lib/agent-engine/pacing/ledger-supabase"),
      import("./membros-do-aviso"),
    ]);
  const db = createSupabaseAvisoDb(admin);
  const config = await db.carregaConfig(e.organizationId);
  if (!config?.ligado || !config.channel_session_id) return "aviso_desligado";

  const whatsapps = await carregaWhatsappsDosMembros(admin, e.organizationId, [e.userId]);
  const telefone = whatsapps.get(e.userId) ?? null;
  if (!telefone) return "responsavel_sem_whatsapp";

  if (await db.contatoAnonimizado(e.organizationId, e.contactId)) return "contato_anonimizado";
  const canal = await db.carregaCanal(e.organizationId, config.channel_session_id);
  if (!canal || canal.archived_at || canal.desativado || !canal.aceitaMensagemLivre) return "canal_indisponivel";
  if (canal.status !== "WORKING") return "canal_desconectado";
  // O número do membro não pode ser uma conexão da própria organização: a
  // mensagem entraria como conversa de cliente no próprio CRM.
  if (await db.destinoEhDaPropriaOrganizacao(e.organizationId, telefone)) return "destino_circular";

  const transporte = await criarTransporteDoAviso(admin as never);
  if (!(await transporte.configurado(e.organizationId, canal))) return "canal_sem_chave";
  const destino = await transporte.resolveDestino(e.organizationId, canal, telefone);
  if (!destino) return "destino_invalido";
  const pacing = await criarPacingDoCanal(admin);
  const agora = new Date();
  const decisao = await pacing.decide(e.organizationId, canal.id, agora);
  // Sem fila de reenvio de propósito: o próximo lembrete (ou a Central, que já
  // recebeu este) cobre. Esperar o canal liberar seria um segundo relógio.
  if (!decisao.liberado) return `pacing_${decisao.motivo}`;

  let resultado: string;
  try {
    const envio = await transporte.envia(e.organizationId, canal, destino, texto);
    resultado = envio.externalId ? "enviado" : "incerto";
    if (envio.externalId) await db.registraJidDoAviso(e.organizationId, destino);
  } catch {
    resultado = "incerto";
  }
  // Conta até a tentativa incerta, como o aviso de passagem.
  await pacing.registraEnvio(e.organizationId, canal.id, agora);
  return resultado;
}
