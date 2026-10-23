-- CRM Viver de Shopee — schema do Supabase
-- Cole tudo isto em Supabase → SQL Editor → New query → Run.
-- Pode rodar de novo sem problema (é idempotente).

-- ---------------------------------------------------------------------------
-- Leads / alunos (um registro por linha, usado pelo Funil, Leads e Clientes)
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  id           text primary key default gen_random_uuid()::text,
  nome         text not null,
  email        text,
  wa           text,
  tel          text,
  ja_vende     text,
  nicho        text,
  nivel        text,
  objetivo     text,
  invest       numeric default 0,
  fat_shopee   numeric default 0,
  origem       text,
  resp         text,
  stage        text not null default 'novo',   -- chave da etapa do funil (novo, contato, ...)
  valor        numeric default 0,
  prob         int default 50,
  pri          text default 'media',           -- alta | media | baixa
  follow       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists leads_stage_idx on public.leads (stage);
create index if not exists leads_created_idx on public.leads (created_at desc);

-- ---------------------------------------------------------------------------
-- Estado compartilhado da equipe: tarefas, agenda, equipe, meta, etapas do
-- funil, histórico e automação. Uma linha por "fatia" (chave → JSON).
-- ---------------------------------------------------------------------------
create table if not exists public.kv (
  key         text primary key,
  value       jsonb not null default 'null'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Mantém updated_at sempre correto
create or replace function public.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();

drop trigger if exists kv_touch on public.kv;
create trigger kv_touch before update on public.kv
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Segurança (RLS): só quem está logado enxerga/edita. Visitantes sem login
-- (anon) não têm acesso a nada. Todos os usuários logados são a mesma equipe.
-- ---------------------------------------------------------------------------
alter table public.leads enable row level security;
alter table public.kv    enable row level security;

drop policy if exists "equipe_leads" on public.leads;
create policy "equipe_leads" on public.leads
  for all to authenticated using (true) with check (true);

drop policy if exists "equipe_kv" on public.kv;
create policy "equipe_kv" on public.kv
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Tempo real: atualiza a tela dos outros usuários quando algo muda
-- ---------------------------------------------------------------------------
do $$
begin
  begin alter publication supabase_realtime add table public.leads; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.kv;    exception when duplicate_object then null; end;
end $$;

-- ---------------------------------------------------------------------------
-- Anotações avançadas do lead (histórico detalhado: chamadas de vídeo, como o
-- lead começou, objeções...). Uma linha por anotação; some junto com o lead.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_notas (
  id           text primary key default gen_random_uuid()::text,
  lead_id      text not null references public.leads(id) on delete cascade,
  tipo         text not null default 'Observação',
  titulo       text not null,
  texto        text not null default '',
  data_evento  timestamptz not null default now(),   -- quando a conversa aconteceu
  autor        text,
  editado_por  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists lead_notas_lead_idx on public.lead_notas (lead_id, data_evento desc);

drop trigger if exists lead_notas_touch on public.lead_notas;
create trigger lead_notas_touch before update on public.lead_notas
  for each row execute function public.touch_updated_at();

alter table public.lead_notas enable row level security;

drop policy if exists "equipe_lead_notas" on public.lead_notas;
create policy "equipe_lead_notas" on public.lead_notas
  for all to authenticated using (true) with check (true);

do $$
begin
  begin alter publication supabase_realtime add table public.lead_notas; exception when duplicate_object then null; end;
end $$;

-- ---------------------------------------------------------------------------
-- Formulário público (formulario.html): perguntas editáveis pelo CRM, respostas
-- recebidas e a função que transforma cada envio em lead já classificado.
-- ---------------------------------------------------------------------------
create table if not exists public.formularios (
  slug        text primary key,
  config      jsonb not null default '{}'::jsonb,   -- textos, perguntas, regras de classificação
  updated_at  timestamptz not null default now()
);

drop trigger if exists formularios_touch on public.formularios;
create trigger formularios_touch before update on public.formularios
  for each row execute function public.touch_updated_at();

create table if not exists public.form_respostas (
  id          text primary key default gen_random_uuid()::text,
  slug        text not null,
  lead_id     text references public.leads(id) on delete set null,
  respostas   jsonb not null,                        -- { id_da_pergunta: resposta }
  pontos      int not null default 0,
  prioridade  text,
  reenvio     boolean not null default false,        -- true = a pessoa já era lead
  created_at  timestamptz not null default now()
);

create index if not exists form_respostas_slug_idx on public.form_respostas (slug, created_at desc);

alter table public.formularios    enable row level security;
alter table public.form_respostas enable row level security;

-- Qualquer pessoa pode LER as perguntas (a página pública precisa); só a equipe edita.
drop policy if exists "publico_le_formulario" on public.formularios;
create policy "publico_le_formulario" on public.formularios
  for select to anon, authenticated using (true);

drop policy if exists "equipe_formularios" on public.formularios;
create policy "equipe_formularios" on public.formularios
  for all to authenticated using (true) with check (true);

-- Respostas: só a equipe lê. Visitantes gravam apenas pela função abaixo.
drop policy if exists "equipe_form_respostas" on public.form_respostas;
create policy "equipe_form_respostas" on public.form_respostas
  for all to authenticated using (true) with check (true);

-- Recebe um envio do formulário público: valida, classifica (nível, prioridade,
-- etapa do funil), cria o lead (ou reaproveita se o telefone/e-mail já existe)
-- e guarda todas as respostas numa anotação do lead. Roda com permissão do
-- dono do banco (security definer) porque o visitante não tem login.
create or replace function public.enviar_formulario(
  p_slug text, p_respostas jsonb, p_hp text default '', p_origem text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg jsonb; q jsonb; o jsonb; v jsonb; stages jsonb;
  vals text[]; rotulos text[];
  val text; qid text; tipo text; campo text; primeiro text;
  v_nome text := ''; v_sobrenome text := ''; v_email text; v_wa text;
  v_ja_vende text; v_nivel text; v_nicho text; v_objetivo text; v_origem text;
  v_invest numeric := 0; v_fat numeric := 0; v_valor numeric := 0;
  v_pontos int := 0; v_pri text; v_prob int; v_stage text;
  v_nota text := ''; v_lead_id text; v_reenvio boolean := false; v_dig text;
  v_alta int := 9; v_media int := 5;
begin
  -- Campo-isca escondido: se veio preenchido é robô; finge sucesso e descarta.
  if coalesce(p_hp, '') <> '' then return jsonb_build_object('ok', true); end if;

  if p_respostas is null or jsonb_typeof(p_respostas) <> 'object' or pg_column_size(p_respostas) > 30000 then
    raise exception 'Envio inválido.';
  end if;

  select f.config into cfg from public.formularios f where f.slug = p_slug;
  if cfg is null then raise exception 'Formulário indisponível.'; end if;

  -- Freio simples contra enxurrada de envios falsos.
  if (select count(*) from public.form_respostas r where r.created_at > now() - interval '1 minute') >= 40 then
    raise exception 'Muitos envios ao mesmo tempo. Tente de novo em instantes.';
  end if;

  for q in select e.value from jsonb_array_elements(coalesce(cfg->'perguntas', '[]'::jsonb)) e loop
    qid := q->>'id'; tipo := q->>'tipo'; campo := coalesce(q->>'campo', '');
    v := p_respostas -> qid;

    if v is null or v = 'null'::jsonb or v = '""'::jsonb or v = '[]'::jsonb then
      if coalesce((q->>'obrigatoria')::boolean, false) then raise exception 'Responda: %', q->>'pergunta'; end if;
      continue;
    end if;

    if tipo in ('single_select', 'multi_select') then
      if jsonb_typeof(v) = 'array' then
        select coalesce(array_agg(x.value), '{}') into vals from jsonb_array_elements_text(v) x;
      else
        vals := array[v #>> '{}'];
      end if;
      rotulos := '{}'; primeiro := null;
      foreach val in array vals loop
        select oo.value into o from jsonb_array_elements(coalesce(q->'opcoes', '[]'::jsonb)) oo where oo.value->>'id' = val limit 1;
        if o is null then continue; end if; -- id que não existe no formulário: ignora
        rotulos := rotulos || (o->>'label');
        v_pontos := v_pontos + case when (o->>'pontos') ~ '^[0-9]{1,3}$' then (o->>'pontos')::int else 0 end;
        if primeiro is null then primeiro := coalesce(nullif(o->>'valor', ''), o->>'label'); end if;
      end loop;

      if coalesce(array_length(rotulos, 1), 0) = 0 then
        if coalesce((q->>'obrigatoria')::boolean, false) then raise exception 'Responda: %', q->>'pergunta'; end if;
        continue;
      end if;
      v_nota := v_nota || '• ' || (q->>'pergunta') || ': ' || array_to_string(rotulos, ', ') || E'\n';

      if tipo = 'single_select' then
        if campo = 'ja_vende' then v_ja_vende := case when primeiro in ('Sim', 'Não') then primeiro else null end;
        elsif campo = 'nivel' then v_nivel := left(primeiro, 80);
        elsif campo = 'nicho' then v_nicho := left(primeiro, 80);
        elsif campo = 'objetivo' then v_objetivo := left(primeiro, 80);
        elsif campo = 'origem' then v_origem := left(primeiro, 40);
        elsif campo = 'invest' then v_invest := case when primeiro ~ '^[0-9]+(\.[0-9]+)?$' then primeiro::numeric else 0 end;
        elsif campo = 'fat_shopee' then v_fat := case when primeiro ~ '^[0-9]+(\.[0-9]+)?$' then primeiro::numeric else 0 end;
        end if;
      end if;
    else
      val := left(btrim(v #>> '{}'), case when tipo = 'long_text' then 2000 else 300 end);
      if val = '' then
        if coalesce((q->>'obrigatoria')::boolean, false) then raise exception 'Responda: %', q->>'pergunta'; end if;
        continue;
      end if;
      if tipo = 'email' and val !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'E-mail inválido.'; end if;
      if tipo = 'phone' and length(regexp_replace(val, '\D', '', 'g')) not between 10 and 13 then
        raise exception 'Telefone inválido. Confira o DDD e o número.';
      end if;
      v_nota := v_nota || '• ' || (q->>'pergunta') || ': ' || val || E'\n';

      if campo = 'nome' then v_nome := val;
      elsif campo = 'sobrenome' then v_sobrenome := val;
      elsif campo = 'email' then v_email := lower(val);
      elsif campo = 'wa' then v_wa := val;
      elsif campo = 'nicho' then v_nicho := val;
      elsif campo = 'objetivo' then v_objetivo := val;
      end if;
    end if;
  end loop;

  v_nome := btrim(v_nome || ' ' || v_sobrenome);
  if length(v_nome) < 2 then raise exception 'Informe seu nome.'; end if;
  if coalesce(v_wa, '') = '' and coalesce(v_email, '') = '' then
    raise exception 'Informe um telefone ou e-mail para contato.';
  end if;

  -- Nível: se nenhuma pergunta define, deduz do faturamento informado.
  if v_nivel is null then
    v_nivel := case when v_fat <= 0 then 'Ainda não vende' when v_fat < 20000 then 'Iniciante'
                    when v_fat < 100000 then 'Já vende (escalando)' else 'Vendedor avançado' end;
  end if;
  if v_ja_vende is null then v_ja_vende := case when v_nivel = 'Ainda não vende' then 'Não' else 'Sim' end; end if;

  v_origem := left(coalesce(nullif(btrim(v_origem), ''), nullif(btrim(p_origem), ''), nullif(btrim(cfg->>'origem'), ''), 'Formulário'), 40);

  -- Prioridade, probabilidade e etapa do funil a partir da pontuação.
  if (cfg #>> '{classificacao,alta}') ~ '^[0-9]{1,3}$' then v_alta := (cfg #>> '{classificacao,alta}')::int; end if;
  if (cfg #>> '{classificacao,media}') ~ '^[0-9]{1,3}$' then v_media := (cfg #>> '{classificacao,media}')::int; end if;
  v_pri := case when v_pontos >= v_alta then 'alta' when v_pontos >= v_media then 'media' else 'baixa' end;
  v_prob := case v_pri when 'alta' then 70 when 'media' then 50 else 30 end;
  v_stage := coalesce(nullif(cfg #>> array['etapas', v_pri], ''), 'novo');

  -- Se a etapa configurada foi apagada do funil, cai na primeira etapa existente.
  select k.value into stages from public.kv k where k.key = 'stages';
  if stages is not null and jsonb_typeof(stages) = 'array' and jsonb_array_length(stages) > 0
     and not exists (select 1 from jsonb_array_elements(stages) s where s.value->>'id' = v_stage) then
    v_stage := coalesce(stages->0->>'id', 'novo');
  end if;

  if (cfg->>'valorPlano') ~ '^[0-9]+(\.[0-9]+)?$' then v_valor := (cfg->>'valorPlano')::numeric; end if;

  -- Já é lead? (mesmo telefone ou e-mail) — não duplica, só registra o novo envio.
  v_dig := right(regexp_replace(coalesce(v_wa, ''), '\D', '', 'g'), 10);
  if length(v_dig) = 10 then
    select l.id into v_lead_id from public.leads l
      where right(regexp_replace(coalesce(l.wa, ''), '\D', '', 'g'), 10) = v_dig limit 1;
  end if;
  if v_lead_id is null and coalesce(v_email, '') <> '' then
    select l.id into v_lead_id from public.leads l where lower(l.email) = v_email limit 1;
  end if;

  if v_lead_id is not null then
    v_reenvio := true;
  else
    v_lead_id := gen_random_uuid()::text;
    insert into public.leads (id, nome, email, wa, tel, ja_vende, nicho, nivel, objetivo, invest, fat_shopee, origem, stage, valor, prob, pri)
    values (v_lead_id, left(v_nome, 120), v_email, v_wa, v_wa, v_ja_vende, v_nicho, v_nivel, v_objetivo, v_invest, v_fat, v_origem, v_stage, v_valor, v_prob, v_pri);
  end if;

  insert into public.lead_notas (id, lead_id, tipo, titulo, texto, data_evento, autor)
  values (gen_random_uuid()::text, v_lead_id, 'Como começou',
          case when v_reenvio then 'Novo envio do formulário' else 'Respostas do formulário' end,
          left(btrim(v_nota), 4500) || E'\n\nPontuação: ' || v_pontos::text || ' · Prioridade: ' || v_pri || ' · Origem: ' || v_origem,
          now(), 'Formulário');

  insert into public.form_respostas (slug, lead_id, respostas, pontos, prioridade, reenvio)
  values (p_slug, v_lead_id, p_respostas, v_pontos, v_pri, v_reenvio);

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.enviar_formulario(text, jsonb, text, text) from public;
grant execute on function public.enviar_formulario(text, jsonb, text, text) to anon, authenticated;
