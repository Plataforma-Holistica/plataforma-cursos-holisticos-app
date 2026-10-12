-- T-104 · Cambiar la contraseña desde la cuenta (RF-109). TRD §9.2, esquema §6.2; FL-27, paso 3.
-- Cuando una persona con sesión cambia su contraseña, la aplicación fecha el cambio y borra
-- todo lo que tenía anotado de esa cuenta: una entrada que empezó con la contraseña de antes
-- ya no se puede anotar. A diferencia de reclamar una cuenta, esto nunca apaga la marca de
-- contraseña ni crea la fecha de una cuenta que no la tiene.
begin;
\ir _ayuda.psql
select plan(27);

select pruebas.alta('d0000000-0000-0000-0000-000000000001', 'alumna-contrasena@prueba.test');
select pruebas.alta('d0000000-0000-0000-0000-000000000002', 'otra-contrasena@prueba.test');
select pruebas.alta('d0000000-0000-0000-0000-000000000003', 'sin-reclamar-contrasena@prueba.test');
select pruebas.alta('d0000000-0000-0000-0000-000000000004', 'marcada-contrasena@prueba.test');
select pruebas.confirmar(id) from public.profiles where id::text like 'd0000000-0000-0000-0000-00000000000_';

-- Las dos primeras reclaman su cuenta, como quien fijó su contraseña desde su buzón.
select pruebas.como_servicio('d0000000-0000-0000-0000-000000000001');
select is(private.claim_account(), 'claimed', 'la primera cuenta queda reclamada');
select pruebas.como_servicio('d0000000-0000-0000-0000-000000000002');
select is(private.claim_account(), 'claimed', 'y la segunda');

-- La cuarta no se reclamó, pero tiene fecha: no debería existir, y se arma como dueño.
select pruebas.como_dueno();
insert into private.account_security (profile_id, password_changed_at)
  values ('d0000000-0000-0000-0000-000000000004', now() - interval '1 day');

insert into auth.sessions (id, user_id, created_at, updated_at, not_after) values
  ('5e570000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', now(), now(), null),
  ('5e570000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', now(), now(), null),
  ('5e570000-0000-0000-0000-000000000011', 'd0000000-0000-0000-0000-000000000002', now(), now(), null);
insert into private.app_sessions (session_id, profile_id) values
  ('5e570000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001'),
  ('5e570000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001'),
  ('5e570000-0000-0000-0000-000000000011', 'd0000000-0000-0000-0000-000000000002'),
  ('5e570000-0000-0000-0000-000000000041', 'd0000000-0000-0000-0000-000000000004');

-- ---------------------------------------------------------------------------------------
-- Estructura.

select ok(
  has_function_privilege('app_service', 'private.note_password_change()', 'execute')
    and not has_function_privilege('authenticated', 'private.note_password_change()', 'execute')
    and not has_function_privilege('anon', 'private.note_password_change()', 'execute')
    and not has_function_privilege('service_role', 'private.note_password_change()', 'execute'),
  'solo el servidor ejecuta private.note_password_change()');
select is_empty(
  'select * from private.schema_violations()',
  'private.schema_violations() sigue en cero');

-- ---------------------------------------------------------------------------------------
-- Quién no puede.

select pruebas.como_servicio();
select is(private.note_password_change(), 'ineligible', 'sin actor declarado no se fecha nada');
select pruebas.como_servicio('d0000000-0000-0000-0000-000000000003');
select is(private.note_password_change(), 'unclaimed', 'una cuenta que nunca fijó su contraseña desde su buzón no tiene fecha que mover');
select pruebas.como_dueno();
select is(
  (select count(*)::int from private.account_security where profile_id = 'd0000000-0000-0000-0000-000000000003'),
  0, 'y no se le crea una: sin fecha, esa cuenta sigue sin poder anotar sesiones');
select is(
  (select count(*)::int from private.app_sessions),
  4, 'ninguna de esas dos negativas borró nada');

-- ---------------------------------------------------------------------------------------
-- Fechar el cambio.

select password_changed_at as antes from private.account_security
  where profile_id = 'd0000000-0000-0000-0000-000000000001' \gset
select password_changed_at as antes_otra from private.account_security
  where profile_id = 'd0000000-0000-0000-0000-000000000002' \gset
-- Una entrada que empieza ahora, con la contraseña de antes todavía sin cambiar.
select clock_timestamp() as intento_viejo \gset

select pruebas.como_servicio('d0000000-0000-0000-0000-000000000001');
select is(private.note_password_change(), 'noted', 'la cuenta de quien actúa queda fechada');
select pruebas.como_dueno();
select ok(
  (select password_changed_at > :'antes'::timestamptz and password_changed_at > :'intento_viejo'::timestamptz
   from private.account_security where profile_id = 'd0000000-0000-0000-0000-000000000001'),
  'la fecha del cambio avanzó, con el reloj de la base y no con el del inicio de la transacción');
select is(
  (select count(*)::int from private.app_sessions where profile_id = 'd0000000-0000-0000-0000-000000000001'),
  0, 'y todo lo que tenía anotado se borró');
select is(
  (select count(*)::int from auth.sessions where user_id = 'd0000000-0000-0000-0000-000000000001'),
  2, 'las sesiones de Auth no se tocan aquí: esas las cierra Auth al cambiar la contraseña');
select ok(
  (select password_changed_at = :'antes_otra'::timestamptz from private.account_security
   where profile_id = 'd0000000-0000-0000-0000-000000000002'),
  'la fecha de la otra cuenta no se mueve');
select is(
  (select count(*)::int from private.app_sessions where profile_id = 'd0000000-0000-0000-0000-000000000002'),
  1, 'ni lo que tiene anotado');
select is(
  (select password_reset_required from public.profiles where id = 'd0000000-0000-0000-0000-000000000001'),
  false, 'la marca de contraseña de una cuenta reclamada sigue apagada');

-- Lo que la fecha consigue: la entrada que empezó antes del cambio ya no se anota, y una
-- que empieza después, sí.
select pruebas.como_servicio('d0000000-0000-0000-0000-000000000001');
select is(
  private.session_recognized('5e570000-0000-0000-0000-000000000001'),
  'not_noted', 'la sesión anotada antes deja de reconocerse');
select is(
  private.note_session('5e570000-0000-0000-0000-000000000002', :'intento_viejo'::timestamptz),
  'stale', 'una entrada que empezó antes del cambio no se anota: Auth la aceptó con una contraseña que ya no vale');
select is(
  private.note_session('5e570000-0000-0000-0000-000000000002', clock_timestamp()),
  'noted', 'una que empieza después, sí');
select is(private.note_password_change(), 'noted', 'se puede volver a fechar');
select pruebas.como_dueno();
select is(
  (select count(*)::int from private.app_sessions where profile_id = 'd0000000-0000-0000-0000-000000000001'),
  0, 'y vuelve a borrar lo anotado');

-- ---------------------------------------------------------------------------------------
-- Nunca apaga la marca de contraseña: eso es solo de quien abre un enlace de su buzón.

select pruebas.como_servicio('d0000000-0000-0000-0000-000000000004');
select is(private.note_password_change(), 'noted', 'una cuenta con la marca prendida y con fecha: se fecha y se limpia');
select pruebas.como_dueno();
select is(
  (select password_reset_required from public.profiles where id = 'd0000000-0000-0000-0000-000000000004'),
  true, 'pero su marca sigue prendida: cambiar la contraseña desde la cuenta no reclama nada');
select is(
  (select count(*)::int from private.app_sessions where profile_id = 'd0000000-0000-0000-0000-000000000004'),
  0, 'y lo que tenía anotado, que no debía existir, se fue');
select pruebas.como_servicio('d0000000-0000-0000-0000-000000000004');
select is(
  private.note_session('5e570000-0000-0000-0000-000000000041', clock_timestamp()),
  'unclaimed', 'así que sigue sin poder anotar sesiones');

-- ---------------------------------------------------------------------------------------
-- Nadie más la llama ni toca la tabla.

select pruebas.como_usuario('d0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$select private.note_password_change()$$,
  '42501', null, 'una persona no fecha su cambio de contraseña con su sesión');
select pruebas.como_servicio('d0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$update private.account_security set password_changed_at = now() - interval '1 year'$$,
  '42501', null, 'el servidor no mueve la fecha escribiendo la tabla');
select throws_ok(
  $$delete from private.account_security$$,
  '42501', null, 'ni la borra');

select pruebas.limpiar();
select * from finish();
rollback;
