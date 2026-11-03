-- T-405, segunda solicitud · La salida de la revisión (RF-607, RF-701, FL-35, FL-45; esquema §5.2 y §5.8). Lo enviado por el editor entra a la cola, Contenido lo devuelve con motivo
-- y qué corregir, y su maestro lo lee. Enviar sigue sin ruta ni pantalla: la tercera solicitud la trae, y ya con cómo salir.
--
-- Por qué es así:
--   · Dos campos y no uno: RF-607 pide «motivo y qué corregir», y PA-62 los dos obligatorios. `what_to_fix` nació con esta solicitud; la tabla no tiene filas en ningún entorno.
--   · La cola lee la fotografía en un mapa cerrado: nunca salen rutas, identificadores del proveedor ni la huella, y de la licencia no sale el origen. Los cursos por guion salen como
--     antes, con la misma forma, y lo enviado suma lo suyo. Lo que se revisa es lo que se envió: del borrador no se lee nada. El borrador no cambia mientras se revisa
--     (`draft_open` contesta `not_editable`), así que la lección que la fotografía nombra es la que `video_preview` firma. Un video vigente siempre está listo
--     (`draft_videos_current_is_ready`): de cada lección solo se dice si es de Mux.
--   · Devolver lleva el envío que se vio: un formulario que llega tarde, con el curso ya devuelto y reenviado, contesta `changed` y no devuelve lo que nadie vio. Candados: el del curso
--     y la fila del registro, el mismo orden de enviar. No toma las listas: sacar un curso de revisión solo baja lo que «en uso» cuenta. El guardián de lo publicado ya lo deja:
--     pasa por la puerta de Contenido, sin ningún paso nuevo.
--   · Nadie devuelve lo suyo, con `actor_owns_teacher`: cuenta también a quien tiene una invitación de ese maestro a su correo.
--   · El maestro lee solo el motivo y qué corregir de su último envío, si fue rechazado y el curso sigue en borrador, sin saber quién lo devolvió.
--   · Contenido baja un recurso y ve un video solo de lo que está en revisión: un borrador solo lo ve su maestro (PA-42), y T-403 dejó a Contenido ver cualquiera porque todavía no había
--     envíos. El recurso compara el objeto y su versión, como las otras dos puertas. Mirar no pide un código reciente, como reproducir.

alter table public.course_reviews add column what_to_fix text;
comment on column public.course_reviews.what_to_fix is 'Qué corregir: obligatorio al rechazar, junto con el motivo (RF-607).';
alter table public.course_reviews
  add constraint course_reviews_rejection_has_fix check (result <> 'rejected' or private.draft_text_ok(what_to_fix, 2000, true)),
  add constraint course_reviews_reason_only_if_rejected check (result = 'rejected' or (reason is null and what_to_fix is null));

-- El guardián del envío: lo de la primera solicitud, con la columna nueva entre lo que se decide.
create or replace function private.guard_course_review() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '%.%: a submission is evidence and is not deleted', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  if old.result <> 'pending' or new.result = 'pending'
     or (pg_catalog.to_jsonb(new) - array['result', 'reviewed_by', 'reviewed_at', 'reason', 'what_to_fix'])
        is distinct from (pg_catalog.to_jsonb(old) - array['result', 'reviewed_by', 'reviewed_at', 'reason', 'what_to_fix']) then
    raise exception '%.%: a submission only changes once, from pending to decided', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Lo que la cola dice de un envío: un mapa cerrado de su fotografía y de su licencia.

create function private.review_submission_resources(p_resources jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', x.r -> 'id', 'title', x.r -> 'title', 'kind', x.r -> 'kind', 'size_bytes', x.r -> 'size_bytes') order by x.o), '[]'::jsonb)
  from pg_catalog.jsonb_array_elements(p_resources) with ordinality as x (r, o)
$$;
revoke all on function private.review_submission_resources(jsonb) from public;

create function private.review_submission_row(p_review uuid) returns jsonb
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
revoke all on function private.review_submission_row(uuid) from public;

-- La cola: los cursos por guion, sin cambio, y lo enviado. El más antiguo primero.
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
        join public.course_registry r on r.course_id = c.course_id and r.state = 'in_review'
        where c.result = 'pending') as q), '[]'::jsonb));
end
$$;

-- Devolver al maestro. Lleva el envío que se vio. Contesta: returned, forbidden, needs_fresh_code, not_found, not_pending, changed, self, invalid. No escribe antes de rechazar.
create function private.review_return(p_course uuid, p_submission uuid, p_reason text, p_what_to_fix text) returns text
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
  if v_registry.state <> 'in_review' then
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
  update public.course_registry set state = 'draft', updated_at = now() where course_id = p_course;
  return 'returned';
end
$$;
revoke all on function private.review_return(uuid, uuid, text, text) from public;
grant execute on function private.review_return(uuid, uuid, text, text) to app_service;

-- Lo que el maestro lee: de cada curso suyo en borrador cuyo último envío se rechazó, el motivo y qué corregir. También suspendido.
create function private.course_return_notes() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'course_id', x.course_id, 'reason', x.reason, 'what_to_fix', x.what_to_fix, 'returned_at', x.reviewed_at) order by x.course_id), '[]'::jsonb)
  from (
    select distinct on (c.course_id) c.course_id, c.result, c.reason, c.what_to_fix, c.reviewed_at
    from public.course_reviews c
    join public.course_registry r on r.course_id = c.course_id and r.state = 'draft'
    where c.teacher_id = private.actor_teacher_id()
    order by c.course_id, c.submission_no desc) as x
  where x.result = 'rejected'
$$;
revoke all on function private.course_return_notes() from public;
grant execute on function private.course_return_notes() to app_service;

-- Un recurso de lo que está en revisión, para Contenido. Nulo si no.
create function private.review_resource_object(p_resource uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('path', x.storage_path, 'mime', x.mime, 'title', x.title)
  from public.draft_resources x
  join public.course_registry r on r.course_id = x.course_id and r.state = 'in_review'
  join storage.objects o on o.bucket_id = 'course-resources' and o.name = x.storage_path
                        and o.id = x.object_id and o.version = x.object_version
  where x.id = p_resource and x.state = 'ready' and private.actor_has_capability('content'::public.capability)
$$;
revoke all on function private.review_resource_object(uuid) from public;
grant execute on function private.review_resource_object(uuid) to app_service;

-- La vista previa de un video del borrador: su maestro, también suspendido, y Contenido solo con el curso en revisión.
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
      and exists (select 1 from public.course_registry r where r.course_id = p_course and r.state = 'in_review')) then
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
           ('private.review_submission_resources(jsonb)', false)),
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
  where f.oid is not null and (f.server or f.signature = 'private.review_submission_row(uuid)') and not f.prosecdef
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
