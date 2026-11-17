/**
 * FOLLOW-UPS E RESPOSTAS PRONTAS — para quem gerencia a empresa montar, por um
 * aplicativo conectado (o ChatGPT, por exemplo), as sequências automáticas de
 * retomada e as respostas prontas compartilhadas da equipe.
 *
 * `apenasHumano`: um assistente que atende o cliente não desenha nem liga as
 * próprias sequências de mensagem. Publicar é `critico` porque, publicado, o
 * fluxo passa a mandar mensagem a cliente sozinho. Apagar fica na tela. As
 * regras são as do editor de follow-ups e da tela de respostas prontas.
 */
import { declararTools } from "./tipos";

export const TOOLS_SEQUENCIAS = declararTools([
  {
    name: "crm_list_followup_flows",
    category: "read",
    rotulo: "Ver as sequências de follow-up",
    explicacao:
      "Lista as sequências automáticas de retomada da empresa, com a situação de cada uma: rascunho, ligada ou desligada.",
    oQueToca: "Follow-ups",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_get_followup_flow",
    category: "read",
    rotulo: "Abrir uma sequência de follow-up",
    explicacao: "Mostra o que dispara a sequência e cada passo dela, como o editor desenha.",
    oQueToca: "Follow-ups",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_create_followup_flow",
    category: "write",
    rotulo: "Criar uma sequência de follow-up",
    explicacao:
      "Cria uma sequência vazia, em rascunho. Nada é enviado até ela ser montada e publicada.",
    oQueToca: "Follow-ups",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_save_followup_flow_draft",
    category: "write",
    rotulo: "Salvar o rascunho de uma sequência",
    explicacao:
      "Muda o nome, os passos, o que dispara a sequência e o que acontece quando uma pessoa assume a conversa. Fica em rascunho: os clientes não sentem nada até publicar.",
    oQueToca: "Follow-ups",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_publish_followup_flow",
    category: "write",
    rotulo: "Publicar uma sequência de follow-up",
    explicacao:
      "Coloca o rascunho no ar. A partir daí a sequência manda mensagens aos clientes sozinha, sempre que o gatilho acontecer.",
    oQueToca: "Follow-ups",
    risco: "critico",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_disable_followup_flow",
    category: "write",
    rotulo: "Desligar uma sequência de follow-up",
    explicacao:
      "Para a sequência para clientes novos. Nada é apagado, e ela pode ser publicada de novo.",
    oQueToca: "Follow-ups",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_create_message_template",
    category: "write",
    rotulo: "Criar uma resposta pronta da equipe",
    explicacao:
      "Cria uma resposta pronta compartilhada, com título, texto e atalho. Imagens e áudios são colocados pela tela.",
    oQueToca: "Respostas prontas",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_update_message_template",
    category: "write",
    rotulo: "Alterar uma resposta pronta da equipe",
    explicacao:
      "Muda título, texto, atalho ou grupo de uma resposta pronta compartilhada. As respostas pessoais de cada atendente não mudam.",
    oQueToca: "Respostas prontas",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
]);
