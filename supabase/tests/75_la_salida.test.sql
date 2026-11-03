-- T-405, segunda solicitud · La salida de la revisión (RF-607, RF-701, FL-35, FL-45). Lo enviado por el editor entra a la cola por su fotografía, en un mapa cerrado; Contenido lo
-- devuelve con motivo y qué corregir, y el curso vuelve a borrador; su maestro lee el motivo y puede corregir, reenviar o borrar, y la prueba se queda. Los envíos se fuerzan aquí con
-- las funciones de la primera solicitud: la aplicación todavía no envía. Pasa con los borradores legales cargados y sin ellos.
begin;
\ir _ayuda.psql
select plan(99);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a7500000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.m(p_n integer) returns uuid language sql immutable
as $$ select ('a7500000-0000-0000-0001-' || lpad(p_n::text, 12, '0'))::uuid $$;
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
-- Un curso de una lección con su video: listo para enviar.
create function pruebas.armar(p_n integer, p_k text, p_title text) returns void
language plpgsql as $$
declare
  v_video uuid := gen_random_uuid();
begin
  perform pruebas.r(pruebas.p(p_n), format('private.draft_create(%L, %L)', gen_random_uuid(), p_title), p_k);
  perform pruebas.r(pruebas.p(p_n), format('private.draft_save_course(%L, 1, %L, %L, %L, %L)', pruebas.id(p_k), p_title, 'Un resumen.',
          'a7500000-0000-0000-0002-000000000001', 'a7500000-0000-0000-0002-000000000002'));
  perform pruebas.r(pruebas.p(p_n), format('private.draft_add_module(%L, 1, %L)', pruebas.id(p_k), 'Inicio'), p_k || '-m');
  perform pruebas.r(pruebas.p(p_n), format('private.draft_add_lesson(%L, %L, 1, %L)', pruebas.id(p_k), pruebas.id(p_k || '-m'), 'Primera'), p_k || '-l');
  perform pruebas.como_dueno();
  insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                   provider, provider_asset_id, provider_playback_id, duration_seconds)
  values (v_video, pruebas.id(p_k), pruebas.m(p_n), pruebas.id(p_k || '-l'), 'ready', true, 'clase.mp4', 'video/mp4', 'ruta/' || v_video, 1000, gen_random_uuid(), 'v1', 600,
          'mux', 'asset-' || v_video, 'play-' || v_video, 600);
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
create function pruebas.devolver(p_id uuid, p_k text, p_reason text default 'El audio se corta.', p_fix text default 'Vuelve a subir la lección 1.', p_submission uuid default null) returns text
language plpgsql as $$
declare
  v text;
  v_submission uuid := coalesce(p_submission, pruebas.envio(p_k));
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.review_return(pruebas.id(p_k), v_submission, p_reason, p_fix);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.cola(p_id uuid) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.review_queue();
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.de_cola(p_k text, p_id uuid default null) returns jsonb
language sql as $$
  select c from jsonb_array_elements(pruebas.cola(coalesce(p_id, pruebas.p(3))) -> 'courses') c where c ->> 'course_id' = pruebas.id(p_k)::text
$$;
create function pruebas.notas(p_id uuid) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.course_return_notes();
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.nota(p_id uuid, p_k text) returns jsonb
language sql as $$
  select n from jsonb_array_elements(pruebas.notas(p_id)) n where n ->> 'course_id' = pruebas.id(p_k)::text
$$;
create function pruebas.objeto_de(p_id uuid, p_resource uuid) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.review_resource_object(p_resource);
  perform pruebas.limpiar();
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
select pruebas.alta(pruebas.p(n), 'salida-' || n || '@prueba.test'), pruebas.confirmar(pruebas.p(n)) from generate_series(1, 5) n;
select pruebas.maestro(n) from generate_series(1, 2) n;
select pruebas.dar_capacidad(pruebas.p(n), 'content') from generate_series(2, 4) n;
select pruebas.equipar(pruebas.p(n)) from generate_series(2, 4) n;
select pruebas.limpiar();
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '1 hour' where session_id = pruebas.sesion(pruebas.p(4));

select pruebas.como_dueno_sistema();
insert into public.practices (id, slug, name, position, cover_tone) values ('a7500000-0000-0000-0002-000000000001', 'salida-practica', 'Salida práctica', 902, 1);
insert into public.levels (id, slug, name, position) values ('a7500000-0000-0000-0002-000000000002', 'salida-nivel', 'Salida nivel', 902);
insert into public.legal_documents (doc_type, version, title, body, effective_from)
values ('license_annex', 1, 'Anexo de licencia', 'El texto completo del anexo.', now());
select pruebas.como_dueno();

select pruebas.armar(1, 'curso', 'Respirar');
select pruebas.armar(1, 'segundo', 'Dormir');
select pruebas.armar(2, 'propio', 'De quien revisa');
select pruebas.armar(1, 'sin-enviar-antes', 'Nunca enviado');

-- Dos recursos: uno de la lección y otro del curso.
insert into storage.objects (id, bucket_id, name, version, metadata)
values ('a7500000-0000-0000-0004-000000000001', 'course-resources', 'salida/guia', 'v1', jsonb_build_object('size', 100, 'mimetype', 'application/pdf')),
       ('a7500000-0000-0000-0004-000000000002', 'course-resources', 'salida/temario', 'v1', jsonb_build_object('size', 100, 'mimetype', 'application/pdf'));
insert into public.draft_resources (id, course_id, teacher_id, lesson_id, title, kind, mime, storage_path, size_bytes, state, position, object_id, object_version)
values ('a7500000-0000-0000-0003-000000000001', pruebas.id('curso'), pruebas.m(1), pruebas.id('curso-l'), 'Guía', 'pdf', 'application/pdf', 'salida/guia', 100, 'ready', 1,
        'a7500000-0000-0000-0004-000000000001', 'v1'),
       ('a7500000-0000-0000-0003-000000000002', pruebas.id('curso'), pruebas.m(1), null, 'Temario', 'pdf', 'application/pdf', 'salida/temario', 100, 'ready', 1,
        'a7500000-0000-0000-0004-000000000002', 'v1');

-- ---------------------------------------------------------------------------------------
-- La cola: lo que no se envió no está.

select is(pruebas.de_cola('curso'), null, 'un borrador sin enviar no entra a la cola');
select is(pruebas.enviar(1, 'curso'), 'submitted', 'el maestro envía');
select is(pruebas.enviar(1, 'segundo'), 'submitted', 'y envía otro');
select is(pruebas.enviar(2, 'propio'), 'submitted', 'y quien revisa envía uno suyo');

-- En una transacción, todos enviaron «ahora»: el primero se mueve hacia atrás, con el guardián apagado.
select pruebas.como_dueno();
alter table public.course_reviews disable trigger user;
update public.course_reviews set submitted_at = now() - interval '2 days' where course_id = pruebas.id('curso');
alter table public.course_reviews enable trigger user;

select is(pruebas.cola(pruebas.p(5)), null, 'sin Contenido, la cola es nula');
select is(pruebas.cola(pruebas.p(1)), null, 'también para el maestro del curso');
select isnt(pruebas.de_cola('curso'), null, 'con Contenido, lo enviado está en la cola');
select isnt(pruebas.de_cola('curso', pruebas.p(4)), null, 'leerla no pide un código reciente');

-- Por su fotografía, en un mapa cerrado.
select is(pruebas.de_cola('curso') ->> 'title', 'Respirar', 'con su título');
select is(pruebas.de_cola('curso') ->> 'summary', 'Un resumen.', 'y su resumen');
select is(pruebas.de_cola('curso') ->> 'practice', 'Salida práctica', 'su práctica');
select is(pruebas.de_cola('curso') ->> 'level', 'Salida nivel', 'y su nivel');
select is((pruebas.de_cola('curso') ->> 'lesson_count')::integer, 1, 'cuenta las lecciones');
select is((pruebas.de_cola('curso') ->> 'total_duration_seconds')::integer, 600, 'y suma lo que duran');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pruebas.de_cola('curso') -> 'lessons' -> 0) k),
  array['description', 'duration_seconds', 'lesson_id', 'module', 'module_id', 'resources', 'title', 'video'],
  'una lección da solo lo que la pantalla pinta');
select is(pruebas.de_cola('curso') -> 'lessons' -> 0 ->> 'lesson_id', pruebas.id('curso-l')::text, 'con su id');
select is(pruebas.de_cola('curso') -> 'lessons' -> 0 ->> 'video', 'playable', 'y un video de Mux se puede ver');
select is(
  pruebas.de_cola('curso') -> 'lessons' -> 0 -> 'resources',
  jsonb_build_array(jsonb_build_object('id', 'a7500000-0000-0000-0003-000000000001', 'title', 'Guía', 'kind', 'pdf', 'size_bytes', 100)),
  'con sus recursos, sin ruta ni objeto');
select is(
  pruebas.de_cola('curso') -> 'submission' -> 'resources',
  jsonb_build_array(jsonb_build_object('id', 'a7500000-0000-0000-0003-000000000002', 'title', 'Temario', 'kind', 'pdf', 'size_bytes', 100)),
  'y los del curso van aparte');
select is(pruebas.de_cola('curso') -> 'submission' ->> 'id', pruebas.envio('curso')::text, 'dice cuál es el envío, para devolverlo');
select is((pruebas.de_cola('curso') -> 'submission' ->> 'number')::integer, 1, 'y su número');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pruebas.de_cola('curso') -> 'submission' -> 'annex') k),
  array['accepted_at', 'statement', 'term_years', 'version'],
  'del anexo aceptado, solo versión, fecha, frase y plazo');
select is((pruebas.de_cola('curso') -> 'submission' -> 'annex' ->> 'version')::integer, 1, 'con la versión aceptada');
select ok((pruebas.de_cola('curso') -> 'submission' -> 'annex' ->> 'statement') like '%«Respirar»%', 'y la frase nombra el curso');
select ok(not (pruebas.cola(pruebas.p(3))::text ~ 'ruta/|salida/|asset-|play-|203\.0\.113|Navegador|sha256|object_'),
  'la cola no da rutas, identificadores del proveedor, huella ni origen');
select is(
  (select array_agg(c ->> 'title' order by o) from jsonb_array_elements(pruebas.cola(pruebas.p(3)) -> 'courses') with ordinality e (c, o)
   where c ->> 'course_id' in (pruebas.id('curso')::text, pruebas.id('segundo')::text)),
  array['Respirar', 'Dormir'],
  'el más antiguo primero');

-- La fotografía manda sobre el borrador.
select pruebas.como_dueno();
alter table public.course_drafts disable trigger user;
update public.course_drafts set title = 'Otro título' where course_id = pruebas.id('segundo');
alter table public.course_drafts enable trigger user;
select is(pruebas.de_cola('segundo') ->> 'title', 'Dormir', 'lo que se revisa es lo que se envió');
select pruebas.como_dueno();
alter table public.course_drafts disable trigger user;
update public.course_drafts set title = 'Dormir' where course_id = pruebas.id('segundo');
alter table public.course_drafts enable trigger user;

-- Aprobar todavía no publica lo del editor: llega con la cuarta solicitud.
select is((select pruebas.pide(pruebas.p(3), format('private.approve_course(%L)', pruebas.id('curso')))), 'incomplete', 'aprobar lo del editor contesta incomplete');

-- ---------------------------------------------------------------------------------------
-- Los recursos, para Contenido.

select is(pruebas.objeto_de(pruebas.p(3), 'a7500000-0000-0000-0003-000000000001') ->> 'path', 'salida/guia', 'Contenido baja un recurso de lo enviado');
select is(pruebas.objeto_de(pruebas.p(4), 'a7500000-0000-0000-0003-000000000001') ->> 'path', 'salida/guia', 'sin pedir un código reciente');
select is(pruebas.objeto_de(pruebas.p(5), 'a7500000-0000-0000-0003-000000000001'), null, 'sin Contenido, no');
select is(pruebas.objeto_de(pruebas.p(1), 'a7500000-0000-0000-0003-000000000001'), null, 'por aquí tampoco su maestro, que tiene su propia puerta');
update storage.objects set version = 'v2' where id = 'a7500000-0000-0000-0004-000000000001';
select is(pruebas.objeto_de(pruebas.p(3), 'a7500000-0000-0000-0003-000000000001'), null, 'un archivo reemplazado por fuera no se entrega');
update storage.objects set version = 'v1' where id = 'a7500000-0000-0000-0004-000000000001';

-- Y el video: Contenido lo ve mientras se revisa.
select is(pruebas.rj(pruebas.p(3), format('private.video_preview(%L, %L)', pruebas.id('curso'), pruebas.id('curso-l'))) ->> 'answer', 'ok', 'Contenido ve el video de lo enviado');
select is(pruebas.rj(pruebas.p(3), format('private.video_preview(%L, %L)', pruebas.id('curso'), pruebas.id('curso-l'))) ->> 'email', 'salida-3@prueba.test', 'con su correo, para la marca de agua');
select is(pruebas.rj(pruebas.p(5), format('private.video_preview(%L, %L)', pruebas.id('curso'), pruebas.id('curso-l'))) ->> 'answer', 'not_found', 'sin Contenido, no');
select is(pruebas.rj(pruebas.p(3), format('private.video_preview(%L, %L)', pruebas.id('sin-enviar-antes'), pruebas.id('sin-enviar-antes-l'))) ->> 'answer', 'not_found', 'un borrador sin enviar, tampoco: solo lo ve su maestro');
select is(pruebas.rj(pruebas.p(1), format('private.video_preview(%L, %L)', pruebas.id('sin-enviar-antes'), pruebas.id('sin-enviar-antes-l'))) ->> 'answer', 'ok', 'su maestro sí');

-- ---------------------------------------------------------------------------------------
-- Devolver: cada respuesta, sin escribir nada antes de rechazar.

select is(pruebas.devolver(pruebas.p(5), 'curso'), 'forbidden', 'sin Contenido, no se devuelve');
select is(pruebas.devolver(pruebas.p(1), 'curso'), 'forbidden', 'ni su maestro');
select is(pruebas.devolver(pruebas.p(4), 'curso'), 'needs_fresh_code', 'devolver sí pide un código reciente');
select is(pruebas.devolver(pruebas.p(3), 'propio', 'Motivo.', 'Corrección.'), 'returned', 'otra persona con Contenido devuelve el de quien revisa');
select is(pruebas.enviar(2, 'propio'), 'submitted', 'y vuelve a enviarlo');
select is(pruebas.devolver(pruebas.p(2), 'propio'), 'self', 'nadie devuelve lo suyo');
-- Una invitación a su correo cuenta como suyo, también revocada: si no, alguien se devuelve su curso y acepta después.
select pruebas.como_dueno_sistema();
insert into private.teacher_invitations (teacher_id, email, created_at, expires_at, revoked_at)
values (pruebas.m(1), 'salida-3@prueba.test', now(), now() + interval '1 day', now());
select is(pruebas.devolver(pruebas.p(3), 'segundo'), 'self', 'una invitación de ese maestro a su correo cuenta como suyo');
select pruebas.como_dueno_sistema();
delete from private.teacher_invitations where email = 'salida-3@prueba.test';
select pruebas.como_dueno();
select is(pruebas.devolver(pruebas.p(3), 'curso', '   '), 'invalid', 'un motivo de solo espacios no vale');
select is(pruebas.devolver(pruebas.p(3), 'curso', E'\n\n'), 'invalid', 'ni de solo saltos de línea');
select is(pruebas.devolver(pruebas.p(3), 'curso', null), 'invalid', 'ni sin motivo');
select is(pruebas.devolver(pruebas.p(3), 'curso', repeat('a', 2001)), 'invalid', 'ni uno demasiado largo');
select is(pruebas.devolver(pruebas.p(3), 'curso', 'Motivo.', ' '), 'invalid', 'qué corregir también es obligatorio');
select is(pruebas.devolver(pruebas.p(3), 'curso', 'Motivo.', null), 'invalid', 'también sin nada');
select is(pruebas.devolver(pruebas.p(3), 'curso', 'Motivo.', 'Corrección.', gen_random_uuid()), 'changed', 'un formulario de otro envío contesta changed');
select is(
  (select pruebas.pide(pruebas.p(3), format('private.review_return(%L, %L, %L, %L)', gen_random_uuid(), gen_random_uuid(), 'Motivo.', 'Corrección.'))),
  'not_found', 'un curso que no existe');
select pruebas.armar(1, 'sin-enviar', 'Sin enviar');
select is(pruebas.devolver(pruebas.p(3), 'sin-enviar', 'Motivo.', 'Corrección.', gen_random_uuid()), 'not_pending', 'lo que no está en revisión');
select pruebas.como_dueno();
select results_eq(
  format($$select c.result::text, c.reason, r.state::text from public.course_reviews c join public.course_registry r on r.course_id = c.course_id where c.course_id = %L$$, pruebas.id('curso')),
  $$values ('pending', null::text, 'in_review')$$,
  'nada de eso escribió');

select is(pruebas.devolver(pruebas.p(3), 'curso', E'  El audio se corta.\nEn la lección 1.  ', 'Vuelve a subir la lección 1.'), 'invalid', 'con espacios en las puntas tampoco: los quita quien llama');
select is(pruebas.devolver(pruebas.p(3), 'curso'), 'returned', 'con motivo y qué corregir, se devuelve');
select pruebas.como_dueno();
select results_eq(
  format($$select c.result::text, c.reviewed_by, c.reason, c.what_to_fix, c.reviewed_at is not null, r.state::text
           from public.course_reviews c join public.course_registry r on r.course_id = c.course_id where c.course_id = %L$$, pruebas.id('curso')),
  format($$values ('rejected', %L::uuid, 'El audio se corta.', 'Vuelve a subir la lección 1.', true, 'draft')$$, pruebas.p(3)),
  'queda decidido, con quién y por qué, y el curso vuelve a borrador');
select is((select count(*)::integer from public.licenses l where l.course_id = pruebas.id('curso')), 1, 'su licencia se queda');
select results_eq(
  format($$select category::text, new_value ? 'content_snapshot', new_value ->> 'reason', new_value ->> 'what_to_fix' from public.audit_log
           where action = 'course_reviews.update' and entity_id = %L$$, pruebas.envio('curso')),
  $$values ('content', false, 'El audio se corta.', 'Vuelve a subir la lección 1.')$$,
  'y se audita, sin la fotografía');
select is(pruebas.de_cola('curso'), null, 'ya no está en la cola');
select is(pruebas.devolver(pruebas.p(3), 'curso'), 'not_pending', 'una segunda vez contesta not_pending');

-- Una decisión no cambia, ni se escribe a medias.
select pruebas.como_dueno();
select throws_ok(format($$update public.course_reviews set what_to_fix = 'Otra cosa.' where id = %L$$, pruebas.envio('curso')), '42501', null, 'lo decidido no cambia');
select throws_ok(format($$update public.course_reviews set result = 'rejected', reviewed_by = %L, reviewed_at = now(), reason = 'Motivo.' where id = %L$$, pruebas.p(3), pruebas.envio('segundo')),
  '23514', null, 'la base no guarda un rechazo sin qué corregir');
select throws_ok(format($$update public.course_reviews set result = 'approved', reviewed_by = %L, reviewed_at = now(), reason = 'Motivo.' where id = %L$$, pruebas.p(3), pruebas.envio('segundo')),
  '23514', null, 'ni un motivo en lo que no se rechazó');
select throws_ok(format($$update public.course_reviews set what_to_fix = 'Motivo.' where id = %L$$, pruebas.envio('segundo')), '42501', null, 'ni escribe el motivo sin decidir');

-- Quién la ejecuta.
select ok(has_function_privilege('app_service', 'private.review_return(uuid, uuid, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'private.review_return(uuid, uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'private.review_return(uuid, uuid, text, text)', 'execute'), 'devolver es del servidor, y de nadie más');

-- ---------------------------------------------------------------------------------------
-- El maestro lee por qué.

select is(pruebas.nota(pruebas.p(1), 'curso') ->> 'reason', 'El audio se corta.', 'su maestro lee el motivo');
select is(pruebas.nota(pruebas.p(1), 'curso') ->> 'what_to_fix', 'Vuelve a subir la lección 1.', 'y qué corregir');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pruebas.nota(pruebas.p(1), 'curso')) k),
  array['course_id', 'reason', 'returned_at', 'what_to_fix'],
  'sin decir quién lo devolvió');
select is(pruebas.nota(pruebas.p(2), 'curso'), null, 'otro maestro no lo lee');
select is(pruebas.notas(pruebas.p(3)), '[]'::jsonb, 'quien no es maestro no tiene notas');
select is(pruebas.nota(pruebas.p(1), 'segundo'), null, 'lo que sigue en revisión no tiene nota');

-- El curso se abre otra vez, y un formulario viejo no vale.
select is(pruebas.r(pruebas.p(1), format('private.draft_save_course(%L, 2, %L, %L, %L, %L)', pruebas.id('curso'), 'Respirar mejor', 'Un resumen.',
       'a7500000-0000-0000-0002-000000000001', 'a7500000-0000-0000-0002-000000000002')), 'saved', 'el maestro puede corregir');
select pruebas.envio('curso') as primero \gset
select is(pruebas.enviar(1, 'curso'), 'submitted', 'y reenviar');
select is(pruebas.nota(pruebas.p(1), 'curso'), null, 'con el reenvío, la nota se va');
-- Un rechazo seguido de un envío pendiente, con el curso forzado a borrador: la nota mira solo el último.
select pruebas.como_dueno();
alter table public.course_registry disable trigger user;
update public.course_registry set state = 'draft' where course_id = pruebas.id('curso');
alter table public.course_registry enable trigger user;
select is(pruebas.nota(pruebas.p(1), 'curso'), null, 'el rechazo de antes no sale si el último está pendiente');
select pruebas.como_dueno();
alter table public.course_registry disable trigger user;
update public.course_registry set state = 'in_review' where course_id = pruebas.id('curso');
alter table public.course_registry enable trigger user;
select is(pruebas.de_cola('curso') ->> 'title', 'Respirar mejor', 'y la cola ve lo corregido');
select is((pruebas.de_cola('curso') -> 'submission' ->> 'number')::integer, 2, 'con su número');
select is(pruebas.devolver(pruebas.p(3), 'curso', 'Otro.', 'Otra.', :'primero'), 'changed', 'devolver con el envío de antes no vale');
select is(pruebas.devolver(pruebas.p(3), 'curso', 'Falta luz.', 'Vuelve a grabar.'), 'returned', 'se devuelve otra vez');
select is(pruebas.nota(pruebas.p(1), 'curso') ->> 'reason', 'Falta luz.', 'y la nota es la del último');

-- Un maestro suspendido lo sigue leyendo.
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'Prueba', suspension_notice = 'Prueba' where id = pruebas.m(1);
select is(pruebas.nota(pruebas.p(1), 'curso') ->> 'reason', 'Falta luz.', 'también suspendido');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'active', suspended_at = null, suspension_reason = null, suspension_notice = null where id = pruebas.m(1);
select pruebas.como_dueno();

-- Dos estados que hoy no se alcanzan sin forzar la base: las defensas no dependen de que nunca lleguen.
select pruebas.como_dueno();
alter table public.course_registry disable trigger user;
update public.course_registry set state = 'draft' where course_id = pruebas.id('segundo');
alter table public.course_registry enable trigger user;
select is(pruebas.devolver(pruebas.p(3), 'segundo'), 'not_pending', 'un envío pendiente con el curso fuera de revisión no se devuelve');
select is(pruebas.nota(pruebas.p(1), 'segundo'), null, 'y lo pendiente no da nota, aunque el curso esté en borrador');
select pruebas.como_dueno();
alter table public.course_registry disable trigger user;
update public.course_registry set state = 'in_review' where course_id = pruebas.id('segundo');
update public.course_registry set state = 'published', first_published_at = now() where course_id = pruebas.id('curso');
alter table public.course_registry enable trigger user;
select is(pruebas.nota(pruebas.p(1), 'curso'), null, 'un curso que ya no es borrador no da nota, aunque su último envío se haya rechazado');
select pruebas.como_dueno();
alter table public.course_registry disable trigger user;
update public.course_registry set state = 'draft', first_published_at = null where course_id = pruebas.id('curso');
alter table public.course_registry enable trigger user;

-- Lo devuelto ya no se revisa.
select is(pruebas.rj(pruebas.p(3), format('private.video_preview(%L, %L)', pruebas.id('curso'), pruebas.id('curso-l'))) ->> 'answer', 'not_found', 'de vuelta en borrador, Contenido ya no ve su video');
select is(pruebas.objeto_de(pruebas.p(3), 'a7500000-0000-0000-0003-000000000001'), null, 'de vuelta en borrador, Contenido ya no baja sus recursos');

-- Borrar lo rechazado se lleva el curso, y la prueba se queda.
select is(pruebas.r(pruebas.p(1), format('private.draft_delete_course(%L, %s)', pruebas.id('curso'), (select content_revision from public.course_drafts where course_id = pruebas.id('curso')))),
  'deleted', 'el maestro borra lo rechazado');
select pruebas.como_dueno();
select is((select count(*)::integer from public.course_reviews c where c.course_id = pruebas.id('curso')), 2, 'sus envíos se quedan');
select is((select count(*)::integer from public.licenses l where l.course_id = pruebas.id('curso')), 2, 'y sus licencias');
select is(pruebas.nota(pruebas.p(1), 'curso'), null, 'y la nota ya no sale');

-- ---------------------------------------------------------------------------------------
-- El vigilante conoce lo nuevo.

select is(pruebas.vigila(), '{}', 'el área está limpia');
grant execute on function private.review_return(uuid, uuid, text, text) to authenticated;
select ok('submission function executable by authenticated' = any(pruebas.vigila()), 'devolver en manos de la persona se nota');
revoke execute on function private.review_return(uuid, uuid, text, text) from authenticated;
alter table public.course_reviews drop constraint course_reviews_rejection_has_fix;
select ok('evidence table without constraint course_reviews_rejection_has_fix' = any(pruebas.vigila()), 'un rechazo sin qué corregir se nota');
alter table public.course_reviews add constraint course_reviews_rejection_has_fix check (result <> 'rejected' or private.draft_text_ok(what_to_fix, 2000, true));
-- Una función recreada sin su regla, con el mismo nombre y los mismos permisos.
select pg_get_functiondef('private.review_return(uuid, uuid, text, text)'::regprocedure) as devolver_antes \gset
create or replace function private.review_return(p_course uuid, p_submission uuid, p_reason text, p_what_to_fix text) returns text
language plpgsql security definer set search_path = '' as $$ begin return private.content_change_gate(); end $$;
select ok('submission function without its rule actor_owns_teacher' = any(pruebas.vigila()), 'devolver sin «nadie devuelve lo suyo» se nota');
select :'devolver_antes' \gexec
select pg_get_functiondef('private.video_preview(uuid, uuid)'::regprocedure) as preview_antes \gset
create or replace function private.video_preview(p_course uuid, p_lesson uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin return (select pg_catalog.jsonb_build_object('state', 'in_review')); end $$;
select ok('submission function without its rule actor_has_capability' = any(pruebas.vigila()), 'ver un video sin mirar la capacidad se nota');
select :'preview_antes' \gexec
create function private.review_otra() returns void language sql set search_path = '' as $$ select 1 $$;
select ok('submission function not in the watchdog area' = any(pruebas.vigila()), 'una función nueva de revisar se nota');
drop function private.review_otra();
select is(pruebas.vigila(), '{}', 'y al deshacerlo queda limpia');

select * from finish();
