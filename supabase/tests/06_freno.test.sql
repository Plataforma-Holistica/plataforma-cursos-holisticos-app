-- T-104 · Freno de intentos y límites de peticiones (RF-102, RNF-08).
-- Esquema de backend §5.9 y §16.2. Las dos tablas viven en private y solo las toca el servidor.
begin;
\ir _ayuda.psql
select plan(26);

-- ---------------------------------------------------------------------------------------
-- Estructura: sin registro de escritura adelantada, con seguridad por fila y sin políticas.

select is(
  (select array_agg(c.relname::text order by c.relname)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'private' and c.relname in ('rate_limit_counters', 'login_throttles')
     and c.relpersistence = 'u' and c.relrowsecurity),
  array['login_throttles', 'rate_limit_counters'],
  'las dos tablas existen, son unlogged y tienen seguridad por fila');
select is(
  (select count(*)::int from pg_policies
   where schemaname = 'private' and tablename in ('rate_limit_counters', 'login_throttles')),
  0, 'ninguna tiene políticas: quedan cerradas para toda persona');

select ok(
  has_table_privilege('app_service', 'private.' || t, 'select')
    and has_table_privilege('app_service', 'private.' || t, 'insert')
    and has_table_privilege('app_service', 'private.' || t, 'update')
    and has_table_privilege('app_service', 'private.' || t, 'delete')
    and not has_table_privilege('app_service', 'private.' || t, 'truncate'),
  'app_service lee, inserta, actualiza y borra en ' || t || ', y no la vacía')
from unnest(array['rate_limit_counters', 'login_throttles']) as t;
select ok(
  not has_table_privilege(r, 'private.' || t, 'select, insert, update, delete, truncate')
    and not has_any_column_privilege(r, 'private.' || t, 'select, insert, update'),
  r || ' no tiene ningún permiso sobre ' || t || ', ni por columna')
from unnest(array['rate_limit_counters', 'login_throttles']) as t,
     unnest(array['anon', 'authenticated', 'service_role']) as r;

-- ---------------------------------------------------------------------------------------
-- El servidor cuenta y frena. Las claves son huellas de 32 bytes, no correos ni direcciones.

select pruebas.como_servicio();
select lives_ok(
  $$insert into private.login_throttles (account_key, ip_key, failed_count, locked_until, last_failed_at)
    values (decode(repeat('a1', 32), 'hex'), decode(repeat('01', 32), 'hex'), 5, now() + interval '1 minute', now()),
           (decode(repeat('a1', 32), 'hex'), decode(repeat('02', 32), 'hex'), 1, null, now()),
           (decode(repeat('b2', 32), 'hex'), decode(repeat('01', 32), 'hex'), 2, null, now())$$,
  'el servidor guarda frenos por par de cuenta e IP');
select throws_ok(
  $$insert into private.login_throttles (account_key, ip_key)
    values (decode(repeat('a1', 32), 'hex'), decode(repeat('01', 32), 'hex'))$$,
  '23505', null, 'un par tiene una sola fila');
select throws_ok(
  $$insert into private.login_throttles (account_key, ip_key)
    values (decode(repeat('a1', 31), 'hex'), decode(repeat('03', 32), 'hex'))$$,
  '23514', null, 'la huella de la cuenta mide 32 bytes: 31 no pasan');
select throws_ok(
  $$insert into private.login_throttles (account_key, ip_key)
    values (decode(repeat('a1', 32), 'hex'), decode(repeat('03', 33), 'hex'))$$,
  '23514', null, 'la huella de la IP mide 32 bytes: 33 no pasan');
select throws_ok(
  $$insert into private.login_throttles (account_key, ip_key, failed_count)
    values (decode(repeat('c3', 32), 'hex'), decode(repeat('03', 32), 'hex'), -1)$$,
  '23514', null, 'la cuenta de fallos no baja de cero');

-- Recuperar la contraseña quita los frenos de esa cuenta, en todas sus redes, y de ninguna otra.
select lives_ok(
  $$delete from private.login_throttles where account_key = decode(repeat('a1', 32), 'hex')$$,
  'el servidor borra los frenos de una cuenta');
-- Solo las huellas de esta prueba: la tabla puede traer frenos de una sesión de desarrollo.
select results_eq(
  $$select encode(account_key, 'hex') from private.login_throttles
    where account_key in (decode(repeat('a1', 32), 'hex'), decode(repeat('b2', 32), 'hex'))$$,
  array[repeat('b2', 32)],
  'se fueron los dos pares de esa cuenta y quedó el de la otra');

select lives_ok(
  $$insert into private.rate_limit_counters (bucket, window_start) values ('prueba:x', date_trunc('hour', now()))$$,
  'el servidor abre un contador');
select is(
  (select hits from private.rate_limit_counters where bucket = 'prueba:x'),
  1, 'un contador nace en uno');
select lives_ok(
  $$update private.rate_limit_counters set hits = hits - 1 where bucket = 'prueba:x'$$,
  'descontar el intento que salió bien puede dejarlo en cero');
select throws_ok(
  $$update private.rate_limit_counters set hits = hits - 1 where bucket = 'prueba:x'$$,
  '23514', null, 'pero no bajo cero');

-- Aunque alguien le diera lectura a una persona, la seguridad por fila la deja sin filas.
select pruebas.como_dueno();
grant select on private.login_throttles to authenticated;
select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from private.login_throttles), 0,
  'con permiso de lectura y filas presentes, una persona con sesión no ve ninguna');
select pruebas.como_dueno();
revoke select on private.login_throttles from authenticated;
-- Y el vigilante avisa de un permiso así, aunque sea de una sola columna y solo de lectura.
grant select (account_key) on private.login_throttles to authenticated;
select isnt_empty(
  $$select * from private.schema_violations()
    where problem = 'unexpected column privilege for authenticated'
      and object_name = 'private.login_throttles'$$,
  'schema_violations() avisa si una persona recibe una columna del esquema privado');
revoke select (account_key) on private.login_throttles from authenticated;

-- ---------------------------------------------------------------------------------------
-- Los ocho parámetros, por nombre: definidos, enteros, con su unidad y con valor vigente.

select results_eq(
  $$select d.key, d.value_type, d.unit, d.group_name, d.affects_payout,
           private.parameter_value(d.key)
    from public.parameter_definitions d
    where d.key in ('FRENO_ESPERA_BASE', 'FRENO_ESPERA_TOPE', 'FRENO_OLVIDO', 'FRENO_CONFIANZA_DIAS',
                    'TOPE_INTENTOS_HORA', 'TOPE_REGISTROS_HORA', 'TOPE_ENVIOS_CORREO_HORA', 'ESPERA_REENVIO')
    order by d.key$$,
  $$values ('ESPERA_REENVIO', 'integer', 'segundos', 'product', false, '60'::jsonb),
           ('FRENO_CONFIANZA_DIAS', 'integer', 'días', 'product', false, '30'::jsonb),
           ('FRENO_ESPERA_BASE', 'integer', 'minutos', 'product', false, '1'::jsonb),
           ('FRENO_ESPERA_TOPE', 'integer', 'minutos', 'product', false, '15'::jsonb),
           ('FRENO_OLVIDO', 'integer', 'minutos', 'product', false, '60'::jsonb),
           ('TOPE_ENVIOS_CORREO_HORA', 'integer', null, 'product', false, '5'::jsonb),
           ('TOPE_INTENTOS_HORA', 'integer', null, 'product', false, '20'::jsonb),
           ('TOPE_REGISTROS_HORA', 'integer', null, 'product', false, '20'::jsonb)$$,
  'los ocho parámetros del freno existen con su tipo, su unidad y el valor de 00-fundamentos §4');
select is(
  (select count(*)::int from public.business_parameters
   where key in ('FRENO_ESPERA_BASE', 'FRENO_ESPERA_TOPE', 'FRENO_OLVIDO', 'FRENO_CONFIANZA_DIAS',
                 'TOPE_INTENTOS_HORA', 'TOPE_REGISTROS_HORA', 'TOPE_ENVIOS_CORREO_HORA', 'ESPERA_REENVIO')
     and status = 'proposed'),
  8, 'y los ocho valores están como propuestos');
select ok(
  (private.parameter_value('FRENO_ESPERA_BASE') #>> '{}')::int
    <= (private.parameter_value('FRENO_ESPERA_TOPE') #>> '{}')::int,
  'la espera base no pasa del tope');

select pruebas.limpiar();
select * from finish();
rollback;
