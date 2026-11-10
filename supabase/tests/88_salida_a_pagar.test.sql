-- T-302, primera solicitud · La salida a pagar, en la base (RF-201, RF-202; plan aprobado por Sergio el 2026-11-09). Antes de mandar a alguien a la página de
-- Stripe, la base reserva la salida con todo lo que irá a Stripe y con el consentimiento del cobro recurrente sobre el texto vigente, en una sola transacción y
-- con el candado de la cuenta; no la reserva si hay un pago en curso (una suscripción viva, o una `pending` que Stripe no dio por terminada); hay a lo más una
-- salida abierta por cuenta; y una salida se cierra solo con la palabra de Stripe o pasado el instante en que Stripe ya la venció. Nadie de la aplicación lee
-- ni escribe las tablas: solo las puertas, solo del servidor. Lo que Stripe contesta y las carreras entre dos peticiones los prueba la integración 116.
begin;
\ir _ayuda.psql
select plan(107);

select pruebas.alta('a8800000-0000-0000-0000-000000000001', 'ana-88@prueba.test');
select pruebas.alta('a8800000-0000-0000-0000-000000000002', 'beto-88@prueba.test');
select pruebas.alta('a8800000-0000-0000-0000-000000000003', 'cris-88@prueba.test');
select pruebas.alta('a8800000-0000-0000-0000-000000000004', 'dani-88@prueba.test');
select pruebas.alta('a8800000-0000-0000-0000-000000000005', 'eli-88@prueba.test');
select pruebas.alta('a8800000-0000-0000-0000-000000000006', 'fer-88@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-88@prueba.test' and email <> 'beto-88@prueba.test';
select pruebas.suspender('a8800000-0000-0000-0000-000000000003');

create function pruebas.ana() returns uuid language sql immutable as $$ select 'a8800000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.beto() returns uuid language sql immutable as $$ select 'a8800000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.cris() returns uuid language sql immutable as $$ select 'a8800000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.dani() returns uuid language sql immutable as $$ select 'a8800000-0000-0000-0000-000000000004'::uuid $$;
create function pruebas.eli() returns uuid language sql immutable as $$ select 'a8800000-0000-0000-0000-000000000005'::uuid $$;
create function pruebas.fer() returns uuid language sql immutable as $$ select 'a8800000-0000-0000-0000-000000000006'::uuid $$;

-- Dani ya paga; Eli tiene un pago que Stripe todavía no termina (su suscripción quedó `pending` con `incomplete`); Fer tuvo uno que Stripe dio por vencido.
insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, provider_status, currency, current_period_start, current_period_end,
                                  provider_started_at, provider_state_at) values
  (pruebas.dani(), 'stripe', 'sub_88_dani', 'monthly', 'active', 'active', 'MXN', now() - interval '3 days', now() + interval '27 days', now() - interval '3 days', now()),
  (pruebas.fer(), 'stripe', 'sub_88_fer', 'monthly', 'pending', 'incomplete_expired', 'MXN', null, null, now() - interval '3 days', now());
-- Lo de Eli lleva 30 días: el bloqueo no tiene plazo.
insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, provider_status, currency, provider_started_at, provider_state_at,
                                  created_at)
  values (pruebas.eli(), 'stripe', 'sub_88_eli', 'monthly', 'pending', 'incomplete', 'MXN', now() - interval '30 days', now() - interval '30 days',
          now() - interval '30 days');

-- El texto del cobro recurrente de esta prueba: una versión 1 que rige desde ahora (la base puede tener o no el borrador).
select pruebas.como_dueno_sistema();
set local session_replication_role = replica;
delete from public.consents where legal_document_id in (select id from public.legal_documents where doc_type = 'recurring_charge_consent');
delete from public.legal_documents where doc_type = 'recurring_charge_consent';
set local session_replication_role = origin;
insert into public.legal_documents (doc_type, version, title, body, effective_from)
  values ('recurring_charge_consent', 1, 'Cobro recurrente', 'Acepto que el cobro se repite hasta que yo cancele.', now())
  returning id as texto \gset
select pruebas.limpiar();

select (private.parameter_value('PRECIO_MENSUAL') #>> '{}')::bigint as mensual, (private.parameter_value('PRECIO_ANUAL') #>> '{}')::bigint as anual \gset

-- Empieza la salida a nombre de esa persona, desde PA-04, con lo que vio.
create function pruebas.empieza(p_who uuid, p_plan public.subscription_plan, p_amount bigint, p_document uuid, p_to text default '/inicio') returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_who);
  v := private.checkout_begin(p_plan, p_amount, p_document, false, p_to, '203.0.113.88'::inet, 'Navegador 88');
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.paso(p_who uuid, p_call text) returns text language plpgsql as $$
declare
  v text;
begin
  perform pruebas.a_nombre_de(p_who);
  execute 'select (' || p_call || ')::text' into v;
  perform pruebas.limpiar();
  return v;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Lo que PA-04 muestra: los dos planes con el monto del parámetro, la clave del precio en Stripe y la fecha del siguiente cobro, y el texto vigente.

select pruebas.como_sistema();
select private.checkout_offer() as oferta \gset
select pruebas.limpiar();
select is((:'oferta'::jsonb #>> '{plans,0,plan}'), 'monthly', 'la oferta trae primero el mensual');
select is((:'oferta'::jsonb #>> '{plans,0,amount_cents}')::bigint, :mensual::bigint, 'con el monto del parámetro');
select is((:'oferta'::jsonb #>> '{plans,0,lookup_key}'), 'plataforma_monthly_' || :mensual || '_mxn', 'y la clave del precio armada con ese monto');
select is((:'oferta'::jsonb #>> '{plans,1,plan}'), 'annual', 'después el anual');
select is((:'oferta'::jsonb #>> '{plans,1,amount_cents}')::bigint, :anual::bigint, 'con el suyo');
select is((:'oferta'::jsonb #>> '{recurring,id}')::uuid, :'texto'::uuid, 'y el texto del cobro recurrente que rige');
select ok((:'oferta'::jsonb #>> '{plans,0,next_charge_at}')::timestamptz between now() + interval '27 days' and now() + interval '32 days',
  'el siguiente cobro del mensual, en un mes');

-- La fecha del siguiente cobro sigue la regla de Stripe: del 31 al último día del mes que sigue, y del 29 de febrero al 28.
select is(private.checkout_next_charge('monthly', '2027-01-31 18:00+00'), '2027-02-28 18:00+00'::timestamptz, 'del 31 de enero, al 28 de febrero');
select is(private.checkout_next_charge('monthly', '2028-01-31 18:00+00'), '2028-02-29 18:00+00'::timestamptz, 'en bisiesto, al 29');
select is(private.checkout_next_charge('monthly', '2027-03-31 18:00+00'), '2027-04-30 18:00+00'::timestamptz, 'del 31 de marzo, al 30 de abril');
select is(private.checkout_next_charge('annual', '2028-02-29 18:00+00'), '2029-02-28 18:00+00'::timestamptz, 'el anual del 29 de febrero, al 28');
select is(private.checkout_next_charge('annual', '2027-11-09 18:00+00'), '2028-11-09 18:00+00'::timestamptz, 'y el anual común, el mismo día del año siguiente');

-- ---------------------------------------------------------------------------------------
-- Reservar: el consentimiento, la salida con lo que irá a Stripe y el cliente por anotar.

select pruebas.empieza(pruebas.ana(), 'monthly', :mensual, :'texto', '/cursos/uno') as primera \gset
select is(:'primera'::jsonb ->> 'answer', 'reserved', 'Ana reserva su salida');
select is(:'primera'::jsonb #>> '{checkout,plan}', 'monthly', 'del plan que eligió');
select is((:'primera'::jsonb #>> '{checkout,amount_cents}')::bigint, :mensual::bigint, 'con el monto que vio');
select is(:'primera'::jsonb #>> '{checkout,lookup_key}', 'plataforma_monthly_' || :mensual || '_mxn', 'la clave del precio');
select is(:'primera'::jsonb #>> '{checkout,return_to}', '/cursos/uno', 'y a dónde vuelve');
select ok((:'primera'::jsonb #>> '{checkout,expires_at}')::timestamptz between now() + interval '59 minutes' and now() + interval '61 minutes',
  'vence en una hora: Stripe pide al menos 30 minutos desde que se crea, y así un reintento cabe');
select is(:'primera'::jsonb -> 'customer', 'null'::jsonb, 'todavía sin cliente de Stripe');
select :'primera'::jsonb #>> '{checkout,id}' as salida \gset
select is((select count(*)::int from public.consents c where c.profile_id = pruebas.ana() and c.legal_document_id = :'texto'::uuid
             and c.origin = 'checkout' and c.action = 'granted' and c.ip = '203.0.113.88'::inet and c.user_agent = 'Navegador 88'), 1,
  'su consentimiento, sobre el texto vigente, desde la salida a pagar, con la IP y el navegador');
select is((select s.consent_id from private.checkout_sessions s where s.id = :'salida'::uuid),
          (select c.id from public.consents c where c.profile_id = pruebas.ana() and c.legal_document_id = :'texto'::uuid), 'y la salida lo nombra');
select is((select s.state::text from private.checkout_sessions s where s.id = :'salida'::uuid), 'reserved', 'la salida queda reservada');
select is((select count(*)::int from private.billing_customers b where b.profile_id = pruebas.ana() and not b.livemode and b.customer_id is null), 1,
  'y su cliente de Stripe, reservado para anotarlo');

-- Otra vez el mismo plan: la misma salida, sin otro consentimiento. Otro plan: la abierta, para vencerla antes.
select pruebas.empieza(pruebas.ana(), 'monthly', :mensual, :'texto') as otra_vez \gset
select is(:'otra_vez'::jsonb ->> 'answer', 'reuse', 'el mismo plan otra vez devuelve la misma salida');
select is(:'otra_vez'::jsonb #>> '{checkout,id}', :'salida', 'la misma');
select is((select count(*)::int from public.consents c where c.profile_id = pruebas.ana() and c.origin = 'checkout'), 1, 'sin otro consentimiento');
select pruebas.empieza(pruebas.ana(), 'annual', :anual, :'texto') as otro_plan \gset
select is(:'otro_plan'::jsonb ->> 'answer', 'open_other', 'otro plan contesta que hay una abierta');
select is(:'otro_plan'::jsonb #>> '{checkout,id}', :'salida', 'y cuál, para vencerla primero');
select is((select count(*)::int from private.checkout_sessions s where s.profile_id = pruebas.ana()), 1, 'sin reservar otra');
select pruebas.paso(pruebas.ana(), 'private.checkout_standing()') as situacion \gset
select is(:'situacion'::jsonb #>> '{open,id}', :'salida', 'PA-04 sabe de su salida abierta');
select is(:'situacion'::jsonb ->> 'blocking', 'false', 'y que no tiene un pago en curso');
select is(pruebas.paso(pruebas.eli(), $$private.checkout_standing() ->> 'blocking'$$), 'true', 'Eli sí lo tiene');

-- Lo que vio ya no es lo vigente: no reserva ni anota nada.
select is(pruebas.empieza(pruebas.ana(), 'monthly', :mensual + 100, :'texto') ->> 'answer', 'changed', 'otro monto: cambió');
select is(pruebas.empieza(pruebas.ana(), 'monthly', :mensual, gen_random_uuid()) ->> 'answer', 'changed', 'otro texto: cambió');
select is((select count(*)::int from public.consents c where c.profile_id = pruebas.ana() and c.origin = 'checkout'), 1, 'y no anotó nada');

-- ---------------------------------------------------------------------------------------
-- Quién no sale a pagar.

select is(pruebas.empieza(pruebas.beto(), 'monthly', :mensual, :'texto') #>> '{reason}', 'email_unverified', 'sin el correo verificado, no');
select is(pruebas.empieza(pruebas.cris(), 'monthly', :mensual, :'texto') #>> '{reason}', 'suspended', 'con la cuenta suspendida, no');
select is(pruebas.empieza(pruebas.dani(), 'monthly', :mensual, :'texto') ->> 'answer', 'in_progress', 'con una suscripción viva, no');
select is(pruebas.empieza(pruebas.eli(), 'monthly', :mensual, :'texto') ->> 'answer', 'in_progress',
  'con un pago que Stripe no terminó, tampoco, sin importar cuánto lleva');
select pruebas.empieza(pruebas.fer(), 'monthly', :mensual, :'texto', '/explorar?q=yoga+suave') as de_fer \gset
select is(:'de_fer'::jsonb ->> 'answer', 'reserved', 'con uno que Stripe dio por vencido, sí');
select is(:'de_fer'::jsonb #>> '{checkout,return_to}', '/explorar?q=yoga+suave', 'y vuelve a su búsqueda, con su «+»');
select is((select count(*)::int from public.consents c where c.profile_id in (pruebas.beto(), pruebas.cris(), pruebas.dani(), pruebas.eli()) and c.origin = 'checkout'), 0,
  'a quien no sale, no se le anota nada');
select pruebas.como_sistema();
select is((private.checkout_begin('monthly', :mensual, :'texto', false, '/inicio', null, null)) #>> '{reason}', 'no_actor', 'sin persona, no: un trabajo no paga por nadie');
select pruebas.limpiar();

-- Sin un texto vigente, no se reserva, y no lanza (el guardián de los consentimientos lo rechazaría).
select pruebas.como_dueno_sistema();
alter table public.legal_documents disable trigger ledger_no_update_delete;
update public.legal_documents set effective_from = now() + interval '1 day' where id = :'texto'::uuid;
alter table public.legal_documents enable trigger ledger_no_update_delete;
select pruebas.limpiar();
select pruebas.alta('a8800000-0000-0000-0000-000000000007', 'gil-88@prueba.test');
select pruebas.confirmar('a8800000-0000-0000-0000-000000000007');
select is(pruebas.empieza('a8800000-0000-0000-0000-000000000007', 'monthly', :mensual, :'texto') ->> 'answer', 'unavailable', 'sin texto vigente: no disponible');
select pruebas.como_sistema();
select is(private.checkout_offer() -> 'recurring', 'null'::jsonb, 'y la oferta lo dice');
select pruebas.limpiar();
select pruebas.como_dueno_sistema();
alter table public.legal_documents disable trigger ledger_no_update_delete;
update public.legal_documents set effective_from = now() where id = :'texto'::uuid;
alter table public.legal_documents enable trigger ledger_no_update_delete;
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- De reservada a abierta: crear en Stripe, anotar la sesión y el cliente.

select pruebas.paso(pruebas.beto(), format('private.checkout_creating(%L) ->> %L', :'salida'::text, 'answer')) as ajena \gset
select is(:'ajena'::text, 'not_found', 'la salida de otra persona no existe para quien la pide');
select is(pruebas.paso(pruebas.beto(), format('private.checkout_close(%L, %L, null)', :'salida'::text, 'abandoned')), 'not_found', 'ni la cierra');
select is(pruebas.paso(pruebas.beto(), format('private.checkout_session_record(%L, %L, %L)', :'salida'::text, 'cs_test_88beto', 'https://checkout.stripe.com/c/pay/cs_test_88beto')),
  'not_found', 'ni le anota una sesión');
select pruebas.como_sistema();
select is(private.checkout_close(:'salida'::uuid, 'abandoned', null), 'not_allowed', 'y un trabajo del sistema no cierra la salida de nadie');
select pruebas.limpiar();
select pruebas.paso(pruebas.ana(), format('private.checkout_creating(%L)', :'salida'::text)) as creando \gset
select is(:'creando'::jsonb ->> 'answer', 'creating', 'Ana pasa su salida a «creando», antes de pedirla a Stripe');
select is(:'creando'::jsonb #>> '{checkout,id}', :'salida', 'y recibe lo reservado, para mandarlo tal cual');
select is(pruebas.paso(pruebas.ana(), format('private.checkout_creating(%L) ->> %L', :'salida'::text, 'answer')), 'creating', 'un reintento recibe lo mismo');

select is(pruebas.paso(pruebas.ana(), format('private.checkout_customer_record(false, %L)', 'cus_88ana')), 'recorded', 'anota el cliente que creó Stripe');
select is(pruebas.paso(pruebas.ana(), format('private.checkout_customer_record(false, %L)', 'cus_88ana')), 'recorded', 'el mismo otra vez, igual');
select is(pruebas.paso(pruebas.ana(), format('private.checkout_customer_record(false, %L)', 'cus_88otro')), 'conflict', 'otro distinto no lo pisa');
select is(pruebas.paso(pruebas.ana(), format('private.checkout_customer_record(false, %L)', 'no es un cliente')), 'invalid', 'uno sin forma tampoco');
select is(pruebas.paso(pruebas.fer(), format('private.checkout_customer_record(false, %L)', 'cus_88ana')), 'conflict', 'el cliente de Ana no se ata a Fer');
select is((select b.customer_id from private.billing_customers b where b.profile_id = pruebas.ana() and not b.livemode), 'cus_88ana', 'el cliente de Ana es el suyo');

-- Reservada hace tanto que Stripe ya no aceptaría su vencimiento (pide al menos 30 minutos desde que se crea): no se pide, y se abandona.
select pruebas.como_dueno();
set local session_replication_role = replica;
update private.checkout_sessions set expires_at = now() + interval '29 minutes' where profile_id = pruebas.fer();
set local session_replication_role = origin;
select (select s.id from private.checkout_sessions s where s.profile_id = pruebas.fer()) as fer_salida \gset
select is(pruebas.paso(pruebas.fer(), format('private.checkout_creating(%L) ->> %L', :'fer_salida'::text, 'answer')), 'stale', 'una reserva vieja no se pide a Stripe');
select is(pruebas.paso(pruebas.fer(), format('private.checkout_close(%L, %L, null)', :'fer_salida'::text, 'abandoned')), 'closed', 'y se abandona');

select is(pruebas.paso(pruebas.ana(), format('private.checkout_session_record(%L, %L, %L)', :'salida'::text, 'cs_test_88a', 'https://checkout.stripe.com/c/pay/cs_test_88a')),
  'recorded', 'anota la sesión que creó Stripe: queda abierta');
select is(pruebas.paso(pruebas.ana(), format('private.checkout_session_record(%L, %L, %L)', :'salida'::text, 'cs_test_88a', 'https://checkout.stripe.com/c/pay/cs_test_88a')),
  'recorded', 'la misma otra vez, igual');
select is(pruebas.paso(pruebas.ana(), format('private.checkout_session_record(%L, %L, %L)', :'salida'::text, 'cs_test_88b', 'https://checkout.stripe.com/c/pay/cs_test_88b')),
  'conflict', 'otra sesión distinta no la pisa');
select is(pruebas.paso(pruebas.ana(), format('private.checkout_session_record(%L, %L, %L)', :'salida'::text, 'cs_test_88a', 'https://otro.example/pagar')),
  'invalid', 'una dirección que no es la de Stripe no se anota');
select is((select s.state::text || ' ' || s.session_id from private.checkout_sessions s where s.id = :'salida'::uuid), 'open cs_test_88a', 'abierta, con su sesión');
select is(pruebas.empieza(pruebas.ana(), 'monthly', :mensual, :'texto') #>> '{checkout,url}', 'https://checkout.stripe.com/c/pay/cs_test_88a',
  'y volver a «Continuar» devuelve su dirección');

-- Lo que PA-32 lee: la sesión es de quien mira, y su suscripción todavía no está viva.
select pruebas.paso(pruebas.ana(), format('private.checkout_status(%L)', 'cs_test_88a')) as estado \gset
select is(:'estado'::jsonb ->> 'mine', 'true', 'PA-32: la sesión es de Ana');
select is(:'estado'::jsonb ->> 'live', 'false', 'y no hay nada vivo todavía: sin acceso');
select is(:'estado'::jsonb ->> 'return_to', '/cursos/uno', 'con a dónde vuelve');
select is(pruebas.paso(pruebas.beto(), format('private.checkout_status(%L) ->> %L', 'cs_test_88a', 'mine')), 'false', 'para Beto, no es suya');
select is(pruebas.paso(pruebas.beto(), format('private.checkout_status(%L) ->> %L', 'cs_test_88a', 'return_to')), null, 'y no ve nada de ella');

-- Stripe dice que se completó, con su suscripción: se anota; el aviso la hace viva, y PA-32 lo ve.
select is(pruebas.paso(pruebas.ana(), format('private.checkout_close(%L, %L, %L)', :'salida'::text, 'completed', 'sub_88ana')), 'closed', 'se completó: se anota con su suscripción');
select is(pruebas.empieza(pruebas.ana(), 'annual', :anual, :'texto') ->> 'answer', 'in_progress',
  'Stripe la completó y su aviso no ha llegado: ya pagó, y no sale a pagar otra vez');
select is(pruebas.paso(pruebas.ana(), format('private.checkout_close(%L, %L, null)', :'salida'::text, 'expired')), 'already_closed', 'y ya no cambia');
insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, provider_status, currency, provider_started_at, provider_state_at)
  values (pruebas.ana(), 'stripe', 'sub_88ana', 'monthly', 'pending', 'incomplete', 'MXN', now(), now());
select is(pruebas.paso(pruebas.ana(), format('private.checkout_status(%L) ->> %L', 'cs_test_88a', 'live')), 'false', 'llegó la suscripción sin cobro: todavía no');
update public.subscriptions set status = 'active', provider_status = 'active', current_period_start = now(), current_period_end = now() + interval '1 month'
where provider_subscription_id = 'sub_88ana';
select is(pruebas.paso(pruebas.ana(), format('private.checkout_status(%L) ->> %L', 'cs_test_88a', 'live')), 'true', 'con el cobro aplicado, sí');
select is(pruebas.empieza(pruebas.ana(), 'annual', :anual, :'texto') ->> 'answer', 'in_progress', 'y ya no sale a pagar otra vez');

-- ---------------------------------------------------------------------------------------
-- Cerrar: solo lo que se puede, y lo que Stripe ya venció.

select pruebas.empieza('a8800000-0000-0000-0000-000000000007', 'annual', :anual, :'texto') #>> '{checkout,id}' as gil \gset
select is(pruebas.paso('a8800000-0000-0000-0000-000000000007', format('private.checkout_close(%L, %L, null)', :'gil'::text, 'expired')), 'not_allowed',
  'una reservada no se da por vencida: Stripe no la conoce');
select is(pruebas.paso('a8800000-0000-0000-0000-000000000007', format('private.checkout_close(%L, %L, null)', :'gil'::text, 'abandoned')), 'closed',
  'se abandona, porque nunca se pidió a Stripe');
select is(pruebas.empieza('a8800000-0000-0000-0000-000000000007', 'annual', :anual, :'texto') ->> 'answer', 'reserved', 'y puede reservar otra');
select pruebas.empieza('a8800000-0000-0000-0000-000000000007', 'annual', :anual, :'texto') #>> '{checkout,id}' as gil2 \gset
select pruebas.paso('a8800000-0000-0000-0000-000000000007', format('private.checkout_creating(%L)', :'gil2'::text));
select is(pruebas.paso('a8800000-0000-0000-0000-000000000007', format('private.checkout_close(%L, %L, null)', :'gil2'::text, 'abandoned')), 'closed',
  'creando, se abandona solo si Stripe rechazó crearla (lo decide el servidor con su respuesta)');
select pruebas.empieza('a8800000-0000-0000-0000-000000000007', 'annual', :anual, :'texto') #>> '{checkout,id}' as gil3 \gset
select pruebas.paso('a8800000-0000-0000-0000-000000000007', format('private.checkout_creating(%L)', :'gil3'::text));
select pruebas.paso('a8800000-0000-0000-0000-000000000007', format('private.checkout_session_record(%L, %L, %L)', :'gil3'::text, 'cs_test_88g', 'https://checkout.stripe.com/c/pay/cs_test_88g'));
select is(pruebas.paso('a8800000-0000-0000-0000-000000000007', format('private.checkout_close(%L, %L, null)', :'gil3'::text, 'abandoned')), 'not_allowed',
  'abierta no se abandona: Stripe la tiene');
select is(pruebas.paso('a8800000-0000-0000-0000-000000000007', format('private.checkout_close(%L, %L, null)', :'gil3'::text, 'completed')), 'invalid',
  'completada sin su suscripción, no');
-- Recién vencida: un pago pudo ir en camino, y se espera cinco minutos.
select pruebas.como_dueno();
set local session_replication_role = replica;
update private.checkout_sessions set expires_at = now() - interval '2 minutes' where id = :'gil3'::uuid;
set local session_replication_role = origin;
select is(pruebas.empieza('a8800000-0000-0000-0000-000000000007', 'annual', :anual, :'texto') ->> 'answer', 'in_progress', 'recién vencida, se espera');
select is((select s.state::text from private.checkout_sessions s where s.id = :'gil3'::uuid), 'open', 'sin darla por vencida todavía');
-- Pasado el margen, Stripe ya la venció: la siguiente salida la da por vencida y reserva.
set local session_replication_role = replica;
update private.checkout_sessions set expires_at = now() - interval '5 minutes' where id = :'gil3'::uuid;
set local session_replication_role = origin;
select pruebas.empieza('a8800000-0000-0000-0000-000000000007', 'annual', :anual, :'texto') as tras_vencer \gset
select is(:'tras_vencer'::jsonb ->> 'answer', 'reserved', 'pasada la hora en que Stripe la venció, se reserva otra');
select is((select s.state::text from private.checkout_sessions s where s.id = :'gil3'::uuid), 'lapsed', 'y la vieja queda vencida por el reloj');
-- Si Stripe sí la completó, lo dice después, y lo vencido por el reloj se corrige.
select is(pruebas.paso('a8800000-0000-0000-0000-000000000007', format('private.checkout_close(%L, %L, %L)', :'gil3'::text, 'completed', 'sub_88gil')), 'closed',
  'una vencida por el reloj se corrige con la palabra de Stripe');
select is((select s.state::text || ' ' || s.subscription_id from private.checkout_sessions s where s.id = :'gil3'::uuid), 'completed sub_88gil',
  'completada, con su suscripción');

-- El texto cambió con una salida abierta: no se reusa, porque su consentimiento es del texto anterior.
select pruebas.alta('a8800000-0000-0000-0000-000000000008', 'hugo-88@prueba.test');
select pruebas.confirmar('a8800000-0000-0000-0000-000000000008');
select pruebas.empieza('a8800000-0000-0000-0000-000000000008', 'monthly', :mensual, :'texto') #>> '{checkout,id}' as de_hugo \gset
-- De la versión 2 en adelante publica alguien con configuración: el dueño, a nombre de esa persona (como lo hace la función de PA-89).
select pruebas.alta('a8800000-0000-0000-0000-000000000010', 'config-88@prueba.test');
select pruebas.dar_capacidad('a8800000-0000-0000-0000-000000000010', 'config');
select pruebas.equipar('a8800000-0000-0000-0000-000000000010');
select pruebas.limpiar();
select set_config('app.actor_id', 'a8800000-0000-0000-0000-000000000010', true),
       set_config('app.actor_session', pruebas.sesion('a8800000-0000-0000-0000-000000000010')::text, true);
insert into public.legal_documents (doc_type, version, title, body, effective_from)
  values ('recurring_charge_consent', 2, 'Cobro recurrente', 'Acepto que el cobro se repite hasta que yo cancele, otra vez.', now())
  returning id as texto2 \gset
select pruebas.limpiar();
select pruebas.empieza('a8800000-0000-0000-0000-000000000008', 'monthly', :mensual, :'texto2') as otra_version \gset
select is(:'otra_version'::jsonb ->> 'answer', 'open_other', 'con otro texto vigente, la abierta no se reusa: se vence primero');
select is(:'otra_version'::jsonb #>> '{checkout,id}', :'de_hugo'::text, 'la de antes');

-- Un navegador desmedido se recorta: no impide salir a pagar.
select pruebas.alta('a8800000-0000-0000-0000-000000000009', 'ivo-88@prueba.test');
select pruebas.confirmar('a8800000-0000-0000-0000-000000000009');
select pruebas.a_nombre_de('a8800000-0000-0000-0000-000000000009');
select is(private.checkout_begin('monthly', :mensual, :'texto2', false, '/inicio', null, repeat('n', 2000)) ->> 'answer', 'reserved',
  'un navegador desmedido no impide salir');
select pruebas.limpiar();
select is((select length(c.user_agent) from public.consents c where c.profile_id = 'a8800000-0000-0000-0000-000000000009'), 1000, 'se guarda recortado');

-- ---------------------------------------------------------------------------------------
-- Lo que la base hace cumplir aunque alguien escriba directo.

select pruebas.como_dueno();
select throws_ok(format($$insert into private.checkout_sessions (profile_id, livemode, plan, lookup_key, amount_cents, next_charge_at, expires_at, return_to, consent_id)
                          select profile_id, livemode, plan, lookup_key, amount_cents, next_charge_at, expires_at, return_to, consent_id
                          from private.checkout_sessions where id = %L$$, :'tras_vencer'::jsonb #>> '{checkout,id}'),
  '23505', null, 'a lo más una salida abierta por cuenta');
select throws_ok(format($$update private.checkout_sessions set state = 'open' where id = %L$$, :'gil'::text), '42501', null, 'una salida cerrada no se reabre');
select throws_ok(format($$update private.checkout_sessions set subscription_id = 'sub_88otra' where id = %L$$, :'salida'::text), '42501', null,
  'ni cambia la suscripción de una completada');
select throws_ok(format($$update private.checkout_sessions set amount_cents = 1 where id = %L$$, :'tras_vencer'::jsonb #>> '{checkout,id}'), '42501', null,
  'ni cambia lo que se reservó');
select throws_ok($$update private.billing_customers set customer_id = 'cus_88otro' where profile_id = 'a8800000-0000-0000-0000-000000000001'$$, '42501', null,
  'un cliente anotado no cambia');
select throws_ok($$delete from private.checkout_sessions$$, '42501', null, 'ni se borran salidas');
select pruebas.limpiar();

-- Nadie de la aplicación lee ni escribe las tablas, ni ejecuta las puertas salvo el servidor.
select pruebas.como_usuario(pruebas.ana());
select throws_ok('select * from private.checkout_sessions', '42501', null, 'la persona no lee sus salidas de frente');
select throws_ok(format('select private.checkout_begin(%L, 1, null, false, %L, null, null)', 'monthly', '/inicio'), '42501', null, 'ni ejecuta la puerta');
select pruebas.limpiar();
select pruebas.a_nombre_de(pruebas.ana());
select throws_ok('select * from private.billing_customers', '42501', null, 'el servidor tampoco lee las tablas de frente');
select pruebas.limpiar();

select is_empty('select * from private.schema_violations_checkout()', 'el área de la salida a pagar, en orden');
select pruebas.como_dueno();
grant select on private.checkout_sessions to app_service;
select ok((select array_agg(problem) from private.schema_violations_checkout()) @> array['checkout table privilege for app_service'], 'el vigilante ve un permiso de más');
revoke select on private.checkout_sessions from app_service;
grant execute on function private.checkout_next_charge(public.subscription_plan, timestamptz) to app_service;
select ok((select array_agg(problem) from private.schema_violations_checkout()) @> array['checkout helper reachable: checkout_next_charge'], 'y una ayuda alcanzable');
revoke execute on function private.checkout_next_charge(public.subscription_plan, timestamptz) from app_service;
alter table private.checkout_sessions disable trigger checkout_sessions_guard;
select ok((select array_agg(problem) from private.schema_violations_checkout()) @> array['checkout trigger missing: checkout_sessions_guard'], 'y un guardián apagado');
alter table private.checkout_sessions enable trigger checkout_sessions_guard;
select is_empty('select * from private.schema_violations_checkout()', 'y queda en orden otra vez');

select * from finish();
rollback;
