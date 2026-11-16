import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/conversations/[id]/passagens/aceitar — "é comigo".
 *
 * A passagem ENTREGUE (rodízio, transferência, escalada) não é passagem
 * ACEITA (migration 9401). Este é o gesto que fecha a diferença: o responsável
 * — ou um `admin`, ou qualquer `agent`+ quando ninguém responde por ela ainda —
 * aceita, a conversa passa a ser dele e o escalonamento para de cobrar.
 *
 * ## A ordem, e por que é esta
 *
 *   1. lê a passagem viva daquela conversa (sem ela: aceita → 200 idempotente;
 *      nenhuma → 404);
 *   2. confere quem pode (o mesmo que `fn_passagem_aceitar` confere de novo
 *      dentro da transação — a rota recusa cedo, o banco recusa sempre);
 *   3. ATRIBUI a conversa a quem aceita pela `fn_conversation_assign`, com os
 *      efeitos do botão Assumir (`assumirConversaComEfeitos`: auditoria,
 *      evento, linha na timeline) — nunca um UPDATE cru. Assumir também mantém
 *      a IA calada (`bot_silenced_until = 'infinity'`, 0173), que é o que a
 *      passagem já tinha feito;
 *   4. `fn_passagem_aceitar` fecha o estado e resolve o aviso da Central.
 *
 * ## O reserva que não enxerga a conversa
 *
 * Numa organização em "Só os seus", o reserva para quem a passagem urgente
 * escalou não VÊ a conversa de outro atendente — e o claim pela sessão volta
 * zero linhas. Só nesse caso, e só para quem o SERVIDOR já designou como
 * responsável da passagem (`responsavel_user_id`, gravado pelo gatilho ou pelo
 * cron, nunca pelo corpo), a atribuição vai pelo client de serviço, com o
 * mesmo `expected_assignee`. Sem isto a escalada levaria a pessoa a uma
 * conversa que ela não consegue abrir.
 *
 * Idempotente: aceitar de novo devolve 200 com `ja_aceita: true` e não audita.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { passagemEmAberto } from "@/lib/escalacao/escalonamento-da-passagem";
import { traduzir } from "@/lib/i18n/dicionario";
import { assumirConversaComEfeitos } from "@/lib/inbox/assumir-conversa";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PassagemDoAceite {
  id: string;
  estado: string;
  responsavel_user_id: string | null;
  aceita_em: string | null;
  aceita_por: string | null;
  criado_em: string;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "passagens_de_atendimento" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  if (!UUID.test(id)) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  const orgId = authz.org.orgId;
  const eu = authz.user.id;
  const ehAdmin = authz.org.role === "admin";
  const admin = createAdminClient();

  // ⚠️ organização filtrada à mão: service role bypassa a RLS. A organização
  // vem da sessão (`requireRole`), nunca do corpo.
  const [{ data: conversa }, { data: linhas, error: erroLeitura }] = await Promise.all([
    admin
      .from("conversations")
      .select("id, assigned_to_user_id")
      .eq("organization_id", orgId)
      .eq("id", id)
      .maybeSingle(),
    admin
      .from("passagens_de_atendimento")
      .select("id, estado, responsavel_user_id, aceita_em, aceita_por, criado_em")
      .eq("organization_id", orgId)
      .eq("conversation_id", id)
      .order("criado_em", { ascending: false })
      .limit(20),
  ]);
  if (erroLeitura) {
    logger.error("[passagem.aceitar] leitura falhou", { conversation_id: id, error: erroLeitura.message, requestId });
    return fail("internal_error", t("Não foi possível aceitar o atendimento."), 500, { requestId });
  }
  if (!conversa) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  const passagens = (linhas ?? []) as PassagemDoAceite[];
  const vivas = passagens.filter((p) => passagemEmAberto(p.estado));
  if (vivas.length === 0) {
    const aceita = passagens.find((p) => p.estado === "aceita");
    if (aceita) {
      return ok(
        { conversation_id: id, passagem_id: aceita.id, estado: "aceita", aceita_em: aceita.aceita_em, ja_aceita: true },
        { requestId },
      );
    }
    return fail("not_found", t("Não há atendimento esperando aceite nesta conversa."), 404, { requestId });
  }

  const responsavel = vivas.find((p) => p.responsavel_user_id !== null)?.responsavel_user_id ?? null;
  const souResponsavel = responsavel === eu;
  if (!ehAdmin && responsavel !== null && !souResponsavel) {
    return fail("forbidden", t("Este atendimento está com outra pessoa da equipe."), 403, { requestId });
  }

  // (3) a conversa passa a ser de quem aceita.
  const supabase = await createClient();
  const actor = { type: "user" as const, id: eu, role: authz.org.role };
  let assumiuAgora = false;
  const donoAtual = (conversa as { assigned_to_user_id: string | null }).assigned_to_user_id;
  if (donoAtual !== eu) {
    const tentativa = await assumirConversaComEfeitos(supabase, {
      organizationId: orgId,
      conversationId: id,
      actor,
      requestId,
      expectedAssignee: donoAtual,
    });
    if (tentativa.error) {
      return fail("internal_error", t("Não foi possível aceitar o atendimento."), 500, { requestId });
    }
    assumiuAgora = tentativa.conversation !== null;
    if (!assumiuAgora && souResponsavel) {
      // O reserva que não enxerga a conversa (ver o cabeçalho).
      const peloServidor = await assumirConversaComEfeitos(admin, {
        organizationId: orgId,
        conversationId: id,
        actor,
        requestId,
        expectedAssignee: donoAtual,
      });
      assumiuAgora = peloServidor.conversation !== null;
    }
    if (!assumiuAgora) {
      // Pode ter sido um segundo clique (a primeira chamada já assumiu): relê.
      const { data: agora } = await admin
        .from("conversations")
        .select("assigned_to_user_id")
        .eq("organization_id", orgId)
        .eq("id", id)
        .maybeSingle();
      if ((agora as { assigned_to_user_id: string | null } | null)?.assigned_to_user_id !== eu) {
        return fail("state_conflict", t("Outro atendente já assumiu."), 409, { requestId });
      }
    }
  }

  // (4) o estado e o aviso. A função confere de novo, na transação.
  const { data: resultado, error } = await supabase.rpc("fn_passagem_aceitar", {
    p_organization_id: orgId,
    p_conversation_id: id,
  });
  if (error) {
    if (error.message.includes("passagem_de_outro_responsavel")) {
      return fail("forbidden", t("Este atendimento está com outra pessoa da equipe."), 403, { requestId });
    }
    logger.error("[passagem.aceitar] aceite falhou", { conversation_id: id, error: error.message, requestId });
    return fail("internal_error", t("Não foi possível aceitar o atendimento."), 500, { requestId });
  }
  const aceitas = Number((resultado as { aceitas?: unknown } | null)?.aceitas ?? 0);

  // Audita quem FEZ a passagem virar aceita: o vencedor do claim (o gatilho de
  // atribuição aceita junto) ou quem a função aceitou agora. O segundo clique
  // concorrente não vence nenhum dos dois e não escreve.
  if (assumiuAgora || aceitas > 0) {
    await audit({
      action: "handoff.accepted",
      actorUserId: eu,
      organizationId: orgId,
      resourceType: "conversation",
      resourceId: id,
      requestId,
      metadata: {
        passagem_ids: vivas.map((p) => p.id),
        responsavel_anterior: responsavel,
        pelo_admin: ehAdmin && !souResponsavel,
        assumiu_a_conversa: assumiuAgora,
      },
    });
  }

  return ok(
    {
      conversation_id: id,
      passagem_id: vivas[0]!.id,
      estado: "aceita",
      aceita_em: new Date().toISOString(),
      ja_aceita: !(assumiuAgora || aceitas > 0),
    },
    { requestId },
  );
}
