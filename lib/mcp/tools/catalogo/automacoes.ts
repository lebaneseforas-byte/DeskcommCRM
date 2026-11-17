/**
 * REGRAS AUTOMÁTICAS — para quem gerencia a empresa criar e ajustar, por um
 * aplicativo conectado (o ChatGPT, por exemplo), o que o sistema faz sozinho.
 *
 * `apenasHumano`: o assistente que atende continua sem escrever regra (a
 * doutrina de `lib/operacao/regras-automaticas.ts`). Mesmo aqui, ação que manda
 * dado para fora da empresa fica só na tela, a regra nasce pausada e ligar é a
 * capacidade à parte `crm_set_automation_rule_active` — ver `../automacoes.ts`.
 */
import { declararTools } from "./tipos";

export const TOOLS_AUTOMACOES = declararTools([
  {
    name: "crm_get_automation_rule",
    category: "read",
    rotulo: "Abrir uma regra automática",
    explicacao:
      "Mostra uma regra inteira: o que a dispara, as condições e o que ela faz, sem as senhas guardadas nela.",
    oQueToca: "Regras automáticas",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_create_automation_rule",
    category: "write",
    rotulo: "Criar uma regra automática",
    explicacao:
      "Cria uma regra pausada. Ela só roda depois que alguém a liga. Regras que mandam dados para fora da empresa só podem ser feitas pela tela.",
    oQueToca: "Regras automáticas",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_update_automation_rule",
    category: "write",
    rotulo: "Alterar uma regra automática",
    explicacao:
      "Muda o nome a qualquer momento. O que dispara a regra, as condições e o que ela faz só mudam com a regra pausada.",
    oQueToca: "Regras automáticas",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
]);
