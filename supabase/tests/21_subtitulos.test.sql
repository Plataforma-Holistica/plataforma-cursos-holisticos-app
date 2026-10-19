-- T-203 · Los subtítulos se recuerdan en la cuenta (RF-310; diseño, sección 5.4; decisión de
-- Sergio del 2026-10-15). Una columna de `profiles` que nace apagada: el servidor la escribe
-- por su columna, a nombre de quien actúa, y la persona solo la lee. No se audita: no es un
-- acto administrativo.
begin;
\ir _ayuda.psql
select plan(13);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana-subtitulos@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto-subtitulos@prueba.test');

select pruebas.como_dueno();
select has_column('public', 'profiles', 'captions_on', 'el perfil tiene la elección de subtítulos');
select col_not_null('public', 'profiles', 'captions_on', 'sin nulos: apagados o prendidos');
select is(
  (select bool_or(captions_on) from public.profiles where id::text like 'a0000000-0000-0000-0000-00000000000_'),
  false, 'una cuenta nueva nace con los subtítulos apagados');

-- ---------------------------------------------------------------------------------------
-- Quién la escribe: el servidor, por su columna. Nadie más.

select ok(has_column_privilege('app_service', 'public.profiles', 'captions_on', 'update'),
  'el servidor puede escribir la elección');
select ok(
  not has_column_privilege(r, 'public.profiles', 'captions_on', 'update'),
  r || ' no la escribe')
from unnest(array['anon', 'authenticated', 'service_role']) as r;

select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
update public.profiles set captions_on = true where id = 'a0000000-0000-0000-0000-000000000001';
select pruebas.como_dueno();
select is(
  (select captions_on from public.profiles where id = 'a0000000-0000-0000-0000-000000000001'),
  true, 'el servidor la prende, a nombre de quien actúa');

select pruebas.como_usuario('a0000000-0000-0000-0000-000000000002');
select throws_ok(
  $$update public.profiles set captions_on = true where id = 'a0000000-0000-0000-0000-000000000002'$$,
  '42501', null, 'la persona no la escribe con su sesión: pasa por el servidor');
select is(
  (select captions_on from public.profiles),
  false, 'pero sí lee la suya');
select is(
  (select count(*)::int from public.profiles where id = 'a0000000-0000-0000-0000-000000000001'),
  0, 'y no la de otra cuenta');

-- ---------------------------------------------------------------------------------------
-- No deja nada en la auditoría, y el vigilante sigue en cero.

select pruebas.como_dueno();
select is(
  (select count(*)::int from public.audit_log where entity_id = 'a0000000-0000-0000-0000-000000000001'),
  0, 'cambiarla no se audita');
select is(
  (select count(*)::int from private.schema_violations()),
  0, 'el vigilante no encuentra nada');

select * from finish();
rollback;
