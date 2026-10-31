-- T-404, tercera solicitud · Los recursos publicados y quién los baja (RF-308, RF-306, FL-14). Esquema §5.3 y §12.
--
-- `published_resources` la escribe solo el dueño declarado sistema, como lo demás publicado, hasta que T-405 y T-406
-- publiquen desde el borrador. La ruta se comparte entre versiones: un archivo que lo publicado nombra no sobra, aunque
-- el borrador ya no lo nombre.
--
-- Bajar pasa por la puerta de medios (RF-306): los hechos (`resource_facts`, que reusa los de la cuenta) y la segunda
-- barrera (`resource_object`, hermana de `lesson_playback`) salen de la misma foto. La barrera no conoce a Contenido: su
-- regla llega con T-405, cuando haya qué revisar. Descargar no cuenta para el reparto, y no abre reproducción.
--
-- Decisiones mías sin confirmar: `TOPE_DESCARGAS_HORA` en 60 por cuenta; el maestro suspendido baja lo que subió, porque
-- ya lo lee en solo lectura (RF-702); cuánto se conserva un archivo que una versión nueva retira se decide con T-405.

insert into public.parameter_definitions (key, description, value_type, unit, group_name, affects_payout) values
  ('TOPE_DESCARGAS_HORA', 'Descargas de recursos que una cuenta puede pedir en una hora', 'integer', null, 'product', false);

-- Para que un recurso no cuelgue de una lección de otro curso.
alter table public.published_lessons add constraint published_lessons_id_course_uq unique (id, course_id);

create table public.published_resources (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null,
  teacher_id uuid not null,
  lesson_id uuid,                                  -- nula: es del curso
  place_id uuid generated always as (coalesce(lesson_id, course_id)) stored,
  title text not null,
  kind public.resource_kind not null,
  mime text not null,
  storage_path text not null,                      -- nunca sale a la persona: la suelta la barrera
  object_id uuid not null,                         -- el objeto confirmado
  object_version text not null,                    -- y su versión: un reemplazo conserva el id y cambia esta
  size_bytes bigint not null,
  position integer not null,
  is_current boolean not null default true,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  constraint published_resources_course_fk foreign key (course_id, teacher_id)
    references public.published_courses (course_id, teacher_id),
  constraint published_resources_lesson_fk foreign key (lesson_id, course_id)
    references public.published_lessons (id, course_id),
  constraint published_resources_position_positive check (position >= 1),
  constraint published_resources_title_ok check (private.draft_text_ok(title, 120, false)),
  constraint published_resources_mime_ok check (private.resource_mime_ok(kind, mime)),
  constraint published_resources_size_positive check (size_bytes > 0),
  constraint published_resources_retired_consistent check (is_current = (retired_at is null)),
  -- La ruta la pone la base, con el maestro y el curso primero (§12).
  constraint published_resources_path_ok check (starts_with(storage_path, teacher_id::text || '/' || course_id::text || '/'))
);
comment on table public.published_resources is 'Los recursos publicados de un curso (RF-308, T-404). Los escribe solo el dueño declarado sistema hasta T-405 y T-406; la gente los lee sin la ruta, y bajar pasa por la puerta de medios.';
create unique index published_resources_position_uq on public.published_resources (place_id, position) where is_current;
create index published_resources_course_idx on public.published_resources (course_id, teacher_id);
create index published_resources_lesson_idx on public.published_resources (lesson_id, course_id);
create index published_resources_path_idx on public.published_resources (storage_path);

alter table public.published_resources enable row level security;
-- Sin la ruta ni el objeto. También el servidor, que lee la lista como sistema para la ficha pública.
grant select (id, course_id, teacher_id, lesson_id, title, kind, size_bytes, position, is_current)
  on public.published_resources to anon, authenticated, app_service;
-- La lección también vigente: un recurso de una lección retirada no se enumera.
create policy published_resources_public_select on public.published_resources
  for select to anon, authenticated
  using (is_current
         and (lesson_id is null or exists (
           select 1 from public.published_lessons l where l.id = published_resources.lesson_id and l.is_current))
         and exists (
           select 1 from public.published_courses c where c.course_id = published_resources.course_id and c.is_listed));
create policy published_resources_teacher_select on public.published_resources
  for select to authenticated using (teacher_id = (select private.current_teacher_id()));
create policy published_resources_content_select on public.published_resources
  for select to authenticated using ((select private.has_capability('content'::public.capability)));

create trigger publication_guard before insert or update or delete on public.published_resources
  for each row execute function private.guard_publication();
create trigger publication_no_truncate before truncate on public.published_resources
  for each statement execute function private.guard_publication();

-- ---------------------------------------------------------------------------------------
-- Los hechos, para la regla del dominio. La parte de la cuenta es la de ver: `media_facts` con lección nula.
-- `is_current` dice también de su lección. El correo no viaja: un recurso no lleva marca de agua.

create function private.resource_facts(p_resource uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_facts jsonb := private.media_facts(null);
  v_resource jsonb;
begin
  if v_facts is null then
    return null;
  end if;
  select pg_catalog.jsonb_build_object(
           'is_current', x.is_current and (x.lesson_id is null or coalesce(l.is_current, false)),
           'teacher_id', x.teacher_id,
           'course_state', r.state,
           'listed', c.is_listed,
           'is_open', r.is_open)
    into v_resource
  from public.published_resources x
  join public.published_courses c on c.course_id = x.course_id
  join public.course_registry r on r.course_id = x.course_id
  left join public.published_lessons l on l.id = x.lesson_id
  where x.id = p_resource;
  return (v_facts - 'lesson') #- '{viewer,email}' || pg_catalog.jsonb_build_object('resource', v_resource);
end
$$;
revoke all on function private.resource_facts(uuid) from public;
grant execute on function private.resource_facts(uuid) to app_service;

-- La segunda barrera: la ruta sale solo de un recurso vigente, con el objeto que se publicó, en un curso publicado y
-- listado o del maestro dueño (también suspendido). El mismo predicado de `lesson_playback`, sin Contenido.
create function private.resource_object(p_resource uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('path', x.storage_path, 'mime', x.mime, 'title', x.title)
  from public.published_resources x
  join public.published_courses c on c.course_id = x.course_id
  join public.course_registry r on r.course_id = x.course_id
  join storage.objects o on o.bucket_id = 'course-resources' and o.name = x.storage_path
                        and o.id = x.object_id and o.version = x.object_version
  where x.id = p_resource
    and private.actor_id() is not null
    and x.is_current
    and (x.lesson_id is null or exists (select 1 from public.published_lessons l where l.id = x.lesson_id and l.is_current))
    and ((c.is_listed and r.state in ('published', 'changes_pending'))
         or x.teacher_id = (select t.id from public.teachers t
                            where t.profile_id = private.actor_id() and t.status in ('active', 'suspended')))
$$;
revoke all on function private.resource_object(uuid) from public;
grant execute on function private.resource_object(uuid) to app_service;

-- Lo que un maestro subió a su borrador: solo el suyo, solo lo confirmado, con el objeto que se confirmó. Es una lectura:
-- no toma la fila del maestro, y sirve también suspendido.
create function private.resource_draft_object(p_course uuid, p_resource uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('path', x.storage_path, 'mime', x.mime, 'title', x.title)
  from public.draft_resources x
  join public.teachers t on t.id = x.teacher_id
  join storage.objects o on o.bucket_id = 'course-resources' and o.name = x.storage_path
                        and o.id = x.object_id and o.version = x.object_version
  where x.id = p_resource and x.course_id = p_course and x.state = 'ready'
    and t.profile_id = private.actor_id() and t.status in ('active', 'suspended')
$$;
revoke all on function private.resource_draft_object(uuid, uuid) from public;
grant execute on function private.resource_draft_object(uuid, uuid) to app_service;

-- El freno de descargas. Se llama con el acceso ya dado, en su propia transacción. Falla cerrado: sin quien actúe o sin el
-- parámetro no pasa, y lo dice distinto de `throttled`. Una sola sentencia: con el tope, no toca la fila ni contesta nada.
create function private.resource_download_hit() returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_cap integer := (private.parameter_value('TOPE_DESCARGAS_HORA'))::integer;
  v_hits integer;
begin
  if v_actor is null or v_cap is null then
    return 'unavailable';
  end if;
  insert into private.rate_limit_counters as c (bucket, window_start, hits)
  values ('resource_download:' || v_actor, pg_catalog.date_trunc('hour', now()), 1)
  on conflict (bucket, window_start) do update set hits = c.hits + 1 where c.hits < v_cap
  returning c.hits into v_hits;
  return case when v_hits is null then 'throttled' else 'ok' end;
end
$$;
revoke all on function private.resource_download_hit() from public;
grant execute on function private.resource_download_hit() to app_service;

-- ---------------------------------------------------------------------------------------
-- Lo que sobra mira también lo publicado: la ruta se comparte entre versiones.

create or replace function private.resource_unused_objects(p_course uuid) returns table (path text)
language sql stable security definer set search_path = ''
as $$
  select o.name
  from public.teachers t
  join storage.objects o on o.bucket_id = 'course-resources' and o.name like t.id || '/' || p_course || '/%'
  where t.profile_id = private.actor_id() and t.status in ('active', 'suspended')
    and not exists (select 1 from public.draft_resources r where r.storage_path = o.name)
    and not exists (select 1 from public.published_resources r where r.storage_path = o.name)
$$;

create or replace function private.resource_sweep() returns table (path text)
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.draft_resources r where r.state = 'pending' and r.created_at <= now() - interval '3 hours';
  return query
    select o.name from storage.objects o
    where o.bucket_id = 'course-resources'
      and not exists (select 1 from public.draft_resources r where r.storage_path = o.name)
      and not exists (select 1 from public.published_resources r where r.storage_path = o.name);
end
$$;

-- El área `resources` del vigilante conoce lo nuevo.
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
           ('private.resource_facts(uuid)', true),
           ('private.resource_object(uuid)', true),
           ('private.resource_draft_object(uuid, uuid)', true),
           ('private.resource_download_hit()', true),
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
      ('public.draft_lessons', 'draft_lessons_id_course_uq', 'UNIQUE (id, course_id)'),
      ('public.published_lessons', 'published_lessons_id_course_uq', 'UNIQUE (id, course_id)'),
      ('public.published_resources', 'published_resources_lesson_fk',
       'FOREIGN KEY (lesson_id, course_id) REFERENCES public.published_lessons(id, course_id)'),
      ('public.published_resources', 'published_resources_mime_ok', 'CHECK (private.resource_mime_ok(kind, mime))'),
      ('public.published_resources', 'published_resources_title_ok', 'CHECK (private.draft_text_ok(title, 120, false))')
    ) as c (table_name, name, definition)
  where not exists (
    select 1 from pg_catalog.pg_constraint k
    where k.conrelid = c.table_name::regclass and k.conname = c.name and k.convalidated
      and not k.condeferred and pg_catalog.pg_get_constraintdef(k.oid) = c.definition)
  union all
  -- Lo publicado: la gente lo lee sin la ruta, y nadie de la aplicación lo escribe. El área `base`, congelada, no
  -- conoce esta tabla: lo exige esta.
  select 'published resource table writable by ' || r.rolname, 'public.published_resources'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.published_resources', 'INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.published_resources', 'DELETE, TRUNCATE, TRIGGER')
  union all
  select 'published resource path readable by ' || r.rolname, 'public.published_resources'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.published_resources', 'storage_path', 'SELECT')
     or pg_catalog.has_column_privilege(r.rolname::name, 'public.published_resources', 'object_id', 'SELECT')
     or pg_catalog.has_column_privilege(r.rolname::name, 'public.published_resources', 'object_version', 'SELECT')
  union all
  select 'published resource table without row level security', 'public.published_resources'
  from pg_catalog.pg_class c where c.oid = 'public.published_resources'::regclass and not c.relrowsecurity
  union all
  select 'published resource table without guard', g.name
  from (values ('publication_guard', 31), ('publication_no_truncate', 34)) as g (name, kind)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'public.published_resources'::regclass and tg.tgname = g.name
      and tg.tgfoid = 'private.guard_publication()'::regprocedure and tg.tgtype = g.kind
      and tg.tgenabled in ('O', 'A'))
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

