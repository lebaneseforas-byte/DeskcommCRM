/**
 * CADASTROS — para quem gerencia a empresa manter, por um aplicativo conectado
 * (o ChatGPT, por exemplo), o que os assistentes sabem e o que a empresa vende.
 *
 * `apenasHumano`: o assistente que atende o cliente não reescreve a própria base
 * de conhecimento nem o preço do catálogo — quem atende não define o que é
 * verdade para si mesmo. Apagar fica na tela, de propósito. As regras são as das
 * telas Conhecimento e Produtos (`lib/ai/knowledge/escrita-do-material.ts` e
 * `lib/catalogo/escrita-do-produto.ts`).
 */
import { declararTools } from "./tipos";

export const TOOLS_CADASTROS = declararTools([
  {
    name: "crm_create_knowledge_source",
    category: "write",
    rotulo: "Adicionar um material à base de conhecimento",
    explicacao:
      "Cria um material que os assistentes usam para responder: uma lista de perguntas e respostas ou um texto. O sistema prepara o material para a busca sozinho.",
    oQueToca: "Base de conhecimento",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_update_knowledge_source",
    category: "write",
    rotulo: "Atualizar um material da base de conhecimento",
    explicacao:
      "Troca o nome de um material ou a lista inteira de perguntas e respostas. Os assistentes passam a usar a versão nova assim que ela fica pronta.",
    oQueToca: "Base de conhecimento",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_create_product",
    category: "write",
    rotulo: "Cadastrar um produto",
    explicacao:
      "Cria um produto no catálogo, com código, nome, preço e estoque. As fotos são colocadas pela tela de produtos.",
    oQueToca: "Produtos",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_update_product",
    category: "write",
    rotulo: "Alterar um produto",
    explicacao:
      "Muda preço, nome, descrição, estoque ou se o produto está à venda. Só muda o que for pedido.",
    oQueToca: "Produtos",
    risco: "atencao",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
]);
