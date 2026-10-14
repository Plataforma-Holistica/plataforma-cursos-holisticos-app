-- T-107 · Lo publicado en tablas propias (ADR-21), y los cursos que carga el dueño de la base
-- (RN-16, RF-709, FL-58). Esquema §5.1, §5.2, §6 y §7.4.
-- Plan y decisiones de Sergio del 2026-10-14: mientras no hay pilotos ni el documento de
-- PQ-25, se prueba con cursos de prueba en la base local; lo cargado queda «por aprobar», sin
-- listar, y lo aprueba alguien del equipo con Contenido y un código reciente.
--
-- Lo que cambia respecto al esquema, y por qué:
--   · Nadie de la aplicación escribe estas tablas. Cargar lo hace solo el dueño de la base,
--     declarado sistema (como el arranque del equipo); aprobar, una función con la puerta de
--     Contenido. Un guardián en cada tabla lo exige aunque alguien le diera permisos al
--     servidor.
--   · Sin Payload: el curso tiene su propio identificador, y el video dice qué lección
--     publicada lo usa (`lesson_id`, no `lesson_ref`).
--   · `published_courses` nace sin `course_review_id`: llega con las revisiones (T-405). Lo
--     cargado nace sin listar, y aprobar lo lista.
--   · Claves compuestas: una lección no puede quedar en un módulo de otro curso, ni con un
--     video de otro curso o de otro maestro.
--   · Un proveedor de video de prueba (`test`), que solo acepta el dueño declarado sistema
--     con el ajuste del guion local: los videos de verdad son de Mux (T-108).

create type public.teacher_status as enum ('invited', 'active', 'suspended', 'left');
create type public.course_state as enum ('draft', 'in_review', 'published', 'changes_pending', 'withdrawn');
create type public.course_version_state as enum ('draft', 'in_review');
create type public.video_status as enum ('uploading', 'processing', 'ready', 'errored');

-- ---------------------------------------------------------------------------------------
-- Las tablas.

create table public.teachers (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique references public.profiles (id),  -- nulo hasta que acepta la invitación
  tiebreak_rank bigint generated always as identity unique, -- el «identificador menor» de RN-07
  status public.teacher_status not null default 'invited',
  is_founder boolean not null default false,
  founder_since date,                         -- inicio de FUNDADOR_MULTIPLICADOR (RF-702)
  second_factor_required boolean not null default false,
  suspended_at timestamptz,
  suspended_by uuid references public.profiles (id),
  suspension_approved_by uuid references public.profiles (id),  -- segunda persona (RN-17)
  suspension_reason text,
  left_at timestamptz,
  created_by uuid references public.profiles (id),  -- nulo: lo dio de alta el sistema
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teachers_founder_has_date check (is_founder = (founder_since is not null)),
  constraint teachers_active_has_profile check (status = 'invited' or profile_id is not null),
  constraint teachers_suspended_consistent check ((status = 'suspended') = (suspended_at is not null)),
  constraint teachers_suspension_has_reason check (suspended_at is null or suspension_reason is not null),
  constraint teachers_two_distinct_people
    check (suspension_approved_by is null or suspension_approved_by <> suspended_by),
  constraint teachers_left_consistent check ((status = 'left') = (left_at is not null))
);
comment on column public.teachers.tiebreak_rank is 'Orden estable para repartir centavos sobrantes (RN-07). Nunca sale de la base.';

create table public.published_teachers (
  teacher_id uuid primary key references public.teachers (id),
  slug text not null unique,
  display_name text not null,
  bio text,                                   -- semblanza (RF-611)
  portrait_path text,                         -- lo carga el equipo
  is_listed boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint published_teachers_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

create table public.course_registry (
  course_id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id),
  state public.course_state not null default 'draft',
  pending_version_state public.course_version_state,  -- solo con cambios pendientes (RF-608)
  is_open boolean not null default false,     -- curso abierto (RF-309)
  open_since timestamptz,
  first_published_at timestamptz,
  withdrawn_at timestamptz,
  withdrawn_by uuid references public.profiles (id),
  withdrawal_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint course_registry_course_teacher_uq unique (course_id, teacher_id),
  constraint course_registry_version_consistent
    check ((state = 'changes_pending') = (pending_version_state is not null)),
  constraint course_registry_withdrawn_consistent
    check ((state = 'withdrawn') = (withdrawn_at is not null)),
  constraint course_registry_withdrawal_has_reason
    check (withdrawn_at is null or withdrawal_reason is not null),
  constraint course_registry_open_is_published
    check (not is_open or state in ('published', 'changes_pending')),
  constraint course_registry_open_consistent check (is_open = (open_since is not null)),
  constraint course_registry_published_has_date
    check (state in ('draft', 'in_review') or first_published_at is not null)
);
-- Cursos de un maestro (PA-42), y la política «solo lo suyo».
create index course_registry_teacher_idx on public.course_registry (teacher_id);
-- H-03: un solo curso abierto a la vez.
create unique index course_registry_single_open_uq on public.course_registry (is_open) where is_open;

create table public.video_assets (
  id uuid primary key default gen_random_uuid(),   -- viaja como passthrough al proveedor
  course_id uuid not null,
  teacher_id uuid not null references public.teachers (id),
  lesson_id uuid not null,                    -- la lección publicada que lo usa; no es clave foránea: el video nace antes
  provider text not null,
  provider_upload_id text,
  provider_asset_id text,
  provider_playback_id text,
  status public.video_status not null default 'uploading',
  duration_seconds integer,                   -- la que mide el proveedor, no la del navegador
  error_code text,
  captions_ready boolean not null default false,   -- RF-310
  original_path text,                         -- ruta en la cubeta video-originals (RNF-17)
  original_size_bytes bigint,
  original_sha256 bytea,
  original_archived_at timestamptz,
  replaced_by uuid references public.video_assets (id),
  created_by uuid references public.profiles (id),  -- nulo: lo cargó el sistema
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint video_assets_course_fk foreign key (course_id, teacher_id) references public.course_registry (course_id, teacher_id),
  constraint video_assets_identity_uq unique (id, course_id, teacher_id),
  -- `test` es el de los cursos de prueba de la base local: lo cuida el guardián, no esto.
  constraint video_assets_provider_known check (provider in ('mux', 'test')),
  constraint video_assets_duration_positive check (duration_seconds > 0),
  constraint video_assets_size_positive check (original_size_bytes > 0),
  constraint video_assets_ready_is_complete check (
    status <> 'ready'
    or (duration_seconds is not null and provider_asset_id is not null and provider_playback_id is not null)),
  constraint video_assets_archive_consistent check ((original_archived_at is null) = (original_path is null))
);
-- El aviso del proveedor llega con su identificador: no puede ligarse a dos filas.
create unique index video_assets_provider_asset_uq
  on public.video_assets (provider, provider_asset_id) where provider_asset_id is not null;
-- Videos de un curso (PA-43) y comprobación de RF-606.
create index video_assets_course_idx on public.video_assets (course_id);
-- Barrido de videos atorados y alerta de original sin archivar (sección 13).
create index video_assets_pending_idx on public.video_assets (created_at)
  where status in ('uploading', 'processing') or (status = 'ready' and original_archived_at is null);

create table public.published_courses (
  course_id uuid primary key,
  teacher_id uuid not null references public.teachers (id),
  slug text not null unique,
  title text not null,
  summary text,
  teacher_name text not null,
  practice_id uuid references public.practices (id),
  level_id uuid references public.levels (id),
  cover_path text,                            -- portada generada (RF-709)
  lesson_count integer not null,
  total_duration_seconds integer not null,
  is_open boolean not null default false,
  is_listed boolean not null default false,   -- nace sin listar: aprobar lo lista; retirar lo quita (RF-708)
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_tsv tsvector generated always as (
    to_tsvector('spanish'::regconfig, coalesce(title, '') || ' ' || coalesce(teacher_name, ''))) stored,
  constraint published_courses_registry_fk foreign key (course_id, teacher_id) references public.course_registry (course_id, teacher_id),
  constraint published_courses_identity_uq unique (course_id, teacher_id),
  constraint published_courses_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint published_courses_has_lessons check (lesson_count >= 1 and total_duration_seconds > 0)
);
-- Búsqueda por título de curso y nombre de maestro (RF-304).
create index published_courses_search_idx on public.published_courses using gin (search_tsv);
-- Ficha de maestro y carrusel por maestro (RF-303, RF-301).
create index published_courses_teacher_idx on public.published_courses (teacher_id) where is_listed;
-- Filtros por práctica y nivel (RF-304), y cuántos cursos usan una (FL-58 E1).
create index published_courses_filter_idx on public.published_courses (practice_id, level_id) where is_listed;
create index published_courses_level_idx on public.published_courses (level_id) where is_listed;
-- Carrusel de nuevos (RF-301).
create index published_courses_recent_idx on public.published_courses (published_at desc) where is_listed;

create table public.published_modules (
  id uuid primary key,
  course_id uuid not null references public.published_courses (course_id),
  title text not null,
  position integer not null,
  is_current boolean not null default true,
  constraint published_modules_identity_uq unique (id, course_id)
);
create unique index published_modules_position_uq
  on public.published_modules (course_id, position) where is_current;

create table public.published_lessons (
  id uuid primary key,                        -- el mismo identificador entre versiones
  course_id uuid not null,
  module_id uuid not null,
  teacher_id uuid not null,
  video_asset_id uuid not null,
  title text not null,
  position integer not null,                  -- orden dentro del curso entero
  duration_seconds integer not null,
  has_captions boolean not null default false,
  is_current boolean not null default true,   -- falso si una versión nueva la quitó (RN-14)
  published_at timestamptz not null default now(),
  retired_at timestamptz,
  constraint published_lessons_course_fk foreign key (course_id, teacher_id) references public.published_courses (course_id, teacher_id),
  constraint published_lessons_module_fk foreign key (module_id, course_id) references public.published_modules (id, course_id),
  constraint published_lessons_video_fk
    foreign key (video_asset_id, course_id, teacher_id) references public.video_assets (id, course_id, teacher_id),
  constraint published_lessons_duration_positive check (duration_seconds > 0),
  constraint published_lessons_retired_consistent check (is_current = (retired_at is null))
);
-- Temario en orden y «siguiente lección sin terminar» (RF-307).
create unique index published_lessons_position_uq
  on public.published_lessons (course_id, position) where is_current;
-- Lecciones de un maestro: panel, avance de alumnos y comentarios (RF-601, RF-613, RF-609).
create index published_lessons_teacher_idx on public.published_lessons (teacher_id);

-- ---------------------------------------------------------------------------------------
-- Quién lee. Nadie de la aplicación escribe: ni insertar, ni actualizar, ni borrar.

alter table public.teachers enable row level security;
alter table public.published_teachers enable row level security;
alter table public.course_registry enable row level security;
alter table public.video_assets enable row level security;
alter table public.published_courses enable row level security;
alter table public.published_modules enable row level security;
alter table public.published_lessons enable row level security;

-- De un maestro se lee todo menos su orden de desempate, que nunca sale de la base.
grant select (id, profile_id, status, is_founder, founder_since, second_factor_required, suspended_at,
              suspended_by, suspension_approved_by, suspension_reason, left_at, created_by, created_at, updated_at)
  on public.teachers to authenticated, app_service;
grant select on public.course_registry, public.video_assets to authenticated, app_service;
grant select on public.published_teachers, public.published_courses, public.published_modules, public.published_lessons
  to anon, authenticated, app_service;

-- El maestro de la sesión: activo o suspendido, nunca invitado ni de baja.
create function private.current_teacher_id() returns uuid
language sql stable security definer set search_path = ''
as $$
  select t.id from public.teachers t
  where t.profile_id = (select auth.uid()) and t.status in ('active', 'suspended')
$$;
grant execute on function private.current_teacher_id() to authenticated, app_service;

create policy teachers_self_select on public.teachers
  for select to authenticated using (profile_id = (select auth.uid()));
create policy published_teachers_public_select on public.published_teachers
  for select to anon, authenticated using (is_listed);
create policy published_courses_public_select on public.published_courses
  for select to anon, authenticated using (is_listed);
create policy published_modules_public_select on public.published_modules
  for select to anon, authenticated
  using (is_current and exists (
    select 1 from public.published_courses c
    where c.course_id = published_modules.course_id and c.is_listed));
create policy published_lessons_public_select on public.published_lessons
  for select to anon, authenticated
  using (is_current and exists (
    select 1 from public.published_courses c
    where c.course_id = published_lessons.course_id and c.is_listed));

-- Patrón 2: «solo lo suyo» del maestro (RF-612).
do $$
declare t text;
begin
  foreach t in array array['course_registry', 'video_assets', 'published_courses', 'published_lessons']
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (teacher_id = (select private.current_teacher_id()))',
      t || '_teacher_select', t);
  end loop;
end
$$;

-- Patrón 3: lectura por capacidad, siempre con segundo factor (has_capability lo exige).
do $$
declare r record;
begin
  for r in
    select * from (values
      ('teachers', 'finance'), ('teachers', 'content'), ('course_registry', 'content'),
      ('video_assets', 'content'), ('published_courses', 'content'), ('published_modules', 'content'),
      ('published_lessons', 'content')
    ) as v (table_name, capability)
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select private.has_capability(%L::public.capability)))',
      r.table_name || '_' || r.capability || '_select', r.table_name, r.capability);
  end loop;
end
$$;

-- Llega con la tabla de maestros (t104b_legal): un texto de maestro lo leen los maestros.
create policy legal_documents_teacher_select on public.legal_documents
  for select to authenticated
  using (doc_type in ('teacher_privacy_notice', 'teacher_agreement', 'license_annex')
    and (select private.current_teacher_id()) is not null);

-- ---------------------------------------------------------------------------------------
-- El guardián de lo publicado. No es security definer: mira quién ejecuta. Solo el dueño de
-- la tabla (es decir, las funciones de abajo), y a nombre del sistema (cargar) o de alguien
-- que pasa la puerta de Contenido (aprobar). Nada se borra ni se vacía: lo publicado se
-- oculta. Y un video de prueba solo lo pone el sistema con el ajuste del guion local.

create function private.guard_publication() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
begin
  if tg_op = 'TRUNCATE' then
    raise exception '%.%: rows are hidden, not deleted', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner from pg_catalog.pg_class c where c.oid = tg_relid;
  if current_user::name <> v_owner
     or not (private.actor_is_system() or private.content_change_gate() is null) then
    raise exception '%.%: only the publication functions write this table', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception '%.%: rows are hidden, not deleted', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  -- En dos pasos: plpgsql resuelve `new.provider` aunque la tabla no sea la de videos.
  if tg_table_name = 'video_assets' then
    if new.provider = 'test'
       and not (private.actor_is_system() and pg_catalog.current_setting('app.local_courses', true) = 'on') then
      raise exception '%.%: test videos are only loaded by the local courses script', tg_table_schema, tg_table_name
        using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

do $$
declare t text;
begin
  foreach t in array array['teachers', 'published_teachers', 'course_registry', 'video_assets',
                           'published_courses', 'published_modules', 'published_lessons']
  loop
    execute format('create trigger publication_guard before insert or update or delete on public.%I
                    for each row execute function private.guard_publication()', t);
    execute format('create trigger publication_no_truncate before truncate on public.%I
                    for each statement execute function private.guard_publication()', t);
  end loop;
  foreach t in array array['teachers', 'published_teachers', 'course_registry', 'video_assets', 'published_courses']
  loop
    execute format('create trigger touch_updated_at before update on public.%I
                    for each row execute function private.touch_updated_at()', t);
  end loop;
end
$$;
create trigger audit_changes after insert or update or delete on public.teachers
  for each row execute function private.audit_row_change('access');
create trigger audit_changes after insert or update or delete on public.course_registry
  for each row execute function private.audit_row_change('content');

-- ---------------------------------------------------------------------------------------
-- El candado de un curso. Va siempre después de los de las listas del catálogo (prácticas y
-- después niveles): ese es el orden de todo lo que toma más de uno.

create function private.course_lock(p_course uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'course changes run in read committed' using errcode = '25000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('course:' || coalesce(p_course::text, ''), 0));
end
$$;

-- ---------------------------------------------------------------------------------------
-- Las prácticas y los niveles también los crea el sistema (decisión de Sergio del
-- 2026-10-14): el guion local de los cursos de prueba los necesita. Agregar se parte en dos:
-- la puerta, que es de cada camino, y colocar, que es común.

create function private.catalog_place(p_list public.catalog_list, p_name text) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_table text := private.catalog_table(p_list);
  v_name text := pg_catalog.btrim(normalize(p_name, NFC));
  v_slug text;
  v_try text;
  v_n integer := 1;
  v_found uuid;
  v_active boolean;
  v_position integer;
  v_id uuid;
begin
  if v_table is null or not private.catalog_name_ok(v_name) then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;

  execute pg_catalog.format('select id, is_active from public.%I where private.catalog_key(name) = private.catalog_key($1)', v_table)
    into v_found, v_active using v_name;
  if v_found is not null then
    return pg_catalog.jsonb_build_object('answer', case when v_active then 'duplicate' else 'inactive_duplicate' end, 'id', v_found);
  end if;

  v_slug := private.catalog_slug(v_name);
  v_try := v_slug;
  loop
    execute pg_catalog.format('select id from public.%I where slug = $1', v_table) into v_found using v_try;
    exit when v_found is null;
    v_n := v_n + 1;
    v_try := v_slug || '-' || v_n;
  end loop;

  execute pg_catalog.format('select coalesce(max(position), 0) + 1 from public.%I', v_table) into v_position;
  if p_list = 'practices' then
    insert into public.practices (slug, name, position, cover_tone)
    values (v_try, v_name, v_position, (select (pg_catalog.count(*) % 8 + 1)::smallint from public.practices))
    returning id into v_id;
  else
    insert into public.levels (slug, name, position) values (v_try, v_name, v_position) returning id into v_id;
  end if;
  return pg_catalog.jsonb_build_object('answer', 'added', 'id', v_id);
end
$$;

create or replace function private.catalog_add(p_list public.catalog_list, p_name text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
begin
  perform private.catalog_lock(p_list);
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('answer', v_gate);
  end if;
  return private.catalog_place(p_list, p_name);
end
$$;

-- El sistema agrega: solo el dueño de la base, declarado sistema. No es security definer y no
-- tiene permisos para nadie, como el arranque del equipo.
create function private.system_catalog_add(p_list public.catalog_list, p_name text) returns jsonb
language plpgsql set search_path = ''
as $$
begin
  if not private.actor_is_system() then
    raise exception 'private.system_catalog_add(): declare the system actor first' using errcode = '42501';
  end if;
  perform private.catalog_lock(p_list);
  return private.catalog_place(p_list, p_name);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Cargar: solo el dueño de la base, declarado sistema. Hoy lo usa el guion local de los
-- cursos de prueba; mañana, los pilotos (con el documento de PQ-25) y el editor (T-402)
-- llegan por su propio camino.

-- Un maestro sin cuenta (invitado), con su ficha. Si su slug ya existe, el que hay.
create function private.system_add_teacher(p_display_name text, p_slug text, p_bio text) returns uuid
language plpgsql set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.actor_is_system() then
    raise exception 'private.system_add_teacher(): declare the system actor first' using errcode = '42501';
  end if;
  select teacher_id into v_id from public.published_teachers where slug = p_slug;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.teachers (status) values ('invited') returning id into v_id;
  insert into public.published_teachers (teacher_id, slug, display_name, bio) values (v_id, p_slug, p_display_name, p_bio);
  return v_id;
end
$$;

-- Un curso entero, con sus módulos, sus lecciones y sus videos, por aprobar: entra a lo
-- publicado sin listar. Contesta en un jsonb `{answer, course_id}`:
--   loaded             cargado, en revisión
--   already_loaded     ese slug ya existe: no se carga dos veces
--   teacher_missing    el maestro no existe o no tiene ficha
--   practice_missing / practice_inactive / level_missing / level_inactive
--   invalid            la forma no es la de un curso: sin lecciones, un título vacío o largo,
--                      un video sin duración o sin identificadores
-- Forma de p_course: {slug, title, summary, practice, level, modules: [{title, lessons:
-- [{title, video: {provider, asset_id, playback_id, duration_seconds}}]}]}.
create function private.system_load_course(p_teacher uuid, p_course jsonb) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_practice uuid;
  v_level uuid;
  v_active boolean;
  v_teacher_name text;
  v_course uuid;
  v_module jsonb;
  v_lesson jsonb;
  v_module_id uuid;
  v_lesson_id uuid;
  v_video_id uuid;
  v_module_no integer := 0;
  v_lesson_no integer := 0;
  v_count integer := 0;
  v_total integer := 0;
  v_duration integer;
begin
  if not private.actor_is_system() then
    raise exception 'private.system_load_course(): declare the system actor first' using errcode = '42501';
  end if;
  -- El orden de siempre: prácticas, niveles, y después el curso.
  perform private.catalog_lock('practices');
  perform private.catalog_lock('levels');

  select pt.display_name into v_teacher_name
  from public.published_teachers pt join public.teachers t on t.id = pt.teacher_id where t.id = p_teacher;
  if v_teacher_name is null then
    return pg_catalog.jsonb_build_object('answer', 'teacher_missing');
  end if;

  select id, is_active into v_practice, v_active from public.practices where slug = p_course ->> 'practice' for key share;
  if v_practice is null then
    return pg_catalog.jsonb_build_object('answer', 'practice_missing');
  elsif not v_active then
    return pg_catalog.jsonb_build_object('answer', 'practice_inactive');
  end if;
  select id, is_active into v_level, v_active from public.levels where slug = p_course ->> 'level' for key share;
  if v_level is null then
    return pg_catalog.jsonb_build_object('answer', 'level_missing');
  elsif not v_active then
    return pg_catalog.jsonb_build_object('answer', 'level_inactive');
  end if;

  select course_id into v_course from public.published_courses where slug = p_course ->> 'slug';
  if v_course is not null then
    return pg_catalog.jsonb_build_object('answer', 'already_loaded', 'course_id', v_course);
  end if;

  -- La forma, antes de escribir nada.
  if coalesce(p_course ->> 'slug', '') !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     or coalesce(pg_catalog.char_length(pg_catalog.btrim(p_course ->> 'title')), 0) not between 1 and 120
     or pg_catalog.jsonb_typeof(p_course -> 'modules') is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_course -> 'modules') = 0 then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  for v_module in select * from pg_catalog.jsonb_array_elements(p_course -> 'modules') loop
    if coalesce(pg_catalog.char_length(pg_catalog.btrim(v_module ->> 'title')), 0) not between 1 and 120
       or pg_catalog.jsonb_typeof(v_module -> 'lessons') is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_module -> 'lessons') = 0 then
      return pg_catalog.jsonb_build_object('answer', 'invalid');
    end if;
    for v_lesson in select * from pg_catalog.jsonb_array_elements(v_module -> 'lessons') loop
      v_duration := case when pg_catalog.jsonb_typeof(v_lesson -> 'video' -> 'duration_seconds') = 'number'
                         then (v_lesson -> 'video' ->> 'duration_seconds')::numeric::integer end;
      if coalesce(pg_catalog.char_length(pg_catalog.btrim(v_lesson ->> 'title')), 0) not between 1 and 120
         or v_duration is null or v_duration <= 0
         or coalesce(v_lesson -> 'video' ->> 'asset_id', '') = ''
         or coalesce(v_lesson -> 'video' ->> 'playback_id', '') = '' then
        return pg_catalog.jsonb_build_object('answer', 'invalid');
      end if;
      v_count := v_count + 1;
      v_total := v_total + v_duration;
    end loop;
  end loop;

  insert into public.course_registry (teacher_id, state) values (p_teacher, 'in_review') returning course_id into v_course;
  perform private.course_lock(v_course);
  insert into public.published_courses
    (course_id, teacher_id, slug, title, summary, teacher_name, practice_id, level_id, lesson_count, total_duration_seconds, is_listed)
  values
    (v_course, p_teacher, p_course ->> 'slug', pg_catalog.btrim(p_course ->> 'title'), nullif(pg_catalog.btrim(p_course ->> 'summary'), ''),
     v_teacher_name, v_practice, v_level, v_count, v_total, false);

  for v_module in select * from pg_catalog.jsonb_array_elements(p_course -> 'modules') loop
    v_module_no := v_module_no + 1;
    v_module_id := gen_random_uuid();
    insert into public.published_modules (id, course_id, title, position)
    values (v_module_id, v_course, pg_catalog.btrim(v_module ->> 'title'), v_module_no);
    for v_lesson in select * from pg_catalog.jsonb_array_elements(v_module -> 'lessons') loop
      v_lesson_no := v_lesson_no + 1;
      v_lesson_id := gen_random_uuid();
      v_duration := (v_lesson -> 'video' ->> 'duration_seconds')::numeric::integer;
      insert into public.video_assets
        (course_id, teacher_id, lesson_id, provider, provider_asset_id, provider_playback_id, status, duration_seconds)
      values
        (v_course, p_teacher, v_lesson_id, v_lesson -> 'video' ->> 'provider', v_lesson -> 'video' ->> 'asset_id',
         v_lesson -> 'video' ->> 'playback_id', 'ready', v_duration)
      returning id into v_video_id;
      -- La duración de la lección es la del video, nunca otra.
      insert into public.published_lessons (id, course_id, module_id, teacher_id, video_asset_id, title, position, duration_seconds)
      select v_lesson_id, v_course, v_module_id, p_teacher, v.id, pg_catalog.btrim(v_lesson ->> 'title'), v_lesson_no, v.duration_seconds
      from public.video_assets v where v.id = v_video_id;
    end loop;
  end loop;
  return pg_catalog.jsonb_build_object('answer', 'loaded', 'course_id', v_course);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Aprobar: alguien del equipo con Contenido y un código reciente lista un curso en
-- revisión. Contesta:
--   approved           listado y publicado
--   not_found          no existe ese curso
--   not_pending        no está en revisión (ya se aprobó, o es de otro estado)
--   practice_inactive / level_inactive   su práctica o su nivel se desactivó mientras tanto
--   videos_not_ready   alguna lección tiene un video que no está listo (RN-16)
--   forbidden / needs_fresh_code         la puerta de Contenido
-- Toma los candados de las dos listas antes que el del curso: desactivar una práctica y
-- aprobar un curso que la usa van uno tras otro.
create function private.approve_course(p_course uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_state public.course_state;
  v_practice uuid;
  v_level uuid;
begin
  perform private.catalog_lock('practices');
  perform private.catalog_lock('levels');
  perform private.course_lock(p_course);
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;

  select state into v_state from public.course_registry where course_id = p_course for no key update;
  if v_state is null then
    return 'not_found';
  elsif v_state <> 'in_review' then
    return 'not_pending';
  end if;
  select practice_id, level_id into v_practice, v_level from public.published_courses where course_id = p_course;
  if v_practice is not null and not exists (select 1 from public.practices where id = v_practice and is_active) then
    return 'practice_inactive';
  end if;
  if v_level is not null and not exists (select 1 from public.levels where id = v_level and is_active) then
    return 'level_inactive';
  end if;
  if exists (
    select 1 from public.published_lessons l join public.video_assets v on v.id = l.video_asset_id
    where l.course_id = p_course and l.is_current and v.status <> 'ready') then
    return 'videos_not_ready';
  end if;

  update public.course_registry set state = 'published', first_published_at = coalesce(first_published_at, now())
  where course_id = p_course;
  update public.published_courses set is_listed = true, published_at = now() where course_id = p_course;
  return 'approved';
end
$$;

grant execute on function private.approve_course(uuid) to app_service;

-- ---------------------------------------------------------------------------------------
-- El guardián de las listas acepta también al dueño declarado sistema (decisión de Sergio
-- del 2026-10-14): es como el guion local crea las prácticas y los niveles de prueba.

create or replace function private.guard_catalog_list() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
begin
  -- Vaciar no pasa por los disparadores de cada fila: este mismo guardián lo cierra, para
  -- todos y antes que nada.
  if tg_op = 'TRUNCATE' then
    raise exception '%.%: rows are deactivated, not deleted', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner from pg_catalog.pg_class c where c.oid = tg_relid;
  if current_user::name <> v_owner
     or (private.content_change_gate() is not null and not private.actor_is_system()) then
    raise exception '%.%: only the catalog functions write this list', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception '%.%: rows are deactivated, not deleted', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.slug is distinct from old.slug) then
    raise exception '%.%: id and slug do not change', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------
-- El vigilante aprende lo publicado, el orden de desempate y las funciones del sistema.

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
