-- T-210, segunda solicitud · Buscar en el catálogo (RF-304, PA-21, FL-11). Esquema §5.2.
-- Decisión de Sergio del 2026-10-27: la búsqueda va sin acentos y por el principio de cada
-- palabra, con una migración chica.
--
-- La columna de búsqueda de T-107 usaba la configuración `spanish`: guardaba las raíces y
-- con acentos, así que «respiracion» no encontraba «Respiración», y «resp» no encontraba
-- nada. Ahora las dos puntas pasan por la misma clave de las listas (`private.catalog_key`:
-- minúsculas, sin acentos en ninguna forma Unicode, espacios duros como espacios) y por la
-- configuración `simple`, sin raíces ni palabras vacías. Quien busca da palabras: cada una se
-- busca como principio de una palabra del título o del maestro, y todas tienen que estar.

-- Lo que se guarda de un curso para buscarlo. Inmutable: la usa una columna generada. Postgres
-- la calcula con los permisos de quien escribe la fila, en cada escritura y antes de los
-- disparadores: sin permiso, quien intenta escribir directo recibiría «sin permiso sobre la
-- función» en lugar del rechazo del guardián. Por eso la ejecuta cualquiera; es del dueño
-- porque la clave es interna, y no lee ninguna tabla.
create function private.catalog_search(p_text text) returns tsvector
language sql immutable security definer set search_path = ''
as $$
  select pg_catalog.to_tsvector('pg_catalog.simple'::pg_catalog.regconfig, private.catalog_key(coalesce(p_text, '')))
$$;

-- La consulta de quien busca, o nula si no trae nada que buscar. Solo letras sin acento y
-- cifras llegan a la consulta: lo demás separa palabras, así que nada de lo que se escriba
-- es un operador (`&`, `|`, `!`, `:*`, paréntesis). Se miran los primeros 100 caracteres.
-- Es del dueño porque la clave es interna (la prueba 17 lo exige), y no lee ninguna tabla.
create function private.catalog_query(p_text text) returns tsquery
language sql immutable security definer set search_path = ''
as $$
  select pg_catalog.to_tsquery('pg_catalog.simple'::pg_catalog.regconfig, pg_catalog.string_agg(word || ':*', ' & '))
  from pg_catalog.regexp_split_to_table(private.catalog_key(pg_catalog.left(coalesce(p_text, ''), 100)), '[^a-z0-9]+') as word
  where word <> ''
$$;
revoke execute on function private.catalog_search(text), private.catalog_query(text) from public;
grant execute on function private.catalog_search(text) to anon, authenticated, app_service;
grant execute on function private.catalog_query(text) to app_service;

-- La columna de antes se cambia por la nueva. Quitarla se lleva su índice.
alter table public.published_courses drop column search_tsv;
alter table public.published_courses
  add column search_tsv tsvector generated always as (private.catalog_search(title || ' ' || teacher_name)) stored;
-- Búsqueda por título de curso y nombre de maestro (RF-304).
create index published_courses_search_idx on public.published_courses using gin (search_tsv);
