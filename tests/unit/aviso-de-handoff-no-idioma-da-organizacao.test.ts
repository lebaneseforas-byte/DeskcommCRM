/**
 * O AVISO DE PASSAGEM NO WHATSAPP SAI NO IDIOMA DA ORGANIZAÇÃO.
 *
 * Medido numa instalação real com `organizations.locale = 'en'`: o dono
 * recebia "Um atendimento precisa de uma pessoa da equipe." em português.
 * `textoDoAvisoHandoff` passou a receber o idioma e a montar a frase por
 * `traduzir`, pedaço a pedaço — o link fica fora da tradução. O texto em
 * português é byte a byte o de antes (o aviso já distribuído não muda), e
 * idioma desconhecido cai em português.
 *
 * A regra de privacidade é a mesma nos quatro: nenhuma frase carrega dado do
 * cliente — só o link da conversa.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { textoDoAvisoHandoff } from "@/lib/escalacao/aviso-de-handoff";
import { IDIOMAS } from "@/lib/i18n/idiomas";

/**
 * O inglês ainda está `em_construcao` na `main` (`lib/i18n/registro.ts`): o
 * catálogo não é carregado e `normalizarIdioma('en')` cai em português. A
 * instalação que já grava `locale = 'en'` roda com o inglês promovido. Os dois
 * lados são medidos: as frases EXATAS estão no catálogo (é o que a promoção
 * entrega), e o texto montado sai em inglês quando o idioma é servido — ou em
 * português, nunca em pedaços misturados, quando não é.
 */
const INGLES_SERVIDO = (IDIOMAS as readonly string[]).includes("en");
const CATALOGO_EN = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "lib", "i18n", "traducoes", "en.json"), "utf8"),
) as Record<string, string>;

const URL_PUBLICA = "https://crm.exemplo.test";
const CONV = "55555555-5555-4555-8555-555555555555";
const LINK = `https://crm.exemplo.test/app/inbox?id=${CONV}`;

describe("textoDoAvisoHandoff × idioma", () => {
  it("pt-BR (e sem idioma) é o texto de sempre, byte a byte", () => {
    const esperado = `Um atendimento precisa de uma pessoa da equipe.\n\nAbrir conversa: ${LINK}\n\nResponda pelo CRM; responder a este aviso não chega ao cliente.`;
    expect(textoDoAvisoHandoff(URL_PUBLICA, CONV)).toBe(esperado);
    expect(textoDoAvisoHandoff(URL_PUBLICA, CONV, "pt-BR")).toBe(esperado);
  });

  it("en: o catálogo traz as frases exatas do aviso", () => {
    expect(CATALOGO_EN["Um atendimento precisa de uma pessoa da equipe."]).toBe(
      "A conversation needs someone from the team.",
    );
    expect(CATALOGO_EN["Abrir conversa:"]).toBe("Open conversation:");
    expect(CATALOGO_EN["Responda pelo CRM; responder a este aviso não chega ao cliente."]).toBe(
      "Reply in the CRM; replying to this alert does not reach the customer.",
    );
    expect(CATALOGO_EN["URGENTE:"]).toBe("URGENT:");
  });

  it("en: o aviso sai em inglês quando o idioma é servido (senão, inteiro em português)", () => {
    const ingles = `A conversation needs someone from the team.

Open conversation: ${LINK}

Reply in the CRM; replying to this alert does not reach the customer.`;
    const esperado = INGLES_SERVIDO ? ingles : textoDoAvisoHandoff(URL_PUBLICA, CONV, "pt-BR");
    expect(textoDoAvisoHandoff(URL_PUBLICA, CONV, "en")).toBe(esperado);
    const urgente = textoDoAvisoHandoff(URL_PUBLICA, CONV, "en", { urgente: true });
    expect(urgente).toBe(INGLES_SERVIDO ? `URGENT: ${ingles}` : `URGENTE: ${esperado}`);
  });

  it("es", () => {
    const texto = textoDoAvisoHandoff(URL_PUBLICA, CONV, "es");
    expect(texto).toBe(
      `Una conversación necesita a una persona del equipo.\n\nAbrir conversación: ${LINK}\n\nResponde por el CRM; responder a este aviso no llega al cliente.`,
    );
  });

  it("pt-BR urgente: URGENTE: na frente, o resto igual", () => {
    expect(textoDoAvisoHandoff(URL_PUBLICA, CONV, "pt-BR", { urgente: true })).toMatch(
      /^URGENTE: Um atendimento precisa de uma pessoa da equipe\./,
    );
  });

  it("idioma desconhecido, vazio ou nulo cai em português", () => {
    const pt = textoDoAvisoHandoff(URL_PUBLICA, CONV, "pt-BR");
    for (const locale of ["fr", "", null, "EN-us", "xx-YY"]) {
      expect(textoDoAvisoHandoff(URL_PUBLICA, CONV, locale), String(locale)).toBe(pt);
    }
  });

  it("as guardas de endereço continuam valendo em qualquer idioma", () => {
    expect(textoDoAvisoHandoff("http://crm.exemplo.test", CONV, "en")).toBeNull();
    expect(textoDoAvisoHandoff(URL_PUBLICA, "nao-e-uuid", "en")).toBeNull();
  });
});
