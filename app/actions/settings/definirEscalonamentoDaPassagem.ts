"use server";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import {
  CHAVE_DO_ESCALONAMENTO,
  escalonamentoWriteSchema,
  lerEscalonamento,
  type EscalonamentoDaPassagemEntrada,
} from "@/lib/escalacao/escalonamento-da-passagem";
import { supportWriteError } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Grava `organizations.settings.escalonamento_de_passagem` (migration 9401).
 *
 * Mesma porta de `definirAvisoDeTransferencia`: admin da empresa, suporte em
 * leitura recusado, MFA em dívida recusado, e o `update` só vence se o
 * `settings` ainda é o que foi lido — duas abas salvando ao mesmo tempo não se
 * apagam em silêncio.
 *
 * O reserva e o responsável de cada etiqueta (`rota_por_etiqueta`) são
 * conferidos AQUI contra a equipe ATIVA (`agent`+, vínculo não
 * revogado): o cron confia no mapa, e um id de quem saiu da empresa faria a
 * escalada urgente apontar para ninguém. O cron confere de novo ao usar (o
 * aviso vai a `para_user_id`, e um membro revogado não recebe push).
 */
export async function definirEscalonamentoDaPassagem(
  valor: EscalonamentoDaPassagemEntrada,
): Promise<{ ok: boolean; error?: string }> {
  const entrada = escalonamentoWriteSchema.safeParse(valor);
  if (!entrada.success) return { ok: false, error: "Confira os campos: há um valor fora do permitido." };
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "Sua sessão expirou. Entre de novo." };
  if (supportWriteError(user.support)) return { ok: false, error: "Acesso somente leitura." };
  const org = await resolveActiveOrg(user);
  if (!org || !podeAdministrarEmpresa(user, org)) {
    return { ok: false, error: "Só um administrador pode mudar esta opção." };
  }
  if (await mfaEmDivida()) return { ok: false, error: "Confirme o segundo fator para salvar." };

  const admin = createAdminClient();
  const ids = [
    ...new Set([
      ...Object.keys(entrada.data.backup),
      ...Object.values(entrada.data.backup),
      ...Object.values(entrada.data.rota_por_etiqueta),
    ]),
  ];
  if (ids.length > 0) {
    // ⚠️ organização filtrada à mão: service role bypassa a RLS.
    const { data: membros, error: erroMembros } = await admin
      .from("user_organizations")
      .select("user_id, role")
      .eq("organization_id", org.orgId)
      .is("revoked_at", null)
      .in("user_id", ids);
    if (erroMembros) return { ok: false, error: "Não foi possível conferir a equipe." };
    const ativos = new Set(
      ((membros ?? []) as Array<{ user_id: string; role: string }>)
        .filter((m) => m.role === "agent" || m.role === "manager" || m.role === "admin")
        .map((m) => m.user_id),
    );
    if (ids.some((id) => !ativos.has(id))) {
      return { ok: false, error: "O reserva e o responsável por etiqueta precisam ser alguém ativo da equipe." };
    }
  }

  const { data, error: leitura } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();
  if (leitura || !data) return { ok: false, error: "Não foi possível ler a configuração." };
  const atual = (data.settings ?? {}) as Record<string, unknown>;
  const anterior = lerEscalonamento(atual);
  const { data: salva, error } = await admin
    .from("organizations")
    .update({ settings: { ...atual, [CHAVE_DO_ESCALONAMENTO]: entrada.data } })
    .eq("id", org.orgId)
    .eq("settings", JSON.stringify(atual))
    .select("id")
    .maybeSingle();
  if (error || !salva) {
    return { ok: false, error: "A configuração mudou ou não pôde ser salva. Recarregue e tente de novo." };
  }
  await audit({
    action: "settings.escalonamento_de_passagem_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { anterior, novo: entrada.data },
  });
  revalidatePath("/app/ai/cases/avisos");
  return { ok: true };
}
