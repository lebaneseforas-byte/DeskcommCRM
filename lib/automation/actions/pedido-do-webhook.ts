/**
 * O PEDIDO no corpo do webhook de saída — `data.request`, e só por opt-in.
 *
 * ## Para que serve
 *
 * Quem recebe o aviso "o contato ganhou a etiqueta X" (um sistema de operações,
 * por exemplo) precisa saber O QUE o cliente pediu sem abrir o CRM: o título e o
 * resumo do negócio, a última coisa que o cliente escreveu, o canal e o id da
 * conversa para abrir o atendimento direto. Sem isto, o outro lado recebia só o
 * contato e mostrava uma linha vazia — medido numa integração real em
 * 16/11/2026, em que a equipe pedia "mais detalhes do pedido" a cada aviso.
 *
 * ## Por que é opt-in
 *
 * A última mensagem do cliente é dado pessoal e o resumo do negócio é dado
 * comercial. A mesma régua do responsável (`include_owner`, #1612): sem
 * `include_request: true` na ação, a chave nem nasce — e a forma segura de
 * garantir isso é não fazer consulta nenhuma.
 *
 * ## De onde sai cada campo
 *
 * - `title` / `summary`: o negócio do contexto (`context.lead`) ou, quando o
 *   gatilho é de CONTATO (`contact.tag_added`), o negócio ABERTO mais recente do
 *   contato — a mesma escolha que o motor faz para mensagem recebida
 *   (`buildContext`, #3974). `summary` é a descrição do negócio.
 * - `conversation_id` / `channel`: a conversa do evento quando ele traz uma
 *   (`payload.conversation_id`); senão a conversa individual mais recente do
 *   contato. `channel` é o valor de `conversations.channel` (whatsapp,
 *   instagram, facebook); qualquer outro vira `other`.
 * - `last_message`: a última mensagem RECEBIDA nessa conversa com texto (o
 *   corpo, ou a transcrição/descrição da mídia).
 *
 * ## Nunca lança
 *
 * Cada leitura é melhor esforço. Uma falha deixa o campo de fora; a entrega do
 * webhook nunca falha por causa de um detalhe do pedido. Toda consulta filtra
 * `organization_id` da regra (cliente admin, sem RLS).
 */
import type { ActionCtx } from "@/lib/automation/types";

export const LIMITES_DO_PEDIDO = { title: 140, summary: 1000, last_message: 1000 } as const;

export type CanalDoPedido = "whatsapp" | "instagram" | "facebook" | "other";

const CANAIS_CONHECIDOS: ReadonlySet<string> = new Set(["whatsapp", "instagram", "facebook"]);

/** `conversations.channel` → o vocabulário do contrato. Desconhecido vira `other`. */
export function canalDoPedido(bruto: unknown): CanalDoPedido {
  return typeof bruto === "string" && CANAIS_CONHECIDOS.has(bruto) ? (bruto as CanalDoPedido) : "other";
}

/** Texto limpo e cortado no limite do contrato; vazio vira `null`. */
export function textoDoPedido(bruto: unknown, limite: number): string | null {
  if (typeof bruto !== "string") return null;
  const limpo = bruto.trim();
  if (!limpo) return null;
  return limpo.length > limite ? limpo.slice(0, limite - 1).trimEnd() + "…" : limpo;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function texto(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

async function negocioDoContato(
  ctx: ActionCtx,
  contactId: string | null,
): Promise<Record<string, unknown> | null> {
  const doContexto = ctx.context.lead as Record<string, unknown> | undefined;
  if (doContexto) return doContexto;
  if (!contactId) return null;
  try {
    const { data } = await ctx.admin
      .from("crm_leads")
      .select("title, description")
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", contactId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as Record<string, unknown> | null) ?? null;
  } catch {
    return null;
  }
}

async function conversaDoPedido(
  ctx: ActionCtx,
  contactId: string | null,
): Promise<{ id: string; channel: unknown } | null> {
  try {
    const doEvento = texto(ctx.event.payload?.conversation_id);
    if (doEvento && UUID.test(doEvento)) {
      const { data } = await ctx.admin
        .from("conversations")
        .select("id, channel")
        .eq("organization_id", ctx.organizationId)
        .eq("id", doEvento)
        .maybeSingle();
      if (data) return data as { id: string; channel: unknown };
    }
    if (!contactId) return null;
    const { data } = await ctx.admin
      .from("conversations")
      .select("id, channel")
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", contactId)
      .eq("is_group", false)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    return (data as { id: string; channel: unknown } | null) ?? null;
  } catch {
    return null;
  }
}

async function ultimaMensagemDoCliente(ctx: ActionCtx, conversationId: string): Promise<string | null> {
  try {
    const { data } = await ctx.admin
      .from("messages")
      .select("body, media_derived_text")
      .eq("organization_id", ctx.organizationId)
      .eq("conversation_id", conversationId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(5);
    for (const m of (data ?? []) as { body?: unknown; media_derived_text?: unknown }[]) {
      const t = textoDoPedido(m.body, LIMITES_DO_PEDIDO.last_message) ??
        textoDoPedido(m.media_derived_text, LIMITES_DO_PEDIDO.last_message);
      if (t) return t;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * `data.request` — ou `undefined` sem o opt-in (nenhuma consulta) ou quando não
 * há nada a dizer. Campos sem valor ficam de fora, nunca `null`.
 */
export async function pedidoPublico(
  ctx: ActionCtx,
  config: Record<string, unknown>,
): Promise<Record<string, string> | undefined> {
  if (config.include_request !== true) return undefined;
  const contato = ctx.context.contact as Record<string, unknown> | undefined;
  const lead = ctx.context.lead as Record<string, unknown> | undefined;
  const contactId = texto(contato?.id) ?? texto(lead?.contact_id) ?? texto(ctx.event.payload?.contact_id);

  const [negocio, conversa] = await Promise.all([
    negocioDoContato(ctx, contactId),
    conversaDoPedido(ctx, contactId),
  ]);
  const ultima = conversa ? await ultimaMensagemDoCliente(ctx, conversa.id) : null;

  const pedido: Record<string, string> = {};
  const titulo = textoDoPedido(negocio?.title, LIMITES_DO_PEDIDO.title);
  const resumo = textoDoPedido(negocio?.description, LIMITES_DO_PEDIDO.summary);
  if (titulo) pedido.title = titulo;
  if (resumo) pedido.summary = resumo;
  if (ultima) pedido.last_message = ultima;
  if (conversa) {
    pedido.channel = canalDoPedido(conversa.channel);
    pedido.conversation_id = conversa.id;
  }
  return Object.keys(pedido).length > 0 ? pedido : undefined;
}
