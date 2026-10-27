-- T-603 · La purga de los latidos (05 §11.4 y §13.2; decisión de Sergio del 2026-10-25). Una partición de
-- `watch_events` se borra cuando su periodo está cerrado o pagado, pasó `RETENCION_LATIDOS` desde el
-- cierre, no tiene liquidaciones retenidas y no queda progreso por rehacer que lea esos latidos. Con ella
-- se van las reproducciones que ya no tienen ninguna partición, salvo las que otra señala como la que tomó
-- su lugar. La corrida diaria (`raw_retention`) confirma por periodo: aquí no se puede llamar dentro de
-- una transacción; la prueba de integración `57-purga` la corre de verdad.
--
-- Usa los meses de 2032, que ninguna otra prueba usa, con sus propias particiones.
begin;
\ir _ayuda.psql
select plan(29);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a6060000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.curso(p_slug text) returns jsonb language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', (
      select jsonb_agg(jsonb_build_object('title', t, 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'Asset' || p_slug || n, 'playback_id', 'Playback' || p_slug || n, 'duration_seconds', 100)) order by n)
      from unnest(array['Uno', 'Dos']) with ordinality as l (t, n)))))
$$;
-- Un periodo cerrado hace tantos días, con el guardián apagado: aquí el reloj no avanza.
create function pruebas.cerrado(p_period integer, p_closed_at timestamptz) returns void language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(p_period);
  alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
  update public.payout_periods set status = 'closed', closed_at = p_closed_at,
         entered_closing_at = coalesce(entered_closing_at, p_closed_at - interval '1 day') where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
  perform pruebas.como_dueno();
end
$$;
-- Una reproducción de la alumna, con su inicio y su último latido; revocada por otra, si se dice.
create function pruebas.reproduccion(p_n integer, p_started timestamptz, p_last timestamptz, p_replaced_by integer default null)
returns void language sql as $$
  insert into public.playback_sessions (id, profile_id, auth_session_id, course_id, lesson_id, video_asset_id, teacher_id, access_basis,
                                        counts_for_payout, lesson_duration_seconds, started_at, last_heartbeat_at, revoked_at,
                                        revoke_reason, revoked_by)
  select ('d6060000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid, pruebas.al(1), gen_random_uuid(), l.course_id, l.id,
         l.video_asset_id, l.teacher_id, 'subscription', true, 100, p_started, p_last,
         case when p_replaced_by is not null then p_last end, case when p_replaced_by is not null then 'replaced' end,
         case when p_replaced_by is not null then ('d6060000-0000-0000-0000-' || lpad(p_replaced_by::text, 12, '0'))::uuid end
  from public.published_lessons l join public.published_courses c on c.course_id = l.course_id
  where c.slug = 'purga-m1' and l.title = 'Uno'
$$;
create function pruebas.queda(p_n integer) returns boolean language sql stable
as $$ select exists (select 1 from public.playback_sessions where id = ('d6060000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid) $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- La alumna, un maestro con su curso, y los meses de enero a marzo de 2032 con su partición.
select pruebas.alta(pruebas.al(1), 'alumna-purga@prueba.test');
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra purga', 'maestra-purga-m1', null), pruebas.curso('purga-m1'));
select private.create_watch_partition(p) from unnest(array[203201, 203202, 203203]) p;
select pruebas.como_dueno();
select pruebas.cerrado(203201, now() - interval '100 days');
select pruebas.cerrado(203202, now() - interval '100 days');
select pruebas.como_dueno_sistema();
select private.open_period(203203);
select pruebas.como_dueno();

-- Las reproducciones: 1, solo en enero; 2, de enero a febrero; 3, en enero, reemplazada por 4, también en
-- enero; 6, en enero, reemplazada por 5, que es de febrero; y 7, de enero a febrero, reemplazada por 8,
-- que empezó después pero terminó en enero.
select pruebas.reproduccion(4, '2032-01-12 12:00-06', '2032-01-12 12:30-06');
select pruebas.reproduccion(5, '2032-02-03 12:00-06', '2032-02-03 12:30-06');
select pruebas.reproduccion(1, '2032-01-10 12:00-06', '2032-01-10 12:30-06');
select pruebas.reproduccion(2, '2032-01-31 23:50-06', '2032-02-01 00:20-06');
select pruebas.reproduccion(3, '2032-01-12 11:00-06', '2032-01-12 11:30-06', 4);
select pruebas.reproduccion(6, '2032-01-20 11:00-06', '2032-01-20 11:30-06', 5);
select pruebas.reproduccion(8, '2032-01-31 23:55-06', '2032-01-31 23:58-06');
select pruebas.reproduccion(7, '2032-01-31 23:50-06', '2032-02-01 00:20-06', 8);

-- ---------------------------------------------------------------------------------------
-- Las piezas.

select ok(not has_function_privilege('app_service', 'private.purge_watch_partition(public.period_id)', 'execute')
          and not has_function_privilege('app_service', 'private.raw_retention()', 'execute'),
  'la aplicación no purga');
select is((select schedule || ' ' || command from cron.job where jobname = 'raw_retention'), '45 9 * * * call private.raw_retention()',
  'pg_cron la corre cada día, después de la consolidación');
select is((select format('%s %s %s', schedule, expected_every, alert_after) from public.job_definitions where job = 'raw_retention'),
  '45 9 * * * 1 day 3 days', 'y se espera cada día, con alerta a los tres');

-- ---------------------------------------------------------------------------------------
-- Cada condición.

select pruebas.como_dueno_sistema();
create temporary table retencion as
  select id from public.business_parameters where key = 'RETENCION_LATIDOS' and canceled_at is null;
update public.business_parameters set canceled_at = now() where id in (select id from retencion);
select is(private.purge_watch_partition(203201), 'no_retention', 'sin RETENCION_LATIDOS no se purga nada');
insert into public.business_parameters (key, value, status, effective_from)
values ('RETENCION_LATIDOS', '90', 'decided', clock_timestamp() - interval '1 second');
select pruebas.como_dueno();
select is(private.purge_watch_partition(203203), 'not_closed', 'un periodo abierto no se purga');
select is(private.purge_watch_partition(203601), 'not_closed', 'ni uno sin fila');
select pruebas.cerrado(203201, now() - interval '90 days' + interval '1 second');
select is(private.purge_watch_partition(203201), 'within_retention', 'un segundo antes de los 90 días, todavía no');
select pruebas.cerrado(203201, now() - interval '90 days');
set local session_replication_role = replica;
insert into public.payouts (id, period_id, teacher_id, close_run_id, status, pool_cents, subtotal_cents, net_cents,
                            held_from_status, held_at, held_by, hold_reason)
select 'e6060000-0000-0000-0000-000000000001', 203201, teacher_id, gen_random_uuid(), 'on_hold', 100, 100, 100,
       'calculated', now(), pruebas.al(1), 'Se investiga.'
from public.published_courses where slug = 'purga-m1';
set local session_replication_role = origin;
select is(private.purge_watch_partition(203201), 'on_hold', 'con una liquidación retenida, no: el crudo es la evidencia');
set local session_replication_role = replica;
delete from public.payouts where id = 'e6060000-0000-0000-0000-000000000001';
set local session_replication_role = origin;
insert into private.progress_rebuilds (profile_id, lesson_id, failed_at, code)
select pruebas.al(1), lesson_id, now(), 'prueba' from public.playback_sessions where id = 'd6060000-0000-0000-0000-000000000002';
select is(private.purge_watch_partition(203201), 'progress_pending', 'con progreso por rehacer que lee esos latidos, tampoco');
delete from private.progress_rebuilds where profile_id = pruebas.al(1);
select pruebas.cerrado(203501, now() - interval '1 year');
select is(private.purge_watch_partition(203501), 'no_partition', 'un periodo sin partición no tiene nada que purgar');

-- ---------------------------------------------------------------------------------------
-- La purga de enero.

select is(private.purge_watch_partition(203201), 'purged', 'a los 90 días exactos, con todo en orden, se purga');
select ok(to_regclass('public.watch_events_203201') is null, 'la partición de enero ya no existe');
select ok(to_regclass('public.watch_events_203202') is not null, 'la de febrero sigue');
select ok(pruebas.queda(1), 'borrar la partición no borra reproducciones: van aparte, en otra transacción');
select is(private.purge_playback_sessions(203201), 4, 'después se borran las de enero que ya no tienen partición');
select ok(not pruebas.queda(1), 'la reproducción solo de enero se fue');
select ok(pruebas.queda(2), 'la que cruza a febrero, que tiene partición, se queda');
select ok(not pruebas.queda(3) and not pruebas.queda(4), 'la reemplazada y la que la reemplazó, las dos de enero, se fueron');
select ok(not pruebas.queda(6) and pruebas.queda(5), 'la de enero reemplazada por una de febrero se va; la de febrero se queda');
select ok(pruebas.queda(7) and pruebas.queda(8), 'la que cruza a febrero se queda, y la de enero que la reemplazó también: la señala');
select is(private.purge_watch_partition(203201), 'no_partition', 'purgar otra vez no hace nada');

-- Febrero: con su partición se van las que quedaban.
select is(private.purge_watch_partition(203202), 'purged', 'febrero se purga');
select is(private.purge_playback_sessions(203202), 4, 'y sus reproducciones');
select ok(not pruebas.queda(2) and not pruebas.queda(5) and not pruebas.queda(7) and not pruebas.queda(8),
  'y con él las reproducciones que quedaban');

-- Pagado también se purga.
select pruebas.como_dueno_sistema();
alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
update public.payout_periods set status = 'paid', closed_at = now() - interval '200 days', entered_closing_at = now() - interval '201 days'
where period_id = 203203;
alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
select pruebas.como_dueno();
select is(private.purge_watch_partition(203203), 'purged', 'un periodo pagado también');

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is_empty($$select * from private.schema_violations_payouts()$$, 'en orden');
select pruebas.como_dueno_sistema();
grant execute on function private.purge_watch_partition(public.period_id) to app_service;
select results_eq($$select problem, object_name like 'private.purge_watch_partition(%' from private.schema_violations_payouts()$$,
  $$values ('payouts function executable by app_service', true)$$, 'la purga al alcance del servidor');
revoke execute on function private.purge_watch_partition(public.period_id) from app_service;
select cron.unschedule('raw_retention');
select results_eq($$select problem, object_name from private.schema_violations_payouts()$$,
  $$values ('payouts job not scheduled: raw_retention', 'cron.job')$$, 'la purga sin programar');
select cron.schedule('raw_retention', '45 9 * * *', 'call private.raw_retention()');
select is_empty($$select * from private.schema_violations_payouts()$$, 'y en orden otra vez');
select pruebas.como_dueno();

select * from finish();
rollback;
