/**
 * GET /api/v1/campaigns — a lista.
 * POST /api/v1/campaigns — cria um rascunho.
 *
 * Papel: `manager` para tudo. Disparar para uma lista de gente não é gesto de
 * `viewer` nem de `agent`, e a RLS de `campaigns` (migration 0375) exige o mesmo
 * papel — a porta HTTP e a do PostgREST concordam.
 *
 * Paginação: keyset sobre (created_at DESC, id DESC), o mesmo formato de
 * `lead-captures`.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { fail, ok } from "@/lib/api/wrappers";
import { COLUNAS_DA_LISTA_DE_CAMPANHAS, criarCampanha } from "@/lib/campanhas/criar-campanha";
import {
  codificarCursor,
  criarCampanhaSchema,
  decodificarCursor,
  listarCampanhasSchema,
} from "@/lib/campanhas/schemas";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS_DA_LISTA = COLUNAS_DA_LISTA_DE_CAMPANHAS;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "campaigns",
    role: "manager",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "campaigns_lista", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const org = { orgId: authz.organizationId };

  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = listarCampanhasSchema.safeParse(params);
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const q = parsed.data;

  const supabase = authz.supabase;
  let query = supabase
    .from("campaigns")
    .select(COLUNAS_DA_LISTA)
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);

  if (q.status) query = query.eq("status", q.status);
  if (q.cursor) {
    const c = decodificarCursor(q.cursor);
    if (!c) return fail("invalid_cursor", t("Cursor inválido."), 400, { requestId });
    query = query.or(`created_at.lt.${c.created_at},and(created_at.eq.${c.created_at},id.lt.${c.id})`);
  }

  const { data, error } = await query;
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const linhas = data ?? [];
  const temMais = linhas.length > q.limit;
  const pagina = temMais ? linhas.slice(0, q.limit) : linhas;
  const ultima = pagina[pagina.length - 1] as { created_at: string; id: string } | undefined;

  return ok(pagina, {
    requestId,
    meta: {
      cursor: temMais && ultima ? codificarCursor(ultima) : null,
      has_more: temMais,
    },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "campaigns",
    role: "manager",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "campaigns_criar", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const org = { orgId: authz.organizationId };
  // Autor só quando é uma pessoa logada: o token não é usuário, e NULL é o
  // que a coluna `created_by` aceita (`references auth.users`, nullable).
  const autor = authz.actor.type === "user" ? authz.actor.id : null;

  const parsed = criarCampanhaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const entrada = parsed.data;

  // Client ADMIN na escrita, e não o da sessão: a migration 0375 concede ao
  // papel `authenticated` apenas SELECT (a tela lê; só o servidor escreve). O
  // isolamento não se perde: `org.orgId` vem da autenticação acima, nunca do
  // corpo. A conferência do canal, do conteúdo e da velocidade, o pool e a
  // auditoria moram em `lib/campanhas/criar-campanha.ts` — a mesma do MCP.
  const r = await criarCampanha(createAdminClient(), {
    orgId: org.orgId,
    entrada,
    autorUserId: autor,
    apiTokenId: authz.apiTokenId ?? null,
    requestId,
    t,
  });
  if (!r.ok) return fail(r.codigo, r.mensagem, r.status, { requestId });
  const data = r.campanha;

  return ok(data, { requestId, status: 201 });
}
