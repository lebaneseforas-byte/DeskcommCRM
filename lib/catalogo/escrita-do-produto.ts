/**
 * GRAVAR UM PRODUTO DO CATÁLOGO — a parte que a tela (`app/api/v1/products`) e o
 * MCP do CRM (o dono cadastrando pelo ChatGPT) fazem igual.
 *
 * Saiu das rotas para não haver duas réguas: a capacidade "capacidade do
 * produto" só com o recurso ligado, a moeda é a da organização, código
 * repetido vira `conflict`, e cada escrita audita `catalog_product.created` /
 * `catalog_product.updated`. As FOTOS ficam com quem chama (a rota baixa e
 * guarda as URLs antes do insert); o MCP não recebe fotos.
 *
 * ⚠️ `db` pode ser o client da sessão (RLS) ou o de serviço; em ambos a
 * organização vai explícita em cada consulta.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { capacidadesDaOrganizacao } from "@/lib/organizacao/capacidades";
import { COLUNAS_DO_PRODUTO, type Produto, type ProdutoCreate, type ProdutoPatch } from "@/lib/schemas/produtos";

export interface AtorDoProduto {
  userId: string | null;
  apiTokenId: string | null;
  requestId: string;
}

export type ResultadoDoProduto =
  | { ok: true; produto: Produto }
  | { ok: false; codigo: "conflict" | "not_found" | "internal_error"; status: number };

/** O campo `capacidade` só vale com o recurso ligado nesta organização. */
export async function capacidadeDoProdutoPermitida(
  db: SupabaseClient,
  orgId: string,
  capacidade: string | undefined,
): Promise<boolean> {
  if (!capacidade) return true;
  return (await capacidadesDaOrganizacao(db, orgId)).includes("capacidade_do_produto");
}

export async function inserirProduto(
  db: SupabaseClient,
  args: {
    orgId: string;
    campos: Omit<ProdutoCreate, "fotos">;
    /** Pré-gerado quando a rota já guardou fotos com este id. */
    id?: string;
    fotos?: string[];
    ator: AtorDoProduto;
  },
): Promise<ResultadoDoProduto> {
  const moeda = await moedaDaOrganizacao(db, args.orgId);
  const { data, error } = await db
    .from("catalog_products")
    .insert({
      ...args.campos,
      ...(args.id ? { id: args.id } : {}),
      ...(args.fotos ? { fotos: args.fotos } : {}),
      moeda,
      organization_id: args.orgId,
      origem: "manual",
    })
    .select(COLUNAS_DO_PRODUTO)
    .single();
  if (error || !data) {
    return error?.code === "23505"
      ? { ok: false, codigo: "conflict", status: 409 }
      : { ok: false, codigo: "internal_error", status: 500 };
  }
  const produto = data as unknown as Produto;
  await audit({
    organizationId: args.orgId,
    actorUserId: args.ator.userId,
    actorApiTokenId: args.ator.apiTokenId,
    action: "catalog_product.created",
    resourceType: "catalog_products",
    resourceId: produto.id,
    requestId: args.ator.requestId,
  });
  return { ok: true, produto };
}

export async function atualizarProduto(
  db: SupabaseClient,
  args: {
    orgId: string;
    id: string;
    campos: Omit<ProdutoPatch, "fotos">;
    fotos?: string[];
    ator: AtorDoProduto;
  },
): Promise<ResultadoDoProduto> {
  const { data, error } = await db
    .from("catalog_products")
    .update({ ...args.campos, ...(args.fotos ? { fotos: args.fotos } : {}) })
    .eq("organization_id", args.orgId)
    .eq("id", args.id)
    .select(COLUNAS_DO_PRODUTO)
    .maybeSingle();
  if (error) {
    return error.code === "23505"
      ? { ok: false, codigo: "conflict", status: 409 }
      : { ok: false, codigo: "internal_error", status: 500 };
  }
  if (!data) return { ok: false, codigo: "not_found", status: 404 };
  await audit({
    organizationId: args.orgId,
    actorUserId: args.ator.userId,
    actorApiTokenId: args.ator.apiTokenId,
    action: "catalog_product.updated",
    resourceType: "catalog_products",
    resourceId: args.id,
    requestId: args.ator.requestId,
  });
  return { ok: true, produto: data as unknown as Produto };
}
