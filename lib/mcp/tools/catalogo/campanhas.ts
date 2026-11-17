/**
 * CAMPANHAS — para quem gerencia a empresa montar e soltar envios em massa por
 * um aplicativo conectado (o ChatGPT, por exemplo).
 *
 * `apenasHumano`: o assistente que atende não dispara campanha. Iniciar, agendar
 * e cancelar são `critico` (mandam para a lista inteira, ou descartam o que
 * faltava, sem volta). As regras — ritmo seguro, janela de envio, base legal,
 * quem pediu para sair — são as da tela de Campanhas (`lib/campanhas/`).
 */
import { declararTools } from "./tipos";

export const TOOLS_CAMPANHAS = declararTools([
  {
    name: "crm_list_campaigns",
    category: "read",
    rotulo: "Ver as campanhas",
    explicacao:
      "Lista as campanhas de envio em massa, com a situação de cada uma e quantas pessoas recebem.",
    oQueToca: "Campanhas",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_get_campaign",
    category: "read",
    rotulo: "Abrir uma campanha",
    explicacao:
      "Mostra a mensagem, o canal, o público, o ritmo de envio e as contagens de uma campanha.",
    oQueToca: "Campanhas",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_create_campaign_draft",
    category: "write",
    rotulo: "Criar o rascunho de uma campanha",
    explicacao: "Cria uma campanha em rascunho, com mensagem, canal e público. Nada é enviado.",
    oQueToca: "Campanhas",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_prepare_campaign",
    category: "write",
    rotulo: "Preparar uma campanha",
    explicacao:
      "Separa quem vai receber, já tirando quem pediu para não receber, e mostra quantas pessoas são. Nada é enviado.",
    oQueToca: "Campanhas",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_test_campaign",
    category: "write",
    rotulo: "Testar uma campanha",
    explicacao:
      "Manda a mensagem da campanha uma vez, para um contato escolhido, para conferir como ela chega.",
    oQueToca: "Campanhas",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_start_campaign",
    category: "write",
    rotulo: "Iniciar uma campanha",
    explicacao:
      "Começa (ou retoma) o envio para todas as pessoas da campanha, no ritmo seguro e dentro do horário de envio. O que já saiu não volta.",
    oQueToca: "Campanhas",
    risco: "critico",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_schedule_campaign",
    category: "write",
    rotulo: "Agendar uma campanha",
    explicacao:
      "Marca o dia e a hora em que a campanha começa sozinha a enviar para todas as pessoas dela.",
    oQueToca: "Campanhas",
    risco: "critico",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_pause_campaign",
    category: "write",
    rotulo: "Pausar uma campanha",
    explicacao: "Para o envio até alguém retomar. Nada é perdido.",
    oQueToca: "Campanhas",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_cancel_campaign",
    category: "write",
    rotulo: "Cancelar uma campanha",
    explicacao:
      "Encerra a campanha de vez. As mensagens que ainda não saíram não saem mais, e ela não pode ser retomada.",
    oQueToca: "Campanhas",
    risco: "critico",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
]);
