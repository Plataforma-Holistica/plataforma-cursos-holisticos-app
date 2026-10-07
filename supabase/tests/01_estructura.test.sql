-- T-103 · Comprobaciones estructurales (esquema de backend §16.3, RNF-08).
-- Ninguna tabla sin seguridad por fila, ninguna función de más, ningún permiso de más.
begin;
\ir _ayuda.psql
select plan(19);

select is_empty(
  'select * from private.schema_violations()',
  'private.schema_violations() devuelve cero filas');

select has_table('public', t, 'existe public.' || t)
from unnest(array['profiles', 'admin_capabilities', 'audit_log',
                  'parameter_definitions', 'business_parameters']) as t;

-- El visitante no lee ninguna tabla propia.
select ok(
  not has_table_privilege('anon', 'public.' || t, 'select'),
  'el visitante no tiene permiso de lectura sobre ' || t)
from unnest(array['profiles', 'admin_capabilities', 'audit_log',
                  'parameter_definitions', 'business_parameters']) as t;

-- La clave secreta de Supabase no toca tablas propias.
select ok(
  not has_table_privilege('service_role', 'public.' || t, 'select, insert, update, delete'),
  'service_role no tiene ningún permiso sobre ' || t)
from unnest(array['profiles', 'admin_capabilities', 'audit_log',
                  'parameter_definitions', 'business_parameters']) as t;

select ok(
  (select rolbypassrls and not rolcanlogin and not rolsuper from pg_roles where rolname = 'app_service'),
  'app_service salta la seguridad por fila, no es superusuario y nace sin permiso de entrada');

-- La API de datos no expone el esquema privado.
select ok(
  not has_schema_privilege('anon', 'private', 'usage'),
  'el visitante no tiene uso del esquema private');

-- Sobre el libro de auditoría, el servidor solo lee e inserta.
select ok(
  has_table_privilege('app_service', 'public.audit_log', 'select')
    and has_table_privilege('app_service', 'public.audit_log', 'insert')
    and not has_table_privilege('app_service', 'public.audit_log', 'update')
    and not has_table_privilege('app_service', 'public.audit_log', 'delete')
    and not has_table_privilege('app_service', 'public.audit_log', 'truncate'),
  'app_service lee e inserta en audit_log, y nada más');

select * from finish();
rollback;
