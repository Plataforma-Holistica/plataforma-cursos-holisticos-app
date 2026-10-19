-- T-204 · Una reproducción a la vez (RF-107; 05 §5.4 y §9.5; TRD §6.1; FL-25). Decisiones de
-- Sergio del 2026-10-19: el límite trae su propio latido de presencia (los latidos con medición
-- son T-205, que se monta encima), en pausa se suelta el lugar, la vista previa del dueño
-- cuenta y la revisión del equipo no abre reproducción.
--
-- Una fila por reproducción, con la sesión de Auth que la abrió. «Viva» es sin revocar y con
-- un latido dentro de tres `LATIDO_SEGUNDOS`. Contra `SESIONES_SIMULTANEAS` solo cuentan las
-- vivas de otras sesiones de Auth: la misma sesión es la misma persona en el mismo navegador
-- (renovar la dirección, recargar, cambiar de lección, otra pestaña), y la nueva reemplaza a
-- la vieja en lugar de chocar con ella.
--
-- Nadie de la aplicación escribe la tabla: solo las dos funciones, que el servidor llama a
-- nombre de quien actúa (`private.actor_id()`) y con la sesión que declara
-- (`private.actor_session()`). Lo que una cuenta puede ver, con qué base y si cuenta para el
-- reparto ya lo decidió TypeScript (`getMediaGrant`); aquí se cuenta, se abre y se late, bajo
-- un candado por cuenta. La revocación no detiene un video por sí sola: la dirección de Mux no
-- se revoca (ADR-27), y el reproductor se detiene porque su latido la recibe.

-- ---------------------------------------------------------------------------------------
-- Con qué regla entró una reproducción (RF-306): las tres de la cuenta (RN-01) y las de la
-- lección (`MediaBasis` en `src/domain/access/media-access.ts`). `review` existe porque así lo
-- describe el esquema; la revisión del equipo no abre reproducción (decisión del 2026-10-19).

create type public.access_basis as enum ('subscription', 'grace', 'courtesy', 'open_course', 'owner_preview', 'review');

-- ---------------------------------------------------------------------------------------
-- La tabla. Las columnas de la medición (segundos aceptados, consecutivos) nacen aquí, como
-- las describe el esquema, y las escribe T-205.

create table public.playback_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id),
  auth_session_id uuid not null,              -- la sesión de Auth que la abrió; sin clave foránea: Auth borra las suyas
  course_id uuid not null references public.course_registry (course_id),
  lesson_id uuid not null,                    -- sin clave foránea: una lección puede dejar de estar publicada
  video_asset_id uuid not null references public.video_assets (id),
  teacher_id uuid not null references public.teachers (id),
  access_basis public.access_basis not null,  -- con qué regla entró (RF-306)
  counts_for_payout boolean not null,
  lesson_duration_seconds integer not null,
  started_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  accepted_media_seconds integer not null default 0,     -- para la revisión acumulada contra el reloj (RF-402, T-205)
  seqs_received int4multirange not null default '{}',    -- consecutivos ya recibidos (RNF-05, T-205)
  revoked_at timestamptz,
  revoke_reason text,
  revoked_by uuid references public.playback_sessions (id),   -- la reproducción que tomó su lugar, si la hubo
  constraint playback_sessions_duration_positive check (lesson_duration_seconds > 0),
  constraint playback_sessions_accepted_positive check (accepted_media_seconds >= 0),
  constraint playback_sessions_counts_only_paid
    check (not counts_for_payout or access_basis in ('subscription', 'grace')),
  constraint playback_sessions_revoke_reason_known
    check (revoke_reason in ('closed_by_user', 'replaced', 'session_closed', 'access_lost', 'admin')),
  constraint playback_sessions_revocation_consistent check ((revoked_at is null) = (revoke_reason is null)),
  constraint playback_sessions_revoked_by_reason
    check (revoked_by is null or revoke_reason in ('closed_by_user', 'replaced')),
  -- La revisión del equipo no abre reproducción (decisión de Sergio del 2026-10-19).
  constraint playback_sessions_not_review check (access_basis <> 'review')
);
comment on table public.playback_sessions is 'Una fila por reproducción (RF-107, RF-401). La escriben solo private.open_playback() y private.touch_playback() (T-204) y, con T-205, private.record_heartbeats().';
comment on column public.playback_sessions.auth_session_id is 'La sesión de Auth que abrió la reproducción: la misma sesión reemplaza, otra cuenta contra el cupo. No sale por la API de datos.';

-- Reproducciones vivas de una cuenta: el límite de SESIONES_SIMULTANEAS.
create index playback_sessions_live_idx
  on public.playback_sessions (profile_id, last_heartbeat_at) where revoked_at is null;
-- Las de una sesión de Auth: reemplazarlas, y revocarlas cuando la sesión se cierra.
create index playback_sessions_auth_session_idx
  on public.playback_sessions (auth_session_id) where revoked_at is null;
-- Purga junto con los latidos crudos (05 §11.4, con T-205).
create index playback_sessions_retention_idx on public.playback_sessions (started_at);
create index playback_sessions_revoked_by_idx on public.playback_sessions (revoked_by) where revoked_by is not null;

alter table public.playback_sessions enable row level security;

-- La persona lee las suyas, sin la sesión de Auth (05 §6). El servidor, todo, para leer.
grant select (id, profile_id, course_id, lesson_id, video_asset_id, teacher_id, access_basis,
              counts_for_payout, lesson_duration_seconds, started_at, last_heartbeat_at,
              accepted_media_seconds, seqs_received, revoked_at, revoke_reason, revoked_by)
  on public.playback_sessions to authenticated;
grant select on public.playback_sessions to app_service;
create policy playback_sessions_self_select on public.playback_sessions
  for select to authenticated using (profile_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------
-- Las vivas de la cuenta que no son de esta sesión de Auth: lo que cuenta contra el cupo, y la
-- lista de PA-34. Con el navegador de la sesión que la abrió (`private.app_sessions`, T-104),
-- que el servidor describe; nunca el id de esa sesión. Solo la usan las dos funciones de abajo.
--
-- Forma de cada elemento: {session_id, user_agent, lesson_title, course_title, started_at}.

create function private.live_playbacks(p_profile uuid, p_auth_session uuid, p_window interval)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'session_id', s.id,
           'user_agent', a.user_agent,
           'lesson_title', l.title,
           'course_title', c.title,
           'started_at', s.started_at) order by s.started_at, s.id), '[]'::jsonb)
  from public.playback_sessions s
  left join private.app_sessions a on a.session_id = s.auth_session_id
  left join public.published_lessons l on l.id = s.lesson_id
  left join public.published_courses c on c.course_id = s.course_id
  where s.profile_id = p_profile
    and s.auth_session_id <> p_auth_session
    and s.revoked_at is null
    and s.last_heartbeat_at > pg_catalog.now() - p_window
$$;

-- El cupo y la ventana, de los parámetros vigentes. Sin un entero positivo no se adivina (un
-- cupo de 0 dejaría a todos sin video): se lanza, y el servidor contesta «no se pudo».
create function private.playback_limits(out max_live integer, out heartbeat_seconds integer)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_max jsonb := private.parameter_value('SESIONES_SIMULTANEAS');
  v_beat jsonb := private.parameter_value('LATIDO_SEGUNDOS');
begin
  if pg_catalog.jsonb_typeof(v_max) is distinct from 'number' or pg_catalog.jsonb_typeof(v_beat) is distinct from 'number'
     or (v_max)::text !~ '^[1-9][0-9]*$' or (v_beat)::text !~ '^[1-9][0-9]*$' then
    raise exception 'playback limits are not set' using errcode = 'P0001';
  end if;
  max_live := (v_max)::text::integer;
  heartbeat_seconds := (v_beat)::text::integer;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Abrir. Lo pide el servidor después de decidir y de firmar, con la lección, el playback id que
-- firmó (para anotar ese video y no otro), la base y si cuenta. `p_closing` es la reproducción
-- que la persona eligió cerrar en PA-34, o la que tomó su lugar cuando pulsa «Reproducir aquí».
--
-- Contesta (nula si no hay quien actúe o no declaró su sesión):
--   {outcome: 'opened', session_id, heartbeat_seconds}
--   {outcome: 'busy', live: [...]}       sin lugar: no cierra ni anota nada
--   {outcome: 'not_found'}               la lección no existe o su video no es el firmado
--   {outcome: 'session_closed'}          la sesión de Auth se cerró después de pasar la guarda
--
-- El candado solo sirve si contar toma una foto nueva después de esperarlo: eso pasa en read
-- committed, y por eso se exige, como en private.claim_account().

create function private.open_playback(
  p_lesson uuid, p_playback_id text, p_basis public.access_basis, p_counts boolean, p_closing uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_session uuid := private.actor_session();
  v_limits record;
  v_window interval;
  v_lesson record;
  v_live jsonb;
  v_id uuid;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.open_playback() needs read committed isolation' using errcode = '25000';
  end if;
  if v_actor is null or v_session is null then
    return null;
  end if;

  select l.course_id, l.video_asset_id, l.teacher_id, l.duration_seconds
    into v_lesson
  from public.published_lessons l
  join public.video_assets v on v.id = l.video_asset_id
  where l.id = p_lesson and v.provider_playback_id = p_playback_id;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;

  v_limits := private.playback_limits();
  v_window := pg_catalog.make_interval(secs => 3 * v_limits.heartbeat_seconds);

  -- Una cuenta a la vez: dos peticiones no pasan las dos por el último lugar, y cerrar una para
  -- abrir otra no deja hueco.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('playback:' || v_actor::text, 0));

  -- La sesión sigue anotada, y no se puede quitar hasta que esta apertura termine: cerrar la
  -- sesión espera, y su disparador ve la reproducción nueva y la suelta. Sin esto, una sesión
  -- cerrada mientras se abría dejaría una reproducción viva.
  perform 1 from private.app_sessions a where a.session_id = v_session and a.profile_id = v_actor for key share;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'session_closed');
  end if;

  -- La que se elige cerrar no cuenta; si de todos modos no hay lugar, no se cierra.
  select coalesce(pg_catalog.jsonb_agg(e), '[]'::jsonb) into v_live
  from pg_catalog.jsonb_array_elements(private.live_playbacks(v_actor, v_session, v_window)) e
  where p_closing is null or (e ->> 'session_id')::uuid <> p_closing;
  if pg_catalog.jsonb_array_length(v_live) >= v_limits.max_live then
    return pg_catalog.jsonb_build_object('outcome', 'busy', 'live', v_live);
  end if;

  insert into public.playback_sessions (
    profile_id, auth_session_id, course_id, lesson_id, video_asset_id, teacher_id, access_basis,
    counts_for_payout, lesson_duration_seconds)
  values (
    v_actor, v_session, v_lesson.course_id, p_lesson, v_lesson.video_asset_id, v_lesson.teacher_id,
    p_basis, p_counts, v_lesson.duration_seconds)
  returning id into v_id;

  if p_closing is not null then
    update public.playback_sessions s
    set revoked_at = pg_catalog.now(), revoke_reason = 'closed_by_user', revoked_by = v_id
    where s.id = p_closing and s.profile_id = v_actor and s.auth_session_id <> v_session and s.revoked_at is null;
  end if;

  -- La misma persona en el mismo navegador: la nueva reemplaza a la suya.
  update public.playback_sessions s
  set revoked_at = pg_catalog.now(), revoke_reason = 'replaced', revoked_by = v_id
  where s.profile_id = v_actor and s.auth_session_id = v_session and s.id <> v_id and s.revoked_at is null;

  return pg_catalog.jsonb_build_object('outcome', 'opened', 'session_id', v_id,
                                       'heartbeat_seconds', v_limits.heartbeat_seconds);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Latir (la presencia). Contesta (nula si no hay quien actúe o no declaró su sesión):
--   {outcome: 'ok'}                                  viva, o vencida y con lugar: el latido queda anotado
--   {outcome: 'busy', live: [...]}                   vencida, y otro dispositivo tomó el lugar
--   {outcome: 'revoked', reason, by}                 con el motivo y, si la hubo, la que tomó su lugar
--   {outcome: 'not_found'}                           no existe, o es de otra cuenta o de otra sesión de Auth
-- T-205 la llama antes de `record_heartbeats`, en la misma transacción (05 §9.2).

create function private.touch_playback(p_session uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_auth uuid := private.actor_session();
  v_row public.playback_sessions%rowtype;
  v_limits record;
  v_window interval;
  v_live jsonb;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.touch_playback() needs read committed isolation' using errcode = '25000';
  end if;
  if v_actor is null or v_auth is null then
    return null;
  end if;

  v_limits := private.playback_limits();
  v_window := pg_catalog.make_interval(secs => 3 * v_limits.heartbeat_seconds);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('playback:' || v_actor::text, 0));

  select * into v_row from public.playback_sessions s
  where s.id = p_session and s.profile_id = v_actor and s.auth_session_id = v_auth
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;
  if v_row.revoked_at is not null then
    return pg_catalog.jsonb_build_object('outcome', 'revoked', 'reason', v_row.revoke_reason, 'by', v_row.revoked_by);
  end if;

  -- Vencida (una pausa larga, una pestaña congelada): vuelve a pasar por el cupo.
  if v_row.last_heartbeat_at <= pg_catalog.now() - v_window then
    v_live := private.live_playbacks(v_actor, v_auth, v_window);
    if pg_catalog.jsonb_array_length(v_live) >= v_limits.max_live then
      return pg_catalog.jsonb_build_object('outcome', 'busy', 'live', v_live);
    end if;
  end if;

  update public.playback_sessions s set last_heartbeat_at = pg_catalog.now() where s.id = p_session;
  return pg_catalog.jsonb_build_object('outcome', 'ok');
end
$$;

revoke all on function private.live_playbacks(uuid, uuid, interval), private.playback_limits(),
  private.open_playback(uuid, text, public.access_basis, boolean, uuid), private.touch_playback(uuid) from public;
grant execute on function
  private.open_playback(uuid, text, public.access_basis, boolean, uuid), private.touch_playback(uuid)
  to app_service;

-- ---------------------------------------------------------------------------------------
-- Cerrar una sesión de Auth suelta sus reproducciones, la cierre quien la cierre: toda función
-- que la cierra (cerrar una o las demás desde la cuenta, reclamar, cambiar la contraseña, las
-- invitaciones) quita su anotación de `private.app_sessions`. Así «cierra todas las sesiones»
-- de PA-34 (FL-25, A2) libera el lugar al momento.

create function private.release_playback_of_closed_session()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.playback_sessions s
  set revoked_at = pg_catalog.now(), revoke_reason = 'session_closed'
  where s.auth_session_id = old.session_id and s.revoked_at is null;
  return old;
end
$$;
revoke all on function private.release_playback_of_closed_session() from public;

create trigger app_sessions_release_playback
  after delete on private.app_sessions
  for each row execute function private.release_playback_of_closed_session();

-- ---------------------------------------------------------------------------------------
-- El vigilante aprende la tabla: ningún rol de la aplicación la escribe directo.

create or replace function private.schema_violations()
returns table (problem text, object_name text)
language sql stable security definer set search_path = ''
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
  union all
  -- La marca de contraseña solo la cambia private.claim_account() (TRD 9.2).
  select 'password_reset_required writable by ' || r.rolname, 'public.profiles'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.profiles'::regclass, 'password_reset_required', 'UPDATE')
  union all
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
  union all
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
  -- Los hechos de la cuenta todavía no los escribe nadie de la aplicación (T-202). La
  -- escritura llega con quien la necesita: las suscripciones con T-302 y T-303, la cortesía
  -- con T-307, y cada una la abre aquí.
  select 'account facts table writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.subscriptions'), ('public.courtesy_grants')) as t (table_name)
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
  union all
  -- Las reproducciones solo las escriben sus funciones (T-204): abrir, latir y, con T-205, los
  -- latidos con medición.
  select 'playback table writable by ' || r.rolname, 'public.playback_sessions'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.playback_sessions'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.playback_sessions'::regclass, 'DELETE, TRUNCATE, TRIGGER')
$$;
