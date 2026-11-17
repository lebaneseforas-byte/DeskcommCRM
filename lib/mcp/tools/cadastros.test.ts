/**
 * Base de conhecimento e produtos pelo MCP: a organização sai do CONTEXTO, o
 * autor gravado é o token (não uma pessoa), a tradução de argumento chega igual
 * às regras da tela, e as recusas voltam legíveis. As regras em si
 * (`escrita-do-material`, `escrita-do-produto`) têm testes próprios, pelas rotas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { McpContext } from "../types";

const h = vi.hoisted(() => ({
  chamadas: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  resultado: null as unknown,
  capacidadeLigada: true,
}));

vi.mock("@/lib/ai/knowledge/escrita-do-material", () => ({
  criarMaterial: async (args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "criarMaterial", args });
    return (
      h.resultado ?? { ok: true, data: { id: "m1", items_count: 2, indexacao_habilitada: true } }
    );
  },
  atualizarMaterial: async (args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "atualizarMaterial", args });
    return h.resultado ?? { ok: true, data: { id: "m1", items_count: 1 } };
  },
}));
vi.mock("@/lib/catalogo/escrita-do-produto", () => ({
  capacidadeDoProdutoPermitida: async (_db: unknown, _org: string, capacidade?: string) =>
    !capacidade || h.capacidadeLigada,
  inserirProduto: async (_db: unknown, args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "inserirProduto", args });
    return h.resultado ?? { ok: true, produto: { id: "p1" } };
  },
  atualizarProduto: async (_db: unknown, args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "atualizarProduto", args });
    return h.resultado ?? { ok: true, produto: { id: "p1" } };
  },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const PRODUTO = "22222222-2222-4222-8222-222222222222";

function ctx(): McpContext {
  return {
    organizationId: ORG,
    role: "admin",
    actor: { type: "api_token", id: "tok", role: "admin" },
    apiTokenId: "tok",
    requestId: "req",
    supabase: {} as McpContext["supabase"],
  } as McpContext;
}

beforeEach(() => {
  h.chamadas = [];
  h.resultado = null;
  h.capacidadeLigada = true;
});

describe("base de conhecimento pelo MCP", () => {
  it("cria um FAQ na organização do contexto, com o token como autor", async () => {
    const { crmCreateKnowledgeSource } = await import("./cadastros");
    const r = (await crmCreateKnowledgeSource.handler(
      {
        nome: "Horários",
        tipo: "faq",
        perguntas_e_respostas: [{ pergunta: "Abre sábado?", resposta: "Sim, das 9h às 13h." }],
      },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.material_id).toBe("m1");
    const { args } = h.chamadas[0]!;
    expect(args.orgId).toBe(ORG);
    expect(args.ator).toEqual({ userId: null, apiTokenId: "tok", requestId: "req" });
    expect(args.input).toMatchObject({
      name: "Horários",
      source_type: "faq",
      items: [{ question: "Abre sábado?", answer: "Sim, das 9h às 13h." }],
    });
  });

  it("documento vai como texto; faq sem pares é recusado antes de gravar", async () => {
    const { crmCreateKnowledgeSource } = await import("./cadastros");
    await crmCreateKnowledgeSource.handler(
      { nome: "Política", tipo: "documento", texto: "# Trocas\n7 dias." },
      ctx(),
    );
    expect(h.chamadas[0]!.args.input).toMatchObject({
      source_type: "documento",
      markdown_blob: "# Trocas\n7 dias.",
    });

    h.chamadas = [];
    const r = (await crmCreateKnowledgeSource.handler(
      { nome: "Vazio", tipo: "faq" },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("pedido_invalido");
    expect(h.chamadas).toHaveLength(0);
  });

  it("a recusa da regra volta com o código e a mensagem dela", async () => {
    h.resultado = {
      ok: false,
      codigo: "conflict",
      mensagem: "Já existe um material com esse nome.",
    };
    const { crmCreateKnowledgeSource } = await import("./cadastros");
    const r = await crmCreateKnowledgeSource.handler(
      { nome: "Horários", tipo: "documento", texto: "x" },
      ctx(),
    );
    expect(r).toEqual({ erro: "conflict", mensagem: "Já existe um material com esse nome." });
  });

  it("atualizar sem nada a mudar é recusado; com pares, troca a lista inteira", async () => {
    const { crmUpdateKnowledgeSource } = await import("./cadastros");
    const vazio = (await crmUpdateKnowledgeSource.handler(
      { material_id: PRODUTO },
      ctx(),
    )) as Record<string, unknown>;
    expect(vazio.erro).toBe("pedido_vazio");
    expect(h.chamadas).toHaveLength(0);

    await crmUpdateKnowledgeSource.handler(
      { material_id: PRODUTO, perguntas_e_respostas: [{ pergunta: "P", resposta: "R" }] },
      ctx(),
    );
    const { args } = h.chamadas[0]!;
    expect(args.orgId).toBe(ORG);
    expect(args.sourceId).toBe(PRODUTO);
    expect(args.input).toEqual({
      items: [{ question: "P", answer: "R", tags: [], locale: "pt-BR" }],
    });
  });
});

describe("produtos pelo MCP", () => {
  it("o esquema de entrada não aceita fotos nem moeda", async () => {
    const { crmCreateProduct, crmUpdateProduct } = await import("./cadastros");
    expect(Object.keys(crmCreateProduct.inputSchema)).not.toContain("fotos");
    expect(Object.keys(crmUpdateProduct.inputSchema)).not.toContain("fotos");
    expect(Object.keys(crmCreateProduct.inputSchema)).not.toContain("moeda");
    const parse = z
      .object(crmUpdateProduct.inputSchema)
      .parse({ product_id: PRODUTO, preco_cents: 500 });
    // PATCH só de preço não pode levar default que zera estoque ou reativa produto.
    expect(parse).toEqual({ product_id: PRODUTO, preco_cents: 500 });
  });

  it("cria na organização do contexto, com o token como autor", async () => {
    const { crmCreateProduct } = await import("./cadastros");
    const r = (await crmCreateProduct.handler(
      {
        codigo: "SKU-1",
        nome: "Cadeira",
        preco_cents: 15000,
        controla_estoque: true,
        quantidade: 3,
        ativo: true,
      },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.produto).toEqual({ id: "p1" });
    const { args } = h.chamadas[0]!;
    expect(args.orgId).toBe(ORG);
    expect(args.ator).toEqual({ userId: null, apiTokenId: "tok", requestId: "req" });
  });

  it("código repetido vira recusa legível", async () => {
    h.resultado = { ok: false, codigo: "conflict", status: 409 };
    const { crmCreateProduct } = await import("./cadastros");
    const r = (await crmCreateProduct.handler(
      {
        codigo: "SKU-1",
        nome: "Cadeira",
        preco_cents: 1,
        controla_estoque: true,
        quantidade: 0,
        ativo: true,
      },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("codigo_repetido");
  });

  it("o campo capacidade desligado recusa sem gravar", async () => {
    h.capacidadeLigada = false;
    const { crmUpdateProduct } = await import("./cadastros");
    const r = (await crmUpdateProduct.handler(
      { product_id: PRODUTO, capacidade: "8 pessoas" },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("capacidade_desligada");
    expect(h.chamadas).toHaveLength(0);
  });

  it("atualiza só o que veio, pelo id e organização do contexto; produto de fora é 'não encontrado'", async () => {
    const { crmUpdateProduct } = await import("./cadastros");
    await crmUpdateProduct.handler({ product_id: PRODUTO, preco_cents: 990 }, ctx());
    expect(h.chamadas[0]!.args).toMatchObject({
      orgId: ORG,
      id: PRODUTO,
      campos: { preco_cents: 990 },
    });

    h.resultado = { ok: false, codigo: "not_found", status: 404 };
    const r = (await crmUpdateProduct.handler(
      { product_id: PRODUTO, ativo: false },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("produto_nao_encontrado");

    const vazio = (await crmUpdateProduct.handler({ product_id: PRODUTO }, ctx())) as Record<
      string,
      unknown
    >;
    expect(vazio.erro).toBe("pedido_vazio");
  });

  it("as quatro são só de gestão: escrita, papel manager, escopo de escrita", async () => {
    const m = await import("./cadastros");
    for (const t of [
      m.crmCreateKnowledgeSource,
      m.crmUpdateKnowledgeSource,
      m.crmCreateProduct,
      m.crmUpdateProduct,
    ]) {
      expect([t.category, t.requiresRole, t.requiresScope]).toEqual([
        "write",
        "manager",
        "mcp:write",
      ]);
    }
    const { IDS_DO_ADMINISTRADOR } = await import("./ferramentas-do-administrador");
    for (const n of [
      "crm_create_knowledge_source",
      "crm_update_knowledge_source",
      "crm_create_product",
      "crm_update_product",
    ]) {
      expect(IDS_DO_ADMINISTRADOR.has(n)).toBe(true);
    }
  });
});
