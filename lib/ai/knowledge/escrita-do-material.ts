/**
 * CRIAR E ATUALIZAR UM MATERIAL DA BASE DE CONHECIMENTO — a mesma régua para a
 * tela (`app/api/v1/ai/knowledge/sources`) e para o MCP do CRM (o dono
 * cadastrando pelo ChatGPT o que os assistentes devem saber).
 *
 * Saiu das rotas sem mudar a sequência: tipo canonizado na borda, conteúdo
 * colado só nos tipos que o aceitam, assistente da organização, FAQ por itens
 * ou por markdown `## Pergunta / ## Resposta`, documento guardado no bucket,
 * insert com 23505 → nome repetido, itens com desfazer no erro, `emit_event`
 * `knowledge_source.updated` (é ele que dispara a indexação) e a auditoria.
 *
 * ⚠️ Dois clients, como nas rotas de antes: `dbLeitura` (sessão com RLS na tela,
 * serviço no MCP) para conferir, `dbEscrita` (serviço) para gravar — cada consulta
 * filtra `organization_id` à mão.
 * Apagar material NÃO está aqui de propósito — fica só na tela.
 *
 * As mensagens saem em português, como frase NOSSA: quem chama passa por
 * `traduzir` (a rota) ou devolve ao modelo como está (o MCP).
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { temChaveDeEmbedding } from "@/lib/ai/embeddings/chave";
import { BUCKET_DE_CONHECIMENTO } from "@/lib/ai/rag/ingest/documento";
import { parseFaqMarkdown } from "@/lib/ai/rag/ingest/faq";
import {
  aceitaTextoColado,
  canonizarTipoDeFonte,
  ePerguntaEResposta,
  rotuloDoTipo,
} from "@/lib/ai/rag/tipos-de-fonte";

export const faqItemSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
  locale: z.string().optional().default("pt-BR"),
});

/**
 * O tipo chega como texto livre e é CANONIZADO na borda (`canonizarTipoDeFonte`):
 * um `z.enum` recusaria os nomes legados que integrações antigas ainda mandam.
 */
export const createSourceSchema = z.object({
  /** Opcional desde a 0181: o material é da organização. */
  agent_id: z.string().uuid().optional(),
  source_type: z.string().min(1),
  name: z.string().trim().min(2).max(120),
  items: z.array(faqItemSchema).optional(),
  markdown_blob: z.string().optional(),
  source_metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export const patchSourceSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  items: z.array(faqItemSchema).optional(),
  source_metadata: z.record(z.string(), z.unknown()).optional(),
});

export interface AtorDoMaterial {
  userId: string | null;
  apiTokenId: string | null;
  requestId: string;
}

export interface FalhaDoMaterial {
  ok: false;
  codigo: string;
  mensagem: string;
  status: number;
  details?: unknown;
}

function falha(
  codigo: string,
  mensagem: string,
  status: number,
  extra?: { details?: unknown; requestId?: string },
): FalhaDoMaterial {
  return {
    ok: false,
    codigo,
    mensagem,
    status,
    ...(extra?.details !== undefined ? { details: extra.details } : {}),
  };
}

/** As frases já são português; a tradução é de quem chama. */
const t = (texto: string) => texto;

export async function criarMaterial(args: {
  /** Leituras de conferência: o client da sessão (RLS) na tela; o de serviço no MCP. */
  dbLeitura: SupabaseClient;
  /** Escritas: o client de serviço, com `organization_id` à mão. */
  dbEscrita: SupabaseClient;
  orgId: string;
  input: z.output<typeof createSourceSchema>;
  ator: AtorDoMaterial;
}): Promise<
  | { ok: true; data: { id: string; items_count: number; indexacao_habilitada: boolean } }
  | FalhaDoMaterial
> {
  const requestId = args.ator.requestId;
  const input = args.input;
  const tipo = canonizarTipoDeFonte(input.source_type);
  if (tipo === null) {
    return falha(
      "validation_failed",
      `Tipo de material desconhecido: "${input.source_type}". Use faq, documento, conversas ou catalogo.`,
      422,
      { requestId },
    );
  }

  // Conteúdo mandado para um tipo que esta rota não ingere era ACEITO e
  // descartado em silêncio: a fonte nascia vazia, com 201, e ninguém entendia
  // por que o agente não sabia nada dali. Recusar alto é a única resposta honesta.
  const temConteudo =
    (input.items?.length ?? 0) > 0 || (input.markdown_blob?.trim().length ?? 0) > 0;
  if (temConteudo && !aceitaTextoColado(tipo)) {
    return falha(
      "unprocessable_entity",
      `Material de ${rotuloDoTipo(tipo).toLowerCase()} não recebe conteúdo colado — ` +
        "ele é preenchido automaticamente.",
      422,
      { requestId },
    );
  }

  const supabase = args.dbLeitura;

  // `agent_id` é HISTÓRICO. Continua validado — mandar o id de um agente de
  // outra organização tem de doer — mas não decide mais quem lê o material.
  if (input.agent_id) {
    const { data: agent, error: agentErr } = await supabase
      .from("ai_agents")
      .select("id")
      .eq("id", input.agent_id)
      .eq("organization_id", args.orgId)
      .maybeSingle();

    if (agentErr) {
      console.error("[ai-knowledge-sources] validação do agente falhou:", agentErr.message);
      return falha("internal_error", "Erro ao validar agent_id.", 500, { requestId });
    }
    if (!agent) {
      return falha("not_found", t("Assistente não encontrado nesta organização."), 404, {
        requestId,
      });
    }
  }

  let faqItems: Array<{ question: string; answer: string; tags: string[]; locale: string }> = [];

  if (ePerguntaEResposta(tipo)) {
    if (input.items && input.items.length > 0) {
      faqItems = input.items.map((it) => ({
        question: it.question,
        answer: it.answer,
        tags: it.tags,
        locale: it.locale,
      }));
    } else if (input.markdown_blob) {
      faqItems = parseFaqMarkdown(input.markdown_blob);
      if (faqItems.length === 0) {
        return falha(
          "invalid_request",
          t(
            "Não achei nenhum par pergunta/resposta no texto. Use uma linha ## Pergunta: e uma ## Resposta: por item.",
          ),
          400,
          { requestId },
        );
      }
    } else {
      return falha("invalid_request", t("Cole o conteúdo do material antes de criar."), 400, {
        requestId,
      });
    }
  } else if (tipo === "documento" && !input.markdown_blob?.trim()) {
    return falha(
      "invalid_request",
      "Cole o texto do documento, ou envie o arquivo em /api/v1/ai/knowledge/sources/upload.",
      400,
      { requestId },
    );
  }

  const admin = args.dbEscrita;

  // TEXTO COLADO DE DOCUMENTO VIRA ARQUIVO.
  //
  // Um documento não é uma lista de pergunta/resposta: é texto corrido, e não
  // havia onde guardá-lo — o indexador só sabia ler `ai_faq_items`, e era por
  // isso que colar uma política produzia uma fonte que nunca indexava nada.
  //
  // Em vez de uma tabela nova para "texto que não é P/R", o texto é guardado
  // como `.md` no mesmo bucket dos arquivos e segue exatamente a mesma rota de
  // extração. Um destino, um caminho, um lugar para consertar.
  let metadata: Record<string, unknown> = { ...(input.source_metadata ?? {}) };
  if (tipo === "documento" && input.markdown_blob) {
    const blobPath = `${args.orgId}/${randomUUID()}.md`;
    const { error: upErr } = await admin.storage
      .from(BUCKET_DE_CONHECIMENTO)
      .upload(blobPath, Buffer.from(input.markdown_blob, "utf8"), {
        contentType: "text/markdown",
        upsert: false,
      });
    if (upErr) {
      console.error("[ai-knowledge-sources] guardar o texto falhou:", upErr.message);
      return falha("internal_error", t("Erro ao guardar o conteúdo do material."), 500, {
        requestId,
      });
    }
    metadata = { ...metadata, blob_path: blobPath, ext: "md", origem: "texto_colado" };
  }

  const { data: ks, error: ksErr } = await admin
    .from("ai_knowledge_sources")
    .insert({
      organization_id: args.orgId,
      agent_id: input.agent_id ?? null,
      source_type: tipo,
      name: input.name,
      status: "ready",
      is_active: true,
      source_metadata: metadata,
      ingested_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (ksErr || !ks) {
    // `ai_knowledge_sources_nome_unico_por_org`: dois materiais ativos não podem
    // ter o mesmo nome — é por ele que a pessoa os distingue na tela e no
    // seletor do assistente. Sem esta tradução o 23505 saía como 500.
    if (ksErr?.code === "23505") {
      return falha(
        "knowledge_source_name_in_use",
        `Já existe um material chamado "${input.name}". Escolha outro nome.`,
        409,
        { requestId },
      );
    }
    console.error("[ai-knowledge-sources] insert falhou:", ksErr?.message);
    return falha("internal_error", "Erro ao criar o material.", 500, { requestId });
  }

  const ksId: string = (ks as { id: string }).id;

  let itemsCount = 0;
  if (faqItems.length > 0) {
    const rows = faqItems.map((item, idx) => ({
      organization_id: args.orgId,
      knowledge_source_id: ksId,
      question: item.question,
      answer: item.answer,
      tags: item.tags,
      locale: item.locale,
      position: idx,
    }));

    const { error: itemsErr } = await admin.from("ai_faq_items").insert(rows);

    if (itemsErr) {
      // Fonte sem item nenhum é fonte vazia: melhor desfazer do que deixar uma
      // linha que promete conteúdo e nunca vai indexar nada.
      await admin
        .from("ai_knowledge_sources")
        .delete()
        .eq("organization_id", args.orgId)
        .eq("id", ksId);
      console.error("[ai-knowledge-sources] insert dos itens falhou:", itemsErr.message);
      return falha("internal_error", t("Erro ao gravar o conteúdo do material."), 500, {
        requestId,
      });
    }
    itemsCount = rows.length;
  }

  const { error: emitErr } = await admin.rpc(
    "emit_event" as never,
    {
      p_event_type: "knowledge_source.updated",
      p_entity_kind: "ai_knowledge_source",
      p_entity_id: ksId,
      p_payload: {
        knowledge_source_id: ksId,
        agent_id: input.agent_id ?? null,
        source_type: tipo,
      },
      p_organization_id: args.orgId,
    } as never,
  );

  if (emitErr) {
    console.warn("[ai-knowledge-sources] emit_event falhou (não bloqueia):", emitErr.message);
  }

  // Quem pôs este material no acervo? A trilha responde — com tipo e contagem,
  // nunca com o texto (a tabela é append-only e a cascata da LGPD não a alcança).
  void audit({
    action: "ai.knowledge_source_created",
    actorUserId: args.ator.userId,
    actorApiTokenId: args.ator.apiTokenId,
    organizationId: args.orgId,
    resourceType: "ai_knowledge_source",
    resourceId: ksId,
    requestId,
    metadata: { source_type: tipo, items_count: itemsCount },
  });

  // A resposta DIZ se a indexação vai acontecer. Sem isto a tela prometia
  // "começa em instantes" para uma organização sem chave de embedding, e o
  // material ficava parado sem que nada na tela mudasse.
  const temChave = await temChaveDeEmbedding(args.orgId);

  return { ok: true, data: { id: ksId, items_count: itemsCount, indexacao_habilitada: temChave } };
}

export async function atualizarMaterial(args: {
  dbLeitura: SupabaseClient;
  dbEscrita: SupabaseClient;
  orgId: string;
  sourceId: string;
  input: z.output<typeof patchSourceSchema>;
  ator: AtorDoMaterial;
}): Promise<{ ok: true; data: { id: string; items_count?: number } } | FalhaDoMaterial> {
  const requestId = args.ator.requestId;
  const sourceId = args.sourceId;
  const input = args.input;

  // Verify the source exists and belongs to the org (user-scoped client for RLS check).
  const supabase = args.dbLeitura;
  const { data: existing, error: fetchErr } = await supabase
    .from("ai_knowledge_sources")
    .select("id, source_type, agent_id")
    .eq("id", sourceId)
    .eq("organization_id", args.orgId)
    .maybeSingle();

  if (fetchErr) {
    console.error("[ai-knowledge-sources] PATCH fetch failed:", fetchErr.message);
    return falha("internal_error", "Erro ao verificar fonte.", 500, { requestId });
  }
  if (!existing) {
    return falha("not_found", "Fonte de conhecimento não encontrada.", 404, { requestId });
  }

  const ksRow = existing as { id: string; source_type: string; agent_id: string | null };
  const tipo = canonizarTipoDeFonte(ksRow.source_type);

  // `items` SÓ tem efeito em `faq`. A conferência vem antes de QUALQUER escrita.
  //
  // A recusa anterior testava `!aceitaTextoColado(tipo)`, e `documento` aceita
  // texto colado — na CRIAÇÃO, onde o texto vira arquivo. No PATCH isso passava
  // pela recusa, não entrava no ramo do FAQ e terminava em `200 { id }`: quem
  // integra por API achava que tinha trocado o conteúdo e nada mudou. E a
  // recusa vinha DEPOIS do `update` de nome/metadata, então um 422 em
  // `{ name, items }` já tinha gravado o nome novo. Recusa alta, antes de tudo.
  if (input.items !== undefined && tipo !== "faq") {
    return falha(
      "unprocessable_entity",
      "Este material não é preenchido por texto colado — envie o arquivo ou aguarde a rotina que o alimenta.",
      422,
      { requestId },
    );
  }

  // Build update payload (only provided fields).
  const updatePayload: Record<string, unknown> = {};
  if (input.name !== undefined) updatePayload.name = input.name;
  if (input.source_metadata !== undefined) updatePayload.source_metadata = input.source_metadata;

  const admin = args.dbEscrita;

  if (Object.keys(updatePayload).length > 0) {
    const { error: updateErr } = await admin
      .from("ai_knowledge_sources")
      .update(updatePayload)
      .eq("id", sourceId)
      .eq("organization_id", args.orgId);

    if (updateErr) {
      console.error("[ai-knowledge-sources] PATCH update failed:", updateErr.message);
      return falha("internal_error", "Erro ao atualizar fonte.", 500, { requestId });
    }
  }

  // Replace FAQ items if provided.
  let itemsCount: number | undefined;
  if (input.items !== undefined && tipo === "faq") {
    // Delete existing items.
    const { error: delErr } = await admin
      .from("ai_faq_items")
      .delete()
      .eq("knowledge_source_id", sourceId)
      .eq("organization_id", args.orgId);

    if (delErr) {
      console.error("[ai-knowledge-sources] PATCH delete items failed:", delErr.message);
      return falha("internal_error", "Erro ao remover itens antigos.", 500, { requestId });
    }

    if (input.items.length > 0) {
      const rows = input.items.map((item, idx) => ({
        organization_id: args.orgId,
        knowledge_source_id: sourceId,
        question: item.question,
        answer: item.answer,
        tags: item.tags,
        locale: item.locale,
        position: idx,
      }));

      const { error: insertErr } = await admin.from("ai_faq_items").insert(rows);

      if (insertErr) {
        console.error("[ai-knowledge-sources] PATCH insert items failed:", insertErr.message);
        return falha("internal_error", "Erro ao inserir novos itens FAQ.", 500, { requestId });
      }
      itemsCount = rows.length;
    } else {
      itemsCount = 0;
    }
  }

  // Emit knowledge_source.updated (fire-and-forget).
  const { error: emitErr } = await admin.rpc(
    "emit_event" as never,
    {
      p_event_type: "knowledge_source.updated",
      p_entity_kind: "ai_knowledge_source",
      p_entity_id: sourceId,
      p_payload: {
        knowledge_source_id: sourceId,
        agent_id: ksRow.agent_id,
        source_type: ksRow.source_type,
      },
      p_organization_id: args.orgId,
    } as never,
  );

  if (emitErr) {
    console.warn("[ai-knowledge-sources] emit_event failed (non-blocking):", emitErr.message);
  }

  // A trilha responde "quem mudou o que o agente diz aos clientes". Só ids,
  // nomes de campo e contagem — o texto do material nunca entra: a tabela é
  // append-only e a cascata da LGPD não a alcança.
  void audit({
    action: "ai.knowledge_source_updated",
    actorUserId: args.ator.userId,
    actorApiTokenId: args.ator.apiTokenId,
    organizationId: args.orgId,
    resourceType: "ai_knowledge_source",
    resourceId: sourceId,
    requestId,
    metadata: {
      source_type: ksRow.source_type,
      campos: Object.keys(updatePayload),
      ...(itemsCount !== undefined ? { items_count: itemsCount } : {}),
    },
  });

  return {
    ok: true,
    data: { id: sourceId, ...(itemsCount !== undefined ? { items_count: itemsCount } : {}) },
  };
}
