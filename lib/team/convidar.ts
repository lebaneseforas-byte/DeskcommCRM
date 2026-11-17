/**
 * CONVIDAR PESSOAS PARA A EQUIPE — a parte que `POST /api/v1/team/invite` e o
 * MCP do CRM (o dono pelo ChatGPT) fazem igual, quando há service-role.
 *
 * Saiu da rota para não haver duas réguas: o plano cheio RECUSA antes do e-mail
 * (spec cobrança §5, D-10; decisão do dono de 30/09), quem já é membro ATIVO é
 * pulado com `already_member`, e cada convite vira linha em `team_invites` por
 * `emitirConvite` (o e-mail e o recibo `member.invited` saem de lá). A membership
 * só nasce no aceite.
 *
 * ⚠️ `admin` é o client de serviço; a organização vem de quem chama, nunca do
 * corpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Role } from "@/lib/schemas/team";
import { lerLimiteDoPlano, mensagemDoLimite } from "@/lib/cobranca/limites";
import type { EmailDeliveryError } from "@/lib/email/roteador";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import type { InterfaceSettings } from "@/lib/navigation/interface";
import { emitirConvite } from "@/lib/team/convites";

export interface ConviteEnviado {
  email: string;
  invite_id: string;
  expires_at: string;
  email_dispatched: boolean;
  /** Por que não saiu, quando não saiu. Vocabulário de `lib/email/roteador.ts`. */
  email_error?: EmailDeliveryError;
  accept_url: string;
}

export interface ConviteRecusado {
  email: string;
  reason: string;
}

export type ResultadoDosConvites =
  | { ok: true; sent: ConviteEnviado[]; failed: ConviteRecusado[] }
  | { ok: false; codigo: "plan_limit_reached"; mensagem: string; limite: number };

export async function convidarPessoas(
  admin: SupabaseClient,
  args: {
    orgId: string;
    orgName: string;
    inviterId: string;
    inviterName: string;
    idioma: Idioma;
    requestId: string;
    convites: Array<{ email: string; role: Role; interface_settings?: InterfaceSettings }>;
  },
): Promise<ResultadoDosConvites> {
  const { data: membros } = await admin
    .from("user_organizations")
    .select("user_id, provisional_until_handover")
    .eq("organization_id", args.orgId)
    .is("revoked_at", null);

  // Plano cheio: RECUSA antes do e-mail. A trava do que já foi convidado segue
  // no gatilho de assentos, no ACEITE. Convite pendente não conta, e o
  // provisório do handover também não — a mesma contagem do gatilho. Ler o
  // limite falhou → segue: falhou a informação, e a trava continua no banco.
  const ativos = (membros ?? []).filter((m) => !m.provisional_until_handover).length;
  let limite: number | null = null;
  try {
    limite = await lerLimiteDoPlano(admin, args.orgId, "assentos");
  } catch (err) {
    logger.warn("team.invite: limite do plano não pôde ser lido — o convite segue", {
      organization_id: args.orgId,
      request_id: args.requestId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }
  if (limite !== null && ativos >= limite) {
    return {
      ok: false,
      codigo: "plan_limit_reached",
      mensagem: mensagemDoLimite("assentos", limite, args.idioma),
      limite,
    };
  }

  // O schema `auth` NÃO é acessível via PostgREST, então e-mail ↔ usuário sai da
  // GoTrue admin API (getUserById). N pequeno: poucos membros por organização.
  const emailsDeMembros = new Set<string>();
  for (const m of membros ?? []) {
    const { data: u } = await admin.auth.admin.getUserById(m.user_id as string);
    const email = u?.user?.email?.trim().toLowerCase();
    if (email) emailsDeMembros.add(email);
  }

  const sent: ConviteEnviado[] = [];
  const failed: ConviteRecusado[] = [];
  for (const inv of args.convites) {
    const email = inv.email.trim().toLowerCase();
    if (emailsDeMembros.has(email)) {
      failed.push({ email, reason: "already_member" });
      continue;
    }
    const { convite, accept_url, email_dispatched, email_error } = await emitirConvite(admin, {
      email,
      role: inv.role,
      interfaceSettings: inv.interface_settings,
      organizationId: args.orgId,
      orgName: args.orgName,
      inviterId: args.inviterId,
      inviterName: args.inviterName,
      requestId: args.requestId,
    });
    sent.push({
      email,
      invite_id: convite.id,
      expires_at: convite.expires_at,
      email_dispatched,
      email_error,
      accept_url,
    });
  }
  return { ok: true, sent, failed };
}
