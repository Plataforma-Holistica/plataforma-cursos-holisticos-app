-- T-402, primera solicitud · El borrador de un curso (RF-603, FL-32, PA-42, PA-43). Esquema §5.2.
-- Lo escribe el maestro activo, por el servidor y con las funciones `private.draft_*`; lo lee su
-- maestro, también suspendido; nadie más lo ve, tampoco Contenido (RF-612). Decisiones de Sergio del
-- 2026-10-29: un borrador no impide desactivar una práctica o un nivel; el maestro borra un borrador
-- que nunca envió; largos de 60, 500, 120 y 2 000. Las reglas del área `drafts` del vigilante, del
-- carril B, se provocan aquí.
begin;
\ir _ayuda.psql
select plan(147);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a3700000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.m(p_n integer) returns uuid language sql immutable
as $$ select ('a3700000-0000-0000-0001-' || lpad(p_n::text, 12, '0'))::uuid $$;
-- Un maestro con cuenta, escrito como el dueño declarado sistema.
create function pruebas.maestro(p_n integer, p_status public.teacher_status) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  insert into public.teachers (id, profile_id, status, suspended_at, suspension_reason)
  values (pruebas.m(p_n), pruebas.p(p_n), p_status,
          case when p_status = 'suspended' then now() end, case when p_status = 'suspended' then 'prueba' end);
  perform pruebas.limpiar();
end
$$;
-- Los ids que van naciendo, por nombre.
create table pruebas.ids (k text primary key, v uuid not null);
create function pruebas.id(p_k text) returns uuid language sql stable
as $$ select v from pruebas.ids where k = p_k $$;
-- Una función del borrador por el servidor, a nombre de una persona. Si contesta un id (`course`,
-- `module` o `lesson`) y se le da un nombre, lo anota. Devuelve la respuesta.
create function pruebas.b(p_id uuid, p_call text, p_k text default null) returns text
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_id);
  execute 'select ' || p_call into v;
  perform pruebas.limpiar();
  if p_k is not null then
    insert into pruebas.ids values (p_k, coalesce(v ->> 'course', v ->> 'module', v ->> 'lesson')::uuid);
  end if;
  return v ->> 'answer';
end
$$;
-- Las lecciones de un módulo, en orden, por título.
create function pruebas.lecciones(p_module uuid) returns text[] language sql stable
as $$ select coalesce(array_agg(title order by position), '{}') from public.draft_lessons where module_id = p_module $$;
create function pruebas.posiciones(p_module uuid) returns integer[] language sql stable
as $$ select coalesce(array_agg(position order by position), '{}') from public.draft_lessons where module_id = p_module $$;
create function pruebas.modulos(p_course uuid) returns text[] language sql stable
as $$ select coalesce(array_agg(title order by position), '{}') from public.draft_modules where course_id = p_course $$;
create function pruebas.rev(p_table text, p_id uuid) returns bigint language plpgsql stable
as $$
declare v bigint;
begin
  execute format('select revision from public.%I where %I = $1', p_table,
                 case when p_table = 'course_drafts' then 'course_id' else 'id' end) into v using p_id;
  return v;
end
$$;
create function pruebas.estructura(p_course uuid) returns bigint language sql stable
as $$ select structure_revision from public.course_drafts where course_id = p_course $$;
create function pruebas.contenido(p_course uuid) returns bigint language sql stable
as $$ select content_revision from public.course_drafts where course_id = p_course $$;
create function pruebas.vigila() returns text[]
language sql as $$
  select coalesce(array_agg(v.problem order by v.problem), '{}') from private.schema_violations_drafts() v
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;
grant select on pruebas.ids to anon, authenticated, app_service;

-- Ana (1) y Beto (2), maestros activos; Caro (3), activa para crear su curso y después suspendida;
-- Dani (4), alumna sin maestro; Eva (5), de Contenido; Fer (6), maestra activa con la cuenta suspendida.
select pruebas.alta(pruebas.p(n), 'borrador-' || n || '@prueba.test') from generate_series(1, 6) n;
select pruebas.confirmar(pruebas.p(n)) from generate_series(1, 6) n;
select pruebas.maestro(1, 'active'), pruebas.maestro(2, 'active'), pruebas.maestro(3, 'active'), pruebas.maestro(6, 'active');
select pruebas.suspender(pruebas.p(6));
select pruebas.dar_capacidad(pruebas.p(5), 'content');
select pruebas.equipar(pruebas.p(5));
select pruebas.como_dueno_sistema();
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('practices', 'Océano'),
       private.system_catalog_add('levels', 'Principiante'), private.system_catalog_add('levels', 'Avanzado');
select pruebas.limpiar();
create function pruebas.lista(p_slug text) returns uuid language sql stable
as $$ select id from public.practices where slug = p_slug union all select id from public.levels where slug = p_slug $$;

-- ---------------------------------------------------------------------------------------
-- El vigilante, antes de todo.

select is_empty('select * from private.schema_violations()', 'el vigilante no dice nada');
select ok((select array_agg(function_name) from private.watchdog_areas()) @> array['schema_violations_drafts'],
  'el área del borrador está entre las áreas');

-- ---------------------------------------------------------------------------------------
-- Crear un curso.

select is(pruebas.b(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), 'Respirar en calma'), 'ana'), 'created',
  'la maestra activa crea un curso');
select is((select row(teacher_id, state)::text from public.course_registry where course_id = pruebas.id('ana')),
  row(pruebas.m(1), 'draft'::public.course_state)::text, 'el registro nace en borrador y es de ella');
select is((select row(teacher_id, version, title, summary, practice_id, level_id, revision, structure_revision)::text
           from public.course_drafts where course_id = pruebas.id('ana')),
  row(pruebas.m(1), 1, 'Respirar en calma', null::text, null::uuid, null::uuid, 1::bigint, 1::bigint)::text,
  'y el borrador, con su título y nada más');
select is((select actor_id from public.audit_log where entity_table = 'public.course_registry'
           and entity_id = pruebas.id('ana')::text and action like '%insert'), pruebas.p(1),
  'el alta del registro queda en la auditoría a su nombre');
select is(pruebas.b(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), repeat('a', 60)), 'ana60'), 'created',
  'un título de 60 caracteres cabe');
select is(pruebas.b(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), repeat('a', 61))), 'invalid', 'uno de 61 no');
select is(pruebas.b(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), '')), 'invalid', 'ni uno vacío');
select is(pruebas.b(pruebas.p(1), format('private.draft_create(%L, null)', gen_random_uuid())), 'invalid', 'ni uno nulo');
select is(pruebas.b(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), ' Respirar')), 'invalid', 'ni con espacio al principio');
select is(pruebas.b(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), E'Respirar\nen calma')), 'invalid',
  'ni con un salto de línea');
select is(pruebas.b(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), E'Respi\u200brar')), 'invalid',
  'ni con un carácter que no se ve');
select is(pruebas.b(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), E'Uno\u2028dos')), 'invalid',
  'ni con un separador de línea (lo trae un texto pegado)');
select is(pruebas.b(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), E'Uno\u0085dos')), 'invalid',
  'ni con un control C1');
select is(pruebas.b(pruebas.p(1), format('private.draft_create(%L, %L)', 'a3700000-0000-0000-0002-000000000001', 'Con testigo'), 'tok'), 'created',
  'crea con el testigo de su formulario');
select is(pruebas.b(pruebas.p(1), format('private.draft_create(%L, %L)', 'a3700000-0000-0000-0002-000000000001', 'Con testigo')), 'created',
  'el mismo formulario reenviado contesta created');
select is((select count(*)::integer from public.course_drafts where create_token = 'a3700000-0000-0000-0002-000000000001'), 1, 'y no crea otro');
select pruebas.a_nombre_de(pruebas.p(1));
select is(private.draft_create('a3700000-0000-0000-0002-000000000001', 'Con testigo') ->> 'course', pruebas.id('tok')::text,
  'devuelve el mismo curso');
select pruebas.como_dueno();
select is(pruebas.b(pruebas.p(1), format('private.draft_create(null, %L)', 'Sin testigo')), 'invalid', 'sin testigo no crea');
select is(pruebas.b(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), E'Cafe\u0301')), 'invalid',
  'ni sin normalizar (NFC)');
select is(pruebas.b(pruebas.p(3), format('private.draft_create(%L, %L)', gen_random_uuid(), 'El curso de Caro'), 'caro'), 'created',
  'Caro, activa todavía, crea el suyo');
select is(pruebas.b(pruebas.p(2), format('private.draft_create(%L, %L)', gen_random_uuid(), 'El curso de Beto'), 'beto'), 'created',
  'y Beto el suyo');

-- Caro queda suspendida como maestra.
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba' where id = pruebas.m(3);
select pruebas.limpiar();

select is(pruebas.b(pruebas.p(3), format('private.draft_create(%L, %L)', gen_random_uuid(), 'Otro')), 'suspended',
  'suspendida, ya no crea: lo dice');
select is(pruebas.b(pruebas.p(6), format('private.draft_create(%L, %L)', gen_random_uuid(), 'Otro')), 'suspended',
  'una maestra activa con la cuenta suspendida tampoco crea');
select is(pruebas.b(pruebas.p(4), format('private.draft_create(%L, %L)', gen_random_uuid(), 'Otro')), 'not_teacher',
  'una alumna sin maestro no crea');
select pruebas.como_sistema();
select is(private.draft_create(gen_random_uuid(), 'Otro') ->> 'answer', 'not_teacher', 'ni un trabajo del sistema');
select pruebas.como_usuario(pruebas.p(1));
select throws_ok($$select private.draft_create(gen_random_uuid(), 'Otro')$$, '42501', null, 'la persona no la ejecuta: solo el servidor');
select pruebas.como_visitante();
select throws_ok($$select private.draft_create(gen_random_uuid(), 'Otro')$$, '42501', null, 'ni el visitante');
select pruebas.como_dueno();
select is((select count(*)::integer from public.course_drafts), 5, 'nada más se creó');

-- ---------------------------------------------------------------------------------------
-- Los datos del curso.

select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 1, %L, %L, %L, %L)', pruebas.id('ana'),
  'Respirar', 'Un curso para respirar.', pruebas.lista('naturaleza'), pruebas.lista('principiante'))), 'saved',
  'guarda título, resumen, práctica y nivel');
select is((select row(title, summary, practice_id, level_id, revision)::text from public.course_drafts
           where course_id = pruebas.id('ana')),
  row('Respirar', 'Un curso para respirar.', pruebas.lista('naturaleza'), pruebas.lista('principiante'), 2::bigint)::text,
  'y sube la revisión');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 1, %L, null, null, null)', pruebas.id('ana'), 'Otro')),
  'changed', 'un formulario de antes (otra pestaña, un reenvío) contesta changed');
select is((select title from public.course_drafts where course_id = pruebas.id('ana')), 'Respirar', 'y no cambia nada');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 2, %L, %L, null, null)', pruebas.id('ana'),
  'Respirar', E'Primera línea.\nSegunda línea.')), 'saved', 'el resumen admite saltos de línea');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 3, %L, %L, null, null)', pruebas.id('ana'),
  'Respirar', E'Con retorno\r\n.')), 'invalid', 'pero no el retorno de carro');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 3, %L, %L, null, null)', pruebas.id('ana'),
  'Respirar', repeat('r', 501))), 'invalid', 'un resumen de 501 no cabe');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 3, %L, %L, null, null)', pruebas.id('ana'),
  'Respirar', repeat('r', 500))), 'saved', 'uno de 500 sí');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 4, %L, %L, null, null)', pruebas.id('ana'),
  'Respirar', '')), 'invalid', 'un resumen vacío no: es nulo');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 4, %L, null, %L, null)', pruebas.id('ana'),
  'Respirar', gen_random_uuid())), 'invalid', 'una práctica que no existe no');

-- Contenido desactiva «Océano» y «Avanzado» antes de que nadie las use.
select is(pruebas.pide(pruebas.p(5), format('private.catalog_set_active(%L, %L, false)', 'practices', pruebas.lista('oceano'))),
  'deactivated', 'Contenido desactiva una práctica');
select is(pruebas.pide(pruebas.p(5), format('private.catalog_set_active(%L, %L, false)', 'levels', pruebas.lista('avanzado'))),
  'deactivated', 'y un nivel');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 4, %L, null, %L, null)', pruebas.id('ana'),
  'Respirar', pruebas.lista('oceano'))), 'practice_inactive', 'elegir una práctica inactiva no');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 4, %L, null, null, %L)', pruebas.id('ana'),
  'Respirar', pruebas.lista('avanzado'))), 'level_inactive', 'ni un nivel inactivo');

-- Un borrador no impide desactivar (decisión de Sergio): Ana usa «Naturaleza» y Contenido la desactiva.
select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 4, %L, null, %L, %L)', pruebas.id('ana'),
  'Respirar', pruebas.lista('naturaleza'), pruebas.lista('principiante'))), 'saved', 'Ana elige práctica y nivel');
select is(private.catalog_in_use('practices', pruebas.lista('naturaleza')), 0, 'un borrador no cuenta como en uso');
select is(pruebas.pide(pruebas.p(5), format('private.catalog_set_active(%L, %L, false)', 'practices', pruebas.lista('naturaleza'))),
  'deactivated', 'y Contenido desactiva la práctica que solo usa un borrador');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 5, %L, null, %L, %L)', pruebas.id('ana'),
  'Respirar sin prisa', pruebas.lista('naturaleza'), pruebas.lista('principiante'))), 'saved',
  'el borrador guarda otros cambios con la práctica que ya tenía, aunque se haya desactivado');

-- De quién es, y en qué estado.
select is(pruebas.b(pruebas.p(2), format('private.draft_save_course(%L, 6, %L, null, null, null)', pruebas.id('ana'), 'Mío')),
  'not_found', 'Beto no toca el curso de Ana: para él no existe');
select is(pruebas.b(pruebas.p(3), format('private.draft_save_course(%L, 1, %L, null, null, null)', pruebas.id('caro'), 'Mío')),
  'suspended', 'Caro, suspendida, no guarda el suyo');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 1, %L, null, null, null)', gen_random_uuid(), 'Mío')),
  'not_found', 'un curso que no existe');
select pruebas.como_dueno_sistema();
update public.course_registry set state = 'in_review' where course_id = pruebas.id('ana60');
select pruebas.limpiar();
select is(pruebas.b(pruebas.p(1), format('private.draft_save_course(%L, 1, %L, null, null, null)', pruebas.id('ana60'), 'Mío')),
  'not_editable', 'un curso que no está en borrador no se edita');

-- ---------------------------------------------------------------------------------------
-- Módulos.

select is(pruebas.b(pruebas.p(1), format('private.draft_add_module(%L, 1, %L)', pruebas.id('ana'), 'Primero'), 'm1'), 'created',
  'agrega un módulo');
select is(pruebas.b(pruebas.p(1), format('private.draft_add_module(%L, 1, %L)', pruebas.id('ana'), 'Primero')), 'changed',
  'el mismo formulario reenviado no agrega otro');
select is(pruebas.b(pruebas.p(1), format('private.draft_add_module(%L, 2, %L)', pruebas.id('ana'), 'Segundo'), 'm2'), 'created',
  'agrega el segundo');
select is(pruebas.b(pruebas.p(1), format('private.draft_add_module(%L, 3, %L)', pruebas.id('ana'), repeat('m', 121))), 'invalid',
  'un título de módulo de 121 no cabe');
select is(pruebas.modulos(pruebas.id('ana')), array['Primero', 'Segundo'], 'los dos, en orden');
select is(pruebas.b(pruebas.p(2), format('private.draft_add_module(%L, 1, %L)', pruebas.id('beto'), 'De Beto'), 'mb'), 'created',
  'Beto agrega uno al suyo');
select is(pruebas.b(pruebas.p(1), format('private.draft_rename_module(%L, %L, 1, %L)', pruebas.id('ana'), pruebas.id('m1'), 'Inicio')),
  'saved', 'renombra un módulo');
select is(pruebas.b(pruebas.p(1), format('private.draft_rename_module(%L, %L, 1, %L)', pruebas.id('ana'), pruebas.id('m1'), 'Otra')),
  'changed', 'con un formulario de antes, changed');
select is(pruebas.b(pruebas.p(1), format('private.draft_rename_module(%L, %L, 1, %L)', pruebas.id('ana'), pruebas.id('mb'), 'Mío')),
  'not_found', 'un módulo de otro curso, con el id del curso propio: no existe');
select is(pruebas.b(pruebas.p(1), format('private.draft_rename_module(%L, %L, 1, %L)', pruebas.id('beto'), pruebas.id('mb'), 'Mío')),
  'not_found', 'ni con el id del curso de Beto');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_module(%L, %L, 2, 1)', pruebas.id('ana'), pruebas.id('m2'))), 'moved',
  'sube el segundo al primer lugar');
select is(pruebas.modulos(pruebas.id('ana')), array['Segundo', 'Inicio'], 'y quedan al revés');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_module(%L, %L, 2, 1)', pruebas.id('ana'), pruebas.id('m2'))), 'changed',
  'el mismo «Subir» reenviado no lo mueve otra vez');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_module(%L, %L, 1, 3)', pruebas.id('ana'), pruebas.id('m2'))), 'invalid',
  'no se mueve fuera de la lista');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_module(%L, %L, 1, 0)', pruebas.id('ana'), pruebas.id('m2'))), 'invalid',
  'ni antes del primero');

-- ---------------------------------------------------------------------------------------
-- Lecciones.

select is(pruebas.b(pruebas.p(1), format('private.draft_add_lesson(%L, %L, %s, %L)', pruebas.id('ana'), pruebas.id('m1'),
  2, 'Una'), 'l1'), 'created', 'agrega una lección con la revisión del módulo que vio (2: se renombró una vez)');
select is(pruebas.b(pruebas.p(1), format('private.draft_add_lesson(%L, %L, %s, %L)', pruebas.id('ana'), pruebas.id('m1'),
  2, 'Una')), 'changed', 'el mismo formulario reenviado no agrega otra');
select is(pruebas.b(pruebas.p(1), format('private.draft_add_lesson(%L, %L, %s, %L)', pruebas.id('ana'), pruebas.id('m1'),
  pruebas.rev('draft_modules', pruebas.id('m1')), 'Dos'), 'l2'), 'created', 'la segunda');
select is(pruebas.b(pruebas.p(1), format('private.draft_add_lesson(%L, %L, %s, %L)', pruebas.id('ana'), pruebas.id('m1'),
  pruebas.rev('draft_modules', pruebas.id('m1')), 'Tres'), 'l3'), 'created', 'la tercera');
select is(pruebas.lecciones(pruebas.id('m1')), array['Una', 'Dos', 'Tres'], 'en el orden en que llegaron');
select is(pruebas.b(pruebas.p(1), format('private.draft_add_lesson(%L, %L, %s, %L)', pruebas.id('ana'), pruebas.id('mb'),
  pruebas.rev('draft_modules', pruebas.id('mb')), 'Intrusa')), 'not_found', 'no agrega en un módulo de otro curso');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_lesson(%L, %L, 1, %L, %L)', pruebas.id('ana'), pruebas.id('l1'),
  'Una lección', E'Qué se hace.\nY cómo.')), 'saved', 'guarda título y descripción, con saltos de línea');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_lesson(%L, %L, 1, %L, null)', pruebas.id('ana'), pruebas.id('l1'),
  'Otra')), 'changed', 'con un formulario de antes, changed');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_lesson(%L, %L, 2, %L, %L)', pruebas.id('ana'), pruebas.id('l1'),
  'Una lección', repeat('d', 2001))), 'invalid', 'una descripción de 2 001 no cabe');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_lesson(%L, %L, 2, %L, %L)', pruebas.id('ana'), pruebas.id('l1'),
  repeat('t', 121), null)), 'invalid', 'ni un título de 121');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_lesson(%L, %L, 2, %L, %L)', pruebas.id('ana'), pruebas.id('l2'),
  'Dos', 'x')), 'changed', 'la revisión es la de cada lección: la de otra no sirve');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_lesson(%L, %L, 1, %L, %L)', pruebas.id('ana'), pruebas.id('l2'),
  'Dos', 'x')), 'saved', 'y mover o editar otra lección no invalida el formulario de esta');
select is(pruebas.rev('draft_modules', pruebas.id('m1')), 7::bigint,
  'guardar una lección sube la revisión de su módulo: borrar el módulo no se lleva lo que no se vio');
-- Mover dentro del módulo y entre módulos.
select is(pruebas.b(pruebas.p(1), format('private.draft_move_lesson(%L, %L, %L, 3, %L, 1)', pruebas.id('ana'), pruebas.id('l3'),
  pruebas.id('m1'), pruebas.id('m1'))), 'moved', 'sube la tercera al primer lugar');
select is(pruebas.lecciones(pruebas.id('m1')), array['Tres', 'Una lección', 'Dos'], 'y el orden cambia');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_lesson(%L, %L, %L, 1, %L, 3)', pruebas.id('ana'), pruebas.id('l3'),
  pruebas.id('m1'), pruebas.id('m1'))), 'moved', 'la baja al último lugar');
select is(pruebas.lecciones(pruebas.id('m1')), array['Una lección', 'Dos', 'Tres'], 'y las de en medio suben');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_lesson(%L, %L, %L, 3, %L, 1)', pruebas.id('ana'), pruebas.id('l3'),
  pruebas.id('m1'), pruebas.id('m1'))), 'moved', 'y la vuelve a subir');
select is(pruebas.rev('draft_modules', pruebas.id('m1')), 10::bigint,
  'mover dentro del módulo también sube su revisión (de 7 a 10, con tres movimientos)');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_lesson(%L, %L, %L, 3, %L, 1)', pruebas.id('ana'), pruebas.id('l3'),
  pruebas.id('m1'), pruebas.id('m1'))), 'changed', 'el mismo movimiento reenviado no la mueve otra vez');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_lesson(%L, %L, %L, 2, %L, 1)', pruebas.id('ana'), pruebas.id('l1'),
  pruebas.id('m1'), pruebas.id('m2'))), 'moved', 'mueve una lección a otro módulo');
select is(pruebas.lecciones(pruebas.id('m1')) || pruebas.lecciones(pruebas.id('m2')), array['Tres', 'Dos', 'Una lección'],
  'se va del primero y llega al segundo');
select is(pruebas.posiciones(pruebas.id('m1')) || pruebas.posiciones(pruebas.id('m2')), array[1, 2, 1],
  'los dos módulos quedan con posiciones seguidas');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_lesson(%L, %L, %L, 1, %L, 3)', pruebas.id('ana'), pruebas.id('l1'),
  pruebas.id('m2'), pruebas.id('m1'))), 'moved', 'y la regresa al final del primero');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_lesson(%L, %L, %L, 3, %L, 5)', pruebas.id('ana'), pruebas.id('l1'),
  pruebas.id('m1'), pruebas.id('m2'))), 'invalid', 'no se mueve más allá del final del otro módulo');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_lesson(%L, %L, %L, 3, %L, 1)', pruebas.id('ana'), pruebas.id('l1'),
  pruebas.id('m1'), pruebas.id('mb'))), 'not_found', 'ni a un módulo de otro curso');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_lesson(%L, %L, %L, 3, %L, 1)', pruebas.id('ana'), pruebas.id('l1'),
  pruebas.id('m2'), pruebas.id('m2'))), 'changed', 'con el módulo que se vio equivocado, changed');
-- Borrar.
select is(pruebas.b(pruebas.p(1), format('private.draft_delete_lesson(%L, %L, 1)', pruebas.id('ana'), pruebas.id('l3'))), 'deleted',
  'borra una lección');
select is(pruebas.posiciones(pruebas.id('m1')), array[1, 2], 'las demás se recorren');
select is(pruebas.b(pruebas.p(1), format('private.draft_delete_lesson(%L, %L, 1)', pruebas.id('ana'), pruebas.id('l3'))), 'not_found',
  'la que ya se borró no existe');
select is(pruebas.b(pruebas.p(1), format('private.draft_delete_lesson(%L, %L, 1)', pruebas.id('ana'), pruebas.id('l2'))), 'changed',
  'una que cambió desde que se vio no se borra');
select is(pruebas.b(pruebas.p(1), format('private.draft_add_module(%L, %s, %L)', pruebas.id('ana'), pruebas.estructura(pruebas.id('ana')),
  'Tercero'), 'm3'), 'created', 'agrega un tercer módulo, al final');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_module(%L, %L, 1, 3)', pruebas.id('ana'), pruebas.id('m2'))), 'moved',
  'baja el primero al último lugar');
select is(pruebas.modulos(pruebas.id('ana')), array['Inicio', 'Tercero', 'Segundo'], 'y los de en medio suben');
select is(pruebas.b(pruebas.p(1), format('private.draft_delete_module(%L, %L, %s)', pruebas.id('ana'), pruebas.id('m1'),
  pruebas.rev('draft_modules', pruebas.id('m1')) - 1)), 'changed', 'un módulo que cambió desde que se vio no se borra');
select is(pruebas.b(pruebas.p(1), format('private.draft_delete_module(%L, %L, %s)', pruebas.id('ana'), pruebas.id('m1'),
  pruebas.rev('draft_modules', pruebas.id('m1')))), 'deleted', 'borra un módulo con sus lecciones');
select is((select count(*)::integer from public.draft_lessons where course_id = pruebas.id('ana')), 0,
  'sus lecciones se fueron con él');
select is(pruebas.modulos(pruebas.id('ana')) || (select array_agg(position::text order by position) from public.draft_modules
           where course_id = pruebas.id('ana')), array['Tercero', 'Segundo', '1', '2'],
  'y los que quedan se recorren');
select ok((select updated_at from public.course_drafts where course_id = pruebas.id('ana')) is not null,
  'el borrador sabe cuándo se guardó');

-- ---------------------------------------------------------------------------------------
-- Leer.

select pruebas.b(pruebas.p(2), format('private.draft_add_lesson(%L, %L, %s, %L)', pruebas.id('beto'), pruebas.id('mb'),
  pruebas.rev('draft_modules', pruebas.id('mb')), 'De Beto'), 'lb');
select is(pruebas.b(pruebas.p(1), format('private.draft_save_lesson(%L, %L, 1, %L, null)', pruebas.id('ana'), pruebas.id('lb'), 'Mía')),
  'not_found', 'Ana no edita una lección de Beto con el id de su curso');
select is(pruebas.b(pruebas.p(1), format('private.draft_delete_lesson(%L, %L, 1)', pruebas.id('ana'), pruebas.id('lb'))),
  'not_found', 'ni la borra');
select is(pruebas.b(pruebas.p(1), format('private.draft_move_lesson(%L, %L, %L, 1, %L, 1)', pruebas.id('ana'), pruebas.id('lb'),
  pruebas.id('mb'), pruebas.id('m2'))), 'not_found', 'ni se la lleva a un módulo suyo');
select pruebas.como_usuario(pruebas.p(1));
select is((select array_agg(title order by title collate "C") from public.course_drafts), array['Con testigo', 'Respirar sin prisa', repeat('a', 60)],
  'Ana lee sus borradores y ninguno más');
select is((select count(*)::integer from public.draft_modules), 2, 'y sus módulos');
select is((select count(*)::integer from public.draft_lessons), 0, 'y no las lecciones de Beto');
select pruebas.como_usuario(pruebas.p(3));
select is((select array_agg(title) from public.course_drafts), array['El curso de Caro'], 'Caro, suspendida, lee el suyo');
select pruebas.como_usuario(pruebas.p(5), 'aal2');
select is((select count(*)::integer from public.course_drafts) + (select count(*)::integer from public.draft_modules)
          + (select count(*)::integer from public.draft_lessons), 0, 'Contenido no ve ningún borrador (RF-612)');
select pruebas.como_usuario(pruebas.p(4));
select is((select count(*)::integer from public.course_drafts), 0, 'ni una alumna');
select pruebas.como_visitante();
select throws_ok($$select count(*) from public.course_drafts$$, '42501', null, 'el visitante ni siquiera la lee');
select pruebas.como_usuario(pruebas.p(1));
select throws_ok(format('insert into public.draft_modules (course_id, teacher_id, title, position) values (%L, %L, %L, 9)',
  pruebas.id('ana'), pruebas.m(1), 'Directo'), '42501', null, 'la persona no escribe directo');
select pruebas.a_nombre_de(pruebas.p(1));
select throws_ok(format('update public.course_drafts set title = %L where course_id = %L', 'Directo', pruebas.id('ana')),
  '42501', null, 'ni el servidor');
-- El guardián, aunque alguien le conceda el permiso al servidor (que salta la seguridad por fila). Para
-- que el guardián sea lo único que lo para, también la regla de los textos de las restricciones.
select pruebas.como_dueno();
grant insert on public.draft_lessons to app_service;
grant delete on public.draft_modules to app_service;
grant execute on function private.draft_text_ok(text, integer, boolean) to app_service;
select pruebas.a_nombre_de(pruebas.p(1));
select throws_ok(format('insert into public.draft_lessons (course_id, teacher_id, module_id, title, position) values (%L, %L, %L, %L, 9)',
  pruebas.id('ana'), pruebas.m(1), pruebas.id('m2'), 'Directo'), '42501', null, 'con permiso concedido, el guardián no deja escribir');
select throws_ok(format('delete from public.draft_modules where course_id = %L', pruebas.id('ana')), '42501', null,
  'ni borrar');
select pruebas.como_dueno();
revoke insert on public.draft_lessons from app_service;
revoke delete on public.draft_modules from app_service;
revoke execute on function private.draft_text_ok(text, integer, boolean) from app_service;
-- Con la tabla que la nombra desde T-404: sola, la clave foránea la detendría antes que el guardián.
select throws_ok('truncate public.draft_lessons, public.draft_resources', '42501', 'public.draft_lessons: drafts are not truncated', 'ni el dueño vacía la tabla');

-- ---------------------------------------------------------------------------------------
-- Borrar un borrador que nunca se envió.

select is(pruebas.b(pruebas.p(2), format('private.draft_delete_course(%L, %s)', pruebas.id('ana'),
  pruebas.contenido(pruebas.id('ana')))), 'not_found', 'Beto no borra el de Ana');
select is(pruebas.b(pruebas.p(3), format('private.draft_delete_course(%L, 1)', pruebas.id('caro'))), 'suspended',
  'Caro, suspendida, no borra el suyo');
select is(pruebas.b(pruebas.p(1), format('private.draft_delete_course(%L, 1)', pruebas.id('ana60'))), 'not_editable',
  'uno que ya no está en borrador no se borra');
select is(pruebas.b(pruebas.p(1), format('private.draft_delete_course(%L, 1)', pruebas.id('ana'))), 'changed',
  'con un formulario de antes, changed');
select is(pruebas.b(pruebas.p(1), format('private.draft_delete_course(%L, %s)', pruebas.id('ana'),
  pruebas.rev('course_drafts', pruebas.id('ana')))), 'changed',
  'con la revisión de los datos no basta: la de todo el contenido es la que cuenta');
select is(pruebas.b(pruebas.p(1), format('private.draft_delete_course(%L, %s)', pruebas.id('ana'),
  pruebas.contenido(pruebas.id('ana')))), 'deleted', 'Ana borra su borrador');
select is((select count(*)::integer from public.course_registry where course_id = pruebas.id('ana'))
          + (select count(*)::integer from public.course_drafts where course_id = pruebas.id('ana'))
          + (select count(*)::integer from public.draft_modules where course_id = pruebas.id('ana')), 0,
  'se va el registro con todo su borrador');
select is((select actor_id from public.audit_log where entity_table = 'public.course_registry'
           and entity_id = pruebas.id('ana')::text and action like '%delete'), pruebas.p(1),
  'y el borrado queda en la auditoría a su nombre');

-- ---------------------------------------------------------------------------------------
-- El vigilante del área.

select is(pruebas.vigila(), '{}', 'el área del borrador está en orden');
grant insert on public.course_drafts to authenticated;
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft table writable by authenticated'),
  've un permiso de escritura para la persona');
revoke insert on public.course_drafts from authenticated;
grant select on public.draft_lessons to anon;
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft table readable by anon'),
  've que el visitante la lee');
revoke select on public.draft_lessons from anon;
grant execute on function private.draft_create(uuid, text) to authenticated;
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft function executable by authenticated'),
  've que la persona ejecuta una función del borrador');
revoke execute on function private.draft_create(uuid, text) from authenticated;
alter function private.draft_delete_course(uuid, bigint) security invoker;
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft function not security definer'),
  've una función que dejó de ser security definer');
alter function private.draft_delete_course(uuid, bigint) security definer;
alter table public.draft_modules disable trigger draft_modules_guard;
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft table without guard'),
  've un guardián apagado');
alter table public.draft_modules enable trigger draft_modules_guard;
alter table public.draft_lessons disable row level security;
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft table without row level security'),
  've la seguridad por fila apagada');
alter table public.draft_lessons enable row level security;
create policy draft_lessons_content on public.draft_lessons for select to authenticated using (true);
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft policy other than teacher read'),
  've una política de más');
drop policy draft_lessons_content on public.draft_lessons;
create function private.draft_extra() returns integer language sql as 'select 1';
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft function not in the watchdog area'),
  've una función del borrador que el área no conoce');
drop function private.draft_extra();
create function private.draftextra() returns integer language sql as 'select 1';
create function public.draft_publica() returns integer language sql as 'select 1';
select is((select array_agg(object_name order by object_name) from private.schema_violations_drafts()
           where problem = 'draft function not in the watchdog area'), array['public.draft_publica()'],
  'también una en public, y solo las que empiezan con «draft_»');
drop function private.draftextra();
drop function public.draft_publica();
alter table public.draft_lessons drop constraint draft_lessons_title_ok;
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft table without constraint draft_lessons_title_ok'),
  've que falta una restricción de los textos');
alter table public.draft_lessons add constraint draft_lessons_title_ok check (true);
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft table without constraint draft_lessons_title_ok'),
  'y que no basta una con el mismo nombre que no revisa nada');
alter table public.draft_lessons drop constraint draft_lessons_title_ok;
alter table public.draft_lessons add constraint draft_lessons_title_ok check (private.draft_text_ok(title, 120, false));
create trigger ajeno before insert on public.draft_modules for each row execute function private.guard_draft();
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft table with a foreign trigger'),
  've un disparador ajeno');
drop trigger ajeno on public.draft_modules;
alter function private.draft_open(uuid, uuid) reset search_path;
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft function without fixed search_path'),
  've una función sin el search_path fijo');
alter function private.draft_open(uuid, uuid) set search_path = '';
revoke execute on function private.draft_delete_lesson(uuid, uuid, bigint) from app_service;
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft function not executable by app_service'),
  've que el servidor ya no ejecuta una');
grant execute on function private.draft_delete_lesson(uuid, uuid, bigint) to app_service;
alter function private.guard_draft() security definer;
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft function security definer'),
  've el guardián como security definer');
alter function private.guard_draft() security invoker;
select is(pruebas.vigila(), '{}', 'deshecho todo, otra vez en orden');
drop function private.draft_refusal();
select ok(exists (select 1 from unnest(pruebas.vigila()) p where p like 'draft function missing'), 've una función que falta');

select * from finish();
rollback;
