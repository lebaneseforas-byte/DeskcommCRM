import type { EmailDeliveryError } from "@/lib/email/roteador";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { issueInvite } from "@/lib/auth/issue-invite";
import { convidarPessoas } from "@/lib/team/convidar";
import { isServiceRoleConfigured } from "@/lib/audit";
/**
 * POST /api/v1/team/invite — bulk-invite up to 20 emails.
 *
 * O que viaja no e-mail é um token HMAC stateless (`lib/auth/invite-token.ts`).
 * Quando o service-role está configurado, cada convite também vira uma linha em
 * `team_invites` (migration 0238) — é o que a tela de Equipe lista e o que
 * torna a revogação possível. Reconvidar um e-mail com convite pendente RENOVA
 * a linha. Sem service-role, degrada para só-token (nada some, só não persiste).
 *
 * Se o e-mail já tem membership ATIVA na org, pula com `already_member`.
 *
 * Membership row is created at /accept-invite time (Server Action) — that's
 * also when audit emits `member.accepted`. Here we audit `member.invited`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { inviteMemberSchema, validateRequest } from "@/lib/schemas";

export const dynamic = "force-dynamic";

interface SentItem {
  email: string;
  invite_id: string;
  expires_at: string;
  email_dispatched: boolean;
  /** Por que não saiu, quando não saiu. Vocabulário de `lib/email/roteador.ts`. */
  email_error?: EmailDeliveryError;
  accept_url: string;
}
interface FailedItem {
  email: string;
  reason: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(inviteMemberSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const inviterName = authUser.full_name ?? authUser.email ?? "Um colega";

  // Com service-role: plano cheio, quem já é membro e a linha de `team_invites`
  // moram em `lib/team/convidar.ts` — a mesma régua do MCP do CRM.
  if (isServiceRoleConfigured()) {
    const r = await convidarPessoas(createAdminClient(), {
      orgId: activeOrg.orgId,
      orgName: activeOrg.name,
      inviterId: authUser.id,
      inviterName,
      idioma: authUser.idioma,
      requestId,
      convites: input.invitations,
    });
    if (!r.ok) {
      return fail(r.codigo, r.mensagem, 409, { requestId, details: { recurso: "assentos", limite: r.limite } });
    }
    return ok({ sent: r.sent, failed: r.failed }, { status: 201, requestId });
  }

  // Sem service-role: degrada para só-token (nada some, só não persiste).
  const sent: SentItem[] = [];
  const failed: FailedItem[] = [];
  for (const inv of input.invitations) {
    sent.push(
      await issueInvite({
        email: inv.email.trim().toLowerCase(),
        role: inv.role,
        interfaceSettings: inv.interface_settings,
        organizationId: activeOrg.orgId,
        orgName: activeOrg.name,
        inviterId: authUser.id,
        inviterName,
        requestId,
      }),
    );
  }
  return ok({ sent, failed }, { status: 201, requestId });
}
