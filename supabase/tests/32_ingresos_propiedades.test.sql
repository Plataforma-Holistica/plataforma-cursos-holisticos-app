-- T-301 · Las propiedades de la regla de RN-02, con miles de casos al azar (02 §12.2). Los
-- oráculos no repiten la implementación: dicen, en enteros, qué tiene que cumplir cada redondeo.
-- Los casos van sesgados a montos chicos (netos de 0 a 13 centavos, donde once partes valen
-- cero) y llegan hasta el tope de un cobro; los periodos cruzan años, hasta 209801.
begin;
\ir _ayuda.psql
-- La revisión de las partes de un cobro es diferida: aquí, al final de cada sentencia.
set constraints all immediate;
select plan(15);
select setseed(0.301);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana-propiedades@prueba.test');
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
values ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'manual', 'sus-propiedades',
        'monthly', 'pending', 'MXN');

create temporary table casos on commit drop as
select i,
       (case i % 3 when 0 then 1 + floor(random() * 20) when 1 then 1 + floor(random() * 100000)
                   else 1 + floor(random() * 1000000000) end)::bigint as gross,
       (case i % 5 when 0 then 0 when 1 then 1600 else floor(random() * 10001) end)::integer as iva,
       (case i % 7 when 0 then 0 when 1 then 500 else floor(random() * 10000) end)::integer as fee,
       (case when random() < 0.5 then 'monthly' else 'annual' end)::public.subscription_plan as plan,
       ((2020 + floor(random() * 78)) * 100 + 1 + floor(random() * 12))::integer as period
from generate_series(1, 3000) as i;
create temporary table montos on commit drop as
select c.*, m.net_of_tax_cents as net_of_tax, m.revenue_net_cents as net
from casos c cross join lateral private.revenue_amounts(c.gross, c.iva, c.fee) m;
create temporary table partes on commit drop as
select m.i, m.net, m.plan, m.period, p.*
from montos m cross join lateral private.revenue_parts(m.net, m.plan, m.period) p;

-- ---------------------------------------------------------------------------------------
-- Los dos pasos de RN-02.

select is((select count(*)::integer from montos), 3000, 'tres mil casos');
select ok((select count(*) from montos where net <= 13) >= 300, 'con cientos de netos chicos');
-- Mitad hacia arriba: sin_iva − ½ ≤ bruto ÷ (1 + IVA) < sin_iva + ½, en enteros.
select is((select count(*)::integer from montos
           where not (- (10000 + iva) <= 2 * gross * 10000 - 2 * net_of_tax * (10000 + iva)
                      and 2 * gross * 10000 - 2 * net_of_tax * (10000 + iva) < 10000 + iva)), 0,
  'el sin IVA es el más cercano al centavo, y en el empate hacia arriba');
-- Hacia abajo: neto ≤ sin_iva × (1 − comisión) < neto + 1, en enteros.
select is((select count(*)::integer from montos
           where not (net * 10000 <= net_of_tax * (10000 - fee) and net_of_tax * (10000 - fee) < (net + 1) * 10000)), 0,
  'el ingreso neto es la comisión aplicada hacia abajo');
select is((select count(*)::integer from montos where net < 0 or net > net_of_tax or net_of_tax > gross), 0,
  'el neto nunca pasa del sin IVA, ni el sin IVA del bruto');

-- ---------------------------------------------------------------------------------------
-- Las partes.

select is((select count(*)::integer from (select i from partes group by i, net having sum(base_cents) <> net) x), 0,
  'las partes de cada caso suman exactamente su neto');
select is((select count(*)::integer from (select i, plan from partes group by i, plan
           having count(*) <> case plan when 'monthly' then 1 else 12 end
               or bool_or(parts_total <> case plan when 'monthly' then 1 else 12 end)) x), 0,
  'una parte el mensual, doce el anual, y cada una lo dice');
select is((select count(*)::integer from partes where part_no < parts_total and base_cents <> net / parts_total), 0,
  'las once primeras son el neto entre doce hacia abajo');
select is((select count(*)::integer from partes l join partes f on f.i = l.i and f.part_no = 1
           where l.part_no = l.parts_total and not (l.base_cents >= f.base_cents and l.base_cents <= f.base_cents + 11)), 0,
  'la última lleva la diferencia: de cero a once centavos más');
-- Los periodos, como número de mes: seguidos desde el del cobro, y cada uno un mes de verdad.
select is((select count(*)::integer from partes
           where (period_id / 100) * 12 + period_id % 100 <> (period / 100) * 12 + period % 100 + part_no - 1
              or period_id % 100 not between 1 and 12), 0,
  'una parte por mes, seguidos desde el periodo del cobro, aunque crucen el año');

-- ---------------------------------------------------------------------------------------
-- La tabla y la función dicen lo mismo.

-- Cada caso, escrito a mano como el dueño con lo que calculó la función: la regla atada en la
-- tabla lo acepta. Sus meses, con fila (T-601: las partes empiezan en un periodo que existe).
select pruebas.como_dueno_sistema();
select count(private.open_period(m.period)) from (select distinct period from montos) m;
select pruebas.como_dueno();
insert into public.charges (profile_id, subscription_id, provider, provider_charge_id, plan, charged_at, period_id,
                            allocation_start_period_id, currency,
                            gross_cents, tax_cents, fx_rate_to_mxn, fx_source, gross_mxn_cents, net_of_tax_mxn_cents,
                            iva_bps, fee_bps, revenue_net_mxn_cents)
select 'a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'manual', 'caso-' || i, plan,
       '2026-10-10 12:00-06', period, period, 'MXN', gross, gross - net_of_tax, 1, 'same_currency', gross, net_of_tax, iva, fee, net
from montos;
select is((select count(*)::integer from public.charges where provider_charge_id like 'caso-%'), 3000,
  'la tabla acepta los tres mil: su regla es la de la función');

-- Cientos de cobros por la función, con la regla de octubre de 2026 (la de la semilla).
select is((select count(*)::integer from (
  select pruebas_cobro.answer ->> 'outcome' as outcome
  from casos c
  cross join lateral (select private.record_charge('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
                                                   'manual', 'funcion-' || c.i, null, c.plan,
                                                   timestamptz '2026-10-01 06:00Z' + (c.i % 20) * interval '1 day' + c.i * interval '1 second',
                                                   'MXN', c.gross, null, null, null, null, null) as answer) pruebas_cobro
  where c.i <= 300) x where outcome = 'recorded'), 300, 'trescientos cobros por la función, todos registrados');
select is((select count(*)::integer from public.charges c
           where c.provider_charge_id like 'funcion-%'
             and (c.period_id <> 202610 or c.iva_bps <> 1600 or c.fee_bps <> 500
                  or c.revenue_net_mxn_cents <> (select sum(a.base_cents) from public.revenue_allocations a where a.charge_id = c.id))), 0,
  'todos en octubre, con la regla de octubre, y sus partes suman su neto');
select is((select count(*)::integer from public.charges c join casos k on c.provider_charge_id = 'funcion-' || k.i
           cross join lateral private.revenue_amounts(k.gross, 1600, 500) m
           where c.net_of_tax_mxn_cents <> m.net_of_tax_cents or c.revenue_net_mxn_cents <> m.revenue_net_cents), 0,
  'y cada uno con lo mismo que da la aritmética sola');
select is((select count(*)::integer from public.revenue_allocations a join public.charges c on c.id = a.charge_id
           where c.provider_charge_id like 'funcion-%' and (a.fee_bps <> c.fee_bps or a.profile_id <> c.profile_id or a.rule <> 'charge_date_v1')), 0,
  'cada parte lleva la comisión, la cuenta y la regla de su cobro');

select * from finish();
rollback;
