-- T-401, primera solicitud: el maestro activo en el guardián de lo publicado (RF-702; criterio del 06:
-- un maestro suspendido no puede enviar cursos). Decisión de Sergio del 2026-10-29: va antes que el
-- editor de cursos (T-402, carril B), que escribe el registro de cursos a nombre del maestro, y con el
-- contrato que el carril B pidió: a nombre del maestro activo solo se da de alta un borrador limpio suyo
-- y se borra un borrador suyo que nunca se publicó. Ningún cambio a su nombre: el resto lo siguen
-- haciendo el sistema y Contenido, como desde T-107.

-- ---------------------------------------------------------------------------------------
-- El maestro activo de quien actúa: con la fila del maestro activa y la cuenta activa. Toma la fila del
-- maestro para compartir, así que escribir a su nombre y suspender al maestro van uno tras otro, y por
-- eso es volátil. La fila de la cuenta no la toma: suspender la cuenta no espera (la guarda de sesión la
-- detiene en la siguiente petición). Quien actúa sale de `private.actor_id()`: la persona por su sesión,
-- o la que el servidor declara (las funciones del borrador corren por el servidor, sin sesión de la
-- persona). Solo dentro de una escritura, y por eso no la ejecuta ningún rol de la aplicación: la llaman
-- las funciones del dueño. Para leer está `private.current_teacher_id()` (un candado de fila falla en una
-- transacción de solo lectura). Una función que escribe a nombre del maestro la llama antes de tocar
-- `course_registry`, prácticas, niveles o `course_lock`: el guardián solo la vuelve a comprobar, y para
-- entonces ya tiene la fila del curso.

create function private.current_active_teacher_id() returns uuid
language sql volatile security definer set search_path = ''
as $$
  select t.id
  from public.teachers t
  join public.profiles p on p.id = t.profile_id
  where t.profile_id = private.actor_id() and t.status = 'active' and p.status = 'active'
  for share of t
$$;
revoke all on function private.current_active_teacher_id() from public;

-- ---------------------------------------------------------------------------------------
-- El guardián de lo publicado, con el paso del maestro activo en el registro de cursos. Lo demás queda
-- como estaba: solo el dueño de la tabla escribe, a nombre del sistema o de quien pasa la puerta de
-- Contenido, y fuera del borrador del maestro nada se borra. Un borrador que ya tiene filas que lo
-- nombran (un video, reproducciones) no se borra: ninguna de esas claves borra en cascada.

create or replace function private.guard_publication() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
  v_teacher boolean := false;
begin
  if tg_op = 'TRUNCATE' then
    raise exception '%.%: rows are hidden, not deleted', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner from pg_catalog.pg_class c where c.oid = tg_relid;
  if current_user::name <> v_owner then
    raise exception '%.%: only the publication functions write this table', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  -- El maestro activo, en el registro de cursos: dar de alta un borrador limpio suyo, o borrar un
  -- borrador suyo que nunca se publicó. En su propio bloque: plpgsql resuelve `new.teacher_id` aunque
  -- la tabla sea otra. Un nulo cuenta como no.
  if tg_relid = 'public.course_registry'::regclass and not private.actor_is_system() then
    if tg_op = 'INSERT' then
      v_teacher := coalesce(
        new.teacher_id = private.current_active_teacher_id()
        and new.created_at = pg_catalog.now() and new.updated_at = pg_catalog.now()
        and new.state = 'draft' and new.pending_version_state is null and not new.is_open
        and new.open_since is null and new.first_published_at is null
        and new.withdrawn_at is null and new.withdrawn_by is null and new.withdrawal_reason is null,
        false);
    elsif tg_op = 'DELETE' then
      v_teacher := coalesce(
        old.teacher_id = private.current_active_teacher_id()
        and old.state = 'draft' and old.first_published_at is null,
        false);
    end if;
  end if;
  if not (v_teacher or private.actor_is_system() or private.content_change_gate() is null) then
    raise exception '%.%: only the publication functions write this table', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    if v_teacher then
      return old;
    end if;
    raise exception '%.%: rows are hidden, not deleted', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  -- En dos pasos: plpgsql resuelve `new.provider` aunque la tabla no sea la de videos.
  if tg_table_name = 'video_assets' then
    if new.provider = 'test'
       -- Un ajuste que nunca se definió es nulo, y un `if` nulo no lanza: por eso el coalesce.
       and not (private.actor_is_system() and coalesce(pg_catalog.current_setting('app.local_courses', true), '') = 'on') then
      raise exception '%.%: test videos are only loaded by the local courses script', tg_table_schema, tg_table_name
        using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------
-- El área `teachers` del vigilante (carril A): el maestro activo y el guardián del que depende.

create function private.schema_violations_teachers()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  teacher_functions (name, definer, callers) as (
    values ('current_active_teacher_id', true, array[]::text[]),
           -- Un disparador: no se mira quién lo ejecuta (no hace nada fuera de su tabla), sí que no sea definer.
           ('guard_publication', false, null::text[])),
  found as (
    select f.name, f.definer, f.callers, p.oid, p.prosecdef, p.proconfig, p.provolatile, p.proowner
    from teacher_functions f
    join pg_catalog.pg_proc p on p.proname = f.name and p.pronargs = 0
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private')
  select 'teachers function missing', 'private.' || f.name
  from teacher_functions f
  where not exists (select 1 from found where found.name = f.name)
  union all
  select 'teachers function executable by ' || r.rolname, found.oid::regprocedure::text
  from app_roles r cross join found
  where found.callers is not null
    and pg_catalog.has_function_privilege(r.rolname::name, found.oid, 'EXECUTE')
    and not r.rolname = any (found.callers)
  union all
  select 'teachers function not executable by ' || c, found.oid::regprocedure::text
  from found cross join unnest(found.callers) c
  where not pg_catalog.has_function_privilege(c::name, found.oid, 'EXECUTE')
  union all
  select 'teachers function security definer or without fixed search_path', found.oid::regprocedure::text
  from found
  where (found.prosecdef and not found.definer)
     or not coalesce(found.proconfig, '{}') @> array['search_path=""']
  union all
  select 'teachers function not security definer', found.oid::regprocedure::text
  from found
  where found.definer and not found.prosecdef
  union all
  -- Toma la fila del maestro: una función estable no puede.
  select 'teachers function not volatile', found.oid::regprocedure::text
  from found
  where found.name = 'current_active_teacher_id' and found.provolatile <> 'v'
  union all
  select 'teachers function not owned by the table owner', found.oid::regprocedure::text
  from found
  where found.name = 'current_active_teacher_id'
    and found.proowner <> (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.teachers'::regclass)
  union all
  select 'teachers trigger missing or disabled: ' || t.tgname, 'public.course_registry'
  -- El de cada fila: por fila (1), antes (2), al insertar (4), al borrar (8) y al cambiar (16). El de
  -- vaciar: por sentencia (sin el 1), antes (2) y al vaciar (32).
  from (values ('publication_guard', 31, 31), ('publication_no_truncate', 35, 34)) t (tgname, mask, bits)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = 'public.course_registry'::regclass and tg.tgname = t.tgname
      and tg.tgenabled in ('O', 'A') and n.nspname = 'private' and p.proname = 'guard_publication'
      and (tg.tgtype & t.mask) = t.bits)
$$;
revoke all on function private.schema_violations_teachers() from public;

-- ---------------------------------------------------------------------------------------
-- La auditoría: el borrado de un borrador del maestro es el primer borrado de una tabla cuya llave es
-- `course_id`, y sin esto quedaba sin entidad. Lo demás, igual que en `t103_auditoria`.

create or replace function private.audit_row_change() returns trigger
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
    coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'course_id', v_old ->> 'course_id', v_new ->> 'period_id',
             v_old ->> 'period_id'),
    v_old,
    v_new,
    nullif(current_setting('app.reason', true), ''),
    nullif(current_setting('app.request_id', true), ''));
  return null;
end
$$;
