-- T-405, quinta solicitud · Versiones de un curso publicado (RF-608, RN-14, FL-36, FL-45; esquema §5.2). Plan aprobado por Sergio el 2026-11-03, con una revisión independiente del
-- diseño hecha con el código a la vista.
--
-- Por qué es así:
--   · Una versión vive en el registro como `changes_pending`, con la versión en `draft` o en `in_review` (`pending_version_state`). Nunca como `in_review`: la cola y `approve_course`
--     tomarían un curso en revisión con fila publicada como uno por guion, y lo aprobarían sin revisar lo enviado. Dos ayudantes dicen qué se edita y qué se revisa
--     (`course_editable`, `course_reviewing`), y las funciones que miraban `'draft'` o `'in_review'` los usan.
--   · «Editar» (`course_version_open`) copia lo vigente de lo publicado al borrador con los mismos ids, sin tocar lo que ven los alumnos. Un curso por guion (sin el envío que lo
--     publicó) o uno al que le falta lo que el borrador exige contesta `not_copyable`, antes de escribir. Si ya hay versión, la abre (E1).
--   · El número de versión es el mayor del curso más uno: una versión enviada y descartada no se repite, y dos licencias no dicen lo mismo de contenidos distintos (LF-24).
--   · Descartar borra el borrador y el curso vuelve a publicado (H-18). Toma los videos del borrador antes que el registro: asentar un video toma su fila y después el registro
--     (`video_settle`, `video_promote`), y al revés se interbloquean. `draft_delete_course` también.
--   · Publicar una versión sustituye a lo publicado sin borrar nada: lo que la versión quitó queda retirado, con su id, porque el consumo, el progreso y el reparto apuntan a él
--     (RN-14); el slug, el curso abierto, la fecha de publicación y la de la primera vez no cambian. Un video que ya no usa ninguna lección vigente queda retirado. Las posiciones
--     vigentes se corren hacia arriba antes de escribir las nuevas: sus índices son parciales y no se difieren.
--   · Lo retirado no vuelve a estar vigente, y una lección vigente no apunta a un video retirado: lo exige el guardián, para todos. Es lo que hace segura la retención.
--   · La retención (decisiones de Sergio del 2026-11-03): la fila se queda siempre; el video en el proveedor se borra pasados VIDEO_RETIRADO_PROVEEDOR_DIAS, y el original y el
--     archivo de un recurso pasados ARCHIVO_RETIRADO_DIAS. Lo hace quien opera con el repaso (OP-21), sin trabajo programado: `retired_files_due` dice qué, y `retired_file_done` lo
--     anota después de borrar, comprobando otra vez.
--   · La versión pendiente de un maestro dado de baja (una suspensión con motivo «baja», OP-06) la descarta quien opera con `system_discard_version`, como el dueño declarado sistema;
--     si está en revisión, antes la devuelve Contenido (decisión de Sergio del 2026-11-03).
--   · La cola dice de una versión cuál es y qué cambió frente a lo publicado (FL-45).
--   · El guardián de lo publicado le suma al maestro tres pasos en el registro, sin otro cambio: abrir (con su borrador ya copiado), descartar (ya sin borrador) y enviar la versión
--     (con su envío y su licencia). La función la comparten los dos carriles: los pasos de antes no cambian.

insert into public.parameter_definitions (key, description, value_type, unit, group_name, affects_payout) values
  ('VIDEO_RETIRADO_PROVEEDOR_DIAS', 'Días que el video que una versión nueva retiró se conserva en el proveedor antes de borrarlo', 'integer', 'días', 'operation', false),
  ('ARCHIVO_RETIRADO_DIAS', 'Días que el original de un video retirado y el archivo de un recurso retirado se conservan en la cubeta antes de borrarlos', 'integer', 'días', 'operation', false);

-- ---------------------------------------------------------------------------------------
-- Lo retirado y lo que ya se borró de su archivo.

alter table public.video_assets
  add column retired_at timestamptz,
  add column provider_deleted_at timestamptz,
  add column original_deleted_at timestamptz,
  add constraint video_assets_provider_deleted_is_retired check (provider_deleted_at is null or retired_at is not null),
  add constraint video_assets_original_deleted_is_retired check (original_deleted_at is null or (retired_at is not null and original_path is not null));
comment on column public.video_assets.retired_at is 'Desde cuándo ninguna lección vigente lo usa: una versión nueva lo quitó (T-405). Nunca se vacía.';

-- Qué lecciones vigentes usan un video: lo pregunta el guardián en cada escritura de `video_assets`, y publicar y la retención también.
create index published_lessons_video_idx on public.published_lessons (video_asset_id) where is_current;

alter table public.published_resources
  add column file_deleted_at timestamptz,
  add constraint published_resources_file_deleted_is_retired check (file_deleted_at is null or retired_at is not null);

-- ---------------------------------------------------------------------------------------
-- Qué se edita y qué se revisa.

create function private.course_editable(p_state public.course_state, p_pending public.course_version_state) returns boolean
language sql immutable set search_path = ''
as $$ select coalesce(p_state = 'draft' or (p_state = 'changes_pending' and p_pending = 'draft'), false) $$;
revoke all on function private.course_editable(public.course_state, public.course_version_state) from public;

create function private.course_reviewing(p_state public.course_state, p_pending public.course_version_state) returns boolean
language sql immutable set search_path = ''
as $$ select coalesce(p_state = 'in_review' or (p_state = 'changes_pending' and p_pending = 'in_review'), false) $$;
revoke all on function private.course_reviewing(public.course_state, public.course_version_state) from public;

-- ---------------------------------------------------------------------------------------
-- El guardián de lo publicado: lo de antes, los tres pasos de la versión y lo retirado que no vuelve.

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
  -- El maestro activo, en el registro de cursos: dar de alta un borrador limpio suyo, borrar un borrador suyo que nunca se publicó, enviarlo a revisión, y de un curso publicado
  -- abrir una versión, descartarla o enviarla. En su propio bloque: plpgsql resuelve `new.teacher_id` aunque la tabla sea otra. Un nulo cuenta como no.
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
        and new.updated_at = pg_catalog.now()
        and (pg_catalog.to_jsonb(new) - array['state', 'pending_version_state', 'updated_at'])
            = (pg_catalog.to_jsonb(old) - array['state', 'pending_version_state', 'updated_at'])
        and (
          -- Enviar el borrador de un curso nuevo, con su envío y su licencia.
          (old.state = 'draft' and old.pending_version_state is null and old.first_published_at is null
           and new.state = 'in_review' and new.pending_version_state is null
           and exists (
             select 1 from public.course_reviews c
             join public.licenses l on l.course_review_id = c.id
             where c.course_id = new.course_id and c.teacher_id = new.teacher_id and c.result = 'pending' and not c.is_revision
               and l.accepted_by = private.actor_id()))
          -- Abrir una versión de lo publicado, con su borrador ya copiado.
          or (old.state = 'published' and old.pending_version_state is null and old.first_published_at is not null
              and new.state = 'changes_pending' and new.pending_version_state = 'draft'
              and exists (select 1 from public.course_drafts d where d.course_id = new.course_id and d.teacher_id = new.teacher_id))
          -- Descartarla, ya sin borrador.
          or (old.state = 'changes_pending' and old.pending_version_state = 'draft'
              and new.state = 'published' and new.pending_version_state is null
              and not exists (select 1 from public.course_drafts d where d.course_id = new.course_id))
          -- Enviarla, con su envío y su licencia.
          or (old.state = 'changes_pending' and old.pending_version_state = 'draft'
              and new.state = 'changes_pending' and new.pending_version_state = 'in_review'
              and exists (
                select 1 from public.course_reviews c
                join public.licenses l on l.course_review_id = c.id
                where c.course_id = new.course_id and c.teacher_id = new.teacher_id and c.result = 'pending' and c.is_revision
                  and l.accepted_by = private.actor_id()))),
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
  -- Lo retirado no vuelve (T-405): el consumo, el progreso y el reparto apuntan a esa fila tal como quedó, y la retención borra su archivo. Para todos, también el sistema.
  -- Anidado: plpgsql resuelve `old.is_current` aunque la tabla no lo tenga.
  if tg_op = 'UPDATE' and tg_table_name in ('published_modules', 'published_lessons', 'published_resources') then
    if not old.is_current and new.is_current then
      raise exception '%.%: a retired row does not come back', tg_table_schema, tg_table_name
        using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' and tg_table_name in ('published_lessons', 'published_resources') then
    if old.retired_at is not null and new.retired_at is distinct from old.retired_at then
      raise exception '%.%: a retired row keeps its date', tg_table_schema, tg_table_name
        using errcode = '42501';
    end if;
  end if;
  if tg_table_name = 'published_lessons' then
    if new.is_current and exists (select 1 from public.video_assets a where a.id = new.video_asset_id and a.retired_at is not null) then
      raise exception '%.%: a current lesson does not play a retired video', tg_table_schema, tg_table_name
        using errcode = '42501';
    end if;
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
    if tg_op = 'UPDATE' then
      if old.retired_at is not null and new.retired_at is distinct from old.retired_at then
        raise exception '%.%: a retired video keeps its date', tg_table_schema, tg_table_name
          using errcode = '42501';
      end if;
    end if;
    if new.retired_at is not null and exists (select 1 from public.published_lessons l where l.video_asset_id = new.id and l.is_current) then
      raise exception '%.%: a video a current lesson plays is not retired', tg_table_schema, tg_table_name
        using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Las funciones del borrador y de sus videos: una versión en borrador se edita como un borrador.

create or replace function private.draft_open(p_course uuid, p_teacher uuid) returns text
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.course_lock(p_course);
  if not exists (select 1 from public.course_drafts d where d.course_id = p_course and d.teacher_id = p_teacher) then
    return 'not_found';
  end if;
  if not exists (select 1 from public.course_registry r where r.course_id = p_course and private.course_editable(r.state, r.pending_version_state)) then
    return 'not_editable';
  end if;
  return null;
end
$$;

create or replace function private.video_promote(p_lesson uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_video uuid;
begin
  select v.id into v_video
  from public.draft_videos v join public.course_registry r on r.course_id = v.course_id
  where v.lesson_id = p_lesson and not v.is_current and v.state = 'ready' and private.course_editable(r.state, r.pending_version_state)
  for update of v for share of r;
  if v_video is not null then
    delete from public.draft_videos where lesson_id = p_lesson and is_current;
    update public.draft_videos set is_current = true where id = v_video;
  end if;
end
$$;

create or replace function private.video_due(p_course uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_status public.teacher_status := (
    select t.status from public.course_drafts d join public.teachers t on t.id = d.teacher_id
    where d.course_id = p_course and t.profile_id = private.actor_id());
  v_own uuid := (
    select d.teacher_id from public.course_drafts d join public.teachers t on t.id = d.teacher_id
    where d.course_id = p_course and t.profile_id = private.actor_id());
  v_acts boolean := v_status = 'active'
    and exists (select 1 from public.course_registry r where r.course_id = p_course and private.course_editable(r.state, r.pending_version_state));
  v_result jsonb;
begin
  if coalesce(v_status not in ('active', 'suspended'), true) and not private.actor_has_capability('content'::public.capability) then
    return '[]'::jsonb;
  end if;
  v_acts := coalesce(v_acts, false);
  with due as (
    update public.draft_videos v set checked_at = now()
     where ((v.course_id = p_course
             and (v.state = 'processing'
                  or (v.state = 'ready' and not v.captions_ready)
                  or (v_acts and v.state = 'uploaded')
                  or (v_acts and v.state = 'creating' and v.claimed_at <= now() - interval '5 minutes')
                  or (v_acts and v.state = 'ready' and not v.is_current)))
            or (v.teacher_id = v_own and v.state = 'processing'))
       and (v.checked_at is null
            or v.checked_at <= now() - case when v.state = 'ready' and v.is_current and v.settled_at <= now() - interval '6 hours'
                                            then interval '1 hour' else interval '10 seconds' end)
    returning v.id, v.state, v.provider, v.provider_asset_id, v.read_seconds, v.is_current)
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('video', due.id, 'state', due.state, 'provider', due.provider, 'asset', due.provider_asset_id, 'seconds', due.read_seconds, 'current', due.is_current)), '[]'::jsonb)
    into v_result from due;
  return v_result;
end
$$;

-- Borrar un curso que nunca se publicó. Los videos del borrador antes que el registro, como al descartar.
create or replace function private.draft_delete_course(p_course uuid, p_seen bigint) returns jsonb
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
  if (select first_published_at from public.course_registry where course_id = p_course) is not null then
    return pg_catalog.jsonb_build_object('answer', 'not_editable');
  end if;
  if (select content_revision from public.course_drafts where course_id = p_course) is distinct from p_seen then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  perform 1 from public.draft_videos v where v.course_id = p_course for update;
  delete from public.course_registry where course_id = p_course and teacher_id = v_teacher;
  return pg_catalog.jsonb_build_object('answer', 'deleted');
end
$$;

-- ---------------------------------------------------------------------------------------
-- Abrir, descartar y la baja.

create function private.course_version_open(p_course uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_registry public.course_registry;
  v_published public.published_courses;
  v_version integer;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  if p_course is null or not exists (select 1 from public.course_registry r where r.course_id = p_course and r.teacher_id = v_teacher) then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  perform private.course_lock(p_course);
  select * into v_registry from public.course_registry r where r.course_id = p_course for update;
  if v_registry.state = 'changes_pending' then
    return pg_catalog.jsonb_build_object('answer', 'open', 'course', p_course);
  end if;
  if v_registry.state <> 'published' then
    return pg_catalog.jsonb_build_object('answer', 'not_editable');
  end if;
  select * into v_published from public.published_courses c where c.course_id = p_course;
  -- Lo que no se copia: un curso por guion (sin el envío que lo publicó), o uno con algo que el borrador no admite. Antes de escribir.
  if v_published.course_review_id is null
     or not coalesce(private.draft_text_ok(v_published.title, 60, false), false)
     or (v_published.summary is not null and not coalesce(private.draft_text_ok(v_published.summary, 500, true), false))
     or exists (
       select 1 from public.published_modules m
       where m.course_id = p_course and m.is_current and not coalesce(private.draft_text_ok(m.title, 120, false), false))
     or exists (
       select 1 from public.published_lessons l
       left join public.video_assets a on a.id = l.video_asset_id
       where l.course_id = p_course and l.is_current
         and (not coalesce(private.draft_text_ok(l.title, 120, false), false)
              or (l.description is not null and not coalesce(private.draft_text_ok(l.description, 2000, true), false))
              or a.id is null or a.status <> 'ready' or a.retired_at is not null
              or a.original_path is null or a.original_size_bytes is null or a.object_id is null or a.object_version is null
              or a.read_seconds is null or a.read_seconds <= 0 or a.mime is null or a.mime not in ('video/mp4', 'video/quicktime')
              or not coalesce(private.draft_text_ok(a.file_name, 255, false), false)
              or a.provider_asset_id is null or a.provider_playback_id is null or a.duration_seconds is null)) then
    return pg_catalog.jsonb_build_object('answer', 'not_copyable');
  end if;
  v_version := coalesce((select pg_catalog.max(c.course_version) from public.course_reviews c where c.course_id = p_course), 1) + 1;
  insert into public.course_drafts (course_id, teacher_id, version, title, summary, practice_id, level_id, create_token)
  values (p_course, v_teacher, v_version, v_published.title, v_published.summary, v_published.practice_id, v_published.level_id, gen_random_uuid());
  insert into public.draft_modules (id, course_id, teacher_id, title, position)
  select m.id, p_course, v_teacher, m.title, pg_catalog.row_number() over (order by m.position)
  from public.published_modules m where m.course_id = p_course and m.is_current;
  insert into public.draft_lessons (id, course_id, teacher_id, module_id, title, description, position)
  select l.id, p_course, v_teacher, l.module_id, l.title, l.description, pg_catalog.row_number() over (partition by l.module_id order by l.position)
  from public.published_lessons l where l.course_id = p_course and l.is_current;
  insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                   provider, provider_asset_id, provider_playback_id, duration_seconds, captions_ready, settled_at)
  select a.id, p_course, v_teacher, l.id, 'ready', true, a.file_name, a.mime, a.original_path, a.original_size_bytes, a.object_id, a.object_version, a.read_seconds,
         a.provider, a.provider_asset_id, a.provider_playback_id, a.duration_seconds, a.captions_ready, now()
  from public.published_lessons l join public.video_assets a on a.id = l.video_asset_id
  where l.course_id = p_course and l.is_current;
  insert into public.draft_resources (id, course_id, teacher_id, lesson_id, title, kind, mime, storage_path, size_bytes, state, position, object_id, object_version)
  select r.id, p_course, v_teacher, r.lesson_id, r.title, r.kind, r.mime, r.storage_path, r.size_bytes, 'ready',
         pg_catalog.row_number() over (partition by r.place_id order by r.position), r.object_id, r.object_version
  from public.published_resources r
  where r.course_id = p_course and r.is_current
    and (r.lesson_id is null or exists (select 1 from public.published_lessons l where l.id = r.lesson_id and l.is_current));
  update public.course_registry set state = 'changes_pending', pending_version_state = 'draft', updated_at = now() where course_id = p_course;
  return pg_catalog.jsonb_build_object('answer', 'opened', 'course', p_course);
end
$$;
revoke all on function private.course_version_open(uuid) from public;
grant execute on function private.course_version_open(uuid) to app_service;

-- Lo que comparten descartar y la baja, con los candados ya tomados: el borrador se va, lo que la cascada manda a la papelera y lo publicado nombra sale enseguida, y el curso
-- vuelve a publicado. Lo subido nuevo queda en la papelera, para la limpieza del servidor.
create function private.course_version_drop(p_course uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.course_drafts where course_id = p_course;
  delete from private.video_trash x
  where x.course_id = p_course
    and exists (select 1 from public.video_assets a
                where a.course_id = p_course
                  and ((x.provider_asset_id is not null and a.provider_asset_id = x.provider_asset_id)
                       or (x.storage_path is not null and a.original_path = x.storage_path)));
  update public.course_registry set state = 'published', pending_version_state = null, updated_at = now() where course_id = p_course;
end
$$;
revoke all on function private.course_version_drop(uuid) from public;

-- Descartar (H-18): su maestro activo, con la versión en borrador y lo que se vio. Contesta discarded, changed, not_editable, not_found, suspended, not_teacher.
create function private.course_version_discard(p_course uuid, p_seen bigint) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_registry public.course_registry;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  if p_course is null or not exists (select 1 from public.course_registry r where r.course_id = p_course and r.teacher_id = v_teacher) then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  perform private.course_lock(p_course);
  -- Los videos del borrador antes que el registro: asentar un video toma su fila y después el registro.
  perform 1 from public.draft_videos v where v.course_id = p_course for update;
  select * into v_registry from public.course_registry r where r.course_id = p_course for update;
  if v_registry.state <> 'changes_pending' or v_registry.pending_version_state <> 'draft' then
    return pg_catalog.jsonb_build_object('answer', 'not_editable');
  end if;
  if (select d.content_revision from public.course_drafts d where d.course_id = p_course) is distinct from p_seen then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  perform private.course_version_drop(p_course);
  return pg_catalog.jsonb_build_object('answer', 'discarded');
end
$$;
revoke all on function private.course_version_discard(uuid, bigint) from public;
grant execute on function private.course_version_discard(uuid, bigint) to app_service;

-- La baja de un maestro (OP-06): quien opera descarta su versión en borrador, como el dueño declarado sistema. Una en revisión la devuelve antes Contenido. No la ejecuta nadie de
-- la aplicación. Contesta discarded, in_review, not_pending, not_found, forbidden.
create function private.system_discard_version(p_course uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_registry public.course_registry;
begin
  if not private.actor_is_system() then
    return 'forbidden';
  end if;
  -- El orden de siempre: la fila del maestro, el curso, los videos del borrador y el registro.
  perform 1 from public.teachers t where t.id = (select r.teacher_id from public.course_registry r where r.course_id = p_course) for share;
  perform private.course_lock(p_course);
  perform 1 from public.draft_videos v where v.course_id = p_course for update;
  select * into v_registry from public.course_registry r where r.course_id = p_course for update;
  if v_registry.course_id is null then
    return 'not_found';
  end if;
  if v_registry.state = 'changes_pending' and v_registry.pending_version_state = 'in_review' then
    return 'in_review';
  end if;
  if v_registry.state <> 'changes_pending' then
    return 'not_pending';
  end if;
  perform private.course_version_drop(p_course);
  return 'discarded';
end
$$;
revoke all on function private.system_discard_version(uuid) from public;

-- ---------------------------------------------------------------------------------------
-- Enviar: también una versión. Lo demás, como en la primera solicitud.

create or replace function private.course_submit_preview(p_course uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_missing jsonb;
  v_annex public.legal_documents;
  v_term integer := (private.parameter_value('LICENCIA_ANIOS'))::integer;
  v_title text;
  v_version integer;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  if exists (select 1 from public.course_registry r where r.course_id = p_course and r.state = 'draft' and r.first_published_at is not null) then
    return pg_catalog.jsonb_build_object('answer', 'not_editable');
  end if;
  v_missing := private.course_readiness(p_course);
  if pg_catalog.jsonb_array_length(v_missing) > 0 then
    return pg_catalog.jsonb_build_object('answer', 'not_ready', 'missing', v_missing);
  end if;
  v_annex := private.course_annex();
  if v_annex.id is null then
    return pg_catalog.jsonb_build_object('answer', 'annex_missing');
  end if;
  if v_term is null then
    return pg_catalog.jsonb_build_object('answer', 'unavailable');
  end if;
  select d.title, d.version into v_title, v_version from public.course_drafts d where d.course_id = p_course;
  return pg_catalog.jsonb_build_object(
    'answer', 'ready',
    'annex', pg_catalog.jsonb_build_object(
      'id', v_annex.id, 'version', v_annex.version, 'title', v_annex.title, 'body', v_annex.body, 'effective_from', v_annex.effective_from),
    'term_years', v_term,
    'statement', private.course_statement(v_annex.version, v_title, v_version, v_term),
    'submission_no', coalesce((select pg_catalog.max(c.submission_no) from public.course_reviews c where c.course_id = p_course), 0) + 1,
    'content_sha256', pg_catalog.encode(private.course_snapshot_hash(private.course_snapshot(p_course)), 'hex'));
end
$$;

create or replace function private.course_submit(p_course uuid, p_annex uuid, p_seen_hash text, p_term integer, p_submission integer, p_ip inet, p_user_agent text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_actor uuid := private.actor_id();
  v_session uuid := private.actor_session();
  v_registry public.course_registry;
  v_draft public.course_drafts;
  v_missing jsonb;
  v_annex public.legal_documents;
  v_term integer;
  v_snapshot jsonb;
  v_hash bytea;
  v_statement text;
  v_next integer;
  v_review uuid;
  v_revision boolean;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  if p_course is null or p_annex is null or p_seen_hash is null or p_term is null or p_submission is null then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  perform private.catalog_lock('practices');
  perform private.catalog_lock('levels');
  perform private.course_lock(p_course);
  select * into v_draft from public.course_drafts d where d.course_id = p_course and d.teacher_id = v_teacher;
  if v_draft.course_id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  select * into v_registry from public.course_registry r where r.course_id = p_course for update;
  if not private.course_editable(v_registry.state, v_registry.pending_version_state)
     or (v_registry.state = 'draft' and v_registry.first_published_at is not null) then
    if exists (
        select 1 from public.course_reviews c
        join public.licenses l on l.course_review_id = c.id
        where c.course_id = p_course and c.result = 'pending' and pg_catalog.encode(c.content_sha256, 'hex') = p_seen_hash
          and l.legal_document_id = p_annex and l.term_years = p_term and c.submission_no = p_submission) then
      return pg_catalog.jsonb_build_object('answer', 'submitted');
    end if;
    return pg_catalog.jsonb_build_object('answer', 'not_editable');
  end if;
  v_revision := v_registry.state = 'changes_pending';
  -- Lo que se envía se lee de aquí en adelante, ya con la fila del registro tomada.
  select * into v_draft from public.course_drafts d where d.course_id = p_course;
  v_missing := private.course_readiness(p_course);
  if pg_catalog.jsonb_array_length(v_missing) > 0 then
    return pg_catalog.jsonb_build_object('answer', 'not_ready', 'missing', v_missing);
  end if;
  v_annex := private.course_annex();
  if v_annex.id is null then
    return pg_catalog.jsonb_build_object('answer', 'annex_missing');
  end if;
  v_term := (private.parameter_value('LICENCIA_ANIOS'))::integer;
  if v_term is null then
    return pg_catalog.jsonb_build_object('answer', 'unavailable');
  end if;
  v_snapshot := private.course_snapshot(p_course);
  v_hash := private.course_snapshot_hash(v_snapshot);
  v_next := coalesce((select pg_catalog.max(c.submission_no) from public.course_reviews c where c.course_id = p_course), 0) + 1;
  if v_annex.id <> p_annex or v_term <> p_term or pg_catalog.encode(v_hash, 'hex') <> p_seen_hash or v_next <> p_submission then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  if p_ip is null and not exists (select 1 from private.local_flags f where f.flag = 'legal_drafts') then
    return pg_catalog.jsonb_build_object('answer', 'origin_missing');
  end if;
  v_statement := private.course_statement(v_annex.version, v_draft.title, v_draft.version, v_term);
  insert into public.course_reviews (course_id, teacher_id, submission_no, is_revision, course_version, content_snapshot, content_sha256, submitted_by)
  values (p_course, v_teacher, v_next, v_revision, v_draft.version, v_snapshot, v_hash, v_actor)
  returning id into v_review;
  insert into public.licenses (course_review_id, course_id, teacher_id, legal_document_id, term_years, accepted_statement, accepted_statement_sha256,
                               accepted_by, ip, user_agent, session_id, aal)
  values (v_review, p_course, v_teacher, v_annex.id, v_term, v_statement, pg_catalog.sha256(pg_catalog.convert_to(v_statement, 'UTF8')),
          v_actor, p_ip, pg_catalog.left(p_user_agent, 500), v_session,
          (select s.aal::text from auth.sessions s where s.id = v_session));
  if v_revision then
    update public.course_registry set pending_version_state = 'in_review', updated_at = now() where course_id = p_course;
  else
    update public.course_registry set state = 'in_review', updated_at = now() where course_id = p_course;
  end if;
  return pg_catalog.jsonb_build_object('answer', 'submitted');
end
$$;

create or replace function private.course_submit_status() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'course_id', r.course_id,
           'missing', case when private.course_editable(r.state, r.pending_version_state) and exists (select 1 from public.course_drafts d where d.course_id = r.course_id)
                           then pg_catalog.jsonb_array_length(private.course_readiness(r.course_id)) end,
           'submitted_at', (select c.submitted_at from public.course_reviews c where c.course_id = r.course_id and c.result = 'pending'))
         order by r.course_id), '[]'::jsonb)
  from public.course_registry r
  where r.teacher_id = private.actor_teacher_id()
$$;

-- «En uso» cuenta también la práctica y el nivel de una versión en revisión.
create or replace function private.catalog_in_use(p_list public.catalog_list, p_id uuid) returns integer
language sql stable set search_path = ''
as $$
  select pg_catalog.count(*)::integer
  from (
    select c.course_id
    from public.published_courses c
    join public.course_registry r on r.course_id = c.course_id
    where r.state <> 'withdrawn'
      and case p_list when 'practices' then c.practice_id = p_id else c.level_id = p_id end
    union
    select d.course_id
    from public.course_drafts d
    join public.course_registry r on r.course_id = d.course_id
    where private.course_reviewing(r.state, r.pending_version_state)
      and case p_list when 'practices' then d.practice_id = p_id else d.level_id = p_id end
  ) as u
$$;

-- ---------------------------------------------------------------------------------------
-- La revisión de una versión: devolver, lo que lee el maestro, y lo que Contenido mira.

create or replace function private.review_return(p_course uuid, p_submission uuid, p_reason text, p_what_to_fix text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text := private.content_change_gate();
  v_registry public.course_registry;
  v_pending uuid;
begin
  if v_gate is not null then
    return v_gate;
  end if;
  perform private.course_lock(p_course);
  select * into v_registry from public.course_registry r where r.course_id = p_course for update;
  if v_registry.course_id is null then
    return 'not_found';
  end if;
  if not private.course_reviewing(v_registry.state, v_registry.pending_version_state) then
    return 'not_pending';
  end if;
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
  if not coalesce(private.draft_text_ok(p_reason, 2000, true), false) or not coalesce(private.draft_text_ok(p_what_to_fix, 2000, true), false) then
    return 'invalid';
  end if;
  update public.course_reviews
  set result = 'rejected', reviewed_by = private.actor_id(), reviewed_at = now(), reason = p_reason, what_to_fix = p_what_to_fix
  where id = v_pending;
  if v_registry.state = 'changes_pending' then
    update public.course_registry set pending_version_state = 'draft', updated_at = now() where course_id = p_course;
  else
    update public.course_registry set state = 'draft', updated_at = now() where course_id = p_course;
  end if;
  return 'returned';
end
$$;

-- El motivo de una devolución, solo si es de la versión del borrador: el de una versión que se descartó no reaparece en la siguiente, que lleva otro número.
create or replace function private.course_return_notes() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'course_id', x.course_id, 'reason', x.reason, 'what_to_fix', x.what_to_fix, 'returned_at', x.reviewed_at) order by x.course_id), '[]'::jsonb)
  from (
    select distinct on (c.course_id) c.course_id, c.result, c.reason, c.what_to_fix, c.reviewed_at, c.course_version, d.version as draft_version
    from public.course_reviews c
    join public.course_registry r on r.course_id = c.course_id and private.course_editable(r.state, r.pending_version_state)
    join public.course_drafts d on d.course_id = c.course_id
    where c.teacher_id = private.actor_teacher_id()
    order by c.course_id, c.submission_no desc) as x
  where x.result = 'rejected' and x.course_version = x.draft_version
$$;

create or replace function private.review_resource_object(p_resource uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('path', x.storage_path, 'mime', x.mime, 'title', x.title)
  from public.draft_resources x
  join public.course_registry r on r.course_id = x.course_id and private.course_reviewing(r.state, r.pending_version_state)
  join storage.objects o on o.bucket_id = 'course-resources' and o.name = x.storage_path
                        and o.id = x.object_id and o.version = x.object_version
  where x.id = p_resource and x.state = 'ready' and private.actor_has_capability('content'::public.capability)
$$;

create or replace function private.video_preview(p_course uuid, p_lesson uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_row public.draft_videos;
  v_owner boolean := exists (
    select 1 from public.course_drafts d join public.teachers t on t.id = d.teacher_id
    where d.course_id = p_course and t.profile_id = private.actor_id() and t.status in ('active', 'suspended'));
begin
  if not v_owner and not (
      private.actor_has_capability('content'::public.capability)
      and exists (select 1 from public.course_registry r where r.course_id = p_course and private.course_reviewing(r.state, r.pending_version_state))) then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  select * into v_row from public.draft_videos where lesson_id = p_lesson and course_id = p_course and is_current;
  if v_row.id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  return pg_catalog.jsonb_build_object('answer', 'ok', 'playback', v_row.provider_playback_id, 'provider', v_row.provider, 'seconds', v_row.duration_seconds,
                                       'email', (select u.email from auth.users u where u.id = private.actor_id()));
end
$$;

create or replace function private.review_queue() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.actor_id() is null or not private.actor_has_capability('content') then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.content_change_gate() is null,
    'courses', coalesce((
      select pg_catalog.jsonb_agg(q.course order by q.at, q.course_id)
      from (
        select r.course_id, r.created_at as at,
               pg_catalog.jsonb_build_object(
                 'course_id', c.course_id,
                 'title', c.title,
                 'teacher_name', c.teacher_name,
                 'teacher_listed', coalesce(t.is_listed, false),
                 'practice', p.name,
                 'level', l.name,
                 'lesson_count', c.lesson_count,
                 'total_duration_seconds', c.total_duration_seconds,
                 'loaded_at', r.created_at,
                 'lessons', coalesce((
                   select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                            'lesson_id', pl.id,
                            'module_id', m.id,
                            'module', m.title,
                            'title', pl.title,
                            'duration_seconds', pl.duration_seconds,
                            -- Un mapa cerrado: lo que la pantalla dice de cada video.
                            'video', case
                              when v.provider <> 'mux' then 'test'
                              when v.status = 'ready' then 'playable'
                              when v.status = 'errored' then 'errored'
                              else 'processing'
                            end) order by pl.position)
                   from public.published_lessons pl
                   join public.published_modules m on m.id = pl.module_id
                   join public.video_assets v on v.id = pl.video_asset_id
                   where pl.course_id = c.course_id and pl.is_current and m.is_current), '[]'::jsonb)) as course
        from public.course_registry r
        join public.published_courses c on c.course_id = r.course_id
        left join public.published_teachers t on t.teacher_id = r.teacher_id
        left join public.practices p on p.id = c.practice_id
        left join public.levels l on l.id = c.level_id
        where r.state = 'in_review'
        union all
        select c.course_id, c.submitted_at, private.review_submission_row(c.id)
        from public.course_reviews c
        join public.course_registry r on r.course_id = c.course_id and private.course_reviewing(r.state, r.pending_version_state)
        where c.result = 'pending') as q), '[]'::jsonb));
end
$$;

-- Qué cambió de una versión frente a lo publicado (FL-45): los datos del curso, y los títulos de lo que llegó, se fue, se renombró, cambió de video o de lugar. Nulo en un primer envío.
-- Una lección cambia de lugar si cambia de módulo, o si cambia su orden entre las que siguen en el mismo módulo: que se quite la de antes no la mueve. Un módulo, si cambia su orden
-- entre los que siguen.
create function private.course_version_changes(p_review uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with review as (
    select c.course_id, c.content_snapshot as s from public.course_reviews c where c.id = p_review and c.is_revision),
  published as (
    select p.* from public.published_courses p join review r on r.course_id = p.course_id),
  new_modules as (
    select (m.value ->> 'id')::uuid as id, m.value ->> 'title' as title, m.o as position
    from review r cross join lateral pg_catalog.jsonb_array_elements(r.s -> 'modules') with ordinality as m (value, o)),
  old_modules as (
    select m.id, m.title, m.position from public.published_modules m join review r on r.course_id = m.course_id where m.is_current),
  new_lessons as (
    select x.lesson_id as id, x.lesson_title as title, x.description, x.module_id, x.lesson_position as position, (x.video ->> 'id')::uuid as video
    from review r cross join lateral private.review_snapshot_lessons(r.s) x),
  old_lessons as (
    select l.id, l.title, l.description, l.module_id, l.position, l.video_asset_id as video
    from public.published_lessons l join review r on r.course_id = l.course_id where l.is_current),
  common as (
    select n.id, n.title, n.position, n.module_id as new_module, o.module_id as old_module, n.position as new_position, o.position as old_position,
           (n.title is distinct from o.title or n.description is distinct from o.description) as text_changed,
           n.video is distinct from o.video as video_changed
    from new_lessons n join old_lessons o on o.id = n.id),
  stayed as (
    select c.id,
           pg_catalog.row_number() over (partition by c.new_module order by c.new_position) as new_rank,
           pg_catalog.row_number() over (partition by c.new_module order by c.old_position) as old_rank
    from common c where c.new_module = c.old_module),
  common_modules as (
    select n.id, n.title, n.position,
           pg_catalog.row_number() over (order by n.position) as new_rank,
           pg_catalog.row_number() over (order by o.position) as old_rank
    from new_modules n join old_modules o on o.id = n.id),
  new_resources as (
    select x.id, x.title, x.lesson_id, x.position from review r cross join lateral private.review_snapshot_resources(r.s) x),
  old_resources as (
    select x.id, x.title, x.lesson_id, x.position from public.published_resources x join review r on r.course_id = x.course_id
    where x.is_current and (x.lesson_id is null or exists (select 1 from public.published_lessons l where l.id = x.lesson_id and l.is_current))),
  -- Un recurso cambia de lugar si cambia su orden entre los que siguen en su misma lección o en el curso.
  common_resources as (
    select n.id, n.title,
           pg_catalog.row_number() over (partition by n.lesson_id order by n.position) as new_rank,
           pg_catalog.row_number() over (partition by n.lesson_id order by o.position) as old_rank
    from new_resources n join old_resources o on o.id = n.id and o.lesson_id is not distinct from n.lesson_id)
  select pg_catalog.jsonb_build_object(
    'course', coalesce((
      select pg_catalog.jsonb_agg(f.name order by f.n)
      from review r cross join published p
      cross join lateral (values
        (1, 'title', (r.s -> 'course' ->> 'title') is distinct from p.title),
        (2, 'summary', (r.s -> 'course' ->> 'summary') is distinct from p.summary),
        (3, 'practice', (r.s -> 'course' ->> 'practice_id')::uuid is distinct from p.practice_id),
        (4, 'level', (r.s -> 'course' ->> 'level_id')::uuid is distinct from p.level_id)) as f (n, name, changed)
      where f.changed), '[]'::jsonb),
    'modules_added', coalesce((select pg_catalog.jsonb_agg(n.title order by n.position) from new_modules n where not exists (select 1 from old_modules o where o.id = n.id)), '[]'::jsonb),
    'modules_removed', coalesce((select pg_catalog.jsonb_agg(o.title order by o.position) from old_modules o where not exists (select 1 from new_modules n where n.id = o.id)), '[]'::jsonb),
    'modules_renamed', coalesce((select pg_catalog.jsonb_agg(n.title order by n.position) from new_modules n join old_modules o on o.id = n.id where n.title is distinct from o.title), '[]'::jsonb),
    'modules_moved', coalesce((select pg_catalog.jsonb_agg(c.title order by c.position) from common_modules c where c.new_rank <> c.old_rank), '[]'::jsonb),
    'lessons_added', coalesce((select pg_catalog.jsonb_agg(n.title order by n.position) from new_lessons n where not exists (select 1 from old_lessons o where o.id = n.id)), '[]'::jsonb),
    'lessons_removed', coalesce((select pg_catalog.jsonb_agg(o.title order by o.position) from old_lessons o where not exists (select 1 from new_lessons n where n.id = o.id)), '[]'::jsonb),
    'lessons_video', coalesce((select pg_catalog.jsonb_agg(c.title order by c.position) from common c where c.video_changed), '[]'::jsonb),
    'lessons_text', coalesce((select pg_catalog.jsonb_agg(c.title order by c.position) from common c where c.text_changed), '[]'::jsonb),
    'lessons_moved', coalesce((
      select pg_catalog.jsonb_agg(c.title order by c.position) from common c
      where c.new_module <> c.old_module or exists (select 1 from stayed s where s.id = c.id and s.new_rank <> s.old_rank)), '[]'::jsonb),
    'resources_added', coalesce((select pg_catalog.jsonb_agg(n.title order by n.title) from new_resources n where not exists (select 1 from old_resources o where o.id = n.id)), '[]'::jsonb),
    'resources_removed', coalesce((select pg_catalog.jsonb_agg(o.title order by o.title) from old_resources o where not exists (select 1 from new_resources n where n.id = o.id)), '[]'::jsonb),
    'resources_renamed', coalesce((select pg_catalog.jsonb_agg(n.title order by n.title) from new_resources n join old_resources o on o.id = n.id where n.title is distinct from o.title), '[]'::jsonb),
    'resources_moved', coalesce((select pg_catalog.jsonb_agg(c.title order by c.title) from common_resources c where c.new_rank <> c.old_rank), '[]'::jsonb))
  from review
$$;
revoke all on function private.course_version_changes(uuid) from public;

-- La fila de lo enviado: lo de la cuarta solicitud, y de una versión cuál es y qué cambió.
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
      'version', c.course_version,
      'is_revision', c.is_revision,
      'changes', private.course_version_changes(c.id),
      'resources', private.review_submission_resources(c.content_snapshot -> 'resources'),
      'captions_missing', coalesce((
        select pg_catalog.jsonb_agg(x.lesson -> 'id' order by x.module_order, x.lesson_order)
        from lessons x
        where not exists (
          select 1 from public.draft_videos v
          where v.id = (x.lesson -> 'video' ->> 'id')::uuid and v.is_current and v.captions_ready)), '[]'::jsonb),
      'files_changed', coalesce((
        select pg_catalog.jsonb_agg(f.title order by f.n)
        from (
          select x.module_order * 1000 + x.lesson_order as n, x.lesson ->> 'title' as title
          from lessons x
          where not exists (
            select 1 from storage.objects o
            where o.bucket_id = 'video-originals' and o.name = x.lesson -> 'video' ->> 'storage_path'
              and o.id = (x.lesson -> 'video' ->> 'object_id')::uuid and o.version = x.lesson -> 'video' ->> 'object_version')
          union all
          select 1000000, r.title
          from private.review_snapshot_resources(c.content_snapshot) r
          where not exists (
            select 1 from storage.objects o
            where o.bucket_id = 'course-resources' and o.name = r.storage_path and o.id = r.object_id and o.version = r.object_version)) as f), '[]'::jsonb),
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
-- Aprobar: también una versión. Lo de la cuarta solicitud, con la versión en revisión.

create or replace function private.review_approve(p_course uuid, p_submission uuid, p_captions uuid[]) returns text
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
  -- El orden de enviar: la fila del maestro y la de su cuenta, las listas, el curso y el registro.
  perform 1 from public.teachers t where t.id = v_teacher for share;
  perform 1 from public.profiles p where p.id = (select t.profile_id from public.teachers t where t.id = v_teacher) for share;
  perform private.catalog_lock('practices');
  perform private.catalog_lock('levels');
  perform private.course_lock(p_course);
  select * into v_registry from public.course_registry r where r.course_id = p_course for update;
  if not private.course_reviewing(v_registry.state, v_registry.pending_version_state) then
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

create or replace function private.review_approve_assets(p_course uuid, p_submission uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_gate text := private.content_change_gate();
  v_registry public.course_registry;
  v_review public.course_reviews;
begin
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('answer', v_gate);
  end if;
  select * into v_registry from public.course_registry r where r.course_id = p_course;
  if v_registry.course_id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  select c.* into v_review from public.course_reviews c where c.course_id = p_course and c.result = 'pending';
  if not private.course_reviewing(v_registry.state, v_registry.pending_version_state) or v_review.id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_pending');
  end if;
  if v_review.id is distinct from p_submission then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  if private.actor_owns_teacher(v_registry.teacher_id) then
    return pg_catalog.jsonb_build_object('answer', 'self');
  end if;
  return pg_catalog.jsonb_build_object('answer', 'ok', 'assets', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'video', x.video -> 'id', 'lesson', x.lesson_id, 'provider', x.video -> 'provider',
             'asset', x.video -> 'provider_asset_id', 'playback', x.video -> 'provider_playback_id') order by x.lesson_position)
    from private.review_snapshot_lessons(v_review.content_snapshot) x), '[]'::jsonb));
end
$$;

-- Publicar un envío pendiente, con los candados ya tomados. Las comprobaciones, como en la cuarta solicitud. Un curso que ya tenía algo publicado (una versión) lo sustituye sin
-- borrar nada; uno nuevo se publica como antes.
create or replace function private.review_publish(p_review uuid, p_by uuid, p_captions uuid[]) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_review public.course_reviews;
  v_snapshot jsonb;
  v_name text;
  v_slug text;
  v_try text;
  v_n integer := 1;
  v_course uuid;
begin
  select * into v_review from public.course_reviews c where c.id = p_review and c.result = 'pending';
  if v_review.id is null then
    return 'unavailable';
  end if;
  v_snapshot := v_review.content_snapshot;
  v_course := v_review.course_id;
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
  perform 1 from public.draft_videos v where v.course_id = v_course for update;
  if exists (
      select 1 from private.review_snapshot_lessons(v_snapshot) x
      where x.video is null
         or not exists (
              select 1 from public.draft_videos v
              where v.id = (x.video ->> 'id')::uuid and v.course_id = v_course and v.is_current
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
  where v.course_id = v_course and v.is_current and not v.captions_ready and v.id = any(coalesce(p_captions, '{}'));
  if exists (
      select 1 from private.review_snapshot_lessons(v_snapshot) x
      join public.draft_videos v on v.id = (x.video ->> 'id')::uuid
      where not v.captions_ready) then
    return 'captions_pending';
  end if;

  -- Los videos nuevos. Los que lo publicado ya tenía no cambian.
  insert into public.video_assets
    (id, course_id, teacher_id, lesson_id, provider, provider_asset_id, provider_playback_id, status, duration_seconds, captions_ready,
     original_path, original_size_bytes, original_archived_at, file_name, mime, object_id, object_version, read_seconds, created_by)
  select (x.video ->> 'id')::uuid, v_course, v_review.teacher_id, x.lesson_id, x.video ->> 'provider', x.video ->> 'provider_asset_id',
         x.video ->> 'provider_playback_id', 'ready', (x.video ->> 'duration_seconds')::integer, true,
         x.video ->> 'storage_path', (x.video ->> 'size_bytes')::bigint, coalesce(o.created_at, now()), x.video ->> 'file_name', x.video ->> 'mime',
         (x.video ->> 'object_id')::uuid, x.video ->> 'object_version', (x.video ->> 'read_seconds')::integer, v_review.submitted_by
  from private.review_snapshot_lessons(v_snapshot) x
  join storage.objects o on o.bucket_id = 'video-originals' and o.name = x.video ->> 'storage_path'
  where not exists (select 1 from public.video_assets a where a.id = (x.video ->> 'id')::uuid);

  if not exists (select 1 from public.published_courses c where c.course_id = v_course) then
    -- La primera vez. El slug, del título; con un número si ya existe. Un candado propio, después de los del curso.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('published_courses.slug', 0));
    v_slug := coalesce(nullif(private.catalog_slug(v_snapshot -> 'course' ->> 'title'), ''), 'curso');
    v_try := v_slug;
    while exists (select 1 from public.published_courses c where c.slug = v_try) loop
      v_n := v_n + 1;
      v_try := v_slug || '-' || v_n;
    end loop;
    insert into public.published_courses
      (course_id, teacher_id, slug, title, summary, teacher_name, practice_id, level_id, lesson_count, total_duration_seconds, is_listed, published_at, course_review_id)
    select v_course, v_review.teacher_id, v_try, v_snapshot -> 'course' ->> 'title', v_snapshot -> 'course' ->> 'summary', v_name,
           (v_snapshot -> 'course' ->> 'practice_id')::uuid, (v_snapshot -> 'course' ->> 'level_id')::uuid,
           pg_catalog.count(*)::integer, pg_catalog.sum((x.video ->> 'duration_seconds')::integer)::integer, true, now(), p_review
    from private.review_snapshot_lessons(v_snapshot) x;
  else
    -- Una versión: el slug, el curso abierto, el listado y la fecha de publicación se quedan.
    update public.published_courses c
    set title = v_snapshot -> 'course' ->> 'title', summary = v_snapshot -> 'course' ->> 'summary', teacher_name = v_name,
        practice_id = (v_snapshot -> 'course' ->> 'practice_id')::uuid, level_id = (v_snapshot -> 'course' ->> 'level_id')::uuid,
        lesson_count = (select pg_catalog.count(*)::integer from private.review_snapshot_lessons(v_snapshot) x),
        total_duration_seconds = (select pg_catalog.sum((x.video ->> 'duration_seconds')::integer)::integer from private.review_snapshot_lessons(v_snapshot) x),
        course_review_id = p_review, updated_at = now()
    where c.course_id = v_course;
    -- Lo que la versión quitó queda retirado, con su id (RN-14). Lo vigente se corre hacia arriba, fuera de las posiciones nuevas: los índices son parciales y no se difieren.
    update public.published_modules m set is_current = false
    where m.course_id = v_course and m.is_current
      and not exists (select 1 from pg_catalog.jsonb_array_elements(v_snapshot -> 'modules') s where (s ->> 'id')::uuid = m.id);
    update public.published_modules m set position = m.position + 1000000 where m.course_id = v_course and m.is_current;
    update public.published_lessons l set is_current = false, retired_at = now()
    where l.course_id = v_course and l.is_current
      and not exists (select 1 from private.review_snapshot_lessons(v_snapshot) x where x.lesson_id = l.id);
    update public.published_lessons l set position = l.position + 1000000 where l.course_id = v_course and l.is_current;
    update public.published_resources r set is_current = false, retired_at = now()
    where r.course_id = v_course and r.is_current
      and not exists (select 1 from private.review_snapshot_resources(v_snapshot) x where x.id = r.id);
    update public.published_resources r set position = r.position + 1000000 where r.course_id = v_course and r.is_current;
  end if;

  insert into public.published_modules (id, course_id, title, position)
  select (m.value ->> 'id')::uuid, v_course, m.value ->> 'title', m.o::integer
  from pg_catalog.jsonb_array_elements(v_snapshot -> 'modules') with ordinality as m (value, o)
  on conflict (id) do update set title = excluded.title, position = excluded.position;

  insert into public.published_lessons
    (id, course_id, module_id, teacher_id, video_asset_id, title, description, position, duration_seconds, has_captions)
  select x.lesson_id, v_course, x.module_id, v_review.teacher_id, (x.video ->> 'id')::uuid, x.lesson_title, x.description, x.lesson_position,
         (x.video ->> 'duration_seconds')::integer, true
  from private.review_snapshot_lessons(v_snapshot) x
  on conflict (id) do update set module_id = excluded.module_id, video_asset_id = excluded.video_asset_id, title = excluded.title, description = excluded.description,
                                 position = excluded.position, duration_seconds = excluded.duration_seconds, has_captions = excluded.has_captions;

  insert into public.published_resources (id, course_id, teacher_id, lesson_id, title, kind, mime, storage_path, object_id, object_version, size_bytes, position)
  select r.id, v_course, v_review.teacher_id, r.lesson_id, r.title, r.kind::public.resource_kind, r.mime, r.storage_path, r.object_id, r.object_version,
         r.size_bytes, r.position
  from private.review_snapshot_resources(v_snapshot) r
  on conflict (id) do update set title = excluded.title, position = excluded.position;

  -- Un video que ya no usa ninguna lección vigente queda retirado: la retención borra su archivo después.
  update public.video_assets a set retired_at = now(), updated_at = now()
  where a.course_id = v_course and a.retired_at is null
    and not exists (select 1 from public.published_lessons l where l.video_asset_id = a.id and l.is_current);

  update public.course_registry set state = 'published', pending_version_state = null, first_published_at = coalesce(first_published_at, now()), updated_at = now()
  where course_id = v_course;
  update public.course_reviews set result = 'approved', reviewed_by = p_by, reviewed_at = now() where id = p_review;
  update public.published_teachers set is_listed = true where teacher_id = v_review.teacher_id and not is_listed;

  -- El borrador se va (05 §5.2). Lo que la cascada manda a la papelera lo nombra lo publicado: sale enseguida, sin tocar nada.
  delete from public.course_drafts where course_id = v_course;
  delete from private.video_trash x
  where x.course_id = v_course
    and exists (select 1 from public.video_assets a
                where a.course_id = v_course
                  and ((x.provider_asset_id is not null and a.provider_asset_id = x.provider_asset_id)
                       or (x.storage_path is not null and a.original_path = x.storage_path)));
  return 'approved';
end
$$;

-- ---------------------------------------------------------------------------------------
-- La retención de lo retirado: de quien opera, no de la aplicación.

-- Lo que ya venció: el video en su proveedor, el original en `video-originals` y el archivo de un recurso en `course-resources`. Nunca lo que una lección o un recurso vigentes, o un
-- borrador, nombran. Sin el parámetro no vence nada.
create function private.retired_files_due() returns table (kind text, id uuid, provider text, asset text, path text)
language sql stable security definer set search_path = ''
as $$
  select 'provider'::text, a.id, a.provider, a.provider_asset_id, null::text
  from public.video_assets a
  where a.retired_at <= now() - (private.parameter_value('VIDEO_RETIRADO_PROVEEDOR_DIAS'))::integer * interval '1 day'
    and a.provider_deleted_at is null and a.provider_asset_id is not null
    and not exists (select 1 from public.published_lessons l where l.video_asset_id = a.id and l.is_current)
    and not exists (select 1 from public.draft_videos v where v.provider = a.provider and v.provider_asset_id = a.provider_asset_id)
  union all
  select 'original'::text, a.id, null::text, null::text, a.original_path
  from public.video_assets a
  where a.retired_at <= now() - (private.parameter_value('ARCHIVO_RETIRADO_DIAS'))::integer * interval '1 day'
    and a.original_deleted_at is null and a.original_path is not null
    and not exists (select 1 from public.published_lessons l where l.video_asset_id = a.id and l.is_current)
    and not exists (select 1 from public.draft_videos v where v.storage_path = a.original_path)
    and not exists (select 1 from public.video_assets b where b.original_path = a.original_path and b.id <> a.id and b.retired_at is null)
  union all
  select 'resource'::text, r.id, null::text, null::text, r.storage_path
  from public.published_resources r
  where r.retired_at <= now() - (private.parameter_value('ARCHIVO_RETIRADO_DIAS'))::integer * interval '1 day'
    and r.file_deleted_at is null
    and not exists (select 1 from public.published_resources o where o.storage_path = r.storage_path and o.is_current)
    and not exists (select 1 from public.draft_resources d where d.storage_path = r.storage_path)
$$;
revoke all on function private.retired_files_due() from public;

-- Anotar lo que quien opera ya borró: toma la fila y comprueba otra vez que vence. Escribe como el sistema, solo en esa sentencia. Contesta done, not_due, invalid.
create function private.retired_file_done(p_kind text, p_id uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_kind text := pg_catalog.current_setting('app.actor_kind', true);
begin
  if p_kind is null or p_kind not in ('provider', 'original', 'resource') then
    return 'invalid';
  end if;
  if p_kind = 'resource' then
    perform 1 from public.published_resources r where r.id = p_id for update;
  else
    perform 1 from public.video_assets a where a.id = p_id for update;
  end if;
  if not exists (select 1 from private.retired_files_due() d where d.kind = p_kind and d.id = p_id) then
    return 'not_due';
  end if;
  perform pg_catalog.set_config('app.actor_kind', 'system', true);
  if p_kind = 'provider' then
    update public.video_assets set provider_deleted_at = now(), updated_at = now() where id = p_id;
  elsif p_kind = 'original' then
    update public.video_assets set original_deleted_at = now(), updated_at = now() where id = p_id;
  else
    update public.published_resources set file_deleted_at = now() where id = p_id;
  end if;
  perform pg_catalog.set_config('app.actor_kind', coalesce(v_kind, ''), true);
  return 'done';
end
$$;
revoke all on function private.retired_file_done(text, uuid) from public;

-- ---------------------------------------------------------------------------------------
-- El área `submissions` del vigilante: lo de la cuarta solicitud, y las reglas de «en revisión» nombran el ayudante.

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
           ('private.review_approve_assets(uuid, uuid)', true),
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
  -- Las reglas de acceso viven adentro de las funciones: quien recree una sin su regla se nota aquí, sin esperar a una prueba. «En revisión» lo dice `course_reviewing`, que el
  -- área `versions` revisa por lo que contesta.
  select 'submission function without its rule ' || b.rule, b.signature
  from (values
      ('private.review_queue()', 'actor_has_capability'),
      ('private.review_queue()', 'course_reviewing'),
      ('private.review_return(uuid, uuid, text, text)', 'content_change_gate'),
      ('private.review_return(uuid, uuid, text, text)', 'actor_owns_teacher'),
      ('private.review_return(uuid, uuid, text, text)', 'course_reviewing'),
      ('private.review_resource_object(uuid)', 'actor_has_capability'),
      ('private.review_resource_object(uuid)', 'course_reviewing'),
      ('private.video_preview(uuid, uuid)', 'course_reviewing'),
      ('private.video_preview(uuid, uuid)', 'actor_has_capability'),
      ('private.course_return_notes()', 'actor_teacher_id'),
      ('private.course_submit_assets(uuid)', 'current_active_teacher_id'),
      ('private.course_submit_status()', 'actor_teacher_id'),
      ('private.course_submit_licenses()', 'actor_teacher_id'),
      ('private.course_submit_annex(uuid)', 'actor_teacher_id'),
      ('private.review_approve(uuid, uuid, uuid[])', 'content_change_gate'),
      ('private.review_approve(uuid, uuid, uuid[])', 'actor_owns_teacher'),
      ('private.review_approve(uuid, uuid, uuid[])', 'course_reviewing'),
      ('private.review_approve_assets(uuid, uuid)', 'content_change_gate'),
      ('private.review_approve_assets(uuid, uuid)', 'actor_owns_teacher'),
      ('private.review_approve_assets(uuid, uuid)', 'course_reviewing'),
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

-- ---------------------------------------------------------------------------------------
-- El área `versions` del vigilante (del carril B).

create function private.schema_violations_versions()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  version_functions (signature, server, definer) as (
    values ('private.course_version_open(uuid)', true, true),
           ('private.course_version_discard(uuid, bigint)', true, true),
           ('private.course_version_drop(uuid)', false, true),
           ('private.course_version_changes(uuid)', false, true),
           ('private.system_discard_version(uuid)', false, true),
           ('private.retired_files_due()', false, true),
           ('private.retired_file_done(text, uuid)', false, true),
           ('private.course_editable(public.course_state, public.course_version_state)', false, false),
           ('private.course_reviewing(public.course_state, public.course_version_state)', false, false)),
  found as (
    select f.signature, f.server, f.definer, p.oid, p.proconfig, p.proowner, p.prosecdef
    from version_functions f
    left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(f.signature))
  select 'versions function missing', f.signature
  from found f where f.oid is null
  union all
  -- Una función de versiones que el área no conoce se agrega a la lista.
  select 'versions function not in the watchdog area', p.oid::regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname in ('private', 'public')
  where (p.proname like 'course\_version\_%' or p.proname like 'retired\_file%'
         or p.proname in ('system_discard_version', 'course_editable', 'course_reviewing'))
    and not exists (select 1 from found f where f.oid = p.oid)
  union all
  select 'versions function executable by ' || r.rolname, f.signature
  from found f cross join app_roles r
  where f.oid is not null and (not f.server or r.rolname <> 'app_service')
    and pg_catalog.has_function_privilege(r.rolname::name, f.oid, 'EXECUTE')
  union all
  select 'versions function not executable by app_service', f.signature
  from found f
  where f.oid is not null and f.server and not pg_catalog.has_function_privilege('app_service', f.oid, 'EXECUTE')
  union all
  select 'versions function not security definer', f.signature
  from found f
  where f.oid is not null and f.definer and not f.prosecdef
  union all
  select 'versions function without fixed search_path', f.signature
  from found f
  where f.oid is not null and not coalesce(f.proconfig, '{}') @> array['search_path=""']
  union all
  select 'versions function not owned by the table owner', f.signature
  from found f
  where f.oid is not null
    and f.proowner <> (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.course_registry'::regclass)
  union all
  -- Las reglas viven adentro: quien recree una sin la suya se nota aquí.
  select 'versions function without its rule ' || b.rule, b.signature
  from (values
      ('private.course_version_open(uuid)', 'current_active_teacher_id'),
      ('private.course_version_open(uuid)', 'course_review_id'),
      ('private.course_version_discard(uuid, bigint)', 'current_active_teacher_id'),
      ('private.course_version_discard(uuid, bigint)', 'draft_videos'),
      ('private.system_discard_version(uuid)', 'actor_is_system'),
      ('private.retired_files_due()', 'is_current'),
      ('private.retired_files_due()', 'draft_videos'),
      ('private.retired_files_due()', 'draft_resources'),
      ('private.retired_file_done(text, uuid)', 'retired_files_due'),
      -- Lo que hace segura la retención vive en el guardián que comparten los dos carriles: si alguien lo recrea desde una copia anterior, se nota aquí.
      ('private.guard_publication()', 'a retired row does not come back'),
      ('private.guard_publication()', 'a retired row keeps its date'),
      ('private.guard_publication()', 'a current lesson does not play a retired video'),
      ('private.guard_publication()', 'a retired video keeps its date'),
      ('private.guard_publication()', 'a video a current lesson plays is not retired'),
      ('private.guard_publication()', 'pending_version_state')
    ) as b (signature, rule)
  where pg_catalog.strpos(coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(b.signature)), ''), b.rule) = 0
  union all
  -- Los ayudantes del estado, por lo que contestan en cada combinación: uno que deje editar o revisar de más abre lo que no debe.
  select 'versions helper ' || h.name || ' answers wrong', 'private.' || h.name
  from (values ('course_editable'), ('course_reviewing')) as h (name)
  where exists (
    select 1
    from pg_catalog.unnest(pg_catalog.enum_range(null::public.course_state)) as s (state)
    cross join (select v from pg_catalog.unnest(pg_catalog.enum_range(null::public.course_version_state)) as v union all select null::public.course_version_state) as p (pending)
    where (case h.name when 'course_editable' then private.course_editable(s.state, p.pending) else private.course_reviewing(s.state, p.pending) end)
          is distinct from
          coalesce(case h.name
                     when 'course_editable' then s.state = 'draft' or (s.state = 'changes_pending' and p.pending = 'draft')
                     else s.state = 'in_review' or (s.state = 'changes_pending' and p.pending = 'in_review') end, false))
  union all
  select 'versions parameter missing', k.key
  from (values ('VIDEO_RETIRADO_PROVEEDOR_DIAS'), ('ARCHIVO_RETIRADO_DIAS')) as k (key)
  where not exists (select 1 from public.parameter_definitions d where d.key = k.key)
$$;
revoke all on function private.schema_violations_versions() from public;
