/**
 * GET/POST /api/v1/cron/passagem-escalonamento — a passagem que ninguém aceitou
 * volta a pedir gente, e a urgente sobe para o reserva.
 *
 * ## O que faz
 *
 * Varre as passagens VIVAS (`pendente`, `atribuida`, `reaberta` — migration
 * 9401) dos últimos 7 dias, uma por conversa (a mais recente), e aplica a cada
 * uma `aplicarEscalonamento` (`lib/escalacao/escalonamento-da-passagem.ts`): a
 * regra pura decide lembrar, escalar ou calar, e só quem vence o
 * compare-and-set fala com alguém. A configuração é da organização
 * (`settings.escalonamento_de_passagem`, tela IA › Aviso no WhatsApp), e
 * ausente é LIGADO com os padrões.
 *
 * ## O que NÃO faz
 *
 * - Não fala com cliente. Os três canais são a Central, o push (pelo barramento
 *   do aviso) e o WhatsApp de um MEMBRO da equipe.
 * - Não atribui a conversa. Escalar troca o RESPONSÁVEL da passagem; quem
 *   aceita é que fica com a conversa (`POST …/passagens/aceitar`).
 * - Não repete: cada lembrete é reivindicado antes de sair, e os tetos moram na
 *   regra pura, não neste laço.
 *
 * ## Por que de 5 em 5 minutos
 *
 * O menor intervalo configurável é 5 min e o default urgente é 15. Rodar a cada
 * minuto seria 60 varreduras/h por um prazo que, no pior caso, atrasa 5 min.
 *
 * Auth: o mesmo contrato dos demais crons (`autorizaCron`). Audita SÓ quando
 * lembrou ou escalou — uma linha por efeito, escrita pelo efeito
 * (`handoff.reminder_sent`, `handoff.escalated`); rodada vazia não escreve nada.
 * Organização parada (`idsDeOrgsParadas`) não é varrida: ela não fala.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { env } from "@/lib/env";
import {
  aplicarEscalonamento,
  ESTADOS_EM_ABERTO,
  HORIZONTE_DO_ESCALONAMENTO_MS,
  lerEscalonamento,
  type PassagemLida,
  umaPorConversa,
} from "@/lib/escalacao/escalonamento-da-passagem";
import {
  criarEfeitosDoEscalonamento,
  idiomaDaLinha,
  type OrganizacaoDoEscalonamento,
} from "@/lib/escalacao/lembrete-da-passagem";
import { logger } from "@/lib/logger";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Teto de passagens lidas por rodada; o que sobrar entra na próxima. */
const LIMITE_DA_VARREDURA = 500;

const COLUNAS =
  "id, organization_id, conversation_id, contact_id, estado, urgente, responsavel_user_id, lembretes_enviados, ultimo_lembrete_em, escalada_em, criado_em";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const agora = new Date();
  const horizonte = new Date(agora.getTime() - HORIZONTE_DO_ESCALONAMENTO_MS).toISOString();

  let paradas: Set<string>;
  try {
    paradas = new Set(await idsDeOrgsParadas(admin));
  } catch (err) {
    logger.error("[passagem-escalonamento] leitura das organizações paradas falhou", {
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return fail("internal_error", "Falha ao ler organizações.", 500, { requestId });
  }

  const { data, error } = await admin
    .from("passagens_de_atendimento")
    .select(COLUNAS)
    .in("estado", [...ESTADOS_EM_ABERTO])
    .gte("criado_em", horizonte)
    .order("criado_em", { ascending: true })
    .limit(LIMITE_DA_VARREDURA);
  if (error) {
    logger.error("[passagem-escalonamento] varredura falhou", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar passagens.", 500, { requestId });
  }

  const candidatas = umaPorConversa((data ?? []) as PassagemLida[]).filter(
    (p) => !paradas.has(p.organization_id),
  );
  if (candidatas.length === 0) {
    return ok({ examinadas: 0, lembretes: 0, escaladas: 0, corridas_perdidas: 0 }, { requestId });
  }

  const orgIds = [...new Set(candidatas.map((p) => p.organization_id))];
  const { data: orgs, error: erroOrgs } = await admin
    .from("organizations")
    .select("id, locale, timezone, settings")
    .in("id", orgIds);
  if (erroOrgs) {
    logger.error("[passagem-escalonamento] leitura das organizações falhou", {
      error: erroOrgs.message,
      requestId,
    });
    return fail("internal_error", "Falha ao ler organizações.", 500, { requestId });
  }
  const porOrg = new Map<string, OrganizacaoDoEscalonamento & { fuso: string | null }>();
  for (const o of (orgs ?? []) as Array<{ id: string; locale: string | null; timezone: string | null; settings: unknown }>) {
    porOrg.set(o.id, { idioma: idiomaDaLinha(o.locale), settings: o.settings, fuso: o.timezone });
  }

  const efeitos = criarEfeitosDoEscalonamento(admin, {
    requestId,
    urlPublica: env.NEXT_PUBLIC_APP_URL,
    organizacao: (orgId) => porOrg.get(orgId) ?? { idioma: "pt-BR", settings: {} },
  });

  let lembretes = 0;
  let escaladas = 0;
  let corridasPerdidas = 0;
  for (const lida of candidatas) {
    const org = porOrg.get(lida.organization_id);
    if (!org) continue;
    try {
      const r = await aplicarEscalonamento(efeitos, {
        lida,
        config: lerEscalonamento(org.settings),
        agora,
        fuso: org.fuso,
      });
      if (r.feito === "lembrete") lembretes += 1;
      else if (r.feito === "escalada") escaladas += 1;
      else if (r.feito === "perdeu_a_corrida") corridasPerdidas += 1;
    } catch (err) {
      // Uma passagem não derruba a rodada: as outras clientes continuam
      // esperando, e esta volta na próxima (o CAS não foi gravado, ou foi e o
      // teto segura).
      logger.error("[passagem-escalonamento] passo falhou", {
        passagem_id: lida.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  return ok(
    { examinadas: candidatas.length, lembretes, escaladas, corridas_perdidas: corridasPerdidas },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
