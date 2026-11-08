-- T-303, cuarta solicitud · La conciliación con Stripe y las dos respuestas nuevas del cierre (RF-208, RF-501; plan aprobado por Sergio el 2026-11-08, con sus
-- decisiones de ese día y las del 2026-11-06). El servidor lista los cargos de Stripe de la ventana del periodo y la base los clasifica, los compara con los cobros
-- propios y guarda la comparación con cada diferencia. Una sola definición dice si hay una comparación vigente que coincide (`billing_reconciliation_current`), y la
-- usan el cierre, sus dos lecturas y lo que pide el trabajo. Lo que Stripe cobró y el libro no tiene se explica con nota de una persona; lo que el libro tiene y Stripe
-- no, o con otro monto, frena hasta corregirse. El cierre se frena con lo fallido y lo que espera a T-307 de cualquier fecha, con lo pendiente de antes del fin del
-- mes, y sin una comparación vigente. Además, lo que liquidó Stripe se completa para los cobros que llegaron sin su transacción de saldo.
--
-- Octubre de 2026 ya terminó y es el mes que se compara y se cierra; el mes de ahora todavía no termina.
begin;
\ir _ayuda.psql
select plan(115);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a8700000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.sus(p_n integer) returns uuid language sql immutable
as $$ select ('c8700000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b8700000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.otra() returns uuid language sql immutable as $$ select 'b8700000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.nadie() returns uuid language sql immutable as $$ select 'b8700000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.ahora() returns integer language sql stable as $$ select private.period_of(now())::integer $$;

create function pruebas.como_finanzas(p_who uuid default null) returns void language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', coalesce(p_who, pruebas.finanzas())::text, true),
         set_config('app.actor_session', pruebas.sesion(coalesce(p_who, pruebas.finanzas()))::text, true);
$$;
-- Lo que el servidor lee de un cargo de Stripe.
create function pruebas.cargo(p_id text, p_cents bigint, p_status text default 'succeeded', p_captured boolean default true,
                              p_currency text default 'mxn', p_at timestamptz default '2026-10-10 12:00-06', p_live boolean default false,
                              p_refunded boolean default false)
returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_id, 'status', p_status, 'captured', p_captured, 'refunded', p_refunded, 'currency', p_currency, 'livemode', p_live,
                            'created', extract(epoch from p_at)::bigint, 'amount_captured', p_cents)
$$;
-- La ventana, como la pide quien compara (el sistema si no se dice otra cosa).
create function pruebas.ventana(p_period integer, p_who uuid default null) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  if p_who is null then perform pruebas.como_sistema(); else perform pruebas.como_finanzas(p_who); end if;
  v := private.billing_reconciliation_window(p_period);
  perform pruebas.limpiar();
  return v;
end
$$;
-- Compara: pide la ventana y manda los cargos con ella, salvo que se diga otra ventana.
create function pruebas.compara(p_period integer, p_charges jsonb, p_complete boolean default true, p_who uuid default null,
                                p_starts bigint default null, p_ends bigint default null, p_live boolean default false)
returns jsonb language plpgsql as $$
declare
  w jsonb := pruebas.ventana(p_period);
  v jsonb;
begin
  if p_who is null then perform pruebas.como_sistema(); else perform pruebas.como_finanzas(p_who); end if;
  v := private.billing_reconciliation_record(p_period, p_live, coalesce(p_starts, (w ->> 'starts_at')::bigint),
                                             coalesce(p_ends, (w ->> 'ends_at')::bigint), p_complete, p_charges);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.explica(p_period integer, p_side text, p_charge text, p_own bigint, p_provider bigint, p_currency text default 'mxn',
                                p_note text default 'Cobro a mano en el panel de Stripe, ya reembolsado.') returns text language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  v := private.billing_reconciliation_explain(p_period, p_side, p_charge, p_own, p_provider, p_currency, p_note);
  perform pruebas.limpiar();
  return v ->> 'outcome';
end
$$;
create function pruebas.vigente(p_period integer) returns boolean language sql stable as $$
  select private.billing_reconciliation_current(p_period) is not null
$$;
create function pruebas.lados(p_id uuid) returns text[] language sql stable as $$
  select coalesce(array_agg(d.side || ':' || d.provider_charge_id order by d.side, d.provider_charge_id), '{}')
  from private.billing_reconciliation_differences d where d.reconciliation_id = p_id
$$;
create function pruebas.cobra(p_n integer, p_charge text, p_cents bigint, p_at timestamptz default '2026-10-10 12:00-06',
                              p_provider text default 'stripe') returns text language sql as $$
  select private.record_charge(pruebas.al(p_n), pruebas.sus(p_n), p_provider, p_charge, null, 'monthly', p_at, 'MXN', p_cents, null, null,
                               'card', 'MX', null) ->> 'outcome'
$$;
create function pruebas.recibe(p_event text, p_type text default 'invoice.paid', p_at timestamptz default '2026-10-20 12:00-06') returns uuid language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_sistema();
  v := private.provider_event_receive('stripe', p_event, p_type, false, '2026-10-28.endive', 'in_87', p_at);
  perform pruebas.limpiar();
  return (v ->> 'id')::uuid;
end
$$;
create function pruebas.termina(p_id uuid, p_status text, p_code text) returns void language plpgsql as $$
declare
  v_attempt integer;
begin
  perform pruebas.como_sistema();
  perform private.provider_event_claim(p_id);
  perform pruebas.limpiar();
  v_attempt := (select e.attempts from private.provider_events e where e.id = p_id);
  perform pruebas.como_sistema();
  perform private.provider_event_finish(p_id, v_attempt, p_status, p_code);
  perform pruebas.limpiar();
end
$$;
-- Lo reclama el sistema y lo deja en proceso. El identificador se lee como dueño, antes de tomar el rol del servidor.
create function pruebas.reclama(p_id uuid) returns void language plpgsql as $$
begin
  perform pruebas.como_sistema();
  perform private.provider_event_claim(p_id);
  perform pruebas.limpiar();
end
$$;
-- Lo termina sin aplicar, como un aviso que no es de cobro: así deja de frenar.
create function pruebas.olvida(p_id uuid) returns void language plpgsql as $$
begin
  set local session_replication_role = replica;
  update private.provider_events set status = 'ignored', finished_at = now(), last_error = null, locked_until = null where id = p_id;
  set local session_replication_role = origin;
end
$$;
create function pruebas.cierra(p_period integer) returns text language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  v := private.close_period(p_period, private.last_rehearsal(p_period));
  perform pruebas.limpiar();
  return v ->> 'outcome';
end
$$;
create function pruebas.lee(p_fn text, p_period integer, p_who uuid default null) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas(p_who);
  execute format('select private.%I($1)', p_fn) using p_period into v;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.servidor(p_call text, p_who uuid default null) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  if p_who is null then perform pruebas.como_sistema(); else perform pruebas.como_finanzas(p_who); end if;
  execute 'select ' || p_call into v;
  perform pruebas.limpiar();
  return v;
end
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

delete from public.job_runs where period_id between 202609 and 202712;

-- Las cuentas: cuatro alumnos con su suscripción de Stripe, dos personas de finanzas y una del equipo sin finanzas.
select pruebas.alta(pruebas.al(n), format('alumno%s-87@prueba.test', n)) from generate_series(1, 4) n;
select pruebas.alta(pruebas.finanzas(), 'finanzas-87@prueba.test');
select pruebas.alta(pruebas.otra(), 'otra-87@prueba.test');
select pruebas.alta(pruebas.nadie(), 'nadie-87@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-87@prueba.test';
select pruebas.dar_capacidad(pruebas.finanzas(), 'finance');
select pruebas.dar_capacidad(pruebas.otra(), 'finance');
select pruebas.dar_capacidad(pruebas.nadie(), 'content');
select pruebas.equipar(pruebas.finanzas());
select pruebas.equipar(pruebas.otra());
select pruebas.equipar(pruebas.nadie());
select pruebas.como_dueno_sistema();
select private.open_period(202610);
select private.open_period(pruebas.ahora());
select pruebas.como_dueno();
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
select pruebas.sus(n), pruebas.al(n), case when n = 4 then 'mercadopago' else 'stripe' end, 'sub_87_' || n, 'monthly', 'pending', 'MXN'
from generate_series(1, 4) n;
select is(array[pruebas.cobra(1, 'ch_87_uno', 34900), pruebas.cobra(2, 'ch_87_dos', 34900)], array['recorded', 'recorded'],
  'dos cobros de Stripe en octubre');

-- ---------------------------------------------------------------------------------------
-- Las tablas y las puertas.

select has_table('private', 'billing_reconciliations', 'existen las comparaciones');
select has_table('private', 'billing_reconciliation_differences', 'sus diferencias');
select has_table('private', 'billing_reconciliation_notes', 'y las notas que las explican');
select ok(not exists (
  select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('app_service')) r (rolname)
  cross join (values ('private.billing_reconciliations'), ('private.billing_reconciliation_differences'), ('private.billing_reconciliation_notes')) t (name)
  where has_table_privilege(r.rolname, t.name, 'select, insert, update, delete, truncate, references, trigger')),
  'nadie de la aplicación toca las tres tablas');
select ok((select bool_and(c.relrowsecurity) from pg_class c
           where c.oid in ('private.billing_reconciliations'::regclass, 'private.billing_reconciliation_differences'::regclass,
                           'private.billing_reconciliation_notes'::regclass)),
  'y las tres tienen seguridad por fila');
select ok((select bool_and(has_function_privilege('app_service', s, 'execute') and not has_function_privilege('authenticated', s, 'execute')
                           and not has_function_privilege('anon', s, 'execute') and (select prosecdef from pg_proc where oid = s::regprocedure))
           from unnest(array['private.billing_reconciliation_window(public.period_id)',
                             'private.billing_reconciliation_record(public.period_id, boolean, bigint, bigint, boolean, jsonb)',
                             'private.billing_reconciliation_due()',
                             'private.billing_reconciliation_explain(public.period_id, text, text, bigint, bigint, text, text)',
                             'private.billing_settlements_missing(public.period_id)',
                             'private.billing_settlement_complete(text, text, bigint, bigint, bigint, timestamptz)']) s),
  'las seis puertas son del servidor y corren como el dueño');
select ok(not has_function_privilege('app_service', 'private.billing_reconciliation_current(public.period_id)', 'execute'),
  'y la definición de «vigente» es un ayudante que nadie de la aplicación ejecuta');

-- ---------------------------------------------------------------------------------------
-- La ventana.

select is(pruebas.ventana(202610),
  jsonb_build_object('outcome', 'window', 'starts_at', (select extract(epoch from starts_at)::bigint from public.payout_periods where period_id = 202610),
                     'ends_at', (select extract(epoch from ends_at)::bigint from public.payout_periods where period_id = 202610)),
  'la ventana de octubre son sus extremos en segundos');
select is(pruebas.ventana(pruebas.ahora()) ->> 'outcome', 'too_early', 'el mes de ahora todavía no se compara');
select is(pruebas.ventana(202610, pruebas.nadie()) ->> 'outcome', 'forbidden', 'quien no tiene finanzas no pide la ventana');
select is(pruebas.ventana(202610, pruebas.finanzas()) ->> 'outcome', 'window', 'quien tiene finanzas sí');

-- ---------------------------------------------------------------------------------------
-- Comparar y clasificar.

create temporary table r (et text primary key, v jsonb);
insert into r values ('igual', pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_dos', 34900),
                                                                         pruebas.cargo('ch_87_falla', 34900, 'failed', false))));
select is((select v ->> 'outcome' from r where et = 'igual'), 'recorded', 'una comparación se registra');
select is((select (v ->> 'matches')::boolean from r where et = 'igual'), true, 'con lo mismo de los dos lados coincide (un cargo fallido no cuenta)');
select ok(pruebas.vigente(202610), 'y queda vigente');
select is((select array[own_count, provider_count]::bigint[] || array[own_cents, provider_cents] from private.billing_reconciliations
           where id = (select (v ->> 'reconciliation_id')::uuid from r where et = 'igual')), array[2, 2, 69800, 69800]::bigint[],
  'con cuántos y cuánto de cada lado');

insert into r values ('sobra', pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_dos', 34900),
                                                                         pruebas.cargo('ch_87_panel', 50000))));
select is((select (v ->> 'matches')::boolean from r where et = 'sobra'), false, 'un cargo que el libro no tiene no coincide');
select is(pruebas.lados((select (v ->> 'reconciliation_id')::uuid from r where et = 'sobra')), array['only_provider:ch_87_panel'],
  'y queda como lo que sobra en Stripe');
select ok(not pruebas.vigente(202610), 'y la comparación más nueva manda: el periodo queda sin conciliar');

insert into r values ('falta', pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900))));
select is(pruebas.lados((select (v ->> 'reconciliation_id')::uuid from r where et = 'falta')), array['only_own:ch_87_dos'],
  'un cobro del libro que Stripe no tiene es lo que falta en Stripe');
insert into r values ('monto', pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_dos', 30000))));
select is(pruebas.lados((select (v ->> 'reconciliation_id')::uuid from r where et = 'monto')), array['amount:ch_87_dos'], 'otro monto es su propia diferencia');
select is((select array[own_cents, provider_cents] from private.billing_reconciliation_differences
           where reconciliation_id = (select (v ->> 'reconciliation_id')::uuid from r where et = 'monto')), array[34900, 30000]::bigint[],
  'con los dos montos');
insert into r values ('moneda', pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_dos', 34900),
                                                                          pruebas.cargo('ch_87_usd', 2000, p_currency => 'usd'))));
select is(pruebas.lados((select (v ->> 'reconciliation_id')::uuid from r where et = 'moneda')), array['other_currency:ch_87_usd'],
  'un cargo en otra moneda no se esconde: es dinero que el libro no tiene');
insert into r values ('pendiente', pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_dos', 34900),
                                                                             pruebas.cargo('ch_87_oxxo', 34900, 'pending', false),
                                                                             pruebas.cargo('ch_87_auth', 34900, 'succeeded', false))));
select is((select (v ->> 'matches')::boolean from r where et = 'pendiente'), false, 'un cargo pendiente o sin capturar no deja coincidir');
select is((select provider_pending from private.billing_reconciliations where id = (select (v ->> 'reconciliation_id')::uuid from r where et = 'pendiente')),
  2, 'y se cuentan los dos');
insert into r values ('vencida', pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_dos', 34900),
                                                                           pruebas.cargo('ch_87_vencida', 34900, 'succeeded', false, p_refunded => true))));
select is((select (v ->> 'matches')::boolean from r where et = 'vencida'), true,
  'una autorización sin capturar que Stripe ya devolvió no es dinero ni está pendiente: se ignora');
insert into r values ('incompleta', pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_dos', 34900)), false));
select is((select (v ->> 'matches')::boolean from r where et = 'incompleta'), false, 'un listado que no terminó no coincide aunque cuadre');

-- Lo que se rechaza sin guardar nada.
select is(pruebas.compara(202610, '[]'::jsonb, p_starts => 1) ->> 'outcome', 'malformed', 'otra ventana que la del periodo se rechaza');
select is(pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_nov', 34900, p_at => '2026-11-01 00:00-06'))) ->> 'outcome', 'malformed',
  'un cargo fuera de la ventana se rechaza (el borde de arriba no entra)');
select is(pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_uno', 34900))) ->> 'outcome', 'malformed',
  'un cargo repetido se rechaza');
select is(pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900, p_live => true))) ->> 'outcome', 'malformed',
  'un cargo de otro modo se rechaza');
select is(pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900) - 'refunded')) ->> 'outcome', 'malformed',
  'un cargo sin decir si se devolvió se rechaza');
select is(pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch 87', 34900))) ->> 'outcome', 'malformed', 'un id con otra forma se rechaza');
select is(pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_raro', 34900, 'refunded'))) ->> 'outcome', 'malformed',
  'un estado que no se conoce se rechaza');
select is(pruebas.compara(202610, '{}'::jsonb) ->> 'outcome', 'malformed', 'y lo que no es una lista también');

-- Demasiadas diferencias: se guarda, no coincide y se guardan 200.
insert into r values ('muchas', pruebas.compara(202610, (select jsonb_agg(pruebas.cargo('ch_87_m' || n, 100)) from generate_series(1, 203) n)));
select is((select array[(v ->> 'matches')::boolean, (select too_many from private.billing_reconciliations
                                                      where id = (v ->> 'reconciliation_id')::uuid)] from r where et = 'muchas'),
  array[false, true], 'con más de 200 diferencias queda como demasiadas y no coincide');
select is((select count(*) from private.billing_reconciliation_differences where reconciliation_id = (select (v ->> 'reconciliation_id')::uuid from r where et = 'muchas')),
  200::bigint, 'y se guardan 200');

-- Quién compara.
select is(pruebas.compara(202610, '[]'::jsonb, p_who => pruebas.nadie()) ->> 'outcome', 'forbidden', 'quien no tiene finanzas no compara');
select is(pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_dos', 34900)), p_who => pruebas.finanzas()) ->> 'outcome',
  'recorded', 'finanzas compara sin código reciente: no cambia dinero');
select is((select requested_by from private.billing_reconciliations order by registered_at desc, id desc limit 1), pruebas.finanzas(),
  'y queda quién lo pidió');
select is(pruebas.ventana(202610, pruebas.otra()) ->> 'outcome', 'rate_limited', 'otra persona no pide la ventana del mismo mes antes de un minuto, antes de listar');
select is(pruebas.compara(202610, '[]'::jsonb, p_who => pruebas.otra(), p_starts => (select extract(epoch from starts_at)::bigint from public.payout_periods where period_id = 202610),
                          p_ends => (select extract(epoch from ends_at)::bigint from public.payout_periods where period_id = 202610)) ->> 'outcome',
  'rate_limited', 'ni la registra');
select is(pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_dos', 34900))) ->> 'outcome', 'recorded',
  'el sistema sí');
select is((pruebas.compara(202610, '[]'::jsonb, false) ->> 'matches')::boolean, false, 'después, una incompleta (Stripe no contestó)');
select ok(pruebas.vigente(202610), 'no tira la que ya coincidía: la vigencia la decide la última completa');
select is(array[pruebas.lee('finance_period', 202610) #>> '{reconciliation,complete}', pruebas.lee('finance_period', 202610) #>> '{reconciliation,matches}',
                pruebas.lee('finance_period', 202610) #>> '{reconciliation,current}'], array['true', 'true', 'true'],
  'PA-79 muestra la misma que decide, no la incompleta');
select isnt(pruebas.lee('finance_period', 202610) #>> '{reconciliation,latest_incomplete_at}', null, 'y dice que después hubo una incompleta');
select is(pruebas.compara(pruebas.ahora(), '[]'::jsonb, p_starts => 0, p_ends => 1) ->> 'outcome', 'too_early', 'el mes de ahora no se registra');

-- La comparación es un libro, y su hora la pone la base.
select pruebas.como_dueno();
insert into private.billing_reconciliations (period_id, livemode, window_start, window_end, complete, own_count, own_cents, provider_count, provider_cents,
                                             provider_pending, provider_other_currency, differences, too_many, registered_at)
values (202610, false, '2026-10-01 00:00-06', '2026-11-01 00:00-06', true, 0, 0, 0, 0, 0, 0, 0, false, '2020-01-01');
select ok((select registered_at > now() - interval '1 minute' from private.billing_reconciliations order by registered_at desc, id desc limit 1),
  'la hora de una comparación la pone el reloj, aunque se escriba otra');
select throws_ok($$update private.billing_reconciliations set complete = true where period_id = 202610$$, '42501', null, 'una comparación no se cambia');
select throws_ok($$delete from private.billing_reconciliation_differences$$, '42501', null, 'ni se borran sus diferencias');

-- ---------------------------------------------------------------------------------------
-- La huella y lo ajeno.

select is((pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_dos', 34900))) ->> 'matches')::boolean, true,
  'una comparación que coincide');
select pruebas.como_dueno();
select is(pruebas.cobra(3, 'ch_87_tres', 34900), 'recorded', 'entra otro cobro de octubre después de comparar');
select ok(not pruebas.vigente(202610), 'y la comparación deja de estar vigente: lo propio cambió');
select is(array[(pruebas.lee('finance_period', 202610) #>> '{reconciliation,own_count}')::int, (pruebas.lee('finance_period', 202610) #>> '{reconciliation,own_count_now}')::int],
  array[2, 3], 'PA-79 dice cuántos cobros vio la comparación y cuántos tiene el libro ahora');
select is((pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_dos', 34900),
                                                     pruebas.cargo('ch_87_tres', 34900))) ->> 'matches')::boolean, true, 'con él coincide otra vez');
select is(pruebas.cobra(4, 'mp_87_cuatro', 34900, p_provider => 'mercadopago'), 'recorded', 'un cobro de otro proveedor en octubre');
select ok(not pruebas.vigente(202610), 'deja a octubre sin conciliar: ese proveedor no se compara');
select is(pruebas.lee('finance_period', 202610) #> '{reconciliation,foreign_provider}', 'true'::jsonb, 'y PA-79 dice por qué');

-- ---------------------------------------------------------------------------------------
-- Explicar.

-- Septiembre: un mes terminado sin cobros, con un cargo hecho a mano en el panel de Stripe.
select pruebas.como_dueno_sistema();
select private.open_period(202609);
select pruebas.como_dueno();
select is((pruebas.compara(202609, '[]'::jsonb) ->> 'matches')::boolean, true, 'un mes sin cobros de ningún lado coincide');
insert into r values ('panel', pruebas.compara(202609, jsonb_build_array(pruebas.cargo('ch_87_sep', 50000, p_at => '2026-09-15 12:00-06'),
                                                                         pruebas.cargo('ch_87_eur', 900, p_currency => 'eur', p_at => '2026-09-16 12:00-06'))));
-- Una incompleta más nueva (Stripe se cortó) no cambia sobre qué se explica: sobre la que se muestra, la misma que decide.
insert into r values ('sep_incompleta', pruebas.compara(202609, jsonb_build_array(pruebas.cargo('ch_87_solo', 700, p_at => '2026-09-20 12:00-06')), false));
select is(pruebas.explica(202609, 'only_provider', 'ch_87_solo', null, 700), 'not_in_comparison', 'lo que solo vio la incompleta no se explica');
select is(pruebas.explica(202609, 'only_provider', 'ch_87_sep', null, 40000), 'not_in_comparison', 'solo se explica la diferencia exacta de la comparación que decide');
select is(pruebas.explica(202609, 'only_provider', 'ch_87_sep', null, 50000), 'explained', 'lo que sobra en Stripe se explica con nota');
select ok(not pruebas.vigente(202609), 'mientras quede otra sin explicar, no está vigente');
select is(pruebas.explica(202609, 'other_currency', 'ch_87_eur', null, 900, 'eur'), 'explained', 'un cargo en otra moneda también se explica');
select ok(pruebas.vigente(202609), 'con todas explicadas, la comparación coincide sin volver a leer Stripe');
select is(pruebas.explica(202609, 'only_provider', 'ch_87_sep', null, 50000), 'exists', 'la misma diferencia no se explica dos veces');
insert into r values ('panel2', pruebas.compara(202609, jsonb_build_array(pruebas.cargo('ch_87_sep', 60000, p_at => '2026-09-15 12:00-06'),
                                                                          pruebas.cargo('ch_87_eur', 900, p_currency => 'eur', p_at => '2026-09-16 12:00-06'))));
select is((select (v ->> 'matches')::boolean from r where et = 'panel2'), false, 'el mismo cargo con otro monto es otra diferencia: la nota no la tapa');
select is(pruebas.explica(202610, 'only_own', 'ch_87_dos', 34900, null), 'not_explainable', 'lo que falta en Stripe no se explica con nota (decisión de Sergio)');
select is(pruebas.explica(202610, 'amount', 'ch_87_dos', 34900, 30000), 'not_explainable', 'ni un monto distinto');
select is(pruebas.explica(202609, 'only_provider', 'ch_87_sep', null, 60000, p_note => '   '), 'malformed', 'la nota es obligatoria');
select is(pruebas.explica(202609, 'only_provider', 'ch_87_sep', null, 60000, p_note => repeat('x', 501)), 'malformed', 'y de hasta 500');
select pruebas.sin_codigo(pruebas.finanzas());
select is(pruebas.explica(202609, 'only_provider', 'ch_87_sep', null, 60000), 'needs_fresh_code', 'explicar pide el código reciente');
select pruebas.equipar(pruebas.finanzas());
select is(pruebas.explica(202609, 'only_provider', 'ch_87_sep', null, 60000), 'explained', 'con el código se explica');
select ok(exists (select 1 from public.audit_log a where a.entity_table = 'private.billing_reconciliation_notes' and a.category = 'money'
                  and a.actor_id = pruebas.finanzas() and not (coalesce(a.new_value, '{}'::jsonb) ? 'note')),
  'cada nota queda en la auditoría como dinero, sin el texto');
select throws_ok($$update private.billing_reconciliation_notes set note = 'otra'$$, '42501', null, 'una nota no se cambia');

-- ---------------------------------------------------------------------------------------
-- Lo que pide el trabajo.

select ok(not (pruebas.servidor('private.billing_reconciliation_due()') @> '[{"period_id": 202609}]'::jsonb), 'un mes con comparación vigente no se pide');
select ok(pruebas.servidor('private.billing_reconciliation_due()') @> '[{"period_id": 202610, "overdue": true}]'::jsonb,
  'octubre, sin ella, sí, y ya pasaron dos días de su fin: se reporta');
select ok(not (pruebas.servidor('private.billing_reconciliation_due()') @> jsonb_build_array(jsonb_build_object('period_id', pruebas.ahora()))), 'el mes de ahora no');

-- ---------------------------------------------------------------------------------------
-- El cierre.

select pruebas.como_dueno_sistema();
set constraints payout_periods_balanced immediate;
set constraints payout_periods_balanced deferred;
alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
update public.payout_periods set status = 'closing', entered_closing_at = now() - interval '2 days', active_students = 3, pool_bps = 6000
where period_id = 202610;
update public.payout_periods set status = 'closed', closed_at = now() where period_id = 202609;
alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
select pruebas.como_dueno();
insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
values ('nightly_rollup', 202610, 'succeeded', now() - interval '1 hour', now() - interval '1 hour', now() - interval '59 minutes', '{"mode": "full"}');
-- Se quita el cobro de otro proveedor, como si nunca hubiera entrado.
set local session_replication_role = replica;
delete from public.revenue_allocations where charge_id in (select id from public.charges where provider = 'mercadopago' and provider_charge_id = 'mp_87_cuatro');
delete from public.charges where provider = 'mercadopago' and provider_charge_id = 'mp_87_cuatro';
set local session_replication_role = origin;

create temporary table e (et text primary key, id uuid);
insert into e values ('falla', pruebas.recibe('evt_87_falla', p_at => '2026-11-05 12:00-06'));
select pruebas.termina((select id from e where et = 'falla'), 'failed', 'unknown_plan');
select is(pruebas.cierra(202610), 'billing_events_pending', 'un aviso fallido frena el cierre aunque sea de después del fin del mes');
select pruebas.olvida((select id from e where et = 'falla'));
insert into e values ('reembolso', pruebas.recibe('evt_87_reembolso', 'charge.refunded', '2026-11-03 12:00-06'));
select pruebas.termina((select id from e where et = 'reembolso'), 'deferred', 'waits_for_t307');
select is(pruebas.cierra(202610), 'billing_events_pending', 'un reembolso que espera a T-307 también, de cualquier fecha (RN-10)');
select pruebas.olvida((select id from e where et = 'reembolso'));
insert into e values ('antes', pruebas.recibe('evt_87_antes', p_at => '2026-10-31 23:55-06'));
select is(pruebas.cierra(202610), 'billing_events_pending', 'uno pendiente de antes del fin del mes frena');
select pruebas.olvida((select id from e where et = 'antes'));
select is((pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_dos', 34900))) ->> 'matches')::boolean, false,
  'la última comparación no ve el tercer cobro en Stripe');
insert into e values ('borde', pruebas.recibe('evt_87_borde', p_at => '2026-11-01 00:09-06'));
select is(pruebas.cierra(202610), 'billing_events_pending', 'uno pendiente de 9 minutos después del fin todavía frena (el margen de la foto)');
select pruebas.olvida((select id from e where et = 'borde'));
insert into e values ('proceso', pruebas.recibe('evt_87_proceso', p_at => '2026-10-30 12:00-06'));
select pruebas.reclama((select id from e where et = 'proceso'));
select is(pruebas.cierra(202610), 'billing_events_pending', 'uno que se está procesando también');
select pruebas.olvida((select id from e where et = 'proceso'));
insert into e values ('fuera', pruebas.recibe('evt_87_fuera', p_at => '2026-11-01 00:11-06'));
select is(pruebas.cierra(202610), 'charges_match_provider', 'uno pendiente de 11 minutos después ya no');
insert into e values ('despues', pruebas.recibe('evt_87_despues', p_at => '2026-11-02 12:00-06'));
select is(pruebas.cierra(202610), 'charges_match_provider', 'uno pendiente de después no, y sin comparación vigente el cierre se frena');
select is(pruebas.lee('finance_close', 202610) -> 'checks' -> 'billing_events', '0'::jsonb, 'PA-80 lee los avisos que frenan con la misma regla');
select is(pruebas.lee('finance_close', 202610) -> 'checks' -> 'charges_match', 'false'::jsonb, 'y que no hay comparación vigente');
select is((pruebas.compara(202610, jsonb_build_array(pruebas.cargo('ch_87_uno', 34900), pruebas.cargo('ch_87_dos', 34900),
                                                     pruebas.cargo('ch_87_tres', 34900))) ->> 'matches')::boolean, true, 'se compara otra vez y coincide');
select is(pruebas.cierra(202610), 'rehearsal_missing', 'con las dos en orden, el cierre sigue a lo del ensayo');
select is(pruebas.lee('finance_close', 202610) -> 'checks' -> 'charges_match', 'true'::jsonb, 'y PA-80 lo ve igual que el cierre');
select pruebas.como_dueno();
set local session_replication_role = replica;
insert into public.anomaly_alerts (period_id, kind, status, metric_value, threshold_value)
values (202610, 'unconsumed_pool_ratio', 'open', 1, 1);
set local session_replication_role = origin;
insert into e values ('falla2', pruebas.recibe('evt_87_falla2'));
select pruebas.termina((select id from e where et = 'falla2'), 'failed', 'unknown_plan');
select is(pruebas.cierra(202610), 'open_alerts', 'las alertas abiertas van antes que los avisos');

-- Un mes cerrado no se compara, no se explica ni se pide.
select is(pruebas.ventana(202609) ->> 'outcome', 'closed', 'la ventana de un mes cerrado no se da');
select is(pruebas.compara(202609, '[]'::jsonb, p_starts => 0, p_ends => 1) ->> 'outcome', 'closed', 'ni se registra una comparación');
select is(pruebas.explica(202609, 'only_provider', 'ch_87_sep', null, 60000), 'closed', 'ni se explica');
select ok(not (pruebas.servidor('private.billing_reconciliation_due()') @> '[{"period_id": 202609}]'::jsonb), 'ni lo pide el trabajo');

-- PA-79.
select is(pruebas.lee('finance_period', 202610) #>> '{reconciliation,current}', 'true', 'PA-79 dice si la comparación está vigente');
select is(jsonb_array_length(pruebas.lee('finance_period', 202609) #> '{reconciliation,differences}'), 2, 'y muestra las diferencias de la última');
select ok((select bool_and((d ->> 'explained')::boolean) from jsonb_array_elements(pruebas.lee('finance_period', 202609) #> '{reconciliation,differences}') d),
  'y dice que las dos están explicadas');

-- ---------------------------------------------------------------------------------------
-- Lo que liquidó Stripe.

select is(pruebas.servidor('private.billing_settlements_missing(202610)'), '["ch_87_dos", "ch_87_tres", "ch_87_uno"]'::jsonb,
  'los cobros de octubre sin lo que liquidó Stripe');
select is(pruebas.servidor($$private.billing_settlement_complete('ch_87_uno', 'txn_87_uno', 34900, 1500, 33400, '2026-10-17 00:00-06')$$) ->> 'outcome',
  'recorded', 'se completa lo que liquidó un cobro');
select is(pruebas.servidor($$private.billing_settlement_complete('ch_87_uno', 'txn_87_uno', 34900, 1500, 33400, '2026-10-17 00:00-06')$$) ->> 'outcome',
  'exists', 'una sola vez');
select is(pruebas.servidor($$private.billing_settlement_complete('ch_87_dos', 'txn_87_dos', 30000, 1500, 28500, null)$$) ->> 'outcome',
  'mismatch', 'con otro bruto que el del cobro, no');
select is(pruebas.servidor($$private.billing_settlement_complete('ch_87_dos', 'txn_87_dos', 34900, 1500, 30000, null)$$) ->> 'outcome',
  'malformed', 'ni si el neto no es el bruto menos la comisión');
select is(pruebas.servidor('private.billing_settlements_missing(202610)'), '["ch_87_dos", "ch_87_tres"]'::jsonb, 'y el completado sale de la lista');

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is_empty($$select * from private.schema_violations_billing()$$, 'el área de los avisos no ve problemas');
select is_empty($$select * from private.schema_violations_close()$$, 'ni la del cierre');
alter table private.billing_reconciliations disable trigger billing_reconciliations_guard;
select ok(exists (select 1 from private.schema_violations_billing() where problem like 'billing trigger missing: billing_reconciliations_guard'),
  've la comparación sin el reloj de la base');
alter table private.billing_reconciliations enable trigger billing_reconciliations_guard;
create temporary table definiciones as select pg_get_functiondef('private.close_period(public.period_id, uuid)'::regprocedure) as cierre;
do $$ begin
  execute replace(replace((select cierre from definiciones), 'billing_events_pending"', 'billing_events_pending_x"'),
                  'private.billing_reconciliation_current(p_period) is null', 'false');
end $$;
select ok(exists (select 1 from private.schema_violations_close() where problem = 'close without the billing checks'),
  've un cierre sin las dos comprobaciones de cobro');
do $$ begin execute (select cierre from definiciones); end $$;
select is_empty($$select * from private.schema_violations_close()$$, 'y repuesto, ya no');
-- La regla de «vigente», sin la exigencia de completa: el vigilante de los avisos lo ve.
insert into definiciones (cierre) select pg_get_functiondef('private.billing_reconciliation_current(public.period_id)'::regprocedure);
do $$ begin
  execute replace((select cierre from definiciones where cierre like '%FUNCTION private.billing_reconciliation_current(%'), 'where r.period_id = p_period and r.complete', 'where r.period_id = p_period');
end $$;
select ok(exists (select 1 from private.schema_violations_billing() where problem = 'reconciliation without its rule: billing_reconciliation_current'),
  've una vigencia que ya no exige la comparación completa');
do $$ begin execute (select cierre from definiciones where cierre like '%FUNCTION private.billing_reconciliation_current(%'); end $$;
select is_empty($$select * from private.schema_violations_billing()$$, 'y repuesta, ya no');
-- Lo que se muestra, sin preferir la completa: es el error que hablaba de otra comparación que la que decide.
insert into definiciones (cierre) select pg_get_functiondef('private.billing_reconciliation_shown(public.period_id)'::regprocedure);
do $$ begin
  execute replace((select cierre from definiciones where cierre like '%FUNCTION private.billing_reconciliation_shown(%'), 'order by r.complete desc, ', 'order by ');
end $$;
select ok(exists (select 1 from private.schema_violations_billing() where problem = 'reconciliation without its rule: billing_reconciliation_shown'),
  've lo que se muestra sin preferir la completa');
do $$ begin execute (select cierre from definiciones where cierre like '%FUNCTION private.billing_reconciliation_shown(%'); end $$;
select is_empty($$select * from private.schema_violations_billing()$$, 'y repuesto, ya no');

select * from finish();
rollback;
