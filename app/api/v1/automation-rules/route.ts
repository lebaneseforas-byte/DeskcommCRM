import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/automation-rules — lista as regras de automação da org ativa.
 * POST /api/v1/automation-rules — cria uma regra. is_active NUNCA aceito no
 *   create (schema não tem o campo) — regra nasce pausada (default FALSE do banco).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { criarRegra } from "@/lib/automation/escrita-da-regra";
import { createAutomationRuleSchema } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "automation_rules" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("automation_rules")
    .select("*")
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
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
  const parsed = createAutomationRuleSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_request", t("Dados inválidos."), 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // As recusas (segredo do webhook sem cifra, etapa de perda sem motivo, fonte
  // de outra empresa, gatilho de data no contato) e a gravação moram em
  // `lib/automation/escrita-da-regra.ts`, a mesma que o MCP do CRM usa. A regra
  // nasce PAUSADA: o schema de criação não tem `is_active`.
  const r = await criarRegra(await createClient(), {
    orgId: activeOrg.orgId,
    admin: createAdminClient(),
    regra: parsed.data,
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
  const created = r.regra;

  return ok(created, { requestId, status: 201 });
}
