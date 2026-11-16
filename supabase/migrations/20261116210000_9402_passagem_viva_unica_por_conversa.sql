-- manifest: **Uma passagem viva por conversa.** Quando nasce uma passagem numa conversa que já tem outra viva (`pendente`, `atribuida`, `reaberta`), a nova herda o responsável (se não trouxer um) e a urgência da anterior, e a anterior vira `resolvida`. Antes, o worker de sentimento e a ferramenta do agente abriam duas passagens com 9 s de diferença para a mesma reclamação; o escalonamento só acompanhava a mais nova (`umaPorConversa`) e a mais velha ficava viva para sempre, sem responsável. O backfill aplica a mesma regra às duplicadas que já existem. Nada é apagado: a passagem anterior continua no histórico com o briefing dela. Sem HTTP em gatilho. Idempotente.
--
-- ════════════════════════════════════════════════════════════════════════════
-- 9402 — UMA PASSAGEM VIVA POR CONVERSA
-- ════════════════════════════════════════════════════════════════════════════
--
-- ─── O defeito, medido (16/11/2026) ─────────────────────────────────────────
--
-- Uma cliente escreveu que ia dar uma estrela no Google. O worker de sentimento
-- abriu uma passagem (`low_sentiment`) e, 9 s depois, o próprio agente abriu
-- outra para o mesmo assunto. As duas ficaram `pendente`. O cron de
-- escalonamento olha só a mais nova da conversa (`umaPorConversa`, "duas vivas
-- são UM cliente esperando"), então a mais velha nunca recebia lembrete, nunca
-- ganhava responsável e nunca saía da lista de quem espera.
--
-- ─── A regra ────────────────────────────────────────────────────────────────
--
-- A passagem nova SUCEDE a viva: herda dela o responsável (só quando a nova não
-- trouxe um) e a urgência (só liga, nunca desliga), e a anterior passa a
-- `resolvida`. Registrar as duas continua sendo a regra (o briefing da segunda
-- costuma ser o mais rico — `tests/unit/passagem-registro-e-dedup.test.ts`); o
-- que deixa de existir é haver duas VIVAS.
--
-- Por que `resolvida` e não um estado novo: o vocabulário é fechado por CHECK e
-- espelhado em TypeScript (`ESTADOS_DA_PASSAGEM`); um estado a mais obrigaria
-- toda tela e todo filtro a aprender um nome para "foi continuada". Para quem
-- opera, a anterior está encerrada: o cliente tem uma passagem viva, a nova.
--
-- Dois gatilhos, para não reescrever o corpo da 9401:
--   (1) BEFORE INSERT `trg_passagem_sucede_a_viva` — roda DEPOIS de
--       `trg_passagem_nasce_com_estado` (ordem alfabética do Postgres) e só
--       acrescenta a herança.
--   (2) AFTER INSERT `trg_passagem_encerra_a_anterior` — fecha as vivas mais
--       velhas da mesma conversa.
-- Sem HTTP em gatilho (anti-pattern 9). Idempotente.

create or replace function public.fn_passagem_sucede_a_viva()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_responsavel uuid;
  v_urgente boolean;
begin
  select (array_agg(p.responsavel_user_id order by p.criado_em desc)
            filter (where p.responsavel_user_id is not null))[1],
         coalesce(bool_or(p.urgente), false)
    into v_responsavel, v_urgente
    from public.passagens_de_atendimento p
   where p.organization_id = new.organization_id
     and p.conversation_id = new.conversation_id
     and p.estado in ('pendente', 'atribuida', 'reaberta');

  if new.responsavel_user_id is null and v_responsavel is not null then
    new.responsavel_user_id := v_responsavel;
    if new.estado = 'pendente' then
      new.estado := 'atribuida';
    end if;
  end if;
  new.urgente := coalesce(new.urgente, false) or coalesce(v_urgente, false);
  return new;
end;
$$;
revoke all on function public.fn_passagem_sucede_a_viva() from public, anon, authenticated;

drop trigger if exists trg_passagem_sucede_a_viva on public.passagens_de_atendimento;
create trigger trg_passagem_sucede_a_viva
  before insert on public.passagens_de_atendimento
  for each row execute function public.fn_passagem_sucede_a_viva();

create or replace function public.fn_passagem_encerra_a_anterior()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.passagens_de_atendimento p
     set estado = 'resolvida'
   where p.organization_id = new.organization_id
     and p.conversation_id = new.conversation_id
     and p.id <> new.id
     and p.criado_em <= new.criado_em
     and p.estado in ('pendente', 'atribuida', 'reaberta');
  return null;
end;
$$;
revoke all on function public.fn_passagem_encerra_a_anterior() from public, anon, authenticated;

drop trigger if exists trg_passagem_encerra_a_anterior on public.passagens_de_atendimento;
create trigger trg_passagem_encerra_a_anterior
  after insert on public.passagens_de_atendimento
  for each row
  when (new.estado in ('pendente', 'atribuida', 'reaberta'))
  execute function public.fn_passagem_encerra_a_anterior();

-- Backfill: as duplicadas vivas que já existem. A mais nova herda e as outras
-- fecham. Rodar de novo não acha mais nada (idempotente).
with vivas as (
  select p.id, p.organization_id, p.conversation_id, p.criado_em, p.responsavel_user_id, p.urgente,
         row_number() over (partition by p.organization_id, p.conversation_id order by p.criado_em desc, p.id desc) as ordem
    from public.passagens_de_atendimento p
   where p.estado in ('pendente', 'atribuida', 'reaberta')
),
heranca as (
  select v.organization_id, v.conversation_id,
         (array_agg(v.responsavel_user_id order by v.criado_em desc)
            filter (where v.responsavel_user_id is not null))[1] as responsavel,
         bool_or(v.urgente) as urgente
    from vivas v
   group by v.organization_id, v.conversation_id
  having count(*) > 1
)
update public.passagens_de_atendimento p
   set responsavel_user_id = coalesce(p.responsavel_user_id, h.responsavel),
       urgente = p.urgente or coalesce(h.urgente, false),
       estado = case when p.estado = 'pendente' and coalesce(p.responsavel_user_id, h.responsavel) is not null
                     then 'atribuida' else p.estado end
  from vivas v
  join heranca h on h.organization_id = v.organization_id and h.conversation_id = v.conversation_id
 where p.id = v.id
   and v.ordem = 1;

with vivas as (
  select p.id,
         row_number() over (partition by p.organization_id, p.conversation_id order by p.criado_em desc, p.id desc) as ordem
    from public.passagens_de_atendimento p
   where p.estado in ('pendente', 'atribuida', 'reaberta')
)
update public.passagens_de_atendimento p
   set estado = 'resolvida'
  from vivas v
 where p.id = v.id
   and v.ordem > 1;
