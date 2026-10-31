-- T-404, tercera solicitud · Los recursos publicados y quién los baja (RF-308, RF-306, FL-14). Esquema §5.3 y §12.
-- `published_resources` la escribe solo el dueño declarado sistema, como lo demás publicado, hasta T-405 y T-406. La gente
-- ve la lista sin la ruta del archivo; bajar pasa por la puerta de medios, y aquí se prueban sus hechos, su segunda barrera
-- (`resource_object`, hermana de `lesson_playback`) y su freno. Las reglas del área `resources` se provocan aquí.
begin;
\ir _ayuda.psql
select plan(89);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a7100000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.m(p_n integer) returns uuid language sql immutable
as $$ select ('a7100000-0000-0000-0001-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.curso(p_n integer) returns uuid language sql immutable
as $$ select ('a7100000-0000-0000-0002-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.modulo(p_n integer) returns uuid language sql immutable
as $$ select ('a7100000-0000-0000-0003-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.leccion(p_n integer) returns uuid language sql immutable
as $$ select ('a7100000-0000-0000-0004-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.recurso(p_n integer) returns uuid language sql immutable
as $$ select ('a7100000-0000-0000-0005-' || lpad(p_n::text, 12, '0'))::uuid $$;

-- Ana (1), maestra dueña; Beto (2), otro maestro; Caro (3), alumna sin suscripción; Eva (4), de Contenido.
select pruebas.alta(pruebas.p(n), 'publicados-' || n || '@prueba.test') from generate_series(1, 4) n;
select pruebas.confirmar(pruebas.p(n)) from generate_series(1, 4) n;
select pruebas.dar_capacidad(pruebas.p(4), 'content');
select pruebas.equipar(pruebas.p(4));

select pruebas.como_dueno_sistema();
insert into public.teachers (id, profile_id, status) values (pruebas.m(1), pruebas.p(1), 'active'), (pruebas.m(2), pruebas.p(2), 'active');
insert into public.published_teachers (teacher_id, slug, display_name, is_listed)
values (pruebas.m(1), 'ana-publicados', 'Ana', true), (pruebas.m(2), 'beto-publicados', 'Beto', true);
-- El curso 1, publicado y listado; el 2, sin listar; el 3, con cambios pendientes; el 4, retirado; el 5, abierto.
insert into public.course_registry (course_id, teacher_id, state, first_published_at)
select pruebas.curso(n), pruebas.m(1), 'published', now() from generate_series(1, 5) n;
insert into public.published_courses (course_id, teacher_id, slug, title, teacher_name, lesson_count, total_duration_seconds, is_listed)
select pruebas.curso(n), pruebas.m(1), 'publicados-' || n, 'Curso ' || n, 'Ana', 1, 60, n not in (2, 4)
from generate_series(1, 5) n;
insert into public.published_modules (id, course_id, title, position)
select pruebas.modulo(n), pruebas.curso(n), 'Módulo', 1 from generate_series(1, 5) n;
insert into public.video_assets (id, course_id, teacher_id, lesson_id, provider, status, duration_seconds, provider_asset_id, provider_playback_id)
select pruebas.leccion(n + 100), pruebas.curso(n), pruebas.m(1), pruebas.leccion(n), 'mux', 'ready', 60, 'asset-pub-' || n, 'playback-pub-' || n from generate_series(1, 5) n;
insert into public.published_lessons (id, course_id, teacher_id, module_id, title, position, duration_seconds, video_asset_id)
select pruebas.leccion(n), pruebas.curso(n), pruebas.m(1), pruebas.modulo(n), 'Lección', 1, 60, pruebas.leccion(n + 100) from generate_series(1, 5) n;
update public.course_registry set state = 'changes_pending', pending_version_state = 'draft' where course_id = pruebas.curso(3);
update public.course_registry set state = 'withdrawn', withdrawn_at = now(), withdrawal_reason = 'prueba' where course_id = pruebas.curso(4);
select pruebas.limpiar();

create function pruebas.objeto(p_path text) returns uuid
language sql as $$
  insert into storage.objects (bucket_id, name, version, metadata)
  values ('course-resources', p_path, 'v1', jsonb_build_object('size', 100, 'mimetype', 'application/pdf'))
  returning id
$$;
-- Un recurso publicado con su objeto, como el dueño declarado sistema.
create function pruebas.publicar(p_n integer, p_curso integer, p_leccion integer, p_position integer default 1) returns void
language plpgsql as $$
declare
  v_path text := pruebas.m(1) || '/' || pruebas.curso(p_curso) || '/' || pruebas.recurso(p_n);
  v_object uuid := pruebas.objeto(v_path);
begin
  perform pruebas.como_dueno_sistema();
  insert into public.published_resources (id, course_id, teacher_id, lesson_id, title, kind, mime, storage_path, object_id, object_version, size_bytes, position)
  values (pruebas.recurso(p_n), pruebas.curso(p_curso), pruebas.m(1), case when p_leccion is null then null else pruebas.leccion(p_leccion) end,
          'Recurso ' || p_n, 'pdf', 'application/pdf', v_path, v_object, 'v1', 100, p_position);
  perform pruebas.limpiar();
end
$$;
-- Lo que suelta la barrera, a nombre de una persona.
create function pruebas.barrera(p_id uuid, p_recurso uuid) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.resource_object(p_recurso);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.hechos(p_id uuid, p_recurso uuid) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.resource_facts(p_recurso);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.borrador(p_id uuid, p_curso uuid, p_recurso uuid) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.resource_draft_object(p_curso, p_recurso);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.golpe(p_id uuid) returns text
language plpgsql as $$
declare v text;
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.resource_download_hit();
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.vigila() returns text[]
language sql as $$
  select coalesce(array_agg(v.problem order by v.problem), '{}') from private.schema_violations_resources() v
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.publicar(1, 1, 1);         -- de la lección, en el curso listado
select pruebas.publicar(2, 1, null);      -- del curso listado
select pruebas.publicar(3, 2, 2);         -- del curso sin listar
select pruebas.publicar(4, 3, 3);         -- del curso con cambios pendientes
select pruebas.publicar(5, 4, 4);         -- del curso retirado
select pruebas.publicar(6, 5, 5);         -- del curso abierto

-- ---------------------------------------------------------------------------------------
-- El vigilante, antes de todo.

select is_empty('select * from private.schema_violations()', 'el vigilante no dice nada');
select is((private.parameter_value('TOPE_DESCARGAS_HORA'))::int, 60, 'el tope de descargas');

-- ---------------------------------------------------------------------------------------
-- Quién lee la lista: sin la ruta, y solo lo vigente de lo listado.

select pruebas.como_visitante();
select is((select count(*)::int from public.published_resources where id = pruebas.recurso(1)), 1, 'el visitante ve un recurso de un curso listado');
select is((select title from public.published_resources where id = pruebas.recurso(2)), 'Recurso 2', 'también el del curso');
select is((select count(*)::int from public.published_resources where id = pruebas.recurso(3)), 0, 'no el de un curso sin listar');
select throws_ok('select storage_path from public.published_resources', '42501', null, 'ni la ruta del archivo');
select throws_ok('select object_id from public.published_resources', '42501', null, 'ni qué objeto es');
select throws_ok('select object_version from public.published_resources', '42501', null, 'ni su versión');
select throws_ok($$update public.published_resources set title = 'x'$$, '42501', null, 'y no escribe');
select pruebas.como_usuario(pruebas.p(3));
select is((select count(*)::int from public.published_resources where id = pruebas.recurso(3)), 0, 'la alumna tampoco ve el de un curso sin listar');
select throws_ok('select storage_path from public.published_resources', '42501', null, 'ni la ruta');
select pruebas.como_usuario(pruebas.p(1));
select is((select count(*)::int from public.published_resources where id = pruebas.recurso(3)), 1, 'su maestra sí ve lo suyo sin listar');
select pruebas.como_usuario(pruebas.p(4), 'aal2');
select is((select count(*)::int from public.published_resources where id = pruebas.recurso(3)), 1, 'Contenido también');
select pruebas.limpiar();

-- Una lección retirada se lleva de la vista sus recursos, aunque ellos sigan vigentes.
select pruebas.publicar(7, 1, null, 2);
select pruebas.como_dueno_sistema();
insert into public.published_lessons (id, course_id, teacher_id, module_id, title, position, duration_seconds, video_asset_id, is_current, retired_at)
values (pruebas.leccion(9), pruebas.curso(1), pruebas.m(1), pruebas.modulo(1), 'Retirada', 9, 60, pruebas.leccion(101), false, now());
select pruebas.limpiar();
select pruebas.publicar(8, 1, 9);
select pruebas.como_visitante();
select is((select count(*)::int from public.published_resources where id = pruebas.recurso(8)), 0, 'el recurso de una lección retirada no se ve');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Quién escribe.

select pruebas.como_dueno();
select throws_ok(format($$update public.published_resources set title = 'x' where id = %L$$, pruebas.recurso(1)), '42501', null, 'ni el dueño sin declararse sistema');
select throws_ok(format('delete from public.published_resources where id = %L', pruebas.recurso(1)), '42501', null, 'y no se borra');
select throws_ok('truncate public.published_resources', '42501', null, 'ni se vacía');
select pruebas.limpiar();
select pruebas.como_dueno_sistema();
select throws_ok(format('delete from public.published_resources where id = %L', pruebas.recurso(1)), '42501', null, 'ni como sistema: se retira, no se borra');
select pruebas.limpiar();

-- Las restricciones.
select pruebas.como_dueno_sistema();
select throws_ok(format($$insert into public.published_resources (course_id, teacher_id, title, kind, mime, storage_path, object_id, object_version, size_bytes, position)
  values (%L, %L, 'Otra ruta', 'pdf', 'application/pdf', 'otro/lado/archivo', gen_random_uuid(), 'v', 1, 5)$$, pruebas.curso(1), pruebas.m(1)), '23514', null,
  'la ruta empieza por su maestro y su curso');
select throws_ok(format($$insert into public.published_resources (course_id, teacher_id, title, kind, mime, storage_path, object_id, object_version, size_bytes, position)
  values (%L, %L, 'Tipo', 'pdf', 'audio/mpeg', %L, gen_random_uuid(), 'v', 1, 5)$$, pruebas.curso(1), pruebas.m(1), pruebas.m(1) || '/' || pruebas.curso(1) || '/z1'), '23514', null,
  'el tipo es de su clase');
select throws_ok(format($$insert into public.published_resources (course_id, teacher_id, title, kind, mime, storage_path, object_id, object_version, size_bytes, position)
  values (%L, %L, 'Mismo lugar', 'pdf', 'application/pdf', %L, gen_random_uuid(), 'v', 1, 1)$$, pruebas.curso(1), pruebas.m(1), pruebas.m(1) || '/' || pruebas.curso(1) || '/z2'), '23505', null,
  'dos vigentes no comparten lugar, tampoco los del curso');
select throws_ok(format($$insert into public.published_resources (course_id, teacher_id, lesson_id, title, kind, mime, storage_path, object_id, object_version, size_bytes, position)
  values (%L, %L, %L, 'Ajena', 'pdf', 'application/pdf', %L, gen_random_uuid(), 'v', 1, 7)$$, pruebas.curso(1), pruebas.m(1), pruebas.leccion(2), pruebas.m(1) || '/' || pruebas.curso(1) || '/z3'), '23503', null,
  'ni cuelga de una lección de otro curso');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Los hechos, para la regla.

select is(pruebas.hechos(pruebas.p(3), pruebas.recurso(1)) -> 'resource' ->> 'is_current', 'true', 'la lección y el recurso vigentes');
select is(pruebas.hechos(pruebas.p(3), pruebas.recurso(8)) -> 'resource' ->> 'is_current', 'false', 'con su lección retirada, ya no');
select is(pruebas.hechos(pruebas.p(3), pruebas.recurso(1)) -> 'resource' ->> 'teacher_id', pruebas.m(1)::text, 'de quién es');
select is(pruebas.hechos(pruebas.p(3), pruebas.recurso(4)) -> 'resource' ->> 'course_state', 'changes_pending', 'el estado del curso');
select is(pruebas.hechos(pruebas.p(3), pruebas.recurso(3)) -> 'resource' ->> 'listed', 'false', 'si está listado');
select is(pruebas.hechos(pruebas.p(3), gen_random_uuid()) -> 'resource', 'null'::jsonb, 'de lo que no existe, nada');
select is(pruebas.hechos(pruebas.p(3), pruebas.recurso(1)) -> 'viewer' ->> 'suspended', 'false', 'y los hechos de la cuenta');
select ok(not (pruebas.hechos(pruebas.p(3), pruebas.recurso(1)) -> 'viewer') ? 'email', 'sin su correo: un recurso no lleva marca de agua');
select is(pruebas.hechos(null, pruebas.recurso(1)), null, 'sin nadie que actúe, nada');
select pruebas.como_dueno_sistema();
update public.course_registry set is_open = true, open_since = now() where course_id = pruebas.curso(5);
select pruebas.limpiar();
select is(pruebas.hechos(pruebas.p(3), pruebas.recurso(6)) -> 'resource' ->> 'is_open', 'true', 'si el curso es abierto, lo dice el registro');

-- ---------------------------------------------------------------------------------------
-- La segunda barrera: la ruta sale solo si se puede.

select is(pruebas.barrera(pruebas.p(3), pruebas.recurso(1)) ->> 'path', pruebas.m(1) || '/' || pruebas.curso(1) || '/' || pruebas.recurso(1), 'de un curso publicado y listado, suelta la ruta');
select is(pruebas.barrera(pruebas.p(3), pruebas.recurso(1)) ->> 'mime', 'application/pdf', 'su tipo');
select is(pruebas.barrera(pruebas.p(3), pruebas.recurso(1)) ->> 'title', 'Recurso 1', 'y su título');
select ok(pruebas.barrera(pruebas.p(3), pruebas.recurso(4)) is not null, 'también con cambios pendientes: la regla los deja pasar, y no deben contradecirse');
select is(pruebas.barrera(pruebas.p(3), pruebas.recurso(3)), null, 'de uno sin listar, no');
select is(pruebas.barrera(pruebas.p(3), pruebas.recurso(5)), null, 'de uno retirado, no');
select is(pruebas.barrera(pruebas.p(3), pruebas.recurso(8)), null, 'de una lección retirada, no');
-- Listado y en un estado que no se ve: lo decide el estado, no la lista.
select pruebas.como_dueno_sistema();
update public.course_registry set state = 'withdrawn', withdrawn_at = now(), withdrawal_reason = 'prueba' where course_id = pruebas.curso(1);
select pruebas.limpiar();
select is(pruebas.barrera(pruebas.p(3), pruebas.recurso(1)), null, 'de un curso listado pero retirado, no');
select is(pruebas.hechos(pruebas.p(3), pruebas.recurso(1)) -> 'resource' ->> 'course_state', 'withdrawn', 'y los hechos dicen el estado');
select pruebas.como_dueno_sistema();
update public.course_registry set state = 'in_review', withdrawn_at = null, withdrawal_reason = null where course_id = pruebas.curso(1);
select pruebas.limpiar();
select is(pruebas.barrera(pruebas.p(3), pruebas.recurso(1)), null, 'de un curso listado pero en revisión, no');
select pruebas.como_dueno_sistema();
update public.course_registry set state = 'published' where course_id = pruebas.curso(1);
select pruebas.limpiar();
-- Un recurso retirado no sale por ningún lado, ni a su maestra. T-405 será quien los escriba.
select pruebas.publicar(9, 1, null, 3);
select pruebas.como_dueno_sistema();
update public.published_resources set is_current = false, retired_at = now() where id = pruebas.recurso(9);
select pruebas.limpiar();
select is(pruebas.barrera(pruebas.p(3), pruebas.recurso(9)), null, 'de un recurso retirado, no');
select is(pruebas.barrera(pruebas.p(1), pruebas.recurso(9)), null, 'ni a su maestra');
select is(pruebas.hechos(pruebas.p(3), pruebas.recurso(9)) -> 'resource' ->> 'is_current', 'false', 'y los hechos lo dicen');
select pruebas.como_visitante();
select is((select count(*)::int from public.published_resources where id = pruebas.recurso(9)), 0, 'y no se enumera');
select pruebas.limpiar();
select is(pruebas.barrera(pruebas.p(3), gen_random_uuid()), null, 'de lo que no existe, no');
select is(pruebas.barrera(null, pruebas.recurso(1)), null, 'sin nadie que actúe, no');
select ok(pruebas.barrera(pruebas.p(1), pruebas.recurso(3)) is not null, 'a su maestra, de uno sin listar, sí');
select ok(pruebas.barrera(pruebas.p(1), pruebas.recurso(5)) is not null, 'y de uno retirado');
select is(pruebas.barrera(pruebas.p(2), pruebas.recurso(3)), null, 'a otro maestro, no');
select is(pruebas.barrera(pruebas.p(4), pruebas.recurso(3)), null, 'a Contenido, no: su regla llega con T-405');

-- Suspendida como maestra, sigue siendo lo suyo.
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba', suspension_notice = 'x' where id = pruebas.m(1);
select pruebas.limpiar();
select ok(pruebas.barrera(pruebas.p(1), pruebas.recurso(3)) is not null, 'la maestra suspendida baja lo suyo');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'active', suspended_at = null, suspension_reason = null, suspension_notice = null where id = pruebas.m(1);
select pruebas.limpiar();

-- Si el objeto no es el que se publicó, no se firma.
update storage.objects set version = 'v2' where bucket_id = 'course-resources' and name = pruebas.m(1) || '/' || pruebas.curso(1) || '/' || pruebas.recurso(1);
select is(pruebas.barrera(pruebas.p(3), pruebas.recurso(1)), null, 'un objeto reemplazado no se suelta');
update storage.objects set version = 'v1' where bucket_id = 'course-resources' and name = pruebas.m(1) || '/' || pruebas.curso(1) || '/' || pruebas.recurso(1);
select ok(pruebas.barrera(pruebas.p(3), pruebas.recurso(1)) is not null, 'con el suyo, sí');
-- Otra fila con otro id para el mismo nombre: el id también se compara.
select pruebas.como_dueno_sistema();
update public.published_resources set object_id = gen_random_uuid() where id = pruebas.recurso(2);
select pruebas.limpiar();
select is(pruebas.barrera(pruebas.p(3), pruebas.recurso(2)), null, 'otro objeto con su nombre tampoco');

select pruebas.como_usuario(pruebas.p(3));
select throws_ok('select private.resource_object(null)', '42501', null, 'la persona no llama a la barrera');
select throws_ok('select private.resource_facts(null)', '42501', null, 'ni a los hechos');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- El borrador: su maestro baja lo que subió, también suspendido; nadie más.

select pruebas.como_dueno_sistema();
insert into public.teachers (id, profile_id, status) values (pruebas.m(3), pruebas.p(3), 'active');
select pruebas.limpiar();
select set_config('app.actor_id', pruebas.p(3)::text, true);
insert into public.consents (profile_id, legal_document_id, origin)
select pruebas.p(3), private.current_legal_document('teacher_privacy_notice'), 'account_settings' where private.current_legal_document('teacher_privacy_notice') is not null;
select pruebas.limpiar();
do $$
begin
  if private.current_legal_document('teacher_privacy_notice') is null then
    perform pruebas.como_dueno_sistema();
    insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now());
    perform pruebas.limpiar();
    perform set_config('app.actor_id', pruebas.p(3)::text, true);
    insert into public.consents (profile_id, legal_document_id, origin)
    values (pruebas.p(3), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
    perform pruebas.limpiar();
  end if;
end
$$;
create table pruebas.borradores (k text primary key, v uuid);
grant select on pruebas.borradores to anon, authenticated, app_service;
do $$
declare
  v jsonb;
  v_course uuid;
  v_ready uuid;
  v_pending uuid;
begin
  perform pruebas.a_nombre_de(pruebas.p(3));
  v := private.draft_create(gen_random_uuid(), 'Mi borrador');
  v_course := (v ->> 'course')::uuid;
  v := private.resource_begin(v_course, null, 'Lista', 'pdf', 'application/pdf', 10);
  v_ready := (v ->> 'resource')::uuid;
  perform pruebas.limpiar();
  perform pruebas.objeto(v ->> 'path');
  perform pruebas.a_nombre_de(pruebas.p(3));
  perform private.resource_confirm(v_course, v_ready, true);
  v := private.resource_begin(v_course, null, 'Pendiente', 'pdf', 'application/pdf', 10);
  v_pending := (v ->> 'resource')::uuid;
  perform pruebas.limpiar();
  insert into pruebas.borradores values ('curso', v_course), ('listo', v_ready), ('pendiente', v_pending);
end
$$;
create function pruebas.b(p_k text) returns uuid language sql stable as $$ select v from pruebas.borradores where k = p_k $$;
grant execute on function pruebas.b(text) to anon, authenticated, app_service;
select is(pruebas.borrador(pruebas.p(3), pruebas.b('curso'), pruebas.b('listo')) ->> 'title', 'Lista', 'su maestra baja lo que subió');
select is(pruebas.borrador(pruebas.p(3), pruebas.b('curso'), pruebas.b('pendiente')), null, 'lo pendiente, no');
select is(pruebas.borrador(pruebas.p(2), pruebas.b('curso'), pruebas.b('listo')), null, 'otro maestro, no');
select is(pruebas.borrador(pruebas.p(4), pruebas.b('curso'), pruebas.b('listo')), null, 'Contenido, no: el borrador no lo ve (RF-612)');
select is(pruebas.borrador(pruebas.p(3), pruebas.curso(1), pruebas.b('listo')), null, 'desde otro curso, no');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba', suspension_notice = 'x' where id = pruebas.m(3);
select pruebas.limpiar();
select is(pruebas.borrador(pruebas.p(3), pruebas.b('curso'), pruebas.b('listo')) ->> 'title', 'Lista', 'suspendida, sigue bajando lo suyo: lo lee en solo lectura');
select pruebas.como_usuario(pruebas.p(3));
select throws_ok('select private.resource_draft_object(null, null)', '42501', null, 'la persona no la llama');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- El freno de descargas: una fila por cuenta y hora, y falla cerrado.

select is(pruebas.golpe(pruebas.p(2)), 'ok', 'la primera descarga pasa');
select is((select hits from private.rate_limit_counters where bucket = 'resource_download:' || pruebas.p(2)), 1, 'y cuenta');
update private.rate_limit_counters set hits = 59 where bucket = 'resource_download:' || pruebas.p(2);
select is(pruebas.golpe(pruebas.p(2)), 'ok', 'la 60 pasa');
select is(pruebas.golpe(pruebas.p(2)), 'throttled', 'la 61, no');
select is((select hits from private.rate_limit_counters where bucket = 'resource_download:' || pruebas.p(2)), 60, 'y no cuenta');
select is(pruebas.golpe(pruebas.p(4)), 'ok', 'a otra cuenta no le toca');
select is(pruebas.golpe(null), 'unavailable', 'sin nadie que actúe, no se sabe');
select is((select count(*)::int from private.rate_limit_counters where bucket = 'resource_download:'), 0, 'y no cuenta nada');
alter table public.business_parameters disable trigger user;
update public.business_parameters set canceled_at = now() where key = 'TOPE_DESCARGAS_HORA' and canceled_at is null;
select is(pruebas.golpe(pruebas.p(3)), 'unavailable', 'sin el parámetro, tampoco: nunca pasa sin tope');
update public.business_parameters set canceled_at = null where key = 'TOPE_DESCARGAS_HORA' and canceled_at = now();
-- Con un tope sin sentido, tampoco: la primera descarga de cada hora se colaría, porque insertar no compara.
update public.business_parameters set value = '0' where key = 'TOPE_DESCARGAS_HORA' and canceled_at is null;
select is(pruebas.golpe(pruebas.p(3)), 'unavailable', 'con el tope en 0, no pasa');
select is((select count(*)::int from private.rate_limit_counters where bucket = 'resource_download:' || pruebas.p(3)), 0, 'y no cuenta');
update public.business_parameters set value = '60' where key = 'TOPE_DESCARGAS_HORA' and canceled_at is null;
alter table public.business_parameters enable trigger user;

-- ---------------------------------------------------------------------------------------
-- Lo que sobra mira también lo publicado: la ruta se comparte entre versiones.

select pruebas.como_dueno_sistema();
update public.teachers set status = 'active', suspended_at = null, suspension_reason = null, suspension_notice = null where id = pruebas.m(1);
select pruebas.limpiar();
select pruebas.objeto(pruebas.m(1) || '/' || pruebas.curso(1) || '/sin-fila');
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
select is(pruebas.sobran(pruebas.p(1), pruebas.curso(1)), array[pruebas.m(1) || '/' || pruebas.curso(1) || '/sin-fila'], 'sobra lo que nadie nombra, no lo publicado');
select ok(not exists (select 1 from private.resource_sweep() s where s.path = pruebas.m(1) || '/' || pruebas.curso(1) || '/' || pruebas.recurso(1)), 'y el repaso tampoco se lleva lo publicado');

-- ---------------------------------------------------------------------------------------
-- Las reglas del vigilante se provocan.

select is(pruebas.vigila(), '{}', 'el área está limpia');
grant select (storage_path) on public.published_resources to anon;
select ok('published resource path readable by anon' = any(pruebas.vigila()), 'la ruta de lo publicado a la vista se nota');
revoke select (storage_path) on public.published_resources from anon;
grant insert on public.published_resources to app_service;
select ok('published resource table writable by app_service' = any(pruebas.vigila()), 'que el servidor escriba se nota');
revoke insert on public.published_resources from app_service;
alter table public.published_resources disable trigger publication_guard;
select ok('published resource table without guard' = any(pruebas.vigila()), 'el guardián apagado se nota');
alter table public.published_resources enable trigger publication_guard;
alter table public.published_resources disable row level security;
select ok('published resource table without row level security' = any(pruebas.vigila()), 'la seguridad por fila apagada se nota');
alter table public.published_resources enable row level security;
grant execute on function private.resource_object(uuid) to authenticated;
select ok('resource function executable by authenticated' = any(pruebas.vigila()), 'la barrera en manos de la persona se nota');
revoke execute on function private.resource_object(uuid) from authenticated;
create policy abierta on public.published_resources for select to anon using (true);
select ok('published resource policy not allowed' = any(pruebas.vigila()), 'una política de más se nota');
drop policy abierta on public.published_resources;
alter policy published_resources_public_select on public.published_resources using (true);
select ok('published resource policy not allowed' = any(pruebas.vigila()), 'una política abierta se nota');
alter policy published_resources_public_select on public.published_resources using (
  is_current
  and (lesson_id is null or exists (select 1 from public.published_lessons l where l.id = published_resources.lesson_id and l.is_current))
  and exists (select 1 from public.published_courses c where c.course_id = published_resources.course_id and c.is_listed));
drop policy published_resources_teacher_select on public.published_resources;
select ok('published resource table without policy' = any(pruebas.vigila()), 'que falte una se nota');
create policy published_resources_teacher_select on public.published_resources
  for select to authenticated using (teacher_id = (select private.current_teacher_id()));
alter table public.published_resources drop constraint published_resources_path_ok;
select ok('resource table without constraint published_resources_path_ok' = any(pruebas.vigila()), 'la regla de la ruta se nota');
alter table public.published_resources add constraint published_resources_path_ok check (starts_with(storage_path, teacher_id::text || '/' || course_id::text || '/'));
select is(pruebas.vigila(), '{}', 'y al deshacerlo queda limpia');

select * from finish();
rollback;
