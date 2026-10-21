-- T-207 · Consolidación nocturna (RF-405, RF-408, RN-04; 05 §5.4, §8.2 y §13). Decisiones de
-- Sergio del 2026-10-21: la lanza pg_cron y todo vive en la base; un día de práctica es un
-- tramo visible aceptado, con sus segundos; cada noche se consolidan el mes en curso y el
-- anterior, sin tabla de periodos todavía.
--
-- `private.record_heartbeats()` deja la marca del par (periodo, alumno, lección) cuando acepta
-- un tramo que cuenta para el reparto, y suma los segundos visibles del día de práctica. La
-- corrida (`private.nightly_rollup()`, que hace `commit` entre lotes y por eso no se llama aquí)
-- abre su corrida, da pasos (`private.rollup_step()`) y la cierra. Cada paso consolida un par
-- entero a partir de todos sus tramos del periodo: segundos distintos que cuentan y medios
-- puntos. Correrla dos veces da lo mismo; repetir un tramo no suma.
--
-- En una prueba de base todo corre en una transacción y `now()` no avanza: el tope de una
-- reproducción se mueve moviendo hacia atrás su último latido.
begin;
\ir _ayuda.psql
select plan(160);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana-consolida@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto-consolida@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido-consolida@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-consolida@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');

create function pruebas.ana() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.beto() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.computadora() returns uuid language sql immutable as $$ select 'c2000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.telefono() returns uuid language sql immutable as $$ select 'c2000000-0000-0000-0000-000000000002'::uuid $$;
-- El periodo en curso, el anterior y el de antes, en la zona del periodo.
create function pruebas.periodo(p_months_back integer default 0) returns integer
language sql stable as $$
  select to_char(date_trunc('month', timezone('America/Mexico_City', now())) - make_interval(months => p_months_back), 'YYYYMM')::integer
$$;
create function pruebas.hoy() returns date language sql stable as $$ select timezone('America/Mexico_City', now())::date $$;

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
  where c.slug = 'curso-consolida' and l.title = p_title
$$;
create function pruebas.video(p_lesson uuid) returns text
language sql as $$
  select v.provider_playback_id from public.published_lessons l join public.video_assets v on v.id = l.video_asset_id
  where l.id = p_lesson
$$;
-- Abre una reproducción de la lección con el video vigente, y le da tiempo vivo de sobra.
create function pruebas.abre(p_id uuid, p_session uuid, p_lesson uuid, p_basis text default 'subscription',
                             p_counts boolean default true, p_closing uuid default null) returns uuid
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como(p_id, p_session);
  select private.open_playback(p_lesson, pruebas.video(p_lesson), p_basis::public.access_basis, p_counts, p_closing) into v;
  perform pruebas.limpiar();
  if v ->> 'outcome' <> 'opened' then
    raise exception 'no abrió: %', v;
  end if;
  update public.playback_sessions set live_seconds = 100000, started_at = now() - interval '1 hour'
  where id = (v ->> 'session_id')::uuid;
  return (v ->> 'session_id')::uuid;
end
$$;
-- Como el servidor: con el tope que dio el blanco.
create function pruebas.registra(p_id uuid, p_session uuid, p_playback uuid, p_events jsonb, p_access_counts boolean default true)
returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como(p_id, p_session);
  select private.record_heartbeats(p_playback, p_events, p_access_counts,
                                   (private.heartbeat_target(p_playback) ->> 'at')::timestamptz) into v;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.tramo(p_seq integer, p_from integer, p_to integer, p_rate numeric default 1, p_visible boolean default true) returns jsonb
language sql immutable as $$
  select jsonb_build_object('seq', p_seq, 'from', p_from, 'to', p_to, 'rate', p_rate, 'visible', p_visible)
$$;
create function pruebas.marca(p_id uuid, p_lesson uuid, p_period integer default null) returns timestamptz
language sql as $$
  select touched_at from private.rollup_dirty
  where period_id = coalesce(p_period, pruebas.periodo()) and profile_id = p_id and lesson_id = p_lesson
$$;
create function pruebas.practica(p_id uuid, p_day date default null) returns integer
language sql as $$ select seconds from public.practice_days where profile_id = p_id and day = coalesce(p_day, pruebas.hoy()) $$;
create function pruebas.consolidado(p_id uuid, p_lesson uuid, p_period integer default null) returns public.watch_rollup
language sql as $$
  select * from public.watch_rollup
  where period_id = coalesce(p_period, pruebas.periodo()) and profile_id = p_id and lesson_id = p_lesson
$$;
-- Un paso de la corrida con todas las marcas confirmadas hasta ahora.
create function pruebas.paso(p_run uuid, p_after_profile uuid default null, p_after_lesson uuid default null,
                             p_limit integer default 200) returns jsonb
language sql as $$ select private.rollup_step(p_run, clock_timestamp(), p_after_profile, p_after_lesson, p_limit) $$;
-- Da pasos hasta que no quede nada; devuelve cuántas filas cambió en total.
create function pruebas.corre(p_run uuid, p_limit integer default 200) returns integer
language plpgsql as $$
declare
  v jsonb;
  v_written integer := 0;
  v_profile uuid;
  v_lesson uuid;
begin
  loop
    v := private.rollup_step(p_run, clock_timestamp(), v_profile, v_lesson, p_limit);
    exit when (v ->> 'read')::integer = 0;
    v_written := v_written + (v ->> 'written')::integer;
    v_profile := (v ->> 'last_profile')::uuid;
    v_lesson := (v ->> 'last_lesson')::uuid;
  end loop;
  return v_written;
end
$$;
-- El video nuevo puede llevar un id dado: así el desempate final (por id) no decide por azar.
create function pruebas.cambia_video(p_lesson uuid, p_playback text, p_id uuid default gen_random_uuid()) returns void
language plpgsql as $$
declare
  v_video uuid;
begin
  perform pruebas.como_dueno_sistema();
  insert into public.video_assets (id, course_id, teacher_id, lesson_id, provider, provider_asset_id, provider_playback_id, status, duration_seconds)
  select p_id, l.course_id, l.teacher_id, l.id, 'mux', 'Asset' || p_playback, p_playback, 'ready', l.duration_seconds
  from public.published_lessons l where l.id = p_lesson
  returning id into v_video;
  update public.published_lessons set video_asset_id = v_video where id = p_lesson;
  perform pruebas.limpiar();
end
$$;
create function pruebas.curso() returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', 'curso-consolida', 'title', 'Curso consolida', 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', jsonb_build_array(
      jsonb_build_object('title', 'Lección uno', 'video',
        jsonb_build_object('provider', 'mux', 'asset_id', 'AssetConsolidauno', 'playback_id', 'PlaybackConsolidauno', 'duration_seconds', 100)),
      jsonb_build_object('title', 'Lección dos', 'video',
        jsonb_build_object('provider', 'mux', 'asset_id', 'AssetConsolidados', 'playback_id', 'PlaybackConsolidados', 'duration_seconds', 200)),
      jsonb_build_object('title', 'Lección tres', 'video',
        jsonb_build_object('provider', 'mux', 'asset_id', 'AssetConsolidatres', 'playback_id', 'PlaybackConsolidatres', 'duration_seconds', 106))))))
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
create temporary table maestra as select private.system_add_teacher('Maestra que consolida', 'maestra-que-consolida', null) as id;
select private.system_load_course((select id from maestra), pruebas.curso());
select pruebas.limpiar();
select is(pruebas.pide('b0000000-0000-0000-0000-000000000001',
  format('private.approve_course(%L)', course_id)), 'approved', 'se aprueba el curso')
  from public.published_courses where slug = 'curso-consolida';
select pruebas.como_dueno();
insert into private.app_sessions (session_id, profile_id) values
  (pruebas.computadora(), pruebas.ana()), (pruebas.telefono(), pruebas.ana()),
  (pruebas.sesion(pruebas.beto()), pruebas.beto());
create temporary table r (name text primary key, id uuid);
grant select on r to app_service, authenticated;

-- ---------------------------------------------------------------------------------------
-- Las tablas y quién las toca: nadie de la aplicación. El consolidado lo escriben las
-- funciones de la corrida; las marcas y los días, private.record_heartbeats().

select has_table('public', 'watch_rollup', 'existe el consolidado');
select has_table('private', 'rollup_dirty', 'existen las marcas');
select has_table('public', 'practice_days', 'existen los días de práctica');
select has_table('public', 'job_definitions', 'existen los trabajos');
select has_table('public', 'job_runs', 'existen las corridas');
select col_is_pk('public', 'watch_rollup', array['period_id', 'profile_id', 'lesson_id'], 'una fila por periodo, alumno y lección: repetir no suma');
select col_is_pk('private', 'rollup_dirty', array['period_id', 'profile_id', 'lesson_id'], 'una marca por par y periodo');
select col_is_pk('public', 'practice_days', array['profile_id', 'day'], 'un día por cuenta');
select columns_are('public', 'practice_days', array['profile_id', 'day', 'seconds'], 'el día y sus segundos');
select columns_are('public', 'watch_rollup', array[
  'period_id', 'profile_id', 'lesson_id', 'course_id', 'teacher_id', 'video_asset_id', 'lesson_duration_seconds',
  'covered_seconds', 'half_points', 'computed_at', 'job_run_id'], 'el consolidado y sus columnas');
select has_index('public', 'watch_rollup', 'watch_rollup_teacher_idx', array['period_id', 'teacher_id'], 'los puntos de un maestro');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'job_runs_one_running_uq'),
  'el candado de una corrida viva por trabajo y periodo');
select ok((select relrowsecurity from pg_class where oid = t::regclass), t || ' con seguridad por fila')
from unnest(array['public.watch_rollup', 'private.rollup_dirty', 'public.practice_days', 'public.job_definitions',
                  'public.job_runs']) as t;
select ok(
  not has_any_column_privilege(r, t, 'select, insert, update, references')
  and not has_table_privilege(r, t, 'delete, truncate, trigger'),
  r || ' no toca ' || t)
from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r
cross join unnest(array['public.watch_rollup', 'private.rollup_dirty', 'public.practice_days', 'public.job_definitions',
                        'public.job_runs']) as t;
select ok(
  not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r
              where has_function_privilege(r, f, 'execute')),
  'nadie de la aplicación ejecuta ' || f)
from unnest(array[
  'private.payout_thresholds(public.period_id)',
  'private.half_points(integer, integer, integer, integer)',
  'private.rollup_pair(public.period_id, uuid, uuid, uuid, integer, integer)',
  'private.rollup_step(uuid, timestamptz, uuid, uuid, integer)',
  'private.rollup_window()',
  'private.open_job_run(text, public.period_id, text)',
  'private.close_job_run(uuid, text)',
  'private.nightly_rollup(boolean, integer)']) as f;
select is((select schedule from cron.job where jobname = 'nightly_rollup'), '0 9 * * *',
  'pg_cron la corre a las 09:00 UTC, las 03:00 de la Ciudad de México');
select is((select command from cron.job where jobname = 'nightly_rollup'), 'call private.nightly_rollup()',
  'y su trabajo es solo la llamada: así puede hacer commit entre lotes');
select is((select schedule from public.job_definitions where job = 'nightly_rollup'), '0 9 * * *', 'el trabajo está declarado');
select is(array(select p::integer from private.rollup_window() as p order by 1),array[pruebas.periodo(1), pruebas.periodo()]::integer[],
  'cada noche: el periodo en curso y el anterior, los que todavía reciben latidos');

-- ---------------------------------------------------------------------------------------
-- Los medios puntos (RN-04): la regla pura, en los bordes de los dos umbrales.

select is(private.half_points(0, 100, 2500, 9000), 0::smallint, 'nada visto, cero');
select is(private.half_points(24, 100, 2500, 9000), 0::smallint, 'debajo de UMBRAL_MEDIO_PCT, cero');
select is(private.half_points(25, 100, 2500, 9000), 1::smallint, 'en UMBRAL_MEDIO_PCT, medio punto');
select is(private.half_points(89, 100, 2500, 9000), 1::smallint, 'debajo de UMBRAL_COMPLETO_PCT, medio punto');
select is(private.half_points(90, 100, 2500, 9000), 2::smallint, 'en UMBRAL_COMPLETO_PCT, un punto');
select is(private.half_points(100, 100, 2500, 9000), 2::smallint, 'todo, un punto: el tope');
select is(private.half_points(26, 106, 2500, 9000), 0::smallint, '26 de 106 no es el 25 %');
select is(private.half_points(27, 106, 2500, 9000), 1::smallint, '27 sí: se redondea hacia arriba');
select is(private.half_points(95, 106, 2500, 9000), 1::smallint, '95 de 106 no es el 90 %');
select is(private.half_points(96, 106, 2500, 9000), 2::smallint, '96 sí, igual que el progreso');
select is(private.half_points(50, 100, null, 9000), null, 'sin umbral no da cero: da nulo, y el consolidado no lo acepta');

-- Los umbrales del periodo: los que rigen desde su periodo (RF-707), no los de hoy. La semilla los
-- pone desde 202610: un periodo de antes no tiene.
select is((select row(half_bps, full_bps)::text from private.payout_thresholds(pruebas.periodo())), '(2500,9000)',
  'los del periodo en curso');
select throws_ok('select * from private.payout_thresholds(202001)', 'P0001', null, 'un periodo sin umbrales no se adivina');
alter table public.business_parameters disable trigger user;
insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
values ('UMBRAL_COMPLETO_PCT', '8500', 'decided', now() - interval '1 second', pruebas.periodo(-2));
select is(private.parameter_value('UMBRAL_COMPLETO_PCT'), '8500'::jsonb, 'un cambio programado ya es el valor «de ahora»');
select is((select full_bps from private.payout_thresholds(pruebas.periodo())), 9000, 'pero el periodo en curso sigue con el suyo');
select is((select full_bps from private.payout_thresholds(pruebas.periodo(-1))), 9000, 'y el que sigue también');
select is((select full_bps from private.payout_thresholds(pruebas.periodo(-2))), 8500, 'el cambio entra en su periodo');
insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
values ('UMBRAL_MEDIO_PCT', '9500', 'decided', now() - interval '1 second', pruebas.periodo(-2));
select throws_ok(format('select * from private.payout_thresholds(%s)', pruebas.periodo(-2)), 'P0001', null,
  'medio por encima de completo no se acepta');
delete from public.business_parameters where effective_from = now() - interval '1 second';
alter table public.business_parameters enable trigger user;

-- ---------------------------------------------------------------------------------------
-- Las marcas y los días, en el latido.

insert into r values ('a1', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Lección uno')));
select is(pruebas.marca(pruebas.ana(), pruebas.leccion('Lección uno')), null, 'sin latidos no hay marca');
select is(pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a1'),
  jsonb_build_array(pruebas.tramo(0, 0, 30))) ->> 'outcome', 'recorded', 'un tramo que cuenta');
select isnt(pruebas.marca(pruebas.ana(), pruebas.leccion('Lección uno')), null, 'deja la marca del par en el periodo del tope');
select is(pruebas.practica(pruebas.ana()), 30, 'y los segundos del día de práctica');
create temporary table antes as select pruebas.marca(pruebas.ana(), pruebas.leccion('Lección uno')) as t;
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a1'), jsonb_build_array(pruebas.tramo(0, 0, 30)));
select is(pruebas.marca(pruebas.ana(), pruebas.leccion('Lección uno')), (select t from antes), 'un lote repetido no vuelve a marcar');
select is(pruebas.practica(pruebas.ana()), 30, 'ni suma al día');
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a1'),
  jsonb_build_array(pruebas.tramo(1, 30, 40, 1, false)));
select is(pruebas.marca(pruebas.ana(), pruebas.leccion('Lección uno')), (select t from antes), 'lo oculto no cuenta: no marca');
select is(pruebas.practica(pruebas.ana()), 30, 'ni es práctica');
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a1'),
  jsonb_build_array(pruebas.tramo(2, 40, 50, 2.5)));
select is(pruebas.marca(pruebas.ana(), pruebas.leccion('Lección uno')), (select t from antes), 'lo más rápido que VELOCIDAD_MAX no marca');
select is(pruebas.practica(pruebas.ana()), 40, 'pero visible es práctica, a cualquier velocidad');
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a1'),
  jsonb_build_array(pruebas.tramo(3, 50, 60)));
select cmp_ok(pruebas.marca(pruebas.ana(), pruebas.leccion('Lección uno')), '>', (select t from antes),
  'un tramo nuevo que cuenta refresca la marca');
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a1'),
  jsonb_build_array(pruebas.tramo(4, 0, 30)));
select is(pruebas.practica(pruebas.ana()), 80, 'volver a ver lo ya visto también es práctica');

-- Sin acceso que cuente a la hora del tope, no marca.
insert into r values ('a2', pruebas.abre(pruebas.ana(), pruebas.telefono(), pruebas.leccion('Lección dos'), 'subscription', true,
                                         (select id from r where name = 'a1')));
select pruebas.registra(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'a2'), jsonb_build_array(pruebas.tramo(0, 0, 30)), false);
select is(pruebas.marca(pruebas.ana(), pruebas.leccion('Lección dos')), null, 'sin acceso que cuente no hay marca');
select is(pruebas.practica(pruebas.ana()), 110, 'pero es práctica');

-- Cortesía y vista previa del dueño.
insert into r values ('cortesia', pruebas.abre(pruebas.beto(), pruebas.sesion(pruebas.beto()), pruebas.leccion('Lección uno'), 'courtesy', false));
select pruebas.registra(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'cortesia'),
  jsonb_build_array(pruebas.tramo(0, 0, 20)));
select is(pruebas.marca(pruebas.beto(), pruebas.leccion('Lección uno')), null, 'una cortesía no marca: no genera puntos');
select is(pruebas.practica(pruebas.beto()), 20, 'pero es práctica');
insert into r values ('previa', pruebas.abre(pruebas.beto(), pruebas.sesion(pruebas.beto()), pruebas.leccion('Lección dos'), 'owner_preview', false));
select pruebas.registra(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'previa'),
  jsonb_build_array(pruebas.tramo(0, 0, 30)));
select is(pruebas.marca(pruebas.beto(), pruebas.leccion('Lección dos')), null, 'la vista previa del dueño no marca');
select is(pruebas.practica(pruebas.beto()), 20, 'ni es práctica');

-- El día es el del tope, en la zona del periodo: lo atrasado cuenta en su día. Un día antes, si
-- eso no cambia de mes (el día 1 no hay «ayer» que el periodo en curso reciba).
select set_config('pruebas.atras', case when date_trunc('month', timezone('America/Mexico_City', now() - interval '1 day'))
  = date_trunc('month', timezone('America/Mexico_City', now())) then '1 day' else '0 seconds' end, true);
insert into r values ('ayer', pruebas.abre(pruebas.beto(), pruebas.sesion(pruebas.beto()), pruebas.leccion('Lección tres')));
update public.playback_sessions set last_heartbeat_at = now() - current_setting('pruebas.atras')::interval
where id = (select id from r where name = 'ayer');
select pruebas.registra(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'ayer'),
  jsonb_build_array(pruebas.tramo(0, 0, 15)), false);
select is(pruebas.practica(pruebas.beto(), timezone('America/Mexico_City',
  now() - current_setting('pruebas.atras')::interval + interval '90 seconds')::date) - case when current_setting('pruebas.atras') = '0 seconds'
  then 20 else 0 end, 15, 'lo visto ayer cuenta ayer');
update public.playback_sessions set last_heartbeat_at = now() where id = (select id from r where name = 'ayer');

-- Si el día falla, el lote se queda; si la marca falla, el lote no entra.
alter table public.practice_days add constraint prueba_falla check (seconds < 0) not valid;
select is(pruebas.registra(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'ayer'),
  jsonb_build_array(pruebas.tramo(1, 15, 30))) ->> 'outcome', 'recorded', 'si el día de práctica falla, el lote se registra');
select isnt(pruebas.marca(pruebas.beto(), pruebas.leccion('Lección tres')), null, 'con su marca');
alter table public.practice_days drop constraint prueba_falla;
alter table private.rollup_dirty add constraint prueba_falla check (period_id < 0) not valid;
select is(pruebas.registra(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'ayer'),
  jsonb_build_array(pruebas.tramo(2, 30, 45))) ->> 'outcome', 'failed', 'si la marca falla, el lote no entra: perderla perdería consumo');
select is((select count(*)::integer from public.watch_events where playback_session_id = (select id from r where name = 'ayer') and seq = 2),
  0, 'y el tramo no queda en el libro: el navegador lo reintenta');
alter table private.rollup_dirty drop constraint prueba_falla;

-- ---------------------------------------------------------------------------------------
-- Las corridas: una viva por trabajo y periodo.

insert into r values ('corrida', private.open_job_run('nightly_rollup', pruebas.periodo(), 'dirty'));
select isnt((select id from r where name = 'corrida'), null, 'abre la corrida del periodo');
select is(private.open_job_run('nightly_rollup', pruebas.periodo(), 'dirty'), null, 'otra del mismo periodo no arranca');
select is((select status::text from public.job_runs where id = (select id from r where name = 'corrida')), 'running', 'la primera sigue viva');
insert into r values ('anterior', private.open_job_run('nightly_rollup', pruebas.periodo(1), 'dirty'));
select isnt((select id from r where name = 'anterior'), null, 'la del periodo anterior es otra');

-- ---------------------------------------------------------------------------------------
-- Un paso: consolida los pares marcados.

select is((pruebas.paso((select id from r where name = 'corrida')) ->> 'read')::integer, 2, 'lee los dos pares marcados del periodo');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).covered_seconds, 40,
  'segundos distintos que cuentan: lo oculto, lo rápido y lo repetido no suman (RF-405)');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).half_points, 1::smallint, '40 de 100: medio punto');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).lesson_duration_seconds, 100, 'con la duración del video');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).teacher_id,
  (select teacher_id from public.published_lessons where id = pruebas.leccion('Lección uno')), 'el maestro vigente (RN-14)');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).video_asset_id,
  (select video_asset_id from public.published_lessons where id = pruebas.leccion('Lección uno')), 'y el video que se vio');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).job_run_id, (select id from r where name = 'corrida'),
  'de qué corrida salió');
select is((pruebas.consolidado(pruebas.beto(), pruebas.leccion('Lección tres'))).covered_seconds, 15,
  'el otro par: 15 de 106, sin lo que no contaba ni el lote que falló');
select is((pruebas.consolidado(pruebas.beto(), pruebas.leccion('Lección tres'))).half_points, 0::smallint,
  'cero puntos, y la fila se queda: los segundos cuentan para el maestro');
select is(pruebas.consolidado(pruebas.beto(), pruebas.leccion('Lección uno')), null, 'la cortesía no deja consolidado');
select is((select count(*)::integer from private.rollup_dirty where period_id = pruebas.periodo()), 0, 'las marcas procesadas se van');
select is((select row(rows_read, rows_written)::text from public.job_runs where id = (select id from r where name = 'corrida')), '(2,2)',
  'la corrida cuenta lo leído y lo escrito');
select is((pruebas.paso((select id from r where name = 'corrida')) ->> 'read')::integer, 0, 'el siguiente paso no encuentra nada');

-- Correrla dos veces da lo mismo: con la marca otra vez y sin tramos nuevos, nada cambia.
create temporary table foto as select * from public.watch_rollup;
insert into private.rollup_dirty (period_id, profile_id, lesson_id) values (pruebas.periodo(), pruebas.ana(), pruebas.leccion('Lección uno'));
select is((pruebas.paso((select id from r where name = 'corrida')) ->> 'written')::integer, 0, 'otra vez el mismo par: no escribe nada');
select results_eq('select * from public.watch_rollup order by profile_id, lesson_id', 'select * from foto order by profile_id, lesson_id',
  'y el consolidado queda idéntico, hasta la hora en que cambió');

-- Repetir un tramo no suma: el mismo pedazo con otro consecutivo.
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a1'),
  jsonb_build_array(pruebas.tramo(5, 0, 30), pruebas.tramo(6, 10, 20)));
select is((pruebas.paso((select id from r where name = 'corrida')) ->> 'written')::integer, 0, 'repetir lo ya visto no cambia nada');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).covered_seconds, 40, 'siguen 40 segundos');

-- Dos reproducciones del mismo periodo se unen.
insert into r values ('a3', pruebas.abre(pruebas.ana(), pruebas.telefono(), pruebas.leccion('Lección uno')));
select pruebas.registra(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'a3'), jsonb_build_array(pruebas.tramo(0, 60, 90)));
select pruebas.paso((select id from r where name = 'corrida'));
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).covered_seconds, 70, 'dos reproducciones se unen');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).half_points, 1::smallint, '70 de 100: medio punto');
select pruebas.registra(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'a3'), jsonb_build_array(pruebas.tramo(1, 30, 51)));
select pruebas.paso((select id from r where name = 'corrida'));
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).covered_seconds, 90, 'lo que llena el hueco suma solo lo nuevo');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).half_points, 2::smallint, '90 de 100: un punto');
select cmp_ok((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).computed_at, '>=',
  (select computed_at from foto where profile_id = pruebas.ana() and lesson_id = pruebas.leccion('Lección uno')),
  'la hora dice cuándo cambió');

-- Dos duraciones del mismo video: la menor, y lo cubierto nunca pasa de ella.
update public.playback_sessions set lesson_duration_seconds = 80 where id = (select id from r where name = 'a3');
insert into private.rollup_dirty (period_id, profile_id, lesson_id) values (pruebas.periodo(), pruebas.ana(), pruebas.leccion('Lección uno'));
select pruebas.paso((select id from r where name = 'corrida'));
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).lesson_duration_seconds, 80, 'la menor de las duraciones');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).covered_seconds, 80, 'y lo cubierto no pasa de ella');
update public.playback_sessions set lesson_duration_seconds = 100 where id = (select id from r where name = 'a3');
insert into private.rollup_dirty (period_id, profile_id, lesson_id) values (pruebas.periodo(), pruebas.ana(), pruebas.leccion('Lección uno'));
select pruebas.paso((select id from r where name = 'corrida'));

-- La lección cambia de video a medio periodo: se queda el video con más medios puntos (05 §8.2).
select pruebas.cambia_video(pruebas.leccion('Lección uno'), 'PlaybackConsolidaunonuevo', 'ffffffff-ffff-4fff-bfff-ffffffffffff');
insert into r values ('a4', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Lección uno'), 'subscription', true,
                                         (select id from r where name = 'a3')));
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a4'), jsonb_build_array(pruebas.tramo(0, 0, 30)));
select pruebas.paso((select id from r where name = 'corrida'));
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).half_points, 2::smallint,
  'el video anterior dio un punto y el nuevo medio: cuenta el punto');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).video_asset_id,
  (select video_asset_id from public.playback_sessions where id = (select id from r where name = 'a1')), 'con su video');
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a4'), jsonb_build_array(pruebas.tramo(1, 30, 90)));
select pruebas.paso((select id from r where name = 'corrida'));
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).video_asset_id,
  (select video_asset_id from public.published_lessons where id = pruebas.leccion('Lección uno')),
  'empatados en puntos y en segundos, el vigente');
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a4'), jsonb_build_array(pruebas.tramo(2, 90, 95)));
select pruebas.paso((select id from r where name = 'corrida'));
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección uno'))).covered_seconds, 95,
  'y si el nuevo tiene más segundos, el nuevo: nunca se suman dos videos');

-- Un par marcado sin nada que cuente se borra del consolidado.
insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id, lesson_duration_seconds,
                                 covered_seconds, half_points)
select pruebas.periodo(), pruebas.beto(), l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, 50, 1
from public.published_lessons l where l.id = pruebas.leccion('Lección uno');
insert into private.rollup_dirty (period_id, profile_id, lesson_id) values (pruebas.periodo(), pruebas.beto(), pruebas.leccion('Lección uno'));
select is((pruebas.paso((select id from r where name = 'corrida')) ->> 'written')::integer, 1, 'un par sin tramos que cuenten');
select is(pruebas.consolidado(pruebas.beto(), pruebas.leccion('Lección uno')), null, 'sale del consolidado');

-- Una marca más nueva que el arranque de la corrida espera a la siguiente.
insert into private.rollup_dirty (period_id, profile_id, lesson_id, touched_at)
values (pruebas.periodo(), pruebas.ana(), pruebas.leccion('Lección uno'), clock_timestamp() + interval '1 hour');
select is((pruebas.paso((select id from r where name = 'corrida')) ->> 'read')::integer, 0, 'lo marcado después del arranque no entra');
select isnt(pruebas.marca(pruebas.ana(), pruebas.leccion('Lección uno')), null, 'y la marca se queda para la siguiente');
delete from private.rollup_dirty;

-- Un latido que llega mientras se consolida el par: su marca no se borra. Lo simula un
-- disparador que, al escribir el consolidado, refresca la marca como lo haría ese latido.
create function pruebas.latido_en_medio() returns trigger language plpgsql as $$
begin
  update private.rollup_dirty set touched_at = clock_timestamp() where profile_id = new.profile_id and lesson_id = new.lesson_id;
  return new;
end
$$;
create trigger latido_en_medio after insert or update on public.watch_rollup
  for each row execute function pruebas.latido_en_medio();
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a4'), jsonb_build_array(pruebas.tramo(3, 95, 100)));
select is((pruebas.paso((select id from r where name = 'corrida')) ->> 'written')::integer, 1, 'consolida el par');
select isnt(pruebas.marca(pruebas.ana(), pruebas.leccion('Lección uno')), null,
  'pero la marca que se refrescó en medio se queda: lo de ese latido entra en la siguiente');
drop trigger latido_en_medio on public.watch_rollup;
delete from private.rollup_dirty;

-- Dos videos de la misma lección con duraciones distintas. Con los mismos medios puntos, el de
-- más segundos aunque ya no sea el vigente; y el de más medios puntos aunque tenga menos segundos.
insert into r values ('b1', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Lección dos')));
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'b1'), jsonb_build_array(pruebas.tramo(0, 10, 170)));
select pruebas.cambia_video(pruebas.leccion('Lección dos'), 'PlaybackConsolidadosnuevo');
insert into r values ('b2', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Lección dos')));
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'b2'), jsonb_build_array(pruebas.tramo(0, 0, 100)));
select pruebas.paso((select id from r where name = 'corrida'));
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección dos'))).video_asset_id,
  (select video_asset_id from public.playback_sessions where id = (select id from r where name = 'b1')),
  'medio punto cada uno: el de más segundos, aunque ya no sea el vigente');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección dos'))).covered_seconds, 160, 'con sus 160 segundos');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección dos'))).half_points, 1::smallint, 'y su medio punto');
update public.playback_sessions set lesson_duration_seconds = 100 where id = (select id from r where name = 'b1');
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'b2'), jsonb_build_array(pruebas.tramo(1, 100, 120)));
select pruebas.paso((select id from r where name = 'corrida'));
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección dos'))).video_asset_id,
  (select video_asset_id from public.playback_sessions where id = (select id from r where name = 'b1')),
  'el anterior con su punto (90 de 100) gana al vigente a medias (120 de 200)');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección dos'))).covered_seconds, 90,
  'con lo cubierto dentro de su duración: de [10, 170) contra 100 s, [10, 100)');
select is((pruebas.consolidado(pruebas.ana(), pruebas.leccion('Lección dos'))).half_points, 2::smallint, 'y su punto');

-- Una propiedad: tramos al azar contra un modelo hecho de otra forma (segundo por segundo). En
-- cada ronda llegan tramos visibles u ocultos, a varias velocidades, que se repiten y se
-- traslapan; el consolidado dice siempre los segundos distintos que cuentan, nunca más que la
-- duración, y sus medios puntos.
select setseed(0.207);
insert into r values ('azar', pruebas.abre(pruebas.beto(), pruebas.sesion(pruebas.beto()), pruebas.leccion('Lección dos')));
create function pruebas.rondas(p_rounds integer) returns integer
language plpgsql as $$
declare
  v_bad integer := 0;
  v_seq integer := 0;
  v_events jsonb;
  v_from integer;
  v_expected integer;
  v_row public.watch_rollup;
begin
  for i in 1 .. p_rounds loop
    v_events := '[]';
    for j in 1 .. 4 loop
      v_from := floor(random() * 190)::integer;
      v_events := v_events || jsonb_build_array(pruebas.tramo(v_seq, v_from, least(200, v_from + 1 + floor(random() * 25)::integer),
        (array[0.5, 1, 1.5, 2, 2.25])[1 + floor(random() * 5)::integer], random() < 0.8));
      v_seq := v_seq + 1;
    end loop;
    perform pruebas.registra(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'azar'), v_events);
    perform pruebas.paso((select id from r where name = 'corrida'));
    select count(distinct s)::integer into v_expected
    from public.watch_events e cross join generate_series(e.from_second, e.to_second - 1) s
    where e.period_id = pruebas.periodo() and e.profile_id = pruebas.beto() and e.lesson_id = pruebas.leccion('Lección dos')
      and e.counts_for_payout;
    v_row := pruebas.consolidado(pruebas.beto(), pruebas.leccion('Lección dos'));
    if coalesce(v_row.covered_seconds, 0) <> v_expected or coalesce(v_row.covered_seconds, 0) > 200
       or coalesce(v_row.half_points, 0) <> (case when v_expected * 10000 >= 200 * 9000 then 2
                                                  when v_expected * 10000 >= 200 * 2500 then 1 else 0 end) then
      v_bad := v_bad + 1;
    end if;
  end loop;
  return v_bad;
end
$$;
select is(pruebas.rondas(40), 0, 'en 40 rondas al azar, el consolidado coincide con el modelo segundo por segundo');

-- ---------------------------------------------------------------------------------------
-- El recálculo completo (RF-408): todos los pares del periodo, desde los latidos, da lo mismo
-- que la corrida de cada noche, y corrige lo que alguien haya tocado.

select private.close_job_run((select id from r where name = 'corrida'), null);
create temporary table noche as select period_id, profile_id, lesson_id, video_asset_id, lesson_duration_seconds, covered_seconds, half_points
from public.watch_rollup;
update public.watch_rollup set half_points = 0, covered_seconds = 0 where profile_id = pruebas.ana();
-- Un par sin un solo latido en el periodo: solo el consolidado lo nombra.
insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id, lesson_duration_seconds,
                                 covered_seconds, half_points)
select pruebas.periodo(), pruebas.ana(), l.id, l.course_id, l.teacher_id, l.video_asset_id, 106, 50, 1
from public.published_lessons l where l.id = pruebas.leccion('Lección tres');
insert into r values ('completo', private.open_job_run('nightly_rollup', pruebas.periodo(), 'full'));
select cmp_ok(pruebas.corre((select id from r where name = 'completo'), 1), '>=', 2, 'recorre el periodo de a un par');
select results_eq(
  'select period_id, profile_id, lesson_id, video_asset_id, lesson_duration_seconds, covered_seconds, half_points from public.watch_rollup order by 2, 3',
  'select * from noche order by 2, 3',
  'el recálculo completo da lo mismo que la corrida de cada noche, y deshace lo tocado');

-- ---------------------------------------------------------------------------------------
-- Cerrar una corrida, y la que se quedó colgada.

select private.close_job_run((select id from r where name = 'completo'), null);
select is((select status::text from public.job_runs where id = (select id from r where name = 'completo')), 'succeeded', 'cierra bien');
select isnt((select finished_at from public.job_runs where id = (select id from r where name = 'completo')), null, 'con su hora');
insert into private.rollup_dirty (period_id, profile_id, lesson_id) values (pruebas.periodo(2), pruebas.ana(), pruebas.leccion('Lección uno'));
select private.close_job_run((select id from r where name = 'anterior'), '22023: algo');
select is((select row(status, error)::text from public.job_runs where id = (select id from r where name = 'anterior')), '(failed,"22023: algo")',
  'una corrida con error cierra fallida, con el error');
select is((select details ->> 'marks_outside_window' from public.job_runs where id = (select id from r where name = 'anterior')), '1',
  'y anota las marcas de periodos que ya no se consolidan');
delete from private.rollup_dirty;
insert into r values ('colgada', private.open_job_run('nightly_rollup', pruebas.periodo(), 'dirty'));
update public.job_runs set heartbeat_at = clock_timestamp() - interval '16 minutes' where id = (select id from r where name = 'colgada');
insert into r values ('colgada_lejos', private.open_job_run('nightly_rollup', 202001, 'dirty'));
update public.job_runs set heartbeat_at = clock_timestamp() - interval '16 minutes' where id = (select id from r where name = 'colgada_lejos');
insert into r values ('relevo', private.open_job_run('nightly_rollup', pruebas.periodo(), 'dirty'));
select isnt((select id from r where name = 'relevo'), null, 'una corrida sin latir hace más de 15 minutos no detiene a la siguiente');
select is((select row(status, error)::text from public.job_runs where id = (select id from r where name = 'colgada')), '(failed,stale)',
  'y queda fallida');
select is((select status::text from public.job_runs where id = (select id from r where name = 'colgada_lejos')), 'failed',
  'también la de un periodo que ya no se abre: ninguna se queda viva para siempre');

-- Un par que falla no detiene a los demás: su marca pasa al final, para la corrida siguiente, y la
-- corrida termina fallida, con cuántos fallaron.
do $$
begin
  execute format('alter table public.watch_rollup add constraint prueba_falla check (lesson_id <> %L) not valid',
                 pruebas.leccion('Lección tres'));
end
$$;
insert into private.rollup_dirty (period_id, profile_id, lesson_id, touched_at) values
  (pruebas.periodo(), pruebas.beto(), pruebas.leccion('Lección tres'), clock_timestamp() - interval '2 minutes'),
  (pruebas.periodo(), pruebas.beto(), pruebas.leccion('Lección dos'), clock_timestamp() - interval '1 minute');
delete from public.watch_rollup where profile_id = pruebas.beto() and lesson_id in (pruebas.leccion('Lección dos'), pruebas.leccion('Lección tres'));
create temporary table antes_falla as select clock_timestamp() as t;
select is((pruebas.paso((select id from r where name = 'relevo')) ->> 'read')::integer, 2, 'lee los dos pares');
select isnt(pruebas.consolidado(pruebas.beto(), pruebas.leccion('Lección dos')), null, 'el que no falla se consolida');
select is(pruebas.marca(pruebas.beto(), pruebas.leccion('Lección dos')), null, 'y su marca se va');
select cmp_ok(pruebas.marca(pruebas.beto(), pruebas.leccion('Lección tres')), '>', (select t from antes_falla),
  'la del que falla se queda, con la hora de ahora: esta corrida ya no la vuelve a leer');
select is((select details ->> 'pairs_failed' from public.job_runs where id = (select id from r where name = 'relevo')), '1',
  'la corrida cuenta el par que falló');
select private.close_job_run((select id from r where name = 'relevo'), null);
select is((select row(status, error)::text from public.job_runs where id = (select id from r where name = 'relevo')),
  '(failed,"pairs failed: 1 (23514)")', 'y cierra fallida, con cuántos y el código del primero');
delete from private.rollup_dirty;
insert into r values ('completo_falla', private.open_job_run('nightly_rollup', pruebas.periodo(), 'full'));
select pruebas.corre((select id from r where name = 'completo_falla'));
select isnt(pruebas.marca(pruebas.beto(), pruebas.leccion('Lección tres')), null,
  'en el recálculo completo, el par que falla queda marcado para la noche siguiente');
select is((select details ->> 'pairs_failed' from public.job_runs where id = (select id from r where name = 'completo_falla')), '1',
  'y también se cuenta');
alter table public.watch_rollup drop constraint prueba_falla;
select private.close_job_run((select id from r where name = 'completo_falla'), null);
delete from private.rollup_dirty;

-- Un periodo sin marcas no necesita umbrales; con marcas y sin umbrales, falla. La semilla pone
-- los umbrales desde 202610.
insert into r values ('vieja', private.open_job_run('nightly_rollup', 202001, 'dirty'));
select is((pruebas.paso((select id from r where name = 'vieja')) ->> 'read')::integer, 0, 'un periodo sin marcas no pide nada');
insert into private.rollup_dirty (period_id, profile_id, lesson_id) values (202001, pruebas.ana(), pruebas.leccion('Lección uno'));
select throws_ok(format('select private.rollup_step(%L, clock_timestamp())', (select id from r where name = 'vieja')), 'P0001', null,
  'con marcas y sin umbrales para ese periodo, el paso entero falla');

-- ---------------------------------------------------------------------------------------
-- El vigilante.

grant select on public.watch_rollup to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'consolidation table reachable by app_service'
                  and object_name = 'public.watch_rollup'), 'el vigilante dice si alguien le deja leer el consolidado al servidor');
revoke select on public.watch_rollup from app_service;
grant insert on private.rollup_dirty to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'consolidation table reachable by app_service'
                  and object_name = 'private.rollup_dirty'), 'o escribir las marcas');
revoke insert on private.rollup_dirty from app_service;
grant select (seconds) on public.practice_days to authenticated;
select ok(exists (select 1 from private.schema_violations() where problem = 'consolidation table reachable by authenticated'
                  and object_name = 'public.practice_days'), 'o leer los días antes de T-505');
revoke select (seconds) on public.practice_days from authenticated;
grant execute on procedure private.nightly_rollup(boolean, integer) to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'system function executable by app_service'
                  and object_name = 'private.nightly_rollup(boolean, integer)'), 'o correr la consolidación');
revoke execute on procedure private.nightly_rollup(boolean, integer) from app_service;
select is_empty('select * from private.schema_violations()', 'sin nada concedido, el vigilante no dice nada');

select * from finish();
rollback;
