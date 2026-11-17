/**
 * MUDAR O PAPEL DE UM MEMBRO — a parte que `PATCH /api/v1/team/[user_id]` e o
 * MCP do CRM (o dono pelo ChatGPT) fazem igual.
 *
 * Guardas (G2-02): membro revogado não muda de papel, e o ÚLTIMO admin não é
 * rebaixado (contagem antes da escrita). O snapshot de autorização do alvo cai
 * antes E depois da escrita (#3696): o papel novo vale na próxima requisição.
 *
 * ⚠️ A organização vem de quem chama, nunca do corpo, e vai explícita em toda
 * consulta — `db` pode ser o client de serviço (MCP).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import type { Role } from "@/lib/schemas/team";

export type ResultadoDoPapel =
  | { ok: true; user_id: string; role: Role; papel_anterior: Role }
  | {
      ok: false;
      codigo: "not_found" | "state_conflict" | "internal_error";
      mensagem: string;
      traduzivel: boolean;
      status: number;
    };

export async function lerMembro(
  db: SupabaseClient,
  orgId: string,
  userId: string,
): Promise<
  { id: string; user_id: string; role: Role; revoked_at: string | null } | null | { erro: string }
> {
  const { data, error } = await db
    .from("user_organizations")
    .select("id, user_id, role, revoked_at")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { erro: error.message };
  return (
    (data as { id: string; user_id: string; role: Role; revoked_at: string | null } | null) ?? null
  );
}

export async function alterarPapel(
  db: SupabaseClient,
  args: {
    orgId: string;
    alvoUserId: string;
    papel: Role;
    ator: { userId: string | null; apiTokenId: string | null; requestId: string };
  },
): Promise<ResultadoDoPapel> {
  const { orgId, alvoUserId, papel, ator } = args;
  const alvo = await lerMembro(db, orgId, alvoUserId);
  if (alvo && "erro" in alvo)
    return {
      ok: false,
      codigo: "internal_error",
      mensagem: alvo.erro,
      traduzivel: false,
      status: 500,
    };
  if (!alvo)
    return {
      ok: false,
      codigo: "not_found",
      mensagem: "Membro não encontrado.",
      traduzivel: true,
      status: 404,
    };
  if (alvo.revoked_at) {
    return {
      ok: false,
      codigo: "state_conflict",
      mensagem: "Membro está revogado.",
      traduzivel: true,
      status: 409,
    };
  }

  if (alvo.role === "admin" && papel !== "admin") {
    const { count, error } = await db
      .from("user_organizations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("role", "admin")
      .is("revoked_at", null);
    if (error)
      return {
        ok: false,
        codigo: "internal_error",
        mensagem: error.message,
        traduzivel: false,
        status: 500,
      };
    if ((count ?? 0) <= 1) {
      return {
        ok: false,
        codigo: "state_conflict",
        mensagem: "Não é possível rebaixar o último admin do tenant.",
        traduzivel: true,
        status: 409,
      };
    }
  }

  // #3696: derrubar o snapshot ANTES da escrita fecha a janela em que uma tela
  // que atualiza "ao vivo" pede o valor velho no meio do UPDATE e o guarda de
  // novo. A invalidação de depois, pós-commit, cobre o intervalo que sobra.
  invalidarUsuario(alvoUserId);
  const { error: updErr } = await db
    .from("user_organizations")
    .update({ role: papel, updated_at: new Date().toISOString() })
    .eq("id", alvo.id)
    .eq("organization_id", orgId);
  if (updErr)
    return {
      ok: false,
      codigo: "internal_error",
      mensagem: updErr.message,
      traduzivel: false,
      status: 500,
    };
  invalidarUsuario(alvoUserId);

  await audit({
    action: "team.role_changed",
    actorUserId: ator.userId,
    actorApiTokenId: ator.apiTokenId,
    organizationId: orgId,
    resourceType: "membership",
    resourceId: alvo.id,
    requestId: ator.requestId,
    metadata: { target_user_id: alvoUserId, old_role: alvo.role, new_role: papel },
  });
  return { ok: true, user_id: alvoUserId, role: papel, papel_anterior: alvo.role };
}
