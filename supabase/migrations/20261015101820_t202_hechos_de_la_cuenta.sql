-- T-202 · Los hechos de la puerta única de medios (RF-306; RN-01; TRD §5.1; 05 §5.3).
-- Decisión de Sergio del 2026-10-15: T-202 va completa ahora, y las dos tablas de los hechos
-- de la cuenta nacen aquí sin nadie de la aplicación que las escriba, como lo publicado en
-- T-107. T-302 y T-303 (suscripciones) y T-307 (cortesías) traen a quien escribe, y abren
-- en el vigilante la escritura que les toca.
--
-- Lo que el servidor le pregunta a la base son dos funciones:
--   · `private.media_facts(lección)`: en un solo valor, los hechos de quien actúa (su cuenta,
--     su suscripción más reciente, sus cortesías, si es maestro) y los de la lección, con la
--     hora de la base. Sin el playback id. La regla (RN-01 y RF-306) vive en TypeScript.
--   · `private.lesson_playback(lección)`: el playback id, solo si pasa una condición gruesa
--     en SQL. Es la segunda barrera: aunque el servicio se equivoque, a una cuenta común no le
--     sale el video de un curso sin publicar.
-- Quien actúa sale siempre de `private.actor_id()`: bajo el servidor no hay `auth.uid()`.

create type public.subscription_plan as enum ('monthly', 'annual');
create type public.subscription_status as enum ('pending', 'active', 'in_grace', 'canceled', 'expired', 'refunded');

-- ---------------------------------------------------------------------------------------
-- Las tablas, como 05 §5.3.

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id),
  provider text not null,
  provider_subscription_id text not null,
  provider_customer_id text,
  plan public.subscription_plan not null,
  pending_plan public.subscription_plan,      -- cambio de anual a mensual al terminar el año (RF-207)
  status public.subscription_status not null default 'pending',
  currency text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,             -- fin del último periodo PAGADO: el "paidThrough" de RN-01. No se copia del proveedor de cobro, que lo avanza aunque el cobro falle (T-201; se confirma en T-303)
  cancel_at_period_end boolean not null default false,   -- RF-204
  canceled_at timestamptz,
  last_renewal_failed_at timestamptz,         -- abre la gracia (RF-205)
  ended_at timestamptz,
  provider_state_at timestamptz,              -- qué tan reciente es lo leído del proveedor (RF-208)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_provider_uq unique (provider, provider_subscription_id),
  constraint subscriptions_provider_known check (provider in ('stripe', 'mercadopago', 'manual')),
  constraint subscriptions_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint subscriptions_period_order check (current_period_end > current_period_start),
  constraint subscriptions_active_has_period check (status = 'pending' or current_period_end is not null),
  constraint subscriptions_grace_has_failure check (status <> 'in_grace' or last_renewal_failed_at is not null),
  -- Una fecha `infinity` llega a la regla como fecha inválida, que es «no se supo»: quien paga
  -- se quedaría sin video. Sin fin se escribe nulo.
  constraint subscriptions_finite_dates check (isfinite(current_period_start) and isfinite(current_period_end)
                                               and isfinite(last_renewal_failed_at) and isfinite(ended_at))
);
-- Hechos de la cuenta para RN-01, en cada petición con acceso.
create index subscriptions_profile_idx on public.subscriptions (profile_id, current_period_end desc);
-- Las de una cuenta de las que pueden salir los hechos (`private.media_facts`: la viva, y si no
-- hay, la más reciente).
create index subscriptions_latest_idx on public.subscriptions (profile_id, created_at desc, id desc)
  where status <> 'pending';
-- Una cuenta no tiene dos suscripciones cobrando a la vez.
create unique index subscriptions_one_live_uq
  on public.subscriptions (profile_id) where status in ('active', 'in_grace');
-- Avisos antes de renovar (RF-214) y vencimiento de la gracia (RF-205).
create index subscriptions_renewal_idx on public.subscriptions (current_period_end)
  where status in ('active', 'in_grace') and not cancel_at_period_end;

create trigger touch_updated_at before update on public.subscriptions
  for each row execute function private.touch_updated_at();

create table public.courtesy_grants (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id),
  reason text not null,                       -- RF-213: siempre con motivo
  starts_at timestamptz not null default now(),
  ends_at timestamptz,                        -- nulo: sin fecha de fin
  granted_by uuid not null references public.profiles (id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id),
  constraint courtesy_grants_order check (ends_at is null or ends_at > starts_at),
  constraint courtesy_grants_revocation_consistent check ((revoked_at is null) = (revoked_by is null)),
  constraint courtesy_grants_finite_dates check (isfinite(starts_at) and isfinite(ends_at))   -- sin fin es nulo, no `infinity`
);
-- Hechos de la cuenta para RN-01: las ventanas de cortesía ("courtesy", T-201), de starts_at a ends_at; ends_at nulo es sin fin.
create index courtesy_grants_profile_idx on public.courtesy_grants (profile_id) where revoked_at is null;

-- ---------------------------------------------------------------------------------------
-- Quién lee: cada quien lo suyo, y Soporte todo (05 §6.4 y §6.5). Nadie de la aplicación
-- escribe todavía: ni el servidor, ni una persona. El vigilante, abajo, lo exige.

alter table public.subscriptions enable row level security;
alter table public.courtesy_grants enable row level security;

grant select on public.subscriptions, public.courtesy_grants to authenticated, app_service;

create policy subscriptions_self_select on public.subscriptions
  for select to authenticated using (profile_id = (select auth.uid()));
create policy courtesy_grants_self_select on public.courtesy_grants
  for select to authenticated using (profile_id = (select auth.uid()));
create policy subscriptions_support_select on public.subscriptions
  for select to authenticated using ((select private.has_capability('support'::public.capability)));
create policy courtesy_grants_support_select on public.courtesy_grants
  for select to authenticated using ((select private.has_capability('support'::public.capability)));

-- ---------------------------------------------------------------------------------------
-- Los hechos. Forma (nula si no hay quien actúe o no tiene perfil):
--   {now,
--    viewer: {suspended, email_verified, teacher_id},
--    subscription: null | {paid_through, failed_at, ended_at, refunded, grace_days},
--    courtesy: [{from, until}],
--    lesson: null | {is_current, provider, ready, duration_seconds, teacher_id, course_state, listed, is_open}}
--
-- · La suscripción es la viva de quien actúa (`active` o `in_grace`: solo puede haber una), y
--   si no hay, la más reciente sin contar las `pending`, que nunca se pagaron. Así una que se
--   abre y no se termina de pagar, o una más nueva que el cobro dio por terminada, no tapa a
--   la que paga (decisión de Sergio del 2026-10-15, tras la revisión del diff). Los cuatro
--   hechos salen de esa misma, para que el fin de una vieja no corte una nueva (T-201).
-- · `grace_days` es el parámetro vigente a la hora de la falla, para que subirlo no reviva un
--   acceso terminado. Sin falla va nulo: la gracia no se usa. Con falla y nulo (el parámetro
--   no existía entonces), quien lo lea lo trata como «no se supo».
-- · El maestro es el de quien actúa en `active` o `suspended`: suspendido sigue viendo lo
--   suyo (RF-702, solo lectura; decisión de Sergio del 2026-10-15).
-- · Abierto lo dice `course_registry`, que tiene las restricciones (solo publicado, uno a la
--   vez); listado, `published_courses`.

create function private.media_facts(p_lesson uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_viewer jsonb;
  v_subscription jsonb;
  v_courtesy jsonb;
  v_lesson jsonb;
begin
  if v_actor is null then
    return null;
  end if;

  select pg_catalog.jsonb_build_object(
           'suspended', p.status <> 'active',
           'email_verified', coalesce(u.email_confirmed_at is not null, false),
           'teacher_id', (select t.id from public.teachers t
                          where t.profile_id = v_actor and t.status in ('active', 'suspended')))
    into v_viewer
  from public.profiles p
  left join auth.users u on u.id = p.id
  where p.id = v_actor;
  if v_viewer is null then
    return null;
  end if;

  select pg_catalog.jsonb_build_object(
           'paid_through', s.current_period_end,
           'failed_at', s.last_renewal_failed_at,
           'ended_at', s.ended_at,
           'refunded', s.status = 'refunded',
           'grace_days', case when s.last_renewal_failed_at is not null
                              then private.parameter_value('GRACIA_COBRO_DIAS', s.last_renewal_failed_at) end)
    into v_subscription
  from public.subscriptions s
  where s.profile_id = v_actor and s.status <> 'pending'
  order by s.status in ('active', 'in_grace') desc, s.created_at desc, s.id desc
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('from', g.starts_at, 'until', g.ends_at)
                                       order by g.starts_at, g.id), '[]'::jsonb)
    into v_courtesy
  from public.courtesy_grants g
  where g.profile_id = v_actor and g.revoked_at is null;

  select pg_catalog.jsonb_build_object(
           'is_current', l.is_current,
           'provider', v.provider,
           'ready', v.status = 'ready',
           'duration_seconds', l.duration_seconds,
           'teacher_id', l.teacher_id,
           'course_state', r.state,
           'listed', c.is_listed,
           'is_open', r.is_open)
    into v_lesson
  from public.published_lessons l
  join public.published_courses c on c.course_id = l.course_id
  join public.course_registry r on r.course_id = l.course_id
  join public.video_assets v on v.id = l.video_asset_id
  where l.id = p_lesson;

  return pg_catalog.jsonb_build_object(
    'now', pg_catalog.now(),
    'viewer', v_viewer,
    'subscription', v_subscription,
    'courtesy', v_courtesy,
    'lesson', v_lesson);
end
$$;

-- El playback id, solo con la condición gruesa: la lección vigente con su video de Mux
-- listo, y además un curso publicado y listado, o quien actúa es su maestro (en cualquier
-- estado del curso), o tiene Contenido. Lo demás, nulo. No es RN-01: si la cuenta tiene acceso
-- lo decide la regla de TypeScript antes de llamar aquí.
create function private.lesson_playback(p_lesson uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select v.provider_playback_id
  from public.published_lessons l
  join public.published_courses c on c.course_id = l.course_id
  join public.course_registry r on r.course_id = l.course_id
  join public.video_assets v on v.id = l.video_asset_id
  where l.id = p_lesson
    and private.actor_id() is not null
    and l.is_current
    and v.provider = 'mux'
    and v.status = 'ready'
    and ((c.is_listed and r.state in ('published', 'changes_pending'))
         or l.teacher_id = (select t.id from public.teachers t
                            where t.profile_id = private.actor_id() and t.status in ('active', 'suspended'))
         or private.actor_has_capability('content'))
$$;

revoke all on function private.media_facts(uuid), private.lesson_playback(uuid) from public;
grant execute on function private.media_facts(uuid), private.lesson_playback(uuid) to app_service;

-- ---------------------------------------------------------------------------------------
-- El vigilante aprende las dos tablas: ningún rol de la aplicación las escribe todavía.

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
$$;
