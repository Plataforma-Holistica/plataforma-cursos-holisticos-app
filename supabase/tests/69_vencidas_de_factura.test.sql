-- T-604, segunda solicitud · Las vencidas de factura y el periodo pagado (RF-501, RF-505). Una factura pendiente no detiene al periodo: al liberar, la base pone
-- el día en que vence (el mayor entre `LIMITE_FACTURA` antes de `DIA_PAGO` y `PLAZO_FACTURA_MIN_DIAS` hábiles después de liberar), y un trabajo de cada noche marca
-- las que lo pasaron. Una sola regla dice cuándo un periodo está pagado (`period_settled`), y la usan el periodo y quien lo paga. Al final, lo que vigila el vigilante.
begin;
\ir _ayuda.psql
select plan(30);

select pruebas.alta('a6900000-0000-0000-0000-000000000001', 'luz-69@prueba.test');
select pruebas.alta('c6900000-0000-0000-0000-000000000001', 'f1-69@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-69@prueba.test';
select pruebas.dar_capacidad('c6900000-0000-0000-0000-000000000001', 'finance');
select pruebas.equipar('c6900000-0000-0000-0000-000000000001');

create function pruebas.f1() returns uuid language sql immutable as $$ select 'c6900000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.m() returns uuid language sql immutable as $$ select 'e6900000-0000-4000-8000-000000000001'::uuid $$;
create function pruebas.p(n integer) returns uuid language sql immutable as $$ select ('b6900000-0000-4000-8000-00000000000' || n)::uuid $$;
create function pruebas.periodo(p_period public.period_id) returns void language plpgsql as $$
declare
  v_run uuid := gen_random_uuid();
begin
  set local session_replication_role = replica;
  -- Una corrida que exista: las claves foráneas se revisan otra vez al cambiar una fila nacida en esta transacción.
  insert into public.close_runs (id, period_id, kind, status, period_status_at_run, code_version, parameters, started_by, error)
  values (v_run, p_period, 'rehearsal', 'failed', 'open', 'prueba', '{}', pruebas.f1(), 'prueba');
  insert into public.payout_periods (period_id, starts_at, ends_at, timezone, status, entered_closing_at, active_students, pool_bps,
                                     net_revenue_cents, student_pools_cents, pool_cents, assigned_cents, unconsumed_cents, carried_out_cents,
                                     close_run_id, closed_at, closed_by, payouts_released_at, payouts_released_by)
  select p_period, b.starts_at, b.ends_at, 'America/Mexico_City', 'closed', now(), 0, 6000, 0, 0, 0, 0, 0, 0,
         v_run, now(), pruebas.f1(), now(), pruebas.f1()
  from private.month_bounds(p_period, 'America/Mexico_City') b;
  set local session_replication_role = origin;
end
$$;
-- La liquidación n en el periodo 20310n, con el día en que vence su factura.
create function pruebas.liquidacion(n integer, p_estado public.payout_status, p_vence date) returns uuid language plpgsql as $$
begin
  perform pruebas.periodo((203100 + n)::public.period_id);
  set local session_replication_role = replica;
  insert into public.payouts (id, period_id, teacher_id, close_run_id, status, pool_cents, subtotal_cents, net_cents, released_at, released_by, invoice_due_on)
  values (pruebas.p(n), 203100 + n, pruebas.m(), (select close_run_id from public.payout_periods where period_id = 203100 + n), p_estado, 100000, 100000, 100000, now(), pruebas.f1(), p_vence);
  set local session_replication_role = origin;
  return pruebas.p(n);
end
$$;
create function pruebas.estado_periodo(p public.period_id) returns text language sql security definer as $$ select status::text from public.payout_periods where period_id = p $$;
create function pruebas.vencida(p_pago uuid) returns boolean language sql security definer as $$ select invoice_overdue_at is not null from public.payouts where id = p_pago $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.como_dueno_sistema();
insert into public.teachers (id, profile_id, status) values (pruebas.m(), 'a6900000-0000-0000-0000-000000000001', 'active');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- Días hábiles: de lunes a viernes, sin feriados (HO-18).

select is(private.business_days_add('2026-11-06', 1), '2026-11-09'::date, 'el siguiente hábil de un viernes es el lunes');
select is(private.business_days_add('2026-11-07', 1), '2026-11-09'::date, 'y el de un sábado también');
select is(private.business_days_add('2026-11-10', -3), '2026-11-05'::date, 'tres hábiles antes de un martes, el jueves anterior');
select is(private.business_days_add('2026-11-09', -1), '2026-11-06'::date, 'uno antes de un lunes, el viernes');
select is(private.business_days_add('2026-11-04', 0), '2026-11-04'::date, 'cero no mueve');

-- El día en que vence: `DIA_PAGO` es el 10 del mes que sigue al periodo, y `LIMITE_FACTURA`, 3 hábiles antes.
select is((private.parameter_value('PLAZO_FACTURA_MIN_DIAS'))::integer, 5, 'el plazo mínimo es de 5 hábiles');
select is(private.invoice_due_on(202610, '2026-11-02'), '2026-11-09'::date, 'liberada el lunes 2, vence el lunes 9: el plazo mínimo gana al límite del jueves 5');
select is(private.invoice_due_on(202610, '2026-10-27'), '2026-11-05'::date, 'liberada antes, vence en el límite');
select is(private.invoice_due_on(202612, '2027-01-04'), '2027-01-11'::date, 'el mes que sigue a diciembre es enero del año siguiente');

-- ---------------------------------------------------------------------------------------
-- El trabajo de cada noche.

select pruebas.liquidacion(1, 'awaiting_invoice', (now() at time zone 'America/Mexico_City')::date - 1);
select pruebas.liquidacion(2, 'invoice_rejected', (now() at time zone 'America/Mexico_City')::date - 1);
select pruebas.liquidacion(3, 'awaiting_invoice', (now() at time zone 'America/Mexico_City')::date);
select pruebas.liquidacion(4, 'invoice_in_review', (now() at time zone 'America/Mexico_City')::date - 1);
select pruebas.liquidacion(5, 'awaiting_invoice', (now() at time zone 'America/Mexico_City')::date - 1);
set local session_replication_role = replica;
update public.payouts set status = 'on_hold', held_from_status = 'awaiting_invoice', held_at = now(), held_by = pruebas.f1(), hold_reason = 'Se investiga',
                          hold_kind = 'investigation'
where id = pruebas.p(5);
set local session_replication_role = origin;

select ok(not private.period_settled(203101), 'una en espera de factura sin vencer detiene al periodo');
select throws_ok(format($$update public.payouts set invoice_overdue_at = now() where id = %L$$, pruebas.p(1)), '23514', null, 'solo el sistema la marca vencida');
select pruebas.como_dueno();
select is(private.invoice_deadline(), 2, 'el trabajo marca dos');
select ok(pruebas.vencida(pruebas.p(1)), 'la que esperaba factura y pasó su día');
select ok(pruebas.vencida(pruebas.p(2)), 'la rechazada que pasó su día');
select ok(not pruebas.vencida(pruebas.p(3)), 'la que vence hoy, todavía no');
select ok(not pruebas.vencida(pruebas.p(4)), 'la que está en revisión no vence: esa demora es nuestra');
select ok(not pruebas.vencida(pruebas.p(5)), 'una retenida no se marca');
select is(pruebas.estado_periodo(203101), 'paid', 'su periodo pasa a pagado');
select is(pruebas.estado_periodo(203102), 'paid', 'también el de la rechazada');
select is(pruebas.estado_periodo(203103), 'closed', 'el de la que vence hoy, no');
select is(pruebas.estado_periodo(203104), 'closed', 'ni el de la que está en revisión');
select is(pruebas.estado_periodo(203105), 'closed', 'ni el de la retenida');
select is(private.invoice_deadline(), 0, 'correrlo otra vez no marca nada');
select is((select status::text from public.payouts where id = pruebas.p(1)), 'awaiting_invoice', 'vencida sigue esperando su factura: una tardía se puede pagar');
select pruebas.como_dueno_sistema();
select throws_ok(format($$update public.payouts set invoice_overdue_at = null where id = %L$$, pruebas.p(1)), '23514', null, 'la marca no se borra');
select pruebas.como_dueno();

-- El trabajo está programado, y el periodo pagado lo decide una sola regla.
select is((select command from cron.job where jobname = 'invoice_deadline'), 'select private.invoice_deadline()', 'el trabajo corre cada noche');
select ok(pg_get_functiondef('private.settle_period(public.period_id)'::regprocedure) like '%period_settled%', 'pagar el periodo usa la regla');
select ok(pg_get_functiondef('private.guard_payout_period()'::regprocedure) like '%period_settled%', 'y el guardián del periodo también');

-- Lo que vigila el vigilante, en el área de las liquidaciones y en la de lo fiscal.
select is_empty($$select * from private.schema_violations()$$, 'el vigilante no encuentra nada');
grant execute on function private.payout_mark_paid(uuid, uuid, text, date, bigint) to authenticated;
select ok(exists (select 1 from private.schema_violations() where problem like 'payouts function executable by authenticated%'), 've marcar pagada al alcance de una persona');
revoke execute on function private.payout_mark_paid(uuid, uuid, text, date, bigint) from authenticated;

select * from finish();
rollback;
