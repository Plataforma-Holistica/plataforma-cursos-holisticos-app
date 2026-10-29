-- Ola 0 · El vigilante por áreas. Antes de trabajar en dos carriles, `private.schema_violations()`
-- se partió en funciones de área (`private.schema_violations_<área>()`) que un agregador descubre
-- en el catálogo: agregar reglas es crear un área, sin reescribir las demás, y dos ramas en
-- paralelo ya no se borran las reglas una a la otra.
--
-- La primera parte provoca cada una de las 31 reglas y exige su texto exacto para el objeto que
-- la provoca: se escribió contra el vigilante de antes, y tiene que seguir pasando igual. La
-- segunda prueba la mecánica: qué áreas hay, que nadie de la aplicación las ejecuta, y que un área
-- que no sirve o que lanza se reporta en vez de tumbar al vigilante.
begin;
\ir _ayuda.psql
select plan(64);

-- Los problemas que el vigilante dice de un objeto, ordenados.
create function pruebas.vigila(p_object text) returns text[]
language sql as $$
  select coalesce(array_agg(v.problem order by v.problem), '{}') from private.schema_violations() v where v.object_name = p_object
$$;

select is_empty('select * from private.schema_violations()', 'de entrada, el vigilante no dice nada');

-- ---------------------------------------------------------------------------------------
-- Las reglas de la base: tablas y funciones de prueba.

create table public.zz_tabla (id integer, nota text);
select is(pruebas.vigila('public.zz_tabla'), array['table without row level security'], 'una tabla sin seguridad por fila');
alter table public.zz_tabla enable row level security;
select is(pruebas.vigila('public.zz_tabla'), '{}'::text[], 'con ella, nada');

create function public.zz_definer() returns integer language sql security definer as 'select 1';
select is(pruebas.vigila('public.zz_definer'), array['security definer function without a fixed search_path'],
  'una función security definer sin search_path fijo');
alter function public.zz_definer() set search_path = '';
grant execute on function public.zz_definer() to public;
select is(pruebas.vigila('public.zz_definer'), array['function executable by PUBLIC'], 'una función que cualquiera ejecuta');
revoke execute on function public.zz_definer() from public;

grant insert on public.zz_tabla to anon;
select is(pruebas.vigila('public.zz_tabla'),
  array['unexpected column write privilege for anon', 'unexpected write privilege for anon'],
  'escribir una tabla, para el visitante (y por eso cada columna)');
revoke insert on public.zz_tabla from anon;
grant update (nota) on public.zz_tabla to authenticated;
select is(pruebas.vigila('public.zz_tabla'), array['unexpected column write privilege for authenticated'],
  'editar una columna, para la persona con sesión');
revoke update (nota) on public.zz_tabla from authenticated;
grant select on public.zz_tabla to public;
select is(pruebas.vigila('public.zz_tabla'), array['privilege granted to PUBLIC'], 'un permiso para todos');
revoke select on public.zz_tabla from public;
grant select on public.zz_tabla to service_role;
select is(pruebas.vigila('public.zz_tabla'), array['unexpected privilege for service_role'], 'cualquier permiso para la clave secreta');
revoke select on public.zz_tabla from service_role;

create table private.zz_privada (id integer, nota text);
alter table private.zz_privada enable row level security;
grant select (nota) on private.zz_privada to authenticated;
select is(pruebas.vigila('private.zz_privada'), array['unexpected column privilege for authenticated'],
  'una columna del esquema privado, aunque sea para leer');
revoke select (nota) on private.zz_privada from authenticated;
grant select on private.zz_privada to anon;
select is(pruebas.vigila('private.zz_privada'), array['unexpected column privilege for anon', 'unexpected privilege for anon'],
  'o la tabla entera');
revoke select on private.zz_privada from anon;

-- Las excepciones escritas: la lista propia (insertar y borrar), las cuatro columnas de la persona
-- y dónde se quedó, solo para el servidor. La de la lista sigue en el área `base`, congelada,
-- pero desde T-210 (decisión de Sergio del 2026-10-28: la escribe el servidor) el área `catalog`
-- la prohíbe: el área `base` no dice nada propio, y el vigilante sí (36_mi_lista).
do $$ begin
  if to_regclass('public.saved_courses') is null then
    create table public.saved_courses (profile_id uuid, course_id uuid);
    alter table public.saved_courses enable row level security;
  end if;
end $$;
grant insert, delete on public.saved_courses to authenticated;
select is(pruebas.vigila('public.saved_courses'), array['saved list writable by authenticated'],
  'la lista propia: insertar y borrar, el área base no lo dice; el catálogo, sí');
grant update on public.saved_courses to authenticated;
select is(pruebas.vigila('public.saved_courses'),
  array['saved list writable by authenticated', 'unexpected column write privilege for authenticated',
        'unexpected write privilege for authenticated'], 'editarla, tampoco el área base');
revoke insert, update, delete on public.saved_courses from authenticated;
grant update (display_name, country_code, country_is_self_declared, locale) on public.profiles to authenticated;
select is(pruebas.vigila('public.profiles'), '{}'::text[], 'las cuatro columnas de la persona, sí');
grant update (status) on public.profiles to authenticated;
select is(pruebas.vigila('public.profiles'), array['unexpected column write privilege for authenticated'], 'otra, no');
revoke update (status) on public.profiles from authenticated;
select ok(has_function_privilege('app_service', 'private.lesson_position(uuid)', 'execute')
          and not exists (select 1 from private.schema_violations() where object_name = 'private.lesson_position(uuid)'),
  'dónde se quedó alguien, para el servidor, sí');
grant execute on function private.lesson_position(uuid) to authenticated;
select is(pruebas.vigila('private.lesson_position(uuid)'), array['progress function executable by authenticated'],
  'para la persona, no');
revoke execute on function private.lesson_position(uuid) from authenticated;

-- ---------------------------------------------------------------------------------------
-- Los libros.

grant update on public.audit_log to app_service;
select is(pruebas.vigila('public.audit_log'), array['ledger column writable by app_service', 'ledger writable by app_service'],
  'editar un libro');
revoke update on public.audit_log from app_service;
grant update (ip) on public.consents to app_service;
select is(pruebas.vigila('public.consents'), array['ledger column writable by app_service'], 'o una columna de un libro');
revoke update (ip) on public.consents from app_service;

-- ---------------------------------------------------------------------------------------
-- Los latidos (T-205).

select set_config('pruebas.particion',
  format('public.watch_events_%s', to_char(now() at time zone 'America/Mexico_City', 'YYYYMM')), true);
do $$ begin execute format('grant select on %s to app_service', current_setting('pruebas.particion')); end $$;
select is(pruebas.vigila(current_setting('pruebas.particion')), array['watch ledger reachable by app_service'], 'leer una partición');
do $$ begin execute format('revoke select on %s from app_service', current_setting('pruebas.particion')); end $$;
do $$ begin execute format('alter table %s disable trigger ledger_no_truncate', current_setting('pruebas.particion')); end $$;
select is(pruebas.vigila(current_setting('pruebas.particion')), array['watch partition without truncate guard'],
  'una partición sin su seguro de vaciar');
do $$ begin execute format('alter table %s enable trigger ledger_no_truncate', current_setting('pruebas.particion')); end $$;
do $$ begin execute format('alter table %s disable trigger ledger_no_update_delete', current_setting('pruebas.particion')); end $$;
select is(pruebas.vigila(current_setting('pruebas.particion')), array['watch partition without update guard'],
  'o sin el de editar');
do $$ begin execute format('alter table %s enable trigger ledger_no_update_delete', current_setting('pruebas.particion')); end $$;
create table public.watch_events_zz partition of public.watch_events default;
alter table public.watch_events_zz enable row level security;
select ok('watch default partition' = any (pruebas.vigila('public.watch_events_zz')), 'una partición por omisión');
drop table public.watch_events_zz;
select set_config('pruebas.siguiente',
  format('watch_events_%s', to_char(date_trunc('month', now() at time zone 'America/Mexico_City') + interval '1 month', 'YYYYMM')), true);
do $$ begin execute format('alter table public.%I rename to zz_falta', current_setting('pruebas.siguiente')); end $$;
select is(pruebas.vigila('public.' || current_setting('pruebas.siguiente')), array['watch partition missing for next month'],
  'la partición del mes que sigue, que falta');
do $$ begin execute format('alter table public.zz_falta rename to %I', current_setting('pruebas.siguiente')); end $$;
grant select on private.heartbeat_rejection_counts to app_service;
select is(pruebas.vigila('private.heartbeat_rejection_counts'), array['heartbeat rejections reachable by app_service'],
  'los rechazos');
revoke select on private.heartbeat_rejection_counts from app_service;

-- ---------------------------------------------------------------------------------------
-- La cuenta y el equipo (T-104 a T-105, T-202).

grant update (password_reset_required) on public.profiles to app_service;
select is(pruebas.vigila('public.profiles'), array['password_reset_required writable by app_service'], 'la marca de contraseña');
revoke update (password_reset_required) on public.profiles from app_service;
grant insert on public.subscriptions to app_service;
select is(pruebas.vigila('public.subscriptions'), array['account facts table writable by app_service'], 'los hechos de la cuenta');
revoke insert on public.subscriptions from app_service;
grant insert on public.admin_capabilities to app_service;
select is(pruebas.vigila('public.admin_capabilities'), array['admin_capabilities writable by app_service'], 'las capacidades');
revoke insert on public.admin_capabilities from app_service;
grant select on private.admin_invitations to app_service;
select is(pruebas.vigila('private.admin_invitations'), array['team table reachable by app_service'], 'las invitaciones');
revoke select on private.admin_invitations from app_service;

-- ---------------------------------------------------------------------------------------
-- El catálogo y lo publicado (T-106, T-107).

grant insert on public.practices to app_service;
select is(pruebas.vigila('public.practices'), array['catalog list writable by app_service'], 'las prácticas');
revoke insert on public.practices from app_service;
grant insert on public.video_assets to app_service;
select is(pruebas.vigila('public.video_assets'), array['publication table writable by app_service'], 'lo publicado');
revoke insert on public.video_assets from app_service;
grant select (tiebreak_rank) on public.teachers to app_service;
select is(pruebas.vigila('public.teachers'), array['teachers.tiebreak_rank readable by app_service'], 'el orden de desempate');
revoke select (tiebreak_rank) on public.teachers from app_service;

-- Las dieciséis funciones del sistema, de cuatro tareas.
create temporary table sistema (signature text primary key);
insert into sistema values
  ('private.system_catalog_add(public.catalog_list, text)'), ('private.system_add_teacher(text, text, text)'),
  ('private.system_load_course(uuid, jsonb)'), ('private.catalog_place(public.catalog_list, text)'),
  ('private.create_watch_partition(public.period_id)'), ('private.ensure_watch_partitions(integer, text)'),
  ('private.half_points(integer, integer, integer, integer)'), ('private.payout_thresholds(public.period_id)'),
  ('private.rollup_pair(public.period_id, uuid, uuid, uuid, integer, integer)'), ('private.rollup_window()'),
  ('private.open_job_run(text, public.period_id, text)'), ('private.close_job_run(uuid, text)'),
  ('private.rollup_step(uuid, timestamptz, uuid, uuid, integer)'), ('private.nightly_rollup(boolean, integer)'),
  ('private.rebuild_pair(uuid, uuid, timestamptz)'), ('private.rebuild_progress()');
do $$ declare v text; begin
  for v in select signature from sistema loop execute format('grant execute on routine %s to app_service, anon', v); end loop;
end $$;
select is(
  (select array_agg(v.object_name order by v.object_name) from private.schema_violations() v
   where v.problem = 'system function executable by app_service'),
  (select array_agg(signature order by signature) from sistema), 'cada función del sistema, para el servidor');
select is(
  (select array_agg(v.object_name order by v.object_name) from private.schema_violations() v
   where v.problem = 'system function executable by anon'),
  (select array_agg(signature order by signature) from sistema), 'y para el visitante');
do $$ declare v text; begin
  for v in select signature from sistema loop execute format('revoke execute on routine %s from app_service, anon', v); end loop;
end $$;

-- ---------------------------------------------------------------------------------------
-- Reproducciones, progreso y consolidación (T-204 a T-207).

grant update on public.playback_sessions to app_service;
select is(pruebas.vigila('public.playback_sessions'), array['playback table writable by app_service'], 'las reproducciones');
revoke update on public.playback_sessions from app_service;
grant insert on public.lesson_progress to app_service;
select is(pruebas.vigila('public.lesson_progress'), array['progress writable by app_service'], 'escribir el progreso');
revoke insert on public.lesson_progress from app_service;
grant select on public.lesson_progress to app_service;
select is(pruebas.vigila('public.lesson_progress'), array['progress readable by app_service'], 'leerlo, el servidor');
revoke select on public.lesson_progress from app_service;
grant select (covered) on public.lesson_progress to authenticated;
select is(pruebas.vigila('public.lesson_progress'), array['progress spans readable by authenticated'], 'los tramos, la persona');
revoke select (covered) on public.lesson_progress from authenticated;
grant select on private.progress_rebuilds to app_service;
select is(pruebas.vigila('private.progress_rebuilds'), array['progress rebuilds reachable by app_service'], 'lo que falta rehacer');
revoke select on private.progress_rebuilds from app_service;
grant execute on function private.merge_progress(public.playback_sessions, int4multirange, integer, integer, timestamptz) to app_service;
select is(pruebas.vigila('private.merge_progress(public.playback_sessions, int4multirange, integer, integer, timestamptz)'),
  array['progress function executable by app_service'], 'fundir el progreso');
revoke execute on function private.merge_progress(public.playback_sessions, int4multirange, integer, integer, timestamptz) from app_service;
grant select on public.job_runs to app_service;
select is(pruebas.vigila('public.job_runs'), array['consolidation table reachable by app_service'], 'las corridas');
revoke select on public.job_runs from app_service;

select is_empty('select * from private.schema_violations()', 'sin nada concedido, otra vez nada');

-- ---------------------------------------------------------------------------------------
-- Las áreas: qué hay y quién las ejecuta.

select ok((select prosecdef from pg_proc where oid = 'private.schema_violations()'::regprocedure), 'el agregador es security definer');
select ok((select 'search_path=""' = any (proconfig) from pg_proc where oid = 'private.schema_violations()'::regprocedure),
  'con el search_path vacío');
select ok(has_function_privilege('app_service', 'private.schema_violations()', 'execute'), 'el servidor lo ejecuta');
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r
                      where has_function_privilege(r, 'private.schema_violations()', 'execute')), 'nadie más de la aplicación');
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) r
                      where has_function_privilege(r, 'private.watchdog_areas()', 'execute')), 'el descubrimiento, nadie');

select ok((select array_agg(function_name) from private.watchdog_areas()) @> array[
    'schema_violations_base', 'schema_violations_ledgers', 'schema_violations_account', 'schema_violations_team',
    'schema_violations_catalog', 'schema_violations_watch', 'schema_violations_playback', 'schema_violations_progress',
    'schema_violations_rollup'],
  'están las nueve áreas de la ola 0');
select is_empty('select * from private.watchdog_areas() where unusable_reason is not null', 'y todas se pueden usar');
-- Cada área que haya, también las que agreguen los carriles.
select is_empty($$
  select a.function_name from private.watchdog_areas() a
  join pg_proc p on p.proname = a.function_name and p.pronamespace = 'private'::regnamespace
  cross join unnest(array['anon', 'authenticated', 'service_role', 'app_service']) r
  where has_function_privilege(r, p.oid, 'execute')$$, 'ningún área la ejecuta nadie de la aplicación');
select is_empty($$
  select a.function_name from private.watchdog_areas() a
  join pg_proc p on p.proname = a.function_name and p.pronamespace = 'private'::regnamespace
  where p.prosecdef or not ('search_path=""' = any (coalesce(p.proconfig, '{}')))$$,
  'ni es security definer, y tiene el search_path vacío');

grant execute on function private.schema_violations_team() to authenticated;
select is(pruebas.vigila('private.schema_violations_team'), array['watchdog area executable by authenticated'],
  'y el vigilante dice si alguien le concede ejecutar un área');
revoke execute on function private.schema_violations_team() from authenticated;

set local role app_service;
select is_empty('select * from private.schema_violations()', 'como el servidor, el vigilante corre y no dice nada');
select throws_ok('select * from private.schema_violations_base()', '42501', null, 'pero un área sola no la puede llamar');
reset role;

-- ---------------------------------------------------------------------------------------
-- La mecánica: un área nueva entra sola, y la que no sirve o lanza se dice.

create function private.schema_violations_zz_prueba() returns table (problem text, object_name text)
language sql stable set search_path = '' as $$ select 'zz problem'::text, 'zz.object'::text $$;
revoke all on function private.schema_violations_zz_prueba() from public;
select is(pruebas.vigila('zz.object'), array['zz problem'], 'un área nueva entra sin tocar el agregador');
drop function private.schema_violations_zz_prueba();

create function private.schema_violations_zz_lanza() returns table (problem text, object_name text)
language plpgsql stable set search_path = '' as $$ begin raise exception 'zz' using errcode = 'P0001'; end $$;
create table public.zz_otra (id integer);
select lives_ok('select * from private.schema_violations()', 'un área que lanza no tumba al vigilante');
select is(pruebas.vigila('private.schema_violations_zz_lanza'), array['watchdog area failed (P0001): zz'], 'se dice cuál');
select is(pruebas.vigila('public.zz_otra'), array['table without row level security'], 'y las demás áreas siguen vigilando');
drop function private.schema_violations_zz_lanza();
drop table public.zz_otra;

create function private.schema_violation_zz() returns table (problem text, object_name text)
language sql stable set search_path = '' as $$ select 'nunca'::text, 'nunca'::text $$;
create function private.schema_violations_zz_args(p integer) returns table (problem text, object_name text)
language sql stable set search_path = '' as $$ select 'nunca'::text, 'nunca'::text $$;
create function private.schema_violations_zz_forma() returns setof text
language sql stable set search_path = '' as $$ select 'nunca'::text $$;
create procedure private.schema_violations_zz_proc() language sql as $$ select 1 $$;
select is(
  (select array_agg(v.object_name || ' ' || v.problem order by v.object_name) from private.schema_violations() v
   where v.problem like 'watchdog area not usable%'),
  array['private.schema_violation_zz watchdog area not usable: name',
        'private.schema_violations_zz_args watchdog area not usable: arguments',
        'private.schema_violations_zz_forma watchdog area not usable: result',
        'private.schema_violations_zz_proc watchdog area not usable: kind'],
  'un nombre, unos argumentos, una forma o un tipo que no son los de un área se dicen, y no se ejecutan');
select ok(not exists (select 1 from private.schema_violations() where problem = 'nunca'), 'ninguno corrió');
drop function private.schema_violation_zz();
drop function private.schema_violations_zz_args(integer);
drop function private.schema_violations_zz_forma();
drop procedure private.schema_violations_zz_proc();

-- Un área de otro dueño no se ejecuta con los permisos del agregador, aunque cualquiera la pueda
-- ejecutar (Postgres le da el permiso a PUBLIC al crearla).
grant create on schema private to app_service;
set local role app_service;
create function private.schema_violations_zz_ajena() returns table (problem text, object_name text)
language sql stable set search_path = '' as $$ select 'ajena'::text, 'ajena'::text $$;
reset role;
select ok('watchdog area not usable: owner' = any (pruebas.vigila('private.schema_violations_zz_ajena')),
  'un área de otro dueño se dice');
select ok(not exists (select 1 from private.schema_violations() where problem = 'ajena'), 'y no se ejecuta');
select ok('function executable by PUBLIC' = any (pruebas.vigila('private.schema_violations_zz_ajena')),
  'y también que cualquiera la ejecuta');
drop function private.schema_violations_zz_ajena();
revoke create on schema private from app_service;

-- Sin áreas, el vigilante no se queda callado.
do $$ declare v text; begin
  for v in select function_name from private.watchdog_areas() loop
    execute format('alter function private.%I() rename to %I', v, 'zz_' || v);
  end loop;
end $$;
select is((select array_agg(problem) from private.schema_violations()), array['watchdog found no areas'],
  'sin ninguna área, lo dice');

select * from finish();
rollback;
