/**
 * A PASSAGEM NUNCA SE PERDE — o estado, a configuração e a DECISÃO do lembrete.
 *
 * ─── O que este arquivo é ───────────────────────────────────────────────────
 *
 * A regra pura (sem banco, sem relógio, sem rede) que o cron
 * `app/api/v1/cron/passagem-escalonamento` aplica a cada passagem viva:
 * lembrar o responsável, escalar para o reserva, ou ficar quieto. É aqui que
 * moram os tetos — e eles moram aqui, e não no cron, porque um teto que só
 * existe no laço de quem chama é um teto que o próximo chamador esquece.
 *
 * ─── Os estados (migration 9401) ────────────────────────────────────────────
 *
 *   pendente   ninguém responde por ela ainda;
 *   atribuida  há responsável, mas ENTREGUE não é ACEITA;
 *   aceita     a pessoa disse "é comigo";
 *   resolvida  a conversa fechou ou voltou ao automático;
 *   reaberta   o cliente voltou depois de uma passagem já resolvida.
 *
 * `ESTADOS_DA_PASSAGEM` é o par TypeScript do CHECK do banco, medido por
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
 *
 * ─── A linha do tempo (defaults) ────────────────────────────────────────────
 *
 *   URGENTE (etiqueta `urgente`/`reclamação`), a cada 15 min:
 *     0 min  passagem nasce, nada;
 *    15 min  lembrete 1 ao responsável;
 *    30 min  lembrete 2;
 *    45 min  ESCALA: o responsável vira o reserva configurado, que é avisado;
 *    60 min  lembrete 3 — o último, ao reserva. Depois disso, silêncio.
 *   Sem reserva configurado, aos 45 a escalada é REGISTRADA como pulada
 *   (`escalada_em` com `escalada_para` nulo) e o último lembrete vai ao
 *   responsável de sempre. Uma escalada só: nunca de volta, nunca em cadeia.
 *
 *   NORMAL, a cada 60 min, até `max_lembretes` (3): 60, 120, 180 — e para.
 *   Passagem normal nunca troca de responsável.
 *
 * ─── Silêncio ───────────────────────────────────────────────────────────────
 *
 * Entre `silencio.inicio` e `silencio.fim` (no fuso da ORGANIZAÇÃO) o WhatsApp
 * não sai — a Central e o push continuam. Quem atende pelo celular não leva
 * mensagem às 3 h da manhã por causa de uma passagem que pode esperar o
 * expediente; o sino, que é silencioso, continua contando.
 */
import { z } from "zod";

/** O vocabulário do CHECK `passagens_de_atendimento_estado_check`. */
export const ESTADOS_DA_PASSAGEM = ["pendente", "atribuida", "aceita", "resolvida", "reaberta"] as const;
export type EstadoDaPassagem = (typeof ESTADOS_DA_PASSAGEM)[number];

/** Os estados em que alguém do outro lado ainda espera uma pessoa. */
export const ESTADOS_EM_ABERTO: readonly EstadoDaPassagem[] = ["pendente", "atribuida", "reaberta"];

export function passagemEmAberto(estado: string | null | undefined): boolean {
  return (ESTADOS_EM_ABERTO as readonly string[]).includes(estado ?? "");
}

/**
 * As etiquetas que tornam a passagem urgente, na forma normalizada de
 * `conversationTagSchema` (trim + minúsculas). A MESMA lista mora em
 * `fn_passagem_eh_urgente` (migration 9401) — é o banco que decide, na criação.
 */
export const ETIQUETAS_URGENTES = ["urgente", "reclamação", "reclamacao"] as const;

/** Teto absoluto, acima de qualquer configuração: nenhuma passagem vira laço. */
export const TETO_ABSOLUTO_DE_LEMBRETES = 10;

/** Só olha passagem desta idade para baixo: a atualização não acorda o passado. */
export const HORIZONTE_DO_ESCALONAMENTO_MS = 7 * 24 * 60 * 60 * 1000;

/** `organizations.settings.<CHAVE>`. */
export const CHAVE_DO_ESCALONAMENTO = "escalonamento_de_passagem";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A etiqueta na forma em que o banco a grava e procura — a régua de
 * `conversationTagSchema` (trim + minúsculas, 1..40). `null` = não é etiqueta.
 */
export function normalizarEtiqueta(bruta: unknown): string | null {
  if (typeof bruta !== "string") return null;
  const etiqueta = bruta.trim().toLowerCase();
  return etiqueta.length >= 1 && etiqueta.length <= 40 ? etiqueta : null;
}

const minutos = z.number().int().min(5).max(1440);
const lembretes = z.number().int().min(1).max(TETO_ABSOLUTO_DE_LEMBRETES);
const hora = z.number().int().min(0).max(23);

/**
 * O CONTRATO de escrita (a tela de configurações). Estrito: um campo torto é
 * recusado com nome, nunca salvo pela metade.
 */
export const escalonamentoWriteSchema = z
  .object({
    ligado: z.boolean(),
    urgente_minutos: minutos,
    normal_minutos: minutos,
    max_lembretes: lembretes,
    escalar_urgente_apos_lembretes: lembretes,
    backup: z
      .record(z.string().regex(UUID), z.string().regex(UUID))
      .refine((m) => Object.keys(m).length <= 200, "backup_grande_demais")
      .refine((m) => Object.entries(m).every(([de, para]) => de !== para), "backup_de_si_mesmo"),
    silencio: z.object({ inicio: hora, fim: hora }),
    /**
     * `{ "<etiqueta>": "<userId>" }` — o 3º elo do responsável, depois do dono
     * da conversa e do dono do negócio (`fn_passagem_responsavel_inicial`,
     * migration 9401). A chave é gravada NORMALIZADA (trim + minúsculas, como
     * `conversationTagSchema`), porque é assim que o banco a procura.
     */
    rota_por_etiqueta: z
      .record(z.string(), z.string().regex(UUID))
      .transform((m, ctx) => {
        const saida: Record<string, string> = {};
        for (const [bruta, quem] of Object.entries(m)) {
          const etiqueta = normalizarEtiqueta(bruta);
          if (!etiqueta) {
            ctx.addIssue({ code: "custom", message: "etiqueta_invalida" });
            return z.NEVER;
          }
          saida[etiqueta] = quem;
        }
        return saida;
      })
      .refine((m) => Object.keys(m).length <= 100, "rota_grande_demais"),
  })
  .strict();

/** O que a TELA manda (antes da normalização das etiquetas). */
export type EscalonamentoDaPassagemEntrada = z.input<typeof escalonamentoWriteSchema>;
export type EscalonamentoDaPassagem = z.output<typeof escalonamentoWriteSchema>;

export const ESCALONAMENTO_PADRAO: EscalonamentoDaPassagem = {
  ligado: true,
  urgente_minutos: 15,
  normal_minutos: 60,
  max_lembretes: 3,
  escalar_urgente_apos_lembretes: 2,
  backup: {},
  silencio: { inicio: 22, fim: 8 },
  rota_por_etiqueta: {},
};

/**
 * A LEITURA — nunca lança. O jsonb pode ter sido escrito por fora (script,
 * versão antiga), então cada campo cai no padrão sozinho: um `urgente_minutos`
 * torto não desliga o escalonamento inteiro, e ausente é LIGADO com os padrões
 * (decisão do produto: passagem esquecida é o defeito, não o recurso).
 */
export function lerEscalonamento(settings: unknown): EscalonamentoDaPassagem {
  const raiz =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)[CHAVE_DO_ESCALONAMENTO]
      : undefined;
  const bloco =
    raiz && typeof raiz === "object" && !Array.isArray(raiz) ? (raiz as Record<string, unknown>) : {};
  const p = ESCALONAMENTO_PADRAO;
  const silencioBruto =
    bloco.silencio && typeof bloco.silencio === "object" && !Array.isArray(bloco.silencio)
      ? (bloco.silencio as Record<string, unknown>)
      : {};
  const backup: Record<string, string> = {};
  if (bloco.backup && typeof bloco.backup === "object" && !Array.isArray(bloco.backup)) {
    for (const [de, para] of Object.entries(bloco.backup as Record<string, unknown>)) {
      if (UUID.test(de) && typeof para === "string" && UUID.test(para) && de !== para) backup[de] = para;
    }
  }
  const rota: Record<string, string> = {};
  if (bloco.rota_por_etiqueta && typeof bloco.rota_por_etiqueta === "object" && !Array.isArray(bloco.rota_por_etiqueta)) {
    for (const [bruta, quem] of Object.entries(bloco.rota_por_etiqueta as Record<string, unknown>)) {
      const etiqueta = normalizarEtiqueta(bruta);
      if (etiqueta && typeof quem === "string" && UUID.test(quem)) rota[etiqueta] = quem;
    }
  }
  return {
    ligado: z.boolean().catch(p.ligado).parse(bloco.ligado ?? p.ligado),
    urgente_minutos: minutos.catch(p.urgente_minutos).parse(bloco.urgente_minutos),
    normal_minutos: minutos.catch(p.normal_minutos).parse(bloco.normal_minutos),
    max_lembretes: lembretes.catch(p.max_lembretes).parse(bloco.max_lembretes),
    escalar_urgente_apos_lembretes: lembretes
      .catch(p.escalar_urgente_apos_lembretes)
      .parse(bloco.escalar_urgente_apos_lembretes),
    backup,
    silencio: {
      inicio: hora.catch(p.silencio.inicio).parse(silencioBruto.inicio),
      fim: hora.catch(p.silencio.fim).parse(silencioBruto.fim),
    },
    rota_por_etiqueta: rota,
  };
}

/** A hora local (0–23) no fuso dado; fuso inválido cai em São Paulo, o default da coluna. */
export function horaNoFuso(agora: Date, fuso: string | null | undefined): number {
  const formatar = (tz: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(agora);
  let texto: string;
  try {
    texto = formatar(fuso || "America/Sao_Paulo");
  } catch {
    texto = formatar("America/Sao_Paulo");
  }
  const h = Number.parseInt(texto, 10);
  return Number.isFinite(h) ? h % 24 : 0;
}

/**
 * Está no horário de silêncio? Janela meio-aberta `[inicio, fim)`, que pode
 * atravessar a meia-noite (22 → 8). `inicio === fim` é "sem silêncio".
 */
export function emSilencio(
  agora: Date,
  fuso: string | null | undefined,
  silencio: { inicio: number; fim: number },
): boolean {
  const { inicio, fim } = silencio;
  if (inicio === fim) return false;
  const h = horaNoFuso(agora, fuso);
  return inicio < fim ? h >= inicio && h < fim : h >= inicio || h < fim;
}

/** O que a decisão precisa saber da linha. */
export interface PassagemParaEscalonar {
  estado: string;
  urgente: boolean;
  responsavel_user_id: string | null;
  lembretes_enviados: number;
  ultimo_lembrete_em: string | null;
  escalada_em: string | null;
  criado_em: string;
}

export type DecisaoDoEscalonamento =
  | { acao: "nada"; motivo: "desligado" | "fechada" | "cedo" | "teto" }
  | {
      acao: "lembrar";
      /** O número DESTE lembrete (1-based); o compare-and-set grava ele. */
      numero: number;
      para: string | null;
      whatsapp: boolean;
      ultimo: boolean;
    }
  | {
      acao: "escalar";
      /** De quem sai — o responsável de agora (pode ser nulo). */
      de: string | null;
      /** Para quem vai — `null` quando não há reserva configurado. */
      para: string | null;
      whatsapp: boolean;
    };

function instante(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * A DECISÃO. Pura e total: toda passagem tem uma resposta, e toda resposta
 * respeita os tetos — `TETO_ABSOLUTO_DE_LEMBRETES` vale mesmo que alguém grave
 * um número absurdo no jsonb.
 *
 * O relógio de cada passo é o ÚLTIMO acontecimento: o último lembrete, ou a
 * escalada (o lembrete pós-escalada conta a partir dela), ou o nascimento.
 */
export function decidirEscalonamento(entrada: {
  passagem: PassagemParaEscalonar;
  config: EscalonamentoDaPassagem;
  agora: Date;
  fuso: string | null | undefined;
}): DecisaoDoEscalonamento {
  const { passagem: p, config, agora, fuso } = entrada;
  if (!config.ligado) return { acao: "nada", motivo: "desligado" };
  if (!passagemEmAberto(p.estado)) return { acao: "nada", motivo: "fechada" };

  const enviados = Math.max(0, Math.trunc(p.lembretes_enviados || 0));
  if (enviados >= TETO_ABSOLUTO_DE_LEMBRETES) return { acao: "nada", motivo: "teto" };

  const intervaloMs = (p.urgente ? config.urgente_minutos : config.normal_minutos) * 60_000;
  const marcos = [instante(p.ultimo_lembrete_em), instante(p.escalada_em), instante(p.criado_em)].filter(
    (t): t is number => t !== null,
  );
  const base = marcos.length > 0 ? Math.max(...marcos) : agora.getTime();
  if (agora.getTime() - base < intervaloMs) return { acao: "nada", motivo: "cedo" };

  const whatsapp = !emSilencio(agora, fuso, config.silencio);

  if (!p.urgente) {
    const teto = Math.min(config.max_lembretes, TETO_ABSOLUTO_DE_LEMBRETES);
    if (enviados >= teto) return { acao: "nada", motivo: "teto" };
    return {
      acao: "lembrar",
      numero: enviados + 1,
      para: p.responsavel_user_id,
      whatsapp,
      ultimo: enviados + 1 >= teto,
    };
  }

  // URGENTE: E lembretes, uma escalada, mais um lembrete. Nunca mais que isso.
  const antesDeEscalar = Math.min(config.escalar_urgente_apos_lembretes, TETO_ABSOLUTO_DE_LEMBRETES - 1);
  if (enviados < antesDeEscalar) {
    return { acao: "lembrar", numero: enviados + 1, para: p.responsavel_user_id, whatsapp, ultimo: false };
  }
  if (p.escalada_em === null) {
    const atual = p.responsavel_user_id;
    const reserva = atual ? config.backup[atual] ?? null : null;
    return {
      acao: "escalar",
      de: atual,
      para: reserva && reserva !== atual ? reserva : null,
      whatsapp,
    };
  }
  if (enviados < antesDeEscalar + 1) {
    return { acao: "lembrar", numero: enviados + 1, para: p.responsavel_user_id, whatsapp, ultimo: true };
  }
  return { acao: "nada", motivo: "teto" };
}

/* ───────────────────────────────────────────────────────────────────────────
 * A APLICAÇÃO — o passo do cron, com o mundo injetado.
 * ────────────────────────────────────────────────────────────────────────── */

/** A linha inteira que o cron leu, com o que a reivindicação compara. */
export interface PassagemLida extends PassagemParaEscalonar {
  id: string;
  organization_id: string;
  conversation_id: string;
  contact_id: string;
}

/** Uma por conversa — a mais recente. Duas passagens vivas da mesma conversa são UM cliente esperando. */
export function umaPorConversa(linhas: readonly PassagemLida[]): PassagemLida[] {
  const porConversa = new Map<string, PassagemLida>();
  for (const l of linhas) {
    const atual = porConversa.get(l.conversation_id);
    if (!atual || Date.parse(l.criado_em) > Date.parse(atual.criado_em)) porConversa.set(l.conversation_id, l);
  }
  return [...porConversa.values()];
}

export interface EfeitosDoEscalonamento {
  /**
   * COMPARE-AND-SET: grava o novo estado SÓ se a linha ainda é a que foi lida
   * (`lembretes_enviados`, `ultimo_lembrete_em`, `escalada_em` iguais e estado
   * em aberto). `false` = outra rodada (ou um aceite) chegou primeiro, e quem
   * perdeu não manda NADA. É o que torna duas rodadas simultâneas inofensivas.
   */
  reivindicar(
    lida: PassagemLida,
    novo: {
      lembretes_enviados: number;
      ultimo_lembrete_em: string;
      escalada_em?: string;
      escalada_para?: string | null;
      responsavel_user_id?: string | null;
    },
  ): Promise<boolean>;
  /** Aviso na Central para `para` (nulo = a equipe). O push sai pelo barramento do aviso. */
  avisarNaCentral(entrada: {
    lida: PassagemLida;
    para: string | null;
    tipo: "lembrete" | "escalada";
    numero: number;
    ultimo: boolean;
  }): Promise<void>;
  /** O WhatsApp do responsável, pelo transporte do aviso de passagem. Devolve o motivo. */
  enviarWhatsapp(entrada: { lida: PassagemLida; para: string }): Promise<string>;
  auditar(entrada: {
    action: "handoff.reminder_sent" | "handoff.escalated";
    lida: PassagemLida;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

export type ResultadoDoPasso =
  | { feito: "nada"; motivo: string }
  | { feito: "perdeu_a_corrida" }
  | { feito: "lembrete"; numero: number; whatsapp: string }
  | { feito: "escalada"; para: string | null; whatsapp: string };

/**
 * UM passo do escalonamento sobre UMA passagem: decide, reivindica, e só então
 * fala com alguém. A ordem é a garantia — reivindicar ANTES de avisar faz uma
 * falha de transporte perder um lembrete (há outro, ou o teto), e nunca faz
 * duas rodadas mandarem o mesmo lembrete duas vezes.
 */
export async function aplicarEscalonamento(
  efeitos: EfeitosDoEscalonamento,
  entrada: { lida: PassagemLida; config: EscalonamentoDaPassagem; agora: Date; fuso: string | null },
): Promise<ResultadoDoPasso> {
  const { lida, config, agora, fuso } = entrada;
  const decisao = decidirEscalonamento({ passagem: lida, config, agora, fuso });
  if (decisao.acao === "nada") return { feito: "nada", motivo: decisao.motivo };
  const quando = agora.toISOString();

  if (decisao.acao === "lembrar") {
    const ganhou = await efeitos.reivindicar(lida, {
      lembretes_enviados: decisao.numero,
      ultimo_lembrete_em: quando,
    });
    if (!ganhou) return { feito: "perdeu_a_corrida" };
    await efeitos.avisarNaCentral({
      lida,
      para: decisao.para,
      tipo: "lembrete",
      numero: decisao.numero,
      ultimo: decisao.ultimo,
    });
    const whatsapp =
      decisao.para === null
        ? "sem_responsavel"
        : decisao.whatsapp
          ? await efeitos.enviarWhatsapp({ lida, para: decisao.para })
          : "horario_de_silencio";
    await efeitos.auditar({
      action: "handoff.reminder_sent",
      lida,
      metadata: { numero: decisao.numero, urgente: lida.urgente, ultimo: decisao.ultimo, whatsapp },
    });
    return { feito: "lembrete", numero: decisao.numero, whatsapp };
  }

  // ESCALAR. Sem reserva: registra a escalada como pulada e não avisa ninguém
  // agora — o último lembrete (um intervalo depois) vai ao responsável de sempre.
  const ganhou = await efeitos.reivindicar(lida, {
    lembretes_enviados: lida.lembretes_enviados,
    ultimo_lembrete_em: lida.ultimo_lembrete_em ?? quando,
    escalada_em: quando,
    escalada_para: decisao.para,
    ...(decisao.para ? { responsavel_user_id: decisao.para } : {}),
  });
  if (!ganhou) return { feito: "perdeu_a_corrida" };
  let whatsapp = "sem_reserva";
  if (decisao.para) {
    await efeitos.avisarNaCentral({
      lida: { ...lida, responsavel_user_id: decisao.para },
      para: decisao.para,
      tipo: "escalada",
      numero: lida.lembretes_enviados,
      ultimo: false,
    });
    whatsapp = decisao.whatsapp
      ? await efeitos.enviarWhatsapp({ lida, para: decisao.para })
      : "horario_de_silencio";
  }
  await efeitos.auditar({
    action: "handoff.escalated",
    lida,
    metadata: {
      de: decisao.de,
      para: decisao.para,
      sem_reserva: decisao.para === null,
      whatsapp,
    },
  });
  return { feito: "escalada", para: decisao.para, whatsapp };
}

/* ───────────────────────────────────────────────────────────────────────────
 * A TELA — quando o botão Aceitar aparece.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * A passagem que ESTA pessoa pode aceitar agora, ou `null`.
 *
 * A mesma régua de `fn_passagem_aceitar` (o servidor confere de novo): a
 * passagem viva mais recente, e quem olha é o responsável, ou `admin`, ou
 * ninguém responde por ela ainda. A tela não oferece o que a rota recusa — um
 * botão que devolve 403 é pior que um botão que não existe.
 */
export function passagemParaAceitar<
  P extends { id: string; estado?: string | null; responsavel_user_id?: string | null; criado_em: string },
>(passagens: readonly P[], quem: { userId: string; ehAdmin: boolean }): P | null {
  const vivas = passagens
    .filter((p) => passagemEmAberto(p.estado ?? null))
    .sort((a, b) => Date.parse(b.criado_em) - Date.parse(a.criado_em));
  const viva = vivas[0];
  if (!viva) return null;
  const responsavel = viva.responsavel_user_id ?? null;
  if (quem.ehAdmin || responsavel === null || responsavel === quem.userId) return viva;
  return null;
}
