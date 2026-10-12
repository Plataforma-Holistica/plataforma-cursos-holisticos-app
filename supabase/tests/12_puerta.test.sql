-- T-105 · La puerta del equipo (RF-105, RF-106). TRD §9.2, fila «Segundo factor»; esquema §6.2.
-- Segunda entrega de T-105, primera parte.
--
-- Ser del equipo no lo dice el token: lo dice la base, en cada consulta. Hacen falta una
-- capacidad activa, un factor atado a la persona, y una sesión que la aplicación abrió y que
-- Supabase Auth tiene en segundo nivel con ese mismo factor, verificada hace poco. Aquí se
-- rompe cada una de esas condiciones, de una en una, por los dos caminos.
begin;
\ir _ayuda.psql
select plan(77);

select pruebas.alta('c0000000-0000-0000-0000-000000000001', 'config1@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000002', 'config2@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000003', 'config3@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana@prueba.test');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000002', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000003', 'config');

-- ¿Pasa la puerta? Por el camino del usuario: con su token, como en la API de datos. No
-- repara nada: lo que haya en la base es lo que se prueba. El token puede decir otra sesión
-- u otro nivel que los de la base.
create function pruebas.pasa(p_id uuid, p_session text default null, p_aal text default 'aal2') returns boolean
language plpgsql
as $$
declare
  v_passes boolean;
begin
  perform pruebas.limpiar();
  perform set_config('request.jwt.claims',
            json_build_object('sub', p_id, 'role', 'authenticated', 'aal', p_aal,
                              'session_id', coalesce(p_session, pruebas.sesion(p_id)::text))::text, true),
          set_config('role', 'authenticated', true);
  v_passes := private.has_capability('config');
  perform pruebas.limpiar();
  return v_passes;
end
$$;

-- Lo mismo por el camino de servicio: el servidor declara por quién actúa y con qué sesión.
create function pruebas.pasa_servicio(p_id uuid, p_session text default null) returns boolean
language plpgsql
as $$
declare
  v_passes boolean;
begin
  perform pruebas.limpiar();
  perform set_config('app.actor_id', p_id::text, true),
          set_config('app.actor_session', coalesce(p_session, pruebas.sesion(p_id)::text), true),
          set_config('role', 'app_service', true);
  v_passes := private.actor_has_capability('config');
  perform pruebas.limpiar();
  return v_passes;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Estructura.

select ok(
  not has_any_column_privilege('app_service', 'private.admin_factors', 'select, insert, update')
    and not has_table_privilege('app_service', 'private.admin_factors', 'delete')
    and not has_any_column_privilege('authenticated', 'private.admin_factors', 'select, insert, update')
    and not has_any_column_privilege('anon', 'private.admin_factors', 'select, insert, update')
    and not has_any_column_privilege('service_role', 'private.admin_factors', 'select, insert, update')
    and not has_any_column_privilege('supabase_auth_admin', 'private.admin_factors', 'select, insert, update'),
  'nadie tiene permisos sobre la tabla que ata el factor');
select ok(
  not has_function_privilege('app_service', 'private.team_session(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'private.team_session(uuid, uuid)', 'execute')
    and not has_function_privilege('anon', 'private.team_session(uuid, uuid)', 'execute')
    and not has_function_privilege('service_role', 'private.team_session(uuid, uuid)', 'execute')
    and not has_function_privilege('supabase_auth_admin', 'private.team_session(uuid, uuid)', 'execute'),
  'la puerta no se llama desde fuera: nadie le pregunta por la sesión de otro');
select ok(
  not has_function_privilege('app_service', 'private.actor_session()', 'execute')
    and not has_function_privilege('authenticated', 'private.actor_session()', 'execute')
    and not has_function_privilege('anon', 'private.actor_session()', 'execute')
    and not has_function_privilege('service_role', 'private.actor_session()', 'execute')
    and not has_function_privilege('supabase_auth_admin', 'private.actor_session()', 'execute'),
  'ni la función que lee con qué sesión se actúa');
select ok(
  has_function_privilege('authenticated', 'private.has_capability(public.capability)', 'execute')
    and has_function_privilege('app_service', 'private.actor_has_capability(public.capability)', 'execute')
    and not has_function_privilege('anon', 'private.has_capability(public.capability)', 'execute')
    and not has_function_privilege('anon', 'private.actor_has_capability(public.capability)', 'execute'),
  'las dos preguntas de siempre las siguen haciendo los mismos');
select is_empty(
  'select * from private.schema_violations()',
  'private.schema_violations() sigue en cero');
-- Las columnas de Auth que la puerta lee, para que un cambio de Supabase se note aquí.
select has_column('auth', 'sessions', 'aal', 'auth.sessions.aal existe');
select has_column('auth', 'sessions', 'factor_id', 'auth.sessions.factor_id existe');
select has_column('auth', 'sessions', 'not_after', 'auth.sessions.not_after existe');
select has_column('auth', 'mfa_factors', 'factor_type', 'auth.mfa_factors.factor_type existe');
select has_column('auth', 'mfa_amr_claims', 'session_id', 'auth.mfa_amr_claims.session_id existe');
select has_column('auth', 'mfa_amr_claims', 'authentication_method', 'auth.mfa_amr_claims.authentication_method existe');
select has_column('auth', 'mfa_amr_claims', 'updated_at', 'auth.mfa_amr_claims.updated_at existe');
select is(
  private.parameter_value('VIGENCIA_SEGUNDO_FACTOR_HORAS'), '12'::jsonb,
  'la vigencia de una verificación es un parámetro, y arranca en 12 horas');

-- ---------------------------------------------------------------------------------------
-- Atar un factor es un acto administrativo: deja su renglón, y sin autor no ocurre.

select pruebas.como_dueno();
select throws_ok(
  $$insert into private.admin_factors (profile_id, factor_id)
    values ('c0000000-0000-0000-0000-000000000001', pruebas.factor('c0000000-0000-0000-0000-000000000001'))$$,
  '42501', null, 'atar un factor sin autor declarado se rechaza');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select pruebas.equipar('c0000000-0000-0000-0000-000000000002');
select is(
  (select count(*)::int from public.audit_log
   where entity_table = 'private.admin_factors' and action = 'admin_factors.insert' and category = 'access'),
  2, 'cada atadura deja su renglón de auditoría');
select set_config('app.actor_kind', 'system', true);
select throws_ok(
  $$insert into private.admin_factors (profile_id, factor_id)
    values ('c0000000-0000-0000-0000-000000000001', gen_random_uuid())$$,
  '23505', null, 'una persona tiene un solo factor atado');
select throws_ok(
  $$insert into private.admin_factors (profile_id, factor_id)
    values ('a0000000-0000-0000-0000-000000000001', pruebas.factor('c0000000-0000-0000-0000-000000000001'))$$,
  '23505', null, 'y un factor es de una sola persona');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Con todo en su lugar, pasa. Por los dos caminos.

select ok(pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'con capacidad, factor atado y sesión verificada con ese factor: pasa');
select ok(pruebas.pasa_servicio('c0000000-0000-0000-0000-000000000001'),
  'y por el camino de servicio, también');
select pruebas.como_usuario('c0000000-0000-0000-0000-000000000001', 'aal2');
select ok(private.actor_has_capability('config'), 'la pregunta de los disparadores contesta lo mismo con el token');
select ok(not private.has_capability('finance'), 'y solo la capacidad que tiene');
select ok(not private.actor_has_capability('finance'), 'por las dos preguntas');
select pruebas.limpiar();

-- El token no manda. Uno ya emitido sigue diciendo «segundo nivel» un rato después de que
-- la sesión lo perdió: la puerta lee la sesión.
select pruebas.sin_codigo('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001', null, 'aal2'),
  'un token que dice segundo nivel no pasa si la sesión ya no lo tiene');
select ok(not pruebas.pasa_servicio('c0000000-0000-0000-0000-000000000001'),
  'tampoco por el camino de servicio');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select ok(pruebas.pasa('c0000000-0000-0000-0000-000000000001', null, 'aal1'),
  'y un token de antes de dar el código pasa si su sesión ya está verificada: manda la base');

-- ---------------------------------------------------------------------------------------
-- Cada condición, rota de una en una.

-- La capacidad.
select ok(not pruebas.pasa('a0000000-0000-0000-0000-000000000001'),
  'sin capacidad no pasa, aunque no tenga nada más');
select pruebas.equipar('a0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('a0000000-0000-0000-0000-000000000001'),
  'ni con factor atado y sesión verificada: sin capacidad no es del equipo');
select ok(not pruebas.pasa_servicio('a0000000-0000-0000-0000-000000000001'), 'por ningún camino');

-- La atadura.
select set_config('app.actor_kind', 'system', true);
delete from private.admin_factors where profile_id = 'c0000000-0000-0000-0000-000000000001';
select pruebas.limpiar();
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'sin factor atado no pasa, aunque Auth tenga la sesión en segundo nivel');
select ok(not pruebas.pasa_servicio('c0000000-0000-0000-0000-000000000001'), 'por ningún camino');
select is(
  (select count(*)::int from public.audit_log
   where entity_table = 'private.admin_factors' and action = 'admin_factors.delete'),
  1, 'y quitar la atadura también queda en la auditoría');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');

-- El factor de la sesión no es el atado: lo cambió llamando directo a Auth.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
values ('fac70000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-000000000001', 'otro', 'totp', 'verified', now(), now(), 'JBSWY3DPEHPK3PXP');
update auth.sessions set factor_id = 'fac70000-0000-0000-0000-00000000000b'
  where id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'una sesión verificada con otro factor, aunque sea suyo y esté verificado, no pasa');
select ok(not pruebas.pasa_servicio('c0000000-0000-0000-0000-000000000001'), 'por ningún camino');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');

-- El factor atado ya no existe en Auth, o dejó de estar verificado.
update auth.mfa_factors set status = 'unverified' where id = pruebas.factor('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'si el factor atado ya no está verificado en Auth, no pasa');
delete from auth.mfa_factors where id = pruebas.factor('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'ni si Auth ya no lo tiene: la sesión puede seguir apuntando a un factor borrado');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
update auth.mfa_factors set user_id = 'c0000000-0000-0000-0000-000000000002', friendly_name = 'ajeno'
  where id = pruebas.factor('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'ni si el factor atado es de otra cuenta');
update auth.mfa_factors set user_id = 'c0000000-0000-0000-0000-000000000001', friendly_name = 'equipo'
  where id = pruebas.factor('c0000000-0000-0000-0000-000000000001');
update auth.mfa_factors set factor_type = 'webauthn' where id = pruebas.factor('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'ni si no es un factor de aplicación de códigos');
update auth.mfa_factors set factor_type = 'totp' where id = pruebas.factor('c0000000-0000-0000-0000-000000000001');
select ok(pruebas.pasa('c0000000-0000-0000-0000-000000000001'), '(de vuelta en su lugar, pasa)');

-- La sesión: que sea la suya, que la haya abierto la aplicación y que siga viva.
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001',
    pruebas.sesion('c0000000-0000-0000-0000-000000000002')::text),
  'con la sesión de otra persona del equipo no pasa');
select ok(not pruebas.pasa_servicio('c0000000-0000-0000-0000-000000000001',
    pruebas.sesion('c0000000-0000-0000-0000-000000000002')::text),
  'por ningún camino');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001', gen_random_uuid()::text),
  'con una sesión que no existe, tampoco');
-- Su otra sesión: la abrió la aplicación y es suya, pero hoy está en primer nivel. Que
-- tenga una verificada en otro navegador no le sirve a esta, ni que esta misma conserve
-- anotada una verificación de cuando sí lo estuvo.
insert into auth.sessions (id, user_id, aal, created_at, updated_at)
values ('5e510000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-000000000001', 'aal1', now(), now());
insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
values (gen_random_uuid(), '5e510000-0000-0000-0000-00000000000b', 'totp', now(), now());
insert into private.app_sessions (session_id, profile_id)
values ('5e510000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001', '5e510000-0000-0000-0000-00000000000b'),
  'con otra sesión suya que está en primer nivel no pasa, aunque tenga una verificada');
select ok(not pruebas.pasa_servicio('c0000000-0000-0000-0000-000000000001', '5e510000-0000-0000-0000-00000000000b'),
  'por ningún camino');
update private.app_sessions set profile_id = 'a0000000-0000-0000-0000-000000000001'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'una sesión anotada a nombre de otra cuenta no pasa');
delete from private.app_sessions where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'una sesión que la aplicación no abrió no pasa, aunque en Auth esté verificada');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
-- Cada tabla se mira con su propia columna de dueño: una fila mal anotada no abre nada.
update auth.sessions set user_id = 'c0000000-0000-0000-0000-000000000002'
  where id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'una sesión que en Auth es de otra cuenta no pasa, aunque esté anotada a su nombre');
update auth.sessions set user_id = 'c0000000-0000-0000-0000-000000000001', aal = 'aal1'
  where id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'una sesión de primer nivel no pasa, aunque siga apuntando al factor atado');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
update auth.sessions set not_after = clock_timestamp() - interval '1 second'
  where id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'), 'una sesión que ya pasó su fecha tope no pasa');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');

-- Con qué sesión se actúa llega de fuera: lo que no tiene forma de serlo no lanza.
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001', 'no-es-una-sesion'),
  'un token con una sesión que no tiene forma de serlo no pasa, y no lanza');
select ok(not pruebas.pasa_servicio('c0000000-0000-0000-0000-000000000001', 'no-es-una-sesion'),
  'por el camino de servicio, igual');
select ok(not pruebas.pasa_servicio('c0000000-0000-0000-0000-000000000001', ''),
  'y sin sesión declarada no pasa');
select pruebas.como_sistema();
select ok(not private.actor_has_capability('config'), 'el sistema no es del equipo: no pasa por aquí');
select pruebas.limpiar();
-- Los dos caminos no se cruzan. Con una persona en el token, la sesión es la del token:
-- una declarada aparte no la suple. Y la pregunta de la sesión no lee lo declarado.
select set_config('request.jwt.claims',
  json_build_object('sub', 'c0000000-0000-0000-0000-000000000001', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select set_config('app.actor_session', pruebas.sesion('c0000000-0000-0000-0000-000000000001')::text, true);
select set_config('role', 'authenticated', true);
select ok(not private.has_capability('config'),
  'un token sin sesión no pasa, aunque haya una sesión válida declarada aparte');
select pruebas.limpiar();
select set_config('app.actor_id', 'c0000000-0000-0000-0000-000000000001', true);
select set_config('app.actor_session', pruebas.sesion('c0000000-0000-0000-0000-000000000001')::text, true);
select set_config('role', 'app_service', true);
select ok(not private.has_capability('config'),
  'y la pregunta de la sesión del token contesta que no por el camino de servicio: ahí no hay token');
select pruebas.limpiar();

-- La verificación: reciente y del segundo factor.
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '11 hours 59 minutes'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'una verificación de hace menos de VIGENCIA_SEGUNDO_FACTOR_HORAS pasa');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '12 hours 1 minute'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'una de hace más ya no: hay que dar el código otra vez');
select ok(not pruebas.pasa_servicio('c0000000-0000-0000-0000-000000000001'), 'por ningún camino');
-- La hora la pone el reloj de Auth, que puede ir un poco adelantado. Mucho, no.
update auth.mfa_amr_claims set updated_at = clock_timestamp() + interval '1 minute'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'una verificación fechada un minuto adelante pasa: es desfase de relojes');
update auth.mfa_amr_claims set updated_at = clock_timestamp() + interval '1 hour'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'una fechada una hora adelante no: no puede ser de ahora');
update auth.mfa_amr_claims set updated_at = clock_timestamp(), authentication_method = 'password'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'lo que cuenta es la verificación del código, no la de la contraseña');
delete from auth.mfa_amr_claims where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000001');
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'), 'y sin ninguna verificación anotada no pasa');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');

-- La cuenta. Suspender es una sanción, y queda en la auditoría: aquí la pone el sistema.
select set_config('app.actor_kind', 'system', true);
update public.profiles set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba'
  where id = 'c0000000-0000-0000-0000-000000000001';
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'), 'una cuenta suspendida no pasa');
select ok(not pruebas.pasa_servicio('c0000000-0000-0000-0000-000000000001'), 'por ningún camino');
select set_config('app.actor_kind', 'system', true);
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null
  where id = 'c0000000-0000-0000-0000-000000000001';
select set_config('app.claiming_account', 'on', true);
update public.profiles set password_reset_required = true where id = 'c0000000-0000-0000-0000-000000000001';
select set_config('app.claiming_account', '', true);
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'),
  'una cuenta con la marca de contraseña prendida no pasa');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select ok(pruebas.pasa('c0000000-0000-0000-0000-000000000001'), '(de vuelta en su lugar, pasa)');

-- La capacidad revocada corta en el acto, con la sesión y el token intactos.
select pruebas.como_sistema();
update public.admin_capabilities set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000002'
  where profile_id = 'c0000000-0000-0000-0000-000000000001' and capability = 'config';
select pruebas.limpiar();
select ok(not pruebas.pasa('c0000000-0000-0000-0000-000000000001'), 'una capacidad revocada deja de pasar en el acto');
select ok(not pruebas.pasa_servicio('c0000000-0000-0000-0000-000000000001'), 'por ningún camino');
select ok(pruebas.pasa('c0000000-0000-0000-0000-000000000002'), 'y la de la otra persona sigue pasando');

-- ---------------------------------------------------------------------------------------
-- El parámetro. Va al final porque cambia, dentro de esta transacción, de dónde salen los
-- parámetros. Sin él, o con uno que no vale, nadie pasa: la puerta falla cerrada.

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

create function pruebas.pasa_con_vigencia(p_value jsonb) returns boolean
language plpgsql
as $$
declare
  v_passes boolean;
begin
  insert into pruebas.parametro_falso values ('VIGENCIA_SEGUNDO_FACTOR_HORAS', p_value);
  v_passes := pruebas.pasa('c0000000-0000-0000-0000-000000000002');
  delete from pruebas.parametro_falso;
  return v_passes;
end
$$;

-- Los avisos que la puerta deja en el registro cuando le falta su parámetro, aquí son ruido.
set local client_min_messages to error;
select ok(not pruebas.pasa_con_vigencia(null), 'sin VIGENCIA_SEGUNDO_FACTOR_HORAS no pasa nadie');
select ok(not pruebas.pasa_con_vigencia('0'), 'ni con el parámetro en cero');
select ok(not pruebas.pasa_con_vigencia('"12"'), 'ni con un texto en su lugar');
select ok(pruebas.pasa_con_vigencia('1'), 'con una hora, la verificación recién hecha pasa');
select ok(pruebas.pasa_con_vigencia('2147483647'), 'y con el entero más grande no se desborda');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '61 minutes'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000002');
select ok(not pruebas.pasa_con_vigencia('1'), 'con una hora, la de hace 61 minutos ya no pasa');
select ok(pruebas.pasa_con_vigencia('2'), 'y con dos, sí: la ventana sale del parámetro');

-- ---------------------------------------------------------------------------------------
-- Primero la capacidad. Estas preguntas viven en políticas de tablas que lee cualquier
-- cuenta: quien no tiene la capacidad no debe llegar a la puerta, ni a nada de Auth. Aquí la
-- puerta se cambia por una que lanza, para verlo.

create or replace function private.team_session(p_user uuid, p_session uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  raise exception 'la puerta no debía consultarse';
end
$$;
select ok(not pruebas.pasa('a0000000-0000-0000-0000-000000000001'),
  'quien no tiene la capacidad no llega a la puerta: contesta que no sin consultarla');
select throws_ok(
  $$select pruebas.pasa('c0000000-0000-0000-0000-000000000002')$$,
  'P0001', 'la puerta no debía consultarse',
  'y quien sí la tiene, llega');

select pruebas.limpiar();
select * from finish();
rollback;
