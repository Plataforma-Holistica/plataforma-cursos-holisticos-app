-- T-405, tercera solicitud · Lo que PA-44, PA-42 y PA-50 le preguntan a la base para enviar (RF-606, FL-34). Los assets vigentes, para preguntarle a Mux antes de firmar; qué le
-- falta a cada curso y cuándo se envió; lo que el maestro aceptó, sin el origen; y el texto de una versión del anexo, la vigente o una que aceptó. Pasa con los borradores legales
-- cargados y sin ellos.
begin;
\ir _ayuda.psql
select plan(42);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a7600000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.m(p_n integer) returns uuid language sql immutable
as $$ select ('a7600000-0000-0000-0001-' || lpad(p_n::text, 12, '0'))::uuid $$;
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
create function pruebas.armar(p_n integer, p_k text, p_title text) returns void
language plpgsql as $$
begin
  perform pruebas.r(pruebas.p(p_n), format('private.draft_create(%L, %L)', gen_random_uuid(), p_title), p_k);
  perform pruebas.r(pruebas.p(p_n), format('private.draft_save_course(%L, 1, %L, %L, %L, %L)', pruebas.id(p_k), p_title, 'Un resumen.',
          'a7600000-0000-0000-0002-000000000001', 'a7600000-0000-0000-0002-000000000002'));
  perform pruebas.r(pruebas.p(p_n), format('private.draft_add_module(%L, 1, %L)', pruebas.id(p_k), 'Inicio'), p_k || '-m');
  perform pruebas.r(pruebas.p(p_n), format('private.draft_add_lesson(%L, %L, 1, %L)', pruebas.id(p_k), pruebas.id(p_k || '-m'), 'Primera'), p_k || '-l');
end
$$;
create function pruebas.video(p_n integer, p_k text, p_current boolean, p_state public.draft_video_state default 'ready') returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  perform pruebas.como_dueno();
  insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                   provider, provider_asset_id, provider_playback_id, duration_seconds)
  values (v_id, pruebas.id(p_k), pruebas.m(p_n), pruebas.id(p_k || '-l'), p_state, p_current, 'clase.mp4', 'video/mp4', 'ruta/' || v_id, 1000,
          gen_random_uuid(), 'v1', 600, 'mux', 'asset-' || v_id, case when p_state = 'ready' then 'play-' || v_id end, case when p_state = 'ready' then 600 end);
  return v_id;
end
$$;
create function pruebas.enviar(p_n integer, p_k text) returns text
language plpgsql as $$
declare
  v jsonb := pruebas.rj(pruebas.p(p_n), format('private.course_submit_preview(%L)', pruebas.id(p_k)));
begin
  return pruebas.rj(pruebas.p(p_n), format('private.course_submit(%L, %L, %L, %s, %s, %L, %L)', pruebas.id(p_k), v -> 'annex' ->> 'id', v ->> 'content_sha256',
    v ->> 'term_years', v ->> 'submission_no', '203.0.113.7', 'Navegador de prueba')) ->> 'answer';
end
$$;
create function pruebas.estado(p_id uuid, p_k text) returns jsonb
language sql as $$
  select e from jsonb_array_elements(pruebas.rj(p_id, 'private.course_submit_status()')) e where e ->> 'course_id' = pruebas.id(p_k)::text
$$;
create function pruebas.vigila() returns text[]
language sql as $$
  select coalesce(array_agg(v.problem order by v.problem), '{}') from private.schema_violations_submissions() v
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;
grant select on pruebas.ids to anon, authenticated, app_service;
grant insert, update on pruebas.ids to anon, authenticated, app_service;

-- 1 y 2 son maestros; 3 tiene Contenido y configuración.
select pruebas.alta(pruebas.p(n), 'enviar-' || n || '@prueba.test'), pruebas.confirmar(pruebas.p(n)) from generate_series(1, 3) n;
select pruebas.maestro(n) from generate_series(1, 2) n;
select pruebas.dar_capacidad(pruebas.p(3), 'content');
-- Y configuración: publica las versiones del anexo de esta prueba.
select pruebas.dar_capacidad(pruebas.p(3), 'config');
select pruebas.equipar(pruebas.p(3));
select pruebas.limpiar();

select pruebas.como_dueno_sistema();
insert into public.practices (id, slug, name, position, cover_tone) values ('a7600000-0000-0000-0002-000000000001', 'enviar-practica', 'Enviar práctica', 903, 1);
insert into public.levels (id, slug, name, position) values ('a7600000-0000-0000-0002-000000000002', 'enviar-nivel', 'Enviar nivel', 903);
insert into public.legal_documents (doc_type, version, title, body, effective_from)
values ('license_annex', 1, 'Anexo de licencia', 'El texto de la versión 1.', now());
select pruebas.como_dueno();
select id as anexo1 from public.legal_documents where doc_type = 'license_annex' and version = 1 \gset

select pruebas.armar(1, 'curso', 'Respirar');
select pruebas.armar(2, 'ajeno', 'De otro');

-- ---------------------------------------------------------------------------------------
-- Los assets vigentes, para preguntarle a Mux antes de firmar.

select is(pruebas.rj(pruebas.p(1), format('private.course_submit_assets(%L)', pruebas.id('curso'))) -> 'assets', '[]'::jsonb, 'sin video, no hay assets');
select pruebas.video(1, 'curso', true) as vigente \gset
select pruebas.video(1, 'curso', false, 'processing') as reemplazo \gset
select is(
  pruebas.rj(pruebas.p(1), format('private.course_submit_assets(%L)', pruebas.id('curso'))),
  jsonb_build_object('answer', 'ok', 'assets', jsonb_build_array(jsonb_build_object('lesson', pruebas.id('curso-l'), 'provider', 'mux', 'asset', 'asset-' || :'vigente', 'playback', 'play-' || :'vigente'))),
  'solo el vigente, con su proveedor, su asset y la reproducción que se firma');
select is(pruebas.rj(pruebas.p(2), format('private.course_submit_assets(%L)', pruebas.id('curso'))) ->> 'answer', 'not_found', 'el curso de otro maestro, para él, no existe');
select is(pruebas.rj(pruebas.p(3), format('private.course_submit_assets(%L)', pruebas.id('curso'))) ->> 'answer', 'not_teacher', 'quien no es maestro no lo pide');
select pruebas.como_dueno();
delete from public.draft_videos where id = :'reemplazo';

-- ---------------------------------------------------------------------------------------
-- Qué le falta a cada curso, con la misma lista de enviar.

select is((pruebas.estado(pruebas.p(1), 'curso') ->> 'missing')::integer, 0, 'con todo, no le falta nada');
select is(pruebas.estado(pruebas.p(1), 'curso') ->> 'submitted_at', null, 'y no se ha enviado');
select is((pruebas.estado(pruebas.p(2), 'ajeno') ->> 'missing')::integer, 1, 'al otro le falta el video de su lección');
select is(pruebas.estado(pruebas.p(1), 'ajeno'), null, 'cada maestro ve solo lo suyo');
select is(pruebas.rj(pruebas.p(3), 'private.course_submit_status()'), '[]'::jsonb, 'quien no es maestro no tiene cursos');
select pruebas.video(1, 'curso', false, 'processing') as reemplazo2 \gset
select is((pruebas.estado(pruebas.p(1), 'curso') ->> 'missing')::integer, 1, 'un reemplazo en camino cuenta, como al enviar');
select pruebas.como_dueno();
delete from public.draft_videos where id = :'reemplazo2';

select is(pruebas.enviar(1, 'curso'), 'submitted', 'el maestro envía');
select isnt(pruebas.estado(pruebas.p(1), 'curso') ->> 'submitted_at', null, 'y su curso dice cuándo');
select is(pruebas.estado(pruebas.p(1), 'curso') ->> 'missing', null, 'en revisión no se cuenta lo que falta');
select is(pruebas.rj(pruebas.p(1), format('private.course_submit_assets(%L)', pruebas.id('curso'))) ->> 'answer', 'not_editable', 'ni se piden sus assets');

-- Un maestro suspendido sigue viendo lo suyo.
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'Prueba', suspension_notice = 'Prueba' where id = pruebas.m(1);
select isnt(pruebas.estado(pruebas.p(1), 'curso'), null, 'suspendido, ve el estado de sus cursos');
select isnt(pruebas.rj(pruebas.p(1), 'private.course_submit_licenses()') -> 0, null, 'y lo que aceptó');
select is(pruebas.rj(pruebas.p(1), format('private.course_submit_assets(%L)', pruebas.id('curso'))) ->> 'answer', 'suspended', 'pero no pide assets para enviar');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'active', suspended_at = null, suspension_reason = null, suspension_notice = null where id = pruebas.m(1);
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- Lo que aceptó, sin el origen.

select is(jsonb_array_length(pruebas.rj(pruebas.p(1), 'private.course_submit_licenses()')), 1, 'el maestro ve su licencia');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pruebas.rj(pruebas.p(1), 'private.course_submit_licenses()') -> 0) k),
  array['accepted_at', 'annex', 'course_id', 'course_title', 'statement', 'submission_no', 'term_years'],
  'con lo que dice PA-50, y nada del origen');
select is(pruebas.rj(pruebas.p(1), 'private.course_submit_licenses()') -> 0 ->> 'course_title', 'Respirar', 'nombra el curso, tal como se envió');
select is((pruebas.rj(pruebas.p(1), 'private.course_submit_licenses()') -> 0 -> 'annex' ->> 'id')::uuid, :'anexo1'::uuid, 'y la versión del anexo');
select ok((pruebas.rj(pruebas.p(1), 'private.course_submit_licenses()') -> 0 ->> 'statement') like '%«Respirar»%', 'con la frase aceptada');
select ok(not (pruebas.rj(pruebas.p(1), 'private.course_submit_licenses()')::text ~ '203\.0\.113|Navegador'), 'sin la dirección ni el navegador');
select is(pruebas.rj(pruebas.p(2), 'private.course_submit_licenses()'), '[]'::jsonb, 'otro maestro no la ve');
select is(pruebas.rj(pruebas.p(3), 'private.course_submit_licenses()'), '[]'::jsonb, 'ni quien no es maestro');

-- El título es el que se envió, aunque el curso cambie o se borre después.
select pruebas.como_dueno();
alter table public.course_drafts disable trigger user;
update public.course_drafts set title = 'Otro nombre' where course_id = pruebas.id('curso');
alter table public.course_drafts enable trigger user;
select is(pruebas.rj(pruebas.p(1), 'private.course_submit_licenses()') -> 0 ->> 'course_title', 'Respirar', 'el título no cambia con el borrador');

-- Devuelto, ya no dice que se envió: la fecha es la del envío pendiente.
select pruebas.como_dueno();
select c.id as envio from public.course_reviews c where c.course_id = pruebas.id('curso') and c.result = 'pending' \gset
select pruebas.a_nombre_de(pruebas.p(3));
select private.review_return(pruebas.id('curso'), :'envio', 'Motivo.', 'Corrección.') as devuelto \gset
select pruebas.limpiar();
select is(:'devuelto'::text, 'returned', 'Contenido lo devuelve');
select is(pruebas.estado(pruebas.p(1), 'curso') ->> 'submitted_at', null, 'y de vuelta en borrador no hay fecha de envío');

-- ---------------------------------------------------------------------------------------
-- El texto de una versión del anexo: la vigente, o una que el maestro aceptó.

select is(pruebas.rj(pruebas.p(1), format('private.course_submit_annex(%L)', :'anexo1')) ->> 'body', 'El texto de la versión 1.', 'el maestro lee la versión que aceptó');
select is(pruebas.rj(pruebas.p(2), format('private.course_submit_annex(%L)', :'anexo1')) ->> 'body', 'El texto de la versión 1.', 'y otro maestro, la vigente');
-- Desde la versión 2 la publica una persona, como el dueño a su nombre.
select pruebas.como_dueno();
select set_config('app.actor_id', pruebas.p(3)::text, true), set_config('app.actor_session', pruebas.sesion(pruebas.p(3))::text, true);
insert into public.legal_documents (doc_type, version, title, body, effective_from)
values ('license_annex', 2, 'Anexo de licencia', 'El texto de la versión 2.', now());
select pruebas.como_dueno();
select id as anexo2 from public.legal_documents where doc_type = 'license_annex' and version = 2 \gset
select is(pruebas.rj(pruebas.p(1), format('private.course_submit_annex(%L)', :'anexo1')) ->> 'body', 'El texto de la versión 1.', 'quien la aceptó sigue leyendo la versión 1');
select is(pruebas.rj(pruebas.p(2), format('private.course_submit_annex(%L)', :'anexo1')), null, 'quien no la aceptó ya no: no es la vigente');
select is(pruebas.rj(pruebas.p(2), format('private.course_submit_annex(%L)', :'anexo2')) ->> 'version', '2', 'la vigente sí');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pruebas.rj(pruebas.p(2), format('private.course_submit_annex(%L)', :'anexo2'))) k),
  array['body', 'effective_from', 'id', 'title', 'version'],
  'con su texto, su versión y desde cuándo rige');
select is(pruebas.rj(pruebas.p(1), format('private.course_submit_annex(%L)', private.current_legal_document('teacher_privacy_notice'))), null, 'otro tipo de texto, no');
select is(pruebas.rj(pruebas.p(3), format('private.course_submit_annex(%L)', :'anexo2')), null, 'quien no es maestro, no');
-- Desde la versión 2 la publica una persona, como el dueño a su nombre.
select pruebas.como_dueno();
select set_config('app.actor_id', pruebas.p(3)::text, true), set_config('app.actor_session', pruebas.sesion(pruebas.p(3))::text, true);
insert into public.legal_documents (doc_type, version, title, body, effective_from)
values ('license_annex', 3, 'Anexo de licencia', 'El texto que todavía no rige.', now() + interval '1 day');
select pruebas.como_dueno();
select id as anexo3 from public.legal_documents where doc_type = 'license_annex' and version = 3 \gset
select is(pruebas.rj(pruebas.p(2), format('private.course_submit_annex(%L)', :'anexo3')), null, 'una versión que todavía no rige, no');

-- ---------------------------------------------------------------------------------------
-- Quién las ejecuta, y el vigilante.

select ok(
  (select bool_and(has_function_privilege('app_service', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
   from unnest(array['private.course_submit_assets(uuid)', 'private.course_submit_status()', 'private.course_submit_licenses()', 'private.course_submit_annex(uuid)']) f),
  'las cuatro son del servidor, y de nadie más');
select is(pruebas.vigila(), '{}', 'el área está limpia');
grant execute on function private.course_submit_licenses() to authenticated;
select ok('submission function executable by authenticated' = any(pruebas.vigila()), 'lo aceptado en manos de la persona se nota');
revoke execute on function private.course_submit_licenses() from authenticated;
select pg_get_functiondef('private.course_submit_licenses()'::regprocedure) as antes \gset
create or replace function private.course_submit_licenses() returns jsonb
language sql stable security definer set search_path = '' as $$ select '[]'::jsonb $$;
select ok('submission function without its rule actor_teacher_id' = any(pruebas.vigila()), 'lo aceptado sin mirar de quién se nota');
select :'antes' \gexec
select is(pruebas.vigila(), '{}', 'y al deshacerlo queda limpia');

select * from finish();
