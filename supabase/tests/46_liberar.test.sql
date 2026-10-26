-- T-603 · Liberar las liquidaciones, retenerlas, los bonos a mano, los ajustes, el saldo y el paso a pagado
-- (RF-501, RF-505 a RF-508, RN-11, RN-12, RN-17; 05 §5.5, §7.3, §8.1 y §8.7). Segunda de dos solicitudes; la
-- primera (`45_liquidaciones`) crea las liquidaciones al cerrar. Decisiones de Sergio del 2026-10-25: se
-- paga si el bruto (lo del bote, los bonos confirmados, los ajustes y el saldo anterior) llega a
-- `PAGO_MINIMO`; si no, acumulada, y un bruto negativo es saldo en contra; liberar va en orden, con los
-- bonos del fundador decididos; la retenida vuelve al estado en que estaba, y soltar una retenida desde
-- calculada en un mes ya liberado la libera ahí mismo; los bonos a mano nacen confirmados y se anulan
-- mientras su mes no se libere (uno sobre un mes liberado va al siguiente); un ajuste va al primer mes
-- sin liberar después de su origen; pagado al instante.
--
-- Octubre de 2026 es el ejemplo del PRD con M3 fundador y `PAGO_MINIMO` de 100 MXN (el ejemplo lo
-- fija así; el parámetro sigue en 500): M1 y M2 se pagan, M3 se acumula con su bono (38.52). Noviembre y
-- diciembre no tienen consumo: solo saldos, ajustes y bonos. La comprobación de cada liberación corre al
-- confirmar; `pruebas.hace()` la adelanta.
begin;
\ir _ayuda.psql
select plan(104);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a6040000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b6040000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.contenido() returns uuid language sql immutable as $$ select 'b6040000-0000-0000-0000-000000000002'::uuid $$;
create table pruebas.etiquetas (id uuid primary key, et text not null);
create function pruebas.et(p_id uuid) returns text language sql stable as $$ select et from pruebas.etiquetas where id = p_id $$;
create function pruebas.id(p_et text) returns uuid language sql stable as $$ select id from pruebas.etiquetas where et = p_et $$;

create function pruebas.como_finanzas(p_id uuid default null) returns void language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', coalesce(p_id, pruebas.finanzas())::text, true),
         set_config('app.actor_session', pruebas.sesion(coalesce(p_id, pruebas.finanzas()))::text, true);
$$;
-- Una llamada de finanzas, con las comprobaciones de lo liberado adelantadas (como al confirmar).
create function pruebas.hace(p_call text, p_id uuid default null) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas(p_id);
  execute 'select ' || p_call into v;
  set constraints payouts_released immediate;
  set constraints payouts_released deferred;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.cierra(p_period integer) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  perform private.rehearse_close(p_period);
  v := private.close_period(p_period);
  set constraints payout_periods_balanced immediate;
  set constraints payout_periods_balanced deferred;
  perform pruebas.limpiar();
  return v;
end
$$;
-- Libera, cambia lo escrito con la sesión en réplica y adelanta la comprobación de lo liberado; si
-- cuadra, lanza P0002 para deshacerlo todo.
create function pruebas.descuadra(p_period integer, p_sql text) returns void language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  v := private.release_payouts(p_period);
  if v ->> 'outcome' <> 'released' then
    raise exception 'no liberó: %', v;
  end if;
  if p_sql is not null then
    set local session_replication_role = replica;
    execute p_sql;
    set local session_replication_role = origin;
  end if;
  set constraints payouts_released immediate;
  raise exception 'cuadra' using errcode = 'P0002';
end
$$;
create function pruebas.o(p jsonb) returns text language sql immutable as $$ select p ->> 'outcome' $$;
create function pruebas.en_cierre(p_period integer) returns void language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(p_period);
  alter table public.payout_periods disable trigger payout_periods_guard;
  update public.payout_periods set status = 'closing', entered_closing_at = now() - interval '2 days',
         active_students = 4, pool_bps = 6000
  where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard;
  perform pruebas.como_dueno();
  insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
  values ('nightly_rollup', p_period, 'succeeded', now() - interval '3 minutes', now() - interval '3 minutes',
          now() - interval '2 minutes', '{"mode": "full"}'::jsonb);
end
$$;
create function pruebas.abierto(p_period integer) returns void language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(p_period);
  alter table public.payout_periods disable trigger payout_periods_guard;
  update public.payout_periods set status = 'open', entered_closing_at = null where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard;
  perform pruebas.como_dueno();
end
$$;
create function pruebas.parametro(p_key text, p_value jsonb, p_period integer) returns uuid language sql as $$
  select pruebas.como_dueno_sistema();
  insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
  values (p_key, p_value, 'decided', clock_timestamp() - interval '1 second', p_period) returning id;
$$;
create function pruebas.cobra(p_n integer, p_at timestamptz, p_gross bigint) returns text language sql as $$
  select private.record_charge(pruebas.al(p_n), ('c6040000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid, 'manual',
                               'cobro-lib-' || p_n || '-' || p_gross, null,
                               (select plan from public.subscriptions where profile_id = pruebas.al(p_n) limit 1),
                               p_at, 'MXN', p_gross, null, null, 'card', 'MX', null) ->> 'outcome'
$$;
create function pruebas.curso(p_slug text) returns jsonb language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', (
      select jsonb_agg(jsonb_build_object('title', t, 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'Asset' || p_slug || n, 'playback_id', 'Playback' || p_slug || n, 'duration_seconds', 100)) order by n)
      from unnest(array['Uno', 'Dos', 'Tres', 'Cuatro']) with ordinality as l (t, n)))))
$$;
create function pruebas.leccion(p_course text, p_title text) returns uuid language sql as $$
  select l.id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id
  where c.slug = p_course and l.title = p_title
$$;
create function pruebas.fila(p_period integer, p_profile uuid, p_course text, p_title text, p_half_points integer) returns void
language sql as $$
  select private.open_period(p_period);
  insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                   lesson_duration_seconds, covered_seconds, half_points)
  select p_period, p_profile, l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, 50 * p_half_points, p_half_points
  from public.published_lessons l where l.id = pruebas.leccion(p_course, p_title)
$$;
-- La liquidación de un maestro en un periodo, y lo que dice en palabras.
create function pruebas.y(p_et text, p_period integer) returns uuid language sql stable
as $$ select id from public.payouts where teacher_id = pruebas.id(p_et) and period_id = p_period $$;
create function pruebas.liq(p_period integer) returns text[] language sql stable as $$
  select array(select format('%s %s pool=%s bonos=%s ajustes=%s saldo=%s bruto=%s', pruebas.et(teacher_id), status, pool_cents,
                             bonuses_cents, adjustments_cents, balance_applied_cents, subtotal_cents)
               from public.payouts where period_id = p_period order by pruebas.et(teacher_id))
$$;
create function pruebas.saldo(p_et text) returns bigint language sql stable
as $$ select coalesce(sum(amount_cents), 0)::bigint from public.teacher_balance_entries where teacher_id = pruebas.id(p_et) $$;
create function pruebas.estado(p_period integer) returns text language sql stable
as $$ select status::text from public.payout_periods where period_id = p_period $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

delete from public.job_runs where period_id between 202609 and 202712;

-- Las cuentas, los maestros (M4 sin consumo) y M3 fundador, como en `45_liquidaciones`.
select pruebas.alta(pruebas.al(n), format('alumno%s-lib@prueba.test', n)) from generate_series(1, 4) n;
select pruebas.alta(pruebas.finanzas(), 'finanzas-lib@prueba.test');
select pruebas.alta(pruebas.contenido(), 'contenido-lib@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-lib@prueba.test';
select pruebas.dar_capacidad(pruebas.finanzas(), 'finance');
select pruebas.equipar(pruebas.finanzas());
select pruebas.dar_capacidad(pruebas.contenido(), 'content');
select pruebas.equipar(pruebas.contenido());
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra ' || s, 'maestra-' || s, null), pruebas.curso(s))
from unnest(array['lib-m1', 'lib-m2', 'lib-m3', 'lib-m4']) with ordinality as x (s, n) order by n;
select pruebas.como_dueno();
insert into pruebas.etiquetas select teacher_id, 'M' || right(slug, 1) from public.published_courses where slug like 'lib-m%';
select pruebas.como_dueno_sistema();
update public.teachers set is_founder = true, founder_since = '2026-10-01' where id = pruebas.id('M3');
select pruebas.como_dueno();
select pruebas.abierto(202610);
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
select ('c6040000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, pruebas.al(n), 'manual', 'sus-lib-' || n,
       case when n = 3 then 'annual' else 'monthly' end::public.subscription_plan, 'pending', 'MXN'
from generate_series(1, 4) n;
select is(array[pruebas.cobra(1, '2026-10-05 12:00-06', 34900), pruebas.cobra(2, '2026-10-06 12:00-06', 34900),
                pruebas.cobra(3, '2026-10-07 12:00-06', 299000), pruebas.cobra(4, '2026-10-08 12:00-06', 34900)],
  array['recorded', 'recorded', 'recorded', 'recorded'], 'los cuatro cobros del ejemplo');
select pruebas.fila(202610, pruebas.al(1), 'lib-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres', 'Cuatro']) t;
select pruebas.fila(202610, pruebas.al(1), 'lib-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(1), 'lib-m2', 'Dos', 2),
       pruebas.fila(202610, pruebas.al(1), 'lib-m2', 'Tres', 1);
select pruebas.fila(202610, pruebas.al(2), 'lib-m2', 'Uno', 1);
select pruebas.fila(202610, pruebas.al(3), 'lib-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres']) t;
select pruebas.fila(202610, pruebas.al(3), 'lib-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(3), 'lib-m3', 'Uno', 2);
select pruebas.abierto(202611);
select pruebas.abierto(202612);

-- ---------------------------------------------------------------------------------------
-- Las piezas.

select has_table('public', 'payout_adjustments', 'los ajustes');
select has_table('public', 'teacher_balance_entries', 'el saldo de cada maestro, como libro');
select enum_has_labels('public', 'balance_entry_kind', array['carried_forward', 'applied_to_payout', 'paid_on_exit'],
  'lo que mueve el saldo');
select has_column('public', 'payout_periods', 'payouts_released_at', 'cuándo se liberaron las liquidaciones de un periodo');
select has_column('public', 'payout_periods', 'paid_at', 'y cuándo pasó a pagado');
select has_column('public', 'close_runs', 'payout_preview', 'el ensayo estima las liquidaciones');
select is((select count(*)::integer from information_schema.role_table_grants
           where table_schema = 'public' and table_name in ('payout_adjustments', 'teacher_balance_entries')
             and grantee in ('anon', 'authenticated', 'service_role', 'app_service', 'PUBLIC')), 0,
  'nadie de la aplicación toca los ajustes ni el saldo todavía');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.prosecdef
             and p.proname in ('release_payouts', 'hold_payout', 'unhold_payout', 'capture_bonus', 'confirm_founder_bonus', 'void_bonus',
                               'capture_adjustment', 'check_payout_released', 'assert_payout_released', 'ensure_payout',
                               'release_payout', 'teacher_balance', 'payout_pending_teachers', 'first_unreleased_period',
                               'settle_period', 'purge_watch_partition')),
  array['capture_adjustment', 'capture_bonus', 'check_payout_released', 'confirm_founder_bonus', 'hold_payout',
        'release_payouts', 'unhold_payout', 'void_bonus'],
  'como el dueño corren las funciones de finanzas y la comprobación al confirmar');
select ok(not has_function_privilege('app_service', 'private.release_payouts(public.period_id)', 'execute')
          and not has_function_privilege('authenticated', 'private.capture_bonus(uuid, text, bigint, public.period_id, text)', 'execute'),
  'el servidor todavía no libera ni captura (PA-81 a PA-83, T-605)');

-- ---------------------------------------------------------------------------------------
-- Octubre: el ejemplo del PRD, liberado con un mínimo de 100 MXN.

select pruebas.en_cierre(202610);
select is(pruebas.o(pruebas.cierra(202610)), 'closed', 'octubre se cierra');
select is(pruebas.o(pruebas.hace('private.release_payouts(202610)', pruebas.contenido())), 'forbidden', 'sin finanzas no se libera');
select pruebas.sin_codigo(pruebas.finanzas());
select is(pruebas.o(pruebas.hace('private.release_payouts(202610)')), 'needs_fresh_code', 'sin código reciente, tampoco');
select pruebas.equipar(pruebas.finanzas());
select is(pruebas.o(pruebas.hace('private.release_payouts(null)')), 'malformed', 'sin periodo');
select is(pruebas.o(pruebas.hace('private.release_payouts(202611)')), 'not_closed', 'un periodo abierto no se libera');
select is(pruebas.o(pruebas.hace('private.release_payouts(203601)')), 'not_closed', 'ni uno sin fila');
select is(pruebas.hace('private.release_payouts(202610)'), '{"outcome": "founder_bonuses_pending", "count": 1}'::jsonb,
  'con el bono del fundador sin decidir, no se libera');
select pruebas.como_finanzas();
select throws_ok($$update public.payout_periods set payouts_released_at = now() where period_id = 202610$$, '23514', null,
  'ni marcándolo a mano: el guardián también lo exige');
select pruebas.como_dueno();
create temporary table semilla as
  select id from public.business_parameters where key = 'PAGO_MINIMO' and canceled_at is null and effective_period_id = 202610;
select pruebas.como_dueno_sistema();
update public.business_parameters set canceled_at = now() where id in (select id from semilla);
select pruebas.como_dueno();
select is(pruebas.o(pruebas.hace(format('private.confirm_founder_bonus(%L)', (select id from public.bonuses where period_id = 202610)))),
  'confirmed', 'finanzas confirma el bono del fundador');
select is(pruebas.hace(format('private.confirm_founder_bonus(%L)', (select id from public.bonuses where period_id = 202610))),
  '{"outcome": "already_decided", "status": "confirmed"}'::jsonb, 'una vez');
select is(pruebas.o(pruebas.hace('private.release_payouts(202610)')), 'no_minimum', 'sin el pago mínimo del periodo no se libera');
select pruebas.parametro('PAGO_MINIMO', '10000', 202610);
create temporary table liberacion as select pruebas.hace('private.release_payouts(202610)') as r;
select is((select r from liberacion),
  '{"outcome": "released", "period_id": 202610, "released": 3, "awaiting_invoice": 2, "carried_forward": 1, "held": 0, "period_status": "closed"}'::jsonb,
  'se libera: dos se pagan, una se acumula');
select is(pruebas.liq(202610),
  array['M1 awaiting_invoice pool=24494 bonos=0 ajustes=0 saldo=0 bruto=24494',
        'M2 awaiting_invoice pool=35843 bonos=0 ajustes=0 saldo=0 bruto=35843',
        'M3 carried_forward pool=3350 bonos=502 ajustes=0 saldo=0 bruto=3852'],
  'M1 y M2 llegan al mínimo; M3 no, y se acumula con su bono: 38.52 (05 §8.7)');
select ok((select bool_and(net_cents = subtotal_cents and vat_cents = 0 and income_tax_withheld_cents = 0 and vat_withheld_cents = 0
                           and released_by = pruebas.finanzas() and released_at = now())
           from public.payouts where period_id = 202610), 'sin retenciones ni IVA hasta T-409, liberadas por finanzas');
select results_eq($$select kind::text, amount_cents from public.teacher_balance_entries where teacher_id = pruebas.id('M3')$$,
  $$values ('carried_forward', 3852::bigint)$$, 'el saldo de M3: lo acumulado');
select ok((select payouts_released_by = pruebas.finanzas() and payouts_released_at = now() and status = 'closed'
           from public.payout_periods where period_id = 202610), 'octubre queda liberado y cerrado: hay liquidaciones por pagar');
select results_eq(
  $$select pruebas.et(y.teacher_id), e.from_status::text, e.to_status::text from public.payout_status_events e
    join public.payouts y on y.id = e.payout_id where y.period_id = 202610 and e.from_status is not null order by 1$$,
  $$values ('M1', 'calculated', 'awaiting_invoice'), ('M2', 'calculated', 'awaiting_invoice'), ('M3', 'calculated', 'carried_forward')$$,
  'cada paso en su historia');
select is(pruebas.hace('private.release_payouts(202610)'), '{"outcome": "already_released", "period_id": 202610}'::jsonb,
  'liberar otra vez no escribe nada');
select is((select count(*)::integer from public.teacher_balance_entries), 1, 'ni otro renglón de saldo');

-- ---------------------------------------------------------------------------------------
-- Los bonos a mano, los del fundador y los ajustes.

select is(pruebas.o(pruebas.hace(format('private.capture_bonus(%L, %L, 1000, 202611, %L)', pruebas.id('M1'), 'founder', 'No.'))),
  'malformed', 'el del fundador no se captura a mano');
select is(pruebas.o(pruebas.hace(format('private.capture_bonus(%L, %L, 0, 202611, %L)', pruebas.id('M1'), 'discretionary', 'No.'))),
  'malformed', 'ni uno de 0');
select is(pruebas.o(pruebas.hace(format('private.capture_bonus(%L, %L, 1000, 202611, %L)', pruebas.id('M1'), 'discretionary', ''))),
  'malformed', 'ni sin motivo');
select is(pruebas.o(pruebas.hace(format('private.capture_bonus(%L, %L, 1000, 202611, %L)', pruebas.al(1), 'discretionary', 'No.'))),
  'no_teacher', 'ni a quien no es maestro');
select is(pruebas.o(pruebas.hace(format('private.capture_bonus(%L, %L, 1000, 202609, %L)', pruebas.id('M1'), 'discretionary', 'No.'))),
  'before_launch', 'ni antes del arranque');
create temporary table tardio as
  select pruebas.hace(format('private.capture_bonus(%L, %L, 2500, 202610, %L)', pruebas.id('M2'), 'discretionary', 'Un taller extra.')) as r;
select is((select format('%s %s %s', r ->> 'outcome', r ->> 'period_id', r ->> 'moved') from tardio), 'captured 202611 true',
  'un bono sobre un mes ya liberado va al siguiente (RF-508)');
select results_eq($$select status::text, created_by, decided_by, decided_at = now() from public.bonuses
                    where id = (select (r ->> 'bonus_id')::uuid from tardio)$$,
  $$values ('confirmed', pruebas.finanzas(), pruebas.finanzas(), true)$$, 'nace confirmado, a nombre de quien lo capturó');
select is(pruebas.o(pruebas.hace(format('private.confirm_founder_bonus(%L)', (select (r ->> 'bonus_id')::uuid from tardio)))),
  'not_founder', 'confirmar es solo del bono del fundador');
select is(pruebas.o(pruebas.hace(format('private.void_bonus(%L, %L)', (select (r ->> 'bonus_id')::uuid from tardio), 'Se capturó mal.'))),
  'voided', 'mientras su mes no se libere, se anula');
select results_eq($$select status::text, void_reason, voided_by from public.bonuses where id = (select (r ->> 'bonus_id')::uuid from tardio)$$,
  $$values ('void', 'Se capturó mal.', pruebas.finanzas())$$, 'con su motivo y quién');
select is(pruebas.o(pruebas.hace(format('private.void_bonus(%L, %L)', (select (r ->> 'bonus_id')::uuid from tardio), 'Otra vez.'))),
  'already_void', 'una vez');
select is(pruebas.o(pruebas.hace(format('private.void_bonus(%L, %L)', (select id from public.bonuses where period_id = 202610), 'Tarde.'))),
  'period_released', 'el de un mes liberado ya no: se corrige con un ajuste');
select is(pruebas.o(pruebas.hace(format('private.void_bonus(%L, %L)', gen_random_uuid(), 'No.'))), 'not_found', 'uno que no existe');
select is(pruebas.o(pruebas.hace(format('private.capture_adjustment(%L, 202611, -100, %L)', pruebas.id('M1'), 'No.'))),
  'origin_not_closed', 'un ajuste sale de un mes cerrado');
select is(pruebas.o(pruebas.hace(format('private.capture_adjustment(%L, 202610, 0, %L)', pruebas.id('M1'), 'No.'))),
  'malformed', 'y no es de 0');
select is(pruebas.o(pruebas.hace(format('private.capture_adjustment(%L, 202610, -100, %L, %L)', pruebas.id('M1'), 'No.', gen_random_uuid()))),
  'no_alert', 'ni con una alerta que no existe');
create temporary table ajuste as
  select pruebas.hace(format('private.capture_adjustment(%L, 202610, -30000, %L)', pruebas.id('M1'), 'Un fraude descubierto tarde.')) as r;
select is((select format('%s %s', r ->> 'outcome', r ->> 'applied_period_id') from ajuste), 'captured 202611',
  'un ajuste va al primer mes sin liberar después de su origen (RF-507)');
select results_eq($$select origin_period_id::integer, applied_period_id::integer, amount_cents, created_by from public.payout_adjustments$$,
  $$values (202610, 202611, -30000::bigint, pruebas.finanzas())$$, 'con su origen, a nombre de quien lo capturó');
select ok(exists (select 1 from public.audit_log where entity_table = 'public.payout_adjustments' and category = 'money'
                  and actor_id = pruebas.finanzas()), 'y auditado');

-- ---------------------------------------------------------------------------------------
-- Noviembre: sin consumo. M3 trae su saldo y M1 un ajuste en contra mayor que lo que recibe.

select pruebas.en_cierre(202611);
select is(pruebas.o(pruebas.cierra(202611)), 'closed', 'noviembre se cierra');
select is(pruebas.liq(202611),
  array['M1 calculated pool=0 bonos=0 ajustes=0 saldo=0 bruto=0', 'M3 calculated pool=0 bonos=0 ajustes=0 saldo=0 bruto=0'],
  'el cierre crea la liquidación de quien tiene algo pendiente, aunque no tenga reparto');
select pruebas.en_cierre(202612);
select is(pruebas.o(pruebas.cierra(202612)), 'closed', 'diciembre también');
select is(pruebas.hace('private.release_payouts(202612)'), '{"outcome": "previous_not_released", "period": 202611}'::jsonb,
  'liberar va en orden');
select is((select format('%s %s', r ->> 'outcome', r ->> 'period_status') from (select pruebas.hace('private.release_payouts(202611)') as r) x),
  'released paid', 'noviembre se libera, y como todas quedan acumuladas, pasa a pagado al instante');
select is(pruebas.liq(202611),
  array['M1 carried_forward pool=0 bonos=0 ajustes=-30000 saldo=0 bruto=-30000',
        'M3 carried_forward pool=0 bonos=0 ajustes=0 saldo=3852 bruto=3852'],
  'M3 sigue debajo del mínimo; M1 queda con saldo en contra');
select is(array[pruebas.saldo('M1'), pruebas.saldo('M3')], array[-30000::bigint, 3852::bigint], 'los saldos después');
select results_eq($$select kind::text, amount_cents from public.teacher_balance_entries where teacher_id = pruebas.id('M3') order by created_at, kind$$,
  $$values ('carried_forward', 3852::bigint), ('applied_to_payout', -3852::bigint), ('carried_forward', 3852::bigint)$$,
  'lo que se aplicó y lo que se volvió a acumular');
select ok((select paid_at = now() from public.payout_periods where period_id = 202611), 'con la hora en que se pagó');

-- ---------------------------------------------------------------------------------------
-- Diciembre: la frontera del mínimo, el saldo en contra que se descuenta, y retener.

select is(pruebas.o(pruebas.hace(format('private.capture_bonus(%L, %L, 10000, 202612, %L)', pruebas.id('M2'), 'discretionary', 'Exacto.'))),
  'captured', 'un bono de exactamente el mínimo para M2');
select is(pruebas.o(pruebas.hace(format('private.capture_bonus(%L, %L, 9999, 202612, %L)', pruebas.id('M4'), 'open_course', 'Un centavo menos.'))),
  'captured', 'uno de un centavo menos para M4');
select is(pruebas.o(pruebas.hace(format('private.capture_bonus(%L, %L, 30000, 202612, %L)', pruebas.id('M1'), 'discretionary', 'Lo compensa.'))),
  'captured', 'y uno para M1 que compensa su saldo en contra');
select is(pruebas.liq(202612)::text, array['M1 calculated pool=0 bonos=0 ajustes=0 saldo=0 bruto=0',
  'M2 calculated pool=0 bonos=0 ajustes=0 saldo=0 bruto=0', 'M3 calculated pool=0 bonos=0 ajustes=0 saldo=0 bruto=0',
  'M4 calculated pool=0 bonos=0 ajustes=0 saldo=0 bruto=0']::text,
  'un bono sobre un mes cerrado le da su liquidación al maestro que no la tenía');
select is(pruebas.o(pruebas.hace(format('private.hold_payout(%L, %L)', pruebas.y('M4', 202612), ''))), 'malformed', 'retener pide motivo');
select is(pruebas.o(pruebas.hace(format('private.hold_payout(%L, %L, %L)', pruebas.y('M4', 202612), 'Revisión.', gen_random_uuid()))),
  'no_alert', 'y una alerta que exista');
select is(pruebas.hace(format('private.hold_payout(%L, %L)', pruebas.y('M4', 202612), 'Se investiga.')),
  '{"outcome": "held", "from": "calculated"}'::jsonb, 'se retiene una calculada');
select is(pruebas.o(pruebas.hace(format('private.hold_payout(%L, %L)', pruebas.y('M4', 202612), 'Otra vez.'))), 'already_held', 'una vez');
select is(pruebas.hace(format('private.hold_payout(%L, %L)', pruebas.y('M3', 202611), 'No.')),
  '{"outcome": "not_holdable", "status": "carried_forward"}'::jsonb, 'una acumulada no se retiene');
select is(pruebas.o(pruebas.hace(format('private.unhold_payout(%L, %L)', pruebas.y('M1', 202612), 'No.'))), 'not_held',
  'ni se suelta una que no está retenida');
select is(pruebas.o(pruebas.hace(format('private.hold_payout(%L, %L)', gen_random_uuid(), 'No.'))), 'not_found', 'ni una que no existe');
select is(pruebas.hace('private.release_payouts(202612)'),
  '{"outcome": "released", "period_id": 202612, "released": 3, "awaiting_invoice": 1, "carried_forward": 2, "held": 1, "period_status": "closed"}'::jsonb,
  'diciembre se libera sin tocar la retenida');
select is(pruebas.liq(202612),
  array['M1 carried_forward pool=0 bonos=30000 ajustes=0 saldo=-30000 bruto=0',
        'M2 awaiting_invoice pool=0 bonos=10000 ajustes=0 saldo=0 bruto=10000',
        'M3 carried_forward pool=0 bonos=0 ajustes=0 saldo=3852 bruto=3852',
        'M4 on_hold pool=0 bonos=0 ajustes=0 saldo=0 bruto=0'],
  'exactamente el mínimo se paga; el saldo en contra se descuenta del bono');
select is(pruebas.saldo('M1'), 0::bigint, 'M1 queda en 0, sin renglón acumulado de 0');
select is(pruebas.hace(format('private.unhold_payout(%L, %L)', pruebas.y('M4', 202612), 'No era fraude.')),
  '{"outcome": "released_from_hold", "to": "carried_forward", "period_status": "closed"}'::jsonb,
  'soltar una retenida desde calculada en un mes liberado la libera ahí mismo: un centavo menos que el mínimo, acumulada');
select results_eq(
  $$select e.from_status::text, e.to_status::text, e.note from public.payout_status_events e
    where e.payout_id = pruebas.y('M4', 202612) and e.from_status is not null order by e.occurred_at$$,
  $$values ('calculated', 'on_hold', 'Se investiga.'), ('on_hold', 'calculated', 'No era fraude.'), ('calculated', 'carried_forward', null)$$,
  'su historia: retenida, de vuelta a calculada y liberada');
select is(pruebas.hace(format('private.hold_payout(%L, %L)', pruebas.y('M2', 202612), 'Revisión de su factura.')),
  '{"outcome": "held", "from": "awaiting_invoice"}'::jsonb, 'una en espera de factura también se retiene');
select is(pruebas.o(pruebas.hace('private.release_payouts(202612)')), 'already_released', '(liberar no la toca)');
select is(pruebas.hace(format('private.unhold_payout(%L, %L)', pruebas.y('M2', 202612), 'Todo en orden.')),
  '{"outcome": "released_from_hold", "to": "awaiting_invoice", "period_status": "closed"}'::jsonb,
  'y vuelve a donde estaba');
select is(pruebas.estado(202612), 'closed', 'diciembre sigue cerrado: M2 espera su factura (T-604)');
select is(pruebas.o(pruebas.hace(format('private.capture_bonus(%L, %L, 1000, 202612, %L)', pruebas.id('M2'), 'discretionary', 'Tarde.'))),
  'captured', 'un bono a un mes liberado');
select is((select period_id::integer from public.bonuses where reason = 'Tarde.'), 202701, 'va al siguiente, y le abre la fila');

-- ---------------------------------------------------------------------------------------
-- El ensayo estima las liquidaciones (FL-50, paso 4).

select pruebas.en_cierre(202701);
create temporary table ensayo as select pruebas.hace('private.rehearse_close(202701)') as r;
select is((select array_agg(pruebas.et(x::uuid) order by pruebas.et(x::uuid)) from ensayo, jsonb_array_elements_text(r -> 'below_minimum') x),
  array['M2', 'M3', 'M4'], 'el ensayo dice quién quedaría debajo del mínimo (M4 con lo acumulado de su retenida)');
select is((select e from public.close_runs c, jsonb_array_elements(c.payout_preview) e
           where c.id = (select (r ->> 'run_id')::uuid from ensayo) and e ->> 'teacher_id' = pruebas.id('M2')::text),
  jsonb_build_object('teacher_id', pruebas.id('M2'), 'pool_cents', 0, 'founder_bonus_cents', 0, 'bonuses_cents', 1000,
                     'adjustments_cents', 0, 'balance_cents', 0, 'estimate_cents', 1000, 'below_minimum', true),
  'y por qué, con el saldo de ahora');

-- ---------------------------------------------------------------------------------------
-- Los guardianes.

select pruebas.como_finanzas();
select throws_ok($$update public.payouts set status = 'invoice_in_review' where id = pruebas.y('M2', 202612)$$,
  '23514', null, 'la factura llega con T-604');
select throws_ok($$update public.payouts set bonuses_cents = 1, subtotal_cents = subtotal_cents + 1, net_cents = net_cents + 1
                   where id = pruebas.y('M2', 202612)$$, '23514', null, 'lo liberado no cambia de monto');
select throws_ok($$update public.payout_periods set status = 'paid' where period_id = 202612$$, '23514', null,
  'un periodo con liquidaciones por pagar no pasa a pagado');
select throws_ok($$update public.payout_periods set payouts_released_at = null, payouts_released_by = null where period_id = 202612$$,
  '23514', null, 'la liberación no se deshace');
select throws_ok($$update public.payout_periods set paid_at = now() + interval '1 day' where period_id = 202611$$, '23514', null,
  'un periodo pagado no cambia');
select throws_ok($$update public.payout_adjustments set amount_cents = 1$$, '42501', null, 'un ajuste no se edita');
select throws_ok($$delete from public.teacher_balance_entries$$, '42501', null, 'ni el saldo se borra');
select throws_ok($$insert into public.teacher_balance_entries (teacher_id, payout_id, period_id, kind, amount_cents)
                   values (pruebas.id('M3'), pruebas.y('M3', 202612), 202612, 'paid_on_exit', 3852)$$, '23514', null,
  'pagar el saldo al salir llega con la baja del maestro');
select throws_ok($$update public.bonuses set status = 'void', void_reason = 'No.', voided_by = pruebas.finanzas(), voided_at = now()
                   where reason = 'Lo compensa.'$$, '55000', null, 'un bono de un mes liberado no cambia');
select throws_ok($$insert into public.bonuses (teacher_id, period_id, kind, amount_cents, reason)
                   values (pruebas.id('M1'), 202612, 'discretionary', 100, 'A mano.')$$, '55000', null,
  'ni nace a mano en un mes liberado');
select throws_ok($$insert into public.payout_adjustments (teacher_id, origin_period_id, applied_period_id, amount_cents, reason)
                   values (pruebas.id('M1'), 202701, 202702, 100, 'A mano.')$$, '55000', null,
  'un ajuste sale de un mes cerrado');
select throws_ok($$insert into public.teacher_balance_entries (teacher_id, payout_id, period_id, kind, amount_cents)
                   values (pruebas.id('M1'), pruebas.y('M3', 202612), 202612, 'carried_forward', 1)$$, '23514', null,
  'y un renglón del saldo es de su liquidación');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- La comprobación al confirmar de cada liberación (05 §8.6).

select pruebas.abierto(202702);
select pruebas.como_finanzas();
select private.capture_bonus(pruebas.id('M4'), 'discretionary', 20000, 202701, 'Para descuadrar.');
select pruebas.como_dueno();
select pruebas.como_finanzas();
select private.close_period(202701);
set constraints payout_periods_balanced immediate;
set constraints payout_periods_balanced deferred;
select pruebas.como_dueno();
select throws_ok($$select pruebas.descuadra(202701, null)$$, 'P0002', 'cuadra', 'una liberación sin tocar cuadra');
select throws_like($$select pruebas.descuadra(202701, $s$update public.payouts set bonuses_cents = bonuses_cents + 1,
                     subtotal_cents = subtotal_cents + 1, net_cents = net_cents + 1 where id = pruebas.y('M4', 202701)$s$)$$,
  '%bonuses%', 'una liquidación con otros bonos que los confirmados');
select throws_like($$select pruebas.descuadra(202701, $s$update public.payouts set status = 'carried_forward' where id = pruebas.y('M4', 202701)$s$)$$,
  '%minimum%', 'una que llega al mínimo y se acumula');
select throws_like($$select pruebas.descuadra(202701, $s$update public.teacher_balance_entries set amount_cents = amount_cents + 1
                     where payout_id = pruebas.y('M3', 202701) and kind = 'carried_forward'$s$)$$,
  '%balance%', 'un saldo acumulado que no es el bruto');
select throws_like($$select pruebas.descuadra(202701, $s$delete from public.teacher_balance_entries
                     where payout_id = pruebas.y('M3', 202701) and kind = 'applied_to_payout'$s$)$$,
  '%balance%', 'un saldo aplicado sin su renglón');
select is(pruebas.estado(202701), 'closed', 'nada de eso quedó');

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is_empty($$select * from private.schema_violations_payouts()$$, 'en orden');
select pruebas.como_dueno_sistema();
grant execute on function private.release_payouts(public.period_id) to app_service;
select results_eq($$select problem, object_name like 'private.release_payouts(%' from private.schema_violations_payouts()$$,
  $$values ('payouts function executable by app_service', true)$$, 'liberar al alcance del servidor');
revoke execute on function private.release_payouts(public.period_id) from app_service;
alter function private.release_payouts(public.period_id) security invoker;
select results_eq($$select problem, object_name like 'private.release_payouts(%' from private.schema_violations_payouts()$$,
  $$values ('payouts function not security definer', true)$$, 'liberar sin correr como el dueño');
alter function private.release_payouts(public.period_id) security definer;
drop trigger payouts_released on public.payouts;
create constraint trigger payouts_released after update of released_at on public.payouts
  not deferrable for each row when (old.released_at is null and new.released_at is not null)
  execute function private.check_payout_released();
select results_eq($$select problem, object_name from private.schema_violations_payouts()$$,
  $$values ('payouts trigger not deferred: payouts_released', 'public.payouts')$$, 'la comprobación de lo liberado sin diferir');
drop trigger payouts_released on public.payouts;
create constraint trigger payouts_released after update of released_at on public.payouts
  deferrable initially deferred for each row when (old.released_at is null and new.released_at is not null)
  execute function private.check_payout_released();
select is_empty($$select * from private.schema_violations_payouts()$$, 'y todo en su lugar otra vez');
select pruebas.como_dueno();

select * from finish();
rollback;
