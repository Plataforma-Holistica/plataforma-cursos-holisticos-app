-- T-405, cuarta solicitud · Publicar desde el borrador (RF-606, RF-607, RN-16, RF-310, FL-35). Contenido aprueba lo que se envió desde el editor: lleva el envío que vio, y la
-- base publica desde la fotografía, con los videos y su original, los recursos y el envío cerrado, y borra el borrador. Lo que no se aprueba: lo suyo, el curso de un maestro
-- suspendido, un anexo de borrador fuera de local, lo que no tiene subtítulos y un archivo que cambió por fuera. Pasa con los borradores legales cargados y sin ellos.
begin;
\ir _ayuda.psql
select plan(71);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a7700000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.m(p_n integer) returns uuid language sql immutable
as $$ select ('a7700000-0000-0000-0001-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.maestro(p_n integer, p_name text) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  insert into public.teachers (id, profile_id, status) values (pruebas.m(p_n), pruebas.p(p_n), 'active');
  insert into public.published_teachers (teacher_id, slug, display_name) values (pruebas.m(p_n), private.catalog_slug(p_name), p_name);
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
-- Un video listo y vigente, con su original en la cubeta, como lo deja T-403.
create function pruebas.video(p_n integer, p_k text, p_lesson text, p_provider text default 'mux') returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
  v_path text := pruebas.m(p_n)::text || '/' || pruebas.id(p_k)::text || '/' || v_id::text;
  v_object uuid;
begin
  perform pruebas.como_dueno();
  insert into storage.objects (bucket_id, name, version, metadata)
  values ('video-originals', v_path, 'v1', jsonb_build_object('size', 1000, 'mimetype', 'video/mp4'))
  returning id into v_object;
  insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                   provider, provider_asset_id, provider_playback_id, duration_seconds)
  values (v_id, pruebas.id(p_k), pruebas.m(p_n), pruebas.id(p_lesson), 'ready', true, 'clase.mp4', 'video/mp4', v_path, 1000, v_object, 'v1', 300,
          p_provider, 'asset-' || v_id, 'play-' || v_id, 300);
  return v_id;
end
$$;
-- Un recurso listo, con su objeto en la cubeta. Lección nula: es del curso.
create function pruebas.recurso(p_n integer, p_k text, p_lesson text, p_title text) returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
  v_path text := pruebas.m(p_n)::text || '/' || pruebas.id(p_k)::text || '/' || v_id::text;
  v_object uuid;
begin
  perform pruebas.como_dueno();
  insert into storage.objects (bucket_id, name, version, metadata)
  values ('course-resources', v_path, 'v1', jsonb_build_object('size', 100, 'mimetype', 'application/pdf'))
  returning id into v_object;
  insert into public.draft_resources (id, course_id, teacher_id, lesson_id, title, kind, mime, storage_path, size_bytes, state, position, object_id, object_version)
  values (v_id, pruebas.id(p_k), pruebas.m(p_n), pruebas.id(p_lesson), p_title, 'pdf', 'application/pdf', v_path, 100, 'ready', 1, v_object, 'v1');
  return v_id;
end
$$;
-- Un curso de un módulo y una lección, con su video.
create function pruebas.armar(p_n integer, p_k text, p_title text, p_provider text default 'mux') returns void
language plpgsql as $$
begin
  perform pruebas.r(pruebas.p(p_n), format('private.draft_create(%L, %L)', gen_random_uuid(), p_title), p_k);
  perform pruebas.r(pruebas.p(p_n), format('private.draft_save_course(%L, 1, %L, %L, %L, %L)', pruebas.id(p_k), p_title, 'Un resumen.',
          'a7700000-0000-0000-0002-000000000001', 'a7700000-0000-0000-0002-000000000002'));
  perform pruebas.r(pruebas.p(p_n), format('private.draft_add_module(%L, 1, %L)', pruebas.id(p_k), 'Inicio'), p_k || '-m');
  perform pruebas.r(pruebas.p(p_n), format('private.draft_add_lesson(%L, %L, 1, %L)', pruebas.id(p_k), pruebas.id(p_k || '-m'), 'Primera'), p_k || '-l');
  perform pruebas.video(p_n, p_k, p_k || '-l', p_provider);
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
create function pruebas.envio(p_k text) returns uuid language sql stable
as $$ select c.id from public.course_reviews c where c.course_id = pruebas.id(p_k) order by c.submission_no desc limit 1 $$;
-- Los videos del curso con subtítulos, según lo que el servidor le preguntó a Mux: todos, ninguno, o solo el de la primera lección.
create function pruebas.subtitulos(p_k text, p_which text) returns uuid[]
language sql stable as $$
  select coalesce(array_agg(x.id order by x.n), '{}') from (
    select v.id, row_number() over (order by m.position, l.position) as n
    from public.draft_videos v
    join public.draft_lessons l on l.id = v.lesson_id
    join public.draft_modules m on m.id = l.module_id
    where v.course_id = pruebas.id(p_k) and v.is_current) x
  where p_which = 'all' or (p_which = 'first' and x.n = 1)
$$;
create function pruebas.aprobar(p_id uuid, p_k text, p_which text default 'all', p_submission uuid default null) returns text
language plpgsql as $$
declare
  v text;
  v_captions uuid[] := pruebas.subtitulos(p_k, p_which);
  v_submission uuid := coalesce(p_submission, pruebas.envio(p_k));
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.review_approve(pruebas.id(p_k), v_submission, v_captions);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.de_cola(p_k text) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(pruebas.p(3));
  select c into v from jsonb_array_elements(private.review_queue() -> 'courses') c where c ->> 'course_id' = pruebas.id(p_k)::text;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.estado(p_k text) returns text language sql stable
as $$ select state::text from public.course_registry where course_id = pruebas.id(p_k) $$;
create function pruebas.barrido(p_k text) returns text[]
language plpgsql as $$
declare
  v text[];
begin
  perform pruebas.como_dueno();
  select coalesce(array_agg(s.kind order by s.kind), '{}') into v from private.video_sweep() s
  where starts_with(s.path, pruebas.m(1)::text || '/' || pruebas.id(p_k)::text || '/');
  return v;
end
$$;
create function pruebas.vigila() returns text[]
language sql as $$
  select coalesce(array_agg(v.problem order by v.problem), '{}') from private.schema_violations_submissions() v
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;
grant select on pruebas.ids to anon, authenticated, app_service;
grant insert, update on pruebas.ids to anon, authenticated, app_service;

-- 1 y 2 son maestros; 2 además tiene Contenido. 3 tiene Contenido, 4 también, sin un código reciente, y 5 no tiene nada.
select pruebas.alta(pruebas.p(n), 'publicar-' || n || '@prueba.test'), pruebas.confirmar(pruebas.p(n)) from generate_series(1, 5) n;
select pruebas.maestro(1, 'Ana Luz');
select pruebas.maestro(2, 'Beto Mar');
select pruebas.dar_capacidad(pruebas.p(n), 'content') from generate_series(2, 4) n;
select pruebas.equipar(pruebas.p(n)) from generate_series(2, 4) n;
select pruebas.limpiar();
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '1 hour' where session_id = pruebas.sesion(pruebas.p(4));

select pruebas.como_dueno_sistema();
insert into public.practices (id, slug, name, position, cover_tone) values ('a7700000-0000-0000-0002-000000000001', 'publicar-practica', 'Publicar práctica', 904, 1);
insert into public.levels (id, slug, name, position) values ('a7700000-0000-0000-0002-000000000002', 'publicar-nivel', 'Publicar nivel', 904);
insert into public.legal_documents (doc_type, version, title, body, effective_from)
values ('license_annex', 1, 'Anexo de licencia', 'El texto completo del anexo.', now());
-- La versión 0, como la carga db:drafts, para probar que fuera de local no se aprueba.
select set_config('app.legal_drafts', 'on', true);
insert into public.legal_documents (doc_type, version, title, body, effective_from)
select 'license_annex', 0, 'Anexo de borrador', 'Borrador sin validez.', now() - interval '1 day'
where not exists (select 1 from public.legal_documents where doc_type = 'license_annex' and version = 0);
select pruebas.como_dueno();
select id as anexo0 from public.legal_documents where doc_type = 'license_annex' and version = 0 \gset
-- La marca de los videos de prueba, como la pone db:login. La de los borradores legales, como estaba.
insert into private.local_flags (flag) values ('video_test') on conflict do nothing;
select exists (select 1 from private.local_flags where flag = 'legal_drafts') as con_borradores \gset

-- El curso de 1: dos módulos, tres lecciones, recursos del curso y de una lección.
select pruebas.r(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), 'Respirar'), 'curso');
select pruebas.r(pruebas.p(1), format('private.draft_save_course(%L, 1, %L, %L, %L, %L)', pruebas.id('curso'), 'Respirar', 'Un resumen.',
       'a7700000-0000-0000-0002-000000000001', 'a7700000-0000-0000-0002-000000000002'));
select pruebas.r(pruebas.p(1), format('private.draft_add_module(%L, 1, %L)', pruebas.id('curso'), 'Inicio'), 'm1');
select pruebas.r(pruebas.p(1), format('private.draft_add_module(%L, 2, %L)', pruebas.id('curso'), 'Práctica'), 'm2');
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, 1, %L)', pruebas.id('curso'), pruebas.id('m1'), 'Postura'), 'l1');
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, 2, %L)', pruebas.id('curso'), pruebas.id('m1'), 'Ritmo'), 'l2');
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, 1, %L)', pruebas.id('curso'), pruebas.id('m2'), 'Sesión'), 'l3');
select pruebas.r(pruebas.p(1), format('private.draft_save_lesson(%L, %L, 1, %L, %L)', pruebas.id('curso'), pruebas.id('l1'), 'Postura', 'Sentada, con la espalda recta.'));
select pruebas.video(1, 'curso', 'l1') as v1 \gset
select pruebas.video(1, 'curso', 'l2') as v2 \gset
select pruebas.video(1, 'curso', 'l3') as v3 \gset
select pruebas.recurso(1, 'curso', null, 'Temario') as rc \gset
select pruebas.recurso(1, 'curso', 'l1', 'Guía') as rl \gset

select pruebas.armar(2, 'propio', 'De quien revisa');
select pruebas.armar(2, 'gemelo', 'Respirar');
select pruebas.armar(1, 'prueba', 'Con video de prueba', 'test');
select pruebas.armar(1, 'huerfano', 'Sin original');
select pruebas.armar(1, 'borrador', 'Nunca enviado');

-- ---------------------------------------------------------------------------------------
-- Antes de enviar no hay nada que aprobar.

select is(pruebas.aprobar(pruebas.p(3), 'borrador'), 'not_pending', 'un borrador no se aprueba');
select is(pruebas.rj(pruebas.p(3), format('private.review_approve_assets(%L)', pruebas.id('borrador'))) ->> 'answer', 'not_pending', 'ni se piden sus videos');

select is(pruebas.enviar(1, 'curso'), 'submitted', 'el maestro envía');
select is(pruebas.enviar(2, 'propio'), 'submitted', 'quien revisa envía uno suyo');
select is(pruebas.enviar(2, 'gemelo'), 'submitted', 'y otro con el mismo título que el primero');
select is(pruebas.enviar(1, 'prueba'), 'submitted', 'uno con video del proveedor de prueba');
select is(pruebas.enviar(1, 'huerfano'), 'submitted', 'y uno más');

-- ---------------------------------------------------------------------------------------
-- Lo que el servidor le pregunta a Mux antes de aprobar.

select is(
  pruebas.rj(pruebas.p(3), format('private.review_approve_assets(%L)', pruebas.id('curso'))) -> 'assets' -> 0,
  jsonb_build_object('video', :'v1', 'lesson', pruebas.id('l1'), 'provider', 'mux', 'asset', 'asset-' || :'v1', 'playback', 'play-' || :'v1'),
  'cada video de lo enviado, con su asset y la reproducción que se publica');
select is(jsonb_array_length(pruebas.rj(pruebas.p(3), format('private.review_approve_assets(%L)', pruebas.id('curso'))) -> 'assets'), 3, 'los tres');
select is(pruebas.rj(pruebas.p(4), format('private.review_approve_assets(%L)', pruebas.id('curso'))) ->> 'answer', 'ok', 'leerlos no pide un código reciente');
select is(pruebas.rj(pruebas.p(5), format('private.review_approve_assets(%L)', pruebas.id('curso'))) ->> 'answer', 'forbidden', 'sin Contenido, no');
select is(pruebas.rj(pruebas.p(1), format('private.review_approve_assets(%L)', pruebas.id('curso'))) ->> 'answer', 'forbidden', 'ni su maestro');

-- ---------------------------------------------------------------------------------------
-- Cada respuesta, sin escribir nada antes de rechazar.

select is(pruebas.aprobar(pruebas.p(5), 'curso'), 'forbidden', 'sin Contenido, no se aprueba');
select is(pruebas.aprobar(pruebas.p(1), 'curso'), 'forbidden', 'ni su maestro');
select is(pruebas.aprobar(pruebas.p(4), 'curso'), 'needs_fresh_code', 'aprobar pide un código reciente');
select is((select pruebas.pide(pruebas.p(3), format('private.review_approve(%L, %L, %L)', gen_random_uuid(), pruebas.envio('curso'), '{}'))), 'not_found', 'un curso que no existe');
select is(pruebas.aprobar(pruebas.p(3), 'curso', 'all', gen_random_uuid()), 'changed', 'otro envío que el que se vio, no');
select is(pruebas.aprobar(pruebas.p(2), 'propio'), 'self', 'nadie aprueba lo suyo');

-- Un maestro suspendido, o con la cuenta suspendida: se queda en revisión (decisión de Sergio del 2026-11-03).
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'Prueba', suspension_notice = 'Prueba' where id = pruebas.m(1);
select is(pruebas.aprobar(pruebas.p(3), 'curso'), 'teacher_suspended', 'el curso de un maestro suspendido no se aprueba');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'active', suspended_at = null, suspension_reason = null, suspension_notice = null where id = pruebas.m(1);
select pruebas.suspender(pruebas.p(1));
select is(pruebas.aprobar(pruebas.p(3), 'curso'), 'teacher_suspended', 'ni el de una cuenta suspendida');
select pruebas.como_dueno_sistema();
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = pruebas.p(1);

-- Un anexo de borrador no se aprueba fuera de local (RN-16).
select pruebas.como_dueno();
select legal_document_id as anexo_firmado from public.licenses where course_review_id = pruebas.envio('curso') \gset
alter table public.licenses disable trigger user;
update public.licenses set legal_document_id = :'anexo0' where course_review_id = pruebas.envio('curso');
alter table public.licenses enable trigger user;
delete from private.local_flags where flag = 'legal_drafts';
select is(pruebas.aprobar(pruebas.p(3), 'curso'), 'annex_draft', 'con el anexo de borrador y fuera de local, no se aprueba');
select pruebas.como_dueno();
alter table public.licenses disable trigger user;
update public.licenses set legal_document_id = :'anexo_firmado' where course_review_id = pruebas.envio('curso');
alter table public.licenses enable trigger user;
insert into private.local_flags (flag) select 'legal_drafts' where :'con_borradores';

-- Una práctica que se desactivó mientras se revisaba.
alter table public.practices disable trigger user;
update public.practices set is_active = false where id = 'a7700000-0000-0000-0002-000000000001';
alter table public.practices enable trigger user;
select is(pruebas.aprobar(pruebas.p(3), 'curso'), 'practice_inactive', 'con la práctica desactivada, no');
select pruebas.como_dueno();
alter table public.practices disable trigger user;
update public.practices set is_active = true where id = 'a7700000-0000-0000-0002-000000000001';
alter table public.practices enable trigger user;

-- Sin subtítulos no se publica (RF-310; decisión de Sergio del 2026-11-03). Lo que Mux dijo se queda, aunque falte otro.
select is(pruebas.aprobar(pruebas.p(3), 'curso', 'none'), 'captions_pending', 'sin subtítulos, no se aprueba');
select is(pruebas.aprobar(pruebas.p(3), 'curso', 'first'), 'captions_pending', 'con los de uno solo, tampoco');
select is((select count(*)::integer from public.draft_videos where course_id = pruebas.id('curso') and captions_ready), 1, 'y lo que sí tiene queda anotado');
select ok((pruebas.de_cola('curso') -> 'submission' -> 'captions_missing') @> jsonb_build_array(pruebas.id('l2'), pruebas.id('l3')), 'la cola dice qué lecciones esperan sus subtítulos');
select is(jsonb_array_length(pruebas.de_cola('curso') -> 'submission' -> 'captions_missing'), 2, 'solo esas');

-- Un archivo que cambió por fuera: el original de un video, o un recurso.
select pruebas.como_dueno();
update storage.objects set version = 'v2' where bucket_id = 'video-originals' and name = (select storage_path from public.draft_videos where id = :'v2');
select is(pruebas.aprobar(pruebas.p(3), 'curso'), 'files_changed', 'un original reemplazado por fuera no se publica');
select pruebas.como_dueno();
update storage.objects set version = 'v1' where bucket_id = 'video-originals' and name = (select storage_path from public.draft_videos where id = :'v2');
update storage.objects set version = 'v2' where bucket_id = 'course-resources' and name = (select storage_path from public.draft_resources where id = :'rl');
select is(pruebas.aprobar(pruebas.p(3), 'curso'), 'files_changed', 'ni un recurso reemplazado');
select pruebas.como_dueno();
update storage.objects set version = 'v1' where bucket_id = 'course-resources' and name = (select storage_path from public.draft_resources where id = :'rl');
select pruebas.como_dueno();
update storage.objects set name = name || '.movido' where bucket_id = 'video-originals' and name = (select storage_path from public.draft_videos where id = :'v3');
select is(pruebas.aprobar(pruebas.p(3), 'curso'), 'files_changed', 'ni un original que ya no está');
select pruebas.como_dueno();
update storage.objects set name = (select storage_path from public.draft_videos where id = :'v3')
where bucket_id = 'video-originals' and name = (select storage_path from public.draft_videos where id = :'v3') || '.movido';

select is(pruebas.estado('curso'), 'in_review', 'tras cada rechazo el curso sigue en revisión');
select is((select count(*)::integer from public.published_courses where course_id = pruebas.id('curso')), 0, 'sin nada publicado');
select is((select result::text from public.course_reviews where id = pruebas.envio('curso')), 'pending', 'y el envío pendiente');

-- ---------------------------------------------------------------------------------------
-- Aprobar publica desde la fotografía.

select is(pruebas.aprobar(pruebas.p(3), 'curso'), 'approved', 'Contenido aprueba');
select is(pruebas.estado('curso'), 'published', 'el curso queda publicado');
select isnt((select first_published_at from public.course_registry where course_id = pruebas.id('curso')), null, 'con su fecha');
select is((select result::text from public.course_reviews where id = pruebas.envio('curso')), 'approved', 'el envío queda aprobado');
select is((select reviewed_by from public.course_reviews where id = pruebas.envio('curso')), pruebas.p(3), 'por quien lo aprobó');

select is(
  (select jsonb_build_object('slug', c.slug, 'title', c.title, 'summary', c.summary, 'teacher_name', c.teacher_name, 'practice', c.practice_id, 'level', c.level_id,
                             'lessons', c.lesson_count, 'seconds', c.total_duration_seconds, 'listed', c.is_listed, 'review', c.course_review_id)
   from public.published_courses c where c.course_id = pruebas.id('curso')),
  jsonb_build_object('slug', 'respirar', 'title', 'Respirar', 'summary', 'Un resumen.', 'teacher_name', 'Ana Luz',
                     'practice', 'a7700000-0000-0000-0002-000000000001', 'level', 'a7700000-0000-0000-0002-000000000002',
                     'lessons', 3, 'seconds', 900, 'listed', true, 'review', pruebas.envio('curso')),
  'el curso, con su slug del título, su maestro, lo que dura, listado y con el envío que lo publicó');
select is((select is_listed from public.published_teachers where teacher_id = pruebas.m(1)), true, 'y la ficha de su maestro, listada');

select is(
  (select array_agg(m.id::text || ':' || m.position || ':' || m.title order by m.position) from public.published_modules m where m.course_id = pruebas.id('curso')),
  array[pruebas.id('m1')::text || ':1:Inicio', pruebas.id('m2')::text || ':2:Práctica'],
  'los módulos, con los mismos ids y su orden');
select is(
  (select array_agg(l.id::text || ':' || l.position || ':' || l.module_id::text order by l.position) from public.published_lessons l where l.course_id = pruebas.id('curso')),
  array[pruebas.id('l1')::text || ':1:' || pruebas.id('m1')::text, pruebas.id('l2')::text || ':2:' || pruebas.id('m1')::text,
        pruebas.id('l3')::text || ':3:' || pruebas.id('m2')::text],
  'las lecciones, con los mismos ids y numeradas en el curso entero');
select is((select description from public.published_lessons where id = pruebas.id('l1')), 'Sentada, con la espalda recta.', 'con su descripción');
select is((select video_asset_id from public.published_lessons where id = pruebas.id('l1')), :'v1'::uuid, 'y su video, con el mismo id');
select ok((select bool_and(has_captions and duration_seconds = 300 and is_current) from public.published_lessons where course_id = pruebas.id('curso')), 'con subtítulos y lo que dura');

select is(
  (select jsonb_build_object('lesson', a.lesson_id, 'provider', a.provider, 'asset', a.provider_asset_id, 'playback', a.provider_playback_id, 'status', a.status,
                             'seconds', a.duration_seconds, 'captions', a.captions_ready, 'original', a.original_path, 'size', a.original_size_bytes,
                             'file_name', a.file_name, 'mime', a.mime, 'object_version', a.object_version, 'read_seconds', a.read_seconds, 'by', a.created_by)
   from public.video_assets a where a.id = :'v1'),
  jsonb_build_object('lesson', pruebas.id('l1'), 'provider', 'mux', 'asset', 'asset-' || :'v1', 'playback', 'play-' || :'v1', 'status', 'ready',
                     'seconds', 300, 'captions', true, 'original', pruebas.m(1)::text || '/' || pruebas.id('curso')::text || '/' || :'v1', 'size', 1000,
                     'file_name', 'clase.mp4', 'mime', 'video/mp4', 'object_version', 'v1', 'read_seconds', 300, 'by', pruebas.p(1)),
  'cada video, con su original (RNF-17) y lo que el borrador necesita para volver');
select isnt((select original_archived_at from public.video_assets where id = :'v1'), null, 'con la fecha del original');
select is((select object_id from public.video_assets where id = :'v1'), (select id from storage.objects where bucket_id = 'video-originals' and name = pruebas.m(1)::text || '/' || pruebas.id('curso')::text || '/' || :'v1'), 'y el objeto que se revisó');

select is(
  (select array_agg(r.id::text || ':' || coalesce(r.lesson_id::text, 'curso') || ':' || r.title || ':' || r.position order by r.title) from public.published_resources r where r.course_id = pruebas.id('curso')),
  array[:'rl' || ':' || pruebas.id('l1')::text || ':Guía:1', :'rc' || ':curso:Temario:1'],
  'los recursos, con los mismos ids y su lugar');
select is((select storage_path from public.published_resources where id = :'rc'), (select name from storage.objects where bucket_id = 'course-resources' and name like '%' || :'rc'), 'con la misma ruta');

-- El borrador se va (05 §5.2), y nada queda en la papelera ni sobra en la cubeta.
select is((select count(*)::integer from public.course_drafts where course_id = pruebas.id('curso')), 0, 'el borrador se borra');
select is((select count(*)::integer from public.draft_videos where course_id = pruebas.id('curso')), 0, 'con sus videos');
select is((select count(*)::integer from private.video_trash where course_id = pruebas.id('curso')), 0, 'y nada de lo publicado queda en la papelera');
select is(pruebas.barrido('curso'), '{}', 'ni sobra en la cubeta: lo publicado nombra cada original');

select is(pruebas.aprobar(pruebas.p(3), 'curso'), 'not_pending', 'aprobar dos veces contesta not_pending');
select is(pruebas.de_cola('curso'), null, 'y ya no está en la cola');
select is(private.catalog_in_use('practices', 'a7700000-0000-0000-0002-000000000001') >= 1, true, '«en uso» lo sigue contando');

-- El mismo título, otro slug.
select is(pruebas.aprobar(pruebas.p(3), 'gemelo'), 'approved', 'un curso con el mismo título se aprueba');
select is((select slug from public.published_courses where course_id = pruebas.id('gemelo')), 'respirar-2', 'con otro slug');

-- ---------------------------------------------------------------------------------------
-- Sin `original_path`, el original quedaría huérfano y el repaso lo borraría: la prueba de que se escribe.

select is(pruebas.aprobar(pruebas.p(3), 'huerfano'), 'approved', 'se aprueba otro');
select is(pruebas.barrido('huerfano'), '{}', 'y su original no sobra');
select pruebas.como_dueno();
alter table public.video_assets disable trigger user;
update public.video_assets set original_path = null, original_archived_at = null where course_id = pruebas.id('huerfano');
alter table public.video_assets enable trigger user;
select is(pruebas.barrido('huerfano'), array['orphan'], 'sin la ruta, el repaso lo daría por huérfano');
select pruebas.como_dueno();
alter table public.video_assets disable trigger user;
update public.video_assets a set original_path = pruebas.m(1)::text || '/' || pruebas.id('huerfano')::text || '/' || a.id::text, original_archived_at = now()
where a.course_id = pruebas.id('huerfano');
alter table public.video_assets enable trigger user;

-- ---------------------------------------------------------------------------------------
-- Un video del proveedor de prueba: solo con la marca local de los videos de prueba.

select pruebas.como_dueno();
delete from private.local_flags where flag = 'video_test';
select throws_ok(format('select pruebas.aprobar(%L, %L)', pruebas.p(3), 'prueba'), '42501', null, 'sin la marca, un video de prueba no se publica');
select pruebas.como_dueno();
select is(pruebas.estado('prueba'), 'in_review', 'y el curso sigue en revisión');
insert into private.local_flags (flag) values ('video_test');
select is(pruebas.aprobar(pruebas.p(3), 'prueba'), 'approved', 'con ella, sí');
select is((select provider from public.video_assets where course_id = pruebas.id('prueba')), 'test', 'con su proveedor');

-- ---------------------------------------------------------------------------------------
-- Quién las ejecuta, y el vigilante.

select pruebas.como_dueno();
select ok(
  (select bool_and(has_function_privilege('app_service', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
   from unnest(array['private.review_approve(uuid, uuid, uuid[])', 'private.review_approve_assets(uuid)']) f),
  'aprobar y sus videos son del servidor, y de nadie más');
select ok(
  (select bool_and(not has_function_privilege(r, f, 'execute'))
   from unnest(array['private.review_publish(uuid, uuid, uuid[])']) f
   cross join unnest(array['app_service', 'authenticated', 'anon']) r),
  'publicar no lo ejecuta nadie de la aplicación');
select is(pruebas.vigila(), '{}', 'el área está limpia');
select pg_get_functiondef('private.review_approve(uuid, uuid, uuid[])'::regprocedure) as antes \gset
create or replace function private.review_approve(p_course uuid, p_submission uuid, p_captions uuid[]) returns text
language plpgsql security definer set search_path = '' as $$ begin return private.content_change_gate(); end $$;
select ok('submission function without its rule actor_owns_teacher' = any(pruebas.vigila()), 'aprobar sin mirar de quién es se nota');
select :'antes' \gexec
select is(pruebas.vigila(), '{}', 'y al deshacerlo queda limpia');

select * from finish();
