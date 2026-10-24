-- T-207 · Rehacer el progreso que falló (RF-307; 05 §5.7 y §13). Decisión de Sergio del
-- 2026-10-20: si el progreso falla al registrar un lote, el libro se guarda igual, el par queda en
-- `private.progress_rebuilds` y el progreso se rehace después desde `watch_events`.
--
-- `private.rebuild_pair()` rehace un par: toma el candado de la cuenta y vuelve a fundir cada
-- reproducción del par con lo que el libro tiene de ella, con la misma `private.merge_progress()`
-- del latido. La corrida (`private.rebuild_progress()`, que hace `commit` entre pares y por eso no
-- se llama aquí) recorre la tabla cada hora; la prueba `tests/integration/44-rehacer-progreso.test.ts`
-- la llama de verdad.
--
-- En una prueba de base todo corre en una transacción y `now()` no avanza: el tope de una
-- reproducción se mueve moviendo hacia atrás su último latido.
begin;
\ir _ayuda.psql
select plan(65);

-- El mes anterior, abierto (T-601): sus latidos atrasados entran hasta su día de cierre, y así esta
-- prueba no depende de qué día del mes corre. Sin el guardián, que no deja volver a abierto.
select pruebas.como_dueno_sistema();
alter table public.payout_periods disable trigger payout_periods_guard;
insert into public.payout_periods (period_id, starts_at, ends_at, timezone)
select m.p, timezone('America/Mexico_City', to_date(m.p::text || '01', 'YYYYMMDD')::timestamp),
       timezone('America/Mexico_City', to_date(m.p::text || '01', 'YYYYMMDD')::timestamp + interval '1 month'), 'America/Mexico_City'
from (select to_char(date_trunc('month', timezone('America/Mexico_City', now())) - interval '1 month', 'YYYYMM')::integer as p) m
on conflict (period_id) do update set status = 'open', entered_closing_at = null;
alter table public.payout_periods enable trigger payout_periods_guard;
select pruebas.limpiar();

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana-rehace@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto-rehace@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000003', 'carla-rehace@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido-rehace@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-rehace@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');

create function pruebas.ana() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.beto() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.carla() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.computadora() returns uuid language sql immutable as $$ select 'c3000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.telefono() returns uuid language sql immutable as $$ select 'c3000000-0000-0000-0000-000000000002'::uuid $$;
-- La ventana de una reproducción: tres latidos.
create function pruebas.ventana() returns interval
language sql stable as $$ select make_interval(secs => 3 * (private.playback_limits()).heartbeat_seconds) $$;

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
  where c.slug = 'curso-rehace' and l.title = p_title
$$;
create function pruebas.video(p_lesson uuid) returns text
language sql as $$
  select v.provider_playback_id from public.published_lessons l join public.video_assets v on v.id = l.video_asset_id
  where l.id = p_lesson
$$;
-- Abre una reproducción de la lección con el video vigente, y le da tiempo vivo de sobra.
create function pruebas.abre(p_id uuid, p_session uuid, p_lesson uuid, p_basis text default 'subscription',
                             p_counts boolean default true) returns uuid
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como(p_id, p_session);
  select private.open_playback(p_lesson, pruebas.video(p_lesson), p_basis::public.access_basis, p_counts, null) into v;
  perform pruebas.limpiar();
  if v ->> 'outcome' <> 'opened' then
    raise exception 'no abrió: %', v;
  end if;
  update public.playback_sessions set live_seconds = 100000, started_at = now() - interval '1 hour'
  where id = (v ->> 'session_id')::uuid;
  return (v ->> 'session_id')::uuid;
end
$$;
-- Mueve hacia atrás el último latido de una reproducción (y su arranque, que nunca es posterior):
-- su tope queda en ese latido más una ventana.
create function pruebas.atrasa(p_playback uuid, p_heartbeat timestamptz) returns void
language sql as $$
  update public.playback_sessions set last_heartbeat_at = p_heartbeat, started_at = p_heartbeat - interval '1 hour'
  where id = p_playback
$$;
-- Como el servidor: con el tope que dio el blanco.
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
create function pruebas.tramo(p_seq integer, p_from integer, p_to integer, p_visible boolean default true) returns jsonb
language sql immutable as $$
  select jsonb_build_object('seq', p_seq, 'from', p_from, 'to', p_to, 'rate', 1, 'visible', p_visible)
$$;
-- Sin UMBRAL_COMPLETO_PCT el progreso falla y el par queda anotado; con él, vuelve.
create function pruebas.sin_umbral() returns void
language sql as $$
  update public.business_parameters set effective_from = effective_from + interval '100 years' where key = 'UMBRAL_COMPLETO_PCT'
$$;
create function pruebas.con_umbral() returns void
language sql as $$
  update public.business_parameters set effective_from = effective_from - interval '100 years' where key = 'UMBRAL_COMPLETO_PCT'
$$;
create function pruebas.fila(p_id uuid, p_lesson uuid) returns public.lesson_progress
language sql as $$ select * from public.lesson_progress where profile_id = p_id and lesson_id = p_lesson $$;
create function pruebas.pendiente(p_id uuid, p_lesson uuid) returns private.progress_rebuilds
language sql as $$ select * from private.progress_rebuilds where profile_id = p_id and lesson_id = p_lesson $$;
-- Rehace un par como la corrida: con la hora de la falla que leyó.
create function pruebas.rehace(p_id uuid, p_lesson uuid) returns jsonb
language sql as $$ select private.rebuild_pair(p_id, p_lesson, (pruebas.pendiente(p_id, p_lesson)).failed_at) $$;
-- Lo que dice el progreso de un par, sin la hora en que se escribió.
create function pruebas.foto(p_id uuid, p_lesson uuid) returns jsonb
language sql as $$ select to_jsonb(pruebas.fila(p_id, p_lesson)) - 'updated_at' $$;
-- Lo que un par diría si fuera de otra cuenta: para comparar con una que no falló.
create function pruebas.sin_cuenta(p_id uuid, p_lesson uuid) returns jsonb
language sql as $$ select pruebas.foto(p_id, p_lesson) - 'profile_id' - 'last_playback_session_id' $$;
create function pruebas.cambia_video(p_lesson uuid, p_playback text) returns void
language plpgsql as $$
declare
  v_video uuid;
begin
  perform pruebas.como_dueno_sistema();
  insert into public.video_assets (course_id, teacher_id, lesson_id, provider, provider_asset_id, provider_playback_id, status, duration_seconds)
  select l.course_id, l.teacher_id, l.id, 'mux', 'Asset' || p_playback, p_playback, 'ready', l.duration_seconds
  from public.published_lessons l where l.id = p_lesson
  returning id into v_video;
  update public.published_lessons set video_asset_id = v_video where id = p_lesson;
  perform pruebas.limpiar();
end
$$;
create function pruebas.curso() returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', 'curso-rehace', 'title', 'Curso rehace', 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', (
      select jsonb_agg(jsonb_build_object('title', t, 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'AssetRehace' || n, 'playback_id', 'PlaybackRehace' || n, 'duration_seconds', 100)) order by n)
      from unnest(array['Uno', 'Dos', 'Tres', 'Cuatro', 'Cinco', 'Seis', 'Siete', 'Ocho', 'Nueve', 'Diez', 'Once']) with ordinality as l (t, n)))))
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
create temporary table maestra as select private.system_add_teacher('Maestra que rehace', 'maestra-que-rehace', null) as id;
select private.system_load_course((select id from maestra), pruebas.curso());
select pruebas.limpiar();
select is(pruebas.pide('b0000000-0000-0000-0000-000000000001',
  format('private.approve_course(%L)', course_id)), 'approved', 'se aprueba el curso')
  from public.published_courses where slug = 'curso-rehace';
select pruebas.como_dueno();
insert into private.app_sessions (session_id, profile_id) values
  (pruebas.computadora(), pruebas.ana()), (pruebas.telefono(), pruebas.ana()),
  (pruebas.sesion(pruebas.beto()), pruebas.beto()), (pruebas.sesion(pruebas.carla()), pruebas.carla());
create temporary table r (name text primary key, id uuid);
grant select on r to app_service, authenticated;
alter table public.business_parameters disable trigger user;

-- ---------------------------------------------------------------------------------------
-- La corrida y quién la ejecuta: solo el dueño de la base, cada hora.

select ok(exists (select 1 from pg_proc where oid = 'private.rebuild_pair(uuid, uuid, timestamptz)'::regprocedure),
  'existe rehacer un par');
select ok(exists (select 1 from pg_proc where oid = 'private.rebuild_progress()'::regprocedure and prokind = 'p'),
  'y la corrida, un procedimiento: hace commit entre pares');
select ok(
  not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r
              where has_function_privilege(r, f, 'execute')),
  'nadie de la aplicación ejecuta ' || f)
from unnest(array['private.rebuild_pair(uuid, uuid, timestamptz)', 'private.rebuild_progress()']) as f;
select is((select schedule from cron.job where jobname = 'progress_rebuild'), '30 * * * *', 'pg_cron la corre cada hora');
select is((select command from cron.job where jobname = 'progress_rebuild'), 'call private.rebuild_progress()',
  'y su trabajo es solo la llamada');
select is((select row(schedule, expected_every)::text from public.job_definitions where job = 'progress_rebuild'),
  '("30 * * * *",01:00:00)', 'el trabajo está declarado');

-- Sus corridas, sin periodo y sin las marcas de la consolidación.
insert into r values ('corrida', private.open_job_run('progress_rebuild', null, 'rebuild'));
select is(private.open_job_run('progress_rebuild', null, 'rebuild'), null, 'una sola viva');
select private.close_job_run((select id from r where name = 'corrida'), null);
select is((select row(status, details)::text from public.job_runs where id = (select id from r where name = 'corrida')),
  '(succeeded,"{""mode"": ""rebuild""}")', 'se cierra bien, sin contar marcas que no son suyas');
insert into r values ('fallida', private.open_job_run('progress_rebuild', null, 'rebuild'));
update public.job_runs set details = details || '{"pairs_failed": 2, "first_failure": "P0001"}' where id = (select id from r where name = 'fallida');
select private.close_job_run((select id from r where name = 'fallida'), null);
select is((select row(status, error)::text from public.job_runs where id = (select id from r where name = 'fallida')),
  '(failed,"pairs failed: 2 (P0001)")', 'con pares fallidos, fallida');
insert into r values ('noche', private.open_job_run('nightly_rollup', null, 'dirty'));
select private.close_job_run((select id from r where name = 'noche'), null);
select ok((select details ? 'marks_outside_window' from public.job_runs where id = (select id from r where name = 'noche')),
  'la de la consolidación sí las cuenta');

-- ---------------------------------------------------------------------------------------
-- Un par que falló queda como si no hubiera fallado.

insert into r values ('a1', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Uno')));
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a1'),
  jsonb_build_array(pruebas.tramo(0, 0, 30)));
select pruebas.sin_umbral();
select is(pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a1'),
  jsonb_build_array(pruebas.tramo(1, 30, 60), pruebas.tramo(2, 60, 70, false))) -> 'progress' ->> 'outcome', 'failed',
  'sin umbral, el progreso del lote falla');
select pruebas.con_umbral();
select is((pruebas.pendiente(pruebas.ana(), pruebas.leccion('Uno'))).code, 'P0001', 'y el par queda anotado');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Uno'))).covered, '{[0,30)}'::int4multirange, 'con el progreso de antes');

-- Beto ve lo mismo y su progreso no falla: es lo que Ana debe tener.
insert into r values ('b1', pruebas.abre(pruebas.beto(), pruebas.sesion(pruebas.beto()), pruebas.leccion('Uno')));
select pruebas.registra(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'b1'),
  jsonb_build_array(pruebas.tramo(0, 0, 30)));
select pruebas.registra(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'b1'),
  jsonb_build_array(pruebas.tramo(1, 30, 60), pruebas.tramo(2, 60, 70, false)));

select is(pruebas.rehace(pruebas.ana(), pruebas.leccion('Uno')), '{"outcome": "rebuilt"}'::jsonb, 'se rehace');
select is(pruebas.sin_cuenta(pruebas.ana(), pruebas.leccion('Uno')), pruebas.sin_cuenta(pruebas.beto(), pruebas.leccion('Uno')),
  'igual que si no hubiera fallado: tramos, posición, consecutivo, horas y video');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Uno'))).covered, '{[0,60)}'::int4multirange,
  'lo oculto no se funde');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Uno'))).last_position_seconds, 70,
  'pero mueve la posición, como en el latido: el último consecutivo, sirva o no');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Uno'))).last_playback_session_id, (select id from r where name = 'a1'),
  'de su reproducción');
select is(pruebas.pendiente(pruebas.ana(), pruebas.leccion('Uno')), null, 'y el par ya no está anotado');

-- Dos veces da lo mismo.
create temporary table antes as select pruebas.foto(pruebas.ana(), pruebas.leccion('Uno')) as foto;
insert into private.progress_rebuilds (profile_id, lesson_id, code) values (pruebas.ana(), pruebas.leccion('Uno'), 'P0001');
select is(pruebas.rehace(pruebas.ana(), pruebas.leccion('Uno')), '{"outcome": "rebuilt"}'::jsonb, 'rehacerlo otra vez');
select is(pruebas.foto(pruebas.ana(), pruebas.leccion('Uno')), (select foto from antes), 'deja lo mismo');

-- ---------------------------------------------------------------------------------------
-- Lo que el lote fallido terminaba queda terminado, a la hora en que se vio.

insert into r values ('a2', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Dos')));
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a2'),
  jsonb_build_array(pruebas.tramo(0, 0, 50)));
select pruebas.sin_umbral();
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a2'),
  jsonb_build_array(pruebas.tramo(1, 50, 95)));
select pruebas.con_umbral();
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Dos'))).completed_at, null, 'el lote que la terminaba falló');
select is(pruebas.rehace(pruebas.ana(), pruebas.leccion('Dos')), '{"outcome": "rebuilt"}'::jsonb, 'se rehace');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Dos'))).completed_at, now(), 'y queda terminada, con la hora del tope');

-- ---------------------------------------------------------------------------------------
-- Lo más nuevo no se pisa: los tramos se unen, la posición se queda.

-- De la misma reproducción: un consecutivo mayor.
insert into r values ('a3', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Tres')));
select pruebas.sin_umbral();
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a3'),
  jsonb_build_array(pruebas.tramo(0, 0, 40)));
select pruebas.con_umbral();
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a3'),
  jsonb_build_array(pruebas.tramo(1, 10, 20)));
select is(pruebas.rehace(pruebas.ana(), pruebas.leccion('Tres')), '{"outcome": "rebuilt"}'::jsonb, 'se rehace');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Tres'))).covered, '{[0,40)}'::int4multirange, 'con lo que había fallado');
select is(row((pruebas.fila(pruebas.ana(), pruebas.leccion('Tres'))).last_position_seconds,
              (pruebas.fila(pruebas.ana(), pruebas.leccion('Tres'))).last_seq)::text, '(20,1)',
  'y la posición del lote que llegó después, que es el más nuevo');

-- De otra reproducción, más nueva: el tope de la vieja es su último latido más una ventana, no la
-- hora en que llegó su lote.
insert into r values ('a4', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Cuatro')));
select pruebas.atrasa((select id from r where name = 'a4'), now() - interval '2 hours');
select pruebas.sin_umbral();
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a4'),
  jsonb_build_array(pruebas.tramo(0, 0, 40)));
select pruebas.con_umbral();
insert into r values ('a5', pruebas.abre(pruebas.ana(), pruebas.telefono(), pruebas.leccion('Cuatro')));
select pruebas.atrasa((select id from r where name = 'a5'), now() - interval '1 hour');
select pruebas.registra(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'a5'),
  jsonb_build_array(pruebas.tramo(0, 5, 15)));
select is(pruebas.rehace(pruebas.ana(), pruebas.leccion('Cuatro')), '{"outcome": "rebuilt"}'::jsonb, 'se rehace');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Cuatro'))).covered, '{[0,40)}'::int4multirange, 'con lo que había fallado');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Cuatro'))).last_position_seconds, 15,
  'la posición de la reproducción más nueva');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Cuatro'))).last_watched_at, now() - interval '1 hour' + pruebas.ventana(),
  'y su hora');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Cuatro'))).first_watched_at, now() - interval '2 hours' + pruebas.ventana(),
  'la primera vez es la de la vieja');

-- De otra reproducción, cerrada: su tope es la hora en que se cerró.
insert into r values ('a6', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Cinco')));
select pruebas.atrasa((select id from r where name = 'a6'), now() - interval '2 hours');
update public.playback_sessions set revoked_at = now() - interval '2 hours' + interval '10 seconds', revoke_reason = 'closed_by_user'
where id = (select id from r where name = 'a6');
select pruebas.sin_umbral();
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a6'),
  jsonb_build_array(pruebas.tramo(0, 0, 40)));
select pruebas.con_umbral();
insert into r values ('a7', pruebas.abre(pruebas.ana(), pruebas.telefono(), pruebas.leccion('Cinco')));
select pruebas.atrasa((select id from r where name = 'a7'), now() - interval '2 hours' - pruebas.ventana() + interval '60 seconds');
select pruebas.registra(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'a7'),
  jsonb_build_array(pruebas.tramo(0, 5, 15)));
select is(pruebas.rehace(pruebas.ana(), pruebas.leccion('Cinco')), '{"outcome": "rebuilt"}'::jsonb, 'se rehace');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Cinco'))).covered, '{[0,40)}'::int4multirange, 'con lo que había fallado');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Cinco'))).last_position_seconds, 15,
  'y la posición de la que vio después de que la otra se cerró');

-- ---------------------------------------------------------------------------------------
-- Lo que no se rehace: un video que la lección ya no tiene, y la vista previa del dueño.

insert into r values ('a8', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Seis')));
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a8'),
  jsonb_build_array(pruebas.tramo(0, 0, 50)));
select pruebas.cambia_video(pruebas.leccion('Seis'), 'PlaybackRehaceNuevo');
insert into r values ('a9', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Seis')));
select pruebas.sin_umbral();
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a9'),
  jsonb_build_array(pruebas.tramo(0, 0, 10)));
select pruebas.con_umbral();
select is(pruebas.rehace(pruebas.ana(), pruebas.leccion('Seis')), '{"outcome": "rebuilt"}'::jsonb, 'se rehace');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Seis'))).video_asset_id,
  (select video_asset_id from public.published_lessons where id = pruebas.leccion('Seis')), 'con el video nuevo');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Seis'))).covered, '{[0,10)}'::int4multirange,
  'y solo lo visto de él: lo del anterior ya no dice nada');

insert into r values ('c1', pruebas.abre(pruebas.carla(), pruebas.sesion(pruebas.carla()), pruebas.leccion('Siete'), 'owner_preview', false));
select pruebas.registra(pruebas.carla(), pruebas.sesion(pruebas.carla()), (select id from r where name = 'c1'),
  jsonb_build_array(pruebas.tramo(0, 0, 80)));
insert into r values ('c2', pruebas.abre(pruebas.carla(), pruebas.sesion(pruebas.carla()), pruebas.leccion('Siete')));
select pruebas.sin_umbral();
select pruebas.registra(pruebas.carla(), pruebas.sesion(pruebas.carla()), (select id from r where name = 'c2'),
  jsonb_build_array(pruebas.tramo(0, 0, 10)));
select pruebas.con_umbral();
select is(pruebas.rehace(pruebas.carla(), pruebas.leccion('Siete')), '{"outcome": "rebuilt"}'::jsonb, 'se rehace');
select is((pruebas.fila(pruebas.carla(), pruebas.leccion('Siete'))).covered, '{[0,10)}'::int4multirange,
  'sin la vista previa del dueño, que no deja progreso');

-- ---------------------------------------------------------------------------------------
-- Lo del periodo anterior también: una reproducción que cruzó el mes tiene latidos en los dos.

insert into r values ('a10', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Ocho')));
select pruebas.atrasa((select id from r where name = 'a10'),
  timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '1 hour');
select pruebas.sin_umbral();
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a10'),
  jsonb_build_array(pruebas.tramo(0, 0, 40)));
select pruebas.con_umbral();
select is((select period_id::integer from public.watch_events where playback_session_id = (select id from r where name = 'a10') and seq = 0),
  to_char(date_trunc('month', timezone('America/Mexico_City', now())) - interval '1 month', 'YYYYMM')::integer,
  'el lote que falló quedó en el periodo anterior');
update public.playback_sessions set last_heartbeat_at = now() where id = (select id from r where name = 'a10');
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a10'),
  jsonb_build_array(pruebas.tramo(1, 40, 50)));
select is(pruebas.rehace(pruebas.ana(), pruebas.leccion('Ocho')), '{"outcome": "rebuilt"}'::jsonb, 'se rehace');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Ocho'))).covered, '{[0,50)}'::int4multirange,
  'con lo de los dos periodos');

-- Al revés: el último latido fue al cerrar el mes, y el lote quedó en el mes de su tope, el siguiente.
insert into r values ('a12', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Diez')));
select pruebas.atrasa((select id from r where name = 'a12'),
  timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '5 seconds');
select pruebas.sin_umbral();
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a12'),
  jsonb_build_array(pruebas.tramo(0, 0, 30)));
select pruebas.con_umbral();
select is((select period_id::integer from public.watch_events where playback_session_id = (select id from r where name = 'a12') and seq = 0),
  to_char(date_trunc('month', timezone('America/Mexico_City', now())), 'YYYYMM')::integer,
  'el lote que falló quedó en el mes siguiente al de su último latido');
select is(pruebas.rehace(pruebas.ana(), pruebas.leccion('Diez')), '{"outcome": "rebuilt"}'::jsonb, 'se rehace');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Diez'))).covered, '{[0,30)}'::int4multirange,
  'con él: los periodos llegan al último latido más una ventana');

-- ---------------------------------------------------------------------------------------
-- Las reproducciones se funden en el orden en que se vieron: si fallaron las dos, la terminada
-- lleva la hora de la que la terminó, no la de la más nueva.

insert into r values ('a13', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Once')));
select pruebas.atrasa((select id from r where name = 'a13'), now() - interval '2 hours');
insert into r values ('a14', pruebas.abre(pruebas.ana(), pruebas.telefono(), pruebas.leccion('Once')));
select pruebas.atrasa((select id from r where name = 'a14'), now() - interval '1 hour');
select pruebas.sin_umbral();
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a13'),
  jsonb_build_array(pruebas.tramo(0, 0, 95)));
select pruebas.registra(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'a14'),
  jsonb_build_array(pruebas.tramo(0, 0, 10)));
select pruebas.con_umbral();
select is(pruebas.fila(pruebas.ana(), pruebas.leccion('Once')), null, 'los dos lotes fallaron: no hay progreso');
select is(pruebas.rehace(pruebas.ana(), pruebas.leccion('Once')), '{"outcome": "rebuilt"}'::jsonb, 'se rehace');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Once'))).completed_at, now() - interval '2 hours' + pruebas.ventana(),
  'terminada a la hora de la que la terminó');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Once'))).last_position_seconds, 10,
  'y la posición de la más nueva');

-- ---------------------------------------------------------------------------------------
-- Si vuelve a fallar, se queda anotado para la hora siguiente.

insert into r values ('a11', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Nueve')));
select pruebas.sin_umbral();
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a11'),
  jsonb_build_array(pruebas.tramo(0, 0, 20)));
update private.progress_rebuilds set code = 'XX000' where profile_id = pruebas.ana() and lesson_id = pruebas.leccion('Nueve');
select is(pruebas.rehace(pruebas.ana(), pruebas.leccion('Nueve')), '{"outcome": "failed", "code": "P0001"}'::jsonb,
  'sin umbral, rehacer también falla');
select is((pruebas.pendiente(pruebas.ana(), pruebas.leccion('Nueve'))).code, 'P0001', 'el par se queda, con el código nuevo');
select ok((pruebas.pendiente(pruebas.ana(), pruebas.leccion('Nueve'))).failed_at > now(), 'y la hora de la falla nueva');
select is(pruebas.fila(pruebas.ana(), pruebas.leccion('Nueve')), null, 'sin progreso a medias');
select pruebas.con_umbral();
select is(pruebas.rehace(pruebas.ana(), pruebas.leccion('Nueve')), '{"outcome": "rebuilt"}'::jsonb, 'con el umbral, se rehace');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Nueve'))).covered, '{[0,20)}'::int4multirange, 'entero');

-- Una falla que llegó después de leer la anotación: se rehace, y la anotación se queda para la
-- corrida siguiente (con el candado de la cuenta no llega ninguna mientras tanto).
insert into private.progress_rebuilds (profile_id, lesson_id, code) values (pruebas.ana(), pruebas.leccion('Nueve'), 'P0001');
select is(private.rebuild_pair(pruebas.ana(), pruebas.leccion('Nueve'), now() - interval '1 second'), '{"outcome": "rebuilt"}'::jsonb,
  'con otra hora de falla, se rehace');
select isnt(pruebas.pendiente(pruebas.ana(), pruebas.leccion('Nueve')), null, 'pero la anotación nueva se queda');
delete from private.progress_rebuilds where profile_id = pruebas.ana() and lesson_id = pruebas.leccion('Nueve');

-- Una cuenta que ya no existe: no hay qué rehacer, y no falla cada hora.
insert into private.progress_rebuilds (profile_id, lesson_id, code) values ('a0000000-0000-0000-0000-0000000000ff', pruebas.leccion('Uno'), 'P0001');
select is(pruebas.rehace('a0000000-0000-0000-0000-0000000000ff', pruebas.leccion('Uno')), '{"outcome": "gone"}'::jsonb,
  'una cuenta que ya no existe');
select is(pruebas.pendiente('a0000000-0000-0000-0000-0000000000ff', pruebas.leccion('Uno')), null, 'sale de la tabla');

-- Rehacer no toca nada más: ni la marca para la consolidación ni el día de práctica.
create temporary table otras as
  select (select count(*) from private.rollup_dirty) as marcas, (select sum(seconds) from public.practice_days) as dias;
insert into private.progress_rebuilds (profile_id, lesson_id, code) values (pruebas.ana(), pruebas.leccion('Dos'), 'P0001');
select is(pruebas.rehace(pruebas.ana(), pruebas.leccion('Dos')), '{"outcome": "rebuilt"}'::jsonb, 'se rehace');
select is((select row((select count(*) from private.rollup_dirty), (select sum(seconds) from public.practice_days))::text),
  (select row(marcas, dias)::text from otras), 'ni marcas ni días de práctica');

-- El vigilante conoce lo nuevo.
-- Los disparadores de los parámetros, otra vez prendidos: el vigilante de los periodos los mira (T-601).
alter table public.business_parameters enable trigger user;
select is((select count(*)::integer from private.schema_violations()), 0, 'el vigilante no encuentra nada');

select * from finish();
rollback;
