/**
 * POST /api/v1/campaigns/:id/:acao — preparar, iniciar, agendar, pausar,
 * retomar, cancelar, duplicar e testar.
 *
 * ═══ Por que UMA rota e não oito ═══
 *
 * As oito fazem a mesma coisa em volta: conferir papel, carregar a campanha da
 * organização certa, pedir a transição à máquina de estados, auditar. Espalhado
 * em oito arquivos, esse "em volta" diverge — e o dia em que um deles esquecer de
 * conferir o estado é o dia em que uma campanha cancelada volta a enviar. As
 * ações em si moram em `lib/campanhas/acoes.ts`, e o despacho em
 * `lib/campanhas/executar-acao.ts` (o mesmo do MCP do CRM).
 *
 * O caminho na URL continua sendo o da Spec 12 §16 (`/prepare`, `/start`, …, em
 * português): `acao` é validada contra um mapa fechado, então nenhuma URL
 * inventada chega ao banco.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ehAcaoDeCampanha, executarAcaoDaCampanha } from "@/lib/campanhas/executar-acao";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; acao: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id, acao } = await ctx.params;

  if (!ehAcaoDeCampanha(acao)) {
    return fail("not_found", t("Ação de campanha desconhecida."), 404, { requestId });
  }

  // Só `agendar` e `testar` leem o corpo; as outras ações ignoram.
  const corpo = acao === "agendar" || acao === "testar" ? await req.json().catch(() => null) : null;

  // Admin client porque duas ações ENVIAM (teste e, por tabela, a preparação
  // lê contatos de toda a organização). Toda consulta filtra `organization_id`
  // à mão, resolvido do papel conferido acima — nunca do corpo. O despacho, a
  // máquina de estados e a auditoria moram em `lib/campanhas/executar-acao.ts`.
  const r = await executarAcaoDaCampanha(createAdminClient(), {
    orgId: authz.org.orgId,
    campanhaId: id,
    acao,
    corpo,
    ator: { userId: authz.user.id, apiTokenId: null, requestId },
    t,
  });
  if (!r.ok) return fail(r.codigo, r.mensagem, r.status, { requestId });
  return ok(r.data, { requestId });
}
