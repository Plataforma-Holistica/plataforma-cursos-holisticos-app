-- T-104 · La marca de quién fijó la contraseña (RF-101, RF-103). TRD §9.2, esquema §5.1.
-- Nace prendida y solo la apaga private.claim_account(), a nombre de la propia cuenta.
begin;
\ir _ayuda.psql
select plan(45);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'alumna-cuenta@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'otra-cuenta@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000003', 'suspendida-cuenta@prueba.test');

-- ---------------------------------------------------------------------------------------
-- Nace prendida, también si quien inserta dice otra cosa.

select pruebas.como_dueno();
select is(
  (select bool_and(password_reset_required) from public.profiles
   where id::text like 'a0000000-0000-0000-0000-00000000000_'),
  true, 'una cuenta nueva nace con la marca prendida');
insert into public.profiles (id, password_reset_required)
  values ('a0000000-0000-0000-0000-000000000008', false);
select is(
  (select password_reset_required from public.profiles where id = 'a0000000-0000-0000-0000-000000000008'),
  true, 'el dueño de la tabla inserta un perfil con la marca apagada y nace prendida');
select pruebas.como_servicio();
insert into public.profiles (id, password_reset_required)
  values ('a0000000-0000-0000-0000-000000000009', false);
select pruebas.como_dueno();
select is(
  (select password_reset_required from public.profiles where id = 'a0000000-0000-0000-0000-000000000009'),
  true, 'el servidor inserta un perfil con la marca apagada y nace prendida');

-- ---------------------------------------------------------------------------------------
-- Nadie la apaga escribiendo la columna.

select ok(
  not has_column_privilege(r, 'public.profiles', 'password_reset_required', 'update'),
  r || ' no tiene permiso de escribir la marca')
from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r;

select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$update public.profiles set password_reset_required = false
    where id = 'a0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'el servidor no apaga la marca con un update');
select throws_ok(
  $$insert into public.profiles (id) values ('a0000000-0000-0000-0000-000000000001')
    on conflict (id) do update set password_reset_required = false$$,
  '42501', null, 'ni con un insert que actualiza al chocar');
select throws_ok(
  $$update public.profiles set display_name = 'Ana', password_reset_required = false
    where id = 'a0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'ni escondida entre otras columnas');
select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$update public.profiles set password_reset_required = false
    where id = 'a0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'la alumna no apaga su propia marca con su sesión');
select is(
  (select password_reset_required from public.profiles),
  true, 'aunque sí la puede leer');
select pruebas.como_visitante();
select throws_ok(
  $$update public.profiles set password_reset_required = false$$,
  '42501', null, 'el visitante tampoco');

-- Ni el dueño de la tabla con un update suelto. (Con el ajuste puesto a mano el dueño sí
-- podría: es el dueño, y también puede quitar el disparador. El guardián cuida de un
-- descuido, no del dueño.)
select pruebas.como_dueno();
select throws_ok(
  $$update public.profiles set password_reset_required = false
    where id = 'a0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'el dueño de la tabla no apaga la marca con un update');
-- Se le devuelve al servidor el permiso de tabla, para probar la segunda capa sola.
grant update on public.profiles to app_service;
select isnt_empty(
  $$select * from private.schema_violations()
    where problem = 'password_reset_required writable by app_service' and object_name = 'public.profiles'$$,
  'schema_violations() avisa si el servidor recupera el permiso de escribir la marca');
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select set_config('app.claiming_account', 'on', true);
select throws_ok(
  $$update public.profiles set password_reset_required = false
    where id = 'a0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'con el permiso devuelto y el ajuste falsificado, el guardián la sigue cuidando');
select throws_ok(
  $$insert into public.profiles (id) values ('a0000000-0000-0000-0000-000000000001')
    on conflict (id) do update set password_reset_required = false$$,
  '42501', null, 'también si el cambio llega por un insert que actualiza al chocar');
select pruebas.como_dueno();
revoke update on public.profiles from app_service;
-- Una persona con permiso de escribir otra columna de su perfil: el vigilante también avisa.
grant update (status, suspended_for_fraud) on public.profiles to authenticated;
select isnt_empty(
  $$select * from private.schema_violations()
    where problem = 'unexpected column write privilege for authenticated' and object_name = 'public.profiles'$$,
  'schema_violations() avisa si una persona recibe permiso de escribir una columna de más');
revoke update (status, suspended_for_fraud) on public.profiles from authenticated;
grant update (display_name, status, country_code, country_is_self_declared, locale, adult_declared_at,
              suspended_at, suspended_by, suspension_reason, suspended_for_fraud, comment_ban_until,
              deleted_at)
  on public.profiles to app_service;
select is(
  (select bool_and(password_reset_required) from public.profiles
   where id::text like 'a0000000-0000-0000-0000-00000000000_'),
  true, 'después de todos los intentos, la marca sigue prendida en todas las cuentas');

-- ---------------------------------------------------------------------------------------
-- El servidor conserva lo que sí le toca escribir.

select ok(
  has_column_privilege('app_service', 'public.profiles', c, 'update'),
  'app_service sigue pudiendo escribir ' || c)
from unnest(array['display_name', 'status', 'country_code', 'country_is_self_declared', 'locale',
                  'adult_declared_at', 'suspended_at', 'suspended_by', 'suspension_reason',
                  'suspended_for_fraud', 'comment_ban_until', 'deleted_at']) as c;
select ok(
  not has_column_privilege('app_service', 'public.profiles', 'id', 'update')
    and not has_column_privilege('app_service', 'public.profiles', 'created_at', 'update')
    and not has_column_privilege('app_service', 'public.profiles', 'updated_at', 'update'),
  'y no escribe el identificador ni las fechas de la fila');
-- El disparador que mueve updated_at escribe una columna que el servidor ya no tiene
-- concedida: no debe estorbarle.
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select lives_ok(
  $$update public.profiles set display_name = 'Ana' where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'el servidor edita un perfil aunque no tenga permiso sobre updated_at');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- private.claim_account(): la misma cuenta pasa por cada estado.

select ok(
  has_function_privilege('app_service', 'private.claim_account()', 'execute')
    and not has_function_privilege('authenticated', 'private.claim_account()', 'execute')
    and not has_function_privilege('anon', 'private.claim_account()', 'execute'),
  'solo el servidor ejecuta claim_account');

select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select is(private.claim_account(), 'ineligible', 'con el correo sin confirmar no se reclama');
select pruebas.como_dueno();
select pruebas.confirmar('a0000000-0000-0000-0000-000000000001');
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select is(private.claim_account(), 'claimed', 'con el correo confirmado, la cuenta se reclama');
select is(private.claim_account(), 'already_claimed', 'la segunda vez ya estaba reclamada');
select pruebas.como_dueno();
select results_eq(
  $$select id::text, password_reset_required from public.profiles
    where id::text like 'a0000000-0000-0000-0000-00000000000_' order by id$$,
  $$values ('a0000000-0000-0000-0000-000000000001', false),
           ('a0000000-0000-0000-0000-000000000002', true),
           ('a0000000-0000-0000-0000-000000000003', true),
           ('a0000000-0000-0000-0000-000000000008', true),
           ('a0000000-0000-0000-0000-000000000009', true)$$,
  'se apagó la marca de esa cuenta y de ninguna otra');

-- Una cuenta suspendida no se reclama; reactivada, sí.
select pruebas.confirmar('a0000000-0000-0000-0000-000000000003');
select set_config('app.actor_kind', 'system', true);
update public.profiles set status = 'suspended', suspended_at = now(), suspension_reason = 'Prueba'
  where id = 'a0000000-0000-0000-0000-000000000003';
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000003');
select is(private.claim_account(), 'ineligible', 'una cuenta suspendida no se reclama');
select pruebas.como_dueno();
select set_config('app.actor_kind', 'system', true);
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null
  where id = 'a0000000-0000-0000-0000-000000000003';
select pruebas.como_servicio('a0000000-0000-0000-0000-000000000003');
select is(private.claim_account(), 'claimed', 'reactivada, esa misma cuenta sí se reclama');

-- Sin actor, como sistema o a nombre de una cuenta que no existe: nada, y nada cambia.
select pruebas.como_dueno();
select pruebas.confirmar('a0000000-0000-0000-0000-000000000002');
select pruebas.como_servicio();
select is(private.claim_account(), 'ineligible', 'sin actor declarado no se reclama nada');
select pruebas.como_sistema();
select is(private.claim_account(), 'ineligible', 'el sistema no reclama cuentas');
select pruebas.como_servicio('a0000000-0000-0000-0000-0000000000ff');
select is(private.claim_account(), 'ineligible', 'un actor sin perfil no reclama nada');
select pruebas.como_dueno();
select is(
  (select password_reset_required from public.profiles where id = 'a0000000-0000-0000-0000-000000000002'),
  true, 'y la cuenta confirmada que nadie reclamó sigue con la marca prendida');

select pruebas.como_usuario('a0000000-0000-0000-0000-000000000002');
select throws_ok(
  'select private.claim_account()',
  '42501', null, 'una persona no llama a claim_account con su sesión');

select pruebas.limpiar();
select * from finish();
rollback;
