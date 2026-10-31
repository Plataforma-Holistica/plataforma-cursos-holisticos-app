-- T-404, segunda solicitud · La ruta de un recurso, para el servidor (RF-605).
--
-- Para confirmar, el servidor lee los primeros bytes del objeto, y para eso necesita su ruta. Nadie de la
-- aplicación lee `draft_resources.storage_path` (el vigilante lo exige), así que la pide por aquí: solo el
-- maestro activo dueño del borrador, con el protocolo de siempre (la fila del maestro, después el curso).

create function private.resource_file(p_course uuid, p_resource uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_path text;
  v_mime text;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select r.storage_path, r.mime into v_path, v_mime
  from public.draft_resources r where r.id = p_resource and r.course_id = p_course;
  if v_path is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  return pg_catalog.jsonb_build_object('answer', 'found', 'path', v_path, 'mime', v_mime);
end
$$;
revoke all on function private.resource_file(uuid, uuid) from public;
grant execute on function private.resource_file(uuid, uuid) to app_service;

-- El área `resources` del vigilante conoce la función nueva.
create or replace function private.schema_violations_resources()
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
           ('private.resource_file(uuid, uuid)', true),
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

