/**
 * O RESPONSÁVEL QUE CHEGA DEPOIS — a passagem viva sem responsável ganha um na
 * varredura do escalonamento.
 *
 * ## O defeito, medido (16/11/2026)
 *
 * O responsável de uma passagem é decidido por `fn_passagem_responsavel_inicial`
 * (migration 9401: dono da conversa → dono do negócio aberto → rota por
 * etiqueta) em dois momentos só: quando a passagem NASCE e quando as etiquetas
 * da conversa ou do contato MUDAM. Uma configuração salva DEPOIS — a rota por
 * etiqueta ligada às 19:45 numa instalação real — não alcançava as passagens
 * que já esperavam: três passagens vivas, com `projeto` à vista, ficaram com
 * responsável nulo, e cada lembrete saiu com o WhatsApp `sem_responsavel`.
 * Ninguém foi avisado do cliente que esperava.
 *
 * ## O que faz
 *
 * Para a passagem viva sem responsável, pergunta ao banco a MESMA função (nada
 * de reescrever a régua em TypeScript) e grava o resultado com compare-and-set
 * (`responsavel_user_id is null`): quem aceitou ou atribuiu no meio-tempo vence,
 * e esta varredura não sobrescreve ninguém. `pendente` vira `atribuida`, como o
 * gatilho das etiquetas faz; `reaberta` fica `reaberta`.
 *
 * Audita só quando gravou (`handoff.responsible_assigned`) — rodada sem efeito
 * não escreve nada. Nunca lança: falha deixa a passagem como estava, e o
 * lembrete segue para a Central como antes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import type { PassagemLida } from "@/lib/escalacao/escalonamento-da-passagem";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIVOS = ["pendente", "atribuida", "reaberta"] as const;

export async function completarResponsavel(
  admin: SupabaseClient,
  lida: PassagemLida,
  requestId: string,
): Promise<PassagemLida> {
  if (lida.responsavel_user_id) return lida;
  try {
    const { data: quem, error } = await admin.rpc("fn_passagem_responsavel_inicial", {
      p_organization_id: lida.organization_id,
      p_conversation_id: lida.conversation_id,
      p_contact_id: lida.contact_id,
    });
    if (error || typeof quem !== "string" || !UUID.test(quem)) return lida;

    const estado = lida.estado === "pendente" ? "atribuida" : lida.estado;
    const { data: gravada, error: erroGravar } = await admin
      .from("passagens_de_atendimento")
      .update({ responsavel_user_id: quem, estado })
      .eq("organization_id", lida.organization_id)
      .eq("id", lida.id)
      .is("responsavel_user_id", null)
      .in("estado", [...VIVOS])
      .select("responsavel_user_id, estado")
      .maybeSingle();
    if (erroGravar || !gravada) return lida;

    const linha = gravada as { responsavel_user_id: string; estado: string };
    await audit({
      action: "handoff.responsible_assigned",
      organizationId: lida.organization_id,
      resourceType: "conversation",
      resourceId: lida.conversation_id,
      requestId,
      metadata: { passagem_id: lida.id, responsavel_user_id: linha.responsavel_user_id, via: "varredura" },
    });
    return { ...lida, responsavel_user_id: linha.responsavel_user_id, estado: linha.estado as PassagemLida["estado"] };
  } catch {
    return lida;
  }
}
