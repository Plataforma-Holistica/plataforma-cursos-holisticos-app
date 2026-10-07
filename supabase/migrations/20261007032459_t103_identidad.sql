-- T-103 · Identidad y permisos: profiles y admin_capabilities.
-- Esquema de backend §5.1 (tablas), §6.2 (funciones), §6.4 y §6.5 (privilegios y políticas),
-- §7.2 (una sola puerta) y §7.4 (auditoría).
--
-- Una cuenta no tiene un rol: tiene hechos. Es administrador quien tiene una capacidad
-- activa. Las demás tablas del dominio (maestros, invitaciones, datos fiscales, alias)
-- llegan con la tarea que las usa.

-- ---------------------------------------------------------------------------------------
-- Tablas (5.1)

create table public.profiles (
  id uuid primary key,                        -- el mismo valor que auth.users.id (ADR-15)
  display_name text,                          -- nombre que la persona escribe (RF-109)
  status public.profile_status not null default 'active',
  country_code text,                          -- para las líneas de ayuda (RF-804)
  country_is_self_declared boolean not null default false,
  locale text not null default 'es-MX',
  adult_declared_at timestamptz,              -- declaró tener EDAD_MINIMA (RF-101)
  suspended_at timestamptz,
  suspended_by uuid references public.profiles (id),
  suspension_reason text,
  suspended_for_fraud boolean not null default false,  -- RN-08: solo así se excluye su consumo
  comment_ban_until timestamptz,              -- derecho a comentar suspendido (RF-704)
  deleted_at timestamptz,                     -- lápida (RF-110)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_length check (char_length(display_name) between 1 and 120),
  constraint profiles_country_format check (country_code ~ '^[A-Z]{2}$'),
  constraint profiles_suspended_consistent check ((status = 'suspended') = (suspended_at is not null)),
  constraint profiles_suspension_has_reason check (suspended_at is null or suspension_reason is not null),
  constraint profiles_tombstone_is_empty check (
    status <> 'deleted'
    or (deleted_at is not null and display_name is null and country_code is null
        and adult_declared_at is null and comment_ban_until is null))
);
comment on table public.profiles is 'Una fila por cuenta. No guarda correo ni rol: el correo vive en auth.users y el rol se deriva.';

create table public.admin_capabilities (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id),
  capability public.capability not null,
  granted_by uuid references public.profiles (id),   -- nulo solo en las dos filas de arranque
  granted_at timestamptz not null default now(),
  revoked_by uuid references public.profiles (id),
  revoked_at timestamptz,
  constraint admin_capabilities_revocation_consistent check ((revoked_at is null) = (revoked_by is null))
);
-- Una capacidad activa por persona. Lo consulta has_capability() en cada petición (RF-105).
create unique index admin_capabilities_active_uq
  on public.admin_capabilities (profile_id, capability) where revoked_at is null;

-- ---------------------------------------------------------------------------------------
-- Funciones auxiliares (6.2)

-- ¿La persona de la sesión tiene esta capacidad, con segundo factor?
-- Lee la tabla en cada consulta: quitar una capacidad surte efecto de inmediato (RF-105).
create function private.has_capability(p_capability public.capability) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_aal2() and exists (
    select 1 from public.admin_capabilities c
    where c.profile_id = (select auth.uid())
      and c.capability = p_capability
      and c.revoked_at is null)
$$;

-- ¿Quien actúa tiene esta capacidad? Sirve a los dos caminos. Lo usan los disparadores
-- para que una ruta que olvidó comprobar no pueda escribir.
create function private.actor_has_capability(p_capability public.capability) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
      select 1 from public.admin_capabilities c
      where c.profile_id = private.actor_id()
        and c.capability = p_capability
        and c.revoked_at is null)
    and case
      when (select auth.uid()) is not null then private.is_aal2()
      else coalesce(current_setting('app.actor_aal', true), '') = 'aal2'
    end
$$;

grant execute on function
  private.has_capability(public.capability), private.actor_has_capability(public.capability)
  to authenticated, app_service;

-- Alta de una cuenta: la identidad nace en Supabase Auth y aquí nace su perfil.
-- Es lo que mantiene profiles.id igual a auth.users.id sin clave foránea.
-- Las tareas que traen más tablas por cuenta (privacidad, avisos) amplían esta función.
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- updated_at se mantiene solo.
create function private.touch_updated_at() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger touch_updated_at before update on public.profiles
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------
-- Seguridad por fila y privilegios (6.4)

alter table public.profiles enable row level security;
alter table public.admin_capabilities enable row level security;

grant select on public.profiles, public.admin_capabilities to authenticated;
-- La única escritura de una persona con su sesión: sus propios datos de perfil.
grant update (display_name, country_code, country_is_self_declared, locale) on public.profiles to authenticated;

-- El servidor. Sobre las capacidades, solo dar y revocar.
grant select, insert, update on public.profiles to app_service;
grant select, insert on public.admin_capabilities to app_service;
grant update (revoked_at, revoked_by) on public.admin_capabilities to app_service;

-- ---------------------------------------------------------------------------------------
-- Políticas (6.5)

create policy profiles_self_select on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) and status = 'active')
  with check (id = (select auth.uid()) and status = 'active');
create policy profiles_support_select on public.profiles
  for select to authenticated
  using ((select private.has_capability('support'::public.capability)));

create policy admin_capabilities_self_select on public.admin_capabilities
  for select to authenticated using (profile_id = (select auth.uid()));
create policy admin_capabilities_config_select on public.admin_capabilities
  for select to authenticated
  using ((select private.has_capability('config'::public.capability)));

-- La auditoría la lee quien tiene configuración, y nadie más (RF-706). Vive aquí porque
-- aquí nace la capacidad; la tabla y su política de segundo factor están en la migración
-- anterior.
create policy audit_log_config_select on public.audit_log
  for select to authenticated
  using ((select private.has_capability('config'::public.capability)));

-- ---------------------------------------------------------------------------------------
-- Una sola puerta (7.2): de una capacidad solo cambia su revocación, una vez.

create function private.allow_only_columns() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_allowed text[] := tg_argv::text[];
  v_old jsonb;
  v_new jsonb;
  v_col text;
begin
  if tg_op = 'DELETE' then
    raise exception 'append-only ledger %.%: DELETE is not allowed', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  if (v_old - v_allowed) is distinct from (v_new - v_allowed) then
    raise exception '%.%: only % may change', tg_table_schema, tg_table_name, v_allowed
      using errcode = '42501';
  end if;
  foreach v_col in array v_allowed loop
    if (v_old -> v_col) <> 'null'::jsonb and (v_old -> v_col) is distinct from (v_new -> v_col) then
      raise exception '%.%: % is write-once', tg_table_schema, tg_table_name, v_col
        using errcode = '42501';
    end if;
  end loop;
  return new;
end
$$;

create trigger admin_capabilities_guard before update or delete on public.admin_capabilities
  for each row execute function private.allow_only_columns('revoked_at', 'revoked_by');

-- RF-712: siempre quedan al menos dos personas con capacidad de configuración.
create function private.guard_min_config_admins() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.capability = 'config' and old.revoked_at is null and new.revoked_at is not null then
    if (select count(distinct c.profile_id) from public.admin_capabilities c
        where c.capability = 'config' and c.revoked_at is null) < 2 then
      raise exception 'at least two people must keep the config capability (RF-712)'
        using errcode = '23514';
    end if;
  end if;
  return null;
end
$$;

create trigger admin_capabilities_min_config after update on public.admin_capabilities
  for each row execute function private.guard_min_config_admins();

-- ---------------------------------------------------------------------------------------
-- Auditoría (7.4)

create trigger audit_changes after insert or update or delete on public.admin_capabilities
  for each row execute function private.audit_row_change('access');

-- Un perfil cambia mucho sin que sea un acto administrativo: se audita solo la sanción.
create trigger audit_profile_sanctions after update on public.profiles
  for each row
  when (old.status is distinct from new.status
     or old.comment_ban_until is distinct from new.comment_ban_until
     or old.suspended_for_fraud is distinct from new.suspended_for_fraud)
  execute function private.audit_row_change('access');
