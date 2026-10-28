-- T-210, segunda solicitud · Buscar en el catálogo (RF-304, PA-21, FL-11): por el título del curso
-- y el nombre del maestro, sin acentos, sin mayúsculas y por el principio de cada palabra
-- (decisión de Sergio del 2026-10-27). Esquema §5.2. La clave es la de las listas
-- (`private.catalog_key`), así un nombre se compara igual en todas partes.
begin;
\ir _ayuda.psql
select plan(33);

-- Lo que dice si un texto encuentra a otro: el lado del curso y el de quien busca.
create function pruebas.halla(p_doc text, p_query text) returns boolean
language sql as $$ select coalesce(private.catalog_search(p_doc) @@ private.catalog_query(p_query), false) $$;

-- ---------------------------------------------------------------------------------------
-- La estructura y los permisos.

select has_function('private', 'catalog_search', array['text'], 'existe private.catalog_search(text)');
select has_function('private', 'catalog_query', array['text'], 'existe private.catalog_query(text)');
select volatility_is('private', 'catalog_search', array['text'], 'immutable', 'la del curso es inmutable: la usa una columna generada');
select volatility_is('private', 'catalog_query', array['text'], 'immutable', 'la de quien busca es inmutable');
select ok(
  (select pg_catalog.pg_get_expr(d.adbin, d.adrelid) like '%catalog_search%'
   from pg_catalog.pg_attrdef d
   join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.published_courses'::regclass and a.attname = 'search_tsv'),
  'la columna de búsqueda de los cursos publicados sale de catalog_search');
select ok(
  (select pg_catalog.pg_get_indexdef(i.indexrelid) like '%USING gin (search_tsv)%'
   from pg_catalog.pg_index i
   where i.indexrelid = 'public.published_courses_search_idx'::regclass),
  'y lleva su índice GIN');
select ok(
  has_function_privilege('app_service', 'private.catalog_query(text)', 'execute')
  and not has_function_privilege('authenticated', 'private.catalog_query(text)', 'execute')
  and not has_function_privilege('anon', 'private.catalog_query(text)', 'execute'),
  'la consulta la arma solo el servidor');
select ok(
  has_function_privilege('authenticated', 'private.catalog_search(text)', 'execute')
  and has_function_privilege('anon', 'private.catalog_search(text)', 'execute'),
  'la del curso la ejecuta cualquiera: la columna se calcula con los permisos de quien escribe, y así manda el guardián');
select ok(
  not has_function_privilege('app_service', 'private.catalog_key(text)', 'execute'),
  'la clave de un nombre sigue siendo interna');

-- ---------------------------------------------------------------------------------------
-- Sin acentos y sin mayúsculas, de los dos lados.

select ok(pruebas.halla('Respiración consciente', 'respiracion'), 'sin acento encuentra al acentuado');
select ok(pruebas.halla('Respiracion consciente', 'Respiración'), 'con acento encuentra al que no lo lleva');
select ok(pruebas.halla('Respiración consciente', 'RESPIRACIÓN'), 'sin importar las mayúsculas');
select ok(pruebas.halla('Respiración consciente', 'respiraci' || chr(111) || chr(769) || 'n'), 'la tilde escrita aparte es la misma letra');
select ok(pruebas.halla('Yoga con Ana Núñez', 'nunez'), 'la eñe sin tilde');

-- ---------------------------------------------------------------------------------------
-- Por el principio de cada palabra.

select ok(pruebas.halla('Respiración consciente', 'resp'), 'el principio de una palabra la encuentra');
select ok(pruebas.halla('Respiración consciente', 'consc'), 'de cualquiera de sus palabras');
select ok(not pruebas.halla('Respiración consciente', 'piracion'), 'el medio de una palabra no');
select ok(pruebas.halla('Curso 5 minutos', '5'), 'las cifras también');

-- ---------------------------------------------------------------------------------------
-- Varias palabras: todas, en cualquier orden. El título y el maestro son un solo texto.

select ok(pruebas.halla('Yoga suave Ana Núñez', 'yoga ana'), 'título y maestro a la vez');
select ok(pruebas.halla('Yoga suave Ana Núñez', 'ana yo'), 'en cualquier orden');
select ok(not pruebas.halla('Yoga suave Ana Núñez', 'yoga pedro'), 'una palabra que no está deja fuera');
select ok(pruebas.halla('Yoga' || chr(160) || 'suave', 'yoga suave'), 'el espacio duro separa palabras');

-- ---------------------------------------------------------------------------------------
-- Lo que no son letras ni cifras solo separa: nunca es un operador de la búsqueda.

select ok(pruebas.halla('Reiki-Usui para principiantes', 'usui'), 'una palabra con guion se encuentra por sus partes');
select ok(pruebas.halla('Reiki Usui', 'reiki-usui'), 'y buscar con guion encuentra sin él');
select ok(pruebas.halla('Yoga suave Ana', 'yoga & !ana'), '«&» y «!» no niegan ni juntan: solo separan');
select lives_ok($$ select private.catalog_query('a:* | b <-> (c'' d\') $$, 'nada de lo que se escriba rompe la consulta');
select ok(not pruebas.halla('Yoga suave', 'yoga:*|zzz'), '«|» no es «o»: la palabra que no está deja fuera');
select ok(not pruebas.halla('Yoga suave', 'yoga|zzz'), 'ni siquiera sin espacios');

-- ---------------------------------------------------------------------------------------
-- Sin nada que buscar, nula: quien la usa sabe que no hay búsqueda.

select is(private.catalog_query(''), null, 'vacía es nula');
select is(private.catalog_query('   ¿? — !! '), null, 'sin una letra ni una cifra es nula');
select is(private.catalog_query(null), null, 'nula es nula');
select lives_ok($$ select private.catalog_query(repeat('respiracion ', 500)) $$, 'una muy larga no rompe');

select is_empty('select * from private.schema_violations()', 'private.schema_violations() sigue en cero');

select * from finish();
rollback;
