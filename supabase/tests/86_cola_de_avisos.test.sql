-- T-303, tercera solicitud · La cola visible de los avisos (PA-84) y lo que avisa (RF-208, RF-710; plan aprobado por Sergio el 2026-11-07). Lo que agota sus intentos
-- queda fallido en cuanto se suelta; finanzas lee la lista y su cuenta, y cada aviso que pasa a fallido le deja un CO-22 a cada persona con finanzas, a lo más uno
-- por hora (decisiones de Sergio de ese día). Encolarlo nunca impide que el aviso quede fallido. Lo que la bandeja ya hacía lo prueba la 84.
begin;
\ir _ayuda.psql
select plan(66);

select pruebas.alta('a8600000-0000-0000-0000-000000000001', 'f1-86@prueba.test');
select pruebas.alta('a8600000-0000-0000-0000-000000000002', 'F2-86@Prueba.test');
select pruebas.alta('a8600000-0000-0000-0000-000000000003', 'sin-86@prueba.test');
select pruebas.alta('a8600000-0000-0000-0000-000000000004', 'ana-86@prueba.test');
select pruebas.alta('a8600000-0000-0000-0000-000000000005', 'ida-86@prueba.test');
select pruebas.confirmar(id) from auth.users where email ilike '%-86@prueba.test';
select pruebas.dar_capacidad('a8600000-0000-0000-0000-000000000001', 'finance');
select pruebas.dar_capacidad('a8600000-0000-0000-0000-000000000002', 'finance');
select pruebas.dar_capacidad('a8600000-0000-0000-0000-000000000003', 'finance');
select pruebas.dar_capacidad('a8600000-0000-0000-0000-000000000005', 'finance');
select pruebas.equipar('a8600000-0000-0000-0000-000000000001');
select pruebas.equipar('a8600000-0000-0000-0000-000000000002');
-- Una sin correo (Auth lo admite con un teléfono) y otra a la que ya le quitaron finanzas.
update auth.users set email = null where id = 'a8600000-0000-0000-0000-000000000003';
select pruebas.como_dueno_sistema();
update public.admin_capabilities set revoked_at = now(), revoked_by = 'a8600000-0000-0000-0000-000000000001'
where profile_id = 'a8600000-0000-0000-0000-000000000005';
select pruebas.limpiar();

create function pruebas.f1() returns uuid language sql immutable as $$ select 'a8600000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.f2() returns uuid language sql immutable as $$ select 'a8600000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.sin_correo() returns uuid language sql immutable as $$ select 'a8600000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.ana() returns uuid language sql immutable as $$ select 'a8600000-0000-0000-0000-000000000004'::uuid $$;
create function pruebas.ida() returns uuid language sql immutable as $$ select 'a8600000-0000-0000-0000-000000000005'::uuid $$;
create function pruebas.recibe(p_event text, p_type text default 'invoice.paid', p_object text default 'in_86', p_at timestamptz default now() - interval '1 minute')
returns uuid language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_sistema();
  v := private.provider_event_receive('stripe', p_event, p_type, false, '2026-10-28.endive', p_object, p_at);
  perform pruebas.limpiar();
  return (v ->> 'id')::uuid;
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
create function pruebas.suelta(p_id uuid, p_attempt integer) returns boolean language plpgsql as $$
declare
  v boolean;
begin
  perform pruebas.como_sistema();
  v := private.provider_event_release(p_id, p_attempt, 'provider_unavailable');
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.termina(p_id uuid, p_status text, p_code text default 'zero_invoice') returns boolean language plpgsql as $$
declare
  v boolean;
  v_attempt integer := (select e.attempts from private.provider_events e where e.id = p_id);
begin
  perform pruebas.como_sistema();
  v := private.provider_event_finish(p_id, v_attempt, p_status, p_code);
  perform pruebas.limpiar();
  return v;
end
$$;
-- Recibe, reclama y lo deja fallido: lo de siempre para tener uno en la lista.
create function pruebas.fallido(p_event text, p_type text default 'invoice.paid', p_object text default 'in_86') returns uuid language plpgsql as $$
declare
  v uuid := pruebas.recibe(p_event, p_type, p_object);
begin
  perform pruebas.reclama(v);
  perform pruebas.termina(v, 'failed');
  return v;
end
$$;
create function pruebas.aviso(p_id uuid) returns private.provider_events language sql security definer
as $$ select e from private.provider_events e where e.id = p_id $$;
-- Sin el guardián: las horas y los intentos no se escriben a mano.
create function pruebas.forzar(p_id uuid, p_attempts integer, p_status text default 'processing') returns void language plpgsql security definer as $$
begin
  set local session_replication_role = replica;
  update private.provider_events set attempts = p_attempts, status = p_status,
         locked_until = case when p_status = 'processing' then now() - interval '1 second' end,
         last_error = case when p_status = 'failed' then coalesce(last_error, 'provider_unavailable') else last_error end
  where id = p_id;
  set local session_replication_role = origin;
end
$$;
create function pruebas.recibido_hace(p_id uuid, p_ago interval) returns void language plpgsql security definer as $$
begin
  set local session_replication_role = replica;
  update private.provider_events set received_at = now() - p_ago where id = p_id;
  set local session_replication_role = origin;
end
$$;
create function pruebas.de_cuenta(p_id uuid, p_profile uuid) returns void language plpgsql security definer as $$
begin
  set local session_replication_role = replica;
  update private.provider_events set profile_id = p_profile where id = p_id;
  set local session_replication_role = origin;
end
$$;
create function pruebas.co22(p_profile uuid) returns setof private.mail_outbox language sql security definer
as $$ select m from private.mail_outbox m where m.template = 'CO-22' and m.profile_id = p_profile order by m.sent_at nulls last, m.claimed_until nulls first, m.created_at $$;
create function pruebas.co22s() returns integer language sql security definer
as $$ select count(*)::integer from private.mail_outbox m where m.template = 'CO-22' and m.profile_id::text like 'a8600000-%' $$;
create function pruebas.lista(p_id uuid) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.provider_events_list();
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.cuenta(p_id uuid) returns integer language plpgsql as $$
declare
  v integer;
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.provider_events_count();
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.fila(p_list jsonb, p_id uuid) returns jsonb language sql
as $$ select x from jsonb_array_elements(p_list -> 'events') x where (x ->> 'id')::uuid = p_id $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;
-- Lo que ya hubiera: la lista y la cuenta se miden contra esto.
create temp table antes as select (select count(*)::integer from private.provider_events where status = 'failed') as fallidos;

-- ---------------------------------------------------------------------------------------
-- Lo que agota sus intentos queda fallido al soltarlo, no un día después en el reclamo once.

select pruebas.recibe('evt_86_agota') as agota \gset
select pruebas.reclama(:'agota');
select pruebas.forzar(:'agota', 9);
select is(pruebas.reclama(:'agota') ->> 'attempt', '10', 'el décimo intento se reclama');
select ok(pruebas.suelta(:'agota', 10), 'soltar el décimo contesta que lo soltó');
select results_eq(format($$select status, last_error, locked_until is null from pruebas.aviso(%L)$$, :'agota'),
  $$values ('failed', 'attempts_exhausted', true)$$, 'y queda fallido, con su código, a la vista');
select is(pruebas.reclama(:'agota') - 'id', '{"outcome": "finished", "status": "failed"}'::jsonb, 'ya no se reclama');
select pruebas.recibe('evt_86_noveno') as noveno \gset
select pruebas.reclama(:'noveno');
select pruebas.forzar(:'noveno', 8);
select pruebas.reclama(:'noveno');
select ok(pruebas.suelta(:'noveno', 9), 'el noveno se suelta');
select is((pruebas.aviso(:'noveno')).status, 'pending', 'y vuelve a la fila como antes');

-- El reclamo de respaldo: un décimo intento que se cortó sin soltarse.
select pruebas.recibe('evt_86_corte') as corte \gset
select pruebas.reclama(:'corte');
select pruebas.forzar(:'corte', 10);
select is(pruebas.reclama(:'corte') - 'id', '{"outcome": "finished", "status": "failed", "exhausted": true}'::jsonb,
  'el reclamo que lo agota lo dice');
select is(pruebas.reclama(:'corte') - 'id', '{"outcome": "finished", "status": "failed"}'::jsonb, 'y el siguiente ya no, porque ya estaba fallido');

-- ---------------------------------------------------------------------------------------
-- CO-22: a cada persona con finanzas, a lo más uno por hora.

select is(pruebas.co22s(), 2, 'los dos agotados (al soltar y al reclamar) dejaron un aviso a cada persona con finanzas');
select is((select count(*)::integer from pruebas.co22(pruebas.f1())), 1, 'uno por persona: lo de la misma hora se junta');
select is((select (params ->> 'count')::integer from pruebas.co22(pruebas.f1())), 2, 'con cuántos fallaron');
select is((select recipient from pruebas.co22(pruebas.f2())), 'f2-86@prueba.test', 'a la segunda persona con finanzas, en minúsculas');
select is((select count(*)::integer from pruebas.co22(pruebas.sin_correo())), 0, 'quien no tiene correo no lo recibe, y no impide los demás');
select is((select count(*)::integer from pruebas.co22(pruebas.ida())), 0, 'ni quien ya no tiene finanzas');
select is((select count(*)::integer from pruebas.co22(pruebas.ana())), 0, 'ni quien nunca la tuvo');
select is((select params - 'first_at' from pruebas.co22(pruebas.f1())), '{"count": 2, "first_type": "invoice.paid"}'::jsonb,
  'dice el tipo y la hora del primero, y nada del alumno ni del monto');
select ok((select (params ->> 'first_at')::timestamptz = (pruebas.aviso(:'agota')).occurred_at from pruebas.co22(pruebas.f1())),
  'la hora es la del aviso en Stripe');
select ok((select idempotency_key like 'CO-22:' || pruebas.f1() || ':%' from pruebas.co22(pruebas.f1())), 'la llave lleva a quién va');
select is((select claimed_until from pruebas.co22(pruebas.f1())), null, 'el primero de la hora sale ya');

-- Lo que no es fallido no avisa.
select pruebas.recibe('evt_86_paso') as paso \gset
select pruebas.reclama(:'paso');
select pruebas.suelta(:'paso', 1);
select pruebas.recibe('evt_86_espera', 'charge.refunded', 'ch_86') as espera \gset
select pruebas.reclama(:'espera');
select pruebas.termina(:'espera', 'deferred', 'refund_waits_t307');
select pruebas.recibe('evt_86_otro', 'customer.created', 'cus_86') as otro \gset
select pruebas.reclama(:'otro');
select pruebas.termina(:'otro', 'ignored', null);
select is((select (params ->> 'count')::integer from pruebas.co22(pruebas.f1())), 2, 'ni una falla de paso, ni lo que espera a T-307, ni lo ignorado');

-- Ya enviado, el siguiente espera a que pase la hora.
update private.mail_outbox set sent_at = now() - interval '10 minutes' where template = 'CO-22' and profile_id = pruebas.f1();
select pruebas.fallido('evt_86_b') as b \gset
select is((select count(*)::integer from pruebas.co22(pruebas.f1())), 2, 'después del enviado nace otro');
select ok((select claimed_until between now() + interval '49 minutes' and now() + interval '51 minutes'
           from pruebas.co22(pruebas.f1()) offset 1), 'que no sale hasta una hora después del anterior');
select is((select (params ->> 'count')::integer from pruebas.co22(pruebas.f1()) offset 1), 1, 'con uno');
select pruebas.fallido('evt_86_c', 'customer.subscription.updated', 'sub_86') as c \gset
select is((select (params ->> 'count')::integer from pruebas.co22(pruebas.f1()) offset 1), 2, 'y lo que falle mientras espera se le suma');
select is((select params ->> 'first_type' from pruebas.co22(pruebas.f1()) offset 1), 'invoice.paid', 'sin cambiar cuál fue el primero');
select is((select (params ->> 'count')::integer from pruebas.co22(pruebas.f2())), 4, 'a la otra persona, que no lo ha recibido, se le junta todo');

-- Uno ya reclamado por la salida no se toca: lo que falle después va en otro.
update private.mail_outbox set attempts = 1, claimed_until = now() + interval '5 minutes' where template = 'CO-22' and profile_id = pruebas.f2();
select pruebas.fallido('evt_86_d') as d \gset
select is((select (params ->> 'count')::integer from pruebas.co22(pruebas.f2()) limit 1), 4, 'el que va saliendo se queda como estaba');
select is((select count(*)::integer from pruebas.co22(pruebas.f2())), 2, 'y nace otro');
select ok((select claimed_until > now() + interval '55 minutes' from pruebas.co22(pruebas.f2()) offset 1),
  'que espera la hora desde el que va saliendo');

-- Reintentar y volver a fallar avisa otra vez.
select pruebas.a_nombre_de(pruebas.f1());
select is(private.provider_event_retry(:'d', (pruebas.aviso(:'d')).revision) ->> 'outcome', 'retried', 'finanzas lo reintenta');
select pruebas.limpiar();
select is((select (params ->> 'count')::integer from pruebas.co22(pruebas.f1()) offset 1), 3, 'reintentar no avisa');
select pruebas.reclama(:'d');
select pruebas.termina(:'d', 'failed');
select is((select (params ->> 'count')::integer from pruebas.co22(pruebas.f1()) offset 1), 4, 'volver a fallar sí');

-- Si el aviso no se puede escribir, el aviso de cobro queda fallido igual.
alter table private.mail_outbox add constraint pruebas_sin_co22 check (template <> 'CO-22') not valid;
select pruebas.fallido('evt_86_e') as e \gset
select results_eq(format($$select status, last_error from pruebas.aviso(%L)$$, :'e'), $$values ('failed', 'zero_invoice')$$,
  'un CO-22 que no se pudo escribir no impide que el aviso quede fallido');
alter table private.mail_outbox drop constraint pruebas_sin_co22;
select is((select (params ->> 'count')::integer from pruebas.co22(pruebas.f1()) offset 1), 4, 'y no dejó nada a medias');

-- Si falla para una persona, las demás reciben el suyo; y el camino de uno nuevo tampoco tumba la falla.
update private.mail_outbox set sent_at = now() - interval '2 hours', claimed_until = null where template = 'CO-22' and sent_at is null;
alter table private.mail_outbox add constraint pruebas_sin_f2 check (not (template = 'CO-22' and profile_id = 'a8600000-0000-0000-0000-000000000002')) not valid;
select pruebas.fallido('evt_86_f') as f \gset
alter table private.mail_outbox drop constraint pruebas_sin_f2;
select is((pruebas.aviso(:'f')).status, 'failed', 'el aviso queda fallido aunque una persona no pueda recibir el suyo');
select is((select count(*)::integer from pruebas.co22(pruebas.f1()) where sent_at is null), 1, 'la otra recibe uno nuevo');
select is((select count(*)::integer from pruebas.co22(pruebas.f2()) where sent_at is null), 0, 'y la que falló, nada a medias');

-- Lo que agota el barrido también avisa.
select pruebas.recibe('evt_86_barrido') as barrido \gset
select pruebas.forzar(:'barrido', 10, 'pending');
select pruebas.como_sistema();
select is((select count(*)::integer from private.provider_event_claim_due(100) c where c.id = :'barrido'), 0, 'el barrido no lo toma');
select pruebas.limpiar();
select is((pruebas.aviso(:'barrido')).last_error, 'attempts_exhausted', 'lo deja fallido');
select is((select (params ->> 'count')::integer from pruebas.co22(pruebas.f1()) where sent_at is null), 2, 'y le suma a su CO-22');

-- ---------------------------------------------------------------------------------------
-- La lista de PA-84 y su cuenta: solo finanzas.

select pruebas.recibe('evt_86_viejo') as viejo \gset
select pruebas.recibido_hace(:'viejo', interval '31 minutes');
select pruebas.recibe('evt_86_nuevo') as nuevo \gset
select pruebas.recibido_hace(:'nuevo', interval '29 minutes');
select pruebas.fallido('evt_86_mio', 'invoice.paid', 'in_86_mio') as mio \gset
select pruebas.de_cuenta(:'mio', pruebas.f1());
select pruebas.recibe('evt_86_resuelto') as resuelto \gset
select pruebas.reclama(:'resuelto');
select pruebas.termina(:'resuelto', 'failed');
select pruebas.a_nombre_de(pruebas.f2());
select is(private.provider_event_resolve(:'resuelto', 'Factura de prueba', (pruebas.aviso(:'resuelto')).revision) ->> 'outcome', 'resolved',
  'uno resuelto a mano');
select pruebas.limpiar();

select is(pruebas.lista(pruebas.ana()), null, 'quien no tiene finanzas no lee la lista');
select is(pruebas.lista(pruebas.ida()), null, 'ni quien ya no la tiene');
select pruebas.como_sistema();
select is(private.provider_events_list(), null, 'ni el sistema, que no es del equipo');
select is(private.provider_events_count(), null, 'ni su cuenta');
select pruebas.limpiar();
select is(pruebas.cuenta(pruebas.ana()), null, 'la cuenta tampoco, sin finanzas');
select pruebas.lista(pruebas.f1()) as l \gset

select ok(pruebas.fila(:'l', :'agota') is not null and pruebas.fila(:'l', :'e') is not null, 'lo fallido está');
select is(pruebas.fila(:'l', :'espera') ->> 'status', 'deferred', 'lo que espera a T-307 también');
select is(pruebas.fila(:'l', :'viejo') ->> 'status', 'pending', 'y lo pendiente de más de 30 minutos');
select is(pruebas.fila(:'l', :'nuevo'), null, 'lo pendiente reciente no');
select ok(pruebas.fila(:'l', :'otro') is null and pruebas.fila(:'l', :'resuelto') is null, 'ni lo ignorado ni lo resuelto');
select is((select array_agg(k order by k) from jsonb_object_keys(pruebas.fila(:'l', :'agota')) k),
  array['attempts', 'event_type', 'id', 'is_self', 'last_error', 'livemode', 'next_attempt_at', 'object_id', 'occurred_at', 'provider_event_id',
        'received_at', 'revision', 'status'],
  'cada fila trae lo que PA-84 muestra, y nunca la nota ni quién resolvió');
select is(pruebas.fila(:'l', :'agota') -> 'revision', to_jsonb((pruebas.aviso(:'agota')).revision), 'con la revisión que se vio');
select is(pruebas.fila(:'l', :'mio') ->> 'is_self', 'true', 'el aviso del pago propio dice que es suyo');
select is(pruebas.fila(:'l', :'agota') ->> 'is_self', 'false', 'y los demás no');
select is(pruebas.fila(pruebas.lista(pruebas.f2()), :'mio') ->> 'is_self', 'false', 'para otra persona no es suyo');
select ok((select bool_and(a.failed > b.failed or (a.failed = b.failed and a.ord <= b.ord))
           from (select (x ->> 'status') = 'failed' as failed, (x ->> 'occurred_at')::timestamptz as ord, n
                 from jsonb_array_elements(:'l'::jsonb -> 'events') with ordinality t (x, n)) a
           join (select (x ->> 'status') = 'failed' as failed, (x ->> 'occurred_at')::timestamptz as ord, n
                 from jsonb_array_elements(:'l'::jsonb -> 'events') with ordinality t (x, n)) b
             on b.n = a.n + 1),
  'lo fallido primero, y cada grupo del más viejo al más nuevo');
select is((:'l'::jsonb ->> 'fresh_code')::boolean, true, 'y dice si su código es reciente');
select is((:'l'::jsonb ->> 'total')::integer, jsonb_array_length(:'l'::jsonb -> 'events'), 'con el total');
select is(pruebas.cuenta(pruebas.f1()), (select fallidos from antes) + 9, 'la cuenta del inicio es solo lo fallido');
-- Con más de 100 en espera de T-307, más viejos, un fallido nuevo sigue en la lista.
insert into private.provider_events (provider, provider_event_id, event_type, livemode, object_id, occurred_at, status, last_error)
select 'stripe', 'evt_86_espera_' || g, 'charge.refunded', false, 'ch_86_' || g, now() - interval '30 days', 'deferred', 'refund_waits_t307'
from generate_series(1, 101) g;
select ok(pruebas.fila(pruebas.lista(pruebas.f1()), :'f') is not null, 'con más de 100 en espera, lo fallido nuevo sigue en la lista');
select pruebas.sin_codigo(pruebas.f1());
select is(pruebas.lista(pruebas.f1()), null, 'sin su segundo factor no pasa la puerta del equipo');

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is_empty('select * from private.schema_violations_billing()', 'el vigilante de los avisos no encuentra nada');
alter table private.provider_events disable trigger provider_events_alert;
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['billing trigger missing: provider_events_alert'],
  'y si el aviso a finanzas no corriera');
alter table private.provider_events enable trigger provider_events_alert;
grant execute on function private.provider_events_list() to authenticated;
select ok((select array_agg(problem) from private.schema_violations_billing()) @> array['billing door missing or wrong: provider_events_list'],
  'y si una persona pudiera leer la lista sin el servidor');
revoke execute on function private.provider_events_list() from authenticated;
select is_empty('select * from private.schema_violations_billing()', 'todo vuelve a su lugar');

select * from finish();
rollback;
