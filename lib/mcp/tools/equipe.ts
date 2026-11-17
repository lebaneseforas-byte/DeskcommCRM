/**
 * EQUIPE PELO MCP — o dono convidando gente e ajustando papéis pelo ChatGPT.
 *
 * ⚠️ NENHUMA REGRA DE NEGÓCIO MORA AQUI. Convidar é `lib/team/convidar.ts` (plano
 * cheio, quem já é membro, a linha de `team_invites`, o e-mail) e mudar papel é
 * `lib/team/alterar-papel.ts` (revogado, último admin, cache do papel) — as
 * mesmas das rotas de `team`.
 *
 * ⚠️ A TRAVA A MAIS: NADA AQUI DÁ OU TIRA O PAPEL `admin`. Quem escreve é um
 * modelo que lê conversas de cliente pelas outras ferramentas; um texto plantado
 * numa conversa que fizesse o modelo convidar um estranho como admin, ou rebaixar
 * o dono, entregaria a empresa. Então: convite e papel novo só vão até `manager`,
 * o papel de quem JÁ é admin não muda por aqui, e quem autorizou a conexão não
 * muda o próprio papel. Dar ou tirar admin, revogar acesso e apagar convite
 * ficam na tela de Equipe.
 *
 * ⚠️ A ORGANIZAÇÃO SAI DE `ctx.organizationId`. Papel `admin`, o da tela.
 */
import { z } from "zod";

import type { McpContext, McpToolDefinition } from "../types";

const carregarConvite = () => import("@/lib/team/convidar");
const carregarPapel = () => import("@/lib/team/alterar-papel");

/** Os papéis que esta conexão pode dar — ver a trava do topo. */
export const PAPEIS_PELO_APLICATIVO = ["viewer", "agent", "manager"] as const;

/** Quem autorizou a conexão (a linha do token): é o "quem convidou" do e-mail. */
async function donoDaConexao(ctx: McpContext): Promise<{ id: string; nome: string } | null> {
  const { data } = await ctx.supabase
    .from("api_tokens")
    .select("created_by")
    .eq("id", ctx.apiTokenId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  const id = (data as { created_by?: string } | null)?.created_by;
  if (!id) return null;
  const { data: u } = await ctx.supabase.auth.admin.getUserById(id);
  const nome =
    (u?.user?.user_metadata?.full_name as string | undefined) ?? u?.user?.email ?? "Um colega";
  return { id, nome };
}

// ---------------------------------------------------------------------------
// crm_list_team_invites
// ---------------------------------------------------------------------------

export const crmListTeamInvites: McpToolDefinition<Record<string, never>> = {
  name: "crm_list_team_invites",
  description:
    "Lists the team invitations still waiting to be accepted: e-mail, role, when it was sent and when it expires. " +
    "Current members are in crm_list_team_members.",
  inputSchema: {},
  category: "read",
  requiresRole: "admin",
  requiresScope: "mcp:read",
  handler: async (_input, ctx) => {
    const { data, error } = await ctx.supabase
      .from("team_invites")
      .select("id, email, role, created_at, expires_at, resend_count")
      .eq("organization_id", ctx.organizationId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .order("created_at", { ascending: false });
    if (error) return { erro: "falha_na_leitura", mensagem: error.message };
    return { convites: data ?? [] };
  },
};

// ---------------------------------------------------------------------------
// crm_invite_team_members
// ---------------------------------------------------------------------------

const convidarShape = {
  convites: z
    .array(z.object({ email: z.string().email(), role: z.enum(PAPEIS_PELO_APLICATIVO) }).strict())
    .min(1)
    .max(5),
};

export const crmInviteTeamMembers: McpToolDefinition<typeof convidarShape> = {
  name: "crm_invite_team_members",
  description:
    "Invites up to 5 people to the company's CRM by e-mail, as viewer, agent or manager (admin can only be given " +
    "on the Team screen). Each person receives an e-mail with an acceptance link; nobody joins until they accept. " +
    "Confirm the exact e-mails and roles with the person before calling.",
  inputSchema: convidarShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const dono = await donoDaConexao(ctx);
    if (!dono)
      return {
        erro: "conexao_sem_dono",
        mensagem: "Could not find who authorized this connection.",
      };
    const { data: org } = await ctx.supabase
      .from("organizations")
      .select("name")
      .eq("id", ctx.organizationId)
      .maybeSingle();
    const { convidarPessoas } = await carregarConvite();
    const r = await convidarPessoas(ctx.supabase, {
      orgId: ctx.organizationId,
      orgName: (org as { name?: string } | null)?.name ?? "",
      inviterId: dono.id,
      inviterName: dono.nome,
      idioma: "pt-BR",
      requestId: ctx.requestId,
      convites: input.convites,
    });
    if (!r.ok) return { erro: r.codigo, mensagem: r.mensagem, limite: r.limite };
    return {
      enviados: r.sent.map((s) => ({
        email: s.email,
        convite_id: s.invite_id,
        expira_em: s.expires_at,
        email_saiu: s.email_dispatched,
        ...(s.email_error ? { motivo_do_email_nao_sair: s.email_error } : {}),
      })),
      recusados: r.failed,
    };
  },
};

// ---------------------------------------------------------------------------
// crm_change_team_member_role
// ---------------------------------------------------------------------------

const papelShape = {
  user_id: z.string().uuid().describe("From crm_list_team_members."),
  role: z.enum(PAPEIS_PELO_APLICATIVO),
};

export const crmChangeTeamMemberRole: McpToolDefinition<typeof papelShape> = {
  name: "crm_change_team_member_role",
  description:
    "Changes a team member's role between viewer, agent and manager. Admins cannot be changed here, nobody can be " +
    "made admin here, and the person who authorized this connection cannot change their own role (all on the Team " +
    "screen). The new role applies on their next action. Confirm with the person before calling.",
  inputSchema: papelShape,
  category: "write",
  requiresRole: "admin",
  requiresScope: "mcp:write",
  handler: async (input, ctx) => {
    const dono = await donoDaConexao(ctx);
    if (!dono)
      return {
        erro: "conexao_sem_dono",
        mensagem: "Could not find who authorized this connection.",
      };
    if (dono.id === input.user_id) {
      return {
        erro: "proprio_papel",
        mensagem: "You cannot change your own role from here; use the Team screen.",
      };
    }
    const { alterarPapel, lerMembro } = await carregarPapel();
    const alvo = await lerMembro(ctx.supabase, ctx.organizationId, input.user_id);
    if (alvo && "erro" in alvo) return { erro: "falha_na_leitura", mensagem: alvo.erro };
    if (!alvo)
      return {
        erro: "membro_nao_encontrado",
        mensagem: "No member with this user_id in this company.",
      };
    if (alvo.role === "admin") {
      return {
        erro: "papel_de_admin",
        mensagem: "This person is an admin; admin roles only change on the Team screen.",
      };
    }
    const r = await alterarPapel(ctx.supabase, {
      orgId: ctx.organizationId,
      alvoUserId: input.user_id,
      papel: input.role,
      ator: { userId: null, apiTokenId: ctx.apiTokenId, requestId: ctx.requestId },
    });
    if (!r.ok) return { erro: r.codigo, mensagem: r.mensagem };
    return { user_id: r.user_id, papel: r.role, papel_anterior: r.papel_anterior };
  },
};
