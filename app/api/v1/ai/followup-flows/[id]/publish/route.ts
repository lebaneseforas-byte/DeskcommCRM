import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/:id/publish — valida o draft_graph
 * (validateFlowForPublish, Task 2.2) e, se válido, publica atomicamente via
 * fn_publish_followup_flow_version (migration 0056): insert da version +
 * ativação do pointer (active_version_id + status='active') numa função só,
 * sem janela onde a version fica órfã. EXECUTE da função é só service_role
 * (revogado de authenticated) — por isso o client aqui é o admin, com
 * organization_id sempre filtrado explicitamente (nunca do body).
 *
 * 422 validation_failed com details.errors (mesmo shape de PublishValidationError)
 * se draft_graph ausente ou reprovado na validação estrutural/semântica.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { publicarFluxo } from "@/lib/followup/escrita-do-fluxo";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * As regras da publicação (gatilho com motor, etapa do gatilho ativa,
 * `validateFlowForPublish`, a função atômica) moram em
 * `lib/followup/escrita-do-fluxo.ts` — as mesmas que o MCP do CRM usa.
 */
export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const r = await publicarFluxo(createAdminClient(), {
    orgId: activeOrg.orgId,
    id,
    ator: { userId: user.id, apiTokenId: null, requestId },
  });
  if (!r.ok) {
    return fail(r.codigo, r.traduzivel ? t(r.mensagem) : r.mensagem, r.status, {
      requestId,
      ...(r.erros
        ? { details: { errors: r.erros.map((e) => ({ ...e, message: t(e.message) })) } }
        : {}),
    });
  }
  return ok(r.data, { requestId });
}
