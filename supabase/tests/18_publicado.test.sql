-- T-107 · Lo publicado en tablas propias (ADR-21) y los cursos que carga el dueño de la base
-- (RN-16, FL-58). Esquema §5.1, §5.2, §6 y §7.4. Decisiones de Sergio del 2026-10-14: lo
-- cargado queda por aprobar, sin listar; lo aprueba alguien con Contenido y un código
-- reciente; el proveedor de video de prueba solo lo pone el guion local.
begin;
\ir _ayuda.psql
select plan(109);

select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido1@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000002', 'contenido2@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000002', 'content');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');
select pruebas.equipar('b0000000-0000-0000-0000-000000000002');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001');
-- La segunda persona con Contenido dio su código hace una hora.
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '1 hour'
  where session_id = pruebas.sesion('b0000000-0000-0000-0000-000000000002');

-- Un curso de dos lecciones, en la forma que espera la función de cargar.
create function pruebas.curso(p_slug text, p_practice text default 'naturaleza', p_level text default 'principiante',
                              p_provider text default 'test') returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', p_practice, 'level', p_level,
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', jsonb_build_array(
      jsonb_build_object('title', 'Lección uno', 'video',
        jsonb_build_object('provider', p_provider, 'asset_id', p_slug || '-a1', 'playback_id', p_slug || '-p1', 'duration_seconds', 356)),
      jsonb_build_object('title', 'Lección dos', 'video',
        jsonb_build_object('provider', p_provider, 'asset_id', p_slug || '-a2', 'playback_id', p_slug || '-p2', 'duration_seconds', 409.4))))))
$$;
-- El dueño declarado sistema con el ajuste del guion local: como carga `pnpm db:courses`.
create function pruebas.como_guion() returns void
language sql as $$ select pruebas.como_dueno_sistema(); select set_config('app.local_courses', 'on', true); $$;
create function pruebas.aprueba(p_id uuid, p_course uuid) returns text
language sql as $$ select pruebas.pide(p_id, format('private.approve_course(%L)', p_course)) $$;
create function pruebas.desactiva(p_id uuid, p_list text, p_slug text) returns text
language sql as $$
  select pruebas.pide(p_id, format('private.catalog_set_active(%L, %L, false)', p_list,
    (select id from public.practices where slug = p_slug union all select id from public.levels where slug = p_slug limit 1)))
$$;
create function pruebas.curso_por_slug(p_slug text) returns uuid
language sql security definer as $$ select course_id from public.published_courses where slug = p_slug $$;
create table pruebas.cargado (slug text primary key, course_id uuid);
create function pruebas.listas_de(p_id uuid) returns jsonb
language sql as $$ select pruebas.pide(p_id, 'private.catalog_lists()')::jsonb $$;
-- El dueño de la tabla, a nombre de alguien: es como escriben las funciones que aprueban.
create function pruebas.dueno_a_nombre_de(p_id uuid) returns void
language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', p_id::text, true), set_config('app.actor_session', pruebas.sesion(p_id)::text, true);
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- La estructura y los permisos.

select has_table('public', t, 'existe public.' || t)
from unnest(array['teachers', 'published_teachers', 'course_registry', 'video_assets',
                  'published_courses', 'published_modules', 'published_lessons']) as t;
select ok((select bool_and(c.relrowsecurity) from pg_class c where c.oid in (
  'public.teachers'::regclass, 'public.published_teachers'::regclass, 'public.course_registry'::regclass,
  'public.video_assets'::regclass, 'public.published_courses'::regclass, 'public.published_modules'::regclass,
  'public.published_lessons'::regclass)), 'todas con seguridad por fila');
select ok(
  bool_and(not has_any_column_privilege(r, t, 'insert, update') and not has_table_privilege(r, t, 'delete, truncate, trigger')),
  'nadie de la aplicación las escribe')
from unnest(array['public.teachers', 'public.published_teachers', 'public.course_registry', 'public.video_assets',
                  'public.published_courses', 'public.published_modules', 'public.published_lessons']) as t,
     unnest(array['anon', 'authenticated', 'app_service', 'service_role']) as r;
select ok(
  bool_and(has_table_privilege('anon', t, 'select')),
  'el público lee lo publicado (la política decide qué)')
from unnest(array['public.published_teachers', 'public.published_courses', 'public.published_modules', 'public.published_lessons']) as t;
select ok(
  not has_any_column_privilege('anon', 'public.teachers', 'select')
  and not has_table_privilege('anon', 'public.course_registry', 'select')
  and not has_table_privilege('anon', 'public.video_assets', 'select'),
  'el público no lee maestros, el registro ni los videos');
select ok(
  not has_column_privilege('authenticated', 'public.teachers', 'tiebreak_rank', 'select')
  and not has_column_privilege('app_service', 'public.teachers', 'tiebreak_rank', 'select')
  and has_column_privilege('app_service', 'public.teachers', 'status', 'select'),
  'el orden de desempate de un maestro no sale de la base');
select hasnt_column('public', 'published_courses', 'course_review_id', 'lo publicado nace sin la revisión: llega con T-405');
select hasnt_column('public', 'video_assets', 'lesson_ref', 'sin Payload: el video dice su lección por lesson_id');
select col_has_default('public', 'course_registry', 'course_id', 'el curso tiene su propio identificador');
select ok(
  bool_and(not has_function_privilege(r, f, 'execute')),
  'cargar, agregar como sistema y colocar no los ejecuta nadie de la aplicación')
from unnest(array['private.system_load_course(uuid, jsonb)', 'private.system_add_teacher(text, text, text)',
                  'private.system_catalog_add(public.catalog_list, text)', 'private.catalog_place(public.catalog_list, text)']) as f,
     unnest(array['anon', 'authenticated', 'app_service', 'service_role']) as r;
select ok(
  has_function_privilege('app_service', 'private.approve_course(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.approve_course(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.approve_course(uuid)', 'execute'),
  'aprobar lo ejecuta solo el servidor');
select is_empty('select * from private.schema_violations()', 'private.schema_violations() sigue en cero');
select ok(
  bool_and(exists (select 1 from pg_trigger g where g.tgrelid = t::regclass and g.tgname = 'publication_guard' and not g.tgisinternal)
           and exists (select 1 from pg_trigger g where g.tgrelid = t::regclass and g.tgname = 'publication_no_truncate' and not g.tgisinternal)),
  'cada tabla tiene su guardián, también contra vaciarla')
from unnest(array['public.teachers', 'public.published_teachers', 'public.course_registry', 'public.video_assets',
                  'public.published_courses', 'public.published_modules', 'public.published_lessons']) as t;
select ok(
  exists (select 1 from pg_trigger where tgrelid = 'public.teachers'::regclass and tgname = 'audit_changes')
  and exists (select 1 from pg_trigger where tgrelid = 'public.course_registry'::regclass and tgname = 'audit_changes'),
  'los maestros y el registro de cursos quedan en la auditoría');
select policies_are('public', 'legal_documents',
  array['legal_documents_public_select', 'legal_documents_config_select', 'legal_documents_teacher_select'],
  'los textos de maestro los leen los maestros: la política llega con la tabla');

-- ---------------------------------------------------------------------------------------
-- Cargar: solo el dueño declarado sistema.

select pruebas.como_dueno();
select throws_ok($$select private.system_catalog_add('practices', 'Naturaleza')$$, '42501', null,
  'el dueño sin declararse sistema no agrega');
select throws_ok($$select private.system_add_teacher('X', 'x', null)$$, '42501', null, 'ni da de alta un maestro');
select throws_ok($$select private.system_load_course(gen_random_uuid(), '{}'::jsonb)$$, '42501', null, 'ni carga un curso');

select pruebas.como_guion();
select is(private.system_catalog_add('practices', 'Naturaleza') ->> 'answer', 'added', 'el sistema agrega una práctica');
select is(private.system_catalog_add('practices', 'Océano') ->> 'answer', 'added', 'y otra');
select is(private.system_catalog_add('levels', 'Principiante') ->> 'answer', 'added', 'y un nivel');
select is(private.system_catalog_add('practices', 'naturaleza') ->> 'answer', 'duplicate', 'con la misma regla de duplicados');
create temporary table maestra as select private.system_add_teacher('Maestra de prueba', 'maestra-de-prueba', 'Una maestra que no existe.') as id;
select is((select status::text || ' ' || (profile_id is null)::text || ' ' || (created_by is null)::text from public.teachers where id = (select id from maestra)),
  'invited true true', 'el maestro nace invitado, sin cuenta, y lo dio de alta el sistema');
select is(private.system_add_teacher('Otra', 'maestra-de-prueba', null), (select id from maestra), 'su slug ya existe: el mismo maestro');

select is(private.system_load_course((select id from maestra), pruebas.curso('naturaleza-uno')) ->> 'answer', 'loaded', 'carga un curso');
insert into pruebas.cargado select 'naturaleza-uno', course_id from public.published_courses where slug = 'naturaleza-uno';
select is((select state::text from public.course_registry where course_id = (select course_id from pruebas.cargado)), 'in_review',
  'queda en revisión');
select is((select is_listed from public.published_courses where slug = 'naturaleza-uno'), false, 'sin listar');
select is((select lesson_count || ' ' || total_duration_seconds from public.published_courses where slug = 'naturaleza-uno'), '2 765',
  'con sus lecciones contadas y su duración sumada');
select is((select array_agg(l.duration_seconds = v.duration_seconds order by l.position)
           from public.published_lessons l join public.video_assets v on v.id = l.video_asset_id
           where l.course_id = (select course_id from pruebas.cargado)), array[true, true],
  'la duración de cada lección es la de su video');
select is((select array_agg(v.lesson_id = l.id order by l.position)
           from public.published_lessons l join public.video_assets v on v.id = l.video_asset_id
           where l.course_id = (select course_id from pruebas.cargado)), array[true, true],
  'y cada video dice qué lección lo usa');
select is((select count(*)::int from public.video_assets where provider = 'test' and status = 'ready'), 2, 'con videos de prueba, listos');
select is((select teacher_name from public.published_courses where slug = 'naturaleza-uno'), 'Maestra de prueba', 'con el nombre de su maestro');
select is(private.system_load_course((select id from maestra), pruebas.curso('naturaleza-uno')) ->> 'answer', 'already_loaded',
  'el mismo slug otra vez: ya está');
select is((select count(*)::int from public.course_registry), 1, 'y no cargó nada más');
select is(private.system_load_course(gen_random_uuid(), pruebas.curso('otro')) ->> 'answer', 'teacher_missing', 'sin maestro: teacher_missing');
select is(private.system_load_course((select id from maestra), pruebas.curso('otro', 'no-existe')) ->> 'answer', 'practice_missing',
  'con una práctica que no existe: practice_missing');
select is(private.system_load_course((select id from maestra), pruebas.curso('otro', 'naturaleza', 'no-existe')) ->> 'answer', 'level_missing',
  'con un nivel que no existe: level_missing');
select is(private.system_load_course((select id from maestra), pruebas.curso('otro') - 'modules' || '{"modules": []}') ->> 'answer', 'invalid',
  'sin módulos: invalid');
select is(private.system_load_course((select id from maestra), jsonb_set(pruebas.curso('otro'), '{modules,0,lessons,0,video,duration_seconds}', '0')) ->> 'answer',
  'invalid', 'un video sin duración: invalid');
select is(private.system_load_course((select id from maestra), jsonb_set(pruebas.curso('otro'), '{modules,0,lessons,1,title}', '"  "')) ->> 'answer',
  'invalid', 'una lección sin título: invalid');
select is(private.system_load_course((select id from maestra), pruebas.curso('Otro Mal')) ->> 'answer', 'invalid', 'un slug sin forma: invalid');
select is((select count(*)::int from public.course_registry), 1, 'ningún rechazo escribió');
-- Sin el ajuste del guion local, un video de prueba no entra, ni como sistema.
select pruebas.como_dueno_sistema();
select throws_ok($$select private.system_load_course((select id from maestra), pruebas.curso('sin-ajuste'))$$,
  '42501', 'public.video_assets: test videos are only loaded by the local courses script',
  'sin el ajuste del guion local, un video de prueba no entra');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Lo que se ve antes de aprobar.

select pruebas.como_visitante();
select is((select count(*)::int from public.published_courses), 0, 'un visitante no ve un curso por aprobar');
select is((select count(*)::int from public.published_modules), 0, 'ni sus módulos');
select is((select count(*)::int from public.published_lessons), 0, 'ni sus lecciones');
select is((select count(*)::int from public.published_teachers), 0, 'ni la ficha de su maestro: su nombre no se ve antes de aprobar');
select pruebas.limpiar();
select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.published_courses), 0, 'una cuenta común, lo mismo');
select is((select count(*)::int from public.course_registry), 0, 'y no lee el registro');
select is((select count(*)::int from public.video_assets), 0, 'ni los videos');
select is(private.current_teacher_id(), null::uuid, 'no es maestro');
select pruebas.limpiar();
select pruebas.como_usuario('b0000000-0000-0000-0000-000000000001', 'aal2');
select is((select count(*)::int from public.course_registry), 1, 'Contenido lee el registro');
select is((select count(*)::int from public.published_courses), 1, 'y el curso por aprobar');
select is((select count(*)::int from public.video_assets), 2, 'y sus videos');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Aprobar: Contenido con un código reciente.

select is(pruebas.aprueba('a0000000-0000-0000-0000-000000000001', (select course_id from pruebas.cargado)), 'forbidden',
  'una cuenta común: forbidden');
select is(pruebas.aprueba('b0000000-0000-0000-0000-000000000002', (select course_id from pruebas.cargado)), 'needs_fresh_code',
  'con el código de hace una hora: needs_fresh_code');
select is(pruebas.aprueba('b0000000-0000-0000-0000-000000000001', gen_random_uuid()), 'not_found', 'un curso que no existe: not_found');
select is(pruebas.aprueba('b0000000-0000-0000-0000-000000000001', (select course_id from pruebas.cargado)), 'approved', 'aprueba');
select is((select state::text || ' ' || (first_published_at is not null)::text from public.course_registry
           where course_id = (select course_id from pruebas.cargado)), 'published true', 'queda publicado, con su fecha');
select is((select actor_id::text from public.audit_log where entity_table = 'public.course_registry' order by id desc limit 1),
  'b0000000-0000-0000-0000-000000000001', 'y la auditoría dice quién aprobó');
select is(pruebas.aprueba('b0000000-0000-0000-0000-000000000001', (select course_id from pruebas.cargado)), 'not_pending',
  'otra vez: not_pending');
select pruebas.como_visitante();
select is((select count(*)::int from public.published_courses), 1, 'un visitante ya ve el curso');
select is((select count(*)::int from public.published_modules), 1, 'su módulo');
select is((select count(*)::int from public.published_lessons), 2, 'y sus lecciones');
select is((select count(*)::int from public.published_teachers), 1, 'y la ficha de su maestro');
select pruebas.limpiar();
select is((select count(*)::int from public.audit_log where entity_table = 'public.teachers' and (new_value ? 'tiebreak_rank' or old_value ? 'tiebreak_rank')), 0,
  'el orden de desempate no quedó en la auditoría');

-- Una práctica que se desactiva mientras el curso espera: aprobar se niega.
select pruebas.como_guion();
select is(private.system_load_course((select id from maestra), pruebas.curso('oceano-uno', 'oceano')) ->> 'answer', 'loaded',
  'carga otro curso, en otra práctica');
select pruebas.limpiar();
-- Desde la segunda solicitud de T-107, desactivarla lo niega «en uso». Aprobar comprueba lo
-- mismo como defensa: se desactiva por fuera de las funciones, como dueño declarado sistema.
select is(pruebas.desactiva('b0000000-0000-0000-0000-000000000001', 'practices', 'oceano'), 'in_use',
  'desactivar la práctica de un curso que espera: in_use');
select pruebas.como_dueno_sistema();
update public.practices set is_active = false where slug = 'oceano';
select pruebas.limpiar();
select is((select is_active from public.practices where slug = 'oceano'), false, '(desactivada por fuera)');
select is(pruebas.aprueba('b0000000-0000-0000-0000-000000000001', pruebas.curso_por_slug('oceano-uno')), 'practice_inactive',
  'aprobarlo: practice_inactive');
select is((select is_listed from public.published_courses where slug = 'oceano-uno'), false, 'y sigue sin listar');
select pruebas.como_guion();
select is(private.system_load_course((select id from maestra), pruebas.curso('oceano-dos', 'oceano')) ->> 'answer', 'practice_inactive',
  'cargar otro con esa práctica inactiva: practice_inactive');
select is(private.system_catalog_add('levels', 'Avanzado') ->> 'answer', 'added', 'el sistema agrega otro nivel');
select is(private.system_load_course((select id from maestra), pruebas.curso('avanzado-uno', 'naturaleza', 'avanzado')) ->> 'answer', 'loaded',
  'carga un curso en ese nivel');
select pruebas.limpiar();
select is(pruebas.desactiva('b0000000-0000-0000-0000-000000000001', 'levels', 'avanzado'), 'in_use', 'desactivar su nivel: in_use');
select pruebas.como_dueno_sistema();
update public.levels set is_active = false where slug = 'avanzado';
select pruebas.limpiar();
select is(pruebas.aprueba('b0000000-0000-0000-0000-000000000001', pruebas.curso_por_slug('avanzado-uno')), 'level_inactive', 'aprobarlo: level_inactive');
select pruebas.como_guion();
select is(private.system_load_course((select id from maestra), pruebas.curso('avanzado-dos', 'naturaleza', 'avanzado')) ->> 'answer', 'level_inactive',
  'cargar otro con ese nivel inactivo: level_inactive');
-- Un video que deja de estar listo: aprobar se niega (RN-16).
select is(private.system_load_course((select id from maestra), pruebas.curso('pendiente-uno')) ->> 'answer', 'loaded', 'carga otro');
update public.video_assets set status = 'processing' where course_id = pruebas.curso_por_slug('pendiente-uno');
-- Un curso en revisión sin su copia publicada (como lo dejará un camino que todavía no existe).
insert into public.course_registry (teacher_id, state) values ((select id from maestra), 'in_review');
select pruebas.limpiar();
select is(pruebas.aprueba('b0000000-0000-0000-0000-000000000001', pruebas.curso_por_slug('pendiente-uno')), 'videos_not_ready', 'con un video que no está listo: videos_not_ready');
select is(pruebas.aprueba('b0000000-0000-0000-0000-000000000001',
  (select r.course_id from public.course_registry r where not exists (select 1 from public.published_courses c where c.course_id = r.course_id))),
  'incomplete', 'sin su copia publicada: incomplete');

-- ---------------------------------------------------------------------------------------
-- «En uso» (segunda solicitud de T-107; FL-58 E1): no se desactiva lo que usa un curso sin
-- retirar, esté publicado o en revisión.

select is((select provolatile::text from pg_proc where oid = 'private.catalog_set_active(public.catalog_list, uuid, boolean)'::regprocedure), 'v',
  'desactivar es volátil: dentro del candado ve lo que confirmó quien lo tenía');
select is(pruebas.desactiva('b0000000-0000-0000-0000-000000000001', 'practices', 'naturaleza'), 'in_use', 'una práctica que usa un curso publicado: in_use');
select is((select is_active from public.practices where slug = 'naturaleza'), true, 'y sigue activa');
select is(pruebas.desactiva('b0000000-0000-0000-0000-000000000001', 'levels', 'principiante'), 'in_use', 'un nivel también');
select is(pruebas.desactiva('b0000000-0000-0000-0000-000000000001', 'practices', 'oceano'), 'unchanged',
  'una que ya está inactiva sigue contestando unchanged, aunque la use un curso');
select is(
  (select (p ->> 'in_use')::int from jsonb_array_elements(pruebas.listas_de('b0000000-0000-0000-0000-000000000001') -> 'practices') p where p ->> 'slug' = 'naturaleza'),
  (select count(*)::int from public.published_courses where practice_id = (select id from public.practices where slug = 'naturaleza')),
  'la lista dice cuántos cursos la usan, también los que esperan aprobación');
select ok(
  (select (p ->> 'in_use')::int from jsonb_array_elements(pruebas.listas_de('b0000000-0000-0000-0000-000000000001') -> 'practices') p where p ->> 'slug' = 'naturaleza') >= 2,
  '(y son varios: uno publicado y otros en revisión)');
-- Un curso retirado ya no la usa.
select pruebas.como_guion();
select is(private.system_catalog_add('practices', 'Retirada') ->> 'answer', 'added', 'el sistema agrega una práctica');
select is(private.system_load_course((select id from maestra), pruebas.curso('retirado-uno', 'retirada')) ->> 'answer', 'loaded',
  'carga un curso con ella');
update public.course_registry set state = 'withdrawn', first_published_at = now(), withdrawn_at = now(), withdrawal_reason = 'prueba'
  where course_id = pruebas.curso_por_slug('retirado-uno');
select pruebas.limpiar();
select is(
  (select (p ->> 'in_use')::int from jsonb_array_elements(pruebas.listas_de('b0000000-0000-0000-0000-000000000001') -> 'practices') p where p ->> 'slug' = 'retirada'),
  0, 'un curso retirado no cuenta');
select is(pruebas.desactiva('b0000000-0000-0000-0000-000000000001', 'practices', 'retirada'), 'deactivated', 'y la práctica se desactiva');
select is(pruebas.desactiva('b0000000-0000-0000-0000-000000000002', 'practices', 'naturaleza'), 'needs_fresh_code',
  'la puerta va antes que «en uso»');

-- ---------------------------------------------------------------------------------------
-- El guardián: aunque alguien le diera permiso al servidor, escribir directo no pasa.

select pruebas.como_dueno();
grant insert, update, delete on public.published_courses, public.video_assets to app_service;
select isnt_empty('select * from private.schema_violations()', 'con un permiso de más, el vigilante lo señala');
select pruebas.a_nombre_de('b0000000-0000-0000-0000-000000000001');
select throws_ok($$update public.published_courses set is_listed = true where slug = 'oceano-uno'$$,
  '42501', 'public.published_courses: only the publication functions write this table',
  'listar directo, aun con Contenido: el guardián lo rechaza');
select pruebas.limpiar();
select pruebas.como_sistema();
select set_config('app.local_courses', 'on', true);
select throws_ok($$update public.video_assets set provider_playback_id = 'otro'$$,
  '42501', 'public.video_assets: only the publication functions write this table',
  'ni el servidor declarado sistema, con el ajuste del guion puesto');
select pruebas.limpiar();
revoke insert, update, delete on public.published_courses, public.video_assets from app_service;
-- El dueño de la tabla, pero sin declararse sistema ni pasar la puerta, tampoco escribe.
select pruebas.como_dueno();
select throws_ok($$update public.published_teachers set is_listed = true$$,
  '42501', 'public.published_teachers: only the publication functions write this table',
  'el dueño sin declararse sistema no escribe');
select pruebas.limpiar();
select pruebas.dueno_a_nombre_de('b0000000-0000-0000-0000-000000000002');
select throws_ok($$update public.course_registry set state = 'published', first_published_at = now() where state = 'in_review'$$,
  '42501', 'public.course_registry: only the publication functions write this table',
  'ni a nombre de alguien con Contenido y un código de hace una hora');
select pruebas.limpiar();
select pruebas.dueno_a_nombre_de('b0000000-0000-0000-0000-000000000001');
select lives_ok($$update public.published_modules set title = title where false$$, '(a nombre de quien pasa la puerta, sí: es como aprueba)');
select pruebas.limpiar();
select is_empty('select * from private.schema_violations()', '(sin el permiso de más, en cero otra vez)');

select pruebas.como_dueno_sistema();
select throws_ok($$delete from public.published_lessons$$, '42501', 'public.published_lessons: rows are hidden, not deleted',
  'ni el dueño borra lo publicado');
-- Con `cascade`: desde T-206 el progreso apunta a las lecciones, y sin él la base se niega antes
-- de llegar al guardián.
select throws_ok($$truncate public.published_lessons cascade$$, '42501', 'public.published_lessons: rows are hidden, not deleted',
  'ni lo vacía');
-- Una lección no puede quedar en un módulo de otro curso: con su propio video, solo eso falla.
select throws_ok(
  $$insert into public.published_lessons (id, course_id, module_id, teacher_id, video_asset_id, title, position, duration_seconds)
    select gen_random_uuid(), l.course_id, (select id from public.published_modules where course_id = pruebas.curso_por_slug('oceano-uno')),
           l.teacher_id, l.video_asset_id, 'Cruzada', 9, 10
    from public.published_lessons l where l.course_id = pruebas.curso_por_slug('naturaleza-uno') limit 1$$,
  '23503', null, 'una lección no queda en un módulo de otro curso');
-- Ni con un video de otro curso: con su propio módulo, solo eso falla.
select throws_ok(
  $$insert into public.published_lessons (id, course_id, module_id, teacher_id, video_asset_id, title, position, duration_seconds)
    select gen_random_uuid(), l.course_id, l.module_id, l.teacher_id,
           (select id from public.video_assets where course_id = pruebas.curso_por_slug('oceano-uno') limit 1), 'Cruzada', 9, 10
    from public.published_lessons l where l.course_id = pruebas.curso_por_slug('naturaleza-uno') limit 1$$,
  '23503', null, 'ni con un video de otro curso');
select pruebas.limpiar();

select * from finish();
rollback;
