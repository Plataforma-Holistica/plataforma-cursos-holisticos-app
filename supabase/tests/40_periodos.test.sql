-- T-601 · Los periodos (RF-501, RN-13; 05 §5.10, §7.3 y §8.1). Decisiones de Sergio del 2026-10-23:
-- el mes pasa a «en cierre» el día `DIA_CIERRE` (3) del mes siguiente, tras la corrida de esa noche;
-- un cobro que llega a un periodo cerrado va al primer periodo abierto, con registro; y T-601 va en
-- dos solicitudes (esta, los periodos; la siguiente, los tramos).
--
-- La migración no escribe filas: un mes sin fila toma su estado del reloj. Las pruebas no dependen
-- de hoy salvo donde se dice: los meses con fila son de 2020, 2021 y 2030 en adelante, que ninguna
-- otra prueba toca, y los del reloj se comparan contra lo que dice el reloj. La auditoría no se
-- borra: solo se mira la de esta transacción.
begin;
\ir _ayuda.psql
-- La revisión de las partes de un cobro es diferida: aquí, al final de cada sentencia.
set constraints all immediate;
select plan(143);

create function pruebas.ana() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000001'::uuid $$;
-- El mes en curso y el anterior, por el reloj, en la zona de la semilla.
create function pruebas.mes(p_back integer default 0) returns integer language sql stable
as $$ select to_char(date_trunc('month', timezone('America/Mexico_City', now())) - make_interval(months => p_back), 'YYYYMM')::integer $$;
-- Los instantes de un mes en una zona.
create function pruebas.inicio(p_period integer, p_zone text default 'America/Mexico_City') returns timestamptz
language sql stable as $$ select timezone(p_zone, to_date(p_period::text || '01', 'YYYYMMDD')::timestamp) $$;
create function pruebas.fin(p_period integer, p_zone text default 'America/Mexico_City') returns timestamptz
language sql stable as $$ select timezone(p_zone, to_date(p_period::text || '01', 'YYYYMMDD')::timestamp + interval '1 month') $$;
-- Una fila escrita por el dueño declarado sistema, con su forma correcta.
create function pruebas.fila(p_period integer, p_status text default 'open', p_zone text default 'America/Mexico_City') returns void
language sql as $$
  select pruebas.como_dueno_sistema();
  insert into public.payout_periods (period_id, starts_at, ends_at, timezone, status)
  values (p_period, pruebas.inicio(p_period, p_zone), pruebas.fin(p_period, p_zone), p_zone, p_status::public.period_status);
  select pruebas.como_dueno();
$$;
-- Un estado que T-601 todavía no sabe escribir (cerrado, pagado): sin el guardián, dentro de la
-- transacción de la prueba.
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
create function pruebas.estado(p_period integer) returns text language sql stable
as $$ select status::text from public.payout_periods where period_id = p_period $$;
create function pruebas.ventana() returns integer[] language sql stable as $$ select array(select private.rollup_window()) $$;
create function pruebas.parametro(p_key text, p_value jsonb, p_period integer, p_from timestamptz default null) returns void
language sql as $$
  select pruebas.como_dueno_sistema();
  insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
  values (p_key, p_value, 'decided', coalesce(p_from, pruebas.inicio(p_period)), p_period);
  select pruebas.como_dueno();
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- La tabla, sin filas de la migración, y nadie de la aplicación la toca.

select has_table('public', 'payout_periods', 'la tabla de los periodos');
select enum_has_labels('public', 'period_status', array['open', 'closing', 'closed', 'paid'], 'abierto, en cierre, cerrado y pagado');
select col_is_pk('public', 'payout_periods', 'period_id', 'un periodo por mes');
select columns_are('public', 'payout_periods',
  array['period_id', 'starts_at', 'ends_at', 'timezone', 'status', 'entered_closing_at', 'active_students', 'carried_in_cents', 'created_at',
        'pool_bps', 'net_revenue_cents', 'student_pools_cents', 'pool_cents', 'assigned_cents', 'unconsumed_cents', 'carried_out_cents',
        'close_run_id', 'closed_at', 'closed_by'],
  'lo de T-601, y las cifras del cierre de T-602');
select ok((select relrowsecurity from pg_class where oid = 'public.payout_periods'::regclass), 'con seguridad por fila');
select has_trigger('public', 'payout_periods', 'payout_periods_guard', 'con su guardián');
select has_trigger('public', 'payout_periods', 'payout_periods_no_truncate', 'que tampoco se vacía');
select has_trigger('public', 'payout_periods', 'audit_changes', 'y auditada');
select has_column('public', 'charges', 'allocation_start_period_id', 'el cobro dice en qué periodo empiezan sus partes');
select fk_ok('public', 'charges', 'allocation_start_period_id', 'public', 'payout_periods', 'period_id',
  'y ese periodo existe');
select is(private.parameter_value('DIA_CIERRE'), '3'::jsonb, 'el mes pasa a en cierre el día 3 del siguiente (semilla)');
select is((select description from public.parameter_definitions where key = 'DIA_CIERRE'),
  'Día del mes siguiente en que el mes pasa a en cierre', 'con su definición nueva');
select ok(exists (select 1 from public.job_definitions where job = 'period_transition'), 'el paso a cierre es un trabajo con sus corridas');

select pruebas.como_usuario(pruebas.ana());
select throws_ok('select 1 from public.payout_periods', '42501', null, 'una persona no lee los periodos');
select pruebas.como_servicio();
select throws_ok('select 1 from public.payout_periods', '42501', null, 'ni el servidor');
select throws_ok('select private.open_period(203001)', '42501', null, 'ni abre uno');
select throws_ok('select private.period_status_of(203001)', '42501', null, 'ni pregunta su estado');
select throws_ok('select private.period_transition(array[203001])', '42501', null, 'ni pasa uno a cierre');
select pruebas.como_dueno();
select ok(exists (select 1 from private.watchdog_areas() where function_name = 'schema_violations_periods' and unusable_reason is null),
  'el área de los periodos está en el vigilante y se puede usar');
select is_empty($$select * from private.schema_violations_periods()$$, 'el vigilante de los periodos no encuentra nada');
select is_empty($$select * from private.schema_violations()$$, 'ni el de todo');

-- ---------------------------------------------------------------------------------------
-- Cuándo pasa un mes a en cierre: el día DIA_CIERRE del mes siguiente, a las 00:00 en la zona del
-- periodo (la corrida de esa noche lo pasa). Los días se suman en hora local; el día se lee al
-- terminar el mes.

select is(private.period_closing_at(202610), timestamptz '2026-11-03 06:00Z', 'octubre de 2026: el 3 de noviembre en la Ciudad de México');
select is(private.period_closing_at(202612), timestamptz '2027-01-03 06:00Z', 'diciembre: el 3 de enero, aunque cambie el año');
select pruebas.parametro('DIA_CIERRE', '10', null, '2031-01-01 06:00Z');
select pruebas.parametro('DIA_CIERRE', '1', null, '2032-01-01 06:00Z');
select pruebas.parametro('DIA_CIERRE', '28', null, '2033-01-01 06:00Z');
select pruebas.parametro('DIA_CIERRE', '29', null, '2034-01-01 06:00Z');
select pruebas.parametro('DIA_CIERRE', '0', null, '2035-01-01 06:00Z');
-- Un texto no lo deja pasar el guardián de los parámetros; sin él, tampoco lo acepta el cierre.
alter table public.business_parameters disable trigger business_parameters_effective;
select pruebas.parametro('DIA_CIERRE', '"3"', null, '2036-01-01 06:00Z');
alter table public.business_parameters enable trigger business_parameters_effective;
select is(private.period_closing_at(203011), timestamptz '2030-12-03 06:00Z', 'el día se lee al terminar el mes: noviembre de 2030 con el 3');
select is(private.period_closing_at(203012), timestamptz '2031-01-10 06:00Z', 'y diciembre con el 10, que rige desde el 1 de enero');
select is(private.period_closing_at(203112), timestamptz '2032-01-01 06:00Z', 'con el día 1, en cierre al terminar el mes');
select is(private.period_closing_at(203212), timestamptz '2033-01-28 06:00Z', 'hasta el día 28');
select throws_ok('select private.period_closing_at(203312)', 'P0001', null, 'el 29 no: no todos los meses lo tienen');
select throws_ok('select private.period_closing_at(203412)', 'P0001', null, 'ni el 0');
select throws_ok('select private.period_closing_at(203512)', 'P0001', null, 'ni un texto');
select throws_ok('select private.period_closing_at(202101)', 'P0001', null, 'sin el día de ese momento no se adivina');

-- ---------------------------------------------------------------------------------------
-- El estado de un mes sin fila sale del reloj; con fila, de la fila.

select is(private.period_status_of(203701)::text, 'open', 'un mes futuro sin fila está abierto');
select is(private.period_status_of(pruebas.mes(0))::text, 'open', 'el en curso también');
select is(private.period_status_of(202101)::text, 'closing', 'uno de antes del arranque está en cierre: nadie lo cierra');
select is(private.period_status_of(pruebas.mes(1))::text,
  coalesce(pruebas.estado(pruebas.mes(1)),
           case when now() < private.period_closing_at(pruebas.mes(1)) then 'open' else 'closing' end),
  'el anterior, abierto hasta su día de cierre (depende de hoy)');

-- ---------------------------------------------------------------------------------------
-- Abrir un periodo: la fila con los instantes de su mes en la zona de ahora, una sola vez.

select ok(private.open_period(203701), 'abre un periodo sin fila');
select ok(not private.open_period(203701), 'la segunda vez ya estaba');
select results_eq(
  $$select status::text, timezone, starts_at, ends_at, entered_closing_at, active_students, carried_in_cents
    from public.payout_periods where period_id = 203701$$,
  $$values ('open', 'America/Mexico_City', timestamptz '2037-01-01 06:00Z', timestamptz '2037-02-01 06:00Z',
            null::timestamptz, null::integer, 0::bigint)$$,
  'abierto, en la zona de los periodos, con los instantes de su mes y sin cifras');
select ok(private.open_period(202102), 'abre uno de antes del arranque');
select results_eq($$select status::text, entered_closing_at is not null from public.payout_periods where period_id = 202102$$,
  $$values ('closing', true)$$, 'con el estado que le daba el reloj: en cierre, con su hora');
select is(current_setting('app.actor_kind', true), '', 'quien actúa queda como estaba');
select results_eq(
  $$select actor_kind, category::text, action from public.audit_log
    where occurred_at = now() and entity_table = 'public.payout_periods' and entity_id = '203701' order by id$$,
  $$values ('system', 'money', 'payout_periods.insert')$$, 'abrir queda en la auditoría, como el sistema');

-- ---------------------------------------------------------------------------------------
-- El guardián: la forma al insertar, y después solo avanza.

select pruebas.como_dueno_sistema();
select throws_ok(
  $$insert into public.payout_periods (period_id, starts_at, ends_at, timezone) values (203702, '2037-02-01 00:00Z', '2037-03-01 06:00Z', 'America/Mexico_City')$$,
  '23514', null, 'el inicio tiene que ser el de su mes en su zona');
select throws_ok(
  $$insert into public.payout_periods (period_id, starts_at, ends_at, timezone) values (203702, '2037-02-01 06:00Z', '2037-03-02 06:00Z', 'America/Mexico_City')$$,
  '23514', null, 'y el fin');
select throws_ok(
  $$insert into public.payout_periods (period_id, starts_at, ends_at, timezone) values (203702, '2037-02-01 06:00Z', '2037-03-01 06:00Z', 'Marte/Olimpo')$$,
  '23514', null, 'una zona que no existe no');
select throws_ok(
  $$insert into public.payout_periods (period_id, starts_at, ends_at, timezone, status) values (203702, '2037-02-01 06:00Z', '2037-03-01 06:00Z', 'America/Mexico_City', 'closed')$$,
  '23514', 'public.payout_periods: period 203702 starts open or closing, without figures', 'nace abierto o en cierre: cerrar es de T-602');
select throws_ok(
  $$insert into public.payout_periods (period_id, starts_at, ends_at, timezone, carried_in_cents) values (203702, '2037-02-01 06:00Z', '2037-03-01 06:00Z', 'America/Mexico_City', 5)$$,
  '23514', null, 'sin lo arrastrado: lo escribe el cierre');
select throws_ok(
  $$insert into public.payout_periods (period_id, starts_at, ends_at, timezone, active_students) values (203702, '2037-02-01 06:00Z', '2037-03-01 06:00Z', 'America/Mexico_City', 3)$$,
  '23514', null, 'ni los alumnos activos');
select throws_ok(
  format($$insert into public.payout_periods (period_id, starts_at, ends_at, timezone) values (203705, %L, %L, 'EST5EDT')$$,
         pruebas.inicio(203705, 'EST5EDT'), pruebas.fin(203705, 'EST5EDT')),
  '23514', null, 'ni una zona sin nombre de lugar, aunque sus instantes cuadren');
select pruebas.fila(203003, 'open', 'Asia/Tokyo');
select is(pruebas.estado(203003), 'open', 'un periodo puede tener otra zona, si sus instantes son los de esa zona');
select throws_ok($$select pruebas.fila(203002)$$, '23P01', null, 'pero no se encima con otro: el febrero de México se mete en el marzo de Tokio');
select throws_ok($$select pruebas.fila(203801, 'closing')$$, '23514', null, 'no nace en cierre un mes que no ha llegado a su día');
select pruebas.fila(202108, 'closing');
select ok((select entered_closing_at is not null from public.payout_periods where period_id = 202108),
  'uno que ya llegó nace en cierre con su hora, la pone la base');

select pruebas.fila(202109);
select pruebas.fila(202110);
select pruebas.como_dueno_sistema();
select throws_ok($$update public.payout_periods set status = 'closing' where period_id = 203701$$, '23514', null,
  'un mes que no ha llegado a su día no pasa a en cierre');
select throws_ok($$update public.payout_periods set status = 'closing' where period_id = 202109$$, '23514',
  'public.payout_periods: period 202109 needs its photo before closing', 'sin su foto no pasa a en cierre');
update public.payout_periods set active_students = 0 where period_id = 202109;
update public.payout_periods set status = 'closing', entered_closing_at = '2000-01-01 00:00Z' where period_id = 202109;
select results_eq($$select status::text, entered_closing_at = now() from public.payout_periods where period_id = 202109$$,
  $$values ('closing', true)$$, 'de abierto a en cierre, con la hora que pone la base');
select throws_ok($$update public.payout_periods set status = 'open' where period_id = 202109$$, '23514', null, 'no regresa a abierto');
select throws_ok($$update public.payout_periods set status = 'closed' where period_id = 202109$$, '23514', null,
  'ni pasa a cerrado: lo hace T-602');
select throws_ok($$update public.payout_periods set entered_closing_at = now() - interval '1 day' where period_id = 202109$$, '23514', null,
  'su hora de cierre no cambia');
select throws_ok($$update public.payout_periods set starts_at = starts_at + interval '1 hour' where period_id = 202109$$, '23514', null,
  'ni sus instantes');
select throws_ok($$update public.payout_periods set timezone = 'UTC' where period_id = 202109$$, '23514', null, 'ni su zona');
select throws_ok($$update public.payout_periods set carried_in_cents = 1 where period_id = 202109$$, '23514', null, 'ni lo arrastrado');
select throws_ok($$update public.payout_periods set active_students = 1 where period_id = 203701$$, '23514', null,
  'ni toma la foto de un mes que no ha terminado (la foto, en 41_tramos)');
select throws_ok($$update public.payout_periods set period_id = 202112 where period_id = 202109$$, '23514', null, 'ni el periodo');
select throws_ok($$delete from public.payout_periods where period_id = 202109$$, '42501', null, 'un periodo no se borra');
select throws_ok($$truncate public.payout_periods cascade$$, '42501', null, 'ni se vacía la tabla');
select results_eq(
  $$select actor_kind, old_value ->> 'status', new_value ->> 'status' from public.audit_log
    where occurred_at = now() and entity_table = 'public.payout_periods' and entity_id = '202109' and action = 'payout_periods.update'
      and new_value ->> 'status' = 'closing'$$,
  $$values ('system', 'open', 'closing')$$, 'el cambio de estado queda en la auditoría, con el de antes');
select pruebas.como_dueno();
select pruebas.como_dueno_sistema();
update public.payout_periods set active_students = 0 where period_id = 202110;
select pruebas.como_dueno();
select throws_ok($$update public.payout_periods set status = 'closing' where period_id = 202110$$, '42501', null,
  'sin quien actúe, no hay cambio (la auditoría lo exige)');

-- ---------------------------------------------------------------------------------------
-- El periodo de un instante: el de la fila que lo contiene; sin fila, el mes en la zona de ahora.

select is(private.period_of('2036-03-01 05:59:59Z')::integer, 203602, 'sin fila: el 29 de febrero a las 23:59 en México');
select is(private.period_of('2036-03-01 06:00Z')::integer, 203603, 'y a las 00:00 del 1 de marzo, marzo');
select is(private.period_of('2030-02-28 16:00Z')::integer, 203003, 'con fila manda la fila: ya es marzo en Tokio');
select is(private.period_of('2030-02-28 15:00Z')::integer, 203003, 'desde el primer instante de su fila');
select is(private.period_closing_at(203003), timestamptz '2030-04-02 15:00Z', 'y su cierre, en la zona de su fila: el 3 de abril en Tokio');
select is(private.period_of('2030-02-28 14:00Z')::integer, 203002, 'antes de su inicio, el mes de la zona de ahora');

-- ---------------------------------------------------------------------------------------
-- La ventana: el mes anterior y el en curso por reloj, más los periodos abiertos o en cierre que ya
-- empezaron, menos los cerrados y los pagados. En orden.

select ok(array[pruebas.mes(1), pruebas.mes(0)] <@ pruebas.ventana(), 'el anterior y el en curso, siempre que no estén cerrados');
select pruebas.fila(202103);
select ok(202102 = any (pruebas.ventana()), 'un periodo en cierre que ya empezó, aunque sea viejo');
select ok(202103 = any (pruebas.ventana()), 'uno abierto, también');
select ok(not 203701 = any (pruebas.ventana()) and not 203003 = any (pruebas.ventana()), 'uno que no ha empezado, no');
select is(pruebas.ventana(), array(select unnest(pruebas.ventana()) order by 1), 'en orden');
select pruebas.forzar(202103, 'closed');
select pruebas.como_dueno_sistema();
select throws_ok($$update public.payout_periods set status = 'closing' where period_id = 202103$$, '23514', null,
  'uno cerrado no regresa a en cierre');
select pruebas.forzar(202102, 'paid');
select ok(not 202103 = any (pruebas.ventana()), 'uno cerrado sale');
select ok(not 202102 = any (pruebas.ventana()), 'y uno pagado');
select pruebas.forzar(202102, 'closing');
select pruebas.forzar(202103, 'open');

-- ---------------------------------------------------------------------------------------
-- El paso a cierre (lo llama la corrida de cada noche al terminar).

select pruebas.fila(202104);
select pruebas.fila(202105);
-- Las filas del mes en curso y los dos siguientes que dejaron otras corridas en la base local, fuera
-- (dentro de esta transacción): así se ve que el paso las abre.
alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
delete from public.payout_periods
where period_id in (pruebas.mes(0), private.period_plus(pruebas.mes(0), 1), private.period_plus(pruebas.mes(0), 2));
alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
select pruebas.fila(203901);
-- Sin la foto (sus alumnos activos) no pasa a cierre: la toma la corrida al empezar (41_tramos).
select pruebas.como_dueno_sistema();
update public.payout_periods set active_students = 0 where period_id = 202104;
select set_config('app.actor_kind', 'prueba', true);
select set_config('pruebas.paso', private.period_transition(array[202104, 203901, pruebas.mes(0)])::text, true);
select is(current_setting('app.actor_kind', true), 'prueba', 'quien actúa queda como estaba');
select ok(current_setting('pruebas.paso')::jsonb -> 'entered_closing' @> '[202104]', 'pasa a cierre el que ya llegó a su día y se consolidó');
select is(pruebas.estado(202104), 'closing', 'en la tabla también');
select ok((select entered_closing_at = now() from public.payout_periods where period_id = 202104), 'con su hora');
select is(pruebas.estado(202105), 'open', 'el que no se consolidó sin error en la corrida se queda abierto');
select ok(current_setting('pruebas.paso')::jsonb -> 'held_open' @> '[202105]', 'y lo dice');
select ok(not current_setting('pruebas.paso')::jsonb -> 'held_open' @> '[202104]', 'sin contar como detenido al que pasó');
select is(pruebas.estado(203901), 'open', 'uno que no ha llegado a su día tampoco pasa');
select is(pruebas.estado(pruebas.mes(0)), 'open', 'ni el en curso');
select is(current_setting('pruebas.paso')::jsonb -> 'opened',
  jsonb_build_array(pruebas.mes(0), private.period_plus(pruebas.mes(0), 1), private.period_plus(pruebas.mes(0), 2)),
  'abre las filas del mes en curso y los dos siguientes');
select is((select count(*)::integer from public.payout_periods
           where period_id in (pruebas.mes(0), private.period_plus(pruebas.mes(0), 1), private.period_plus(pruebas.mes(0), 2)) and status = 'open'), 3,
  'abiertas');
select ok(not current_setting('pruebas.paso')::jsonb ? 'open_failed', 'sin ninguna que no se pudiera abrir');
select ok(not current_setting('pruebas.paso')::jsonb ? 'photo_missing', 'ni sin foto: el que no se consolidó no la pide todavía');
select is((select actor_kind from public.audit_log
           where occurred_at = now() and entity_table = 'public.payout_periods' and entity_id = '202104' and action = 'payout_periods.update'
             and new_value ->> 'status' = 'closing'),
  'system', 'el paso queda en la auditoría como el sistema');
select is(private.period_transition(array[202104]) -> 'entered_closing', '[]'::jsonb, 'otra vez no pasa nada');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- Los cobros: el que llega a un periodo cerrado, o a uno de antes de la ventana sin fila, es tardío.
-- Se queda en su mes (`period_id`), con la regla de su mes, y sus partes empiezan en el primer
-- periodo abierto (`allocation_start_period_id`), con la regla `late_charge_v1`.

select pruebas.alta(pruebas.ana(), 'ana-periodos@prueba.test');
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency) values
  ('c0000000-0000-0000-0000-000000000001', pruebas.ana(), 'manual', 'sus-periodos', 'monthly', 'pending', 'MXN'),
  ('c0000000-0000-0000-0000-000000000002', pruebas.ana(), 'manual', 'sus-periodos-anual', 'annual', 'pending', 'MXN');
create function pruebas.cobra(p_charge text, p_at timestamptz, p_plan text default 'monthly', p_gross bigint default 34900) returns jsonb
language sql as $$
  select private.record_charge(pruebas.ana(),
           case p_plan when 'monthly' then 'c0000000-0000-0000-0000-000000000001'::uuid else 'c0000000-0000-0000-0000-000000000002'::uuid end,
           'manual', p_charge, null, p_plan::public.subscription_plan, p_at, 'MXN', p_gross, null, null, null, null, null) - 'charge_id'
$$;
create function pruebas.cobro(p_charge text) returns public.charges
language sql as $$ select * from public.charges where provider_charge_id = p_charge $$;
create function pruebas.partes_de(p_charge text) returns table (period_id integer, base_cents bigint, rule text)
language sql as $$
  select a.period_id::integer, a.base_cents, a.rule from public.revenue_allocations a
  join public.charges c on c.id = a.charge_id where c.provider_charge_id = p_charge order by a.part_no
$$;
-- La regla del ingreso desde 2020 (la semilla empieza en 202610); en febrero, otra comisión.
select pruebas.parametro(k, v, 202001)
from (values ('IVA_EN_PRECIO', 'true'::jsonb), ('IVA_PCT', '1600'), ('COMISION_COBRO_PCT', '500'), ('BASE_COMISION', '"fixed_rate"'),
             ('INGRESO_POR_PERIODO', '"monthly_when_charged_annual_in_twelfths"')) as x (k, v);
select pruebas.parametro('COMISION_COBRO_PCT', '800', 202002);
select pruebas.parametro('COMISION_COBRO_PCT', '500', 202003);
select pruebas.fila(202002);
select pruebas.forzar(202002, 'closed');
select pruebas.fila(202003);

select is(pruebas.cobra('tarde-feb', '2020-02-15 12:00-06'), '{"outcome": "recorded", "late": true}'::jsonb,
  'un cobro de un mes cerrado se registra, y la respuesta dice que es tardío');
select results_eq(
  $$select period_id::integer, allocation_start_period_id::integer, fee_bps::integer, revenue_net_mxn_cents from pruebas.cobro('tarde-feb')$$,
  $$values (202002, 202003, 800, 27679::bigint)$$,
  'se queda en su mes, con la comisión de su mes, y sus partes empiezan en el primer periodo abierto');
select results_eq($$select * from pruebas.partes_de('tarde-feb')$$, $$values (202003, 27679::bigint, 'late_charge_v1')$$,
  'su parte va a marzo con la regla del cobro tardío');
select is(pruebas.cobra('tarde-feb', '2020-02-15 12:00-06'), '{"outcome": "already_recorded"}'::jsonb,
  'repetido, la respuesta de siempre');
select is(pruebas.cobra('tarde-ene', '2020-01-15 12:00-06'), '{"outcome": "recorded", "late": true}'::jsonb,
  'uno de un mes sin fila de antes de la ventana también es tardío');
select results_eq($$select period_id::integer, allocation_start_period_id::integer from pruebas.cobro('tarde-ene')$$,
  $$values (202001, 202003)$$, 'empieza en el primer periodo abierto después de su mes');
select is(pruebas.estado(202001), null, 'y su mes sigue sin fila: no se abre un mes viejo');
select is(pruebas.cobra('a-tiempo', '2020-03-10 12:00-06'), '{"outcome": "recorded"}'::jsonb,
  'uno de un periodo abierto, la respuesta de siempre');
select results_eq($$select c.allocation_start_period_id::integer, p.rule from pruebas.cobro('a-tiempo') c, pruebas.partes_de('a-tiempo') p$$,
  $$values (202003, 'charge_date_v1')$$, 'empieza en su mes, con la regla de siempre');
select is(pruebas.cobra('tarde-anual', '2020-02-20 12:00-06', 'annual', 299000), '{"outcome": "recorded", "late": true}'::jsonb,
  'un anual tardío');
select results_eq(
  $$select count(*)::integer, min(period_id), max(period_id), sum(base_cents)::bigint, bool_and(rule = 'late_charge_v1') from pruebas.partes_de('tarde-anual')$$,
  $$values (12, 202003, 202102, 237138::bigint, true)$$, 'reparte sus doce partes desde el primer periodo abierto');
select is(pruebas.cobra('mes-pasado', pruebas.inicio(pruebas.mes(1)) + interval '1 day'), '{"outcome": "recorded"}'::jsonb,
  'uno del mes anterior no es tardío, esté abierto o en cierre (depende de hoy)');
select results_eq($$select period_id::integer, allocation_start_period_id::integer from pruebas.cobro('mes-pasado')$$,
  format('values (%s, %s)', pruebas.mes(1), pruebas.mes(1)), 'y empieza en su mes');
select ok(pruebas.estado(pruebas.mes(1)) in ('open', 'closing'), 'que ya tiene fila, con el estado del reloj si no la tenía');
select is(pruebas.cobra('tarde-abr', '2020-04-15 12:00-06') ->> 'late', 'true', 'uno de un mes sin fila después de un periodo abierto');
select is((pruebas.cobro('tarde-abr')).allocation_start_period_id::integer, 202103,
  'no empieza en el abierto de antes de su mes, sino en el primero después');
select pruebas.forzar(202003, 'closed');
select is(pruebas.cobra('tarde-lejos', '2020-02-25 12:00-06') ->> 'late', 'true', 'con el siguiente cerrado, también');
select is((pruebas.cobro('tarde-lejos')).allocation_start_period_id::integer, 202103, 'va al primer periodo abierto, aunque esté lejos');
select pruebas.forzar(202103, 'closed');
select pruebas.forzar(202105, 'closed');
select is(pruebas.cobra('tarde-sin-abierto', '2020-02-26 12:00-06') ->> 'late', 'true', 'sin ninguno abierto entre medio');
select is((pruebas.cobro('tarde-sin-abierto')).allocation_start_period_id::integer, 202110,
  'va al primero abierto que haya después, aunque sea uno viejo que se quedó abierto');
select pruebas.forzar(202103, 'open');
select pruebas.forzar(202105, 'open');

-- La tabla dice lo mismo, escrita a mano como el dueño.
create function pruebas.cobro_directo(p_charge text, p_period integer, p_start integer) returns void
language sql as $$
  insert into public.charges (profile_id, subscription_id, provider, provider_charge_id, plan, charged_at, period_id, allocation_start_period_id,
                              currency, gross_cents, tax_cents, fx_rate_to_mxn, fx_source, gross_mxn_cents, net_of_tax_mxn_cents,
                              iva_bps, fee_bps, revenue_net_mxn_cents)
  values (pruebas.ana(), 'c0000000-0000-0000-0000-000000000001', 'manual', p_charge, 'monthly', '2020-02-15 12:00-06', p_period, p_start,
          'MXN', 34900, 4814, 1, 'same_currency', 34900, 30086, 1600, 500, 28581)
$$;
select pruebas.fila(202005);
select throws_ok($$select pruebas.cobro_directo('antes', 202005, 202004)$$, '23514', null, 'sus partes no empiezan antes de su mes');
select throws_ok($$select pruebas.cobro_directo('sin-periodo', 202005, 204001)$$, '23503', null, 'ni en un periodo que no existe');
select throws_ok($$select pruebas.cobro_directo('congelado', 202002, 202002)$$, '55000', null, 'ni en uno cerrado');
select lives_ok($$select pruebas.cobro_directo('directo', 202004, 202005)$$, 'en uno abierto, sí');
select throws_ok(
  $$insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
    select id, profile_id, 202005, 'charge', 1, 1, 28581, 500, 'charge_date_v1' from pruebas.cobro('directo')$$,
  '23514', null, 'la parte de un cobro tardío lleva la regla del cobro tardío');
select throws_ok(
  $$insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
    select id, profile_id, 202004, 'charge', 1, 1, 28581, 500, 'late_charge_v1' from pruebas.cobro('directo')$$,
  '23514', null, 'y empieza donde dice su cobro, no en su mes');
select lives_ok(
  $$insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
    select id, profile_id, 202005, 'charge', 1, 1, 28581, 500, 'late_charge_v1' from pruebas.cobro('directo')$$,
  'así, sí');
select throws_ok(
  $$insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
    select id, profile_id, 202002, 'charge', 2, 2, 0, 500, 'late_charge_v1' from pruebas.cobro('directo')$$,
  '55000', null, 'ninguna parte entra a un periodo cerrado');

-- ---------------------------------------------------------------------------------------
-- Lo demás que se congela con el periodo cerrado: abrir una alerta, crear o revertir una exclusión.

select pruebas.como_dueno_sistema();
select throws_ok(
  $$insert into public.anomaly_alerts (period_id, kind, metric_value, threshold_value) values (202002, 'unconsumed_pool_ratio', 1, 1)$$,
  '55000', null, 'no se abre una alerta en un periodo cerrado');
select pruebas.forzar(202102, 'paid');
select pruebas.como_dueno_sistema();
select throws_ok(
  $$insert into public.anomaly_alerts (period_id, kind, metric_value, threshold_value) values (202102, 'unconsumed_pool_ratio', 1, 1)$$,
  '55000', null, 'ni en uno pagado');
select pruebas.forzar(202102, 'closing');
select pruebas.como_dueno_sistema();
insert into public.anomaly_alerts (period_id, kind, metric_value, threshold_value) values (202005, 'unconsumed_pool_ratio', 1, 1);
select pruebas.forzar(202005, 'closed');
select pruebas.como_dueno_sistema();
alter table public.anomaly_alerts disable trigger alerts_guard;
update public.anomaly_alerts set review_note = 'revisada después del cierre' where period_id = 202005;
alter table public.anomaly_alerts enable trigger alerts_guard;
select is((select review_note from public.anomaly_alerts where period_id = 202005), 'revisada después del cierre',
  'pero revisar una sigue, cerrado el periodo');
select throws_ok(
  format($$insert into public.consumption_exclusions (period_id, scope, profile_id, reason_code, reason, created_by)
           values (202002, 'account', %L, 'other', 'prueba', %L)$$, pruebas.ana(), pruebas.ana()),
  '55000', null, 'no se crea una exclusión en un periodo cerrado');
alter table public.consumption_exclusions disable trigger exclusions_guard;
insert into public.consumption_exclusions (period_id, scope, profile_id, reason_code, reason, created_by)
values (202103, 'account', pruebas.ana(), 'other', 'prueba', pruebas.ana());
select pruebas.forzar(202103, 'closed');
select pruebas.como_dueno_sistema();
select throws_ok(
  format($$update public.consumption_exclusions set revoked_at = now(), revoked_by = %L, revoke_reason = 'prueba' where period_id = 202103$$, pruebas.ana()),
  '55000', null, 'ni se revierte una');
alter table public.consumption_exclusions enable trigger exclusions_guard;
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- El vigilante de los periodos ve lo que se le quite.

select pruebas.como_dueno_sistema();
alter table public.charges disable trigger charges_frozen;
select results_eq($$select problem, object_name from private.schema_violations_periods()$$,
  $$values ('period trigger missing or disabled: charges_frozen', 'public.charges')$$, 'un congelado apagado');
alter table public.charges enable trigger charges_frozen;
grant execute on function private.open_period(public.period_id) to app_service;
select results_eq($$select problem, object_name like 'private.open_period(%' from private.schema_violations_periods()$$,
  $$values ('period function executable by app_service', true)$$, 'una función que la aplicación ejecuta');
revoke execute on function private.open_period(public.period_id) from app_service;
grant select on public.payout_periods to authenticated;
select results_eq($$select problem, object_name from private.schema_violations_periods()$$,
  $$values ('period table reachable by authenticated', 'public.payout_periods')$$, 'la tabla al alcance de una sesión');
revoke select on public.payout_periods from authenticated;
alter function private.period_status_of(public.period_id) security definer;
select results_eq($$select problem, object_name like 'private.period_status_of(%' from private.schema_violations_periods()$$,
  $$values ('period function security definer or without fixed search_path', true)$$,
  'una función que corre como el dueño');
alter function private.period_status_of(public.period_id) security invoker;
select is_empty($$select * from private.schema_violations_periods()$$, 'y todo en su lugar otra vez');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- Un periodo cerrado sale de la ventana aunque sea el mes anterior.

select private.open_period(pruebas.mes(1));
select pruebas.forzar(pruebas.mes(1), 'closed');
select ok(not pruebas.mes(1) = any (pruebas.ventana()), 'el mes anterior cerrado ya no se consolida');
select is(private.period_status_of(pruebas.mes(1))::text, 'closed', 'su estado es el de su fila');
select pruebas.forzar(pruebas.mes(1), 'paid');
select ok(not pruebas.mes(1) = any (pruebas.ventana()), 'ni pagado');
select pruebas.forzar(pruebas.mes(1), 'closing');

-- ---------------------------------------------------------------------------------------
-- La detección en un periodo en cierre más viejo que el anterior: el bote sin consumo se mira en
-- todo periodo de la ventana que ya terminó.

select pruebas.parametro('BOTE_PCT_TECHO', '7500', 202001);
select pruebas.parametro('BOTE_REGLA_TRAMO', '"marginal_tiers"', 202001);
select pruebas.parametro('BOTE_SIN_CONSUMO', '"proportional_to_assigned_pool"', 202001);
select pruebas.como_dueno_sistema();
select private.set_pool_tiers(202001, '{0}', '{6000}');
select pruebas.como_dueno();
select pruebas.fila(202106, 'closing');
select pruebas.cobro_directo('viejo-en-cierre', 202106, 202106);
insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
select id, profile_id, 202106, 'charge', 1, 1, 28581, 500, 'charge_date_v1' from pruebas.cobro('viejo-en-cierre');
select ok(202106 = any (pruebas.ventana()), 'el periodo en cierre sigue en la ventana');
select is(private.detect_anomalies(202106, now()), '{"alerts_opened": 1}'::jsonb, 'y su bote sin consumo se mira: nadie vio nada');
select is((select (details ->> 'pool_cents')::bigint from public.anomaly_alerts where period_id = 202106 and kind = 'unconsumed_pool_ratio'),
  17148::bigint, 'con el bote de ese periodo');

-- ---------------------------------------------------------------------------------------
-- Un cobro tardío sin ningún periodo abierto después del suyo, ni el en curso: lanza, no se adivina.

select pruebas.fila(202111);
select pruebas.forzar(202111, 'closed');
select pruebas.como_dueno_sistema();
alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
update public.payout_periods set status = 'closed', entered_closing_at = coalesce(entered_closing_at, now())
where status = 'open' and period_id > 202111;
alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
select pruebas.como_dueno();
select throws_ok($$select private.allocation_start(202111)$$, 'P0001', null,
  'sin un periodo abierto después del suyo ni el en curso, el cobro tardío no se escribe');

-- ---------------------------------------------------------------------------------------
-- Sin la zona de los periodos no se adivina: ni el periodo de un instante sin fila.

alter table public.business_parameters disable trigger business_parameters_effective;
select pruebas.parametro('ZONA_HORARIA_PERIODO', 'null'::jsonb, null, now());
alter table public.business_parameters enable trigger business_parameters_effective;
select throws_ok($$select private.period_of('2040-06-01 00:00Z')$$, 'P0001', null, 'sin la zona, el periodo de un instante sin fila lanza');

select * from finish();
rollback;
