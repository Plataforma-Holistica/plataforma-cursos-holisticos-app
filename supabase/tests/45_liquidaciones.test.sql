-- T-603 · Las liquidaciones y el bono del fundador, al cerrar (RF-505, RF-508, RN-12; 05 §5.5, §7.3, §8.6
-- y §8.7). Primera de dos solicitudes; la segunda libera. Decisiones de Sergio del 2026-10-25: el bono
-- del fundador es el piso del total del periodo por el multiplicador menos uno, durante 24 periodos
-- desde el que contiene `founder_since`, aunque esté suspendido o se haya ido; sin fila si da 0; y
-- entra a la huella del ensayo.
--
-- Octubre de 2026 es el ejemplo del PRD, con M3 fundador desde ese mes: 33.50 y un bono de 5.02. El
-- estado en cierre se fuerza con el guardián apagado; la comprobación al confirmar la adelanta
-- `pruebas.cierra()`, como en `43_cierre`.
begin;
\ir _ayuda.psql
select plan(86);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a6030000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b6030000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.maestra(p_n integer) returns uuid language sql immutable
as $$ select ('b6030000-0000-0000-0000-' || lpad((10 + p_n)::text, 12, '0'))::uuid $$;
create table pruebas.etiquetas (id uuid primary key, et text not null);
create function pruebas.et(p_id uuid) returns text language sql stable as $$ select et from pruebas.etiquetas where id = p_id $$;
create function pruebas.id(p_et text) returns uuid language sql stable as $$ select id from pruebas.etiquetas where et = p_et $$;

create function pruebas.como_finanzas() returns void language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', pruebas.finanzas()::text, true),
         set_config('app.actor_session', pruebas.sesion(pruebas.finanzas())::text, true);
$$;
create function pruebas.ensaya(p_period integer) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  v := private.rehearse_close(p_period);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.cierra(p_period integer) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  v := private.close_period(p_period);
  set constraints payout_periods_balanced immediate;
  set constraints payout_periods_balanced deferred;
  perform pruebas.limpiar();
  return v;
end
$$;
-- Cierra, cambia lo escrito con la sesión en réplica y adelanta la comprobación; si cuadra, lanza P0002
-- para deshacerlo todo (como en `43_cierre`). Con un rol, confirma como ese rol.
create function pruebas.descuadra(p_period integer, p_sql text, p_role text default null) returns void language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  v := private.close_period(p_period);
  if v ->> 'outcome' <> 'closed' then
    raise exception 'no cerró: %', v;
  end if;
  if p_sql is not null then
    set local session_replication_role = replica;
    execute p_sql;
    set local session_replication_role = origin;
  end if;
  if p_role is not null then
    perform set_config('role', p_role, true);
  end if;
  set constraints payout_periods_balanced immediate;
  perform set_config('role', 'none', true);
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
-- Un parámetro del reparto como el dueño (la semilla, una corrección a mano): exento de RF-707 por
-- instante. Cancelarlo, también como el dueño.
create function pruebas.parametro(p_key text, p_value jsonb, p_period integer) returns uuid language sql as $$
  select pruebas.como_dueno_sistema();
  insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
  values (p_key, p_value, 'decided', now() - interval '1 second', p_period) returning id;
$$;
create function pruebas.cancela(p_id uuid) returns void language sql as $$
  select pruebas.como_dueno_sistema();
  update public.business_parameters set canceled_at = now() where id = p_id;
  select pruebas.como_dueno();
$$;
create function pruebas.cobra(p_n integer, p_at timestamptz, p_gross bigint) returns text language sql as $$
  select private.record_charge(pruebas.al(p_n), ('c6030000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid, 'manual',
                               'cobro-liq-' || p_n || '-' || p_gross, null,
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
create function pruebas.corrida(p_period integer, p_started interval) returns void language sql as $$
  insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
  values ('nightly_rollup', p_period, 'succeeded', now() + p_started, now() + p_started, now() + p_started + interval '1 minute',
          '{"mode": "full"}'::jsonb)
$$;
-- Las líneas de un maestro, para la función pura del bono: una parte por cada total.
create function pruebas.lineas(p_totals jsonb) returns private.payout_line[] language sql immutable as $$
  select array(select row('share', 'a6030000-0000-0000-0000-000000000099'::uuid, (e.key)::uuid, 1, (e.value)::bigint, null, 1)::private.payout_line
               from jsonb_each_text(p_totals) e order by e.key)
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

delete from public.job_runs where period_id between 202609 and 202712;

-- Las cuentas: cuatro alumnos del ejemplo y finanzas.
select pruebas.alta(pruebas.al(n), format('alumno%s-liq@prueba.test', n)) from generate_series(1, 4) n;
insert into pruebas.etiquetas select pruebas.al(n), (array['A', 'B', 'C', 'D'])[n] from generate_series(1, 4) n;
select pruebas.alta(pruebas.finanzas(), 'finanzas-liq@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-liq@prueba.test';
select pruebas.dar_capacidad(pruebas.finanzas(), 'finance');
select pruebas.equipar(pruebas.finanzas());

-- Los maestros, en este orden (decide el empate del ejemplo 3), y M4, sin consumo.
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra ' || s, 'maestra-' || s, null), pruebas.curso(s))
from unnest(array['liq-m1', 'liq-m2', 'liq-m3', 'liq-m4']) with ordinality as x (s, n) order by n;
select pruebas.como_dueno();
insert into pruebas.etiquetas select teacher_id, 'M' || right(slug, 1) from public.published_courses where slug like 'liq-m%';

-- M3 es fundador desde octubre de 2026.
select pruebas.como_dueno_sistema();
update public.teachers set is_founder = true, founder_since = '2026-10-01' where id = pruebas.id('M3');
select pruebas.como_dueno();

-- Los cobros y el consolidado del ejemplo (05 §8.7), como en `43_cierre`.
select pruebas.abierto(202610);
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
select ('c6030000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, pruebas.al(n), 'manual', 'sus-liq-' || n,
       case when n = 3 then 'annual' else 'monthly' end::public.subscription_plan, 'pending', 'MXN'
from generate_series(1, 4) n;
select is(array[pruebas.cobra(1, '2026-10-05 12:00-06', 34900), pruebas.cobra(2, '2026-10-06 12:00-06', 34900),
                pruebas.cobra(3, '2026-10-07 12:00-06', 299000), pruebas.cobra(4, '2026-10-08 12:00-06', 34900)],
  array['recorded', 'recorded', 'recorded', 'recorded'], 'los cuatro cobros del ejemplo');
select pruebas.fila(202610, pruebas.al(1), 'liq-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres', 'Cuatro']) t;
select pruebas.fila(202610, pruebas.al(1), 'liq-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(1), 'liq-m2', 'Dos', 2),
       pruebas.fila(202610, pruebas.al(1), 'liq-m2', 'Tres', 1);
select pruebas.fila(202610, pruebas.al(2), 'liq-m2', 'Uno', 1);
select pruebas.fila(202610, pruebas.al(3), 'liq-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres']) t;
select pruebas.fila(202610, pruebas.al(3), 'liq-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(3), 'liq-m3', 'Uno', 2);

-- ---------------------------------------------------------------------------------------
-- Las piezas.

select has_table('public', 'payouts', 'las liquidaciones');
select has_table('public', 'payout_status_events', 'su historia');
select has_table('public', 'bonuses', 'los bonos');
select enum_has_labels('public', 'payout_status', array['calculated', 'awaiting_invoice', 'invoice_in_review', 'invoice_rejected',
  'ready_to_pay', 'paid', 'carried_forward', 'on_hold', 'payment_returned'], 'los nueve estados de RF-505');
select enum_has_labels('public', 'bonus_kind', array['founder', 'open_course', 'discretionary'], 'los tipos de bono');
select enum_has_labels('public', 'bonus_status', array['proposed', 'confirmed', 'void'], 'y sus estados');
select has_column('public', 'close_run_teacher_totals', 'founder_bonus_cents', 'el ensayo dice el bono del fundador');
select is((select count(*)::integer from information_schema.role_table_grants
           where table_schema = 'public' and table_name in ('payouts', 'payout_status_events', 'bonuses')
             and grantee in ('anon', 'authenticated', 'service_role', 'app_service', 'PUBLIC')), 0,
  'nadie de la aplicación toca las liquidaciones todavía (T-604, T-605)');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relrowsecurity and c.relname in ('payouts', 'payout_status_events', 'bonuses')), 3,
  'y las tres tienen RLS');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.prosecdef
             and p.proname in ('founder_bonus', 'close_founder_bonuses', 'guard_payout', 'guard_bonus', 'log_payout_status')),
  null, 'ninguna función nueva corre como el dueño');

-- ---------------------------------------------------------------------------------------
-- El bono del fundador, la función pura (RN-12).

select is(private.founder_bonus(3350, '2026-10-01', 202610, '{"multiplier": "1.15", "months": 24}')::text, '(1500,502)',
  'el del ejemplo: 15 % de 33.50 son 5.025, hacia abajo 5.02');
select is((private.founder_bonus(3350, '2024-11-30', 202610, '{"multiplier": "1.15", "months": 24}')).amount_cents, 502::bigint,
  'el periodo 24, contando el de founder_since, todavía cuenta');
select is((private.founder_bonus(3350, '2024-10-31', 202610, '{"multiplier": "1.15", "months": 24}')).amount_cents, 0::bigint,
  'el 25 ya no');
select is((private.founder_bonus(3350, '2026-11-01', 202610, '{"multiplier": "1.15", "months": 24}')).amount_cents, 0::bigint,
  'ni un periodo antes de ser fundador');
select is((private.founder_bonus(6, '2026-10-01', 202610, '{"multiplier": "1.15", "months": 24}')).amount_cents, 0::bigint,
  'seis centavos dan 0.9: hacia abajo, nada');
select is((private.founder_bonus(1000000, '2026-10-01', 202610, '{"multiplier": "1", "months": 24}')).amount_cents, 0::bigint,
  'con multiplicador 1 no hay ventaja');
select is((private.founder_bonus(1000000, '2026-10-01', 202610, '{"multiplier": "1.0001", "months": 24}')).amount_cents, 100::bigint,
  'el multiplicador más chico que cabe en puntos base');
select throws_ok($$select private.founder_bonus(3350, '2026-10-01', 202610, '{"multiplier": "1.15005", "months": 24}')$$,
  'P0001', null, 'un multiplicador que no cabe en puntos base no se redondea: lanza');
select throws_ok($$select private.founder_bonus(3350, '2026-10-01', 202610, null)$$, 'P0001', null,
  'sin la regla, un fundador no se adivina: lanza');
select throws_ok($$select private.founder_bonus(3350, '2026-10-01', 202610, '{"multiplier": "0.9", "months": 24}')$$, 'P0001', null,
  'un multiplicador menor que 1 tampoco');
select results_eq(
  format($$select teacher_id, basis_cents, multiplier_bps, amount_cents
           from private.close_founder_bonuses(pruebas.lineas('{"%s": 3350, "%s": 24494, "%s": 6}'),
                  '[{"teacher_id": "%s", "founder_since": "2026-10-01"}, {"teacher_id": "%s", "founder_since": "2026-10-01"},
                    {"teacher_id": "%s", "founder_since": "2026-10-01"}]', '{"multiplier": "1.15", "months": 24}', 202610)$$,
         pruebas.id('M3'), pruebas.id('M1'), pruebas.id('M2'), pruebas.id('M3'), pruebas.id('M4'), pruebas.id('M2')),
  format($$values ('%s'::uuid, 3350::bigint, 1500, 502::bigint)$$, pruebas.id('M3')),
  'de las líneas: solo el fundador con total y bono; ni el que no es fundador, ni el que redondea a 0, ni el fundador sin partes');
select is_empty($$select * from private.close_founder_bonuses(pruebas.lineas('{"a6030000-0000-0000-0000-000000000001": 3350}'), '[]', null, 202610)$$,
  'sin fundadores no hace falta la regla');

-- ---------------------------------------------------------------------------------------
-- El ensayo dice el bono, y la huella lo cubre.

select pruebas.en_cierre(202610);
select pruebas.corrida(202610, '-3 minutes');
create temporary table ensayo as select pruebas.ensaya(202610) as r;
select is((select pruebas.o(r) || ' ' || (r ->> 'period_status_at_run') from ensayo), 'rehearsed closing', 'octubre se ensaya en cierre');
select is((select (r ->> 'founder_bonus_cents')::bigint from ensayo), 502::bigint, 'el ensayo dice el bono del fundador');
select is((select r -> 'founder_bonuses' from ensayo),
  jsonb_build_array(jsonb_build_object('teacher_id', pruebas.id('M3'), 'basis_cents', 3350, 'amount_cents', 502)),
  'de quién y sobre qué');
select results_eq(
  $$select pruebas.et(teacher_id), total_cents, founder_bonus_cents from public.close_run_teacher_totals
    where close_run_id = (select (r ->> 'run_id')::uuid from ensayo) order by 1$$,
  $$values ('M1', 24494::bigint, 0::bigint), ('M2', 35843::bigint, 0::bigint), ('M3', 3350::bigint, 502::bigint)$$,
  'lo que finanzas ve: el total y el bono de cada maestro');
select is((select parameters - 'tiers' - 'BOTE_REGLA_TRAMO' - 'BOTE_SIN_CONSUMO' - 'active_students' from public.close_runs
           where id = (select (r ->> 'run_id')::uuid from ensayo)),
  jsonb_build_object('FUNDADOR_MULTIPLICADOR', '{"months": 24, "multiplier": "1.15"}'::jsonb,
                     'founders', jsonb_build_array(jsonb_build_object('teacher_id', pruebas.id('M3'), 'founder_since', '2026-10-01'))),
  'la regla del fundador y los fundadores entran a los parámetros de la corrida');
-- Un fundador suspendido o que se fue sigue en la lista: lo cobra igual.
select pruebas.alta(pruebas.maestra(4), 'maestra4-liq@prueba.test');
select pruebas.como_dueno_sistema();
update public.teachers set profile_id = pruebas.maestra(4), is_founder = true, founder_since = '2025-01-01',
       status = 'left', left_at = now() where id = pruebas.id('M4');
select pruebas.como_dueno();
select is(jsonb_array_length((private.close_input(202610)).parameters -> 'founders'), 2, 'un fundador que se fue sigue contando');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', left_at = null, suspended_at = now(), suspension_reason = 'Prueba.'
where id = pruebas.id('M4');
select pruebas.como_dueno();
select is(jsonb_array_length((private.close_input(202610)).parameters -> 'founders'), 2, 'y uno suspendido también');
select is(pruebas.o(pruebas.cierra(202610)), 'rehearsal_stale', 'un fundador nuevo deja viejo el ensayo');
select pruebas.como_dueno_sistema();
update public.teachers set is_founder = false, founder_since = null where id = pruebas.id('M4');
update public.teachers set founder_since = '2026-09-01' where id = pruebas.id('M3');
select pruebas.como_dueno();
select is(pruebas.o(pruebas.cierra(202610)), 'rehearsal_stale', 'y otra fecha de fundador');
select pruebas.como_dueno_sistema();
update public.teachers set founder_since = '2026-10-01' where id = pruebas.id('M3');
select pruebas.como_dueno();
create temporary table otra_regla as select pruebas.parametro('FUNDADOR_MULTIPLICADOR', '{"multiplier": "1.2", "months": 24}', 202610) as id;
select is(pruebas.o(pruebas.cierra(202610)), 'rehearsal_stale', 'y otra regla del fundador');
select pruebas.cancela((select id from otra_regla));
create temporary table mala_regla as select pruebas.parametro('FUNDADOR_MULTIPLICADOR', '{"multiplier": "1.15005", "months": 24}', 202610) as id;
create temporary table ensayo_fallido as select pruebas.ensaya(202610) as r;
select is((select pruebas.o(r) from ensayo_fallido), 'failed', 'una regla que no cabe en puntos base deja el ensayo fallido');
select ok((select r ->> 'error' like 'P0001: %' from ensayo_fallido), 'con su error');
select pruebas.cancela((select id from mala_regla));

-- ---------------------------------------------------------------------------------------
-- La comprobación al confirmar: las liquidaciones y el bono (05 §8.6, 9 y 10).

select throws_ok($$select pruebas.descuadra(202610, null)$$, 'P0002', 'cuadra', 'un cierre sin tocar cuadra');
select throws_ok($$select pruebas.descuadra(202610, null, 'app_service')$$, 'P0002', 'cuadra',
  'y cuadra aunque confirme el servidor, que no lee las liquidaciones: la comprobación corre como el dueño');
select throws_like($$select pruebas.descuadra(202610, $s$delete from public.payouts where period_id = 202610
                                                         and teacher_id = pruebas.id('M1')$s$)$$,
  '%without a matching payout%', 'un maestro con total y sin liquidación');
select throws_like($$select pruebas.descuadra(202610, $s$update public.payouts set pool_cents = pool_cents + 1, subtotal_cents = subtotal_cents + 1,
                                                         net_cents = net_cents + 1 where period_id = 202610 and teacher_id = pruebas.id('M1')$s$)$$,
  '%without a matching payout%', 'una liquidación que no es su total');
select throws_like($$select pruebas.descuadra(202610, $s$update public.payouts set close_run_id = (select id from public.close_runs
                                                           where period_id = 202610 and kind = 'rehearsal' limit 1)
                                                         where period_id = 202610 and teacher_id = pruebas.id('M2')$s$)$$,
  '%without a matching payout%', 'una liquidación con otra corrida');
select throws_like($$select pruebas.descuadra(202610, $s$insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, subtotal_cents, net_cents)
                                                         select 202610, pruebas.id('M4'), close_run_id, 0, 0, 0
                                                         from public.payout_periods where period_id = 202610$s$)$$,
  '%payouts without a teacher total%', 'una liquidación de quien no tiene total');
select throws_like($$select pruebas.descuadra(202610, $s$update public.bonuses set amount_cents = amount_cents + 1
                                                         where period_id = 202610$s$)$$,
  '%founder bonuses%', 'un bono que no es el piso del total');
select throws_like($$select pruebas.descuadra(202610, $s$delete from public.bonuses where period_id = 202610$s$)$$,
  '%founder bonuses%', 'un fundador sin su bono');
select throws_like($$select pruebas.descuadra(202610, $s$insert into public.bonuses (teacher_id, period_id, kind, amount_cents, basis_cents,
                                                                                    multiplier_bps, close_run_id)
                                                         select pruebas.id('M1'), 202610, 'founder', 3674, 24494, 1500, close_run_id
                                                         from public.payout_periods where period_id = 202610$s$)$$,
  '%founder bonuses%', 'un bono de quien no es fundador');
select throws_like($$select pruebas.descuadra(202610, $s$update public.bonuses set status = 'confirmed', decided_at = now(),
                                                         decided_by = pruebas.finanzas() where period_id = 202610$s$)$$,
  '%founder bonuses%', 'un bono que nace confirmado');
select throws_like($$select pruebas.descuadra(202610, $s$update public.close_run_teacher_totals set founder_bonus_cents = 0
                                                         where close_run_id = (select close_run_id from public.payout_periods
                                                                               where period_id = 202610)$s$)$$,
  '%close run founder bonus%', 'la corrida del cierre que dice otro bono');
select is((select count(*)::integer from public.payouts where period_id = 202610), 0, 'nada de eso quedó');

-- ---------------------------------------------------------------------------------------
-- El cierre del ejemplo.

create temporary table cierre as select pruebas.cierra(202610) as r;
select is((select pruebas.o(r) from cierre), 'closed', 'octubre se cierra');
select is((select format('liquidaciones=%s bono=%s', r ->> 'payouts', r ->> 'founder_bonus_cents') from cierre), 'liquidaciones=3 bono=502',
  'con tres liquidaciones y el bono del fundador');
select results_eq(
  $$select pruebas.et(teacher_id), status::text, pool_cents, bonuses_cents, adjustments_cents, balance_applied_cents, subtotal_cents,
           vat_cents, income_tax_withheld_cents, vat_withheld_cents, net_cents
    from public.payouts where period_id = 202610 order by 1$$,
  $$values ('M1', 'calculated', 24494::bigint, 0::bigint, 0::bigint, 0::bigint, 24494::bigint, 0::bigint, 0::bigint, 0::bigint, 24494::bigint),
           ('M2', 'calculated', 35843::bigint, 0::bigint, 0::bigint, 0::bigint, 35843::bigint, 0::bigint, 0::bigint, 0::bigint, 35843::bigint),
           ('M3', 'calculated', 3350::bigint, 0::bigint, 0::bigint, 0::bigint, 3350::bigint, 0::bigint, 0::bigint, 0::bigint, 3350::bigint)$$,
  'una liquidación por maestro, calculada, con lo que le tocó del bote (05 §8.7)');
select ok((select bool_and(close_run_id = (select (r ->> 'close_run_id')::uuid from cierre) and released_at is null
                           and released_by is null and held_from_status is null)
           from public.payouts where period_id = 202610), 'con la corrida del cierre, sin liberar ni retener');
select results_eq(
  $$select pruebas.et(y.teacher_id), e.from_status::text, e.to_status::text, e.actor_id from public.payout_status_events e
    join public.payouts y on y.id = e.payout_id where y.period_id = 202610 order by 1$$,
  $$values ('M1', null, 'calculated', pruebas.finanzas()), ('M2', null, 'calculated', pruebas.finanzas()),
           ('M3', null, 'calculated', pruebas.finanzas())$$,
  'cada una con su primer renglón de historia, a nombre de quien cerró');
select is((select count(*)::integer from public.audit_log where entity_table = 'public.payouts' and action = 'payouts.insert'
           and category = 'money' and actor_id = pruebas.finanzas()), 3, 'las liquidaciones se auditan como dinero');
select results_eq(
  $$select pruebas.et(teacher_id), kind::text, status::text, basis_cents, multiplier_bps, amount_cents, created_by, reason,
           decided_at, voided_at
    from public.bonuses where period_id = 202610$$,
  $$values ('M3', 'founder', 'proposed', 3350::bigint, 1500, 502::bigint, null::uuid, null::text, null::timestamptz, null::timestamptz)$$,
  'el bono de M3: propuesto, sobre sus 33.50, 5.02 (05 §8.7)');
select is((select close_run_id from public.bonuses where period_id = 202610), (select (r ->> 'close_run_id')::uuid from cierre),
  'calculado por el cierre');
select is((select count(*)::integer from public.audit_log where entity_table = 'public.bonuses' and action = 'bonuses.insert'
           and category = 'money'), 1, 'y auditado');
select results_eq(
  $$select pruebas.et(teacher_id), founder_bonus_cents from public.close_run_teacher_totals
    where close_run_id = (select (r ->> 'close_run_id')::uuid from cierre) order by 1$$,
  $$values ('M1', 0::bigint), ('M2', 0::bigint), ('M3', 502::bigint)$$, 'la corrida del cierre dice el mismo bono');
select is((select encode(input_hash, 'hex') from public.close_runs where id = (select (r ->> 'close_run_id')::uuid from cierre)),
  (select r ->> 'input_hash' from ensayo), 'con la misma huella que el ensayo');
select is(pruebas.cierra(202610) ->> 'outcome', 'already_closed', 'cerrar otra vez no crea otras liquidaciones');
select is((select count(*)::integer from public.payouts where period_id = 202610), 3, 'siguen siendo tres');

-- ---------------------------------------------------------------------------------------
-- Lo que no cambia todavía: liberar llega con la segunda solicitud.

select throws_ok($$update public.payouts set status = 'awaiting_invoice', released_at = now(), released_by = pruebas.finanzas()
                   where period_id = 202610 and teacher_id = pruebas.id('M1')$$,
  '23514', null, 'ni el dueño libera una liquidación todavía');
select throws_ok($$update public.payouts set pool_cents = 0, subtotal_cents = 0, net_cents = 0 where period_id = 202610$$,
  '23514', null, 'ni le cambia el monto');
select throws_ok($$delete from public.payouts where period_id = 202610$$, '42501', null, 'una liquidación no se borra');
select throws_ok($$truncate public.payouts cascade$$, '42501', null, 'ni se vacían');
select throws_ok($$update public.payout_status_events set note = 'otra'$$, '42501', null, 'la historia no se edita');
select throws_ok($$delete from public.payout_status_events$$, '42501', null, 'ni se borra');
select throws_ok($$update public.bonuses set status = 'confirmed', decided_at = now(), decided_by = pruebas.finanzas()
                   where period_id = 202610$$, '23514', null, 'confirmar el bono llega con la segunda solicitud');
select throws_ok($$delete from public.bonuses where period_id = 202610$$, '42501', null, 'un bono no se borra');
select throws_ok($$truncate public.bonuses$$, '42501', null, 'ni se vacían');
select throws_ok($$insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, subtotal_cents, net_cents)
                   values (202610, pruebas.id('M4'), (select close_run_id from public.payout_periods where period_id = 202610), 0, 0, 0)$$,
  '55000', null, 'ni entra una liquidación a un periodo que no está en cierre');
select throws_ok($$insert into public.bonuses (teacher_id, period_id, kind, amount_cents, reason, created_by)
                   values (pruebas.id('M1'), 202610, 'discretionary', 1000, 'Prueba.', pruebas.finanzas())$$,
  '23514', null, 'ni un bono a mano, todavía');
-- El guardián revisa antes que el periodo: lo que pide al nacer, aunque el periodo sí estuviera en cierre.
select throws_ok($$insert into public.payouts (period_id, teacher_id, close_run_id, status, pool_cents, subtotal_cents, net_cents,
                                               released_at, released_by)
                   values (202610, pruebas.id('M4'), (select close_run_id from public.payout_periods where period_id = 202610),
                           'awaiting_invoice', 100, 100, 100, now(), pruebas.finanzas())$$,
  '23514', null, 'una liquidación no nace liberada');
select throws_ok($$insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, bonuses_cents, subtotal_cents, net_cents)
                   values (202610, pruebas.id('M4'), (select close_run_id from public.payout_periods where period_id = 202610), 100, 50, 150, 150)$$,
  '23514', null, 'ni con más que lo del bote');
select throws_ok($$insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, bonuses_cents, adjustments_cents,
                                               subtotal_cents, net_cents)
                   values (202610, pruebas.id('M4'), (select close_run_id from public.payout_periods where period_id = 202610), 100, 50, -50, 100, 100)$$,
  '23514', null, 'ni con un bono compensado por un ajuste');
select throws_ok($$insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, bonuses_cents, balance_applied_cents,
                                               subtotal_cents, net_cents)
                   values (202610, pruebas.id('M4'), (select close_run_id from public.payout_periods where period_id = 202610), 100, 50, -50, 100, 100)$$,
  '23514', null, 'ni por un saldo');
select throws_ok($$insert into public.bonuses (teacher_id, period_id, kind, amount_cents, basis_cents, multiplier_bps, close_run_id,
                                               status, decided_at, decided_by)
                   select pruebas.id('M4'), 202610, 'founder', 100, 1000, 1000, close_run_id, 'confirmed', now(), pruebas.finanzas()
                   from public.payout_periods where period_id = 202610$$,
  '23514', null, 'y el del fundador no nace confirmado');

-- ---------------------------------------------------------------------------------------
-- Lo que el guardián de una liquidación pide al nacer, aun como el dueño en un cierre en curso.

select pruebas.en_cierre(202611);
select throws_ok($$insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, subtotal_cents, net_cents)
                   values (202611, pruebas.id('M1'), (select close_run_id from public.payout_periods where period_id = 202610), 0, 0, 0)$$,
  '55000', null, 'una liquidación con la corrida de otro periodo no entra');

-- ---------------------------------------------------------------------------------------
-- El vigilante: el área de las liquidaciones.

select ok(exists (select 1 from private.watchdog_areas() where function_name = 'schema_violations_payouts'),
  'el agregador descubre el área de las liquidaciones');
select is_empty($$select * from private.schema_violations_payouts()$$, 'en orden');
select pruebas.como_dueno_sistema();
grant select on public.payouts to authenticated;
select results_eq($$select problem, object_name from private.schema_violations_payouts()$$,
  $$values ('payouts table reachable by authenticated', 'public.payouts')$$, 'las liquidaciones al alcance de una sesión');
revoke select on public.payouts from authenticated;
grant execute on function private.founder_bonus(bigint, date, public.period_id, jsonb) to app_service;
select results_eq($$select problem, object_name like 'private.founder_bonus(%' from private.schema_violations_payouts()$$,
  $$values ('payouts function executable by app_service', true)$$, 'el bono al alcance del servidor');
revoke execute on function private.founder_bonus(bigint, date, public.period_id, jsonb) from app_service;
alter function private.guard_payout() security definer;
select results_eq($$select problem, object_name like 'private.guard_payout(%' from private.schema_violations_payouts()$$,
  $$values ('payouts function security definer or without fixed search_path', true)$$, 'un guardián que corre como el dueño');
alter function private.guard_payout() security invoker;
alter table public.payouts disable trigger payouts_guard;
select results_eq($$select problem, object_name from private.schema_violations_payouts()$$,
  $$values ('payouts trigger missing or disabled: payouts_guard', 'public.payouts')$$, 'el guardián de las liquidaciones apagado');
alter table public.payouts enable trigger payouts_guard;
alter table public.payout_status_events disable trigger ledger_no_update_delete;
select results_eq($$select problem, object_name from private.schema_violations_payouts()$$,
  $$values ('payouts trigger missing or disabled: ledger_no_update_delete', 'public.payout_status_events')$$, 'la historia editable');
alter table public.payout_status_events enable trigger ledger_no_update_delete;
alter table public.bonuses disable trigger audit_changes;
select results_eq($$select problem, object_name from private.schema_violations_payouts()$$,
  $$values ('payouts trigger missing or disabled: audit_changes', 'public.bonuses')$$, 'los bonos sin auditoría');
alter table public.bonuses enable trigger audit_changes;
select is_empty($$select * from private.schema_violations_payouts()$$, 'y todo en su lugar otra vez');
select pruebas.como_dueno();

select * from finish();
rollback;
