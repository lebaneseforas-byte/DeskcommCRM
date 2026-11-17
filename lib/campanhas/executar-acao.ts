/**
 * EXECUTAR UMA AÇÃO DE CAMPANHA — preparar, iniciar, agendar, pausar, retomar,
 * cancelar, duplicar e testar. A parte que `POST /api/v1/campaigns/:id/:acao` e
 * o MCP do CRM (o dono pelo ChatGPT) fazem igual.
 *
 * ═══ Por que um despacho só ═══
 *
 * Todas fazem a mesma coisa em volta: carregar a campanha da organização certa,
 * pedir a transição à máquina de estados (`lib/campanhas/acoes.ts`) e auditar.
 * Espalhado, esse "em volta" diverge — e o dia em que um caminho esquecer de
 * conferir o estado é o dia em que uma campanha cancelada volta a enviar. Por
 * isso a rota e o MCP passam por AQUI, e só por aqui.
 *
 * ⚠️ `admin` é o client de serviço: duas ações ENVIAM (o teste e, por tabela, a
 * preparação lê contatos da organização inteira). Toda consulta filtra
 * `organization_id`, que vem de quem chama — nunca do corpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { knobsDoCanal } from "@/lib/automation/janela-do-canal";
import {
  agendarAcao,
  cancelarAcao,
  carregarCampanha,
  duplicarAcao,
  iniciarAcao,
  pausarAcao,
  prepararAcao,
  testarAcao,
  type Desfecho,
} from "@/lib/campanhas/acoes";
import { agendarSchema, testarSchema } from "@/lib/campanhas/schemas";

export const ACOES_DE_CAMPANHA = [
  "preparar",
  "iniciar",
  "agendar",
  "pausar",
  "retomar",
  "cancelar",
  "duplicar",
  "testar",
] as const;

export type AcaoDeCampanha = (typeof ACOES_DE_CAMPANHA)[number];

export function ehAcaoDeCampanha(valor: string): valor is AcaoDeCampanha {
  return (ACOES_DE_CAMPANHA as readonly string[]).includes(valor);
}

export type ResultadoDaAcao =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; codigo: string; mensagem: string; status: number };

/** O corpo da resposta sem o `ok`, que é ruído para quem lê `{ data }`. */
function semOk(d: { ok: true } & Record<string, unknown>): Record<string, unknown> {
  const { ok: _ignorado, ...resto } = d;
  return resto;
}

export async function executarAcaoDaCampanha(
  admin: SupabaseClient,
  args: {
    orgId: string;
    campanhaId: string;
    acao: AcaoDeCampanha;
    /** O corpo da requisição — só `agendar` (data) e `testar` (contato) leem. */
    corpo: unknown;
    ator: { userId: string | null; apiTokenId: string | null; requestId: string };
    t: (texto: string) => string;
  },
): Promise<ResultadoDaAcao> {
  const { orgId, acao, ator, t } = args;
  const carregada = await carregarCampanha(admin, orgId, args.campanhaId);
  if (!carregada.ok)
    return {
      ok: false,
      codigo: carregada.codigo,
      mensagem: t(carregada.mensagem),
      status: carregada.status,
    };
  const campanha = carregada.campanha;
  const agora = new Date();

  let desfecho: Desfecho<Record<string, unknown>>;
  let acaoAuditada: AuditAction | null = null;
  let extra: Record<string, unknown> = {};

  switch (acao) {
    case "preparar": {
      desfecho = await prepararAcao(admin, campanha, agora);
      acaoAuditada = "campaign.prepared";
      break;
    }
    case "iniciar":
    case "retomar": {
      const r = await iniciarAcao(admin, campanha, agora);
      desfecho = r;
      acaoAuditada = r.ok && r.retomada ? "campaign.resumed" : "campaign.started";
      break;
    }
    case "agendar": {
      const parsed = agendarSchema.safeParse(args.corpo);
      if (!parsed.success) {
        return {
          ok: false,
          codigo: "validation_failed",
          mensagem: t("Informe a data do agendamento."),
          status: 422,
        };
      }
      desfecho = await agendarAcao(admin, campanha, new Date(parsed.data.scheduled_at), agora);
      acaoAuditada = "campaign.scheduled";
      extra = { scheduled_at: parsed.data.scheduled_at };
      break;
    }
    case "pausar": {
      desfecho = await pausarAcao(admin, campanha, agora);
      acaoAuditada = "campaign.paused";
      break;
    }
    case "cancelar": {
      desfecho = await cancelarAcao(admin, campanha, agora);
      acaoAuditada = "campaign.cancelled";
      break;
    }
    case "duplicar": {
      // A cópia leva o autor; uma conexão (token) não é autora.
      if (!ator.userId) {
        return {
          ok: false,
          codigo: "forbidden",
          mensagem: t("Duplicar campanha é pela tela."),
          status: 403,
        };
      }
      desfecho = await duplicarAcao(admin, campanha, ator.userId);
      acaoAuditada = "campaign.duplicated";
      break;
    }
    case "testar": {
      if (campanha.channel_session_id === null) {
        return {
          ok: false,
          codigo: "campanha_conteudo_invalido",
          mensagem: t(
            "Campanha de e-mail ainda não é enviada: esta entrega guarda o assunto, o corpo e o público. O envio entra na fatia seguinte.",
          ),
          status: 422,
        };
      }
      const parsed = testarSchema.safeParse(args.corpo);
      if (!parsed.success) {
        return {
          ok: false,
          codigo: "validation_failed",
          mensagem: t("Escolha um contato para o teste."),
          status: 422,
        };
      }
      // O fuso é o do NÚMERO (channel_knobs), o mesmo que a janela de envio usa
      // — a saudação do teste tem de ser a que o destinatário veria.
      const knobs = await knobsDoCanal(admin, orgId, campanha.channel_session_id);
      desfecho = await testarAcao(admin, campanha, parsed.data.contact_id, agora, knobs.timezone);
      acaoAuditada = "campaign.test_sent";
      break;
    }
  }

  const registrar = (metadata: Record<string, unknown>) =>
    void audit({
      action: acaoAuditada!,
      actorUserId: ator.userId,
      actorApiTokenId: ator.apiTokenId,
      organizationId: orgId,
      resourceType: "campaign",
      resourceId: campanha.id,
      requestId: ator.requestId,
      // Sem telefone, sem texto: id e contagem bastam para responder "quem
      // mandou isso, e quando?".
      metadata,
    });

  if (!desfecho.ok) {
    // Falha depois de gravar (o cancelamento sem a fila fechada): o estado
    // mudou, então a trilha registra o que ficou gravado — e a resposta, o erro.
    if (acaoAuditada && desfecho.gravado) registrar({ ...extra, ...desfecho.gravado });
    return {
      ok: false,
      codigo: desfecho.codigo,
      mensagem: t(desfecho.mensagem),
      status: desfecho.status,
    };
  }
  if (acaoAuditada) registrar({ ...extra, ...semOk(desfecho) });
  return { ok: true, data: semOk(desfecho) };
}
