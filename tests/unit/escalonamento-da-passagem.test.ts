/**
 * A PASSAGEM NUNCA SE PERDE — a regra pura do escalonamento (migration 9401).
 *
 * O que este arquivo mede, e por que cada parte existe:
 *
 *   · a LINHA DO TEMPO urgente 0/15/30/45/60 — dois lembretes, uma escalada,
 *     um último lembrete, e silêncio depois;
 *   · a escalada acontece UMA vez: depois dela a regra nunca mais escala, nem
 *     de volta (o "pingue-pongue" entre dois atendentes é o laço que os tetos
 *     existem para impedir);
 *   · os TETOS: normal para em `max_lembretes`, e o teto absoluto vale mesmo
 *     com jsonb torto;
 *   · o SILÊNCIO no fuso da organização — Asia/Beirut, que muda de UTC+2 para
 *     UTC+3 no horário de verão: a mesma hora UTC cai dentro e fora da janela
 *     conforme a estação;
 *   · sem RESERVA a escalada é registrada como pulada, e o último lembrete vai
 *     a quem já era responsável;
 *   · DUAS RODADAS simultâneas com o mesmo retrato da linha mandam UM lembrete:
 *     a segunda perde o compare-and-set e não fala com ninguém.
 */
import { describe, expect, it } from "vitest";

import {
  aplicarEscalonamento,
  decidirEscalonamento,
  emSilencio,
  ESCALONAMENTO_PADRAO,
  escalonamentoWriteSchema,
  lerEscalonamento,
  passagemParaAceitar,
  TETO_ABSOLUTO_DE_LEMBRETES,
  umaPorConversa,
  type EfeitosDoEscalonamento,
  type EscalonamentoDaPassagem,
  type PassagemLida,
} from "@/lib/escalacao/escalonamento-da-passagem";

const ANA = "11111111-1111-4111-8111-111111111111";
const BIA = "22222222-2222-4222-8222-222222222222";
const CAIO = "33333333-3333-4333-8333-333333333333";
const ORG = "44444444-4444-4444-8444-444444444444";
const CONV = "55555555-5555-4555-8555-555555555555";

/** Meio-dia em Beirute (UTC+2 no inverno): fora do silêncio 22→8. */
const T0 = Date.parse("2026-01-15T10:00:00Z");
const min = (m: number) => new Date(T0 + m * 60_000);
const FUSO = "Asia/Beirut";

function config(parcial: Partial<EscalonamentoDaPassagem> = {}): EscalonamentoDaPassagem {
  return { ...ESCALONAMENTO_PADRAO, backup: { [ANA]: BIA }, ...parcial };
}

function linha(parcial: Partial<PassagemLida> = {}): PassagemLida {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    organization_id: ORG,
    conversation_id: CONV,
    contact_id: "77777777-7777-4777-8777-777777777777",
    estado: "atribuida",
    urgente: true,
    responsavel_user_id: ANA,
    lembretes_enviados: 0,
    ultimo_lembrete_em: null,
    escalada_em: null,
    criado_em: min(0).toISOString(),
    ...parcial,
  };
}

/**
 * O mundo dublado: a linha mora num objeto e `reivindicar` é um CAS de
 * verdade sobre ele — compara os três campos lidos e o estado em aberto.
 */
function mundo(inicial: PassagemLida) {
  const banco: PassagemLida & { escalada_para?: string | null } = { ...inicial };
  const avisos: Array<{ para: string | null; tipo: string; numero: number }> = [];
  const whatsapps: string[] = [];
  const auditorias: string[] = [];
  const efeitos: EfeitosDoEscalonamento = {
    async reivindicar(lida, novo) {
      // Uma volta ao laço de eventos entre ler e gravar: é onde a corrida mora.
      await Promise.resolve();
      if (
        banco.lembretes_enviados !== lida.lembretes_enviados ||
        banco.ultimo_lembrete_em !== lida.ultimo_lembrete_em ||
        banco.escalada_em !== lida.escalada_em ||
        !["pendente", "atribuida", "reaberta"].includes(banco.estado)
      ) {
        return false;
      }
      Object.assign(banco, novo);
      return true;
    },
    async avisarNaCentral({ para, tipo, numero }) {
      avisos.push({ para, tipo, numero });
    },
    async enviarWhatsapp({ para }) {
      whatsapps.push(para);
      return "enviado";
    },
    async auditar({ action }) {
      auditorias.push(action);
    },
  };
  /** Uma rodada do cron: lê a linha COMO ESTÁ e aplica. */
  const rodada = (agora: Date, cfg = config()) =>
    aplicarEscalonamento(efeitos, { lida: { ...banco }, config: cfg, agora, fuso: FUSO });
  return { banco, avisos, whatsapps, auditorias, efeitos, rodada };
}

describe("a linha do tempo URGENTE", () => {
  it("0/15/30/45/60: nada, lembrete, lembrete, escalada ao reserva, último lembrete — e para", async () => {
    const m = mundo(linha());
    expect(await m.rodada(min(0))).toEqual({ feito: "nada", motivo: "cedo" });
    expect(await m.rodada(min(10))).toEqual({ feito: "nada", motivo: "cedo" });
    expect(await m.rodada(min(15))).toMatchObject({ feito: "lembrete", numero: 1 });
    expect(await m.rodada(min(20))).toEqual({ feito: "nada", motivo: "cedo" });
    expect(await m.rodada(min(30))).toMatchObject({ feito: "lembrete", numero: 2 });
    expect(await m.rodada(min(45))).toMatchObject({ feito: "escalada", para: BIA });
    expect(m.banco.responsavel_user_id, "a escalada troca o responsável").toBe(BIA);
    expect(await m.rodada(min(50))).toEqual({ feito: "nada", motivo: "cedo" });
    expect(await m.rodada(min(60))).toMatchObject({ feito: "lembrete", numero: 3 });
    for (const t of [75, 90, 180, 24 * 60]) {
      expect(await m.rodada(min(t)), `minuto ${t}`).toEqual({ feito: "nada", motivo: "teto" });
    }
    expect(m.avisos.map((a) => [a.tipo, a.para])).toEqual([
      ["lembrete", ANA],
      ["lembrete", ANA],
      ["escalada", BIA],
      ["lembrete", BIA],
    ]);
    expect(m.auditorias).toEqual([
      "handoff.reminder_sent",
      "handoff.reminder_sent",
      "handoff.escalated",
      "handoff.reminder_sent",
    ]);
  });

  it("escala UMA vez: com reserva recíproco (A→B, B→A) não volta para A", async () => {
    const m = mundo(linha());
    const cfg = config({ backup: { [ANA]: BIA, [BIA]: ANA } });
    for (const t of [15, 30, 45, 60, 75, 90, 120]) await m.rodada(min(t), cfg);
    expect(m.avisos.filter((a) => a.tipo === "escalada")).toHaveLength(1);
    expect(m.banco.responsavel_user_id).toBe(BIA);
    expect(m.banco.escalada_para).toBe(BIA);
  });

  it("sem reserva: a escalada é REGISTRADA como pulada, sem aviso, e o último lembrete vai ao responsável", async () => {
    const m = mundo(linha());
    const cfg = config({ backup: {} });
    await m.rodada(min(15), cfg);
    await m.rodada(min(30), cfg);
    expect(await m.rodada(min(45), cfg)).toEqual({ feito: "escalada", para: null, whatsapp: "sem_reserva" });
    expect(m.banco.escalada_em, "a escalada pulada fica registrada").not.toBeNull();
    expect(m.banco.escalada_para).toBeNull();
    expect(m.banco.responsavel_user_id).toBe(ANA);
    expect(m.avisos.filter((a) => a.tipo === "escalada"), "ninguém para avisar").toHaveLength(0);
    expect(await m.rodada(min(60), cfg)).toMatchObject({ feito: "lembrete", numero: 3 });
    expect(m.avisos.at(-1)?.para).toBe(ANA);
    expect(await m.rodada(min(90), cfg)).toEqual({ feito: "nada", motivo: "teto" });
  });

  it("urgente sem responsável: lembra a equipe (aviso sem dono) e a escalada é pulada", async () => {
    const m = mundo(linha({ estado: "pendente", responsavel_user_id: null }));
    expect(await m.rodada(min(15))).toMatchObject({ feito: "lembrete", whatsapp: "sem_responsavel" });
    expect(m.avisos[0]?.para).toBeNull();
    expect(m.whatsapps, "sem responsável não há WhatsApp de ninguém").toHaveLength(0);
    await m.rodada(min(30));
    expect(await m.rodada(min(45))).toMatchObject({ feito: "escalada", para: null });
  });
});

describe("a passagem NORMAL", () => {
  it("lembra a cada 60 min, até max_lembretes, e nunca troca de responsável", async () => {
    const m = mundo(linha({ urgente: false }));
    expect(await m.rodada(min(59))).toEqual({ feito: "nada", motivo: "cedo" });
    expect(await m.rodada(min(60))).toMatchObject({ feito: "lembrete", numero: 1 });
    expect(await m.rodada(min(120))).toMatchObject({ feito: "lembrete", numero: 2 });
    const terceiro = decidirEscalonamento({ passagem: { ...m.banco }, config: config(), agora: min(180), fuso: FUSO });
    expect(terceiro).toMatchObject({ acao: "lembrar", numero: 3, ultimo: true });
    await m.rodada(min(180));
    expect(await m.rodada(min(240))).toEqual({ feito: "nada", motivo: "teto" });
    expect(m.banco.escalada_em).toBeNull();
    expect(m.banco.responsavel_user_id).toBe(ANA);
  });

  it("o teto absoluto vale mesmo com contador absurdo no banco", () => {
    const d = decidirEscalonamento({
      passagem: linha({ urgente: false, lembretes_enviados: TETO_ABSOLUTO_DE_LEMBRETES }),
      config: config({ max_lembretes: 10 }),
      agora: min(10_000),
      fuso: FUSO,
    });
    expect(d).toEqual({ acao: "nada", motivo: "teto" });
  });

  it("passagem aceita, resolvida ou com o escalonamento desligado não recebe nada", () => {
    for (const estado of ["aceita", "resolvida"]) {
      expect(decidirEscalonamento({ passagem: linha({ estado }), config: config(), agora: min(500), fuso: FUSO })).toEqual({
        acao: "nada",
        motivo: "fechada",
      });
    }
    expect(
      decidirEscalonamento({ passagem: linha(), config: config({ ligado: false }), agora: min(500), fuso: FUSO }),
    ).toEqual({ acao: "nada", motivo: "desligado" });
  });

  it("`reaberta` é passagem viva: o cliente voltou e é cobrado como qualquer outra", () => {
    expect(
      decidirEscalonamento({ passagem: linha({ estado: "reaberta" }), config: config(), agora: min(15), fuso: FUSO }),
    ).toMatchObject({ acao: "lembrar", numero: 1 });
  });
});

describe("o SILÊNCIO no fuso da organização (Asia/Beirut, com horário de verão)", () => {
  const janela = { inicio: 22, fim: 8 };
  it("inverno (UTC+2): 20:30Z é 22:30 local → silêncio; 19:30Z é 21:30 → não", () => {
    expect(emSilencio(new Date("2026-01-15T20:30:00Z"), FUSO, janela)).toBe(true);
    expect(emSilencio(new Date("2026-01-15T19:30:00Z"), FUSO, janela)).toBe(false);
  });
  it("verão (UTC+3): a MESMA 19:30Z já é 22:30 local → silêncio; 18:30Z é 21:30 → não", () => {
    expect(emSilencio(new Date("2026-07-15T19:30:00Z"), FUSO, janela)).toBe(true);
    expect(emSilencio(new Date("2026-07-15T18:30:00Z"), FUSO, janela)).toBe(false);
  });
  it("a borda da manhã: 07:30 local é silêncio, 08:00 não (janela meio-aberta)", () => {
    expect(emSilencio(new Date("2026-07-15T04:30:00Z"), FUSO, janela)).toBe(true);
    expect(emSilencio(new Date("2026-07-15T05:00:00Z"), FUSO, janela)).toBe(false);
    expect(emSilencio(new Date("2026-01-15T06:00:00Z"), FUSO, janela)).toBe(false);
  });
  it("na virada do horário de verão (29/03/2026) a hora local segue a regra nova", () => {
    // 29/03 23:30Z: já em UTC+3 → 02:30 local do dia 30 → silêncio.
    expect(emSilencio(new Date("2026-03-29T23:30:00Z"), FUSO, janela)).toBe(true);
    // 29/03 05:30Z: UTC+3 → 08:30 local → fora; em UTC+2 seria 07:30 (dentro).
    expect(emSilencio(new Date("2026-03-29T05:30:00Z"), FUSO, janela)).toBe(false);
  });
  it("`inicio === fim` é sem silêncio; fuso inválido não lança", () => {
    expect(emSilencio(new Date("2026-01-15T23:00:00Z"), FUSO, { inicio: 8, fim: 8 })).toBe(false);
    expect(() => emSilencio(new Date(), "Lugar/Nenhum", janela)).not.toThrow();
  });
  it("no silêncio o lembrete SAI (Central e push), só o WhatsApp não", async () => {
    // 22:30 local em Beirute no inverno; passagem nasceu 15 min antes.
    const agora = new Date("2026-01-15T20:30:00Z");
    const m = mundo(linha({ criado_em: new Date(agora.getTime() - 15 * 60_000).toISOString() }));
    const r = await m.rodada(agora);
    expect(r).toMatchObject({ feito: "lembrete", numero: 1, whatsapp: "horario_de_silencio" });
    expect(m.avisos).toHaveLength(1);
    expect(m.whatsapps).toHaveLength(0);
  });
});

describe("duas rodadas ao mesmo tempo", () => {
  it("com o MESMO retrato da linha, só uma manda — a outra perde o compare-and-set", async () => {
    const m = mundo(linha());
    const retrato = { ...m.banco };
    const [a, b] = await Promise.all([
      aplicarEscalonamento(m.efeitos, { lida: retrato, config: config(), agora: min(15), fuso: FUSO }),
      aplicarEscalonamento(m.efeitos, { lida: { ...retrato }, config: config(), agora: min(15), fuso: FUSO }),
    ]);
    expect([a.feito, b.feito].sort()).toEqual(["lembrete", "perdeu_a_corrida"]);
    expect(m.avisos).toHaveLength(1);
    expect(m.whatsapps).toHaveLength(1);
    expect(m.auditorias).toHaveLength(1);
    expect(m.banco.lembretes_enviados).toBe(1);
  });

  it("escalada concorrente também acontece uma vez só", async () => {
    const m = mundo(linha({ lembretes_enviados: 2, ultimo_lembrete_em: min(30).toISOString() }));
    const retrato = { ...m.banco };
    const rs = await Promise.all(
      [1, 2, 3].map(() => aplicarEscalonamento(m.efeitos, { lida: { ...retrato }, config: config(), agora: min(45), fuso: FUSO })),
    );
    expect(rs.filter((r) => r.feito === "escalada")).toHaveLength(1);
    expect(m.avisos.filter((a) => a.tipo === "escalada")).toHaveLength(1);
  });

  it("um aceite entre a leitura e a gravação cala o lembrete", async () => {
    const m = mundo(linha());
    const retrato = { ...m.banco };
    m.banco.estado = "aceita";
    expect(await aplicarEscalonamento(m.efeitos, { lida: retrato, config: config(), agora: min(15), fuso: FUSO })).toEqual({
      feito: "perdeu_a_corrida",
    });
    expect(m.avisos).toHaveLength(0);
  });
});

describe("a configuração", () => {
  it("ausente é LIGADO com os padrões", () => {
    expect(lerEscalonamento({})).toEqual(ESCALONAMENTO_PADRAO);
    expect(lerEscalonamento(null)).toEqual(ESCALONAMENTO_PADRAO);
  });

  it("um campo torto cai no padrão sozinho, sem desligar o resto", () => {
    const lido = lerEscalonamento({
      escalonamento_de_passagem: {
        urgente_minutos: "15",
        normal_minutos: 2,
        max_lembretes: 99,
        silencio: { inicio: 23, fim: "x" },
        backup: { [ANA]: BIA, [CAIO]: CAIO, "nao-e-uuid": BIA },
        normal: true,
      },
    });
    expect(lido.ligado).toBe(true);
    expect(lido.urgente_minutos).toBe(15);
    expect(lido.normal_minutos).toBe(60);
    expect(lido.max_lembretes).toBe(3);
    expect(lido.silencio).toEqual({ inicio: 23, fim: 8 });
    expect(lido.backup, "reserva de si mesmo e id torto saem").toEqual({ [ANA]: BIA });
  });

  it("a rota por etiqueta é lida NORMALIZADA (trim + minúsculas) e sem id torto", () => {
    const lido = lerEscalonamento({
      escalonamento_de_passagem: {
        rota_por_etiqueta: { " Projeto ": ANA, LOJA: BIA, vip: "fulano", "": CAIO },
      },
    });
    expect(lido.rota_por_etiqueta).toEqual({ projeto: ANA, loja: BIA });
  });

  it("a escrita normaliza a etiqueta e recusa reserva de si mesmo, campo extra e etiqueta vazia", () => {
    const base = { ...ESCALONAMENTO_PADRAO, backup: { [ANA]: BIA }, rota_por_etiqueta: { " Projeto": ANA } };
    const ok = escalonamentoWriteSchema.safeParse(base);
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.rota_por_etiqueta).toEqual({ projeto: ANA });
    expect(escalonamentoWriteSchema.safeParse({ ...base, backup: { [ANA]: ANA } }).success).toBe(false);
    expect(escalonamentoWriteSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(escalonamentoWriteSchema.safeParse({ ...base, rota_por_etiqueta: { "   ": ANA } }).success).toBe(false);
    expect(escalonamentoWriteSchema.safeParse({ ...base, urgente_minutos: 1 }).success).toBe(false);
  });
});

describe("a tela e o cron", () => {
  const p = (parcial: { id: string; estado: string; responsavel_user_id: string | null; criado_em: string }) => parcial;
  it("o botão Aceitar só aparece para o responsável, para admin ou quando ninguém responde", () => {
    const viva = p({ id: "a", estado: "atribuida", responsavel_user_id: ANA, criado_em: min(0).toISOString() });
    expect(passagemParaAceitar([viva], { userId: ANA, ehAdmin: false })?.id).toBe("a");
    expect(passagemParaAceitar([viva], { userId: BIA, ehAdmin: false })).toBeNull();
    expect(passagemParaAceitar([viva], { userId: BIA, ehAdmin: true })?.id).toBe("a");
    const semDono = { ...viva, estado: "pendente", responsavel_user_id: null };
    expect(passagemParaAceitar([semDono], { userId: BIA, ehAdmin: false })?.id).toBe("a");
    expect(passagemParaAceitar([{ ...viva, estado: "aceita" }], { userId: ANA, ehAdmin: true })).toBeNull();
  });

  it("o cron olha UMA passagem por conversa — a mais recente", () => {
    const velha = linha({ id: "velha", criado_em: min(0).toISOString() });
    const nova = linha({ id: "nova", criado_em: min(5).toISOString() });
    const outra = linha({ id: "outra", conversation_id: "88888888-8888-4888-8888-888888888888" });
    expect(umaPorConversa([velha, nova, outra]).map((l) => l.id).sort()).toEqual(["nova", "outra"]);
  });
});
