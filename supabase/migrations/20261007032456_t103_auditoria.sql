-- T-103 · El libro de auditoría (RF-706, RNF-12).
-- Esquema de backend §5.9 (tabla), §6.2 (quién actúa), §7.1 (solo inserción) y §7.4
-- (auditoría por disparador).
--
-- Va antes que identidad porque las tablas de identidad nacen ya auditadas. La política que
-- deja leer este libro a configuración llega en la migración de identidad, que es donde
-- nace la capacidad: hasta entonces el libro está cerrado para toda sesión.

-- ---------------------------------------------------------------------------------------
-- Quién actúa (6.2)

-- Las tres leen el token de la sesión con auth.jwt() y auth.uid(). Son "security definer"
-- para que app_service, que no tiene uso del esquema auth, también pueda llamarlas. Solo
-- leen variables de la propia transacción: no dan acceso a ninguna tabla.

-- Nivel de autenticación de la sesión: aal2 es "con segundo factor" (RF-106).
create function private.is_aal2() returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2' $$;

-- Quién actúa. En el camino del usuario es la sesión. En el camino de servicio, el servidor
-- lo declara en la transacción: select set_config('app.actor_id', '<uuid>', true).
create function private.actor_id() returns uuid
language sql stable security definer set search_path = ''
as $$ select coalesce((select auth.uid()), nullif(current_setting('app.actor_id', true), '')::uuid) $$;

-- Un trabajo programado se declara como sistema: set_config('app.actor_kind', 'system', true).
create function private.actor_is_system() returns boolean
language sql stable security definer set search_path = ''
as $$ select (select auth.uid()) is null and coalesce(current_setting('app.actor_kind', true), '') = 'system' $$;

grant execute on function private.is_aal2(), private.actor_id(), private.actor_is_system()
  to authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- La tabla (5.9)

create table public.audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid,                              -- nulo si lo hizo un trabajo del sistema
  actor_kind text not null,
  category public.audit_category not null,
  action text not null,                       -- 'business_parameters.insert'
  entity_table text not null,
  entity_id text,
  old_value jsonb,                            -- nunca un dato cifrado en claro
  new_value jsonb,
  reason text,
  request_id text,                            -- liga con el registro técnico
  constraint audit_log_actor_kind_known check (actor_kind in ('user', 'system')),
  constraint audit_log_actor_consistent check (actor_kind = 'system' or actor_id is not null)
);
comment on table public.audit_log is 'Registro de auditoría (RF-706). Solo inserción. Sin clave foránea al autor: sobrevive a todo.';

-- Consulta de la auditoría por fecha y por categoría (PA-87).
create index audit_log_time_idx on public.audit_log (occurred_at desc);
create index audit_log_category_idx on public.audit_log (category, occurred_at desc);
-- Historia de una entidad: "qué le pasó a este parámetro".
create index audit_log_entity_idx on public.audit_log (entity_table, entity_id, occurred_at desc);
-- Todo lo que hizo una persona.
create index audit_log_actor_idx on public.audit_log (actor_id, occurred_at desc) where actor_id is not null;

-- ---------------------------------------------------------------------------------------
-- Seguridad por fila y privilegios (6.4, 6.5)

alter table public.audit_log enable row level security;

grant select on public.audit_log to authenticated;
-- El servidor lee e inserta. Las lecturas delicadas se auditan a mano desde el servicio.
grant select, insert on public.audit_log to app_service;

-- Segundo factor obligatorio (RF-106). Es restrictiva: se suma a las demás con "y".
create policy audit_log_require_aal2 on public.audit_log
  as restrictive for all to authenticated
  using ((select private.is_aal2()));

-- ---------------------------------------------------------------------------------------
-- Solo inserción (7.1). Ni el dueño de la tabla puede actualizar, borrar o vaciar.

create function private.reject_mutation() returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'append-only ledger %.%: % is not allowed', tg_table_schema, tg_table_name, tg_op
    using errcode = '42501';
end
$$;

create trigger ledger_no_update_delete before update or delete on public.audit_log
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on public.audit_log
  for each statement execute function private.reject_mutation();

-- ---------------------------------------------------------------------------------------
-- Auditoría por disparador (7.4). Cada tabla administrativa lo cuelga en su propia migración.
-- Primer argumento: la categoría. Los demás: columnas que no deben quedar escritas en el registro.

create function private.audit_row_change() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_system boolean := private.actor_is_system();
  v_redact text[] := coalesce(tg_argv[1:], '{}');
  v_old jsonb;
  v_new jsonb;
begin
  -- Sin autor no hay cambio: el registro y el cambio viven o mueren juntos.
  if v_actor is null and not v_system then
    raise exception 'audited change on %.% without an actor', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  if tg_op <> 'INSERT' then v_old := to_jsonb(old) - v_redact; end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new) - v_redact; end if;
  if tg_op = 'UPDATE' and v_old = v_new then
    return null;
  end if;
  insert into public.audit_log (
    actor_id, actor_kind, category, action, entity_table, entity_id, old_value, new_value, reason, request_id)
  values (
    v_actor,
    case when v_actor is null then 'system' else 'user' end,
    tg_argv[0]::public.audit_category,
    tg_table_name || '.' || lower(tg_op),
    tg_table_schema || '.' || tg_table_name,
    coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'course_id', v_new ->> 'period_id', v_old ->> 'period_id'),
    v_old,
    v_new,
    nullif(current_setting('app.reason', true), ''),
    nullif(current_setting('app.request_id', true), ''));
  return null;
end
$$;
