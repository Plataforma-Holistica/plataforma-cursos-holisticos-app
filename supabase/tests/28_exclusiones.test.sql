-- T-208 · Exclusiones de consumo (RF-404, RN-08, RN-17; 05 §5.4 y §8.2). Decisiones de Sergio del
-- 2026-10-21: las exclusiones las crea finanzas (con su código reciente y un motivo escrito); solo
-- la de fraude exige una alerta decidida como fraude; una cuenta suspendida por fraude pierde todo
-- su consumo de los periodos abiertos.
--
-- Una exclusión es una regla, no un borrado: el latido no se toca. La consolidación la aplica en
-- `private.rollup_pair()` (por cuenta, por reproducción o por tramo de una lección), y crearla o
-- revertirla marca los pares que cambian para la corrida siguiente. Revertir restaura.
--
-- En una prueba de base todo corre en una transacción y `now()` no avanza.
begin;
\ir _ayuda.psql
select plan(64);

-- El mes anterior, abierto (T-601): sus latidos atrasados entran hasta su día de cierre, y así esta
-- prueba no depende de qué día del mes corre. Sin el guardián, que no deja volver a abierto.
select pruebas.como_dueno_sistema();
alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
insert into public.payout_periods (period_id, starts_at, ends_at, timezone)
select m.p, timezone('America/Mexico_City', to_date(m.p::text || '01', 'YYYYMMDD')::timestamp),
       timezone('America/Mexico_City', to_date(m.p::text || '01', 'YYYYMMDD')::timestamp + interval '1 month'), 'America/Mexico_City'
from (select to_char(date_trunc('month', timezone('America/Mexico_City', now())) - interval '1 month', 'YYYYMM')::integer as p) m
on conflict (period_id) do update set status = 'open', entered_closing_at = null;
alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
select pruebas.limpiar();

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana-excluye@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto-excluye@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido-excluye@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000002', 'finanzas-excluye@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-excluye@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000002', 'finance');
select pruebas.equipar('b0000000-0000-0000-0000-000000000002');

create function pruebas.ana() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.beto() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b0000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.computadora() returns uuid language sql immutable as $$ select 'c2800000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.telefono() returns uuid language sql immutable as $$ select 'c2800000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.periodo(p_months_back integer default 0) returns integer
language sql stable as $$
  select to_char(date_trunc('month', timezone('America/Mexico_City', now())) - make_interval(months => p_months_back), 'YYYYMM')::integer
$$;
create function pruebas.como(p_id uuid, p_session uuid) returns void
language plpgsql as $$
begin
  perform pruebas.a_nombre_de(p_id, p_session);
  perform set_config('app.actor_session', coalesce(p_session::text, ''), true);
end
$$;
create function pruebas.leccion(p_title text) returns uuid
language sql as $$
  select l.id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id
  where c.slug = 'curso-excluye' and l.title = p_title
$$;
create function pruebas.video(p_lesson uuid) returns text
language sql as $$
  select v.provider_playback_id from public.published_lessons l join public.video_assets v on v.id = l.video_asset_id
  where l.id = p_lesson
$$;
-- Abre una reproducción de la lección; las anteriores de la cuenta ya vencieron (una a la vez).
create function pruebas.abre(p_id uuid, p_session uuid, p_lesson uuid) returns uuid
language plpgsql as $$
declare
  v jsonb;
begin
  update public.playback_sessions set last_heartbeat_at = least(last_heartbeat_at, now() - interval '10 minutes')
  where profile_id = p_id;
  perform pruebas.como(p_id, p_session);
  select private.open_playback(p_lesson, pruebas.video(p_lesson), 'subscription', true, null) into v;
  perform pruebas.limpiar();
  if v ->> 'outcome' <> 'opened' then
    raise exception 'no abrió: %', v;
  end if;
  update public.playback_sessions set live_seconds = 100000, started_at = now() - interval '1 hour'
  where id = (v ->> 'session_id')::uuid;
  return (v ->> 'session_id')::uuid;
end
$$;
create function pruebas.registra(p_id uuid, p_session uuid, p_playback uuid, p_events jsonb) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como(p_id, p_session);
  select private.record_heartbeats(p_playback, p_events, true,
                                   (private.heartbeat_target(p_playback) ->> 'at')::timestamptz) into v;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.tramo(p_seq integer, p_from integer, p_to integer) returns jsonb
language sql immutable as $$
  select jsonb_build_object('seq', p_seq, 'from', p_from, 'to', p_to, 'rate', 1, 'visible', true)
$$;
create function pruebas.consolidado(p_id uuid, p_lesson uuid) returns public.watch_rollup
language sql as $$
  select * from public.watch_rollup where period_id = pruebas.periodo() and profile_id = p_id and lesson_id = p_lesson
$$;
create function pruebas.cubiertos(p_id uuid, p_lesson uuid) returns integer
language sql as $$ select (pruebas.consolidado(p_id, p_lesson)).covered_seconds $$;
create function pruebas.marca(p_id uuid, p_lesson uuid) returns timestamptz
language sql as $$
  select touched_at from private.rollup_dirty where period_id = pruebas.periodo() and profile_id = p_id and lesson_id = p_lesson
$$;
-- Consolida el periodo en curso como la corrida de cada noche: lo marcado hasta ahora.
create function pruebas.consolida() returns void
language plpgsql as $$
declare
  v_run uuid := private.open_job_run('nightly_rollup', pruebas.periodo(), 'dirty');
  v jsonb;
begin
  loop
    v := private.rollup_step(v_run, clock_timestamp());
    exit when (v ->> 'read')::integer = 0;
  end loop;
  perform private.close_job_run(v_run, null);
end
$$;
-- Lo que contesta una decisión de finanzas, como el servidor a nombre de quien la pide.
create function pruebas.excluye(p_actor uuid, p_scope text, p_profile uuid, p_reason_code text default 'technical_error',
                                p_reason text default 'Una prueba de la plataforma.', p_period integer default null,
                                p_session uuid default null, p_lesson uuid default null, p_from integer default null,
                                p_to integer default null, p_alert uuid default null) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_actor);
  select private.exclude_consumption(p_scope::public.exclusion_scope, coalesce(p_period, pruebas.periodo()), p_profile,
                                     p_session, p_lesson, p_from, p_to, p_reason_code, p_reason, p_alert) into v;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.revierte(p_actor uuid, p_exclusion uuid, p_reason text default 'Era un error.') returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_actor);
  select private.revoke_exclusion(p_exclusion, p_reason) into v;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.curso() returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', 'curso-excluye', 'title', 'Curso excluye', 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', (
      select jsonb_agg(jsonb_build_object('title', t, 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'AssetExcluye' || n, 'playback_id', 'PlaybackExcluye' || n, 'duration_seconds', 100)) order by n)
      from unnest(array['Uno', 'Dos', 'Tres']) with ordinality as l (t, n)))))
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
create temporary table maestra as select private.system_add_teacher('Maestra que excluye', 'maestra-que-excluye', null) as id;
select private.system_load_course((select id from maestra), pruebas.curso());
select pruebas.limpiar();
select is(pruebas.pide('b0000000-0000-0000-0000-000000000001',
  format('private.approve_course(%L)', course_id)), 'approved', 'se aprueba el curso')
  from public.published_courses where slug = 'curso-excluye';
select pruebas.como_dueno();
insert into private.app_sessions (session_id, profile_id) values
  (pruebas.computadora(), pruebas.ana()), (pruebas.telefono(), pruebas.ana()),
  (pruebas.sesion(pruebas.beto()), pruebas.beto());
create temporary table r (name text primary key, id uuid);
grant select, insert on r to app_service, authenticated;

-- ---------------------------------------------------------------------------------------
-- Las tablas y quién las toca: nadie de la aplicación directo. El servidor llega por funciones.

select has_table('public', 'consumption_exclusions', 'existen las exclusiones');
select has_table('public', 'anomaly_alerts', 'y las alertas');
select ok(not exists (
  select 1 from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r (rolname)
  cross join unnest(array['public.consumption_exclusions', 'public.anomaly_alerts']) as t (name)
  where has_any_column_privilege(r.rolname, t.name, 'SELECT, INSERT, UPDATE, REFERENCES')
     or has_table_privilege(r.rolname, t.name, 'DELETE, TRUNCATE, TRIGGER')),
  'nadie de la aplicación las lee ni las escribe');
select ok(not has_column_privilege('app_service', 'public.profiles', 'suspended_for_fraud', 'UPDATE'),
  'ni el servidor prende la marca de fraude de una cuenta');
select ok(has_function_privilege('app_service', f, 'execute')
          and not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, f, 'execute')),
  'las decisiones de finanzas, solo el servidor: ' || f)
from unnest(array[
  'private.exclude_consumption(public.exclusion_scope, public.period_id, uuid, uuid, uuid, integer, integer, text, text, uuid)',
  'private.revoke_exclusion(uuid, text)']) as f;
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) r
                      where has_function_privilege(r, 'private.mark_pairs_for(uuid, public.period_id, uuid, uuid)', 'execute')),
  'marcar pares, nadie de la aplicación');

-- ---------------------------------------------------------------------------------------
-- El consumo de partida: Ana ve las tres lecciones (Uno desde dos aparatos), Beto, una.

insert into r values ('a1', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Uno')));
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a1'),
  jsonb_build_array(pruebas.tramo(0, 0, 40)));
insert into r values ('a2', pruebas.abre(pruebas.ana(), pruebas.telefono(), pruebas.leccion('Uno')));
select pruebas.registra(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'a2'),
  jsonb_build_array(pruebas.tramo(0, 40, 80)));
insert into r values ('a3', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Dos')));
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a3'),
  jsonb_build_array(pruebas.tramo(0, 0, 100)));
insert into r values ('a4', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Tres')));
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a4'),
  jsonb_build_array(pruebas.tramo(0, 0, 100)));
insert into r values ('b1', pruebas.abre(pruebas.beto(), pruebas.sesion(pruebas.beto()), pruebas.leccion('Uno')));
select pruebas.registra(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'b1'),
  jsonb_build_array(pruebas.tramo(0, 0, 100)));
select pruebas.consolida();
select is(array[pruebas.cubiertos(pruebas.ana(), pruebas.leccion('Uno')), pruebas.cubiertos(pruebas.ana(), pruebas.leccion('Dos')),
                pruebas.cubiertos(pruebas.beto(), pruebas.leccion('Uno'))], array[80, 100, 100], 'el consolidado de partida');
create temporary table antes as select * from public.watch_rollup where profile_id = pruebas.ana();

-- ---------------------------------------------------------------------------------------
-- La puerta: finanzas, con su código reciente.

select is(pruebas.excluye(pruebas.ana(), 'account', pruebas.ana()) ->> 'outcome', 'forbidden', 'una alumna no excluye nada');
select is(pruebas.excluye('b0000000-0000-0000-0000-000000000001', 'account', pruebas.ana()) ->> 'outcome', 'forbidden',
  'ni alguien del equipo sin finanzas');
select pruebas.sin_codigo(pruebas.finanzas());
select is(pruebas.excluye(pruebas.finanzas(), 'account', pruebas.ana()) ->> 'outcome', 'needs_fresh_code',
  'finanzas sin su código reciente da su código otra vez');
select pruebas.equipar(pruebas.finanzas());

-- Lo que no tiene forma no llega a la tabla.
select is(pruebas.excluye(pruebas.finanzas(), 'account', pruebas.ana(), 'technical_error', '   ') ->> 'outcome', 'malformed',
  'sin motivo escrito, no');
select is(pruebas.excluye(pruebas.finanzas(), 'account', pruebas.ana(), 'otra_cosa') ->> 'outcome', 'malformed',
  'un motivo fuera de la lista, no');
select is(pruebas.excluye(pruebas.finanzas(), 'interval', pruebas.ana(), p_lesson => pruebas.leccion('Dos'), p_from => 30, p_to => 30) ->> 'outcome',
  'malformed', 'un tramo vacío, no');
select is(pruebas.excluye(pruebas.finanzas(), 'account', 'a0000000-0000-0000-0000-0000000000ff') ->> 'outcome', 'not_found',
  'una cuenta que no existe');
select is(pruebas.excluye(pruebas.finanzas(), 'account', pruebas.ana(), p_period => pruebas.periodo(2)) ->> 'outcome', 'outside_window',
  'un periodo que ya no recibe latidos no se toca');
select is(pruebas.excluye(pruebas.finanzas(), 'account', pruebas.ana(), 'fraud') ->> 'outcome', 'needs_fraud_decision',
  'por fraude, sin una alerta decidida como fraude, no');
select is((select count(*)::integer from public.consumption_exclusions), 0, 'y nada quedó escrito');

-- ---------------------------------------------------------------------------------------
-- Por cuenta: todo su consumo del periodo sale, y revertir lo restaura.

-- Una marca que ya existía se renueva: así una corrida que la leyó antes no la borra.
insert into private.rollup_dirty (period_id, profile_id, lesson_id, touched_at)
values (pruebas.periodo(), pruebas.ana(), pruebas.leccion('Uno'), now() - interval '1 hour');
insert into r select 'cuenta', (pruebas.excluye(pruebas.finanzas(), 'account', pruebas.ana()) -> 'ids' ->> 0)::uuid;
select isnt((select id from r where name = 'cuenta'), null, 'se excluye la cuenta');
select ok(pruebas.marca(pruebas.ana(), pruebas.leccion('Uno')) > now() - interval '1 minute',
  'la marca que ya estaba se renueva con la hora de la decisión');
select is((select count(*)::integer from private.rollup_dirty where period_id = pruebas.periodo() and profile_id = pruebas.ana()), 3,
  'y quedan marcadas sus tres lecciones');
select is(pruebas.excluye(pruebas.finanzas(), 'account', pruebas.ana()) ->> 'outcome', 'already_excluded', 'otra igual, no');
select is((select row(created_by, reason_code, scope)::text from public.consumption_exclusions where id = (select id from r where name = 'cuenta')),
  row(pruebas.finanzas(), 'technical_error', 'account')::text, 'con quién la decidió y por qué');
select ok(exists (select 1 from public.audit_log where entity_table = 'public.consumption_exclusions'
                  and entity_id = (select id from r where name = 'cuenta')::text and category = 'money'),
  'y queda en la auditoría');
select pruebas.consolida();
select is((select count(*)::integer from public.watch_rollup where period_id = pruebas.periodo() and profile_id = pruebas.ana()), 0,
  'la consolidación ya no cuenta nada de esa cuenta');
select is(pruebas.cubiertos(pruebas.beto(), pruebas.leccion('Uno')), 100, 'lo de otra cuenta sigue igual');
select is((select count(*)::integer from public.watch_events where period_id = pruebas.periodo() and profile_id = pruebas.ana()), 4,
  'el libro no se toca');

select is(pruebas.revierte(pruebas.ana(), (select id from r where name = 'cuenta')) ->> 'outcome', 'forbidden',
  'revertir, tampoco una alumna');
select is(pruebas.revierte(pruebas.finanzas(), (select id from r where name = 'cuenta'), '') ->> 'outcome', 'malformed',
  'ni sin motivo');
select is(pruebas.revierte(pruebas.finanzas(), (select id from r where name = 'cuenta')) ->> 'outcome', 'revoked', 'se revierte');
select is(pruebas.revierte(pruebas.finanzas(), (select id from r where name = 'cuenta')) ->> 'outcome', 'already_revoked', 'una sola vez');
select is(pruebas.revierte(pruebas.finanzas(), gen_random_uuid()) ->> 'outcome', 'not_found', 'una que no existe');
select is((select count(*)::integer from private.rollup_dirty where period_id = pruebas.periodo() and profile_id = pruebas.ana()), 3,
  'revertir vuelve a marcar sus lecciones, aunque el consolidado ya no tenga sus filas: salen del libro');
select pruebas.consolida();
select is((select array_agg(row(lesson_id, covered_seconds, half_points)::text order by lesson_id)
           from public.watch_rollup where period_id = pruebas.periodo() and profile_id = pruebas.ana()),
  (select array_agg(row(lesson_id, covered_seconds, half_points)::text order by lesson_id) from antes),
  'y la consolidación lo restaura igual que estaba');
select is((select row(revoked_by, revoke_reason)::text from public.consumption_exclusions where id = (select id from r where name = 'cuenta')),
  row(pruebas.finanzas(), 'Era un error.')::text, 'la exclusión se queda, revertida, con quién y por qué');

-- ---------------------------------------------------------------------------------------
-- Por reproducción: solo lo de esa reproducción.

select is(pruebas.excluye(pruebas.finanzas(), 'session', pruebas.ana(), p_session => (select id from r where name = 'b1')) ->> 'outcome',
  'not_found', 'una reproducción de otra cuenta, no');
select is(pruebas.excluye(pruebas.finanzas(), 'session', pruebas.ana(), p_session => gen_random_uuid()) ->> 'outcome',
  'not_found', 'ni una que no existe');
insert into r select 'sesion', (pruebas.excluye(pruebas.finanzas(), 'session', pruebas.ana(), p_session => (select id from r where name = 'a2')) -> 'ids' ->> 0)::uuid;
select isnt((select id from r where name = 'sesion'), null, 'se excluye la reproducción del teléfono');
select ok(pruebas.marca(pruebas.ana(), pruebas.leccion('Uno')) is not null
          and pruebas.marca(pruebas.ana(), pruebas.leccion('Dos')) is null, 'marca solo la lección de esa reproducción');
select pruebas.consolida();
select is(pruebas.cubiertos(pruebas.ana(), pruebas.leccion('Uno')), 40, 'Uno se queda con lo de la computadora');
select is(pruebas.cubiertos(pruebas.ana(), pruebas.leccion('Dos')), 100, 'Dos, igual');
select is(pruebas.revierte(pruebas.finanzas(), (select id from r where name = 'sesion')) ->> 'outcome', 'revoked', 'se revierte');
select pruebas.consolida();
select is(pruebas.cubiertos(pruebas.ana(), pruebas.leccion('Uno')), 80, 'y vuelve');

-- Una reproducción que cruzó de mes deja una exclusión por cada periodo que tocó.
insert into r values ('a5', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Tres')));
update public.playback_sessions set last_heartbeat_at = timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '1 hour',
                                    started_at = timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '2 hours'
where id = (select id from r where name = 'a5');
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a5'), jsonb_build_array(pruebas.tramo(0, 0, 10)));
update public.playback_sessions set last_heartbeat_at = now() where id = (select id from r where name = 'a5');
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a5'), jsonb_build_array(pruebas.tramo(1, 10, 20)));
select is(jsonb_array_length(pruebas.excluye(pruebas.finanzas(), 'session', pruebas.ana(), p_session => (select id from r where name = 'a5')) -> 'ids'), 2,
  'una reproducción que cruzó de mes: una exclusión por cada periodo');
select is((select array_agg(period_id::integer order by period_id) from public.consumption_exclusions
           where playback_session_id = (select id from r where name = 'a5')), array[pruebas.periodo(1), pruebas.periodo()],
  'el anterior y el en curso');

-- ---------------------------------------------------------------------------------------
-- Por tramo de una lección: se resta, y si no queda nada, la fila sale.

insert into r select 'tramo', (pruebas.excluye(pruebas.finanzas(), 'interval', pruebas.ana(), p_lesson => pruebas.leccion('Dos'), p_from => 10, p_to => 30) -> 'ids' ->> 0)::uuid;
select isnt((select id from r where name = 'tramo'), null, 'se excluye un tramo de Dos');
select pruebas.consolida();
select is(pruebas.cubiertos(pruebas.ana(), pruebas.leccion('Dos')), 80, 'Dos pierde esos 20 segundos');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Dos'))).half_points, 1::smallint, 'y con ellos, el punto completo');
insert into private.rollup_dirty (period_id, profile_id, lesson_id) values (pruebas.periodo(), pruebas.ana(), pruebas.leccion('Uno'));
select pruebas.consolida();
select is(pruebas.cubiertos(pruebas.ana(), pruebas.leccion('Uno')), 80, 'un tramo excluido de Dos no toca otra lección');
insert into r select 'todo', (pruebas.excluye(pruebas.finanzas(), 'interval', pruebas.ana(), p_lesson => pruebas.leccion('Dos'), p_from => 0, p_to => 100) -> 'ids' ->> 0)::uuid;
select pruebas.consolida();
select is(pruebas.consolidado(pruebas.ana(), pruebas.leccion('Dos')), null, 'un tramo que cubre todo deja la lección sin fila');
select pruebas.revierte(pruebas.finanzas(), (select id from r where name = 'todo'));
select pruebas.revierte(pruebas.finanzas(), (select id from r where name = 'tramo'));
select pruebas.consolida();
select is(pruebas.cubiertos(pruebas.ana(), pruebas.leccion('Dos')), 100, 'revertidos los dos, vuelve entera');

-- La resta por tramos contra un modelo segundo por segundo: tramos al azar, y lo consolidado es
-- exactamente lo visto de Tres menos lo excluido.
create temporary table fallos (n integer);
do $$
declare
  v_ids uuid[] := '{}';
  v_from integer;
  v_to integer;
  v_model integer;
  v_got integer;
begin
  perform setseed(0.28);
  for i in 1 .. 12 loop
    v_from := floor(random() * 100)::integer;
    v_to := v_from + 1 + floor(random() * (100 - v_from))::integer;
    v_ids := v_ids || (pruebas.excluye(pruebas.finanzas(), 'interval', pruebas.ana(), p_lesson => pruebas.leccion('Tres'),
                                       p_from => v_from, p_to => v_to) -> 'ids' ->> 0)::uuid;
    perform pruebas.consolida();
    select count(*) into v_model from generate_series(0, 99) as s
    where not exists (select 1 from public.consumption_exclusions x
                      where x.id = any (v_ids) and x.revoked_at is null and s >= x.from_second and s < x.to_second);
    v_got := coalesce(pruebas.cubiertos(pruebas.ana(), pruebas.leccion('Tres')), 0);
    if v_got <> v_model then
      insert into fallos values (i);
    end if;
    if random() < 0.3 then
      perform pruebas.revierte(pruebas.finanzas(), v_ids[1 + floor(random() * array_length(v_ids, 1))::integer]);
    end if;
  end loop;
end $$;
select is((select count(*)::integer from fallos), 0, 'tramos excluidos al azar: lo consolidado coincide con el modelo');

-- ---------------------------------------------------------------------------------------
-- Una cuenta suspendida por fraude pierde todo su consumo de los periodos abiertos.

delete from private.rollup_dirty;
select pruebas.como_dueno_sistema();
update public.profiles set suspended_for_fraud = true where id = pruebas.ana();
select pruebas.limpiar();
select ok((select count(*) from private.rollup_dirty where profile_id = pruebas.ana() and period_id = pruebas.periodo()) >= 3
          and exists (select 1 from private.rollup_dirty where profile_id = pruebas.ana() and period_id = pruebas.periodo(1)),
  'prender la marca de fraude marca sus pares de los dos periodos abiertos');
select pruebas.consolida();
select is((select count(*)::integer from public.watch_rollup where period_id = pruebas.periodo() and profile_id = pruebas.ana()), 0,
  'y la consolidación ya no cuenta nada suyo');
select pruebas.como_dueno_sistema();
update public.profiles set suspended_for_fraud = false where id = pruebas.ana();
select pruebas.limpiar();
select pruebas.consolida();
select ok((select count(*) from public.watch_rollup where period_id = pruebas.periodo() and profile_id = pruebas.ana()) >= 3,
  'apagarla lo restaura');
delete from private.rollup_dirty;
select pruebas.como_dueno_sistema();
update public.profiles set display_name = 'Ana' where id = pruebas.ana();
select pruebas.limpiar();
select is((select count(*)::integer from private.rollup_dirty where profile_id = pruebas.ana()), 0,
  'cambiar otra cosa del perfil no marca nada');

-- ---------------------------------------------------------------------------------------
-- Las exclusiones no se borran ni se editan fuera de su revocación.

-- Como el dueño y con alguien que actúa, para que no lo detenga antes la auditoría: con finanzas,
-- que pasa la puerta, lo detiene el guardián por lo que se cambia; con una alumna, por la puerta.
create function pruebas.dueno_a_nombre_de(p_id uuid) returns void
language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', p_id::text, true), set_config('app.actor_session', pruebas.sesion(p_id)::text, true);
$$;
select pruebas.dueno_a_nombre_de(pruebas.finanzas());
select throws_ok(format('delete from public.consumption_exclusions where id = %L', (select id from r where name = 'cuenta')),
  '42501', null, 'una exclusión no se borra');
select throws_ok(format('update public.consumption_exclusions set reason = %L where id = %L', 'otro', (select id from r where name = 'cuenta')),
  '42501', null, 'ni se edita más que la revocación');
select throws_ok(format('update public.consumption_exclusions set revoke_reason = %L where id = %L', 'otro', (select id from r where name = 'cuenta')),
  '42501', null, 'ni se cambia una revocación');
select throws_ok('truncate public.consumption_exclusions cascade', '42501', null, 'ni se vacía');
-- Una exclusión de un periodo que ya no recibe latidos (escrita a mano por finanzas) no se revierte.
-- El periodo tiene fila (la exclusión apunta a ella, T-602) y se cierra después, con su guardián apagado.
select private.open_period(pruebas.periodo(2));
with x as (
  insert into public.consumption_exclusions (period_id, scope, profile_id, reason_code, reason, created_by)
  values (pruebas.periodo(2), 'account', pruebas.beto(), 'other', 'de antes', pruebas.finanzas()) returning id)
insert into r select 'vieja', id from x;
alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
update public.payout_periods set status = 'closed', entered_closing_at = coalesce(entered_closing_at, now())
where period_id = pruebas.periodo(2);
alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
select pruebas.dueno_a_nombre_de(pruebas.ana());
select throws_ok(format('insert into public.consumption_exclusions (period_id, scope, profile_id, reason_code, reason, created_by) values (%s, %L, %L, %L, %L, %L)',
  pruebas.periodo(), 'account', pruebas.beto(), 'other', 'por fuera', pruebas.ana()), '42501', null, 'ni la escribe quien no pasa la puerta de finanzas');
select pruebas.limpiar();
select is(pruebas.revierte(pruebas.finanzas(), (select id from r where name = 'vieja')) ->> 'outcome', 'outside_window',
  'una exclusión de un periodo que ya no recibe latidos no se revierte');

select is((select count(*)::integer from private.schema_violations()), 0, 'el vigilante no encuentra nada');

select * from finish();
rollback;
