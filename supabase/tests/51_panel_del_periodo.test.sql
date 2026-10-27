-- T-605 · El panel del periodo (PA-78 a PA-80; RF-705, RF-503; 05 §6 y §8.6). Decisiones del 2026-10-27:
-- el servidor ensaya y cierra (se le abren `rehearse_close` y `close_period`), y finanzas lee por tres
-- funciones, nulas sin la capacidad, que no dan el identificador de ningún alumno ni recalculan nada
-- al leer: el bote, el porcentaje y el sin consumo salen del cierre o del último ensayo, con su fecha.
-- PA-79 da dos ingresos con su nombre: lo cobrado en el periodo y lo asignado al periodo.
--
-- Octubre de 2026 es el ejemplo del PRD, como en `43_cierre`.
begin;
\ir _ayuda.psql
select plan(56);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a6051000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b6051000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.contenido() returns uuid language sql immutable as $$ select 'b6051000-0000-0000-0000-000000000002'::uuid $$;
create table pruebas.etiquetas (id uuid primary key, et text not null);
create function pruebas.m(p_et text) returns uuid language sql stable as $$ select id from pruebas.etiquetas where et = p_et $$;

-- Por el servidor, como la aplicación: con el rol `app_service` y quien actúa declarado.
create function pruebas.servidor(p_actor uuid, p_call text, p_period integer) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  -- A nombre de quien actúa, sin repararle nada (como el servidor).
  if p_actor is null then
    perform pruebas.como_servicio(null);
  else
    perform pruebas.a_nombre_de(p_actor);
  end if;
  execute format('select private.%I(%s)', p_call, coalesce(p_period::text, '')) into v;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.en_cierre(p_period integer) returns void language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(p_period);
  alter table public.payout_periods disable trigger payout_periods_guard;
  update public.payout_periods set status = 'closing', entered_closing_at = now() - interval '2 days', active_students = 4, pool_bps = 6000
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
create function pruebas.corrida(p_period integer, p_status text, p_mode text, p_started interval) returns uuid language sql as $$
  insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details, error)
  values ('nightly_rollup', p_period, p_status::public.run_status, now() + p_started, now() + p_started,
          case when p_status <> 'running' then now() + p_started + interval '1 minute' end, jsonb_build_object('mode', p_mode),
          case when p_status = 'failed' then 'una falla de prueba' end)
  returning id
$$;
create function pruebas.cobra(p_n integer, p_at timestamptz, p_gross bigint) returns text language sql as $$
  select private.record_charge(pruebas.al(p_n), ('c6051000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid, 'manual',
                               'cobro-panel-' || p_n || '-' || p_gross, null,
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
create function pruebas.fila(p_period integer, p_profile uuid, p_course text, p_title text, p_half_points integer) returns void
language sql as $$
  select private.open_period(p_period);
  insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                   lesson_duration_seconds, covered_seconds, half_points)
  select p_period, p_profile, l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, 50 * p_half_points, p_half_points
  from public.published_lessons l join public.published_courses c on c.course_id = l.course_id
  where c.slug = p_course and l.title = p_title
$$;
-- Ninguna lectura de finanzas lleva el identificador de un alumno.
create function pruebas.sin_alumnos(p jsonb) returns boolean language sql stable as $$
  select not exists (select 1 from generate_series(1, 4) n where p::text like '%' || pruebas.al(n)::text || '%')
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

delete from public.job_runs where period_id between 202609 and 202712;

select pruebas.alta(pruebas.al(n), format('alumno%s-panel@prueba.test', n)) from generate_series(1, 4) n;
select pruebas.alta(pruebas.finanzas(), 'finanzas-panel@prueba.test');
select pruebas.alta(pruebas.contenido(), 'contenido-panel@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-panel@prueba.test';
select pruebas.dar_capacidad(pruebas.finanzas(), 'finance');
select pruebas.equipar(pruebas.finanzas());
select pruebas.dar_capacidad(pruebas.contenido(), 'content');
select pruebas.equipar(pruebas.contenido());
update public.profiles set display_name = 'Fernanda Finanzas' where id = pruebas.finanzas();

select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra ' || s, 'panel-' || s, null), pruebas.curso('panel-' || s))
from unnest(array['m1', 'm2', 'm3']) with ordinality as x (s, n) order by n;
select pruebas.como_dueno();
insert into pruebas.etiquetas select teacher_id, 'M' || right(slug, 1) from public.published_courses where slug like 'panel-m%';

select pruebas.abierto(202610);
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
select ('c6051000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, pruebas.al(n), 'manual', 'sus-panel-' || n,
       case when n = 3 then 'annual' else 'monthly' end::public.subscription_plan, 'pending', 'MXN'
from generate_series(1, 4) n;
select is(array[pruebas.cobra(1, '2026-10-05 12:00-06', 34900), pruebas.cobra(2, '2026-10-06 12:00-06', 34900),
                pruebas.cobra(3, '2026-10-07 12:00-06', 299000), pruebas.cobra(4, '2026-10-08 12:00-06', 34900)],
  array['recorded', 'recorded', 'recorded', 'recorded'], 'los cuatro cobros del ejemplo');
select pruebas.fila(202610, pruebas.al(1), 'panel-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres', 'Cuatro']) t;
select pruebas.fila(202610, pruebas.al(1), 'panel-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(1), 'panel-m2', 'Dos', 2),
       pruebas.fila(202610, pruebas.al(1), 'panel-m2', 'Tres', 1);
select pruebas.fila(202610, pruebas.al(2), 'panel-m2', 'Uno', 1);
select pruebas.fila(202610, pruebas.al(3), 'panel-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres']) t;
select pruebas.fila(202610, pruebas.al(3), 'panel-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(3), 'panel-m3', 'Uno', 2);

-- ---------------------------------------------------------------------------------------
-- Quién ejecuta qué.

select ok(has_function_privilege('app_service', 'private.rehearse_close(public.period_id)', 'execute')
          and has_function_privilege('app_service', 'private.close_period(public.period_id)', 'execute'),
  'el servidor ensaya y cierra (PA-80)');
select ok(has_function_privilege('app_service', 'private.finance_periods()', 'execute')
          and has_function_privilege('app_service', 'private.finance_period(public.period_id)', 'execute')
          and has_function_privilege('app_service', 'private.finance_close(public.period_id)', 'execute')
          and has_function_privilege('app_service', 'private.close_export_download(uuid)', 'execute')
          and has_function_privilege('app_service', 'private.request_rollup(public.period_id)', 'execute'),
  'y lee el panel, descarga la exportación y pide el recálculo');
select ok(not exists (
            select 1 from (values ('anon'), ('authenticated'), ('service_role')) r (rolname),
                 (values ('private.rehearse_close(public.period_id)'), ('private.close_period(public.period_id)'),
                         ('private.finance_periods()'), ('private.finance_period(public.period_id)'),
                         ('private.finance_close(public.period_id)'), ('private.close_export_download(uuid)'),
                         ('private.request_rollup(public.period_id)')) f (sig)
            where has_function_privilege(r.rolname, f.sig::regprocedure, 'execute')),
  'nadie más');
select ok(not exists (
            select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('app_service')) r (rolname),
                 (values ('private.close_export_csv(uuid, bigint)'), ('private.assert_close_export(public.period_id)'),
                         ('private.write_close_export()'), ('private.csv_text(text)'), ('private.csv_money(bigint)'),
                         ('private.run_rollup_requests()')) f (sig)
            where has_function_privilege(r.rolname, f.sig::regprocedure, 'execute')),
  'las piezas de la exportación y el corredor de pedidos, solo el dueño');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.prosecdef
             and p.proname in ('finance_periods', 'finance_period', 'finance_close', 'close_export_download', 'request_rollup',
                               'close_export_csv', 'assert_close_export', 'write_close_export', 'csv_text', 'csv_money',
                               'run_rollup_requests')),
  array['close_export_download', 'finance_close', 'finance_period', 'finance_periods', 'request_rollup'],
  'como el dueño corren solo lo que el servidor llama');

-- El vigilante del área del cierre.
select ok(exists (select 1 from private.watchdog_areas() where function_name = 'schema_violations_close' and unusable_reason is null),
  'el área del cierre está y se puede usar');
select is((select count(*)::integer from private.schema_violations()), 0, 'y no encuentra nada');
revoke execute on function private.close_period(public.period_id) from app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'close function not executable by app_service'
                  and object_name like 'private.close_period(%'), 've el cierre que el servidor ya no puede correr');
grant execute on function private.close_period(public.period_id) to app_service;
grant execute on function private.close_export_csv(uuid, bigint) to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'close function executable by app_service'
                  and object_name like 'private.close_export_csv(%'), 've una pieza de la exportación al alcance del servidor');
revoke execute on function private.close_export_csv(uuid, bigint) from app_service;
grant select on private.close_exports to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'close table reachable by app_service'
                  and object_name = 'private.close_exports'), 've la exportación al alcance del servidor');
revoke select on private.close_exports from app_service;
grant select on private.rollup_requests to authenticated;
select ok(exists (select 1 from private.schema_violations() where problem = 'close table reachable by authenticated'
                  and object_name = 'private.rollup_requests'), 've los pedidos al alcance de quien tiene sesión');
revoke select on private.rollup_requests from authenticated;
grant execute on procedure private.run_rollup_requests() to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'close function executable by app_service'
                  and object_name like 'private.run_rollup_requests(%'), 've el corredor de pedidos al alcance del servidor');
revoke execute on procedure private.run_rollup_requests() from app_service;
alter table public.payout_periods disable trigger write_close_export;
select ok(exists (select 1 from private.schema_violations() where problem = 'close trigger missing or disabled: write_close_export'),
  've apagado el disparador que escribe la exportación');
alter table public.payout_periods enable trigger write_close_export;
alter table private.close_exports disable trigger ledger_no_update_delete;
select ok(exists (select 1 from private.schema_violations() where problem = 'close trigger missing or disabled: ledger_no_update_delete'
                  and object_name = 'private.close_exports'), 've la exportación sin su seguro de solo inserción');
alter table private.close_exports enable trigger ledger_no_update_delete;
alter function private.close_export_csv(uuid, bigint) security definer;
select ok(exists (select 1 from private.schema_violations() where problem = 'close function security definer or without fixed search_path'
                  and object_name like 'private.close_export_csv(%'), 've la exportación como `security definer`');
alter function private.close_export_csv(uuid, bigint) security invoker;
select ok(exists (select 1 from cron.job where jobname = 'rollup_requests' and schedule = '* * * * *'
                  and command = 'call private.run_rollup_requests()'), 'los pedidos se atienden cada minuto');
select cron.alter_job((select jobid from cron.job where jobname = 'rollup_requests'), active := false);
select ok(exists (select 1 from private.schema_violations() where problem = 'close job missing or inactive: rollup_requests'),
  've el trabajo de los pedidos apagado');
select cron.alter_job((select jobid from cron.job where jobname = 'rollup_requests'), active := true);
-- La pausa del corredor está atada al horario de la consolidación de cada noche.
select ok(exists (select 1 from cron.job where jobname = 'nightly_rollup' and schedule = '0 9 * * *')
          and current_setting('cron.timezone') in ('GMT', 'UTC'),
  'la consolidación de cada noche es a las 09:00 UTC; si cambia, cambia la pausa del corredor');
select is(array[private.rollup_requests_paused('2026-10-27 07:59:59+00'), private.rollup_requests_paused('2026-10-27 08:00:00+00'),
                private.rollup_requests_paused('2026-10-27 08:59:59+00'), private.rollup_requests_paused('2026-10-27 09:00:00+00'),
                private.rollup_requests_paused('2026-10-27 09:29:59+00'), private.rollup_requests_paused('2026-10-27 09:30:00+00'),
                private.rollup_requests_paused('2026-10-27 02:30:00-06')],
  array[false, true, true, true, true, false, true], 'el corredor no empieza de las 08:00 a las 09:30 UTC');
select is((select count(*)::integer from private.schema_violations()), 0, 'todo en su lugar otra vez');

-- ---------------------------------------------------------------------------------------
-- Quién lee.

select is(pruebas.servidor(pruebas.contenido(), 'finance_periods', null), null, 'sin finanzas, la lista de periodos es nula');
select is(pruebas.servidor(null, 'finance_period', 202610), null, 'sin nadie que actúe, el panel también');
select is(pruebas.servidor(pruebas.contenido(), 'finance_period', 202610), null, 'ni con otra capacidad');
select is(pruebas.servidor(pruebas.contenido(), 'finance_close', 202610), null, 'y el ensayo y cierre');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '1 hour' where session_id = pruebas.sesion(pruebas.finanzas());
select is((pruebas.servidor(pruebas.finanzas(), 'finance_period', 202610) -> 'fresh_code'), 'false'::jsonb,
  'con finanzas y sin el código reciente se lee, y lo dice');
select pruebas.equipar(pruebas.finanzas());

-- ---------------------------------------------------------------------------------------
-- El periodo abierto: lo cobrado y lo asignado, sin ensayo.

select pruebas.corrida(202610, 'succeeded', 'dirty', interval '-3 hours');
create temporary table abierto as select pruebas.servidor(pruebas.finanzas(), 'finance_period', 202610) as r;
select is((select r -> 'fresh_code' from abierto), 'true'::jsonb, 'con el código reciente, lo dice');
select is((select r #>> '{period,status}' from abierto), 'open', 'el periodo, abierto');
select is((select r -> 'collected' from abierto),
  jsonb_build_object('charges', 4, 'gross_mxn_cents', 403700, 'revenue_net_mxn_cents',
                     (select sum(revenue_net_mxn_cents) from public.charges where period_id = 202610)),
  'lo cobrado en el periodo: cuatro cobros, con el anual entero');
select is((select r -> 'assigned' from abierto), '{"students": 4, "base_cents": 106148}'::jsonb,
  'lo asignado al periodo: lo que reparte el cierre, con un doceavo del anual');
select is((select r -> 'rehearsal' from abierto), 'null'::jsonb, 'sin ensayo todavía');
select is((select r #>> '{last_rollup,status}' from abierto), 'succeeded', 'la última consolidación');
select is((select (r ->> 'open_alerts')::integer from abierto), 0, 'sin alertas');
select is((select r -> 'rollup_request' from abierto), 'null'::jsonb, 'sin recálculo pedido');
select ok((select pruebas.sin_alumnos(r) from abierto), 'sin el identificador de ningún alumno');
select is((select pruebas.servidor(pruebas.finanzas(), 'finance_period', 209901) -> 'period'), 'null'::jsonb,
  'un periodo sin fila no tiene panel');
select pruebas.abierto(202611);
select is((select (r -> 'collected') || (r -> 'assigned') from (select pruebas.servidor(pruebas.finanzas(), 'finance_period', 202611) as r) x),
  jsonb_build_object('charges', 0, 'gross_mxn_cents', 0, 'revenue_net_mxn_cents', 0, 'students', 1,
                     'base_cents', (select sum(base_cents) from public.revenue_allocations where period_id = 202611)),
  'noviembre: nada cobrado en él, y asignado el doceavo del anual de C');

-- ---------------------------------------------------------------------------------------
-- En cierre: el ensayo por el servidor, y lo que dicen las lecturas.

select pruebas.en_cierre(202610);
select pruebas.corrida(202610, 'succeeded', 'full', interval '-1 hour');
select pruebas.como_dueno_sistema();
insert into public.anomaly_alerts (period_id, kind, metric_value, threshold_value) values (202610, 'unconsumed_pool_ratio', 9000, 5000);
select pruebas.como_dueno();
create temporary table ensayo as select pruebas.servidor(pruebas.finanzas(), 'rehearse_close', 202610) as r;
select is((select r ->> 'outcome' from ensayo), 'rehearsed', 'el servidor ensaya');
select ok(exists (select 1 from public.close_runs where id = (select (r ->> 'run_id')::uuid from ensayo)
                  and started_by = pruebas.finanzas()), 'a nombre de quien actúa');
create temporary table panel as select pruebas.servidor(pruebas.finanzas(), 'finance_period', 202610) as r;
select is((select (r -> 'rehearsal') - 'at' from panel),
  jsonb_build_object('run_id', (select r ->> 'run_id' from ensayo), 'period_status_at_run', 'closing', 'active_students', 4,
                     'pool_bps', 6000, 'net_revenue_cents', 106148, 'pool_cents', 63687, 'assigned_cents', 46539,
                     'unconsumed_cents', 17148, 'carried_out_cents', 0),
  'el panel da las cifras del último ensayo, sin recalcular');
select is((select (r ->> 'open_alerts')::integer from panel), 1, 'y cuántas alertas faltan por revisar');
create temporary table cierre_antes as select pruebas.servidor(pruebas.finanzas(), 'finance_close', 202610) as r;
select is((select jsonb_path_query_array(r, '$.rehearsal.teachers[*].total_cents') from cierre_antes), '[24494, 35843, 3350]'::jsonb,
  'el ensayo y cierre da la tabla por maestro del ensayo');
select is((select r #>> '{rehearsal,teachers,0,name}' from cierre_antes), 'Maestra m1', 'con el nombre de cada maestro');
select is((select r #> '{rehearsal,teachers,0,below_minimum}' from cierre_antes), 'true'::jsonb, 'y si queda debajo del mínimo');
select is((select r -> 'checks' from cierre_antes),
  '{"open_alerts": 1, "final_rehearsal": true, "last_rollup": "succeeded", "rollup_marks": false}'::jsonb,
  'y lo que sabe sin calcular de lo que falta para cerrar');
select is((select r -> 'close' from cierre_antes), 'null'::jsonb, 'todavía sin cierre');
select ok((select pruebas.sin_alumnos(r) from cierre_antes), 'sin el identificador de ningún alumno');
-- Un ensayo que falla después: el panel sigue con las cifras del último bueno; el ensayo y cierre dice que falló, sin su error.
set local session_replication_role = replica;
insert into public.close_runs (period_id, kind, status, period_status_at_run, code_version, parameters, started_by, started_at,
                               finished_at, error)
values (202610, 'rehearsal', 'failed', 'closing', 'prueba', '{}', pruebas.finanzas(), now() + interval '1 second',
        now() + interval '2 seconds', 'XX000: un error interno de prueba');
set local session_replication_role = origin;
select is(pruebas.servidor(pruebas.finanzas(), 'finance_period', 202610) #>> '{rehearsal,run_id}', (select r ->> 'run_id' from ensayo),
  'después de un ensayo fallido, el panel sigue con el último que salió bien');
select ok((select r #>> '{rehearsal,status}' = 'failed' and r::text not like '%un error interno%'
           from (select pruebas.servidor(pruebas.finanzas(), 'finance_close', 202610) as r) x),
  'y el ensayo y cierre dice que el último falló, sin el texto del error');

-- ---------------------------------------------------------------------------------------
-- El cierre por el servidor, sin la alerta (aquí no importa cómo se revisa).

set local session_replication_role = replica;
delete from public.anomaly_alerts where period_id = 202610;
set local session_replication_role = origin;
create temporary table cierre as select pruebas.servidor(pruebas.finanzas(), 'close_period', 202610) as r;
select is((select r ->> 'outcome' from cierre), 'closed', 'el servidor cierra');
set constraints payout_periods_balanced immediate;
set constraints payout_periods_balanced deferred;
create temporary table cerrado as select pruebas.servidor(pruebas.finanzas(), 'finance_close', 202610) as r;
select is((select (r -> 'close') - 'at' - 'export' - 'teachers' from cerrado),
  jsonb_build_object('run_id', (select r ->> 'close_run_id' from cierre), 'closed_by', 'Fernanda Finanzas', 'pool_bps', 6000,
                     'active_students', 4, 'net_revenue_cents', 106148, 'pool_cents', 63687, 'assigned_cents', 46539,
                     'unconsumed_cents', 17148, 'carried_out_cents', 0),
  'cerrado: quién cerró y con qué cifras');
select is((select (r #> '{close,export}') - 'created_at' from cerrado),
  jsonb_build_object('rows', 3, 'sha256', (select encode(sha256, 'hex') from private.close_exports where period_id = 202610)),
  'y su exportación, con su huella');
select is((select jsonb_path_query_array(r, '$.close.teachers[*].total_cents') from cerrado), '[24494, 35843, 3350]'::jsonb,
  'con la tabla por maestro del cierre');
select is((select r #>> '{period,status}' from cerrado), 'closed', 'el periodo, cerrado');
create temporary table lista as select pruebas.servidor(pruebas.finanzas(), 'finance_periods', null) as r;
select is((select e - 'starts_at' - 'ends_at' - 'rehearsed_at' from lista, jsonb_array_elements(r -> 'periods') e
           where (e ->> 'period_id')::integer = 202610),
  '{"period_id": 202610, "status": "closed", "active_students": 4, "pool_bps": 6000, "pool_cents": 63687, "unconsumed_cents": 17148,
    "payouts": {"total": 3, "paid": 0}}'::jsonb,
  'la lista de periodos: el cerrado con sus cifras y sus liquidaciones pagadas del total');
select is((select (r -> 'periods' -> 0 ->> 'period_id')::integer from lista),
  (select max(period_id) from public.payout_periods), 'el más reciente primero');

select * from finish();
rollback;
