/**
 * RELATÓRIOS DO DIA — para quem gerencia a empresa revisar a operação por um
 * aplicativo conectado (o ChatGPT, por exemplo). Só leitura.
 *
 * `apenasHumano`: o relatório é de quem gerencia, não ferramenta de atendimento —
 * um assistente não precisa ler o dia inteiro da empresa para responder um
 * cliente. As regras são as da tela Operação do dia (`lib/operacao/`).
 */
import { declararTools } from "./tipos";

export const TOOLS_RELATORIOS = declararTools([
  {
    name: "crm_get_daily_operation",
    category: "read",
    rotulo: "Ver como está o dia da operação",
    explicacao:
      "Mostra o dia ao vivo: conversas novas e com mensagem do cliente por canal, quem espera uma pessoa, projetos, reclamações, pedidos de produto, negócios ganhos e perdidos e as falhas do dia.",
    oQueToca: "Relatório do dia",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_list_daily_reports",
    category: "read",
    rotulo: "Ver os relatórios diários salvos",
    explicacao:
      "Lista os relatórios do dia que o sistema guarda sozinho, com os números principais de cada dia, para comparar dias e semanas.",
    oQueToca: "Relatório do dia",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_get_daily_report",
    category: "read",
    rotulo: "Ler o relatório de um dia",
    explicacao:
      "Mostra o relatório salvo de um dia, com o mesmo texto da tela de relatórios e os nomes atualizados.",
    oQueToca: "Relatório do dia",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
]);
