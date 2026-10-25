-- T-105 · Las invitaciones de administrador (RF-105, RF-106, RF-712). TRD §9.2, fila
-- «Invitaciones»; esquema §6.2. Tercera entrega de T-105.
--
-- Nadie recibe una capacidad si no es aceptando una invitación, y aceptar pide tres cosas
-- que aquí se rompen de una en una: el resguardo del navegador que abrió el enlace del
-- correo, una sesión verificada hace poco con el factor que se va a atar y, si es un
-- restablecimiento, el código que dicta quien restableció. Cambiar el equipo pide además
-- un código reciente de quien lo cambia.
begin;
\ir _ayuda.psql
select plan(284);

select pruebas.alta('c0000000-0000-0000-0000-000000000001', 'config1@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000002', 'config2@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000003', 'config3@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000003', 'suspendida@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000004', 'comun@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%@prueba.test';
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000002', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000003', 'config');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select pruebas.equipar('c0000000-0000-0000-0000-000000000002');
select pruebas.equipar('c0000000-0000-0000-0000-000000000003');

-- ---------------------------------------------------------------------------------------
-- Estructura y permisos.

select ok(
  not has_any_column_privilege('app_service', 'private.admin_invitations', 'select, insert, update')
    and not has_table_privilege('app_service', 'private.admin_invitations', 'delete')
    and not has_any_column_privilege('authenticated', 'private.admin_invitations', 'select, insert, update')
    and not has_any_column_privilege('anon', 'private.admin_invitations', 'select, insert, update')
    and not has_any_column_privilege('service_role', 'private.admin_invitations', 'select, insert, update'),
  'nadie tiene permisos sobre la tabla de invitaciones');
select ok(
  has_table_privilege('app_service', 'public.admin_capabilities', 'select')
    and not has_any_column_privilege('app_service', 'public.admin_capabilities', 'insert, update')
    and not has_table_privilege('app_service', 'public.admin_capabilities', 'delete'),
  'el servidor lee las capacidades y ya no las escribe');
select ok(
  bool_and(has_function_privilege('app_service', f, 'execute')
           and not has_function_privilege('authenticated', f, 'execute')
           and not has_function_privilege('anon', f, 'execute')
           and not has_function_privilege('service_role', f, 'execute')),
  'las siete funciones del servidor las ejecuta solo el servidor')
from unnest(array[
  'private.claim_account(text)',
  'private.invite_admin(text, public.capability[])',
  'private.revoke_admin_invitation(uuid)',
  'private.accept_admin_invitation(text, uuid, text)',
  'private.grant_capability(uuid, public.capability)',
  'private.revoke_capability(uuid, public.capability)',
  'private.reset_second_factor(uuid, text, text)']) as f;
select ok(
  bool_and(not has_function_privilege('app_service', f, 'execute')
           and not has_function_privilege('authenticated', f, 'execute')
           and not has_function_privilege('anon', f, 'execute')
           and not has_function_privilege('service_role', f, 'execute')
           and not has_function_privilege('supabase_auth_admin', f, 'execute')),
  'las internas y las del dueño no las ejecuta nadie más')
from unnest(array[
  'private.clean_email(text)',
  'private.team_lock()',
  'private.drop_unbound_factors(uuid)',
  'private.close_all_sessions(uuid)',
  'private.recent_code_seconds()',
  'private.fresh_code(uuid, uuid)',
  'private.team_change_gate()',
  'private.place_invitation(text, public.capability[], uuid)',
  'private.reset_factor(uuid, text, uuid, text)',
  'private.reset_version(uuid)',
  'private.system_invite_admin(text, public.capability[])',
  'private.system_reset_second_factor(uuid, text, text)']) as f;
select is(
  (select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname = 'claim_account'),
  1, 'reclamar la cuenta tiene una sola firma: la de antes ya no existe');
select is_empty('select * from private.schema_violations()', 'private.schema_violations() sigue en cero');
select results_eq(
  $$select private.parameter_value('VIGENCIA_INVITACION_DIAS'), private.parameter_value('VIGENCIA_CODIGO_RECIENTE_MINUTOS'),
           private.parameter_value('VIGENCIA_PRUEBA_BUZON_MINUTOS')$$,
  $$values ('7'::jsonb, '15'::jsonb, '60'::jsonb)$$,
  'los tres plazos son parámetros: 7 días, 15 minutos y 60 minutos');
select has_column('auth', 'users', 'is_sso_user', 'auth.users.is_sso_user existe');
select has_column('auth', 'mfa_factors', 'status', 'auth.mfa_factors.status existe');

-- El vigilante ve si alguien devuelve un permiso.
grant insert on public.admin_capabilities to app_service;
select isnt_empty('select * from private.schema_violations()', 'devolverle al servidor el alta de capacidades es una violación');
revoke insert on public.admin_capabilities from app_service;
grant update (revoked_at) on public.admin_capabilities to app_service;
select isnt_empty('select * from private.schema_violations()', 'también por una sola columna');
revoke update (revoked_at) on public.admin_capabilities from app_service;
grant select on private.admin_invitations to app_service;
select isnt_empty('select * from private.schema_violations()', 'y dejarle leer las invitaciones');
revoke select on private.admin_invitations from app_service;
grant select (factor_id) on private.admin_factors to app_service;
select isnt_empty('select * from private.schema_violations()', 'o una columna de las ataduras');
revoke select (factor_id) on private.admin_factors from app_service;
select is_empty('select * from private.schema_violations()', '(de vuelta en cero)');

-- ---------------------------------------------------------------------------------------
-- Cambiar el equipo pide configuración y un código reciente.

select is(pruebas.pide('a0000000-0000-0000-0000-000000000001', $$private.invite_admin('x@prueba.test', '{support}')$$),
  'forbidden', 'quien no tiene configuración no invita');
select pruebas.como_sistema();
select is(private.invite_admin('x@prueba.test', '{support}'), 'forbidden', 'el sistema, por el camino de servicio, tampoco');
select pruebas.limpiar();

update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '16 minutes'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('x@prueba.test', '{support}')$$),
  'needs_fresh_code', 'con un código de hace 16 minutos no se invita');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_admin_invitation(gen_random_uuid())$$),
  'needs_fresh_code', 'ni se revoca una invitación');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.grant_capability('c0000000-0000-0000-0000-000000000002', 'support')$$),
  'needs_fresh_code', 'ni se da una capacidad');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('c0000000-0000-0000-0000-000000000003', 'config')$$),
  'needs_fresh_code', 'ni se quita');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('c0000000-0000-0000-0000-000000000002', pruebas.huella('x'), pruebas.version('c0000000-0000-0000-0000-000000000002'))$$),
  'needs_fresh_code', 'ni se restablece a nadie');
-- Ni se cambia un parámetro: los plazos lo son, y quien tuviera esa sesión se los alargaría.
select pruebas.a_nombre_de('c0000000-0000-0000-0000-000000000001');
select set_config('app.reason', 'Prueba', true);
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('VIGENCIA_CODIGO_RECIENTE_MINUTOS', '100000', 'proposed', now() + interval '1 day')$$,
  '42501', 'public.business_parameters: a recent second factor code is required',
  'ni se programa un cambio de parámetro');
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('VENTANA_REEMBOLSO_DIAS', '12', 'proposed', now() + interval '3 days')$$,
  '42501', 'public.business_parameters: a recent second factor code is required',
  'de ninguno: no es una lista de parámetros delicados');
select throws_ok(
  $$update public.business_parameters set canceled_at = now(), canceled_by = 'c0000000-0000-0000-0000-000000000001'
    where key = 'VIGENCIA_CODIGO_RECIENTE_MINUTOS'$$,
  '42501', 'public.business_parameters: a recent second factor code is required',
  'ni se cancela el vigente');
select pruebas.como_sistema();
select lives_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('VENTANA_REEMBOLSO_DIAS', '11', 'proposed', now() + interval '2 days')$$,
  'el sistema sí: no da códigos');
select pruebas.limpiar();
select ok(pruebas.tiene('c0000000-0000-0000-0000-000000000001', 'config'), '(y eso que la puerta de 12 horas sí la pasa)');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '14 minutes'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('', '{support}')$$),
  'invalid', 'con uno de hace 14 minutos sí pasa la puerta de cambio');
select pruebas.a_nombre_de('c0000000-0000-0000-0000-000000000001');
select set_config('app.reason', 'Prueba', true);
select lives_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('VENTANA_REEMBOLSO_DIAS', '10', 'proposed', now() + interval '1 day')$$,
  'y se puede programar un cambio de parámetro');
select pruebas.limpiar();
update auth.mfa_amr_claims set updated_at = clock_timestamp() + interval '6 minutes'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('', '{support}')$$),
  'needs_fresh_code', 'un código fechado seis minutos adelante no es reciente');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');

-- El código tiene que ser del factor atado: verificar con otro no sirve.
select pruebas.verificar('c0000000-0000-0000-0000-000000000001', gen_random_uuid());
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('', '{support}')$$),
  'needs_fresh_code', 'un código reciente de otro factor no abre la puerta de cambio');
select ok(not private.fresh_code('c0000000-0000-0000-0000-000000000001', pruebas.sesion('c0000000-0000-0000-0000-000000000001')),
  'preguntado directo: el código de otro factor no es reciente para nadie');
delete from auth.mfa_factors where user_id = 'c0000000-0000-0000-0000-000000000001'
  and id <> pruebas.factor('c0000000-0000-0000-0000-000000000001');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select ok(private.fresh_code('c0000000-0000-0000-0000-000000000001', pruebas.sesion('c0000000-0000-0000-0000-000000000001')),
  'el del factor atado, recién dado, sí');
select ok(not private.fresh_code('c0000000-0000-0000-0000-000000000002', pruebas.sesion('c0000000-0000-0000-0000-000000000001')),
  'pero no para otra persona');
select ok(not private.fresh_code('c0000000-0000-0000-0000-000000000001', pruebas.sesion('c0000000-0000-0000-0000-000000000002')),
  'ni con la sesión de otra');
update auth.sessions set aal = 'aal1' where id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not private.fresh_code('c0000000-0000-0000-0000-000000000001', pruebas.sesion('c0000000-0000-0000-0000-000000000001')),
  'ni si la sesión ya no está en segundo nivel');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
update auth.mfa_amr_claims set authentication_method = 'password'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not private.fresh_code('c0000000-0000-0000-0000-000000000001', pruebas.sesion('c0000000-0000-0000-0000-000000000001')),
  'ni si lo reciente fue la contraseña y no el código');
delete from auth.mfa_amr_claims where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');

update auth.mfa_amr_claims set updated_at = clock_timestamp() + interval '6 minutes'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not private.fresh_code('c0000000-0000-0000-0000-000000000001', pruebas.sesion('c0000000-0000-0000-0000-000000000001')),
  'ni uno fechado seis minutos adelante');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '16 minutes'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not private.fresh_code('c0000000-0000-0000-0000-000000000001', pruebas.sesion('c0000000-0000-0000-0000-000000000001')),
  'ni uno de hace 16 minutos');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');

-- Con el código reciente pero sin pasar la puerta del equipo, tampoco: aquí, una sesión que
-- la aplicación no abrió.
delete from private.app_sessions where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('', '{support}')$$),
  'needs_fresh_code', 'el código reciente no basta si la sesión no pasa la puerta del equipo');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------------------------------
-- Invitar.

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', 'private.invite_admin(' || quote_nullable(e) || $$, '{support}')$$),
  'invalid', 'un correo que no lo es no se invita: ' || coalesce(e, 'nulo'))
from unnest(array[null, '', '   ', 'sin-arroba', 'a@b', 'dos@@x.test', 'con espacio@x.test', repeat('a', 250) || '@x.test']) as e;
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('x@prueba.test', null)$$),
  'invalid', 'ni sin lista de capacidades');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('x@prueba.test', '{}')$$),
  'invalid', 'ni con la lista vacía');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('x@prueba.test', array[null]::public.capability[])$$),
  'invalid', 'ni con un nulo dentro');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('x@prueba.test', '{{support}}')$$),
  'invalid', 'ni con una lista de listas: no lanza');
select is((select count(*)::int from private.admin_invitations), 0, 'nada de lo anterior dejó una invitación');

-- Un correo sin cuenta.
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
    $$private.invite_admin('  Nueva@Prueba.Test ', '{support,content,support}')$$),
  'invited_new', 'se invita un correo que no tiene cuenta');
select results_eq(
  $$select i.kind, i.email, i.profile_id is null, i.capabilities::text, i.invited_by, i.handoff is null,
           i.expires_at = i.created_at + interval '7 days', i.created_at > now() - interval '1 minute'
    from private.admin_invitations i$$,
  $$values ('grant', 'nueva@prueba.test', true, '{support,content}', 'c0000000-0000-0000-0000-000000000001'::uuid, true, true, true)$$,
  'queda con el correo normalizado, las capacidades sin repetir, quién invitó y su caducidad');
select results_eq(
  $$select actor_id, new_value ->> 'email', new_value ? 'handoff' from public.audit_log
    where entity_table = 'private.admin_invitations' and action = 'admin_invitations.insert'$$,
  $$values ('c0000000-0000-0000-0000-000000000001'::uuid, 'nueva@prueba.test', false)$$,
  'la auditoría dice quién invitó y a qué correo, y no guarda la huella del código dictado');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', $$private.invite_admin('nueva@prueba.test', '{finance}')$$),
  'already_invited', 'un correo con invitación viva no se invita otra vez');

-- Una cuenta que ya existe: no se le toca nada.
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001');
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('ana@prueba.test', '{support}')$$),
  'invited_existing', 'se invita un correo que ya tiene cuenta');
select is((pruebas.invitacion_viva('ana@prueba.test')).profile_id, 'a0000000-0000-0000-0000-000000000001'::uuid,
  'y la invitación apunta a su cuenta');
select ok(
  (select not p.password_reset_required from public.profiles p where p.id = 'a0000000-0000-0000-0000-000000000001')
    and exists (select 1 from auth.sessions s where s.user_id = 'a0000000-0000-0000-0000-000000000001' and s.aal = 'aal2')
    and exists (select 1 from private.app_sessions x where x.profile_id = 'a0000000-0000-0000-0000-000000000001')
    and exists (select 1 from auth.mfa_factors m where m.user_id = 'a0000000-0000-0000-0000-000000000001'),
  'invitar no le prende la marca, no le cierra sesiones y no le borra nada');

select pruebas.suspender('a0000000-0000-0000-0000-000000000003');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('suspendida@prueba.test', '{support}')$$),
  'ineligible', 'una cuenta suspendida no se invita');
insert into auth.users (id, email, is_sso_user) values ('a0000000-0000-0000-0000-000000000005', 'federada@prueba.test', true);
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('federada@prueba.test', '{support}')$$),
  'invited_new', 'una cuenta de acceso federado no cuenta como la cuenta de ese correo');
select is((pruebas.invitacion_viva('federada@prueba.test')).profile_id, null, 'la invitación no apunta a ella');
insert into auth.users (id, email) values ('a0000000-0000-0000-0000-000000000006', 'Mayus@Prueba.Test');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('mayus@prueba.test', '{support}')$$),
  'invited_existing', 'una cuenta cuyo correo quedó guardado con mayúsculas se encuentra igual');

-- Una cuenta invitada que cambia de correo sigue teniendo su invitación: una viva por cuenta.
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('beto@prueba.test', '{support}')$$),
  'invited_existing', '(se invita a otra cuenta que ya existe)');
update auth.users set email = 'beto-nuevo@prueba.test' where id = 'a0000000-0000-0000-0000-000000000002';
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('beto-nuevo@prueba.test', '{support}')$$),
  'already_invited', 'si la cuenta cambió de correo, sigue invitada: no se le invita otra vez');
select pruebas.como_dueno_sistema();
update private.admin_invitations set created_at = created_at - interval '8 days', expires_at = expires_at - interval '8 days'
  where email = 'beto@prueba.test';
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('beto-nuevo@prueba.test', '{support}')$$),
  'invited_existing', 'y caducada la anterior, se le invita al correo nuevo');
select is((select count(*)::int from private.admin_invitations i
           where i.profile_id = 'a0000000-0000-0000-0000-000000000002' and i.revoked_at is null),
  1, 'la anterior, que iba a su correo viejo, queda revocada');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
    $$private.revoke_admin_invitation((pruebas.invitacion_viva('beto-nuevo@prueba.test')).id)$$), 'revoked', '(se revoca)');
update auth.users set email = 'beto@prueba.test' where id = 'a0000000-0000-0000-0000-000000000002';
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('config2@prueba.test', '{support}')$$),
  'already_member', 'quien ya es del equipo no se invita: se le da la capacidad');

-- Una caducada deja invitar de nuevo, y queda revocada por quien reinvita.
select pruebas.como_dueno_sistema();
update private.admin_invitations set created_at = created_at - interval '8 days', expires_at = expires_at - interval '8 days'
  where email = 'nueva@prueba.test';
select throws_ok(
  $$insert into private.admin_invitations (kind, email, capabilities, created_at, expires_at)
    values ('grant', 'nueva@prueba.test', '{support}', now(), now() + interval '1 day')$$,
  '23505', null, 'un correo tiene una sola invitación viva, aunque esté caducada');
select throws_ok(
  $$insert into private.admin_invitations (kind, email, profile_id, capabilities, created_at, expires_at)
    values ('grant', 'otra@prueba.test', 'a0000000-0000-0000-0000-000000000001', '{support}', now(), now() + interval '1 day')$$,
  '23505', null, 'y una cuenta también una sola');
select throws_ok(
  $$insert into private.admin_invitations (kind, email, capabilities, created_at, expires_at)
    values ('grant', 'vacia@prueba.test', '{}', now(), now() + interval '1 day')$$,
  '23514', null, 'una invitación que da capacidades lleva al menos una');
select throws_ok(
  $$insert into private.admin_invitations (kind, email, profile_id, capabilities, handoff, created_at, expires_at)
    values ('rebind', 'r@prueba.test', 'a0000000-0000-0000-0000-000000000004', '{support}', pruebas.huella('c'), now(), now() + interval '1 day')$$,
  '23514', null, 'y una de restablecimiento no lleva ninguna');
select throws_ok(
  $$insert into private.admin_invitations (kind, email, profile_id, capabilities, created_at, expires_at)
    values ('rebind', 'r@prueba.test', 'a0000000-0000-0000-0000-000000000004', '{}', now(), now() + interval '1 day')$$,
  '23514', null, 'ni va sin la huella del código dictado');
select pruebas.limpiar();
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000004', pruebas.huella('x')), 'no_invitation',
  '(quien no tiene invitación no acepta nada)');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', $$private.invite_admin('nueva@prueba.test', '{support}')$$),
  'invited_new', 'un correo con la invitación caducada se invita de nuevo');
select results_eq(
  $$select i.revoked_by, i.accepted_at is null from private.admin_invitations i
    where i.email = 'nueva@prueba.test' and i.revoked_at is not null$$,
  $$values ('c0000000-0000-0000-0000-000000000002'::uuid, true)$$,
  'y la caducada queda revocada por quien reinvitó');

-- ---------------------------------------------------------------------------------------
-- Revocar una invitación.

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_admin_invitation(gen_random_uuid())$$),
  'not_found', 'una invitación que no existe no se revoca');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_admin_invitation(null)$$),
  'not_found', 'ni un nulo');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
    $$private.revoke_admin_invitation((pruebas.invitacion_viva('nueva@prueba.test')).id)$$),
  'revoked', 'quien tiene configuración revoca una invitación viva, la haya hecho quien la haya hecho');
select is((select count(*)::int from private.admin_invitations i where i.email = 'nueva@prueba.test' and i.revoked_at is null),
  0, 'y deja de estar viva');
select is((select count(*)::int from private.admin_invitations i
           where i.email = 'nueva@prueba.test' and i.revoked_by = 'c0000000-0000-0000-0000-000000000001'),
  1, 'con quién la revocó');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
    $$private.revoke_admin_invitation(pruebas.una_invitacion('nueva@prueba.test'))$$),
  'not_found', 'una ya revocada no se revoca dos veces');

-- ---------------------------------------------------------------------------------------
-- La prueba del buzón: el resguardo que deja reclamar la cuenta.

select is(pruebas.reclamar('a0000000-0000-0000-0000-000000000002', pruebas.huella('beto-1')), 'claimed',
  'reclamar con resguardo contesta lo de siempre');
select results_eq(
  $$select s.mailbox_ticket, s.mailbox_proven_at = s.password_changed_at, s.mailbox_proven_email
    from private.account_security s where s.profile_id = 'a0000000-0000-0000-0000-000000000002'$$,
  $$values (pruebas.huella('beto-1'), true, 'beto@prueba.test')$$,
  'y deja la huella, la hora y el correo probado');
select is(pruebas.reclamar('a0000000-0000-0000-0000-000000000002', pruebas.huella('beto-2')), 'already_claimed',
  'una recuperación posterior también deja resguardo');
select is((select s.mailbox_ticket from private.account_security s where s.profile_id = 'a0000000-0000-0000-0000-000000000002'),
  pruebas.huella('beto-2'), 'el nuevo sustituye al anterior');
select mailbox_proven_at as probado from private.account_security where profile_id = 'a0000000-0000-0000-0000-000000000002' \gset
select pruebas.reclamar('a0000000-0000-0000-0000-000000000002');
select results_eq(
  $$select s.mailbox_ticket is null, s.mailbox_proven_at from private.account_security s
    where s.profile_id = 'a0000000-0000-0000-0000-000000000002'$$,
  format($$values (true, %L::timestamptz)$$, :'probado'),
  'un reclamo sin resguardo anula el anterior y no mueve la hora de la prueba');
select is(pruebas.reclamo_guarda('a0000000-0000-0000-0000-000000000002', pruebas.huella('m')), true, '(una huella bien formada sí se guarda)');
select is(pruebas.reclamo_guarda('a0000000-0000-0000-0000-000000000002', t), false,
  'lo que no tiene forma de huella no se guarda como resguardo: ' || left(t, 12))
from unnest(array['XYZ', upper(pruebas.huella('m')), left(pruebas.huella('m'), 63), pruebas.huella('m') || '0', '']) as t;
select is(pruebas.reclamar('a0000000-0000-0000-0000-000000000003', pruebas.huella('susp')), 'ineligible',
  'una cuenta suspendida no se reclama');
select is((select s.mailbox_ticket from private.account_security s where s.profile_id = 'a0000000-0000-0000-0000-000000000003'),
  null, 'ni se queda con resguardo');

-- Cambiar la contraseña desde la cuenta no es una prueba del buzón.
select pruebas.verificar('a0000000-0000-0000-0000-000000000002');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000002', pruebas.huella('beto-3'));
select ok(exists (select 1 from auth.mfa_factors m where m.user_id = 'a0000000-0000-0000-0000-000000000002'),
  'a una cuenta cuya invitación se revocó, reclamar no le quita su factor');
select mailbox_proven_at as probado from private.account_security where profile_id = 'a0000000-0000-0000-0000-000000000002' \gset
select pruebas.pide('a0000000-0000-0000-0000-000000000002', 'private.note_password_change()');
select results_eq(
  $$select s.mailbox_ticket, s.mailbox_proven_at, s.password_changed_at > s.mailbox_proven_at
    from private.account_security s where s.profile_id = 'a0000000-0000-0000-0000-000000000002'$$,
  format($$values (%L, %L::timestamptz, true)$$, pruebas.huella('beto-3'), :'probado'),
  'cambiar la contraseña desde la cuenta fecha el cambio y no toca la prueba del buzón');

-- El factor que la cuenta invitada ya tenía se borra al probar el buzón. El de una cuenta
-- sin invitación, no.
select pruebas.verificar('a0000000-0000-0000-0000-000000000004');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000004', pruebas.huella('comun'));
select ok(exists (select 1 from auth.mfa_factors m where m.user_id = 'a0000000-0000-0000-0000-000000000004'),
  'a una cuenta sin invitación, reclamar no le quita su factor');

select pruebas.como_dueno();
insert into private.second_factor_attempts (factor_id, failed_count, last_failed_at)
values (pruebas.factor('a0000000-0000-0000-0000-000000000001'), 2, now());
insert into auth.sessions (id, user_id, aal, factor_id, created_at, updated_at)
values ('a1a1a1a1-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'aal2', gen_random_uuid(), now(), now()),
       ('a1a1a1a1-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'aal2', null, now(), now());
select is(pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'already_claimed',
  'la cuenta invitada prueba su buzón');
select ok(
  not exists (select 1 from auth.mfa_factors m where m.user_id = 'a0000000-0000-0000-0000-000000000001')
    and not exists (select 1 from private.second_factor_attempts a where a.factor_id = pruebas.factor('a0000000-0000-0000-0000-000000000001')),
  'y el factor que ya tenía desaparece, con sus intentos');
select ok(
  not exists (select 1 from auth.sessions s where s.user_id = 'a0000000-0000-0000-0000-000000000001'
              and (s.aal::text <> 'aal1' or s.factor_id is not null))
    and not exists (select 1 from auth.mfa_amr_claims c join auth.sessions s on s.id = c.session_id
                    where s.user_id = 'a0000000-0000-0000-0000-000000000001' and c.authentication_method = 'totp'),
  'sus sesiones bajan a primer nivel, también la que apuntaba a un factor que ya no existía y la que no apuntaba a ninguno');

-- ---------------------------------------------------------------------------------------
-- Aceptar. Ana tiene invitación viva (support) y resguardo; le falta el factor nuevo.

select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_code',
  'con el resguardo y sin haber verificado un factor, falta el código');
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', null), 'needs_mailbox_proof', 'sin resguardo no se acepta');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('otro')), 'needs_mailbox_proof', 'ni con otro');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', 'ana-1'), 'needs_mailbox_proof', 'ni con el secreto sin su huella');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('beto-3')), 'needs_mailbox_proof',
  'ni con el resguardo de otra cuenta');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_mailbox_proof',
  'ni con el suyo, si un reclamo posterior sin resguardo lo anuló');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1'));
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');

-- El resguardo tiene que ser posterior a la invitación, del mismo correo y reciente.
select pruebas.como_dueno();
update private.account_security set mailbox_proven_at = (pruebas.invitacion_viva('ana@prueba.test')).created_at
  where profile_id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_mailbox_proof',
  'una prueba que no es posterior a la invitación no cuenta');
select pruebas.como_dueno_sistema();
update private.admin_invitations set created_at = created_at - interval '3 hours' where email = 'ana@prueba.test';
select pruebas.limpiar();
update private.account_security set mailbox_proven_at = clock_timestamp() - interval '61 minutes'
  where profile_id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_mailbox_proof',
  'una prueba de hace 61 minutos ya venció');
update private.account_security set mailbox_proven_at = clock_timestamp() - interval '59 minutes'
  where profile_id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1'), p_factor => gen_random_uuid()),
  'needs_code', 'una de hace 59 minutos vale; y el factor tiene que ser el que el servidor dio de alta en ese navegador');
update private.account_security set mailbox_proven_at = clock_timestamp() - interval '30 minutes', mailbox_proven_email = 'otra@prueba.test'
  where profile_id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_mailbox_proof',
  'una prueba hecha con otro correo no cuenta para este');
update private.account_security set mailbox_proven_email = 'ana@prueba.test'
  where profile_id = 'a0000000-0000-0000-0000-000000000001';

-- La sesión con la que se acepta, rota de una en una. Cada vez vuelve a su lugar.
update auth.sessions set aal = 'aal1' where id = pruebas.sesion('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_code', 'la sesión tiene que estar en segundo nivel');
select isnt_empty(
  $$select 1 from auth.sessions s join private.app_sessions x on x.session_id = s.id
    where s.id = pruebas.sesion('a0000000-0000-0000-0000-000000000001')$$,
  'y un rechazo no le cierra la sesión a nadie: solo aceptar la cierra');
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
update auth.sessions set not_after = clock_timestamp() - interval '1 second' where id = pruebas.sesion('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_code', 'y viva');
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
delete from private.app_sessions where session_id = pruebas.sesion('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_code', 'y ser de las que abrió la aplicación');
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
update auth.mfa_factors set status = 'unverified' where id = pruebas.factor('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_code', 'el factor tiene que estar verificado');
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
update auth.mfa_factors set factor_type = 'phone', phone = '+5215500000000' where id = pruebas.factor('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_code', 'y ser de aplicación de códigos');
update auth.mfa_factors set factor_type = 'totp', phone = null where id = pruebas.factor('a0000000-0000-0000-0000-000000000001');
update auth.mfa_factors set user_id = 'a0000000-0000-0000-0000-000000000004' where id = pruebas.factor('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_code', 'y ser de esa misma cuenta');
update auth.mfa_factors set user_id = 'a0000000-0000-0000-0000-000000000001' where id = pruebas.factor('a0000000-0000-0000-0000-000000000001');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '16 minutes'
  where session_id = pruebas.sesion('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_code', 'y el código, de hace menos de 15 minutos');
update auth.mfa_amr_claims set authentication_method = 'password', updated_at = clock_timestamp()
  where session_id = pruebas.sesion('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_code', 'y de la aplicación de códigos, no la contraseña');
delete from auth.mfa_amr_claims where session_id = pruebas.sesion('a0000000-0000-0000-0000-000000000001');
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1'),
    p_session => pruebas.sesion('c0000000-0000-0000-0000-000000000002')),
  'needs_code', 'la sesión de otra persona, aunque esté verificada, no sirve');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1'), p_session => gen_random_uuid()),
  'needs_code', 'ni una sesión que no existe, aunque la cuenta tenga otra verificada');
update private.app_sessions set profile_id = 'a0000000-0000-0000-0000-000000000004'
  where session_id = pruebas.sesion('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_code',
  'ni una sesión anotada a nombre de otra cuenta');
update private.app_sessions set profile_id = 'a0000000-0000-0000-0000-000000000001'
  where session_id = pruebas.sesion('a0000000-0000-0000-0000-000000000001');
update auth.sessions set user_id = 'a0000000-0000-0000-0000-000000000004' where id = pruebas.sesion('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_code',
  'ni una que en Auth es de otra cuenta');
update auth.sessions set user_id = 'a0000000-0000-0000-0000-000000000001' where id = pruebas.sesion('a0000000-0000-0000-0000-000000000001');
update auth.mfa_amr_claims set updated_at = clock_timestamp() + interval '6 minutes'
  where session_id = pruebas.sesion('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'needs_code',
  'ni un código fechado seis minutos adelante');
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');

-- La cuenta de quien acepta.
update auth.users set email_confirmed_at = null where id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'ineligible', 'sin el correo confirmado no se acepta');
update auth.users set email_confirmed_at = now(), is_sso_user = true where id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'ineligible', 'ni una cuenta de acceso federado');
select isnt_empty(
  $$select 1 from auth.sessions s join private.app_sessions x on x.session_id = s.id
    where s.id = pruebas.sesion('a0000000-0000-0000-0000-000000000001')$$,
  'y quien no puede aceptar conserva su sesión');
update auth.users set is_sso_user = false where id = 'a0000000-0000-0000-0000-000000000001';
select pruebas.suspender('a0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'ineligible', 'ni una cuenta suspendida');
select pruebas.como_dueno_sistema();
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = 'a0000000-0000-0000-0000-000000000001';
select pruebas.limpiar();
select pruebas.como_sistema();
select is(private.accept_admin_invitation(pruebas.huella('ana-1'), pruebas.factor('a0000000-0000-0000-0000-000000000001'), null),
  'ineligible', 'y el sistema no acepta invitaciones');
select pruebas.limpiar();

-- El correo de la cuenta tiene que ser el invitado.
update auth.users set email = 'ana2@prueba.test' where id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'no_invitation',
  'si el correo de la cuenta ya no es el invitado, no hay invitación que aceptar');
select isnt_empty(
  $$select 1 from auth.sessions s join private.app_sessions x on x.session_id = s.id
    where s.id = pruebas.sesion('a0000000-0000-0000-0000-000000000001')$$,
  'y quien no tiene invitación que aceptar conserva su sesión');
update auth.users set email = 'ana@prueba.test' where id = 'a0000000-0000-0000-0000-000000000001';
select pruebas.como_dueno_sistema();
update private.admin_invitations set profile_id = 'a0000000-0000-0000-0000-000000000004' where email = 'ana@prueba.test' and revoked_at is null;
select pruebas.limpiar();
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'no_invitation',
  'ni si la invitación apunta a otra cuenta');
select pruebas.como_dueno_sistema();
update private.admin_invitations set profile_id = 'a0000000-0000-0000-0000-000000000001', expires_at = clock_timestamp() - interval '1 second'
  where email = 'ana@prueba.test' and revoked_at is null;
select pruebas.limpiar();
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'no_invitation', 'una invitación caducada no se acepta');
select ok((pruebas.invitacion_viva('ana@prueba.test')).id is not null, 'y aceptar no la revoca: sigue ahí hasta que alguien reinvite');
select pruebas.como_dueno_sistema();
update private.admin_invitations set expires_at = clock_timestamp() + interval '1 day' where email = 'ana@prueba.test' and revoked_at is null;
select pruebas.limpiar();

-- Quien invitó tiene que seguir siendo del equipo, con configuración.
select pruebas.como_dueno_sistema();
delete from private.admin_factors where profile_id = 'c0000000-0000-0000-0000-000000000001';
select pruebas.limpiar();
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-1')), 'inviter_lost_config',
  'si quien invitó ya no tiene su factor atado, la invitación no se acepta');
select isnt_empty(
  $$select 1 from auth.sessions s join private.app_sessions x on x.session_id = s.id
    where s.id = pruebas.sesion('a0000000-0000-0000-0000-000000000001')$$,
  'y aunque la invitación se revoque, a quien la traía no se le cierra la sesión');
select results_eq(
  $$select i.revoked_at is not null, i.revoked_by, i.accepted_at is null from private.admin_invitations i where i.email = 'ana@prueba.test'$$,
  $$values (true, null::uuid, true)$$,
  'y queda revocada, sin persona que la revoque');
select ok(
  not exists (select 1 from private.admin_factors f where f.profile_id = 'a0000000-0000-0000-0000-000000000001')
    and not exists (select 1 from public.admin_capabilities c where c.profile_id = 'a0000000-0000-0000-0000-000000000001'),
  'ninguno de los rechazos de arriba dejó atadura ni capacidades');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');

-- Las otras dos maneras de dejar de ser quien puede invitar. Cada vez: invitación nueva,
-- prueba del buzón y factor verificado, para que lo único roto sea quien invitó.
select pruebas.pide('c0000000-0000-0000-0000-000000000003', $$private.invite_admin('ana@prueba.test', '{support}')$$);
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-b'));
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
select pruebas.suspender('c0000000-0000-0000-0000-000000000003');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-b')), 'inviter_lost_config',
  'si quien invitó está suspendido, la invitación no se acepta');
select pruebas.como_dueno_sistema();
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = 'c0000000-0000-0000-0000-000000000003';
select pruebas.limpiar();
select pruebas.pide('c0000000-0000-0000-0000-000000000003', $$private.invite_admin('ana@prueba.test', '{support}')$$);
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-c'));
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
select pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.grant_capability('c0000000-0000-0000-0000-000000000003', 'support')$$);
select pruebas.como_dueno_sistema();
update public.admin_capabilities set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000001'
  where profile_id = 'c0000000-0000-0000-0000-000000000003' and capability = 'config';
select pruebas.limpiar();
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-c')), 'inviter_lost_config',
  'ni si le quitaron la configuración por fuera de la función, aunque conserve otra capacidad');
select pruebas.como_dueno_sistema();
update public.admin_capabilities set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000001'
  where profile_id = 'c0000000-0000-0000-0000-000000000003' and capability = 'support';
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003', $$private.invite_admin('x@prueba.test', '{support}')$$),
  'forbidden', 'y quien tuvo configuración y ya no la tiene, no invita');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000003', 'config');
select pruebas.equipar('c0000000-0000-0000-0000-000000000003');

-- Ahora sí. Antes, lo que tiene que desaparecer al aceptar: otro factor y otra sesión.
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('ana@prueba.test', '{support,content}')$$),
  'invited_existing', '(se le invita de nuevo)');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-2'));
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
select pruebas.verificar('a0000000-0000-0000-0000-000000000001', 'fa000000-0000-0000-0000-00000000000a', '5e000000-0000-0000-0000-00000000000a');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-2')), 'accepted', 'con todo en su lugar, se acepta');
select results_eq(
  $$select f.factor_id, f.bound_email from private.admin_factors f where f.profile_id = 'a0000000-0000-0000-0000-000000000001'$$,
  $$values (pruebas.factor('a0000000-0000-0000-0000-000000000001'), 'ana@prueba.test')$$,
  'queda atado el factor de esa sesión, con el correo con el que aceptó');
select results_eq(
  $$select c.capability::text, c.granted_by, c.revoked_at is null from public.admin_capabilities c
    where c.profile_id = 'a0000000-0000-0000-0000-000000000001' order by 1$$,
  $$values ('content', 'c0000000-0000-0000-0000-000000000001'::uuid, true), ('support', 'c0000000-0000-0000-0000-000000000001'::uuid, true)$$,
  'recibe las capacidades de la invitación, dadas por quien invitó');
select results_eq(
  $$select i.accepted_by, i.accepted_at is not null, i.revoked_at is null from private.admin_invitations i
    where i.email = 'ana@prueba.test' and i.accepted_at is not null$$,
  $$values ('a0000000-0000-0000-0000-000000000001'::uuid, true, true)$$,
  'la invitación queda aceptada');
select is((select s.mailbox_ticket from private.account_security s where s.profile_id = 'a0000000-0000-0000-0000-000000000001'),
  null, 'el resguardo se gasta');
select results_eq(
  $$select m.id from auth.mfa_factors m where m.user_id = 'a0000000-0000-0000-0000-000000000001'$$,
  $$values (pruebas.factor('a0000000-0000-0000-0000-000000000001'))$$,
  'el otro factor de la cuenta desaparece');
-- Todas sus sesiones, también la que aceptó: existía antes de la atadura, y una copia de su
-- cookie pasaría la puerta sin haber dado un código después de atar.
select is_empty(
  $$select s.id from auth.sessions s where s.user_id = 'a0000000-0000-0000-0000-000000000001'$$,
  'y todas sus sesiones se cierran, también aquella con la que aceptó');
select is_empty(
  $$select x.session_id from private.app_sessions x where x.profile_id = 'a0000000-0000-0000-0000-000000000001'$$,
  'también en lo anotado');
select is_empty(
  $$select 1 from auth.mfa_amr_claims c where c.session_id = pruebas.sesion('a0000000-0000-0000-0000-000000000001')$$,
  'y con ellas, lo que Auth anotó de su verificación');
select ok(not pruebas.tiene('a0000000-0000-0000-0000-000000000001', 'support'), 'con la sesión con la que aceptó no pasa la puerta');
select ok(not private.team_session('a0000000-0000-0000-0000-000000000001', pruebas.sesion('a0000000-0000-0000-0000-000000000001')), 'ni preguntándole a la puerta por ella');
select isnt_empty(
  $$select 1 from auth.mfa_factors m join private.admin_factors f on f.factor_id = m.id and f.profile_id = m.user_id
    where m.user_id = 'a0000000-0000-0000-0000-000000000001' and m.status = 'verified' and m.factor_type = 'totp'$$,
  'el factor que quedó atado sigue en Auth, verificado: cerrar las sesiones no lo toca');
-- Entra de nuevo y da su código: esa sesión es otra, y nace después de la atadura.
select pruebas.verificar('a0000000-0000-0000-0000-000000000001', null, '5e000000-0000-0000-0000-0000000000b1');
select ok(private.team_session('a0000000-0000-0000-0000-000000000001', '5e000000-0000-0000-0000-0000000000b1'),
  'la sesión nueva, verificada con el factor atado, pasa la puerta');
select ok(not private.team_session('a0000000-0000-0000-0000-000000000001', pruebas.sesion('a0000000-0000-0000-0000-000000000001')),
  'y aquella con la que aceptó sigue sin pasar');
-- (Lo que sigue usa la sesión de pruebas de siempre: se abre de nuevo.)
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
select is(pruebas.pide('a0000000-0000-0000-0000-000000000001', $$private.invite_admin('x@prueba.test', '{support}')$$),
  'forbidden', 'ser del equipo sin configuración no deja invitar');
select ok(pruebas.tiene('a0000000-0000-0000-0000-000000000001', 'support'), 'entrando de nuevo y dando su código, pasa la puerta con su capacidad');
select ok(not pruebas.tiene('a0000000-0000-0000-0000-000000000001', 'config'), 'y solo con las que recibió');
select results_eq(
  $$select action, actor_id from public.audit_log
    where entity_table in ('private.admin_factors', 'public.admin_capabilities')
      and coalesce(new_value ->> 'profile_id', '') = 'a0000000-0000-0000-0000-000000000001' order by id$$,
  $$values ('admin_factors.insert', 'a0000000-0000-0000-0000-000000000001'::uuid),
           ('admin_capabilities.insert', 'a0000000-0000-0000-0000-000000000001'::uuid),
           ('admin_capabilities.insert', 'a0000000-0000-0000-0000-000000000001'::uuid)$$,
  'atar y recibir quedan en la auditoría, a nombre de quien aceptó');
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-2')), 'no_invitation', 'una invitación se acepta una sola vez');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
    $$private.revoke_admin_invitation((select i.id from pruebas.aceptadas('ana@prueba.test') i))$$),
  'not_found', 'y una aceptada ya no se revoca');
select pruebas.como_dueno_sistema();
insert into private.admin_invitations (kind, email, capabilities, created_at, expires_at)
values ('grant', 'ana@prueba.test', '{finance}', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day');
select pruebas.limpiar();
select is(pruebas.aceptar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-2')), 'already_bound',
  'quien ya tiene su factor atado no acepta otra invitación');
select pruebas.como_dueno_sistema();
update private.admin_invitations set revoked_at = now() where email = 'ana@prueba.test' and accepted_at is null and revoked_at is null;
select pruebas.limpiar();

-- Un reclamo de alguien del equipo: conserva su factor atado y queda en la auditoría.
select is(pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-3')), 'already_claimed', 'alguien del equipo recupera su contraseña');
select ok(exists (select 1 from auth.mfa_factors m where m.id = pruebas.factor('a0000000-0000-0000-0000-000000000001'))
    and exists (select 1 from private.admin_factors f where f.profile_id = 'a0000000-0000-0000-0000-000000000001'),
  'con el buzón solo no se le quita el factor atado');
select results_eq(
  $$select actor_id, actor_kind, category::text, entity_table, entity_id from public.audit_log where action = 'account.claimed' order by id$$,
  $$values ('a0000000-0000-0000-0000-000000000001'::uuid, 'user', 'access', 'public.profiles', 'a0000000-0000-0000-0000-000000000001')$$,
  'y ese reclamo, solo el de quien tiene capacidades, deja su renglón');

-- ---------------------------------------------------------------------------------------
-- Dar una capacidad: solo a quien ya tiene su factor atado.

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.grant_capability('a0000000-0000-0000-0000-000000000001', null)$$),
  'invalid', 'sin capacidad no hay nada que dar');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.grant_capability('a0000000-0000-0000-0000-000000000002', 'support')$$),
  'not_member', 'a quien no tiene su factor atado no se le da nada: se le invita');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.grant_capability(gen_random_uuid(), 'support')$$),
  'ineligible', 'ni a una cuenta que no existe');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.grant_capability('a0000000-0000-0000-0000-000000000001', 'support')$$),
  'already_has', 'ni la que ya tiene');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.grant_capability('a0000000-0000-0000-0000-000000000001', 'finance')$$),
  'granted', 'a alguien del equipo se le da otra capacidad sin invitación');
select is(
  (select c.granted_by from public.admin_capabilities c
   where c.profile_id = 'a0000000-0000-0000-0000-000000000001' and c.capability = 'finance' and c.revoked_at is null),
  'c0000000-0000-0000-0000-000000000001'::uuid, 'queda dada por quien la dio');
select pruebas.suspender('a0000000-0000-0000-0000-000000000001');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.grant_capability('a0000000-0000-0000-0000-000000000001', 'config')$$),
  'ineligible', 'a una cuenta suspendida no se le da nada');
select pruebas.como_dueno_sistema();
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = 'a0000000-0000-0000-0000-000000000001';
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Quitar una capacidad.

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('a0000000-0000-0000-0000-000000000001', 'config')$$),
  'not_found', 'no se quita la que no tiene');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability(gen_random_uuid(), 'support')$$),
  'not_found', 'ni a quien no existe');
select pruebas.verificar('a0000000-0000-0000-0000-000000000001');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('a0000000-0000-0000-0000-000000000001', 'finance')$$),
  'revoked', 'quien tiene configuración quita una capacidad');
select results_eq(
  $$select c.revoked_by, c.revoked_at is not null from public.admin_capabilities c
    where c.profile_id = 'a0000000-0000-0000-0000-000000000001' and c.capability = 'finance'$$,
  $$values ('c0000000-0000-0000-0000-000000000001'::uuid, true)$$,
  'queda revocada por quien la quitó');
select ok(
  not exists (select 1 from auth.sessions s where s.user_id = 'a0000000-0000-0000-0000-000000000001')
    and not exists (select 1 from private.app_sessions x where x.profile_id = 'a0000000-0000-0000-0000-000000000001'),
  'y a esa persona se le cierran todas las sesiones');
select ok(exists (select 1 from private.admin_factors f where f.profile_id = 'a0000000-0000-0000-0000-000000000001'),
  'le quedan otras capacidades: conserva su factor atado');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('a0000000-0000-0000-0000-000000000001', 'finance')$$),
  'not_found', 'una ya quitada no se quita dos veces');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.grant_capability('a0000000-0000-0000-0000-000000000001', 'finance')$$),
  'granted', 'y se le puede dar de nuevo');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('a0000000-0000-0000-0000-000000000001', 'finance')$$),
  'revoked', '(y quitársela otra vez)');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('a0000000-0000-0000-0000-000000000001', 'content')$$),
  'revoked', '(se le quita otra)');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('a0000000-0000-0000-0000-000000000001', 'support')$$),
  'revoked', 'y la última');
select ok(
  not exists (select 1 from private.admin_factors f where f.profile_id = 'a0000000-0000-0000-0000-000000000001')
    and not exists (select 1 from auth.mfa_factors m where m.user_id = 'a0000000-0000-0000-0000-000000000001'),
  'sin capacidades deja de ser del equipo: pierde la atadura y el factor');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('a0000000-0000-0000-0000-000000000001', pruebas.huella('k'), pruebas.version('a0000000-0000-0000-0000-000000000001'))$$),
  'not_member', 'y ya no hay nada que restablecerle: sus capacidades revocadas no cuentan');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('ana-4'));
select is((select count(*)::int from public.audit_log where action = 'account.claimed'), 1,
  'ni deja renglón su siguiente recuperación de contraseña');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('ana@prueba.test', '{support}')$$),
  'invited_existing', 'y se le puede invitar de nuevo: haber tenido capacidades no la deja fuera');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
    $$private.revoke_admin_invitation((pruebas.invitacion_viva('ana@prueba.test')).id)$$), 'revoked', '(se revoca)');

-- El mínimo de dos con configuración cuenta cuentas activas (RF-712).
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003', $$private.invite_admin('deltres@prueba.test', '{support}')$$),
  'invited_new', '(la tercera persona con configuración invita a alguien)');
select pruebas.suspender('c0000000-0000-0000-0000-000000000003');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('c0000000-0000-0000-0000-000000000002', 'config')$$),
  'min_config', 'con tres personas con configuración y una suspendida, no se le quita a otra');
select pruebas.como_dueno_sistema();
select throws_ok(
  $$update public.admin_capabilities set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000001'
    where profile_id = 'c0000000-0000-0000-0000-000000000002' and capability = 'config'$$,
  '23514', null, 'tampoco escribiendo la tabla como dueño: el disparador cuenta igual');
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = 'c0000000-0000-0000-0000-000000000003';
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003', $$private.revoke_capability('c0000000-0000-0000-0000-000000000003', 'config')$$),
  'revoked', 'con las tres activas, una se la quita a sí misma');
select ok(not exists (select 1 from auth.sessions s where s.user_id = 'c0000000-0000-0000-0000-000000000003'),
  'y se queda sin sesiones, también la que usó para quitársela');
select results_eq(
  $$select i.revoked_at is not null, i.revoked_by from private.admin_invitations i where i.email = 'deltres@prueba.test'$$,
  $$values (true, 'c0000000-0000-0000-0000-000000000003'::uuid)$$,
  'y las invitaciones que ella había hecho quedan revocadas');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('c0000000-0000-0000-0000-000000000002', 'config')$$),
  'min_config', 'pero no se baja de dos');
-- El mínimo es de configuración: otra capacidad de esas dos personas sí se quita, y no se
-- lleva las invitaciones que hicieron.
select pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.grant_capability('c0000000-0000-0000-0000-000000000002', 'support')$$);
select pruebas.pide('c0000000-0000-0000-0000-000000000002', $$private.invite_admin('sigue@prueba.test', '{support}')$$);
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('c0000000-0000-0000-0000-000000000002', 'support')$$),
  'revoked', 'con dos personas con configuración, a una de ellas se le quita otra capacidad');
select ok((pruebas.invitacion_viva('sigue@prueba.test')).id is not null, 'y lo que invitó sigue en pie: conserva configuración');
select pruebas.equipar('c0000000-0000-0000-0000-000000000002');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
    $$private.revoke_admin_invitation((pruebas.invitacion_viva('sigue@prueba.test')).id)$$), 'revoked', '(se revoca)');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('c0000000-0000-0000-0000-000000000001', 'config')$$),
  'min_config', 'ni quitándosela una misma');

-- ---------------------------------------------------------------------------------------
-- Restablecer el segundo factor de otra persona.

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('c0000000-0000-0000-0000-000000000001', pruebas.huella('k'), pruebas.version('c0000000-0000-0000-0000-000000000001'))$$),
  'self', 'nadie se restablece a sí mismo');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', 'private.reset_second_factor(''c0000000-0000-0000-0000-000000000002'', ' || quote_nullable(h) || ', pruebas.version(''c0000000-0000-0000-0000-000000000002''))'),
  'invalid', 'sin la huella del código dictado no se restablece')
from unnest(array[null, '', 'codigo', upper(pruebas.huella('k'))]) as h;
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('a0000000-0000-0000-0000-000000000002', pruebas.huella('k'), pruebas.version('a0000000-0000-0000-0000-000000000002'))$$),
  'not_member', 'a quien no tiene capacidades no hay nada que restablecerle');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor(gen_random_uuid(), pruebas.huella('k'), '0.0')$$),
  'ineligible', 'ni a una cuenta que no existe');
update auth.users set email = 'config2-otro@prueba.test' where id = 'c0000000-0000-0000-0000-000000000002';
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('c0000000-0000-0000-0000-000000000002', pruebas.huella('k'), pruebas.version('c0000000-0000-0000-0000-000000000002'))$$),
  'ineligible', 'si el correo de la cuenta ya no es el de su atadura, no se manda la invitación al nuevo');
update auth.users set email = 'config2@prueba.test' where id = 'c0000000-0000-0000-0000-000000000002';

select pruebas.suspender('c0000000-0000-0000-0000-000000000002');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('c0000000-0000-0000-0000-000000000002', pruebas.huella('k'), pruebas.version('c0000000-0000-0000-0000-000000000002'))$$),
  'ineligible', 'ni se restablece a una cuenta suspendida');
select pruebas.como_dueno_sistema();
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = 'c0000000-0000-0000-0000-000000000002';
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', $$private.invite_admin('deldos@prueba.test', '{support}')$$),
  'invited_new', '(la persona que se va a restablecer había invitado a alguien)');
select pruebas.reclamar('c0000000-0000-0000-0000-000000000002', pruebas.huella('viejo'));
select pruebas.equipar('c0000000-0000-0000-0000-000000000002');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('c0000000-0000-0000-0000-000000000002', pruebas.huella('clave-1'), pruebas.version('c0000000-0000-0000-0000-000000000002'))$$),
  'reset', 'quien tiene configuración restablece a otra persona');
select ok(
  not exists (select 1 from private.admin_factors f where f.profile_id = 'c0000000-0000-0000-0000-000000000002')
    and not exists (select 1 from auth.mfa_factors m where m.user_id = 'c0000000-0000-0000-0000-000000000002')
    and not exists (select 1 from auth.sessions s where s.user_id = 'c0000000-0000-0000-0000-000000000002')
    and not exists (select 1 from private.app_sessions x where x.profile_id = 'c0000000-0000-0000-0000-000000000002'),
  'pierde la atadura, el factor y las sesiones');
select ok(
  (select p.password_reset_required from public.profiles p where p.id = 'c0000000-0000-0000-0000-000000000002')
    and (select s.mailbox_ticket is null from private.account_security s where s.profile_id = 'c0000000-0000-0000-0000-000000000002'),
  'queda con la marca de contraseña prendida y sin resguardo');
select is(
  (select count(*)::int from public.admin_capabilities c where c.profile_id = 'c0000000-0000-0000-0000-000000000002' and c.revoked_at is null),
  1, 'conserva sus capacidades');
select ok(not pruebas.tiene('c0000000-0000-0000-0000-000000000002', 'config'), 'aunque sin atadura no le sirven');
select results_eq(
  $$select i.kind, i.profile_id, i.capabilities::text, i.invited_by, i.handoff, i.handoff_failures,
           i.expires_at = i.created_at + interval '7 days'
    from private.admin_invitations i where i.email = 'config2@prueba.test' and i.revoked_at is null and i.accepted_at is null$$,
  $$values ('rebind', 'c0000000-0000-0000-0000-000000000002'::uuid, '{}', 'c0000000-0000-0000-0000-000000000001'::uuid,
            pruebas.huella('clave-1'), 0, true)$$,
  'y con una invitación de restablecimiento: sin capacidades, con la huella del código dictado');
select is((select i.revoked_at is not null from private.admin_invitations i where i.email = 'deldos@prueba.test'),
  true, 'las invitaciones que ella había hecho quedan revocadas');
select pruebas.como_dueno_sistema();
update private.admin_invitations set revoked_at = now() where email = 'config2@prueba.test' and revoked_at is null and accepted_at is null;
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('config2@prueba.test', '{support}')$$),
  'already_member', 'a quien conserva capacidades sin su factor atado no se le invita: se le restablece');
-- Y una invitación que da capacidades, dirigida a quien ya las tiene, no le devuelve la
-- atadura sin el código dictado: puede pasar si alguien cambia su correo al de una invitación.
select pruebas.como_dueno_sistema();
insert into private.admin_invitations (kind, email, capabilities, created_at, expires_at)
values ('grant', 'config2@prueba.test', '{finance}', clock_timestamp(), clock_timestamp() + interval '1 day');
select pruebas.limpiar();
select is(pruebas.reclamar('c0000000-0000-0000-0000-000000000002', pruebas.huella('atajo')), 'claimed', '(prueba su buzón)');
select pruebas.verificar('c0000000-0000-0000-0000-000000000002');
select is(pruebas.aceptar('c0000000-0000-0000-0000-000000000002', pruebas.huella('atajo')), 'no_invitation',
  'una invitación que da capacidades no la acepta quien ya tiene alguna');
select ok(
  not exists (select 1 from private.admin_factors f where f.profile_id = 'c0000000-0000-0000-0000-000000000002')
    and (select count(*)::int from private.admin_invitations i where i.email = 'config2@prueba.test' and i.revoked_at is null and i.accepted_at is null) = 0,
  'no queda atada, y esa invitación queda revocada');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('c0000000-0000-0000-0000-000000000002', pruebas.huella('clave-1'), pruebas.version('c0000000-0000-0000-0000-000000000002'))$$),
  'reset', '(se le restablece de nuevo, con el mismo código)');

-- Volver: buzón, factor nuevo y el código dictado.
select is(pruebas.aceptar('c0000000-0000-0000-0000-000000000002', pruebas.huella('viejo'), pruebas.huella('clave-1')), 'ineligible',
  'con la marca prendida no se acepta: primero el buzón');
select is(pruebas.reclamar('c0000000-0000-0000-0000-000000000002', pruebas.huella('nuevo')), 'claimed', 'recupera su contraseña desde su correo');
select pruebas.verificar('c0000000-0000-0000-0000-000000000002');
select is(pruebas.aceptar('c0000000-0000-0000-0000-000000000002', pruebas.huella('nuevo')), 'needs_handoff', 'sin el código dictado no vuelve');
select is(pruebas.aceptar('c0000000-0000-0000-0000-000000000002', pruebas.huella('nuevo'), pruebas.huella('otra')), 'needs_handoff', 'ni con otro');
select is(pruebas.aceptar('c0000000-0000-0000-0000-000000000002', pruebas.huella('nuevo'), 'clave-1'), 'needs_handoff', 'ni con el código sin su huella');
select is((pruebas.invitacion_viva('config2@prueba.test')).handoff_failures, 3, 'cada fallo se cuenta');
select is(pruebas.aceptar('c0000000-0000-0000-0000-000000000002', pruebas.huella('otro-resguardo'), pruebas.huella('clave-1')), 'needs_mailbox_proof',
  'el código dictado sin el resguardo tampoco basta');
select is((pruebas.invitacion_viva('config2@prueba.test')).handoff_failures, 3, 'y sin resguardo no se gasta un intento del código');
select isnt_empty(
  $$select 1 from auth.sessions s join private.app_sessions x on x.session_id = s.id
    where s.id = pruebas.sesion('c0000000-0000-0000-0000-000000000002')$$,
  'ni el código dictado equivocado ni la falta del resguardo le cierran la sesión');
select is(pruebas.aceptar('c0000000-0000-0000-0000-000000000002', pruebas.huella('nuevo'), pruebas.huella('clave-1')), 'accepted',
  'con el buzón, el factor nuevo y el código dictado, vuelve');
select is_empty(
  $$select s.id from auth.sessions s where s.user_id = 'c0000000-0000-0000-0000-000000000002'
    union all select x.session_id from private.app_sessions x where x.profile_id = 'c0000000-0000-0000-0000-000000000002'$$,
  'un restablecimiento aceptado también cierra todas sus sesiones');
select ok(not pruebas.tiene('c0000000-0000-0000-0000-000000000002', 'config'), 'y con la sesión con la que lo aceptó no pasa la puerta');
select isnt_empty(
  $$select 1 from auth.mfa_factors m join private.admin_factors f on f.factor_id = m.id and f.profile_id = m.user_id
    where m.user_id = 'c0000000-0000-0000-0000-000000000002' and m.status = 'verified' and m.factor_type = 'totp'$$,
  'su factor nuevo queda atado y verificado en Auth');
select pruebas.verificar('c0000000-0000-0000-0000-000000000002');
select ok(pruebas.tiene('c0000000-0000-0000-0000-000000000002', 'config'), 'entrando de nuevo y dando su código, su capacidad vuelve a servirle');
select is(
  (select count(*)::int from public.admin_capabilities c where c.profile_id = 'c0000000-0000-0000-0000-000000000002'),
  2, 'sin recibir ninguna capacidad nueva: las dos filas que ya tenía, una de ellas revocada');

-- Cinco códigos equivocados gastan la invitación.
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('c0000000-0000-0000-0000-000000000002', pruebas.huella('clave-2'), pruebas.version('c0000000-0000-0000-0000-000000000002'))$$),
  'reset', '(se le restablece otra vez)');
select pruebas.reclamar('c0000000-0000-0000-0000-000000000002', pruebas.huella('nuevo-2'));
select pruebas.verificar('c0000000-0000-0000-0000-000000000002');
select is(
  (select count(*)::int from generate_series(1, 5) as n
   where pruebas.aceptar('c0000000-0000-0000-0000-000000000002', pruebas.huella('nuevo-2'), pruebas.huella('mala-' || n)) = 'needs_handoff'),
  5, 'cinco códigos equivocados');
select is(pruebas.aceptar('c0000000-0000-0000-0000-000000000002', pruebas.huella('nuevo-2'), pruebas.huella('clave-2')), 'no_invitation',
  'y el correcto ya no sirve: la invitación quedó revocada');

-- Restablecer por segunda vez, ya sin atadura: el correo sale de su última invitación.
select pruebas.como_dueno_sistema();
insert into private.admin_invitations (kind, email, profile_id, capabilities, handoff, created_at, expires_at, revoked_at)
values ('rebind', 'muy-viejo@prueba.test', 'c0000000-0000-0000-0000-000000000002', '{}', pruebas.huella('v'),
        now() - interval '30 days', now() - interval '23 days', now() - interval '29 days');
select pruebas.limpiar();
update auth.users set email = 'config2-otro@prueba.test' where id = 'c0000000-0000-0000-0000-000000000002';
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('c0000000-0000-0000-0000-000000000002', pruebas.huella('clave-3'), pruebas.version('c0000000-0000-0000-0000-000000000002'))$$),
  'ineligible', 'sin atadura, el correo se compara con el de su última invitación');
update auth.users set email = 'config2@prueba.test' where id = 'c0000000-0000-0000-0000-000000000002';
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('c0000000-0000-0000-0000-000000000002', pruebas.huella('clave-3'), pruebas.version('c0000000-0000-0000-0000-000000000002'))$$),
  'reset', 'y con el mismo correo se restablece de nuevo');

-- El ataque que tumbó el primer diseño: restablecer, quitar la última capacidad, y aceptar.
select pruebas.reclamar('c0000000-0000-0000-0000-000000000002', pruebas.huella('nuevo-3'));
select pruebas.verificar('c0000000-0000-0000-0000-000000000002');
select pruebas.equipar('c0000000-0000-0000-0000-000000000003');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000003', 'config');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.revoke_capability('c0000000-0000-0000-0000-000000000002', 'config')$$),
  'revoked', 'a la persona restablecida se le quita su última capacidad');
select is((select count(*)::int from private.admin_invitations i
           where i.profile_id = 'c0000000-0000-0000-0000-000000000002' and i.revoked_at is null and i.accepted_at is null),
  0, 'con ella se va su invitación de restablecimiento');
select is(pruebas.aceptar('c0000000-0000-0000-0000-000000000002', pruebas.huella('nuevo-3'), pruebas.huella('clave-3')), 'no_invitation',
  'y ya no tiene invitación que aceptar');
select ok(
  not exists (select 1 from private.admin_factors f where f.profile_id = 'c0000000-0000-0000-0000-000000000002')
    and not exists (select 1 from public.admin_capabilities c where c.profile_id = 'c0000000-0000-0000-0000-000000000002' and c.revoked_at is null),
  'no queda atada ni recupera nada');

-- Una de restablecimiento que sobrevive a su razón de ser tampoco da nada.
select pruebas.como_dueno_sistema();
insert into private.admin_invitations (kind, email, profile_id, capabilities, handoff, created_at, expires_at)
values ('rebind', 'config2@prueba.test', 'c0000000-0000-0000-0000-000000000002', '{}', pruebas.huella('clave-4'),
        clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day');
select pruebas.limpiar();
select is(pruebas.aceptar('c0000000-0000-0000-0000-000000000002', pruebas.huella('nuevo-3'), pruebas.huella('clave-4')), 'no_invitation',
  'una invitación de restablecimiento para quien ya no tiene capacidades no se acepta');
select is((select count(*)::int from private.admin_invitations i where i.email = 'config2@prueba.test' and i.revoked_at is null and i.accepted_at is null),
  0, 'y queda revocada');

-- ---------------------------------------------------------------------------------------
-- El arranque y la emergencia: solo el dueño de la base, declarado sistema.

select pruebas.como_sistema();
select throws_ok($$select private.system_invite_admin('arranque@prueba.test', '{config}')$$, '42501', null,
  'el servidor no ejecuta el arranque');
select throws_ok($$select private.system_reset_second_factor('c0000000-0000-0000-0000-000000000001', pruebas.huella('e'), null)$$, '42501', null,
  'ni la emergencia');
select pruebas.como_dueno();
select throws_ok($$select private.system_invite_admin('arranque@prueba.test', '{config}')$$,
  '42501', 'private.system_invite_admin(): declare the system actor first',
  'el dueño, sin declararse sistema, tampoco: la auditoría tiene que decir quién fue');
select throws_ok($$select private.system_reset_second_factor('c0000000-0000-0000-0000-000000000001', pruebas.huella('e'), null)$$,
  '42501', 'private.system_reset_second_factor(): declare the system actor first',
  'en ninguna de las dos');
select pruebas.como_dueno_sistema();
select is(private.system_invite_admin('arranque@prueba.test', '{config}'), 'invited_new', 'el dueño, declarado sistema, deja una invitación de arranque');
select is((pruebas.invitacion_viva('arranque@prueba.test')).invited_by, null, 'que no tiene quién invitó');
select pruebas.alta('e0000000-0000-0000-0000-000000000001', 'arranque@prueba.test');
select pruebas.confirmar('e0000000-0000-0000-0000-000000000001');
select is(pruebas.reclamar('e0000000-0000-0000-0000-000000000001'), 'claimed', '(la persona completa su registro, sin resguardo)');
select pruebas.verificar('e0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('e0000000-0000-0000-0000-000000000001', pruebas.huella('arr')), 'needs_mailbox_proof',
  'la invitación de arranque pide la misma prueba del buzón que cualquiera');
select pruebas.reclamar('e0000000-0000-0000-0000-000000000001', pruebas.huella('arr'));
select ok(not exists (select 1 from auth.mfa_factors m where m.user_id = 'e0000000-0000-0000-0000-000000000001'),
  'al probarlo pierde el factor que tenía, aunque la invitación sea anterior a su cuenta');
select pruebas.verificar('e0000000-0000-0000-0000-000000000001');
select is(pruebas.aceptar('e0000000-0000-0000-0000-000000000001', pruebas.huella('arr')), 'accepted', 'y con ella se acepta');
select results_eq(
  $$select c.capability::text, c.granted_by from public.admin_capabilities c where c.profile_id = 'e0000000-0000-0000-0000-000000000001'$$,
  $$values ('config', null::uuid)$$,
  'la capacidad queda sin quién la dio: fue el arranque');
select ok(not pruebas.tiene('e0000000-0000-0000-0000-000000000001', 'config'), 'también en el arranque la sesión con la que aceptó se cierra');
select isnt_empty(
  $$select 1 from auth.mfa_factors m join private.admin_factors f on f.factor_id = m.id and f.profile_id = m.user_id
    where m.user_id = 'e0000000-0000-0000-0000-000000000001' and m.status = 'verified' and m.factor_type = 'totp'$$,
  'y su factor queda atado y verificado en Auth');
select pruebas.verificar('e0000000-0000-0000-0000-000000000001');
select ok(pruebas.tiene('e0000000-0000-0000-0000-000000000001', 'config'), 'y entrando de nuevo, pasa la puerta');

select pruebas.como_dueno_sistema();
select is(private.system_reset_second_factor('e0000000-0000-0000-0000-000000000001', pruebas.huella('emergencia'), 'Otro@Prueba.Test '),
  'reset', 'la emergencia restablece a quien haga falta, hacia el correo que el dueño escriba');
select results_eq(
  $$select i.kind, i.email, i.invited_by from private.admin_invitations i
    where i.profile_id = 'e0000000-0000-0000-0000-000000000001' and i.revoked_at is null and i.accepted_at is null$$,
  $$values ('rebind', 'otro@prueba.test', null::uuid)$$,
  'deja la invitación de restablecimiento, sin persona que la haya hecho');
select is(private.system_reset_second_factor('e0000000-0000-0000-0000-000000000001', pruebas.huella('emergencia-2'), null),
  'reset', 'sin correo escrito usa el de la cuenta');
select is((select i.email from private.admin_invitations i
           where i.profile_id = 'e0000000-0000-0000-0000-000000000001' and i.revoked_at is null and i.accepted_at is null),
  'arranque@prueba.test', 'y revoca la anterior');
select is(private.system_invite_admin('otro-mas@prueba.test', '{support}'), 'invited_new', '(una invitación viva a otro correo)');
select is(private.system_reset_second_factor('e0000000-0000-0000-0000-000000000001', pruebas.huella('emergencia-3'), 'otro-mas@prueba.test'),
  'reset', 'restablecer hacia un correo que ya tenía una invitación viva la sustituye');
select results_eq(
  $$select i.kind from private.admin_invitations i where i.email = 'otro-mas@prueba.test' and i.revoked_at is null and i.accepted_at is null$$,
  $$values ('rebind')$$, 'queda una sola viva para ese correo');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Los parámetros. Va al final porque cambia, dentro de esta transacción, de dónde salen.

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
set local client_min_messages to error;
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');

insert into pruebas.parametro_falso values ('VIGENCIA_INVITACION_DIAS', null);
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('param@prueba.test', '{support}')$$),
  'unavailable', 'sin VIGENCIA_INVITACION_DIAS no se invita');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('e0000000-0000-0000-0000-000000000001', pruebas.huella('p'), pruebas.version('e0000000-0000-0000-0000-000000000001'))$$),
  'unavailable', 'ni se restablece');
update pruebas.parametro_falso set value = '2147483647';
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('param@prueba.test', '{support}')$$),
  'unavailable', 'y con un plazo que se sale del calendario, tampoco: no lanza');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('c0000000-0000-0000-0000-000000000003', pruebas.huella('p'), pruebas.version('c0000000-0000-0000-0000-000000000003'))$$),
  'unavailable', 'ni al restablecer');
select ok(exists (select 1 from private.admin_factors f where f.profile_id = 'c0000000-0000-0000-0000-000000000003'),
  'y no le quitó nada a esa persona');
delete from pruebas.parametro_falso;

insert into pruebas.parametro_falso values ('VIGENCIA_CODIGO_RECIENTE_MINUTOS', null);
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('', '{support}')$$),
  'needs_fresh_code', 'sin VIGENCIA_CODIGO_RECIENTE_MINUTOS ningún código es reciente');
update pruebas.parametro_falso set value = '2147483647';
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('', '{support}')$$),
  'invalid', 'con el entero más grande no se desborda');
delete from pruebas.parametro_falso;

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_admin('param@prueba.test', '{support}')$$),
  'invited_new', '(una invitación para probar el plazo del resguardo)');
select pruebas.alta('e0000000-0000-0000-0000-000000000002', 'param@prueba.test');
select pruebas.confirmar('e0000000-0000-0000-0000-000000000002');
select pruebas.reclamar('e0000000-0000-0000-0000-000000000002', pruebas.huella('param'));
select pruebas.verificar('e0000000-0000-0000-0000-000000000002');
insert into pruebas.parametro_falso values ('VIGENCIA_PRUEBA_BUZON_MINUTOS', null);
select is(pruebas.aceptar('e0000000-0000-0000-0000-000000000002', pruebas.huella('param')), 'needs_mailbox_proof',
  'sin VIGENCIA_PRUEBA_BUZON_MINUTOS ninguna prueba vale');
update pruebas.parametro_falso set value = '2147483647';
select is(pruebas.aceptar('e0000000-0000-0000-0000-000000000002', pruebas.huella('param')), 'accepted',
  'y con el entero más grande no se desborda');
delete from pruebas.parametro_falso;

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.reset_second_factor('e0000000-0000-0000-0000-000000000002', pruebas.huella('q'), pruebas.version('e0000000-0000-0000-0000-000000000002'))$$),
  'reset', '(un restablecimiento para probar el límite de códigos)');
select pruebas.reclamar('e0000000-0000-0000-0000-000000000002', pruebas.huella('param-2'));
select pruebas.verificar('e0000000-0000-0000-0000-000000000002');
insert into pruebas.parametro_falso values ('INTENTOS_ANTES_DE_FRENO', null);
select is(pruebas.aceptar('e0000000-0000-0000-0000-000000000002', pruebas.huella('param-2'), pruebas.huella('q')), 'unavailable',
  'sin INTENTOS_ANTES_DE_FRENO no se acepta un restablecimiento, ni con el código correcto');
delete from pruebas.parametro_falso;
select is(pruebas.aceptar('e0000000-0000-0000-0000-000000000002', pruebas.huella('param-2'), pruebas.huella('q')), 'accepted',
  'y con el parámetro en su lugar, sí');

select pruebas.limpiar();
select * from finish();
rollback;
