-- manifest: **Urgência da passagem também em inglês.** `fn_passagem_eh_urgente` passa a reconhecer as etiquetas `urgent` e `complaint` além de `urgente`/`reclamação`/`reclamacao`, para que uma organização que troca as etiquetas para inglês não desligue em silêncio o escalonamento urgente (lembrete a cada 15 min e passagem ao reserva). As etiquetas em português continuam valendo. Só redefine a função; idempotente.
--
-- ════════════════════════════════════════════════════════════════════════════
-- 9403 — URGÊNCIA DA PASSAGEM TAMBÉM EM INGLÊS
-- ════════════════════════════════════════════════════════════════════════════
--
-- A 9401 decidiu a urgência por uma lista fechada em português. Uma instalação
-- com operação em inglês (medida em 17/11/2026, que renomeou `urgente` → `urgent`
-- e `reclamação` → `complaint`) perderia o lembrete de 15 minutos e a passagem
-- ao reserva sem nenhum aviso: a etiqueta continuaria na conversa, só que com
-- outro nome. A lista é o par de `ETIQUETAS_URGENTES` em
-- `lib/escalacao/escalonamento-da-passagem.ts`.

create or replace function public.fn_passagem_eh_urgente(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_contact_id uuid
) returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.conversations c, unnest(coalesce(c.tags, '{}'::text[])) as t(valor)
     where c.organization_id = p_organization_id
       and c.id = p_conversation_id
       and lower(btrim(t.valor)) in ('urgente', 'reclamação', 'reclamacao', 'urgent', 'complaint')
  ) or exists (
    select 1
      from public.crm_leads l, unnest(coalesce(l.tags, '{}'::text[])) as t(valor)
     where l.organization_id = p_organization_id
       and l.contact_id = p_contact_id
       and l.status = 'open'
       and lower(btrim(t.valor)) in ('urgente', 'reclamação', 'reclamacao', 'urgent', 'complaint')
  );
$$;
revoke all on function public.fn_passagem_eh_urgente(uuid, uuid, uuid) from public, anon, authenticated;
