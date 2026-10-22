-- Ola 0 · El vigilante por áreas. Antes de trabajar en dos carriles en paralelo (decisión de
-- Sergio del 2026-10-21), `private.schema_violations()` se reescribía entera en cada migración: si
-- dos ramas la reemplazaban, ganaba la de marca de tiempo más tardía y las reglas de la otra
-- desaparecían sin error.
--
-- Desde aquí el vigilante son funciones de área, `private.schema_violations_<área>()`, una por
-- dominio, y un agregador que las descubre en el catálogo. Agregar reglas es crear un área nueva
-- (por dominio: `schema_violations_anomalies` para T-208), sin tocar las demás ni el agregador.
-- Las reglas y sus textos son los de antes, sin cambiar una letra; `supabase/tests/27_vigilante.test.sql`
-- provoca cada una. Hay una sola regla nueva, en `base`: un área no la ejecuta nadie de la
-- aplicación.
--
-- Un área es `language sql stable set search_path = ''`, con la firma del vigilante, sin
-- `security definer` y sin permisos para nadie: la corre el agregador, que sí es definer, con los
-- permisos de su dueño. Cada área repite dentro las listas que usa (`app_roles`, `ledgers`,
-- `watch_tables`) para bastarse sola, y la regla de las funciones del sistema se reparte con el
-- mismo texto entre las áreas dueñas de cada firma.
--
-- Mientras haya dos carriles, las áreas `base`, `ledgers`, `account` y `team`, el agregador y
-- `private.watchdog_areas()` no se tocan. Una excepción nueva a las reglas de `base` (un permiso
-- previsto para una persona con sesión) va en una solicitud corta que solo cambia esa área.

-- ---------------------------------------------------------------------------------------
-- La base (T-103 y T-104): seguridad por fila, funciones, PUBLIC, escrituras de los roles de
-- usuario, el esquema privado y la clave secreta.

create function private.schema_violations_base()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  -- Tablas propias sin seguridad por fila (RNF-08).
  select 'table without row level security', n.nspname || '.' || c.relname
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and not c.relrowsecurity
  union all
  -- Funciones security definer sin search_path fijo.
  select 'security definer function without a fixed search_path', n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosecdef
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%')
  union all
  -- Funciones propias que cualquiera puede ejecutar.
  select 'function executable by PUBLIC', n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and pg_catalog.has_function_privilege('public', p.oid, 'execute')
  union all
  -- Escrituras a nivel de tabla para roles de usuario, fuera de la única prevista.
  select 'unexpected write privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  where g.grantee in ('anon', 'authenticated')
    and g.table_schema in ('public', 'private')
    and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    and not (g.grantee = 'authenticated' and g.table_name = 'saved_courses'
             and g.privilege_type in ('INSERT', 'DELETE'))
  union all
  -- Lo mismo, columna por columna, que no sale en la consulta de arriba. La única escritura
  -- por columnas prevista es la de la persona sobre sus propios datos de perfil.
  select distinct 'unexpected column write privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.grantee in ('anon', 'authenticated')
    and g.table_schema in ('public', 'private')
    and g.privilege_type in ('INSERT', 'UPDATE')
    and not (g.grantee = 'authenticated' and g.table_schema = 'public' and g.table_name = 'profiles'
             and g.privilege_type = 'UPDATE'
             and g.column_name in ('display_name', 'country_code', 'country_is_self_declared', 'locale'))
    and not (g.grantee = 'authenticated' and g.table_schema = 'public' and g.table_name = 'saved_courses'
             and g.privilege_type = 'INSERT')
  union all
  -- Del esquema privado, ni una columna, ni para leer.
  select distinct 'unexpected column privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.table_schema = 'private' and g.grantee in ('anon', 'authenticated')
  union all
  -- Nada concedido a todos: PUBLIC incluye al visitante y a cualquier rol que llegue después.
  select distinct 'privilege granted to PUBLIC', g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.grantee = 'PUBLIC' and g.table_schema in ('public', 'private')
  union all
  -- La clave secreta no toca tablas propias. Ningún rol de usuario toca el esquema privado.
  select 'unexpected privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  where (g.grantee = 'service_role' and g.table_schema in ('public', 'private'))
     or (g.grantee in ('anon', 'authenticated') and g.table_schema = 'private')
  union all
  -- Un área del vigilante no la ejecuta nadie de la aplicación: la corre el agregador, como su
  -- dueño (ola 0). La regla de arriba solo ve lo concedido a PUBLIC.
  select 'watchdog area executable by ' || r.rolname, n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private'
  cross join (values ('anon'), ('authenticated'), ('service_role'), ('app_service')) as r (rolname)
  where p.proname like 'schema\_violation%' and p.proname <> 'schema_violations'
    and pg_catalog.has_function_privilege(r.rolname::name, p.oid, 'EXECUTE')
$$;
revoke all on function private.schema_violations_base() from public;

-- ---------------------------------------------------------------------------------------
-- Los libros (T-103 y T-104): ningún rol de la aplicación edita ni borra uno, ni una columna.

create function private.schema_violations_ledgers()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with ledgers (table_schema, table_name) as (
    values
      ('public', 'watch_events'), ('public', 'charges'), ('public', 'charge_reversals'),
      ('public', 'revenue_allocations'), ('public', 'payout_student_pools'), ('public', 'payout_shares'),
      ('public', 'payout_teacher_totals'), ('public', 'payout_status_events'),
      ('public', 'payout_adjustments'), ('public', 'teacher_balance_entries'),
      ('public', 'reserve_entries'), ('public', 'legal_documents'), ('public', 'consents'),
      ('public', 'licenses'), ('public', 'audit_log'), ('private', 'teacher_tax_profiles'),
      ('private', 'student_aliases'), ('private', 'moderation_actions'),
      ('private', 'moderation_case_access_log')),
  app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service'))
  -- Ningún rol de la aplicación puede editar ni borrar un libro.
  select 'ledger writable by ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  join ledgers l on l.table_schema = g.table_schema and l.table_name = g.table_name
  where g.grantee in (select r.rolname from app_roles r)
    and g.privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
  union all
  -- Ni editar una sola de sus columnas: el permiso por columna no sale en la consulta de arriba.
  select 'ledger column writable by ' || r.rolname, l.table_schema || '.' || l.table_name
  from ledgers l
  join pg_catalog.pg_namespace n on n.nspname = l.table_schema
  join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = l.table_name
  cross join app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, c.oid, 'UPDATE')
$$;
revoke all on function private.schema_violations_ledgers() from public;

-- ---------------------------------------------------------------------------------------
-- La cuenta (T-104 y T-202): la marca de contraseña y los hechos de la cuenta.

create function private.schema_violations_account()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service'))
  -- La marca de contraseña solo la cambia private.claim_account() (TRD 9.2).
  select 'password_reset_required writable by ' || r.rolname, 'public.profiles'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.profiles'::regclass, 'password_reset_required', 'UPDATE')
  union all
  -- Los hechos de la cuenta todavía no los escribe nadie de la aplicación (T-202). La
  -- escritura llega con quien la necesita: las suscripciones con T-302 y T-303, la cortesía
  -- con T-307, y cada una la abre aquí.
  select 'account facts table writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.subscriptions'), ('public.courtesy_grants')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
$$;
revoke all on function private.schema_violations_account() from public;

-- ---------------------------------------------------------------------------------------
-- El equipo (T-105): las capacidades, las invitaciones y las ataduras.

create function private.schema_violations_team()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service'))
  -- Las capacidades solo se escriben con las funciones que cambian el equipo (T-105).
  select 'admin_capabilities writable by ' || r.rolname, 'public.admin_capabilities'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.admin_capabilities'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.admin_capabilities'::regclass, 'DELETE, TRUNCATE')
  union all
  -- Las invitaciones y las ataduras no las toca ningún rol de la aplicación, ni para leer.
  select 'team table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('private.admin_invitations'), ('private.admin_factors')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
$$;
revoke all on function private.schema_violations_team() from public;

-- ---------------------------------------------------------------------------------------
-- El catálogo y lo publicado (T-106 y T-107). Del carril B mientras haya dos.

create function private.schema_violations_catalog()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service'))
  -- Las prácticas y los niveles solo los escriben las funciones de las listas (T-106).
  select 'catalog list writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.practices'), ('public.levels')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Lo publicado y lo que lo sostiene solo lo escriben las funciones de cargar y aprobar
  -- (T-107).
  select 'publication table writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.teachers'), ('public.published_teachers'), ('public.course_registry'),
                     ('public.video_assets'), ('public.published_courses'), ('public.published_modules'),
                     ('public.published_lessons')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- El orden de desempate de un maestro nunca sale de la base (RN-07).
  select 'teachers.tiebreak_rank readable by ' || r.rolname, 'public.teachers'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.teachers'::regclass, 'tiebreak_rank', 'SELECT')
  union all
  -- Lo que solo corre el dueño de la base, declarado sistema, no lo ejecuta nadie más.
  select 'system function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.system_catalog_add(public.catalog_list, text)'),
                     ('private.system_add_teacher(text, text, text)'),
                     ('private.system_load_course(uuid, jsonb)'),
                     ('private.catalog_place(public.catalog_list, text)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
$$;
revoke all on function private.schema_violations_catalog() from public;

-- ---------------------------------------------------------------------------------------
-- Los latidos (T-205). Del carril A mientras haya dos.

create function private.schema_violations_watch()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  watch_tables (oid) as (
    select 'public.watch_events'::regclass::oid
    union all
    select i.inhrelid from pg_catalog.pg_inherits i where i.inhparent = 'public.watch_events'::regclass)
  -- El libro de latidos y cada partición: solo private.record_heartbeats() escribe, y nadie de
  -- la aplicación lee los latidos crudos (T-205).
  select 'watch ledger reachable by ' || r.rolname, 'public.' || c.relname
  from watch_tables w
  join pg_catalog.pg_class c on c.oid = w.oid
  cross join app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, c.oid, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- El seguro contra vaciar no pasa de la madre a las particiones: cada una lleva el suyo.
  select 'watch partition without truncate guard', 'public.' || c.relname
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.watch_events'::regclass
    and not exists (
      select 1 from pg_catalog.pg_trigger t
      where t.tgrelid = c.oid and t.tgname = 'ledger_no_truncate' and t.tgenabled <> 'D')
  union all
  -- El seguro de editar y borrar sí pasa de la madre, pero se puede apagar en una partición.
  select 'watch partition without update guard', 'public.' || c.relname
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.watch_events'::regclass
    and not exists (
      select 1 from pg_catalog.pg_trigger t
      where t.tgrelid = c.oid and t.tgname = 'ledger_no_update_delete' and t.tgenabled <> 'D')
  union all
  -- Sin partición por omisión: un tramo sin su mes no entra.
  select 'watch default partition', 'public.' || c.relname
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.watch_events'::regclass and c.relpartbound is not null
    and pg_catalog.pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
  union all
  -- La partición del mes que sigue ya existe: si pg_cron dejó de correr, se sabe antes de que
  -- los latidos empiecen a fallar.
  select 'watch partition missing for next month', 'public.watch_events_' || m.period
  from (select pg_catalog.to_char(
                 pg_catalog.date_trunc('month', pg_catalog.timezone(
                   coalesce(private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}', 'UTC'), pg_catalog.now()))
                 + interval '1 month', 'YYYYMM') as period) m
  where pg_catalog.to_regclass('public.watch_events_' || m.period) is null
  union all
  -- Los rechazos solo los escribe private.record_heartbeats() (T-205).
  select 'heartbeat rejections reachable by ' || r.rolname, 'private.heartbeat_rejection_counts'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'private.heartbeat_rejection_counts'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, 'private.heartbeat_rejection_counts'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Las particiones de latidos las crea el dueño (la migración y pg_cron).
  select 'system function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.create_watch_partition(public.period_id)'),
                     ('private.ensure_watch_partitions(integer, text)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
$$;
revoke all on function private.schema_violations_watch() from public;

-- ---------------------------------------------------------------------------------------
-- Las reproducciones (T-204). Del carril A mientras haya dos.

create function private.schema_violations_playback()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service'))
  -- Las reproducciones solo las escriben sus funciones (T-204): abrir, latir y, con T-205, los
  -- latidos con medición.
  select 'playback table writable by ' || r.rolname, 'public.playback_sessions'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.playback_sessions'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.playback_sessions'::regclass, 'DELETE, TRUNCATE, TRIGGER')
$$;
revoke all on function private.schema_violations_playback() from public;

-- ---------------------------------------------------------------------------------------
-- El progreso (T-206) y rehacerlo (T-207). Del carril A mientras haya dos.

create function private.schema_violations_progress()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service'))
  -- El progreso solo lo escribe private.record_heartbeats() (T-206), y el servidor no lo lee
  -- entero: pregunta dónde se quedó quien actúa con private.lesson_position().
  select 'progress writable by ' || r.rolname, 'public.lesson_progress'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.lesson_progress'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.lesson_progress'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  select 'progress readable by ' || r.rolname, 'public.lesson_progress'
  from app_roles r
  where r.rolname <> 'authenticated'
    and pg_catalog.has_any_column_privilege(r.rolname::name, 'public.lesson_progress'::regclass, 'SELECT')
  union all
  -- La persona lee su avance, no los tramos ni de qué reproducción vino.
  select 'progress spans readable by authenticated', 'public.lesson_progress'
  where pg_catalog.has_column_privilege('authenticated', 'public.lesson_progress'::regclass, 'covered', 'SELECT')
     or pg_catalog.has_column_privilege('authenticated', 'public.lesson_progress'::regclass, 'last_playback_session_id', 'SELECT')
     or pg_catalog.has_column_privilege('authenticated', 'public.lesson_progress'::regclass, 'last_seq', 'SELECT')
  union all
  -- Lo que falta rehacer no lo toca nadie de la aplicación.
  select 'progress rebuilds reachable by ' || r.rolname, 'private.progress_rebuilds'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'private.progress_rebuilds'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, 'private.progress_rebuilds'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Dónde se quedó alguien lo pregunta solo el servidor, y fundir no lo ejecuta nadie.
  select 'progress function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.lesson_position(uuid)'),
                     ('private.merge_progress(public.playback_sessions, int4multirange, integer, integer, timestamptz)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
    and not (r.rolname = 'app_service' and f.signature = 'private.lesson_position(uuid)')
  union all
  -- Rehacer el progreso lo corre solo el dueño de la base (pg_cron).
  select 'system function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.rebuild_pair(uuid, uuid, timestamptz)'),
                     ('private.rebuild_progress()')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
$$;
revoke all on function private.schema_violations_progress() from public;

-- ---------------------------------------------------------------------------------------
-- La consolidación (T-207). Del carril A mientras haya dos.

create function private.schema_violations_rollup()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service'))
  -- Las marcas, los días, el consolidado y las corridas no los toca ningún rol de la
  -- aplicación, ni para leer. Los escriben private.record_heartbeats() y la corrida; los días
  -- los leerá la persona cuando haya quien los pinte (T-505), y el consolidado, el maestro y
  -- finanzas por sus funciones (T-408, T-605).
  select 'consolidation table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('private.rollup_dirty'), ('public.practice_days'), ('public.watch_rollup'),
                     ('public.job_definitions'), ('public.job_runs')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- La consolidación la corre solo el dueño de la base (pg_cron, y db:rollup en local).
  select 'system function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.half_points(integer, integer, integer, integer)'),
                     ('private.payout_thresholds(public.period_id)'),
                     ('private.rollup_pair(public.period_id, uuid, uuid, uuid, integer, integer)'),
                     ('private.rollup_window()'),
                     ('private.open_job_run(text, public.period_id, text)'),
                     ('private.close_job_run(uuid, text)'),
                     ('private.rollup_step(uuid, timestamptz, uuid, uuid, integer)'),
                     ('private.nightly_rollup(boolean, integer)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
$$;
revoke all on function private.schema_violations_rollup() from public;

-- ---------------------------------------------------------------------------------------
-- Las áreas que hay: toda función de `private` cuyo nombre empieza como el del vigilante, salvo
-- el agregador, con la razón por la que no se puede usar, o nula. Un área tiene nombre
-- `schema_violations_<minúsculas, dígitos y guiones bajos>`, es una función (no un procedimiento),
-- sin argumentos, con la firma del vigilante y del mismo dueño que el agregador: una función de
-- otro dueño no se ejecuta con los permisos de este.

create function private.watchdog_areas()
returns table (function_name text, unusable_reason text)
language sql stable set search_path = ''
as $$
  select p.proname::text,
         case when p.proname !~ '^schema_violations_[a-z0-9_]+$' then 'name'
              when p.proowner <> me.proowner then 'owner'
              when p.prokind <> 'f' then 'kind'
              when p.pronargs <> 0 then 'arguments'
              when pg_catalog.pg_get_function_result(p.oid) <> 'TABLE(problem text, object_name text)' then 'result'
         end
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private'
  cross join (select q.proowner from pg_catalog.pg_proc q
              where q.oid = 'private.schema_violations()'::regprocedure) me
  where p.proname like 'schema\_violation%'
    and not (p.proname = 'schema_violations' and p.pronargs = 0)
$$;
revoke all on function private.watchdog_areas() from public;

-- ---------------------------------------------------------------------------------------
-- El agregador: la misma firma y el mismo permiso de siempre (lo llaman las pruebas de base y el
-- servidor). Corre cada área en orden de nombre. Un área que no se puede usar, o que lanza, se
-- dice con una fila y no tumba a las demás; sin ninguna área, también lo dice: el vigilante nunca
-- se queda callado por un error suyo.

create or replace function private.schema_violations()
returns table (problem text, object_name text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_area record;
  v_run integer := 0;
begin
  for v_area in
    select a.function_name, a.unusable_reason from private.watchdog_areas() a order by a.function_name
  loop
    if v_area.unusable_reason is not null then
      problem := 'watchdog area not usable: ' || v_area.unusable_reason;
      object_name := 'private.' || v_area.function_name;
      return next;
      continue;
    end if;
    v_run := v_run + 1;
    begin
      return query execute pg_catalog.format(
        'select v.problem, v.object_name from private.%I() as v', v_area.function_name);
    exception when others then
      problem := 'watchdog area failed (' || sqlstate || '): ' || sqlerrm;
      object_name := 'private.' || v_area.function_name;
      return next;
    end;
  end loop;
  if v_run = 0 then
    problem := 'watchdog found no areas';
    object_name := 'private.schema_violations';
    return next;
  end if;
end
$$;
revoke all on function private.schema_violations() from public;
grant execute on function private.schema_violations() to app_service;
