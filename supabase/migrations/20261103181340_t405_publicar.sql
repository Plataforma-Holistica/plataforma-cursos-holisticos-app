-- T-405, cuarta solicitud · Publicar desde el borrador (RF-606, RF-607, RN-16, RF-310, FL-35; esquema §5.2). Contenido aprueba lo que el maestro envió desde el editor, y la base lo
-- publica desde la fotografía del envío. Plan aprobado por Sergio el 2026-11-03.
--
-- Por qué es así:
--   · Una función nueva (`review_approve`) y no `approve_course`, que sigue para los cursos por guion y es del carril A. Las dos comparten el guardián de lo publicado.
--   · Aprobar lleva el envío que se vio, como devolver: un formulario que llega tarde, con el curso devuelto y vuelto a enviar, contesta `changed`.
--   · Candados en el orden de enviar: la fila del maestro (`for share`, la que suspender toma para cambiar), las listas, el curso y el registro. Así no se publica el curso de alguien
--     que se suspende en ese instante.
--   · No se aprueba (decisiones de Sergio del 2026-11-03): el curso de un maestro suspendido, o con la cuenta suspendida, o que se fue (`teacher_suspended`; se queda en revisión), ni
--     un curso con una lección sin subtítulos (`captions_pending`, RF-310): lo que el servidor le preguntó a Mux llega en la misma llamada y se anota antes de decidir.
--   · RN-16: el anexo aceptado tiene que ser una versión publicada (1 o más). La 0 solo vale en una base local, con la marca de `db:drafts` (`annex_draft`).
--   · Cada archivo se compara con el que se revisó: el original de cada video y cada recurso, por su objeto y su versión en Storage (`files_changed`).
--   · Lo publicado sale de la fotografía, no del borrador: es lo que se revisó. Los ids son los del borrador (módulos, lecciones, videos y recursos), para que «Editar» (la quinta
--     solicitud) los recree iguales. Las lecciones se numeran en el curso entero, como lo publicado; en el borrador van por módulo.
--   · Cada video guarda su original (`original_path`, RNF-17) y lo que el borrador necesita para volver. Sin la ruta, al borrar el borrador la papelera sacaría el renglón por el asset
--     y el repaso daría el original por huérfano y lo borraría: la prueba 77 lo exige. `original_archived_at` es la fecha del objeto en Storage. La huella del archivo queda nula:
--     nadie la calcula todavía.
--   · El slug sale del título y no cambia (03, PA-02); si ya existe, lleva un número. Lo elige un candado propio, después de los del curso.
--   · Al aprobar, el borrador se borra (05 §5.2), en la misma transacción: lo que la papelera recibe por la cascada sale enseguida, porque lo publicado lo nombra.
--   · El guion local (`db:student`) sigue publicando solo los cursos por guion: un envío aprobado deja una persona en `reviewed_by`, y lo enviado desde el editor se aprueba en PA-62.
--   · El guardián de lo publicado acepta un video del proveedor de prueba también con la marca local `video_test` (la que pone `db:login`), para aprobar en un extremo a extremo.
--     Fuera de local nadie la pone (acordado con el carril A el 2026-11-03).

-- ---------------------------------------------------------------------------------------
-- Lo que lo publicado necesita y no tenía.

alter table public.published_courses add column course_review_id uuid references public.course_reviews (id);
comment on column public.published_courses.course_review_id is 'El envío que lo publicó (T-405). Nulo en los cursos por guion.';

alter table public.published_lessons add column description text;
alter table public.published_lessons
  add constraint published_lessons_description_ok check (description is null or private.draft_text_ok(description, 2000, true));

alter table public.video_assets
  add column file_name text,
  add column mime text,
  add column object_id uuid,
  add column object_version text,
  add column read_seconds integer;
comment on column public.video_assets.object_version is 'El original confirmado, con object_id: lo que el borrador necesita para volver (T-405). Nulo en los cursos por guion.';

-- ---------------------------------------------------------------------------------------
-- El guardián de lo publicado: lo de la primera solicitud, y un video de prueba también con la marca local.

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
  -- El maestro activo, en el registro de cursos: dar de alta un borrador limpio suyo, borrar un
  -- borrador suyo que nunca se publicó, o enviarlo a revisión. En su propio bloque: plpgsql resuelve
  -- `new.teacher_id` aunque la tabla sea otra. Un nulo cuenta como no.
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
    elsif tg_op = 'UPDATE' then
      v_teacher := coalesce(
        old.teacher_id = private.current_active_teacher_id()
        and old.state = 'draft' and new.state = 'in_review' and old.first_published_at is null
        and new.updated_at = pg_catalog.now()
        and (pg_catalog.to_jsonb(new) - array['state', 'updated_at']) = (pg_catalog.to_jsonb(old) - array['state', 'updated_at'])
        and exists (
          select 1 from public.course_reviews c
          join public.licenses l on l.course_review_id = c.id
          where c.course_id = new.course_id and c.teacher_id = new.teacher_id and c.result = 'pending'
            and l.accepted_by = private.actor_id()),
        false);
    end if;
  -- Aceptar la invitación: el maestro invitado y sin cuenta se ata a quien actúa y queda activo.
  elsif tg_relid = 'public.teachers'::regclass and tg_op = 'UPDATE' and not private.actor_is_system() then
    v_teacher := coalesce(
      old.status = 'invited' and old.profile_id is null
      and new.status = 'active' and new.profile_id = private.actor_id()
      and (pg_catalog.to_jsonb(new) - array['status', 'profile_id'])
          = (pg_catalog.to_jsonb(old) - array['status', 'profile_id'])
      and exists (
        select 1 from private.teacher_invitations i
        where i.teacher_id = new.id and i.accepted_by = new.profile_id and i.accepted_at is not null),
      false);
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
  -- En dos pasos: plpgsql resuelve `new.provider` aunque la tabla no sea la de videos. Un video de prueba: el guion de los cursos de prueba, o una base con la marca local de los
  -- videos de prueba (la pone db:login; fuera de local nadie la pone).
  if tg_table_name = 'video_assets' then
    if new.provider = 'test'
       -- Un ajuste que nunca se definió es nulo, y un `if` nulo no lanza: por eso el coalesce.
       and not ((private.actor_is_system() and coalesce(pg_catalog.current_setting('app.local_courses', true), '') = 'on')
                or exists (select 1 from private.local_flags f where f.flag = 'video_test')) then
      raise exception '%.%: test videos are only loaded by the local courses script', tg_table_schema, tg_table_name
        using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------
-- La fotografía, leída para publicar: las lecciones en orden, numeradas en el curso entero, y los recursos con su lugar.

create function private.review_snapshot_lessons(p_snapshot jsonb)
returns table (module_id uuid, module_title text, module_position integer, lesson_id uuid, lesson_title text, description text, lesson_position integer, video jsonb, resources jsonb)
language sql immutable set search_path = ''
as $$
  select (m.value ->> 'id')::uuid, m.value ->> 'title', m.o::integer,
         (l.value ->> 'id')::uuid, l.value ->> 'title', l.value ->> 'description',
         (pg_catalog.row_number() over (order by m.o, l.o))::integer, l.value -> 'video', l.value -> 'resources'
  from pg_catalog.jsonb_array_elements(p_snapshot -> 'modules') with ordinality as m (value, o)
  cross join lateral pg_catalog.jsonb_array_elements(m.value -> 'lessons') with ordinality as l (value, o)
  order by m.o, l.o
$$;
revoke all on function private.review_snapshot_lessons(jsonb) from public;

create function private.review_snapshot_resources(p_snapshot jsonb)
returns table (id uuid, lesson_id uuid, title text, kind text, mime text, size_bytes bigint, "position" integer, storage_path text, object_id uuid, object_version text)
language sql immutable set search_path = ''
as $$
  select (r.value ->> 'id')::uuid, x.lesson_id, r.value ->> 'title', r.value ->> 'kind', r.value ->> 'mime', (r.value ->> 'size_bytes')::bigint,
         (r.value ->> 'position')::integer, r.value ->> 'storage_path', (r.value ->> 'object_id')::uuid, r.value ->> 'object_version'
  from (select null::uuid as lesson_id, p_snapshot -> 'resources' as resources
        union all
        select s.lesson_id, s.resources from private.review_snapshot_lessons(p_snapshot) s) as x
  cross join lateral pg_catalog.jsonb_array_elements(x.resources) as r (value)
$$;
revoke all on function private.review_snapshot_resources(jsonb) from public;

-- ---------------------------------------------------------------------------------------
-- Publicar un envío pendiente, con los candados ya tomados. No la ejecuta nadie de la aplicación: entra por review_approve. Contesta: approved, teacher_suspended,
-- unavailable, annex_draft, practice_inactive, level_inactive, files_changed, captions_pending. No escribe antes de rechazar, salvo los subtítulos que dijo Mux.

create function private.review_publish(p_review uuid, p_by uuid, p_captions uuid[]) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_review public.course_reviews;
  v_snapshot jsonb;
  v_name text;
  v_slug text;
  v_try text;
  v_n integer := 1;
begin
  select * into v_review from public.course_reviews c where c.id = p_review and c.result = 'pending';
  if v_review.id is null then
    return 'unavailable';
  end if;
  v_snapshot := v_review.content_snapshot;
  -- El maestro y su cuenta, activos: uno suspendido o que se fue no publica (decisión de Sergio del 2026-11-03).
  if not exists (
      select 1 from public.teachers t join public.profiles p on p.id = t.profile_id
      where t.id = v_review.teacher_id and t.status = 'active' and p.status = 'active') then
    return 'teacher_suspended';
  end if;
  select pt.display_name into v_name from public.published_teachers pt where pt.teacher_id = v_review.teacher_id;
  if v_name is null then
    return 'unavailable';
  end if;
  -- RN-16: el anexo aceptado es un texto publicado. La versión 0 solo vale en una base local, con la marca de db:drafts.
  if not exists (
      select 1 from public.licenses l join public.legal_documents d on d.id = l.legal_document_id
      where l.course_review_id = p_review
        and (d.version >= 1 or exists (select 1 from private.local_flags f where f.flag = 'legal_drafts'))) then
    return 'annex_draft';
  end if;
  if not exists (select 1 from public.practices p where p.id = (v_snapshot -> 'course' ->> 'practice_id')::uuid and p.is_active) then
    return 'practice_inactive';
  end if;
  if not exists (select 1 from public.levels l where l.id = (v_snapshot -> 'course' ->> 'level_id')::uuid and l.is_active) then
    return 'level_inactive';
  end if;
  -- Los videos del borrador, tomados: en revisión solo cambian sus subtítulos. Cada uno sigue siendo el que se envió, con su original en la cubeta; cada recurso, también.
  perform 1 from public.draft_videos v where v.course_id = v_review.course_id for update;
  if exists (
      select 1 from private.review_snapshot_lessons(v_snapshot) x
      where x.video is null
         or not exists (
              select 1 from public.draft_videos v
              where v.id = (x.video ->> 'id')::uuid and v.course_id = v_review.course_id and v.is_current
                and v.provider_asset_id = x.video ->> 'provider_asset_id' and v.provider_playback_id = x.video ->> 'provider_playback_id')
         or not exists (
              select 1 from storage.objects o
              where o.bucket_id = 'video-originals' and o.name = x.video ->> 'storage_path'
                and o.id = (x.video ->> 'object_id')::uuid and o.version = x.video ->> 'object_version'))
     or exists (
      select 1 from private.review_snapshot_resources(v_snapshot) r
      where not exists (
        select 1 from storage.objects o
        where o.bucket_id = 'course-resources' and o.name = r.storage_path and o.id = r.object_id and o.version = r.object_version)) then
    return 'files_changed';
  end if;
  -- Lo que el servidor le preguntó a Mux, antes de decidir: solo los videos vigentes de este curso.
  update public.draft_videos v set captions_ready = true
  where v.course_id = v_review.course_id and v.is_current and not v.captions_ready and v.id = any(coalesce(p_captions, '{}'));
  if exists (
      select 1 from private.review_snapshot_lessons(v_snapshot) x
      join public.draft_videos v on v.id = (x.video ->> 'id')::uuid
      where not v.captions_ready) then
    return 'captions_pending';
  end if;

  -- El slug, del título; con un número si ya existe. Un candado propio, después de los del curso.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('published_courses.slug', 0));
  v_slug := coalesce(nullif(private.catalog_slug(v_snapshot -> 'course' ->> 'title'), ''), 'curso');
  v_try := v_slug;
  while exists (select 1 from public.published_courses c where c.slug = v_try) loop
    v_n := v_n + 1;
    v_try := v_slug || '-' || v_n;
  end loop;

  insert into public.video_assets
    (id, course_id, teacher_id, lesson_id, provider, provider_asset_id, provider_playback_id, status, duration_seconds, captions_ready,
     original_path, original_size_bytes, original_archived_at, file_name, mime, object_id, object_version, read_seconds, created_by)
  select (x.video ->> 'id')::uuid, v_review.course_id, v_review.teacher_id, x.lesson_id, x.video ->> 'provider', x.video ->> 'provider_asset_id',
         x.video ->> 'provider_playback_id', 'ready', (x.video ->> 'duration_seconds')::integer, true,
         x.video ->> 'storage_path', (x.video ->> 'size_bytes')::bigint, coalesce(o.created_at, now()), x.video ->> 'file_name', x.video ->> 'mime',
         (x.video ->> 'object_id')::uuid, x.video ->> 'object_version', (x.video ->> 'read_seconds')::integer, v_review.submitted_by
  from private.review_snapshot_lessons(v_snapshot) x
  join storage.objects o on o.bucket_id = 'video-originals' and o.name = x.video ->> 'storage_path';

  insert into public.published_courses
    (course_id, teacher_id, slug, title, summary, teacher_name, practice_id, level_id, lesson_count, total_duration_seconds, is_listed, published_at, course_review_id)
  select v_review.course_id, v_review.teacher_id, v_try, v_snapshot -> 'course' ->> 'title', v_snapshot -> 'course' ->> 'summary', v_name,
         (v_snapshot -> 'course' ->> 'practice_id')::uuid, (v_snapshot -> 'course' ->> 'level_id')::uuid,
         pg_catalog.count(*)::integer, pg_catalog.sum((x.video ->> 'duration_seconds')::integer)::integer, true, now(), p_review
  from private.review_snapshot_lessons(v_snapshot) x;

  insert into public.published_modules (id, course_id, title, position)
  select distinct x.module_id, v_review.course_id, x.module_title, x.module_position
  from private.review_snapshot_lessons(v_snapshot) x;

  insert into public.published_lessons
    (id, course_id, module_id, teacher_id, video_asset_id, title, description, position, duration_seconds, has_captions)
  select x.lesson_id, v_review.course_id, x.module_id, v_review.teacher_id, (x.video ->> 'id')::uuid, x.lesson_title, x.description, x.lesson_position,
         (x.video ->> 'duration_seconds')::integer, true
  from private.review_snapshot_lessons(v_snapshot) x;

  insert into public.published_resources (id, course_id, teacher_id, lesson_id, title, kind, mime, storage_path, object_id, object_version, size_bytes, position)
  select r.id, v_review.course_id, v_review.teacher_id, r.lesson_id, r.title, r.kind::public.resource_kind, r.mime, r.storage_path, r.object_id, r.object_version,
         r.size_bytes, r.position
  from private.review_snapshot_resources(v_snapshot) r;

  update public.course_registry set state = 'published', first_published_at = coalesce(first_published_at, now()), updated_at = now()
  where course_id = v_review.course_id;
  update public.course_reviews set result = 'approved', reviewed_by = p_by, reviewed_at = now() where id = p_review;
  update public.published_teachers set is_listed = true where teacher_id = v_review.teacher_id and not is_listed;

  -- El borrador se va (05 §5.2). Lo que la cascada manda a la papelera lo nombra lo publicado: sale enseguida, sin tocar nada.
  delete from public.course_drafts where course_id = v_review.course_id;
  delete from private.video_trash x
  where x.course_id = v_review.course_id
    and exists (select 1 from public.video_assets a
                where a.course_id = v_review.course_id
                  and ((x.provider_asset_id is not null and a.provider_asset_id = x.provider_asset_id)
                       or (x.storage_path is not null and a.original_path = x.storage_path)));
  return 'approved';
end
$$;
revoke all on function private.review_publish(uuid, uuid, uuid[]) from public;

-- ---------------------------------------------------------------------------------------
-- Aprobar, para Contenido con un código reciente. Lleva el envío que se vio y los videos que Mux dijo que tienen subtítulos. Contesta: approved, forbidden, needs_fresh_code,
-- not_found, not_pending, changed, self, y las de publicar.

create function private.review_approve(p_course uuid, p_submission uuid, p_captions uuid[]) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text := private.content_change_gate();
  v_teacher uuid;
  v_registry public.course_registry;
  v_pending uuid;
begin
  if v_gate is not null then
    return v_gate;
  end if;
  select r.teacher_id into v_teacher from public.course_registry r where r.course_id = p_course;
  if v_teacher is null then
    return 'not_found';
  end if;
  -- El orden de enviar: la fila del maestro, las listas, el curso y el registro.
  perform 1 from public.teachers t where t.id = v_teacher for share;
  perform private.catalog_lock('practices');
  perform private.catalog_lock('levels');
  perform private.course_lock(p_course);
  select * into v_registry from public.course_registry r where r.course_id = p_course for update;
  if v_registry.state <> 'in_review' then
    return 'not_pending';
  end if;
  -- Un curso por guion no tiene envío: lo aprueba approve_course.
  select c.id into v_pending from public.course_reviews c where c.course_id = p_course and c.result = 'pending';
  if v_pending is null then
    return 'not_pending';
  end if;
  if v_pending is distinct from p_submission then
    return 'changed';
  end if;
  if private.actor_owns_teacher(v_registry.teacher_id) then
    return 'self';
  end if;
  return private.review_publish(v_pending, private.actor_id(), p_captions);
end
$$;
revoke all on function private.review_approve(uuid, uuid, uuid[]) from public;
grant execute on function private.review_approve(uuid, uuid, uuid[]) to app_service;

-- Lo que el servidor le pregunta a Mux antes de aprobar: cada video de lo enviado, con la reproducción que se publica. Para Contenido, sin código reciente, como mirar.
create function private.review_approve_assets(p_course uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_state public.course_state;
  v_snapshot jsonb;
begin
  if private.actor_id() is null or not private.actor_has_capability('content'::public.capability) then
    return pg_catalog.jsonb_build_object('answer', 'forbidden');
  end if;
  select r.state into v_state from public.course_registry r where r.course_id = p_course;
  if v_state is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  select c.content_snapshot into v_snapshot
  from public.course_reviews c
  join public.course_registry r on r.course_id = c.course_id and r.state = 'in_review'
  where c.course_id = p_course and c.result = 'pending';
  if v_snapshot is null then
    return pg_catalog.jsonb_build_object('answer', 'not_pending');
  end if;
  return pg_catalog.jsonb_build_object('answer', 'ok', 'assets', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'video', x.video -> 'id', 'lesson', x.lesson_id, 'provider', x.video -> 'provider',
             'asset', x.video -> 'provider_asset_id', 'playback', x.video -> 'provider_playback_id') order by x.lesson_position)
    from private.review_snapshot_lessons(v_snapshot) x), '[]'::jsonb));
end
$$;
revoke all on function private.review_approve_assets(uuid) from public;
grant execute on function private.review_approve_assets(uuid) to app_service;

-- ---------------------------------------------------------------------------------------
-- La cola dice, de lo enviado, qué lecciones esperan todavía sus subtítulos. Lo demás, como en la segunda solicitud.

create or replace function private.review_submission_row(p_review uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with lessons as (
    select m.o as module_order, l.o as lesson_order, m.value as module, l.value as lesson
    from public.course_reviews c
    cross join lateral pg_catalog.jsonb_array_elements(c.content_snapshot -> 'modules') with ordinality as m (value, o)
    cross join lateral pg_catalog.jsonb_array_elements(m.value -> 'lessons') with ordinality as l (value, o)
    where c.id = p_review)
  select pg_catalog.jsonb_build_object(
    'course_id', c.course_id,
    'title', c.content_snapshot -> 'course' ->> 'title',
    'summary', c.content_snapshot -> 'course' ->> 'summary',
    'teacher_name', coalesce(pt.display_name, pr.display_name, ''),
    'teacher_listed', coalesce(pt.is_listed, false),
    'practice', (select p.name from public.practices p where p.id = (c.content_snapshot -> 'course' ->> 'practice_id')::uuid),
    'level', (select lv.name from public.levels lv where lv.id = (c.content_snapshot -> 'course' ->> 'level_id')::uuid),
    'lesson_count', (select pg_catalog.count(*) from lessons),
    'total_duration_seconds', (select coalesce(pg_catalog.sum((x.lesson -> 'video' ->> 'duration_seconds')::integer), 0) from lessons x),
    'loaded_at', c.submitted_at,
    'lessons', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'lesson_id', x.lesson -> 'id',
               'module_id', x.module -> 'id',
               'module', x.module -> 'title',
               'title', x.lesson -> 'title',
               'description', x.lesson -> 'description',
               'duration_seconds', (x.lesson -> 'video' ->> 'duration_seconds')::integer,
               'video', case when x.lesson -> 'video' ->> 'provider' = 'mux' then 'playable' else 'test' end,
               'resources', private.review_submission_resources(x.lesson -> 'resources'))
             order by x.module_order, x.lesson_order)
      from lessons x), '[]'::jsonb),
    'submission', pg_catalog.jsonb_build_object(
      'id', c.id,
      'number', c.submission_no,
      'resources', private.review_submission_resources(c.content_snapshot -> 'resources'),
      'captions_missing', coalesce((
        select pg_catalog.jsonb_agg(x.lesson -> 'id' order by x.module_order, x.lesson_order)
        from lessons x
        where not exists (
          select 1 from public.draft_videos v
          where v.id = (x.lesson -> 'video' ->> 'id')::uuid and v.is_current and v.captions_ready)), '[]'::jsonb),
      'annex', pg_catalog.jsonb_build_object(
        'version', d.version, 'accepted_at', l.accepted_at, 'statement', l.accepted_statement, 'term_years', l.term_years)))
  from public.course_reviews c
  join public.licenses l on l.course_review_id = c.id
  join public.legal_documents d on d.id = l.legal_document_id
  join public.teachers t on t.id = c.teacher_id
  left join public.profiles pr on pr.id = t.profile_id
  left join public.published_teachers pt on pt.teacher_id = c.teacher_id
  where c.id = p_review
$$;

-- ---------------------------------------------------------------------------------------
-- El área `submissions` del vigilante, con lo de esta solicitud.

create or replace function private.schema_violations_submissions()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  evidence_tables (table_name, name) as (
    values ('public.course_reviews', 'course_reviews'), ('public.licenses', 'licenses')),
  submission_functions (signature, server) as (
    values ('private.course_submit_preview(uuid)', true),
           ('private.course_submit(uuid, uuid, text, integer, integer, inet, text)', true),
           ('private.course_annex()', false),
           ('private.course_readiness(uuid)', false),
           ('private.course_snapshot(uuid)', false),
           ('private.course_snapshot_resources(uuid, uuid)', false),
           ('private.course_snapshot_hash(jsonb)', false),
           ('private.course_statement(integer, text, integer, integer)', false),
           ('private.guard_course_review()', false),
           ('private.review_queue()', true),
           ('private.review_return(uuid, uuid, text, text)', true),
           ('private.review_resource_object(uuid)', true),
           ('private.course_return_notes()', true),
           ('private.review_submission_row(uuid)', false),
           ('private.review_submission_resources(jsonb)', false),
           ('private.course_submit_assets(uuid)', true),
           ('private.course_submit_status()', true),
           ('private.course_submit_licenses()', true),
           ('private.course_submit_annex(uuid)', true),
           ('private.review_approve(uuid, uuid, uuid[])', true),
           ('private.review_approve_assets(uuid)', true),
           ('private.review_publish(uuid, uuid, uuid[])', false),
           ('private.review_snapshot_lessons(jsonb)', false),
           ('private.review_snapshot_resources(jsonb)', false)),
  found as (
    select f.signature, f.server, p.oid, p.proconfig, p.proowner, p.prosecdef
    from submission_functions f
    left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(f.signature))
  -- Nadie de la aplicación las lee ni las escribe, ni una columna: solo las funciones, como el dueño.
  select 'evidence table open to ' || r.rolname, t.table_name
  from app_roles r cross join evidence_tables t
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  select 'evidence table without row level security', t.table_name
  from evidence_tables t
  join pg_catalog.pg_class c on c.oid = t.table_name::regclass
  where not c.relrowsecurity
  union all
  select 'evidence table with a policy', t.table_name
  from evidence_tables t
  join pg_catalog.pg_policy p on p.polrelid = t.table_name::regclass
  union all
  -- La prueba sobrevive a borrar el curso: ninguna clave foránea al registro ni al borrador.
  select 'evidence table tied to the course', t.table_name
  from evidence_tables t
  join pg_catalog.pg_constraint k on k.conrelid = t.table_name::regclass and k.contype = 'f'
  where k.confrelid in ('public.course_registry'::regclass, 'public.course_drafts'::regclass)
  union all
  -- Sus disparadores, prendidos y con la definición entera: de los argumentos depende que el origen y la fotografía no pasen a la auditoría y qué se puede vaciar de una licencia,
  -- y un `when` o un `update of` los neutralizarían con el mismo nombre y la misma función.
  select 'evidence table without trigger ' || g.name, g.table_name
  from (values
      ('public.course_reviews', 'course_reviews_guard', 'BEFORE DELETE OR UPDATE ON public.course_reviews FOR EACH ROW EXECUTE FUNCTION private.guard_course_review()'),
      ('public.course_reviews', 'ledger_no_truncate', 'BEFORE TRUNCATE ON public.course_reviews FOR EACH STATEMENT EXECUTE FUNCTION private.reject_mutation()'),
      ('public.course_reviews', 'audit_changes', 'AFTER INSERT OR UPDATE ON public.course_reviews FOR EACH ROW EXECUTE FUNCTION private.audit_row_change(''content'', ''content_snapshot'')'),
      ('public.licenses', 'licenses_guard', 'BEFORE DELETE OR UPDATE ON public.licenses FOR EACH ROW EXECUTE FUNCTION private.allow_only_redaction(''ip'', ''user_agent'')'),
      ('public.licenses', 'ledger_no_truncate', 'BEFORE TRUNCATE ON public.licenses FOR EACH STATEMENT EXECUTE FUNCTION private.reject_mutation()'),
      ('public.licenses', 'audit_changes', 'AFTER INSERT OR UPDATE ON public.licenses FOR EACH ROW EXECUTE FUNCTION private.audit_row_change(''content'', ''ip'', ''user_agent'', ''session_id'', ''aal'')')
    ) as g (table_name, name, definition)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = g.table_name::regclass and tg.tgname = g.name and tg.tgenabled in ('O', 'A')
      and pg_catalog.pg_get_triggerdef(tg.oid) = 'CREATE TRIGGER ' || g.name || ' ' || g.definition)
  union all
  select 'evidence table with a foreign trigger', t.table_name
  from evidence_tables t
  join pg_catalog.pg_trigger tg on tg.tgrelid = t.table_name::regclass
  where not tg.tgisinternal and tg.tgname not in (t.name || '_guard', 'ledger_no_truncate', 'audit_changes')
  union all
  -- Las restricciones que sostienen la prueba: un envío pendiente por curso, una licencia por envío, un rechazo con motivo.
  select 'evidence table without constraint ' || c.name, c.table_name
  from (values
      ('public.course_reviews', 'course_reviews_hash_length', 'CHECK ((octet_length(content_sha256) = 32))'),
      ('public.course_reviews', 'course_reviews_rejection_has_reason', 'CHECK (((result <> ''rejected''::public.review_result) OR private.draft_text_ok(reason, 2000, true)))'),
      ('public.course_reviews', 'course_reviews_rejection_has_fix', 'CHECK (((result <> ''rejected''::public.review_result) OR private.draft_text_ok(what_to_fix, 2000, true)))'),
      ('public.course_reviews', 'course_reviews_reason_only_if_rejected', 'CHECK (((result = ''rejected''::public.review_result) OR ((reason IS NULL) AND (what_to_fix IS NULL))))'),
      ('public.course_reviews', 'course_reviews_result_consistent', 'CHECK ((((result = ''pending''::public.review_result) = (reviewed_at IS NULL)) AND ((result = ''pending''::public.review_result) = (reviewed_by IS NULL))))'),
      ('public.course_reviews', 'course_reviews_submission_uq', 'UNIQUE (course_id, submission_no)'),
      ('public.licenses', 'licenses_course_review_id_key', 'UNIQUE (course_review_id)'),
      ('public.licenses', 'licenses_statement_hash_length', 'CHECK ((octet_length(accepted_statement_sha256) = 32))')
    ) as c (table_name, name, definition)
  where not exists (
    select 1 from pg_catalog.pg_constraint k
    where k.conrelid = c.table_name::regclass and k.conname = c.name and k.convalidated
      and pg_catalog.pg_get_constraintdef(k.oid) = c.definition)
  union all
  -- Entero: con el mismo nombre sobre otra columna, o sobre otros envíos, dos pendientes ya no chocarían.
  select 'evidence index missing', 'public.course_reviews_one_pending_uq'
  where not exists (
    select 1 from pg_catalog.pg_indexes i
    where i.schemaname = 'public' and i.indexname = 'course_reviews_one_pending_uq'
      and i.indexdef = 'CREATE UNIQUE INDEX course_reviews_one_pending_uq ON public.course_reviews USING btree (course_id) WHERE (result = ''pending''::public.review_result)')
  union all
  -- Las reglas de acceso viven adentro de las funciones: quien recree una sin su regla se nota aquí, sin esperar a una prueba.
  select 'submission function without its rule ' || b.rule, b.signature
  from (values
      ('private.review_queue()', 'actor_has_capability'),
      ('private.review_return(uuid, uuid, text, text)', 'content_change_gate'),
      ('private.review_return(uuid, uuid, text, text)', 'actor_owns_teacher'),
      ('private.review_resource_object(uuid)', 'actor_has_capability'),
      ('private.review_resource_object(uuid)', 'in_review'),
      ('private.video_preview(uuid, uuid)', 'in_review'),
      ('private.video_preview(uuid, uuid)', 'actor_has_capability'),
      ('private.course_return_notes()', 'actor_teacher_id'),
      ('private.course_submit_assets(uuid)', 'current_active_teacher_id'),
      ('private.course_submit_status()', 'actor_teacher_id'),
      ('private.course_submit_licenses()', 'actor_teacher_id'),
      ('private.course_submit_annex(uuid)', 'actor_teacher_id'),
      ('private.review_approve(uuid, uuid, uuid[])', 'content_change_gate'),
      ('private.review_approve(uuid, uuid, uuid[])', 'actor_owns_teacher'),
      ('private.review_approve(uuid, uuid, uuid[])', 'in_review'),
      ('private.review_approve_assets(uuid)', 'actor_has_capability'),
      ('private.review_approve_assets(uuid)', 'in_review'),
      ('private.review_publish(uuid, uuid, uuid[])', 'legal_drafts'),
      ('private.review_publish(uuid, uuid, uuid[])', 'video-originals'),
      ('private.review_publish(uuid, uuid, uuid[])', 'captions_ready')
    ) as b (signature, rule)
  where pg_catalog.strpos(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(b.signature)), b.rule) = 0
  union all
  select 'submission function missing', f.signature
  from found f where f.oid is null
  union all
  -- Una función de enviar que el área no conoce se agrega a la lista: si no, nadie revisaría a quién se le concede.
  select 'submission function not in the watchdog area', p.oid::regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname in ('private', 'public')
  where (p.proname like 'course\_submit%' or p.proname like 'course\_snapshot%' or p.proname like 'course\_return%' or (p.proname like 'review\_%' and p.proname <> 'review_alert')
         or p.proname in ('course_annex', 'course_readiness', 'course_statement', 'guard_course_review'))
    and not exists (select 1 from found f where f.oid = p.oid)
  union all
  select 'submission function executable by ' || r.rolname, f.signature
  from found f cross join app_roles r
  where f.oid is not null and (not f.server or r.rolname <> 'app_service')
    and pg_catalog.has_function_privilege(r.rolname::name, f.oid, 'EXECUTE')
  union all
  select 'submission function not executable by app_service', f.signature
  from found f
  where f.oid is not null and f.server and not pg_catalog.has_function_privilege('app_service', f.oid, 'EXECUTE')
  union all
  select 'submission function not security definer', f.signature
  from found f
  where f.oid is not null
    and (f.server or f.signature in ('private.review_submission_row(uuid)', 'private.review_publish(uuid, uuid, uuid[])'))
    and not f.prosecdef
  union all
  select 'submission function without fixed search_path', f.signature
  from found f
  where f.oid is not null and not coalesce(f.proconfig, '{}') @> array['search_path=""']
  union all
  select 'submission function not owned by the table owner', f.signature
  from found f
  where f.oid is not null
    and f.proowner <> (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.course_reviews'::regclass)
$$;
