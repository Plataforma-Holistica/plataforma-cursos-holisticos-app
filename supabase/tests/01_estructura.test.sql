-- T-103 · Comprobaciones estructurales (esquema de backend §16.3, RNF-08).
-- Ninguna tabla sin seguridad por fila, ninguna función de más, ningún permiso de más.
begin;
\ir _ayuda.psql
select plan(30);

select is_empty(
  'select * from private.schema_violations()',
  'private.schema_violations() devuelve cero filas');

select has_table('public', t, 'existe public.' || t)
from unnest(array['profiles', 'admin_capabilities', 'audit_log',
                  'parameter_definitions', 'business_parameters',
                  'legal_documents', 'consents']) as t;
select has_table('private', t, 'existe private.' || t)
from unnest(array['rate_limit_counters', 'login_throttles']) as t;

-- El visitante no lee ninguna tabla propia, salvo los textos legales (y de esos, sus
-- columnas públicas: lo prueba 05_legal).
select ok(
  not has_any_column_privilege('anon', 'public.' || t, 'select'),
  'el visitante no tiene permiso de lectura sobre ' || t)
from unnest(array['profiles', 'admin_capabilities', 'audit_log',
                  'parameter_definitions', 'business_parameters', 'consents']) as t;
select ok(
  has_any_column_privilege('anon', 'public.legal_documents', 'select')
    and not has_table_privilege('anon', 'public.legal_documents', 'select'),
  'el visitante lee los textos legales, por columnas y no la tabla entera');

-- La clave secreta de Supabase no toca tablas propias.
select ok(
  not has_table_privilege('service_role', 'public.' || t, 'select, insert, update, delete'),
  'service_role no tiene ningún permiso sobre ' || t)
from unnest(array['profiles', 'admin_capabilities', 'audit_log',
                  'parameter_definitions', 'business_parameters',
                  'legal_documents', 'consents']) as t;

-- El permiso de entrada no se comprueba: la migración crea el rol sin él, y cada entorno
-- se lo da fuera del repositorio (en local, `pnpm db:login`).
select ok(
  (select rolbypassrls and not rolsuper from pg_roles where rolname = 'app_service'),
  'app_service salta la seguridad por fila y no es superusuario');

-- El servidor baja al rol de la persona para leer por ella (ADR-31, TRD §8.10). Puede
-- cambiar a esos dos roles y a ninguno más, y no hereda lo que ellos tengan.
select ok(
  exists (
    select 1
    from pg_auth_members m
    where m.member = 'app_service'::regrole and m.roleid = 'authenticated'::regrole
      and m.set_option and not m.inherit_option and not m.admin_option),
  'app_service puede bajar a authenticated, sin heredar sus permisos');
select ok(
  exists (
    select 1
    from pg_auth_members m
    where m.member = 'app_service'::regrole and m.roleid = 'anon'::regrole
      and m.set_option and not m.inherit_option and not m.admin_option),
  'app_service puede bajar a anon, sin heredar sus permisos');
select is(
  (select coalesce(array_agg(m.roleid::regrole::text order by m.roleid::regrole::text), '{}')
   from pg_auth_members m
   where m.member = 'app_service'::regrole),
  array['anon', 'authenticated'],
  'app_service no es miembro de ningún otro rol');

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
