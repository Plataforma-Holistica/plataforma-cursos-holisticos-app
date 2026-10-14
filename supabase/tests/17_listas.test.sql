-- T-106 · Prácticas y niveles (RF-709, PA-67, FL-58). Esquema §5.2, §6 y §7.4.
-- Primera solicitud de T-106 (decisiones de Sergio del 2026-10-13: pantallas propias, sin
-- Payload; tablas public.practices y public.levels, vacías al arrancar, con slug fijo y con
-- el código reciente para cambiarlas).
--
-- Las dos listas las cambia solo alguien del equipo con la capacidad Contenido y un código
-- del segundo factor reciente, y solo por funciones de private, con auditoría. El servidor
-- solo las lee; el público lee las activas. Quitar es desactivar.
begin;
\ir _ayuda.psql
select plan(127);

select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido1@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000002', 'contenido2@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000001', 'config1@prueba.test');
select pruebas.alta('d0000000-0000-0000-0000-000000000001', 'soporte@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000002', 'content');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'config');
select pruebas.dar_capacidad('d0000000-0000-0000-0000-000000000001', 'support');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');
select pruebas.equipar('b0000000-0000-0000-0000-000000000002');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select pruebas.equipar('d0000000-0000-0000-0000-000000000001');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001');

-- Lo que contesta una función de las listas, como jsonb o como texto.
create function pruebas.agrega(p_id uuid, p_list text, p_name text) returns jsonb
language sql as $$ select pruebas.pide(p_id, format('private.catalog_add(%L, %L)', p_list, p_name))::jsonb $$;
create function pruebas.renombra(p_id uuid, p_list text, p_item uuid, p_name text) returns text
language sql as $$ select pruebas.pide(p_id, format('private.catalog_rename(%L, %L, %L)', p_list, p_item, p_name)) $$;
create function pruebas.mueve(p_id uuid, p_list text, p_item uuid, p_direction text) returns text
language sql as $$ select pruebas.pide(p_id, format('private.catalog_move(%L, %L, %L)', p_list, p_item, p_direction)) $$;
create function pruebas.activa(p_id uuid, p_list text, p_item uuid, p_active boolean) returns text
language sql as $$ select pruebas.pide(p_id, format('private.catalog_set_active(%L, %L, %L)', p_list, p_item, p_active)) $$;
create function pruebas.listas(p_id uuid) returns jsonb
language sql as $$ select pruebas.pide(p_id, 'private.catalog_lists()')::jsonb $$;
-- Una práctica por su nombre, como la lee el dueño.
create function pruebas.practica(p_name text) returns public.practices
language sql security definer as $$ select p from public.practices p where p.name = p_name $$;
create function pruebas.renglones_de(p_table text) returns bigint
language sql security definer as $$ select count(*) from public.audit_log where entity_table = p_table $$;
-- Cuántos renglones de prácticas había en la auditoría, para contar los que deja un cambio.
create table pruebas.antes (n bigint);
create function pruebas.anotar_auditoria() returns void
language sql as $$ delete from pruebas.antes; insert into pruebas.antes select pruebas.renglones_de('public.practices'); $$;
create function pruebas.renglones_antes() returns bigint
language sql as $$ select n from pruebas.antes $$;
-- El dueño de la tabla, a nombre de alguien: es como escriben las funciones de las listas.
create function pruebas.dueno_a_nombre_de(p_id uuid) returns void
language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', p_id::text, true), set_config('app.actor_session', pruebas.sesion(p_id)::text, true);
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- La estructura y los permisos.

select has_table('public', 'practices', 'existe la tabla de prácticas');
select has_table('public', 'levels', 'existe la tabla de niveles');
select hasnt_table('public', 'published_practices', 'ya no hay una copia publicada de las prácticas: son la fuente');
select has_type('public', 'catalog_list', 'existe el tipo que elige la lista');
select enum_has_labels('public', 'catalog_list', array['practices', 'levels'], 'con las dos listas');
select columns_are('public', 'practices',
  array['id', 'slug', 'name', 'position', 'is_active', 'cover_tone', 'created_at', 'updated_at'], 'las columnas de una práctica');
select columns_are('public', 'levels',
  array['id', 'slug', 'name', 'position', 'is_active', 'created_at', 'updated_at'], 'las columnas de un nivel: sin tono');
select ok((select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.practices'::regclass, 'public.levels'::regclass)),
  'las dos con seguridad por fila');
select ok(
  bool_and(has_table_privilege('app_service', t, 'select')
           and not has_any_column_privilege('app_service', t, 'insert, update')
           and not has_table_privilege('app_service', t, 'delete, truncate')),
  'el servidor las lee y no las escribe')
from unnest(array['public.practices', 'public.levels']) as t;
select ok(
  bool_and(has_table_privilege('anon', t, 'select') and has_table_privilege('authenticated', t, 'select')
           and not has_any_column_privilege('anon', t, 'insert, update')
           and not has_any_column_privilege('authenticated', t, 'insert, update')),
  'el público las lee y no las escribe')
from unnest(array['public.practices', 'public.levels']) as t;
select ok(
  bool_and(has_function_privilege('app_service', f, 'execute')
           and not has_function_privilege('authenticated', f, 'execute')
           and not has_function_privilege('anon', f, 'execute')
           and not has_function_privilege('service_role', f, 'execute')),
  'las cinco funciones de las listas las ejecuta solo el servidor')
from unnest(array[
  'private.catalog_add(public.catalog_list, text)',
  'private.catalog_rename(public.catalog_list, uuid, text)',
  'private.catalog_move(public.catalog_list, uuid, text)',
  'private.catalog_set_active(public.catalog_list, uuid, boolean)',
  'private.catalog_lists()']) as f;
select ok(
  bool_and(not has_function_privilege('app_service', f, 'execute')
           and not has_function_privilege('authenticated', f, 'execute')
           and not has_function_privilege('anon', f, 'execute')),
  'la puerta de Contenido y la clave de un nombre son internas')
from unnest(array['private.content_change_gate()', 'private.catalog_key(text)']) as f;
select is_empty('select * from private.schema_violations()', 'private.schema_violations() sigue en cero');

-- ---------------------------------------------------------------------------------------
-- La puerta: Contenido, y un código reciente.

select is(pruebas.agrega('a0000000-0000-0000-0000-000000000001', 'practices', 'Yoga') ->> 'answer', 'forbidden', 'una cuenta común: forbidden');
select is(pruebas.agrega('d0000000-0000-0000-0000-000000000001', 'practices', 'Yoga') ->> 'answer', 'forbidden',
  'alguien del equipo sin Contenido: forbidden');
select is(pruebas.agrega('c0000000-0000-0000-0000-000000000001', 'practices', 'Yoga') ->> 'answer', 'forbidden',
  'ni con configuración: la capacidad es Contenido');
select pruebas.sin_codigo('b0000000-0000-0000-0000-000000000002');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000002', 'practices', 'Yoga') ->> 'answer', 'needs_fresh_code',
  'con Contenido y la sesión en primer nivel: que dé su código');
select pruebas.equipar('b0000000-0000-0000-0000-000000000002');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '1 hour'
  where session_id = pruebas.sesion('b0000000-0000-0000-0000-000000000002');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000002', 'practices', 'Yoga') ->> 'answer', 'needs_fresh_code',
  'con Contenido y un código de hace una hora: que lo dé otra vez');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', null, 'Yoga') ->> 'answer', 'invalid', 'sin lista: invalid');
select throws_ok($$select private.catalog_add('cursos', 'Yoga')$$, '22P02', null, 'una lista que no existe ni siquiera llega');
select is(pruebas.mueve('b0000000-0000-0000-0000-000000000001', 'levels', gen_random_uuid(), 'up'), 'not_found', 'mover en una lista vacía: not_found');
select is((select count(*)::int from public.practices) + (select count(*)::int from public.levels), 0,
  'nada de eso escribió: las listas arrancan vacías');

-- ---------------------------------------------------------------------------------------
-- Agregar.

select pruebas.anotar_auditoria();
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', 'Yoga') ->> 'answer', 'added', 'agrega una práctica');
select is((pruebas.practica('Yoga')).slug, 'yoga', 'con su slug, del nombre');
select is((pruebas.practica('Yoga')).position, 1, 'en la primera posición');
select is((pruebas.practica('Yoga')).cover_tone::int, 1, 'con el primer tono');
select ok((pruebas.practica('Yoga')).is_active, 'activa');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', 'Meditación guiada') ->> 'id',
  (pruebas.practica('Meditación guiada')).id::text, 'agregar devuelve el id de lo que agregó');
select is((pruebas.practica('Meditación guiada')).slug, 'meditacion-guiada', 'sin acentos, con guiones');
select is((pruebas.practica('Meditación guiada')).position, 2, 'después de la anterior');
select is((pruebas.practica('Meditación guiada')).cover_tone::int, 2, 'con el tono siguiente');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', '  Respiración  ') ->> 'answer', 'added',
  'los espacios a los lados se quitan');
select ok((pruebas.practica('Respiración')).id is not null, 'y el nombre queda sin ellos');
select is(pruebas.renglones_de('public.practices') - pruebas.renglones_antes(), 3::bigint, 'cada alta deja su renglón en la auditoría');
select is((select actor_id::text || ' ' || category::text from public.audit_log where entity_table = 'public.practices' order by id desc limit 1),
  'b0000000-0000-0000-0000-000000000001 content', 'con su autor y la categoría Contenido');

select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', 'yoga') ->> 'answer', 'duplicate', 'el mismo nombre en minúsculas: duplicate');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', 'Yógá') ->> 'answer', 'duplicate', 'con acentos: duplicate');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', 'Meditación   guiada') ->> 'answer', 'duplicate',
  'con espacios de más en medio: duplicate');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', U&'Respiracio\0301n') ->> 'answer', 'duplicate',
  'escrito descompuesto (NFD), es el mismo: duplicate');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', 'RESPIRACIÓN') ->> 'answer', 'duplicate', 'en mayúsculas y con acento: duplicate');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', U&'Meditación\00A0guiada') ->> 'answer', 'duplicate',
  'con un espacio duro en medio: duplicate');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', '') ->> 'answer', 'invalid', 'vacío: invalid');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', '    ') ->> 'answer', 'invalid', 'solo espacios: invalid');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', E'Tai\nchi') ->> 'answer', 'invalid', 'con un salto de línea: invalid');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', U&'Yo\00ADga') ->> 'answer', 'invalid', 'con un guion suave, que no se ve: invalid');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', U&'Yo\200Bga') ->> 'answer', 'invalid', 'con un carácter de ancho cero: invalid');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', U&'\202EagoY') ->> 'answer', 'invalid',
  'con uno que invierte la dirección del texto: invalid');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', U&'Yoga\2066') ->> 'answer', 'invalid',
  'con uno que aísla la dirección del texto: invalid');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', U&'Yo\+0E0041ga') ->> 'answer', 'invalid',
  'con una etiqueta, fuera del plano básico: invalid');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', U&'Meditación\2007guiada') ->> 'answer', 'duplicate',
  'con un espacio de cifra en medio, que no es un espacio para toda configuración regional: duplicate');
-- Con la configuración C, `\s` no ve los espacios duros: la clave los cuenta igual.
select is(private.catalog_key(U&'Tai\00A0chi\2007de\202Fpie' collate "C"), 'tai chi de pie',
  'los espacios duros cuentan como espacios en cualquier configuración regional');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', repeat('a', 41)) ->> 'answer', 'invalid', 'de 41 caracteres: invalid');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', '¡¡!!') ->> 'answer', 'invalid', 'solo signos, que dejan el slug vacío: invalid');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', null) ->> 'answer', 'invalid', 'sin nombre: invalid');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', repeat('b', 40)) ->> 'answer', 'added', 'de 40 caracteres, sí');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', 'Yoga!') ->> 'answer', 'added',
  'un nombre distinto que daría el mismo slug');
select is((pruebas.practica('Yoga!')).slug, 'yoga-2', 'recibe otro slug, con un número');
select is((select count(*)::int from public.practices), 5, 'los rechazos no escribieron nada');

-- Los niveles son otra lista: posiciones propias y sin tono.
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'levels', 'Principiante') ->> 'answer', 'added', 'agrega un nivel');
select is((select position from public.levels where name = 'Principiante'), 1, 'en la primera posición de su lista');
select is(pruebas.mueve('b0000000-0000-0000-0000-000000000001', 'levels', (select id from public.levels where name = 'Principiante'), 'down'), 'edge',
  'el único de su lista no baja: edge');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'levels', 'Yoga') ->> 'answer', 'added',
  'un nombre que existe en la otra lista no choca');
select is((select slug from public.levels where name = 'Yoga'), 'yoga', 'ni su slug');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'levels', U&'Ba\0301sico') ->> 'answer', 'added', 'agrega un nivel escrito descompuesto (NFD)');
select ok(exists (select 1 from public.levels where name = 'Básico'), 'y lo guarda compuesto (NFC)');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'levels', 'Bãsico') ->> 'answer', 'duplicate',
  'con cualquier acento, también uno que nadie escribe aquí: duplicate');

-- ---------------------------------------------------------------------------------------
-- Renombrar: el slug no cambia.

select is(pruebas.renombra('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Yoga')).id, 'Yoga suave'), 'renamed', 'renombra');
select is((pruebas.practica('Yoga suave')).slug, 'yoga', 'y el slug sigue siendo el de antes: las direcciones guardadas siguen sirviendo');
select pruebas.anotar_auditoria();
select is(pruebas.renombra('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Yoga suave')).id, 'Yoga suave'), 'unchanged',
  'al mismo nombre: unchanged');
select is(pruebas.renglones_de('public.practices') - pruebas.renglones_antes(), 0::bigint, 'sin escribir nada');
select is(pruebas.renombra('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Yoga suave')).id, 'respiracion'), 'duplicate',
  'al nombre de otra: duplicate');
select is(pruebas.renombra('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Yoga suave')).id, ''), 'invalid', 'a un nombre vacío: invalid');
select is(pruebas.renombra('b0000000-0000-0000-0000-000000000001', 'practices', gen_random_uuid(), 'Otra'), 'not_found', 'una que no existe: not_found');
select is(pruebas.renombra('b0000000-0000-0000-0000-000000000001', 'practices', (select id from public.levels where name = 'Principiante'), 'Otra'),
  'not_found', 'una de la otra lista: not_found');
select is(pruebas.renombra('d0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Yoga suave')).id, 'Otra'), 'forbidden',
  'sin Contenido: forbidden');
select is(pruebas.renombra('b0000000-0000-0000-0000-000000000002', 'practices', (pruebas.practica('Yoga suave')).id, 'Otra'), 'needs_fresh_code',
  'con un código de hace una hora: needs_fresh_code');

-- ---------------------------------------------------------------------------------------
-- Ordenar: se intercambia con la vecina activa.

-- Orden de ahora: Yoga suave (1), Meditación guiada (2), Respiración (3), bbbb… (4), Yoga! (5).
select pruebas.anotar_auditoria();
select is(pruebas.mueve('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Meditación guiada')).id, 'up'), 'moved', 'sube una');
select is(
  (select array_agg(name order by position) from public.practices where position <= 2),
  array['Meditación guiada', 'Yoga suave'], 'y se intercambia con la de arriba');
select is(pruebas.renglones_de('public.practices') - pruebas.renglones_antes(), 2::bigint, 'el intercambio deja dos renglones: uno por fila');
select is(pruebas.mueve('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Meditación guiada')).id, 'up'), 'edge', 'la primera no sube: edge');
select is(pruebas.mueve('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Yoga!')).id, 'down'), 'edge', 'la última no baja: edge');
select is(pruebas.mueve('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Yoga!')).id, 'left'), 'invalid', 'una dirección que no existe: invalid');
select is(pruebas.mueve('b0000000-0000-0000-0000-000000000001', 'practices', gen_random_uuid(), 'up'), 'not_found', 'una que no existe: not_found');
select is(pruebas.mueve('b0000000-0000-0000-0000-000000000002', 'practices', (pruebas.practica('Yoga!')).id, 'up'), 'needs_fresh_code',
  'con un código de hace una hora: needs_fresh_code');

-- ---------------------------------------------------------------------------------------
-- Quitar es desactivar; se puede reactivar, en su lugar.

select is(pruebas.activa('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Respiración')).id, false), 'deactivated', 'desactiva');
select ok(not (pruebas.practica('Respiración')).is_active, 'queda inactiva');
select is(pruebas.activa('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Respiración')).id, false), 'unchanged', 'otra vez: unchanged');
select is(pruebas.activa('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Respiración')).id, null), 'invalid', 'sin decir cuál: invalid');
select is(pruebas.activa('b0000000-0000-0000-0000-000000000002', 'practices', (pruebas.practica('Respiración')).id, true), 'needs_fresh_code',
  'con un código de hace una hora: needs_fresh_code');
select is(pruebas.mueve('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Respiración')).id, 'up'), 'not_found', 'una inactiva no se mueve');
-- bbbb… (4) sube: la vecina activa de arriba es Yoga suave (2), no Respiración (3), que está inactiva.
select is(pruebas.mueve('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica(repeat('b', 40))).id, 'up'), 'moved', 'se salta a la inactiva');
select is((pruebas.practica(repeat('b', 40))).position, 2, 'y toma el lugar de la activa de arriba');
select is((pruebas.practica('Respiración')).position, 3, 'la inactiva no se movió');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', 'respiracion') ->> 'answer', 'inactive_duplicate',
  'agregar el nombre de una inactiva: inactive_duplicate');
select is(pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', 'respiracion') ->> 'id', (pruebas.practica('Respiración')).id::text,
  'con su id, para reactivarla');
select is(pruebas.activa('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('Respiración')).id, true), 'reactivated', 'reactiva');
select is((pruebas.practica('Respiración')).position, 3, 'en el lugar que tenía');

-- ---------------------------------------------------------------------------------------
-- El tono: rotación por orden de creación, de ocho, sin importar cuáles estén activas.

select pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', 'P6');
select pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', 'P7');
select pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', 'P8');
select pruebas.agrega('b0000000-0000-0000-0000-000000000001', 'practices', 'P9');
select is(
  (select array_agg(cover_tone::int order by created_at, position) from public.practices),
  array[1, 2, 3, 4, 5, 6, 7, 8, 1], 'cada nueva toma el tono siguiente, y la novena vuelve al primero');

-- ---------------------------------------------------------------------------------------
-- Lo que ve la pantalla.

select is(pruebas.listas('a0000000-0000-0000-0000-000000000001'), null::jsonb, 'una cuenta común no ve las listas: nulo');
select is(pruebas.listas('d0000000-0000-0000-0000-000000000001'), null::jsonb, 'ni alguien del equipo sin Contenido');
select is(pruebas.listas('c0000000-0000-0000-0000-000000000001'), null::jsonb, 'ni con configuración');
select pruebas.activa('b0000000-0000-0000-0000-000000000001', 'practices', (pruebas.practica('P9')).id, false);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pruebas.listas('b0000000-0000-0000-0000-000000000001')) as k),
  array['fresh_code', 'levels', 'practices'], 'a Contenido: las dos listas y si su código es reciente');
select is(pruebas.listas('b0000000-0000-0000-0000-000000000001') -> 'fresh_code', 'true'::jsonb, 'recién dado: reciente');
select is(jsonb_array_length(pruebas.listas('b0000000-0000-0000-0000-000000000001') -> 'practices'), 9, 'las nueve prácticas, también la inactiva');
select is(
  (select array_agg(p ->> 'name' order by ord) from jsonb_array_elements(pruebas.listas('b0000000-0000-0000-0000-000000000001') -> 'practices')
     with ordinality as t(p, ord) where ord <= 3),
  array['Meditación guiada', repeat('b', 40), 'Respiración'], 'en el orden de su posición');
select is(
  (select array_agg(distinct k order by k) from jsonb_array_elements(pruebas.listas('b0000000-0000-0000-0000-000000000001') -> 'practices') as p,
     jsonb_object_keys(p) as k),
  array['cover_tone', 'id', 'in_use', 'is_active', 'name', 'position', 'slug'], 'de cada práctica, estos campos');
select is(
  (select array_agg(distinct k order by k) from jsonb_array_elements(pruebas.listas('b0000000-0000-0000-0000-000000000001') -> 'levels') as p,
     jsonb_object_keys(p) as k),
  array['id', 'in_use', 'is_active', 'name', 'position', 'slug'], 'de cada nivel, estos');
select is(pruebas.listas('b0000000-0000-0000-0000-000000000002') -> 'fresh_code', 'false'::jsonb,
  'con el código viejo ve las listas, y que no es reciente: leer no lo pide');

-- El público ve solo las activas.
select pruebas.como_visitante();
select is((select count(*)::int from public.practices), 8, 'un visitante ve las activas');
select ok(not exists (select 1 from public.practices where name = 'P9'), 'y no la inactiva');
select pruebas.limpiar();
select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.practices), 8, 'una cuenta común, lo mismo');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- El guardián: aunque alguien le diera permiso al servidor, escribir directo no pasa.

select pruebas.como_dueno();
grant insert, update, delete on public.practices, public.levels to app_service;
select isnt_empty('select * from private.schema_violations()', 'con un permiso de más, el vigilante lo señala');
select pruebas.a_nombre_de('b0000000-0000-0000-0000-000000000001');
select throws_ok($$insert into public.practices (slug, name, position, cover_tone) values ('directa', 'Directa', 99, 1)$$,
  '42501', 'public.practices: only the catalog functions write this list',
  'insertar directo, aun con Contenido: el guardián lo rechaza');
select throws_ok($$update public.practices set name = 'Otra' where name = 'P6'$$,
  '42501', 'public.practices: only the catalog functions write this list', 'actualizar directo, tampoco');
select throws_ok($$insert into public.levels (slug, name, position) values ('directo', 'Directo', 99)$$,
  '42501', 'public.levels: only the catalog functions write this list', 'en los niveles, igual');
select pruebas.limpiar();
select pruebas.como_dueno_sistema();
-- El dueño declarado sistema sí: así crea el guion local las prácticas de los cursos de
-- prueba (decisión de Sergio del 2026-10-14, T-107).
select lives_ok($$insert into public.practices (slug, name, position, cover_tone) values ('directa', 'Directa', 99, 1)$$,
  'el dueño declarado sistema sí escribe');
select pruebas.limpiar();
revoke insert, update, delete on public.practices, public.levels from app_service;
select is_empty('select * from private.schema_violations()', '(sin el permiso de más, en cero otra vez)');
grant trigger on public.levels to app_service;
select isnt_empty('select * from private.schema_violations()', 'con permiso de ponerle disparadores, el vigilante también lo señala');
revoke trigger on public.levels from app_service;

-- Ni el dueño de la tabla con Contenido (como escriben las funciones) cambia el id o el
-- slug, ni borra.
select pruebas.dueno_a_nombre_de('b0000000-0000-0000-0000-000000000001');
select lives_ok($$update public.practices set name = 'P6 nueva' where name = 'P6'$$, '(así, renombrar pasa)');
select throws_ok($$update public.practices set slug = 'otro' where name = 'P6 nueva'$$,
  '42501', 'public.practices: id and slug do not change', 'el slug no cambia');
select throws_ok($$update public.levels set id = gen_random_uuid() where name = 'Yoga'$$,
  '42501', 'public.levels: id and slug do not change', 'ni el id');
select throws_ok($$delete from public.practices where name = 'P6 nueva'$$,
  '42501', 'public.practices: rows are deactivated, not deleted', 'y nada se borra');
select pruebas.limpiar();
select pruebas.dueno_a_nombre_de('b0000000-0000-0000-0000-000000000002');
select throws_ok($$update public.practices set name = 'P7 nueva' where name = 'P7'$$,
  '42501', 'public.practices: only the catalog functions write this list',
  'ni el dueño a nombre de alguien con Contenido y un código de hace una hora');
select pruebas.limpiar();
select pruebas.dueno_a_nombre_de('b0000000-0000-0000-0000-000000000001');
-- (Las revisiones diferidas de las posiciones, hechas ya: con ellas pendientes, la base no
-- deja ni intentar vaciar.)
set constraints all immediate;
-- Desde T-107 lo publicado apunta a las prácticas: vaciar a secas lo niega la clave foránea
-- antes que el guardián. En cascada llega a los guardianes, y tampoco pasa.
select throws_ok($$truncate public.practices$$, '0A000', null, 'ni se vacía');
select throws_ok($$truncate public.practices cascade$$, '42501', null, 'ni en cascada');
select throws_ok($$insert into public.levels (slug, name, position) values ('basico-nfd', U&'Ba\0301sico', 99)$$,
  '23514', null, 'un nombre descompuesto no lo guarda ni el dueño: la tabla lo exige en NFC');
select throws_ok($$insert into public.levels (slug, name, position) values ('yoga-suave', U&'Yo\00ADga', 98)$$,
  '23514', null, 'ni uno con un carácter que no se ve');
select pruebas.limpiar();

select * from finish();
rollback;
