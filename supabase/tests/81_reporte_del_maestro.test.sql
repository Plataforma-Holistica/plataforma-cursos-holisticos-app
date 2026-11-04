-- T-604, cuarta solicitud · El reporte del maestro y el alias (RF-504, RF-505, RF-506, RF-610, RN-15; PA-46 y PA-47; decisiones de Sergio del 2026-11-03:
-- por alumno solo el alias y los puntos, con los pesos en el total, y la línea de consumo excluido va con T-607). El maestro lee lo suyo por tres funciones,
-- sin decir quién es: PA-46 (`payouts_mine`), PA-47 (`payout_report_mine`) y el CSV. El alias de cada alumno se crea al leer, distinto por maestro.
begin;
\ir _ayuda.psql
select plan(67);

select pruebas.alta('a8100000-0000-0000-0000-000000000001', 'tere-81@prueba.test');
select pruebas.alta('a8100000-0000-0000-0000-000000000002', 'otra-81@prueba.test');
select pruebas.alta('a8100000-0000-0000-0000-000000000003', 'susi-81@prueba.test');
select pruebas.alta('a8100000-0000-0000-0000-000000000004', 'nadie-81@prueba.test');
select pruebas.alta('c8100000-0000-0000-0000-000000000001', 'f1-81@prueba.test');
select pruebas.alta(('d8100000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'alumno' || n || '-81@prueba.test') from generate_series(1, 4) n;
select pruebas.confirmar(id) from auth.users where email like '%-81@prueba.test';
select pruebas.dar_capacidad('c8100000-0000-0000-0000-000000000001', 'finance');

create function pruebas.tere() returns uuid language sql immutable as $$ select 'a8100000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.otra() returns uuid language sql immutable as $$ select 'a8100000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.susi() returns uuid language sql immutable as $$ select 'a8100000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.nadie() returns uuid language sql immutable as $$ select 'a8100000-0000-0000-0000-000000000004'::uuid $$;
create function pruebas.f1() returns uuid language sql immutable as $$ select 'c8100000-0000-0000-0000-000000000001'::uuid $$;
-- El alumno n.
create function pruebas.a(n integer) returns uuid language sql immutable as $$ select ('d8100000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
-- Los maestros: m(1) es Tere, m(2) Otra (sin curso publicado) y m(3) Susi (suspendida).
create function pruebas.m(n integer) returns uuid language sql immutable as $$ select ('e8100000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
-- La liquidación del maestro t en el mes n de 2031.
create function pruebas.p(t integer, n integer) returns uuid language sql immutable
as $$ select ('b8100000-0000-4000-8000-' || lpad((t * 100 + n)::text, 12, '0'))::uuid $$;
create function pruebas.mes(n integer) returns public.period_id language sql immutable as $$ select (203100 + n)::public.period_id $$;

-- Un periodo de 2031 con su corrida, en el estado que se pida: el bote del periodo es de 50 000 pesos, al 60 %.
create function pruebas.periodo(n integer, p_estado public.period_status default 'closed') returns void language plpgsql as $$
declare
  v_run uuid := gen_random_uuid();
begin
  set local session_replication_role = replica;
  insert into public.close_runs (id, period_id, kind, status, period_status_at_run, code_version, parameters, started_by, error)
  values (v_run, pruebas.mes(n), 'rehearsal', 'failed', 'open', 'prueba', '{}', pruebas.f1(), 'prueba');
  insert into public.payout_periods (period_id, starts_at, ends_at, timezone, status, entered_closing_at, active_students, pool_bps,
                                     net_revenue_cents, student_pools_cents, pool_cents, assigned_cents, unconsumed_cents, carried_out_cents,
                                     close_run_id, closed_at, closed_by, payouts_released_at, payouts_released_by)
  select pruebas.mes(n), b.starts_at, b.ends_at, 'America/Mexico_City', p_estado, case when p_estado = 'open' then null else now() end, 4, 6000,
         8333333, 5000000, 5000000, case when n = 9 then 0 else 4000000 end, case when n = 9 then 5000000 else 1000000 end, 0,
         v_run, case when p_estado = 'open' then null else now() end, case when p_estado = 'open' then null else pruebas.f1() end, null, null
  from private.month_bounds(pruebas.mes(n), 'America/Mexico_City') b;
  set local session_replication_role = origin;
end
$$;
-- Lo que el cierre deja de un alumno con un maestro: su bote y su parte.
create function pruebas.parte(n integer, p_alumno integer, p_maestro integer, p_medios integer, p_centavos bigint) returns void language plpgsql as $$
begin
  set local session_replication_role = replica;
  insert into public.payout_student_pools (period_id, profile_id, close_run_id, base_cents, pool_cents, half_points)
  select pruebas.mes(n), pruebas.a(p_alumno), p.close_run_id, 30000, 18000, 20 from public.payout_periods p where p.period_id = pruebas.mes(n)
  on conflict do nothing;
  insert into public.payout_shares (period_id, profile_id, teacher_id, close_run_id, half_points, amount_cents)
  select pruebas.mes(n), pruebas.a(p_alumno), pruebas.m(p_maestro), p.close_run_id, p_medios, p_centavos from public.payout_periods p where p.period_id = pruebas.mes(n);
  set local session_replication_role = origin;
end
$$;
create function pruebas.totales(n integer, p_maestro integer, p_medios integer, p_alumnos integer, p_asignado bigint, p_sin_consumo bigint) returns void
language plpgsql as $$
begin
  set local session_replication_role = replica;
  insert into public.payout_teacher_totals (period_id, teacher_id, close_run_id, half_points, students, assigned_cents, unconsumed_cents, total_cents)
  select pruebas.mes(n), pruebas.m(p_maestro), p.close_run_id, p_medios, p_alumnos, p_asignado, p_sin_consumo, p_asignado + p_sin_consumo
  from public.payout_periods p where p.period_id = pruebas.mes(n);
  set local session_replication_role = origin;
end
$$;
-- Una liquidación del maestro t en el mes n, con su bote y lo demás que se pida (columnas de payouts, en jsonb).
create function pruebas.liquidacion(t integer, n integer, p_bote bigint, p_estado public.payout_status, p_mas jsonb default '{}') returns uuid
language plpgsql as $$
declare
  r public.payouts;
begin
  r := jsonb_populate_record(null::public.payouts, jsonb_build_object(
         'id', pruebas.p(t, n), 'period_id', pruebas.mes(n), 'teacher_id', pruebas.m(t),
         'close_run_id', (select close_run_id from public.payout_periods where period_id = pruebas.mes(n)),
         'status', p_estado, 'pool_cents', p_bote, 'bonuses_cents', 0, 'adjustments_cents', 0, 'balance_applied_cents', 0,
         'subtotal_cents', p_bote, 'vat_cents', 0, 'income_tax_withheld_cents', 0, 'vat_withheld_cents', 0, 'net_cents', p_bote,
         'released_at', case when p_estado = 'calculated' then null else now() end,
         'released_by', case when p_estado = 'calculated' then null else pruebas.f1() end,
         'created_at', now(), 'updated_at', now()) || p_mas);
  set local session_replication_role = replica;
  insert into public.payouts select r.*;
  set local session_replication_role = origin;
  return r.id;
end
$$;
-- Lo que ve el maestro m: PA-46, PA-47 y el CSV.
create function pruebas.mias(p_quien uuid) returns jsonb language sql as $$ select pruebas.pide(p_quien, 'private.payouts_mine()')::jsonb $$;
create function pruebas.reporte(p_quien uuid, n integer) returns jsonb language sql
as $$ select pruebas.pide(p_quien, format('private.payout_report_mine(%s)', pruebas.mes(n)))::jsonb $$;
create function pruebas.csv(p_quien uuid, n integer) returns jsonb language sql
as $$ select pruebas.pide(p_quien, format('private.payout_report_csv_mine(%s)', pruebas.mes(n)))::jsonb $$;
-- La fila de PA-46 del mes n.
create function pruebas.fila(p_quien uuid, n integer) returns jsonb language sql
as $$ select x from jsonb_array_elements(pruebas.mias(p_quien) -> 'periods') x where (x ->> 'period_id')::integer = pruebas.mes(n) $$;
create function pruebas.alias(p_maestro integer, p_alumno integer) returns text language sql security definer
as $$ select alias from private.student_aliases where teacher_id = pruebas.m(p_maestro) and profile_id = pruebas.a(p_alumno) $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- Los maestros. Tere publicó en febrero de 2031; Otra no tiene curso; Susi está suspendida.
select pruebas.como_dueno_sistema();
insert into public.teachers (id, profile_id, status) values
  (pruebas.m(1), pruebas.tere(), 'active'), (pruebas.m(2), pruebas.otra(), 'active'), (pruebas.m(3), pruebas.susi(), 'active');
set local session_replication_role = replica;
update public.teachers set status = 'suspended', suspended_at = now(), suspended_by = pruebas.f1(), suspension_reason = 'prueba',
       suspension_notice = 'Tu cuenta de maestro está en pausa.' where id = pruebas.m(3);
insert into public.course_registry (teacher_id, state, first_published_at, withdrawn_at, withdrawal_reason)
values (pruebas.m(1), 'withdrawn', '2031-02-10 12:00-06', '2031-06-01 12:00-06', 'prueba'),
       (pruebas.m(1), 'published', '2031-05-10 12:00-06', null, null),
       (pruebas.m(3), 'published', '2031-01-05 12:00-06', null, null);
set local session_replication_role = origin;
select pruebas.como_dueno();

select pruebas.periodo(n) from generate_series(1, 11) n;
select pruebas.periodo(12, 'open');

-- Febrero: tres alumnos con Tere y uno de ellos también con Otra. Tere: 9 000 asignados más 1 000 sin consumo.
select pruebas.parte(2, 1, 1, 6, 5000);
select pruebas.parte(2, 2, 1, 3, 2500);
select pruebas.parte(2, 3, 1, 3, 1500);
select pruebas.parte(2, 1, 2, 4, 3000);
select pruebas.parte(2, 4, 3, 2, 800);
select pruebas.totales(2, 1, 12, 3, 9000, 1000);
select pruebas.totales(2, 2, 4, 1, 3000, 400);
select pruebas.totales(2, 3, 2, 1, 800, 100);
-- Liberada con un bono de fundador, un ajuste de enero, IVA y retenciones: espera factura y vence el 20 de marzo.
select pruebas.liquidacion(1, 2, 10000, 'awaiting_invoice', jsonb_build_object(
  'bonuses_cents', 2000, 'adjustments_cents', -500, 'subtotal_cents', 11500, 'vat_cents', 1840, 'income_tax_withheld_cents', 1150,
  'vat_withheld_cents', 1227, 'net_cents', 10963, 'invoice_due_on', '2031-03-20'));
select pruebas.liquidacion(2, 2, 3400, 'calculated');
select pruebas.liquidacion(3, 2, 900, 'carried_forward', '{"invoice_due_on": null}');
set local session_replication_role = replica;
insert into public.bonuses (teacher_id, period_id, kind, status, amount_cents, basis_cents, multiplier_bps)
values (pruebas.m(1), pruebas.mes(2), 'founder', 'confirmed', 2000, 10000, 2000),
       (pruebas.m(1), pruebas.mes(2), 'discretionary', 'proposed', 900, null, null);
insert into public.payout_adjustments (teacher_id, origin_period_id, applied_period_id, amount_cents, reason, created_by)
values (pruebas.m(1), pruebas.mes(1), pruebas.mes(2), -500, 'Un motivo interno que el maestro no ve', pruebas.f1());
set local session_replication_role = origin;
-- Enero: Otra no publicó, pero tiene un bono: su liquidación en 0 del bote aparece.
select pruebas.liquidacion(2, 1, 0, 'carried_forward', '{"bonuses_cents": 300, "subtotal_cents": 300, "net_cents": 300}');
-- Marzo: Tere sin consumo ni pendiente: la fila en cero.
-- Abril: acumulada en contra. Mayo: retenida por una investigación, desde en espera de factura. Junio: retenida por datos, desde calculada.
select pruebas.liquidacion(1, 4, 200, 'carried_forward', '{"balance_applied_cents": -700, "subtotal_cents": -500, "net_cents": -500}');
select pruebas.liquidacion(1, 5, 9000, 'on_hold', jsonb_build_object('held_from_status', 'awaiting_invoice', 'held_at', now(), 'held_by', pruebas.f1(),
  'hold_reason', 'Un secreto de la investigación', 'hold_kind', 'investigation', 'invoice_due_on', '2031-06-20'));
select pruebas.liquidacion(1, 6, 9000, 'on_hold', jsonb_build_object('held_from_status', 'calculated', 'held_at', now(), 'held_by', pruebas.f1(),
  'hold_reason', 'Faltan sus datos', 'hold_kind', 'tax_data', 'released_at', null, 'released_by', null));
-- Julio: retenida porque su pago chocó. Agosto: pagada. Septiembre: nada asignado en todo el periodo; su factura rechazada y vencida.
select pruebas.liquidacion(1, 7, 9000, 'on_hold', jsonb_build_object('held_from_status', 'ready_to_pay', 'held_at', now(), 'held_by', pruebas.f1(),
  'hold_reason', 'La referencia ya se usó', 'hold_kind', 'payment'));
select pruebas.liquidacion(1, 8, 9000, 'paid');
select pruebas.liquidacion(1, 9, 9000, 'invoice_rejected', jsonb_build_object('invoice_due_on', '2031-10-20', 'invoice_overdue_at', '2031-10-21 07:00-06'));
-- Octubre: el banco devolvió el pago. Noviembre: calculada, sin liberar.
select pruebas.liquidacion(1, 10, 9000, 'payment_returned');
select pruebas.liquidacion(1, 11, 9000, 'calculated');
select pruebas.liquidacion(3, 3, 5000, 'awaiting_invoice');
set local session_replication_role = replica;
insert into private.teacher_tax_profiles (teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version, created_by,
                                          clabe_changed_at, clabe_effective_from)
values (pruebas.m(1), 1, decode('010001' || repeat('ab', 41), 'hex'), decode('010001' || repeat('ab', 48), 'hex'), '612', 'person',
        decode('010001' || repeat('ab', 46), 'hex'), '7771', 1, pruebas.tere(), now() - interval '10 days', now() - interval '7 days');
insert into private.payout_account_reads (id, payout_id, teacher_id, tax_profile_id, tax_profile_version, clabe_changed_at, first_time, read_by)
values ('f8100000-0000-4000-8000-000000000001', pruebas.p(1, 8), pruebas.m(1), gen_random_uuid(), 1, now(), false, pruebas.f1()),
       ('f8100000-0000-4000-8000-000000000002', pruebas.p(1, 8), pruebas.m(1), gen_random_uuid(), 1, now(), false, pruebas.f1());
-- Dos transferencias reportadas: la primera chocó y se devolvió; la que vale es la segunda.
insert into private.payout_payments (id, payout_id, teacher_id, read_id, tax_profile_version, clabe_changed_at, reference, paid_on, amount_cents, first_time,
                                     account_changed_since_read, conflict, recorded_by, recorded_at)
values ('f8100000-0000-4000-8000-000000000011', pruebas.p(1, 8), pruebas.m(1), 'f8100000-0000-4000-8000-000000000001', 1, now(), 'MAL-1', '2031-09-08', 8000,
        false, false, 'amount_differs', pruebas.f1(), now() - interval '2 days'),
       ('f8100000-0000-4000-8000-000000000012', pruebas.p(1, 8), pruebas.m(1), 'f8100000-0000-4000-8000-000000000002', 1, now(), 'SPEI-778', '2031-09-10', 9000,
        false, false, null, pruebas.f1(), now() - interval '1 day');
insert into private.payout_requests (kind, payout_id, payment_id, note, proposed_by, status, decided_by, decided_at)
values ('payment_return', pruebas.p(1, 8), 'f8100000-0000-4000-8000-000000000011', 'Devuelto', pruebas.f1(), 'confirmed', pruebas.tere(), now());
insert into private.teacher_invoices (id, payout_id, teacher_id, status, pdf_path, pdf_object_id, pdf_object_version, pdf_bytes, xml_enc, xml_sha256, cfdi_uuid,
                                      issued_at, stamped_at, issuer_regime, issuer_profile_version, receiver_rfc, subtotal_cents, vat_cents,
                                      income_tax_withheld_cents, vat_withheld_cents, total_cents, submitted_by, submitted_at, reviewed_by, reviewed_at, rejection_reason)
values ('f8100000-0000-4000-8000-000000000021', pruebas.p(1, 9), pruebas.m(1), 'rejected',
        pruebas.m(1) || '/' || pruebas.p(1, 9) || '/f8100000-0000-4000-8000-000000000021.pdf', gen_random_uuid(), 'v1', 2000,
        decode('010001' || repeat('ab', 40), 'hex'), sha256('x'), gen_random_uuid(), now(), now(), '612', 1, 'PHO200101AB1', 9000, 0, 0, 0, 8000,
        pruebas.tere(), '2031-10-15 10:00-06', pruebas.f1(), '2031-10-16 10:00-06', 'El total no coincide con tu liquidación');
set local session_replication_role = origin;

-- ---------------------------------------------------------------------------------------
-- Lo que la aplicación ve: nada de las tablas, y solo el servidor llama.

select ok(not has_table_privilege('app_service', 'private.student_aliases', 'select, insert, update, delete'), 'el servidor no toca los alias de frente');
select ok(not has_table_privilege('authenticated', 'public.payout_shares', 'select'), 'ni una persona las partes');
select ok(has_function_privilege('app_service', 'private.payout_report_mine(public.period_id)', 'execute')
          and not has_function_privilege('authenticated', 'private.payout_report_mine(public.period_id)', 'execute'), 'el reporte lo pide el servidor');
select ok(not has_function_privilege('app_service', 'private.ensure_student_aliases(uuid, public.period_id)', 'execute'), 'crear alias no es de la aplicación');
select is(pruebas.mias(pruebas.nadie()) ->> 'outcome', 'not_teacher', 'quien no es maestro no lee nada');
select is(pruebas.reporte(pruebas.nadie(), 2) ->> 'outcome', 'not_teacher', 'ni un reporte');

-- ---------------------------------------------------------------------------------------
-- PA-46: los periodos con liquidación, y en cero desde el primer curso publicado.

select is((select array_agg((x ->> 'period_id')::integer order by ordinality) from jsonb_array_elements(pruebas.mias(pruebas.tere()) -> 'periods') with ordinality x),
  array[203111, 203110, 203109, 203108, 203107, 203106, 203105, 203104, 203103, 203102], 'Tere: de su primer mes publicado al último cerrado, el más reciente primero');
select is(pruebas.fila(pruebas.tere(), 3) - 'period_id', jsonb_build_object('status', 'empty', 'pool_cents', 0, 'bonuses_cents', 0,
  'adjustments_cents', 0, 'balance_applied_cents', 0, 'net_cents', null, 'carried_cents', null, 'invoice_due_on', null, 'overdue', false, 'action', null),
  'un mes sin consumo ni pendiente sale en cero');
select is((select array_agg((x ->> 'period_id')::integer) from jsonb_array_elements(pruebas.mias(pruebas.otra()) -> 'periods') x),
  array[203102, 203101], 'Otra no publicó: salen solo sus meses con liquidación, también el del bono');
select is(pruebas.fila(pruebas.otra(), 1) ->> 'carried_cents', '300', 'y su bono acumulado pasa al siguiente');
select is(pruebas.fila(pruebas.tere(), 2) - 'period_id', jsonb_build_object('status', 'awaiting_invoice', 'pool_cents', 10000,
  'bonuses_cents', 2000, 'adjustments_cents', -500, 'balance_applied_cents', 0, 'net_cents', 10963, 'carried_cents', null, 'invoice_due_on', '2031-03-20',
  'overdue', false, 'action', 'upload_invoice'), 'la que espera factura: su neto y la acción');
select is(pruebas.fila(pruebas.tere(), 4) ->> 'net_cents', null, 'una acumulada no tiene neto: no se paga');
select is(pruebas.fila(pruebas.tere(), 4) ->> 'carried_cents', '-500', 'pasa al siguiente, en contra');
select is(pruebas.fila(pruebas.tere(), 4) ->> 'balance_applied_cents', '-700', 'con el saldo que se le aplicó');
select is(pruebas.fila(pruebas.tere(), 9) ->> 'action', 'upload_invoice', 'vencida y rechazada, todavía se factura');
select is(pruebas.fila(pruebas.tere(), 9) ->> 'overdue', 'true', 'y dice que venció');
select is(pruebas.fila(pruebas.tere(), 11) ->> 'net_cents', null, 'sin liberar, sin neto');
select is(pruebas.fila(pruebas.tere(), 11) ->> 'pool_cents', '9000', 'pero sí su reparto');
select is(pruebas.mias(pruebas.tere()) ->> 'balance_cents', null, 'sin saldo acumulado, no hay cifra');
set local session_replication_role = replica;
insert into public.teacher_balance_entries (teacher_id, payout_id, period_id, kind, amount_cents)
values (pruebas.m(1), pruebas.p(1, 4), pruebas.mes(4), 'carried_forward', -500);
set local session_replication_role = origin;
select is(pruebas.mias(pruebas.tere()) ->> 'balance_cents', '-500', 'con saldo, la cifra');
select is((select array_agg((x ->> 'period_id')::integer) from jsonb_array_elements(pruebas.mias(pruebas.susi()) -> 'periods') x),
  array[203111, 203110, 203109, 203108, 203107, 203106, 203105, 203104, 203103, 203102, 203101], 'una maestra suspendida lee lo suyo');
select ok(not exists (select 1 from jsonb_array_elements(pruebas.mias(pruebas.tere()) -> 'periods') x where (x ->> 'period_id')::integer = 203112),
  'un periodo abierto no sale');

-- ---------------------------------------------------------------------------------------
-- Lo que ve el maestro de una retenida: «En revisión», sin motivo (decisión 4 del plan).

select is(pruebas.fila(pruebas.tere(), 5) ->> 'status', 'in_review', 'una investigación se ve en revisión');
select is(pruebas.fila(pruebas.tere(), 7) ->> 'status', 'in_review', 'y un pago que chocó, igual');
select ok(position('on_hold' in pruebas.mias(pruebas.tere())::text) = 0 and position('investigation' in pruebas.reporte(pruebas.tere(), 5)::text) = 0,
  'sin decir que está retenida ni por qué clase');
select is(pruebas.fila(pruebas.tere(), 5) ->> 'action', null, 'ni pedir factura');
select is(pruebas.fila(pruebas.tere(), 6) ->> 'status', 'tax_data_review', 'retenida por datos que ya capturó: falta que finanzas suelte');
select is(pruebas.fila(pruebas.tere(), 6) ->> 'net_cents', null, 'desde calculada, sin neto');
select ok(position('secreto' in pruebas.mias(pruebas.tere())::text) = 0 and position('secreto' in pruebas.reporte(pruebas.tere(), 5)::text) = 0,
  'el motivo de la retención no sale');
set local session_replication_role = replica;
delete from private.teacher_tax_profiles where teacher_id = pruebas.m(1);
set local session_replication_role = origin;
select is(pruebas.fila(pruebas.tere(), 6) ->> 'status', 'tax_data_missing', 'sin sus datos, le dice que faltan');

-- ---------------------------------------------------------------------------------------
-- PA-47.

select is(pruebas.reporte(pruebas.tere(), 12) ->> 'outcome', 'not_found', 'un periodo abierto no tiene reporte');
select is(pruebas.reporte(pruebas.otra(), 3) ->> 'outcome', 'not_found', 'ni uno sin liquidación antes de publicar');
select is(pruebas.reporte(pruebas.tere(), 3) ->> 'outcome', 'empty', 'el mes en cero tiene su reporte vacío');
select is(pruebas.reporte(pruebas.tere(), 2) -> 'summary', jsonb_build_object('pool_cents', 5000000, 'pool_bps', 6000, 'nothing_assigned', false,
  'assigned_cents', 9000, 'unconsumed_cents', 1000, 'total_cents', 10000, 'half_points', 12, 'students', 3), 'el resumen del periodo y lo suyo');
select is(pruebas.reporte(pruebas.tere(), 2) -> 'money', jsonb_build_object('pool_cents', 10000, 'bonuses_cents', 2000, 'adjustments_cents', -500,
  'balance_applied_cents', 0, 'subtotal_cents', 11500, 'vat_cents', 1840, 'income_tax_withheld_cents', 1150, 'vat_withheld_cents', 1227, 'net_cents', 10963,
  'bonuses', jsonb_build_array(jsonb_build_object('kind', 'founder', 'amount_cents', 2000)),
  'adjustments', jsonb_build_array(jsonb_build_object('origin_period_id', 203101, 'amount_cents', -500))), 'el dinero, con cada bono confirmado y cada ajuste');
select ok(position('motivo interno' in pruebas.reporte(pruebas.tere(), 2)::text) = 0, 'sin el motivo del ajuste');
select is(pruebas.reporte(pruebas.tere(), 11) -> 'money', 'null'::jsonb, 'antes de liberar no hay dinero');
select is(pruebas.reporte(pruebas.tere(), 6) -> 'money', 'null'::jsonb, 'ni retenida desde calculada');
select is(pruebas.reporte(pruebas.tere(), 9) -> 'summary' ->> 'nothing_assigned', 'true', 'un periodo sin nada asignado lo dice (FL-39 A3)');
select is(pruebas.reporte(pruebas.tere(), 9) -> 'invoice' -> 'latest', jsonb_build_object('status', 'rejected', 'submitted_at', '2031-10-15 10:00-06'::timestamptz,
  'reviewed_at', '2031-10-16 10:00-06'::timestamptz, 'rejection_reason', 'El total no coincide con tu liquidación'), 'la factura rechazada, con su motivo');
select is(pruebas.reporte(pruebas.tere(), 2) -> 'invoice' -> 'latest', 'null'::jsonb, 'sin factura todavía');
select is(pruebas.reporte(pruebas.tere(), 2) -> 'invoice' ->> 'receiver_rfc', null, 'sin RFC de quien recibe (PQ-20)');
select is(pruebas.reporte(pruebas.tere(), 8) -> 'payment', jsonb_build_object('paid_on', '2031-09-10', 'reference', 'SPEI-778', 'amount_cents', 9000),
  'pagada: la transferencia que vale, con el neto');
select is(pruebas.reporte(pruebas.tere(), 2) -> 'payment', 'null'::jsonb, 'sin pagar, sin pago');
select is(pruebas.reporte(pruebas.tere(), 10) ->> 'status', 'payment_returned', 'el pago devuelto se dice');

-- Las filas: alias y medios puntos, sin pesos por alumno, de más a menos puntos.
select is((select array_agg(x ->> 'half_points' order by ordinality) from jsonb_array_elements(pruebas.reporte(pruebas.tere(), 2) -> 'students') with ordinality x),
  array['6', '3', '3'], 'una fila por alumno, de más a menos');
select is((select array_agg(k order by k) from jsonb_array_elements(pruebas.reporte(pruebas.tere(), 2) -> 'students') x, jsonb_object_keys(x) k),
  array['alias', 'alias', 'alias', 'half_points', 'half_points', 'half_points'], 'cada fila trae solo alias y puntos');
select is((select array_agg(k order by k) from jsonb_object_keys(pruebas.reporte(pruebas.tere(), 2)) k),
  array['invoice', 'invoice_due_on', 'money', 'outcome', 'overdue', 'payment', 'period_id', 'released', 'status', 'students', 'summary']::text[],
  'el reporte trae una lista cerrada de claves');
select ok(position(pruebas.a(1)::text in pruebas.reporte(pruebas.tere(), 2)::text) = 0 and position('base_cents' in pruebas.reporte(pruebas.tere(), 2)::text) = 0,
  'ni el identificador del alumno ni su base');
select is((select sum((x ->> 'half_points')::integer) from jsonb_array_elements(pruebas.reporte(pruebas.tere(), 2) -> 'students') x),
  (pruebas.reporte(pruebas.tere(), 2) -> 'summary' ->> 'half_points')::bigint, 'las filas suman los puntos del total');
select is((pruebas.reporte(pruebas.tere(), 2) -> 'summary' ->> 'total_cents')::bigint, (select pool_cents from public.payouts where id = pruebas.p(1, 2)),
  'y el total es lo que le tocó del bote en su liquidación');

-- ---------------------------------------------------------------------------------------
-- El alias: estable, con forma, distinto con otro maestro, y nunca en el cierre.

select ok(pruebas.alias(1, 1) ~ '^[A-Z][a-z]+ [1-9][0-9]{1,2}$', 'el alias tiene la forma de «Ceiba 42»');
select is((select x ->> 'alias' from jsonb_array_elements(pruebas.reporte(pruebas.tere(), 2) -> 'students') x where (x ->> 'half_points')::integer = 6),
  pruebas.alias(1, 1), 'leer otra vez da el mismo');
select ok(pruebas.alias(2, 1) is null, 'Otra todavía no leyó: su alumno no tiene alias con ella');
select is(jsonb_array_length(pruebas.reporte(pruebas.otra(), 2) -> 'students'), 1, 'Otra ve a su único alumno');
select ok(pruebas.alias(2, 1) is not null, 'y al leer se crea el suyo');
select is((select count(*) from private.student_aliases where teacher_id = pruebas.m(3)), 0::bigint, 'Susi no leyó febrero: sin alias');
select is((select count(*) from audit_log where entity_table like '%student_aliases' or new_value ? 'alias'), 0::bigint, 'el alias no deja rastro en la auditoría');
select throws_ok($$ update private.student_aliases set alias = 'Ceiba 10' $$, '42501', null, 'un alias no cambia');
select throws_ok($$ delete from private.student_aliases $$, '42501', null, 'ni se borra');
-- Una lápida conserva el suyo.
set local session_replication_role = replica;
update public.profiles set status = 'deleted' where id = pruebas.a(1);
set local session_replication_role = origin;
select is((select x ->> 'alias' from jsonb_array_elements(pruebas.reporte(pruebas.tere(), 2) -> 'students') x where (x ->> 'half_points')::integer = 6),
  pruebas.alias(1, 1), 'el alumno que borró su cuenta sigue con su alias');
-- Con un espacio de dos alias, el tercer alumno de Susi no cabe: error, y no un alumno sin alias.
create or replace function private.alias_candidate(p_try integer) returns text language sql volatile set search_path = ''
as $$ select case when pg_catalog.random() < 0.5 then 'Ceiba 10' else 'Ceiba 11' end $$;
select pruebas.parte(3, 1, 3, 2, 100);
select pruebas.parte(3, 2, 3, 2, 100);
select pruebas.parte(3, 3, 3, 2, 100);
select pruebas.totales(3, 3, 6, 3, 300, 0);
select throws_ok(format('select private.ensure_student_aliases(%L, %s)', pruebas.m(3), pruebas.mes(3)), 'P0001', 'student alias space exhausted',
  'si los alias se agotan, falla');
select is((select count(*) from private.student_aliases where teacher_id = pruebas.m(3)), 0::bigint, 'y no deja la mitad');

-- ---------------------------------------------------------------------------------------
-- El CSV: lo mismo que la pantalla.

select is(pruebas.csv(pruebas.tere(), 2) ->> 'outcome', 'ok', 'el CSV de un periodo con reporte');
select is(pruebas.csv(pruebas.tere(), 2) ->> 'csv', chr(65279) || '"Alumno","Puntos","Pesos"' || chr(13) || chr(10)
  || '"' || pruebas.alias(1, 1) || '",3,' || chr(13) || chr(10)
  || (select string_agg('"' || a || '",1.5,' || chr(13) || chr(10), '' order by a) from unnest(array[pruebas.alias(1, 2), pruebas.alias(1, 3)]) a)
  || '"Bote sin consumo",,10.00' || chr(13) || chr(10)
  || '"Total",6,100.00' || chr(13) || chr(10), 'alias y puntos por fila; el bote sin consumo y el total, en pesos');
select is(pruebas.csv(pruebas.tere(), 12) ->> 'outcome', 'not_found', 'sin reporte, sin CSV');

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is((select count(*) from private.schema_violations() v where v.object_name like '%student_aliases%' or v.object_name like '%payout_report%'
           or v.object_name like '%payouts_mine%'), 0::bigint, 'el vigilante no encuentra nada');

select * from finish();
rollback;
