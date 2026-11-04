-- T-405, quinta solicitud · Publicar una versión (RF-608, RN-14, FL-36 y FL-45). Contenido aprueba la versión y sustituye a lo publicado sin borrar nada: lo que se quitó queda
-- retirado, con su id, porque el consumo, el progreso y el reparto apuntan a él; lo que siguió conserva su id; el slug, el curso abierto y la fecha de publicación no cambian. Un video
-- reemplazado se retira. Lo retirado nunca vuelve a estar vigente. La cola dice qué cambió frente a lo publicado. Pasa con los borradores legales cargados y sin ellos.
begin;
\ir _ayuda.psql
\ir _versiones.psql
select plan(52);

-- Publicado ayer: dentro de esta transacción «ahora» es siempre la misma hora, y así se ve si publicar la versión la renueva.
select pruebas.como_dueno();
alter table public.published_courses disable trigger user;
update public.published_courses set published_at = now() - interval '1 day' where course_id = pruebas.id('curso');
alter table public.published_courses enable trigger user;
select (select slug from public.published_courses where course_id = pruebas.id('curso')) as slug_antes,
       (select published_at from public.published_courses where course_id = pruebas.id('curso')) as publicado_el,
       (select first_published_at from public.course_registry where course_id = pruebas.id('curso')) as primera_vez \gset
select pruebas.envio('curso') as envio1 \gset

-- ---------------------------------------------------------------------------------------
-- La versión 2: otro título, resumen y práctica; se quita «Postura» (con su recurso), llega «Nueva» con su video, «Sesión» cambia de video, se renombra un módulo, llega otro con
-- «Cierre», y el temario se cambia por otro.

select is(pruebas.abrir(1, 'curso'), 'opened', 'el maestro abre una versión');
select pruebas.r(pruebas.p(1), format('private.draft_save_course(%L, %s, %L, %L, %L, %L)', pruebas.id('curso'),
  (select revision from public.course_drafts where course_id = pruebas.id('curso')), 'Respirar mejor', 'Otro resumen.',
  'a9000000-0000-0000-0002-000000000003', 'a9000000-0000-0000-0002-000000000002'));
select pruebas.r(pruebas.p(1), format('private.draft_delete_lesson(%L, %L, %s)', pruebas.id('curso'), pruebas.id('l1'), pruebas.rev('draft_lessons', 'l1')));
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, %s, %L)', pruebas.id('curso'), pruebas.id('m1'), pruebas.rev('draft_modules', 'm1'), 'Nueva'), 'l4');
select pruebas.video(1, 'curso', 'l4') as v4 \gset
select pruebas.r(pruebas.p(1), format('private.draft_rename_module(%L, %L, %s, %L)', pruebas.id('curso'), pruebas.id('m2'), pruebas.rev('draft_modules', 'm2'), 'Práctica diaria'));
select pruebas.r(pruebas.p(1), format('private.draft_add_module(%L, %s, %L)', pruebas.id('curso'),
  (select structure_revision from public.course_drafts where course_id = pruebas.id('curso')), 'Final'), 'm3');
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, %s, %L)', pruebas.id('curso'), pruebas.id('m3'), pruebas.rev('draft_modules', 'm3'), 'Cierre'), 'l5');
select pruebas.video(1, 'curso', 'l5') as v6 \gset
select pruebas.r(pruebas.p(1), format('private.resource_remove(%L, %L, %s)', pruebas.id('curso'), :'rc',
  (select revision from public.draft_resources where id = :'rc')));
select pruebas.recurso(1, 'curso', null, 'Nuevo temario') as rn \gset

-- Un video que llega a reemplazar al de «Sesión»: al quedar listo se promueve, como lo hace asentarlo.
select pruebas.video(1, 'curso', 'l3', false) as v5 \gset
select pruebas.como_dueno();
select private.video_promote(pruebas.id('l3'));
select is((select id from public.draft_videos where lesson_id = pruebas.id('l3') and is_current), :'v5'::uuid, 'en una versión, el video nuevo se promueve');
select is((select count(*)::integer from private.video_trash where course_id = pruebas.id('curso') and video_id = :'v3'), 1, 'y el de antes pasa por la papelera');
select is(pruebas.rj(pruebas.p(1), format('private.video_trash_due(%L)', pruebas.id('curso'))), '[]'::jsonb, 'pero lo publicado lo nombra: no se borra en Mux ni en la cubeta');
select is((select count(*)::integer from private.video_trash where course_id = pruebas.id('curso')), 0, 'y sale de la papelera');

select is(pruebas.enviar(1, 'curso'), 'submitted', 'el maestro envía la versión');
select is(private.catalog_in_use('practices', 'a9000000-0000-0000-0002-000000000003'), 1, '«en uso» cuenta la práctica nueva mientras se revisa');

-- ---------------------------------------------------------------------------------------
-- Lo que la cola dice que cambió (FL-45).

select is(
  pruebas.de_cola('curso') -> 'submission' -> 'changes',
  jsonb_build_object(
    'course', jsonb_build_array('title', 'summary', 'practice'),
    'modules_added', jsonb_build_array('Final'), 'modules_removed', '[]'::jsonb, 'modules_renamed', jsonb_build_array('Práctica diaria'), 'modules_moved', '[]'::jsonb,
    'lessons_added', jsonb_build_array('Nueva', 'Cierre'), 'lessons_removed', jsonb_build_array('Postura'),
    'lessons_video', jsonb_build_array('Sesión'), 'lessons_text', '[]'::jsonb, 'lessons_moved', '[]'::jsonb,
    'resources_added', jsonb_build_array('Nuevo temario'), 'resources_removed', jsonb_build_array('Guía', 'Temario'), 'resources_renamed', '[]'::jsonb,
    'resources_moved', '[]'::jsonb),
  'la cola dice qué cambió frente a lo publicado');
select pruebas.armar(2, 'nuevo', 'Curso nuevo');
select pruebas.enviar(2, 'nuevo');
select is(
  (select jsonb_build_object('changes', x.s -> 'changes', 'revision', x.s -> 'is_revision', 'version', x.s -> 'version')
   from (select pruebas.de_cola('nuevo') -> 'submission' as s) x),
  jsonb_build_object('changes', null, 'revision', false, 'version', 1),
  'un primer envío dice que no es una versión, y no compara con nada');

-- ---------------------------------------------------------------------------------------
-- Aprobar la versión.

select is(pruebas.aprobar('curso'), 'approved', 'Contenido aprueba la versión');
select is(pruebas.estado('curso'), 'published', 'el curso vuelve a publicado, sin versión pendiente');
select is((select first_published_at from public.course_registry where course_id = pruebas.id('curso')), :'primera_vez'::timestamptz, 'la primera publicación no cambia');
select is((select result::text from public.course_reviews where id = pruebas.envio('curso')), 'approved', 'el envío queda aprobado');
select is((select result::text from public.course_reviews where id = :'envio1'), 'approved', 'y el primero sigue como estaba');
select is(pruebas.borrador('curso'), 0, 'el borrador se borra');
select is((select count(*)::integer from private.video_trash where course_id = pruebas.id('curso')), 0, 'nada queda en la papelera');
select is(pruebas.barrido('curso'), '{}', 'ni sobra en la cubeta: lo retirado también nombra su original');

select is(
  (select jsonb_build_object('slug', c.slug, 'title', c.title, 'summary', c.summary, 'practice', c.practice_id, 'lessons', c.lesson_count, 'seconds', c.total_duration_seconds,
                             'listed', c.is_listed, 'open', c.is_open, 'published_at', c.published_at, 'review', c.course_review_id)
   from public.published_courses c where c.course_id = pruebas.id('curso')),
  jsonb_build_object('slug', :'slug_antes', 'title', 'Respirar mejor', 'summary', 'Otro resumen.', 'practice', 'a9000000-0000-0000-0002-000000000003', 'lessons', 4,
                     'seconds', 1200, 'listed', true, 'open', false, 'published_at', :'publicado_el'::timestamptz, 'review', pruebas.envio('curso')),
  'el curso: los datos nuevos, el mismo slug, listado, la misma fecha de publicación y el envío que lo publicó');
select is(
  (select array_agg(m.id::text || ':' || m.position || ':' || m.title || ':' || m.is_current order by m.position) from public.published_modules m where m.course_id = pruebas.id('curso')),
  array[pruebas.id('m1')::text || ':1:Inicio:true', pruebas.id('m2')::text || ':2:Práctica diaria:true', pruebas.id('m3')::text || ':3:Final:true'],
  'los módulos, con su nombre nuevo y el que llegó');
select is(
  (select array_agg(l.id::text || ':' || l.position || ':' || l.module_id::text || ':' || l.title order by l.position) from public.published_lessons l
   where l.course_id = pruebas.id('curso') and l.is_current),
  array[pruebas.id('l2')::text || ':1:' || pruebas.id('m1')::text || ':Ritmo', pruebas.id('l4')::text || ':2:' || pruebas.id('m1')::text || ':Nueva',
        pruebas.id('l3')::text || ':3:' || pruebas.id('m2')::text || ':Sesión', pruebas.id('l5')::text || ':4:' || pruebas.id('m3')::text || ':Cierre'],
  'las lecciones vigentes, con los mismos ids y numeradas otra vez en el curso entero');
select is(
  (select jsonb_build_object('current', l.is_current, 'retired', l.retired_at is not null) from public.published_lessons l where l.id = pruebas.id('l1')),
  jsonb_build_object('current', false, 'retired', true),
  'la que se quitó queda retirada, con su id (RN-14)');
select is((select count(*)::integer from public.published_lessons where course_id = pruebas.id('curso')), 5, 'nada de lo publicado se borra');
select is((select video_asset_id from public.published_lessons where id = pruebas.id('l3')), :'v5'::uuid, 'la lección conserva su id y cambia de video');
select is((select video_asset_id from public.published_lessons where id = pruebas.id('l2')), :'v2'::uuid, 'la que no cambió, sigue con el suyo');
select is(
  (select array_agg(a.id::text || ':' || (a.retired_at is not null) order by a.id) from public.video_assets a where a.course_id = pruebas.id('curso')),
  (select array_agg(x order by x) from unnest(array[:'v1' || ':true', :'v2' || ':false', :'v3' || ':true', :'v4' || ':false', :'v5' || ':false', :'v6' || ':false']) x),
  'los videos que ya no usa ninguna lección vigente quedan retirados; los nuevos, publicados');
select ok((select bool_and(original_path is not null and captions_ready and status = 'ready') from public.video_assets where id in (:'v4', :'v5', :'v6')),
  'cada video nuevo, con su original y sus subtítulos');
select is(
  (select array_agg(r.title || ':' || r.is_current order by r.title) from public.published_resources r where r.course_id = pruebas.id('curso')),
  array['Guía:false', 'Nuevo temario:true', 'Temario:false'],
  'los recursos: el de la lección quitada y el que se cambió quedan retirados, con su archivo; el nuevo, vigente');
select is((select storage_path from public.published_resources where id = :'rc'), (select name from storage.objects where bucket_id = 'course-resources' and name like '%' || :'rc'),
  'el retirado conserva su ruta');
select is(pruebas.abrir(1, 'curso'), 'opened', 'se puede abrir otra versión');
select is((select version from public.course_drafts where course_id = pruebas.id('curso')), 3, 'la 3');
select is((select count(*)::integer from public.draft_lessons where course_id = pruebas.id('curso')), 4, 'que copia solo lo vigente');

-- ---------------------------------------------------------------------------------------
-- La versión 3: se va el módulo «Final» con su lección, y «Nueva» pasa a «Práctica diaria».

select pruebas.r(pruebas.p(1), format('private.draft_delete_module(%L, %L, %s)', pruebas.id('curso'), pruebas.id('m3'), pruebas.rev('draft_modules', 'm3')));
select pruebas.r(pruebas.p(1), format('private.draft_move_lesson(%L, %L, %L, %s, %L, %s)', pruebas.id('curso'), pruebas.id('l4'), pruebas.id('m1'), 2, pruebas.id('m2'), 2));
select pruebas.recurso(1, 'curso', null, 'Extra') as rx \gset
select is(pruebas.enviar(1, 'curso'), 'submitted', 'se envía');
select is(pruebas.de_cola('curso') -> 'submission' -> 'changes' -> 'modules_removed', jsonb_build_array('Final'), 'la cola dice qué módulo se quitó');
select is(pruebas.de_cola('curso') -> 'submission' -> 'changes' -> 'lessons_moved', jsonb_build_array('Nueva'), 'y qué lección cambió de lugar');
select is(pruebas.aprobar('curso'), 'approved', 'y se aprueba');
select is(
  (select array_agg(m.title || ':' || m.is_current order by m.title) from public.published_modules m where m.course_id = pruebas.id('curso')),
  array['Final:false', 'Inicio:true', 'Práctica diaria:true'],
  'el módulo quitado queda retirado');
select is(
  (select array_agg(l.title || ':' || l.position order by l.position) from public.published_lessons l where l.course_id = pruebas.id('curso') and l.is_current),
  array['Ritmo:1', 'Sesión:2', 'Nueva:3'],
  'las lecciones vigentes, en su orden nuevo');
select is((select module_id from public.published_lessons where id = pruebas.id('l4')), pruebas.id('m2'), 'la que se movió, en su módulo nuevo');
select is((select retired_at is not null from public.video_assets where id = :'v6'), true, 'el video de la lección quitada queda retirado');
select is(
  (select array_agg(r.title || ':' || r.position order by r.position) from public.published_resources r where r.course_id = pruebas.id('curso') and r.is_current),
  array['Nuevo temario:1', 'Extra:2'],
  'el recurso que siguió vuelve a su posición, y el nuevo va después');

-- La versión 4: dentro de «Práctica diaria», «Nueva» pasa antes que «Sesión»; «Práctica diaria» pasa antes que «Inicio»; «Extra» pasa antes que «Nuevo temario».
-- Cambiar el orden también es cambiar de lugar.
select is(pruebas.abrir(1, 'curso'), 'opened', 'otra versión');
select pruebas.r(pruebas.p(1), format('private.draft_move_lesson(%L, %L, %L, %s, %L, %s)', pruebas.id('curso'), pruebas.id('l4'), pruebas.id('m2'), 2, pruebas.id('m2'), 1));
select pruebas.r(pruebas.p(1), format('private.draft_move_module(%L, %L, %s, %s)', pruebas.id('curso'), pruebas.id('m2'), 2, 1));
select pruebas.r(pruebas.p(1), format('private.resource_move(%L, %L, %s, %s)', pruebas.id('curso'), :'rx', 2, 1));
select is(pruebas.enviar(1, 'curso'), 'submitted', 'se envía');
select is(pruebas.de_cola('curso') -> 'submission' -> 'changes' -> 'lessons_moved', jsonb_build_array('Nueva', 'Sesión'), 'la cola dice las dos lecciones que cambiaron de orden');
select is(pruebas.de_cola('curso') -> 'submission' -> 'changes' -> 'modules_moved', jsonb_build_array('Práctica diaria', 'Inicio'), 'los dos módulos');
select is(pruebas.de_cola('curso') -> 'submission' -> 'changes' -> 'resources_moved', jsonb_build_array('Extra', 'Nuevo temario'), 'y los dos recursos');

-- ---------------------------------------------------------------------------------------
-- Lo retirado no vuelve: ni lecciones, ni recursos, ni videos, ni una lección vigente que apunte a un video retirado. Ni el sistema.

select pruebas.como_dueno_sistema();
select throws_ok(format($$update public.published_lessons set is_current = true, retired_at = null where id = %L$$, pruebas.id('l1')),
  '42501', null, 'una lección retirada no vuelve a estar vigente');
select throws_ok(format($$update public.published_resources set is_current = true, retired_at = null where id = %L$$, :'rc'),
  '42501', null, 'ni un recurso');
select throws_ok(format($$update public.published_modules set is_current = true where id = %L$$, pruebas.id('m3')),
  '42501', null, 'ni un módulo');
select throws_ok(format($$update public.video_assets set retired_at = null where id = %L$$, :'v1'),
  '42501', null, 'ni un video');
select throws_ok(format($$update public.published_resources set retired_at = now() - interval '1 day' where id = %L$$, :'rc'),
  '42501', null, 'la fecha de retiro no cambia');
select throws_ok(format($$update public.video_assets set retired_at = now() where id = %L$$, :'v2'),
  '42501', null, 'y un video que una lección vigente usa no se retira');
select throws_ok(format($$update public.published_lessons set video_asset_id = %L where id = %L$$, :'v1', pruebas.id('l2')),
  '42501', null, 'y una lección vigente no apunta a un video retirado');
select pruebas.como_dueno();

select * from finish();
