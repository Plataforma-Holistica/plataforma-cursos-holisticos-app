-- T-108 · La cola de revisión (PA-61 y PA-62 mínimas; FL-45; RF-701). Decisiones de Sergio del
-- 2026-10-14: una sola pantalla, reproducir sin código reciente y aprobar con él. Lo que
-- la pantalla lee de la base es una sola función, `private.review_queue()`: nula para quien
-- no pasa la puerta de Contenido, y nunca con los identificadores del proveedor de video.
begin;
\ir _ayuda.psql
select plan(24);

select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido1@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000002', 'contenido2@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000001', 'config@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000003', 'contenido3@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000002', 'content');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'config');
-- La tercera tiene Contenido pero ningún factor atado: no tiene sesión de equipo.
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000003', 'content');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');
select pruebas.equipar('b0000000-0000-0000-0000-000000000002');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001');
-- La segunda persona con Contenido dio su código hace una hora.
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '1 hour'
  where session_id = pruebas.sesion('b0000000-0000-0000-0000-000000000002');

create function pruebas.cola_de(p_id uuid) returns jsonb
language sql as $$ select pruebas.pide(p_id, 'private.review_queue()')::jsonb $$;
-- Un curso de dos lecciones: la primera con el proveedor que se pida, la segunda de prueba.
create function pruebas.curso(p_slug text, p_provider text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', jsonb_build_array(
      jsonb_build_object('title', 'Lección uno', 'video',
        jsonb_build_object('provider', p_provider, 'asset_id', 'AssetRevision' || replace(p_slug, '-', ''),
                           'playback_id', 'PlaybackRevision' || replace(p_slug, '-', ''), 'duration_seconds', 356)),
      jsonb_build_object('title', 'Lección dos', 'video',
        jsonb_build_object('provider', 'test', 'asset_id', p_slug || '-a2', 'playback_id', 'prueba:' || p_slug, 'duration_seconds', 409))))))
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- La estructura y los permisos.

select has_function('private', 'review_queue', array[]::text[], 'existe private.review_queue()');
select ok(
  has_function_privilege('app_service', 'private.review_queue()', 'execute')
  and not has_function_privilege('authenticated', 'private.review_queue()', 'execute')
  and not has_function_privilege('anon', 'private.review_queue()', 'execute')
  and not has_function_privilege('service_role', 'private.review_queue()', 'execute'),
  'la cola la lee solo el servidor');
select ok((select prosecdef from pg_proc where oid = 'private.review_queue()'::regprocedure), 'es security definer');
select is((select provolatile from pg_proc where oid = 'private.review_queue()'::regprocedure), 's', 'y estable: no escribe');

-- ---------------------------------------------------------------------------------------
-- Dos cursos cargados por el sistema, como `pnpm db:courses`, y un tercero que se aprueba.

select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
create temporary table maestra as select private.system_add_teacher('Maestra de revisión', 'maestra-de-revision', null) as id;
create temporary table cargado as
  select slug, (private.system_load_course((select id from maestra), pruebas.curso(slug, provider)) ->> 'answer') as answer
  from (values ('curso-viejo', 'mux'), ('curso-nuevo', 'test'), ('curso-aprobado', 'mux')) as v (slug, provider);
select is((select count(*) from cargado where answer = 'loaded'), 3::bigint, 'los tres cursos se cargan');
-- El más antiguo se cargó antes.
update public.course_registry set created_at = now() - interval '2 days'
  where course_id = (select course_id from public.published_courses where slug = 'curso-viejo');
update public.course_registry set created_at = now() - interval '1 day'
  where course_id = (select course_id from public.published_courses where slug = 'curso-aprobado');
select pruebas.limpiar();
select is(
  pruebas.pide('b0000000-0000-0000-0000-000000000001',
    format('private.approve_course(%L)', (select course_id from public.published_courses where slug = 'curso-aprobado'))),
  'approved', 'uno se aprueba');

-- ---------------------------------------------------------------------------------------
-- Quién la lee.

select is(pruebas.cola_de('a0000000-0000-0000-0000-000000000001'), null, 'una cuenta común: nula');
select is(pruebas.cola_de('c0000000-0000-0000-0000-000000000001'), null, 'del equipo sin Contenido: nula');
select is((select private.review_queue()), null, 'sin nadie que actúe: nula');
select is(pruebas.cola_de('b0000000-0000-0000-0000-000000000003'), null,
  'con Contenido y sin sesión de equipo (sin factor atado): nula');
select pruebas.sin_codigo('b0000000-0000-0000-0000-000000000001');
select pruebas.limpiar();
select ok((pruebas.cola_de('b0000000-0000-0000-0000-000000000002') ->> 'fresh_code')::boolean = false,
  'con Contenido y el código de hace una hora: la lee, sin código reciente');
select is(jsonb_array_length(pruebas.cola_de('b0000000-0000-0000-0000-000000000002') -> 'courses'), 2,
  'y ve la cola entera: leer no pide el código');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');
select ok((pruebas.cola_de('b0000000-0000-0000-0000-000000000001') ->> 'fresh_code')::boolean,
  'con el código reciente: fresh_code');

-- ---------------------------------------------------------------------------------------
-- Lo que trae.

create temporary table cola as select pruebas.cola_de('b0000000-0000-0000-0000-000000000001') as q;
select is(
  (select array_agg(c ->> 'title' order by o) from cola, jsonb_array_elements(q -> 'courses') with ordinality as e (c, o)),
  array['Curso curso-viejo', 'Curso curso-nuevo'], 'solo los que están en revisión, el más antiguo primero');
select is(
  (select jsonb_object_keys_set from (select array_agg(k order by k) as jsonb_object_keys_set
     from cola, jsonb_object_keys(q -> 'courses' -> 0) as k) x),
  array['course_id', 'lesson_count', 'lessons', 'level', 'loaded_at', 'practice', 'teacher_listed', 'teacher_name',
        'title', 'total_duration_seconds'],
  'de cada curso, solo esto');
select is(
  (select array_agg(k order by k) from cola, jsonb_object_keys(q -> 'courses' -> 0 -> 'lessons' -> 0) as k),
  array['duration_seconds', 'lesson_id', 'module', 'module_id', 'title', 'video'],
  'de cada lección, solo esto');
select is((select q -> 'courses' -> 0 ->> 'teacher_name' from cola), 'Maestra de revisión', 'el maestro, por su nombre publicado');
select is((select (q -> 'courses' -> 0 ->> 'teacher_listed')::boolean from cola), true,
  'su ficha ya está listada: aprobar el otro curso la listó');
select is((select q -> 'courses' -> 0 ->> 'practice' from cola), 'Naturaleza', 'la práctica, por su nombre');
select is(
  (select array_agg(l ->> 'video' order by o) from cola, jsonb_array_elements(q -> 'courses' -> 0 -> 'lessons') with ordinality as e (l, o)),
  array['playable', 'test'], 'el video de Mux listo se puede ver; el de prueba lo dice');
select ok(
  (select q::text not like '%PlaybackRevision%' and q::text not like '%AssetRevision%' and q::text not like '%prueba:%' from cola),
  'nunca trae el playback id ni el asset id');

-- Los estados del video que el guion no deja: el sistema los pone a mano.
select pruebas.como_dueno_sistema();
update public.video_assets set status = 'processing'
  where provider_asset_id = 'AssetRevisioncursoviejo';
select pruebas.limpiar();
select is((pruebas.cola_de('b0000000-0000-0000-0000-000000000001') -> 'courses' -> 0 -> 'lessons' -> 0 ->> 'video'), 'processing',
  'un video de Mux sin terminar: processing');
select pruebas.como_dueno_sistema();
update public.video_assets set status = 'errored', error_code = 'prueba'
  where provider_asset_id = 'AssetRevisioncursoviejo';
select pruebas.limpiar();
select is((pruebas.cola_de('b0000000-0000-0000-0000-000000000001') -> 'courses' -> 0 -> 'lessons' -> 0 ->> 'video'), 'errored',
  'uno que falló: errored');

select is_empty('select * from private.schema_violations()', 'private.schema_violations() sigue en cero');

select * from finish();
rollback;
