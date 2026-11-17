/**
 * Shared handler: change a member's role (G2-02).
 *
 * Canonical route: PATCH /api/v1/team/[user_id]
 * Alias (EPIC-09, kept for existing callers): PATCH /api/v1/team/[user_id]/role
 *
 * Guardrails:
 *  - Caller must be admin of the active org (requireRole, spec 13 §4).
 *  - Cannot demote the last remaining admin (count check before write).
 *  - Cannot change role of a revoked member.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { changeRoleSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { alterarPapel } from "@/lib/team/alterar-papel";

export async function changeMemberRole(
  req: NextRequest,
  ctx: { params: Promise<{ user_id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { user_id: targetUserId } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;
  const t = (texto: string) => traduzir(texto, authUser.idioma);

  let input;
  try {
    input = await validateRequest(changeRoleSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Guardas (revogado, último admin), o cache do papel (#3696) e a auditoria
  // moram em `lib/team/alterar-papel.ts` — a mesma régua do MCP do CRM.
  const r = await alterarPapel(await createClient(), {
    orgId: activeOrg.orgId,
    alvoUserId: targetUserId,
    papel: input.role,
    ator: { userId: authUser.id, apiTokenId: null, requestId },
  });
  if (!r.ok) return fail(r.codigo, r.traduzivel ? t(r.mensagem) : r.mensagem, r.status, { requestId });
  return ok({ user_id: r.user_id, role: r.role }, { requestId });
}
