/**
 * POST /api/v1/conversations/:id/passagens/aceitar — papel, responsável e
 * idempotência (migration 9401).
 *
 * O banco confere de novo dentro de `fn_passagem_aceitar` (provado em
 * `tests/invariants/passagem-aceite-e-escalonamento.test.ts`); aqui se mede a
 * ROTA: quem ela recusa antes do efeito, que a conversa muda de dono pela
 * função de "Assumir" (nunca por UPDATE cru), e que o segundo clique não
 * audita nem reatribui.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "44444444-4444-4444-8444-444444444444";
const CONV = "55555555-5555-4555-8555-555555555555";
const ANA = "11111111-1111-4111-8111-111111111111";
const BIA = "22222222-2222-4222-8222-222222222222";

type Linha = Record<string, unknown>;

const estado = vi.hoisted(() => ({
  papel: "agent" as string,
  eu: "11111111-1111-4111-8111-111111111111",
  negado: false,
  conversa: null as Record<string, unknown> | null,
  passagens: [] as Array<Record<string, unknown>>,
  /** O que o claim faz: `null` = perdeu (outro assumiu / não enxerga). */
  claim: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () =>
    estado.negado
      ? { ok: false, response: new Response(JSON.stringify({ error: { code: "forbidden_role" } }), { status: 403 }) }
      : {
          ok: true,
          user: { id: estado.eu, idioma: "pt-BR" },
          org: { orgId: ORG, name: "Org", role: estado.papel },
        },
}));
vi.mock("@/lib/audit", () => ({ audit: estado.audit }));
vi.mock("@/lib/inbox/assumir-conversa", () => ({ assumirConversaComEfeitos: estado.claim }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: estado.rpc }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const filtros: Array<[string, unknown]> = [];
      const linhas = (): Linha[] =>
        tabela === "conversations"
          ? estado.conversa
            ? [estado.conversa]
            : []
          : estado.passagens;
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        eq: (c: string, v: unknown) => {
          filtros.push([c, v]);
          return cadeia;
        },
        order: () => cadeia,
        limit: () => cadeia,
        maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) => {
          // A organização TEM de estar no filtro: o client é service role.
          if (!filtros.some(([c, v]) => c === "organization_id" && v === ORG)) {
            return Promise.resolve({ data: [], error: { message: "sem filtro de organização" } }).then(ok);
          }
          return Promise.resolve({ data: linhas(), error: null }).then(ok);
        },
      };
      return cadeia;
    },
  }),
}));

async function aceitar() {
  const { POST } = await import("@/app/api/v1/conversations/[id]/passagens/aceitar/route");
  const res = await POST({} as never, { params: Promise.resolve({ id: CONV }) });
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; error?: { code: string } } };
}

function viva(over: Linha = {}): Linha {
  return {
    id: "p1",
    estado: "atribuida",
    responsavel_user_id: ANA,
    aceita_em: null,
    aceita_por: null,
    criado_em: "2026-11-16T10:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  estado.papel = "agent";
  estado.eu = ANA;
  estado.negado = false;
  estado.conversa = { id: CONV, assigned_to_user_id: null };
  estado.passagens = [viva()];
  estado.claim.mockReset().mockResolvedValue({ conversation: { id: CONV }, error: null });
  estado.rpc.mockReset().mockResolvedValue({ data: { aceitas: 1, ja_aceita: false }, error: null });
  estado.audit.mockReset();
});

describe("aceitar a passagem", () => {
  it("viewer é recusado pelo papel, antes de qualquer efeito", async () => {
    estado.negado = true;
    const r = await aceitar();
    expect(r.status).toBe(403);
    expect(estado.claim).not.toHaveBeenCalled();
    expect(estado.rpc).not.toHaveBeenCalled();
  });

  it("o responsável aceita: a conversa passa a ele pela função de Assumir, o estado fecha, audita uma vez", async () => {
    estado.conversa = { id: CONV, assigned_to_user_id: BIA };
    const r = await aceitar();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ estado: "aceita", ja_aceita: false });
    expect(estado.claim).toHaveBeenCalledTimes(1);
    expect(estado.claim.mock.calls[0]?.[1]).toMatchObject({ conversationId: CONV, expectedAssignee: BIA });
    expect(estado.rpc).toHaveBeenCalledWith("fn_passagem_aceitar", { p_organization_id: ORG, p_conversation_id: CONV });
    expect(estado.audit).toHaveBeenCalledTimes(1);
    expect(estado.audit.mock.calls[0]?.[0]).toMatchObject({ action: "handoff.accepted", organizationId: ORG });
  });

  it("um agent que NÃO é o responsável recebe 403 e nada muda", async () => {
    estado.eu = BIA;
    const r = await aceitar();
    expect(r.status).toBe(403);
    expect(estado.claim).not.toHaveBeenCalled();
    expect(estado.rpc).not.toHaveBeenCalled();
    expect(estado.audit).not.toHaveBeenCalled();
  });

  it("admin aceita a passagem de outro responsável", async () => {
    estado.eu = BIA;
    estado.papel = "admin";
    const r = await aceitar();
    expect(r.status).toBe(200);
    expect(estado.audit.mock.calls[0]?.[0]).toMatchObject({ metadata: { pelo_admin: true } });
  });

  it("sem responsável, qualquer agent aceita", async () => {
    estado.eu = BIA;
    estado.passagens = [viva({ estado: "pendente", responsavel_user_id: null })];
    expect((await aceitar()).status).toBe(200);
  });

  it("conversa que já é minha: não reatribui, só fecha o estado", async () => {
    estado.conversa = { id: CONV, assigned_to_user_id: ANA };
    const r = await aceitar();
    expect(r.status).toBe(200);
    expect(estado.claim).not.toHaveBeenCalled();
    expect(estado.audit).toHaveBeenCalledTimes(1);
  });

  it("IDEMPOTENTE: passagem já aceita devolve 200 ja_aceita, sem claim, sem rpc, sem auditoria", async () => {
    estado.passagens = [viva({ estado: "aceita", aceita_em: "2026-11-16T10:05:00Z", aceita_por: ANA })];
    const r = await aceitar();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ja_aceita: true, estado: "aceita" });
    expect(estado.claim).not.toHaveBeenCalled();
    expect(estado.rpc).not.toHaveBeenCalled();
    expect(estado.audit).not.toHaveBeenCalled();
  });

  it("o segundo clique concorrente (claim perdido, conversa já minha, nada aceito agora) não audita", async () => {
    estado.conversa = { id: CONV, assigned_to_user_id: BIA };
    // O claim perde pela sessão e pelo servidor; a releitura mostra a conversa comigo.
    estado.claim.mockImplementation(async () => {
      estado.conversa = { id: CONV, assigned_to_user_id: ANA };
      return { conversation: null, error: null };
    });
    estado.rpc.mockResolvedValue({ data: { aceitas: 0, ja_aceita: true }, error: null });
    const r = await aceitar();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ja_aceita: true });
    expect(estado.audit).not.toHaveBeenCalled();
  });

  it("outro atendente levou a conversa: 409, e o estado não é tocado", async () => {
    estado.conversa = { id: CONV, assigned_to_user_id: BIA };
    estado.claim.mockResolvedValue({ conversation: null, error: null });
    estado.eu = BIA;
    estado.papel = "admin";
    estado.conversa = { id: CONV, assigned_to_user_id: "99999999-9999-4999-8999-999999999999" };
    const r = await aceitar();
    expect(r.status).toBe(409);
    expect(estado.rpc).not.toHaveBeenCalled();
  });

  it("sem passagem nenhuma esperando: 404", async () => {
    estado.passagens = [];
    expect((await aceitar()).status).toBe(404);
  });

  it("o banco recusa outro responsável mesmo que a rota deixe passar: 403", async () => {
    estado.rpc.mockResolvedValue({ data: null, error: { message: "passagem_de_outro_responsavel" } });
    expect((await aceitar()).status).toBe(403);
    expect(estado.audit).not.toHaveBeenCalled();
  });
});
