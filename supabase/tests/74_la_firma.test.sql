-- T-405, primera solicitud · La firma en la base (RF-606, FL-34, RN-16). Antes de enviar se comprueba una sola lista (`course_readiness`), y lo que se envía queda como una
-- fotografía con su huella, junto con la aceptación del anexo: qué versión del texto, cuándo y desde dónde. Un rechazo no borra la prueba, y sin envío y licencia el registro no
-- pasa a revisión. Todavía nadie puede llegar a enviar desde la aplicación: lo comprueba `tests/architecture/submit.test.ts`. Pasa con los borradores legales cargados y sin ellos.
begin;
\ir _ayuda.psql
select plan(140);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a7400000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.m(p_n integer) returns uuid language sql immutable
as $$ select ('a7400000-0000-0000-0001-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.maestro(p_n integer) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  insert into public.teachers (id, profile_id, status) values (pruebas.m(p_n), pruebas.p(p_n), 'active');
  if private.current_legal_document('teacher_privacy_notice') is null then
    insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now());
  end if;
  perform pruebas.limpiar();
  perform set_config('app.actor_id', pruebas.p(p_n)::text, true);
  insert into public.consents (profile_id, legal_document_id, origin)
  values (pruebas.p(p_n), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
  perform pruebas.limpiar();
end
$$;
create table pruebas.ids (k text primary key, v uuid not null);
create function pruebas.id(p_k text) returns uuid language sql stable
as $$ select v from pruebas.ids where k = p_k $$;
create function pruebas.rj(p_id uuid, p_call text) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_id);
  execute 'select ' || p_call into v;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.r(p_id uuid, p_call text, p_k text default null) returns text
language plpgsql as $$
declare
  v jsonb := pruebas.rj(p_id, p_call);
begin
  if p_k is not null and coalesce(v ->> 'course', v ->> 'module', v ->> 'lesson') is not null then
    insert into pruebas.ids values (p_k, coalesce(v ->> 'course', v ->> 'module', v ->> 'lesson')::uuid)
    on conflict (k) do update set v = excluded.v;
  end if;
  return v ->> 'answer';
end
$$;
-- La vista previa, de quien se diga.
create function pruebas.vista(p_id uuid, p_course text default 'curso') returns jsonb
language sql as $$ select pruebas.rj(p_id, format('private.course_submit_preview(%L)', pruebas.id(p_course))) $$;
-- Lo que falta, ordenado, sin repetir.
create function pruebas.falta(p_course text default 'curso') returns text[]
language sql as $$
  select coalesce(array_agg(distinct x ->> 'what' order by x ->> 'what'), '{}')
  from jsonb_array_elements(pruebas.vista(pruebas.p(1), p_course) -> 'missing') x
$$;
-- Enviar con lo que dio la vista previa, cambiando lo que se diga.
create function pruebas.enviar(p_course text default 'curso', p_annex uuid default null, p_hash text default null, p_term integer default null,
                               p_ip inet default '203.0.113.7', p_ua text default 'Navegador de prueba', p_id uuid default null, p_submission integer default null) returns jsonb
language plpgsql as $$
declare
  v jsonb := pruebas.vista(pruebas.p(1), p_course);
begin
  return pruebas.rj(coalesce(p_id, pruebas.p(1)), format('private.course_submit(%L, %L, %L, %s, %s, %L, %L)', pruebas.id(p_course),
    coalesce(p_annex, (v -> 'annex' ->> 'id')::uuid, gen_random_uuid()), coalesce(p_hash, v ->> 'content_sha256', 'ab'), coalesce(p_term, (v ->> 'term_years')::integer, 10),
    coalesce(p_submission, (v ->> 'submission_no')::integer, 1), p_ip, p_ua));
end
$$;
-- Una fila de video o de recurso, como las dejan las funciones de T-403 y T-404.
create function pruebas.video(p_lesson text, p_state public.draft_video_state, p_current boolean, p_course text default 'curso') returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  perform pruebas.como_dueno();
  insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                   provider, provider_asset_id, provider_playback_id, duration_seconds)
  values (v_id, pruebas.id(p_course), pruebas.m(1), pruebas.id(p_lesson), p_state, p_current, 'clase.mp4', 'video/mp4', 'ruta/' || v_id, 1000,
          case when p_state <> 'uploading' then gen_random_uuid() end, case when p_state <> 'uploading' then 'v1' end, case when p_state <> 'uploading' then 600 end,
          'mux', case when p_state in ('processing', 'ready') then 'asset-' || v_id end, case when p_state = 'ready' then 'play-' || v_id end, case when p_state = 'ready' then 600 end);
  return v_id;
end
$$;
create function pruebas.quitar_video(p_id uuid) returns void
language sql as $$ select pruebas.como_dueno(); delete from public.draft_videos where id = p_id; $$;
-- Lo que falta con un video en ese estado en la segunda lección, y sin dejarlo.
create function pruebas.falta_con(p_state public.draft_video_state) returns text[]
language plpgsql as $$
declare
  v_id uuid := pruebas.video('l2', p_state, false);
  v text[] := pruebas.falta();
begin
  perform pruebas.quitar_video(v_id);
  return v;
end
$$;
create function pruebas.vigila() returns text[]
language sql as $$
  select coalesce(array_agg(v.problem order by v.problem), '{}') from private.schema_violations_submissions() v
$$;
create function pruebas.parametro_cancelado(p_key text, p_canceled boolean) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno();
  alter table public.business_parameters disable trigger user;
  update public.business_parameters set canceled_at = case when p_canceled then now() end where key = p_key;
  alter table public.business_parameters enable trigger user;
end
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;
grant select on pruebas.ids to anon, authenticated, app_service;
grant insert, update on pruebas.ids to anon, authenticated, app_service;

select pruebas.alta(pruebas.p(n), 'firma-' || n || '@prueba.test'), pruebas.confirmar(pruebas.p(n)) from generate_series(1, 4) n;
select pruebas.maestro(n) from generate_series(1, 2) n;
select pruebas.como_dueno_sistema();
insert into public.practices (id, slug, name, position, cover_tone) values ('a7400000-0000-0000-0002-000000000001', 'firma-practica', 'Firma práctica', 901, 1);
insert into public.levels (id, slug, name, position) values ('a7400000-0000-0000-0002-000000000002', 'firma-nivel', 'Firma nivel', 901);
select pruebas.como_dueno();

select pruebas.r(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), 'Respirar'), 'curso');
select pruebas.r(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), 'Vacío'), 'vacio');
select pruebas.r(pruebas.p(2), format('private.draft_create(%L, %L)', gen_random_uuid(), 'De otro'), 'ajeno');

-- ---------------------------------------------------------------------------------------
-- Una sola lista de lo que falta.

select is(pruebas.vista(pruebas.p(1), 'vacio') ->> 'answer', 'not_ready', 'un curso recién creado no se envía');
select is(pruebas.falta('vacio'), array['level', 'modules', 'practice', 'summary'], 'dice que le faltan resumen, práctica, nivel y módulos');

select pruebas.r(pruebas.p(1), format('private.draft_save_course(%L, 1, %L, %L, %L, %L)', pruebas.id('curso'), 'Respirar', 'Un curso para respirar.',
       'a7400000-0000-0000-0002-000000000001', 'a7400000-0000-0000-0002-000000000002'));
select pruebas.r(pruebas.p(1), format('private.draft_add_module(%L, 1, %L)', pruebas.id('curso'), 'Inicio'), 'modulo');
select is(pruebas.falta(), array['module_empty'], 'un módulo sin lecciones se señala');
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, 1, %L)', pruebas.id('curso'), pruebas.id('modulo'), 'Primera'), 'l1');
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, 2, %L)', pruebas.id('curso'), pruebas.id('modulo'), 'Segunda'), 'l2');
select is(pruebas.falta(), array['lesson_no_video'], 'una lección sin video se señala');
select is(jsonb_array_length(pruebas.vista(pruebas.p(1)) -> 'missing'), 2, 'una línea por lección');
select ok((pruebas.vista(pruebas.p(1)) -> 'missing' -> 0) ? 'lesson', 'y la línea dice qué lección, para enlazar al lugar exacto');

select pruebas.video('l1', 'ready', true);

-- Cada estado que no es «lista» impide enviar, también como reemplazo de una vigente (RF-606).
select results_eq(
  $$select s::text, pruebas.falta_con(s) from unnest(array['uploading', 'uploaded', 'creating', 'processing']::public.draft_video_state[]) s$$,
  $$values ('uploading', array['video_in_progress']), ('uploaded', array['video_in_progress']), ('creating', array['video_in_progress']), ('processing', array['video_in_progress'])$$,
  'lo que viene en camino, en cualquiera de sus estados, impide enviar');
select pruebas.video('l2', 'processing', false) as enproceso \gset
select is(pruebas.falta(), array['video_in_progress'], 'un video procesando se dice como tal');
select pruebas.quitar_video(:'enproceso');
select pruebas.video('l2', 'errored', false) as conerror \gset
select is(pruebas.falta(), array['video_errored'], 'un video con error se dice como tal');
select pruebas.quitar_video(:'conerror');
select pruebas.video('l2', 'ready', true) as segundo \gset
select is(pruebas.falta(), '{}'::text[], 'con todos sus videos, no falta nada');
select pruebas.video('l2', 'processing', false) as reemplazo \gset
select is(pruebas.falta(), array['video_in_progress'], 'un reemplazo procesando también impide enviar, aunque haya vigente');
select pruebas.quitar_video(:'reemplazo');
select pruebas.video('l2', 'errored', false) as reemplazo2 \gset
select is(pruebas.falta(), array['video_errored'], 'y un reemplazo con error también');
select pruebas.quitar_video(:'reemplazo2');
select pruebas.video('l2', 'ready', false) as reemplazo3 \gset
select is(pruebas.falta(), array['video_in_progress'], 'un reemplazo listo sin promover también: lo que se envía debe ser lo que se ve');
select pruebas.quitar_video(:'reemplazo3');

-- Un recurso a medias, y una práctica o un nivel que se desactivaron.
select pruebas.como_dueno();
insert into public.draft_resources (id, course_id, teacher_id, lesson_id, title, kind, mime, storage_path, size_bytes)
values ('a7400000-0000-0000-0003-000000000001', pruebas.id('curso'), pruebas.m(1), pruebas.id('l1'), 'Guía', 'pdf', 'application/pdf', 'rec/1', 10);
select is(pruebas.falta(), array['resource_pending'], 'un recurso sin terminar de subir impide enviar');
select ok((pruebas.vista(pruebas.p(1)) -> 'missing' -> 0) ? 'revision', 'y la línea lleva lo que pide quitarlo: el editor no lista los pendientes');
select pruebas.como_dueno();
update public.draft_resources set created_at = now() - interval '3 hours' where id = 'a7400000-0000-0000-0003-000000000001';
select is(pruebas.falta(), '{}'::text[], 'uno vencido ya no impide nada, aunque el repaso no haya pasado: el maestro no tiene cómo quitarlo');
select pruebas.como_dueno();
update public.draft_resources set created_at = now() - interval '3 hours' + interval '1 minute' where id = 'a7400000-0000-0000-0003-000000000001';
select is(pruebas.falta(), array['resource_pending'], 'a un minuto de vencer, sigue contando: todavía se puede confirmar');
select pruebas.como_dueno();
delete from public.draft_resources where id = 'a7400000-0000-0000-0003-000000000001';
insert into public.draft_resources (id, course_id, teacher_id, lesson_id, title, kind, mime, storage_path, size_bytes, state, position, object_id, object_version)
values ('a7400000-0000-0000-0003-000000000002', pruebas.id('curso'), pruebas.m(1), pruebas.id('l1'), 'Guía', 'pdf', 'application/pdf', 'rec/2', 10, 'ready', 1, gen_random_uuid(), 'v1');
select is(pruebas.falta(), '{}'::text[], 'uno listo, no');

select pruebas.como_dueno_sistema();
update public.practices set is_active = false where id = 'a7400000-0000-0000-0002-000000000001';
select is(pruebas.falta(), array['practice'], 'una práctica desactivada se le pide cambiar');
select pruebas.como_dueno_sistema();
update public.practices set is_active = true where id = 'a7400000-0000-0000-0002-000000000001';
update public.levels set is_active = false where id = 'a7400000-0000-0000-0002-000000000002';
select is(pruebas.falta(), array['level'], 'y un nivel desactivado');
select pruebas.como_dueno_sistema();
update public.levels set is_active = true where id = 'a7400000-0000-0000-0002-000000000002';
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- La versión 0 del anexo solo vale con la marca local que escribe `db:drafts`. En producción nadie la pone.

select pruebas.como_dueno_sistema();
select set_config('app.legal_drafts', 'on', true);
insert into public.legal_documents (doc_type, version, title, body, effective_from)
values ('license_annex', 0, 'Anexo borrador', 'Texto borrador', timestamptz '2020-01-01') on conflict (doc_type, version) do nothing;
select pruebas.como_dueno();
delete from private.local_flags where flag = 'legal_drafts';
select is(pruebas.vista(pruebas.p(1)) ->> 'answer', 'annex_missing', 'sin la marca, un borrador del anexo no se ofrece a firmar');
select is(pruebas.enviar() ->> 'answer', 'annex_missing', 'ni se firma');
insert into private.local_flags (flag) values ('legal_drafts');
select is(pruebas.vista(pruebas.p(1)) ->> 'answer', 'ready', 'con la marca, en local, sí');
select is((pruebas.vista(pruebas.p(1)) -> 'annex' ->> 'version')::integer, 0, 'y dice que es la versión 0');
select pruebas.como_dueno();
delete from private.local_flags where flag = 'legal_drafts';

select pruebas.como_dueno_sistema();
insert into public.legal_documents (doc_type, version, title, body, effective_from)
values ('license_annex', 1, 'Anexo de licencia', 'El texto completo del anexo.', now());
select pruebas.como_dueno();
select id as anexo1 from public.legal_documents where doc_type = 'license_annex' and version = 1 \gset

-- ---------------------------------------------------------------------------------------
-- La vista previa: quién la pide y qué da.

select is(pruebas.vista(pruebas.p(1)) ->> 'answer', 'ready', 'una versión 1 vale sin la marca');
select is(pruebas.vista(pruebas.p(1)) -> 'annex' ->> 'id', :'anexo1', 'da el anexo vigente');
select is(pruebas.vista(pruebas.p(1)) -> 'annex' ->> 'body', 'El texto completo del anexo.', 'con su texto completo');
select is((pruebas.vista(pruebas.p(1)) ->> 'term_years')::integer, (private.parameter_value('LICENCIA_ANIOS'))::integer, 'y el plazo de LICENCIA_ANIOS');
select is(pruebas.vista(pruebas.p(1)) ->> 'statement', format('Acepto el anexo de licencia, versión 1, para el curso «Respirar», versión 1, por %s años.', (private.parameter_value('LICENCIA_ANIOS'))::integer),
  'y la frase que se acepta nombra el curso (LFDA artículo 34)');
select is(length(pruebas.vista(pruebas.p(1)) ->> 'content_sha256'), 64, 'y la huella de lo que se enviaría');
select is((pruebas.vista(pruebas.p(1)) ->> 'submission_no')::integer, 1, 'y qué envío sería');
select ok(not (pruebas.vista(pruebas.p(1))::text ~ 'ruta/|asset-|play-|rec/'), 'el maestro no recibe rutas ni identificadores del proveedor');
select is(pruebas.vista(pruebas.p(2)) ->> 'answer', 'not_found', 'el curso de otro maestro, para él, no existe');
select is(pruebas.vista(pruebas.p(3)) ->> 'answer', 'not_teacher', 'quien no es maestro no lo pide');
select pruebas.parametro_cancelado('LICENCIA_ANIOS', true);
select is(pruebas.vista(pruebas.p(1)) ->> 'answer', 'unavailable', 'sin el plazo no se ofrece a firmar');
select is(pruebas.enviar(p_term => 10) ->> 'answer', 'unavailable', 'ni se firma');
select pruebas.parametro_cancelado('LICENCIA_ANIOS', false);

-- ---------------------------------------------------------------------------------------
-- Enviar con lo que no se vio no firma nada.

select pruebas.vista(pruebas.p(1)) ->> 'content_sha256' as huella \gset
select is(pruebas.enviar(p_hash => repeat('0', 64)) ->> 'answer', 'changed', 'con otra huella contesta changed');
select is(pruebas.enviar(p_annex => gen_random_uuid()) ->> 'answer', 'changed', 'con otro anexo también');
select is(pruebas.enviar(p_term => 3) ->> 'answer', 'changed', 'y con otro plazo también');
select is(pruebas.enviar(p_ip => null) ->> 'answer', 'origin_missing', 'sin dirección legible, fuera de local, no se firma');
select is(pruebas.rj(pruebas.p(1), format('private.course_submit(%L, null, %L, 10, 1, %L, %L)', pruebas.id('curso'), :'huella', '203.0.113.7', 'N')) ->> 'answer', 'invalid', 'sin anexo es inválido');
select is(pruebas.rj(pruebas.p(1), format('private.course_submit(%L, %L, %L, 10, null, %L, %L)', pruebas.id('curso'), :'anexo1', :'huella', '203.0.113.7', 'N')) ->> 'answer', 'invalid', 'sin el número de envío, también');
select is(pruebas.enviar(p_submission => 2) ->> 'answer', 'changed', 'con otro número de envío contesta changed');
select is(pruebas.enviar('ajeno', p_annex => :'anexo1', p_hash => :'huella', p_term => 10) ->> 'answer', 'not_found', 'un curso ajeno no existe');
select is(pruebas.enviar('vacio', p_annex => :'anexo1', p_hash => :'huella', p_term => 10) ->> 'answer', 'not_ready', 'lo incompleto no se firma');
select ok(pruebas.enviar('vacio', p_annex => :'anexo1', p_hash => :'huella', p_term => 10) -> 'missing' is not null, 'y dice qué falta');
select is((select count(*)::integer from public.course_reviews), 0, 'nada de eso dejó un envío');
select is((select count(*)::integer from public.licenses), 0, 'ni una licencia');
select is((select state::text from public.course_registry where course_id = pruebas.id('curso')), 'draft', 'y el curso sigue en borrador');

-- Los subtítulos terminan aparte, y la huella no los cuenta: si no, avisar de ellos pediría firmar otra vez.
select pruebas.como_dueno();
update public.draft_videos set captions_ready = true where id = :'segundo';
select is(pruebas.vista(pruebas.p(1)) ->> 'content_sha256', :'huella', 'unos subtítulos que terminan no cambian la huella');

-- Un cambio al curso sí.
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, 3, %L)', pruebas.id('curso'), pruebas.id('modulo'), 'Tercera'), 'l3');
select pruebas.video('l3', 'ready', true);
select isnt(pruebas.vista(pruebas.p(1)) ->> 'content_sha256', :'huella', 'una lección nueva, sí');
select is(pruebas.enviar(p_hash => :'huella') ->> 'answer', 'changed', 'y quien vio lo de antes no firma lo de ahora');

-- Un borrador sigue sin contar como «en uso» (decisión de Sergio del 2026-10-29).
select is(private.catalog_in_use('practices', 'a7400000-0000-0000-0002-000000000001'), 0, 'un borrador no usa su práctica');

-- ---------------------------------------------------------------------------------------
-- Enviar.

insert into auth.sessions (id, user_id, aal, created_at, updated_at) values (pruebas.sesion(pruebas.p(1)), pruebas.p(1), 'aal1', now(), now());
select pruebas.vista(pruebas.p(1)) ->> 'content_sha256' as huella2 \gset
select pruebas.vista(pruebas.p(1)) ->> 'statement' as frase \gset
select is(pruebas.enviar(p_hash => :'huella2') ->> 'answer', 'submitted', 'con lo que vio, se envía');
select is((select state::text from public.course_registry where course_id = pruebas.id('curso')), 'in_review', 'el curso queda en revisión');

select results_eq(
  $$select submission_no, is_revision, course_version, teacher_id, submitted_by, result::text, reviewed_by, reviewed_at, reason, encode(content_sha256, 'hex')
    from public.course_reviews where course_id = pruebas.id('curso')$$,
  format($f$values (1, false, 1, %L::uuid, %L::uuid, 'pending', null::uuid, null::timestamptz, null::text, %L)$f$, pruebas.m(1), pruebas.p(1), :'huella2'),
  'el envío guarda quién, cuándo y la huella');
select is((select (content_snapshot ->> 'format')::integer from public.course_reviews where course_id = pruebas.id('curso')), 1, 'la fotografía lleva su número de formato');
select is((select jsonb_array_length(content_snapshot -> 'modules' -> 0 -> 'lessons') from public.course_reviews where course_id = pruebas.id('curso')), 3, 'lleva las lecciones');
select ok((select content_snapshot -> 'modules' -> 0 -> 'lessons' -> 0 -> 'video' ? 'provider_asset_id' from public.course_reviews where course_id = pruebas.id('curso')), 'y su video con el asset');
select is((select content_snapshot -> 'modules' -> 0 -> 'lessons' -> 0 -> 'resources' -> 0 ->> 'storage_path' from public.course_reviews where course_id = pruebas.id('curso')), 'rec/2', 'y sus recursos, como pide el 07');
select ok((select content_snapshot -> 'captions_ready' ? :'segundo' from public.course_reviews where course_id = pruebas.id('curso')), 'los subtítulos van en la fotografía, fuera de la huella');
select results_eq(
  $$select l.course_id, l.teacher_id, l.legal_document_id, l.term_years, l.accepted_by, l.ip::text, l.user_agent, l.session_id, l.aal, l.accepted_statement
    from public.licenses l join public.course_reviews c on c.id = l.course_review_id where c.course_id = pruebas.id('curso')$$,
  format($f$values (%L::uuid, %L::uuid, %L::uuid, %s, %L::uuid, '203.0.113.7/32', 'Navegador de prueba', %L::uuid, 'aal1', %L)$f$,
         pruebas.id('curso'), pruebas.m(1), :'anexo1', (private.parameter_value('LICENCIA_ANIOS'))::integer, pruebas.p(1), pruebas.sesion(pruebas.p(1)), :'frase'),
  'la licencia guarda qué versión, cuánto tiempo, quién y desde dónde');
select is((select encode(l.accepted_statement_sha256, 'hex') from public.licenses l where l.course_id = pruebas.id('curso')), encode(sha256(convert_to(:'frase', 'UTF8')), 'hex'), 'y la huella de la frase');

-- La auditoría dice qué pasó, sin la dirección ni la fotografía entera.
select results_eq(
  $$select category::text, new_value ? 'content_snapshot', new_value ? 'content_sha256' from public.audit_log where action = 'course_reviews.insert' and entity_id = (select id::text from public.course_reviews where course_id = pruebas.id('curso'))$$,
  $$values ('content', false, true)$$, 'el envío se audita, sin la fotografía');
select results_eq(
  $$select category::text, new_value ? 'ip', new_value ? 'user_agent', new_value ? 'session_id', new_value ? 'legal_document_id' from public.audit_log where action = 'licenses.insert' and entity_id = (select id::text from public.licenses where course_id = pruebas.id('curso'))$$,
  $$values ('content', false, false, false, true)$$, 'la licencia se audita, sin el origen');

-- Un doble clic, o «Reintentar» después de una respuesta que se perdió, contesta lo mismo y no firma otra vez.
select is(pruebas.enviar(p_annex => :'anexo1', p_hash => :'huella2', p_term => (private.parameter_value('LICENCIA_ANIOS'))::integer) ->> 'answer', 'submitted', 'enviar otra vez lo mismo contesta submitted');
select is((select count(*)::integer from public.licenses where course_id = pruebas.id('curso')), 1, 'y no hay otra licencia');
select is(pruebas.enviar(p_annex => :'anexo1', p_hash => repeat('1', 64), p_term => 10) ->> 'answer', 'not_editable', 'con otra huella, ya no se edita');
select is(pruebas.enviar(p_annex => gen_random_uuid(), p_hash => :'huella2', p_term => (private.parameter_value('LICENCIA_ANIOS'))::integer) ->> 'answer', 'not_editable', 'con otro anexo tampoco es el mismo envío');
select is(pruebas.enviar(p_annex => :'anexo1', p_hash => :'huella2', p_term => 3) ->> 'answer', 'not_editable', 'ni con otro plazo');
select is(pruebas.enviar(p_annex => :'anexo1', p_hash => :'huella2', p_term => (private.parameter_value('LICENCIA_ANIOS'))::integer, p_submission => 2) ->> 'answer', 'not_editable', 'ni con otro número de envío');
select is(pruebas.vista(pruebas.p(1)) ->> 'answer', 'not_editable', 'y la vista previa también lo dice');

-- En revisión queda bloqueado para edición.
select is(pruebas.r(pruebas.p(1), format('private.draft_save_course(%L, 2, %L, null, null, null)', pruebas.id('curso'), 'Otro')), 'not_editable', 'editarlo ya no se puede');

-- Un maestro suspendido no envía (RF-702).
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba' where id = pruebas.m(2);
select pruebas.como_dueno();
select is(pruebas.vista(pruebas.p(2), 'ajeno') ->> 'answer', 'suspended', 'a un maestro suspendido se le dice');
select is(pruebas.enviar('ajeno', p_annex => :'anexo1', p_hash => :'huella', p_term => 10, p_id => pruebas.p(2)) ->> 'answer', 'suspended', 'y no envía');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'active', suspended_at = null, suspension_reason = null where id = pruebas.m(2);
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- El guardián: solo el paso de borrador a revisión, sin otro cambio y con su envío y su licencia.

select pruebas.r(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), 'Sin firma'), 'sinfirma');
select set_config('app.actor_id', pruebas.p(1)::text, true);
select throws_ok(format($$update public.course_registry set state = 'in_review', updated_at = now() where course_id = %L$$, pruebas.id('sinfirma')),
  '42501', null, 'sin envío ni licencia no pasa a revisión');
-- Con un envío sin licencia, tampoco.
insert into public.course_reviews (course_id, teacher_id, submission_no, is_revision, course_version, content_snapshot, content_sha256, submitted_by)
values (pruebas.id('sinfirma'), pruebas.m(1), 1, false, 1, '{}', sha256('x'), pruebas.p(1));
select throws_ok(format($$update public.course_registry set state = 'in_review', updated_at = now() where course_id = %L$$, pruebas.id('sinfirma')),
  '42501', null, 'con un envío sin licencia, tampoco');
insert into public.licenses (course_review_id, course_id, teacher_id, legal_document_id, term_years, accepted_statement, accepted_statement_sha256, accepted_by)
select id, course_id, teacher_id, :'anexo1', 10, 'Frase', sha256('Frase'), pruebas.p(1) from public.course_reviews where course_id = pruebas.id('sinfirma');
select throws_ok(format($$update public.course_registry set state = 'in_review', is_open = true, updated_at = now() where course_id = %L$$, pruebas.id('sinfirma')),
  '42501', null, 'y ni con los dos admite otro cambio');
select throws_ok(format($$update public.course_registry set state = 'published', updated_at = now() where course_id = %L$$, pruebas.id('sinfirma')),
  '42501', null, 'y con los dos, el único estado al que pasa es revisión');
select lives_ok(format($$update public.course_registry set state = 'in_review', updated_at = now() where course_id = %L$$, pruebas.id('sinfirma')),
  'con los dos, y solo el estado, sí');
select throws_ok(format($$update public.course_registry set updated_at = now() where course_id = %L$$, pruebas.id('sinfirma')),
  '42501', null, 'y solo desde borrador: ya en revisión, el maestro no lo toca');
select throws_ok(format($$update public.course_registry set state = 'draft', updated_at = now() where course_id = %L$$, pruebas.id('sinfirma')),
  '42501', null, 'el maestro no lo saca de revisión');
select set_config('app.actor_id', pruebas.p(2)::text, true);
select throws_ok(format($$update public.course_registry set state = 'in_review', updated_at = now() where course_id = %L$$, pruebas.id('ajeno')),
  '42501', null, 'el envío de otro no le sirve a nadie');
select pruebas.como_dueno();
-- Una licencia que aceptó otra persona: no le sirve al maestro del curso, ni a quien la aceptó.
select pruebas.r(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), 'Forjado'), 'forjado');
select set_config('app.actor_id', pruebas.p(1)::text, true);
insert into public.course_reviews (course_id, teacher_id, submission_no, is_revision, course_version, content_snapshot, content_sha256, submitted_by)
values (pruebas.id('forjado'), pruebas.m(1), 1, false, 1, '{}', sha256('x'), pruebas.p(1));
insert into public.licenses (course_review_id, course_id, teacher_id, legal_document_id, term_years, accepted_statement, accepted_statement_sha256, accepted_by)
select id, course_id, teacher_id, :'anexo1', 10, 'Frase', sha256('Frase'), pruebas.p(2) from public.course_reviews where course_id = pruebas.id('forjado');
select throws_ok(format($$update public.course_registry set state = 'in_review', updated_at = now() where course_id = %L$$, pruebas.id('forjado')),
  '42501', null, 'la licencia la tiene que haber aceptado quien envía');
select set_config('app.actor_id', pruebas.p(2)::text, true);
select throws_ok(format($$update public.course_registry set state = 'in_review', updated_at = now() where course_id = %L$$, pruebas.id('forjado')),
  '42501', null, 'y quien la aceptó no envía un curso que no es suyo');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- Las dos tablas son prueba: nadie las reescribe, y nadie de la aplicación las lee de frente.

select set_config('app.actor_id', pruebas.p(1)::text, true);
select throws_ok(format($$update public.course_reviews set content_sha256 = sha256('otra') where course_id = %L$$, pruebas.id('curso')),
  '42501', null, 'un envío no cambia su fotografía');
select throws_ok(format($$update public.course_reviews set result = 'approved' where course_id = %L$$, pruebas.id('curso')),
  '23514', null, 'y no se decide sin quién y cuándo');
select throws_ok(format($$update public.course_reviews set result = 'rejected', reviewed_by = %L, reviewed_at = now() where course_id = %L$$, pruebas.p(1), pruebas.id('curso')),
  '23514', null, 'un rechazo sin motivo no se guarda (RF-607)');
select throws_ok(format($$update public.course_reviews set result = 'rejected', reason = '   ', reviewed_by = %L, reviewed_at = now() where course_id = %L$$, pruebas.p(1), pruebas.id('curso')),
  '23514', null, 'ni con un motivo en blanco');
select lives_ok(format($$update public.course_reviews set result = 'approved', reviewed_by = %L, reviewed_at = now() where course_id = %L$$, pruebas.p(1), pruebas.id('sinfirma')),
  'de pendiente a decidido, sí');
select throws_ok(format($$update public.course_reviews set result = 'rejected', reason = 'Otra' where course_id = %L$$, pruebas.id('sinfirma')),
  '42501', null, 'y una sola vez');
select throws_ok(format($$delete from public.course_reviews where course_id = %L$$, pruebas.id('curso')), '42501', null, 'un envío no se borra');
select throws_ok(format($$delete from public.licenses where course_id = %L$$, pruebas.id('curso')), '42501', null, 'una licencia no se borra');
select throws_ok(format($$update public.licenses set term_years = 1 where course_id = %L$$, pruebas.id('curso')), '42501', null, 'ni cambia');
select throws_ok($$truncate public.course_reviews cascade$$, '42501', null, 'ni se vacían los envíos');
select throws_ok($$truncate public.licenses$$, '42501', null, 'ni las licencias');
select lives_ok(format($$update public.licenses set ip = null, user_agent = null where course_id = %L$$, pruebas.id('curso')), 'el origen sí se puede vaciar: lo hará eliminar la cuenta (T-311)');
select pruebas.como_dueno();

select pruebas.como_usuario(pruebas.p(1));
select throws_ok($$select * from public.course_reviews$$, '42501', null, 'el maestro no lee los envíos de frente');
select throws_ok($$select * from public.licenses$$, '42501', null, 'ni las licencias');
select pruebas.como_servicio(pruebas.p(1));
select throws_ok($$select * from public.course_reviews$$, '42501', null, 'el servidor tampoco');
select throws_ok($$select * from public.licenses$$, '42501', null, 'tampoco');
select pruebas.como_usuario(pruebas.p(1));
select throws_ok(format($$select private.course_snapshot(%L)$$, pruebas.id('curso')), '42501', null, 'la fotografía no se pide de fuera');
select pruebas.como_servicio(pruebas.p(1));
select throws_ok(format($$select private.course_readiness(%L)$$, pruebas.id('curso')), '42501', null, 'ni la lista');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- «En uso» cuenta lo que está en revisión: no se desactiva la práctica de un curso que alguien está revisando.

select is(private.catalog_in_use('practices', 'a7400000-0000-0000-0002-000000000001'), 1, 'un curso en revisión usa su práctica');
select is(private.catalog_in_use('levels', 'a7400000-0000-0000-0002-000000000002'), 1, 'y su nivel');

-- ---------------------------------------------------------------------------------------
-- Borrar un curso rechazado que ya se firmó (decisión de Sergio del 2026-11-02): se va el curso y se quedan su envío y su licencia.

select pruebas.como_dueno_sistema();
update public.course_reviews set result = 'rejected', reviewed_by = pruebas.p(1), reviewed_at = now(), reason = 'Falta audio' where course_id = pruebas.id('curso');
update public.course_registry set state = 'draft', updated_at = now() where course_id = pruebas.id('curso');
select pruebas.como_dueno();
-- Un reenvío tardío del mismo formulario, con la misma huella, no firma otra vez sin que el maestro lo vea: lleva el número de envío que vio.
select is(pruebas.enviar(p_annex => :'anexo1', p_hash => :'huella2', p_term => (private.parameter_value('LICENCIA_ANIOS'))::integer, p_submission => 1) ->> 'answer', 'changed',
  'un formulario de antes de la devolución no firma otra vez');
select is((select count(*)::integer from public.licenses where course_id = pruebas.id('curso')), 1, 'y no deja otra licencia');
select is((pruebas.vista(pruebas.p(1)) ->> 'submission_no')::integer, 2, 'la vista previa ya dice que este sería el segundo');
select is(pruebas.enviar() ->> 'answer', 'submitted', 'y con lo que ve ahora, se reenvía');
select is((select max(submission_no) from public.course_reviews where course_id = pruebas.id('curso')), 2, 'como segundo envío');
select is((select count(*)::integer from public.licenses where course_id = pruebas.id('curso')), 2, 'con su propia licencia');
select pruebas.como_dueno_sistema();
update public.course_reviews set result = 'rejected', reviewed_by = pruebas.p(1), reviewed_at = now(), reason = 'Sigue sin audio' where course_id = pruebas.id('curso') and result = 'pending';
update public.course_registry set state = 'draft', updated_at = now() where course_id = pruebas.id('curso');
select pruebas.como_dueno();
select id as envio from public.course_reviews where course_id = pruebas.id('curso') and submission_no = 1 \gset
select content_revision as vista from public.course_drafts where course_id = pruebas.id('curso') \gset
select is(pruebas.r(pruebas.p(1), format('private.draft_delete_course(%L, %s)', pruebas.id('curso'), :vista)), 'deleted', 'un curso rechazado se puede borrar');
select ok(not exists (select 1 from public.course_registry where course_id = pruebas.id('curso')), 'el curso se fue');
select is((select count(*)::integer from public.course_reviews where id = :'envio'), 1, 'su envío se queda');
select is((select count(*)::integer from public.licenses where course_review_id = :'envio'), 1, 'y su licencia');

-- Lo que se publicó alguna vez no se borra, y la función lo dice en vez de lanzar.
select pruebas.r(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), 'Publicado'), 'publicado');
select pruebas.como_dueno_sistema();
update public.course_registry set first_published_at = now() where course_id = pruebas.id('publicado');
select pruebas.como_dueno();
select is(pruebas.r(pruebas.p(1), format('private.draft_delete_course(%L, 1)', pruebas.id('publicado'))), 'not_editable', 'un curso que se publicó no se borra');
select set_config('app.actor_id', pruebas.p(1)::text, true);
insert into public.course_reviews (course_id, teacher_id, submission_no, is_revision, course_version, content_snapshot, content_sha256, submitted_by)
values (pruebas.id('publicado'), pruebas.m(1), 1, false, 1, '{}', sha256('x'), pruebas.p(1));
insert into public.licenses (course_review_id, course_id, teacher_id, legal_document_id, term_years, accepted_statement, accepted_statement_sha256, accepted_by)
select id, course_id, teacher_id, :'anexo1', 10, 'Frase', sha256('Frase'), pruebas.p(1) from public.course_reviews where course_id = pruebas.id('publicado');
select throws_ok(format($$update public.course_registry set state = 'in_review', updated_at = now() where course_id = %L$$, pruebas.id('publicado')),
  '42501', null, 'el guardián tampoco deja pasar a revisión lo que ya se publicó: eso es la solicitud de versiones');
select pruebas.como_dueno();
select is(pruebas.vista(pruebas.p(1), 'publicado') ->> 'answer', 'not_editable', 'y no se ofrece a firmar por aquí');
select is(pruebas.enviar('publicado', p_annex => :'anexo1', p_hash => :'huella', p_term => 10) ->> 'answer', 'not_editable', 'y por aquí no se envía: eso es la solicitud de versiones');

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is_empty($$select * from private.schema_violations()$$, 'el vigilante no encuentra nada');

-- Las reglas del área se provocan.
select is(pruebas.vigila(), '{}', 'el área está limpia');
grant select (ip) on public.licenses to authenticated;
select ok('evidence table open to authenticated' = any(pruebas.vigila()), 'una columna a la vista de la persona se nota');
revoke select (ip) on public.licenses from authenticated;
grant select on public.course_reviews to app_service;
select ok('evidence table open to app_service' = any(pruebas.vigila()), 'que el servidor lea la fotografía se nota');
revoke select on public.course_reviews from app_service;
alter table public.licenses disable row level security;
select ok('evidence table without row level security' = any(pruebas.vigila()), 'sin seguridad por fila, se nota');
alter table public.licenses enable row level security;
create policy abierta on public.course_reviews for select to anon using (true);
select ok('evidence table with a policy' = any(pruebas.vigila()), 'una política se nota');
drop policy abierta on public.course_reviews;
alter table public.licenses add constraint atada foreign key (course_id) references public.course_registry (course_id) not valid;
select ok('evidence table tied to the course' = any(pruebas.vigila()), 'una clave al curso se nota: la prueba no sobreviviría');
alter table public.licenses drop constraint atada;
alter table public.licenses disable trigger audit_changes;
select ok('evidence table without trigger audit_changes' = any(pruebas.vigila()), 'sin auditoría, se nota');
alter table public.licenses enable trigger audit_changes;
-- Con el mismo nombre y la misma función, pero dejando pasar el origen a la auditoría.
drop trigger audit_changes on public.licenses;
create trigger audit_changes after insert or update on public.licenses for each row execute function private.audit_row_change('content');
select ok('evidence table without trigger audit_changes' = any(pruebas.vigila()), 'una auditoría que deja pasar la dirección se nota');
drop trigger audit_changes on public.licenses;
create trigger audit_changes after insert or update on public.licenses for each row execute function private.audit_row_change('content', 'ip', 'user_agent', 'session_id', 'aal');
drop trigger audit_changes on public.course_reviews;
create trigger audit_changes after insert or update on public.course_reviews for each row execute function private.audit_row_change('content');
select ok('evidence table without trigger audit_changes' = any(pruebas.vigila()), 'una auditoría que copia la fotografía se nota');
drop trigger audit_changes on public.course_reviews;
create trigger audit_changes after insert or update on public.course_reviews for each row execute function private.audit_row_change('content', 'content_snapshot');
-- Un guardián que deja vaciar más que el origen.
drop trigger licenses_guard on public.licenses;
create trigger licenses_guard before update or delete on public.licenses for each row execute function private.allow_only_redaction('ip', 'user_agent', 'term_years');
select ok('evidence table without trigger licenses_guard' = any(pruebas.vigila()), 'un guardián que deja vaciar el plazo se nota');
drop trigger licenses_guard on public.licenses;
create trigger licenses_guard before update or delete on public.licenses for each row execute function private.allow_only_redaction('ip', 'user_agent');
alter table public.course_reviews disable trigger course_reviews_guard;
select ok('evidence table without trigger course_reviews_guard' = any(pruebas.vigila()), 'sin el guardián del envío, se nota');
alter table public.course_reviews enable trigger course_reviews_guard;
create trigger ajeno before insert on public.licenses for each row execute function private.reject_mutation();
select ok('evidence table with a foreign trigger' = any(pruebas.vigila()), 'un disparador ajeno se nota');
drop trigger ajeno on public.licenses;
alter table public.course_reviews drop constraint course_reviews_rejection_has_reason;
select ok('evidence table without constraint course_reviews_rejection_has_reason' = any(pruebas.vigila()), 'un rechazo sin motivo se nota');
alter table public.course_reviews add constraint course_reviews_rejection_has_reason check (result <> 'rejected' or (reason is not null and btrim(reason) <> ''));
drop index public.course_reviews_one_pending_uq;
select ok('evidence index missing' = any(pruebas.vigila()), 'dos envíos pendientes a la vez se notan');
create unique index course_reviews_one_pending_uq on public.course_reviews (course_id) where result = 'pending';
create function private.course_submit_otra() returns void language sql set search_path = '' as $$ select 1 $$;
select ok('submission function not in the watchdog area' = any(pruebas.vigila()), 'una función nueva de enviar se nota');
drop function private.course_submit_otra();
grant execute on function private.course_snapshot(uuid) to app_service;
select ok('submission function executable by app_service' = any(pruebas.vigila()), 'la fotografía en manos del servidor se nota');
revoke execute on function private.course_snapshot(uuid) from app_service;
revoke execute on function private.course_submit_preview(uuid) from app_service;
select ok('submission function not executable by app_service' = any(pruebas.vigila()), 'que el servidor no pueda pedir la vista se nota');
grant execute on function private.course_submit_preview(uuid) to app_service;
alter function private.course_submit_preview(uuid) security invoker;
select ok('submission function not security definer' = any(pruebas.vigila()), 'una función del servidor sin los permisos del dueño se nota');
alter function private.course_submit_preview(uuid) security definer;
alter function private.course_readiness(uuid) reset search_path;
select ok('submission function without fixed search_path' = any(pruebas.vigila()), 'una función sin su camino de búsqueda se nota');
alter function private.course_readiness(uuid) set search_path = '';
select is(pruebas.vigila(), '{}', 'y al deshacerlo queda limpia');

select * from finish();
rollback;
