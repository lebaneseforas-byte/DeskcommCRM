/**
 * CRIAR UMA RESPOSTA RÁPIDA — a parte que `POST /api/v1/message-templates` e o
 * MCP do CRM (o dono pelo ChatGPT) fazem igual.
 *
 * A resposta nova nasce no TOPO e sem empate (um passo acima da primeira da
 * lista visível — ver a #3244), com `midias` vazia (a mídia entra só pela rota
 * de upload, que confere os bytes sabendo o id) e `grupo_id` nulo quando não
 * vem. Lança em falha de propósito: o helper de idempotência da rota propaga sem
 * gravar recibo.
 *
 * ⚠️ Quem chama decide se a resposta é PESSOAL (`donoUserId`) ou compartilhada
 * (`null`) e já conferiu o grupo com `grupoDaOrganizacao`. A organização vai
 * explícita em toda consulta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { posicaoEntre } from "@/lib/templates/ordem";

export const COLUNAS_DA_RESPOSTA =
  "id, organization_id, owner_user_id, title, body, shortcut, midias, mostrar_na_barra, grupo_id, created_by_user_id, created_at, updated_at, ordem";

export async function criarRespostaRapida(
  db: SupabaseClient,
  args: {
    orgId: string;
    donoUserId: string | null;
    criadorUserId: string | null;
    apiTokenId: string | null;
    requestId: string;
    title: string;
    body: string;
    shortcut?: string;
    mostrar_na_barra?: boolean;
    grupo_id?: string | null;
  },
): Promise<Record<string, unknown> & { id: string }> {
  const { data: primeira, error: erroPrimeira } = await db
    .from("message_templates")
    .select("ordem")
    .eq("organization_id", args.orgId)
    .order("ordem", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (erroPrimeira) throw new Error("Erro ao criar template.");
  const menor = (primeira as { ordem: number } | null)?.ordem ?? null;
  // `posicaoEntre(null, x)` nunca é `null`: só o empate entre DUAS vizinhas é.
  const ordem = posicaoEntre(null, menor)!;

  const { data, error } = await db
    .from("message_templates")
    .insert({
      organization_id: args.orgId,
      owner_user_id: args.donoUserId,
      title: args.title,
      body: args.body,
      shortcut: args.shortcut ?? null,
      grupo_id: args.grupo_id ?? null,
      // Ausente, a coluna assume o default (`true`): nasce aparecendo na barra.
      ...(args.mostrar_na_barra === undefined ? {} : { mostrar_na_barra: args.mostrar_na_barra }),
      midias: [],
      created_by_user_id: args.criadorUserId,
      ordem,
    })
    .select(COLUNAS_DA_RESPOSTA)
    .single();
  if (error || !data) throw new Error("Erro ao criar template.");

  void audit({
    action: "template.created",
    actorUserId: args.criadorUserId,
    actorApiTokenId: args.apiTokenId,
    organizationId: args.orgId,
    resourceType: "message_template",
    resourceId: (data as { id: string }).id,
    requestId: args.requestId,
    metadata: { shared: args.donoUserId === null, title: args.title },
  });
  return data as unknown as Record<string, unknown> & { id: string };
}
