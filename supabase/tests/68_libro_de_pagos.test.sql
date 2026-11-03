-- T-604, segunda solicitud · Los estados de la liquidación y el libro de pagos (RF-505, RF-512; FL-31 A1; decisiones de Sergio del 2026-11-02: la primera vez
-- que se paga a una cuenta no se abre la CLABE sin «ya llamé», y una segunda persona confirma una devolución y soltar con fraude decidido). Toda transferencia
-- reportada entra al libro, también la que llega tarde o choca: la transferencia ya salió. Una pagada tiene un pago vivo, y una lista para pago o devuelta,
-- ninguno. Abrir la cuenta, llamar y marcar se prueban aquí; las vencidas de factura y lo que vigila el vigilante, en la 69.
begin;
\ir _ayuda.psql
select plan(125);

select pruebas.alta('a6800000-0000-0000-0000-000000000001', 'tere-68@prueba.test');
select pruebas.alta('c6800000-0000-0000-0000-000000000001', 'f1-68@prueba.test');
select pruebas.alta('c6800000-0000-0000-0000-000000000002', 'f2-68@prueba.test');
select pruebas.alta('c6800000-0000-0000-0000-000000000003', 'k1-68@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-68@prueba.test';
select pruebas.dar_capacidad('c6800000-0000-0000-0000-000000000001', 'finance');
select pruebas.dar_capacidad('c6800000-0000-0000-0000-000000000002', 'finance');
select pruebas.dar_capacidad('c6800000-0000-0000-0000-000000000003', 'content');
select pruebas.equipar(id) from auth.users where email in ('f1-68@prueba.test', 'f2-68@prueba.test', 'k1-68@prueba.test');

create function pruebas.tere() returns uuid language sql immutable as $$ select 'a6800000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.f1() returns uuid language sql immutable as $$ select 'c6800000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.f2() returns uuid language sql immutable as $$ select 'c6800000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.k1() returns uuid language sql immutable as $$ select 'c6800000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.m() returns uuid language sql immutable as $$ select 'e6800000-0000-4000-8000-000000000001'::uuid $$;
-- La liquidación n es la del periodo 20300n.
create function pruebas.p(n integer) returns uuid language sql immutable as $$ select ('b6800000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
-- Desde cuándo es suya la CLABE vigente: con eso se dice a qué cuenta se llamó.
create function pruebas.cambio() returns timestamptz language sql security definer as $$
  select x.clabe_changed_at from private.teacher_tax_profiles x where x.teacher_id = 'e6800000-0000-4000-8000-000000000001' order by x.version desc limit 1
$$;
create function pruebas.sellado(p_largo integer) returns bytea language sql immutable
as $$ select decode('010001' || repeat('ab', 12 + p_largo + 16), 'hex') $$;

-- Un periodo cerrado y liberado, sin pasar por el cierre: eso se prueba en la 44 y la 46.
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
create function pruebas.liquidacion(n integer, p_estado public.payout_status, p_neto bigint default 100000) returns uuid language plpgsql as $$
begin
  perform pruebas.periodo((203000 + n)::public.period_id);
  set local session_replication_role = replica;
  insert into public.payouts (id, period_id, teacher_id, close_run_id, status, pool_cents, subtotal_cents, net_cents, released_at, released_by)
  values (pruebas.p(n), 203000 + n, pruebas.m(), (select close_run_id from public.payout_periods where period_id = 203000 + n), p_estado, p_neto, p_neto, p_neto, now(), pruebas.f1());
  -- Desde la tercera solicitud, una pagada exige su factura aceptada: la que nace lista para pago ya la tiene (la 80 prueba cómo se llega).
  if p_estado in ('ready_to_pay', 'paid', 'payment_returned') then
    insert into private.teacher_invoices (payout_id, teacher_id, status, pdf_path, pdf_object_id, pdf_object_version, pdf_bytes, xml_enc, xml_sha256, cfdi_uuid,
                                          issued_at, stamped_at, issuer_regime, issuer_profile_version, receiver_rfc, subtotal_cents, vat_cents,
                                          income_tax_withheld_cents, vat_withheld_cents, total_cents, submitted_by, submitted_at, reviewed_by, reviewed_at)
    values (pruebas.p(n), pruebas.m(), 'accepted', 'prueba-68/' || n || '.pdf', gen_random_uuid(), 'v1', 1000, pruebas.sellado(40), sha256('68'::bytea),
            gen_random_uuid(), now(), now(), '612', 1, 'PHO200101AB1', p_neto, 0, 0, 0, p_neto, pruebas.tere(), now(), pruebas.f1(), now());
  end if;
  set local session_replication_role = origin;
  return pruebas.p(n);
end
$$;
create function pruebas.abre(p_pago uuid, p_quien uuid default 'c6800000-0000-0000-0000-000000000001') returns jsonb language plpgsql as $$
begin
  return pruebas.pide(p_quien, format('private.payout_account_open(%L)', p_pago))::jsonb;
end
$$;
create function pruebas.llama(p_pago uuid, p_quien uuid default 'c6800000-0000-0000-0000-000000000001') returns jsonb language plpgsql as $$
begin
  return pruebas.pide(p_quien, format('private.payout_account_call(%L, %L, %L, %L)', p_pago, pruebas.cambio(), 'Tere, al teléfono que dio Contenido', clock_timestamp()))::jsonb;
end
$$;
create function pruebas.marca(p_pago uuid, p_lectura uuid, p_ref text, p_monto bigint default 100000,
                              p_quien uuid default 'c6800000-0000-0000-0000-000000000001', p_dia date default (now() at time zone 'America/Mexico_City')::date) returns jsonb language plpgsql as $$
begin
  return pruebas.pide(p_quien, format('private.payout_mark_paid(%L, %L, %L, %L, %s)', p_pago, p_lectura, p_ref, p_dia, p_monto))::jsonb;
end
$$;
create function pruebas.devuelve(p_pago_banco uuid, p_quien uuid) returns jsonb language plpgsql as $$
begin
  return pruebas.pide(p_quien, format('private.payout_return_payment(%L, %L)', p_pago_banco, 'El banco la regresó'))::jsonb;
end
$$;
create function pruebas.huella(p_pago uuid) returns text language sql security definer as $$ select private.unhold_preview(p_pago) ->> 'fingerprint' $$;
create function pruebas.suelta(p_pago uuid, p_quien uuid) returns jsonb language plpgsql as $$
begin
  return pruebas.pide(p_quien, format('private.unhold_payout(%L, %L, %L)', p_pago, 'Revisado', pruebas.huella(p_pago)))::jsonb;
end
$$;
create function pruebas.estado(p_pago uuid) returns text language sql security definer as $$ select status::text from public.payouts where id = p_pago $$;
create function pruebas.estado_periodo(p public.period_id) returns text language sql security definer as $$ select status::text from public.payout_periods where period_id = p $$;
create function pruebas.vivos(p_pago uuid) returns bigint language sql security definer as $$
  select count(*) from private.payout_payments x
  where x.payout_id = p_pago
    and not exists (select 1 from private.payout_requests r where r.payment_id = x.id and r.kind = 'payment_return' and r.status = 'confirmed')
$$;
create function pruebas.lecturas() returns bigint language sql security definer
as $$ select count(*) from public.audit_log a where a.action = 'tax_profile.read' and a.entity_id is not null and a.new_value ->> 'teacher_id' = pruebas.m()::text $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- La maestra, con su CLABE vigente desde hace una semana y su aviso enviado al cambiarla.
select pruebas.como_dueno_sistema();
insert into public.teachers (id, profile_id, status) values (pruebas.m(), pruebas.tere(), 'active');
set local session_replication_role = replica;
insert into private.teacher_tax_profiles (teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version,
                                          created_by, clabe_changed_at, clabe_effective_from)
values (pruebas.m(), 1, pruebas.sellado(13), pruebas.sellado(20), '612', 'person', pruebas.sellado(18), '7771', 1, pruebas.tere(),
        now() - interval '10 days', now() - interval '7 days');
insert into private.mail_outbox (idempotency_key, template, profile_id, recipient, params, sent_at)
values (private.clabe_notice_key(pruebas.m(), now() - interval '10 days'), 'CO-27', pruebas.tere(), 'tere-68@prueba.test', '{"hours": 72}', now() - interval '10 days');
set local session_replication_role = origin;
select pruebas.como_dueno();

select pruebas.liquidacion(1, 'ready_to_pay');
select pruebas.liquidacion(2, 'ready_to_pay');
select pruebas.liquidacion(3, 'payment_returned');
select pruebas.liquidacion(4, 'ready_to_pay');
select pruebas.liquidacion(5, 'ready_to_pay');

-- ---------------------------------------------------------------------------------------
-- La primera vez que se paga a esta cuenta: sin «ya llamé», no se abre (decisión 2).

select is(pruebas.abre(pruebas.p(1)) ->> 'outcome', 'needs_call', 'la primera vez, sin llamada, no se abre la cuenta');
select is(pruebas.abre(pruebas.p(1)) - 'outcome' - 'clabe_changed_at', '{"clabe_last4": "7771"}'::jsonb, 'dice a qué cuenta se llama: sus últimos cuatro, y nada más');
select is(pruebas.lecturas(), 0::bigint, 'y no queda lectura en la auditoría');
select is((select count(*) from private.payout_account_reads), 0::bigint, 'ni en el libro de lecturas');
select is(pruebas.pide(pruebas.k1(), format('private.payout_account_call(%L, %L, %L, %L)', pruebas.p(1), pruebas.cambio(), 'Tere', now()) ) ::jsonb ->> 'outcome', 'forbidden', 'Contenido no anota llamadas');
select is(pruebas.pide(pruebas.f1(), format('private.payout_account_call(%L, %L, %L, %L)', pruebas.p(1), pruebas.cambio(), '  ', now()))::jsonb ->> 'outcome', 'malformed', 'sin con quién habló, no');
select is(pruebas.pide(pruebas.f1(), format('private.payout_account_call(%L, %L, %L, %L)', pruebas.p(1), pruebas.cambio(), 'Tere', now() + interval '1 hour'))::jsonb ->> 'outcome', 'malformed', 'una llamada que no ha pasado, no');
select is(pruebas.pide(pruebas.f1(), format('private.payout_account_call(%L, %L, %L, %L)', pruebas.p(1), pruebas.cambio(), 'Tere', now() - interval '11 days'))::jsonb ->> 'outcome', 'before_change', 'una llamada de antes del cambio no confirma esta cuenta');
select is(pruebas.pide(pruebas.f1(), format('private.payout_account_call(%L, %L, %L, %L)', pruebas.p(1), now() - interval '20 days', 'Tere', now()))::jsonb ->> 'outcome',
          'changed', 'una llamada a otra cuenta que la de ahora, no');
select is(pruebas.llama(pruebas.p(1)) ->> 'outcome', 'recorded', 'finanzas anota que llamó');
select is((select spoke_with from private.payout_account_calls where teacher_id = pruebas.m()), 'Tere, al teléfono que dio Contenido', 'con quién');
select is((select recorded_by from private.payout_account_calls where teacher_id = pruebas.m()), pruebas.f1(), 'y quién lo anotó');

select is(pruebas.abre(pruebas.p(1)) ->> 'outcome', 'ok', 'con la llamada, se abre');
select is(pruebas.abre(pruebas.p(1)) ->> 'clabe_last4', '7771', 'con sus datos');
select ok((pruebas.abre(pruebas.p(1)) ->> 'first_time')::boolean, 'y dice que es la primera vez');
select is(pruebas.lecturas(), 3::bigint, 'cada apertura queda en la auditoría');
select is((select count(*) from private.payout_account_reads where payout_id = pruebas.p(1)), 1::bigint, 'quien la abrió vuelve a ver la suya: una lectura');
select is(pruebas.abre(pruebas.p(1), pruebas.f2()) ->> 'outcome', 'already_open', 'otra persona no la abre mientras esa lectura no tenga su pago');
select is((pruebas.abre(pruebas.p(1), pruebas.f2()) ->> 'read_by')::uuid, pruebas.f1(), 'y sabe quién la tiene abierta');
select is((select tax_profile_version from private.payout_account_reads where payout_id = pruebas.p(1) limit 1), 1::smallint, 'con la versión que se abrió');
select (pruebas.abre(pruebas.p(1)) ->> 'read_id')::uuid as lectura1 \gset

-- ---------------------------------------------------------------------------------------
-- Marcar pagada lleva la lectura con que se abrió la cuenta.

select is(pruebas.marca(pruebas.p(1), gen_random_uuid(), 'ABC123') ->> 'outcome', 'needs_read', 'sin una lectura de esa liquidación, no');
select is(pruebas.marca(pruebas.p(2), :'lectura1', 'ABC123') ->> 'outcome', 'needs_read', 'ni con la lectura de otra liquidación');
select is(pruebas.marca(pruebas.p(1), :'lectura1', ' ') ->> 'outcome', 'malformed', 'sin referencia, no');
select is(pruebas.marca(pruebas.p(1), :'lectura1', 'ABC123', 0) ->> 'outcome', 'malformed', 'sin monto, no');
select is(pruebas.marca(pruebas.p(1), :'lectura1', 'ABC123', 100000, pruebas.f1(), current_date + 2) ->> 'outcome', 'malformed', 'con fecha futura, no');
select is(pruebas.marca(pruebas.p(1), :'lectura1', 'ABC123', 100000, pruebas.k1()) ->> 'outcome', 'forbidden', 'Contenido no marca');
select is((select count(*) from private.payout_payments), 0::bigint, 'nada de eso entra al libro');

select is(pruebas.marca(pruebas.p(1), :'lectura1', 'ABC123') ->> 'outcome', 'paid', 'con su lectura, queda pagada');
select is(pruebas.estado(pruebas.p(1)), 'paid', 'la liquidación');
select is(pruebas.estado_periodo(203001), 'paid', 'y su periodo, que ya no tiene nada pendiente');
select is((select row(reference, amount_cents, first_time, account_changed_since_read, conflict, recorded_by)::text from private.payout_payments where payout_id = pruebas.p(1)),
          row('ABC123', 100000::bigint, true, false, null::text, pruebas.f1())::text, 'el pago: referencia, monto, primera vez, sin conflicto, quién');
select is((select tax_profile_version from private.payout_payments where payout_id = pruebas.p(1)), 1::smallint, 'con la versión de la lectura');
select (select id from private.payout_payments where payout_id = pruebas.p(1)) as pago1 \gset
select is(pruebas.marca(pruebas.p(1), :'lectura1', 'ABC123') ->> 'outcome', 'already_reported', 'reintentar con la misma lectura no duplica');
select is(pruebas.marca(pruebas.p(1), :'lectura1', 'ABC123') ->> 'payment_id', :'pago1', 'y contesta el mismo pago');
select is((select count(*) from private.payout_payments), 1::bigint, 'el libro tiene un pago');
select is(pruebas.abre(pruebas.p(1)), '{"outcome": "not_ready"}'::jsonb, 'una pagada no abre la cuenta');

-- ---------------------------------------------------------------------------------------
-- Después de un pago vivo a esta cuenta ya no es la primera vez. Una referencia repetida no la paga: la retiene.

select is(pruebas.abre(pruebas.p(2)) ->> 'outcome', 'ok', 'la segunda liquidación abre sin otra llamada');
select ok(not (pruebas.abre(pruebas.p(2)) ->> 'first_time')::boolean, 'porque ya se le pagó a esta cuenta');
select (pruebas.abre(pruebas.p(2)) ->> 'read_id')::uuid as lectura2 \gset
select is(pruebas.marca(pruebas.p(2), :'lectura2', 'abc123') ->> 'conflict', 'duplicate_reference', 'la misma referencia del mismo día, sin importar mayúsculas, choca');
select is(pruebas.estado(pruebas.p(2)), 'on_hold', 'y la liquidación queda retenida, no pagada');
select is((select hold_kind || ':' || held_from_status from public.payouts where id = pruebas.p(2)), 'payment:ready_to_pay', 'por el pago, desde lista para pago');
select is(pruebas.vivos(pruebas.p(2)), 1::bigint, 'el pago entra al libro: la transferencia ya salió');
select is(pruebas.estado_periodo(203002), 'closed', 'el periodo sigue pendiente');
select is(pruebas.abre(pruebas.p(2)), '{"outcome": "on_hold"}'::jsonb, 'una retenida no abre la cuenta');
select is(pruebas.suelta(pruebas.p(2), pruebas.f1()) ->> 'outcome', 'proposed', 'soltarla la pagaría: una persona propone');
select is(pruebas.suelta(pruebas.p(2), pruebas.f1()) ->> 'outcome', 'awaiting_second', 'y no la confirma ella misma');
select is(pruebas.suelta(pruebas.p(2), pruebas.f2()) ->> 'to', 'paid', 'otra persona la suelta, y con un pago vivo va a pagada');
select is(pruebas.estado_periodo(203002), 'paid', 'y su periodo también');

-- ---------------------------------------------------------------------------------------
-- Devolver un pago lo confirma otra persona (decisión 3).

select is(pruebas.devuelve(:'pago1', pruebas.f1()) ->> 'outcome', 'proposed', 'finanzas propone la devolución');
select is(pruebas.estado(pruebas.p(1)), 'paid', 'y sigue pagada');
select is(pruebas.devuelve(:'pago1', pruebas.f1()) ->> 'outcome', 'awaiting_second', 'quien la propuso no la confirma');
select is(pruebas.devuelve(:'pago1', pruebas.k1()) ->> 'outcome', 'forbidden', 'ni Contenido');
select is(pruebas.devuelve(:'pago1', pruebas.f2()) ->> 'outcome', 'returned', 'otra persona de finanzas la confirma');
select is(pruebas.estado(pruebas.p(1)), 'payment_returned', 'sin pagos vivos, la liquidación queda devuelta');
select is(pruebas.estado_periodo(203001), 'paid', 'el periodo pagado no cambia');
select is(pruebas.devuelve(:'pago1', pruebas.f2()) ->> 'outcome', 'already_returned', 'un pago se devuelve una vez');
select is((select proposed_by || ':' || decided_by from private.payout_requests where payment_id = :'pago1'), pruebas.f1() || ':' || pruebas.f2(), 'quién propuso y quién confirmó');
select is(pruebas.abre(pruebas.p(1)), '{"outcome": "not_ready"}'::jsonb, 'una devuelta no abre la cuenta');
select is(pruebas.pide(pruebas.f1(), format('private.payout_reopen(%L, %L)', pruebas.p(1), 'paid'))::jsonb ->> 'outcome', 'changed', 'reabrir lleva el estado que se vio');
select is(pruebas.pide(pruebas.f1(), format('private.payout_reopen(%L, %L)', pruebas.p(1), 'payment_returned'))::jsonb ->> 'outcome', 'reopened', 'y vuelve a lista para pago');
select is(pruebas.estado(pruebas.p(1)), 'ready_to_pay', 'la liquidación');
-- El de la segunda chocó: no dice que la cuenta funciona. Con el único pago limpio devuelto, se vuelve a llamar, y la llamada de antes no vale.
select is(pruebas.abre(pruebas.p(1)) ->> 'outcome', 'needs_call', 'con su único pago limpio devuelto, la cuenta pide otra vez la llamada');
select is(pruebas.pide(pruebas.f1(), format('private.payout_account_call(%L, %L, %L, %L)', pruebas.p(1), pruebas.cambio(), 'Tere', now()))::jsonb ->> 'outcome',
          'before_return', 'una llamada que dice una hora de antes de la devolución no la confirma');
select is(pruebas.llama(pruebas.p(1)) ->> 'outcome', 'recorded', 'se le vuelve a llamar');
select ok((pruebas.abre(pruebas.p(1)) ->> 'first_time')::boolean, 'y se abre, como primera vez otra vez');

-- Retirar una propuesta: solo quien la hizo.
select is(pruebas.devuelve((select id from private.payout_payments where payout_id = pruebas.p(2)), pruebas.f2()) ->> 'outcome', 'proposed', 'otra propuesta');
select (select id from private.payout_requests where status = 'pending') as propuesta \gset
select is(pruebas.pide(pruebas.f1(), format('private.payout_withdraw_request(%L)', :'propuesta'))::jsonb ->> 'outcome', 'not_yours', 'otra persona no la retira');
select is(pruebas.pide(pruebas.f2(), format('private.payout_withdraw_request(%L)', :'propuesta'))::jsonb ->> 'outcome', 'withdrawn', 'quien la hizo, sí');
select is(pruebas.estado(pruebas.p(2)), 'paid', 'y nada cambió');

-- ---------------------------------------------------------------------------------------
-- Un monto distinto la retiene; con fraude decidido, soltarla lo confirma otra persona (decisión 3).

select (pruebas.abre(pruebas.p(1)) ->> 'read_id')::uuid as lectura1b \gset
select is(pruebas.marca(pruebas.p(1), :'lectura1b', 'XYZ9', 90000) ->> 'conflict', 'amount_differs', 'otro monto que el neto choca');
select is(pruebas.estado(pruebas.p(1)), 'on_hold', 'y queda retenida');
select pruebas.como_dueno();
set local session_replication_role = replica;
insert into public.anomaly_alerts (period_id, kind, teacher_id, metric_value, threshold_value, status, is_fraud, reviewed_by, reviewed_at, review_note, fraud_marked_by, evidence)
values (203001, 'teacher_points_jump', pruebas.m(), 1, 1, 'reviewed', true, pruebas.k1(), now(), 'Era fraude', pruebas.k1(), 'Capturas del panel');
set local session_replication_role = origin;
select is(pruebas.suelta(pruebas.p(1), pruebas.f1()) ->> 'outcome', 'proposed', 'con el fraude decidido, soltar es una propuesta');
select is(pruebas.estado(pruebas.p(1)), 'on_hold', 'y sigue retenida');
select is(pruebas.suelta(pruebas.p(1), pruebas.f1()) ->> 'outcome', 'awaiting_second', 'quien la propuso no la confirma');
select is(pruebas.suelta(pruebas.p(1), pruebas.f2()) ->> 'to', 'paid', 'otra persona la suelta, y con el pago vivo va a pagada');
select is((select count(*) from private.payout_requests where payout_id = pruebas.p(1) and kind = 'hold_release' and status = 'confirmed'), 1::bigint, 'queda quién confirmó');

-- ---------------------------------------------------------------------------------------
-- Retener desde devuelta, y una transferencia que llega con la liquidación retenida.

select is(pruebas.pide(pruebas.f1(), format('private.hold_payout(%L, %L, %L)', pruebas.p(3), 'Se investiga', 'payment_returned'))::jsonb ->> 'outcome', 'held', 'una devuelta se retiene');
select is((select held_from_status::text from public.payouts where id = pruebas.p(3)), 'payment_returned', 'y vuelve ahí');
select is(pruebas.suelta(pruebas.p(3), pruebas.f1()) ->> 'to', 'payment_returned', 'al soltarla, sin pagos vivos');

select (pruebas.abre(pruebas.p(4)) ->> 'read_id')::uuid as lectura4 \gset
select is(pruebas.pide(pruebas.f2(), format('private.hold_payout(%L, %L, %L)', pruebas.p(4), 'Algo raro', 'ready_to_pay'))::jsonb ->> 'outcome', 'held', 'otra persona la retiene después de abrir');
select is(pruebas.marca(pruebas.p(4), :'lectura4', 'R4') ->> 'conflict', 'on_hold', 'la transferencia llega con la liquidación retenida');
select is(pruebas.vivos(pruebas.p(4)), 1::bigint, 'y entra al libro');
select is(pruebas.estado(pruebas.p(4)), 'on_hold', 'sin dejar de estar retenida');
select is(pruebas.suelta(pruebas.p(4), pruebas.f1()) ->> 'outcome', 'proposed', 'soltarla la pagaría: lo propone una persona');
select is(pruebas.suelta(pruebas.p(4), pruebas.f2()) ->> 'to', 'paid', 'y al confirmarla otra va a pagada, no a lista para pago: así no se paga dos veces');

-- ---------------------------------------------------------------------------------------
-- Bajo investigación no se abre, y lo que nace después de abrir detiene el pago.

select pruebas.como_dueno();
set local session_replication_role = replica;
insert into public.anomaly_alerts (id, period_id, kind, teacher_id, metric_value, threshold_value)
values ('d6800000-0000-4000-8000-000000000005', 203005, 'teacher_points_jump', pruebas.m(), 1, 1);
set local session_replication_role = origin;
select is(pruebas.abre(pruebas.p(5)), '{"outcome": "under_investigation"}'::jsonb, 'con una alerta abierta en su mes, no se abre');
select pruebas.como_dueno();
set local session_replication_role = replica;
update public.anomaly_alerts set status = 'reviewed', is_fraud = false, reviewed_by = pruebas.k1(), reviewed_at = now(), review_note = 'No era'
where id = 'd6800000-0000-4000-8000-000000000005';
insert into private.teacher_suspension_requests (teacher_id, anomaly_alert_id, reason, proposed_by, proposed_at, status)
values (pruebas.m(), gen_random_uuid(), 'prueba', pruebas.f2(), now(), 'pending');
set local session_replication_role = origin;
select is(pruebas.abre(pruebas.p(5)), '{"outcome": "under_investigation"}'::jsonb, 'ni con una propuesta de suspensión pendiente, de cualquier mes');
select pruebas.como_dueno();
set local session_replication_role = replica;
delete from private.teacher_suspension_requests where teacher_id = pruebas.m();
set local session_replication_role = origin;
select (pruebas.abre(pruebas.p(5)) ->> 'read_id')::uuid as lectura5 \gset
select ok(:'lectura5' is not null, 'sin nada abierto, se abre');
select pruebas.como_dueno();
set local session_replication_role = replica;
update public.anomaly_alerts set status = 'open', is_fraud = null, reviewed_by = null, reviewed_at = null, review_note = null
where id = 'd6800000-0000-4000-8000-000000000005';
set local session_replication_role = origin;
select is(pruebas.marca(pruebas.p(5), :'lectura5', 'R5') ->> 'conflict', 'under_investigation', 'una alerta que se abre entre abrir y marcar choca');
select is(pruebas.estado(pruebas.p(5)), 'on_hold', 'y retiene');

-- ---------------------------------------------------------------------------------------
-- Una cuenta que cambió entre abrir y marcar: se anota, y no se rechaza, porque la transferencia ya salió.

select pruebas.liquidacion(6, 'ready_to_pay');
select (pruebas.abre(pruebas.p(6)) ->> 'read_id')::uuid as lectura6 \gset
select pruebas.como_dueno();
set local session_replication_role = replica;
insert into private.teacher_tax_profiles (teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version,
                                          created_by, clabe_changed_at, clabe_effective_from)
values (pruebas.m(), 2, pruebas.sellado(13), pruebas.sellado(20), '612', 'person', pruebas.sellado(18), '7772', 1, pruebas.tere(),
        now() - interval '9 days', now() - interval '6 days');
insert into private.mail_outbox (idempotency_key, template, profile_id, recipient, params, sent_at)
values (private.clabe_notice_key(pruebas.m(), now() - interval '9 days'), 'CO-27', pruebas.tere(), 'tere-68@prueba.test', '{"hours": 72}', now() - interval '9 days');
-- Ya se le llamó a la cuenta nueva: la primera vez se prueba arriba.
insert into private.payout_account_calls (teacher_id, clabe_changed_at, spoke_with, called_at, recorded_by)
values (pruebas.m(), now() - interval '9 days', 'Tere', now(), pruebas.f1());
set local session_replication_role = origin;
select is(pruebas.marca(pruebas.p(6), :'lectura6', 'R6') ->> 'outcome', 'paid', 'se paga');
select ok((select account_changed_since_read from private.payout_payments where payout_id = pruebas.p(6)), 'y queda dicho que la CLABE cambió desde la lectura');
select is((select tax_profile_version from private.payout_payments where payout_id = pruebas.p(6)), 1::smallint, 'con la versión que se abrió, no la de ahora');
-- Una segunda transferencia con la misma lectura también entra: ya salió.
select is(pruebas.marca(pruebas.p(6), :'lectura6', 'R6-BIS') ->> 'conflict', 'already_paid', 'una segunda transferencia con la misma lectura entra con su conflicto');
select is(pruebas.vivos(pruebas.p(6)), 2::bigint, 'y quedan las dos en el libro');
select is(pruebas.estado(pruebas.p(6)), 'paid', 'sin dejar de estar pagada');

-- ---------------------------------------------------------------------------------------
-- Una lectura vieja y una anulada: la transferencia entra, choca y retiene.

select pruebas.liquidacion(8, 'ready_to_pay');
select (pruebas.abre(pruebas.p(8)) ->> 'read_id')::uuid as lectura8 \gset
select is(pruebas.pide(pruebas.f2(), format('private.hold_payout(%L, %L, %L)', pruebas.p(8), 'Se revisa', 'ready_to_pay'))::jsonb ->> 'outcome', 'held', 'se retiene');
select is(pruebas.suelta(pruebas.p(8), pruebas.f1()) ->> 'to', 'ready_to_pay', 'y se suelta sin pagos: una persona basta');
select is(pruebas.abre(pruebas.p(8), pruebas.f2()) ->> 'outcome', 'already_open', 'retener y soltar no cierra la lectura: otra persona sigue sin la cuenta');
select is(pruebas.abre(pruebas.p(8)) ->> 'outcome', 'already_open', 'ni quien la abrió recibe otra: la de antes la marca o la anula');
select ok((pruebas.abre(pruebas.p(8)) ->> 'own')::boolean, 'y sabe que es la suya');
select is(pruebas.marca(pruebas.p(8), :'lectura8', 'R8') ->> 'conflict', 'stale_read', 'una transferencia con la lectura de antes choca');
select is(pruebas.estado(pruebas.p(8)), 'on_hold', 'y retiene');

select pruebas.liquidacion(9, 'ready_to_pay');
select (pruebas.abre(pruebas.p(9)) ->> 'read_id')::uuid as lectura9 \gset
select is(pruebas.pide(pruebas.f2(), format('private.payout_account_void_read(%L, %L)', :'lectura9', 'No transferí'))::jsonb ->> 'outcome', 'not_yours', 'solo quien la abrió la anula');
select is(pruebas.pide(pruebas.f1(), format('private.payout_account_void_read(%L, %L)', :'lectura9', ' '))::jsonb ->> 'outcome', 'malformed', 'con su nota');
select is(pruebas.pide(pruebas.f1(), format('private.payout_account_void_read(%L, %L)', :'lectura9', 'No transferí'))::jsonb ->> 'outcome', 'voided', 'quien la abrió la anula');
select is(pruebas.abre(pruebas.p(9), pruebas.f2()) ->> 'outcome', 'ok', 'y otra persona ya la puede abrir');
select is(pruebas.marca(pruebas.p(9), :'lectura9', 'R9') ->> 'conflict', 'stale_read', 'una transferencia con la lectura anulada choca');
select is(pruebas.pide(pruebas.f1(), format('private.payout_account_void_read(%L, %L)', :'lectura9', 'Otra vez'))::jsonb ->> 'outcome', 'used', 'y una lectura con su pago ya no se anula');

-- La lectura de quien ya no es de finanzas la anula otra persona, o la liquidación no se abriría nunca.
select pruebas.liquidacion(10, 'ready_to_pay');
select (pruebas.abre(pruebas.p(10)) ->> 'read_id')::uuid as lectura10 \gset
select is(pruebas.abre(pruebas.p(10), pruebas.f2()) ->> 'outcome', 'already_open', 'abierta por otra persona');
create function pruebas.f1_sin_finanzas(p_sin boolean) returns void language plpgsql security definer as $$
begin
  set local session_replication_role = replica;
  update public.admin_capabilities set revoked_at = case when p_sin then now() end, revoked_by = case when p_sin then pruebas.f2() end
  where profile_id = pruebas.f1() and capability = 'finance';
  set local session_replication_role = origin;
end
$$;
select pruebas.f1_sin_finanzas(true);
select is(pruebas.pide(pruebas.f2(), format('private.payout_account_void_read(%L, %L)', :'lectura10', 'Ya no está en finanzas; no transfirió'))::jsonb ->> 'outcome', 'voided',
          'si quien la abrió ya no es de finanzas, otra persona la anula');
select pruebas.f1_sin_finanzas(false);
select is(pruebas.abre(pruebas.p(10), pruebas.f2()) ->> 'outcome', 'ok', 'y ya se abre');

-- ---------------------------------------------------------------------------------------
-- Nadie sobre sí.

select pruebas.como_dueno();
create function pruebas.f1_es_maestra() returns void language plpgsql security definer as $$
begin
  set local session_replication_role = replica;
  update public.teachers set profile_id = pruebas.f1() where id = pruebas.m();
  set local session_replication_role = origin;
end
$$;
select pruebas.f1_es_maestra();
select is(pruebas.abre(pruebas.p(6)) ->> 'outcome', 'self', 'abrir la cuenta propia, no');
select is(pruebas.llama(pruebas.p(6)) ->> 'outcome', 'self', 'anotar la llamada propia, no');
select is(pruebas.marca(pruebas.p(6), :'lectura6', 'R6') ->> 'outcome', 'self', 'marcar la propia, no');
select is(pruebas.devuelve((select id from private.payout_payments where payout_id = pruebas.p(6) and reference = 'R6'), pruebas.f1()) ->> 'outcome', 'self', 'devolver la propia, no');
select is(pruebas.pide(pruebas.f1(), format('private.payout_account_void_read(%L, %L)', :'lectura6', 'No transferí'))::jsonb ->> 'outcome', 'self', 'anular una lectura de la propia, no');
select pruebas.como_dueno();
set local session_replication_role = replica;
update public.teachers set profile_id = pruebas.tere() where id = pruebas.m();
set local session_replication_role = origin;

-- ---------------------------------------------------------------------------------------
-- Lo que la base exige al confirmar, aunque alguien escriba directo.

select pruebas.liquidacion(7, 'ready_to_pay');
-- Con fraude decidido, soltar pide dos personas aunque no la pague (decisión 3).
select pruebas.como_dueno();
set local session_replication_role = replica;
insert into public.anomaly_alerts (period_id, kind, teacher_id, metric_value, threshold_value, status, is_fraud, reviewed_by, reviewed_at, review_note, fraud_marked_by, evidence)
values (203007, 'teacher_points_jump', pruebas.m(), 1, 1, 'reviewed', true, pruebas.k1(), now(), 'Era fraude', pruebas.k1(), 'Capturas del panel');
set local session_replication_role = origin;
select is(pruebas.pide(pruebas.f2(), format('private.hold_payout(%L, %L, %L)', pruebas.p(7), 'Fraude', 'ready_to_pay'))::jsonb ->> 'outcome', 'held', 'se retiene por el fraude');
select is(pruebas.suelta(pruebas.p(7), pruebas.f1()) ->> 'outcome', 'proposed', 'soltarla sin pagarla, con fraude decidido, es una propuesta');
select is(pruebas.suelta(pruebas.p(7), pruebas.f2()) ->> 'to', 'ready_to_pay', 'y otra persona la suelta a lista para pago');
select pruebas.como_dueno();
select set_config('app.actor_id', pruebas.f1()::text, true);
set constraints all immediate;
select throws_ok(format($$update public.payouts set status = 'paid' where id = %L$$, pruebas.p(7)), '23514', null, 'pagada sin un pago vivo, no');
select throws_ok($$update private.payout_payments set amount_cents = 1$$, '42501', null, 'el libro de pagos no se edita');
select throws_ok($$delete from private.payout_account_reads$$, '42501', null, 'ni el de lecturas se borra');
select throws_like(format($$update public.payouts set status = 'ready_to_pay' where id = %L$$, pruebas.p(6)), '%does not go from paid to ready_to_pay%', 'de pagada a lista para pago no se pasa: lo detiene el guardián');
select throws_ok(format($$update public.payouts set status = 'payment_returned' where id = %L$$, pruebas.p(6)), '23514', null, 'devuelta con un pago vivo, no');
set constraints all deferred;

select * from finish();
rollback;
