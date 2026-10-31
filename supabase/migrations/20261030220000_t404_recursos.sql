-- T-404, primera solicitud · Los recursos del borrador (RF-605, FL-33, PA-43). Esquema §5.2 y §12.
--
-- El maestro adjunta archivos a un curso o a una lección. Vercel corta todo envío a una función en
-- 4.5 MB, así que el archivo sube del navegador a la cubeta con una dirección firmada; lo que aquí se
-- guarda es la fila, que nace ANTES que el objeto y con la ruta que pone la base. Por eso:
--
--   · Un objeto que ninguna fila nombra sobra, tenga la edad que tenga: su fila se fue o nunca existió.
--     No hace falta una cola: `resource_unused_objects` los lista por curso al quitar algo, y el repaso
--     (`resource_sweep`) en toda la cubeta. Cuando lo publicado nombre archivos (tercera solicitud), esas
--     dos funciones miran también ahí: la ruta se comparte entre versiones, y editar un curso publicado
--     nunca borra lo que los alumnos siguen bajando.
--   · Confirmar compara lo que Storage guardó (`storage.objects`), que es lo que se va a servir, y no lo
--     que dijo el navegador. Lo rechazado borra su fila en la misma transacción: no hay cómo volver a
--     confirmarlo, aunque la dirección de subida siga viva. Un «no se supo» (no se pudieron leer los
--     primeros bytes, o falta el parámetro) no rechaza: contesta `unavailable` y la fila se queda.
--   · La fila recuerda qué objeto confirmó, con su `id` y su `version`: un reemplazo por `upsert` conserva
--     el `id` y cambia la versión; borrar y volver a subir cambia los dos.
--   · La dirección de subida dura 2 h fijas (Storage no deja pedir menos): un pendiente vive 3 h.
--
-- Decisiones de Sergio del 2026-10-30: PDF, Word (.docx), MP3 y M4A; un archivo se borra al momento, más
-- un repaso que corre quien opera; se acepta en esta versión el riesgo de archivos con código o macros.
--
-- Decisiones mías sin confirmar: `RECURSOS_POR_LUGAR_MAX` en 10 (por lección y por el curso), con los
-- pendientes vivos contados; el título lo escribe el maestro; las funciones se llaman `resource_*` y
-- tienen su propia área del vigilante, sin tocar la del borrador.
--
-- El orden de candados es el del borrador (T-401): la fila del maestro
-- (`current_active_teacher_id`), después el curso (`draft_open`, `course_lock`).

create type public.resource_kind as enum ('pdf', 'doc', 'audio');
create type public.resource_state as enum ('pending', 'ready');

insert into public.parameter_definitions (key, description, value_type, unit, group_name, affects_payout) values
  ('RECURSOS_POR_LUGAR_MAX', 'Recursos que admite una lección, o el curso, en el borrador', 'integer', null, 'product', false);

-- ---------------------------------------------------------------------------------------
-- La cubeta. Privada, con su lista exacta de tipos y su tope: Storage rechaza por sí misma lo demás.
-- Ninguna política sobre `storage.objects`: solo el servidor, con su llave, firma.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('course-resources', 'course-resources', false, 52428800,
        array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'audio/mpeg', 'audio/mp4']);

-- La clase de un recurso y los tipos que le tocan. El tipo lo fija el servidor según la clase, y la
-- comprobación del contenido va aparte (el servidor lee los primeros bytes).
create function private.resource_mime_ok(p_kind public.resource_kind, p_mime text) returns boolean
language sql immutable set search_path = ''
as $$
  select case p_kind
           when 'pdf' then p_mime = 'application/pdf'
           when 'doc' then p_mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
           when 'audio' then p_mime in ('audio/mpeg', 'audio/mp4')
           else false
         end
$$;
revoke all on function private.resource_mime_ok(public.resource_kind, text) from public;

-- ---------------------------------------------------------------------------------------
-- La tabla.

-- Para que un recurso no cuelgue de una lección de otro curso.
alter table public.draft_lessons add constraint draft_lessons_id_course_uq unique (id, course_id);

create table public.draft_resources (
  id uuid primary key,
  course_id uuid not null,
  teacher_id uuid not null,
  lesson_id uuid,                                  -- nula: es del curso
  -- El lugar: la lección, o el curso. Una lista por lugar.
  place_id uuid generated always as (coalesce(lesson_id, course_id)) stored,
  title text not null,
  kind public.resource_kind not null,
  mime text not null,
  storage_path text not null,                      -- la pone la base; nunca sale a la persona
  size_bytes bigint not null,                      -- el declarado, y al confirmar el de verdad
  state public.resource_state not null default 'pending',
  position integer,                                -- dentro de su lugar, desde 1; un pendiente no tiene
  object_id uuid,                                  -- el objeto de Storage al confirmar
  object_version text,                             -- y su versión: un `upsert` conserva el id y cambia esta
  revision bigint not null default 1,              -- sube al renombrarlo
  created_at timestamptz not null default now(),
  constraint draft_resources_course_fk foreign key (course_id, teacher_id)
    references public.course_drafts (course_id, teacher_id) on delete cascade,
  constraint draft_resources_lesson_fk foreign key (lesson_id, course_id)
    references public.draft_lessons (id, course_id) on delete cascade,
  constraint draft_resources_path_uq unique (storage_path),
  -- Como las de módulos y lecciones: se difiere dentro de la función que mueve, nunca al confirmar.
  constraint draft_resources_position_uq unique (place_id, position) deferrable initially immediate,
  constraint draft_resources_position_positive check (position >= 1),
  constraint draft_resources_title_ok check (private.draft_text_ok(title, 120, false)),
  constraint draft_resources_mime_ok check (private.resource_mime_ok(kind, mime)),
  constraint draft_resources_size_positive check (size_bytes > 0),
  constraint draft_resources_state_ok check (
    (state = 'pending' and position is null and object_id is null and object_version is null)
    or (state = 'ready' and position is not null and object_id is not null and object_version is not null))
);
comment on table public.draft_resources is 'Los recursos del borrador de un curso (RF-605, T-404). Los escriben solo las funciones private.resource_*; su maestro los lee, sin la ruta del archivo.';
create index draft_resources_course_idx on public.draft_resources (course_id, teacher_id);
create index draft_resources_lesson_idx on public.draft_resources (lesson_id, course_id);

alter table public.draft_resources enable row level security;
grant select (id, course_id, teacher_id, lesson_id, place_id, title, kind, mime, size_bytes, state, position, revision, created_at)
  on public.draft_resources to authenticated;
create policy draft_resources_teacher_select on public.draft_resources
  for select to authenticated using (teacher_id = (select private.current_teacher_id()));

create trigger draft_resources_guard before insert or update or delete on public.draft_resources
  for each row execute function private.guard_draft();
create trigger draft_resources_no_truncate before truncate on public.draft_resources
  for each statement execute function private.guard_draft();

-- ---------------------------------------------------------------------------------------
-- Las funciones del servidor. Ninguna recibe quién actúa: es el maestro activo de private.actor_id().
-- Ninguna escribe antes de rechazar, salvo confirmar: `rejected` y `expired` borran la fila, y eso es lo
-- que los vuelve definitivos (quien llama valida la respuesta ya confirmada). Contestan {answer}:
--   started, ready, rejected, expired, not_uploaded, saved, moved, deleted, changed, invalid, too_large,
--   too_many, throttled, unavailable, not_found, not_editable, suspended, not_teacher

-- Lo que le toca a una lección o al curso cuando cambia su lista: borrar uno u otro lleva lo que se vio,
-- y así una pestaña vieja no se lleva recursos que no vio.
create function private.resource_touch(p_course uuid, p_lesson uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_lesson is not null then
    update public.draft_lessons set revision = revision + 1 where id = p_lesson and course_id = p_course;
    update public.draft_modules set revision = revision + 1
     where course_id = p_course and id = (select module_id from public.draft_lessons where id = p_lesson);
  end if;
  update public.course_drafts set updated_at = now(), content_revision = content_revision + 1 where course_id = p_course;
end
$$;
revoke all on function private.resource_touch(uuid, uuid) from public;

-- Empezar: reserva la fila y la ruta. El servidor firma la subida con la ruta que esto contesta.
create function private.resource_begin(p_course uuid, p_lesson uuid, p_title text, p_kind text, p_mime text, p_size bigint)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_kind public.resource_kind;
  v_max bigint := (private.parameter_value('RECURSO_TAMANO_MAX'))::bigint;
  v_cap integer := (private.parameter_value('RECURSOS_POR_LUGAR_MAX'))::integer;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_hits integer;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  if p_lesson is not null
     and not exists (select 1 from public.draft_lessons where id = p_lesson and course_id = p_course) then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_max is null or v_cap is null then
    return pg_catalog.jsonb_build_object('answer', 'unavailable');
  end if;
  if p_kind is null or p_kind not in ('pdf', 'doc', 'audio') then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  v_kind := p_kind::public.resource_kind;
  if not private.draft_text_ok(p_title, 120, false)
     or not coalesce(private.resource_mime_ok(v_kind, p_mime), false)
     or p_size is null or p_size < 1 then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  if p_size > v_max then
    return pg_catalog.jsonb_build_object('answer', 'too_large');
  end if;
  -- Lo listo y lo pendiente que sigue vivo; lo vencido ya no cuenta, aunque el repaso no haya pasado.
  if (select pg_catalog.count(*) from public.draft_resources r
      where r.place_id = coalesce(p_lesson, p_course)
        and (r.state = 'ready' or r.created_at > now() - interval '3 hours')) >= v_cap then
    return pg_catalog.jsonb_build_object('answer', 'too_many');
  end if;
  -- El freno, al último: cuenta solo lo aceptado (TRD: permiso de subida, 20 por hora, por maestro).
  -- Una sola sentencia: con el tope, no toca la fila y no contesta nada.
  insert into private.rate_limit_counters as c (bucket, window_start, hits)
  values ('resource_upload:' || v_teacher, pg_catalog.date_trunc('hour', now()), 1)
  on conflict (bucket, window_start) do update set hits = c.hits + 1 where c.hits < 20
  returning c.hits into v_hits;
  if v_hits is null then
    return pg_catalog.jsonb_build_object('answer', 'throttled');
  end if;
  v_path := v_teacher || '/' || p_course || '/' || v_id;
  insert into public.draft_resources (id, course_id, teacher_id, lesson_id, title, kind, mime, storage_path, size_bytes)
  values (v_id, p_course, v_teacher, p_lesson, p_title, v_kind, p_mime, v_path, p_size);
  return pg_catalog.jsonb_build_object('answer', 'started', 'resource', v_id, 'path', v_path);
end
$$;

-- Confirmar: `p_content_ok` es lo que el servidor leyó en los primeros bytes del objeto, y nulo si no lo
-- pudo leer. Lo demás lo mira aquí, en lo que Storage guardó. Lo rechazado se va con su fila, y su objeto
-- queda como sobrante. Lo que no se supo no se rechaza: la fila se queda, para intentarlo otra vez.
create function private.resource_confirm(p_course uuid, p_resource uuid, p_content_ok boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_row public.draft_resources;
  v_object uuid;
  v_version text;
  v_size_text text;
  v_size bigint;
  v_mime text;
  v_reason text;
  v_max bigint := (private.parameter_value('RECURSO_TAMANO_MAX'))::bigint;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select * into v_row from public.draft_resources where id = p_resource and course_id = p_course;
  if v_row.id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_row.state = 'ready' then
    return pg_catalog.jsonb_build_object('answer', 'ready');
  end if;
  if v_row.created_at <= now() - interval '3 hours' then
    delete from public.draft_resources where id = p_resource;
    return pg_catalog.jsonb_build_object('answer', 'expired');
  end if;
  select o.id, o.version, o.metadata ->> 'size', o.metadata ->> 'mimetype' into v_object, v_version, v_size_text, v_mime
  from storage.objects o where o.bucket_id = 'course-resources' and o.name = v_row.storage_path;
  if v_object is null or v_version is null then
    return pg_catalog.jsonb_build_object('answer', 'not_uploaded');
  end if;
  if v_max is null or p_content_ok is null then
    return pg_catalog.jsonb_build_object('answer', 'unavailable');
  end if;
  -- Un tamaño que no es un entero cuenta como que no cabe; un `::bigint` a secas lanzaría.
  v_size := case when v_size_text ~ '^[0-9]{1,18}$' then v_size_text::bigint end;
  v_reason := case
    when v_mime is distinct from v_row.mime then 'type'
    when v_size is null or v_size < 1 or v_size > v_max then 'size'
    when not p_content_ok then 'content'
  end;
  if v_reason is not null then
    delete from public.draft_resources where id = p_resource;
    return pg_catalog.jsonb_build_object('answer', 'rejected', 'reason', v_reason);
  end if;
  update public.draft_resources
     set state = 'ready', object_id = v_object, object_version = v_version, size_bytes = v_size,
         position = (select coalesce(max(r.position), 0) + 1 from public.draft_resources r
                     where r.place_id = v_row.place_id and r.state = 'ready')
   where id = p_resource;
  -- El repaso no toma el candado del curso: pudo llevársela si estaba al filo de vencer.
  if not found then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  perform private.resource_touch(p_course, v_row.lesson_id);
  return pg_catalog.jsonb_build_object('answer', 'ready');
end
$$;

create function private.resource_rename(p_course uuid, p_resource uuid, p_seen bigint, p_title text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_row public.draft_resources;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select * into v_row from public.draft_resources where id = p_resource and course_id = p_course;
  if v_row.id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_row.revision is distinct from p_seen then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  if not private.draft_text_ok(p_title, 120, false) then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  update public.draft_resources set title = p_title, revision = revision + 1 where id = p_resource;
  perform private.resource_touch(p_course, v_row.lesson_id);
  return pg_catalog.jsonb_build_object('answer', 'saved');
end
$$;

-- Mover lleva la posición que se vio: un «Subir» reenviado no sube dos lugares. Solo entre los listos.
create function private.resource_move(p_course uuid, p_resource uuid, p_seen_position integer, p_to_position integer) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_row public.draft_resources;
  v_count integer;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select * into v_row from public.draft_resources where id = p_resource and course_id = p_course and state = 'ready';
  if v_row.id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_row.position is distinct from p_seen_position then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  select pg_catalog.count(*)::integer into v_count from public.draft_resources
   where place_id = v_row.place_id and state = 'ready';
  if p_to_position is null or p_to_position < 1 or p_to_position > v_count then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  if p_to_position <> v_row.position then
    set constraints public.draft_resources_position_uq deferred;
    if p_to_position < v_row.position then
      update public.draft_resources set position = position + 1
       where place_id = v_row.place_id and position >= p_to_position and position < v_row.position;
    else
      update public.draft_resources set position = position - 1
       where place_id = v_row.place_id and position > v_row.position and position <= p_to_position;
    end if;
    update public.draft_resources set position = p_to_position where id = p_resource;
    set constraints public.draft_resources_position_uq immediate;
    perform private.resource_touch(p_course, v_row.lesson_id);
  end if;
  return pg_catalog.jsonb_build_object('answer', 'moved');
end
$$;

-- Quitar: la fila se va ya, y su objeto queda como sobrante (`resource_unused_objects`).
create function private.resource_remove(p_course uuid, p_resource uuid, p_seen bigint) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_row public.draft_resources;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select * into v_row from public.draft_resources where id = p_resource and course_id = p_course;
  if v_row.id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_row.revision is distinct from p_seen then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  delete from public.draft_resources where id = p_resource;
  if v_row.state = 'ready' then
    update public.draft_resources set position = position - 1
     where place_id = v_row.place_id and position > v_row.position;
    perform private.resource_touch(p_course, v_row.lesson_id);
  end if;
  return pg_catalog.jsonb_build_object('answer', 'deleted');
end
$$;

-- Los objetos de un curso que ninguna fila nombra, para que el servidor los borre por la API de Storage
-- después de quitar algo o de borrar la lección, el módulo o el curso. Solo su maestro, también
-- suspendido (limpiar no le da nada), y por el prefijo de su ruta: el curso ya pudo haberse ido.
create function private.resource_unused_objects(p_course uuid) returns table (path text)
language sql stable security definer set search_path = ''
as $$
  select o.name
  from public.teachers t
  join storage.objects o on o.bucket_id = 'course-resources' and o.name like t.id || '/' || p_course || '/%'
  where t.profile_id = private.actor_id() and t.status in ('active', 'suspended')
    and not exists (select 1 from public.draft_resources r where r.storage_path = o.name)
$$;

-- El repaso, de quien opera: se lleva los pendientes vencidos y dice lo que sobra en toda la cubeta. La
-- aplicación no lo llama. Cubre lo que `resource_unused_objects` no alcanza: una caída entre la base y
-- Storage, o una subida que terminó después de que su fila se fue.
create function private.resource_sweep() returns table (path text)
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.draft_resources r where r.state = 'pending' and r.created_at <= now() - interval '3 hours';
  return query
    select o.name from storage.objects o
    where o.bucket_id = 'course-resources'
      and not exists (select 1 from public.draft_resources r where r.storage_path = o.name);
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'private.resource_begin(uuid, uuid, text, text, text, bigint)',
    'private.resource_confirm(uuid, uuid, boolean)',
    'private.resource_rename(uuid, uuid, bigint, text)',
    'private.resource_move(uuid, uuid, integer, integer)',
    'private.resource_remove(uuid, uuid, bigint)',
    'private.resource_unused_objects(uuid)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to app_service', f);
  end loop;
end
$$;
revoke all on function private.resource_sweep() from public;

-- ---------------------------------------------------------------------------------------
-- El área `resources` del vigilante (carril B).

create function private.schema_violations_resources()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  resource_functions (signature, server) as (
    values ('private.resource_begin(uuid, uuid, text, text, text, bigint)', true),
           ('private.resource_confirm(uuid, uuid, boolean)', true),
           ('private.resource_rename(uuid, uuid, bigint, text)', true),
           ('private.resource_move(uuid, uuid, integer, integer)', true),
           ('private.resource_remove(uuid, uuid, bigint)', true),
           ('private.resource_unused_objects(uuid)', true),
           ('private.resource_sweep()', false),
           ('private.resource_touch(uuid, uuid)', false),
           ('private.resource_mime_ok(public.resource_kind, text)', false)),
  found as (
    select f.signature, f.server, p.oid, p.prosecdef, p.proconfig, p.proowner
    from resource_functions f
    left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(f.signature)),
  bucket as (
    select b.public, b.file_size_limit, b.allowed_mime_types from storage.buckets b where b.id = 'course-resources')
  -- La cubeta: privada, con su lista exacta y el tope del parámetro.
  select 'resource bucket missing', 'course-resources'
  where not exists (select 1 from bucket)
  union all
  select 'resource bucket is public', 'course-resources' from bucket b where b.public is distinct from false
  union all
  select 'resource bucket mime types differ', 'course-resources' from bucket b
  where b.allowed_mime_types is distinct from
        array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'audio/mpeg', 'audio/mp4']
  union all
  select 'resource bucket limit differs from the parameter', 'course-resources' from bucket b
  where b.file_size_limit is distinct from (private.parameter_value('RECURSO_TAMANO_MAX'))::bigint
  union all
  -- A los objetos no se llega por una política: solo el servidor firma. «Ninguna política» solo protege
  -- con la seguridad por fila prendida.
  select 'storage object policy', p.polname::text
  from pg_catalog.pg_policy p where p.polrelid = 'storage.objects'::regclass
  union all
  select 'storage objects without row level security', 'storage.objects'
  from pg_catalog.pg_class c where c.oid = 'storage.objects'::regclass and not c.relrowsecurity
  union all
  -- La tabla: la lee su maestro, sin la ruta ni el objeto; no la escribe nadie de la aplicación.
  select 'resource table writable by ' || r.rolname, 'public.draft_resources'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.draft_resources', 'INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.draft_resources', 'DELETE, TRUNCATE, TRIGGER')
  union all
  select 'resource table readable by ' || r.rolname, 'public.draft_resources'
  from app_roles r
  where r.rolname <> 'authenticated'
    and pg_catalog.has_any_column_privilege(r.rolname::name, 'public.draft_resources', 'SELECT')
  union all
  select 'resource path readable by ' || r.rolname, 'public.draft_resources'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.draft_resources', 'storage_path', 'SELECT')
     or pg_catalog.has_column_privilege(r.rolname::name, 'public.draft_resources', 'object_id', 'SELECT')
     or pg_catalog.has_column_privilege(r.rolname::name, 'public.draft_resources', 'object_version', 'SELECT')
  union all
  select 'resource table without row level security', 'public.draft_resources'
  from pg_catalog.pg_class c where c.oid = 'public.draft_resources'::regclass and not c.relrowsecurity
  union all
  select 'resource policy other than teacher read', p.polname::text
  from pg_catalog.pg_policy p
  where p.polrelid = 'public.draft_resources'::regclass
    and not (p.polcmd = 'r' and p.polpermissive
             and p.polroles = array['authenticated'::regrole]::oid[]
             and pg_catalog.pg_get_expr(p.polqual, p.polrelid)
                 = '(teacher_id = ( SELECT private.current_teacher_id() AS current_teacher_id))')
  union all
  select 'resource table without its teacher read policy', 'public.draft_resources'
  where not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.draft_resources'::regclass)
  union all
  select 'resource table without guard', 'draft_resources' || g.suffix
  from (values ('_guard', 31), ('_no_truncate', 34)) as g (suffix, kind)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'public.draft_resources'::regclass and tg.tgname = 'draft_resources' || g.suffix
      and tg.tgfoid = 'private.guard_draft()'::regprocedure and tg.tgtype = g.kind
      and tg.tgenabled in ('O', 'A'))
  union all
  select 'resource table with a foreign trigger', tg.tgname::text
  from pg_catalog.pg_trigger tg
  where tg.tgrelid = 'public.draft_resources'::regclass and not tg.tgisinternal
    and tg.tgname not in ('draft_resources_guard', 'draft_resources_no_truncate')
  union all
  -- Las restricciones que sostienen lo que las funciones suponen, con su definición entera.
  select 'resource table without constraint ' || c.name, c.table_name
  from (values
      ('public.draft_resources', 'draft_resources_course_fk',
       'FOREIGN KEY (course_id, teacher_id) REFERENCES public.course_drafts(course_id, teacher_id) ON DELETE CASCADE'),
      ('public.draft_resources', 'draft_resources_lesson_fk',
       'FOREIGN KEY (lesson_id, course_id) REFERENCES public.draft_lessons(id, course_id) ON DELETE CASCADE'),
      ('public.draft_resources', 'draft_resources_path_uq', 'UNIQUE (storage_path)'),
      ('public.draft_resources', 'draft_resources_position_uq', 'UNIQUE (place_id, "position") DEFERRABLE'),
      ('public.draft_resources', 'draft_resources_title_ok', 'CHECK (private.draft_text_ok(title, 120, false))'),
      ('public.draft_resources', 'draft_resources_mime_ok', 'CHECK (private.resource_mime_ok(kind, mime))'),
      ('public.draft_resources', 'draft_resources_position_positive', 'CHECK (("position" >= 1))'),
      ('public.draft_resources', 'draft_resources_size_positive', 'CHECK ((size_bytes > 0))'),
      ('public.draft_resources', 'draft_resources_state_ok', 'CHECK ((((state = ''pending''::public.resource_state) AND ("position" IS NULL) AND (object_id IS NULL) AND (object_version IS NULL)) OR ((state = ''ready''::public.resource_state) AND ("position" IS NOT NULL) AND (object_id IS NOT NULL) AND (object_version IS NOT NULL))))'),
      ('public.draft_lessons', 'draft_lessons_id_course_uq', 'UNIQUE (id, course_id)')
    ) as c (table_name, name, definition)
  where not exists (
    select 1 from pg_catalog.pg_constraint k
    where k.conrelid = c.table_name::regclass and k.conname = c.name and k.convalidated
      and not k.condeferred and pg_catalog.pg_get_constraintdef(k.oid) = c.definition)
  union all
  select 'resource function missing', f.signature from found f where f.oid is null
  union all
  select 'resource function not in the watchdog area', p.oid::regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname in ('private', 'public')
  where p.proname like 'resource\_%' and not exists (select 1 from found f where f.oid = p.oid)
  union all
  select 'resource function executable by ' || r.rolname, f.signature
  from found f cross join app_roles r
  where f.oid is not null and (not f.server or r.rolname <> 'app_service')
    and pg_catalog.has_function_privilege(r.rolname::name, f.oid, 'EXECUTE')
  union all
  select 'resource function not executable by app_service', f.signature
  from found f
  where f.oid is not null and f.server and not pg_catalog.has_function_privilege('app_service', f.oid, 'EXECUTE')
  union all
  select 'resource function not security definer', f.signature
  from found f
  where f.oid is not null and (f.server or f.signature in ('private.resource_sweep()', 'private.resource_touch(uuid, uuid)'))
    and not f.prosecdef
  union all
  select 'resource function without fixed search_path', f.signature
  from found f
  where f.oid is not null and not coalesce(f.proconfig, '{}') @> array['search_path=""']
  union all
  select 'resource function not owned by the table owner', f.signature
  from found f
  where f.oid is not null
    and f.proowner <> (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.draft_resources'::regclass)
$$;
revoke all on function private.schema_violations_resources() from public;
