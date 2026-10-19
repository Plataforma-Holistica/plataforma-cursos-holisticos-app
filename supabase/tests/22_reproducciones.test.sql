-- T-204 · Una reproducción a la vez (RF-107; 05 §5.4 y §9.5; TRD §6.1). Decisiones de Sergio
-- del 2026-10-19: el límite trae su propio latido de presencia, y en pausa se suelta el lugar.
--
-- Lo que el servidor le pide a la base son dos funciones, a nombre de quien actúa y con la
-- sesión de Auth que declara: `private.open_playback()`, que abre una reproducción si hay
-- lugar (o contesta la lista de las vivas), y `private.touch_playback()`, el latido de
-- presencia. «Viva» es sin revocar y con un latido dentro de tres `LATIDO_SEGUNDOS`; solo
-- cuentan las de otras sesiones de Auth: la misma sesión es el mismo navegador, y la nueva
-- reemplaza a la vieja. Lo que una cuenta puede ver o hacer ya lo decidió TypeScript.
begin;
\ir _ayuda.psql
select plan(66);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana-reproduce@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto-reproduce@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido-reproduce@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-reproduce@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');

-- Dos sesiones de Auth de Ana (la computadora y el teléfono) y una de Beto.
create function pruebas.computadora() returns uuid language sql immutable as $$ select 'c1000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.telefono() returns uuid language sql immutable as $$ select 'c1000000-0000-0000-0000-000000000002'::uuid $$;

-- El servidor a nombre de una persona, con la sesión de Auth que declara.
create function pruebas.abre(
  p_id uuid, p_session uuid, p_lesson uuid, p_playback text,
  p_basis text default 'subscription', p_counts boolean default true, p_closing uuid default null) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_id, p_session);
  -- a_nombre_de pone la sesión de pruebas si no se le da otra: aquí nula es nula.
  perform set_config('app.actor_session', coalesce(p_session::text, ''), true);
  select private.open_playback(p_lesson, p_playback, p_basis::public.access_basis, p_counts, p_closing) into v;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.late(p_id uuid, p_session uuid, p_playback uuid) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_id, p_session);
  -- a_nombre_de pone la sesión de pruebas si no se le da otra: aquí nula es nula.
  perform set_config('app.actor_session', coalesce(p_session::text, ''), true);
  select private.touch_playback(p_playback) into v;
  perform pruebas.limpiar();
  return v;
end
$$;
-- Como si su último latido hubiera llegado hace tantos segundos.
create function pruebas.envejece(p_playback uuid, p_seconds integer) returns void
language sql as $$
  update public.playback_sessions set last_heartbeat_at = now() - make_interval(secs => p_seconds) where id = p_playback
$$;
create function pruebas.fila(p_playback uuid) returns public.playback_sessions
language sql as $$ select * from public.playback_sessions where id = p_playback $$;
create function pruebas.curso(p_slug text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', jsonb_build_array(
      jsonb_build_object('title', 'Lección uno', 'video',
        jsonb_build_object('provider', 'mux', 'asset_id', 'AssetReproduce' || replace(p_slug, '-', ''),
                           'playback_id', 'PlaybackReproduce' || replace(p_slug, '-', ''), 'duration_seconds', 356)),
      jsonb_build_object('title', 'Lección dos', 'video',
        jsonb_build_object('provider', 'mux', 'asset_id', 'AssetReproduceDos' || replace(p_slug, '-', ''),
                           'playback_id', 'PlaybackReproduceDos' || replace(p_slug, '-', ''), 'duration_seconds', 409))))))
$$;
create function pruebas.leccion(p_position integer default 1) returns uuid
language sql as $$
  select l.id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id
  where c.slug = 'curso-reproducir' and l.position = p_position
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- El curso, aprobado.
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
create temporary table maestra as select private.system_add_teacher('Maestra que reproduce', 'maestra-que-reproduce', null) as id;
select private.system_load_course((select id from maestra), pruebas.curso('curso-reproducir'));
select pruebas.limpiar();
select is(pruebas.pide('b0000000-0000-0000-0000-000000000001',
  format('private.approve_course(%L)', course_id)), 'approved', 'se aprueba el curso')
  from public.published_courses where slug = 'curso-reproducir';

-- Las sesiones de Auth anotadas por la aplicación, con su navegador (T-104).
select pruebas.como_dueno();
insert into private.app_sessions (session_id, profile_id, user_agent) values
  (pruebas.computadora(), 'a0000000-0000-0000-0000-000000000001', 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36'),
  (pruebas.telefono(), 'a0000000-0000-0000-0000-000000000001', 'Mozilla/5.0 (iPhone) Version/18.0 Mobile Safari/604.1'),
  (pruebas.sesion('a0000000-0000-0000-0000-000000000002'), 'a0000000-0000-0000-0000-000000000002', null);
-- El valor decidido el 2026-10-15, y el del latido.
select is(private.parameter_value('SESIONES_SIMULTANEAS'), '1'::jsonb, 'una reproducción a la vez por cuenta');
select is(private.parameter_value('LATIDO_SEGUNDOS'), '30'::jsonb, 'un latido cada 30 segundos');

-- ---------------------------------------------------------------------------------------
-- La tabla y quién la toca.

select has_table('public', 'playback_sessions', 'existe public.playback_sessions');
select has_column('public', 'playback_sessions', 'auth_session_id', 'guarda la sesión de Auth que la abrió');
select hasnt_column('public', 'playback_sessions', 'device_label', 'y no guarda el dispositivo');
select ok(
  not has_any_column_privilege(r, 'public.playback_sessions', 'insert, update')
  and not has_table_privilege(r, 'public.playback_sessions', 'delete, truncate, trigger'),
  r || ' no la escribe: solo las funciones')
from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r;
select ok(
  has_column_privilege('authenticated', 'public.playback_sessions', 'started_at', 'select')
  and not has_column_privilege('authenticated', 'public.playback_sessions', 'auth_session_id', 'select'),
  'la persona lee sus reproducciones, sin la sesión de Auth');
select ok(not has_any_column_privilege('anon', 'public.playback_sessions', 'select'), 'el visitante no lee nada');
grant update (revoked_at) on public.playback_sessions to app_service;
select is(
  (select array_agg(object_name) from private.schema_violations() where problem like 'playback table writable by %'),
  array['public.playback_sessions'], 'el vigilante dice si alguien le concede escribir');
revoke update (revoked_at) on public.playback_sessions from app_service;

select ok(
  has_function_privilege('app_service', 'private.open_playback(uuid, text, public.access_basis, boolean, uuid)', 'execute')
  and has_function_privilege('app_service', 'private.touch_playback(uuid)', 'execute'),
  'el servidor abre y late');
select ok(
  not has_function_privilege(r, 'private.open_playback(uuid, text, public.access_basis, boolean, uuid)', 'execute')
  and not has_function_privilege(r, 'private.touch_playback(uuid)', 'execute')
  and not has_function_privilege(r, 'private.live_playbacks(uuid, uuid, interval)', 'execute'),
  r || ' no')
from unnest(array['anon', 'authenticated', 'service_role']) as r;
select ok(not has_function_privilege('app_service', 'private.live_playbacks(uuid, uuid, interval)', 'execute'),
  'la lista de las vivas solo la usan las dos funciones');

-- ---------------------------------------------------------------------------------------
-- Abrir.

select is(pruebas.abre('a0000000-0000-0000-0000-000000000001', null, pruebas.leccion(), 'PlaybackReproducecursoreproducir'),
  null, 'sin sesión de Auth declarada no se abre nada');
select is(pruebas.abre('a0000000-0000-0000-0000-000000000001', pruebas.computadora(), pruebas.leccion(), 'PlaybackOtro'),
  '{"outcome": "not_found"}'::jsonb, 'si el video firmado no es el de la lección, no se abre');

create temporary table r (name text primary key, answer jsonb);
grant all on r to app_service;
insert into r select 'compu', pruebas.abre('a0000000-0000-0000-0000-000000000001', pruebas.computadora(),
  pruebas.leccion(), 'PlaybackReproducecursoreproducir');
select is((select answer - 'session_id' from r where name = 'compu'),
  '{"outcome": "opened", "heartbeat_seconds": 30}'::jsonb, 'con lugar se abre, y dice cada cuánto latir');
create function pruebas.id(p_name text) returns uuid language sql as $$ select (answer ->> 'session_id')::uuid from r where name = p_name $$;
grant execute on function pruebas.id(text) to app_service;
select is(
  (select jsonb_build_object('profile', f.profile_id, 'auth', f.auth_session_id, 'lesson', f.lesson_id,
     'duration', f.lesson_duration_seconds, 'basis', f.access_basis, 'counts', f.counts_for_payout,
     'teacher', f.teacher_id = (select id from maestra),
     'course', f.course_id = (select course_id from public.published_courses where slug = 'curso-reproducir'),
     'video', f.video_asset_id = (select video_asset_id from public.published_lessons where id = pruebas.leccion()),
     'revoked', f.revoked_at)
   from pruebas.fila(pruebas.id('compu')) f),
  jsonb_build_object('profile', 'a0000000-0000-0000-0000-000000000001', 'auth', pruebas.computadora(),
     'lesson', pruebas.leccion(), 'duration', 356, 'basis', 'subscription', 'counts', true,
     'teacher', true, 'course', true, 'video', true, 'revoked', null),
  'la fila sale de la lección, con la base y la sesión de Auth');
select throws_ok(
  format($$select pruebas.abre('a0000000-0000-0000-0000-000000000001', %L, %L, 'PlaybackReproducecursoreproducir', 'open_course', true)$$,
         pruebas.computadora(), pruebas.leccion()),
  '23514', null, 'el curso abierto no cuenta para el reparto');

-- La misma sesión de Auth (renovar la dirección, recargar, otra lección, otra pestaña): reemplaza.
insert into r select 'compu-2', pruebas.abre('a0000000-0000-0000-0000-000000000001', pruebas.computadora(),
  pruebas.leccion(2), 'PlaybackReproduceDoscursoreproducir', 'owner_preview', false);
select is((select answer ->> 'outcome' from r where name = 'compu-2'), 'opened', 'desde el mismo navegador nunca está ocupado');
select is(
  (select jsonb_build_object('reason', f.revoke_reason, 'by', f.revoked_by, 'at', f.revoked_at is not null)
   from pruebas.fila(pruebas.id('compu')) f),
  jsonb_build_object('reason', 'replaced', 'by', pruebas.id('compu-2'), 'at', true),
  'la anterior queda reemplazada por la nueva');
select is((select f.revoked_at from pruebas.fila(pruebas.id('compu-2')) f), null, 'y la nueva, viva');

-- Otro dispositivo de la misma cuenta: no hay lugar.
insert into r select 'tel', pruebas.abre('a0000000-0000-0000-0000-000000000001', pruebas.telefono(),
  pruebas.leccion(), 'PlaybackReproducecursoreproducir');
select is((select answer ->> 'outcome' from r where name = 'tel'), 'busy', 'otro dispositivo encuentra el lugar ocupado');
select is(
  (select jsonb_agg(e - 'started_at') from r, jsonb_array_elements(answer -> 'live') e where name = 'tel'),
  jsonb_build_array(jsonb_build_object(
    'session_id', pruebas.id('compu-2'),
    'user_agent', 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36',
    'lesson_title', 'Lección dos', 'course_title', 'Curso curso-reproducir')),
  'y la lista dice cuál: el navegador, la lección y el curso');
select is(
  (select (e ->> 'started_at')::timestamptz from r, jsonb_array_elements(answer -> 'live') e where name = 'tel'),
  (select f.started_at from pruebas.fila(pruebas.id('compu-2')) f), 'y desde cuándo');
select is(
  (select count(*)::int from public.playback_sessions where auth_session_id = pruebas.telefono()),
  0, 'ocupado no anota nada');

-- Cerrar la otra desde aquí: en un solo paso, cierra y abre.
insert into r select 'tel-2', pruebas.abre('a0000000-0000-0000-0000-000000000001', pruebas.telefono(),
  pruebas.leccion(), 'PlaybackReproducecursoreproducir', 'subscription', true, pruebas.id('compu-2'));
select is((select answer ->> 'outcome' from r where name = 'tel-2'), 'opened', 'cerrar la otra da el lugar');
select is(
  (select jsonb_build_object('reason', f.revoke_reason, 'by', f.revoked_by) from pruebas.fila(pruebas.id('compu-2')) f),
  jsonb_build_object('reason', 'closed_by_user', 'by', pruebas.id('tel-2')),
  'la otra queda cerrada por la persona, y se sabe por cuál');

-- Cerrar una ajena no hace nada.
insert into r select 'beto', pruebas.abre('a0000000-0000-0000-0000-000000000002', pruebas.sesion('a0000000-0000-0000-0000-000000000002'),
  pruebas.leccion(), 'PlaybackReproducecursoreproducir', 'subscription', true, pruebas.id('tel-2'));
select is((select answer ->> 'outcome' from r where name = 'beto'), 'opened', 'otra cuenta tiene su propio lugar');
select is((select f.revoked_at from pruebas.fila(pruebas.id('tel-2')) f), null, 'y no cierra la de Ana aunque la nombre');

-- Ocupado y con algo que cerrar: no cierra nada si de todos modos no habría lugar.
select pruebas.como_dueno_sistema();
insert into public.business_parameters (key, value, status, effective_from)
values ('SESIONES_SIMULTANEAS', '0', 'decided', now() - interval '2 seconds');
insert into r select 'cero', pruebas.abre('a0000000-0000-0000-0000-000000000001', pruebas.computadora(),
  pruebas.leccion(), 'PlaybackReproducecursoreproducir', 'subscription', true, pruebas.id('tel-2'));
select is((select answer ->> 'outcome' from r where name = 'cero'), 'busy', 'el cupo sale del parámetro vigente');
select is((select f.revoked_at from pruebas.fila(pruebas.id('tel-2')) f), null, 'y sin lugar, cerrar no se hace a medias');
-- Los parámetros no se borran: se vuelve a 1 con un valor más nuevo.
select pruebas.como_dueno_sistema();
insert into public.business_parameters (key, value, status, effective_from)
values ('SESIONES_SIMULTANEAS', '1', 'decided', now() - interval '1 second');

-- ---------------------------------------------------------------------------------------
-- Latir.

select pruebas.envejece(pruebas.id('tel-2'), 60);
select is(pruebas.late('a0000000-0000-0000-0000-000000000001', pruebas.telefono(), pruebas.id('tel-2')),
  '{"outcome": "ok"}'::jsonb, 'viva: sigue');
select ok((select f.last_heartbeat_at > now() - interval '1 second' from pruebas.fila(pruebas.id('tel-2')) f),
  'y el latido queda anotado');
select is(pruebas.late('a0000000-0000-0000-0000-000000000001', pruebas.computadora(), pruebas.id('compu-2')),
  jsonb_build_object('outcome', 'revoked', 'reason', 'closed_by_user', 'by', pruebas.id('tel-2')),
  'cerrada: dice por qué y por cuál, para tomar el lugar de vuelta');
select is(pruebas.late('a0000000-0000-0000-0000-000000000001', pruebas.computadora(), pruebas.id('compu')),
  jsonb_build_object('outcome', 'revoked', 'reason', 'replaced', 'by', pruebas.id('compu-2')),
  'reemplazada: igual');
select is(pruebas.late('a0000000-0000-0000-0000-000000000001', pruebas.computadora(), pruebas.id('tel-2')),
  '{"outcome": "not_found"}'::jsonb, 'desde otra sesión de Auth de la misma cuenta, como si no existiera');
select is(pruebas.late('a0000000-0000-0000-0000-000000000002', pruebas.telefono(), pruebas.id('tel-2')),
  '{"outcome": "not_found"}'::jsonb, 'desde otra cuenta, igual');
select is(pruebas.late('a0000000-0000-0000-0000-000000000001', pruebas.telefono(), gen_random_uuid()),
  '{"outcome": "not_found"}'::jsonb, 'una que no existe');
select is(pruebas.late('a0000000-0000-0000-0000-000000000001', null, pruebas.id('tel-2')),
  null, 'sin sesión de Auth declarada, nada');

-- Vencida (una pausa larga) y con lugar: vuelve a entrar.
select pruebas.envejece(pruebas.id('tel-2'), 91);
select is(pruebas.late('a0000000-0000-0000-0000-000000000001', pruebas.telefono(), pruebas.id('tel-2')),
  '{"outcome": "ok"}'::jsonb, 'vencida y con lugar: sigue');
select ok((select f.last_heartbeat_at > now() - interval '1 second' from pruebas.fila(pruebas.id('tel-2')) f),
  'y vuelve a estar viva');

-- Vencida, y otro dispositivo tomó el lugar mientras tanto.
select pruebas.envejece(pruebas.id('tel-2'), 90);
insert into r select 'compu-3', pruebas.abre('a0000000-0000-0000-0000-000000000001', pruebas.computadora(),
  pruebas.leccion(), 'PlaybackReproducecursoreproducir');
select is((select answer ->> 'outcome' from r where name = 'compu-3'), 'opened',
  'una pausa de tres latidos suelta el lugar');
select is(
  (select jsonb_build_object('outcome', l -> 'outcome', 'live', jsonb_path_query_array(l, '$.live[*].session_id'))
   from pruebas.late('a0000000-0000-0000-0000-000000000001', pruebas.telefono(), pruebas.id('tel-2')) l),
  jsonb_build_object('outcome', 'busy', 'live', jsonb_build_array(pruebas.id('compu-3'))),
  'y al reanudar encuentra ocupado, con la lista');
select is((select f.revoked_at from pruebas.fila(pruebas.id('tel-2')) f), null, 'sin quedar revocada: puede pedirlo de nuevo');
select ok((select f.last_heartbeat_at < now() - interval '89 seconds' from pruebas.fila(pruebas.id('tel-2')) f),
  'ni anotar el latido');

-- El borde de la ventana: a los 89 segundos sigue viva.
select pruebas.envejece(pruebas.id('compu-3'), 89);
insert into r select 'tel-3', pruebas.abre('a0000000-0000-0000-0000-000000000001', pruebas.telefono(),
  pruebas.leccion(), 'PlaybackReproducecursoreproducir');
select is((select answer ->> 'outcome' from r where name = 'tel-3'), 'busy', 'a los 89 segundos todavía cuenta');
select pruebas.envejece(pruebas.id('compu-3'), 90);
insert into r select 'tel-4', pruebas.abre('a0000000-0000-0000-0000-000000000001', pruebas.telefono(),
  pruebas.leccion(), 'PlaybackReproducecursoreproducir');
select is((select answer ->> 'outcome' from r where name = 'tel-4'), 'opened', 'a los 90 ya no');
select is((select f.revoke_reason from pruebas.fila(pruebas.id('tel-2')) f), 'replaced',
  'y la vieja del mismo teléfono queda reemplazada');
select is((select f.revoked_at from pruebas.fila(pruebas.id('compu-3')) f), null,
  'la vencida de la computadora no se revoca: solo deja de contar');

-- ---------------------------------------------------------------------------------------
-- Cerrar una sesión de Auth suelta sus reproducciones, la cierre quien la cierre.

select pruebas.como_dueno();
delete from private.app_sessions where session_id = pruebas.telefono();
select is((select f.revoke_reason from pruebas.fila(pruebas.id('tel-4')) f), 'session_closed',
  'quitar la sesión anotada revoca su reproducción');
select is((select f.revoked_by from pruebas.fila(pruebas.id('tel-4')) f), null, 'sin una reproducción que la reemplace');
select is((select f.revoked_at from pruebas.fila(pruebas.id('beto')) f), null, 'y no toca las de otras sesiones');
select is(pruebas.late('a0000000-0000-0000-0000-000000000001', pruebas.telefono(), pruebas.id('tel-4')),
  jsonb_build_object('outcome', 'revoked', 'reason', 'session_closed', 'by', null), 'su latido lo dice');
select is(
  (select count(*)::int from public.playback_sessions where auth_session_id = pruebas.computadora() and revoked_at is null),
  1, 'las de la computadora siguen');

-- La persona lee las suyas, y solo las suyas.
select pruebas.como_usuario('a0000000-0000-0000-0000-000000000002');
select is((select count(*)::int from public.playback_sessions), 1, 'Beto lee su reproducción');
select is((select count(*)::int from public.playback_sessions where profile_id = 'a0000000-0000-0000-0000-000000000001'),
  0, 'y no las de Ana');
select throws_ok($$select auth_session_id from public.playback_sessions$$, '42501', null,
  'ni la sesión de Auth de la suya');

-- ---------------------------------------------------------------------------------------
-- Las dos funciones escriben; ninguna se salta el candado; el vigilante sigue en cero.

select pruebas.como_dueno();
select ok(
  (select bool_and(prosecdef and provolatile = 'v') from pg_proc
   where oid in ('private.open_playback(uuid, text, public.access_basis, boolean, uuid)'::regprocedure,
                 'private.touch_playback(uuid)'::regprocedure)),
  'abrir y latir son security definer y volátiles');
select ok(
  (select bool_and(pg_get_functiondef(oid) like '%pg_advisory_xact_lock%') from pg_proc
   where oid in ('private.open_playback(uuid, text, public.access_basis, boolean, uuid)'::regprocedure,
                 'private.touch_playback(uuid)'::regprocedure)),
  'las dos toman el candado de la cuenta');
select is(
  (select count(*)::int from public.audit_log where entity_table like '%playback_sessions'),
  0, 'reproducir no se audita');
select is((select count(*)::int from private.schema_violations()), 0, 'el vigilante no encuentra nada');

select * from finish();
rollback;
