import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/knowledge/sources — os materiais da organização
 * POST /api/v1/ai/knowledge/sources — cadastra um material
 *
 * Desde a 0181 o acervo é da ORGANIZAÇÃO, não de um agente. `agent_id` continua
 * aceito e vira registro histórico de onde o material nasceu; quem lê o quê é
 * escolha da versão publicada de cada assistente
 * (`ai_agent_versions.knowledge_source_ids`).
 *
 * Auth: sessão por cookie, papel >= manager para escrever.
 * `organization_id` SEMPRE sai da sessão autenticada — nunca do corpo.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi, requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { createSourceSchema, criarMaterial } from "@/lib/ai/knowledge/escrita-do-material";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Zod
// ---------------------------------------------------------------------------

const SELECT_COLUNAS =
  "id, agent_id, organization_id, source_type, name, status, last_index_status, " +
  "last_index_error, last_indexed_at, chunks_count, is_active, source_metadata, " +
  "active_kb_version_id, ingested_at, created_at, updated_at";

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authUser = await loadAuthUser();
  if (!authUser) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const ativa = await orgAtivaDaApi(authUser, requestId);
  if (!ativa.ok) return ativa.response;
  const activeOrg = ativa.org;
  if (!activeOrg) {
    return fail("forbidden", "Nenhuma organização ativa.", 403, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ai_knowledge_sources")
    .select(SELECT_COLUNAS)
    .eq("organization_id", activeOrg.orgId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[ai-knowledge-sources] GET falhou:", error.message);
    return fail("internal_error", "Erro ao listar os materiais.", 500, { requestId });
  }

  // `ok()` já embrulha em `{ data }`. Com `{ data: data ?? [] }` o corpo saía
  // `{ data: { data: [...] } }` e o hook fazia `.filter` sobre o envelope.
  return ok(data ?? [], { requestId });
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = createSourceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // A sequência inteira (tipo, conteúdo, assistente da organização, FAQ ou
  // documento, insert, itens, indexação, auditoria) mora em
  // `lib/ai/knowledge/escrita-do-material.ts` — a mesma do MCP do CRM.
  const r = await criarMaterial({
    dbLeitura: await createClient(),
    dbEscrita: createAdminClient(),
    orgId: activeOrg.orgId,
    input: parsed.data,
    ator: { userId: authz.user.id, apiTokenId: null, requestId },
  });
  if (!r.ok) {
    return fail(r.codigo, t(r.mensagem), r.status, {
      requestId,
      ...(r.details !== undefined ? { details: r.details as Record<string, unknown> } : {}),
    });
  }
  return ok(r.data, { status: 201, requestId });
}
