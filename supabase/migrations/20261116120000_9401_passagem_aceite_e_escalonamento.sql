-- manifest: **A passagem para uma pessoa nunca se perde: estado, aceite explícito e escalonamento.** `passagens_de_atendimento` ganha o ciclo `pendente → atribuida → aceita → resolvida` (e `reaberta` quando a IA passa de novo uma conversa já resolvida), com `responsavel_user_id` (dono da conversa → dono do negócio aberto → `settings.escalonamento_de_passagem.rota_por_etiqueta` pelas etiquetas da conversa e do contato → ninguém), `aceita_em`/`aceita_por`, `urgente` (etiqueta `urgente` ou `reclamação` na conversa ou no negócio aberto), `lembretes_enviados`/`ultimo_lembrete_em` e `escalada_em`/`escalada_para`. Colunas na MESMA tabela, não tabela 1:1: é um estado por episódio, e a tabela já tem a RLS de três condições, a cascata de LGPD e o piso de retenção que uma tabela-irmã teria de repetir. Quem escreve é o banco (gatilho na criação, gatilho na atribuição, gatilho no fechamento, `fn_passagem_devolvida` redefinida) e duas portas do servidor: `fn_passagem_aceitar` (definer, sessão, `agent`+ e responsável ou `admin`) e o cron `passagem-escalonamento` (service role, compare-and-set). Sem HTTP em gatilho. Idempotente; o backfill roda uma vez só, no banco que ainda não tem `estado`.
--
-- ════════════════════════════════════════════════════════════════════════════
-- 9401 — A PASSAGEM NUNCA SE PERDE
-- ════════════════════════════════════════════════════════════════════════════
--
-- ─── O defeito ──────────────────────────────────────────────────────────────
--
-- `reconhecido_em` (0291/0293) é escrito por QUALQUER atribuição — inclusive a
-- do rodízio, que entrega a conversa a alguém que pode nem estar olhando. Para a
-- tabela, "entregue" e "alguém pegou" eram a mesma coisa, e o único lembrete
-- (o braço de passagens do `case-stale-watcher`) só acorda depois de 24 h e só
-- cobra a passagem que NINGUÉM recebeu. Uma reclamação entregue ao atendente
-- errado às 9 h ficava sem resposta o dia inteiro, com a tela dizendo
-- "assumida".
--
-- ─── O desenho ──────────────────────────────────────────────────────────────
--
--   pendente   ninguém responde por ela ainda;
--   atribuida  há um responsável (dono da conversa, senão dono do negócio
--              aberto) — ENTREGUE, não aceita;
--   aceita     a pessoa disse "é comigo": o botão Aceitar, ou ela mesma assumiu
--              a conversa (Assumir/abrir/responder: `changed_by = to_user_id`);
--   resolvida  a conversa fechou, ou alguém a devolveu ao automático;
--   reaberta   a IA passou de novo uma conversa cuja passagem anterior já tinha
--              sido resolvida — o cliente voltou.
--
-- `reconhecido_*` não muda de significado: continua sendo o fato da 0293
-- (houve dono / o episódio fechou), e é o que o expurgo e o cartão leem.
--
-- ─── Por que COLUNAS e não tabela 1:1 ───────────────────────────────────────
--
-- A linha da passagem JÁ é o episódio, e o estado é do episódio. Uma tabela
-- companheira teria de repetir a RLS de três condições (organização + papel +
-- visibilidade da conversa), entrar na cascata de LGPD e no expurgo — três
-- lugares onde uma divergência vira vazamento ou rastro órfão. Nenhuma coluna
-- nova guarda dado de pessoa (só ids, carimbos e contadores), então a cascata
-- de LGPD não precisa de passo novo.
--
-- ─── Portabilidade ──────────────────────────────────────────────────────────
--
-- `add column if not exists`, `drop constraint if exists` + `add`,
-- `create or replace function`, `drop trigger if exists` + `create trigger`.
-- O backfill vive num `do` que só roda quando `estado` ainda não existe — a
-- reaplicação do `update.sh` não reescreve estado de ninguém. Sem
-- `BEGIN`/`COMMIT`, sem tabela temporária.

-- ── (1) as colunas ──────────────────────────────────────────────────────────
alter table public.passagens_de_atendimento
  add column if not exists responsavel_user_id uuid references auth.users(id) on delete set null;
alter table public.passagens_de_atendimento
  add column if not exists aceita_em timestamptz;
alter table public.passagens_de_atendimento
  add column if not exists aceita_por uuid references auth.users(id) on delete set null;
alter table public.passagens_de_atendimento
  add column if not exists urgente boolean not null default false;
alter table public.passagens_de_atendimento
  add column if not exists lembretes_enviados integer not null default 0;
alter table public.passagens_de_atendimento
  add column if not exists ultimo_lembrete_em timestamptz;
alter table public.passagens_de_atendimento
  add column if not exists escalada_em timestamptz;
alter table public.passagens_de_atendimento
  add column if not exists escalada_para uuid references auth.users(id) on delete set null;
alter table public.passagens_de_atendimento
  add column if not exists resolvida_em timestamptz;

-- ── (2) quem responde, e se é urgente — UMA regra para o gatilho e o backfill ─
--
-- A cadeia, nesta ordem:
--   1. o dono HUMANO da conversa;
--   2. o dono humano do negócio ABERTO mais recente do contato — quando há
--      negócio, o que numa operação que roteia por etiqueta muitas vezes não há;
--   3. a ROTA POR ETIQUETA da organização
--      (`settings.escalonamento_de_passagem.rota_por_etiqueta`, `{ "<etiqueta>":
--      "<userId>" }`), conferida contra as etiquetas da CONVERSA e depois as do
--      CONTATO, na ordem em que estão gravadas, normalizadas como
--      `conversationTagSchema` (trim + minúsculas);
--   4. ninguém — a passagem fica `pendente` e o lembrete vai à Central da
--      equipe inteira (aviso sem dono), onde a gestão o vê.
-- Em todos os elos só membro `agent`+ ATIVO da organização serve: quem saiu da
-- equipe não responde por atendimento, e um id torto no jsonb é ignorado.
create or replace function public.fn_passagem_responsavel_inicial(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_contact_id uuid
) returns uuid
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_quem uuid;
  v_rota jsonb;
  v_etiqueta text;
  v_alvo text;
begin
  select c.assigned_to_user_id into v_quem
    from public.conversations c
   where c.organization_id = p_organization_id
     and c.id = p_conversation_id
     and c.assigned_to_user_id is not null
     and coalesce(c.assignee_kind, 'user') = 'user';
  if v_quem is not null
     and coalesce(public.fn_member_role_in_org(v_quem, p_organization_id), 'none') in ('agent','manager','admin') then
    return v_quem;
  end if;

  select l.owner_user_id into v_quem
    from public.crm_leads l
   where l.organization_id = p_organization_id
     and l.contact_id = p_contact_id
     and l.status = 'open'
     and l.owner_user_id is not null
     and coalesce(l.owner_kind, 'user') = 'user'
   order by l.updated_at desc
   limit 1;
  if v_quem is not null
     and coalesce(public.fn_member_role_in_org(v_quem, p_organization_id), 'none') in ('agent','manager','admin') then
    return v_quem;
  end if;

  select o.settings -> 'escalonamento_de_passagem' -> 'rota_por_etiqueta' into v_rota
    from public.organizations o
   where o.id = p_organization_id;
  if v_rota is null or jsonb_typeof(v_rota) <> 'object' then
    return null;
  end if;

  for v_etiqueta in
    select e.etiqueta from (
      select lower(btrim(t.valor)) as etiqueta, 1 as fonte, t.n
        from public.conversations c,
             unnest(coalesce(c.tags, '{}'::text[])) with ordinality as t(valor, n)
       where c.organization_id = p_organization_id
         and c.id = p_conversation_id
      union all
      select lower(btrim(t.valor)), 2, t.n
        from public.contacts k,
             unnest(coalesce(k.tags, '{}'::text[])) with ordinality as t(valor, n)
       where k.organization_id = p_organization_id
         and k.id = p_contact_id
    ) e
    order by e.fonte, e.n
  loop
    v_alvo := v_rota ->> v_etiqueta;
    if v_alvo is not null
       and v_alvo ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and coalesce(public.fn_member_role_in_org(v_alvo::uuid, p_organization_id), 'none')
             in ('agent','manager','admin') then
      return v_alvo::uuid;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function public.fn_passagem_responsavel_inicial(uuid, uuid, uuid) from public, anon, authenticated;

-- Urgente = etiqueta `urgente` ou `reclamação` na conversa OU no negócio aberto
-- do contato, normalizada como `conversationTagSchema` (trim + minúsculas).
-- `reclamacao` sem acento entra junto: é como metade de quem digita no celular
-- escreve, e uma reclamação marcada sem acento não pode virar "normal".
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
       and lower(btrim(t.valor)) in ('urgente', 'reclamação', 'reclamacao')
  ) or exists (
    select 1
      from public.crm_leads l, unnest(coalesce(l.tags, '{}'::text[])) as t(valor)
     where l.organization_id = p_organization_id
       and l.contact_id = p_contact_id
       and l.status = 'open'
       and lower(btrim(t.valor)) in ('urgente', 'reclamação', 'reclamacao')
  );
$$;
revoke all on function public.fn_passagem_eh_urgente(uuid, uuid, uuid) from public, anon, authenticated;

-- ── (3) `estado` + backfill, UMA vez ────────────────────────────────────────
--
-- O backfill só roda no banco que ainda não tem a coluna. Num clone que já a
-- tem, reaplicar não reescreve estado nenhum — inclusive os aceites feitos
-- depois desta versão.
--
-- O que ele decide, linha a linha:
--   · reconhecida COM dono  → `aceita` (antes desta versão, assumir era o único
--     gesto que existia; tratá-la como "entregue" faria o cron cobrar de novo
--     atendimento que já andou);
--   · reconhecida SEM dono  → `resolvida` (devolvida ao automático);
--   · conversa já encerrada → `resolvida`;
--   · em aberto             → `atribuida`/`pendente`, com `lembretes_enviados`
--     herdando `cobrancas` (quem já foi cobrado pelo braço de 24 h não volta ao
--     zero) e `ultimo_lembrete_em = now()` — a atualização não dispara uma
--     rajada de lembretes sobre a semana inteira no minuto seguinte.
do $estado$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'passagens_de_atendimento'
       and column_name = 'estado'
  ) then
    alter table public.passagens_de_atendimento
      add column estado text not null default 'pendente';

    update public.passagens_de_atendimento p
       set estado = case
             when p.reconhecido_em is not null and p.reconhecido_por is not null then 'aceita'
             when p.reconhecido_em is not null then 'resolvida'
             when c.status in ('closed', 'resolved', 'archived') then 'resolvida'
             when public.fn_passagem_responsavel_inicial(p.organization_id, p.conversation_id, p.contact_id) is not null then 'atribuida'
             else 'pendente'
           end,
           responsavel_user_id = coalesce(
             p.reconhecido_por,
             public.fn_passagem_responsavel_inicial(p.organization_id, p.conversation_id, p.contact_id)
           ),
           aceita_em  = case when p.reconhecido_por is not null then p.reconhecido_em end,
           aceita_por = p.reconhecido_por,
           resolvida_em = case
             when p.reconhecido_em is not null and p.reconhecido_por is null then p.reconhecido_em
             when p.reconhecido_em is null and c.status in ('closed', 'resolved', 'archived') then now()
           end,
           urgente = public.fn_passagem_eh_urgente(p.organization_id, p.conversation_id, p.contact_id),
           lembretes_enviados = case when p.reconhecido_em is null then greatest(coalesce(p.cobrancas, 0), 0) else 0 end,
           ultimo_lembrete_em = case
             when p.reconhecido_em is null and c.status not in ('closed', 'resolved', 'archived') then now()
           end
      from public.conversations c
     where c.id = p.conversation_id
       and c.organization_id = p.organization_id;
  end if;
end $estado$;

-- Os CHECK em bloco próprio (drop + add): UMA constraint por regra, também no
-- clone que já tinha a coluna. O vocabulário de `estado` é o par de
-- `ESTADOS_DA_PASSAGEM` (`lib/escalacao/escalonamento-da-passagem.ts`), medido
-- por `tests/invariants/vocabulario-banco-x-typescript.test.ts`.
alter table public.passagens_de_atendimento
  drop constraint if exists passagens_de_atendimento_estado_check;
alter table public.passagens_de_atendimento
  add constraint passagens_de_atendimento_estado_check
  check (estado in ('pendente', 'atribuida', 'aceita', 'resolvida', 'reaberta'));

alter table public.passagens_de_atendimento
  drop constraint if exists passagens_lembretes_com_teto;
alter table public.passagens_de_atendimento
  add constraint passagens_lembretes_com_teto
  check (lembretes_enviados >= 0 and lembretes_enviados <= 50);

alter table public.passagens_de_atendimento
  drop constraint if exists passagens_aceite_coerente;
alter table public.passagens_de_atendimento
  add constraint passagens_aceite_coerente
  check (estado <> 'aceita' or aceita_em is not null);

-- Leitor declarado: o cron `passagem-escalonamento`, que só varre o que ainda
-- espera alguém. Parcial, então custa só as passagens vivas.
create index if not exists passagens_em_aberto_para_escalonar
  on public.passagens_de_atendimento (criado_em)
  where estado in ('pendente', 'atribuida', 'reaberta');

-- ── (4) a passagem NASCE com estado ─────────────────────────────────────────
--
-- Gatilho BEFORE INSERT, e não os treze call sites dos dois motores: o mesmo
-- argumento da 0293 — um gatilho cobre os treze e o décimo quarto. SQL puro,
-- nenhum HTTP (anti-pattern nº 9).
create or replace function public.fn_passagem_nasce_com_estado()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.responsavel_user_id is null then
    new.responsavel_user_id := public.fn_passagem_responsavel_inicial(
      new.organization_id, new.conversation_id, new.contact_id);
  end if;
  new.urgente := coalesce(new.urgente, false)
    or public.fn_passagem_eh_urgente(new.organization_id, new.conversation_id, new.contact_id);

  -- Só decide quando quem inseriu não decidiu (o default da coluna é
  -- `pendente`). `reaberta` vence `atribuida`: "o cliente voltou" é o fato que
  -- muda como a equipe lê a passagem, e o responsável continua gravado ao lado.
  if new.estado is null or new.estado = 'pendente' then
    if exists (
      select 1 from public.passagens_de_atendimento p
       where p.organization_id = new.organization_id
         and p.conversation_id = new.conversation_id
         and p.estado = 'resolvida'
    ) then
      new.estado := 'reaberta';
    elsif new.responsavel_user_id is not null then
      new.estado := 'atribuida';
    else
      new.estado := 'pendente';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.fn_passagem_nasce_com_estado() from public, anon, authenticated;

drop trigger if exists trg_passagem_nasce_com_estado on public.passagens_de_atendimento;
create trigger trg_passagem_nasce_com_estado
  before insert on public.passagens_de_atendimento
  for each row execute function public.fn_passagem_nasce_com_estado();

-- ── (5) a atribuição move o responsável — e quem assume para si, aceita ─────
--
-- Gatilho IRMÃO do `trg_passagem_reconhecida` (0293), no mesmo evento, e não
-- uma redefinição dele: os dois tocam colunas diferentes, e reescrever o corpo
-- da 0293 aqui seria a segunda cópia de uma função que já tem prova própria.
--
-- A régua de aceite: `changed_by = to_user_id` é a pessoa dando a conversa A SI
-- MESMA (Assumir, abrir e assumir, responder). Isso é "é comigo". Quando quem
-- atribui é outro (transferência, rodízio — `changed_by` nulo ou outra pessoa),
-- é ENTREGA: o responsável muda e o estado vai a `atribuida`, nunca a `aceita`.
--
-- A segunda camada da 0293 vale aqui também: só age se a conversa está MESMO
-- com aquele dono agora.
create or replace function public.fn_passagem_acompanha_atribuicao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.to_user_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.conversations c
     where c.id = new.conversation_id
       and c.organization_id = new.organization_id
       and c.assigned_to_user_id is not distinct from new.to_user_id
  ) then
    return new;
  end if;

  if new.changed_by is not null and new.changed_by = new.to_user_id then
    update public.passagens_de_atendimento
       set estado = 'aceita',
           aceita_em = now(),
           aceita_por = new.to_user_id,
           responsavel_user_id = new.to_user_id
     where organization_id = new.organization_id
       and conversation_id = new.conversation_id
       and estado in ('pendente', 'atribuida', 'reaberta');
  else
    update public.passagens_de_atendimento
       set responsavel_user_id = new.to_user_id,
           estado = case when estado = 'pendente' then 'atribuida' else estado end
     where organization_id = new.organization_id
       and conversation_id = new.conversation_id
       and estado in ('pendente', 'atribuida', 'reaberta');
  end if;
  return new;
end;
$$;
revoke all on function public.fn_passagem_acompanha_atribuicao() from public, anon, authenticated;

drop trigger if exists trg_passagem_acompanha_atribuicao on public.conversation_assignment_events;
create trigger trg_passagem_acompanha_atribuicao
  after insert on public.conversation_assignment_events
  for each row execute function public.fn_passagem_acompanha_atribuicao();

-- ── (5b) a etiqueta que chega DEPOIS da passagem ────────────────────────────
--
-- A IA costuma etiquetar a conversa e o contato (`projeto`, `loja`,
-- `reclamação`) no MESMO turno em que passa — às vezes depois do insert da
-- passagem. Sem este gatilho, a rota por etiqueta e a urgência só valeriam para
-- quem foi etiquetado ANTES, e a passagem ficaria `pendente` e "normal" com a
-- etiqueta certa à vista. Só toca passagem VIVA: dá responsável a quem não tem
-- (nunca troca um responsável já decidido) e só LIGA a urgência (tirar a
-- etiqueta não desarma um prazo que já corre).
create or replace function public.fn_passagem_acompanha_etiquetas()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.passagens_de_atendimento p
     set responsavel_user_id = coalesce(
           p.responsavel_user_id,
           public.fn_passagem_responsavel_inicial(p.organization_id, p.conversation_id, p.contact_id)),
         urgente = p.urgente
           or public.fn_passagem_eh_urgente(p.organization_id, p.conversation_id, p.contact_id)
   where p.organization_id = new.organization_id
     and (case when tg_table_name = 'contacts' then p.contact_id else p.conversation_id end) = new.id
     and p.estado in ('pendente', 'atribuida', 'reaberta');

  update public.passagens_de_atendimento p
     set estado = 'atribuida'
   where p.organization_id = new.organization_id
     and (case when tg_table_name = 'contacts' then p.contact_id else p.conversation_id end) = new.id
     and p.estado = 'pendente'
     and p.responsavel_user_id is not null;
  return null;
end;
$$;
revoke all on function public.fn_passagem_acompanha_etiquetas() from public, anon, authenticated;

drop trigger if exists trg_passagem_acompanha_etiquetas on public.conversations;
create trigger trg_passagem_acompanha_etiquetas
  after update of tags on public.conversations
  for each row
  when (old.tags is distinct from new.tags)
  execute function public.fn_passagem_acompanha_etiquetas();

drop trigger if exists trg_passagem_acompanha_etiquetas on public.contacts;
create trigger trg_passagem_acompanha_etiquetas
  after update of tags on public.contacts
  for each row
  when (old.tags is distinct from new.tags)
  execute function public.fn_passagem_acompanha_etiquetas();

-- ── (6) a conversa encerrada resolve a passagem ─────────────────────────────
--
-- Gatilho, e não a rota, pelo mesmo motivo da 9212: o encerramento tem três
-- escritores (a rota de fechar, o PATCH de status, a marcação de contato
-- pessoal). Uma vez por transição: o `when` só deixa passar quem ENTRA num
-- estado de fim.
create or replace function public.fn_passagem_resolvida_no_fechamento()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.passagens_de_atendimento
     set estado = 'resolvida',
         resolvida_em = now()
   where organization_id = new.organization_id
     and conversation_id = new.id
     and estado <> 'resolvida';
  return null;
end;
$$;
revoke all on function public.fn_passagem_resolvida_no_fechamento() from public, anon, authenticated;

drop trigger if exists trg_passagem_resolvida_no_fechamento on public.conversations;
create trigger trg_passagem_resolvida_no_fechamento
  after update of status on public.conversations
  for each row
  when (new.status in ('closed', 'resolved', 'archived')
        and old.status is distinct from new.status)
  execute function public.fn_passagem_resolvida_no_fechamento();

-- ── (7) "Devolver ao automático" também resolve ─────────────────────────────
--
-- Corpo da 0293 inteiro, com UM passo a mais: o estado vai a `resolvida` em
-- TODA passagem viva da conversa — inclusive a já reconhecida (alguém assumiu e
-- depois devolveu), que o update de `reconhecido_em` não alcança por desenho.
-- O retorno continua sendo quantas passagens ganharam `reconhecido_em` agora:
-- é o contrato que `tests/invariants/passagem-se-reconhece-sozinha.test.ts` mede.
create or replace function public.fn_passagem_devolvida(
  p_organization_id uuid,
  p_conversation_id uuid
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fechadas integer;
begin
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  update public.passagens_de_atendimento
     set reconhecido_em = now()
   where organization_id = p_organization_id
     and conversation_id = p_conversation_id
     and reconhecido_em is null;
  get diagnostics v_fechadas = row_count;

  update public.passagens_de_atendimento
     set estado = 'resolvida',
         resolvida_em = now()
   where organization_id = p_organization_id
     and conversation_id = p_conversation_id
     and estado <> 'resolvida';

  update public.agent_inbox_items
     set status = 'resolved',
         resolved_at = now()
   where organization_id = p_organization_id
     and kind = 'handoff'
     and ref_kind = 'conversation'
     and ref_id = p_conversation_id
     and status = 'open';

  return v_fechadas;
end;
$$;
revoke all     on function public.fn_passagem_devolvida(uuid, uuid) from public, anon;
grant  execute on function public.fn_passagem_devolvida(uuid, uuid) to authenticated, service_role;

-- ── (8) o ACEITE ────────────────────────────────────────────────────────────
--
-- `security definer` pelo mesmo motivo de `fn_passagem_devolvida`: a policy da
-- tabela é `for select` apenas, e `authenticated` não tem `update` — ninguém
-- reescreve um fato pela REST. A autorização mora NO CORPO:
--
--   · sessão obrigatória (aceite é gesto de pessoa; o servidor não aceita por
--     ninguém);
--   · suporte em modo leitura recusa (a mesma guarda de `fn_conversation_assign`);
--   · membro `agent`+ DAQUELA organização;
--   · e só o RESPONSÁVEL aceita — ou um `admin`, ou qualquer `agent`+ quando a
--     passagem ainda não tem responsável.
--
-- A conversa NÃO é atribuída aqui: quem atribui é a rota, pela
-- `fn_conversation_assign` com os efeitos de "Assumir" (auditoria, evento,
-- linha na timeline). Esta função fecha o estado e resolve o aviso da Central —
-- o que precisa acontecer também quando a conversa já é de quem aceita.
--
-- Idempotente: a segunda chamada devolve `aceitas = 0` e `ja_aceita = true`.
create or replace function public.fn_passagem_aceitar(
  p_organization_id uuid,
  p_conversation_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_aceitas integer;
begin
  if v_uid is null then
    raise exception 'passagem_aceite_exige_sessao' using errcode = '42501';
  end if;
  if not public.fn_support_write_allowed(p_organization_id) then
    raise exception 'support_readonly' using errcode = '42501';
  end if;
  if not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using errcode = '42501',
            hint = 'caller must be an active agent+ member of the organization';
  end if;

  -- Trava as vivas daquela conversa: o cron que escala ao mesmo tempo espera
  -- este aceite terminar, e o compare-and-set dele perde.
  perform 1
     from public.passagens_de_atendimento
    where organization_id = p_organization_id
      and conversation_id = p_conversation_id
      and estado in ('pendente', 'atribuida', 'reaberta')
      for update;

  if not public.fn_role_at_least(p_organization_id, 'admin') and exists (
    select 1 from public.passagens_de_atendimento
     where organization_id = p_organization_id
       and conversation_id = p_conversation_id
       and estado in ('pendente', 'atribuida', 'reaberta')
       and responsavel_user_id is not null
       and responsavel_user_id <> v_uid
  ) then
    raise exception 'passagem_de_outro_responsavel' using errcode = '42501';
  end if;

  update public.passagens_de_atendimento
     set estado = 'aceita',
         aceita_em = now(),
         aceita_por = v_uid,
         responsavel_user_id = v_uid
   where organization_id = p_organization_id
     and conversation_id = p_conversation_id
     and estado in ('pendente', 'atribuida', 'reaberta');
  get diagnostics v_aceitas = row_count;

  update public.agent_inbox_items
     set status = 'resolved',
         resolved_at = now()
   where organization_id = p_organization_id
     and kind = 'handoff'
     and ref_kind = 'conversation'
     and ref_id = p_conversation_id
     and status = 'open';

  return jsonb_build_object(
    'aceitas', v_aceitas,
    'ja_aceita', v_aceitas = 0 and exists (
      select 1 from public.passagens_de_atendimento
       where organization_id = p_organization_id
         and conversation_id = p_conversation_id
         and estado = 'aceita'
    )
  );
end;
$$;
revoke all     on function public.fn_passagem_aceitar(uuid, uuid) from public, anon;
grant  execute on function public.fn_passagem_aceitar(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
