/**
 * Equipe pelo MCP — a trava que o MCP põe a mais sobre a régua da tela: nada dá
 * ou tira `admin`, e quem autorizou a conexão não muda o próprio papel. As
 * réguas da tela (plano cheio, último admin, revogado) são de
 * `lib/team/convidar.ts` e `lib/team/alterar-papel.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { McpContext } from "../types";

const DONO = "55555555-5555-4555-8555-555555555555";
const OUTRO = "66666666-6666-4666-8666-666666666666";
const ORG = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  chamadas: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  membro: null as unknown,
}));

vi.mock("@/lib/team/convidar", () => ({
  convidarPessoas: async (_db: unknown, args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "convidarPessoas", args });
    return { ok: true, sent: [], failed: [] };
  },
}));
vi.mock("@/lib/team/alterar-papel", () => ({
  lerMembro: async () => h.membro,
  alterarPapel: async (_db: unknown, args: Record<string, unknown>) => {
    h.chamadas.push({ fn: "alterarPapel", args });
    return { ok: true, user_id: args.alvoUserId, role: args.papel, papel_anterior: "agent" };
  },
}));

function ctx(): McpContext {
  const linhas: Record<string, unknown> = {
    api_tokens: { created_by: DONO },
    organizations: { name: "Neon" },
  };
  const from = (tabela: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => ({ data: linhas[tabela] ?? null, error: null });
    return chain;
  };
  return {
    organizationId: ORG,
    role: "admin",
    actor: { type: "api_token", id: "tok", role: "admin" },
    apiTokenId: "tok",
    requestId: "req",
    supabase: {
      from,
      auth: {
        admin: {
          getUserById: async () => ({
            data: { user: { email: "dono@x.co", user_metadata: { full_name: "Dono" } } },
          }),
        },
      },
    } as unknown as McpContext["supabase"],
  } as McpContext;
}

beforeEach(() => {
  h.chamadas = [];
  h.membro = { id: "m1", user_id: OUTRO, role: "agent", revoked_at: null };
});

describe("convidar", () => {
  it("o esquema não aceita convidar como admin", async () => {
    const { crmInviteTeamMembers } = await import("./equipe");
    const esquema = z.object(crmInviteTeamMembers.inputSchema);
    expect(esquema.safeParse({ convites: [{ email: "a@b.co", role: "admin" }] }).success).toBe(
      false,
    );
    expect(esquema.safeParse({ convites: [{ email: "a@b.co", role: "manager" }] }).success).toBe(
      true,
    );
  });

  it("convida em nome de quem autorizou a conexão, na organização do contexto", async () => {
    const { crmInviteTeamMembers } = await import("./equipe");
    await crmInviteTeamMembers.handler(
      { convites: [{ email: "nova@x.co", role: "agent" }] },
      ctx(),
    );
    expect(h.chamadas[0]!.args).toMatchObject({
      orgId: ORG,
      orgName: "Neon",
      inviterId: DONO,
      inviterName: "Dono",
      convites: [{ email: "nova@x.co", role: "agent" }],
    });
  });
});

describe("mudar papel", () => {
  it("o esquema não aceita promover a admin", async () => {
    const { crmChangeTeamMemberRole } = await import("./equipe");
    expect(
      z.object(crmChangeTeamMemberRole.inputSchema).safeParse({ user_id: OUTRO, role: "admin" })
        .success,
    ).toBe(false);
  });

  it("o papel de quem já é admin não muda por aqui", async () => {
    h.membro = { id: "m1", user_id: OUTRO, role: "admin", revoked_at: null };
    const { crmChangeTeamMemberRole } = await import("./equipe");
    const r = (await crmChangeTeamMemberRole.handler(
      { user_id: OUTRO, role: "viewer" },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("papel_de_admin");
    expect(h.chamadas).toHaveLength(0);
  });

  it("quem autorizou a conexão não muda o próprio papel", async () => {
    const { crmChangeTeamMemberRole } = await import("./equipe");
    const r = (await crmChangeTeamMemberRole.handler(
      { user_id: DONO, role: "manager" },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("proprio_papel");
    expect(h.chamadas).toHaveLength(0);
  });

  it("entre leitor, atendente e gerente, muda pela régua da tela com o token como autor", async () => {
    const { crmChangeTeamMemberRole } = await import("./equipe");
    const r = (await crmChangeTeamMemberRole.handler(
      { user_id: OUTRO, role: "manager" },
      ctx(),
    )) as Record<string, unknown>;
    expect(r).toEqual({ user_id: OUTRO, papel: "manager", papel_anterior: "agent" });
    expect(h.chamadas[0]!.args).toMatchObject({
      orgId: ORG,
      alvoUserId: OUTRO,
      papel: "manager",
      ator: { userId: null, apiTokenId: "tok", requestId: "req" },
    });
  });

  it("membro de fora da organização é 'não encontrado'", async () => {
    h.membro = null;
    const { crmChangeTeamMemberRole } = await import("./equipe");
    const r = (await crmChangeTeamMemberRole.handler(
      { user_id: OUTRO, role: "agent" },
      ctx(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("membro_nao_encontrado");
  });
});
