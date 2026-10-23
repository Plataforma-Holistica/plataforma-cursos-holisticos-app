-- T-301 · El libro propio de ingresos y la asignación del ingreso por periodo (RF-211, RN-02;
-- 05 §5.3 y §8.7). Decisiones de Sergio del 2026-10-22: la regla vive en la base; T-301 son los
-- cobros y sus partes (los reversos llegan con T-307 y la bandeja de avisos con T-303); solo
-- pesos por ahora; y nadie de la aplicación escribe: `private.record_charge()` la abre T-303.
--
-- Ninguna prueba depende de hoy salvo la del cobro en el futuro: los ejemplos del PRD van en
-- octubre de 2026 (el periodo de la semilla y el de 05 §8.7), y para los cambios de parámetro se
-- escriben aquí, como el dueño, versiones de meses anteriores.
begin;
\ir _ayuda.psql
-- La revisión de las partes de un cobro es diferida: aquí, al final de cada sentencia.
set constraints all immediate;
select plan(132);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana-ingresos@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto-ingresos@prueba.test');

create function pruebas.ana() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.beto() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000002'::uuid $$;
-- Las suscripciones, escritas por el dueño (nadie de la aplicación puede todavía). Pendientes: el
-- primer cobro llega antes de que una suscripción esté activa.
create function pruebas.sus(p_n integer) returns uuid language sql immutable
as $$ select ('c0000000-0000-0000-0000-00000000000' || p_n)::uuid $$;
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency) values
  (pruebas.sus(1), pruebas.ana(), 'manual', 'sus-ana', 'monthly', 'pending', 'MXN'),
  (pruebas.sus(2), pruebas.ana(), 'stripe', 'sus-ana-stripe', 'monthly', 'pending', 'MXN'),
  (pruebas.sus(3), pruebas.beto(), 'manual', 'sus-beto', 'monthly', 'pending', 'MXN'),
  (pruebas.sus(4), pruebas.ana(), 'manual', 'sus-ana-otra', 'annual', 'pending', 'MXN');

-- Un cobro con todo lo de siempre; cada prueba cambia lo suyo.
create function pruebas.cobra(
  p_charge text, p_plan text, p_at timestamptz, p_gross bigint,
  p_profile uuid default 'a0000000-0000-0000-0000-000000000001', p_subscription uuid default 'c0000000-0000-0000-0000-000000000001',
  p_provider text default 'manual', p_currency text default 'MXN', p_fee bigint default null, p_net bigint default null,
  p_method text default 'card', p_country text default 'MX', p_receipt text default null, p_invoice text default null)
returns jsonb language sql
as $$
  select private.record_charge(p_profile, p_subscription, p_provider, p_charge, p_invoice, p_plan::public.subscription_plan,
                               p_at, p_currency, p_gross, p_fee, p_net, p_method, p_country, p_receipt)
$$;
create function pruebas.resultado(p_answer jsonb) returns text language sql immutable as $$ select p_answer ->> 'outcome' $$;
create function pruebas.cobros() returns integer language sql as $$ select count(*)::integer from public.charges $$;
create function pruebas.partes() returns integer language sql as $$ select count(*)::integer from public.revenue_allocations $$;
create function pruebas.cobro(p_charge text) returns public.charges
language sql as $$ select * from public.charges where provider_charge_id = p_charge $$;
-- Las partes de un cobro: periodo y monto, en orden.
create function pruebas.partes_de(p_charge text) returns table (part_no smallint, period_id integer, base_cents bigint)
language sql as $$
  select a.part_no, a.period_id::integer, a.base_cents from public.revenue_allocations a
  join public.charges c on c.id = a.charge_id where c.provider_charge_id = p_charge order by a.part_no
$$;
-- Una versión de un parámetro desde un periodo, como el dueño (las fechas pasadas no las deja el
-- guardián de los cambios).
create function pruebas.parametro(p_key text, p_value jsonb, p_period integer, p_from timestamptz default null) returns void
language sql as $$
  insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
  values (p_key, p_value, 'decided',
          coalesce(p_from, timezone('America/Mexico_City', to_date(p_period::text || '01', 'YYYYMMDD')::timestamp)), p_period)
$$;

grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- Las tablas: dos libros que nadie de la aplicación toca.

select has_table('public', 'charges', 'el libro de los cobros');
select has_table('public', 'revenue_allocations', 'el de sus partes por periodo');
select col_type_is('public', 'charges', 'gross_cents', 'bigint', 'los montos van en centavos enteros');
select col_type_is('public', 'charges', 'iva_bps', 'bps', 'el cobro guarda la tasa de IVA que se le aplicó');
select col_type_is('public', 'charges', 'fee_bps', 'bps', 'y la comisión fija');
select col_type_is('public', 'charges', 'revenue_net_mxn_cents', 'bigint', 'y su ingreso neto (RF-211)');
select col_type_is('public', 'revenue_allocations', 'kind', 'allocation_kind', 'cada parte dice de qué es');
select hasnt_column('public', 'revenue_allocations', 'reversal_id', 'los reversos llegan con T-307');
select ok((select relrowsecurity from pg_class where oid = 'public.charges'::regclass), 'los cobros con seguridad por fila');
select ok((select relrowsecurity from pg_class where oid = 'public.revenue_allocations'::regclass), 'sus partes también');
select has_trigger('public', 'charges', 'ledger_no_update_delete', 'un cobro no se edita ni se borra');
select has_trigger('public', 'charges', 'ledger_no_truncate', 'ni se vacía el libro');
select has_trigger('public', 'revenue_allocations', 'ledger_no_update_delete', 'una parte tampoco');
select has_trigger('public', 'revenue_allocations', 'ledger_no_truncate', 'ni el libro de las partes');

select pruebas.como_usuario(pruebas.ana());
select throws_ok('select 1 from public.charges', '42501', null, 'una alumna no lee los cobros (su historial llega con T-306)');
select throws_ok('select 1 from public.revenue_allocations', '42501', null, 'ni las partes');
select pruebas.como_servicio();
select throws_ok('select 1 from public.charges', '42501', null, 'el servidor tampoco lee los cobros');
select throws_ok('select 1 from public.revenue_allocations', '42501', null, 'ni las partes (PA-79 llega con T-605)');
select throws_ok(format($$insert into public.charges (profile_id) values (%L)$$, pruebas.ana()), '42501', null,
  'ni escribe un cobro directo');
select throws_ok(
  format($$select private.record_charge(%L, %L, 'manual', 'servidor', null, 'monthly', '2026-10-10 12:00-06', 'MXN', 34900, null, null, null, null, null)$$,
         pruebas.ana(), pruebas.sus(1)),
  '42501', null, 'ni por la función: la abre T-303 para el aviso del proveedor');
select pruebas.como_sistema();
select throws_ok(
  format($$select private.record_charge(%L, %L, 'manual', 'sistema', null, 'monthly', '2026-10-10 12:00-06', 'MXN', 34900, null, null, null, null, null)$$,
         pruebas.ana(), pruebas.sus(1)),
  '42501', null, 'ni un trabajo del sistema por el camino del servidor');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- Los ejemplos del PRD (§6.3), al centavo: primero el IVA, luego la comisión, luego las partes.

select is(pruebas.resultado(pruebas.cobra('ejemplo-mensual', 'monthly', '2026-10-10 12:00-06', 34900)), 'recorded',
  'se registra el cobro mensual');
select results_eq(
  $$select period_id::integer, gross_cents, tax_cents, net_of_tax_mxn_cents, iva_bps::integer, fee_bps::integer, revenue_net_mxn_cents,
           currency, fx_rate_to_mxn, fx_source, gross_mxn_cents from public.charges where provider_charge_id = 'ejemplo-mensual'$$,
  $$values (202610, 34900::bigint, 4814::bigint, 30086::bigint, 1600, 500, 28581::bigint, 'MXN', 1::numeric, 'same_currency', 34900::bigint)$$,
  'mensual: 349.00 da 300.86 sin IVA y 285.81 de ingreso neto, en octubre');
select results_eq($$select * from pruebas.partes_de('ejemplo-mensual')$$,
  $$values (1::smallint, 202610, 28581::bigint)$$, 'una sola parte, entera, en el periodo del cobro');
select results_eq(
  $$select a.parts_total::integer, a.fee_bps::integer, a.rule, a.kind::text, a.profile_id from public.revenue_allocations a
    join public.charges c on c.id = a.charge_id where c.provider_charge_id = 'ejemplo-mensual'$$,
  format($$values (1, 500, 'charge_date_v1', 'charge', %L::uuid)$$, pruebas.ana()),
  'la parte dice la comisión, la regla y de quién es');

select is(pruebas.resultado(pruebas.cobra('ejemplo-anual', 'annual', '2026-10-10 12:00-06', 299000, p_subscription => pruebas.sus(4))),
  'recorded', 'se registra el cobro anual');
select results_eq(
  $$select tax_cents, net_of_tax_mxn_cents, revenue_net_mxn_cents from public.charges where provider_charge_id = 'ejemplo-anual'$$,
  $$values (41241::bigint, 257759::bigint, 244871::bigint)$$, 'anual: 2 990.00 da 2 577.59 sin IVA y 2 448.71 de ingreso neto');
select results_eq($$select * from pruebas.partes_de('ejemplo-anual')$$,
  $$values (1::smallint, 202610, 20405::bigint), (2::smallint, 202611, 20405::bigint), (3::smallint, 202612, 20405::bigint),
           (4::smallint, 202701, 20405::bigint), (5::smallint, 202702, 20405::bigint), (6::smallint, 202703, 20405::bigint),
           (7::smallint, 202704, 20405::bigint), (8::smallint, 202705, 20405::bigint), (9::smallint, 202706, 20405::bigint),
           (10::smallint, 202707, 20405::bigint), (11::smallint, 202708, 20405::bigint), (12::smallint, 202709, 20416::bigint)$$,
  'doce partes en doce meses seguidos: once de 204.05 y la última de 204.16');
select is((select sum(base_cents) from pruebas.partes_de('ejemplo-anual')), 244871::numeric,
  'las doce suman exactamente el ingreso neto (el criterio de T-301)');

-- ---------------------------------------------------------------------------------------
-- La regla de cada periodo. Versiones de meses anteriores, como el dueño.

alter table public.business_parameters disable trigger user;
select pruebas.parametro('IVA_EN_PRECIO', 'true', 202601);
select pruebas.parametro('IVA_PCT', '1600', 202601);
select pruebas.parametro('COMISION_COBRO_PCT', '500', 202601);
select pruebas.parametro('BASE_COMISION', '"fixed_rate"', 202601);
select pruebas.parametro('INGRESO_POR_PERIODO', '"monthly_when_charged_annual_in_twelfths"', 202601);
select pruebas.parametro('IVA_EN_PRECIO', 'false', 202603);
select pruebas.parametro('IVA_EN_PRECIO', 'true', 202604);
select pruebas.parametro('BASE_COMISION', '"provider_actual"', 202604);
select pruebas.parametro('BASE_COMISION', '"fixed_rate"', 202605);
select pruebas.parametro('INGRESO_POR_PERIODO', '"service_days"', 202605);
select pruebas.parametro('INGRESO_POR_PERIODO', '"monthly_when_charged_annual_in_twelfths"', 202606);
select pruebas.parametro('IVA_PCT', '800', 202606);
select pruebas.parametro('IVA_PCT', '1600', 202607);
-- Dos versiones del mismo periodo: gana la escrita para regir después.
select pruebas.parametro('COMISION_COBRO_PCT', '800', 202607);
select pruebas.parametro('COMISION_COBRO_PCT', '850', 202607, '2026-07-05 06:00Z');
-- Una comisión que rige desde septiembre, anotada a mediados de agosto: por periodo, un cobro de
-- agosto no la ve, aunque ya estuviera escrita cuando se cobró.
select pruebas.parametro('COMISION_COBRO_PCT', '700', 202609, '2026-08-15 06:00Z');

select is(pruebas.resultado(pruebas.cobra('julio', 'monthly', '2026-07-20 12:00-06', 34900)), 'recorded', 'un cobro de julio');
select is((pruebas.cobro('julio')).fee_bps::integer, 850, 'con la versión de julio que rige después');
select pruebas.parametro('COMISION_COBRO_PCT', '500', 202608);
select is(pruebas.resultado(pruebas.cobra('agosto', 'monthly', '2026-08-20 12:00-06', 34900)), 'recorded', 'un cobro de agosto');
select results_eq($$select period_id::integer, fee_bps::integer, revenue_net_mxn_cents from public.charges where provider_charge_id = 'agosto'$$,
  $$values (202608, 500, 28581::bigint)$$, 'con la comisión de su periodo, no la del instante en que se cobró');
select is(pruebas.resultado(pruebas.cobra('corte', 'monthly', '2026-09-30 23:30-06', 34900)), 'recorded',
  'un cobro a las 23:30 del último día de septiembre en la Ciudad de México');
select results_eq($$select period_id::integer, fee_bps::integer, revenue_net_mxn_cents from public.charges where provider_charge_id = 'corte'$$,
  $$values (202609, 700, 27979::bigint)$$, 'es de septiembre (en UTC ya era octubre) y lleva la comisión de septiembre');
select results_eq($$select a.period_id::integer, a.fee_bps::integer, a.base_cents from public.revenue_allocations a
                    join public.charges c on c.id = a.charge_id where c.provider_charge_id = 'corte'$$,
  $$values (202609, 700, 27979::bigint)$$, 'y su parte, la misma comisión');
select is(pruebas.resultado(pruebas.cobra('frontera', 'annual', '2026-06-15 12:00-06', 299000, p_subscription => pruebas.sus(4))),
  'recorded', 'un anual con otra tasa de IVA');
select results_eq($$select tax_cents, net_of_tax_mxn_cents, iva_bps::integer, revenue_net_mxn_cents from public.charges where provider_charge_id = 'frontera'$$,
  $$values (22148::bigint, 276852::bigint, 800, 263009::bigint)$$, 'el IVA de su periodo, guardado en el cobro');
select results_eq($$select period_id, base_cents from pruebas.partes_de('frontera') where part_no in (1, 7, 8, 12)$$,
  $$values (202606, 21917::bigint), (202612, 21917::bigint), (202701, 21917::bigint), (202705, 21922::bigint)$$,
  'sus doce partes cruzan el año, y la última lleva la diferencia');

select is(pruebas.cobros(), 6, 'van seis cobros');
-- Una tasa que no se entiende tampoco se adivina.
insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
values ('IVA_PCT', '"16"', 'decided', '2026-02-01 06:00Z', 202602);
select throws_ok('select private.revenue_rule(202602)', 'P0001', 'revenue rule for period 202602 has an invalid rate',
  'un IVA escrito como texto');
delete from public.business_parameters where key = 'IVA_PCT' and effective_period_id = 202602;
select pruebas.parametro('COMISION_COBRO_PCT', '10000', 202602);
select throws_ok('select private.revenue_rule(202602)', 'P0001', 'revenue rule for period 202602 has an invalid rate',
  'una comisión del cien por ciento');
delete from public.business_parameters where key = 'COMISION_COBRO_PCT' and effective_period_id = 202602;
select throws_ok($$select pruebas.cobra('sin-reglas', 'monthly', '2025-12-15 12:00-06', 34900)$$, 'P0001',
  'revenue rule is not set for period 202512', 'sin parámetros en su periodo, no se adivina');
select throws_ok($$select pruebas.cobra('sin-iva', 'monthly', '2026-03-15 12:00-06', 34900)$$, 'P0001',
  'revenue rule for period 202603 needs IVA_EN_PRECIO', 'un precio sin IVA no lo prevé RN-02');
select throws_ok($$select pruebas.cobra('comision-real', 'monthly', '2026-04-15 12:00-06', 34900)$$, 'P0001',
  'revenue rule for period 202604 needs BASE_COMISION fixed_rate', 'ni la comisión real (PQ-15)');
select throws_ok($$select pruebas.cobra('por-dias', 'monthly', '2026-05-15 12:00-06', 34900)$$, 'P0001',
  'revenue rule for period 202605 has an unknown INGRESO_POR_PERIODO', 'ni otra regla de asignación (PQ-12)');
select is(pruebas.cobros(), 6, 'y ninguno de esos deja un cobro');
select is(pruebas.partes(), 28, 'ni una parte: 1 + 12 + 1 + 1 + 1 + 12');

-- ---------------------------------------------------------------------------------------
-- El mismo cobro dos veces es uno; con otra cosa que lo define, es un conflicto.

select is(pruebas.cobra('ejemplo-mensual', 'monthly', '2026-10-10 12:00-06', 34900),
  jsonb_build_object('outcome', 'already_recorded', 'charge_id', (pruebas.cobro('ejemplo-mensual')).id),
  'repetirlo contesta el cobro que ya está');
select is(pruebas.resultado(pruebas.cobra('ejemplo-anual', 'annual', '2026-10-10 12:00-06', 299000, p_subscription => pruebas.sus(4),
                                          p_fee => 1700, p_net => 297300, p_receipt => 'https://recibo.test/1', p_invoice => 'factura-1',
                                          p_method => 'oxxo', p_country => 'US')),
  'already_recorded', 'aunque lleguen después la comisión real, el neto, el recibo o la factura: lo que no llegó primero no se agrega');
-- Escrita después que la de septiembre, pero para agosto: septiembre sigue con la suya. Y una de
-- septiembre cancelada, que no rige.
select pruebas.parametro('COMISION_COBRO_PCT', '900', 202608, '2026-08-20 06:00Z');
select is(pruebas.resultado(pruebas.cobra('agosto', 'monthly', '2026-08-20 12:00-06', 34900)), 'already_recorded',
  'ni si cambió un parámetro de su periodo: no se recalcula');
insert into public.business_parameters (key, value, status, effective_from, effective_period_id, canceled_at, canceled_by)
values ('COMISION_COBRO_PCT', '1100', 'decided', '2026-08-25 06:00Z', 202609, '2026-08-26 06:00Z', pruebas.ana());
select is(pruebas.resultado(pruebas.cobra('septiembre', 'monthly', '2026-09-10 12:00-06', 34900)), 'recorded', 'un cobro de septiembre después de eso');
select is((pruebas.cobro('septiembre')).fee_bps::integer, 700, 'manda el periodo de la versión, no cuándo se escribió, y la cancelada no cuenta');
select results_eq($$select fee_bps::integer, revenue_net_mxn_cents, receipt_url, payment_method from public.charges where provider_charge_id in ('agosto', 'ejemplo-anual') order by charged_at$$,
  $$values (500, 28581::bigint, null::text, 'card'), (500, 244871::bigint, null::text, 'card')$$, 'los dos quedan como se registraron');
select is(pruebas.partes(), 29, 'sin partes de más que la del cobro nuevo');

select is(pruebas.resultado(pruebas.cobra('ejemplo-mensual', 'monthly', '2026-10-10 12:00-06', 34900, p_profile => pruebas.beto(), p_subscription => pruebas.sus(3))),
  'conflict', 'el mismo identificador de otra cuenta es un conflicto');
select is(pruebas.resultado(pruebas.cobra('ejemplo-mensual', 'monthly', '2026-10-10 12:00-06', 34900, p_subscription => pruebas.sus(4))),
  'conflict', 'o de otra suscripción');
select is(pruebas.resultado(pruebas.cobra('ejemplo-mensual', 'annual', '2026-10-10 12:00-06', 34900)), 'conflict', 'o de otro plan');
select is(pruebas.resultado(pruebas.cobra('ejemplo-mensual', 'monthly', '2026-10-10 12:00:01-06', 34900)), 'conflict', 'o de otro instante');
select is(pruebas.resultado(pruebas.cobra('ejemplo-mensual', 'monthly', '2026-10-10 12:00-06', 34901)), 'conflict', 'o de otro monto');
select is(pruebas.cobra('ejemplo-mensual', 'monthly', '2026-10-10 12:00-06', 34901) -> 'charge_id', 'null'::jsonb,
  'un conflicto no dice qué cobro hay');
select is(pruebas.resultado(pruebas.cobra('ejemplo-mensual', 'monthly', '2026-10-10 12:00-06', 34900, p_provider => 'stripe', p_subscription => pruebas.sus(2))),
  'recorded', 'el mismo identificador de otro proveedor es otro cobro');

-- ---------------------------------------------------------------------------------------
-- Lo que no es un cobro de esta cuenta, o no se entiende, no se escribe.

select is(pruebas.resultado(pruebas.cobra('ajena', 'monthly', '2026-10-10 12:00-06', 34900, p_subscription => pruebas.sus(3))),
  'not_found', 'la suscripción de otra cuenta');
select is(pruebas.resultado(pruebas.cobra('otro-proveedor', 'monthly', '2026-10-10 12:00-06', 34900, p_subscription => pruebas.sus(2))),
  'not_found', 'una suscripción de otro proveedor');
select is(pruebas.resultado(pruebas.cobra('no-existe', 'monthly', '2026-10-10 12:00-06', 34900, p_subscription => gen_random_uuid())),
  'not_found', 'una suscripción que no existe');
select is(pruebas.resultado(pruebas.cobra('dolares', 'monthly', '2026-10-10 12:00-06', 1900, p_currency => 'USD')),
  'unsupported_currency', 'otra moneda, hasta que el contador diga qué tipo de cambio aplica (LF-07)');

select is(pruebas.resultado(pruebas.cobra(v.charge, v.plan, v.at, v.gross, p_provider => v.provider, p_currency => v.currency, p_fee => v.fee,
                                          p_net => v.net, p_method => v.method, p_country => v.country, p_receipt => v.receipt,
                                          p_invoice => v.invoice)),
          'malformed', 'no se entiende ' || v.caso)
from (values
  ('sin monto', 'm-1', 'monthly', '2026-10-10 12:00-06'::timestamptz, null::bigint, 'manual', 'MXN', null::bigint, null::bigint, 'card', 'MX', null, null),
  ('un monto en cero', 'm-2', 'monthly', '2026-10-10 12:00-06', 0, 'manual', 'MXN', null, null, 'card', 'MX', null, null),
  ('un monto absurdo', 'm-3', 'monthly', '2026-10-10 12:00-06', 1000000001, 'manual', 'MXN', null, null, 'card', 'MX', null, null),
  ('un proveedor desconocido', 'm-4', 'monthly', '2026-10-10 12:00-06', 34900, 'paypal', 'MXN', null, null, 'card', 'MX', null, null),
  ('un identificador vacío', '', 'monthly', '2026-10-10 12:00-06', 34900, 'manual', 'MXN', null, null, 'card', 'MX', null, null),
  ('un identificador con espacios', 'ch 1', 'monthly', '2026-10-10 12:00-06', 34900, 'manual', 'MXN', null, null, 'card', 'MX', null, null),
  ('un identificador con un salto de línea', 'ch-1' || chr(10), 'monthly', '2026-10-10 12:00-06', 34900, 'manual', 'MXN', null, null, 'card', 'MX', null, null),
  ('un identificador larguísimo', repeat('x', 256), 'monthly', '2026-10-10 12:00-06', 34900, 'manual', 'MXN', null, null, 'card', 'MX', null, null),
  ('una factura vacía', 'm-7', 'monthly', '2026-10-10 12:00-06', 34900, 'manual', 'MXN', null, null, 'card', 'MX', null, ''),
  ('un método desconocido', 'm-8', 'monthly', '2026-10-10 12:00-06', 34900, 'manual', 'MXN', null, null, 'cash', 'MX', null, null),
  ('un país mal escrito', 'm-9', 'monthly', '2026-10-10 12:00-06', 34900, 'manual', 'MXN', null, null, 'card', 'mex', null, null),
  ('un recibo sin https', 'm-10', 'monthly', '2026-10-10 12:00-06', 34900, 'manual', 'MXN', null, null, 'card', 'MX', 'javascript:alert(1)', null),
  ('un recibo larguísimo', 'm-11', 'monthly', '2026-10-10 12:00-06', 34900, 'manual', 'MXN', null, null, 'card', 'MX', 'https://' || repeat('x', 2041), null),
  ('una comisión negativa', 'm-12', 'monthly', '2026-10-10 12:00-06', 34900, 'manual', 'MXN', -1, null, 'card', 'MX', null, null),
  ('un neto negativo', 'm-13', 'monthly', '2026-10-10 12:00-06', 34900, 'manual', 'MXN', null, -1, 'card', 'MX', null, null),
  ('una moneda mal escrita', 'm-14', 'monthly', '2026-10-10 12:00-06', 34900, 'manual', 'mxn', null, null, 'card', 'MX', null, null),
  ('un cobro en el futuro', 'm-15', 'monthly', now() + interval '10 minutes', 34900, 'manual', 'MXN', null, null, 'card', 'MX', null, null),
  ('un cobro sin fecha', 'm-16', 'monthly', null, 34900, 'manual', 'MXN', null, null, 'card', 'MX', null, null),
  ('un cobro sin plan', 'm-17', null, '2026-10-10 12:00-06', 34900, 'manual', 'MXN', null, null, 'card', 'MX', null, null)
) as v (caso, charge, plan, at, gross, provider, currency, fee, net, method, country, receipt, invoice);
select is(pruebas.resultado(pruebas.cobra('reloj', 'monthly', now() + interval '2 minutes', 34900)), 'recorded',
  'un reloj del proveedor un par de minutos adelantado sí se acepta');
select is(pruebas.resultado(private.record_charge(null, pruebas.sus(1), 'manual', 'sin-cuenta', null, 'monthly', '2026-10-10 12:00-06', 'MXN', 34900,
                                                  null, null, null, null, null)), 'malformed', 'ni sin cuenta');
select is(pruebas.cobros(), 9, 'nada de eso escribió un cobro');

-- ---------------------------------------------------------------------------------------
-- El libro no se edita, no se borra y no se vacía: ni el dueño.

select throws_ok('update public.charges set receipt_url = null', '42501', null, 'el dueño no edita un cobro');
select throws_ok('delete from public.charges', '42501', null, 'ni lo borra');
select throws_ok('truncate public.charges cascade', '42501', null, 'ni vacía el libro');
select throws_ok('update public.revenue_allocations set base_cents = base_cents', '42501', null, 'ni edita una parte');
select throws_ok('delete from public.revenue_allocations', '42501', null, 'ni la borra');
select throws_ok('truncate public.revenue_allocations', '42501', null, 'ni vacía ese libro');

-- La regla está también en la tabla: lo que escriba el dueño a mano tiene que cuadrar.
create function pruebas.cobro_como(p_changes jsonb) returns void
language sql as $$
  insert into public.charges
  select (jsonb_populate_record(null::public.charges,
            to_jsonb(c) || jsonb_build_object('id', gen_random_uuid(), 'provider_charge_id', gen_random_uuid()::text) || p_changes)).*
  from public.charges c where c.provider_charge_id = 'ejemplo-mensual' and c.provider = 'manual'
$$;
create function pruebas.parte_como(p_changes jsonb) returns void
language sql as $$
  insert into public.revenue_allocations
  select (jsonb_populate_record(null::public.revenue_allocations,
            to_jsonb(a) || jsonb_build_object('id', gen_random_uuid()) || p_changes)).*
  from public.revenue_allocations a join public.charges c on c.id = a.charge_id
  where c.provider_charge_id = 'ejemplo-mensual' and c.provider = 'manual'
$$;
select lives_ok($$select pruebas.cobro_como('{}')$$, 'una copia que cuadra sí entra (el control)');
select throws_ok(format('select pruebas.cobro_como(%L)', v.changes), '23514', null, 'la tabla no acepta ' || v.caso)
from (values
  ('un IVA mal redondeado', '{"net_of_tax_mxn_cents": 30087, "tax_cents": 4813, "revenue_net_mxn_cents": 28582}'),
  ('un IVA hacia abajo donde toca hacia arriba', '{"gross_cents": 299000, "gross_mxn_cents": 299000, "net_of_tax_mxn_cents": 257758, "tax_cents": 41242, "revenue_net_mxn_cents": 244870}'),
  ('un ingreso neto que no es el de la comisión', '{"revenue_net_mxn_cents": 28582}'),
  ('un impuesto que no es la diferencia', '{"tax_cents": 4815}'),
  ('otra moneda', '{"currency": "USD", "fx_source": "provider"}'),
  ('un aviso antes de que exista la bandeja', format('{"provider_event_id": "%s"}', gen_random_uuid())),
  ('un recibo sin https', '{"receipt_url": "http://recibo.test"}'),
  ('un identificador con un espacio de más', '{"provider_charge_id": "ejemplo-mensual "}'),
  ('un monto absurdo', '{"gross_cents": 1000000001, "gross_mxn_cents": 1000000001, "net_of_tax_mxn_cents": 862068966, "tax_cents": 137931035, "revenue_net_mxn_cents": 818965517}')
) as v (caso, changes);
select throws_ok(format('select pruebas.cobro_como(%L)', jsonb_build_object('profile_id', pruebas.beto())), '23503', null,
  'ni un cobro de una cuenta con la suscripción de otra');
select throws_ok($$select pruebas.parte_como('{}')$$, '23505', null, 'una parte no se repite');
select throws_ok($$select pruebas.parte_como('{"part_no": 2, "parts_total": 2, "kind": "reversal"}')$$, '23514', null,
  'una parte de reverso no entra sin su reverso (T-307)');
select throws_ok($$select pruebas.parte_como('{"part_no": 2, "parts_total": 2, "base_cents": -1}')$$, '23514', null, 'ni una parte negativa');
select throws_ok($$select pruebas.parte_como('{"part_no": 2}')$$, '23514', null, 'ni una parte más allá de las que tiene');
select throws_ok(format('select pruebas.parte_como(%L)', jsonb_build_object('part_no', 2, 'parts_total', 2, 'profile_id', pruebas.beto())),
  '23503', null, 'ni una parte a nombre de otra cuenta');
select throws_ok($$select pruebas.parte_como('{"part_no": 2, "parts_total": 2, "rule": "otra"}')$$, '23514', null, 'ni con otra regla');
select throws_ok($$select pruebas.parte_como('{"part_no": 2, "parts_total": 2, "fee_bps": 700}')$$, '23503', null,
  'ni con otra comisión que la de su cobro');
select throws_ok($$select pruebas.parte_como('{"part_no": 2, "parts_total": 2}')$$, '23514',
  format('revenue parts of charge %s do not match it', (pruebas.cobro('ejemplo-mensual')).id),
  'ni una parte que no cuadra con su cobro, aunque cada columna esté bien');
-- Un cobro copiado sin partes, y una parte suya que falla en una sola cosa cada vez.
select pruebas.cobro_como('{"id": "d0000000-0000-0000-0000-000000000001"}');
select throws_ok($$select pruebas.parte_como('{"charge_id": "d0000000-0000-0000-0000-000000000001", "base_cents": 28580}')$$,
  '23514', null, 'las partes tienen que sumar el neto del cobro');
select throws_ok($$select pruebas.parte_como('{"charge_id": "d0000000-0000-0000-0000-000000000001", "period_id": 202611}')$$,
  '23514', null, 'y caer desde el periodo del cobro');
select throws_ok($$select pruebas.parte_como('{"charge_id": "d0000000-0000-0000-0000-000000000001", "parts_total": 12}')$$,
  '23514', null, 'y ser tantas como pide su plan');
select pruebas.cobro_como('{"id": "d0000000-0000-0000-0000-000000000002", "plan": "annual"}');
select throws_ok($$select pruebas.parte_como('{"charge_id": "d0000000-0000-0000-0000-000000000002", "parts_total": 12}')$$,
  '23514', null, 'un anual no cabe en una sola parte, aunque lleve el neto entero');
select lives_ok($$select pruebas.parte_como('{"charge_id": "d0000000-0000-0000-0000-000000000001"}')$$,
  'la parte que sí cuadra entra (el control)');

-- ---------------------------------------------------------------------------------------
-- El vigilante: su área está y avisa.

select ok(exists (select 1 from private.watchdog_areas() where function_name = 'schema_violations_revenue' and unusable_reason is null),
  'el área de los ingresos está');
select is((select count(*)::integer from private.schema_violations()), 0, 'y no encuentra nada');
grant select on public.charges to authenticated;
select ok(exists (select 1 from private.schema_violations() where problem = 'revenue table reachable by authenticated'
                  and object_name = 'public.charges'), 'avisa si una persona puede leer los cobros');
revoke select on public.charges from authenticated;
grant select (base_cents) on public.revenue_allocations to service_role;
select ok(exists (select 1 from private.schema_violations() where problem = 'revenue table reachable by service_role'
                  and object_name = 'public.revenue_allocations'), 'o una columna de las partes');
revoke select (base_cents) on public.revenue_allocations from service_role;
grant execute on function private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint, bigint, bigint, text, text, text) to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'revenue function executable by app_service'),
  'o si el servidor puede registrar cobros antes de T-303');
revoke execute on function private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint, bigint, bigint, text, text, text) from app_service;
grant execute on function private.revenue_parts(bigint, public.subscription_plan, public.period_id) to public;
select ok(exists (select 1 from private.schema_violations() where problem = 'revenue function executable by anon'),
  'o si cualquiera ejecuta la aritmética');
revoke execute on function private.revenue_parts(bigint, public.subscription_plan, public.period_id) from public;
alter table public.charges disable trigger ledger_no_update_delete;
select ok(exists (select 1 from private.schema_violations() where problem = 'revenue ledger without ledger_no_update_delete'
                  and object_name = 'public.charges'), 'o si el libro de cobros quedó con su guardia apagada');
alter table public.charges enable replica trigger ledger_no_update_delete;
select ok(exists (select 1 from private.schema_violations() where problem = 'revenue ledger without ledger_no_update_delete'
                  and object_name = 'public.charges'), 'o en modo réplica, en el que no corre');
alter table public.charges enable trigger ledger_no_update_delete;
alter table public.revenue_allocations disable trigger revenue_allocations_match_charge;
select ok(exists (select 1 from private.schema_violations() where problem = 'revenue ledger without revenue_allocations_match_charge'
                  and object_name = 'public.revenue_allocations'), 'o si las partes dejaron de revisarse contra su cobro');
alter table public.revenue_allocations enable trigger revenue_allocations_match_charge;
drop trigger ledger_no_truncate on public.revenue_allocations;
select ok(exists (select 1 from private.schema_violations() where problem = 'revenue ledger without ledger_no_truncate'
                  and object_name = 'public.revenue_allocations'), 'o sin ella');
create trigger ledger_no_truncate before truncate on public.revenue_allocations
  for each statement execute function private.reject_mutation();
alter function private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint, bigint, bigint, text, text, text) security invoker;
select ok(exists (select 1 from private.schema_violations() where problem = 'revenue function not security definer with fixed search_path'),
  'o si registrar un cobro dejó de correr como el dueño');
alter function private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint, bigint, bigint, text, text, text) security definer;
alter function private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint, bigint, bigint, text, text, text) reset search_path;
select ok(exists (select 1 from private.schema_violations() where problem = 'revenue function not security definer with fixed search_path'),
  'o sin su search_path');
alter function private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint, bigint, bigint, text, text, text) set search_path = '';
create function private.record_charge(p_charge text) returns jsonb language sql as $f$ select null::jsonb $f$;
-- En `private` nadie ejecuta por omisión: se le da a propósito, para ver que el área la mira por su nombre.
grant execute on function private.record_charge(text) to anon;
select ok(exists (select 1 from private.schema_violations() where problem = 'revenue function executable by anon'
                  and object_name = 'private.record_charge(text)')
          and exists (select 1 from private.schema_violations() where problem = 'revenue function not security definer with fixed search_path'
                      and object_name = 'private.record_charge(text)'), 'o si aparece otra función con el mismo nombre');
drop function private.record_charge(text);
select is((select count(*)::integer from private.schema_violations()), 0, 'todo en su lugar, nada');

alter table public.business_parameters enable trigger user;
select * from finish();
rollback;
