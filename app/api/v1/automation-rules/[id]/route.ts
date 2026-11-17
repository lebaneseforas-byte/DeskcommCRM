import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/automation-rules/[id] — atualiza campos (inclui is_active — switch da UI).
 * DELETE /api/v1/automation-rules/[id] — remove a regra.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail, noContent } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { atualizarRegra } from "@/lib/automation/escrita-da-regra";
import { updateAutomationRuleSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = updateAutomationRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // As recusas do PATCH parcial (fonte de outra empresa, laço de lead #1528,
  // etapa de perda sem motivo #4297, `campo_alterado` fora do gatilho #1749,
  // gatilho de data no contato #2791), a cifra do segredo e a autoria moram em
  // `lib/automation/escrita-da-regra.ts` — a mesma que o MCP do CRM usa.
  const r = await atualizarRegra(await createClient(), {
    orgId: activeOrg.orgId,
    id,
    admin: createAdminClient(),
    patch: parsed.data,
    ator: {
      actor: { type: "user", id: user.id, role: activeOrg.role },
      apiTokenId: null,
      requestId,
      idioma: authz.user.idioma,
    },
  });
  if (!r.ok) {
    return fail(r.codigo, r.traduzivel ? t(r.mensagem) : r.mensagem, r.status, {
      requestId,
      ...(r.details ? { details: r.details } : {}),
    });
  }
  const updated = r.regra;

  return ok(updated, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("automation_rules")
    .select("id")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Regra não encontrada."), 404, { requestId });

  const { error: delErr } = await supabase.from("automation_rules").delete().eq("id", id);
  if (delErr) return fail("internal_error", delErr.message, 500, { requestId });

  void audit({
    action: "automation.rule_deleted",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "automation_rule",
    resourceId: id,
    requestId,
  });

  return noContent(requestId);
}