/**
 * O AVISO DE PASSAGEM EM INGLÊS, E A FRASE DA EMPRESA MESMO SEM STICKINESS.
 *
 * Medido em 16/11/2026 numa organização em inglês, com a frase própria
 * (`ai_agents.config.aviso_de_handoff`) configurada nos três agentes: a cliente
 * escreveu que ia dar uma estrela no Google, o worker de sentimento passou a
 * conversa adiante, e ela recebeu "Vou pedir ajuda de alguém da equipe para
 * cuidar disso com você. Não há atendente disponível neste instante…". Dois
 * defeitos somados:
 *
 *   1. `textosDoIdioma` não tinha inglês: `en` caía no português.
 *   2. O emissor do CRM só achava o agente por `conversations.active_ai_agent_id`,
 *      que a passagem anterior zera — sem agente, sem a frase da empresa.
 *
 * O envio é dublado; o que se mede é o corpo que saiu.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const enviar = vi.hoisted(() => vi.fn());

vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: (...args: unknown[]) => enviar(...args),
}));
vi.mock("@/lib/escalacao/atendentes", () => ({
  carregarRosterDeAtendimento: vi.fn(async () => []),
  podeAssumirAgora: vi.fn(() => false),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { textoDoAviso, type MotivoDoAviso } from "@/lib/escalacao/aviso-ao-lead";
import type { QuemPodeAssumir } from "@/lib/escalacao/disponibilidade";
import { normalizeCopy } from "@/lib/agent-engine/spinning/engine";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { avisarLeadDoCrm } from "@/lib/ai/handoff/aviso-ao-lead";

const MOTIVOS: MotivoDoAviso[] = ["pediu_humano", "suspeita_de_opt_out", "orcamento_de_ia", "outro"];
const ESTADOS: Array<{ rotulo: string; quem: QuemPodeAssumir | null }> = [
  { rotulo: "leitura falhou", quem: null },
  { rotulo: "instalação fresca", quem: { disponiveis: 0, total: 0 } },
  { rotulo: "fora de expediente", quem: { disponiveis: 0, total: 3 } },
  { rotulo: "com gente livre", quem: { disponiveis: 2, total: 3 } },
];
const CASOS = MOTIVOS.flatMap((motivo) => ESTADOS.map((estado) => ({ motivo, ...estado })));
const PALAVRAS_EM_PORTUGUES = /\b(você|seu|sua|equipe|atendente|não|já|ninguém|aguarde|pedido|conversa)\b/i;
const PALAVRAS_EM_INGLES = /\b(team|you|your|request|someone|staff|messages|moment|chat|conversation)\b/i;

describe("o aviso sai em inglês para organização em inglês", () => {
  it.each(CASOS)("$motivo / $rotulo: inglês de verdade, e não o português", ({ motivo, quem }) => {
    const en = textoDoAviso(motivo, quem, "lead-1", "en");
    expect(en).not.toBe(textoDoAviso(motivo, quem, "lead-1", "pt-BR"));
    expect(en).toMatch(PALAVRAS_EM_INGLES);
    expect(en).not.toMatch(PALAVRAS_EM_PORTUGUES);
    expect(en).not.toContain("—");
  });

  it.each(CASOS)("$motivo / $rotulo: `en-US` cai no mesmo inglês que `en`", ({ motivo, quem }) => {
    expect(textoDoAviso(motivo, quem, "lead-1", "en-US")).toBe(textoDoAviso(motivo, quem, "lead-1", "en"));
  });

  it.each(CASOS)("$motivo / $rotulo: ao menos 3 redações entre 50 leads", ({ motivo, quem }) => {
    const textos = new Set(Array.from({ length: 50 }, (_, i) => textoDoAviso(motivo, quem, `lead-${i}`, "en")));
    expect(textos.size).toBeGreaterThanOrEqual(3);
  });

  it("não cabe na isenção do spinning, como os outros idiomas (o desarme segue necessário)", () => {
    for (const motivo of MOTIVOS) {
      const t = normalizeCopy(textoDoAviso(motivo, null, "lead-1", "en"));
      expect(t.length, motivo).toBeGreaterThan(SPINNING_DEFAULTS.allowlistMaxLength);
    }
  });

  it("o estado da equipe muda o fecho em inglês", () => {
    const fechos = new Set(ESTADOS.slice(1).map(({ quem }) => textoDoAviso("outro", quem, "lead-1", "en")));
    expect(fechos.size).toBe(3);
  });

  it("quem pediu para parar não recebe convite para esperar", () => {
    for (const { quem, rotulo } of ESTADOS) {
      const t = textoDoAviso("suspeita_de_opt_out", quem, "lead-1", "en");
      expect(t, rotulo).toContain("I passed your request to a person on the team to confirm it.");
      expect(t, rotulo).not.toMatch(/wait|queue/i);
    }
  });

  it("controle: idioma sem frases próprias segue em português, como antes", () => {
    expect(textoDoAviso("outro", null, "lead-1", "fr")).toBe(textoDoAviso("outro", null, "lead-1", "pt-BR"));
  });
});

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const AGENTE_DO_NUMERO = "55555555-5555-4555-8555-555555555555";
const OUTRO_AGENTE = "66666666-6666-4666-8666-666666666666";
const FRASE = "Thank you for sharing. Our team will contact you shortly to review your request.";

interface Cenario {
  activeAgent: string | null;
  versoesNaSessao: string[];
}

/** Banco dublado: a IA já falou, a conversa está no número `SESSAO`, dois agentes no ar. */
function banco(c: Cenario) {
  const agentes = [
    { id: AGENTE_DO_NUMERO, config: { aviso_de_handoff: FRASE }, paused_at: null, published_version_id: "v-numero", archived_at: null, priority: 0, created_at: "2026-11-02" },
    { id: OUTRO_AGENTE, config: {}, paused_at: null, published_version_id: "v-outro", archived_at: null, priority: 0, created_at: "2026-11-01" },
  ];
  return {
    from(tabela: string) {
      const cadeia: Record<string, unknown> = {};
      let direcao = "";
      const lista = (): { data: unknown; error: null } => {
        if (tabela === "ai_agent_versions") return { data: c.versoesNaSessao.map((id) => ({ id })), error: null };
        if (tabela === "ai_agents") return { data: agentes, error: null };
        return { data: [], error: null };
      };
      Object.assign(cadeia, {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => {
          if (coluna === "direction") direcao = String(valor);
          return cadeia;
        },
        is: async () => lista(),
        order: () => cadeia,
        then: (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => Promise.resolve(lista()).then(ok, erro),
        limit: () =>
          Object.assign(
            Promise.resolve({
              data:
                direcao === "outbound"
                  ? [{ metadata: null, created_at: new Date().toISOString(), status: "sent" }]
                  : null,
              error: null,
            }),
            { maybeSingle: async () => ({ data: null, error: null }) },
          ),
        maybeSingle: async () => {
          if (tabela === "organizations") return { data: { locale: "en" }, error: null };
          if (tabela === "conversations") {
            return { data: { active_ai_agent_id: c.activeAgent, channel_session_id: SESSAO }, error: null };
          }
          return { data: null, error: null };
        },
      });
      return cadeia;
    },
  } as never;
}

async function corpo(c: Cenario, reason = "low_sentiment"): Promise<string> {
  await avisarLeadDoCrm(banco(c), {
    organizationId: ORG,
    conversationId: CONVERSA,
    contactId: CONTATO,
    reason,
  });
  expect(enviar).toHaveBeenCalledTimes(1);
  return (enviar.mock.calls[0] as unknown as [unknown, unknown, { body: string }])[2].body;
}

describe("emissor do CRM acha o agente pela régua do motor", () => {
  beforeEach(() => {
    enviar.mockReset();
    enviar.mockResolvedValue({ status: "sent", error_code: null });
  });

  it("sem stickiness (a passagem anterior zerou), a versão publicada no número dá a frase da empresa", async () => {
    expect(await corpo({ activeAgent: null, versoesNaSessao: ["v-numero"] })).toBe(FRASE);
  });

  it("controle: com a stickiness no agente sem frase, vale ele, e o padrão sai em inglês", async () => {
    const body = await corpo({ activeAgent: OUTRO_AGENTE, versoesNaSessao: ["v-numero"] });
    expect(body).not.toBe(FRASE);
    expect(body).toMatch(PALAVRAS_EM_INGLES);
    expect(body).not.toMatch(PALAVRAS_EM_PORTUGUES);
  });

  it("dois agentes e nenhum vínculo com a conversa: o padrão do produto, em inglês, nunca a frase do vizinho", async () => {
    const body = await corpo({ activeAgent: null, versoesNaSessao: [] });
    expect(body).not.toBe(FRASE);
    expect(body).not.toMatch(PALAVRAS_EM_PORTUGUES);
  });
});
