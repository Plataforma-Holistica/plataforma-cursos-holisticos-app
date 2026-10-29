-- T-402, primera solicitud · El borrador de un curso (RF-603, FL-32; PA-42 y PA-43). Esquema §5.2.
--
-- El borrador de un curso nuevo: sus datos, sus módulos y sus lecciones. Lo escribe solo el maestro
-- activo, por el servidor y con las funciones de abajo; lo lee su maestro, también suspendido; nadie
-- más lo ve, tampoco Contenido (RF-612). El registro del curso (`course_registry`) lo da de alta y lo
-- borra el paso del maestro activo que T-401 puso en `guard_publication`; las tablas del borrador no
-- llevan ese guardián: llevan el suyo, que deja borrar.
--
-- Decisiones de Sergio del 2026-10-29: un borrador no impide desactivar una práctica o un nivel
-- («en uso» sigue contando solo lo enviado o publicado); el maestro borra un borrador que nunca
-- envió; el título del curso hasta 60 caracteres, el resumen hasta 500, el título de un módulo o de
-- una lección hasta 120 y la descripción de una lección hasta 2 000, sin topes de cuántos.
--
-- Decisiones mías sin confirmar: las tablas del borrador no se auditan (las escribe su maestro, no un
-- administrador; el registro sí, al crear y al borrar); una sola copia de trabajo por curso, con su
-- versión (T-405 la sube al editar un curso publicado); los ids de módulos y lecciones son los que
-- conservará lo publicado; cada fila lleva su revisión y un formulario de antes contesta `changed`.
--
-- El orden de candados (T-401): la fila del maestro (`current_active_teacher_id`), después prácticas,
-- niveles y el curso (`course_lock`).

-- ---------------------------------------------------------------------------------------
-- La forma de un texto: en NFC, sin espacios en las puntas, sin caracteres que no se ven (la lista de
-- `catalog_name_ok`) y sin controles ni separadores de línea; un texto de varias líneas admite el salto
-- de línea y nada más. Con rangos escritos, no con clases como `[[:space:]]`: esas cambian con la
-- configuración regional de la base. Los espacios de las puntas son los que quita `trim()` del
-- navegador, para que lo que la regla del dominio deja pasar no lo rechace la base.

create function private.draft_text_ok(p_text text, p_max integer, p_multiline boolean) returns boolean
language sql immutable set search_path = ''
as $$
  select p_text is not null and pg_catalog.char_length(p_text) between 1 and p_max
     and p_text is nfc normalized
     and p_text !~ '^[\x09-\x0d\x20\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\x09-\x0d\x20\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
     and p_text !~ case when p_multiline then '[\x01-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]'
                        else '[\x01-\x1f\x7f-\x9f\u2028\u2029]' end
     and p_text !~ '[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e007f]'
$$;
revoke all on function private.draft_text_ok(text, integer, boolean) from public;

-- ---------------------------------------------------------------------------------------
-- Las tablas.

create table public.course_drafts (
  course_id uuid primary key,
  teacher_id uuid not null,
  version integer not null default 1,           -- la versión de trabajo; T-405 la sube al editar lo publicado
  title text not null,
  summary text,
  practice_id uuid references public.practices (id),
  level_id uuid references public.levels (id),
  revision bigint not null default 1,           -- sube con cada cambio a los datos del curso
  structure_revision bigint not null default 1, -- sube al agregar o borrar un módulo
  content_revision bigint not null default 1,   -- sube con todo cambio al borrador: borrar el curso la lleva
  create_token uuid not null,                   -- el del formulario que lo creó: un reenvío no crea otro
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),  -- «Guardado a las…»: cualquier cambio al borrador
  constraint course_drafts_course_teacher_fk foreign key (course_id, teacher_id)
    references public.course_registry (course_id, teacher_id) on delete cascade,
  constraint course_drafts_course_teacher_uq unique (course_id, teacher_id),
  constraint course_drafts_create_token_uq unique (teacher_id, create_token),
  constraint course_drafts_version_positive check (version >= 1),
  constraint course_drafts_title_ok check (private.draft_text_ok(title, 60, false)),
  constraint course_drafts_summary_ok check (summary is null or private.draft_text_ok(summary, 500, true))
);
comment on table public.course_drafts is 'El borrador de un curso (RF-603, T-402): sus datos. Lo escriben solo las funciones private.draft_*, a nombre del maestro activo; lo lee su maestro.';
create index course_drafts_teacher_idx on public.course_drafts (teacher_id);

create table public.draft_modules (
  id uuid primary key default gen_random_uuid(),  -- el que conservará published_modules.id
  course_id uuid not null,
  teacher_id uuid not null,
  title text not null,
  position integer not null,                      -- dentro del curso, desde 1
  revision bigint not null default 1,             -- sube al renombrarlo, y al entrar, salir o cambiar una lección
  constraint draft_modules_course_fk foreign key (course_id, teacher_id)
    references public.course_drafts (course_id, teacher_id) on delete cascade,
  constraint draft_modules_id_course_uq unique (id, course_id),
  -- Diferible, pero inmediata: se comprueba al final de cada sentencia (recorrer las posiciones de
  -- una sola vez) o donde la función lo pide, nunca al confirmar.
  constraint draft_modules_position_uq unique (course_id, position) deferrable initially immediate,
  constraint draft_modules_position_positive check (position >= 1),
  constraint draft_modules_title_ok check (private.draft_text_ok(title, 120, false))
);
comment on table public.draft_modules is 'Los módulos del borrador de un curso (T-402). Los escriben solo las funciones private.draft_*.';
create index draft_modules_teacher_idx on public.draft_modules (course_id, teacher_id);

create table public.draft_lessons (
  id uuid primary key default gen_random_uuid(),  -- el que conservará published_lessons.id
  course_id uuid not null,
  teacher_id uuid not null,
  module_id uuid not null,
  title text not null,
  description text,
  position integer not null,                      -- dentro del módulo, desde 1
  revision bigint not null default 1,             -- sube con cada cambio a su título o su descripción
  constraint draft_lessons_course_fk foreign key (course_id, teacher_id)
    references public.course_drafts (course_id, teacher_id) on delete cascade,
  -- Nunca en un módulo de otro curso.
  constraint draft_lessons_module_fk foreign key (module_id, course_id)
    references public.draft_modules (id, course_id) on delete cascade,
  constraint draft_lessons_position_uq unique (module_id, position) deferrable initially immediate,
  constraint draft_lessons_position_positive check (position >= 1),
  constraint draft_lessons_title_ok check (private.draft_text_ok(title, 120, false)),
  constraint draft_lessons_description_ok check (description is null or private.draft_text_ok(description, 2000, true))
);
comment on table public.draft_lessons is 'Las lecciones del borrador de un curso (T-402). Las escriben solo las funciones private.draft_*.';
create index draft_lessons_course_idx on public.draft_lessons (course_id, teacher_id);
create index draft_lessons_module_course_idx on public.draft_lessons (module_id, course_id);

-- Su maestro lee lo suyo, también suspendido (RF-702). Nadie más: Contenido ve el borrador desde que
-- se envía (RF-612, T-405), y del registro solo sabe que existe.
alter table public.course_drafts enable row level security;
alter table public.draft_modules enable row level security;
alter table public.draft_lessons enable row level security;
grant select on public.course_drafts, public.draft_modules, public.draft_lessons to authenticated;
create policy course_drafts_teacher_select on public.course_drafts
  for select to authenticated using (teacher_id = (select private.current_teacher_id()));
create policy draft_modules_teacher_select on public.draft_modules
  for select to authenticated using (teacher_id = (select private.current_teacher_id()));
create policy draft_lessons_teacher_select on public.draft_lessons
  for select to authenticated using (teacher_id = (select private.current_teacher_id()));

-- El guardián. No es security definer: mira quién ejecuta. Solo el dueño de la tabla escribe (las
-- funciones de abajo, y el borrado en cascada, que corre como él); nadie vacía la tabla.
create function private.guard_draft() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
begin
  if tg_op = 'TRUNCATE' then
    raise exception '%.%: drafts are not truncated', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner from pg_catalog.pg_class c where c.oid = tg_relid;
  if current_user::name <> v_owner then
    raise exception '%.%: only the draft functions write this table', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;
revoke all on function private.guard_draft() from public;

do $$
declare t text;
begin
  foreach t in array array['course_drafts', 'draft_modules', 'draft_lessons']
  loop
    execute format('create trigger %I before insert or update or delete on public.%I
                    for each row execute function private.guard_draft()', t || '_guard', t);
    execute format('create trigger %I before truncate on public.%I
                    for each statement execute function private.guard_draft()', t || '_no_truncate', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Lo que comparten las funciones.

-- Por qué no escribe quien actúa: un maestro suspendido (o con la cuenta suspendida) lo sabe, para
-- que su pantalla pinte la franja de solo lectura; los demás no son maestros.
create function private.draft_refusal() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('answer',
    case when exists (select 1 from public.teachers t
                      where t.profile_id = private.actor_id() and t.status in ('active', 'suspended'))
         then 'suspended' else 'not_teacher' end)
$$;
revoke all on function private.draft_refusal() from public;

-- Toma el curso y dice si se puede editar: el borrador del maestro (si no, para él no existe) y el
-- registro en borrador. Nula si se puede.
create function private.draft_open(p_course uuid, p_teacher uuid) returns text
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.course_lock(p_course);
  if not exists (select 1 from public.course_drafts d where d.course_id = p_course and d.teacher_id = p_teacher) then
    return 'not_found';
  end if;
  if (select r.state from public.course_registry r where r.course_id = p_course) <> 'draft' then
    return 'not_editable';
  end if;
  return null;
end
$$;
revoke all on function private.draft_open(uuid, uuid) from public;

-- ---------------------------------------------------------------------------------------
-- Las funciones del servidor. Ninguna recibe quién actúa: es el maestro activo de
-- private.actor_id(). Ninguna escribe antes de rechazar. Contestan {answer} y, al crear, el id:
--   created, saved, moved, deleted, changed, invalid, not_found, not_editable, suspended,
--   not_teacher, practice_inactive, level_inactive

-- Crear lleva el testigo que la pantalla puso en el formulario: el mismo testigo devuelve el curso que
-- ya creó (un doble clic sin JavaScript, o «Reintentar» después de una respuesta que se perdió). El
-- candado del maestro pone en fila dos envíos a la vez con el mismo testigo.
create function private.draft_create(p_token uuid, p_title text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_course uuid;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  if p_token is null or not private.draft_text_ok(p_title, 60, false) then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('draft_create:' || v_teacher::text, 0));
  select course_id into v_course from public.course_drafts where teacher_id = v_teacher and create_token = p_token;
  if v_course is not null then
    return pg_catalog.jsonb_build_object('answer', 'created', 'course', v_course);
  end if;
  insert into public.course_registry (teacher_id) values (v_teacher) returning course_id into v_course;
  insert into public.course_drafts (course_id, teacher_id, title, create_token) values (v_course, v_teacher, p_title, p_token);
  return pg_catalog.jsonb_build_object('answer', 'created', 'course', v_course);
end
$$;

-- Los datos del curso. Toma siempre los candados de las dos listas (la regla de todo camino que le
-- cambie la práctica o el nivel a un curso), y exige activas solo las que cambian: una que se
-- desactivó después se queda hasta que el maestro elija otra (enviar a revisión, T-405, la exige).
create function private.draft_save_course(p_course uuid, p_seen bigint, p_title text, p_summary text,
                                          p_practice uuid, p_level uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_draft public.course_drafts;
  v_active boolean;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  perform private.catalog_lock('practices');
  perform private.catalog_lock('levels');
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select * into v_draft from public.course_drafts where course_id = p_course;
  if v_draft.revision is distinct from p_seen then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  if not private.draft_text_ok(p_title, 60, false)
     or (p_summary is not null and not private.draft_text_ok(p_summary, 500, true)) then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  if p_practice is distinct from v_draft.practice_id and p_practice is not null then
    select is_active into v_active from public.practices where id = p_practice;
    if v_active is null then
      return pg_catalog.jsonb_build_object('answer', 'invalid');
    elsif not v_active then
      return pg_catalog.jsonb_build_object('answer', 'practice_inactive');
    end if;
  end if;
  if p_level is distinct from v_draft.level_id and p_level is not null then
    select is_active into v_active from public.levels where id = p_level;
    if v_active is null then
      return pg_catalog.jsonb_build_object('answer', 'invalid');
    elsif not v_active then
      return pg_catalog.jsonb_build_object('answer', 'level_inactive');
    end if;
  end if;
  update public.course_drafts
     set title = p_title, summary = p_summary, practice_id = p_practice, level_id = p_level,
         revision = revision + 1, updated_at = now(), content_revision = content_revision + 1
   where course_id = p_course;
  return pg_catalog.jsonb_build_object('answer', 'saved');
end
$$;

-- Agregar un módulo lleva la revisión de la estructura que se vio: un formulario reenviado no
-- agrega otro.
create function private.draft_add_module(p_course uuid, p_seen bigint, p_title text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_module uuid;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  if (select structure_revision from public.course_drafts where course_id = p_course) is distinct from p_seen then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  if not private.draft_text_ok(p_title, 120, false) then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  insert into public.draft_modules (course_id, teacher_id, title, position)
  select p_course, v_teacher, p_title, coalesce(max(m.position), 0) + 1
  from public.draft_modules m where m.course_id = p_course
  returning id into v_module;
  update public.course_drafts set structure_revision = structure_revision + 1, updated_at = now(), content_revision = content_revision + 1
   where course_id = p_course;
  return pg_catalog.jsonb_build_object('answer', 'created', 'module', v_module);
end
$$;

create function private.draft_rename_module(p_course uuid, p_module uuid, p_seen bigint, p_title text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_revision bigint;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select revision into v_revision from public.draft_modules where id = p_module and course_id = p_course;
  if v_revision is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_revision is distinct from p_seen then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  if not private.draft_text_ok(p_title, 120, false) then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  update public.draft_modules set title = p_title, revision = revision + 1
   where id = p_module and course_id = p_course;
  update public.course_drafts set updated_at = now(), content_revision = content_revision + 1 where course_id = p_course;
  return pg_catalog.jsonb_build_object('answer', 'saved');
end
$$;

-- Borrar un módulo se lleva sus lecciones; lleva la revisión del módulo que se vio, que sube también
-- cuando entra o sale una lección: no se borra lo que no se vio.
create function private.draft_delete_module(p_course uuid, p_module uuid, p_seen bigint) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_module public.draft_modules;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select * into v_module from public.draft_modules where id = p_module and course_id = p_course;
  if v_module.id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_module.revision is distinct from p_seen then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  delete from public.draft_modules where id = p_module and course_id = p_course;
  update public.draft_modules set position = position - 1
   where course_id = p_course and position > v_module.position;
  update public.course_drafts set structure_revision = structure_revision + 1, updated_at = now(), content_revision = content_revision + 1
   where course_id = p_course;
  return pg_catalog.jsonb_build_object('answer', 'deleted');
end
$$;

-- Mover lleva la posición que se vio: un «Subir» reenviado no sube dos lugares.
create function private.draft_move_module(p_course uuid, p_module uuid, p_seen_position integer,
                                          p_to_position integer) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_from integer;
  v_count integer;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select position into v_from from public.draft_modules where id = p_module and course_id = p_course;
  if v_from is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_from is distinct from p_seen_position then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  select pg_catalog.count(*)::integer into v_count from public.draft_modules where course_id = p_course;
  if p_to_position is null or p_to_position < 1 or p_to_position > v_count then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  if p_to_position <> v_from then
    set constraints public.draft_modules_position_uq deferred;
    if p_to_position < v_from then
      update public.draft_modules set position = position + 1
       where course_id = p_course and position >= p_to_position and position < v_from;
    else
      update public.draft_modules set position = position - 1
       where course_id = p_course and position > v_from and position <= p_to_position;
    end if;
    update public.draft_modules set position = p_to_position where id = p_module and course_id = p_course;
    set constraints public.draft_modules_position_uq immediate;
    update public.course_drafts set updated_at = now(), content_revision = content_revision + 1 where course_id = p_course;
  end if;
  return pg_catalog.jsonb_build_object('answer', 'moved');
end
$$;

-- Agregar una lección lleva la revisión del módulo que se vio.
create function private.draft_add_lesson(p_course uuid, p_module uuid, p_seen bigint, p_title text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_revision bigint;
  v_lesson uuid;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select revision into v_revision from public.draft_modules where id = p_module and course_id = p_course;
  if v_revision is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_revision is distinct from p_seen then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  if not private.draft_text_ok(p_title, 120, false) then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  insert into public.draft_lessons (course_id, teacher_id, module_id, title, position)
  select p_course, v_teacher, p_module, p_title, coalesce(max(l.position), 0) + 1
  from public.draft_lessons l where l.module_id = p_module
  returning id into v_lesson;
  update public.draft_modules set revision = revision + 1 where id = p_module;
  update public.course_drafts set updated_at = now(), content_revision = content_revision + 1 where course_id = p_course;
  return pg_catalog.jsonb_build_object('answer', 'created', 'lesson', v_lesson);
end
$$;

create function private.draft_save_lesson(p_course uuid, p_lesson uuid, p_seen bigint, p_title text,
                                          p_description text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_revision bigint;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select revision into v_revision from public.draft_lessons where id = p_lesson and course_id = p_course;
  if v_revision is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_revision is distinct from p_seen then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  if not private.draft_text_ok(p_title, 120, false)
     or (p_description is not null and not private.draft_text_ok(p_description, 2000, true)) then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  update public.draft_lessons set title = p_title, description = p_description, revision = revision + 1
   where id = p_lesson and course_id = p_course;
  update public.draft_modules set revision = revision + 1
   where id = (select module_id from public.draft_lessons where id = p_lesson) and course_id = p_course;
  update public.course_drafts set updated_at = now(), content_revision = content_revision + 1 where course_id = p_course;
  return pg_catalog.jsonb_build_object('answer', 'saved');
end
$$;

create function private.draft_delete_lesson(p_course uuid, p_lesson uuid, p_seen bigint) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_lesson public.draft_lessons;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select * into v_lesson from public.draft_lessons where id = p_lesson and course_id = p_course;
  if v_lesson.id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_lesson.revision is distinct from p_seen then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  delete from public.draft_lessons where id = p_lesson and course_id = p_course;
  update public.draft_lessons set position = position - 1
   where module_id = v_lesson.module_id and position > v_lesson.position;
  update public.draft_modules set revision = revision + 1 where id = v_lesson.module_id;
  update public.course_drafts set updated_at = now(), content_revision = content_revision + 1 where course_id = p_course;
  return pg_catalog.jsonb_build_object('answer', 'deleted');
end
$$;

-- Mover una lección lleva el módulo y la posición que se vieron. Dentro del mismo módulo va de 1 a
-- cuántas hay; a otro, de 1 a una después de la última.
create function private.draft_move_lesson(p_course uuid, p_lesson uuid, p_seen_module uuid, p_seen_position integer,
                                          p_to_module uuid, p_to_position integer) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_lesson public.draft_lessons;
  v_count integer;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select * into v_lesson from public.draft_lessons where id = p_lesson and course_id = p_course;
  if v_lesson.id is null
     or not exists (select 1 from public.draft_modules where id = p_to_module and course_id = p_course) then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_lesson.module_id is distinct from p_seen_module or v_lesson.position is distinct from p_seen_position then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  select pg_catalog.count(*)::integer into v_count from public.draft_lessons where module_id = p_to_module;
  if p_to_module <> v_lesson.module_id then
    v_count := v_count + 1;
  end if;
  if p_to_position is null or p_to_position < 1 or p_to_position > v_count then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  if p_to_module = v_lesson.module_id and p_to_position = v_lesson.position then
    return pg_catalog.jsonb_build_object('answer', 'moved');
  end if;
  set constraints public.draft_lessons_position_uq deferred;
  if p_to_module = v_lesson.module_id then
    if p_to_position < v_lesson.position then
      update public.draft_lessons set position = position + 1
       where module_id = p_to_module and position >= p_to_position and position < v_lesson.position;
    else
      update public.draft_lessons set position = position - 1
       where module_id = p_to_module and position > v_lesson.position and position <= p_to_position;
    end if;
  else
    update public.draft_lessons set position = position - 1
     where module_id = v_lesson.module_id and position > v_lesson.position;
    update public.draft_lessons set position = position + 1
     where module_id = p_to_module and position >= p_to_position;
    update public.draft_modules set revision = revision + 1 where id in (v_lesson.module_id, p_to_module);
  end if;
  update public.draft_lessons set module_id = p_to_module, position = p_to_position
   where id = p_lesson and course_id = p_course;
  set constraints public.draft_lessons_position_uq immediate;
  update public.course_drafts set updated_at = now(), content_revision = content_revision + 1 where course_id = p_course;
  return pg_catalog.jsonb_build_object('answer', 'moved');
end
$$;

-- Borrar un borrador que nunca se envió (decisión de Sergio del 2026-10-29): se va el registro, y
-- con él todo el borrador. Lleva la revisión del contenido entero que se vio: un módulo o una lección
-- de otra pestaña también la sube. Hasta T-405 todo borrador es
-- nunca enviado; T-405 suma esa condición. El guardián de lo publicado lo vuelve a exigir.
create function private.draft_delete_course(p_course uuid, p_seen bigint) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  if (select content_revision from public.course_drafts where course_id = p_course) is distinct from p_seen then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  delete from public.course_registry where course_id = p_course and teacher_id = v_teacher;
  return pg_catalog.jsonb_build_object('answer', 'deleted');
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'private.draft_create(uuid, text)',
    'private.draft_save_course(uuid, bigint, text, text, uuid, uuid)',
    'private.draft_add_module(uuid, bigint, text)',
    'private.draft_rename_module(uuid, uuid, bigint, text)',
    'private.draft_delete_module(uuid, uuid, bigint)',
    'private.draft_move_module(uuid, uuid, integer, integer)',
    'private.draft_add_lesson(uuid, uuid, bigint, text)',
    'private.draft_save_lesson(uuid, uuid, bigint, text, text)',
    'private.draft_delete_lesson(uuid, uuid, bigint)',
    'private.draft_move_lesson(uuid, uuid, uuid, integer, uuid, integer)',
    'private.draft_delete_course(uuid, bigint)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to app_service', f);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------
-- El área `drafts` del vigilante (carril B).

create function private.schema_violations_drafts()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  draft_tables (table_name, name) as (
    values ('public.course_drafts', 'course_drafts'), ('public.draft_modules', 'draft_modules'),
           ('public.draft_lessons', 'draft_lessons')),
  -- Las del servidor (`server`) y las que nadie de la aplicación ejecuta.
  draft_functions (signature, server) as (
    values ('private.draft_create(uuid, text)', true),
           ('private.draft_save_course(uuid, bigint, text, text, uuid, uuid)', true),
           ('private.draft_add_module(uuid, bigint, text)', true),
           ('private.draft_rename_module(uuid, uuid, bigint, text)', true),
           ('private.draft_delete_module(uuid, uuid, bigint)', true),
           ('private.draft_move_module(uuid, uuid, integer, integer)', true),
           ('private.draft_add_lesson(uuid, uuid, bigint, text)', true),
           ('private.draft_save_lesson(uuid, uuid, bigint, text, text)', true),
           ('private.draft_delete_lesson(uuid, uuid, bigint)', true),
           ('private.draft_move_lesson(uuid, uuid, uuid, integer, uuid, integer)', true),
           ('private.draft_delete_course(uuid, bigint)', true),
           ('private.draft_open(uuid, uuid)', false),
           ('private.draft_refusal()', false),
           ('private.draft_text_ok(text, integer, boolean)', false),
           ('private.guard_draft()', false)),
  found as (
    select f.signature, f.server, p.oid, p.prosecdef, p.proconfig, p.proowner
    from draft_functions f
    left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(f.signature))
  -- Nadie de la aplicación escribe el borrador, ni una columna: solo las funciones, como el dueño.
  select 'draft table writable by ' || r.rolname, t.table_name
  from app_roles r cross join draft_tables t
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Lo lee la persona (su política dice qué); ni el visitante ni el servidor.
  select 'draft table readable by ' || r.rolname, t.table_name
  from app_roles r cross join draft_tables t
  where r.rolname <> 'authenticated'
    and pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT')
  union all
  select 'draft table without row level security', t.table_name
  from draft_tables t
  join pg_catalog.pg_class c on c.oid = t.table_name::regclass
  where not c.relrowsecurity
  union all
  -- Una sola política por tabla: su maestro lee lo suyo.
  select 'draft policy other than teacher read', t.table_name
  from draft_tables t
  join pg_catalog.pg_policy p on p.polrelid = t.table_name::regclass
  where not (p.polcmd = 'r' and p.polpermissive
             and p.polroles = array['authenticated'::regrole]::oid[]
             and pg_catalog.pg_get_expr(p.polqual, p.polrelid)
                 = '(teacher_id = ( SELECT private.current_teacher_id() AS current_teacher_id))')
  union all
  select 'draft table without its teacher read policy', t.table_name
  from draft_tables t
  where not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = t.table_name::regclass)
  union all
  -- Los dos guardianes de cada tabla, con su función y prendidos para las sesiones normales (`O`, o
  -- `A` siempre). El tipo es la suma de fila (1), antes (2), insertar (4), borrar (8) y cambiar (16);
  -- el de vaciar, antes (2) y vaciar (32), por sentencia.
  select 'draft table without guard', t.table_name
  from draft_tables t
  cross join (values ('_guard', 31), ('_no_truncate', 34)) as g (suffix, kind)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = t.table_name::regclass and tg.tgname = t.name || g.suffix
      and tg.tgfoid = 'private.guard_draft()'::regprocedure and tg.tgtype = g.kind
      and tg.tgenabled in ('O', 'A'))
  union all
  -- Ni disparadores ajenos: ninguno más que los suyos y las restricciones.
  select 'draft table with a foreign trigger', t.table_name
  from draft_tables t
  join pg_catalog.pg_trigger tg on tg.tgrelid = t.table_name::regclass
  where not tg.tgisinternal and tg.tgname not in (t.name || '_guard', t.name || '_no_truncate')
  union all
  select 'draft function missing', f.signature
  from found f where f.oid is null
  union all
  -- Una función del borrador que el área no conoce (otra firma de una que sí, o una nueva) se agrega a
  -- la lista: si no, nadie revisaría a quién se le concede.
  select 'draft function not in the watchdog area', p.oid::regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private'
  where (p.proname like 'draft\_%' or p.proname = 'guard_draft')
    and not exists (select 1 from found f where f.oid = p.oid)
  union all
  -- Las restricciones que sostienen lo que las funciones suponen: los textos, el borrado en cascada
  -- desde el registro y las posiciones únicas que se pueden diferir dentro de una función.
  select 'draft table without constraint ' || c.name, c.table_name
  from (values
      ('public.course_drafts', 'course_drafts_title_ok', 'c', false),
      ('public.course_drafts', 'course_drafts_summary_ok', 'c', false),
      ('public.course_drafts', 'course_drafts_course_teacher_fk', 'f', false),
      ('public.course_drafts', 'course_drafts_create_token_uq', 'u', false),
      ('public.draft_modules', 'draft_modules_title_ok', 'c', false),
      ('public.draft_modules', 'draft_modules_course_fk', 'f', false),
      ('public.draft_modules', 'draft_modules_position_uq', 'u', true),
      ('public.draft_lessons', 'draft_lessons_title_ok', 'c', false),
      ('public.draft_lessons', 'draft_lessons_description_ok', 'c', false),
      ('public.draft_lessons', 'draft_lessons_course_fk', 'f', false),
      ('public.draft_lessons', 'draft_lessons_module_fk', 'f', false),
      ('public.draft_lessons', 'draft_lessons_position_uq', 'u', true)) as c (table_name, name, kind, deferred_ok)
  where not exists (
    select 1 from pg_catalog.pg_constraint k
    where k.conrelid = c.table_name::regclass and k.conname = c.name and k.contype = c.kind::"char" and k.convalidated
      and (c.kind <> 'f' or k.confdeltype = 'c')
      and k.condeferrable = c.deferred_ok and not k.condeferred)
  union all
  select 'draft function executable by ' || r.rolname, f.signature
  from found f cross join app_roles r
  where f.oid is not null and (not f.server or r.rolname <> 'app_service')
    and pg_catalog.has_function_privilege(r.rolname::name, f.oid, 'EXECUTE')
  union all
  select 'draft function not executable by app_service', f.signature
  from found f
  where f.oid is not null and f.server and not pg_catalog.has_function_privilege('app_service', f.oid, 'EXECUTE')
  union all
  -- Las del servidor son security definer (escriben como el dueño); el guardián no (mira quién
  -- ejecuta). Todas con el search_path vacío y del dueño de las tablas.
  select 'draft function not security definer', f.signature
  from found f
  where f.oid is not null and f.server and not f.prosecdef
  union all
  select 'draft function security definer', f.signature
  from found f
  where f.oid is not null and f.signature = 'private.guard_draft()' and f.prosecdef
  union all
  select 'draft function without fixed search_path', f.signature
  from found f
  where f.oid is not null and not coalesce(f.proconfig, '{}') @> array['search_path=""']
  union all
  select 'draft function not owned by the table owner', f.signature
  from found f
  where f.oid is not null
    and f.proowner <> (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.course_drafts'::regclass)
$$;
revoke all on function private.schema_violations_drafts() from public;
