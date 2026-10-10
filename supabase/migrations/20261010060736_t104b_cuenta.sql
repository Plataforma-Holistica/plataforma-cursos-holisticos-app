-- T-104 · La marca de quién fijó la contraseña (RF-101, RF-103). TRD §9.2, esquema §5.1.
-- Segunda entrega de T-104.
--
-- Supabase Auth conserva la contraseña del primer registro, y cualquiera puede dar de alta
-- un correo ajeno llamando directo a Auth. Por eso cada cuenta lleva una marca que nace
-- prendida y que solo se apaga cuando alguien canjeó un enlace del buzón y fijó la
-- contraseña en ese mismo paso. La guarda de sesión no deja entrar con la marca prendida.

alter table public.profiles
  add column password_reset_required boolean not null default true;  -- nace prendida; solo la apaga private.claim_account (RF-101)

-- ---------------------------------------------------------------------------------------
-- Primera capa, permisos: el servidor deja de poder escribir la tabla entera y recibe,
-- columna por columna, lo que sí le toca. La marca no está en la lista, ni el
-- identificador, ni las fechas de la fila. Una columna nueva de profiles se agrega aquí a
-- mano: sin permiso, el servidor recibe un error y no un acceso de más.

revoke update on public.profiles from app_service;
grant update (display_name, status, country_code, country_is_self_declared, locale, adult_declared_at,
              suspended_at, suspended_by, suspension_reason, suspended_for_fraud, comment_ban_until,
              deleted_at)
  on public.profiles to app_service;

-- ---------------------------------------------------------------------------------------
-- Segunda capa, guardián: al insertar la marca nace prendida, diga lo que diga quien
-- inserta; y solo cambia cuando quien ejecuta es el dueño de la tabla y viene de
-- private.claim_account(). El servidor puede poner cualquier ajuste de sesión, así que el
-- ajuste solo no basta: por eso se mira además quién ejecuta, y por eso esta función no es
-- "security definer". Ni el dueño de la tabla la cambia con un update suelto.

create function private.guard_password_reset_flag() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
begin
  if tg_op = 'INSERT' then
    new.password_reset_required := true;
    return new;
  end if;
  if new.password_reset_required is distinct from old.password_reset_required then
    select pg_catalog.pg_get_userbyid(c.relowner) into v_owner
    from pg_catalog.pg_class c where c.oid = tg_relid;
    if current_user::name <> v_owner
       or coalesce(pg_catalog.current_setting('app.claiming_account', true), '') <> 'on' then
      raise exception '%.%: password_reset_required changes only through private.claim_account()',
        tg_table_schema, tg_table_name using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

create trigger profiles_password_flag before insert or update on public.profiles
  for each row execute function private.guard_password_reset_flag();

-- ---------------------------------------------------------------------------------------
-- Apagar la marca. Sin argumentos: actúa sobre la cuenta por la que el servidor declaró
-- actuar, con el token que verificó, así que nadie reclama la cuenta de otro por pasar un
-- identificador equivocado. El servicio la llama después de fijar la contraseña, nunca antes.
--
--   claimed          la marca estaba prendida y se apagó ahora
--   already_claimed  ya estaba apagada (lo normal al recuperar la contraseña)
--   ineligible       sin actor, sin perfil, cuenta que no está activa o correo sin confirmar
--
-- Límite, que vale para todo el camino de servicio (ADR-31): por quién se actúa lo declara
-- el servidor. Las dos capas de arriba impiden que una consulta mal escrita apague la marca
-- con un update; esta función impide equivocarse de cuenta. Ninguna detiene a quien ya
-- pueda ejecutar consultas arbitrarias como app_service y declararse otra persona.

create function private.claim_account() returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_status public.profile_status;
  v_pending boolean;
begin
  if v_actor is null then
    return 'ineligible';
  end if;
  -- Con candado: dos reclamos a la vez de la misma cuenta se ordenan, y solo uno apaga.
  select p.status, p.password_reset_required into v_status, v_pending
  from public.profiles p where p.id = v_actor for update;
  if not found or v_status <> 'active' then
    return 'ineligible';
  end if;
  if not exists (select 1 from auth.users u where u.id = v_actor and u.email_confirmed_at is not null) then
    return 'ineligible';
  end if;
  if not v_pending then
    return 'already_claimed';
  end if;
  perform pg_catalog.set_config('app.claiming_account', 'on', true);
  update public.profiles set password_reset_required = false where id = v_actor;
  perform pg_catalog.set_config('app.claiming_account', '', true);
  return 'claimed';
end
$$;

grant execute on function private.claim_account() to app_service;

-- ---------------------------------------------------------------------------------------
-- El vigilante aprende a ver permisos por columna (16.3). Hasta hoy leía solo los permisos
-- de tabla: un `grant update (columna)` sobre un libro, o devolverle al servidor el permiso
-- de escribir profiles entera, no producían ninguna fila. Tampoco lo concedido a PUBLIC.
-- Y consents entra a los libros.

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
$$;

grant execute on function private.schema_violations() to app_service;
