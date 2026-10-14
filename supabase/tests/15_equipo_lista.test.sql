-- T-105 · La lista del equipo (RF-712, PA-86). TRD §9.2, fila «Invitaciones»; esquema §6.2.
-- Quinta entrega de T-105.
--
-- La pantalla del equipo necesita ver a quién administra: las personas con alguna
-- capacidad, las invitaciones vivas y si quien mira dio su código hace poco. El servidor no
-- puede leer las ataduras, las invitaciones ni el correo de una cuenta (el vigilante lo
-- exige), así que lo contesta una función, private.team_roster(), y solo a quien pasa la
-- puerta del equipo con configuración. A los demás les devuelve nulo: «no pasas» no se
-- confunde con «no hay nadie».
--
-- Lo que dice de cada invitación tiene que coincidir con private.team_standing(): una que
-- aceptar revocaría no se pinta como pendiente. Y lo que dice de quitar configuración, con
-- private.revoke_capability().
begin;
\ir _ayuda.psql
select plan(119);

select pruebas.alta('c0000000-0000-0000-0000-000000000001', 'config1@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000002', 'config2@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000003', 'config3@prueba.test');
select pruebas.alta('d0000000-0000-0000-0000-000000000001', 'dora@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%@prueba.test';
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'support');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000002', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000003', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000003', 'support');
select pruebas.dar_capacidad('d0000000-0000-0000-0000-000000000001', 'support');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select pruebas.equipar('c0000000-0000-0000-0000-000000000002');
select pruebas.equipar('c0000000-0000-0000-0000-000000000003');
select pruebas.equipar('d0000000-0000-0000-0000-000000000001');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000002');

-- La lista, como la ve una persona con su sesión de pruebas. Sin repararle nada.
create function pruebas.lista(p_id uuid, p_session uuid default null) returns jsonb
language plpgsql
as $$
declare
  v_roster jsonb;
begin
  perform pruebas.a_nombre_de(p_id, p_session);
  v_roster := private.team_roster();
  perform pruebas.limpiar();
  return v_roster;
end
$$;

-- Una persona de la lista y una invitación, por su correo, vistas por quien pregunta.
create function pruebas.persona(p_actor uuid, p_email text) returns jsonb
language sql
as $$
  select m from jsonb_array_elements(pruebas.lista(p_actor) -> 'members') as m where m ->> 'email' = p_email
$$;

create function pruebas.pendiente(p_actor uuid, p_email text) returns jsonb
language sql
as $$
  select i from jsonb_array_elements(pruebas.lista(p_actor) -> 'invitations') as i where i ->> 'email' = p_email
$$;

-- El estado que private.team_standing() le da a una persona, para comparar.
create function pruebas.estado(p_id uuid, p_ticket text default null) returns text
language plpgsql
as $$
declare
  v_state text;
begin
  perform pruebas.a_nombre_de(p_id);
  select t.state into v_state from private.team_standing(p_ticket) as t;
  perform pruebas.limpiar();
  return v_state;
end
$$;
grant execute on function pruebas.lista(uuid, uuid), pruebas.persona(uuid, text),
  pruebas.pendiente(uuid, text), pruebas.estado(uuid, text) to app_service;

-- ---------------------------------------------------------------------------------------
-- Permisos, y a quién no le contesta.

select ok(
  has_function_privilege('app_service', 'private.team_roster()', 'execute')
  and not has_function_privilege('authenticated', 'private.team_roster()', 'execute')
  and not has_function_privilege('anon', 'private.team_roster()', 'execute')
  and not has_function_privilege('service_role', 'private.team_roster()', 'execute'),
  'la lista la ejecuta solo el servidor');
select is(
  (select p.provolatile::text || ' ' || p.prosecdef::text from pg_proc p where p.oid = 'private.team_roster()'::regprocedure),
  's true', 'no puede escribir: es una lectura, con los permisos de su dueño');
select is_empty('select * from private.schema_violations()', 'private.schema_violations() sigue en cero');

select pruebas.como_sistema();
select is(private.team_roster(), null::jsonb, 'sin persona que actúe: nulo');
select pruebas.limpiar();
select is(pruebas.lista('a0000000-0000-0000-0000-000000000001'), null::jsonb, 'una cuenta común: nulo');
select is(pruebas.lista(gen_random_uuid()), null::jsonb, 'una cuenta que no existe: nulo');
select is(pruebas.tiene('d0000000-0000-0000-0000-000000000001', 'support'), true, '(alguien del equipo sin configuración pasa la puerta con lo suyo)');
select is(pruebas.lista('d0000000-0000-0000-0000-000000000001'), null::jsonb, 'y aun así no ve la lista: pide configuración');
select is(pruebas.lista('c0000000-0000-0000-0000-000000000001', gen_random_uuid()), null::jsonb,
  'con configuración y otra sesión: nulo');
select pruebas.sin_codigo('c0000000-0000-0000-0000-000000000001');
select is(pruebas.lista('c0000000-0000-0000-0000-000000000001'), null::jsonb, 'con la sesión en primer nivel: nulo');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '13 hours'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select is(pruebas.lista('c0000000-0000-0000-0000-000000000001'), null::jsonb, 'con el código de hace 13 horas: nulo');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select pruebas.suspender('c0000000-0000-0000-0000-000000000003');
select is(pruebas.tiene('c0000000-0000-0000-0000-000000000003', 'config'), pruebas.lista('c0000000-0000-0000-0000-000000000003') is not null,
  'una cuenta suspendida ve la lista solo si la puerta la deja pasar: es la misma puerta');
select is(pruebas.lista('c0000000-0000-0000-0000-000000000003'), null::jsonb, 'y no la deja: suspendida, nulo');
select pruebas.como_dueno_sistema();
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = 'c0000000-0000-0000-0000-000000000003';
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Lo que trae, y cada persona.

select is(
  (select array_agg(k order by k) from jsonb_object_keys(pruebas.lista('c0000000-0000-0000-0000-000000000001')) as k),
  array['fresh_code', 'invitations', 'members'],
  'a quien pasa con configuración: las personas, las invitaciones y si su código es reciente');
select is(
  pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config1@prueba.test'),
  jsonb_build_object(
    'profile_id', 'c0000000-0000-0000-0000-000000000001', 'email', 'config1@prueba.test', 'display_name', null,
    'status', 'active', 'capabilities', jsonb_build_array('config', 'support'), 'factor', 'bound',
    'rebind', 'none', 'config_removable', true, 'is_self', true),
  'quien mira: su correo, sus capacidades activas en orden, su factor atado, y que es ella');
select is(
  pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test'),
  jsonb_build_object(
    'profile_id', 'c0000000-0000-0000-0000-000000000002', 'email', 'config2@prueba.test', 'display_name', null,
    'status', 'active', 'capabilities', jsonb_build_array('config'), 'factor', 'bound',
    'rebind', 'none', 'config_removable', true, 'is_self', false),
  'otra persona con configuración: no es quien mira');
select is(
  pruebas.persona('c0000000-0000-0000-0000-000000000001', 'dora@prueba.test'),
  jsonb_build_object(
    'profile_id', 'd0000000-0000-0000-0000-000000000001', 'email', 'dora@prueba.test', 'display_name', null,
    'status', 'active', 'capabilities', jsonb_build_array('support'), 'factor', 'bound',
    'rebind', 'none', 'config_removable', false, 'is_self', false),
  'alguien sin configuración: no hay configuración que quitarle');
select is(
  (select array_agg(m ->> 'email' order by ord)
   from jsonb_array_elements(pruebas.lista('c0000000-0000-0000-0000-000000000001') -> 'members') with ordinality as t(m, ord)),
  array['config1@prueba.test', 'config2@prueba.test', 'config3@prueba.test', 'dora@prueba.test'],
  'solo quien tiene alguna capacidad, en orden de correo: las cuentas comunes no salen');
select is(
  (select array_agg(m ->> 'email') from jsonb_array_elements(pruebas.lista('c0000000-0000-0000-0000-000000000002') -> 'members') as m
   where (m ->> 'is_self')::boolean),
  array['config2@prueba.test'], 'quien mira es una sola, y es quien pregunta');
select is(pruebas.lista('c0000000-0000-0000-0000-000000000001') -> 'invitations', '[]'::jsonb, 'sin invitaciones: una lista vacía, no nulo');

select pruebas.como_dueno_sistema();
update public.profiles set display_name = 'Carla Dos' where id = 'c0000000-0000-0000-0000-000000000002';
select pruebas.limpiar();
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') ->> 'display_name', 'Carla Dos',
  'el nombre, si la persona lo escribió');
update auth.users set email = 'Config2@Prueba.test' where id = 'c0000000-0000-0000-0000-000000000002';
select ok(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') is not null,
  'el correo de cada persona sale en minúsculas, lo guarde Auth como lo guarde');
update auth.users set email = 'config2@prueba.test' where id = 'c0000000-0000-0000-0000-000000000002';

-- Dar y quitar se ven en la siguiente lectura.
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.grant_capability('d0000000-0000-0000-0000-000000000001', 'content')$$),
  'granted', '(se le da otra capacidad)');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'dora@prueba.test') -> 'capabilities', '["content", "support"]'::jsonb,
  'la capacidad recién dada sale');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('d0000000-0000-0000-0000-000000000001', 'support')$$),
  'revoked', '(se le quita una)');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'dora@prueba.test') -> 'capabilities', '["content"]'::jsonb,
  'la que se quitó ya no sale');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('d0000000-0000-0000-0000-000000000001', 'content')$$),
  'revoked', '(y la última)');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'dora@prueba.test'), null::jsonb,
  'quien perdió todas sus capacidades ya no es del equipo: no sale');

-- ---------------------------------------------------------------------------------------
-- Si su código es reciente. La lista se ve igual: leer no pide el código otra vez.

select is(pruebas.lista('c0000000-0000-0000-0000-000000000001') -> 'fresh_code', 'true'::jsonb, 'recién verificada: su código es reciente');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '16 minutes'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select is(pruebas.lista('c0000000-0000-0000-0000-000000000001') -> 'fresh_code', 'false'::jsonb,
  'con el código de hace 16 minutos ya no lo es, y la lista se sigue viendo');
select is(jsonb_array_length(pruebas.lista('c0000000-0000-0000-0000-000000000001') -> 'members'), 3, 'con todas sus personas');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('nadie@prueba.test', '{support}')$$),
  'needs_fresh_code', 'y dice lo mismo que la puerta de los cambios: invitar pediría el código');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '14 minutes'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select is(pruebas.lista('c0000000-0000-0000-0000-000000000001') -> 'fresh_code', 'true'::jsonb, 'con el de hace 14, sí');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------------------------------
-- A quién se le puede quitar configuración: lo mismo que contestaría quitarla.

select is(
  (select array_agg((m ->> 'config_removable')::boolean order by m ->> 'email')
   from jsonb_array_elements(pruebas.lista('c0000000-0000-0000-0000-000000000001') -> 'members') as m),
  array[true, true, true], 'con tres personas activas con configuración, a cualquiera se le puede quitar');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('c0000000-0000-0000-0000-000000000003', 'config')$$),
  'revoked', '(a la tercera se le quita)');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config3@prueba.test') -> 'capabilities', '["support"]'::jsonb,
  'sigue en el equipo con la otra capacidad que tenía');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') -> 'config_removable', 'false'::jsonb,
  'y ya no cuenta: quedan dos con configuración, y a ninguna se le puede quitar');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config3@prueba.test') -> 'config_removable', 'false'::jsonb,
  'a quien ya no la tiene no hay qué quitarle');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.grant_capability('c0000000-0000-0000-0000-000000000003', 'config')$$),
  'granted', '(se le devuelve)');
select pruebas.equipar('c0000000-0000-0000-0000-000000000003');
select pruebas.suspender('c0000000-0000-0000-0000-000000000003');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config3@prueba.test') ->> 'status', 'suspended',
  'una cuenta suspendida sale, y lo dice');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') -> 'config_removable', 'false'::jsonb,
  'con una suspendida quedan dos activas: a ninguna de las dos se le puede quitar');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config1@prueba.test') -> 'config_removable', 'false'::jsonb,
  'tampoco a quien mira');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config3@prueba.test') -> 'config_removable', 'true'::jsonb,
  'a la suspendida sí: sin ella quedan las otras dos');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('c0000000-0000-0000-0000-000000000002', 'config')$$),
  'min_config', 'y quitar contesta lo mismo: a una de las dos activas, no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('c0000000-0000-0000-0000-000000000003', 'config')$$),
  'revoked', 'y a la suspendida, sí');
select pruebas.como_dueno_sistema();
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = 'c0000000-0000-0000-0000-000000000003';
select pruebas.limpiar();
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000003', 'config');
select pruebas.equipar('c0000000-0000-0000-0000-000000000003');

-- ---------------------------------------------------------------------------------------
-- Las invitaciones vivas. Invita la primera persona y mira la tercera, para poder cambiarle
-- cosas a quien invitó.

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('ana@prueba.test', '{support,content}')$$),
  'invited_existing', '(se invita a una cuenta común)');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('nueva@prueba.test', '{finance}')$$),
  'invited_new', '(y a un correo sin cuenta)');
select pruebas.como_dueno_sistema();
select is(private.system_invite_admin('beto@prueba.test', '{config}'), 'invited_existing', '(y el dueño de la base, a otra)');
select pruebas.limpiar();

select is(
  pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') - 'created_at' - 'expires_at',
  jsonb_build_object(
    'id', (pruebas.invitacion_viva('ana@prueba.test')).id, 'kind', 'grant', 'email', 'ana@prueba.test',
    'profile_id', 'a0000000-0000-0000-0000-000000000001', 'capabilities', jsonb_build_array('support', 'content'),
    'invited_by', 'c0000000-0000-0000-0000-000000000001', 'expired', false, 'acceptable', true),
  'una invitación a una cuenta: a quién, qué da en el orden en que se pidió, quién invitó, y que se puede aceptar');
select ok(
  (pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') ->> 'created_at')::timestamptz
    = (pruebas.invitacion_viva('ana@prueba.test')).created_at
  and (pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') ->> 'expires_at')::timestamptz
    = (pruebas.invitacion_viva('ana@prueba.test')).expires_at,
  'con su hora y su caducidad, las de la tabla');
select is(
  pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'nueva@prueba.test') - 'created_at' - 'expires_at' - 'id',
  jsonb_build_object(
    'kind', 'grant', 'email', 'nueva@prueba.test', 'profile_id', null, 'capabilities', jsonb_build_array('finance'),
    'invited_by', 'c0000000-0000-0000-0000-000000000001', 'expired', false, 'acceptable', true),
  'una a un correo sin cuenta: sin cuenta, y espera a que se registre');
select is(
  pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'beto@prueba.test') -> 'invited_by', 'null'::jsonb,
  'la del arranque no tiene quién invitó');
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'beto@prueba.test') -> 'acceptable', 'true'::jsonb, 'y se puede aceptar');
select is(
  (select array_agg(i ->> 'email' order by ord)
   from jsonb_array_elements(pruebas.lista('c0000000-0000-0000-0000-000000000003') -> 'invitations') with ordinality as t(i, ord)),
  array['ana@prueba.test', 'nueva@prueba.test', 'beto@prueba.test'], 'en el orden en que se hicieron');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test'), null::jsonb,
  'una persona invitada todavía no es del equipo: no sale entre las personas');

-- Lo que dice de aceptar coincide con el estado que ve la persona invitada.
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana'));
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'invited', '(la invitada, con su resguardo, puede aceptar)');

-- Quien invitó tiene que seguir pudiendo.
select pruebas.suspender('c0000000-0000-0000-0000-000000000001');
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'acceptable', 'false'::jsonb,
  'si quien invitó está suspendida, ya no se puede aceptar');
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'expired', 'false'::jsonb, 'aunque no haya caducado');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none', 'y la invitada ve lo mismo: nada');
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'nueva@prueba.test') -> 'acceptable', 'false'::jsonb, 'vale para todas las que hizo');
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'beto@prueba.test') -> 'acceptable', 'true'::jsonb, 'y no para la del arranque');
select pruebas.como_dueno_sistema();
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = 'c0000000-0000-0000-0000-000000000001';
delete from private.admin_factors where profile_id = 'c0000000-0000-0000-0000-000000000001';
select pruebas.limpiar();
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'acceptable', 'false'::jsonb,
  'si quien invitó ya no tiene su factor atado, tampoco');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none', 'y la invitada ve lo mismo');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select pruebas.como_dueno_sistema();
update public.admin_capabilities set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000002'
  where profile_id = 'c0000000-0000-0000-0000-000000000001' and capability = 'config';
select pruebas.limpiar();
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'acceptable', 'false'::jsonb,
  'ni si ya no tiene configuración, aunque conserve otra capacidad');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none', 'y la invitada ve lo mismo');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'config');
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'acceptable', 'true'::jsonb,
  '(con quien invitó de vuelta en su lugar, se puede)');

-- La caducidad. Una caducada sigue viva hasta que alguien reinvita, y por eso sale.
select pruebas.como_dueno_sistema();
update private.admin_invitations set created_at = created_at - interval '3 hours', expires_at = clock_timestamp() - interval '1 second'
  where email = 'ana@prueba.test';
select pruebas.limpiar();
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'expired', 'true'::jsonb, 'una caducada sale, y lo dice');
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'acceptable', 'false'::jsonb, 'y no se puede aceptar');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none', 'y la invitada ve lo mismo');
select pruebas.como_dueno_sistema();
update private.admin_invitations set expires_at = clock_timestamp() + interval '1 day' where email = 'ana@prueba.test';
select pruebas.limpiar();

-- La cuenta invitada tiene que ser la que aceptar tomaría.
select pruebas.como_dueno_sistema();
update private.admin_invitations set profile_id = 'd0000000-0000-0000-0000-000000000001' where email = 'ana@prueba.test';
select pruebas.limpiar();
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'acceptable', 'false'::jsonb,
  'si la invitación apunta a otra cuenta que la de ese correo, no');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none', 'y la invitada ve lo mismo');
select pruebas.como_dueno_sistema();
update private.admin_invitations set profile_id = 'a0000000-0000-0000-0000-000000000001' where email = 'ana@prueba.test';
select pruebas.limpiar();
update auth.users set email = 'ana2@prueba.test' where id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'acceptable', 'false'::jsonb,
  'si la cuenta invitada ya no tiene ese correo, no');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none', 'y la invitada ve lo mismo');
update auth.users set email = 'Ana@Prueba.test' where id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'acceptable', 'true'::jsonb,
  'el correo se compara sin mayúsculas, igual que al aceptar');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'invited', 'y la invitada ve lo mismo');
update auth.users set email = 'ana@prueba.test', is_sso_user = true where id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'acceptable', 'false'::jsonb,
  'ni si pasó a ser de acceso federado');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none', 'y la invitada ve lo mismo');
update auth.users set is_sso_user = false where id = 'a0000000-0000-0000-0000-000000000001';
select pruebas.dar_capacidad('a0000000-0000-0000-0000-000000000001', 'moderation');
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'acceptable', 'false'::jsonb,
  'una que da capacidades no le sirve a quien ya tiene alguna');
select is(
  pruebas.persona('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') - 'profile_id' - 'email' - 'display_name',
  jsonb_build_object('status', 'active', 'capabilities', jsonb_build_array('moderation'), 'factor', 'none',
                     'rebind', 'none', 'config_removable', false, 'is_self', false),
  'y quien tiene una capacidad sin factor atado sale entre las personas: sin factor, y sin invitación para volver');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'unbound', 'que es lo que ella ve: que la restablezcan');
select pruebas.como_dueno_sistema();
update public.admin_capabilities set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000001'
  where profile_id = 'a0000000-0000-0000-0000-000000000001';
insert into private.admin_factors (profile_id, factor_id, bound_email)
values ('a0000000-0000-0000-0000-000000000001', gen_random_uuid(), 'ana@prueba.test');
select pruebas.limpiar();
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'acceptable', 'false'::jsonb,
  'ni a quien conserva una atadura');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none', 'y la invitada ve lo mismo');
select pruebas.como_dueno_sistema();
delete from private.admin_factors where profile_id = 'a0000000-0000-0000-0000-000000000001';
select pruebas.limpiar();
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'ana@prueba.test') -> 'acceptable', 'true'::jsonb,
  '(con la invitada de vuelta en su lugar, se puede)');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'invited', 'y la invitada ve lo mismo');

-- Un correo sin cuenta que después se registra.
select pruebas.alta('a0000000-0000-0000-0000-000000000009', 'nueva@prueba.test');
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'nueva@prueba.test') -> 'acceptable', 'true'::jsonb,
  'cuando el correo invitado ya tiene cuenta, se sigue pudiendo');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000009'), 'invited_unproven',
  'y esa cuenta lo ve: tiene una invitación, y le falta probar su buzón');
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'nueva@prueba.test') -> 'profile_id', 'null'::jsonb,
  'y la invitación sigue sin apuntar a una cuenta: eso lo decide aceptar');

-- Aceptada o revocada, deja de salir.
select pruebas.reclamar('a0000000-0000-0000-0000-000000000002', pruebas.huella('beto'));
select pruebas.verificar('a0000000-0000-0000-0000-000000000002');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000002', pruebas.huella('beto')), 'accepted', '(la persona del arranque acepta)');
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'beto@prueba.test'), null::jsonb, 'una invitación aceptada ya no sale');
select is(
  pruebas.persona('c0000000-0000-0000-0000-000000000003', 'beto@prueba.test') - 'display_name',
  jsonb_build_object(
    'profile_id', 'a0000000-0000-0000-0000-000000000002', 'email', 'beto@prueba.test', 'status', 'active',
    'capabilities', jsonb_build_array('config'), 'factor', 'bound', 'rebind', 'none', 'config_removable', true, 'is_self', false),
  'y quien aceptó sale entre las personas, con lo que recibió y su factor atado');
select is(
  pruebas.pide('c0000000-0000-0000-0000-000000000003',
    format('private.revoke_admin_invitation(%L)', (pruebas.invitacion_viva('nueva@prueba.test')).id)),
  'revoked', '(se revoca otra)');
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000003', 'nueva@prueba.test'), null::jsonb, 'una revocada tampoco');
select is(jsonb_array_length(pruebas.lista('c0000000-0000-0000-0000-000000000003') -> 'invitations'), 1, 'queda la que sigue viva');

-- ---------------------------------------------------------------------------------------
-- Quien conserva capacidades y no tiene con qué entrar.

update auth.mfa_factors set status = 'unverified' where id = pruebas.factor('c0000000-0000-0000-0000-000000000002');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') ->> 'factor', 'lost',
  'si Auth ya no tiene verificado su factor atado, lo dice: hay que restablecerla');
update auth.mfa_factors set status = 'verified', factor_type = 'phone', phone = '+5215500000002'
  where id = pruebas.factor('c0000000-0000-0000-0000-000000000002');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') ->> 'factor', 'lost', 'o si dejó de ser de aplicación de códigos');
update auth.mfa_factors set factor_type = 'totp', phone = null, user_id = 'a0000000-0000-0000-0000-000000000009'
  where id = pruebas.factor('c0000000-0000-0000-0000-000000000002');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') ->> 'factor', 'lost', 'también si en Auth es de otra cuenta');
delete from auth.mfa_factors where id = pruebas.factor('c0000000-0000-0000-0000-000000000002');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') ->> 'factor', 'lost', 'o si ya no existe');
select is(pruebas.estado('c0000000-0000-0000-0000-000000000002'), 'unbound', 'que es lo que ella ve');
select pruebas.equipar('c0000000-0000-0000-0000-000000000002');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') ->> 'factor', 'bound', '(de vuelta en su lugar)');

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('c0000000-0000-0000-0000-000000000002', pruebas.huella('clave'))$$),
  'reset', '(se le restablece el segundo factor)');
select is(
  pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') - 'display_name' - 'profile_id' - 'email',
  jsonb_build_object('status', 'active', 'capabilities', jsonb_build_array('config'), 'factor', 'none',
                     'rebind', 'pending', 'config_removable', true, 'is_self', false),
  'restablecida: conserva sus capacidades, sin factor, y con una invitación para volver');
select is(
  pruebas.pendiente('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') - 'created_at' - 'expires_at' - 'id',
  jsonb_build_object(
    'kind', 'rebind', 'email', 'config2@prueba.test', 'profile_id', 'c0000000-0000-0000-0000-000000000002',
    'capabilities', jsonb_build_array(), 'invited_by', 'c0000000-0000-0000-0000-000000000001', 'expired', false, 'acceptable', true),
  'y esa invitación sale entre las pendientes: es de restablecimiento y no da nada');

-- Nada de lo que se guarda en secreto sale. Primero, que lo secreto esté ahí.
select ok(
  exists (select 1 from private.admin_invitations i
          where i.handoff = pruebas.huella('clave') and i.accepted_at is null and i.revoked_at is null)
  and exists (select 1 from private.account_security s where s.mailbox_ticket = pruebas.huella('ana'))
  and exists (select 1 from auth.mfa_factors m where m.id = pruebas.factor('c0000000-0000-0000-0000-000000000001') and m.secret = 'JBSWY3DPEHPK3PXP'),
  '(hay una huella de código dictado, un resguardo del buzón y la clave de un factor guardados)');
select ok(
  pruebas.lista('c0000000-0000-0000-0000-000000000001')::text !~* (
    'handoff|ticket|secret|failures|factor_id|session|' || pruebas.huella('clave') || '|' || pruebas.huella('ana')
    || '|JBSWY3DPEHPK3PXP|' || pruebas.factor('c0000000-0000-0000-0000-000000000001')::text
    || '|' || pruebas.sesion('c0000000-0000-0000-0000-000000000001')::text),
  'la lista no trae la huella del código dictado, ni el resguardo, ni la clave o el identificador de un factor, ni una sesión');
select is(
  (select array_agg(distinct k order by k)
   from jsonb_array_elements(pruebas.lista('c0000000-0000-0000-0000-000000000001') -> 'members') as m, jsonb_object_keys(m) as k),
  array['capabilities', 'config_removable', 'display_name', 'email', 'factor', 'is_self', 'profile_id', 'rebind', 'status'],
  'de cada persona, estos campos y ninguno más');
select is(
  (select array_agg(distinct k order by k)
   from jsonb_array_elements(pruebas.lista('c0000000-0000-0000-0000-000000000001') -> 'invitations') as i, jsonb_object_keys(i) as k),
  array['acceptable', 'capabilities', 'created_at', 'email', 'expired', 'expires_at', 'id', 'invited_by', 'kind', 'profile_id'],
  'y de cada invitación, estos');

-- La invitación para volver, en sus otros estados.
select pruebas.como_dueno_sistema();
update private.admin_invitations set created_at = created_at - interval '3 hours', expires_at = clock_timestamp() - interval '1 second'
  where email = 'config2@prueba.test' and accepted_at is null and revoked_at is null;
select pruebas.limpiar();
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') ->> 'rebind', 'expired',
  'si su invitación para volver caducó, lo dice: hay que restablecerla otra vez');
select pruebas.como_dueno_sistema();
update private.admin_invitations set expires_at = clock_timestamp() + interval '1 day'
  where email = 'config2@prueba.test' and accepted_at is null and revoked_at is null;
select pruebas.limpiar();
update auth.users set email = 'otro2@prueba.test' where id = 'c0000000-0000-0000-0000-000000000002';
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'otro2@prueba.test') ->> 'rebind', 'unusable',
  'si no caducó pero ya no la puede aceptar (le cambiaron el correo), también lo dice');
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test'), null::jsonb, 'el correo que sale es el que la cuenta tiene hoy');
update auth.users set email = 'config2@prueba.test' where id = 'c0000000-0000-0000-0000-000000000002';
select is(pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') ->> 'rebind', 'pending', '(de vuelta en su lugar)');
-- Una invitación para volver no devuelve capacidades: a quien ya no tiene ninguna no le sirve.
select pruebas.como_dueno_sistema();
update public.admin_capabilities set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000001'
  where profile_id = 'c0000000-0000-0000-0000-000000000002' and revoked_at is null;
select pruebas.limpiar();
select is(pruebas.pendiente('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') -> 'acceptable', 'false'::jsonb,
  'una invitación para volver ya no se puede aceptar si la persona perdió sus capacidades');
select is(pruebas.estado('c0000000-0000-0000-0000-000000000002'), 'none', 'y ella ve lo mismo: nada');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000002', 'config');
select is(
  pruebas.pide('c0000000-0000-0000-0000-000000000001',
    format('private.revoke_admin_invitation(%L)', (pruebas.invitacion_viva('config2@prueba.test')).id)),
  'revoked', '(se revoca su invitación para volver)');
select is(
  pruebas.persona('c0000000-0000-0000-0000-000000000001', 'config2@prueba.test') - 'display_name' - 'profile_id' - 'email' - 'capabilities' - 'status',
  jsonb_build_object('factor', 'none', 'rebind', 'none', 'config_removable', true, 'is_self', false),
  'sin atadura y sin invitación: no tiene con qué volver hasta que la restablezcan');

-- No escribe nada: preguntar no deja renglón en la auditoría.
create table pruebas.auditoria_antes as select count(*) as renglones from public.audit_log;
select ok(pruebas.lista('c0000000-0000-0000-0000-000000000001') is not null, '(se lee una vez más)');
select is((select count(*) from public.audit_log), (select a.renglones from pruebas.auditoria_antes a),
  'leer la lista no deja nada en la auditoría');

-- ---------------------------------------------------------------------------------------
-- Cuando falta un parámetro. Va al final porque cambia, dentro de esta transacción, de
-- dónde salen los parámetros.

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
-- El aviso que deja en el registro cuando le falta su parámetro, aquí es ruido.
set local client_min_messages to error;
insert into pruebas.parametro_falso values ('VIGENCIA_CODIGO_RECIENTE_MINUTOS', null);
select is(pruebas.lista('c0000000-0000-0000-0000-000000000001') -> 'fresh_code', 'false'::jsonb,
  'sin el plazo del código reciente, ningún código lo es');
select is(jsonb_array_length(pruebas.lista('c0000000-0000-0000-0000-000000000001') -> 'members'), 4, 'y la lista se sigue viendo');
delete from pruebas.parametro_falso;
insert into pruebas.parametro_falso values ('VIGENCIA_SEGUNDO_FACTOR_HORAS', null);
select is(pruebas.lista('c0000000-0000-0000-0000-000000000001'), null::jsonb, 'sin el plazo del segundo factor no pasa nadie: nulo');

select pruebas.limpiar();
select * from finish();
rollback;
