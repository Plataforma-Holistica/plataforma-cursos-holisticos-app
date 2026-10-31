-- T-404, primera solicitud · Los recursos del borrador (RF-605, FL-33, PA-43). Esquema §5.2 y §12.
-- Los escribe el maestro activo, por el servidor y con las funciones `private.resource_*`; lo lee su
-- maestro, sin la ruta del archivo. El archivo sube directo a la cubeta (Vercel corta un envío en 4.5 MB):
-- la fila nace antes que el objeto, con la ruta que pone la base, y un objeto que ninguna fila nombra
-- sobra. Las reglas del área `resources` del vigilante, del carril B, se provocan aquí.
begin;
\ir _ayuda.psql
select plan(158);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a7000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.m(p_n integer) returns uuid language sql immutable
as $$ select ('a7000000-0000-0000-0001-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.maestro(p_n integer) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  insert into public.teachers (id, profile_id, status) values (pruebas.m(p_n), pruebas.p(p_n), 'active');
  perform pruebas.limpiar();
end
$$;
-- Los ids que van naciendo, por nombre.
create table pruebas.ids (k text primary key, v uuid not null);
create function pruebas.id(p_k text) returns uuid language sql stable
as $$ select v from pruebas.ids where k = p_k $$;
-- Una función por el servidor, a nombre de una persona. Anota el id que conteste. Devuelve la respuesta.
create function pruebas.r(p_id uuid, p_call text, p_k text default null) returns text
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_id);
  execute 'select ' || p_call into v;
  perform pruebas.limpiar();
  if p_k is not null then
    insert into pruebas.ids values (p_k, coalesce(v ->> 'resource', v ->> 'course', v ->> 'module', v ->> 'lesson')::uuid);
  end if;
  return v ->> 'answer';
end
$$;
-- La misma llamada, con la respuesta entera.
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
create function pruebas.ruta(p_resource uuid) returns text language sql stable
as $$ select storage_path from public.draft_resources where id = p_resource $$;
-- Lo que deja Storage al terminar una subida.
create function pruebas.objeto(p_path text, p_size bigint, p_mime text) returns uuid
language sql as $$
  insert into storage.objects (bucket_id, name, version, metadata)
  values ('course-resources', p_path, gen_random_uuid()::text, jsonb_build_object('size', p_size, 'mimetype', p_mime))
  returning id
$$;
create function pruebas.empezar(p_id uuid, p_course uuid, p_lesson uuid, p_title text, p_k text,
                                p_kind text default 'pdf', p_mime text default 'application/pdf',
                                p_size bigint default 1000) returns text
language sql as $$
  select pruebas.r(p_id, format('private.resource_begin(%L, %L, %L, %L, %L, %s)',
                                p_course, p_lesson, p_title, p_kind, p_mime, p_size), p_k)
$$;
-- Empieza, sube y confirma: un recurso listo.
create function pruebas.listo(p_id uuid, p_course uuid, p_lesson uuid, p_title text, p_k text) returns text
language plpgsql as $$
begin
  perform pruebas.empezar(p_id, p_course, p_lesson, p_title, p_k);
  perform pruebas.objeto(pruebas.ruta(pruebas.id(p_k)), 1000, 'application/pdf');
  return pruebas.r(p_id, format('private.resource_confirm(%L, %L, true)', p_course, pruebas.id(p_k)));
end
$$;
create function pruebas.titulos(p_lesson uuid) returns text[] language sql stable
as $$ select coalesce(array_agg(title order by position), '{}') from public.draft_resources
      where lesson_id = p_lesson and state = 'ready' $$;
create function pruebas.del_curso(p_course uuid) returns text[] language sql stable
as $$ select coalesce(array_agg(title order by position), '{}') from public.draft_resources
      where course_id = p_course and lesson_id is null and state = 'ready' $$;
create function pruebas.contenido(p_course uuid) returns bigint language sql stable
as $$ select content_revision from public.course_drafts where course_id = p_course $$;
create function pruebas.vigila() returns text[]
language sql as $$
  select coalesce(array_agg(v.problem order by v.problem), '{}') from private.schema_violations_resources() v
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;
grant select on pruebas.ids to anon, authenticated, app_service;

-- Ana (1) y Beto (2), maestros activos; Caro (3), activa y después suspendida; Dani (4), alumna.
select pruebas.alta(pruebas.p(n), 'recursos-' || n || '@prueba.test') from generate_series(1, 4) n;
select pruebas.confirmar(pruebas.p(n)) from generate_series(1, 4) n;
select pruebas.maestro(1), pruebas.maestro(2), pruebas.maestro(3);

select pruebas.r(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), 'Respirar'), 'curso');
select pruebas.r(pruebas.p(2), format('private.draft_create(%L, %L)', gen_random_uuid(), 'De Beto'), 'beto');
select pruebas.r(pruebas.p(3), format('private.draft_create(%L, %L)', gen_random_uuid(), 'De Caro'), 'caro');
select pruebas.r(pruebas.p(1), format('private.draft_add_module(%L, 1, %L)', pruebas.id('curso'), 'Inicio'), 'modulo');
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, 1, %L)', pruebas.id('curso'), pruebas.id('modulo'), 'Una'), 'leccion');
select pruebas.r(pruebas.p(2), format('private.draft_add_module(%L, 1, %L)', pruebas.id('beto'), 'De Beto'), 'modulo_beto');
select pruebas.r(pruebas.p(2), format('private.draft_add_lesson(%L, %L, 1, %L)', pruebas.id('beto'), pruebas.id('modulo_beto'), 'De Beto'), 'leccion_beto');

-- ---------------------------------------------------------------------------------------
-- El vigilante y la cubeta, antes de todo.

select is_empty('select * from private.schema_violations()', 'el vigilante no dice nada');
select ok((select array_agg(function_name) from private.watchdog_areas()) @> array['schema_violations_resources'],
  'el área de los recursos está entre las áreas');
select is((select public from storage.buckets where id = 'course-resources'), false, 'la cubeta es privada');
select is((select file_size_limit from storage.buckets where id = 'course-resources'),
  (private.parameter_value('RECURSO_TAMANO_MAX'))::bigint, 'su tope es el del parámetro');
select is((select allowed_mime_types from storage.buckets where id = 'course-resources'),
  array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'audio/mpeg', 'audio/mp4'],
  'y admite solo los cuatro tipos, sin comodines (decisión de Sergio del 2026-10-30)');
select is((select count(*)::int from pg_catalog.pg_policy where polrelid = 'storage.objects'::regclass), 0,
  'nadie llega a los objetos por una política: solo el servidor firma');
select is((private.parameter_value('RECURSOS_POR_LUGAR_MAX'))::int, 10, 'el tope de recursos por lugar');

-- ---------------------------------------------------------------------------------------
-- Empezar una subida.

select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('leccion'), 'Guía', 'guia'), 'started',
  'la maestra empieza a subir a una lección suya');
select is((select row(teacher_id, course_id, lesson_id, kind, mime, size_bytes, state, position)::text
           from public.draft_resources where id = pruebas.id('guia')),
  row(pruebas.m(1), pruebas.id('curso'), pruebas.id('leccion'), 'pdf'::public.resource_kind, 'application/pdf',
      1000::bigint, 'pending'::public.resource_state, null::int)::text,
  'la fila nace pendiente y sin lugar en la lista');
select is(pruebas.ruta(pruebas.id('guia')),
  pruebas.m(1) || '/' || pruebas.id('curso') || '/' || pruebas.id('guia'),
  'la ruta la pone la base: el maestro, el curso y el recurso');
create temporary table respuesta on commit drop as
  select pruebas.rj(pruebas.p(1), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('curso'), 'Del curso', 'pdf', 'application/pdf')) as v;
select is((select v ->> 'path' from respuesta), (select storage_path from public.draft_resources where title = 'Del curso'),
  'y la contesta, para firmar la subida');
select is((select lesson_id from public.draft_resources where title = 'Del curso'), null::uuid, 'sin lección es del curso');

select is(pruebas.r(pruebas.p(2), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('curso'), 'Ajeno', 'pdf', 'application/pdf')),
  'not_found', 'al curso de otro maestro no');
select is(pruebas.r(pruebas.p(1), format('private.resource_begin(%L, %L, %L, %L, %L, 10)', pruebas.id('curso'), pruebas.id('leccion_beto'), 'Ajeno', 'pdf', 'application/pdf')),
  'not_found', 'ni a una lección de otro curso');
select is(pruebas.r(pruebas.p(4), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('curso'), 'Ajeno', 'pdf', 'application/pdf')),
  'not_teacher', 'quien no es maestro, no');

select is(pruebas.r(pruebas.p(1), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('curso'), '', 'pdf', 'application/pdf')),
  'invalid', 'sin título, no');
select is(pruebas.r(pruebas.p(1), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('curso'), repeat('a', 121), 'pdf', 'application/pdf')),
  'invalid', 'un título de 121, no');
select is(pruebas.r(pruebas.p(1), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('curso'), 'Mal', 'pdf', 'audio/mpeg')),
  'invalid', 'un tipo que no es de su clase, no');
select is(pruebas.r(pruebas.p(1), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('curso'), 'Mal', 'audio', 'video/mp4')),
  'invalid', 'un tipo fuera de la lista, no');
select is(pruebas.r(pruebas.p(1), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('curso'), 'Mal', 'exe', 'application/pdf')),
  'invalid', 'una clase que no existe, no');
select is(pruebas.r(pruebas.p(1), format('private.resource_begin(%L, null, %L, %L, %L, 0)', pruebas.id('curso'), 'Mal', 'pdf', 'application/pdf')),
  'invalid', 'un tamaño de cero, no');
select is(pruebas.r(pruebas.p(1), format('private.resource_begin(%L, null, %L, %L, %L, %s)', pruebas.id('curso'), 'Mal', 'pdf', 'application/pdf',
                                         (private.parameter_value('RECURSO_TAMANO_MAX'))::bigint + 1)),
  'too_large', 'uno de un byte más que el parámetro, no');
select is(pruebas.r(pruebas.p(1), format('private.resource_begin(%L, null, %L, %L, %L, %s)', pruebas.id('curso'), 'Justo', 'pdf', 'application/pdf',
                                         (private.parameter_value('RECURSO_TAMANO_MAX'))::bigint)),
  'started', 'uno del tamaño exacto, sí');
select is((select count(*)::int from public.draft_resources where title = 'Mal' or title = 'Ajeno'), 0, 'lo rechazado no dejó nada');

-- Los cuatro formatos, con su clase.
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('leccion'), 'Word', 'word', 'doc',
                          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'started', 'un Word');
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('leccion'), 'MP3', 'mp3', 'audio', 'audio/mpeg'), 'started', 'un MP3');
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('leccion'), 'M4A', 'm4a', 'audio', 'audio/mp4'), 'started', 'un M4A');

-- ---------------------------------------------------------------------------------------
-- Confirmar: compara lo que Storage guardó, que es lo que se va a servir.

select is(pruebas.r(pruebas.p(1), format('private.resource_confirm(%L, %L, true)', pruebas.id('curso'), pruebas.id('guia'))),
  'not_uploaded', 'sin objeto no se confirma');
select is((select state from public.draft_resources where id = pruebas.id('guia')), 'pending'::public.resource_state,
  'y la fila sigue pendiente');

select pruebas.objeto(pruebas.ruta(pruebas.id('guia')), 2048, 'application/pdf');
select is(pruebas.r(pruebas.p(2), format('private.resource_confirm(%L, %L, true)', pruebas.id('curso'), pruebas.id('guia'))),
  'not_found', 'otro maestro no confirma lo ajeno');
select is(pruebas.r(pruebas.p(1), format('private.resource_confirm(%L, %L, true)', pruebas.id('curso'), pruebas.id('guia'))),
  'ready', 'con su objeto, sí');
select is((select row(state, position, size_bytes)::text from public.draft_resources where id = pruebas.id('guia')),
  row('ready'::public.resource_state, 1, 2048::bigint)::text, 'queda lista, primera, con el tamaño de verdad');
select is((select object_id from public.draft_resources where id = pruebas.id('guia')),
  (select id from storage.objects where bucket_id = 'course-resources' and name = pruebas.ruta(pruebas.id('guia'))),
  'y recuerda qué objeto es');
select is((select object_version from public.draft_resources where id = pruebas.id('guia')),
  (select version from storage.objects where bucket_id = 'course-resources' and name = pruebas.ruta(pruebas.id('guia'))),
  'y su versión: un reemplazo conserva el id y cambia esta');
select is(pruebas.r(pruebas.p(1), format('private.resource_confirm(%L, %L, true)', pruebas.id('curso'), pruebas.id('guia'))),
  'ready', 'confirmar otra vez no cambia nada');
select is((select position from public.draft_resources where id = pruebas.id('guia')), 1, 'ni su lugar');

-- Un objeto con otro tipo del que se declaró: se rechaza y la fila se va, sin vuelta atrás.
select pruebas.objeto(pruebas.ruta(pruebas.id('word')), 2048, 'application/pdf');
select is(pruebas.rj(pruebas.p(1), format('private.resource_confirm(%L, %L, true)', pruebas.id('curso'), pruebas.id('word'))) ->> 'reason',
  'type', 'otro tipo guardado del declarado se rechaza');
select is((select count(*)::int from public.draft_resources where id = pruebas.id('word')), 0, 'la fila se fue');
select is(pruebas.r(pruebas.p(1), format('private.resource_confirm(%L, %L, true)', pruebas.id('curso'), pruebas.id('word'))),
  'not_found', 'y no hay cómo confirmarlo otra vez');

-- Un objeto más grande de lo permitido, aunque se haya declarado chico.
select pruebas.objeto(pruebas.ruta(pruebas.id('mp3')), (private.parameter_value('RECURSO_TAMANO_MAX'))::bigint + 1, 'audio/mpeg');
select is(pruebas.rj(pruebas.p(1), format('private.resource_confirm(%L, %L, true)', pruebas.id('curso'), pruebas.id('mp3'))) ->> 'reason',
  'size', 'más grande que el parámetro se rechaza');
select is((select count(*)::int from public.draft_resources where id = pruebas.id('mp3')), 0, 'y la fila se fue');

-- El contenido que el servidor leyó no era lo que dice.
select pruebas.objeto(pruebas.ruta(pruebas.id('m4a')), 1000, 'audio/mp4');
select is(pruebas.rj(pruebas.p(1), format('private.resource_confirm(%L, %L, false)', pruebas.id('curso'), pruebas.id('m4a'))) ->> 'reason',
  'content', 'si el contenido no es lo que dice, se rechaza');
select is((select count(*)::int from public.draft_resources where id = pruebas.id('m4a')), 0, 'y la fila se fue');

-- Un tamaño que no es un entero no tumba la función: cuenta como que no cabe.
select pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('leccion'), 'Raro', 'raro');
insert into storage.objects (bucket_id, name, version, metadata)
values ('course-resources', pruebas.ruta(pruebas.id('raro')), 'v1', '{"size": "abc", "mimetype": "application/pdf"}');
select is(pruebas.rj(pruebas.p(1), format('private.resource_confirm(%L, %L, true)', pruebas.id('curso'), pruebas.id('raro'))) ->> 'reason',
  'size', 'un tamaño raro se rechaza');

-- Lo que no se supo no se rechaza: la fila se queda para intentarlo otra vez.
select pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('leccion'), 'Dudosa', 'dudosa');
select pruebas.objeto(pruebas.ruta(pruebas.id('dudosa')), 1000, 'application/pdf');
select is(pruebas.r(pruebas.p(1), format('private.resource_confirm(%L, %L, null)', pruebas.id('curso'), pruebas.id('dudosa'))),
  'unavailable', 'si no se pudo leer el contenido, no se supo');
select is((select state from public.draft_resources where id = pruebas.id('dudosa')), 'pending'::public.resource_state, 'y la fila sigue');
select pruebas.como_dueno();
alter table public.business_parameters disable trigger user;
update public.business_parameters set canceled_at = now() where key = 'RECURSO_TAMANO_MAX' and canceled_at is null;
select pruebas.limpiar();
select is(pruebas.r(pruebas.p(1), format('private.resource_confirm(%L, %L, true)', pruebas.id('curso'), pruebas.id('dudosa'))),
  'unavailable', 'sin el parámetro, tampoco se supo');
select is((select state from public.draft_resources where id = pruebas.id('dudosa')), 'pending'::public.resource_state, 'y la fila sigue');
select is(pruebas.r(pruebas.p(1), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('curso'), 'Mal', 'pdf', 'application/pdf')),
  'unavailable', 'y sin el parámetro no se empieza');
select pruebas.como_dueno();
update public.business_parameters set canceled_at = null where key = 'RECURSO_TAMANO_MAX' and canceled_at is not null;
alter table public.business_parameters enable trigger user;
select pruebas.limpiar();
select is(pruebas.r(pruebas.p(1), format('private.resource_confirm(%L, %L, true)', pruebas.id('curso'), pruebas.id('dudosa'))),
  'ready', 'cuando se sabe, se confirma');

-- Un pendiente que pasó de su vida (la dirección dura 2 h, más un margen): ya no se confirma.
select pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('leccion'), 'Tarde', 'tarde');
select pruebas.objeto(pruebas.ruta(pruebas.id('tarde')), 1000, 'application/pdf');
select pruebas.como_dueno();
alter table public.draft_resources disable trigger draft_resources_guard;
update public.draft_resources set created_at = now() - interval '3 hours 1 minute' where id = pruebas.id('tarde');
alter table public.draft_resources enable trigger draft_resources_guard;
select pruebas.limpiar();
select is(pruebas.r(pruebas.p(1), format('private.resource_confirm(%L, %L, true)', pruebas.id('curso'), pruebas.id('tarde'))),
  'expired', 'un pendiente vencido no se confirma');
select is((select count(*)::int from public.draft_resources where id = pruebas.id('tarde')), 0, 'y la fila se fue');

-- ---------------------------------------------------------------------------------------
-- Lo que sobra: un objeto que ninguna fila nombra. Solo los del curso, y solo de su maestro.

create function pruebas.sobran(p_id uuid, p_course uuid) returns text[]
language plpgsql as $$
declare v text[];
begin
  perform pruebas.a_nombre_de(p_id);
  select coalesce(array_agg(u.path order by u.path), '{}') into v from private.resource_unused_objects(p_course) u;
  perform pruebas.limpiar();
  return v;
end
$$;
grant execute on function pruebas.sobran(uuid, uuid) to anon, authenticated, app_service;

select is(cardinality(pruebas.sobran(pruebas.p(1), pruebas.id('curso'))), 5,
  'sobran los cinco objetos de lo rechazado y lo vencido');
select ok(not pruebas.ruta(pruebas.id('guia')) = any(pruebas.sobran(pruebas.p(1), pruebas.id('curso'))),
  'un objeto que una fila nombra nunca sobra');
select is(cardinality(pruebas.sobran(pruebas.p(2), pruebas.id('curso'))), 0, 'a otro maestro no se le dicen');
select is(cardinality(pruebas.sobran(pruebas.p(4), pruebas.id('curso'))), 0, 'ni a quien no es maestro');
select pruebas.como_usuario(pruebas.p(1));
select throws_ok($$select * from private.resource_unused_objects(null)$$, '42501', null, 'la persona no la llama: es del servidor');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- La lista: renombrar, mover y quitar, con lo que se vio. Las revisiones ven los recursos.

select is(pruebas.listo(pruebas.p(1), pruebas.id('curso'), pruebas.id('leccion'), 'Segunda', 'segunda'), 'ready', 'una segunda');
select is(pruebas.listo(pruebas.p(1), pruebas.id('curso'), pruebas.id('leccion'), 'Tercera', 'tercera'), 'ready', 'una tercera');
select is(pruebas.titulos(pruebas.id('leccion')), array['Guía', 'Dudosa', 'Segunda', 'Tercera'], 'en el orden en que se confirmaron');
select is(pruebas.r(pruebas.p(1), format('private.resource_remove(%L, %L, 1)', pruebas.id('curso'), pruebas.id('dudosa'))), 'deleted', 'quitar una del medio');
select is(pruebas.titulos(pruebas.id('leccion')), array['Guía', 'Segunda', 'Tercera'], 'la lista se cierra');
select is(pruebas.listo(pruebas.p(1), pruebas.id('curso'), null, 'Del curso lista', 'curso1'), 'ready', 'una del curso');
select is((select position from public.draft_resources where id = pruebas.id('curso1')), 1,
  'los del curso llevan su propia lista');

select is(pruebas.r(pruebas.p(1), format('private.resource_move(%L, %L, 3, 1)', pruebas.id('curso'), pruebas.id('tercera'))), 'moved', 'mover al primer lugar');
select is(pruebas.titulos(pruebas.id('leccion')), array['Tercera', 'Guía', 'Segunda'], 'se recorren los demás');
select is(pruebas.r(pruebas.p(1), format('private.resource_move(%L, %L, 3, 1)', pruebas.id('curso'), pruebas.id('tercera'))), 'changed',
  'un «Subir» reenviado no sube dos veces');
select is(pruebas.r(pruebas.p(1), format('private.resource_move(%L, %L, 1, 9)', pruebas.id('curso'), pruebas.id('tercera'))), 'invalid', 'fuera de la lista, no');
select is(pruebas.r(pruebas.p(2), format('private.resource_move(%L, %L, 1, 2)', pruebas.id('curso'), pruebas.id('tercera'))), 'not_found', 'lo ajeno, no');

select is(pruebas.r(pruebas.p(1), format('private.resource_rename(%L, %L, 1, %L)', pruebas.id('curso'), pruebas.id('curso1'), 'Nuevo')), 'saved', 'renombrar');
select is(pruebas.r(pruebas.p(1), format('private.resource_rename(%L, %L, 1, %L)', pruebas.id('curso'), pruebas.id('curso1'), 'Otro')), 'changed',
  'con la revisión de antes contesta que cambió');
select is(pruebas.r(pruebas.p(1), format('private.resource_rename(%L, %L, 2, %L)', pruebas.id('curso'), pruebas.id('curso1'), '')), 'invalid', 'sin título, no');

-- Mi curso con un recurso ajeno: `draft_open` deja pasar, y lo detiene el filtro por curso.
select is(pruebas.listo(pruebas.p(2), pruebas.id('beto'), null, 'De Beto listo', 'beto_r'), 'ready', 'Beto tiene uno listo');
select is(pruebas.r(pruebas.p(1), format('private.resource_confirm(%L, %L, true)', pruebas.id('curso'), pruebas.id('beto_r'))), 'not_found', 'Ana no lo confirma desde su curso');
select is(pruebas.r(pruebas.p(1), format('private.resource_rename(%L, %L, 1, %L)', pruebas.id('curso'), pruebas.id('beto_r'), 'Mío')), 'not_found', 'ni lo renombra');
select is(pruebas.r(pruebas.p(1), format('private.resource_move(%L, %L, 1, 1)', pruebas.id('curso'), pruebas.id('beto_r'))), 'not_found', 'ni lo mueve');
select is(pruebas.r(pruebas.p(1), format('private.resource_remove(%L, %L, 1)', pruebas.id('curso'), pruebas.id('beto_r'))), 'not_found', 'ni lo quita');
select is((select row(title, revision)::text from public.draft_resources where id = pruebas.id('beto_r')),
  row('De Beto listo', 1::bigint)::text, 'y sigue igual');
select is(pruebas.r(pruebas.p(2), format('private.resource_rename(%L, %L, 1, %L)', pruebas.id('curso'), pruebas.id('curso1'), 'Mío')), 'not_found', 'Beto no renombra desde el curso de Ana');
select is(pruebas.r(pruebas.p(2), format('private.resource_remove(%L, %L, 2)', pruebas.id('curso'), pruebas.id('curso1'))), 'not_found', 'ni quita');

-- Un pendiente no se mueve (no está en la lista), y quitarlo no cambia lo que se vio.
select pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('leccion'), 'Cancelada', 'cancelada');
select is(pruebas.r(pruebas.p(1), format('private.resource_move(%L, %L, 1, 1)', pruebas.id('curso'), pruebas.id('cancelada'))), 'not_found', 'un pendiente no se mueve');
create temporary table sin_tocar on commit drop as select pruebas.contenido(pruebas.id('curso')) as contenido;
grant select on sin_tocar to anon, authenticated, app_service;
select is(pruebas.r(pruebas.p(1), format('private.resource_remove(%L, %L, 1)', pruebas.id('curso'), pruebas.id('cancelada'))), 'deleted', 'quitar un pendiente es cancelarlo');
select is(pruebas.contenido(pruebas.id('curso')), (select contenido from sin_tocar), 'sin subir revisiones: no estaba a la vista');

-- Las revisiones: borrar una lección o el curso lleva lo que se vio.
create temporary table antes on commit drop as
  select (select revision from public.draft_lessons where id = pruebas.id('leccion')) as leccion,
         (select revision from public.draft_modules where id = pruebas.id('modulo')) as modulo,
         pruebas.contenido(pruebas.id('curso')) as contenido;
grant select on antes to anon, authenticated, app_service;
select is(pruebas.r(pruebas.p(1), format('private.resource_remove(%L, %L, 2)', pruebas.id('curso'), pruebas.id('tercera'))), 'changed',
  'quitar con la revisión de antes contesta que cambió');
select is(pruebas.r(pruebas.p(1), format('private.resource_remove(%L, %L, 1)', pruebas.id('curso'), pruebas.id('tercera'))), 'deleted', 'quitar la primera');
select is(pruebas.titulos(pruebas.id('leccion')), array['Guía', 'Segunda'], 'la lista queda sin ella');
select is((select array_agg(position order by position) from public.draft_resources where lesson_id = pruebas.id('leccion') and state = 'ready'),
  array[1, 2], 'y sin hueco');
select ok((select revision from public.draft_lessons where id = pruebas.id('leccion')) > (select leccion from antes), 'quitar sube la revisión de la lección');
select ok((select revision from public.draft_modules where id = pruebas.id('modulo')) > (select modulo from antes), 'y la del módulo');
select ok(pruebas.contenido(pruebas.id('curso')) > (select contenido from antes), 'y la del contenido');
select ok(pruebas.ruta(pruebas.id('guia')) is not null, 'la ruta de lo que sigue no cambia');

-- El tope de recursos por lugar cuenta también lo pendiente, sin lo vencido.
do $$
begin
  for n in 1..8 loop
    perform pruebas.empezar(pruebas.p(2), pruebas.id('beto'), pruebas.id('leccion_beto'), 'Beto ' || n, 'beto' || n);
  end loop;
end
$$;
select is(pruebas.empezar(pruebas.p(2), pruebas.id('beto'), pruebas.id('leccion_beto'), 'Beto 9', 'beto9'), 'started', 'el noveno');
select is(pruebas.empezar(pruebas.p(2), pruebas.id('beto'), pruebas.id('leccion_beto'), 'Beto 10', 'beto10'), 'started', 'el décimo');
select is(pruebas.r(pruebas.p(2), format('private.resource_begin(%L, %L, %L, %L, %L, 10)', pruebas.id('beto'), pruebas.id('leccion_beto'), 'Beto 11', 'pdf', 'application/pdf')),
  'too_many', 'el undécimo, no');
select is(pruebas.r(pruebas.p(2), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('beto'), 'Del curso', 'pdf', 'application/pdf')),
  'started', 'cada lugar lleva su cuenta');

-- El freno: 20 subidas por hora por maestro, contadas al aceptar (TRD, límites).
create function pruebas.golpes(p_n integer) returns integer language sql stable
as $$ select hits from private.rate_limit_counters where bucket = 'resource_upload:' || pruebas.m(p_n) $$;
grant execute on function pruebas.golpes(integer) to anon, authenticated, app_service;
create temporary table golpes_antes on commit drop as select pruebas.golpes(2) as hits;
select is(pruebas.r(pruebas.p(2), format('private.resource_begin(%L, null, %L, %L, %L, 0)', pruebas.id('beto'), 'Mal', 'pdf', 'application/pdf')),
  'invalid', 'un rechazo');
select is(pruebas.golpes(2), (select hits from golpes_antes), 'no cuenta: solo lo aceptado');
select pruebas.como_dueno();
update private.rate_limit_counters set hits = 19 where bucket = 'resource_upload:' || pruebas.m(2);
select pruebas.limpiar();
select is(pruebas.r(pruebas.p(2), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('beto'), 'La 20', 'pdf', 'application/pdf')),
  'started', 'la subida 20 de la hora, sí');
select is(pruebas.golpes(2), 20, 'y cuenta');
select is(pruebas.r(pruebas.p(2), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('beto'), 'Frenado', 'pdf', 'application/pdf')),
  'throttled', 'la 21, no');
select is(pruebas.golpes(2), 20, 'y no cuenta');
select is((select count(*)::int from public.draft_resources where title = 'Frenado'), 0, 'y no deja fila');
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), null, 'Otra maestra', 'otra'), 'started', 'a otra maestra no le toca');

-- Un pendiente vencido ya no ocupa lugar en el tope, aunque el repaso no haya pasado.
select pruebas.como_dueno();
update private.rate_limit_counters set hits = 0 where bucket = 'resource_upload:' || pruebas.m(2);
alter table public.draft_resources disable trigger draft_resources_guard;
update public.draft_resources set created_at = now() - interval '3 hours 1 minute' where id = pruebas.id('beto1');
alter table public.draft_resources enable trigger draft_resources_guard;
select pruebas.limpiar();
select is(pruebas.empezar(pruebas.p(2), pruebas.id('beto'), pruebas.id('leccion_beto'), 'Beto otra vez', 'beto_otra'), 'started',
  'con uno vencido vuelve a caber');

-- ---------------------------------------------------------------------------------------
-- Quién lee y quién escribe.

select pruebas.como_usuario(pruebas.p(1));
select is((select count(*)::int from public.draft_resources where id = pruebas.id('guia')), 1, 'su maestra lee lo suyo');
select throws_ok('select storage_path from public.draft_resources', '42501', null, 'pero no la ruta del archivo');
select throws_ok('select object_id from public.draft_resources', '42501', null, 'ni qué objeto es');
select throws_ok($$update public.draft_resources set title = 'x'$$, '42501', null, 'y no escribe directo');
select throws_ok($$select private.resource_begin(null, null, 'x', 'pdf', 'application/pdf', 1)$$, '42501', null, 'ni llama a las funciones');
select throws_ok('select object_version from public.draft_resources', '42501', null, 'ni lee la versión');
select pruebas.como_usuario(pruebas.p(2));
select is((select count(*)::int from public.draft_resources where id = pruebas.id('guia')), 0, 'otro maestro no lo ve');
select pruebas.como_visitante();
select throws_ok('select id from public.draft_resources', '42501', null, 'el visitante tampoco');
select pruebas.limpiar();

-- Aunque se le conceda el permiso, el guardián no la deja escribir.
grant delete on public.draft_resources to app_service;
select pruebas.a_nombre_de(pruebas.p(1));
select throws_ok(format('delete from public.draft_resources where course_id = %L', pruebas.id('curso')), '42501', null,
  'con permiso concedido, el guardián no deja borrar');
select pruebas.limpiar();
revoke delete on public.draft_resources from app_service;

-- El maestro suspendido no sube ni confirma, pero sí se le dice lo que sobra.
select pruebas.empezar(pruebas.p(3), pruebas.id('caro'), null, 'De Caro', 'dc');
select pruebas.objeto(pruebas.ruta(pruebas.id('dc')), 1000, 'application/pdf');
select pruebas.empezar(pruebas.p(3), pruebas.id('caro'), null, 'Rechazada', 'caro_mal');
select pruebas.objeto(pruebas.ruta(pruebas.id('caro_mal')), 1000, 'audio/mpeg');
select pruebas.r(pruebas.p(3), format('private.resource_confirm(%L, %L, true)', pruebas.id('caro'), pruebas.id('caro_mal')));
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba' where id = pruebas.m(3);
select pruebas.limpiar();
select is(pruebas.r(pruebas.p(3), format('private.resource_confirm(%L, %L, true)', pruebas.id('caro'), pruebas.id('dc'))), 'suspended', 'suspendido no confirma');
select is(pruebas.r(pruebas.p(3), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('caro'), 'x', 'pdf', 'application/pdf')), 'suspended', 'ni empieza');
select is(pruebas.r(pruebas.p(3), format('private.resource_remove(%L, %L, 1)', pruebas.id('caro'), pruebas.id('dc'))), 'suspended', 'ni quita');
select is(cardinality(pruebas.sobran(pruebas.p(3), pruebas.id('caro'))), 1, 'lo que sobra sí se le dice: limpiar no le da nada');

-- Un curso que ya no está en borrador no se toca.
select pruebas.como_dueno_sistema();
update public.course_registry set state = 'in_review' where course_id = pruebas.id('beto');
select pruebas.limpiar();
select is(pruebas.r(pruebas.p(2), format('private.resource_begin(%L, null, %L, %L, %L, 10)', pruebas.id('beto'), 'x', 'pdf', 'application/pdf')), 'not_editable', 'no se sube a uno en revisión');
select is(pruebas.r(pruebas.p(2), format('private.resource_remove(%L, %L, 1)', pruebas.id('beto'), pruebas.id('beto_r'))), 'not_editable', 'ni se quita');
select pruebas.como_dueno_sistema();
update public.course_registry set state = 'draft' where course_id = pruebas.id('beto');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Borrar la lección o el curso se lleva las filas; sus objetos quedan como sobrantes.

select is(pruebas.r(pruebas.p(1), format('private.draft_delete_lesson(%L, %L, %s)', pruebas.id('curso'), pruebas.id('leccion'),
                                         (select revision from public.draft_lessons where id = pruebas.id('leccion')))), 'deleted', 'borrar la lección');
select is((select count(*)::int from public.draft_resources where lesson_id = pruebas.id('leccion')), 0, 'se lleva sus recursos');
select ok(pruebas.sobran(pruebas.p(1), pruebas.id('curso')) @> array[pruebas.m(1) || '/' || pruebas.id('curso') || '/' || pruebas.id('guia')],
  'y su objeto sobra');

-- Borrar el módulo y borrar el curso, también: el prefijo sigue diciendo lo que sobra, aunque el curso se haya ido.
select pruebas.r(pruebas.p(2), format('private.draft_add_module(%L, %s, %L)', pruebas.id('beto'),
  (select structure_revision from public.course_drafts where course_id = pruebas.id('beto')), 'Otro'), 'modulo2');
select pruebas.r(pruebas.p(2), format('private.draft_add_lesson(%L, %L, 1, %L)', pruebas.id('beto'), pruebas.id('modulo2'), 'Otra'), 'leccion2');
select pruebas.listo(pruebas.p(2), pruebas.id('beto'), pruebas.id('leccion2'), 'En el módulo', 'en_modulo');
select is(pruebas.r(pruebas.p(2), format('private.draft_delete_module(%L, %L, %s)', pruebas.id('beto'), pruebas.id('modulo2'),
                                         (select revision from public.draft_modules where id = pruebas.id('modulo2')))), 'deleted', 'borrar el módulo');
select is((select count(*)::int from public.draft_resources where lesson_id = pruebas.id('leccion2')), 0, 'se lleva los recursos de sus lecciones');
select ok(pruebas.sobran(pruebas.p(2), pruebas.id('beto')) @> array[pruebas.m(2) || '/' || pruebas.id('beto') || '/' || pruebas.id('en_modulo')],
  'y su objeto sobra');

-- ---------------------------------------------------------------------------------------
-- El repaso (quien opera): barre los pendientes vencidos y dice lo que sobra en toda la cubeta.

select pruebas.empezar(pruebas.p(1), pruebas.id('curso'), null, 'Vencida', 'vencida');
select pruebas.como_dueno();
alter table public.draft_resources disable trigger draft_resources_guard;
-- Uno listo y viejo: el repaso no lo toca.
update public.draft_resources set created_at = now() - interval '3 hours 1 minute' where id in (pruebas.id('vencida'), pruebas.id('curso1'));
alter table public.draft_resources enable trigger draft_resources_guard;
select pruebas.limpiar();
create temporary table barrido on commit drop as select * from private.resource_sweep();
select ok((select count(*) from barrido) >= 1, 'el repaso dice lo que sobra');
select ok(not exists (select 1 from barrido where path = pruebas.ruta(pruebas.id('curso1'))), 'un objeto que una fila nombra nunca sobra');
select ok(exists (select 1 from public.draft_resources where id = pruebas.id('curso1')), 'y lo listo, aunque sea viejo, se queda');
select is((select count(*)::int from public.draft_resources where id = pruebas.id('vencida')), 0, 'y se lleva los pendientes vencidos');
select ok(exists (select 1 from public.draft_resources where id = pruebas.id('beto10')), 'no los que siguen vivos');
select pruebas.como_usuario(pruebas.p(1));
select throws_ok('select * from private.resource_sweep()', '42501', null, 'no es de la aplicación');
select pruebas.limpiar();
select is(has_function_privilege('app_service', 'private.resource_sweep()', 'EXECUTE'), false, 'ni del servidor');

-- Borrar el curso entero (al final: las reglas de abajo no lo necesitan).
select is(pruebas.r(pruebas.p(1), format('private.draft_delete_course(%L, %s)', pruebas.id('curso'), pruebas.contenido(pruebas.id('curso')))), 'deleted', 'borrar el curso');
select is((select count(*)::int from public.draft_resources where course_id = pruebas.id('curso')), 0, 'se lleva sus recursos');
select ok(pruebas.sobran(pruebas.p(1), pruebas.id('curso')) @> array[pruebas.m(1) || '/' || pruebas.id('curso') || '/' || pruebas.id('curso1')],
  'y sus objetos sobran, aunque el curso ya no exista');

-- ---------------------------------------------------------------------------------------
-- Las reglas del vigilante se provocan.

select throws_ok('truncate public.draft_resources', '42501', null, 'ni el dueño vacía la tabla');
select is(pruebas.vigila(), '{}', 'el área está limpia');

update storage.buckets set public = true where id = 'course-resources';
select ok('resource bucket is public' = any(pruebas.vigila()), 'una cubeta pública se nota');
update storage.buckets set public = false where id = 'course-resources';

update storage.buckets set allowed_mime_types = array['application/pdf', 'image/*'] where id = 'course-resources';
select ok('resource bucket mime types differ' = any(pruebas.vigila()), 'un comodín en los tipos se nota');
update storage.buckets set allowed_mime_types = array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'audio/mpeg', 'audio/mp4'] where id = 'course-resources';

update storage.buckets set file_size_limit = 10 where id = 'course-resources';
select ok('resource bucket limit differs from the parameter' = any(pruebas.vigila()), 'un tope distinto del parámetro se nota');
update storage.buckets set file_size_limit = (private.parameter_value('RECURSO_TAMANO_MAX'))::bigint where id = 'course-resources';

grant select (storage_path) on public.draft_resources to authenticated;
select ok('resource path readable by authenticated' = any(pruebas.vigila()), 'la ruta a la vista se nota');
revoke select (storage_path) on public.draft_resources from authenticated;

grant execute on function private.resource_sweep() to app_service;
select ok('resource function executable by app_service' = any(pruebas.vigila()), 'el repaso en manos del servidor se nota');
revoke execute on function private.resource_sweep() from app_service;

-- Una política sobre `storage.objects`, o apagar su seguridad por fila, no se pueden provocar aquí: la
-- tabla es de `supabase_storage_admin`, y `postgres` no lo es. Arriba se comprueba que no hay ninguna.

grant insert on public.draft_resources to authenticated;
select ok('resource table writable by authenticated' = any(pruebas.vigila()), 've un permiso de escritura para la persona');
revoke insert on public.draft_resources from authenticated;
grant select (title) on public.draft_resources to anon;
select ok('resource table readable by anon' = any(pruebas.vigila()), 've que el visitante la lee');
revoke select (title) on public.draft_resources from anon;
grant select (object_version) on public.draft_resources to authenticated;
select ok('resource path readable by authenticated' = any(pruebas.vigila()), 've la versión del objeto a la vista');
revoke select (object_version) on public.draft_resources from authenticated;
alter table public.draft_resources disable row level security;
select ok('resource table without row level security' = any(pruebas.vigila()), 've la seguridad por fila apagada');
alter table public.draft_resources enable row level security;
create policy recursos_de_todos on public.draft_resources for select to authenticated using (true);
select ok('resource policy other than teacher read' = any(pruebas.vigila()), 've una política de más');
drop policy recursos_de_todos on public.draft_resources;
drop policy draft_resources_teacher_select on public.draft_resources;
select ok('resource table without its teacher read policy' = any(pruebas.vigila()), 've que falta la suya');
create policy draft_resources_teacher_select on public.draft_resources
  for select to authenticated using (teacher_id = (select private.current_teacher_id()));
alter table public.draft_resources disable trigger draft_resources_guard;
select ok('resource table without guard' = any(pruebas.vigila()), 've un guardián apagado');
alter table public.draft_resources enable trigger draft_resources_guard;
create trigger ajeno before insert on public.draft_resources for each row execute function private.guard_draft();
select ok('resource table with a foreign trigger' = any(pruebas.vigila()), 've un disparador ajeno');
drop trigger ajeno on public.draft_resources;
alter table public.draft_resources drop constraint draft_resources_mime_ok;
select ok('resource table without constraint draft_resources_mime_ok' = any(pruebas.vigila()), 've que falta una restricción');
alter table public.draft_resources add constraint draft_resources_mime_ok check (true);
select ok('resource table without constraint draft_resources_mime_ok' = any(pruebas.vigila()), 'y que no basta una con su nombre que no revisa nada');
alter table public.draft_resources drop constraint draft_resources_mime_ok;
alter table public.draft_resources add constraint draft_resources_mime_ok check (private.resource_mime_ok(kind, mime));
create function private.resource_extra() returns integer language sql as 'select 1';
select ok('resource function not in the watchdog area' = any(pruebas.vigila()), 've una función que el área no conoce');
drop function private.resource_extra();
alter function private.resource_remove(uuid, uuid, bigint) security invoker;
select ok('resource function not security definer' = any(pruebas.vigila()), 've una que dejó de ser security definer');
alter function private.resource_remove(uuid, uuid, bigint) security definer;
alter function private.resource_touch(uuid, uuid) reset search_path;
select ok('resource function without fixed search_path' = any(pruebas.vigila()), 've una sin el search_path fijo');
alter function private.resource_touch(uuid, uuid) set search_path = '';
revoke execute on function private.resource_confirm(uuid, uuid, boolean) from app_service;
select ok('resource function not executable by app_service' = any(pruebas.vigila()), 've que el servidor ya no ejecuta una');
grant execute on function private.resource_confirm(uuid, uuid, boolean) to app_service;

select is(pruebas.vigila(), '{}', 'y al deshacerlo queda limpia');
drop function private.resource_rename(uuid, uuid, bigint, text);
select ok('resource function missing' = any(pruebas.vigila()), 've una función que falta');

select * from finish();
rollback;
