-- T-105 · Restablecer por la versión de la persona (RF-712, PA-86). TRD §9.2, fila
-- «Invitaciones»; esquema §6.2. Sale de lo que la quinta entrega dejó abierto.
--
-- Restablecer un segundo factor no tiene tope de repetición, y un formulario reenviado (un
-- doble clic sin JavaScript, o recargar) lo haría otra vez y mataría el código ya dictado.
-- Antes lo impedía un testigo en una cookie, que no era un candado. Ahora el botón de
-- confirmar lleva la versión de la persona, y private.reset_second_factor() la compara
-- dentro del candado del equipo: si ya no es esa, no hace nada.
--
-- La versión son dos contadores sobre las invitaciones de esa persona en cualquier estado:
-- cuántas hay y cuántas se aceptaron. Solo crecen, porque nada borra invitaciones ni deshace
-- una aceptación: no dependen del reloj ni empatan.
begin;
\ir _ayuda.psql
select plan(43);

select pruebas.alta('c0000000-0000-0000-0000-000000000001', 'config1@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000002', 'config2@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000003', 'config3@prueba.test');
select pruebas.alta('d0000000-0000-0000-0000-000000000001', 'dora@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%@prueba.test';
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000002', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000003', 'config');
select pruebas.dar_capacidad('d0000000-0000-0000-0000-000000000001', 'support');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select pruebas.equipar('c0000000-0000-0000-0000-000000000002');
select pruebas.equipar('c0000000-0000-0000-0000-000000000003');
select pruebas.equipar('d0000000-0000-0000-0000-000000000001');

-- Cuántos renglones hay en la auditoría, para ver que una respuesta no escribió nada.
create table pruebas.renglones (n bigint);
create function pruebas.anotar_renglones() returns void
language sql
as $$ delete from pruebas.renglones; insert into pruebas.renglones select count(*) from public.audit_log; $$;
create function pruebas.renglones_iguales() returns boolean
language sql
as $$ select (select count(*) from public.audit_log) = (select n from pruebas.renglones) $$;

-- ---------------------------------------------------------------------------------------
-- Las funciones y sus permisos.

select has_function('private', 'reset_version', array['uuid'], 'existe la versión de una persona');
select has_function('private', 'reset_second_factor', array['uuid', 'text', 'text'],
  'restablecer recibe la versión que se confirmó');
select is(
  (select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname = 'reset_second_factor'),
  1, 'restablecer tiene una sola firma: la de dos argumentos ya no existe');
select ok(
  has_function_privilege('app_service', 'private.reset_second_factor(uuid, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'private.reset_second_factor(uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'private.reset_second_factor(uuid, text, text)', 'execute')
  and not has_function_privilege('service_role', 'private.reset_second_factor(uuid, text, text)', 'execute'),
  'restablecer lo ejecuta solo el servidor');
select ok(
  not has_function_privilege('app_service', 'private.reset_version(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.reset_version(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.reset_version(uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.reset_version(uuid)', 'execute'),
  'la versión es interna: no la ejecuta nadie más que el dueño');
-- Que restablecer sea volátil es lo que hace que la comparación, que va después del candado,
-- vea lo que confirmó el envío que lo tenía. Marcada estable, usaría la foto de antes.
select is((select p.provolatile::text from pg_proc p where p.oid = 'private.reset_second_factor(uuid, text, text)'::regprocedure),
  'v', 'restablecer es volátil');
select is((select p.provolatile::text || ' ' || p.prosecdef::text from pg_proc p where p.oid = 'private.reset_version(uuid)'::regprocedure),
  's true', 'la versión es una lectura, con los permisos de su dueño');
select is_empty('select * from private.schema_violations()', 'private.schema_violations() sigue en cero');

-- ---------------------------------------------------------------------------------------
-- Qué cambia la versión y qué no.

select is(pruebas.version('a0000000-0000-0000-0000-000000000001'), '0.0', 'sin invitaciones: 0.0');
select is(pruebas.version('c0000000-0000-0000-0000-000000000002'), '0.0',
  'tampoco quien entró al equipo sin invitación (como en estas pruebas)');
select is(pruebas.version(gen_random_uuid()), '0.0', 'una cuenta que no existe: 0.0');

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('ana@prueba.test', '{support,content}')$$),
  'invited_existing', '(se invita a una cuenta)');
select is(pruebas.version('a0000000-0000-0000-0000-000000000001'), '1.0', 'una invitación a la cuenta sube el primero');
select is(
  pruebas.pide('c0000000-0000-0000-0000-000000000001',
    format('private.revoke_admin_invitation(%L)', (pruebas.invitacion_viva('ana@prueba.test')).id)),
  'revoked', '(se revoca)');
select is(pruebas.version('a0000000-0000-0000-0000-000000000001'), '1.0', 'revocar no la cambia');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('ana@prueba.test', '{support,content}')$$),
  'invited_existing', '(se invita otra vez)');
select is(pruebas.version('a0000000-0000-0000-0000-000000000001'), '2.0', 'otra invitación la sube');
select is(pruebas.version('c0000000-0000-0000-0000-000000000002'), '0.0', 'la de otra persona no cuenta');

select pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana'));
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'accepted', '(acepta)');
select is(pruebas.version('a0000000-0000-0000-0000-000000000001'), '2.1', 'aceptar sube el segundo');

select pruebas.equipar('a0000000-0000-0000-0000-000000000001');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.grant_capability('a0000000-0000-0000-0000-000000000001', 'finance')$$),
  'granted', '(se le da una capacidad)');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('a0000000-0000-0000-0000-000000000001', 'finance')$$),
  'revoked', '(y se le quita, sin ser su última)');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('ana@prueba.test', '{moderation}')$$),
  'already_member', '(invitarla, ya del equipo, no inserta nada)');
select is(pruebas.version('a0000000-0000-0000-0000-000000000001'), '2.1',
  'dar, quitar una que no es la última, e invitar a quien ya es del equipo no la cambian');

-- ---------------------------------------------------------------------------------------
-- Restablecer con la versión.

-- La puerta y «a sí misma» van antes que la versión: lo que contestan no depende de ella.
select is(pruebas.pide('d0000000-0000-0000-0000-000000000001',
  $$private.reset_second_factor('a0000000-0000-0000-0000-000000000001', pruebas.huella('k'), 'no-es-una-version')$$),
  'forbidden', 'sin configuración: forbidden, sea cual sea la versión');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
  $$private.reset_second_factor('c0000000-0000-0000-0000-000000000001', pruebas.huella('k'), 'no-es-una-version')$$),
  'self', 'a sí misma: self, sea cual sea la versión');

select pruebas.anotar_renglones();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
  $$private.reset_second_factor('a0000000-0000-0000-0000-000000000001', pruebas.huella('k'), '2.0')$$),
  'changed', 'con una versión vieja y nada pendiente: changed');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
  $$private.reset_second_factor('a0000000-0000-0000-0000-000000000001', pruebas.huella('k'), null)$$),
  'changed', 'sin versión: changed');
select ok(pruebas.renglones_iguales(), 'y ninguna de las dos escribió nada');
select is((select count(*)::int from private.admin_factors where profile_id = 'a0000000-0000-0000-0000-000000000001'), 1,
  'conserva su atadura');

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
  $$private.reset_second_factor('a0000000-0000-0000-0000-000000000001', pruebas.huella('clave-1'), pruebas.version('a0000000-0000-0000-0000-000000000001'))$$),
  'reset', 'con la versión de ahora, restablece');
select is(pruebas.version('a0000000-0000-0000-0000-000000000001'), '3.1', 'y la versión sube');

-- El mismo formulario otra vez: el doble clic, o recargar.
select pruebas.anotar_renglones();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
  $$private.reset_second_factor('a0000000-0000-0000-0000-000000000001', pruebas.huella('clave-2'), '2.1')$$),
  'already_sent', 'la misma persona otra vez con la versión de antes: already_sent');
select ok(pruebas.renglones_iguales(), 'sin escribir nada');
select is((pruebas.invitacion_viva('ana@prueba.test')).handoff, pruebas.huella('clave-1'),
  'el código que ya se dictó sigue siendo el que vale');

-- Otra persona con configuración, con la página de antes: tiene que ver la confirmación
-- nueva, que avisa que el código anterior deja de servir. «Ya se envió» la llevaría a
-- restablecer otra vez sin ese aviso.
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003',
  $$private.reset_second_factor('a0000000-0000-0000-0000-000000000001', pruebas.huella('clave-3'), '2.1')$$),
  'changed', 'otra persona, con la versión de antes: changed');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003',
  $$private.reset_second_factor('a0000000-0000-0000-0000-000000000001', pruebas.huella('clave-3'), '3.1')$$),
  'reset', 'con la de ahora, restablece otra vez');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
  $$private.reset_second_factor('a0000000-0000-0000-0000-000000000001', pruebas.huella('clave-4'), '3.1')$$),
  'changed', 'y quien restableció primero, con su versión, ya no: lo pendiente es de otra persona');

-- Lo pendiente revocado: ya no hay nada que «ya se envió».
select is(
  pruebas.pide('c0000000-0000-0000-0000-000000000003',
    format('private.revoke_admin_invitation(%L)', (pruebas.invitacion_viva('ana@prueba.test')).id)),
  'revoked', '(se revoca su invitación para volver)');
select is(pruebas.version('a0000000-0000-0000-0000-000000000001'), '4.1', 'revocarla no cambia la versión');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003',
  $$private.reset_second_factor('a0000000-0000-0000-0000-000000000001', pruebas.huella('clave-5'), '3.1')$$),
  'changed', 'sin nada pendiente, la versión vieja contesta changed aunque el restablecimiento haya sido suyo');

-- Una invitación viva cuenta aunque haya caducado: es lo que la base llama «viva».
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003',
  $$private.reset_second_factor('a0000000-0000-0000-0000-000000000001', pruebas.huella('clave-6'), '4.1')$$),
  'reset', '(se restablece otra vez)');
select pruebas.como_dueno_sistema();
update private.admin_invitations set created_at = created_at - interval '30 days', expires_at = clock_timestamp() - interval '1 second'
  where profile_id = 'a0000000-0000-0000-0000-000000000001' and accepted_at is null and revoked_at is null;
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003',
  $$private.reset_second_factor('a0000000-0000-0000-0000-000000000001', pruebas.huella('clave-7'), '4.1')$$),
  'already_sent', 'con la invitación pendiente caducada, sigue siendo already_sent');

select * from finish();
rollback;
