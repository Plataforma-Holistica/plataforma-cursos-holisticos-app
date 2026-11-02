-- T-405, primera solicitud · La firma en la base (RF-606, FL-34, RN-16). Esquema §5.2, §5.8 y §11.1. Sin ruta ni pantalla: nadie de la aplicación llama a estas funciones
-- todavía (lo comprueba tests/architecture/submit.test.ts), y firmar no se ofrece antes de que exista cómo salir (segunda solicitud).
--
-- Decisiones de Sergio del 2026-11-02 (plan aprobado ese día): T-405 y lo central de T-406 van en una sola cadena de cinco solicitudes; al borrar un curso rechazado que ya se
-- firmó se va el curso y se quedan su envío y su licencia como prueba; el maestro no cancela su envío; unos subtítulos sin terminar no impiden enviar; se acepta con casilla y botón,
-- guardando desde ahora todo el origen, y el anexo real no se publica sin la respuesta del abogado.
--
-- Decisiones mías, en el plan, sin confirmar: la aceptación nombra el curso (LFDA artículo 34: el anexo solo es un texto general); el origen es obligatorio fuera de local, y se
-- guardan también la sesión y su nivel, porque agregar un dato después obligaría a pedir otra vez la aceptación; nadie de la aplicación lee ni escribe las dos tablas de frente (la
-- fotografía lleva rutas y assets, y Contenido no lee la dirección); la fotografía lleva recursos (manda el 07, que responde a la ley, sobre el 05).
--
-- Por qué es así:
--   · `course_id` no tiene clave foránea al registro: la prueba sobrevive a borrar el curso. `teacher_id` y las personas sí la tienen.
--   · Una sola lista de lo que falta (`course_readiness`), para PA-42, PA-44 y enviar. Cuenta lo que no está listo aunque haya una vigente: RF-606 no deja enviar con algo
--     procesando o con error, también un reemplazo. Y un reemplazo ya listo sin promover: lo que se envía es lo que se ve.
--   · La huella es de la forma canónica de la fotografía sin `captions_ready`. Unos subtítulos que terminan después no piden firmar otra vez. `content_revision` no sirve como «lo que
--     se vio»: promover un video no la sube.
--   · Los candados: la fila del maestro, las dos listas (las mismas de desactivar), el curso, y la fila del registro `for update`. Lo que se lee, se lee después, en otra sentencia:
--     `video_settle` y `video_promote` no toman el candado del curso, pero promover pide la fila del registro `for share`. Si promover va primero, enviar espera y ve su resultado (y
--     contesta `changed`); si enviar va primero, promover ya no encuentra el curso en borrador.
--   · La versión 0 del anexo solo vale con la marca `legal_drafts`, que escribe `db:drafts`. La regla vive en la base.
--   · El guardián de lo publicado suma un paso: de borrador a revisión, sin otro cambio, con su envío y su licencia ya insertados. Lo demás sigue igual.
--   · El maestro nunca recibe la fotografía: solo su huella, para mandarla de vuelta.

create type public.review_result as enum ('pending', 'approved', 'rejected');

create table public.course_reviews (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null,                         -- sin clave foránea: la prueba sobrevive a borrar el curso
  teacher_id uuid not null references public.teachers (id),
  submission_no integer not null,
  is_revision boolean not null,                    -- falso: primer envío. Verdadero: versión de un curso publicado
  course_version integer not null,                 -- `course_drafts.version` al enviar
  content_snapshot jsonb not null,                 -- lo que se envió, con rutas y assets. El maestro no lo lee
  content_sha256 bytea not null,                   -- de la fotografía sin `captions_ready`
  submitted_by uuid not null references public.profiles (id),
  submitted_at timestamptz not null default now(),
  result public.review_result not null default 'pending',
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  reason text,                                     -- obligatorio al rechazar (RF-607)
  constraint course_reviews_submission_uq unique (course_id, submission_no),
  constraint course_reviews_submission_positive check (submission_no >= 1),
  constraint course_reviews_version_positive check (course_version >= 1),
  constraint course_reviews_hash_length check (octet_length(content_sha256) = 32),
  constraint course_reviews_result_consistent check (
    (result = 'pending') = (reviewed_at is null) and (result = 'pending') = (reviewed_by is null)),
  constraint course_reviews_rejection_has_reason check (result <> 'rejected' or reason is not null)
);
comment on table public.course_reviews is 'Cada envío a revisión: la fotografía de lo que se envió, su huella y el resultado (RF-606, RF-607, T-405). Solo se inserta, y solo cambia una vez, de pendiente a decidido. Nadie de la aplicación la lee de frente.';
-- Un curso no puede tener dos envíos pendientes a la vez.
create unique index course_reviews_one_pending_uq on public.course_reviews (course_id) where result = 'pending';
-- Cola de revisión por antigüedad (PA-61).
create index course_reviews_queue_idx on public.course_reviews (submitted_at) where result = 'pending';
create index course_reviews_teacher_idx on public.course_reviews (teacher_id);
create index course_reviews_submitted_by_idx on public.course_reviews (submitted_by);
create index course_reviews_reviewed_by_idx on public.course_reviews (reviewed_by);

create table public.licenses (
  id uuid primary key default gen_random_uuid(),
  course_review_id uuid not null unique references public.course_reviews (id),
  course_id uuid not null,                         -- sin clave foránea: la prueba sobrevive a borrar el curso
  teacher_id uuid not null references public.teachers (id),
  legal_document_id uuid not null references public.legal_documents (id),   -- la versión del anexo
  term_years integer not null,                     -- LICENCIA_ANIOS al aceptar: es contractual, y no cambia si cambia el parámetro
  accepted_statement text not null,                -- la frase aceptada: nombra el curso (LFDA artículo 34)
  accepted_statement_sha256 bytea not null,
  accepted_by uuid not null references public.profiles (id),
  accepted_at timestamptz not null default now(),
  ip inet,                                         -- se vacía al eliminar la cuenta (T-311); si sobrevive lo dice el abogado
  user_agent text,                                 -- ídem
  session_id uuid,
  aal text,
  constraint licenses_term_positive check (term_years >= 1),
  constraint licenses_statement_not_blank check (btrim(accepted_statement) <> ''),
  constraint licenses_statement_hash_length check (octet_length(accepted_statement_sha256) = 32)
);
comment on table public.licenses is 'El anexo de licencia aceptado en cada envío (RF-606, RF-608, ADR-05, LF-24, LF-28): versión del texto, frase aceptada, fecha y origen. Un libro: solo se vacía el origen. Nadie de la aplicación la lee de frente.';
create index licenses_course_idx on public.licenses (course_id, accepted_at desc);
create index licenses_teacher_idx on public.licenses (teacher_id);
create index licenses_document_idx on public.licenses (legal_document_id);
create index licenses_accepted_by_idx on public.licenses (accepted_by);

alter table public.course_reviews enable row level security;
alter table public.licenses enable row level security;
revoke all on public.course_reviews, public.licenses from public, anon, authenticated, service_role, app_service;

-- El guardián del envío: solo cambia una vez, de pendiente a decidido, y solo lo que decide. Las reglas de quién decide viven en las funciones.
create function private.guard_course_review() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '%.%: a submission is evidence and is not deleted', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  if old.result <> 'pending' or new.result = 'pending'
     or (pg_catalog.to_jsonb(new) - array['result', 'reviewed_by', 'reviewed_at', 'reason'])
        is distinct from (pg_catalog.to_jsonb(old) - array['result', 'reviewed_by', 'reviewed_at', 'reason']) then
    raise exception '%.%: a submission only changes once, from pending to decided', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function private.guard_course_review() from public;

create trigger course_reviews_guard before update or delete on public.course_reviews
  for each row execute function private.guard_course_review();
create trigger ledger_no_truncate before truncate on public.course_reviews
  for each statement execute function private.reject_mutation();
create trigger licenses_guard before update or delete on public.licenses
  for each row execute function private.allow_only_redaction('ip', 'user_agent');
create trigger ledger_no_truncate before truncate on public.licenses
  for each statement execute function private.reject_mutation();
create trigger audit_changes after insert or update on public.course_reviews
  for each row execute function private.audit_row_change('content', 'content_snapshot');
create trigger audit_changes after insert or update on public.licenses
  for each row execute function private.audit_row_change('content', 'ip', 'user_agent', 'session_id', 'aal');

-- ---------------------------------------------------------------------------------------
-- Lo que comparten las funciones.

-- El anexo vigente que se puede firmar: uno publicado, o el borrador solo en una base local.
create function private.course_annex() returns public.legal_documents
language sql stable security definer set search_path = ''
as $$
  select d.* from public.legal_documents d
  where d.id = private.current_legal_document('license_annex')
    and (d.version >= 1 or exists (select 1 from private.local_flags f where f.flag = 'legal_drafts'))
$$;
revoke all on function private.course_annex() from public;

-- Lo que le falta a un curso para enviarse. Lista vacía: está listo. Cada línea dice qué y dónde, para enlazar al lugar exacto de PA-43.
create function private.course_readiness(p_course uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(x.line order by x.rank, x.pos1, x.pos2), '[]'::jsonb)
  from (
    select 1 as rank, 0 as pos1, 0 as pos2, pg_catalog.jsonb_build_object('what', 'summary') as line
    from public.course_drafts d where d.course_id = p_course and d.summary is null
    union all
    select 2, 0, 0, pg_catalog.jsonb_build_object('what', 'practice')
    from public.course_drafts d
    where d.course_id = p_course
      and not exists (select 1 from public.practices p where p.id = d.practice_id and p.is_active)
    union all
    select 3, 0, 0, pg_catalog.jsonb_build_object('what', 'level')
    from public.course_drafts d
    where d.course_id = p_course
      and not exists (select 1 from public.levels l where l.id = d.level_id and l.is_active)
    union all
    select 4, 0, 0, pg_catalog.jsonb_build_object('what', 'modules')
    from public.course_drafts d
    where d.course_id = p_course and not exists (select 1 from public.draft_modules m where m.course_id = p_course)
    union all
    select 5, m.position, 0, pg_catalog.jsonb_build_object('what', 'module_empty', 'module', m.id, 'title', m.title)
    from public.draft_modules m
    where m.course_id = p_course and not exists (select 1 from public.draft_lessons l where l.module_id = m.id)
    union all
    -- Una lección: sin vigente, o con otra fila además (en camino, con error, o lista sin promover).
    select 6, m.position, l.position,
           pg_catalog.jsonb_build_object(
             'what', case when o.state = 'errored' then 'video_errored'
                          when o.id is not null then 'video_in_progress'
                          else 'lesson_no_video' end,
             'module', m.id, 'lesson', l.id, 'title', l.title,
             'replacement', c.id is not null)
    from public.draft_lessons l
    join public.draft_modules m on m.id = l.module_id
    left join public.draft_videos c on c.lesson_id = l.id and c.is_current
    left join public.draft_videos o on o.lesson_id = l.id and not o.is_current
    where l.course_id = p_course and (c.id is null or o.id is not null)
    union all
    select 7, 0, 0, pg_catalog.jsonb_build_object('what', 'resource_pending', 'resource', r.id, 'lesson', r.lesson_id, 'title', r.title)
    from public.draft_resources r
    where r.course_id = p_course and r.state = 'pending'
  ) as x
$$;
revoke all on function private.course_readiness(uuid) from public;

-- Los recursos de un lugar en la fotografía: de una lección, o del curso con lección nula. Solo los listos: un pendiente impide enviar.
create function private.course_snapshot_resources(p_course uuid, p_lesson uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', r.id, 'title', r.title, 'kind', r.kind, 'mime', r.mime, 'size_bytes', r.size_bytes, 'position', r.position,
           'storage_path', r.storage_path, 'object_id', r.object_id, 'object_version', r.object_version)
         order by r.position), '[]'::jsonb)
  from public.draft_resources r
  where r.course_id = p_course and r.lesson_id is not distinct from p_lesson and r.state = 'ready'
$$;
revoke all on function private.course_snapshot_resources(uuid, uuid) from public;

-- La fotografía, en su forma canónica. `format` dice cómo leerla el día que cambie. Nada que cambie sin que cambie el curso: ni revisiones ni fechas.
create function private.course_snapshot(p_course uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'format', 1,
    'course', pg_catalog.jsonb_build_object(
      'id', d.course_id, 'teacher_id', d.teacher_id, 'version', d.version, 'title', d.title, 'summary', d.summary,
      'practice_id', d.practice_id, 'level_id', d.level_id),
    'resources', private.course_snapshot_resources(p_course, null),
    'modules', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', m.id, 'title', m.title, 'position', m.position,
               'lessons', coalesce((
                 select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                          'id', l.id, 'title', l.title, 'description', l.description, 'position', l.position,
                          'video', (select pg_catalog.jsonb_build_object(
                                             'id', v.id, 'provider', v.provider, 'provider_asset_id', v.provider_asset_id,
                                             'provider_playback_id', v.provider_playback_id, 'duration_seconds', v.duration_seconds,
                                             'storage_path', v.storage_path, 'object_id', v.object_id, 'object_version', v.object_version,
                                             'file_name', v.file_name, 'mime', v.mime, 'size_bytes', v.size_bytes, 'read_seconds', v.read_seconds)
                                    from public.draft_videos v where v.lesson_id = l.id and v.is_current),
                          'resources', private.course_snapshot_resources(p_course, l.id))
                        order by l.position)
                 from public.draft_lessons l where l.module_id = m.id), '[]'::jsonb))
             order by m.position)
      from public.draft_modules m where m.course_id = p_course), '[]'::jsonb),
    -- Fuera de la huella: terminan aparte.
    'captions_ready', coalesce((
      select pg_catalog.jsonb_agg(v.id order by v.id) from public.draft_videos v
      where v.course_id = p_course and v.is_current and v.captions_ready), '[]'::jsonb))
  from public.course_drafts d where d.course_id = p_course
$$;
revoke all on function private.course_snapshot(uuid) from public;

create function private.course_snapshot_hash(p_snapshot jsonb) returns bytea
language sql immutable set search_path = ''
as $$
  select pg_catalog.sha256(pg_catalog.convert_to((p_snapshot - 'captions_ready')::text, 'UTF8'))
$$;
revoke all on function private.course_snapshot_hash(jsonb) from public;

-- La frase que se acepta, con el curso identificado. El abogado puede cambiarla: lo aceptado queda en cada licencia.
create function private.course_statement(p_annex_version integer, p_title text, p_version integer, p_term integer) returns text
language sql immutable set search_path = ''
as $$
  select pg_catalog.format('Acepto el anexo de licencia, versión %s, para el curso «%s», versión %s, por %s años.', p_annex_version, p_title, p_version, p_term)
$$;
revoke all on function private.course_statement(integer, text, integer, integer) from public;

-- ---------------------------------------------------------------------------------------
-- Las funciones del servidor. Ninguna recibe quién actúa: es el maestro activo de private.actor_id(). Ninguna escribe antes de rechazar. Contestan {answer}:
--   ready, submitted, changed, not_ready, annex_missing, unavailable, origin_missing, invalid, not_found, not_editable, suspended, not_teacher

-- Lo que el maestro ve antes de firmar. Sin fotografía: su huella, para mandarla de vuelta.
create function private.course_submit_preview(p_course uuid) returns jsonb
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
  if (select r.first_published_at from public.course_registry r where r.course_id = p_course) is not null then
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
    'content_sha256', pg_catalog.encode(private.course_snapshot_hash(private.course_snapshot(p_course)), 'hex'));
end
$$;

-- Enviar: lleva lo que se vio. Con lo mismo, un doble envío contesta `submitted` sin firmar otra vez. Quien llama da la dirección y el navegador; la sesión y su nivel los lee la base.
create function private.course_submit(p_course uuid, p_annex uuid, p_seen_hash text, p_term integer, p_ip inet, p_user_agent text) returns jsonb
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
  v_review uuid;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  if p_course is null or p_annex is null or p_seen_hash is null or p_term is null then
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
  if v_registry.state <> 'draft' or v_registry.first_published_at is not null then
    if exists (
        select 1 from public.course_reviews c
        join public.licenses l on l.course_review_id = c.id
        where c.course_id = p_course and c.result = 'pending' and pg_catalog.encode(c.content_sha256, 'hex') = p_seen_hash
          and l.legal_document_id = p_annex and l.term_years = p_term) then
      return pg_catalog.jsonb_build_object('answer', 'submitted');
    end if;
    return pg_catalog.jsonb_build_object('answer', 'not_editable');
  end if;
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
  if v_annex.id <> p_annex or v_term <> p_term or pg_catalog.encode(v_hash, 'hex') <> p_seen_hash then
    return pg_catalog.jsonb_build_object('answer', 'changed');
  end if;
  if p_ip is null and not exists (select 1 from private.local_flags f where f.flag = 'legal_drafts') then
    return pg_catalog.jsonb_build_object('answer', 'origin_missing');
  end if;
  v_statement := private.course_statement(v_annex.version, v_draft.title, v_draft.version, v_term);
  insert into public.course_reviews (course_id, teacher_id, submission_no, is_revision, course_version, content_snapshot, content_sha256, submitted_by)
  values (p_course, v_teacher,
          coalesce((select pg_catalog.max(c.submission_no) from public.course_reviews c where c.course_id = p_course), 0) + 1,
          false, v_draft.version, v_snapshot, v_hash, v_actor)
  returning id into v_review;
  insert into public.licenses (course_review_id, course_id, teacher_id, legal_document_id, term_years, accepted_statement, accepted_statement_sha256,
                               accepted_by, ip, user_agent, session_id, aal)
  values (v_review, p_course, v_teacher, v_annex.id, v_term, v_statement, pg_catalog.sha256(pg_catalog.convert_to(v_statement, 'UTF8')),
          v_actor, p_ip, pg_catalog.left(p_user_agent, 500), v_session,
          (select s.aal::text from auth.sessions s where s.id = v_session));
  update public.course_registry set state = 'in_review', updated_at = now() where course_id = p_course;
  return pg_catalog.jsonb_build_object('answer', 'submitted');
end
$$;

revoke all on function private.course_submit_preview(uuid) from public;
revoke all on function private.course_submit(uuid, uuid, text, integer, inet, text) from public;
grant execute on function private.course_submit_preview(uuid) to app_service;
grant execute on function private.course_submit(uuid, uuid, text, integer, inet, text) to app_service;

-- ---------------------------------------------------------------------------------------
-- Borrar un curso rechazado se lleva el curso, y su envío y su licencia se quedan: no tienen clave foránea al registro. Lo que se publicó alguna vez contesta `not_editable`, antes
-- de que el guardián lo rechace.

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
  delete from public.course_registry where course_id = p_course and teacher_id = v_teacher;
  return pg_catalog.jsonb_build_object('answer', 'deleted');
end
$$;

-- ---------------------------------------------------------------------------------------
-- «En uso» cuenta lo que está en revisión: lo enviado por el editor todavía no tiene fila en `published_courses`. El borrador sigue sin contar (decisión de Sergio del 2026-10-29).
-- Sin carrera con enviar: los dos toman los candados de las listas.

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
    where r.state = 'in_review'
      and case p_list when 'practices' then d.practice_id = p_id else d.level_id = p_id end
  ) as u
$$;

-- ---------------------------------------------------------------------------------------
-- El guardián de lo publicado: lo de T-401, más un paso. El maestro activo pasa su curso de borrador a revisión, sin otro cambio y con su envío y su licencia ya insertados.
-- La función la comparten los dos carriles: el paso nuevo no cambia ninguno de los anteriores.

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
-- El área `submissions` del vigilante (carril B).

create function private.schema_violations_submissions()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  evidence_tables (table_name, name) as (
    values ('public.course_reviews', 'course_reviews'), ('public.licenses', 'licenses')),
  submission_functions (signature, server) as (
    values ('private.course_submit_preview(uuid)', true),
           ('private.course_submit(uuid, uuid, text, integer, inet, text)', true),
           ('private.course_annex()', false),
           ('private.course_readiness(uuid)', false),
           ('private.course_snapshot(uuid)', false),
           ('private.course_snapshot_resources(uuid, uuid)', false),
           ('private.course_snapshot_hash(jsonb)', false),
           ('private.course_statement(integer, text, integer, integer)', false),
           ('private.guard_course_review()', false)),
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
  -- Sus disparadores, con su función y prendidos. El tipo es la suma de fila (1), antes (2), insertar (4), borrar (8), cambiar (16) y vaciar (32).
  select 'evidence table without trigger ' || g.name, g.table_name
  from (values
      ('public.course_reviews', 'course_reviews_guard', 'private.guard_course_review()', 27),
      ('public.course_reviews', 'ledger_no_truncate', 'private.reject_mutation()', 34),
      ('public.course_reviews', 'audit_changes', 'private.audit_row_change()', 21),
      ('public.licenses', 'licenses_guard', 'private.allow_only_redaction()', 27),
      ('public.licenses', 'ledger_no_truncate', 'private.reject_mutation()', 34),
      ('public.licenses', 'audit_changes', 'private.audit_row_change()', 21)
    ) as g (table_name, name, func, kind)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = g.table_name::regclass and tg.tgname = g.name
      and tg.tgfoid = g.func::regprocedure and tg.tgtype = g.kind and tg.tgenabled in ('O', 'A'))
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
      ('public.course_reviews', 'course_reviews_rejection_has_reason', 'CHECK (((result <> ''rejected''::public.review_result) OR (reason IS NOT NULL)))'),
      ('public.course_reviews', 'course_reviews_submission_uq', 'UNIQUE (course_id, submission_no)'),
      ('public.licenses', 'licenses_course_review_id_key', 'UNIQUE (course_review_id)'),
      ('public.licenses', 'licenses_statement_hash_length', 'CHECK ((octet_length(accepted_statement_sha256) = 32))')
    ) as c (table_name, name, definition)
  where not exists (
    select 1 from pg_catalog.pg_constraint k
    where k.conrelid = c.table_name::regclass and k.conname = c.name and k.convalidated
      and pg_catalog.pg_get_constraintdef(k.oid) = c.definition)
  union all
  select 'evidence index missing', 'public.course_reviews_one_pending_uq'
  where not exists (
    select 1 from pg_catalog.pg_indexes i
    where i.schemaname = 'public' and i.indexname = 'course_reviews_one_pending_uq' and i.indexdef like 'CREATE UNIQUE INDEX%')
  union all
  select 'submission function missing', f.signature
  from found f where f.oid is null
  union all
  -- Una función de enviar que el área no conoce se agrega a la lista: si no, nadie revisaría a quién se le concede.
  select 'submission function not in the watchdog area', p.oid::regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname in ('private', 'public')
  where (p.proname like 'course\_submit%' or p.proname like 'course\_snapshot%' or p.proname in ('course_annex', 'course_readiness', 'course_statement', 'guard_course_review'))
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
  where f.oid is not null and f.server and not f.prosecdef
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
revoke all on function private.schema_violations_submissions() from public;
