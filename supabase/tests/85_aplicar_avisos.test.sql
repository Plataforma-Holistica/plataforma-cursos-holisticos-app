-- T-303, primera solicitud · Lo que un aviso de Stripe aplica (RF-208, RN-01, RN-02, RN-13; plan aprobado por Sergio el 2026-11-06). `private.billing_apply` recibe lo
-- que el servidor leyó de Stripe en ese momento (la suscripción, los pagos de una factura pagada, la falla de una renovación) y en una sola transacción registra
-- los cobros, deja la suscripción al día y marca el aviso. El estado propio sale de una sola traducción (`billing_state`) y del periodo pagado, que solo avanza un
-- cobro: así el orden de llegada no cambia el estado final, y quien pagó no se queda en `pending`. Lo que no se puede aplicar queda fallido, sin escribir nada.
-- Los meses de los cobros van en octubre y noviembre de 2026, con su fila (T-601), como en la 31.
begin;
\ir _ayuda.psql
set constraints all immediate;
select plan(109);

select pruebas.alta('a8500000-0000-0000-0000-000000000001', 'ana-85@prueba.test');
select pruebas.alta('a8500000-0000-0000-0000-000000000002', 'beto-85@prueba.test');
select pruebas.alta('a8500000-0000-0000-0000-000000000003', 'caro-85@prueba.test');
select pruebas.alta('a8500000-0000-0000-0000-000000000004', 'dani-85@prueba.test');
select pruebas.alta('a8500000-0000-0000-0000-000000000005', null);
select pruebas.alta('a8500000-0000-0000-0000-000000000006', 'gabi-85@prueba.test');
select pruebas.alta('a8500000-0000-0000-0000-000000000007', 'hugo-85@prueba.test');

create function pruebas.cuenta(p_n integer) returns uuid language sql immutable
as $$ select ('a8500000-0000-0000-0000-00000000000' || p_n)::uuid $$;

select pruebas.como_dueno_sistema();
select private.open_period(p) from generate_series(202610, 202612) p;
select pruebas.como_dueno();
-- Lo que ya hubiera en la base: los alumnos activos se miden contra esto.
create temp table activos0 as select private.active_students_at('2026-10-15 12:00-06') as n;

-- Lo que el servidor leyó de una suscripción de Stripe.
create function pruebas.sus(p_sub text, p_profile text, p_status text, p_read timestamptz,
                            p_interval text default 'month', p_currency text default 'mxn', p_cancel boolean default false,
                            p_canceled timestamptz default null, p_started timestamptz default '2026-10-01 10:00-06') returns jsonb
language sql immutable as $$
  select jsonb_build_object('id', p_sub, 'customer', 'cus_' || p_sub, 'profile_id', p_profile, 'status', p_status,
                            'interval', p_interval, 'interval_count', 1, 'currency', p_currency,
                            'cancel_at_period_end', p_cancel, 'canceled_at', p_canceled, 'started_at', p_started, 'read_at', p_read)
$$;
-- Un pago de una factura pagada: el cargo, su factura y el periodo de su línea.
create function pruebas.pago(p_charge text, p_at timestamptz, p_from timestamptz, p_to timestamptz, p_gross bigint default 34900,
                             p_interval text default 'month', p_bt text default null) returns jsonb
language sql immutable as $$
  select jsonb_build_object('charge', p_charge, 'status', 'succeeded', 'invoice', 'in_' || p_charge, 'charged_at', p_at, 'gross_cents', p_gross, 'currency', 'mxn',
                            'method', 'card', 'country', 'MX', 'receipt_url', 'https://pay.stripe.com/receipts/' || p_charge,
                            'interval', p_interval, 'interval_count', 1, 'period_start', p_from, 'period_end', p_to,
                            'fee_cents', case when p_bt is not null then 1600 end, 'net_cents', case when p_bt is not null then p_gross - 1600 end,
                            'balance_transaction', p_bt, 'available_on', case when p_bt is not null then p_at + interval '2 days' end)
$$;
-- Un aviso nuevo, reclamado: devuelve su id y su intento.
create function pruebas.aviso(p_event text, p_type text, p_object text) returns jsonb language plpgsql as $$
declare
  v_id uuid;
  v jsonb;
begin
  perform pruebas.como_sistema();
  v_id := (private.provider_event_receive('stripe', p_event, p_type, false, null, p_object, '2026-10-01 10:00-06') ->> 'id')::uuid;
  v := private.provider_event_claim(v_id);
  perform pruebas.limpiar();
  return jsonb_build_object('id', v_id, 'attempt', (v ->> 'attempt')::integer);
end
$$;
-- Cada pago dice de qué suscripción es (si no lo dice ya).
create function pruebas.con_sus(p_sub jsonb, p_payments jsonb) returns jsonb language sql immutable
as $$ select coalesce(jsonb_agg(jsonb_build_object('subscription', p_sub ->> 'id') || x), '[]') from jsonb_array_elements(p_payments) x $$;
-- Aplica como el servidor sin persona. El objeto del aviso es el de Stripe: la factura del primer pago, la de la falla o la suscripción.
create function pruebas.aplica(p_event text, p_sub jsonb, p_payments jsonb default '[]', p_failure jsonb default null, p_type text default 'invoice.paid',
                               p_object text default null)
returns jsonb language plpgsql as $$
declare
  v_claim jsonb := pruebas.aviso(p_event, p_type, coalesce(p_object, p_payments -> 0 ->> 'invoice', p_failure ->> 'invoice', p_sub ->> 'id', 'sin_objeto'));
  v jsonb;
begin
  perform pruebas.como_sistema();
  v := private.billing_apply((v_claim ->> 'id')::uuid, (v_claim ->> 'attempt')::integer, p_sub, pruebas.con_sus(p_sub, p_payments),
                             case when p_failure is not null then jsonb_build_object('subscription', p_sub ->> 'id') || p_failure end);
  perform pruebas.limpiar();
  return v;
end
$$;
-- Lo vuelve a reclamar y a aplicar (el siguiente intento de un aviso que volvió a la fila).
create function pruebas.reaplica(p_event text, p_sub jsonb, p_payments jsonb default '[]') returns jsonb language plpgsql as $$
declare
  v_id uuid := (pruebas.evento(p_event)).id;
  v jsonb;
begin
  perform pruebas.como_sistema();
  v := private.provider_event_claim(v_id);
  v := private.billing_apply(v_id, (v ->> 'attempt')::integer, p_sub, pruebas.con_sus(p_sub, p_payments), null);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.intentos(p_event text, p_attempts integer) returns void language plpgsql security definer as $$
begin
  set local session_replication_role = replica;
  update private.provider_events set attempts = p_attempts where provider_event_id = p_event;
  set local session_replication_role = origin;
end
$$;
create function pruebas.evento(p_event text) returns private.provider_events language sql security definer
as $$ select e from private.provider_events e where e.provider_event_id = p_event $$;
create function pruebas.estado_de(p_sub text) returns table (status text, provider_status text, period_end timestamptz, failed_at timestamptz,
                                                             cancel boolean, canceled_at timestamptz, ended_at timestamptz)
language sql as $$
  select s.status::text, s.provider_status, s.current_period_end, s.last_renewal_failed_at, s.cancel_at_period_end, s.canceled_at, s.ended_at
  from public.subscriptions s where s.provider = 'stripe' and s.provider_subscription_id = p_sub
$$;
create function pruebas.cobros(p_profile uuid) returns integer language sql as $$ select count(*)::integer from public.charges where profile_id = p_profile $$;
create function pruebas.recibos(p_profile uuid) returns integer language sql security definer
as $$ select count(*)::integer from private.mail_outbox where profile_id = p_profile and template = 'CO-03' $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- La traducción: una sola, de lo que dice Stripe y de si hubo periodo pagado.

select results_eq(
  $$select s, p, private.billing_state(s, p)::text from (values
      ('incomplete', false), ('incomplete', true), ('active', false), ('active', true), ('trialing', false), ('trialing', true),
      ('past_due', false), ('past_due', true), ('canceled', false), ('canceled', true), ('unpaid', false), ('unpaid', true),
      ('incomplete_expired', false), ('incomplete_expired', true)) v (s, p)$$,
  $$values ('incomplete', false, 'pending'), ('incomplete', true, 'pending'), ('active', false, 'pending'), ('active', true, 'active'),
           ('trialing', false, 'pending'), ('trialing', true, 'active'), ('past_due', false, 'pending'), ('past_due', true, 'active'),
           ('canceled', false, 'pending'), ('canceled', true, 'canceled'), ('unpaid', false, 'pending'), ('unpaid', true, 'canceled'),
           ('incomplete_expired', false, 'pending'), ('incomplete_expired', true, 'canceled')$$,
  'sin periodo pagado nunca está activa; con él, viva o cancelada (la gracia es de T-304)');
select is(private.billing_state('paused', true), null, 'un estado que no se conoce no se adivina');
select results_eq($$select private.billing_plan(i, c)::text from (values ('month', 1), ('year', 1), ('month', 3), ('week', 1)) v (i, c)$$,
  $$values ('monthly'), ('annual'), (null), (null)$$, 'el plan sale del intervalo del precio, y solo mes o año de uno');

-- ---------------------------------------------------------------------------------------
-- La suscripción llega antes que su factura (el orden de Stripe, a veces).

select is(pruebas.aplica('evt_85_a1', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'active', '2026-10-01 10:00:05-06'), p_type => 'customer.subscription.created')
          ->> 'outcome', 'processed', 'el aviso de la suscripción se aplica');
select results_eq($$select * from pruebas.estado_de('sub_ana')$$,
  $$values ('pending', 'active', null::timestamptz, null::timestamptz, false, null::timestamptz, null::timestamptz)$$,
  'sin cobro, la fila queda pendiente: Stripe dice activa, pero nadie ha pagado aquí');
select results_eq($$select plan::text, currency, provider_customer_id, provider_started_at, provider_state_at from public.subscriptions where provider_subscription_id = 'sub_ana'$$,
  $$values ('monthly', 'MXN', 'cus_sub_ana', '2026-10-01 10:00-06'::timestamptz, '2026-10-01 10:00:05-06'::timestamptz)$$,
  'con su plan, su moneda, su cliente, su inicio en Stripe y la hora de la lectura');
select results_eq($$select status, finished_at is not null, locked_until is null, last_error is null from pruebas.evento('evt_85_a1')$$,
  $$values ('processed', true, true, true)$$, 'el aviso queda procesado en la misma transacción');

-- Su factura, leída antes que la suscripción (lectura más vieja): el cobro entra igual, y la fila pasa a activa.
select is(pruebas.aplica('evt_85_a2', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'active', '2026-10-01 10:00:01-06'),
                         jsonb_build_array(pruebas.pago('ch_ana_1', '2026-10-01 10:00-06', '2026-10-01 10:00-06', '2026-11-01 10:00-06', p_bt => 'txn_ana_1')))
          ->> 'outcome', 'processed', 'la factura pagada se aplica');
select results_eq($$select * from pruebas.estado_de('sub_ana')$$,
  $$values ('active', 'active', '2026-11-01 10:00-06'::timestamptz, null::timestamptz, false, null::timestamptz, null::timestamptz)$$,
  'activa, pagada hasta el fin de la línea: el estado se vuelve a traducir con el periodo pagado, aunque la lectura sea vieja');
select is((select provider_state_at from public.subscriptions where provider_subscription_id = 'sub_ana'), '2026-10-01 10:00:05-06'::timestamptz,
  'y lo de Stripe se queda con la lectura más nueva');
select results_eq($$select provider_charge_id, provider_invoice_id, plan::text, charged_at, gross_cents, provider_fee_cents, provider_net_cents,
                           payment_method, receipt_url, provider_event_id = (pruebas.evento('evt_85_a2')).id
                    from public.charges where profile_id = pruebas.cuenta(1)$$,
  $$values ('ch_ana_1', 'in_ch_ana_1', 'monthly', '2026-10-01 10:00-06'::timestamptz, 34900::bigint, 1600::bigint, 33300::bigint,
           'card', 'https://pay.stripe.com/receipts/ch_ana_1', true)$$,
  'el cobro entra al libro con su aviso, su comisión y su neto reales');
select results_eq($$select s.balance_transaction_id, s.gross_cents, s.fee_cents, s.net_cents from private.provider_settlements s
                    join public.charges c on c.id = s.charge_id where c.provider_charge_id = 'ch_ana_1'$$,
  $$values ('txn_ana_1', 34900::bigint, 1600::bigint, 33300::bigint)$$, 'y lo que liquida Stripe, en su libro aparte');
select results_eq($$select idempotency_key = 'CO-03:' || (select id from public.charges where provider_charge_id = 'ch_ana_1'), recipient,
                           (params ->> 'gross_cents')::bigint
                    from private.mail_outbox where profile_id = pruebas.cuenta(1) and template = 'CO-03'$$,
  $$values (true, 'ana-85@prueba.test', 34900::bigint)$$, 'y su recibo, una vez, con la llave del cobro (decisión 8 de Sergio)');

-- El mismo cobro otra vez (otro aviso que lo nombra): no se duplica nada.
select is(pruebas.aplica('evt_85_a3', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'active', '2026-10-01 10:00:09-06'),
                         jsonb_build_array(pruebas.pago('ch_ana_1', '2026-10-01 10:00-06', '2026-10-01 10:00-06', '2026-11-01 10:00-06', p_bt => 'txn_ana_1')),
                         p_type => 'invoice.paid') ->> 'outcome', 'processed', 'otro aviso del mismo cobro');
select is(pruebas.cobros(pruebas.cuenta(1)), 1, 'sigue un cobro');
select is(pruebas.recibos(pruebas.cuenta(1)), 1, 'y un recibo');
select is((select count(*)::integer from private.provider_settlements s join public.charges c on c.id = s.charge_id where c.profile_id = pruebas.cuenta(1)), 1,
  'y una liquidación');

-- ---------------------------------------------------------------------------------------
-- El orden contrario da lo mismo: primero la factura, después la suscripción.

select is(pruebas.aplica('evt_85_b1', pruebas.sus('sub_beto', pruebas.cuenta(2)::text, 'active', '2026-10-01 10:00:01-06'),
                         jsonb_build_array(pruebas.pago('ch_beto_1', '2026-10-01 10:00-06', '2026-10-01 10:00-06', '2026-11-01 10:00-06')))
          ->> 'outcome', 'processed', 'la factura llega primero: crea la fila y registra el cobro');
select is(pruebas.aplica('evt_85_b2', pruebas.sus('sub_beto', pruebas.cuenta(2)::text, 'active', '2026-10-01 10:00:05-06'), p_type => 'customer.subscription.created')
          ->> 'outcome', 'processed', 'después la suscripción');
select results_eq($$select status, provider_status, period_end, failed_at, cancel from pruebas.estado_de('sub_beto')$$,
                  $$select status, provider_status, period_end, failed_at, cancel from pruebas.estado_de('sub_ana')$$,
  'el mismo estado final que en el otro orden');
select is(pruebas.recibos(pruebas.cuenta(2)), 1, 'con su recibo');
select is((select count(*)::integer from private.provider_settlements s join public.charges c on c.id = s.charge_id where c.profile_id = pruebas.cuenta(2)), 0,
  'sin la transacción de saldo, no hay liquidación todavía (la completa otro aviso)');

-- ---------------------------------------------------------------------------------------
-- Una lectura vieja no pisa una nueva.

select pruebas.aplica('evt_85_a4', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'active', '2026-10-20 12:00-06', p_cancel => true,
                                               p_canceled => '2026-10-20 11:59-06'), p_type => 'customer.subscription.updated');
select results_eq($$select status, cancel, canceled_at, ended_at from pruebas.estado_de('sub_ana')$$,
  $$values ('active', true, '2026-10-20 11:59-06'::timestamptz, null::timestamptz)$$,
  'cancelar al final del periodo se proyecta, y sigue activa con sus días pagados');
select pruebas.aplica('evt_85_a5', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'active', '2026-10-15 12:00-06'), p_type => 'customer.subscription.updated');
select results_eq($$select cancel, canceled_at from pruebas.estado_de('sub_ana')$$, $$values (true, '2026-10-20 11:59-06'::timestamptz)$$,
  'una lectura más vieja que la guardada no la deshace');

-- ---------------------------------------------------------------------------------------
-- La falla de una renovación (la regla de acceso la espera así: nula si la última renovación no falló, y un reintento no la mueve).

select pruebas.aplica('evt_85_b3', pruebas.sus('sub_beto', pruebas.cuenta(2)::text, 'past_due', '2026-11-01 10:05-06'), '[]',
                      '{"invoice": "in_beto_2", "failed_at": "2026-11-01T16:01:00Z", "unpaid": true, "cycle": true}', 'invoice.payment_failed');
select results_eq($$select status, provider_status, failed_at from pruebas.estado_de('sub_beto')$$,
  $$values ('active', 'past_due', '2026-11-01 16:01Z'::timestamptz)$$,
  'la falla de una renovación se anota con la hora de Stripe; sigue viva (la gracia es de T-304)');
select pruebas.aplica('evt_85_b4', pruebas.sus('sub_beto', pruebas.cuenta(2)::text, 'past_due', '2026-11-03 10:05-06'), '[]',
                      '{"invoice": "in_beto_2", "failed_at": "2026-11-03T16:01:00Z", "unpaid": true, "cycle": true}', 'invoice.payment_failed');
select is((select failed_at from pruebas.estado_de('sub_beto')), '2026-11-01 16:01Z'::timestamptz, 'un reintento que vuelve a fallar no la mueve');
select pruebas.aplica('evt_85_b5', pruebas.sus('sub_beto', pruebas.cuenta(2)::text, 'active', '2026-11-04 10:05-06'),
                      jsonb_build_array(pruebas.pago('ch_beto_2', '2026-11-04 10:00-06', '2026-11-01 10:00-06', '2026-12-01 10:00-06')));
select results_eq($$select status, period_end, failed_at from pruebas.estado_de('sub_beto')$$,
  $$values ('active', '2026-12-01 10:00-06'::timestamptz, null::timestamptz)$$,
  'el cobro de esa renovación avanza el periodo y limpia la falla');
select pruebas.aplica('evt_85_b6', pruebas.sus('sub_beto', pruebas.cuenta(2)::text, 'active', '2026-11-04 10:06-06'), '[]',
                      '{"invoice": "in_beto_3", "failed_at": "2026-12-01T16:01:00Z", "unpaid": false, "cycle": true}', 'invoice.payment_failed');
select is((select failed_at from pruebas.estado_de('sub_beto')), null, 'un aviso de falla que llega cuando la factura ya se pagó no la anota');
select pruebas.aplica('evt_85_b7', pruebas.sus('sub_beto', pruebas.cuenta(2)::text, 'active', '2026-11-04 10:07-06'), '[]',
                      '{"invoice": "in_beto_x", "failed_at": "2026-12-01T16:02:00Z", "unpaid": true, "cycle": false}', 'invoice.payment_failed');
select is((select failed_at from pruebas.estado_de('sub_beto')), null, 'una factura que no es de renovación no abre la gracia');
select pruebas.aplica('evt_85_b8', pruebas.sus('sub_beto', pruebas.cuenta(2)::text, 'active', '2026-11-04 10:08-06'),
                      jsonb_build_array(pruebas.pago('ch_beto_1', '2026-10-01 10:00-06', '2026-10-01 10:00-06', '2026-11-01 10:00-06')));
select is((select period_end from pruebas.estado_de('sub_beto')), '2026-12-01 10:00-06'::timestamptz, 'un cobro viejo que llega tarde no regresa el periodo');

-- Una cancelación inmediata en Stripe no corta los días pagados: `ended_at` es de T-304 y T-307.
select pruebas.aplica('evt_85_b9', pruebas.sus('sub_beto', pruebas.cuenta(2)::text, 'canceled', '2026-11-10 10:00-06', p_canceled => '2026-11-10 09:59-06'),
                      p_type => 'customer.subscription.deleted');
select results_eq($$select status, period_end, canceled_at, ended_at from pruebas.estado_de('sub_beto')$$,
  $$values ('canceled', '2026-12-01 10:00-06'::timestamptz, '2026-11-10 09:59-06'::timestamptz, null::timestamptz)$$,
  'cancelada, con su periodo pagado intacto');

-- ---------------------------------------------------------------------------------------
-- Lo que no se puede aplicar queda fallido, sin escribir nada.

select is(pruebas.aplica('evt_85_x1', pruebas.sus('sub_x1', null, 'active', '2026-10-02 10:00-06')) - 'subscription_id',
  '{"outcome": "failed", "code": "unknown_account"}'::jsonb, 'sin la cuenta en la metadata');
select is(pruebas.aplica('evt_85_x2', pruebas.sus('sub_x2', 'no-es-un-id', 'active', '2026-10-02 10:00-06')) ->> 'code', 'unknown_account',
  'ni con algo que no es un id');
select is(pruebas.aplica('evt_85_x3', pruebas.sus('sub_x3', gen_random_uuid()::text, 'active', '2026-10-02 10:00-06')) ->> 'code', 'unknown_account',
  'ni con una cuenta que no existe');
select is((select count(*)::integer from public.subscriptions where provider_subscription_id like 'sub_x%'), 0, 'nada de eso creó una fila');
select results_eq($$select status, last_error, finished_at is null, locked_until is null from pruebas.evento('evt_85_x1')$$,
  $$values ('failed', 'unknown_account', true, true)$$, 'el aviso queda fallido, a la vista de finanzas');
select is(pruebas.aplica('evt_85_x4', pruebas.sus('sub_caro', pruebas.cuenta(3)::text, 'active', '2026-10-02 10:00-06', p_currency => 'usd')) ->> 'code',
  'unsupported_currency', 'una suscripción que no es en pesos');
select is(pruebas.aplica('evt_85_x5', pruebas.sus('sub_caro', pruebas.cuenta(3)::text, 'active', '2026-10-02 10:00-06', p_interval => 'week')) ->> 'code',
  'unknown_plan', 'un plan que no es mes ni año');
select is(pruebas.aplica('evt_85_x6', pruebas.sus('sub_caro', pruebas.cuenta(3)::text, 'paused', '2026-10-02 10:00-06')) ->> 'code',
  'unknown_subscription_status', 'un estado que no se conoce');
select is(pruebas.aplica('evt_85_x7', '{"id": "sub_caro"}'::jsonb) ->> 'code', 'malformed_snapshot', 'una lectura sin forma');
select is(pruebas.aplica('evt_85_x8', pruebas.sus('sub_caro', pruebas.cuenta(3)::text, 'active', '2026-10-02 10:00-06'),
                         jsonb_build_array(pruebas.pago('ch_caro_1', '2020-03-10 10:00-06', '2020-03-10 10:00-06', '2020-04-10 10:00-06'))) ->> 'code',
  'charge_rule_unavailable', 'un cobro de un mes sin la regla de RN-02');
select is((select count(*)::integer from public.subscriptions where provider_subscription_id = 'sub_caro'), 0,
  'y con él no queda ni la fila que se había creado: todo o nada');
select is(pruebas.aplica('evt_85_x9', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'active', '2026-10-21 10:00-06'),
                         jsonb_build_array(pruebas.pago('ch_ana_1', '2026-10-01 10:00-06', '2026-10-01 10:00-06', '2026-11-01 10:00-06', 34901))) ->> 'code',
  'charge_conflict', 'el mismo cargo con otro monto');
select is(pruebas.aplica('evt_85_x10', pruebas.sus('sub_beto', pruebas.cuenta(1)::text, 'active', '2026-11-11 10:00-06')) ->> 'code', 'account_mismatch',
  'una suscripción que cambia de cuenta');
select is(pruebas.aplica('evt_85_x11', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'active', '2026-10-21 10:00-06'),
                         jsonb_build_array(pruebas.pago('ch_ana_9', '2026-10-21 10:00-06', '2026-10-21 10:00-06', '2026-11-21 10:00-06', p_interval => 'day'))) ->> 'code',
  'unknown_plan', 'un pago con un plan que no se conoce');
select is(pruebas.cobros(pruebas.cuenta(1)), 1, 'y ninguno de esos dejó un cobro de más');

-- Una segunda suscripción viva de la misma cuenta (pagó dos veces, en dos pestañas).
select pruebas.aplica('evt_85_d1', pruebas.sus('sub_dani_1', pruebas.cuenta(4)::text, 'active', '2026-10-05 10:00-06'),
                      jsonb_build_array(pruebas.pago('ch_dani_1', '2026-10-05 10:00-06', '2026-10-05 10:00-06', '2026-11-05 10:00-06')));
select is(pruebas.aplica('evt_85_d2', pruebas.sus('sub_dani_2', pruebas.cuenta(4)::text, 'active', '2026-10-05 10:01-06'),
                         jsonb_build_array(pruebas.pago('ch_dani_2', '2026-10-05 10:01-06', '2026-10-05 10:01-06', '2030-11-05 10:01-06'))),
  '{"outcome": "retry", "code": "second_live_subscription"}'::jsonb,
  'la segunda vuelve a la fila: puede ser el orden de los avisos (la baja de la otra no ha llegado)');
select results_eq($$select status, last_error, profile_id from pruebas.evento('evt_85_d2')$$,
  format($$values ('pending', 'second_live_subscription', %L::uuid)$$, pruebas.cuenta(4)), 'pendiente, con su código y su cuenta');
select is(pruebas.cobros(pruebas.cuenta(4)), 2, 'su cobro sí entra: el dinero entró (decisión de Sergio del 2026-11-06)');
select is(pruebas.recibos(pruebas.cuenta(4)), 2, 'con su recibo');
select results_eq($$select status, period_end from pruebas.estado_de('sub_dani_2')$$, $$values ('pending', '2030-11-05 10:01-06'::timestamptz)$$,
  'y ella queda sin dar acceso, con su periodo pagado');
select is((select status from pruebas.estado_de('sub_dani_1')), 'active', 'la otra sigue viva');
select pruebas.intentos('evt_85_d2', 3);
select is(pruebas.reaplica('evt_85_d2', pruebas.sus('sub_dani_2', pruebas.cuenta(4)::text, 'active', '2026-10-05 11:00-06'),
                           jsonb_build_array(pruebas.pago('ch_dani_2', '2026-10-05 10:01-06', '2026-10-05 10:01-06', '2030-11-05 10:01-06'))) ->> 'outcome',
  'retry', 'al cuarto intento todavía vuelve a la fila');
select pruebas.intentos('evt_85_d2', 4);
select is(pruebas.reaplica('evt_85_d2', pruebas.sus('sub_dani_2', pruebas.cuenta(4)::text, 'active', '2026-10-05 12:00-06'),
                           jsonb_build_array(pruebas.pago('ch_dani_2', '2026-10-05 10:01-06', '2026-10-05 10:01-06', '2030-11-05 10:01-06'))),
  '{"outcome": "failed", "code": "second_live_subscription"}'::jsonb, 'al quinto intento queda fallida, para resolverla a mano (decisión 6 de Sergio)');
select is(pruebas.cobros(pruebas.cuenta(4)), 2, 'sin cobro de más');
select is(pruebas.recibos(pruebas.cuenta(4)), 2, 'ni recibo de más');
-- La otra se da de baja: la segunda se vuelve la viva sola, y su aviso vuelve a la fila.
select pruebas.aplica('evt_85_d5', pruebas.sus('sub_dani_1', pruebas.cuenta(4)::text, 'canceled', '2026-10-06 10:00-06', p_canceled => '2026-10-06 09:59-06'),
                      p_type => 'customer.subscription.deleted');
select results_eq($$select s.provider_subscription_id, s.status::text from public.subscriptions s where s.profile_id = pruebas.cuenta(4) order by 1$$,
  $$values ('sub_dani_1', 'canceled'), ('sub_dani_2', 'active')$$, 'al darse de baja la otra, la segunda se vuelve la viva sin esperar a otro aviso');
select results_eq($$select status, attempts from pruebas.evento('evt_85_d2')$$, $$values ('pending', 0)$$,
  'y su aviso fallido vuelve a la fila, con sus intentos desde cero');
select is(pruebas.reaplica('evt_85_d2', pruebas.sus('sub_dani_2', pruebas.cuenta(4)::text, 'active', '2026-10-06 10:01-06'),
                           jsonb_build_array(pruebas.pago('ch_dani_2', '2026-10-05 10:01-06', '2026-10-05 10:01-06', '2030-11-05 10:01-06'))) ->> 'outcome',
  'processed', 'al aplicarse, queda procesado');
select is((select status from pruebas.estado_de('sub_dani_2')), 'active', 'y la segunda sigue siendo la viva');
select is(pruebas.cobros(pruebas.cuenta(4)), 2, 'sin cobro de más');

-- La falla dentro del día de holgura se queda aunque llegue otro aviso sin cobro.
select pruebas.aplica('evt_85_d3', pruebas.sus('sub_dani_2', pruebas.cuenta(4)::text, 'past_due', '2026-11-05 09:30-06'), '[]',
                      '{"invoice": "in_dani_3", "failed_at": "2030-11-05T15:00:00Z", "unpaid": true, "cycle": true}', 'invoice.payment_failed');
select is((select failed_at from pruebas.estado_de('sub_dani_2')), '2030-11-05 15:00Z'::timestamptz,
  'una falla una hora antes del fin del periodo pagado se anota (el día de holgura)');
select pruebas.aplica('evt_85_d4', pruebas.sus('sub_dani_2', pruebas.cuenta(4)::text, 'past_due', '2026-11-05 10:00-06'), p_type => 'customer.subscription.updated');
select is((select failed_at from pruebas.estado_de('sub_dani_2')), '2030-11-05 15:00Z'::timestamptz,
  'y otro aviso sin cobro no la borra');

-- Lo que viene de otro lado no se aplica.
select is(pruebas.aplica('evt_85_x12', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'active', '2026-10-22 10:00-06'), p_type => 'customer.created') ->> 'code',
  'wrong_event_type', 'un aviso que no es de cobro no se aplica');
select is(pruebas.aplica('evt_85_x13', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'active', '2026-10-22 10:00-06'), p_type => 'customer.subscription.updated',
                         p_object => 'sub_otra') ->> 'code', 'object_mismatch', 'ni la lectura de otra suscripción que la del aviso');
select is(pruebas.aplica('evt_85_x14', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'active', '2026-10-22 10:00-06'),
                         jsonb_build_array(pruebas.pago('ch_ana_7', '2026-10-22 10:00-06', '2026-10-22 10:00-06', '2026-11-22 10:00-06')
                                           || '{"subscription": "sub_otra"}'::jsonb)) ->> 'code', 'object_mismatch',
  'ni un pago de otra suscripción');
select is(pruebas.cobros(pruebas.cuenta(1)), 1, 'sin cobro de más');

select is(pruebas.aplica('evt_85_x15', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'active', '2026-10-22 10:00-06'),
                         jsonb_build_array(pruebas.pago('ch_ana_8', '2026-10-22 10:00-06', '2026-10-22 10:00-06', '2026-11-22 10:00-06')
                                           || '{"status": "failed"}'::jsonb)) ->> 'code', 'charge_not_succeeded',
  'ni un cargo que no se cobró');
select is((pruebas.evento('evt_85_x15')).profile_id, pruebas.cuenta(1), 'el aviso fallido sabe de qué cuenta es');
select is((pruebas.evento('evt_85_x4')).profile_id, pruebas.cuenta(3), 'también si falló antes de abrir la suscripción');
select is(pruebas.aplica('evt_85_x16', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'active', '2026-10-22 10:00-06'), p_type => 'charge.refunded',
                         p_object => 'ch_ana_1') ->> 'outcome', 'deferred', 'un reembolso que llega a aplicarse espera a T-307');
select results_eq($$select status, last_error from pruebas.evento('evt_85_x16')$$, $$values ('deferred', 'waits_t307')$$, 'en espera');

-- Un error que no se conoce se relanza: el aviso sigue en proceso y vuelve a tomarse al vencer su reclamo.
create function pruebas.lanza() returns trigger language plpgsql as $$
begin
  if new.provider_subscription_id = 'sub_lanza' then
    raise exception 'otra cosa' using errcode = 'P0001';
  end if;
  if new.provider_subscription_id = 'sub_choca' then
    raise exception 'otro choque' using errcode = '23505', constraint = 'otra_restriccion';
  end if;
  return new;
end
$$;
create trigger zz_lanza before insert on public.subscriptions for each row execute function pruebas.lanza();
select throws_ok($$select pruebas.aplica('evt_85_r1', pruebas.sus('sub_lanza', pruebas.cuenta(7)::text, 'active', '2026-10-22 10:00-06'))$$, 'P0001', 'otra cosa',
  'un P0001 que no es de la regla de RN-02 se relanza');
select throws_ok($$select pruebas.aplica('evt_85_r2', pruebas.sus('sub_choca', pruebas.cuenta(7)::text, 'active', '2026-10-22 10:00-06'))$$, '23505', 'otro choque',
  'y otro choque de unicidad también');
drop trigger zz_lanza on public.subscriptions;

-- La misma transacción de saldo con otro cargo no detiene el cobro.
select is(pruebas.aplica('evt_85_t1', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'active', '2026-10-23 10:00-06'),
                         jsonb_build_array(pruebas.pago('ch_ana_10', '2026-10-23 10:00-06', '2026-10-23 10:00-06', '2026-11-23 10:00-06', p_bt => 'txn_ana_1')))
          ->> 'outcome', 'processed', 'una transacción de saldo que ya tenía otro cobro no lo detiene');
select is((select count(*)::integer from private.provider_settlements where balance_transaction_id = 'txn_ana_1'), 1, 'ni se guarda dos veces');

-- La falla de renovación, en sus bordes.
select pruebas.aplica('evt_85_h1', pruebas.sus('sub_hugo', pruebas.cuenta(7)::text, 'active', '2026-10-24 10:00-06'), p_type => 'customer.subscription.created');
select pruebas.aplica('evt_85_h2', pruebas.sus('sub_hugo', pruebas.cuenta(7)::text, 'past_due', '2026-10-25 10:00-06'), '[]',
                      '{"invoice": "in_hugo_1", "failed_at": "2026-10-25T16:00:00Z", "unpaid": true, "cycle": true}', 'invoice.payment_failed');
select is((select failed_at from pruebas.estado_de('sub_hugo')), null, 'sin un periodo pagado antes, no hay renovación que falle');
select pruebas.aplica('evt_85_h3', pruebas.sus('sub_hugo', pruebas.cuenta(7)::text, 'active', '2026-10-26 10:00-06'),
                      jsonb_build_array(pruebas.pago('ch_hugo_1', '2026-10-26 10:00-06', '2026-10-26 10:00-06', '2026-11-26 10:00-06')));
select pruebas.aplica('evt_85_h4', pruebas.sus('sub_hugo', pruebas.cuenta(7)::text, 'past_due', '2026-10-27 10:00-06'), '[]',
                      '{"invoice": "in_hugo_2", "failed_at": "2026-11-24T16:00:00Z", "unpaid": true, "cycle": true}', 'invoice.payment_failed');
select is((select failed_at from pruebas.estado_de('sub_hugo')), null, 'una falla de más de un día antes del fin del periodo pagado no es la renovación');
select pruebas.aplica('evt_85_h5', pruebas.sus('sub_hugo', pruebas.cuenta(7)::text, 'past_due', '2026-10-28 10:00-06'), '[]',
                      '{"invoice": "in_hugo_3", "failed_at": "2026-11-26T18:00:00Z", "unpaid": true, "cycle": true}', 'invoice.payment_failed');
select is((select failed_at from pruebas.estado_de('sub_hugo')), '2026-11-26 18:00Z'::timestamptz, 'una falla después del fin sí');
select pruebas.aplica('evt_85_h6', pruebas.sus('sub_hugo', pruebas.cuenta(7)::text, 'past_due', '2026-10-29 10:00-06'),
                      jsonb_build_array(pruebas.pago('ch_hugo_2', '2026-10-29 10:00-06', '2026-11-26 16:00Z', '2026-11-26 17:00Z')));
select is((select failed_at from pruebas.estado_de('sub_hugo')), '2026-11-26 18:00Z'::timestamptz,
  'un cobro que avanza el periodo, pero no más allá de la falla, no la limpia');

-- Los hechos de la cuenta eligen la más reciente por su inicio en Stripe (las dos filas nacen en la misma transacción).
select pruebas.aplica('evt_85_g1', pruebas.sus('sub_gabi_2', pruebas.cuenta(6)::text, 'canceled', '2026-10-29 10:00-06', p_started => '2026-10-10 10:00-06'),
                      jsonb_build_array(pruebas.pago('ch_gabi_2', '2026-10-10 10:00-06', '2026-10-10 10:00-06', '2026-11-10 10:00-06')));
select pruebas.aplica('evt_85_g2', pruebas.sus('sub_gabi_1', pruebas.cuenta(6)::text, 'canceled', '2026-10-29 10:00-06', p_started => '2026-10-01 10:00-06'),
                      jsonb_build_array(pruebas.pago('ch_gabi_1', '2026-10-01 10:00-06', '2026-10-01 10:00-06', '2026-11-01 10:00-06')));
-- La que empezó antes en Stripe queda con la fila más nueva: con el orden por la fila, la elegiría a ella.
update public.subscriptions set created_at = now() + interval '1 second' where provider_subscription_id = 'sub_gabi_1';
select pruebas.como_servicio(pruebas.cuenta(6));
select is((private.media_facts(null) -> 'subscription' ->> 'paid_through')::timestamptz, '2026-11-10 10:00-06'::timestamptz,
  'el acceso sale de la que empezó después en Stripe');
select pruebas.como_dueno();

-- (la falla de otra suscripción)
select is(pruebas.aplica('evt_85_x17', pruebas.sus('sub_ana', pruebas.cuenta(1)::text, 'past_due', '2026-10-22 10:00-06'), '[]',
                         '{"subscription": "sub_otra", "invoice": "in_ana_x", "failed_at": "2026-11-01T17:00:00Z", "unpaid": true, "cycle": true}',
                         'invoice.payment_failed') ->> 'code', 'object_mismatch', 'ni la falla de otra suscripción');

-- Sin correo, el cobro entra igual y no hay recibo.
select is(pruebas.aplica('evt_85_e1', pruebas.sus('sub_eli', pruebas.cuenta(5)::text, 'active', '2026-10-20 10:00-06'),
                         jsonb_build_array(pruebas.pago('ch_eli_1', '2026-10-20 10:00-06', '2026-10-20 10:00-06', '2026-11-20 10:00-06'))) ->> 'outcome',
  'processed', 'una cuenta sin correo');
select is(pruebas.cobros(pruebas.cuenta(5)), 1, 'registra su cobro');
select is(pruebas.recibos(pruebas.cuenta(5)), 0, 'sin recibo, porque no hay a quién');

-- Un intento que ya no es el de ahora no escribe.
select pruebas.como_sistema();
select is(private.billing_apply((private.provider_event_receive('stripe', 'evt_85_s1', 'invoice.paid', false, null, 'sub_s1', now() - interval '1 minute') ->> 'id')::uuid,
                                1, pruebas.sus('sub_s1', pruebas.cuenta(3)::text, 'active', now()), '[]', null) ->> 'outcome', 'stale',
  'un aviso sin reclamar no se aplica');
select is(private.provider_event_claim((pruebas.evento('evt_85_s1')).id) ->> 'attempt', '1', '(se reclama)');
select is(private.billing_apply((pruebas.evento('evt_85_s1')).id, 2, pruebas.sus('sub_s1', pruebas.cuenta(3)::text, 'active', now()), '[]', null) ->> 'outcome',
  'stale', 'ni con un intento que no es el de ahora');
select pruebas.como_dueno();
select is((select status from pruebas.evento('evt_85_s1')), 'processing', 'y sigue en proceso, con su intento');
select is((select count(*)::integer from public.subscriptions where provider_subscription_id = 'sub_s1'), 0, 'sin escribir nada');
select pruebas.como_sistema();
select throws_ok($$select private.billing_apply(gen_random_uuid(), 1, '{}'::jsonb, '{}'::jsonb, null)$$, '22023', null, 'los pagos van en un arreglo');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- Un anual: doce partes, el periodo pagado de un año.

select pruebas.aplica('evt_85_c1', pruebas.sus('sub_caro', pruebas.cuenta(3)::text, 'active', '2026-10-10 10:00-06', p_interval => 'year'),
                      jsonb_build_array(pruebas.pago('ch_caro_2', '2026-10-10 10:00-06', '2026-10-10 10:00-06', '2027-10-10 10:00-06', 299000, 'year')));
select results_eq($$select status, period_end from pruebas.estado_de('sub_caro')$$, $$values ('active', '2027-10-10 10:00-06'::timestamptz)$$,
  'pagada por un año');
select results_eq($$select c.plan::text, count(a.id)::integer, sum(a.base_cents)::bigint from public.charges c join public.revenue_allocations a on a.charge_id = c.id
                    where c.provider_charge_id = 'ch_caro_2' group by c.plan$$,
  $$values ('annual', 12, 244871::bigint)$$, 'con las doce partes de RN-02');
-- Una factura con dos pagos: dos cobros, el periodo una sola vez.
select pruebas.aplica('evt_85_c2', pruebas.sus('sub_caro', pruebas.cuenta(3)::text, 'active', '2026-10-11 10:00-06', p_interval => 'year'),
                      jsonb_build_array(pruebas.pago('ch_caro_3', '2026-10-11 10:00-06', '2027-10-10 10:00-06', '2028-10-10 10:00-06', 100000, 'year'),
                                        pruebas.pago('ch_caro_4', '2026-10-11 10:01-06', '2027-10-10 10:00-06', '2028-10-10 10:00-06', 199000, 'year')));
select is(pruebas.cobros(pruebas.cuenta(3)), 3, 'los dos pagos de una factura son dos cobros');
select is((select period_end from pruebas.estado_de('sub_caro')), '2028-10-10 10:00-06'::timestamptz, 'y el periodo avanza una vez');
select is(pruebas.recibos(pruebas.cuenta(3)), 3, 'un recibo por cobro');
-- Una liquidación que no cuadra (el neto no es el bruto menos la comisión) no se guarda, y el cobro entra igual.
select is(pruebas.aplica('evt_85_c3', pruebas.sus('sub_caro', pruebas.cuenta(3)::text, 'active', '2026-10-12 10:00-06', p_interval => 'year'),
                         jsonb_build_array(pruebas.pago('ch_caro_5', '2026-10-12 10:00-06', '2027-10-10 10:00-06', '2028-10-10 10:00-06', 299000, 'year', 'txn_caro_5')
                                           || '{"net_cents": 1}'::jsonb)) ->> 'outcome', 'processed', 'una liquidación que no cuadra no detiene el cobro');
select is((select count(*)::integer from private.provider_settlements s join public.charges c on c.id = s.charge_id where c.provider_charge_id = 'ch_caro_5'), 0,
  'y no se guarda');

-- ---------------------------------------------------------------------------------------
-- Los alumnos activos y la foto del mes esperan a los avisos (RN-13).

-- La fila de una suscripción nace al procesar el aviso (hoy, en esta transacción), después del instante que se cuenta: cuenta su inicio en Stripe.
select is(private.active_students_at('2026-10-15 12:00-06') - (select n from activos0), 7,
  'cuentan las que empezaron en Stripe antes del instante, aunque su fila sea de hoy');
select is((select count(*)::integer from public.subscriptions s where s.profile_id in (pruebas.cuenta(1), pruebas.cuenta(2), pruebas.cuenta(3))
           and coalesce(s.provider_started_at, s.created_at) <= '2026-10-15 12:00-06' and s.created_at > '2026-10-15 12:00-06'), 3,
  '(las tres tienen la fila de después)');

-- Un mes que ya terminó, con un aviso sin terminar de antes de su fin: su foto espera.
select pruebas.como_dueno_sistema();
select private.open_period(202304);
select pruebas.como_dueno();
select pruebas.como_sistema();
select private.provider_event_receive('stripe', 'evt_85_f1', 'invoice.paid', false, null, 'in_f1', '2023-04-30 23:58-06');
select pruebas.como_dueno();
select ok(not coalesce(private.period_photos() -> 'taken' @> '[202304]', false), 'con un aviso pendiente de antes del fin del mes, la foto espera');
select is((select active_students from public.payout_periods where period_id = 202304), null, 'y el mes sigue sin ella');
select pruebas.como_sistema();
select private.provider_event_claim((pruebas.evento('evt_85_f1')).id);
select private.provider_event_finish((pruebas.evento('evt_85_f1')).id, 1, 'failed', 'unknown_account');
select private.provider_event_receive('stripe', 'evt_85_f2', 'charge.refunded', false, null, 'ch_f2', '2023-04-29 12:00-06');
select private.provider_event_claim((pruebas.evento('evt_85_f2')).id);
select private.provider_event_finish((pruebas.evento('evt_85_f2')).id, 1, 'deferred', 'refund_waits_t307');
select private.provider_event_receive('stripe', 'evt_85_f3', 'invoice.paid', false, null, 'in_f3', '2023-05-01 00:05-06');
select pruebas.como_dueno();
select ok(not coalesce(private.period_photos() -> 'taken' @> '[202304]', false),
  'un aviso pendiente de los diez minutos después del fin también la espera (Stripe crea el evento poco después del cobro)');
select pruebas.como_sistema();
select private.provider_event_claim((pruebas.evento('evt_85_f3')).id);
select private.provider_event_finish((pruebas.evento('evt_85_f3')).id, 1, 'failed', 'zero_invoice');
select private.provider_event_receive('stripe', 'evt_85_f4', 'invoice.paid', false, null, 'in_f4', '2023-05-01 00:15-06');
select pruebas.como_dueno();
select ok(private.period_photos() -> 'taken' @> '[202304]',
  'con lo de antes del fin ya terminado, aunque fallido o en espera de T-307, se toma: eso lo frena el cierre, no la foto; y lo de quince minutos después no la espera');

-- La promoción, en sus bordes: solo la que quedó sin dar acceso por una segunda viva, con su periodo pagado vigente y hasta por lo menos donde llegaba la otra; la de
-- inicio más reciente; y solo sus avisos.
select pruebas.alta('a8500000-0000-0000-0000-000000000008', 'ines-85@prueba.test');
insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, provider_status, currency, current_period_start, current_period_end,
                                  provider_started_at, provider_state_at) values
  (pruebas.cuenta(8), 'stripe', 'sub_i_viva', 'monthly', 'active', 'active', 'MXN', '2026-10-01 10:00-06', '2030-01-01 10:00-06', '2026-10-01 10:00-06', '2026-10-01 10:00-06'),
  (pruebas.cuenta(8), 'stripe', 'sub_i_vieja', 'monthly', 'pending', 'active', 'MXN', '2026-10-02 10:00-06', '2030-06-01 10:00-06', '2026-10-02 10:00-06', '2026-10-02 10:00-06'),
  (pruebas.cuenta(8), 'stripe', 'sub_i_nueva', 'monthly', 'pending', 'active', 'MXN', '2026-10-03 10:00-06', '2030-06-01 10:00-06', '2026-10-03 10:00-06', '2026-10-03 10:00-06'),
  (pruebas.cuenta(8), 'stripe', 'sub_i_cancelada', 'monthly', 'pending', 'canceled', 'MXN', '2026-10-04 10:00-06', '2031-06-01 10:00-06', '2026-10-04 10:00-06', '2026-10-04 10:00-06'),
  (pruebas.cuenta(8), 'stripe', 'sub_i_vencida', 'monthly', 'pending', 'active', 'MXN', '2026-10-05 10:00-06', '2026-10-20 10:00-06', '2026-10-05 10:00-06', '2026-10-05 10:00-06'),
  (pruebas.cuenta(8), 'stripe', 'sub_i_corta', 'monthly', 'pending', 'active', 'MXN', '2026-10-06 10:00-06', '2029-06-01 10:00-06', '2026-10-06 10:00-06', '2026-10-06 10:00-06');
insert into private.provider_events (provider, provider_event_id, event_type, livemode, object_id, occurred_at, status, attempts, last_error, profile_id) values
  ('stripe', 'evt_85_i_nueva', 'invoice.paid', false, 'sub_i_nueva', '2026-10-03 10:00-06', 'failed', 5, 'second_live_subscription', pruebas.cuenta(8)),
  ('stripe', 'evt_85_i_vieja', 'invoice.paid', false, 'sub_i_vieja', '2026-10-02 10:00-06', 'failed', 5, 'second_live_subscription', pruebas.cuenta(8)),
  ('stripe', 'evt_85_i_otro_error', 'invoice.paid', false, 'sub_i_nueva', '2026-10-03 10:00-06', 'failed', 1, 'unknown_plan', pruebas.cuenta(8)),
  ('stripe', 'evt_85_i_otra_cuenta', 'invoice.paid', false, 'sub_i_nueva', '2026-10-03 10:00-06', 'failed', 5, 'second_live_subscription', pruebas.cuenta(7));
select pruebas.aplica('evt_85_i1', pruebas.sus('sub_i_viva', pruebas.cuenta(8)::text, 'canceled', '2026-10-10 10:00-06', p_canceled => '2026-10-10 09:59-06'),
                      p_type => 'customer.subscription.deleted');
select results_eq($$select provider_subscription_id, status::text from public.subscriptions where profile_id = pruebas.cuenta(8) order by 1$$,
  $$values ('sub_i_cancelada', 'pending'), ('sub_i_corta', 'pending'), ('sub_i_nueva', 'active'), ('sub_i_vencida', 'pending'), ('sub_i_vieja', 'pending'),
           ('sub_i_viva', 'canceled')$$,
  'se vuelve viva la de inicio más reciente con periodo vigente: no la que Stripe dio por cancelada, ni la vencida, ni la que no llega hasta donde llegaba la otra');
select results_eq($$select provider_event_id, status, attempts from private.provider_events where provider_event_id like 'evt_85_i_%' and provider_event_id <> 'evt_85_i1' order by 1$$,
  $$values ('evt_85_i_nueva', 'pending', 0), ('evt_85_i_otra_cuenta', 'failed', 5), ('evt_85_i_otro_error', 'failed', 1), ('evt_85_i_vieja', 'failed', 5)$$,
  'y solo vuelven a la fila los avisos de la que se promovió que esperaban por eso');

-- Una vencida no se promueve, aunque llegue más lejos que la que se cancela.
select pruebas.alta('a8500000-0000-0000-0000-000000000009', 'juan-85@prueba.test');
insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, provider_status, currency, current_period_start, current_period_end,
                                  provider_started_at, provider_state_at) values
  (pruebas.cuenta(9), 'stripe', 'sub_j_viva', 'monthly', 'active', 'active', 'MXN', '2026-09-01 10:00-06', '2026-10-01 10:00-06', '2026-09-01 10:00-06', '2026-09-01 10:00-06'),
  (pruebas.cuenta(9), 'stripe', 'sub_j_vencida', 'monthly', 'pending', 'active', 'MXN', '2026-09-02 10:00-06', '2026-10-20 10:00-06', '2026-09-02 10:00-06', '2026-09-02 10:00-06');
select pruebas.aplica('evt_85_j1', pruebas.sus('sub_j_viva', pruebas.cuenta(9)::text, 'canceled', '2026-10-10 10:00-06'), p_type => 'customer.subscription.deleted');
select is((select status::text from public.subscriptions where provider_subscription_id = 'sub_j_vencida'), 'pending',
  'una que ya venció no se vuelve la viva, aunque su periodo llegue más lejos que el de la otra');

select is_empty('select * from private.schema_violations_billing()', 'el área de los avisos sigue en orden');
select is_empty('select * from private.schema_violations_periods()', 'y la de los periodos');

select * from finish();
rollback;
