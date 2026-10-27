-- T-602 · El ensayo y el cierre (RF-502, RF-503, RN-09, RNF-04; 05 §5.5, §8.4 a §8.6 y §9.3). Segunda de
-- dos solicitudes; la primera (`42_congelado`) congela lo cerrado. Decisiones de Sergio del 2026-10-24:
-- el cierre va en orden, exige un recálculo completo desde que el periodo entró en cierre, y las
-- liquidaciones, el bono y el paso a pagado son de T-603.
--
-- Octubre de 2026 es el ejemplo del PRD (05 §8.7) y el mes del arranque (el primer juego de tramos);
-- noviembre y diciembre llevan solo la parte del anual de C, sin consumo: lo arrastrado. El estado
-- en cierre y la foto se fuerzan con el guardián apagado: aquí el reloj no avanza. La comprobación de
-- lo cerrado corre al confirmar y aquí nada confirma: `pruebas.cierra()` la adelanta.
begin;
\ir _ayuda.psql
select plan(151);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a6020000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b6020000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.contenido() returns uuid language sql immutable as $$ select 'b6020000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.otra_finanzas() returns uuid language sql immutable as $$ select 'b6020000-0000-0000-0000-000000000003'::uuid $$;
create table pruebas.etiquetas (id uuid primary key, et text not null);
create function pruebas.et(p_id uuid) returns text language sql stable as $$ select et from pruebas.etiquetas where id = p_id $$;

-- Quien actúa por finanzas, como el servidor lo declararía (sin cambiar de rol: nadie de la
-- aplicación ejecuta todavía el ensayo ni el cierre, PA-80).
create function pruebas.como_finanzas(p_id uuid default null) returns void language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', coalesce(p_id, pruebas.finanzas())::text, true),
         set_config('app.actor_session', pruebas.sesion(coalesce(p_id, pruebas.finanzas()))::text, true);
$$;
create function pruebas.ensaya(p_period integer, p_id uuid default null) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas(p_id);
  v := private.rehearse_close(p_period);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.cierra(p_period integer, p_id uuid default null) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas(p_id);
  v := private.close_period(p_period);
  set constraints payout_periods_balanced immediate;
  set constraints payout_periods_balanced deferred;
  perform pruebas.limpiar();
  return v;
end
$$;
-- Un cierre que se descuadra después de escribirse: cierra, cambia lo escrito con los disparadores
-- apagados, y adelanta la comprobación (con otro rol, si se dice). Si cuadra, lanza P0002 para
-- deshacerlo todo: así cada caso se prueba con `throws_ok` y nada queda cerrado. Los disparadores se
-- apagan con la sesión en réplica y no con `alter table`, que no se deja con la comprobación del
-- cierre pendiente sobre `payout_periods`.
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
    -- Con la sentencia: Supabase deja al dueño ponerlo así, no con `set_config`.
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
create function pruebas.inicio(p_period integer) returns timestamptz
language sql stable as $$ select timezone('America/Mexico_City', to_date(p_period::text || '01', 'YYYYMMDD')::timestamp) $$;
-- Un cierre vacío escrito a mano (con la corrida del cierre de octubre), para probar el guardián solo.
create function pruebas.cerrar_a_mano(p_period integer, p_extra text default '') returns void language plpgsql as $$
begin
  execute format('update public.payout_periods set status = ''closed'', net_revenue_cents = 0, student_pools_cents = 0,
                  pool_cents = carried_in_cents, assigned_cents = 0, unconsumed_cents = carried_in_cents, carried_out_cents = 0,
                  close_run_id = (select close_run_id from public.payout_periods where period_id = 202610)%s
                  where period_id = %s', p_extra, p_period);
end
$$;
create function pruebas.o(p jsonb) returns text language sql immutable as $$ select p ->> 'outcome' $$;

-- El periodo en cierre, con su foto: lo que la corrida de cada noche haría el día de cierre.
create function pruebas.en_cierre(p_period integer, p_students integer default 4, p_bps integer default 6000) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(p_period);
  alter table public.payout_periods disable trigger payout_periods_guard;
  update public.payout_periods set status = 'closing', entered_closing_at = now() - interval '2 days',
         active_students = p_students, pool_bps = p_bps
  where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard;
  perform pruebas.como_dueno();
end
$$;
-- Un periodo abierto, aunque el reloj ya lo tenga en cierre: así la prueba no depende del día en que corre.
create function pruebas.abierto(p_period integer) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(p_period);
  alter table public.payout_periods disable trigger payout_periods_guard;
  update public.payout_periods set status = 'open', entered_closing_at = null where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard;
  perform pruebas.como_dueno();
end
$$;
-- Una corrida de la consolidación de un periodo, con su modo, cuándo empezó y su último latido.
create function pruebas.corrida(p_period integer, p_status text, p_mode text, p_started interval, p_heartbeat interval default null)
returns uuid language sql as $$
  insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details, error)
  values ('nightly_rollup', p_period, p_status::public.run_status, now() + p_started, now() + coalesce(p_heartbeat, p_started),
          case when p_status <> 'running' then now() + p_started + interval '1 minute' end,
          jsonb_build_object('mode', p_mode), case when p_status = 'failed' then 'una falla de prueba' end)
  returning id
$$;
create function pruebas.cobra(p_n integer, p_at timestamptz, p_gross bigint) returns text language sql as $$
  select private.record_charge(pruebas.al(p_n), ('c6020000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid, 'manual',
                               'cobro-cierre-' || p_n || '-' || p_gross, null,
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
create function pruebas.periodo(p_period integer) returns jsonb language sql stable
as $$ select to_jsonb(p) from public.payout_periods p where p.period_id = p_period $$;
create function pruebas.cifras(p_period integer) returns text language sql stable as $$
  select format('neto=%s alumnos=%s arrastrado=%s bote=%s asignado=%s sin_consumo=%s pasa=%s',
                net_revenue_cents, student_pools_cents, carried_in_cents, pool_cents, assigned_cents, unconsumed_cents, carried_out_cents)
  from public.payout_periods where period_id = p_period
$$;
create function pruebas.escrito(p_period integer) returns integer language sql stable as $$
  select ((select count(*) from public.payout_student_pools where period_id = p_period)
        + (select count(*) from public.payout_shares where period_id = p_period)
        + (select count(*) from public.payout_teacher_totals where period_id = p_period))::integer
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- Las corridas que el `pg_cron` de la base local haya dejado de estos meses no cuentan aquí: así la
-- prueba no depende de la hora a la que corre.
delete from public.job_runs where period_id between 202609 and 202712;

-- Las cuentas: cuatro alumnos del ejemplo, finanzas (dos personas) y contenido.
select pruebas.alta(pruebas.al(n), format('alumno%s-cierre@prueba.test', n)) from generate_series(1, 4) n;
insert into pruebas.etiquetas select pruebas.al(n), (array['A', 'B', 'C', 'D'])[n] from generate_series(1, 4) n;
select pruebas.alta(pruebas.finanzas(), 'finanzas-cierre@prueba.test');
select pruebas.alta(pruebas.contenido(), 'contenido-cierre@prueba.test');
select pruebas.alta(pruebas.otra_finanzas(), 'otra-finanzas-cierre@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-cierre@prueba.test';
select pruebas.dar_capacidad(pruebas.finanzas(), 'finance');
select pruebas.equipar(pruebas.finanzas());
select pruebas.dar_capacidad(pruebas.otra_finanzas(), 'finance');
select pruebas.equipar(pruebas.otra_finanzas());
select pruebas.dar_capacidad(pruebas.contenido(), 'content');
select pruebas.equipar(pruebas.contenido());

-- Los maestros, en este orden (decide el empate del ejemplo 3).
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra ' || s, 'maestra-' || s, null), pruebas.curso(s))
from unnest(array['cierre-m1', 'cierre-m2', 'cierre-m3']) with ordinality as x (s, n) order by n;
select pruebas.como_dueno();
insert into pruebas.etiquetas select teacher_id, 'M' || right(slug, 1) from public.published_courses where slug like 'cierre-m%';

-- Los cobros de octubre: A, B y D mensuales, C anual (doce partes, hasta septiembre de 2027).
select pruebas.abierto(202610);
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
select ('c6020000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, pruebas.al(n), 'manual', 'sus-cierre-' || n,
       case when n = 3 then 'annual' else 'monthly' end::public.subscription_plan, 'pending', 'MXN'
from generate_series(1, 4) n;
select is(array[pruebas.cobra(1, '2026-10-05 12:00-06', 34900), pruebas.cobra(2, '2026-10-06 12:00-06', 34900),
                pruebas.cobra(3, '2026-10-07 12:00-06', 299000), pruebas.cobra(4, '2026-10-08 12:00-06', 34900)],
  array['recorded', 'recorded', 'recorded', 'recorded'], 'los cuatro cobros del ejemplo');
-- El consolidado del ejemplo (05 §8.7).
select pruebas.fila(202610, pruebas.al(1), 'cierre-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres', 'Cuatro']) t;
select pruebas.fila(202610, pruebas.al(1), 'cierre-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(1), 'cierre-m2', 'Dos', 2),
       pruebas.fila(202610, pruebas.al(1), 'cierre-m2', 'Tres', 1);
select pruebas.fila(202610, pruebas.al(2), 'cierre-m2', 'Uno', 1);
select pruebas.fila(202610, pruebas.al(3), 'cierre-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres']) t;
select pruebas.fila(202610, pruebas.al(3), 'cierre-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(3), 'cierre-m3', 'Uno', 2);

-- ---------------------------------------------------------------------------------------
-- Las piezas.

select has_table('public', 'close_runs', 'las corridas del ensayo y del cierre');
select has_table('public', 'close_run_teacher_totals', 'lo que finanzas ve en un ensayo');
select has_table('public', 'payout_student_pools', 'el bote de cada alumno');
select has_table('public', 'payout_shares', 'las partes');
select has_table('public', 'payout_teacher_totals', 'los totales por maestro');
select is((select count(*)::integer from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('close_runs', 'close_run_teacher_totals', 'payout_student_pools', 'payout_shares', 'payout_teacher_totals')
             and grantee in ('anon', 'authenticated', 'service_role', 'app_service', 'PUBLIC')), 0,
  'nadie de la aplicación toca las tablas del cierre');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relrowsecurity
             and c.relname in ('close_runs', 'close_run_teacher_totals', 'payout_student_pools', 'payout_shares', 'payout_teacher_totals')), 5,
  'y las cinco tienen RLS');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.prosecdef
             and p.proname in ('close_input', 'close_teacher_totals', 'code_version', 'rehearse_close', 'close_period',
                               'assert_period_balanced', 'check_period_balanced', 'require_period_closing', 'guard_close_run')),
  array['check_period_balanced', 'close_period', 'rehearse_close'],
  'como el dueño corren solo el ensayo, el cierre y la comprobación al confirmar');
-- Desde T-605 (PA-80) el servidor ensaya y cierra; nadie más (`51_panel_del_periodo`).
select ok(has_function_privilege('app_service', 'private.rehearse_close(public.period_id)', 'execute')
          and has_function_privilege('app_service', 'private.close_period(public.period_id)', 'execute')
          and not has_function_privilege('authenticated', 'private.close_period(public.period_id)', 'execute'),
  'el servidor ensaya y cierra, y quien tiene sesión no');
select ok((select bool_and(pg_get_functiondef(oid) like '%transaction_isolation%') from pg_proc
           where oid in ('private.rehearse_close(public.period_id)'::regprocedure, 'private.close_period(public.period_id)'::regprocedure)),
  'los dos exigen read committed: cada sentencia ve lo que confirmó quien esperaba el candado');
select is(private.code_version(), (select max(version) from supabase_migrations.schema_migrations),
  'la versión del código es la última migración aplicada');

-- ---------------------------------------------------------------------------------------
-- La puerta y lo que no se ensaya.

select is(pruebas.o(pruebas.ensaya(202610, pruebas.contenido())), 'forbidden', 'sin finanzas no se ensaya');
select is(pruebas.o(pruebas.cierra(202610, pruebas.contenido())), 'forbidden', 'ni se cierra');
select pruebas.sin_codigo(pruebas.finanzas());
select is(pruebas.o(pruebas.ensaya(202610)), 'needs_fresh_code', 'con finanzas y sin código reciente, que lo dé');
select is(pruebas.o(pruebas.cierra(202610)), 'needs_fresh_code', 'también para cerrar');
select pruebas.equipar(pruebas.finanzas());
select is(pruebas.o(pruebas.ensaya(203501)), 'no_period', 'un mes sin fila no se ensaya');
select ok(not exists (select 1 from public.payout_periods where period_id = 203501), 'y el ensayo no le abre la fila');
-- Septiembre de 2026, antes del arranque: llega en cierre por el reloj y sin tramos.
select pruebas.como_dueno_sistema();
select private.open_period(202609);
select pruebas.como_dueno();
select is(pruebas.o(pruebas.ensaya(202609)), 'before_launch', 'un mes de antes del arranque no se ensaya');
select is(pruebas.o(pruebas.cierra(202609)), 'before_launch', 'ni se cierra');

-- ---------------------------------------------------------------------------------------
-- Un ensayo con el periodo abierto: parcial, y no congela nada (05 §8.5).

create temporary table antes as select pruebas.periodo(202610) as fila;
create temporary table ensayo_abierto as select pruebas.ensaya(202610) as r;
select is((select pruebas.o(r) from ensayo_abierto), 'rehearsed', 'octubre abierto se ensaya');
select is((select r ->> 'period_status_at_run' from ensayo_abierto), 'open', 'con los datos de ahora: parcial');
select is((select format('bote=%s asignado=%s sin_consumo=%s', r ->> 'pool_cents', r ->> 'assigned_cents', r ->> 'unconsumed_cents')
           from ensayo_abierto), 'bote=63687 asignado=46539 sin_consumo=17148', 'con las cifras del ejemplo');
select is(pruebas.periodo(202610), (select fila from antes), 'el periodo no cambia');
select is(pruebas.escrito(202610), 0, 'y nada se escribe en el reparto');
select results_eq(
  $$select pruebas.et(t.teacher_id), t.half_points, t.students, t.assigned_cents, t.unconsumed_cents, t.total_cents
    from public.close_run_teacher_totals t where t.close_run_id = (select (r ->> 'run_id')::uuid from ensayo_abierto) order by 1$$,
  $$values ('M1', 14, 2, 17899::bigint, 6595::bigint, 24494::bigint), ('M2', 8, 3, 26192::bigint, 9651::bigint, 35843::bigint),
           ('M3', 2, 1, 2448::bigint, 902::bigint, 3350::bigint)$$,
  'lo que finanzas ve del ensayo: el total de cada maestro');
select is((select format('%s %s %s', kind, status, period_status_at_run) from public.close_runs
           where id = (select (r ->> 'run_id')::uuid from ensayo_abierto)), 'rehearsal succeeded open', 'la corrida queda anotada');
select ok((select started_by = pruebas.finanzas() and code_version = private.code_version()
           from public.close_runs where id = (select (r ->> 'run_id')::uuid from ensayo_abierto)),
  'con quién la corrió y la versión del código');
select is((select parameters from public.close_runs where id = (select (r ->> 'run_id')::uuid from ensayo_abierto)),
  '{"BOTE_REGLA_TRAMO": "marginal_tiers", "BOTE_SIN_CONSUMO": "proportional_to_assigned_pool",
    "FUNDADOR_MULTIPLICADOR": {"multiplier": "1.15", "months": 24}, "founders": [],
    "tiers": {"thresholds": [0], "bps": [6000]}, "active_students": null}'::jsonb,
  'y los parámetros que deciden el cálculo (sin foto, sin alumnos activos)');
select ok(exists (select 1 from public.audit_log where entity_table = 'public.close_runs' and action = 'close_runs.insert'
                  and actor_id = pruebas.finanzas() and category = 'money'), 'y se audita como dinero');
select is(pruebas.o(pruebas.cierra(202610)), 'not_closing', 'un periodo abierto no se cierra');
select is(pruebas.o(pruebas.cierra(203502)), 'not_closing', 'ni un mes sin fila');

-- ---------------------------------------------------------------------------------------
-- Las precondiciones, una por una, en su orden.

select pruebas.en_cierre(202610, null, null);
select is(pruebas.o(pruebas.cierra(202610)), 'photo_missing', 'sin la foto no se cierra');
select is(pruebas.o(pruebas.ensaya(202610)), 'photo_missing', 'ni se ensaya con datos finales');
select pruebas.en_cierre(202610, 4, null);
select is(pruebas.o(pruebas.cierra(202610)), 'no_pool_bps', 'sin porcentaje, tampoco');
select is(pruebas.o(pruebas.ensaya(202610)), 'no_pool_bps', 'ni se ensaya');
select pruebas.en_cierre(202610);
-- Septiembre (antes del arranque, en cierre y sin cerrar) no detiene a octubre.
select is(pruebas.o(pruebas.cierra(202610)), 'needs_full_rollup', 'sin un recálculo completo desde que entró en cierre, no');
select pruebas.corrida(202610, 'succeeded', 'full', '-3 days');
select is(pruebas.o(pruebas.cierra(202610)), 'needs_full_rollup', 'uno de antes de entrar en cierre no cuenta');
create temporary table viva as select pruebas.corrida(202610, 'running', 'full', '-1 hour', '-1 minute') as id;
select is(pruebas.o(pruebas.cierra(202610)), 'rollup_running', 'con una consolidación viva del periodo, no');
update public.job_runs set heartbeat_at = now() - interval '20 minutes' where id = (select id from viva);
select is(pruebas.o(pruebas.cierra(202610)), 'last_rollup_failed',
  'una sin latido hace 15 minutos ya no está viva, pero tampoco terminó bien');
update public.job_runs set status = 'failed', finished_at = now() - interval '5 minutes', error = 'stale' where id = (select id from viva);
select is(pruebas.o(pruebas.cierra(202610)), 'last_rollup_failed', 'si la última corrida desde que entró en cierre falló, no');
create temporary table muerta as select pruebas.corrida(202610, 'running', 'dirty', '-270 seconds', '-20 minutes') as id;
select is(pruebas.o(pruebas.cierra(202610)), 'last_rollup_failed', 'una corrida muerta más nueva no tapa la falla');
update public.job_runs set status = 'failed', finished_at = now() - interval '4 minutes', error = 'stale' where id = (select id from muerta);
select pruebas.corrida(202610, 'succeeded', 'dirty', '-4 minutes');
select is(pruebas.o(pruebas.cierra(202610)), 'needs_full_rollup', 'una de marcas correcta no es el recálculo completo');
select pruebas.corrida(202610, 'succeeded', 'full', '-3 minutes');
create temporary table colgada as select pruebas.corrida(202610, 'running', 'dirty', '-150 seconds', '-20 minutes') as id;
select is(pruebas.o(pruebas.cierra(202610)), 'last_rollup_failed', 'una corrida colgada después del recálculo completo, tampoco');
update public.job_runs set status = 'failed', finished_at = now() - interval '2 minutes', error = 'stale' where id = (select id from colgada);
select pruebas.corrida(202610, 'succeeded', 'dirty', '-100 seconds');
select pruebas.corrida(202611, 'failed', 'dirty', '-2 minutes');
insert into private.rollup_dirty (period_id, profile_id, lesson_id) values (202610, pruebas.al(4), pruebas.leccion('cierre-m3', 'Dos'));
select is(pruebas.o(pruebas.cierra(202610)), 'rollup_marks', 'con marcas del periodo, no (la falla de otro periodo no cuenta)');
delete from private.rollup_dirty where period_id = 202610;
select pruebas.como_dueno_sistema();
insert into public.anomaly_alerts (period_id, kind, metric_value, threshold_value) values (202610, 'unconsumed_pool_ratio', 9000, 5000);
select pruebas.como_dueno();
select is(pruebas.o(pruebas.cierra(202610)), 'open_alerts', 'con una alerta sin revisar, no');
select pruebas.como_finanzas();
update public.anomaly_alerts set status = 'reviewed', review_note = 'Revisada.', reviewed_by = pruebas.finanzas(), reviewed_at = now()
where period_id = 202610;
select pruebas.como_dueno();
select is(pruebas.o(pruebas.cierra(202610)), 'rehearsal_missing', 'sin un ensayo con los datos finales, no (el parcial no cuenta)');

create temporary table ensayo as select pruebas.ensaya(202610) as r;
select is((select pruebas.o(r) || ' ' || (r ->> 'period_status_at_run') from ensayo), 'rehearsed closing', 'el ensayo con los datos finales');
select isnt((select r ->> 'input_hash' from ensayo), (select r ->> 'input_hash' from ensayo_abierto),
  'la foto entra en la huella: el parcial no sirve para cerrar');
select is((select r ->> 'result_hash' from ensayo), (select r ->> 'result_hash' from ensayo_abierto),
  'aunque el resultado sea el mismo');

-- La huella cambia con la entrada.
select pruebas.fila(202610, pruebas.al(4), 'cierre-m3', 'Cuatro', 1);
select is(pruebas.o(pruebas.cierra(202610)), 'rehearsal_stale', 'un medio punto nuevo deja el ensayo viejo');
delete from public.watch_rollup where period_id = 202610 and profile_id = pruebas.al(4);
insert into supabase_migrations.schema_migrations (version, name) values ('29991231235959', 'prueba_t602');
select is(pruebas.o(pruebas.cierra(202610)), 'rehearsal_stale', 'una migración nueva también');
delete from supabase_migrations.schema_migrations where version = '29991231235959';
select pruebas.como_dueno_sistema();
alter table public.payout_periods disable trigger payout_periods_guard;
update public.payout_periods set pool_bps = 6001 where period_id = 202610;
select is(pruebas.o(pruebas.cierra(202610)), 'rehearsal_stale', 'y otro porcentaje');
select pruebas.como_dueno_sistema();
update public.payout_periods set pool_bps = 6000 where period_id = 202610;
alter table public.payout_periods enable trigger payout_periods_guard;
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- La comprobación al confirmar: lo que no cuadra no se guarda (05 §8.6).

select throws_ok($$select pruebas.descuadra(202610, null)$$, 'P0002', 'cuadra', 'un cierre sin tocar cuadra');
select throws_ok($$select pruebas.descuadra(202610, null, 'app_service')$$, 'P0002', 'cuadra',
  'y cuadra aunque confirme el servidor: la comprobación corre como el dueño');
select throws_like($$select pruebas.descuadra(202610, $s$update public.payout_student_pools set pool_cents = pool_cents - 1
                                                         where period_id = 202610 and profile_id = pruebas.al(4)$s$)$$,
  '%student pools sum%', 'un bote de alumno que no suma');
select throws_like($$select pruebas.descuadra(202610, $s$update public.payout_student_pools set base_cents = base_cents + 1
                                                         where period_id = 202610 and profile_id = pruebas.al(4)$s$)$$,
  '%net revenue%', 'una base que no suma el ingreso');
select throws_like($$select pruebas.descuadra(202610, $s$
    update public.payout_shares set amount_cents = amount_cents + 1 where period_id = 202610 and profile_id = pruebas.al(1)
      and teacher_id = (select id from pruebas.etiquetas where et = 'M1');
    update public.payout_shares set amount_cents = amount_cents - 1 where period_id = 202610 and profile_id = pruebas.al(3)
      and teacher_id = (select id from pruebas.etiquetas where et = 'M1')$s$)$$,
  '%shares do not add up%', 'un centavo que pasa de un alumno a otro');
select throws_like($$select pruebas.descuadra(202610, $s$update public.payout_shares set half_points = half_points + 1
                                                         where period_id = 202610 and profile_id = pruebas.al(2)$s$)$$,
  '%shares do not add up%', 'unos medios puntos que no son los del alumno');
select throws_like($$select pruebas.descuadra(202610, $s$update public.payout_periods set assigned_cents = assigned_cents + 1,
                                                         unconsumed_cents = unconsumed_cents - 1 where period_id = 202610$s$)$$,
  '%shares sum%', 'lo asignado que no es la suma de las partes');
select throws_like($$select pruebas.descuadra(202610, $s$
    update public.payout_teacher_totals set assigned_cents = assigned_cents + 1, total_cents = total_cents + 1
      where period_id = 202610 and teacher_id = (select id from pruebas.etiquetas where et = 'M1');
    update public.payout_teacher_totals set assigned_cents = assigned_cents - 1, total_cents = total_cents - 1
      where period_id = 202610 and teacher_id = (select id from pruebas.etiquetas where et = 'M2')$s$)$$,
  '%teacher totals do not match%', 'un maestro con un total que no sale de sus partes');
select throws_like($$select pruebas.descuadra(202610, $s$update public.payout_teacher_totals set half_points = half_points + 1
                                                         where period_id = 202610 and teacher_id = (select id from pruebas.etiquetas where et = 'M1')$s$)$$,
  '%teacher totals do not match%', 'un total con otros medios puntos que sus partes');
select throws_like($$select pruebas.descuadra(202610, $s$update public.payout_teacher_totals set students = students + 1
                                                         where period_id = 202610 and teacher_id = (select id from pruebas.etiquetas where et = 'M3')$s$)$$,
  '%teacher totals do not match%', 'un total con otros alumnos');
select throws_like($$select pruebas.descuadra(202610, $s$delete from public.payout_teacher_totals
                                                         where period_id = 202610 and teacher_id = (select id from pruebas.etiquetas where et = 'M3')$s$)$$,
  '%has no total%', 'un maestro con partes y sin total');
select throws_like($$select pruebas.descuadra(202610, $s$update public.payout_teacher_totals set unconsumed_cents = unconsumed_cents + 1,
                                                         total_cents = total_cents + 1
                                                         where period_id = 202610 and teacher_id = (select id from pruebas.etiquetas where et = 'M1')$s$)$$,
  '%RNF-04%', 'lo que reciben los maestros no es el bote: RNF-04');
select throws_like($$select pruebas.descuadra(202610, $s$
    update public.payout_teacher_totals set unconsumed_cents = unconsumed_cents + 1, total_cents = total_cents + 1
      where period_id = 202610 and teacher_id = (select id from pruebas.etiquetas where et = 'M1');
    update public.payout_teacher_totals set unconsumed_cents = unconsumed_cents - 1, total_cents = total_cents - 1
      where period_id = 202610 and teacher_id = (select id from pruebas.etiquetas where et = 'M2')$s$)$$,
  '%not what the payout computes%', 'un centavo del sin consumo que pasa de un maestro a otro');
select throws_like($$select pruebas.descuadra(202610, $s$update public.close_runs set result_hash = sha256('otro'::bytea)
                                                         where period_id = 202610 and kind = 'close'$s$)$$,
  '%same result%', 'el cierre con otro resultado que su ensayo');
select throws_like($$select pruebas.descuadra(202610, $s$update public.close_runs set result_hash = sha256('otro'::bytea)
                                                         where period_id = 202610$s$)$$,
  '%result does not match what was written%', 'una huella del resultado que no es la de lo escrito');
select throws_like($$select pruebas.descuadra(202610, $s$update public.close_runs set assigned_cents = assigned_cents + 1
                                                         where period_id = 202610 and kind = 'close'$s$)$$,
  '%close run%', 'el cierre anotado con otras cifras que el periodo');
select throws_like($$select pruebas.descuadra(202610, $s$update public.close_runs set input_hash = sha256('otra'::bytea)
                                                         where period_id = 202610 and kind = 'rehearsal'$s$)$$,
  '%no rehearsal%', 'sin un ensayo con los datos finales y la misma entrada (RF-503)');
select throws_like($$select pruebas.descuadra(202610, $s$update public.close_runs set period_status_at_run = 'open'
                                                         where period_id = 202610 and kind = 'rehearsal'
                                                           and period_status_at_run = 'closing'$s$)$$,
  '%no rehearsal%', 'un ensayo parcial con la misma huella no basta');
select is((select status::text from public.payout_periods where period_id = 202610), 'closing',
  'nada de eso quedó: octubre sigue en cierre');
select is(pruebas.escrito(202610), 0, 'ni lo escrito');

-- ---------------------------------------------------------------------------------------
-- El cierre de octubre.

create temporary table cierre as select pruebas.cierra(202610) as r;
select is((select pruebas.o(r) from cierre), 'closed', 'octubre se cierra');
select is(pruebas.cifras(202610), 'neto=106148 alumnos=63687 arrastrado=0 bote=63687 asignado=46539 sin_consumo=17148 pasa=0',
  'las cifras del periodo, las del PRD');
select ok((select status = 'closed' and closed_by = pruebas.finanzas() and closed_at = now() and pool_bps = 6000 and active_students = 4
                  and close_run_id = (select (r ->> 'close_run_id')::uuid from cierre)
           from public.payout_periods where period_id = 202610), 'cerrado, por quién, cuándo y con qué corrida');
select results_eq($$select pruebas.et(profile_id), base_cents, pool_cents, half_points from public.payout_student_pools
                    where period_id = 202610 order by 1$$,
  $$values ('A', 28581::bigint, 17148::bigint, 13), ('B', 28581::bigint, 17148::bigint, 1), ('C', 20405::bigint, 12243::bigint, 10),
           ('D', 28581::bigint, 17148::bigint, 0)$$, 'el bote de cada alumno, también el de quien no vio nada');
select results_eq($$select pruebas.et(profile_id), pruebas.et(teacher_id), half_points, amount_cents from public.payout_shares
                    where period_id = 202610 order by 1, 2$$,
  $$values ('A', 'M1', 8, 10553::bigint), ('A', 'M2', 5, 6595::bigint), ('B', 'M2', 1, 17148::bigint),
           ('C', 'M1', 6, 7346::bigint), ('C', 'M2', 2, 2449::bigint), ('C', 'M3', 2, 2448::bigint)$$, 'las partes, al centavo');
select results_eq($$select pruebas.et(teacher_id), half_points, students, assigned_cents, unconsumed_cents, total_cents
                    from public.payout_teacher_totals where period_id = 202610 order by 1$$,
  $$values ('M1', 14, 2, 17899::bigint, 6595::bigint, 24494::bigint), ('M2', 8, 3, 26192::bigint, 9651::bigint, 35843::bigint),
           ('M3', 2, 1, 2448::bigint, 902::bigint, 3350::bigint)$$, 'y el total de cada maestro: 244.94, 358.43 y 33.50');
select is((select count(distinct close_run_id)::integer from (
             select close_run_id from public.payout_student_pools where period_id = 202610
             union all select close_run_id from public.payout_shares where period_id = 202610
             union all select close_run_id from public.payout_teacher_totals where period_id = 202610) x
           where close_run_id = (select (r ->> 'close_run_id')::uuid from cierre)), 1, 'todo con la corrida del cierre');
select results_eq($$select teacher_id, half_points, students, assigned_cents, unconsumed_cents, total_cents from public.close_run_teacher_totals
                    where close_run_id = (select (r ->> 'close_run_id')::uuid from cierre) order by 1$$,
  $$select teacher_id, half_points, students, assigned_cents, unconsumed_cents, total_cents from public.payout_teacher_totals
    where period_id = 202610 order by 1$$, 'la corrida del cierre lleva también el total de cada maestro');
select is((select encode(input_hash, 'hex') from public.close_runs where id = (select (r ->> 'close_run_id')::uuid from cierre)),
  (select r ->> 'input_hash' from ensayo), 'el ensayo y el cierre con la misma entrada dan la misma huella');
select is((select encode(result_hash, 'hex') from public.close_runs where id = (select (r ->> 'close_run_id')::uuid from cierre)),
  (select r ->> 'result_hash' from ensayo), 'y el mismo resultado');
select is(array(select l::text from private.payout_for_period(202610, 0) l),
  array(select l::text from private.compute_payout(6000, 0,
          array(select row(profile_id, base_cents)::private.payout_base from public.payout_student_pools where period_id = 202610 order by profile_id),
          array(select row(s.profile_id, s.teacher_id, t.tiebreak_rank, s.half_points)::private.payout_points
                from public.payout_shares s join public.teachers t on t.id = s.teacher_id where s.period_id = 202610)) l),
  'lo escrito es lo que devuelve el reparto del periodo');
select ok(exists (select 1 from public.audit_log where entity_table = 'public.payout_periods' and action = 'payout_periods.update'
                  and actor_id = pruebas.finanzas() and new_value ->> 'status' = 'closed'), 'el cierre queda en la auditoría');

-- Cerrar dos veces es un solo cierre (05 §9.3).
select is(pruebas.cierra(202610), jsonb_build_object('outcome', 'already_closed', 'close_run_id', (select (r ->> 'close_run_id')::uuid from cierre)),
  'la segunda vez contesta con el cierre que existe');
select is(pruebas.cierra(202610, pruebas.otra_finanzas()) ->> 'outcome', 'already_closed', 'aunque sea otra persona');
select is((select count(*)::integer from public.close_runs where period_id = 202610 and kind = 'close'), 1, 'y hay una sola corrida de cierre');
select is(pruebas.o(pruebas.ensaya(202610)), 'already_closed', 'un periodo cerrado no se ensaya');

-- Lo cerrado no cambia (RN-09).
select throws_ok($$select pruebas.fila(202610, pruebas.al(4), 'cierre-m3', 'Cuatro', 1)$$, '55000', null, 'el consolidado de octubre ya no cambia');
select throws_ok($$update public.payout_shares set amount_cents = 0 where period_id = 202610$$, '42501', null, 'una parte no se edita');
select throws_ok($$delete from public.payout_student_pools where period_id = 202610 and profile_id = pruebas.al(4)$$, '42501', null,
  'el bote de un alumno no se borra');
select throws_ok($$truncate public.payout_teacher_totals$$, '42501', null, 'los totales no se vacían');
select throws_ok($$delete from public.close_runs where period_id = 202610$$, '42501', null, 'una corrida no se borra');
select throws_ok($$update public.close_run_teacher_totals set total_cents = 0$$, '42501', null, 'ni lo que vio finanzas');
select throws_ok($$insert into public.payout_shares (period_id, profile_id, teacher_id, close_run_id, half_points, amount_cents)
                   select 202610, pruebas.al(4), (select id from pruebas.etiquetas where et = 'M3'), (r ->> 'close_run_id')::uuid, 1, 0 from cierre$$,
  '55000', null, 'ni entra una parte a un periodo que no está en cierre');
select pruebas.como_finanzas();
select throws_ok($$update public.payout_periods set assigned_cents = 0, unconsumed_cents = 63687 where period_id = 202610$$, '23514', null,
  'las cifras de un periodo cerrado no cambian');
select throws_ok($$update public.payout_periods set status = 'closing' where period_id = 202610$$, '23514', null, 'ni vuelve a en cierre');
select throws_ok($$update public.payout_periods set status = 'paid' where period_id = 202610$$, '23514', null,
  'ni pasa a pagado (llega con T-603)');
select pruebas.como_dueno();
select ok(not (202610 = any (array(select private.rollup_window()))), 'y la consolidación ya no lo recorre');

-- ---------------------------------------------------------------------------------------
-- En orden, y lo arrastrado.

select pruebas.en_cierre(202611, 4, 6000);
select pruebas.en_cierre(202612, 4, 6000);
-- Después de la corrida fallida de noviembre de arriba: la última es la buena.
select pruebas.corrida(p, 'succeeded', 'full', '-1 minute') from (values (202611), (202612)) v (p);
select is(pruebas.o(pruebas.cierra(202612)), 'previous_not_closed', 'diciembre no se cierra con noviembre en cierre');
select is(pruebas.cierra(202612) ->> 'period', '202611', 'y dice cuál falta');
create temporary table ensayo_dic as select pruebas.ensaya(202612) as r;
select is((select r ->> 'carried_in_cents' from ensayo_dic), '0', 'diciembre ensayado antes de cerrar noviembre: sin lo arrastrado');
create temporary table ensayo_nov as select pruebas.ensaya(202611) as r;
select is((select pruebas.o(r) from ensayo_nov), 'rehearsed', 'noviembre se ensaya');
select isnt((select r ->> 'input_hash' from ensayo_nov), (select r ->> 'input_hash' from ensayo_dic),
  'con la misma entrada que diciembre, otra huella: el periodo entra en ella');
select is((select r ->> 'result_hash' from ensayo_nov), (select r ->> 'result_hash' from ensayo_dic), 'y el mismo resultado');
select throws_like($$select pruebas.descuadra(202611, $s$update public.payout_periods set carried_in_cents = carried_in_cents - 1
                                                         where period_id = 202612$s$)$$,
  '%did not receive%', 'lo que pasa al siguiente tiene que llegar, al centavo');
select is(pruebas.o(pruebas.cierra(202611)), 'closed', 'noviembre se cierra');
select is(pruebas.cifras(202611), 'neto=20405 alumnos=12243 arrastrado=0 bote=12243 asignado=0 sin_consumo=12243 pasa=12243',
  'nadie tuvo puntos: todo pasa al siguiente (RN-06)');
select is((select count(*)::integer from public.payout_teacher_totals where period_id = 202611), 0, 'ningún maestro recibe nada');
select pruebas.como_finanzas();
select throws_ok($$update public.payout_periods set status = 'paid' where period_id = 202611$$, '23514', null,
  'un periodo sin liquidaciones tampoco pasa a pagado sin liberarse (T-603)');
select pruebas.como_dueno();
select is((select carried_in_cents from public.payout_periods where period_id = 202612), 12243::bigint, 'y diciembre lo recibe');
select is(pruebas.o(pruebas.cierra(202612)), 'rehearsal_stale', 'el ensayo de diciembre quedó viejo: cambió lo arrastrado');
create temporary table ensayo_dic2 as select pruebas.ensaya(202612) as r;
select is((select format('arrastrado=%s bote=%s', r ->> 'carried_in_cents', r ->> 'pool_cents') from ensayo_dic2),
  'arrastrado=12243 bote=24486', 'ensayado otra vez, con lo arrastrado');
set constraints payout_periods_balanced immediate;
select is(pruebas.o(pruebas.cierra(202612)), 'closed', 'diciembre se cierra, aunque quien llama haya puesto la comprobación inmediata');
select is(pruebas.cifras(202612), 'neto=20405 alumnos=12243 arrastrado=12243 bote=24486 asignado=0 sin_consumo=24486 pasa=24486',
  'y pasa todo, con lo que recibió');
select is((select carried_in_cents from public.payout_periods where period_id = 202701), 24486::bigint,
  'enero gana su fila con lo arrastrado');
select pruebas.abierto(202701);

-- Enero, con consumo: lo arrastrado se reparte con el sin consumo.
select pruebas.fila(202701, pruebas.al(3), 'cierre-m1', 'Uno', 2);
select is((select format('bote=%s asignado=%s sin_consumo=%s', r ->> 'pool_cents', r ->> 'assigned_cents', r ->> 'unconsumed_cents')
           from (select pruebas.ensaya(202701) as r) x), 'bote=36729 asignado=12243 sin_consumo=24486',
  'enero abierto: lo arrastrado va a quien tuvo puntos');

-- Un ensayo que falla queda anotado, con su error.
select pruebas.como_dueno_sistema();
insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
values ('BOTE_SIN_CONSUMO', '"by_points"', 'decided', pruebas.inicio(202701), 202701);
select pruebas.como_dueno();
create temporary table fallido as select pruebas.ensaya(202701) as r;
select is((select pruebas.o(r) from fallido), 'failed', 'un ensayo cuyo cálculo lanza contesta que falló');
select ok((select status = 'failed' and error like '%BOTE_SIN_CONSUMO%' and input_hash is null
           from public.close_runs where id = (select (r ->> 'run_id')::uuid from fallido)), 'y la corrida queda fallida, con su error');

-- ---------------------------------------------------------------------------------------
-- El guardián: de en cierre a cerrado solo una vez, con todo; lo arrastrado, una vez y del anterior.

select pruebas.en_cierre(202701, 1, 6000);
select pruebas.como_finanzas();
select throws_ok($$update public.payout_periods set status = 'closed' where period_id = 202701$$, '23514', null,
  'un periodo no se cierra sin sus cifras');
select throws_ok($$update public.payout_periods set carried_in_cents = 1 where period_id = 202701$$, '23514', null,
  'lo arrastrado se escribe una vez');
select throws_ok($$update public.payout_periods set carried_in_cents = 5 where period_id = 202702$$, '23514', null,
  'y solo lo que pasó el anterior cerrado')
  from (select private.open_period(202702)) x;
select throws_ok($$update public.payout_periods set net_revenue_cents = 1 where period_id = 202702$$, '23514', null,
  'las cifras del cierre no se escriben fuera del cierre');
select throws_ok($$update public.payout_periods set status = 'closed' where period_id = 202702$$, '23514', null,
  'ni de abierto a cerrado');
select lives_ok($$update public.payout_periods set status = status where period_id = 202610$$,
  'a un periodo cerrado no le pasa nada con una escritura que no cambia nada');
select throws_ok($$insert into public.payout_periods (period_id, starts_at, ends_at, timezone, net_revenue_cents)
                   values (202706, pruebas.inicio(202706), pruebas.inicio(202707), 'America/Mexico_City', 1)$$, '23514', null,
  'un periodo no nace con cifras del cierre');
select pruebas.en_cierre(202703, 1, 6000);
select pruebas.en_cierre(202704, null, null);
select pruebas.abierto(202705);
select pruebas.como_dueno_sistema();
alter table public.payout_periods disable trigger payout_periods_guard;
update public.payout_periods set active_students = 1, pool_bps = 6000 where period_id = 202705;
alter table public.payout_periods enable trigger payout_periods_guard;
select pruebas.como_finanzas();
select throws_like($$select pruebas.cerrar_a_mano(202705)$$, '%closes only from closing%', 'de abierto no se cierra, ni con cifras y foto');
select throws_ok($$select pruebas.cerrar_a_mano(202704)$$, '23514', null, 'ni sin su foto');
select throws_ok($$select pruebas.cerrar_a_mano(202703, ', timezone = ''UTC''')$$, '23514', null, 'al cerrar no cambia nada más');
select pruebas.como_dueno_sistema();
select throws_ok($$select pruebas.cerrar_a_mano(202703)$$, '23514', null, 'y sin quien actúe no se cierra');
-- Lo arrastrado: julio, cerrado a mano, pasó 5.00.
select pruebas.abierto(202707);
select pruebas.abierto(202708);
select pruebas.como_dueno_sistema();
alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
update public.payout_periods set status = 'closed', entered_closing_at = now() - interval '2 days', active_students = 1, pool_bps = 6000,
       net_revenue_cents = 900, student_pools_cents = 500, pool_cents = 500, assigned_cents = 0, unconsumed_cents = 500,
       carried_out_cents = 500, close_run_id = (select close_run_id from public.payout_periods where period_id = 202610)
where period_id = 202707;
alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
select pruebas.como_finanzas();
select throws_like($$update public.payout_periods set carried_in_cents = 500, timezone = 'UTC' where period_id = 202708$$,
  '%written once, alone%', 'lo arrastrado se escribe solo');
select throws_ok($$update public.payout_periods set carried_in_cents = 499 where period_id = 202708$$, '23514', null,
  'y es lo que pasó el anterior, al centavo');
select lives_ok($$update public.payout_periods set carried_in_cents = 500 where period_id = 202708$$, 'lo que pasó, entra');
-- Dos estados que el cierre no deja, puestos a mano: lo recibido se escribe una vez, aunque sea el
-- monto que pasó el anterior, y solo de un anterior cerrado, aunque diga cuánto pasa.
select pruebas.como_dueno_sistema();
alter table public.payout_periods disable trigger payout_periods_guard;
update public.payout_periods set carried_in_cents = 7 where period_id = 202708;
update public.payout_periods set carried_out_cents = 5 where period_id = 202703;
alter table public.payout_periods enable trigger payout_periods_guard;
select pruebas.como_finanzas();
select throws_like($$update public.payout_periods set carried_in_cents = 500 where period_id = 202708$$, '%written once%',
  'lo recibido no se reescribe');
select throws_like($$update public.payout_periods set carried_in_cents = 5 where period_id = private.period_plus(202703, 1)$$,
  '%receives only what the closed period%', 'ni llega de un anterior que no está cerrado');
-- Las corridas: con el estado que tiene el periodo, y a nombre de quien actúa.
select throws_ok($$insert into public.close_runs (period_id, kind, status, period_status_at_run, code_version, parameters, started_by, error)
                   values (202705, 'rehearsal', 'failed', 'closing', 'x', '{}', pruebas.finanzas(), 'x')$$, '23514', null,
  'una corrida no dice que corrió con otro estado del periodo');
select throws_ok($$insert into public.close_runs (period_id, kind, status, period_status_at_run, code_version, parameters, started_by, error)
                   values (202705, 'rehearsal', 'failed', 'open', 'x', '{}', pruebas.otra_finanzas(), 'x')$$, '23514', null,
  'ni a nombre de otra persona');
select throws_ok($$insert into public.payout_student_pools (period_id, profile_id, close_run_id, base_cents, pool_cents, half_points)
                   select 202703, pruebas.al(1), (r ->> 'run_id')::uuid, 1, 0, 0 from ensayo_abierto$$, '55000', null,
  'el reparto se escribe solo con la corrida del cierre de su periodo');
select pruebas.como_dueno();
select is(pruebas.o(pruebas.cierra(202701, pruebas.contenido())), 'forbidden', 'la puerta se revisa antes que el periodo');

-- ---------------------------------------------------------------------------------------
-- El vigilante: el área del cierre (de este carril).

select ok(exists (select 1 from private.watchdog_areas() where function_name = 'schema_violations_close' and unusable_reason is null),
  'el área del cierre está y se puede usar');
select is((select count(*)::integer from private.schema_violations()), 0, 'y no encuentra nada');
grant select on public.payout_shares to authenticated;
select ok(exists (select 1 from private.schema_violations() where problem = 'close table reachable by authenticated'
                  and object_name = 'public.payout_shares'), 've una tabla del cierre al alcance de quien tiene sesión');
revoke select on public.payout_shares from authenticated;
grant execute on function private.close_period(public.period_id) to authenticated;
select ok(exists (select 1 from private.schema_violations() where problem = 'close function executable by authenticated'
                  and object_name like 'private.close_period(%'), 've el cierre ejecutable por quien tiene sesión');
revoke execute on function private.close_period(public.period_id) from authenticated;
alter function private.close_input(public.period_id) security definer;
select ok(exists (select 1 from private.schema_violations() where problem = 'close function security definer or without fixed search_path'
                  and object_name like 'private.close_input(%'), 've la entrada como `security definer`');
alter function private.close_input(public.period_id) security invoker;
alter function private.close_period(public.period_id) security invoker;
select ok(exists (select 1 from private.schema_violations() where problem = 'close function not security definer'
                  and object_name like 'private.close_period(%'), 've el cierre sin correr como el dueño');
alter function private.close_period(public.period_id) security definer;
alter table public.payout_shares disable trigger require_period_closing;
select ok(exists (select 1 from private.schema_violations() where problem = 'close trigger missing or disabled: require_period_closing'
                  and object_name = 'public.payout_shares'), 've una tabla del reparto que acepta filas fuera del cierre');
alter table public.payout_shares enable trigger require_period_closing;
alter table public.close_runs disable trigger ledger_no_update_delete;
select ok(exists (select 1 from private.schema_violations() where problem = 'close trigger missing or disabled: ledger_no_update_delete'
                  and object_name = 'public.close_runs'), 've una corrida que se puede editar');
alter table public.close_runs enable trigger ledger_no_update_delete;
drop trigger payout_periods_balanced on public.payout_periods;
create constraint trigger payout_periods_balanced after update of status on public.payout_periods
  not deferrable for each row when (new.status = 'closed' and old.status = 'closing') execute function private.check_period_balanced();
select ok(exists (select 1 from private.schema_violations() where problem = 'close trigger not deferred: payout_periods_balanced'),
  've la comprobación del cierre sin esperar a que se confirme');
drop trigger payout_periods_balanced on public.payout_periods;
create constraint trigger payout_periods_balanced after update of status on public.payout_periods
  deferrable initially deferred for each row when (new.status = 'closed' and old.status = 'closing')
  execute function private.check_period_balanced();
alter function private.rehearse_close(public.period_id) rename to rehearse_close_renombrada;
select ok(exists (select 1 from private.schema_violations() where problem = 'close function missing'
                  and object_name = 'private.rehearse_close'), 've una función del cierre que falta');
alter function private.rehearse_close_renombrada(public.period_id) rename to rehearse_close;
select is((select count(*)::integer from private.schema_violations()), 0, 'todo en su lugar, nada');

select * from finish();
rollback;
