/**
 * EQUIPE — para quem administra a empresa convidar gente e ajustar papéis por um
 * aplicativo conectado (o ChatGPT, por exemplo).
 *
 * `apenasHumano` e `critico`: mexem em quem entra no CRM e no que cada um pode
 * fazer. Nada aqui dá ou tira o papel de administrador, e quem autorizou a
 * conexão não muda o próprio papel — ver `../equipe.ts`. Revogar acesso e apagar
 * convite ficam na tela de Equipe.
 */
import { declararTools } from "./tipos";

export const TOOLS_EQUIPE = declararTools([
  {
    name: "crm_list_team_invites",
    category: "read",
    rotulo: "Ver os convites da equipe",
    explicacao:
      "Mostra os convites que ainda não foram aceitos, com o papel e a data em que vencem.",
    oQueToca: "Time de atendimento",
    risco: "seguro",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_invite_team_members",
    category: "write",
    rotulo: "Convidar pessoas para a equipe",
    explicacao:
      "Manda um convite por e-mail para até cinco pessoas, como leitor, atendente ou gerente. Ninguém entra antes de aceitar. Administrador só pela tela.",
    oQueToca: "Time de atendimento",
    risco: "critico",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
  {
    name: "crm_change_team_member_role",
    category: "write",
    rotulo: "Mudar o papel de alguém da equipe",
    explicacao:
      "Troca o papel de uma pessoa entre leitor, atendente e gerente. O papel de administrador, e o seu próprio, só mudam pela tela.",
    oQueToca: "Time de atendimento",
    risco: "critico",
    pacotes: ["evoluir"],
    apenasHumano: true,
  },
]);
