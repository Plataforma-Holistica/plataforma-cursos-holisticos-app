-- T-601 · Los tramos del bote (RN-13, RF-511, RF-707; 05 §5.10 y §8.4). Segunda solicitud de T-601.
-- Decisiones de Sergio del 2026-10-23: tramos marginales, con el porcentaje efectivo hacia abajo al
-- punto base; alumno activo es una suscripción pagada vigente al último instante del mes (cuenta la
-- gracia y la cancelada con días pagados; no cuentan cortesías, pendientes ni cuentas suspendidas por
-- fraude); y solo base (la pantalla, PA-85, después).
--
-- Los meses con fila son de 2023 y 2024, que ninguna otra prueba toca; los de RF-707, de 2031 en
-- adelante. La revisión de RF-707 es diferida: aquí, al final de cada sentencia. La auditoría no se
-- borra: solo se mira la de esta transacción.
begin;
\ir _ayuda.psql
set constraints all immediate;
select plan(184);

create function pruebas.inicio(p_period integer) returns timestamptz
language sql stable as $$ select timezone('America/Mexico_City', to_date(p_period::text || '01', 'YYYYMMDD')::timestamp) $$;
create function pruebas.fin(p_period integer) returns timestamptz
language sql stable as $$ select timezone('America/Mexico_City', to_date(p_period::text || '01', 'YYYYMMDD')::timestamp + interval '1 month') $$;
create function pruebas.mes(p_back integer default 0) returns integer language sql stable
as $$ select to_char(date_trunc('month', timezone('America/Mexico_City', now())) - make_interval(months => p_back), 'YYYYMM')::integer $$;
create function pruebas.fila(p_period integer, p_status text default 'open') returns void
language sql as $$
  select pruebas.como_dueno_sistema();
  insert into public.payout_periods (period_id, starts_at, ends_at, timezone, status)
  values (p_period, pruebas.inicio(p_period), pruebas.fin(p_period), 'America/Mexico_City', p_status::public.period_status);
  select pruebas.como_dueno();
$$;
create function pruebas.forzar(p_period integer, p_status text) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
  update public.payout_periods set status = p_status::public.period_status,
         entered_closing_at = case when p_status = 'open' then null else coalesce(entered_closing_at, now()) end
  where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
  perform pruebas.como_dueno();
end
$$;
create function pruebas.parametro(p_key text, p_value jsonb, p_period integer, p_from timestamptz default null) returns void
language sql as $$
  select pruebas.como_dueno_sistema();
  insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
  values (p_key, p_value, 'decided', coalesce(p_from, pruebas.inicio(p_period)), p_period);
  select pruebas.como_dueno();
$$;
-- Las reglas del bote de un periodo, como el dueño: el techo, la regla de los tramos y la del sin consumo.
create function pruebas.reglas(p_period integer) returns void
language sql as $$
  select pruebas.parametro('BOTE_PCT_TECHO', '7500', p_period);
  select pruebas.parametro('BOTE_REGLA_TRAMO', '"marginal_tiers"', p_period);
  select pruebas.parametro('BOTE_SIN_CONSUMO', '"proportional_to_assigned_pool"', p_period);
$$;
-- Un juego de tramos, como el dueño declarado sistema (la semilla y las pruebas).
create function pruebas.tramos(p_period integer, p_thresholds integer[], p_bps integer[]) returns void
language sql as $$
  select pruebas.como_dueno_sistema();
  select private.set_pool_tiers(p_period, p_thresholds, p_bps);
  select pruebas.como_dueno();
$$;
-- El juego vivo de un periodo, en palabras: «umbral:porcentaje».
create function pruebas.juego(p_period integer) returns text[] language sql stable
as $$ select array(select min_active_students || ':' || pool_bps from public.pool_tiers
                   where effective_period_id = p_period and canceled_at is null order by min_active_students) $$;
create function pruebas.base_de(p_period integer) returns jsonb[] language sql stable
as $$ select array(select value from public.business_parameters
                   where key = 'BOTE_PCT_BASE' and effective_period_id = p_period and canceled_at is null order by changed_at) $$;
-- Una cuenta con una suscripción. Las fechas son las de la suscripción; la cuenta nace activa.
create function pruebas.cuenta(p_n integer) returns uuid language sql immutable
as $$ select ('a0000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.suscribe(p_n integer, p_status text, p_paid_through timestamptz, p_created timestamptz,
                                 p_failed timestamptz default null, p_ended timestamptz default null, p_sub integer default 1) returns void
language plpgsql as $$
begin
  if not exists (select 1 from auth.users where id = pruebas.cuenta(p_n)) then
    perform pruebas.alta(pruebas.cuenta(p_n), format('cuenta%s-tramos@prueba.test', p_n));
  end if;
  insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency, current_period_start,
                                    current_period_end, last_renewal_failed_at, ended_at, created_at)
  values (pruebas.cuenta(p_n), 'manual', format('sus-tramos-%s-%s', p_n, p_sub), 'monthly', p_status::public.subscription_status, 'MXN',
          case when p_paid_through is not null then p_paid_through - interval '30 days' end, p_paid_through, p_failed, p_ended, p_created);
end
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- La tabla de los tramos, la columna del porcentaje aplicado, y nadie de la aplicación las toca.

select has_table('public', 'pool_tiers', 'la tabla de los tramos del bote');
select columns_are('public', 'pool_tiers',
  array['id', 'effective_period_id', 'min_active_students', 'pool_bps', 'created_by', 'created_at', 'canceled_at', 'canceled_by'],
  'como el 05: desde qué periodo, desde cuántos alumnos, qué porcentaje, y quién y cuándo');
select ok((select relrowsecurity from pg_class where oid = 'public.pool_tiers'::regclass), 'con seguridad por fila');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'pool_tiers_live_uq'
                  and indexdef like '%UNIQUE%(effective_period_id, min_active_students)%WHERE (canceled_at IS NULL)%'),
  'un umbral una vez por periodo, sin contar los cancelados');
select has_column('public', 'payout_periods', 'pool_bps', 'el periodo guarda el porcentaje que se le aplicó (RF-511)');
select ok(not exists (select 1 from pg_constraint where conname = 'business_parameters_version_uq'),
  'la versión de un parámetro ya no es única con las canceladas');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'business_parameters_live_version_uq'
                  and indexdef like '%UNIQUE%(key, effective_from)%WHERE (canceled_at IS NULL)%'),
  'solo entre las vivas');
select is((select count(*)::integer from pg_trigger
           where tgname in ('business_parameters_timing', 'pool_tiers_timing') and tgconstraint <> 0
             and tgdeferrable and tginitdeferred and tgenabled = 'O'), 2,
  'RF-707 por instante se revisa al confirmar, en las dos tablas');
select is(pruebas.juego(202610), array['0:6000'], 'la semilla deja un tramo de 0 alumnos con el 60 %');
select is((select status::text from public.business_parameters where key = 'BOTE_REGLA_TRAMO' and canceled_at is null
           order by effective_from desc limit 1), 'decided', 'y los tramos marginales ya son una decisión');

select pruebas.como_servicio();
select throws_ok('select 1 from public.pool_tiers', '42501', null, 'el servidor no lee los tramos');
select throws_ok($$select private.set_pool_tiers(203101, '{0}', '{6000}')$$, '42501', null, 'ni los escribe (PA-85 lo abrirá)');
select throws_ok('select private.marginal_pool_bps(''{0}'', ''{6000}'', 1)', '42501', null, 'ni calcula el porcentaje');
select throws_ok('select private.active_students_at(now())', '42501', null, 'ni cuenta alumnos activos');
select is(private.period_start(203101), timestamptz '2031-01-01 06:00Z', 'solo pregunta dónde empieza un periodo (lo usa RF-707)');
select pruebas.como_usuario(pruebas.cuenta(1));
select throws_ok('select 1 from public.pool_tiers', '42501', null, 'una persona tampoco lee los tramos');
select pruebas.como_dueno();
select ok(exists (select 1 from private.watchdog_areas() where function_name = 'schema_violations_periods' and unusable_reason is null),
  'el área de los periodos sigue en el vigilante');
select is_empty($$select * from private.schema_violations_periods()$$, 'y no encuentra nada');
select is_empty($$select * from private.schema_violations()$$, 'ni el de todo');

-- ---------------------------------------------------------------------------------------
-- Los tramos marginales: los alumnos se numeran del 1 al n, el alumno número u ya va al tramo de
-- umbral u, y el porcentaje efectivo es el promedio, hacia abajo al punto base.

create function pruebas.marginal(p_n integer) returns integer language sql immutable
as $$ select private.marginal_pool_bps('{0,100,300}', '{6000,6500,7000}', p_n) $$;
select is(pruebas.marginal(0), 6000, 'sin alumnos rige el tramo de 0');
select is(pruebas.marginal(1), 6000, 'uno');
select is(pruebas.marginal(99), 6000, 'el último antes del umbral');
select is(pruebas.marginal(100), 6005, 'el alumno 100 ya va al tramo de 100: (99 × 6000 + 6500) / 100');
select is(pruebas.marginal(101), 6009, '(99 × 6000 + 2 × 6500) / 101 = 6009.9, hacia abajo');
select is(pruebas.marginal(299), 6334, 'el último del segundo tramo');
select is(pruebas.marginal(300), 6336, 'el primero del tercero');
select is(pruebas.marginal(1000), 6801, '(99 × 6000 + 200 × 6500 + 701 × 7000) / 1000');
select is(private.marginal_pool_bps('{0}', '{6000}', 5000), 6000, 'con un solo tramo, siempre el suyo');
select is(private.marginal_pool_bps('{0}', '{10000}', 2147483647), 10000, 'la suma no se desborda');
select is(private.marginal_pool_bps('{0,1}', '{6000,7000}', 1), 7000, 'con umbral 1, el primer alumno ya va al segundo tramo');
select throws_ok($$select private.marginal_pool_bps('{0,100}', '{6000}', 5)$$, '22023', null, 'umbrales y porcentajes del mismo largo');
select throws_ok($$select private.marginal_pool_bps('{}', '{}', 5)$$, '22023', null, 'al menos un tramo');
select throws_ok($$select private.marginal_pool_bps('{1}', '{6000}', 5)$$, '22023', null, 'el primero desde 0 alumnos');
select throws_ok($$select private.marginal_pool_bps('{0,100,100}', '{6000,6500,7000}', 5)$$, '22023', null, 'los umbrales crecen');
select throws_ok($$select private.marginal_pool_bps('{0,100}', '{6500,6000}', 5)$$, '22023', null, 'el porcentaje no baja al subir el umbral');
select throws_ok($$select private.marginal_pool_bps('{0}', '{0}', 5)$$, '22023', null, 'desde 1 punto base');
select throws_ok($$select private.marginal_pool_bps('{0}', '{10001}', 5)$$, '22023', null, 'hasta el 100 %');
select throws_ok($$select private.marginal_pool_bps('{0,null}', '{6000,6500}', 5)$$, '22023', null, 'sin nulos');
select throws_ok($$select private.marginal_pool_bps('{0}', '{6000}', -1)$$, '22023', null, 'ni alumnos negativos');
select throws_ok($$select private.marginal_pool_bps('{0}', '{6000}', null)$$, '22023', null, 'ni nulos');
select throws_ok($$select private.marginal_pool_bps(null, '{6000}', 5)$$, '22023', null, 'ni sin umbrales');
select is((select provolatile::text from pg_proc where oid = 'private.marginal_pool_bps(integer[], integer[], integer)'::regprocedure), 'i',
  'no lee tablas');

-- ---------------------------------------------------------------------------------------
-- Escribir un juego: una sola función, que lo valida entero y reemplaza el del mismo periodo. El
-- tramo de 0 es el porcentaje base: si cambia, escribe la versión de `BOTE_PCT_BASE`.

select pruebas.tramos(203101, '{0,100}', '{6000,6500}');
select is(pruebas.juego(203101), array['0:6000', '100:6500'], 'un juego de dos tramos');
select results_eq($$select bool_and(created_by is null), bool_and(created_at = now()), bool_and(canceled_at is null) from public.pool_tiers
                    where effective_period_id = 203101$$,
  $$values (true, true, true)$$, 'sin autor (lo escribió el sistema), con su hora, la de la base');
select is(pruebas.base_de(203101), '{}'::jsonb[], 'el tramo de 0 es el porcentaje que ya regía: no hay versión nueva');
select results_eq(
  $$select actor_kind, category::text from public.audit_log
    where occurred_at = now() and entity_table = 'public.pool_tiers' and action = 'pool_tiers.insert'$$,
  $$values ('system', 'config'), ('system', 'config')$$, 'cada tramo queda en la auditoría de configuración');
select pruebas.tramos(203101, '{0,50}', '{6200,7000}');
select is(pruebas.juego(203101), array['0:6200', '50:7000'], 'escribir otro juego para el mismo periodo lo reemplaza');
select is((select count(*)::integer from public.pool_tiers where effective_period_id = 203101 and canceled_at = now() and canceled_by is null), 2,
  'el anterior queda cancelado, como el sistema');
select is(pruebas.base_de(203101), array['6200'::jsonb], 'el tramo de 0 cambió: la versión de BOTE_PCT_BASE de ese periodo');
select results_eq($$select effective_from, status::text from public.business_parameters
                    where key = 'BOTE_PCT_BASE' and effective_period_id = 203101 and canceled_at is null$$,
  $$values (timestamptz '2031-01-01 06:00Z', 'decided')$$, 'que rige desde el inicio del periodo');
select pruebas.tramos(203101, '{0}', '{6300}');
select is(pruebas.base_de(203101), array['6300'::jsonb], 'otra vez: la anterior se cancela y se escribe otra en el mismo instante');
select pruebas.tramos(203101, '{0}', '{6000}');
select is(pruebas.base_de(203101), array['6000'::jsonb], 'y de regreso al de antes');
select is(private.period_parameter('BOTE_PCT_BASE', 203101), '6000'::jsonb, 'el panel dice lo mismo que el tramo de 0');
select is(pruebas.juego(203101), array['0:6000'], 'el juego vivo es el último');
select pruebas.tramos(203111, '{0}', '{6000}');
select pruebas.tramos(203110, '{0}', '{6400}');
select is(array[private.period_parameter('BOTE_PCT_BASE', 203110), private.period_parameter('BOTE_PCT_BASE', 203111)], array['6400'::jsonb, '6000'::jsonb],
  'escribir un periodo anterior no le cambia el porcentaje base a uno posterior con su propio juego');

select pruebas.como_dueno_sistema();
select throws_ok($$select private.set_pool_tiers(203102, '{0,100}', '{6000}')$$, '22023', null, 'umbrales y porcentajes del mismo largo');
select throws_ok($$select private.set_pool_tiers(203102, '{}', '{}')$$, '22023', null, 'al menos un tramo');
select throws_ok($$select private.set_pool_tiers(203102, '{5}', '{6000}')$$, '22023', null, 'desde 0 alumnos');
select throws_ok($$select private.set_pool_tiers(203102, '{0,10,5}', '{6000,6100,6200}')$$, '22023', null, 'umbrales que crecen');
select throws_ok($$select private.set_pool_tiers(203102, '{0,10}', '{6100,6000}')$$, '22023', null, 'porcentajes que no bajan');
select throws_ok($$select private.set_pool_tiers(203102, '{0}', '{0}')$$, '22023', null, 'desde 1 punto base');
select throws_ok($$select private.set_pool_tiers(203102, '{0,10}', '{6000,7600}')$$, '22023', null, 'ninguno sobre el techo del periodo (7500)');
select throws_ok($$select private.set_pool_tiers(203102, null, '{6000}')$$, '22023', null, 'ni sin umbrales');
select throws_ok($$select private.set_pool_tiers(null, '{0}', '{6000}')$$, '22023', null, 'ni sin periodo');
select throws_ok($$select private.set_pool_tiers(202001, '{0}', '{6000}')$$, 'P0001', null, 'sin techo en su periodo no se adivina');
select is(pruebas.juego(203102), '{}'::text[], 'nada de eso escribió');
-- La sesión del dueño (una corrección a mano) escribe un tramo suelto; los autores y la hora los
-- pone la base.
insert into public.pool_tiers (effective_period_id, min_active_students, pool_bps, created_by, created_at)
values (203102, 0, 6000, pruebas.cuenta(1), '2000-01-01');
select results_eq($$select created_by, created_at = now() from public.pool_tiers where effective_period_id = 203102$$,
  $$values (null::uuid, true)$$, 'el dueño escribe uno suelto, y quién y cuándo los pone la base');
select throws_ok($$insert into public.pool_tiers (effective_period_id, min_active_students, pool_bps, canceled_at) values (203103, 0, 6000, now())$$,
  '42501', null, 'un tramo no nace cancelado');
select pruebas.como_dueno();

select pruebas.como_dueno_sistema();
select throws_ok($$update public.pool_tiers set pool_bps = 7000 where effective_period_id = 203101 and canceled_at is null$$, '42501', null,
  'de un tramo solo cambia su cancelación');
select throws_ok($$update public.pool_tiers set canceled_at = now(), pool_bps = 7000 where effective_period_id = 203101 and canceled_at is null$$,
  '42501', null, 'ni junto con la cancelación');
select throws_ok($$update public.pool_tiers set canceled_at = null where effective_period_id = 203101 and canceled_at is not null$$, '42501', null,
  'y una cancelación no se deshace');
select throws_ok($$update public.pool_tiers set canceled_at = '2001-01-01' where effective_period_id = 203101 and canceled_at is not null$$, '42501', null,
  'ni se reescribe');
select throws_ok($$delete from public.pool_tiers where effective_period_id = 203101$$, '42501', null, 'un tramo no se borra');
select throws_ok($$truncate public.pool_tiers$$, '42501', null, 'ni se vacía la tabla');
select pruebas.como_dueno();
select throws_ok($$select private.set_pool_tiers(203103, '{0}', '{6000}')$$, '42501', null, 'sin quien actúe no hay juego (la auditoría lo exige)');

-- ---------------------------------------------------------------------------------------
-- RF-707 por instante, para quien no es la sesión del dueño: el servidor, con permisos dados aquí
-- (PA-85 los dará), a nombre de alguien con configuración.

select pruebas.alta('c0000000-0000-0000-0000-000000000041', 'config-tramos@prueba.test');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000041', 'config');
grant execute on function private.set_pool_tiers(public.period_id, integer[], integer[]) to app_service;
grant insert, update on public.pool_tiers to app_service;
-- Dos funciones `security definer` del dueño que escriben lo del reparto: la excepción del dueño no
-- se hereda por correr como él.
create function pruebas.cancela_tramos(p_period integer) returns void language sql security definer
as $$ update public.pool_tiers set canceled_at = now() where effective_period_id = p_period and canceled_at is null $$;
create function pruebas.programa(p_key text, p_value jsonb, p_period integer) returns void language sql security definer
as $$ insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
      values (p_key, p_value, 'decided', private.period_start(p_period), p_period) $$;
create function pruebas.tramo_suelto(p_period integer) returns void language sql security definer
as $$ insert into public.pool_tiers (effective_period_id, min_active_students, pool_bps) values (p_period, 500, 7000) $$;
-- El servidor que cambia de rol antes de confirmar: como `authenticated` no lee la definición del
-- parámetro, y la revisión no puede tomarlo por uno que no es del reparto.
create function pruebas.cambia_de_rol() returns void language plpgsql
as $$
begin
  insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
  values ('VELOCIDAD_MAX', '"9"', 'decided', now() + interval '1 minute', 202610);
  perform set_config('role', 'authenticated', true);
  set constraints business_parameters_timing immediate;
end
$$;
grant execute on all functions in schema pruebas to app_service;
create function pruebas.como_config() returns void language sql
as $$ select pruebas.como_servicio('c0000000-0000-0000-0000-000000000041'); select set_config('app.reason', 'Prueba de tramos', true); $$;

select pruebas.como_config();
select lives_ok($$select private.set_pool_tiers(203105, '{0,10}', '{6100,6200}')$$, 'el servidor escribe el juego de un periodo que no ha empezado');
select pruebas.como_dueno();
select is(pruebas.juego(203105), array['0:6100', '10:6200'], 'con sus tramos');
select results_eq($$select distinct created_by from public.pool_tiers where effective_period_id = 203105$$,
  $$values ('c0000000-0000-0000-0000-000000000041'::uuid)$$, 'a nombre de quien lo pidió');
select is(pruebas.base_de(203105), array['6100'::jsonb], 'y la versión de BOTE_PCT_BASE, por la misma función');
select pruebas.como_config();
select lives_ok($$select private.set_pool_tiers(203105, '{0}', '{6150}')$$, 'cancela y vuelve a programar el mismo periodo');
select pruebas.como_dueno();
select is(pruebas.base_de(203105), array['6150'::jsonb], 'con su porcentaje base');
select pruebas.como_config();
select throws_ok(format('select private.set_pool_tiers(%s, ''{0}'', ''{6000}'')', pruebas.mes(0)), '23514', null,
  'el mes en curso ya empezó: su juego no cambia');
select throws_ok($$select private.set_pool_tiers(202610, '{0}', '{6100}')$$, '23514', null, 'ni el de un mes viejo');
set constraints pool_tiers_timing, business_parameters_timing deferred;
select throws_ok(format('select private.set_pool_tiers(%s, ''{0}'', ''{6000}'')', pruebas.mes(0)), '23514', null,
  'la función lo dice antes de confirmar: con la revisión de la tabla diferida, también');
set constraints all immediate;
select throws_ok($$insert into public.pool_tiers (effective_period_id, min_active_students, pool_bps) values (203106, 0, 6000)$$,
  '42501', null, 'un tramo suelto no lo escribe el servidor aunque tenga el permiso');
select throws_ok(format($$update public.pool_tiers set canceled_at = now() where effective_period_id = %s$$, 202610),
  '42501', null, 'ni lo cancela');
select throws_ok($$insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
                   values ('BOTE_PCT_BASE', '6100', 'decided', '2031-07-01 06:00Z', 203107)$$,
  '42501', null, 'ni escribe el porcentaje base por fuera de los tramos');
select throws_ok($$update public.business_parameters set canceled_at = now(), canceled_by = 'c0000000-0000-0000-0000-000000000041'
                   where key = 'BOTE_PCT_BASE' and effective_period_id = 203105 and canceled_at is null$$,
  '42501', null, 'ni lo cancela');
select throws_ok(format('select pruebas.cancela_tramos(%s)', 202610), '23514', null,
  'dentro de una función del dueño, tampoco cancela los tramos de un periodo empezado');
select lives_ok('select pruebas.cancela_tramos(203105)', 'los de uno por empezar, sí');
select throws_ok('select pruebas.tramo_suelto(202610)', '23514', null, 'ni escribe un tramo de un periodo empezado desde una función del dueño');
set constraints business_parameters_timing deferred;
-- Se rechaza por permiso (42501) o, si ya se revisó antes en la transacción, por RF-707 (23514).
select throws_ok('select pruebas.cambia_de_rol()', null, null,
  'cambiar de rol antes de confirmar no salta la revisión: falla cerrada');
set constraints all immediate;
select throws_ok($$select pruebas.programa('UMBRAL_MEDIO_PCT', '2600', 202509)$$, '23514', null,
  'ni programa un parámetro del reparto en un mes que ya empezó');

select lives_ok($$insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
                  values ('UMBRAL_MEDIO_PCT', '2600', 'decided', '2031-06-01 06:00Z', 203106)$$,
  'un parámetro del reparto rige desde el inicio de un periodo que no ha empezado');
select throws_ok($$insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
                   values ('UMBRAL_MEDIO_PCT', '2700', 'decided', '2031-06-01 07:00Z', 203106)$$,
  '23514', null, 'no desde otro instante: con su periodo futuro, a media hora ya cambiaría el mes anterior');
select throws_ok($$insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
                   values ('UMBRAL_MEDIO_PCT', '2700', 'decided', now() - interval '1 second', 203106)$$,
  '23514', null, 'ni desde un instante pasado');
select throws_ok($$insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
                   values ('UMBRAL_MEDIO_PCT', '2700', 'decided', '2025-09-01 06:00Z', 202509)$$,
  '23514', null, 'ni en un periodo que ya empezó, aunque sea desde su inicio');
select throws_ok($$insert into public.business_parameters (key, value, status, effective_from)
                   values ('GRACIA_COBRO_DIAS', '9', 'proposed', now() - interval '1 second')$$,
  '23514', null, 'un parámetro que no es del reparto tampoco rige hacia atrás (la gracia mueve los alumnos activos)');
select throws_ok($$insert into public.business_parameters (key, value, status, effective_from)
                   values ('GRACIA_COBRO_DIAS', '9', 'proposed', now() + interval '1 millisecond')$$,
  '23514', null, 'la hora es la del reloj, no la del inicio de la transacción');
select lives_ok($$insert into public.business_parameters (key, value, status, effective_from)
                  values ('GRACIA_COBRO_DIAS', '9', 'proposed', now() + interval '1 day')$$,
  'hacia adelante, sí');
-- Una versión del reparto con un instante futuro en un periodo ya empezado solo la deja el dueño;
-- el servidor no la cancela.
select pruebas.como_dueno_sistema();
insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
values ('UMBRAL_MEDIO_PCT', '2550', 'decided', now() + interval '2 days', 202610);
select pruebas.como_config();
select throws_ok($$update public.business_parameters set canceled_at = now(), canceled_by = 'c0000000-0000-0000-0000-000000000041'
                   where key = 'UMBRAL_MEDIO_PCT' and value = '2550'$$,
  '23514', null, 'ni se cancela una del reparto cuyo periodo ya empezó, aunque no rija todavía');
select throws_ok($$update public.business_parameters set canceled_at = now(), canceled_by = 'c0000000-0000-0000-0000-000000000041'
                   where key = 'GRACIA_COBRO_DIAS' and effective_from <= now() and canceled_at is null$$,
  '23514', null, 'una versión que ya rige no se cancela');
select lives_ok($$update public.business_parameters set announced_at = now()
                  where key = 'GRACIA_COBRO_DIAS' and effective_from <= now() and canceled_at is null$$,
  'avisar de ella sí: solo se revisa una cancelación');
select lives_ok($$update public.business_parameters set canceled_at = now(), canceled_by = 'c0000000-0000-0000-0000-000000000041'
                  where key = 'UMBRAL_MEDIO_PCT' and effective_period_id = 203106$$,
  'la del reparto que no ha empezado se cancela');
select lives_ok($$insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
                  values ('UMBRAL_MEDIO_PCT', '2700', 'decided', '2031-06-01 06:00Z', 203106)$$,
  'y se vuelve a programar en el mismo instante: el índice único no cuenta la cancelada');
select pruebas.como_dueno();
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '16 minutes'
  where session_id = pruebas.sesion('c0000000-0000-0000-0000-000000000041');
select pruebas.a_nombre_de('c0000000-0000-0000-0000-000000000041');
select throws_ok($$select private.set_pool_tiers(203109, '{0,10}', '{6000,6100}')$$, '42501',
  'public.pool_tiers: a recent second factor code is required', 'sin un código reciente no cambia un tramo, como un parámetro');
select pruebas.como_dueno_sistema();
select lives_ok(format($$insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
                         values ('UMBRAL_MEDIO_PCT', '2500', 'decided', now() - interval '1 hour', %s)$$, pruebas.mes(0)),
  'la sesión del dueño (la semilla, una corrección a mano) sí puede, aunque sea hacia atrás');
select lives_ok($$select private.set_pool_tiers(202610, '{0}', '{6000}')$$, 'también con los tramos de un periodo empezado');
update public.pool_tiers set canceled_at = '2000-01-01', canceled_by = 'c0000000-0000-0000-0000-000000000041'
where effective_period_id = 203102 and canceled_at is null;
select results_eq($$select canceled_at = now(), canceled_by from public.pool_tiers where effective_period_id = 203102$$,
  $$values (true, null::uuid)$$, 'quién y cuándo de una cancelación también los pone la base');
-- La gracia de 9 días programada arriba movería los casos de abajo: el sistema la cancela, sin persona.
select lives_ok($$update public.business_parameters set canceled_at = now()
                  where key = 'GRACIA_COBRO_DIAS' and value = '9' and canceled_at is null$$,
  'el sistema cancela sin persona que lo firme');
select pruebas.como_config();
select throws_ok($$update public.business_parameters set canceled_by = 'c0000000-0000-0000-0000-000000000041'
                   where key = 'GRACIA_COBRO_DIAS' and value = '9'$$,
  '23514', null, 'y nadie la firma después');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- Los alumnos activos en un instante: cuentas activas y sin suspensión por fraude, con alguna
-- suscripción que no esté pendiente, creada a esa hora, que daba acceso por pago o por gracia (RN-01).

create temporary table conteo (base integer not null);
insert into conteo select private.active_students_at('2030-06-15 12:00Z');
create function pruebas.activos() returns integer language sql stable
as $$ select private.active_students_at('2030-06-15 12:00Z') - (select base from conteo) $$;
grant select on conteo to app_service;
select pruebas.suscribe(1, 'active', '2030-06-16 12:00Z', '2030-01-01');
select is(pruebas.activos(), 1, 'pagada y vigente: cuenta');
select pruebas.suscribe(2, 'canceled', '2030-06-20 12:00Z', '2030-01-01');
select is(pruebas.activos(), 2, 'cancelada con días pagados: cuenta');
select pruebas.suscribe(3, 'expired', '2030-06-15 12:00Z', '2030-01-01');
select is(pruebas.activos(), 2, 'la que termina justo en ese instante, no');
select pruebas.suscribe(4, 'in_grace', '2030-06-13 12:00Z', '2030-01-01', '2030-06-13 12:00Z');
select is(pruebas.activos(), 3, 'en gracia, dentro de GRACIA_COBRO_DIAS: cuenta');
select pruebas.suscribe(5, 'expired', '2030-06-08 12:00Z', '2030-01-01', '2030-06-08 12:00Z');
select is(pruebas.activos(), 3, 'a siete días exactos de la falla, la gracia ya terminó');
select pruebas.suscribe(6, 'expired', '2030-06-07 12:00Z', '2030-01-01', '2030-06-07 12:00Z');
select is(pruebas.activos(), 3, 'y pasada, tampoco');
select pruebas.suscribe(7, 'refunded', '2030-06-30 12:00Z', '2030-01-01', null, '2030-06-14 12:00Z');
select is(pruebas.activos(), 3, 'un reembolso corta el periodo pagado');
select pruebas.suscribe(8, 'canceled', '2030-06-14 12:00Z', '2030-01-01', '2030-06-14 12:00Z', '2030-06-15 11:00Z');
select is(pruebas.activos(), 3, 'y cancelar en la gracia la corta');
select pruebas.suscribe(9, 'pending', null, '2030-01-01');
select is(pruebas.activos(), 3, 'una pendiente no cuenta');
select pruebas.suscribe(17, 'pending', '2030-06-20 12:00Z', '2030-01-01');
select is(pruebas.activos(), 3, 'ni con días pagados');
select pruebas.suscribe(10, 'active', '2030-07-15 12:00Z', '2030-06-15 12:01Z');
select is(pruebas.activos(), 3, 'ni una creada después del instante');
select pruebas.suscribe(11, 'expired', '2030-06-14 12:00Z', '2030-01-01', '2030-06-16 12:00Z');
select is(pruebas.activos(), 3, 'una falla posterior al instante no da gracia');
select pruebas.alta(pruebas.cuenta(12), 'cuenta12-tramos@prueba.test');
insert into public.courtesy_grants (profile_id, reason, starts_at, ends_at, granted_by)
values (pruebas.cuenta(12), 'prueba', '2030-01-01', '2030-12-31', pruebas.cuenta(1));
select is(pruebas.activos(), 3, 'una cortesía no cuenta');
select pruebas.suscribe(13, 'active', '2030-06-16 12:00Z', '2030-01-01');
select pruebas.suspender(pruebas.cuenta(13));
select is(pruebas.activos(), 3, 'una cuenta suspendida no cuenta: no tiene acceso');
select pruebas.suscribe(14, 'active', '2030-06-16 12:00Z', '2030-01-01');
select pruebas.como_dueno_sistema();
update public.profiles set suspended_for_fraud = true where id = pruebas.cuenta(14);
select pruebas.como_dueno();
select is(pruebas.activos(), 3, 'ni una suspendida por fraude');
select pruebas.suscribe(15, 'canceled', '2030-06-18 12:00Z', '2030-01-01', null, null, 1);
select pruebas.suscribe(15, 'expired', '2030-06-01 12:00Z', '2030-05-01', null, null, 2);
select is(pruebas.activos(), 4, 'una suscripción nueva vencida no tapa a una vieja con días pagados');
select pruebas.suscribe(16, 'canceled', '2030-06-18 12:00Z', '2030-01-01', null, null, 1);
select pruebas.suscribe(16, 'active', '2030-07-01 12:00Z', '2030-05-01', null, null, 2);
select is(pruebas.activos(), 5, 'y una cuenta con dos que cuentan, cuenta una vez');
select pruebas.suscribe(18, 'active', '2030-06-20 12:00Z', '2030-06-15 12:00Z');
select is(pruebas.activos(), 6, 'una creada justo en ese instante sí cuenta');
select pruebas.suscribe(19, 'refunded', '2030-06-30 12:00Z', '2030-01-01', null, '2030-06-15 12:00Z');
select is(pruebas.activos(), 6, 'y una cortada justo en ese instante, no');
select pruebas.parametro('GRACIA_COBRO_DIAS', '1', null, '2030-06-14 00:00Z');
select is(pruebas.activos(), 6, 'la gracia es la de la hora de la falla: un cambio posterior no la acorta');
select throws_ok($$select private.active_students_at(null)$$, '22023', null, 'sin instante no se cuenta');

-- ---------------------------------------------------------------------------------------
-- La foto: cada periodo con fila que ya terminó y no la tiene recibe sus alumnos activos en su último
-- instante y su porcentaje, una vez, en orden. Sin juego de tramos, el porcentaje queda nulo.

select pruebas.reglas(202301);
select pruebas.suscribe(n, 'canceled', '2023-05-15 12:00Z', '2023-01-01', null, null, 1) from generate_series(21, 23) n;
select pruebas.suscribe(27, 'expired', pruebas.fin(202303), '2023-01-01');
select pruebas.fila(202303);
select pruebas.fila(202304);
select pruebas.fila(202305, 'closing');
select pruebas.fila(202306);
select pruebas.forzar(202306, 'closed');
select pruebas.fila(203108);
select pruebas.tramos(202304, '{0,2}', '{6000,7000}');
select set_config('app.actor_kind', 'prueba', true);
select set_config('pruebas.foto', private.period_photos()::text, true);
select is(current_setting('app.actor_kind', true), 'prueba', 'quien actúa queda como estaba');
select ok(current_setting('pruebas.foto')::jsonb -> 'taken' @> '[202303, 202304, 202305]', 'toma la de los tres que terminaron');
select ok(not current_setting('pruebas.foto')::jsonb -> 'taken' @> '[202306]', 'no la de uno cerrado');
select ok(not current_setting('pruebas.foto')::jsonb -> 'taken' @> '[203108]', 'ni la de uno que no ha terminado');
select ok(not current_setting('pruebas.foto')::jsonb ? 'failed', 'sin fallas');
select results_eq($$select period_id::integer, active_students, pool_bps::integer from public.payout_periods
                    where period_id in (202303, 202304, 202305, 202306, 203108) order by 1$$,
  $$values (202303, 4, null::integer), (202304, 3, 6666), (202305, 0, 6666), (202306, null::integer, null::integer), (203108, null, null)$$,
  'marzo con 4 (la pagada hasta su último instante cuenta) y sin juego (nulo); abril con 3: (6000 + 2 × 7000) / 3; mayo sin alumnos, pero el porcentaje no baja');
select results_eq(
  $$select entity_id, actor_kind from public.audit_log
    where occurred_at = now() and entity_table = 'public.payout_periods' and action = 'payout_periods.update'
      and entity_id in ('202303', '202304', '202305') order by id$$,
  $$values ('202303', 'system'), ('202304', 'system'), ('202305', 'system')$$, 'en orden, como el sistema, en la auditoría de dinero');
select ok(not private.period_photos() -> 'taken' @> '[202303]', 'la segunda vez no la vuelve a tomar');

select pruebas.como_dueno_sistema();
select throws_ok($$update public.payout_periods set active_students = 5 where period_id = 202303$$, '23514', null,
  'una foto no se cambia');
select throws_ok($$update public.payout_periods set active_students = 4 where period_id = 203108$$, '23514', null,
  'ni se toma de un mes que no ha terminado');
select throws_ok($$update public.payout_periods set pool_bps = 6000 where period_id = 202303$$, '23514', null,
  'ni se le agrega después el porcentaje');
select throws_ok($$insert into public.payout_periods (period_id, starts_at, ends_at, timezone, pool_bps)
                   values (202307, '2023-07-01 06:00Z', '2023-08-01 06:00Z', 'America/Mexico_City', 6000)$$,
  '23514', null, 'un periodo nace sin porcentaje');
select pruebas.fila(202308);
select pruebas.como_dueno_sistema();
select throws_ok($$update public.payout_periods set active_students = 1, status = 'closing', entered_closing_at = now() where period_id = 202308$$,
  '23514', null, 'la foto no viaja con un cambio de estado');
select throws_ok($$update public.payout_periods set pool_bps = 6000 where period_id = 202308$$, '23514', null,
  'ni el porcentaje sin los alumnos');
select pruebas.como_dueno();
select set_config('app.actor_id', pruebas.cuenta(1)::text, true);
select throws_ok($$update public.payout_periods set active_students = 1 where period_id = 202308$$, '23514', null,
  'la toma el sistema, no una persona');
select pruebas.como_dueno();

-- Una foto que falla no detiene a las demás, y sin foto el periodo no pasa a cierre.
select pruebas.fila(202402);
select pruebas.fila(202404);
select pruebas.tramos(202402, '{0}', '{6000}');
select pruebas.parametro('BOTE_SIN_CONSUMO', '"by_points"', 202402);
select pruebas.parametro('BOTE_SIN_CONSUMO', '"proportional_to_assigned_pool"', 202403);
select set_config('pruebas.foto', private.period_photos()::text, true);
select ok(current_setting('pruebas.foto')::jsonb -> 'failed' ? '202402', 'la del mes con una regla que no se entiende falla, y lo dice');
select ok(current_setting('pruebas.foto')::jsonb -> 'taken' @> '[202308, 202404]', 'las demás se toman');
select results_eq($$select period_id::integer, active_students, pool_bps::integer from public.payout_periods
                    where period_id in (202308, 202402, 202404) order by 1$$,
  $$values (202308, 0, 6000), (202402, null::integer, null::integer), (202404, 0, 6000)$$, 'y ese mes se queda sin foto');
select set_config('pruebas.paso', private.period_transition(array[202304, 202402])::text, true);
select is((select status::text from public.payout_periods where period_id = 202304), 'closing', 'abril, con su foto, pasa a cierre');
select is((select status::text from public.payout_periods where period_id = 202402), 'open', 'febrero de 2024, sin foto, no');
select is(current_setting('pruebas.paso')::jsonb -> 'photo_missing', '[202402]'::jsonb, 'y el paso lo dice');
select ok(current_setting('pruebas.paso')::jsonb -> 'held_open' @> '[202402]', 'se queda abierto');

-- ---------------------------------------------------------------------------------------
-- El porcentaje de un periodo: el guardado; si no, el de sus alumnos activos (de la foto o, sin ella,
-- los de ahora o los de su último instante), con «no baja» respecto del anterior.

select is(private.pool_bps(202304), 6666, 'el guardado');
select is(private.pool_bps(202305), 6666, 'mayo tenía 0 alumnos y el porcentaje no bajó');
select throws_ok($$select private.pool_bps(202303)$$, 'P0001', 'pool tiers are not set for period 202303',
  'un mes sin juego de tramos lanza: no se adivina');
select throws_ok($$select private.pool_bps(202012)$$, 'P0001', 'pool for period 202012 has an unknown BOTE_REGLA_TRAMO',
  'ni sin la regla de los tramos');
select pruebas.tramos(202303, '{0,3}', '{6000,6900}');
select is(private.pool_bps(202303), 6450, 'con un juego escrito después de la foto, con los alumnos de la foto: (2 × 6000 + 2 × 6900) / 4');
select pruebas.suscribe(25, 'canceled', '2023-04-15 12:00Z', '2023-01-01');
select is(private.pool_bps(202303), 6450, 'aunque hoy se vean más alumnos en ese instante');
select pruebas.tramos(202401, '{0,1}', '{6100,6900}');
select is(private.pool_bps(202401), 6100, 'sin foto ni fila, con los alumnos de su último instante: nadie, el tramo de 0');
select pruebas.suscribe(24, 'active', '2024-02-15 12:00Z', '2024-01-01');
select is(private.pool_bps(202401), 6900, 'con uno, el del tramo de 1: sin fila el anterior, no hay con qué comparar');
select pruebas.fila(202312);
select is(private.pool_bps(202401), 6900, 'con fila el anterior, la cadena sigue: diciembre (6000) no la sube');
select pruebas.fila(202311);
select pruebas.fila(202310);
select pruebas.forzar(202310, 'closing');
select pruebas.como_dueno_sistema();
update public.payout_periods set active_students = 3, pool_bps = 6800 where period_id = 202310;
select pruebas.como_dueno();
select is(private.pool_bps(202310), 6800, 'el guardado manda, aunque hoy se calcularía otro');
select is(private.pool_bps(202311), 6800, 'noviembre sin alumnos no baja de octubre');
select is(private.pool_bps(202312), 6800, 'ni diciembre');
select is(private.pool_bps(202401), 6900, 'enero, con un alumno en el tramo de 1, sube');
select is(private.effective_pool_bps(202311, 0), 6800, 'el cálculo de la foto es el mismo');
-- Sin fila, el anterior no cuenta para «no baja»; los alumnos de un mes sin fila son los de su último
-- instante.
select pruebas.reglas(202106);
select pruebas.tramos(202107, '{0,1}', '{6000,7000}');
select pruebas.suscribe(26, 'expired', pruebas.fin(202107), '2021-07-01');
select is(private.pool_bps(202107), 7000, 'julio de 2021: la pagada hasta su último instante cuenta');
select is(private.pool_bps(202108), 6000, 'agosto no tiene alumnos, y julio sin fila no lo sube');
select pruebas.parametro('BOTE_REGLA_TRAMO', '"flat"', 202405);
select pruebas.tramos(202405, '{0}', '{6000}');
select throws_ok($$select private.pool_bps(202405)$$, 'P0001', 'pool for period 202405 has an unknown BOTE_REGLA_TRAMO',
  'otra regla de tramos lanza');
select throws_ok($$select private.pool_bps(202402)$$, 'P0001', 'pool for period 202402 has an unknown BOTE_SIN_CONSUMO',
  'y otra regla del sin consumo');
select is(private.pool_bps(202610), 6000, 'octubre de 2026, con la semilla: un solo tramo de 60 %, tenga los alumnos que tenga');

-- ---------------------------------------------------------------------------------------
-- La gracia sin su parámetro a la hora de la falla: no se adivina (al final: lanza en todo instante
-- después de esa falla).

select pruebas.suscribe(30, 'in_grace', '2026-09-10 12:00Z', '2026-08-01', '2026-09-10 12:00Z');
select throws_ok($$select private.active_students_at('2026-09-11 12:00Z')$$, 'P0001', null,
  'una falla de antes de que existiera GRACIA_COBRO_DIAS: no se sabe cuánto duraba su gracia');

-- ---------------------------------------------------------------------------------------
-- El vigilante de los periodos ve lo que se le quite a los tramos.

select pruebas.como_dueno_sistema();
revoke insert, update on public.pool_tiers from app_service;
revoke execute on function private.set_pool_tiers(public.period_id, integer[], integer[]) from app_service;
select is_empty($$select * from private.schema_violations_periods()$$, 'sin los permisos de la prueba, en orden');
grant select on public.pool_tiers to authenticated;
select results_eq($$select problem, object_name from private.schema_violations_periods()$$,
  $$values ('period table reachable by authenticated', 'public.pool_tiers')$$, 'los tramos al alcance de una sesión');
revoke select on public.pool_tiers from authenticated;
revoke execute on function private.period_start(public.period_id) from app_service;
select results_eq($$select problem, object_name like 'private.period_start(%' from private.schema_violations_periods()$$,
  $$values ('period function not executable by app_service', true)$$, 'RF-707 sin poder preguntar dónde empieza un periodo');
grant execute on function private.period_start(public.period_id) to app_service;
grant execute on function private.active_students_at(timestamptz) to app_service;
select results_eq($$select problem, object_name like 'private.active_students_at(%' from private.schema_violations_periods()$$,
  $$values ('period function executable by app_service', true)$$, 'una función que la aplicación no debe ejecutar');
revoke execute on function private.active_students_at(timestamptz) from app_service;
alter function private.set_pool_tiers(public.period_id, integer[], integer[]) security invoker;
select results_eq($$select problem, object_name like 'private.set_pool_tiers(%' from private.schema_violations_periods()$$,
  $$values ('period function not security definer', true)$$, 'los tramos sin correr como el dueño');
alter function private.set_pool_tiers(public.period_id, integer[], integer[]) security definer;
alter function private.marginal_pool_bps(integer[], integer[], integer) security definer;
select results_eq($$select problem, object_name like 'private.marginal_pool_bps(%' from private.schema_violations_periods()$$,
  $$values ('period function security definer or without fixed search_path', true)$$, 'una que no debe correr como el dueño');
alter function private.marginal_pool_bps(integer[], integer[], integer) security invoker;
alter table public.pool_tiers disable trigger pool_tiers_guard;
select results_eq($$select problem, object_name from private.schema_violations_periods()$$,
  $$values ('period trigger missing or disabled: pool_tiers_guard', 'public.pool_tiers')$$, 'el guardián de los tramos apagado');
alter table public.pool_tiers enable trigger pool_tiers_guard;
alter table public.pool_tiers disable trigger pool_tiers_fresh_code;
select results_eq($$select problem, object_name from private.schema_violations_periods()$$,
  $$values ('period trigger missing or disabled: pool_tiers_fresh_code', 'public.pool_tiers')$$, 'los tramos sin pedir el código reciente');
alter table public.pool_tiers enable trigger pool_tiers_fresh_code;
drop trigger business_parameters_timing on public.business_parameters;
create constraint trigger business_parameters_timing after insert or update on public.business_parameters
  not deferrable for each row execute function private.guard_payout_timing();
select results_eq($$select problem, object_name from private.schema_violations_periods()$$,
  $$values ('period trigger not deferred: business_parameters_timing', 'public.business_parameters')$$,
  'RF-707 revisado antes de confirmar: una transacción abierta a las 23:59 pasaría');
drop trigger business_parameters_timing on public.business_parameters;
create constraint trigger business_parameters_timing after insert or update on public.business_parameters
  deferrable initially deferred for each row execute function private.guard_payout_timing();
select is_empty($$select * from private.schema_violations_periods()$$, 'y todo en su lugar otra vez');

select * from finish();
rollback;
