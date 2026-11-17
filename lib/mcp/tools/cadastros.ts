/**
 * CADASTROS PELO MCP — o dono mantendo, pelo ChatGPT, o que os assistentes
 * sabem (base de conhecimento) e o que a empresa vende (produtos).
 *
 * ⚠️ NENHUMA REGRA MORA AQUI. Material: `lib/ai/knowledge/escrita-do-material.ts`;
 * produto: `lib/catalogo/escrita-do-produto.ts` — as mesmas das telas. Os
 * esquemas de entrada são os da tela (`createSourceSchema`, `produtoCreateSchema`),
 * sem fotos: baixar URL de foto é trabalho da tela.
 *
 * ⚠️ A ORGANIZAÇÃO SAI DE `ctx.organizationId`. Apagar material ou produto NÃO
 * está aqui de propósito (decisão do dono: apagar fica na tela).
 *
 * Papel `manager` — a régua das rotas de material e de produto.
 */
import { z } from "zod";

import { atualizarMaterial, criarMaterial } from "@/lib/ai/knowledge/escrita-do-material";
import {
  atualizarProduto,
  capacidadeDoProdutoPermitida,
  inserirProduto,
} from "@/lib/catalogo/escrita-do-produto";
import { produtoCreateSchema, produtoPatchSchema } from "@/lib/schemas/produtos";

import type { McpContext, McpToolDefinition } from "../types";

function ator(ctx: McpContext) {
  return { userId: null, apiTokenId: ctx.apiTokenId, requestId: ctx.requestId };
}

const parDePerguntaShape = z
  .object({
    pergunta: z.string().trim().min(1).max(1000),
    resposta: z.string().trim().min(1).max(5000),
  })
  .strict();

// ---------------------------------------------------------------------------
// crm_create_knowledge_source
// ---------------------------------------------------------------------------

const criarMaterialShape = {
  nome: z.string().trim().min(2).max(120).describe("Name of the material (must be unique)."),
  tipo: z
    .enum(["faq", "documento"])
    .describe('"faq" = question/answer pairs; "documento" = a text document.'),
  perguntas_e_respostas: z
    .array(parDePerguntaShape)
    .min(1)
    .max(200)
    .optional()
    .describe("For tipo=faq."),
  texto: z
    .string()
    .trim()
    .min(1)
    .max(200000)
    .optional()
    .describe("For tipo=documento: the full text (markdown allowed)."),
  agent_id: z
    .string()
    .uuid()
    .optional()
    .describe("Optional: tie the material to one assistant. Default: whole company."),
};

export const crmCreateKnowledgeSource: McpToolDefinition<typeof criarMaterialShape> = {
  name: "crm_create_knowledge_source",
  description:
    "Adds a material to the knowledge base the AI assistants answer from: either question/answer pairs (tipo=faq) " +
    "or a text document (tipo=documento). It is indexed automatically after saving. Same rules as the Knowledge " +
    "screen. Check existing materials first with crm_list_knowledge_sources to avoid duplicates.",
  inputSchema: criarMaterialShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    if (input.tipo === "faq" && !input.perguntas_e_respostas?.length) {
      return { erro: "pedido_invalido", mensagem: "tipo=faq needs perguntas_e_respostas." };
    }
    if (input.tipo === "documento" && !input.texto) {
      return { erro: "pedido_invalido", mensagem: "tipo=documento needs texto." };
    }
    const r = await criarMaterial({
      dbLeitura: ctx.supabase,
      dbEscrita: ctx.supabase,
      orgId: ctx.organizationId,
      input: {
        name: input.nome,
        source_type: input.tipo,
        ...(input.agent_id ? { agent_id: input.agent_id } : {}),
        ...(input.tipo === "faq"
          ? {
              items: input.perguntas_e_respostas!.map((p) => ({
                question: p.pergunta,
                answer: p.resposta,
                tags: [],
                locale: "pt-BR",
              })),
            }
          : { markdown_blob: input.texto }),
        source_metadata: {},
      },
      ator: ator(ctx),
    });
    if (!r.ok) return { erro: r.codigo, mensagem: r.mensagem };
    return {
      material_id: r.data.id,
      itens: r.data.items_count,
      indexacao: r.data.indexacao_habilitada
        ? "Indexing started; assistants can use it in a few minutes."
        : "Saved, but no embedding key is configured, so assistants cannot search it yet.",
    };
  },
};

// ---------------------------------------------------------------------------
// crm_update_knowledge_source
// ---------------------------------------------------------------------------

const atualizarMaterialShape = {
  material_id: z.string().uuid(),
  novo_nome: z.string().trim().min(2).max(120).optional(),
  perguntas_e_respostas: z
    .array(parDePerguntaShape)
    .max(200)
    .optional()
    .describe("Only for FAQ materials: REPLACES the whole list of question/answer pairs."),
};

export const crmUpdateKnowledgeSource: McpToolDefinition<typeof atualizarMaterialShape> = {
  name: "crm_update_knowledge_source",
  description:
    "Renames a knowledge-base material and/or REPLACES the full list of question/answer pairs of a FAQ material " +
    "(read the current pairs first and send the complete new list). Re-indexed automatically. Same rules as the " +
    "Knowledge screen; documents and automatic materials cannot be rewritten here.",
  inputSchema: atualizarMaterialShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    if (input.novo_nome === undefined && input.perguntas_e_respostas === undefined) {
      return { erro: "pedido_vazio", mensagem: "Send novo_nome and/or perguntas_e_respostas." };
    }
    const r = await atualizarMaterial({
      dbLeitura: ctx.supabase,
      dbEscrita: ctx.supabase,
      orgId: ctx.organizationId,
      sourceId: input.material_id,
      input: {
        ...(input.novo_nome !== undefined ? { name: input.novo_nome } : {}),
        ...(input.perguntas_e_respostas !== undefined
          ? {
              items: input.perguntas_e_respostas.map((p) => ({
                question: p.pergunta,
                answer: p.resposta,
                tags: [],
                locale: "pt-BR",
              })),
            }
          : {}),
      },
      ator: ator(ctx),
    });
    if (!r.ok) return { erro: r.codigo, mensagem: r.mensagem };
    return { material_id: r.data.id, itens: r.data.items_count ?? null };
  },
};

// ---------------------------------------------------------------------------
// crm_create_product / crm_update_product
// ---------------------------------------------------------------------------

const criarProdutoShape = produtoCreateSchema.omit({ fotos: true }).shape;

export const crmCreateProduct: McpToolDefinition<typeof criarProdutoShape> = {
  name: "crm_create_product",
  description:
    "Creates a product in the CRM catalog (the one assistants quote from). codigo must be unique; preco_cents is " +
    "the price in CENTS of the company's currency (the currency is the company's, not chosen here). Photos are " +
    "added on the Products screen. Search first with crm_search_products to avoid duplicates.",
  inputSchema: criarProdutoShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    if (!(await capacidadeDoProdutoPermitida(ctx.supabase, ctx.organizationId, input.capacidade))) {
      return {
        erro: "capacidade_desligada",
        mensagem: "The 'capacidade' field is turned off for this company.",
      };
    }
    const r = await inserirProduto(ctx.supabase, {
      orgId: ctx.organizationId,
      campos: input,
      ator: ator(ctx),
    });
    if (!r.ok) {
      return r.codigo === "conflict"
        ? { erro: "codigo_repetido", mensagem: "A product with this codigo already exists." }
        : { erro: "falha_ao_salvar", mensagem: "The product could not be saved." };
    }
    return { produto: r.produto };
  },
};

const atualizarProdutoShape = {
  product_id: z.string().uuid(),
  ...produtoPatchSchema.omit({ fotos: true }).shape,
};

export const crmUpdateProduct: McpToolDefinition<typeof atualizarProdutoShape> = {
  name: "crm_update_product",
  description:
    "Updates a catalog product: price (preco_cents, in cents), name, description, stock, active on/off, etc. Only " +
    "the fields sent change. Deactivate with ativo=false instead of deleting.",
  inputSchema: atualizarProdutoShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const { product_id, ...campos } = input;
    if (Object.keys(campos).length === 0)
      return { erro: "pedido_vazio", mensagem: "Nothing to change." };
    if (
      !(await capacidadeDoProdutoPermitida(ctx.supabase, ctx.organizationId, campos.capacidade))
    ) {
      return {
        erro: "capacidade_desligada",
        mensagem: "The 'capacidade' field is turned off for this company.",
      };
    }
    const r = await atualizarProduto(ctx.supabase, {
      orgId: ctx.organizationId,
      id: product_id,
      campos,
      ator: ator(ctx),
    });
    if (!r.ok) {
      if (r.codigo === "not_found")
        return {
          erro: "produto_nao_encontrado",
          mensagem: "No product with this id in this company.",
        };
      if (r.codigo === "conflict")
        return { erro: "codigo_repetido", mensagem: "Another product already uses this codigo." };
      return { erro: "falha_ao_salvar", mensagem: "The product could not be saved." };
    }
    return { produto: r.produto };
  },
};
