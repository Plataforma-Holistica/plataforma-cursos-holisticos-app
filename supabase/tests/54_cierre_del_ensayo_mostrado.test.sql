-- T-605, tercera solicitud · El cierre congela el ensayo que se mostró (05 §8.6). Decisión de Sergio del
-- 2026-10-27: quien cierra dice qué ensayo tenía a la vista (`close_period(p_period, p_run)`), y la base
-- solo cierra si ese es el último ensayo del periodo (`private.last_rehearsal`, por `finished_at`), salió
-- bien con datos finales y su huella es la de la entrada de ahora. Antes aceptaba cualquier ensayo con la
-- huella de ahora: si la entrada volvía a la de un ensayo anterior, se congelaba un reparto que nadie veía.
-- Además, PA-79 lee el umbral de `ALERTA_SIN_CONSUMO_PCT` y si el bote sin consumo lo pasa, con la misma
-- expresión que la alerta (decisiones de Sergio de ese día: el umbral vigente al cerrar, solo con datos
-- finales, sobre el bote del mes sin lo que pasó del anterior).
--
-- Octubre de 2026 es el ejemplo del PRD, como en `43_cierre` y `52_exportacion_del_cierre`. La
-- comprobación al confirmar corre al confirmar y aquí nada confirma: `pruebas.cierra()` la adelanta.
begin;
\ir _ayuda.psql
select plan(37);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a6054000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b6054000-0000-0000-0000-000000000001'::uuid $$;
create table pruebas.etiquetas (id uuid primary key, et text not null);
create function pruebas.m(p_et text) returns uuid language sql stable as $$ select id from pruebas.etiquetas where et = p_et $$;

create function pruebas.como_finanzas() returns void language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', pruebas.finanzas()::text, true),
         set_config('app.actor_session', pruebas.sesion(pruebas.finanzas())::text, true);
$$;
create function pruebas.ensaya(p_period integer) returns uuid language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  v := private.rehearse_close(p_period);
  perform pruebas.limpiar();
  if v ->> 'outcome' <> 'rehearsed' then
    raise exception 'no ensayó: %', v;
  end if;
  return (v ->> 'run_id')::uuid;
end
$$;
create function pruebas.cierra(p_period integer, p_run uuid) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  v := private.close_period(p_period, p_run);
  set constraints payout_periods_balanced immediate;
  set constraints payout_periods_balanced deferred;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.lee(p_fn text, p_period integer) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  execute format('select private.%I($1)', p_fn) using p_period into v;
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
create function pruebas.cobra(p_n integer, p_at timestamptz, p_gross bigint) returns text language sql as $$
  select private.record_charge(pruebas.al(p_n), ('c6054000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid, 'manual',
                               'cobro-mostrado-' || p_n || '-' || p_gross, null,
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
-- Un ensayo fallido, como lo deja `rehearse_close` cuando su cálculo lanza, escrito a mano: con el guardián
-- apagado (réplica), y su `finished_at` lo pone la columna, con el reloj de ahora.
create function pruebas.ensayo_fallido(p_period integer) returns uuid language plpgsql as $$
declare
  v uuid;
begin
  set local session_replication_role = replica;
  insert into public.close_runs (period_id, kind, status, period_status_at_run, code_version, parameters, started_by, error)
  values (p_period, 'rehearsal', 'failed', 'closing', private.code_version(), '{}'::jsonb, pruebas.finanzas(), 'division by zero')
  returning id into v;
  set local session_replication_role = origin;
  return v;
end
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

delete from public.job_runs where period_id between 202609 and 202712;

-- Las cuentas: cuatro alumnos del ejemplo y finanzas.
select pruebas.alta(pruebas.al(n), format('alumno%s-mostrado@prueba.test', n)) from generate_series(1, 4) n;
select pruebas.alta(pruebas.finanzas(), 'finanzas-mostrado@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-mostrado@prueba.test';
select pruebas.dar_capacidad(pruebas.finanzas(), 'finance');
select pruebas.equipar(pruebas.finanzas());

-- Los maestros del ejemplo.
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher(x.name, 'mostrado-' || x.s, null), pruebas.curso('mostrado-' || x.s))
from (values (1, 'm1', 'Maestra Uno'), (2, 'm2', 'Maestra Dos'), (3, 'm3', 'Maestra Tres')) as x (n, s, name) order by x.n;
select pruebas.como_dueno();
insert into pruebas.etiquetas select teacher_id, 'M' || right(slug, 1) from public.published_courses where slug like 'mostrado-m%';

-- Los cobros y el consumo de octubre, como en el ejemplo del PRD.
select pruebas.como_dueno_sistema();
select private.open_period(202610);
select pruebas.como_dueno();
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
select ('c6054000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, pruebas.al(n), 'manual', 'sus-mostrado-' || n,
       case when n = 3 then 'annual' else 'monthly' end::public.subscription_plan, 'pending', 'MXN'
from generate_series(1, 4) n;
select is(array[pruebas.cobra(1, '2026-10-05 12:00-06', 34900), pruebas.cobra(2, '2026-10-06 12:00-06', 34900),
                pruebas.cobra(3, '2026-10-07 12:00-06', 299000), pruebas.cobra(4, '2026-10-08 12:00-06', 34900)],
  array['recorded', 'recorded', 'recorded', 'recorded'], 'los cuatro cobros del ejemplo');
select pruebas.fila(202610, pruebas.al(1), 'mostrado-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres', 'Cuatro']) t;
select pruebas.fila(202610, pruebas.al(1), 'mostrado-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(1), 'mostrado-m2', 'Dos', 2),
       pruebas.fila(202610, pruebas.al(1), 'mostrado-m2', 'Tres', 1);
select pruebas.fila(202610, pruebas.al(2), 'mostrado-m2', 'Uno', 1);
select pruebas.fila(202610, pruebas.al(3), 'mostrado-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres']) t;
select pruebas.fila(202610, pruebas.al(3), 'mostrado-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(3), 'mostrado-m3', 'Uno', 2);
select pruebas.en_cierre(202610);
insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
values ('nightly_rollup', 202610, 'succeeded', now() - interval '1 hour', now() - interval '1 hour', now() - interval '59 minutes', '{"mode": "full"}');

-- ---------------------------------------------------------------------------------------
-- Las funciones.

select has_function('private', 'last_rehearsal', array['public.period_id'], 'existe el último ensayo de un periodo');
select is((select provolatile from pg_proc where oid = 'private.last_rehearsal(public.period_id)'::regprocedure), 's',
  'y es estable: lee, no escribe');
select has_function('private', 'close_period', array['public.period_id', 'uuid'], 'cerrar recibe el periodo y el ensayo mostrado');
select hasnt_function('private', 'close_period', array['public.period_id'], 'y ya no hay un cierre sin el ensayo');
select ok(has_function_privilege('app_service', 'private.close_period(public.period_id, uuid)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.close_period(public.period_id, uuid)', 'EXECUTE')
          and not has_function_privilege('anon', 'private.close_period(public.period_id, uuid)', 'EXECUTE'),
  'el servidor puede cerrar; las cuentas no');
select ok(not has_function_privilege('app_service', 'private.last_rehearsal(public.period_id)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'private.last_rehearsal(public.period_id)', 'EXECUTE'),
  'el último ensayo no lo llama nadie de la aplicación: lo leen las funciones de la base');
select is((select count(*)::integer from private.schema_violations_close()), 0, 'el vigilante del cierre está conforme');

-- ---------------------------------------------------------------------------------------
-- Sin ensayo, falta el ensayo.

select is(private.last_rehearsal(202610), null, 'sin ensayos, no hay último');
select is(pruebas.cierra(202610, null) ->> 'outcome', 'rehearsal_missing', 'sin ensayos, cerrar dice que falta el ensayo');

-- ---------------------------------------------------------------------------------------
-- El caso que se cierra: la entrada vuelve a la de un ensayo anterior.

create temporary table ensayos (et text primary key, id uuid not null);
insert into ensayos values ('a', pruebas.ensaya(202610));
select is(private.last_rehearsal(202610), (select id from ensayos where et = 'a'), 'el único ensayo es el último');
-- Cambia la entrada (un consumo de más), se ensaya otra vez, y la entrada vuelve a la de antes.
select pruebas.fila(202610, pruebas.al(4), 'mostrado-m3', 'Dos', 2);
insert into ensayos values ('b', pruebas.ensaya(202610));
select isnt((select input_hash from public.close_runs where id = (select id from ensayos where et = 'a')),
            (select input_hash from public.close_runs where id = (select id from ensayos where et = 'b')), 'los dos ensayos son de entradas distintas');
select is(private.last_rehearsal(202610), (select id from ensayos where et = 'b'), 'el último es el de después, por cuándo terminó');
delete from public.watch_rollup where period_id = 202610 and profile_id = pruebas.al(4);
select is(pruebas.cierra(202610, (select id from ensayos where et = 'b')) ->> 'outcome', 'rehearsal_stale',
  'con el último a la vista, que ya no es de los datos de ahora, no se cierra');
select is(pruebas.cierra(202610, (select id from ensayos where et = 'a')) ->> 'outcome', 'rehearsal_superseded',
  'con el de antes, aunque su huella sea la de ahora, tampoco: no es el que la pantalla muestra');
select is(pruebas.cierra(202610, gen_random_uuid()) ->> 'outcome', 'rehearsal_superseded', 'con un ensayo que no existe, tampoco');
select is(pruebas.cierra(202610, null) ->> 'outcome', 'rehearsal_superseded', 'sin decir cuál, tampoco');
select is((select status::text from public.payout_periods where period_id = 202610), 'closing', 'y el periodo sigue en cierre');

-- ---------------------------------------------------------------------------------------
-- El último ensayo falló, aunque haya uno bueno antes.

insert into ensayos values ('c', pruebas.ensaya(202610));
insert into ensayos values ('fallido', pruebas.ensayo_fallido(202610));
select is(private.last_rehearsal(202610), (select id from ensayos where et = 'fallido'), 'un ensayo fallido también cuenta como el último');
select is(pruebas.cierra(202610, (select id from ensayos where et = 'fallido')) ->> 'outcome', 'rehearsal_missing',
  'con el fallido a la vista, falta un ensayo bueno');
select is(pruebas.cierra(202610, (select id from ensayos where et = 'c')) ->> 'outcome', 'rehearsal_superseded',
  'con el bueno de antes, tampoco: la pantalla muestra el fallido');

-- Un ensayo parcial (hecho con el periodo abierto) como el último, con la huella de ahora: tampoco.
set local session_replication_role = replica;
insert into public.close_runs (period_id, kind, status, period_status_at_run, input_hash, result_hash, code_version, parameters,
                               active_students, pool_bps, carried_in_cents, net_revenue_cents, student_pools_cents, pool_cents,
                               assigned_cents, unconsumed_cents, carried_out_cents, started_by)
select period_id, kind, status, 'open', input_hash, result_hash, code_version, parameters, active_students, pool_bps, carried_in_cents,
       net_revenue_cents, student_pools_cents, pool_cents, assigned_cents, unconsumed_cents, carried_out_cents, started_by
from public.close_runs where id = (select id from ensayos where et = 'c');
set local session_replication_role = origin;
insert into ensayos values ('parcial', private.last_rehearsal(202610));
select is(pruebas.cierra(202610, (select id from ensayos where et = 'parcial')) ->> 'outcome', 'rehearsal_missing',
  'con un ensayo parcial a la vista, aunque su huella sea la de ahora, falta uno con datos finales');

-- ---------------------------------------------------------------------------------------
-- Lo que leen las pantallas es el mismo «último».

select is((pruebas.lee('finance_close', 202610) #>> '{rehearsal,run_id}')::uuid, (select id from ensayos where et = 'parcial'),
  'PA-80 muestra el último ensayo, bueno, parcial o fallido');
select is((pruebas.lee('finance_period', 202610) #>> '{rehearsal,run_id}')::uuid, (select id from ensayos where et = 'parcial'),
  'PA-79 toma sus cifras del último ensayo que salió bien');

-- ---------------------------------------------------------------------------------------
-- El umbral del bote sin consumo, en PA-79.

-- Con 200 pesos que pasaron del periodo anterior: el sin consumo del mes es 26.9 % de su bote (no pasa el 40 %
-- sembrado), pero sobre el bote con lo anterior sería 44.2 %. La alerta mira el del mes, y la tarjeta también.
set local session_replication_role = replica;
update public.payout_periods set carried_in_cents = 20000 where period_id = 202610;
set local session_replication_role = origin;
insert into ensayos values ('llevado', pruebas.ensaya(202610));
select is((pruebas.lee('finance_period', 202610) ->> 'unconsumed_over')::boolean,
          (select (r.student_pools_cents - r.assigned_cents) * 10000 > 4000::bigint * r.student_pools_cents
           from public.close_runs r where r.id = (select id from ensayos where et = 'llevado')),
  'lo que pasó del periodo anterior no cuenta para el umbral, como en la alerta');
set local session_replication_role = replica;
update public.payout_periods set carried_in_cents = 0 where period_id = 202610;
set local session_replication_role = origin;

-- Un ensayo bueno, con datos finales, vuelve a ser el último.
insert into ensayos values ('d', pruebas.ensaya(202610));
select is((pruebas.lee('finance_period', 202610) ->> 'unconsumed_alert_bps')::integer,
          nullif(private.parameter_value('ALERTA_SIN_CONSUMO_PCT', now()) #>> '{}', '')::integer,
  'el umbral es el parámetro vigente');
select is((pruebas.lee('finance_period', 202610) ->> 'unconsumed_over')::boolean,
          (select (r.student_pools_cents - r.assigned_cents) * 10000
                  > (private.parameter_value('ALERTA_SIN_CONSUMO_PCT', now()) #>> '{}')::bigint * r.student_pools_cents
           from public.close_runs r where r.id = (select id from ensayos where et = 'd')),
  'y si el sin consumo lo pasa, con la expresión de la alerta y el bote del mes sin lo que pasó del anterior');
select is((pruebas.lee('finance_period', 202610) #>> '{rehearsal,student_pools_cents}')::bigint,
          (select student_pools_cents from public.close_runs where id = (select id from ensayos where et = 'd')),
  'el ensayo trae el bote del mes, para el porcentaje');

-- ---------------------------------------------------------------------------------------
-- Cerrar con el ensayo que se ve.

-- Un ensayo cuyo resultado guardado no es el que da su entrada no se congela: el cierre lanza, con un código que
-- no es el de la suma que no cuadra.
set local session_replication_role = replica;
update public.close_runs set result_hash = sha256(convert_to('otro', 'UTF8')) where id = (select id from ensayos where et = 'd');
set local session_replication_role = origin;
select throws_ok($$select pruebas.cierra(202610, (select id from ensayos where et = 'd'))$$, 'XX000', null,
  'si lo calculado no es el resultado del ensayo mostrado, no se cierra');
set local session_replication_role = replica;
update public.close_runs r set result_hash = s.result_hash
from public.close_runs s where r.id = (select id from ensayos where et = 'd') and s.id = (select id from ensayos where et = 'c');
set local session_replication_role = origin;
create temporary table cierre as select pruebas.cierra(202610, (select id from ensayos where et = 'd')) as r;
select is((select r ->> 'outcome' from cierre), 'closed', 'con el último ensayo a la vista, bueno y de los datos de ahora, se cierra');
select is((select (r ->> 'rehearsal_run_id')::uuid from cierre), (select id from ensayos where et = 'd'), 'y dice con qué ensayo');
select is((select result_hash from public.close_runs where id = (select (r ->> 'close_run_id')::uuid from cierre)),
          (select result_hash from public.close_runs where id = (select id from ensayos where et = 'd')),
  'lo congelado es el resultado de ese ensayo');
select is((pruebas.lee('finance_period', 202610) ->> 'unconsumed_alert_bps')::integer,
          nullif(private.parameter_value('ALERTA_SIN_CONSUMO_PCT', (select closed_at from public.payout_periods where period_id = 202610)) #>> '{}', '')::integer,
  'cerrado, el umbral es el vigente al cerrar');

-- Si el parámetro cambia después del cierre, el cerrado sigue con el de entonces: el cierre se mueve a hace dos días y
-- desde ayer rige otro umbral (escrito sin su guardián).
set local session_replication_role = replica;
update public.payout_periods set closed_at = now() - interval '2 days' where period_id = 202610;
insert into public.business_parameters (key, value, status, effective_from)
values ('ALERTA_SIN_CONSUMO_PCT', '1', 'proposed', now() - interval '1 day');
set local session_replication_role = origin;
select is((pruebas.lee('finance_period', 202610) ->> 'unconsumed_alert_bps')::integer, 4000,
  'un cerrado sigue con el umbral vigente al cerrar, no con el de ahora');
select is((pruebas.lee('finance_period', 202610) ->> 'unconsumed_over')::boolean, false, 'y con él decide si lo pasa');

-- ---------------------------------------------------------------------------------------
-- Un periodo abierto: el ensayo es parcial y no se pinta la atención.

select pruebas.como_dueno_sistema();
select private.open_period(202611);
alter table public.payout_periods disable trigger payout_periods_guard;
update public.payout_periods set active_students = 4, pool_bps = 6000 where period_id = 202611;
alter table public.payout_periods enable trigger payout_periods_guard;
select pruebas.como_dueno();
select pruebas.fila(202611, pruebas.al(1), 'mostrado-m1', 'Uno', 2);
insert into ensayos values ('noviembre', pruebas.ensaya(202611));
select is((select period_status_at_run::text from public.close_runs where id = (select id from ensayos where et = 'noviembre')), 'open',
  'noviembre, abierto, tiene un ensayo parcial');
select is((pruebas.lee('finance_period', 202611) ->> 'unconsumed_over')::boolean, null, 'con un ensayo parcial no se dice si pasa el umbral');
select * from finish();
rollback;
