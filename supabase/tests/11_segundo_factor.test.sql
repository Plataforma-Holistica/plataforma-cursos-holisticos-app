-- T-105 · El segundo factor en Auth (RF-106). TRD §9.2, fila «Segundo factor»; esquema §6.2.
-- Primera entrega de T-105.
--
-- Dos cosas. El freno de los códigos del segundo factor, que vive en un gancho de Supabase
-- Auth: Auth le pregunta a esta función antes de dar por buena o por mala cada verificación,
-- venga de la aplicación o de quien llame directo a Auth. Y saber si quien actúa tiene un
-- factor verificado, que es lo que decide cómo cambia su contraseña.
begin;
\ir _ayuda.psql
select plan(34);

select pruebas.alta('e0000000-0000-0000-0000-000000000001', 'con-factor@prueba.test');
select pruebas.alta('e0000000-0000-0000-0000-000000000002', 'sin-factor@prueba.test');
select pruebas.alta('e0000000-0000-0000-0000-000000000003', 'a-medias@prueba.test');

select pruebas.como_dueno();
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
  ('fac70000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'uno', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP'),
  ('fac70000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000003', 'uno', 'totp', 'unverified', now(), now(), 'JBSWY3DPEHPK3PXP');

-- Un intento, como lo manda Auth: qué decide el gancho.
create function pruebas.intento(p_factor uuid, p_valid boolean) returns text
language sql
as $$
  select private.second_factor_attempt(jsonb_build_object(
    'factor_id', p_factor, 'user_id', 'e0000000-0000-0000-0000-000000000001',
    'factor_type', 'totp', 'valid', p_valid)) ->> 'decision';
$$;

create function pruebas.freno(p_factor uuid) returns table (fallos int, espera interval, frenado boolean)
language sql
as $$
  select a.failed_count, a.locked_until - a.last_failed_at, a.locked_until > clock_timestamp()
  from private.second_factor_attempts a where a.factor_id = p_factor;
$$;

-- ---------------------------------------------------------------------------------------
-- Estructura.

select ok(
  has_function_privilege('supabase_auth_admin', 'private.second_factor_attempt(jsonb)', 'execute')
    and not has_function_privilege('app_service', 'private.second_factor_attempt(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'private.second_factor_attempt(jsonb)', 'execute')
    and not has_function_privilege('anon', 'private.second_factor_attempt(jsonb)', 'execute')
    and not has_function_privilege('service_role', 'private.second_factor_attempt(jsonb)', 'execute'),
  'el gancho solo lo ejecuta Supabase Auth');
select is(
  (select count(*)::int from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and has_function_privilege('supabase_auth_admin', p.oid, 'execute')),
  1, 'y de todo el esquema privado, Auth no ejecuta nada más');
select ok(
  has_function_privilege('app_service', 'private.has_verified_factor()', 'execute')
    and not has_function_privilege('authenticated', 'private.has_verified_factor()', 'execute')
    and not has_function_privilege('anon', 'private.has_verified_factor()', 'execute')
    and not has_function_privilege('service_role', 'private.has_verified_factor()', 'execute')
    and not has_function_privilege('supabase_auth_admin', 'private.has_verified_factor()', 'execute'),
  'solo el servidor pregunta si quien actúa tiene un factor verificado');
select ok(
  not has_any_column_privilege('app_service', 'private.second_factor_attempts', 'select, insert, update')
    and not has_table_privilege('app_service', 'private.second_factor_attempts', 'delete')
    and not has_any_column_privilege('supabase_auth_admin', 'private.second_factor_attempts', 'select, insert, update')
    and not has_table_privilege('supabase_auth_admin', 'private.second_factor_attempts', 'delete')
    and not has_any_column_privilege('authenticated', 'private.second_factor_attempts', 'select, insert, update')
    and not has_any_column_privilege('anon', 'private.second_factor_attempts', 'select, insert, update')
    and not has_any_column_privilege('service_role', 'private.second_factor_attempts', 'select, insert, update'),
  'nadie tiene permisos sobre la tabla del freno: solo la toca el gancho');
select is_empty(
  'select * from private.schema_violations()',
  'private.schema_violations() sigue en cero');
-- Las columnas de Auth que se leen, para que un cambio de Supabase se note.
select has_column('auth', 'mfa_factors', 'user_id', 'auth.mfa_factors.user_id existe');
select has_column('auth', 'mfa_factors', 'status', 'auth.mfa_factors.status existe');

-- ---------------------------------------------------------------------------------------
-- El freno: se cuentan los fallos seguidos de cada factor.

select is(pruebas.intento('fac70000-0000-0000-0000-000000000001', false), 'continue',
  'el primer código equivocado sigue su curso: Auth dirá que no coincide');
select pruebas.intento('fac70000-0000-0000-0000-000000000001', false);
select pruebas.intento('fac70000-0000-0000-0000-000000000001', false);
select is(pruebas.intento('fac70000-0000-0000-0000-000000000001', false), 'continue',
  'y así hasta uno antes del límite (INTENTOS_ANTES_DE_FRENO es 5)');
select results_eq(
  $$select fallos, frenado from pruebas.freno('fac70000-0000-0000-0000-000000000001')$$,
  $$values (4, null::boolean)$$,
  'van cuatro fallos anotados, sin espera');
select is(pruebas.intento('fac70000-0000-0000-0000-000000000001', false), 'reject',
  'el fallo que llega al límite se rechaza: Auth cierra esa sesión');
select results_eq(
  $$select fallos, espera, frenado from pruebas.freno('fac70000-0000-0000-0000-000000000001')$$,
  $$values (5, interval '1 minute', true)$$,
  'y el factor queda frenado FRENO_ESPERA_BASE');
select is(pruebas.intento('fac70000-0000-0000-0000-000000000001', true), 'reject',
  'frenado, ni el código correcto pasa: adivinar no sirve mientras dure la espera');
select results_eq(
  $$select fallos, espera from pruebas.freno('fac70000-0000-0000-0000-000000000001')$$,
  $$values (5, interval '1 minute')$$,
  'y un intento hecho durante la espera no la alarga ni cuenta');
select is(pruebas.intento('fac70000-0000-0000-0000-000000000003', false), 'continue',
  'el freno es de cada factor: el de otra persona no se entera');

-- Pasa la espera. El siguiente fallo espera el doble, hasta el tope.
update private.second_factor_attempts set locked_until = clock_timestamp() - interval '1 second'
  where factor_id = 'fac70000-0000-0000-0000-000000000001';
select is(pruebas.intento('fac70000-0000-0000-0000-000000000001', false), 'reject',
  'pasada la espera, otro fallo vuelve a frenar');
select results_eq(
  $$select fallos, espera from pruebas.freno('fac70000-0000-0000-0000-000000000001')$$,
  $$values (6, interval '2 minutes')$$,
  'y la espera se duplica');
update private.second_factor_attempts set failed_count = 5000, locked_until = clock_timestamp() - interval '1 second'
  where factor_id = 'fac70000-0000-0000-0000-000000000001';
select is(pruebas.intento('fac70000-0000-0000-0000-000000000001', false), 'reject',
  'con muchos fallos acumulados sigue frenando, sin desbordarse');
select results_eq(
  $$select fallos, espera from pruebas.freno('fac70000-0000-0000-0000-000000000001')$$,
  $$values (5001, interval '15 minutes')$$,
  'y la espera no pasa de FRENO_ESPERA_TOPE');

-- El código correcto, ya sin espera, borra la cuenta.
update private.second_factor_attempts set locked_until = clock_timestamp() - interval '1 second'
  where factor_id = 'fac70000-0000-0000-0000-000000000001';
select is(pruebas.intento('fac70000-0000-0000-0000-000000000001', true), 'continue',
  'pasada la espera, el código correcto entra');
select is_empty(
  $$select 1 from private.second_factor_attempts where factor_id = 'fac70000-0000-0000-0000-000000000001'$$,
  'y los fallos de ese factor se olvidan');
select is(pruebas.intento('fac70000-0000-0000-0000-000000000001', true), 'continue',
  'un código correcto sin fallos previos no deja nada anotado');
select is_empty(
  $$select 1 from private.second_factor_attempts where factor_id = 'fac70000-0000-0000-0000-000000000001'$$,
  'ni una fila');

-- Los fallos viejos se olvidan solos.
select pruebas.intento('fac70000-0000-0000-0000-000000000001', false);
select pruebas.intento('fac70000-0000-0000-0000-000000000001', false);
update private.second_factor_attempts set last_failed_at = clock_timestamp() - interval '61 minutes'
  where factor_id = 'fac70000-0000-0000-0000-000000000001';
select is(pruebas.intento('fac70000-0000-0000-0000-000000000001', false), 'continue',
  'un fallo después de FRENO_OLVIDO sin fallar empieza la cuenta de nuevo');
select is(
  (select fallos from pruebas.freno('fac70000-0000-0000-0000-000000000001')),
  1, 'desde uno');

-- La espera manda también sobre el olvido: una que sigue viva frena aunque el último fallo
-- sea viejo. Con los parámetros de hoy no puede pasar (la espera más larga dura menos que
-- el olvido), pero son parámetros, y cambian.
update private.second_factor_attempts
  set failed_count = 9, last_failed_at = clock_timestamp() - interval '61 minutes',
      locked_until = clock_timestamp() + interval '5 minutes'
  where factor_id = 'fac70000-0000-0000-0000-000000000001';
select is(pruebas.intento('fac70000-0000-0000-0000-000000000001', true), 'reject',
  'una espera viva frena aunque los fallos ya sean viejos');
select is(
  (select fallos from pruebas.freno('fac70000-0000-0000-0000-000000000001')),
  9, 'y no borra nada');

-- Lo que no se entiende no pasa: el gancho falla cerrado.
select is(
  private.second_factor_attempt('{"valid": true, "factor_type": "totp"}'::jsonb) ->> 'decision',
  'reject', 'un intento sin factor se rechaza');
select is(
  private.second_factor_attempt('{"factor_id": "no-es-un-identificador", "valid": true}'::jsonb) ->> 'decision',
  'reject', 'y uno con un factor que no tiene forma de serlo, también');
select is(
  private.second_factor_attempt(jsonb_build_object('factor_id', 'fac70000-0000-0000-0000-000000000003')) ->> 'decision',
  'continue', 'un intento que no dice si acertó cuenta como fallo');
select is(
  (select fallos from pruebas.freno('fac70000-0000-0000-0000-000000000003')),
  2, 'y se suma a los de ese factor');

-- ---------------------------------------------------------------------------------------
-- ¿Quien actúa tiene un factor verificado?

select pruebas.como_servicio('e0000000-0000-0000-0000-000000000001');
select is(private.has_verified_factor(), true, 'con un factor verificado: sí');
select pruebas.como_servicio('e0000000-0000-0000-0000-000000000003');
select is(private.has_verified_factor(), false, 'con uno que quedó a medias: no');
select pruebas.como_servicio('e0000000-0000-0000-0000-000000000002');
select is(private.has_verified_factor(), false, 'sin ninguno: no, aunque otra cuenta lo tenga');

select pruebas.limpiar();
select * from finish();
rollback;
