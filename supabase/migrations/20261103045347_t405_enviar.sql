-- T-405, tercera solicitud · Enviar desde el portal (RF-606, FL-34; PA-44, PA-42 y PA-50). Lo que las pantallas le preguntan a la base para enviar: las funciones de enviar ya
-- estaban desde la primera solicitud.
--
-- Por qué es así:
--   · Los assets vigentes, para preguntarle a Mux antes de firmar y fuera de la transacción: el maestro no lee `provider_asset_id` (permiso por columnas). Solo su maestro activo, con
--     el curso en borrador: es lo que enviar exige.
--   · PA-42 cuenta lo que falta con la misma lista de enviar (`course_readiness`), que ve reemplazos, pendientes y módulos vacíos; lo que el dominio contaba antes no los veía.
--   · Lo aceptado, para PA-50: la frase, la versión, la fecha y el plazo, sin el origen. El título es el de la fotografía: lo que se aceptó, aunque el curso cambie o se borre.
--   · El texto de una versión del anexo: la vigente, o una que ese maestro aceptó. El anexo no es un texto público (`/legal` no lo sirve).

create function private.course_submit_assets(p_course uuid) returns jsonb
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
  return pg_catalog.jsonb_build_object('answer', 'ok', 'assets', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('lesson', v.lesson_id, 'provider', v.provider, 'asset', v.provider_asset_id) order by v.lesson_id)
    from public.draft_videos v where v.course_id = p_course and v.is_current), '[]'::jsonb));
end
$$;
revoke all on function private.course_submit_assets(uuid) from public;
grant execute on function private.course_submit_assets(uuid) to app_service;

create function private.course_submit_status() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'course_id', r.course_id,
           'missing', case when r.state = 'draft' and exists (select 1 from public.course_drafts d where d.course_id = r.course_id)
                           then pg_catalog.jsonb_array_length(private.course_readiness(r.course_id)) end,
           'submitted_at', (select c.submitted_at from public.course_reviews c where c.course_id = r.course_id and c.result = 'pending'))
         order by r.course_id), '[]'::jsonb)
  from public.course_registry r
  where r.teacher_id = private.actor_teacher_id()
$$;
revoke all on function private.course_submit_status() from public;
grant execute on function private.course_submit_status() to app_service;

create function private.course_submit_licenses() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'course_id', l.course_id,
           'course_title', c.content_snapshot -> 'course' ->> 'title',
           'submission_no', c.submission_no,
           'accepted_at', l.accepted_at,
           'statement', l.accepted_statement,
           'term_years', l.term_years,
           'annex', pg_catalog.jsonb_build_object('id', d.id, 'version', d.version, 'title', d.title, 'effective_from', d.effective_from))
         order by l.accepted_at desc, l.id), '[]'::jsonb)
  from public.licenses l
  join public.course_reviews c on c.id = l.course_review_id
  join public.legal_documents d on d.id = l.legal_document_id
  where l.teacher_id = private.actor_teacher_id()
$$;
revoke all on function private.course_submit_licenses() from public;
grant execute on function private.course_submit_licenses() to app_service;

create function private.course_submit_annex(p_document uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('id', d.id, 'version', d.version, 'title', d.title, 'body', d.body, 'effective_from', d.effective_from)
  from public.legal_documents d
  where d.id = p_document and d.doc_type = 'license_annex' and private.actor_teacher_id() is not null
    and (d.id = (private.course_annex()).id
         or exists (select 1 from public.licenses l where l.legal_document_id = d.id and l.teacher_id = private.actor_teacher_id()))
$$;
revoke all on function private.course_submit_annex(uuid) from public;
grant execute on function private.course_submit_annex(uuid) to app_service;

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
           ('private.course_submit_annex(uuid)', true)),
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
      ('private.course_submit_annex(uuid)', 'actor_teacher_id')
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
