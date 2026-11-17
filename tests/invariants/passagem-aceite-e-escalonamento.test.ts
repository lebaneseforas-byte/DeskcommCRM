/**
 * A PASSAGEM NUNCA SE PERDE — o banco (migration 9401).
 *
 * O que só o banco prova:
 *
 *   · a passagem NASCE com estado e responsável — dono da conversa, senão dono
 *     do negócio aberto, senão a ROTA POR ETIQUETA (conversa antes do contato),
 *     senão ninguém (`pendente`); e urgente pela etiqueta normalizada;
 *   · a etiqueta que chega DEPOIS da passagem ainda decide (gatilho em
 *     `conversations.tags`/`contacts.tags`);
 *   · ENTREGUE não é ACEITA: atribuir pelo serviço deixa `atribuida`; assumir
 *     para si aceita;
 *   · `fn_passagem_aceitar`: o responsável e o admin aceitam; outro agent, um
 *     viewer, a outra organização e a anon key não; e é idempotente;
 *   · fechar a conversa e devolvê-la ao automático RESOLVEM; a próxima
 *     passagem da mesma conversa nasce `reaberta`;
 *   · as colunas novas herdam a RLS da tabela: o vizinho não lê, e ninguém
 *     reescreve o estado pela REST.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const ORG = "94010000-0000-4000-8000-000000000001";
const ORG_B = "94010000-0000-4000-8000-000000000002";
const SESSAO = "94010000-2222-4000-8000-000000000001";
const SESSAO_B = "94010000-2222-4000-8000-000000000002";
// Contatos DIFERENTES por conversa: há unique parcial (org, contato, canal) em
// `conversations` (ver `passagem-se-reconhece-sozinha.test.ts`).
const C1 = "94010000-3333-4000-8000-000000000001";
const C2 = "94010000-3333-4000-8000-000000000002";
const C_B = "94010000-3333-4000-8000-000000000003";
const CONV1 = "94010000-4444-4000-8000-000000000001";
const CONV2 = "94010000-4444-4000-8000-000000000002";
const CONV_B = "94010000-4444-4000-8000-000000000003";
const DONO = "94010000-5555-4000-8000-000000000001";
const OUTRO = "94010000-5555-4000-8000-000000000002";
const CHEFE = "94010000-5555-4000-8000-000000000003";
const LEITOR = "94010000-5555-4000-8000-000000000004";
const VIZINHO = "94010000-5555-4000-8000-000000000005";

function texto(consulta: string): string {
  return (sql(consulta).trim().split("\n").at(-1) ?? "").trim();
}

function comJwt(userId: string): string {
  return `select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);`;
}

function comoMembro(userId: string): string {
  return `set role authenticated;\n${comJwt(userId)}`;
}

function erroDe(script: string): string | null {
  try {
    sql(script);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

function inserirPassagem(conversa = CONV1, contato = C1): void {
  sql(`insert into public.passagens_de_atendimento
         (organization_id, contact_id, conversation_id, motor, origem, motivo_codigo, body)
       values ('${ORG}', '${contato}', '${conversa}', 'engine', 'pedido_explicito',
               'requested_human', 'briefing de teste');`);
}

function campo(coluna: string, conversa = CONV1): string {
  return texto(`select coalesce(${coluna}::text, '<null>') from public.passagens_de_atendimento
                 where organization_id = '${ORG}' and conversation_id = '${conversa}'
                 order by criado_em desc limit 1;`);
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${DONO}',    'p9401-dono@invariant.test'),
      ('${OUTRO}',   'p9401-outro@invariant.test'),
      ('${CHEFE}',   'p9401-chefe@invariant.test'),
      ('${LEITOR}',  'p9401-leitor@invariant.test'),
      ('${VIZINHO}', 'p9401-vizinho@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}',   'p9401-a', 'Passagem 9401 A', 'Passagem 9401 A'),
      ('${ORG_B}', 'p9401-b', 'Passagem 9401 B', 'Passagem 9401 B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${DONO}',    '${ORG}',   'agent',  now()),
      ('${OUTRO}',   '${ORG}',   'agent',  now()),
      ('${CHEFE}',   '${ORG}',   'admin',  now()),
      ('${LEITOR}',  '${ORG}',   'viewer', now()),
      ('${VIZINHO}', '${ORG_B}', 'admin',  now())
      on conflict do nothing;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO}', '${ORG}', 'p9401-a', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_B}', '${ORG_B}', 'p9401-b', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    insert into public.contacts (id, organization_id, display_name) values
      ('${C1}',  '${ORG}',   'P9401 Um'),
      ('${C2}',  '${ORG}',   'P9401 Dois'),
      ('${C_B}', '${ORG_B}', 'P9401 Vizinho')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONV1}',  '${ORG}',   '${C1}',  '${SESSAO}',   'open'),
      ('${CONV2}',  '${ORG}',   '${C2}',  '${SESSAO}',   'open'),
      ('${CONV_B}', '${ORG_B}', '${C_B}', '${SESSAO_B}', 'open')
      on conflict do nothing;
    do $chk$ begin
      if (select count(*) from public.conversations where id in ('${CONV1}','${CONV2}','${CONV_B}')) < 3 then
        raise exception 'seed incompleto: as três conversas precisam existir';
      end if;
    end $chk$;
  `);
});

beforeEach(() => {
  sql(`
    delete from public.passagens_de_atendimento where organization_id in ('${ORG}', '${ORG_B}');
    delete from public.agent_inbox_items where organization_id in ('${ORG}', '${ORG_B}');
    update public.conversations
       set assigned_to_user_id = null, assignee_kind = null, status = 'open', tags = '{}'
     where organization_id in ('${ORG}', '${ORG_B}');
    update public.contacts set tags = '{}' where organization_id in ('${ORG}', '${ORG_B}');
    update public.organizations set settings = '{}'::jsonb where id = '${ORG}';
  `);
});

describe("9401 — a passagem nasce com estado e responsável", () => {
  it("com dono na conversa: `atribuida` a ele", () => {
    sql(`update public.conversations set assigned_to_user_id = '${DONO}', assignee_kind = 'user' where id = '${CONV1}';`);
    inserirPassagem();
    expect(campo("estado")).toBe("atribuida");
    expect(campo("responsavel_user_id")).toBe(DONO);
    expect(campo("urgente")).toBe("false");
  });

  it("sem dono e sem negócio: a ROTA POR ETIQUETA do contato decide", () => {
    sql(`update public.organizations
            set settings = '{"escalonamento_de_passagem":{"rota_por_etiqueta":{"loja":"${OUTRO}","projeto":"${DONO}"}}}'::jsonb
          where id = '${ORG}';
         update public.contacts set tags = array['Loja '] where id = '${C1}';`);
    inserirPassagem();
    expect(campo("responsavel_user_id")).toBe(OUTRO);
    expect(campo("estado")).toBe("atribuida");
  });

  it("a etiqueta da CONVERSA vence a do contato", () => {
    sql(`update public.organizations
            set settings = '{"escalonamento_de_passagem":{"rota_por_etiqueta":{"loja":"${OUTRO}","projeto":"${DONO}"}}}'::jsonb
          where id = '${ORG}';
         update public.contacts set tags = array['loja'] where id = '${C1}';
         update public.conversations set tags = array['projeto'] where id = '${CONV1}';`);
    inserirPassagem();
    expect(campo("responsavel_user_id")).toBe(DONO);
  });

  it("rota para quem não é membro ativo é ignorada: `pendente`", () => {
    sql(`update public.organizations
            set settings = '{"escalonamento_de_passagem":{"rota_por_etiqueta":{"loja":"${VIZINHO}"}}}'::jsonb
          where id = '${ORG}';
         update public.contacts set tags = array['loja'] where id = '${C1}';`);
    inserirPassagem();
    expect(campo("estado")).toBe("pendente");
    expect(campo("responsavel_user_id")).toBe("<null>");
  });

  it("urgente pela etiqueta normalizada (' Reclamação ')", () => {
    sql(`update public.conversations set tags = array[' Reclamação '] where id = '${CONV1}';`);
    inserirPassagem();
    expect(campo("urgente")).toBe("true");
  });

  it("9403: urgente também pelas etiquetas em inglês (' Complaint ', 'urgent')", () => {
    sql(`update public.conversations set tags = array[' Complaint '] where id = '${CONV1}';`);
    inserirPassagem();
    expect(campo("urgente")).toBe("true");
    sql(`update public.conversations set tags = array['urgent'] where id = '${CONV2}';`);
    inserirPassagem(CONV2, C2);
    expect(campo("urgente", CONV2)).toBe("true");
  });

  it("controle: etiqueta sem urgência não liga (' project ')", () => {
    sql(`update public.conversations set tags = array[' project '] where id = '${CONV1}';`);
    inserirPassagem();
    expect(campo("urgente")).toBe("false");
  });

  it("a etiqueta que chega DEPOIS ainda dá responsável e urgência", () => {
    sql(`update public.organizations
            set settings = '{"escalonamento_de_passagem":{"rota_por_etiqueta":{"projeto":"${DONO}"}}}'::jsonb
          where id = '${ORG}';`);
    inserirPassagem();
    expect(campo("estado")).toBe("pendente");
    sql(`update public.conversations set tags = array['projeto', 'urgente'] where id = '${CONV1}';`);
    expect(campo("estado")).toBe("atribuida");
    expect(campo("responsavel_user_id")).toBe(DONO);
    expect(campo("urgente")).toBe("true");
  });
});

describe("9401 — entregue não é aceita", () => {
  it("atribuição pelo SERVIÇO (rodízio) deixa `atribuida`", () => {
    inserirPassagem();
    sql(`select public.fn_conversation_assign('${ORG}', '${CONV1}', '${DONO}', 'routing', null, false);`);
    expect(campo("estado")).toBe("atribuida");
    expect(campo("responsavel_user_id")).toBe(DONO);
    expect(campo("aceita_em")).toBe("<null>");
  });

  it("assumir PARA SI aceita", () => {
    inserirPassagem();
    sql(`${comJwt(DONO)}
         select public.fn_conversation_assign('${ORG}', '${CONV1}', '${DONO}', 'claim', null, true);`);
    expect(campo("estado")).toBe("aceita");
    expect(campo("aceita_por")).toBe(DONO);
  });
});

describe("9401 — fn_passagem_aceitar", () => {
  beforeEach(() => {
    sql(`update public.conversations set assigned_to_user_id = '${DONO}', assignee_kind = 'user' where id = '${CONV1}';`);
    inserirPassagem();
    sql(`insert into public.agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id, status)
         values ('${ORG}', 'handoff', 'warn', 'lembrete', 'corpo', 'conversation', '${CONV1}', 'open');`);
  });

  it("CONTROLE: a semente nasce viva, com o DONO responsável", () => {
    expect(campo("estado")).toBe("atribuida");
  });

  it("outro agent da mesma organização é recusado", () => {
    const erro = erroDe(`${comoMembro(OUTRO)}
      select public.fn_passagem_aceitar('${ORG}', '${CONV1}');`);
    expect(erro).toContain("passagem_de_outro_responsavel");
    expect(campo("estado")).toBe("atribuida");
  });

  it("viewer é recusado", () => {
    expect(erroDe(`${comoMembro(LEITOR)} select public.fn_passagem_aceitar('${ORG}', '${CONV1}');`)).toContain(
      "caller_not_authorized_for_org",
    );
  });

  it("admin da OUTRA organização é recusado", () => {
    expect(erroDe(`${comoMembro(VIZINHO)} select public.fn_passagem_aceitar('${ORG}', '${CONV1}');`)).toContain(
      "caller_not_authorized_for_org",
    );
    expect(campo("estado")).toBe("atribuida");
  });

  it("NÃO é executável pela anon key", () => {
    expect(erroDe(`set role anon; select public.fn_passagem_aceitar('${ORG}', '${CONV1}');`)).toContain(
      "permission denied",
    );
  });

  it("o responsável aceita, o aviso da Central fecha, e a segunda chamada é idempotente", () => {
    const primeira = texto(`${comoMembro(DONO)} select public.fn_passagem_aceitar('${ORG}', '${CONV1}')::text;`);
    expect(JSON.parse(primeira)).toEqual({ aceitas: 1, ja_aceita: false });
    expect(campo("estado")).toBe("aceita");
    expect(campo("aceita_por")).toBe(DONO);
    expect(
      texto(`select count(*) from public.agent_inbox_items
              where organization_id = '${ORG}' and kind = 'handoff' and status = 'open';`),
    ).toBe("0");
    const aceitaEm = campo("aceita_em");
    const segunda = texto(`${comoMembro(DONO)} select public.fn_passagem_aceitar('${ORG}', '${CONV1}')::text;`);
    expect(JSON.parse(segunda)).toEqual({ aceitas: 0, ja_aceita: true });
    expect(campo("aceita_em"), "o carimbo do aceite é um fato").toBe(aceitaEm);
  });

  it("admin aceita a passagem de outro responsável", () => {
    texto(`${comoMembro(CHEFE)} select public.fn_passagem_aceitar('${ORG}', '${CONV1}')::text;`);
    expect(campo("estado")).toBe("aceita");
    expect(campo("aceita_por")).toBe(CHEFE);
  });

  it("ninguém reescreve o estado pela REST: `authenticated` não tem UPDATE", () => {
    expect(
      erroDe(`${comoMembro(DONO)} update public.passagens_de_atendimento set estado = 'aceita' where organization_id = '${ORG}';`),
    ).toContain("permission denied");
  });
});

describe("9401 — RLS das colunas novas", () => {
  it("o vizinho não lê a passagem (nem o estado) de outra organização; o dono lê", () => {
    sql(`update public.conversations set assigned_to_user_id = '${DONO}', assignee_kind = 'user' where id = '${CONV1}';`);
    inserirPassagem();
    const consulta = `select count(*) from public.passagens_de_atendimento
                       where organization_id = '${ORG}' and estado is not null`;
    expect(texto(`${comoMembro(DONO)} ${consulta};`), "controle positivo").toBe("1");
    expect(texto(`${comoMembro(VIZINHO)} ${consulta};`)).toBe("0");
  });
});

describe("9401 — resolver e reabrir", () => {
  it("fechar a conversa resolve; a próxima passagem nasce `reaberta`", () => {
    inserirPassagem();
    sql(`update public.conversations set status = 'closed' where id = '${CONV1}';`);
    expect(campo("estado")).toBe("resolvida");
    expect(campo("resolvida_em")).not.toBe("<null>");
    sql(`update public.conversations set status = 'open' where id = '${CONV1}';`);
    inserirPassagem();
    expect(campo("estado")).toBe("reaberta");
  });

  it("devolver ao automático resolve até a passagem já aceita", () => {
    inserirPassagem();
    sql(`${comJwt(DONO)}
         select public.fn_conversation_assign('${ORG}', '${CONV1}', '${DONO}', 'claim', null, true);`);
    expect(campo("estado")).toBe("aceita");
    sql(`select public.fn_passagem_devolvida('${ORG}', '${CONV1}');`);
    expect(campo("estado")).toBe("resolvida");
  });

  it("a passagem de OUTRA conversa não é tocada pelo fechamento", () => {
    inserirPassagem(CONV2, C2);
    sql(`update public.conversations set status = 'closed' where id = '${CONV1}';`);
    expect(campo("estado", CONV2)).toBe("pendente");
  });
});

describe("9401 — a varredura pode perguntar o responsável de novo", () => {
  // `lib/escalacao/responsavel-tardio.ts` chama esta função pela service key
  // (PostgREST rpc) para a passagem viva que nasceu antes da rota por etiqueta.
  // Ela só existe se a service_role puder executá-la — e a anon key não pode.
  const assinatura = "public.fn_passagem_responsavel_inicial(uuid, uuid, uuid)";
  it("service_role executa; anon e authenticated não", () => {
    expect(sql(`select has_function_privilege('service_role', '${assinatura}', 'execute');`).trim()).toBe("t");
    expect(sql(`select has_function_privilege('anon', '${assinatura}', 'execute');`).trim()).toBe("f");
    expect(sql(`select has_function_privilege('authenticated', '${assinatura}', 'execute');`).trim()).toBe("f");
  });

  it("a rota salva DEPOIS da passagem: nada a alcança sozinho, e perguntar de novo acha o responsável", () => {
    // A etiqueta chega ANTES da rota existir (a ordem medida em produção).
    sql(`update public.conversations set tags = array['projeto'] where id = '${CONV2}';`);
    inserirPassagem(CONV2, C2);
    expect(campo("responsavel_user_id", CONV2)).toBe("<null>");
    // A rota é salva depois: nenhum gatilho roda, a passagem segue sem ninguém.
    sql(`update public.organizations
            set settings = '{"escalonamento_de_passagem":{"rota_por_etiqueta":{"projeto":"${DONO}"}}}'::jsonb
          where id = '${ORG}';`);
    expect(campo("responsavel_user_id", CONV2)).toBe("<null>");
    // A pergunta que a varredura faz (a mesma função do nascimento) acha o dono.
    expect(
      texto(`select coalesce(public.fn_passagem_responsavel_inicial('${ORG}', '${CONV2}', '${C2}')::text, '<null>');`),
    ).toBe(DONO);
  });
});

describe("9402 — uma passagem viva por conversa", () => {
  function contar(estado: string, conversa = CONV1): string {
    return texto(`select count(*) from public.passagens_de_atendimento
                   where organization_id = '${ORG}' and conversation_id = '${conversa}' and estado = '${estado}';`);
  }

  it("a segunda passagem da mesma conversa sucede a primeira: herda responsável e urgência, a anterior fecha", () => {
    inserirPassagem(CONV1, C1);
    sql(`update public.passagens_de_atendimento set responsavel_user_id = '${DONO}', estado = 'atribuida', urgente = true
          where organization_id = '${ORG}' and conversation_id = '${CONV1}';`);
    inserirPassagem(CONV1, C1);
    expect(contar("resolvida")).toBe("1");
    expect(campo("estado")).toBe("atribuida");
    expect(campo("responsavel_user_id")).toBe(DONO);
    expect(campo("urgente")).toBe("true");
    expect(texto(`select count(*) from public.passagens_de_atendimento where organization_id = '${ORG}'
                   and conversation_id = '${CONV1}' and estado in ('pendente','atribuida','reaberta');`)).toBe("1");
  });

  it("a passagem de OUTRA conversa não é tocada", () => {
    inserirPassagem(CONV1, C1);
    inserirPassagem(CONV2, C2);
    expect(contar("pendente", CONV1)).toBe("1");
    expect(contar("pendente", CONV2)).toBe("1");
  });

  it("passagem já ACEITA não é fechada pela nova", () => {
    inserirPassagem(CONV1, C1);
    sql(`update public.passagens_de_atendimento set estado = 'aceita', responsavel_user_id = '${DONO}', aceita_em = now(), aceita_por = '${DONO}'
          where organization_id = '${ORG}' and conversation_id = '${CONV1}';`);
    inserirPassagem(CONV1, C1);
    expect(contar("aceita")).toBe("1");
    expect(contar("resolvida")).toBe("0");
  });

  it("o backfill fecha as duplicadas que já existem e a mais nova herda; rodar de novo não muda nada", () => {
    // Reproduz o estado de antes da 9402: os gatilhos desligados, duas vivas.
    sql(`alter table public.passagens_de_atendimento disable trigger trg_passagem_encerra_a_anterior;
         alter table public.passagens_de_atendimento disable trigger trg_passagem_sucede_a_viva;`);
    try {
      inserirPassagem(CONV1, C1);
      sql(`update public.passagens_de_atendimento set responsavel_user_id = '${DONO}', estado = 'atribuida'
            where organization_id = '${ORG}' and conversation_id = '${CONV1}';`);
      inserirPassagem(CONV1, C1);
    } finally {
      sql(`alter table public.passagens_de_atendimento enable trigger trg_passagem_encerra_a_anterior;
           alter table public.passagens_de_atendimento enable trigger trg_passagem_sucede_a_viva;`);
    }
    expect(texto(`select count(*) from public.passagens_de_atendimento where organization_id = '${ORG}'
                   and conversation_id = '${CONV1}' and estado in ('pendente','atribuida','reaberta');`)).toBe("2");
    const migracao = readFileSync(
      join(process.cwd(), "supabase/migrations/20261116210000_9402_passagem_viva_unica_por_conversa.sql"),
      "utf8",
    );
    const backfill = migracao.slice(migracao.indexOf("-- Backfill"));
    sql(backfill);
    expect(contar("resolvida")).toBe("1");
    expect(campo("estado")).toBe("atribuida");
    expect(campo("responsavel_user_id")).toBe(DONO);
    sql(backfill);
    expect(contar("resolvida")).toBe("1");
  });
});
