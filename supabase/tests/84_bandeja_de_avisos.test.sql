-- T-303, primera solicitud · La bandeja de los avisos del proveedor de cobro (RF-208, RF-710; plan aprobado por Sergio el 2026-11-06). Un aviso se guarda una
-- sola vez por su id, sin su cuerpo: procesar lee el estado de ahora en Stripe. Se reclama por 2 minutos y por intentos; lo que falla de paso vuelve a la fila con su
-- espera, y lo que no se puede aplicar queda fallido a la vista hasta que finanzas lo reintente o lo resuelva a mano, con nota (decisión 6 de Sergio). La aplicación no
-- toca la tabla: entra por sus funciones. Lo que el aviso aplica lo prueba la 85.
begin;
\ir _ayuda.psql
select plan(125);

select pruebas.alta('a8400000-0000-0000-0000-000000000001', 'f1-84@prueba.test');
select pruebas.alta('a8400000-0000-0000-0000-000000000002', 'ana-84@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-84@prueba.test';
select pruebas.dar_capacidad('a8400000-0000-0000-0000-000000000001', 'finance');
select pruebas.equipar('a8400000-0000-0000-0000-000000000001');

create function pruebas.f1() returns uuid language sql immutable as $$ select 'a8400000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.ana() returns uuid language sql immutable as $$ select 'a8400000-0000-0000-0000-000000000002'::uuid $$;
-- Como el servidor sin persona (así corre la ruta del aviso y el barrido).
create function pruebas.recibe(p_event text, p_type text default 'invoice.paid', p_object text default 'in_84', p_at timestamptz default now() - interval '1 minute',
                               p_livemode boolean default false) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_sistema();
  v := private.provider_event_receive('stripe', p_event, p_type, p_livemode, '2025-10-29.clover', p_object, p_at);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.reclama(p_id uuid) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_sistema();
  v := private.provider_event_claim(p_id);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.vencidos(p_limit integer default 20) returns setof jsonb language plpgsql as $$
begin
  perform pruebas.como_sistema();
  return query select to_jsonb(c) from private.provider_event_claim_due(p_limit) c;
  perform pruebas.limpiar();
end
$$;
create function pruebas.suelta(p_id uuid, p_attempt integer, p_code text default 'provider_unavailable') returns boolean language plpgsql as $$
declare
  v boolean;
begin
  perform pruebas.como_sistema();
  v := private.provider_event_release(p_id, p_attempt, p_code);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.termina(p_id uuid, p_attempt integer, p_status text, p_code text default null) returns boolean language plpgsql as $$
declare
  v boolean;
begin
  perform pruebas.como_sistema();
  v := private.provider_event_finish(p_id, p_attempt, p_status, p_code);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.aviso(p_event text) returns private.provider_events language sql security definer
as $$ select e from private.provider_events e where e.provider = 'stripe' and e.provider_event_id = p_event $$;
create function pruebas.id_de(p_event text) returns uuid language sql as $$ select (pruebas.aviso(p_event)).id $$;
-- Lo pone como si el reclamo hubiera vencido o tocara ya, sin el guardián (las horas no se escriben a mano).
create function pruebas.vence(p_event text) returns void language plpgsql security definer as $$
begin
  set local session_replication_role = replica;
  update private.provider_events set next_attempt_at = now() - interval '1 second',
         locked_until = case when status = 'processing' then now() - interval '1 second' end
  where provider_event_id = p_event;
  set local session_replication_role = origin;
end
$$;
create function pruebas.intentos(p_event text, p_attempts integer) returns void language plpgsql security definer as $$
begin
  set local session_replication_role = replica;
  update private.provider_events set attempts = p_attempts where provider_event_id = p_event;
  set local session_replication_role = origin;
end
$$;
create function pruebas.rev(p_event text) returns integer language sql as $$ select (pruebas.aviso(p_event)).revision $$;
create function pruebas.de_cuenta(p_event text, p_profile uuid) returns void language plpgsql security definer as $$
begin
  set local session_replication_role = replica;
  update private.provider_events set profile_id = p_profile where provider_event_id = p_event;
  set local session_replication_role = origin;
end
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;
-- Lo que ya hubiera en la bandeja: las cuentas de la salud se miden contra esto.
create temp table salud0 as select private.provider_events_health() as h;

-- ---------------------------------------------------------------------------------------
-- Las tablas: nadie de la aplicación las toca.

select has_table('private', 'provider_events', 'la bandeja de los avisos');
select has_table('private', 'provider_event_actions', 'lo que finanzas hizo con un aviso');
select has_table('private', 'provider_settlements', 'el libro de lo que liquida el proveedor');
select hasnt_column('private', 'provider_events', 'raw_body', 'sin el cuerpo del aviso: procesar lee el estado de ahora');
select col_is_unique('private', 'provider_events', array['provider', 'provider_event_id'], 'un aviso se guarda una vez por su id');
select ok((select bool_and(c.relrowsecurity) from pg_class c
           where c.oid in ('private.provider_events'::regclass, 'private.provider_event_actions'::regclass, 'private.provider_settlements'::regclass)),
  'las tres con seguridad por fila');
select pruebas.como_servicio(pruebas.f1());
select throws_ok('select 1 from private.provider_events', '42501', null, 'el servidor no lee la bandeja de frente');
select throws_ok('select 1 from private.provider_settlements', '42501', null, 'ni las liquidaciones');
select pruebas.como_usuario(pruebas.ana());
select throws_ok($$select private.provider_event_receive('stripe', 'evt_x', 'invoice.paid', false, null, 'in_x', now())$$, '42501', null,
  'una persona no deja avisos');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- Guardar: una vez por su id.

select is(pruebas.recibe('evt_84_1') ->> 'outcome', 'stored', 'el aviso se guarda');
select results_eq($$select status, attempts, last_error is null, finished_at is null, locked_until is null from pruebas.aviso('evt_84_1')$$,
  $$values ('pending', 0, true, true, true)$$, 'nace pendiente, sin intentos');
select is(pruebas.recibe('evt_84_1') - 'id', '{"outcome": "duplicate", "status": "pending"}'::jsonb,
  'el mismo id otra vez es un repetido, y dice cómo va');
select is((pruebas.recibe('evt_84_1') ->> 'id')::uuid, pruebas.id_de('evt_84_1'), 'con el id del que ya estaba');
select is(pruebas.recibe('evt_84_1', 'customer.subscription.updated') ->> 'outcome', 'conflict',
  'el mismo id con otro tipo no se mezcla');
select is(pruebas.recibe('evt_84_1', p_object => 'in_otro') ->> 'outcome', 'conflict', 'ni con otro objeto');
select is(pruebas.recibe('evt_84_1', p_livemode => true) ->> 'outcome', 'conflict', 'ni con otro modo');
select is((select count(*)::integer from private.provider_events where provider_event_id = 'evt_84_1'), 1, 'sigue habiendo uno');
select is(pruebas.recibe('evt con espacio') ->> 'outcome', 'malformed', 'un id con espacios no es de Stripe');
select is(pruebas.recibe('evt_84_m', 'Invoice Paid') ->> 'outcome', 'malformed', 'ni un tipo que no tiene forma');
select is(pruebas.recibe('evt_84_m', p_object => '') ->> 'outcome', 'malformed', 'ni un objeto vacío');
select is(pruebas.recibe('evt_84_m', p_at => now() + interval '1 hour') ->> 'outcome', 'malformed', 'ni un aviso del futuro');
select is(pruebas.recibe('evt_84_m', p_at => '2019-12-31 12:00Z') ->> 'outcome', 'malformed', 'ni uno de antes de 2020');
select pruebas.como_sistema();
select is(private.provider_event_receive('mercadopago', 'evt_84_m', 'invoice.paid', false, null, 'in_84', now()) ->> 'outcome', 'malformed',
  'solo Stripe, por ahora');
select is(private.provider_event_receive('stripe', 'evt_84_m', 'invoice.paid', null, null, 'in_84', now()) ->> 'outcome', 'malformed',
  'el modo no se adivina');
select pruebas.como_dueno();
select is((select count(*)::integer from private.provider_events where provider_event_id = 'evt_84_m'), 0, 'nada de eso se guardó');

-- ---------------------------------------------------------------------------------------
-- Reclamar uno: por 2 minutos, y solo uno a la vez.

select is(pruebas.reclama(pruebas.id_de('evt_84_1')) - 'id' - 'occurred_at',
  '{"outcome": "claimed", "attempt": 1, "event_type": "invoice.paid", "object_id": "in_84"}'::jsonb,
  'se reclama con su primer intento, su tipo y su objeto');
select results_eq($$select status, attempts, locked_until between now() + interval '119 seconds' and clock_timestamp() + interval '121 seconds'
                    from pruebas.aviso('evt_84_1')$$,
  $$values ('processing', 1, true)$$, 'queda en proceso, apartado por 2 minutos');
select is(pruebas.reclama(pruebas.id_de('evt_84_1')) ->> 'outcome', 'busy', 'otro no lo toma mientras está apartado');
select is(pruebas.reclama(gen_random_uuid()) ->> 'outcome', 'not_found', 'uno que no existe');

-- Falla de paso: vuelve a la fila con su espera, y solo si es el intento en curso.
select ok(not pruebas.suelta(pruebas.id_de('evt_84_1'), 2), 'un intento que no es el de ahora no lo suelta');
select ok(pruebas.suelta(pruebas.id_de('evt_84_1'), 1), 'el intento en curso sí');
select results_eq($$select status, attempts, locked_until is null, last_error,
                           next_attempt_at between now() + interval '59 seconds' and clock_timestamp() + interval '61 seconds'
                    from pruebas.aviso('evt_84_1')$$,
  $$values ('pending', 1, true, 'provider_unavailable', true)$$, 'vuelve pendiente, con el código, y espera un minuto');
select ok(not pruebas.suelta(pruebas.id_de('evt_84_1'), 1), 'soltarlo dos veces no hace nada');
select is((select count(*)::integer from pruebas.vencidos() v where v ->> 'id' = pruebas.id_de('evt_84_1')::text), 0,
  'el barrido no lo toma antes de su espera');
-- Un reenvío de Stripe sí lo intenta ya: reclamar por id no mira la espera.
select results_eq(format($$select x ->> 'attempt', (x ->> 'occurred_at')::timestamptz = %L from (select pruebas.reclama(%L) as x) r$$,
                         (pruebas.aviso('evt_84_1')).occurred_at, pruebas.id_de('evt_84_1')),
  $$values ('2', true)$$, 'el reenvío lo reclama otra vez, con el segundo intento y la hora del aviso en Stripe');
select ok(pruebas.suelta(pruebas.id_de('evt_84_1'), 2), 'y vuelve a fallar de paso');
select ok((select next_attempt_at between now() + interval '299 seconds' and clock_timestamp() + interval '301 seconds' from pruebas.aviso('evt_84_1')),
  'la segunda espera es de 5 minutos');

-- El barrido: lo que toca y lo apartado vencido, con `skip locked`.
select pruebas.vence('evt_84_1');
select is((select v ->> 'attempt' from pruebas.vencidos() v where v ->> 'id' = pruebas.id_de('evt_84_1')::text), '3',
  'con su espera cumplida, el barrido lo toma');
select pruebas.vence('evt_84_1');
select is((select v ->> 'attempt' from pruebas.vencidos() v where v ->> 'id' = pruebas.id_de('evt_84_1')::text), '4',
  'apartado y vencido (la aplicación se cayó), también');
select throws_ok('select * from private.provider_event_claim_due(0)', '22023', null, 'el barrido toma de 1 a 100');
select pruebas.intentos('evt_84_1', 10);
select pruebas.vence('evt_84_1');
select is((select count(*)::integer from pruebas.vencidos() v where v ->> 'id' = pruebas.id_de('evt_84_1')::text), 0,
  'con diez intentos ya no se toma');
select results_eq($$select status, last_error, locked_until is null from pruebas.aviso('evt_84_1')$$,
  $$values ('failed', 'attempts_exhausted', true)$$, 'queda fallido, a la vista');
select is(pruebas.reclama(pruebas.id_de('evt_84_1')) - 'id', '{"outcome": "finished", "status": "failed"}'::jsonb,
  'y un reenvío ya no lo intenta: lo reabre finanzas');

-- Terminar sin aplicar: ignorado, en espera de otra tarea, o fallido para siempre.
select pruebas.recibe('evt_84_2', 'customer.created', 'cus_84');
select is(pruebas.reclama(pruebas.id_de('evt_84_2')) ->> 'attempt', '1', 'otro aviso');
select ok(not pruebas.termina(pruebas.id_de('evt_84_2'), 1, 'processed'), 'procesado solo lo marca quien lo aplica');
select ok(not pruebas.termina(pruebas.id_de('evt_84_2'), 1, 'processed', 'a_mano'), 'tampoco con un código');
select ok(not pruebas.termina(pruebas.id_de('evt_84_2'), 2, 'ignored'), 'ni otro intento');
select ok(pruebas.termina(pruebas.id_de('evt_84_2'), 1, 'ignored'), 'un tipo que no es de cobro se ignora');
select ok((pruebas.aviso('evt_84_2')).revision > 0, 'cada cambio sube la revisión');
select results_eq($$select status, finished_at is not null, locked_until is null from pruebas.aviso('evt_84_2')$$,
  $$values ('ignored', true, true)$$, 'ignorado es terminado');
select is(pruebas.reclama(pruebas.id_de('evt_84_2')) - 'id', '{"outcome": "finished", "status": "ignored"}'::jsonb, 'ya no se reclama');

select pruebas.recibe('evt_84_3', 'charge.refunded', 'ch_84');
select pruebas.reclama(pruebas.id_de('evt_84_3'));
select ok(not pruebas.termina(pruebas.id_de('evt_84_3'), 1, 'deferred'), 'en espera lleva su motivo');
select ok(not pruebas.termina(pruebas.id_de('evt_84_3'), 1, 'failed', 'algo'), 'un reembolso no se da por fallido: se resolvería a mano sin T-307');
select ok(pruebas.termina(pruebas.id_de('evt_84_3'), 1, 'deferred', 'refund_waits_t307'), 'un reembolso espera a T-307 (decisión 3 de Sergio)');
select results_eq($$select status, last_error, finished_at is null from pruebas.aviso('evt_84_3')$$,
  $$values ('deferred', 'refund_waits_t307', true)$$, 'en espera no es terminado: frena el cierre');
select is(pruebas.reclama(pruebas.id_de('evt_84_3')) - 'id', '{"outcome": "finished", "status": "deferred"}'::jsonb, 'y un reenvío no lo toca');
select is((select count(*)::integer from pruebas.vencidos() v where v ->> 'id' = pruebas.id_de('evt_84_3')::text), 0, 'ni el barrido');

select pruebas.recibe('evt_84_4', 'invoice.paid', 'in_84_4');
select pruebas.reclama(pruebas.id_de('evt_84_4'));
select ok(not pruebas.termina(pruebas.id_de('evt_84_4'), 1, 'ignored'), 'un aviso de cobro no se ignora: su cobro se perdería');
select ok(not pruebas.termina(pruebas.id_de('evt_84_4'), 1, 'deferred', 'algo'), 'ni se deja en espera: solo lo de T-307 espera');
select ok(not pruebas.termina(pruebas.id_de('evt_84_4'), 1, 'failed'), 'fallido lleva su motivo');
select ok(not pruebas.termina(pruebas.id_de('evt_84_4'), 1, 'failed', 'Sin Forma'), 'con forma de código');
select ok(pruebas.termina(pruebas.id_de('evt_84_4'), 1, 'failed', 'zero_invoice'), 'una factura de 0 queda fallida (decisión 7 de Sergio)');
select results_eq($$select status, last_error, finished_at is null from pruebas.aviso('evt_84_4')$$,
  $$values ('failed', 'zero_invoice', true)$$, 'fallido, con su código');
select is(pruebas.reclama(pruebas.id_de('evt_84_4')) - 'id', '{"outcome": "finished", "status": "failed"}'::jsonb,
  'un reenvío no lo vuelve a intentar, aunque le queden intentos');
select pruebas.recibe('evt_84_5', 'invoice.paid', 'in_84_5');
select pruebas.intentos('evt_84_5', 10);
-- Desde la tercera solicitud, el reclamo que lo agota lo dice, para que la entrega lo reporte (la 86).
select is(pruebas.reclama(pruebas.id_de('evt_84_5')) - 'id', '{"outcome": "finished", "status": "failed", "exhausted": true}'::jsonb,
  'con diez intentos, el reenvío tampoco lo toma: queda fallido');
select is((pruebas.aviso('evt_84_5')).last_error, 'attempts_exhausted', 'por sus intentos');
-- Nadie reintenta ni resuelve el aviso de su propio pago.
select pruebas.de_cuenta('evt_84_5', pruebas.f1());
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_retry(%L, %s)', pruebas.id_de('evt_84_5'), pruebas.rev('evt_84_5')))::jsonb ->> 'outcome', 'self',
  'finanzas no reabre el aviso de su propio pago');
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_resolve(%L, %L, %s)', pruebas.id_de('evt_84_5'), 'nota', pruebas.rev('evt_84_5')))::jsonb
          ->> 'outcome', 'self', 'ni lo resuelve');
select throws_ok(format('update private.provider_events set profile_id = %L where provider_event_id = %L', pruebas.ana(), 'evt_84_5'), '42501', null,
  'la cuenta de un aviso no cambia');
-- También si el aviso no la sabe, pero su objeto es una suscripción de quien actúa.
insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency)
values (pruebas.f1(), 'stripe', 'sub_f1_84', 'monthly', 'pending', 'MXN');
select pruebas.recibe('evt_84_6', 'customer.subscription.updated', 'sub_f1_84');
select pruebas.intentos('evt_84_6', 10);
select pruebas.reclama(pruebas.id_de('evt_84_6'));
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_retry(%L, %s)', pruebas.id_de('evt_84_6'), pruebas.rev('evt_84_6')))::jsonb ->> 'outcome', 'self',
  'finanzas no reabre el aviso de su propia suscripción');
-- O si su objeto es una factura de un cobro de quien actúa.
select pruebas.como_dueno_sistema();
select private.open_period(202610);
select pruebas.como_dueno();
select is(private.record_charge(pruebas.f1(), (select id from public.subscriptions where provider_subscription_id = 'sub_f1_84'), 'stripe', 'ch_f1_84', 'in_f1_84',
                                'monthly', '2026-10-10 12:00-06', 'MXN', 34900, null, null, null, null, null) ->> 'outcome', 'recorded', '(un cobro de quien tiene finanzas)');
-- La revisión de sus partes es diferida: que corra aquí, y no estorbe a lo que se prueba después.
set constraints all immediate;
select pruebas.recibe('evt_84_8', 'invoice.payment_failed', 'in_f1_84');
select pruebas.intentos('evt_84_8', 10);
select pruebas.reclama(pruebas.id_de('evt_84_8'));
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_resolve(%L, %L, %s)', pruebas.id_de('evt_84_8'), 'nota', pruebas.rev('evt_84_8')))::jsonb
          ->> 'outcome', 'self', 'ni resuelve el aviso de la factura de su propio cobro');
-- Lo de T-307 que se quedó sin intentos no se resuelve a mano: se reintenta.
select pruebas.recibe('evt_84_7', 'charge.refunded', 'ch_84_7');
select pruebas.intentos('evt_84_7', 10);
select pruebas.reclama(pruebas.id_de('evt_84_7'));
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_resolve(%L, %L, %s)', pruebas.id_de('evt_84_7'), 'nota', pruebas.rev('evt_84_7')))::jsonb
          ->> 'outcome', 'not_failed', 'un reembolso fallido no se resuelve a mano');

-- ---------------------------------------------------------------------------------------
-- El guardián: nada se borra, lo de Stripe no cambia, y lo terminado no vuelve.

select throws_ok($$delete from private.provider_events where provider_event_id = 'evt_84_2'$$, '42501', null, 'un aviso no se borra, ni el dueño');
select throws_ok('truncate private.provider_events cascade', '42501', null, 'ni se vacía la bandeja');
select throws_ok($$update private.provider_events set object_id = 'in_otro' where provider_event_id = 'evt_84_4'$$, '42501', null,
  'lo que dijo Stripe no cambia');
select throws_ok($$update private.provider_events set occurred_at = now() where provider_event_id = 'evt_84_4'$$, '42501', null, 'ni su hora');
select throws_ok($$update private.provider_events set status = 'pending' where provider_event_id = 'evt_84_2'$$, '42501', null,
  'lo ignorado no vuelve atrás');
select throws_ok($$update private.provider_events set attempts = 0 where provider_event_id = 'evt_84_3'$$, '42501', null,
  'los intentos solo bajan al reabrir uno fallido');
select throws_ok($$update private.provider_events set status = 'resolved', finished_at = now() where provider_event_id = 'evt_84_4'$$, '23514', null,
  'resuelto lleva quién y su nota');

-- ---------------------------------------------------------------------------------------
-- Finanzas: reintentar y resolver a mano (RF-710; decisión 6 de Sergio).

select is(pruebas.pide(pruebas.ana(), format('private.provider_event_retry(%L, 1)', pruebas.id_de('evt_84_4')))::jsonb ->> 'outcome', 'forbidden',
  'sin finanzas no se reintenta');
select pruebas.sin_codigo(pruebas.f1());
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_retry(%L, 1)', pruebas.id_de('evt_84_4')))::jsonb ->> 'outcome', 'needs_fresh_code',
  'con finanzas, pide el código reciente');
select pruebas.equipar(pruebas.f1());
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_retry(%L, 1)', gen_random_uuid()))::jsonb ->> 'outcome', 'not_found', 'uno que no existe');
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_retry(%L, %s)', pruebas.id_de('evt_84_4'), pruebas.rev('evt_84_4') - 1))::jsonb ->> 'outcome',
  'changed', 'con otra revisión de la que vio, cambió');
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_retry(%L, 1)', pruebas.id_de('evt_84_3')))::jsonb ->> 'outcome', 'not_failed',
  'lo que espera a T-307 no se reintenta');
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_retry(%L, %s)', pruebas.id_de('evt_84_4'), pruebas.rev('evt_84_4')))::jsonb ->> 'outcome',
  'retried', 'uno fallido se reintenta');
select results_eq($$select status, attempts, next_attempt_at <= clock_timestamp(), locked_until is null from pruebas.aviso('evt_84_4')$$,
  $$values ('pending', 0, true, true)$$, 'vuelve pendiente, con sus intentos desde cero y ya');
select results_eq($$select action, actor, note from private.provider_event_actions where event_id = pruebas.id_de('evt_84_4')$$,
  format($$values ('retry', %L::uuid, null::text)$$, pruebas.f1()), 'queda anotado quién lo reintentó');
select is((select count(*)::integer from public.audit_log where entity_table = 'private.provider_event_actions' and actor_id = pruebas.f1()), 1,
  'y en la auditoría');
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_retry(%L, 0)', pruebas.id_de('evt_84_4')))::jsonb ->> 'outcome', 'not_failed',
  'dos veces no: ya no está fallido');

select pruebas.reclama(pruebas.id_de('evt_84_4'));
select pruebas.termina(pruebas.id_de('evt_84_4'), 1, 'failed', 'second_live_subscription');
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_resolve(%L, %L, 1)', pruebas.id_de('evt_84_4'), '   '))::jsonb ->> 'outcome', 'malformed',
  'resolver a mano pide una nota');
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_resolve(%L, %L, 1)', pruebas.id_de('evt_84_4'), repeat('x', 501)))::jsonb ->> 'outcome', 'malformed',
  'de hasta 500 caracteres');
select is(pruebas.pide(pruebas.ana(), format('private.provider_event_resolve(%L, %L, 1)', pruebas.id_de('evt_84_4'), 'nota'))::jsonb ->> 'outcome', 'forbidden',
  'sin finanzas no se resuelve');
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_resolve(%L, %L, 1)', pruebas.id_de('evt_84_3'), 'nota'))::jsonb ->> 'outcome', 'not_failed',
  'lo que espera a T-307 no se resuelve a mano');
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_resolve(%L, %L, %s)', pruebas.id_de('evt_84_4'), 'nota', pruebas.rev('evt_84_4') - 1))::jsonb
          ->> 'outcome', 'changed', 'resolver con una vista vieja: cambió (otro lo reintentó y volvió a fallar)');
select is(pruebas.pide(pruebas.f1(), format('private.provider_event_resolve(%L, %L, %s)', pruebas.id_de('evt_84_4'),
                                            '  Segundo pago de la misma cuenta; se reembolsó en Stripe.  ', pruebas.rev('evt_84_4')))::jsonb ->> 'outcome', 'resolved',
  'con su nota, se resuelve');
select results_eq($$select status, resolved_by, resolution_note, finished_at is not null from pruebas.aviso('evt_84_4')$$,
  format($$values ('resolved', %L::uuid, 'Segundo pago de la misma cuenta; se reembolsó en Stripe.', true)$$, pruebas.f1()),
  'resuelto, con quién y la nota sin espacios de más');
select is((select count(*)::integer from private.provider_event_actions where event_id = pruebas.id_de('evt_84_4') and action = 'resolve'), 1,
  'anotado');
select is((select count(*)::integer from public.audit_log where entity_table = 'private.provider_event_actions'
           and coalesce(new_value::text, '') like '%reembols%'), 0, 'la auditoría no lleva la nota, que es texto libre');
select is(pruebas.reclama(pruebas.id_de('evt_84_4')) - 'id', '{"outcome": "finished", "status": "resolved"}'::jsonb, 'resuelto ya no se reclama');
select throws_ok($$update private.provider_events set status = 'failed', finished_at = null where provider_event_id = 'evt_84_4'$$, '42501', null,
  'ni vuelve atrás');
select throws_ok($$delete from private.provider_event_actions$$, '42501', null, 'lo que hizo finanzas no se borra');

-- ---------------------------------------------------------------------------------------
-- La salud, para el barrido y las alertas, sin nombrar a nadie.

select results_eq($$select (h1 ->> 'pending')::int - (h ->> 'pending')::int, (h1 ->> 'failed')::int - (h ->> 'failed')::int,
                           (h1 ->> 'deferred')::int - (h ->> 'deferred')::int
                    from salud0 cross join (select private.provider_events_health() as h1) x$$,
  $$values (0, 5, 1)$$, 'cuántos esperan, cuántos fallaron y cuántos esperan a otra tarea');
-- La salida de correo manda primero el aviso de CLABE: un día de renovaciones no lo deja atrás.
insert into private.mail_outbox (idempotency_key, template, recipient, created_at) values
  ('CO-03:prueba-84-viejo', 'CO-03', 'ana-84@prueba.test', now() - interval '1 hour'),
  ('CO-27:prueba-84', 'CO-27', 'ana-84@prueba.test', now());
select pruebas.como_sistema();
select is((select template from private.mail_claim(1)), 'CO-27', 'el aviso de CLABE sale antes que un recibo más viejo');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- El libro de ingresos ya sabe de la bandeja, y sigue cerrado a la aplicación.

select ok(not exists (select 1 from pg_constraint where conrelid = 'public.charges'::regclass and conname = 'charges_event_later'),
  'el cobro ya puede nombrar su aviso');
select fk_ok('public', 'charges', 'provider_event_id', 'private', 'provider_events', 'id', 'un cobro dice qué aviso lo trajo');
select has_function('private', 'record_charge',
  array['uuid', 'uuid', 'text', 'text', 'text', 'subscription_plan', 'timestamp with time zone', 'text', 'bigint', 'bigint', 'bigint',
        'text', 'text', 'text', 'uuid'], 'record_charge recibe el aviso al final');
select hasnt_function('private', 'record_charge',
  array['uuid', 'uuid', 'text', 'text', 'text', 'subscription_plan', 'timestamp with time zone', 'text', 'bigint', 'bigint', 'bigint',
        'text', 'text', 'text'], 'y la de catorce ya no existe aparte (las llamadas de catorce siguen sirviendo)');
select ok(not has_function_privilege('app_service', 'private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint, bigint, bigint, text, text, text, uuid)', 'execute'),
  'el servidor sigue sin registrar cobros por su cuenta');
select lives_ok($$insert into private.mail_outbox (idempotency_key, template, recipient) values ('CO-03:prueba-84', 'CO-03', 'ana-84@prueba.test')$$,
  'la salida de correo admite el recibo');

-- ---------------------------------------------------------------------------------------
-- El vigilante del área.

select is_empty('select * from private.schema_violations_billing()', 'el área de los avisos, en orden');
select is_empty('select * from private.schema_violations_revenue()', 'y la de los ingresos');
grant select on private.provider_events to app_service;
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['billing table privilege for app_service'],
  'si el servidor pudiera leer la bandeja, lo dice');
revoke select on private.provider_events from app_service;
grant execute on function private.billing_state(text, boolean) to app_service;
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['billing helper reachable: billing_state'],
  'y si pudiera ejecutar una pieza suelta');
revoke execute on function private.billing_state(text, boolean) from app_service;
revoke execute on function private.provider_event_receive(text, text, text, boolean, text, text, timestamptz) from app_service;
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['billing door missing or wrong: provider_event_receive'],
  'y si le faltara una puerta');
grant execute on function private.provider_event_receive(text, text, text, boolean, text, text, timestamptz) to app_service;
alter table private.provider_events disable trigger provider_events_guard;
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['billing trigger missing: provider_events_guard'],
  'y si el guardián estuviera apagado');
alter table private.provider_events enable trigger provider_events_guard;
alter table private.provider_settlements disable row level security;
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['billing table without row security'],
  'y si una tabla quedara sin seguridad por fila');
alter table private.provider_settlements enable row level security;
alter function private.provider_event_claim(uuid) reset search_path;
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['billing door missing or wrong: provider_event_claim'],
  'y si una puerta perdiera su search_path');
alter function private.provider_event_claim(uuid) set search_path = '';
-- Lo que el vigilante busca en el código: una versión a la que le falta, dentro de esta transacción.
create function pruebas.sin(p_function text, p_old text, p_new text) returns void language plpgsql as $$
declare
  v text := pg_get_functiondef(p_function::regprocedure);
begin
  if position(p_old in v) = 0 then
    raise exception 'pruebas.sin: no está en %', p_function;
  end if;
  execute replace(v, p_old, p_new);
end
$$;
select pruebas.sin('private.billing_apply(uuid, integer, jsonb, jsonb, jsonb)', ':= private.record_charge(', ':= private.record_charge_x(');
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['billing apply without its order'],
  'y si aplicar no registrara el cobro con su orden de candados');
select pruebas.sin('private.billing_apply(uuid, integer, jsonb, jsonb, jsonb)', ':= private.record_charge_x(', ':= private.record_charge(');
select pruebas.sin('private.period_photos()', $$e.status in ('pending', 'processing') and e.occurred_at < p.ends_at + interval$$,
                   $$e.status in ('pending') and e.occurred_at < p.ends_at + interval$$);
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['period photo without the billing wait'],
  'y si la foto no esperara a los avisos en proceso');
select pruebas.sin('private.period_photos()', $$e.status in ('pending') and e.occurred_at < p.ends_at + interval$$,
                   $$e.status in ('pending', 'processing') and e.occurred_at < p.ends_at + interval$$);
select pruebas.sin('private.active_students_at(timestamptz)', 'and coalesce(s.provider_started_at, s.created_at) <= p_at', 'and s.created_at <= p_at');
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['active students without the provider start'],
  'y si los alumnos activos no contaran el inicio en Stripe');
select pruebas.sin('private.active_students_at(timestamptz)', 'and s.created_at <= p_at', 'and coalesce(s.provider_started_at, s.created_at) <= p_at');
select pruebas.sin('private.mail_claim(integer)', $$order by m.template <> 'CO-27', m.created_at$$, 'order by m.created_at');
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['mail claim without the clabe first'],
  'y si la salida de correo no mandara primero el aviso de CLABE');
select pruebas.sin('private.mail_claim(integer)', 'order by m.created_at', $$order by m.template <> 'CO-27', m.created_at$$);
select pruebas.sin('private.provider_event_retry(uuid, integer)', ' or private.provider_event_owner(v.object_id) = private.actor_id()', '');
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['finance door without the self check: provider_event_retry'],
  'y si reintentar no mirara al dueño de lo que el aviso nombra');
select pruebas.sin('private.provider_event_retry(uuid, integer)', 'if v.profile_id = private.actor_id() then', 'if v.profile_id = private.actor_id() or private.provider_event_owner(v.object_id) = private.actor_id() then');
alter table public.charges drop constraint charges_event_fk;
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['charge without its event key'],
  'y si el cobro no tuviera su clave al aviso');
alter table public.charges add constraint charges_event_fk foreign key (provider_event_id) references private.provider_events (id);
select is_empty('select * from private.schema_violations_billing()', 'todo vuelve a su lugar');

select * from finish();
rollback;
