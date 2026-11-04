-- T-405, quinta solicitud · Versiones de un curso publicado (RF-608, FL-36; esquema §5.2). Abrir, descartar, enviar y devolver una versión. «Editar» copia lo publicado al borrador con
-- los mismos ids, sin tocar lo que ven los alumnos; el curso queda con cambios pendientes, nunca en revisión. Descartar la borra y el curso vuelve a publicado. Lo que no se copia: un
-- curso por guion. El guardián de lo publicado le suma al maestro tres pasos y nada más. Pasa con los borradores legales cargados y sin ellos.
begin;
\ir _ayuda.psql
\ir _versiones.psql
select plan(87);


-- Uno como lo deja un guion (sin el envío que lo publicó), otro con un video al que le falta lo que el borrador exige, uno en borrador y uno en revisión.
select pruebas.armar(1, 'guion', 'Por guion');
select pruebas.enviar(1, 'guion');
select pruebas.aprobar('guion');
select pruebas.armar(1, 'sindatos', 'Sin datos');
select pruebas.enviar(1, 'sindatos');
select pruebas.aprobar('sindatos');
select pruebas.armar(1, 'borrador', 'Nunca enviado');
select pruebas.armar(1, 'enrevision', 'En revisión');
select pruebas.enviar(1, 'enrevision');
select pruebas.como_dueno();
alter table public.published_courses disable trigger user;
update public.published_courses set course_review_id = null where course_id = pruebas.id('guion');
alter table public.published_courses enable trigger user;
alter table public.video_assets disable trigger user;
update public.video_assets set file_name = null where course_id = pruebas.id('sindatos');
alter table public.video_assets enable trigger user;

select is(pruebas.estado('curso'), 'published', 'el curso está publicado');
select pruebas.publicado('curso') as antes \gset

-- ---------------------------------------------------------------------------------------
-- Abrir una versión: «Editar».

select is(pruebas.abrir(5, 'curso'), 'not_teacher', 'quien no es maestro no edita');
select is(pruebas.abrir(2, 'curso'), 'not_found', 'otro maestro no edita un curso que no es suyo');
select is(pruebas.r(pruebas.p(1), format('private.course_version_open(%L)', gen_random_uuid())), 'not_found', 'ni uno que no existe');
select is(pruebas.abrir(1, 'borrador'), 'not_editable', 'un borrador no abre versión: ya se edita');
select is(pruebas.abrir(1, 'enrevision'), 'not_editable', 'ni un curso en su primera revisión');
select is(pruebas.abrir(1, 'guion'), 'not_copyable', 'un curso por guion no se copia');
select is(pruebas.abrir(1, 'sindatos'), 'not_copyable', 'ni uno con un video al que le falta lo que el borrador exige');
select is(pruebas.borrador('guion') + pruebas.borrador('sindatos'), 0, 'y no escribe nada');
select is(pruebas.estado('guion') || ' ' || pruebas.estado('sindatos'), 'published published', 'los dos siguen publicados');

select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'Prueba', suspension_notice = 'Prueba' where id = pruebas.m(1);
select is(pruebas.abrir(1, 'curso'), 'suspended', 'un maestro suspendido no edita');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'active', suspended_at = null, suspension_reason = null, suspension_notice = null where id = pruebas.m(1);

select is(pruebas.abrir(1, 'curso'), 'opened', 'su maestro abre una versión');
select is(pruebas.estado('curso'), 'changes_pending/draft', 'el curso queda con cambios pendientes, con la versión en borrador');
select is(pruebas.publicado('curso'), :'antes'::jsonb, 'lo que ven los alumnos no cambia');
select is(
  (select jsonb_build_object('version', d.version, 'title', d.title, 'summary', d.summary, 'practice', d.practice_id, 'level', d.level_id, 'teacher', d.teacher_id)
   from public.course_drafts d where d.course_id = pruebas.id('curso')),
  jsonb_build_object('version', 2, 'title', 'Respirar', 'summary', 'Un resumen.', 'practice', 'a9000000-0000-0000-0002-000000000001',
                     'level', 'a9000000-0000-0000-0002-000000000002', 'teacher', pruebas.m(1)),
  'el borrador copia los datos del curso, como la versión 2');
select is(
  (select array_agg(m.id::text || ':' || m.position || ':' || m.title order by m.position) from public.draft_modules m where m.course_id = pruebas.id('curso')),
  array[pruebas.id('m1')::text || ':1:Inicio', pruebas.id('m2')::text || ':2:Práctica'],
  'los módulos, con los mismos ids y su orden');
select is(
  (select array_agg(l.id::text || ':' || l.module_id::text || ':' || l.position || ':' || l.title order by l.id) from public.draft_lessons l where l.course_id = pruebas.id('curso')),
  (select array_agg(x order by x) from unnest(array[
     pruebas.id('l1')::text || ':' || pruebas.id('m1')::text || ':1:Postura',
     pruebas.id('l2')::text || ':' || pruebas.id('m1')::text || ':2:Ritmo',
     pruebas.id('l3')::text || ':' || pruebas.id('m2')::text || ':1:Sesión']) x),
  'las lecciones, con los mismos ids y su posición dentro del módulo');
select is((select description from public.draft_lessons where id = pruebas.id('l1')), 'Sentada, con la espalda recta.', 'con su descripción');
select is(
  (select jsonb_build_object('lesson', v.lesson_id, 'state', v.state, 'current', v.is_current, 'file_name', v.file_name, 'mime', v.mime, 'path', v.storage_path,
                             'size', v.size_bytes, 'object', v.object_id, 'object_version', v.object_version, 'read_seconds', v.read_seconds, 'provider', v.provider,
                             'asset', v.provider_asset_id, 'playback', v.provider_playback_id, 'seconds', v.duration_seconds, 'captions', v.captions_ready,
                             'deletes_at', v.deletes_at)
   from public.draft_videos v where v.id = :'v1'),
  (select jsonb_build_object('lesson', a.lesson_id, 'state', 'ready', 'current', true, 'file_name', a.file_name, 'mime', a.mime, 'path', a.original_path,
                             'size', a.original_size_bytes, 'object', a.object_id, 'object_version', a.object_version, 'read_seconds', a.read_seconds, 'provider', a.provider,
                             'asset', a.provider_asset_id, 'playback', a.provider_playback_id, 'seconds', a.duration_seconds, 'captions', true, 'deletes_at', null)
   from public.video_assets a where a.id = :'v1'),
  'cada video vuelve con el mismo id, su original y lo que el borrador exige, listo y sin fecha de borrado');
select is((select count(*)::integer from public.draft_videos where course_id = pruebas.id('curso') and is_current and state = 'ready'), 3, 'los tres, vigentes');
select is(
  (select array_agg(x.id::text || ':' || coalesce(x.lesson_id::text, 'curso') || ':' || x.title || ':' || x.position || ':' || x.state || ':' || x.storage_path order by x.title)
   from public.draft_resources x where x.course_id = pruebas.id('curso')),
  (select array_agg(r.id::text || ':' || coalesce(r.lesson_id::text, 'curso') || ':' || r.title || ':' || r.position || ':ready:' || r.storage_path order by r.title)
   from public.published_resources r where r.course_id = pruebas.id('curso')),
  'los recursos, con los mismos ids, su lugar y su ruta');
select is((select jsonb_array_length(private.course_readiness(pruebas.id('curso')))), 0, 'la copia está lista para enviarse');
select is((select x ->> 'missing' from jsonb_array_elements(pruebas.rj(pruebas.p(1), 'private.course_submit_status()')) x where x ->> 'course_id' = pruebas.id('curso')::text),
  '0', 'y Mis cursos lo sabe');
select is((select count(*)::integer from private.video_trash where course_id = pruebas.id('curso')), 0, 'nada va a la papelera');
select is(pruebas.barrido('curso'), '{}', 'ni sobra en la cubeta');

select created_at as abierta from public.course_drafts where course_id = pruebas.id('curso') \gset
select is(pruebas.abrir(1, 'curso'), 'open', '«Editar» otra vez abre la misma versión (E1)');
select is((select created_at from public.course_drafts where course_id = pruebas.id('curso')), :'abierta'::timestamptz, 'sin crear otra');

-- ---------------------------------------------------------------------------------------
-- La versión se edita con las funciones del borrador; lo publicado no se borra desde aquí.

select is(pruebas.r(pruebas.p(1), format('private.draft_save_course(%L, %s, %L, %L, %L, %L)', pruebas.id('curso'),
  (select revision from public.course_drafts where course_id = pruebas.id('curso')), 'Respirar mejor', 'Un resumen.',
  'a9000000-0000-0000-0002-000000000001', 'a9000000-0000-0000-0002-000000000002')), 'saved', 'la versión se edita');
select is((select title from public.published_courses where course_id = pruebas.id('curso')), 'Respirar', 'y los alumnos siguen viendo el título publicado');
select is(pruebas.r(pruebas.p(1), format('private.draft_delete_course(%L, %s)', pruebas.id('curso'),
  (select content_revision from public.course_drafts where course_id = pruebas.id('curso')))), 'not_editable', 'un curso publicado no se borra');

-- ---------------------------------------------------------------------------------------
-- Descartar (H-18).

select is(pruebas.descartar(5, 'curso'), 'not_teacher', 'quien no es maestro no descarta');
select is(pruebas.descartar(2, 'curso'), 'not_found', 'ni otro maestro');
select is(pruebas.descartar(1, 'curso', 0), 'changed', 'con lo que se vio antes, contesta changed');
select is(pruebas.estado('curso'), 'changes_pending/draft', 'sin tocar nada');
select is(pruebas.descartar(1, 'curso'), 'discarded', 'su maestro la descarta');
select is(pruebas.estado('curso'), 'published', 'el curso vuelve a publicado');
select is(pruebas.borrador('curso'), 0, 'el borrador se va entero');
select is(pruebas.publicado('curso'), :'antes'::jsonb, 'y lo publicado sigue igual');
select is((select count(*)::integer from private.video_trash where course_id = pruebas.id('curso')), 0, 'lo que la cascada mandó a la papelera lo nombra lo publicado: sale');
select is(pruebas.barrido('curso'), '{}', 'ningún original sobra');
select is((select count(*)::integer from private.resource_unused_objects(pruebas.id('curso'))), 0, 'ni un recurso');
select is(pruebas.descartar(1, 'curso'), 'not_editable', 'sin versión no hay qué descartar');

-- ---------------------------------------------------------------------------------------
-- Enviar la versión.

select is(pruebas.abrir(1, 'curso'), 'opened', 'se abre otra');
select is((select version from public.course_drafts where course_id = pruebas.id('curso')), 2, 'otra vez la 2: la descartada nunca se envió');
select is(pruebas.vista(1, 'curso') ->> 'answer', 'ready', 'se puede enviar sin cambios');
select ok(pruebas.vista(1, 'curso') ->> 'statement' like '%«Respirar», versión 2,%', 'la frase nombra la versión');
select is(pruebas.enviar(1, 'curso'), 'submitted', 'el maestro la envía');
select is(pruebas.estado('curso'), 'changes_pending/in_review', 'la versión queda en revisión; el curso, con cambios pendientes');
select is(
  (select jsonb_build_object('revision', c.is_revision, 'version', c.course_version, 'result', c.result, 'number', c.submission_no)
   from public.course_reviews c where c.id = pruebas.envio('curso')),
  jsonb_build_object('revision', true, 'version', 2, 'result', 'pending', 'number', 2),
  'el envío dice que es una versión, cuál, y es el segundo del curso');
select is(pruebas.publicado('curso'), :'antes'::jsonb, 'lo publicado sigue igual');
select is(pruebas.r(pruebas.p(1), format('private.draft_save_course(%L, %s, %L, %L, %L, %L)', pruebas.id('curso'),
  (select revision from public.course_drafts where course_id = pruebas.id('curso')), 'Otro', 'Un resumen.',
  'a9000000-0000-0000-0002-000000000001', 'a9000000-0000-0000-0002-000000000002')), 'not_editable', 'en revisión no se edita');
select is(pruebas.descartar(1, 'curso'), 'not_editable', 'ni se descarta: el maestro no cancela su envío');
select is(pruebas.abrir(1, 'curso'), 'open', '«Editar» lleva a la versión que se revisa');
select is(
  (select jsonb_build_object('version', c -> 'submission' -> 'version', 'revision', c -> 'submission' -> 'is_revision')
   from jsonb_array_elements(pruebas.rj(pruebas.p(3), 'private.review_queue()') -> 'courses') c where c ->> 'course_id' = pruebas.id('curso')::text),
  jsonb_build_object('version', 2, 'revision', true),
  'la cola dice que es una versión, y cuál');
select is(
  (select count(*)::integer from jsonb_array_elements(pruebas.rj(pruebas.p(3), 'private.review_queue()') -> 'courses') c where c ->> 'course_id' = pruebas.id('curso')::text),
  1, 'una sola vez: no entra como curso por guion');
select is(pruebas.pide(pruebas.p(3), format('private.approve_course(%L)', pruebas.id('curso'))), 'not_pending', 'y la aprobación de los cursos por guion no la toca');

-- ---------------------------------------------------------------------------------------
-- Devolver la versión, y el motivo que no sobrevive a descartarla.

select is(pruebas.devolver('curso'), 'returned', 'Contenido la devuelve');
select is(pruebas.estado('curso'), 'changes_pending/draft', 'la versión vuelve a borrador; lo publicado no cambia');
select is(pruebas.publicado('curso'), :'antes'::jsonb, 'nada de lo publicado');
select ok(pruebas.notas(1) @> jsonb_build_array(jsonb_build_object('course_id', pruebas.id('curso'), 'reason', 'Falta una lección.')), 'el maestro lee el motivo');
select is(pruebas.descartar(1, 'curso'), 'discarded', 'y la descarta');
select is(pruebas.abrir(1, 'curso'), 'opened', 'abre otra');
select is((select version from public.course_drafts where course_id = pruebas.id('curso')), 3, 'la 3: la 2 se envió, y su número no se repite');
select ok(pruebas.vista(1, 'curso') ->> 'statement' like '%«Respirar», versión 3,%', 'y la frase lo dice');
select ok(not (pruebas.notas(1) @> jsonb_build_array(jsonb_build_object('course_id', pruebas.id('curso')))), 'el motivo de la versión descartada no reaparece');
select is(pruebas.descartar(1, 'curso'), 'discarded', 'se descarta');

-- ---------------------------------------------------------------------------------------
-- El guardián: al maestro, solo abrir, descartar y enviar, sin otro cambio.

select pruebas.como_dueno();
select set_config('app.actor_id', pruebas.p(1)::text, true);
select throws_ok(format($$update public.course_registry set state = 'changes_pending', pending_version_state = 'draft', updated_at = now() where course_id = %L$$, pruebas.id('curso')),
  '42501', null, 'sin borrador no se abre una versión');
insert into public.course_drafts (course_id, teacher_id, version, title, create_token) values (pruebas.id('curso'), pruebas.m(1), 9, 'Respirar', gen_random_uuid());
select throws_ok(format($$update public.course_registry set state = 'changes_pending', pending_version_state = 'draft', is_open = true, updated_at = now() where course_id = %L$$, pruebas.id('curso')),
  '42501', null, 'ni con otro cambio');
select throws_ok(format($$update public.course_registry set state = 'changes_pending', pending_version_state = 'in_review', updated_at = now() where course_id = %L$$, pruebas.id('curso')),
  '42501', null, 'ni directo a revisión');
select set_config('app.actor_id', pruebas.p(2)::text, true);
select throws_ok(format($$update public.course_registry set state = 'changes_pending', pending_version_state = 'draft', updated_at = now() where course_id = %L$$, pruebas.id('curso')),
  '42501', null, 'ni a nombre de otro maestro');
select set_config('app.actor_id', pruebas.p(1)::text, true);
select lives_ok(format($$update public.course_registry set state = 'changes_pending', pending_version_state = 'draft', updated_at = now() where course_id = %L$$, pruebas.id('curso')),
  'con su borrador, y solo eso, sí');
select throws_ok(format($$update public.course_registry set state = 'published', pending_version_state = null, updated_at = now() where course_id = %L$$, pruebas.id('curso')),
  '42501', null, 'no vuelve a publicado con el borrador todavía ahí');
select throws_ok(format($$update public.course_registry set state = 'changes_pending', pending_version_state = 'in_review', updated_at = now() where course_id = %L$$, pruebas.id('curso')),
  '42501', null, 'ni pasa a revisión sin su envío y su licencia');
delete from public.course_drafts where course_id = pruebas.id('curso');
select throws_ok(format($$update public.course_registry set state = 'published', pending_version_state = null, is_open = true, updated_at = now() where course_id = %L$$, pruebas.id('curso')),
  '42501', null, 'descartar tampoco admite otro cambio');
select lives_ok(format($$update public.course_registry set state = 'published', pending_version_state = null, updated_at = now() where course_id = %L$$, pruebas.id('curso')),
  'sin el borrador, vuelve a publicado');
select throws_ok(format($$update public.course_registry set state = 'draft', updated_at = now() where course_id = %L$$, pruebas.id('curso')),
  '42501', null, 'y un curso publicado no vuelve a borrador');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- La baja de un maestro (OP-06): quien opera descarta su versión, como el dueño declarado sistema.

select is(pruebas.abrir(1, 'curso'), 'opened', 'el maestro abre una versión');
select pruebas.como_dueno();
select is(private.system_discard_version(pruebas.id('curso')), 'forbidden', 'sin declararse sistema, no');
select pruebas.como_dueno_sistema();
select is(private.system_discard_version(pruebas.id('curso')), 'discarded', 'quien opera la descarta');
select is(pruebas.estado('curso') || ' ' || pruebas.borrador('curso'), 'published 0', 'el curso vuelve a publicado, sin borrador');
select pruebas.como_dueno_sistema();
select is(private.system_discard_version(pruebas.id('curso')), 'not_pending', 'sin versión, no hay qué descartar');
select is(pruebas.abrir(1, 'curso'), 'opened', 'otra versión');
select is(pruebas.enviar(1, 'curso'), 'submitted', 'enviada');
select pruebas.como_dueno_sistema();
select is(private.system_discard_version(pruebas.id('curso')), 'in_review', 'en revisión, antes la devuelve Contenido');
select is(pruebas.publicado('curso'), :'antes'::jsonb, 'y lo publicado nunca cambió');

-- ---------------------------------------------------------------------------------------
-- Quién las ejecuta.

select pruebas.como_dueno();
select ok(
  (select bool_and(has_function_privilege('app_service', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
   from unnest(array['private.course_version_open(uuid)', 'private.course_version_discard(uuid, bigint)']) f),
  'abrir y descartar son del servidor, y de nadie más');
select ok(
  (select bool_and(not has_function_privilege(r, 'private.system_discard_version(uuid)', 'execute'))
   from unnest(array['app_service', 'authenticated', 'anon']) r),
  'descartar como sistema no lo ejecuta nadie de la aplicación');

select * from finish();
