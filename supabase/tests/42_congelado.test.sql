-- T-602 · Lo que congela un periodo cerrado (RN-09; 05 §5.10, §7.3, §8.2 y §13.2). Primera de dos
-- solicitudes; la segunda trae el ensayo y el cierre. Decisiones de Sergio del 2026-10-24: el cierre
-- va en orden, exige un recálculo completo, y las liquidaciones son de T-603.
--
-- Aquí ningún periodo se cierra todavía: el estado cerrado se fuerza con el guardián apagado,
-- dentro de la transacción. Los meses con fila son de 2032, que ninguna otra prueba toca.
begin;
\ir _ayuda.psql
select plan(55);

create function pruebas.inicio(p_period integer) returns timestamptz
language sql stable as $$ select timezone('America/Mexico_City', to_date(p_period::text || '01', 'YYYYMMDD')::timestamp) $$;
create function pruebas.fin(p_period integer) returns timestamptz
language sql stable as $$ select timezone('America/Mexico_City', to_date(p_period::text || '01', 'YYYYMMDD')::timestamp + interval '1 month') $$;
create function pruebas.fila(p_period integer, p_status text default 'open') returns void
language sql as $$
  select pruebas.como_dueno_sistema();
  insert into public.payout_periods (period_id, starts_at, ends_at, timezone, status)
  values (p_period, pruebas.inicio(p_period), pruebas.fin(p_period), 'America/Mexico_City', p_status::public.period_status);
  select pruebas.como_dueno();
$$;
-- Un estado que esta solicitud todavía no escribe (cerrado, pagado): sin el guardián.
create function pruebas.forzar(p_period integer, p_status text) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  alter table public.payout_periods disable trigger payout_periods_guard;
  update public.payout_periods set status = p_status::public.period_status,
         entered_closing_at = case when p_status = 'open' then null else coalesce(entered_closing_at, now()) end
  where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard;
  perform pruebas.como_dueno();
end
$$;
create function pruebas.estado(p_period integer) returns text language sql stable
as $$ select status::text from public.payout_periods where period_id = p_period $$;
create function pruebas.ana() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000042'::uuid $$;
create function pruebas.curso(p_slug text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', jsonb_build_array(
      jsonb_build_object('title', 'Uno', 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'Asset' || p_slug, 'playback_id', 'Playback' || p_slug, 'duration_seconds', 100))))))
$$;
create function pruebas.consolidado(p_period integer, p_points integer default 2) returns void
language sql as $$
  insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                   lesson_duration_seconds, covered_seconds, half_points)
  select p_period, pruebas.ana(), l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, 100, p_points
  from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug = 'congelado-m1'
$$;
-- Una hora del día anterior en la zona de los periodos.
create function pruebas.ayer() returns timestamptz language sql stable
as $$ select timezone('America/Mexico_City', date_trunc('day', timezone('America/Mexico_City', now())) - interval '12 hours') $$;
create function pruebas.marcas(p_period integer) returns integer language sql stable
as $$ select count(*)::integer from private.rollup_dirty where period_id = p_period and profile_id = pruebas.ana() $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.alta(pruebas.ana(), 'ana-congelado@prueba.test');
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra congelado', 'maestra-congelado', null), pruebas.curso('congelado-m1'));
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- Las claves: el consolidado, las alertas y las exclusiones apuntan a su periodo.

select fk_ok('public', 'watch_rollup', 'period_id', 'public', 'payout_periods', 'period_id', 'el consolidado apunta a su periodo');
select fk_ok('public', 'anomaly_alerts', 'period_id', 'public', 'payout_periods', 'period_id', 'las alertas también');
select fk_ok('public', 'consumption_exclusions', 'period_id', 'public', 'payout_periods', 'period_id', 'y las exclusiones');
select throws_ok($$select pruebas.consolidado(203212)$$, '23503', null, 'un consolidado de un mes sin fila no entra');
select has_trigger('public', 'watch_rollup', 'watch_rollup_frozen', 'el consolidado se congela');
select is((select prosecdef from pg_proc where oid = 'private.guard_frozen_period()'::regprocedure), false,
  'el guardián de lo congelado no corre como el dueño');
select is((select prosecdef from pg_proc where oid = 'private.check_revenue_parts()'::regprocedure), true,
  'la revisión de las partes de un cobro sí: corre al confirmar, con el rol de la sesión');

-- ---------------------------------------------------------------------------------------
-- El consolidado de un periodo cerrado o pagado no cambia: ni entra, ni cambia, ni se borra.

select pruebas.fila(203201);
select lives_ok($$select pruebas.consolidado(203201)$$, 'con el periodo abierto entra');
select pruebas.forzar(203201, 'closing');
select lives_ok($$update public.watch_rollup set covered_seconds = 90, half_points = 1 where period_id = 203201$$,
  'en cierre se sigue corrigiendo');
select pruebas.forzar(203201, 'closed');
select throws_ok($$update public.watch_rollup set covered_seconds = 100, half_points = 2 where period_id = 203201$$, '55000', null,
  'cerrado, no cambia');
select throws_ok($$delete from public.watch_rollup where period_id = 203201$$, '55000', null, 'ni se borra');
select throws_ok($$update public.watch_rollup set period_id = 203202 where period_id = 203201$$, '55000', null,
  'ni se muda a otro periodo');
select pruebas.fila(203202);
select pruebas.forzar(203202, 'paid');
select throws_ok($$select pruebas.consolidado(203202)$$, '55000', null, 'en uno pagado tampoco entra');
select pruebas.fila(203203);
select pruebas.consolidado(203203);
select throws_ok($$update public.watch_rollup set period_id = 203201 where period_id = 203203$$, '55000', null,
  'ni se muda uno abierto a un periodo cerrado');
select is((select half_points::integer from public.watch_rollup where period_id = 203201), 1, 'y el cerrado queda como estaba');

-- ---------------------------------------------------------------------------------------
-- Marcar pares (exclusiones, suspensión por fraude): un periodo cerrado no se marca.

select is(private.mark_pairs_for(pruebas.ana(), 203203, null, null), 1, 'un periodo abierto se marca');
select is(pruebas.marcas(203203), 1, 'con su marca');
select is(private.mark_pairs_for(pruebas.ana(), 203201, null, null), 0, 'uno cerrado, no');
select is(pruebas.marcas(203201), 0, 'sin marca');
select is(private.mark_pairs_for(pruebas.ana(), 203212, null, null), 0, 'uno sin fila, sin nada que marcar, tampoco');
select is((select provolatile::text from pg_proc where oid = 'private.mark_pairs_for(uuid, public.period_id, uuid, uuid)'::regprocedure), 'v',
  'marcar es volátil: toma candado');

-- ---------------------------------------------------------------------------------------
-- Un paso de la consolidación sobre un periodo cerrado no hace nada, y lo anota.

insert into private.rollup_dirty (period_id, profile_id, lesson_id, touched_at)
select 203201, pruebas.ana(), l.id, now() - interval '1 day'
from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug = 'congelado-m1';
select set_config('pruebas.corrida', private.open_job_run('nightly_rollup', 203201, 'dirty')::text, true);
select is(private.rollup_step(current_setting('pruebas.corrida')::uuid, now() + interval '1 hour') ->> 'read', '0',
  'un paso sobre un periodo cerrado no lee nada');
select is((select details ->> 'period_closed' from public.job_runs where id = current_setting('pruebas.corrida')::uuid), 'true',
  'y la corrida lo dice');
select is(pruebas.marcas(203201), 1, 'la marca se queda: la corrida de cada noche ya no recorre un periodo cerrado');
select private.close_job_run(current_setting('pruebas.corrida')::uuid, null);

-- ---------------------------------------------------------------------------------------
-- Qué modo usa la corrida de cada noche: completo con `p_full`, o la primera noche de un periodo en
-- cierre sin una corrida completa correcta desde que entró en cierre; si no, de marcas.

select pruebas.fila(203204);
select is(private.rollup_mode(203204, false), 'dirty', 'un periodo abierto, de marcas');
select is(private.rollup_mode(203204, true), 'full', 'con el recálculo pedido, completo');
select is(private.rollup_mode(203212, false), 'dirty', 'un mes sin fila, de marcas');
select pruebas.forzar(203204, 'closing');
select is(private.rollup_mode(203204, false), 'full', 'la primera noche en cierre, completo');
insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
values ('nightly_rollup', 203204, 'succeeded', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days', '{"mode": "full"}');
select is(private.rollup_mode(203204, false), 'full', 'una completa de antes de entrar en cierre no cuenta');
insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details, error)
values ('nightly_rollup', 203204, 'failed', clock_timestamp(), clock_timestamp(), clock_timestamp(), '{"mode": "full"}', 'x');
select is(private.rollup_mode(203204, false), 'full', 'ni una completa que falló');
insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
values ('nightly_rollup', 203204, 'succeeded', clock_timestamp(), clock_timestamp(), clock_timestamp(), '{"mode": "dirty"}');
select is(private.rollup_mode(203204, false), 'full', 'ni una de marcas');
insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
values ('nightly_rollup', 203204, 'succeeded', clock_timestamp(), clock_timestamp(), clock_timestamp(), '{"mode": "full"}');
select is(private.rollup_mode(203204, false), 'dirty', 'con una completa correcta desde que entró en cierre, de marcas');
select pruebas.forzar(203201, 'closed');
select is(private.rollup_mode(203201, false), 'dirty', 'un periodo cerrado no se recalcula (ni siquiera entra a la corrida)');

-- El recálculo completo borra las marcas de antes de su inicio de los pares que procesó: si no, el
-- cierre esperaría una noche más.
select pruebas.fila(203205);
select pruebas.consolidado(203205);
insert into private.rollup_dirty (period_id, profile_id, lesson_id, touched_at)
select 203205, pruebas.ana(), l.id, now() - interval '1 hour'
from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug = 'congelado-m1';
select set_config('pruebas.corrida', private.open_job_run('nightly_rollup', 203205, 'full')::text, true);
select is(private.rollup_step(current_setting('pruebas.corrida')::uuid, now()) ->> 'read', '1', 'el completo procesa el par');
select is(pruebas.marcas(203205), 0, 'y borra su marca de antes de empezar');
select private.close_job_run(current_setting('pruebas.corrida')::uuid, null);
insert into private.rollup_dirty (period_id, profile_id, lesson_id, touched_at)
select 203205, pruebas.ana(), l.id, now() + interval '1 hour'
from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug = 'congelado-m1';
select pruebas.consolidado(203205);
select set_config('pruebas.corrida', private.open_job_run('nightly_rollup', 203205, 'full')::text, true);
select is(private.rollup_step(current_setting('pruebas.corrida')::uuid, now()) ->> 'read', '1', 'otra vez');
select is(pruebas.marcas(203205), 1, 'pero no la de un latido que llegó después de empezar');
select private.close_job_run(current_setting('pruebas.corrida')::uuid, null);

-- ---------------------------------------------------------------------------------------
-- El aviso de un periodo que se queda abierto dos noches seguidas habiendo llegado a su día.

select pruebas.fila(203206);
-- Su fin, en el pasado, para que haya llegado a su día; se mueve con el guardián apagado.
select pruebas.como_dueno_sistema();
alter table public.payout_periods disable trigger payout_periods_guard;
update public.payout_periods set starts_at = '2021-12-01 06:00Z', ends_at = '2022-01-01 06:00Z' where period_id = 203206;
alter table public.payout_periods enable trigger payout_periods_guard;
select pruebas.como_dueno();
select set_config('pruebas.paso', private.period_transition(array[]::public.period_id[])::text, true);
select ok(current_setting('pruebas.paso')::jsonb -> 'held_open' @> '[203206]', 'llegó a su día y no se consolidó: se queda abierto');
select ok(not current_setting('pruebas.paso')::jsonb ? 'held_open_again', 'la primera noche no avisa');
insert into public.job_runs (job, status, started_at, heartbeat_at, finished_at, details)
values ('period_transition', 'succeeded', now(), now(), now(), '{"held_open": [203206]}');
select ok(not private.period_transition(array[]::public.period_id[]) ? 'held_open_again', 'otra corrida del mismo día tampoco');
insert into public.job_runs (job, status, started_at, heartbeat_at, finished_at, details)
values ('period_transition', 'succeeded', pruebas.ayer(), pruebas.ayer(), pruebas.ayer(), '{"held_open": [203206]}');
select is(private.period_transition(array[]::public.period_id[]) -> 'held_open_again', '[203206]'::jsonb,
  'la segunda noche seguida, sí');

-- ---------------------------------------------------------------------------------------
-- Sellar la partición de los latidos de un periodo que ya no está abierto: no entra ningún latido.

select pruebas.fila(203207);
select private.create_watch_partition(203207);
select throws_ok($$select private.seal_watch_partition(203207)$$, '23514', null, 'la de un periodo abierto no se sella');
select pruebas.forzar(203207, 'closed');
select lives_ok($$select private.seal_watch_partition(203207)$$, 'la de uno cerrado, sí');
select ok(exists (select 1 from pg_constraint where conname = 'watch_events_203207_sealed'
                  and conrelid = 'public.watch_events_203207'::regclass and not convalidated),
  'con una restricción que no revisa lo que ya estaba');
select lives_ok($$select private.seal_watch_partition(203207)$$, 'sellarla dos veces no hace nada');
select pruebas.fila(203208);
select pruebas.forzar(203208, 'closed');
select is(private.seal_watch_partition(203208), false, 'un periodo sin partición no tiene nada que sellar');
select is((select count(*)::integer from private.unsealed_partitions() where period_id = 203207), 0,
  'una sellada ya no está pendiente');
select pruebas.fila(203209);
select private.create_watch_partition(203209);
select pruebas.forzar(203209, 'paid');
select ok(exists (select 1 from private.unsealed_partitions() where period_id = 203209), 'la de uno pagado sin sellar, sí');

-- ---------------------------------------------------------------------------------------
-- La revisión de las partes de un cobro corre con el rol de quien confirma: el servidor (T-303).

select pruebas.alta('a0000000-0000-0000-0000-000000000043', 'beto-congelado@prueba.test');
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
values ('c0000000-0000-0000-0000-000000000043', 'a0000000-0000-0000-0000-000000000043', 'manual', 'sus-congelado', 'monthly', 'pending', 'MXN');
grant execute on function private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint,
                                                 bigint, bigint, text, text, text) to app_service;
set constraints revenue_allocations_match_charge deferred;
select pruebas.como_sistema();
select is(private.record_charge('a0000000-0000-0000-0000-000000000043', 'c0000000-0000-0000-0000-000000000043', 'manual', 'cobro-congelado',
                                null, 'monthly', now() - interval '1 hour', 'MXN', 34900, null, null, null, null, null) ->> 'outcome',
  'recorded', 'el servidor registra un cobro (con el permiso de esta prueba)');
select lives_ok('set constraints revenue_allocations_match_charge immediate', 'y la revisión de sus partes, con su rol, pasa');
select pruebas.como_dueno();
revoke execute on function private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint,
                                                  bigint, bigint, text, text, text) from app_service;

-- ---------------------------------------------------------------------------------------
-- El vigilante de los periodos ve lo nuevo.

select is_empty($$select * from private.schema_violations_periods()$$, 'el vigilante de los periodos no encuentra nada');
alter table public.watch_rollup disable trigger watch_rollup_frozen;
select results_eq($$select problem, object_name from private.schema_violations_periods()$$,
  $$values ('period trigger missing or disabled: watch_rollup_frozen', 'public.watch_rollup')$$, 'el congelado del consolidado apagado');
alter table public.watch_rollup enable trigger watch_rollup_frozen;
grant execute on function private.seal_watch_partition(public.period_id) to app_service;
select results_eq($$select problem, object_name like 'private.seal_watch_partition(%' from private.schema_violations_periods()$$,
  $$values ('period function executable by app_service', true)$$, 'sellar no lo ejecuta la aplicación');
revoke execute on function private.seal_watch_partition(public.period_id) from app_service;
alter function private.check_revenue_parts() security invoker;
select results_eq($$select problem, object_name like 'private.check_revenue_parts(%' from private.schema_violations_periods()$$,
  $$values ('period function not security definer', true)$$, 'la revisión de las partes, sin correr como el dueño');
alter function private.check_revenue_parts() security definer;
select is_empty($$select * from private.schema_violations_periods()$$, 'y todo en su lugar otra vez');

select * from finish();
rollback;
