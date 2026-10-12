-- T-105 · El segundo factor en Auth (RF-106). TRD §9.2, fila «Segundo factor»; esquema §6.2.
-- Primera entrega de T-105.
--
-- Dos cosas. El freno de los códigos del segundo factor, que vive en un gancho de Supabase
-- Auth: Auth le pregunta a esta función antes de dar por buena o por mala cada verificación,
-- venga de la aplicación o de quien llame directo a Auth. Y saber si quien actúa tiene un
-- factor verificado, que es lo que decide cómo cambia su contraseña.
begin;
\ir _ayuda.psql
select plan(59);

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
  'el fallo que llega al límite se rechaza: Auth cierra las sesiones de esa cuenta');
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
select is(
  private.second_factor_attempt(jsonb_build_object(
    'factor_id', 'fac70000-0000-0000-0000-000000000003', 'valid', 'true')) ->> 'decision',
  'continue', 'un acierto es el booleano de JSON: un texto que diga «true» sigue su curso');
select is(
  (select fallos from pruebas.freno('fac70000-0000-0000-0000-000000000003')),
  3, 'pero como un fallo más');

-- El mismo factor escrito en mayúsculas es el mismo factor: misma cuenta y mismo candado.
-- Con un candado propio, dos intentos a la vez del mismo factor se pisarían la cuenta.
create function pruebas.candados() returns int
language sql
as $$
  select count(*)::int from pg_catalog.pg_locks l
  where l.locktype = 'advisory' and l.pid = pg_catalog.pg_backend_pid() and l.granted;
$$;
select set_config('pruebas.candados', pruebas.candados()::text, true);
select is(
  private.second_factor_attempt(jsonb_build_object(
    'factor_id', 'FAC70000-0000-0000-0000-000000000003', 'valid', false)) ->> 'decision',
  'continue', 'un factor escrito en mayúsculas se atiende');
select is(
  (select fallos from pruebas.freno('fac70000-0000-0000-0000-000000000003')),
  4, 'y es el mismo factor: se suma a su cuenta');
select is(
  pruebas.candados(), current_setting('pruebas.candados')::int,
  'con el mismo candado, no con uno propio');

-- ---------------------------------------------------------------------------------------
-- ¿Quien actúa tiene un factor verificado?

select pruebas.como_servicio('e0000000-0000-0000-0000-000000000001');
select is(private.has_verified_factor(), true, 'con un factor verificado: sí');
select pruebas.como_servicio('e0000000-0000-0000-0000-000000000003');
select is(private.has_verified_factor(), false, 'con uno que quedó a medias: no');
select pruebas.como_servicio('e0000000-0000-0000-0000-000000000002');
select is(private.has_verified_factor(), false, 'sin ninguno: no, aunque otra cuenta lo tenga');

-- ---------------------------------------------------------------------------------------
-- Sin sus parámetros el gancho no se queda sin freno: rechaza todo. Va al final porque
-- cambia, dentro de esta transacción, de dónde salen los parámetros.

select pruebas.como_dueno();
create table pruebas.parametro_falso (key text primary key, value jsonb);
create or replace function private.parameter_value(p_key text, p_at timestamptz default now()) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case
    when exists (select 1 from pruebas.parametro_falso f where f.key = p_key)
      then (select f.value from pruebas.parametro_falso f where f.key = p_key)
    else (select b.value from public.business_parameters b
          where b.key = p_key and b.effective_from <= p_at and b.canceled_at is null
          order by b.effective_from desc limit 1)
  end
$$;

-- Qué decide el gancho con un parámetro cambiado (nulo: falta), ante el código correcto de
-- un factor sin fallos: lo que con sus parámetros en orden siempre pasa.
create function pruebas.con_parametro(p_key text, p_value jsonb) returns text
language plpgsql
as $$
declare
  v_decision text;
begin
  insert into pruebas.parametro_falso values (p_key, p_value);
  v_decision := private.second_factor_attempt(jsonb_build_object(
    'factor_id', 'fac70000-0000-0000-0000-000000000002', 'valid', true)) ->> 'decision';
  delete from pruebas.parametro_falso;
  return v_decision;
end
$$;

-- Cada rechazo por configuración deja un aviso en el registro de la base. Aquí serían una
-- docena de renglones de ruido en la salida de las pruebas: se callan hasta el final.
set local client_min_messages to error;

select is(pruebas.con_parametro('INTENTOS_ANTES_DE_FRENO', null), 'reject',
  'sin INTENTOS_ANTES_DE_FRENO no pasa nadie, ni con el código correcto');
select is(pruebas.con_parametro('FRENO_ESPERA_BASE', null), 'reject', 'sin FRENO_ESPERA_BASE, tampoco');
select is(pruebas.con_parametro('FRENO_ESPERA_TOPE', null), 'reject', 'sin FRENO_ESPERA_TOPE, tampoco');
select is(pruebas.con_parametro('FRENO_OLVIDO', null), 'reject', 'sin FRENO_OLVIDO, tampoco');
select is(pruebas.con_parametro('FRENO_ESPERA_BASE', '0'), 'reject', 'un parámetro en cero no sirve');
select is(pruebas.con_parametro('FRENO_ESPERA_BASE', '-1'), 'reject', 'ni uno negativo');
select is(pruebas.con_parametro('FRENO_ESPERA_BASE', '1.5'), 'reject', 'ni uno con decimales');
select is(pruebas.con_parametro('FRENO_ESPERA_BASE', '"1"'), 'reject', 'ni un texto, aunque diga un número');
select is(pruebas.con_parametro('FRENO_ESPERA_BASE', 'null'), 'reject', 'ni el nulo de JSON');
select is(pruebas.con_parametro('FRENO_ESPERA_BASE', 'true'), 'reject', 'ni un booleano');
select is(pruebas.con_parametro('FRENO_ESPERA_BASE', '[5]'), 'reject', 'ni una lista');
select is(pruebas.con_parametro('FRENO_OLVIDO', '9999999999999999999999'), 'reject',
  'ni uno que no cabe en ningún entero: se rechaza, no se lanza');
select is(pruebas.con_parametro('FRENO_OLVIDO', '2147483648'), 'reject', 'tampoco por uno');
-- De uno en adelante vale cualquier entero, que es lo que acepta quien guarda los
-- parámetros: un máximo propio de esta función dejaría al equipo sin entrar con un valor
-- que la pantalla de parámetros habría aceptado.
select is(pruebas.con_parametro('FRENO_OLVIDO', '2147483647'), 'continue', 'el entero más grande, sí');
select is(pruebas.con_parametro('INTENTOS_ANTES_DE_FRENO', '1'), 'continue', 'y uno, también');
select is_empty(
  $$select 1 from private.second_factor_attempts where factor_id = 'fac70000-0000-0000-0000-000000000002'$$,
  'y nada de eso deja una fila');

-- Rechazar por configuración no se confunde con el freno: lleva su propio mensaje.
insert into pruebas.parametro_falso values ('FRENO_OLVIDO', null);
select is(
  private.second_factor_attempt(jsonb_build_object(
    'factor_id', 'fac70000-0000-0000-0000-000000000002', 'valid', true)) ->> 'message',
  'Second factor verification is not available.',
  'cuando rechaza por sus parámetros lo dice con otro mensaje que cuando frena');
delete from pruebas.parametro_falso;

-- Con las tres esperas en el entero más grande nada se desborda: ni la espera, ni
-- duplicarla, ni mirar si los fallos ya son viejos.
insert into pruebas.parametro_falso values
  ('INTENTOS_ANTES_DE_FRENO', '1'), ('FRENO_ESPERA_BASE', '2147483647'),
  ('FRENO_ESPERA_TOPE', '2147483647'), ('FRENO_OLVIDO', '2147483647');
select is(pruebas.intento('fac70000-0000-0000-0000-000000000002', false), 'reject',
  'con las esperas en el entero más grande, el primer fallo frena');
update private.second_factor_attempts set locked_until = clock_timestamp() - interval '1 second'
  where factor_id = 'fac70000-0000-0000-0000-000000000002';
select is(pruebas.intento('fac70000-0000-0000-0000-000000000002', false), 'reject',
  'y el siguiente también, sin desbordarse');
select results_eq(
  $$select fallos, espera from pruebas.freno('fac70000-0000-0000-0000-000000000002')$$,
  $$values (2, make_interval(mins => 2147483647))$$,
  'con la espera en su tope');

select pruebas.limpiar();
select * from finish();
rollback;
