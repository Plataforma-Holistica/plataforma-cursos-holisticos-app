-- T-103 · Identidad y permisos: profiles y admin_capabilities.
-- Qué lee, qué escribe y qué se le niega a cada quien (esquema de backend §6.3).
begin;
\ir _ayuda.psql
select plan(32);

-- Personas de la prueba.
select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana@prueba.test');      -- alumna
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto@prueba.test');     -- alumno
select pruebas.alta('c0000000-0000-0000-0000-000000000001', 'config1@prueba.test');  -- configuración
select pruebas.alta('c0000000-0000-0000-0000-000000000002', 'config2@prueba.test');  -- configuración
select pruebas.alta('c0000000-0000-0000-0000-000000000003', 'config3@prueba.test');  -- configuración
select pruebas.alta('50000000-0000-0000-0000-000000000001', 'soporte@prueba.test');  -- soporte

-- El alta en Supabase Auth crea el perfil con el mismo identificador (ADR-15).
select is(
  (select count(*)::int from public.profiles where id::text like '_0000000-0000-0000-0000-00000000000_'),
  6, 'cada alta en auth.users crea su fila en profiles');
select is(
  (select status::text from public.profiles where id = 'a0000000-0000-0000-0000-000000000001'),
  'active', 'el perfil nace activo');

-- Dar una capacidad sin decir quién lo hace no se puede: el cambio y su registro van juntos.
select pruebas.como_dueno();
select throws_ok(
  $$insert into public.admin_capabilities (profile_id, capability)
    values ('c0000000-0000-0000-0000-000000000001', 'config')$$,
  '42501', null, 'dar una capacidad sin autor declarado se rechaza');

select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000002', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000003', 'config');
select pruebas.dar_capacidad('50000000-0000-0000-0000-000000000001', 'support');

select is(
  (select count(*)::int from public.audit_log
   where entity_table = 'public.admin_capabilities' and action = 'admin_capabilities.insert'
     and category = 'access' and actor_kind = 'system'),
  4, 'cada capacidad dada deja su renglón de auditoría');

-- ---------------------------------------------------------------------------------------
-- La alumna: lee y edita solo lo suyo.
select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001');

select is((select count(*)::int from public.profiles), 1, 'la alumna ve un solo perfil');
select is(
  (select id from public.profiles), 'a0000000-0000-0000-0000-000000000001'::uuid,
  'y es el suyo');
select lives_ok(
  $$update public.profiles set display_name = 'Ana', country_code = 'MX', locale = 'es-MX'
    where id = 'a0000000-0000-0000-0000-000000000001'$$,
  'la alumna edita su nombre, su país y su idioma');
select is((select display_name from public.profiles), 'Ana', 'el nombre quedó guardado');
select throws_ok(
  $$update public.profiles set status = 'suspended'
    where id = 'a0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'la alumna no puede cambiar su estado');
select throws_ok(
  $$update public.profiles set suspended_for_fraud = true
    where id = 'a0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'ni ninguna otra columna');
select lives_ok(
  $$update public.profiles set display_name = 'Intrusa'
    where id = 'a0000000-0000-0000-0000-000000000002'$$,
  'editar el perfil de otro no da error');
select throws_ok(
  $$insert into public.profiles (id) values ('a0000000-0000-0000-0000-000000000009')$$,
  '42501', null, 'la alumna no puede crear perfiles');
select throws_ok(
  $$delete from public.profiles where id = 'a0000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'ni borrar el suyo');
select is((select count(*)::int from public.admin_capabilities), 0, 'la alumna no ve capacidades');
select throws_ok(
  $$insert into public.admin_capabilities (profile_id, capability)
    values ('a0000000-0000-0000-0000-000000000001', 'config')$$,
  '42501', null, 'la alumna no puede darse una capacidad');
select ok(
  not private.has_capability('config'),
  'la alumna no tiene la capacidad de configuración');

select pruebas.como_dueno();
select is(
  (select display_name from public.profiles where id = 'a0000000-0000-0000-0000-000000000002'),
  null, 'pero no cambió nada: el perfil de otro sigue igual');

-- El visitante no lee nada.
select pruebas.como_visitante();
select throws_ok('select count(*) from public.profiles', '42501', null, 'el visitante no lee perfiles');
select throws_ok(
  'select count(*) from public.admin_capabilities', '42501', null,
  'el visitante no lee capacidades');

-- ---------------------------------------------------------------------------------------
-- Capacidades: solo cuentan con segundo factor (RF-105, RF-106).
select pruebas.como_usuario('c0000000-0000-0000-0000-000000000001', 'aal1');
select ok(not private.has_capability('config'), 'sin segundo factor la capacidad no cuenta');
select is(
  (select count(*)::int from public.admin_capabilities), 1,
  'sin segundo factor, un administrador ve solo sus propias capacidades');

select pruebas.como_usuario('c0000000-0000-0000-0000-000000000001', 'aal2');
select ok(private.has_capability('config'), 'con segundo factor la capacidad cuenta');
select ok(not private.has_capability('finance'), 'y solo la que tiene');
select is(
  (select count(*)::int from public.admin_capabilities), 4,
  'configuración con segundo factor ve todas las capacidades');

-- Contra lo que ve el dueño y no contra un número fijo: así no depende de cuántos
-- perfiles haya en la base al correr.
select pruebas.como_dueno();
select count(*)::int as perfiles from public.profiles \gset
select pruebas.como_usuario('50000000-0000-0000-0000-000000000001', 'aal2');
select is(
  (select count(*)::int from public.profiles), :perfiles,
  'soporte con segundo factor ve todos los perfiles');

-- ---------------------------------------------------------------------------------------
-- Revocar: surte efecto de inmediato, es de una sola escritura y deja dos con configuración.
select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001');
select lives_ok(
  $$update public.admin_capabilities
    set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000001'
    where profile_id = '50000000-0000-0000-0000-000000000001' and capability = 'support'$$,
  'el servidor revoca una capacidad');

select pruebas.como_usuario('50000000-0000-0000-0000-000000000001', 'aal2');
select ok(not private.has_capability('support'), 'la capacidad revocada deja de contar de inmediato');

select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$update public.admin_capabilities set revoked_at = now() + interval '1 day'
    where profile_id = '50000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'una revocación no se reescribe');

select pruebas.como_dueno();
select set_config('app.actor_kind', 'system', true);
select throws_ok(
  $$update public.admin_capabilities set capability = 'finance'
    where profile_id = 'c0000000-0000-0000-0000-000000000003'$$,
  '42501', null, 'ni el dueño de la tabla cambia otra columna de una capacidad');
select throws_ok(
  $$delete from public.admin_capabilities where profile_id = 'c0000000-0000-0000-0000-000000000003'$$,
  '42501', null, 'ni la borra');

select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001');
select lives_ok(
  $$update public.admin_capabilities
    set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000001'
    where profile_id = 'c0000000-0000-0000-0000-000000000003' and capability = 'config'$$,
  'con tres personas de configuración, se puede revocar a una');
select throws_ok(
  $$update public.admin_capabilities
    set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000001'
    where profile_id = 'c0000000-0000-0000-0000-000000000002' and capability = 'config'$$,
  '23514', null, 'pero no bajar de dos (RF-712)');

select pruebas.limpiar();
select * from finish();
rollback;
