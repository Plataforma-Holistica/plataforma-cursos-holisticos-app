-- T-105 · En qué estado está una persona respecto al equipo (RF-105, RF-106). TRD §9.2,
-- fila «Invitaciones»; esquema §6.2. Cuarta entrega de T-105, primera parte.
--
-- La guarda de administración necesita saber más que sí o no: si la persona es del equipo,
-- si le falta dar su código, si tiene una invitación que puede aceptar, si la tiene pero
-- no ha probado su buzón en ese navegador, o si conserva capacidades sin su factor atado.
-- private.team_standing() lo contesta sobre quien actúa, sin escribir nada, y tiene que
-- decir lo mismo que diría private.accept_admin_invitation(): si no, la persona daría
-- vueltas entre dos pantallas.
begin;
\ir _ayuda.psql
select plan(61);

select pruebas.alta('c0000000-0000-0000-0000-000000000001', 'config1@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000002', 'config2@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000003', 'config3@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%@prueba.test';
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'support');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000002', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000003', 'config');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select pruebas.equipar('c0000000-0000-0000-0000-000000000002');
select pruebas.equipar('c0000000-0000-0000-0000-000000000003');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000002');

-- El estado de una persona, en una línea: estado, factor, tipo de invitación y capacidades.
create function pruebas.estado(p_id uuid, p_ticket text default null, p_session uuid default null) returns text
language plpgsql
as $$
declare
  v_line text;
begin
  perform pruebas.a_nombre_de(p_id, p_session);
  select t.state || ' ' || coalesce(t.factor::text, '-') || ' ' || coalesce(t.kind, '-')
         || ' [' || array_to_string(t.capabilities, ',') || ']'
  into v_line from private.team_standing(p_ticket) as t;
  perform pruebas.limpiar();
  return v_line;
end
$$;
grant execute on function pruebas.estado(uuid, text, uuid) to app_service;

-- ---------------------------------------------------------------------------------------
-- Permisos, y lo que contesta a quien no es nadie.

select ok(
  bool_and(has_function_privilege('app_service', f, 'execute')
           and not has_function_privilege('authenticated', f, 'execute')
           and not has_function_privilege('anon', f, 'execute')
           and not has_function_privilege('service_role', f, 'execute')),
  'las dos funciones de lectura las ejecuta solo el servidor')
from unnest(array['private.team_standing(text)', 'private.mailbox_proof_seconds(integer)']) as f;
select is_empty('select * from private.schema_violations()', 'private.schema_violations() sigue en cero');
select pruebas.como_sistema();
select results_eq(
  $$select state, factor, kind, capabilities from private.team_standing()$$,
  $$values ('none', null::uuid, null::text, '{}'::text[])$$,
  'sin persona que actúe: nada, y siempre una fila');
select pruebas.limpiar();
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001'), 'none - - []', 'una cuenta común: nada');
select is(pruebas.estado(gen_random_uuid()), 'none - - []', 'una cuenta que no existe: nada');

-- ---------------------------------------------------------------------------------------
-- Quien ya es del equipo.

select is(pruebas.estado('c0000000-0000-0000-0000-000000000001'),
  'member ' || pruebas.factor('c0000000-0000-0000-0000-000000000001') || ' - [config,support]',
  'del equipo: con su factor atado y sus capacidades activas, en orden');
select is(pruebas.estado('c0000000-0000-0000-0000-000000000001', p_session => gen_random_uuid()),
  'needs_code ' || pruebas.factor('c0000000-0000-0000-0000-000000000001') || ' - []',
  'con otra sesión, le falta dar su código: se dice con qué factor, y no sus capacidades');
select pruebas.sin_codigo('c0000000-0000-0000-0000-000000000001');
select is(pruebas.estado('c0000000-0000-0000-0000-000000000001'),
  'needs_code ' || pruebas.factor('c0000000-0000-0000-0000-000000000001') || ' - []',
  'con la sesión en primer nivel, también');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '13 hours'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select is(pruebas.estado('c0000000-0000-0000-0000-000000000001'),
  'needs_code ' || pruebas.factor('c0000000-0000-0000-0000-000000000001') || ' - []',
  'y con el código de hace 13 horas');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
update auth.mfa_factors set status = 'unverified' where id = pruebas.factor('c0000000-0000-0000-0000-000000000001');
select is(pruebas.estado('c0000000-0000-0000-0000-000000000001'), 'unbound - - []',
  'si Auth ya no tiene verificado su factor atado, no hay código que pedir: hay que restablecerla');
update auth.mfa_factors set status = 'verified', factor_type = 'phone', phone = '+5215500000001'
  where id = pruebas.factor('c0000000-0000-0000-0000-000000000001');
select is(pruebas.estado('c0000000-0000-0000-0000-000000000001'), 'unbound - - []', 'ni si dejó de ser de aplicación de códigos');
update auth.mfa_factors set factor_type = 'totp', phone = null, user_id = 'a0000000-0000-0000-0000-000000000002'
  where id = pruebas.factor('c0000000-0000-0000-0000-000000000001');
select is(pruebas.estado('c0000000-0000-0000-0000-000000000001'), 'unbound - - []', 'ni si en Auth es de otra cuenta');
delete from auth.mfa_factors where id = pruebas.factor('c0000000-0000-0000-0000-000000000001');
select is(pruebas.estado('c0000000-0000-0000-0000-000000000001'), 'unbound - - []', 'ni si ya no existe');
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
values (gen_random_uuid(), 'c0000000-0000-0000-0000-000000000001', 'otro', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP');
select is(pruebas.estado('c0000000-0000-0000-0000-000000000001'), 'unbound - - []', 'aunque la cuenta tenga otro factor verificado: el que cuenta es el atado');
delete from auth.mfa_factors where user_id = 'c0000000-0000-0000-0000-000000000001';
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select is(left(pruebas.estado('c0000000-0000-0000-0000-000000000001'), 6), 'member', '(de vuelta en su lugar)');

-- ---------------------------------------------------------------------------------------
-- Quien tiene una invitación que da capacidades.

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('ana@prueba.test', '{support,content}')$$),
  'invited_existing', '(se invita a una cuenta común)');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001'), 'invited_unproven - grant []',
  'invitada, sin haber probado su buzón: no se le dice qué va a recibir');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana'));
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001'), 'invited_unproven - grant []', 'sin presentar el resguardo, igual');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('otro')), 'invited_unproven - grant []', 'con otro, igual');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', 'ana'), 'invited_unproven - grant []', 'con el secreto sin su huella, igual');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'invited - grant [support,content]',
  'con su resguardo: invitada, y entonces sí sus capacidades, en el orden de la invitación');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'invited_unproven - grant []',
  'si un reclamo posterior sin resguardo lo anuló, ya no vale');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana'));

-- El resguardo vale lo mismo que al aceptar: posterior a la invitación, del mismo correo y reciente.
select pruebas.como_dueno();
update private.account_security set mailbox_proven_at = (pruebas.invitacion_viva('ana@prueba.test')).created_at
  where profile_id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'invited_unproven - grant []',
  'una prueba que no es posterior a la invitación no cuenta');
select pruebas.como_dueno_sistema();
update private.admin_invitations set created_at = created_at - interval '3 hours' where email = 'ana@prueba.test';
select pruebas.limpiar();
update private.account_security set mailbox_proven_at = clock_timestamp() - interval '61 minutes'
  where profile_id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'invited_unproven - grant []', 'una de hace 61 minutos ya venció');
update private.account_security set mailbox_proven_at = clock_timestamp() - interval '59 minutes'
  where profile_id = 'a0000000-0000-0000-0000-000000000001';
select is(left(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 8), 'invited ', 'una de hace 59, vale');
update private.account_security set mailbox_proven_at = clock_timestamp() - interval '30 minutes', mailbox_proven_email = 'otra@prueba.test'
  where profile_id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'invited_unproven - grant []', 'una hecha con otro correo no cuenta');
update private.account_security set mailbox_proven_email = 'ana@prueba.test' where profile_id = 'a0000000-0000-0000-0000-000000000001';

-- La invitación tiene que ser una que aceptar aceptaría.
update auth.users set email = 'ana2@prueba.test' where id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none - - []', 'si el correo de la cuenta ya no es el invitado: nada');
update auth.users set email = 'ana@prueba.test', is_sso_user = true where id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none - - []', 'una cuenta de acceso federado: nada');
update auth.users set is_sso_user = false where id = 'a0000000-0000-0000-0000-000000000001';
select pruebas.como_dueno_sistema();
update private.admin_invitations set profile_id = 'a0000000-0000-0000-0000-000000000002' where email = 'ana@prueba.test';
select pruebas.limpiar();
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none - - []', 'si la invitación apunta a otra cuenta: nada');
select pruebas.como_dueno_sistema();
update private.admin_invitations set profile_id = 'a0000000-0000-0000-0000-000000000001', expires_at = clock_timestamp() - interval '1 second'
  where email = 'ana@prueba.test';
select pruebas.limpiar();
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none - - []', 'una invitación caducada: nada');
select pruebas.como_dueno_sistema();
update private.admin_invitations set expires_at = clock_timestamp() + interval '1 day' where email = 'ana@prueba.test';
select pruebas.limpiar();

-- Quien invitó tiene que seguir pudiendo: si no, aceptar la revocaría.
select pruebas.suspender('c0000000-0000-0000-0000-000000000001');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none - - []', 'si quien invitó está suspendido: nada');
select pruebas.como_dueno_sistema();
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = 'c0000000-0000-0000-0000-000000000001';
delete from private.admin_factors where profile_id = 'c0000000-0000-0000-0000-000000000001';
select pruebas.limpiar();
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none - - []', 'si ya no tiene su factor atado: nada');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select pruebas.como_dueno_sistema();
update public.admin_capabilities set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000002'
  where profile_id = 'c0000000-0000-0000-0000-000000000001' and capability = 'config';
select pruebas.limpiar();
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'none - - []',
  'si ya no tiene configuración, aunque conserve otra capacidad: nada');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'config');
select is(left(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 8), 'invited ', '(con quien invitó de vuelta en su lugar, invitada)');

-- La del dueño de la base no tiene quién invitó, y vale.
select pruebas.como_dueno_sistema();
select private.system_invite_admin('beto@prueba.test', '{config}');
select pruebas.limpiar();
select pruebas.reclamar('a0000000-0000-0000-0000-000000000002', pruebas.huella('beto'));
select is(pruebas.estado('a0000000-0000-0000-0000-000000000002', pruebas.huella('beto')), 'invited - grant [config]',
  'una invitación del arranque, con resguardo: invitada');

-- Y lo que dice coincide con lo que aceptar hace.
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana')), 'accepted', '(quien salía invitada, acepta)');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001'),
  'member ' || pruebas.factor('a0000000-0000-0000-0000-000000000001') || ' - [content,support]',
  'y pasa a ser del equipo');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('a0000000-0000-0000-0000-000000000001', 'support')$$), 'revoked', '(se le quita una capacidad)');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('a0000000-0000-0000-0000-000000000001', 'content')$$), 'revoked', '(y la otra)');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001'), 'none - - []',
  'quien perdió todas sus capacidades vuelve a no ser nadie: su invitación ya aceptada no cuenta');
-- Atada y sin capacidades: no pasa por las funciones, pero si pasara, aceptar diría que no.
select pruebas.verificar('a0000000-0000-0000-0000-000000000002');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000002', pruebas.huella('beto')), 'accepted', '(la persona del arranque acepta)');
select pruebas.como_dueno_sistema();
update public.admin_capabilities set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000001'
  where profile_id = 'a0000000-0000-0000-0000-000000000002' and capability = 'config';
insert into private.admin_invitations (kind, email, capabilities, created_at, expires_at)
values ('grant', 'beto@prueba.test', '{support}', clock_timestamp(), clock_timestamp() + interval '1 day');
select pruebas.limpiar();
select pruebas.reclamar('a0000000-0000-0000-0000-000000000002', pruebas.huella('beto-2'));
select is(pruebas.estado('a0000000-0000-0000-0000-000000000002', pruebas.huella('beto-2')), 'none - - []',
  'quien conserva una atadura sin capacidades no puede aceptar otra invitación: nada');

-- ---------------------------------------------------------------------------------------
-- Quien conserva capacidades y perdió su factor atado.

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('c0000000-0000-0000-0000-000000000002', pruebas.huella('clave'))$$),
  'reset', '(se restablece a alguien del equipo)');
select pruebas.reclamar('c0000000-0000-0000-0000-000000000002');
select is(pruebas.estado('c0000000-0000-0000-0000-000000000002'), 'invited_unproven - rebind []',
  'restablecida, sin resguardo: se le dice que es un restablecimiento');
select pruebas.reclamar('c0000000-0000-0000-0000-000000000002', pruebas.huella('dos'));
select is(pruebas.estado('c0000000-0000-0000-0000-000000000002', pruebas.huella('dos')), 'invited - rebind []',
  'con resguardo: invitada a volver, sin capacidades que recibir');
select pruebas.como_dueno_sistema();
update private.admin_invitations set revoked_at = now() where email = 'config2@prueba.test' and revoked_at is null and accepted_at is null;
select pruebas.limpiar();
select is(pruebas.estado('c0000000-0000-0000-0000-000000000002', pruebas.huella('dos')), 'unbound - - []',
  'con capacidades, sin atadura y sin invitación: hay que pedir que la restablezcan');
select pruebas.como_dueno_sistema();
insert into private.admin_invitations (kind, email, capabilities, created_at, expires_at)
values ('grant', 'config2@prueba.test', '{finance}', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day');
select pruebas.limpiar();
select is(pruebas.estado('c0000000-0000-0000-0000-000000000002', pruebas.huella('dos')), 'unbound - - []',
  'una invitación que da capacidades no le sirve a quien ya tiene alguna: aceptar la revocaría');
select pruebas.como_dueno_sistema();
update private.admin_invitations set revoked_at = now() where email = 'config2@prueba.test' and revoked_at is null and accepted_at is null;
select is(private.system_reset_second_factor('c0000000-0000-0000-0000-000000000002', pruebas.huella('e'), 'otro@prueba.test'), 'reset',
  '(la emergencia deja su invitación en otro correo)');
select pruebas.limpiar();
select pruebas.reclamar('c0000000-0000-0000-0000-000000000002', pruebas.huella('tres'));
select is(pruebas.estado('c0000000-0000-0000-0000-000000000002', pruebas.huella('tres')), 'unbound - - []',
  'mientras el correo de su cuenta no sea ese, no tiene invitación que aceptar');

-- Una de restablecimiento para quien ya no tiene capacidades tampoco es una invitación.
select pruebas.como_dueno_sistema();
insert into private.admin_invitations (kind, email, profile_id, capabilities, handoff, created_at, expires_at)
values ('rebind', 'config3@prueba.test', 'c0000000-0000-0000-0000-000000000003', '{}', pruebas.huella('x'),
        clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day');
delete from private.admin_factors where profile_id = 'c0000000-0000-0000-0000-000000000003';
update public.admin_capabilities set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000001'
  where profile_id = 'c0000000-0000-0000-0000-000000000003';
select pruebas.limpiar();
select pruebas.reclamar('c0000000-0000-0000-0000-000000000003', pruebas.huella('cuatro'));
select is(pruebas.estado('c0000000-0000-0000-0000-000000000003', pruebas.huella('cuatro')), 'none - - []',
  'una de restablecimiento para quien ya no tiene capacidades: nada');

-- No escribe: ni la invitación que aceptar revocaría queda tocada.
select is((select count(*)::int from private.admin_invitations i where i.email = 'config3@prueba.test' and i.revoked_at is null),
  1, 'preguntar no revoca nada: eso lo hace aceptar');

-- ---------------------------------------------------------------------------------------
-- Cuánto dura la cookie del resguardo, y qué pasa cuando falta su parámetro. Va al final
-- porque cambia, dentro de esta transacción, de dónde salen los parámetros.

select pruebas.como_servicio();
select is(private.mailbox_proof_seconds(86400), 3600, 'la prueba del buzón dura lo que dice su parámetro: 60 minutos');
select is(private.mailbox_proof_seconds(3600), 3600, 'con el tope justo, lo mismo');
select is(private.mailbox_proof_seconds(600), 600, 'y nunca más que el tope de quien pregunta');
select is(private.mailbox_proof_seconds(null), null, 'sin tope no hay duración');
select is(private.mailbox_proof_seconds(0), null, 'ni con un tope que no vale');
select pruebas.limpiar();
select pruebas.alta('a0000000-0000-0000-0000-000000000003', 'carla@prueba.test');
select pruebas.confirmar('a0000000-0000-0000-0000-000000000003');
select pruebas.como_dueno_sistema();
select private.system_invite_admin('carla@prueba.test', '{finance}');
select pruebas.limpiar();
select pruebas.reclamar('a0000000-0000-0000-0000-000000000003', pruebas.huella('carla'));

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
insert into pruebas.parametro_falso values ('VIGENCIA_PRUEBA_BUZON_MINUTOS', null);
select pruebas.como_servicio();
select is(private.mailbox_proof_seconds(86400), null, 'sin el parámetro no hay duración: no lanza');
select pruebas.limpiar();
select is(pruebas.estado('a0000000-0000-0000-0000-000000000003', pruebas.huella('carla')), 'invited_unproven - grant []',
  'y ningún resguardo vale');
update pruebas.parametro_falso set value = '"sesenta"';
select pruebas.como_servicio();
select is(private.mailbox_proof_seconds(86400), null, 'con un texto en su lugar, tampoco');
select pruebas.limpiar();
update pruebas.parametro_falso set value = '2147483647';
select pruebas.como_servicio();
select is(private.mailbox_proof_seconds(86400), 86400, 'y con el entero más grande no se desborda: queda en el tope');
select pruebas.limpiar();
select is(pruebas.estado('a0000000-0000-0000-0000-000000000003', pruebas.huella('carla')), 'invited - grant [finance]',
  'ni al comparar la edad del resguardo');

select pruebas.limpiar();
select * from finish();
rollback;
