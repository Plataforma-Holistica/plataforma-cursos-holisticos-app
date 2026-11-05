-- T-408, primera solicitud · El estimado del maestro y su panel (RF-601, RF-602, RF-612; PA-41; plan en ~/.claude/plans/t408-panel-diseno.md, aprobado
-- por Sergio el 2026-11-04, con sus decisiones de ese día: el estimado va sin el bote sin consumo, la fuga de pocos alumnos se acepta por escrito y
-- las barras por día quedan fuera).
--
-- Cada noche, después de consolidar y detectar un periodo, `private.teacher_estimates_step` calcula con la entrada del cierre (`close_input`) lo que
-- el reparto le asignaría hoy a cada maestro con puntos, sin el bote sin consumo ni el bono del fundador, y las cifras por curso que el panel muestra.
-- Lo escribe todo de una vez en su propia corrida: un estimado que falla no deja fallida la consolidación ni detiene el cierre. El maestro lo lee con
-- `private.teacher_dashboard()`, sin decir quién es. Nunca se guarda ni sale la parte de cada alumno, sus puntos con otros maestros ni el porcentaje.

-- ---------------------------------------------------------------------------------------
-- Las tablas. En `private`, sin ningún permiso para la aplicación: el maestro lee por su función, y finanzas ya tiene el ensayo (PA-79). De solo
-- inserción y congeladas con su periodo. Sin clave foránea al periodo, al maestro ni al curso, como `revenue_allocations`: lo escribe solo el paso,
-- con lo que leyó del consolidado, y así una prueba que borra un periodo, un maestro o un curso no tiene que conocerlas.

create table private.teacher_estimate_runs (
  id uuid primary key default gen_random_uuid(),
  period_id public.period_id not null,
  input_hash bytea,                    -- la huella de `close_input` con que se calculó; nula si falló
  status text not null,
  error text,                          -- el código y un mensaje acotado
  started_at timestamptz not null,
  finished_at timestamptz not null,    -- «Actualizado el…» del panel
  constraint teacher_estimate_runs_period_uq unique (id, period_id),
  constraint teacher_estimate_runs_status check (status in ('succeeded', 'failed')),
  constraint teacher_estimate_runs_consistent check ((status = 'succeeded') = (input_hash is not null) and (status = 'failed') = (error is not null)),
  constraint teacher_estimate_runs_error_length check (pg_catalog.length(error) <= 300),
  constraint teacher_estimate_runs_times check (finished_at >= started_at)
);
comment on table private.teacher_estimate_runs is 'Cada corrida del estimado de los maestros (RF-601), una por periodo cada noche: bien, con la huella de su entrada, o fallida. Solo inserción.';
-- La última de un periodo, buena o no.
create index teacher_estimate_runs_last_idx on private.teacher_estimate_runs (period_id, finished_at desc, id desc);

create table private.teacher_period_estimates (
  run_id uuid not null,
  period_id public.period_id not null,
  teacher_id uuid not null,
  half_points integer not null,        -- los de sus alumnos con base: los que entran al reparto
  assigned_cents bigint not null,      -- lo asignado por consumo, sin el bote sin consumo (decisión 1 de Sergio del 2026-11-04)
  full_lessons integer not null,       -- lecciones terminadas: pares de alumno con base y lección con 2 medios puntos
  half_lessons integer not null,       -- a medias: con 1
  students integer not null,           -- sus alumnos con base y puntos, como `payout_teacher_totals.students`: una parte por alumno
  primary key (run_id, teacher_id),
  constraint teacher_period_estimates_run_fk foreign key (run_id, period_id) references private.teacher_estimate_runs (id, period_id),
  constraint teacher_period_estimates_not_negative check (
    half_points >= 0 and assigned_cents >= 0 and full_lessons >= 0 and half_lessons >= 0 and students >= 0)
);
comment on table private.teacher_period_estimates is 'El estimado de cada maestro con puntos de alumnos con base en una corrida (RF-601, RF-602). Sin fila en la última corrida buena, su estimado es 0. Solo inserción.';

create table private.teacher_period_course_figures (
  run_id uuid not null,
  period_id public.period_id not null,
  teacher_id uuid not null,            -- el maestro del consolidado (RN-14): un curso que cambió de maestro sale con cada uno
  course_id uuid not null,
  full_lessons integer not null,       -- todo, como en su fila: solo de alumnos con base
  half_lessons integer not null,
  students integer not null,
  primary key (run_id, teacher_id, course_id),
  constraint teacher_period_course_figures_run_fk foreign key (run_id, period_id) references private.teacher_estimate_runs (id, period_id),
  constraint teacher_period_course_figures_estimate_fk foreign key (run_id, teacher_id) references private.teacher_period_estimates (run_id, teacher_id),
  constraint teacher_period_course_figures_not_negative check (full_lessons >= 0 and half_lessons >= 0 and students >= 0)
);
comment on table private.teacher_period_course_figures is 'Las cifras de cada curso de cada maestro en una corrida del estimado, para el panel (PA-41): el panel no agrega nada en vivo. Solo inserción.';

alter table private.teacher_estimate_runs enable row level security;
alter table private.teacher_period_estimates enable row level security;
alter table private.teacher_period_course_figures enable row level security;
revoke all on private.teacher_estimate_runs, private.teacher_period_estimates, private.teacher_period_course_figures
  from public, anon, authenticated, service_role, app_service;

create trigger teacher_estimate_runs_frozen before insert or update or delete on private.teacher_estimate_runs
  for each row execute function private.guard_frozen_period('period_id');
create trigger teacher_period_estimates_frozen before insert or update or delete on private.teacher_period_estimates
  for each row execute function private.guard_frozen_period('period_id');
create trigger teacher_period_course_figures_frozen before insert or update or delete on private.teacher_period_course_figures
  for each row execute function private.guard_frozen_period('period_id');
create trigger ledger_no_update_delete before update or delete on private.teacher_estimate_runs
  for each row execute function private.reject_mutation();
create trigger ledger_no_update_delete before update or delete on private.teacher_period_estimates
  for each row execute function private.reject_mutation();
create trigger ledger_no_update_delete before update or delete on private.teacher_period_course_figures
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.teacher_estimate_runs
  for each statement execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.teacher_period_estimates
  for each statement execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.teacher_period_course_figures
  for each statement execute function private.reject_mutation();

-- ---------------------------------------------------------------------------------------
-- El paso. Lo llama la corrida de cada noche después de consolidar y detectar cada periodo, con su propio `commit`; así también los recálculos
-- pedidos, que corren la misma corrida. Toma la fila del periodo con candado compartido, como los congelados, y la tiene hasta confirmar: un
-- cierre en vuelo lo hace esperar y después ve el periodo cerrado, y un cierre que llega después espera a que el estimado confirme.
--
-- Contesta:
--   {outcome: 'estimated', run_id, teachers}   escrito: una fila por maestro con puntos de alumnos con base y las cifras de cada curso
--   {outcome: 'failed', run_id, error}         su corrida, fallida: la última consolidación del periodo no terminó bien ('rollup failed',
--                                              'rollup running', 'rollup missing'), o el cálculo lanzó (el código)
--   {outcome: 'closed'}                        cerrado o pagado: no se estima ni se escribe
--   {outcome: 'before_launch'}                 sin tramos para el periodo (antes del arranque), como el ensayo: no se estima ni se escribe
--
-- El cálculo es el del ensayo: `compute_payout` con lo que da `close_input`, que es `payout_for_period` con la entrada ya armada (y así la huella
-- que se guarda es la de lo calculado). De cada maestro se queda con lo asignado, sin el sin consumo ni el bono. Las cifras salen del consolidado
-- (los pares con algún medio punto), solo de alumnos con base, en una sola sentencia para el maestro y sus cursos: un alumno sin base no aparece
-- en ninguna cifra, porque con un estimado en 0 se le podría deducir.
--
-- Su tope es el de los candados (`lock_timeout`, 30 s), que corre dentro de la sentencia: `statement_timeout` se arma al empezar cada sentencia que
-- llega del cliente, y cambiarlo aquí, dentro de un `call`, no acota esta. Un candado que no llega lanza 55P03, que la corrida atrapa y anota.
create function private.teacher_estimates_step(p_period public.period_id) returns jsonb
language plpgsql volatile set search_path = '' set lock_timeout = '30s'
as $$
declare
  v_started timestamptz := pg_catalog.clock_timestamp();
  v_status public.period_status;
  v_rollup public.run_status;
  v_rollup_found boolean;
  v_in record;
  v_lines private.payout_line[];
  v_run uuid;
  v_error text;
  v_teachers integer;
begin
  if p_period is null then
    raise exception 'teacher estimates need a period' using errcode = '22023';
  end if;
  -- Sin fila, se estima igual: la ventana de la consolidación no la pide, no hay nada que tomar, y un periodo sin fila no se cierra.
  select p.status into v_status from public.payout_periods p where p.period_id = p_period for share;
  if v_status in ('closed', 'paid') then
    return '{"outcome": "closed"}'::jsonb;
  end if;
  -- Antes del arranque `pool_bps` lanza: no es una falla, y una corrida fallida cada noche diría lo contrario.
  if (select t.thresholds from private.pool_tiers_for(p_period) t) is null then
    return '{"outcome": "before_launch"}'::jsonb;
  end if;

  -- La última consolidación del periodo, como la mira el cierre: si no terminó bien, el consolidado puede estar a medias.
  select j.status into v_rollup
  from public.job_runs j
  where j.job = 'nightly_rollup' and j.period_id = p_period
  order by j.started_at desc, j.id desc
  limit 1;
  v_rollup_found := found;
  if not v_rollup_found then
    v_error := 'rollup missing';
  elsif v_rollup <> 'succeeded' then
    v_error := 'rollup ' || v_rollup::text;
  else
    begin
      select * into v_in from private.close_input(p_period) i;
      v_lines := array(select row(x.kind, x.profile_id, x.teacher_id, x.tiebreak_rank, x.cents, x.base_cents, x.half_points)::private.payout_line
                       from private.compute_payout(v_in.pool_bps, v_in.carried_in_cents, v_in.bases, v_in.points) with ordinality x
                       order by x.ordinality);
      insert into private.teacher_estimate_runs (period_id, input_hash, status, started_at, finished_at)
      values (p_period, v_in.input_hash, 'succeeded', v_started, pg_catalog.clock_timestamp())
      returning id into v_run;
      with based as (select b.profile_id from pg_catalog.unnest(v_in.bases) b),
      figures as (
        select r.teacher_id, r.course_id, grouping(r.course_id) as by_teacher,
               (pg_catalog.count(*) filter (where r.half_points = 2))::integer as full_lessons,
               (pg_catalog.count(*) filter (where r.half_points = 1))::integer as half_lessons,
               (pg_catalog.count(distinct r.profile_id))::integer as students
        from public.watch_rollup r
        join based on based.profile_id = r.profile_id
        where r.period_id = p_period and r.half_points > 0
        group by grouping sets ((r.teacher_id), (r.teacher_id, r.course_id))),
      estimates as (
        insert into private.teacher_period_estimates (run_id, period_id, teacher_id, half_points, assigned_cents, full_lessons, half_lessons, students)
        select v_run, p_period, coalesce(c.teacher_id, f.teacher_id), coalesce(c.half_points, 0), coalesce(c.assigned_cents, 0),
               coalesce(f.full_lessons, 0), coalesce(f.half_lessons, 0), coalesce(c.students, 0)
        from private.close_teacher_totals(v_lines) c
        full join (select * from figures where figures.by_teacher = 1) f on f.teacher_id = c.teacher_id)
      -- Una sentencia con un insert en su `with` lo corre entero, y las claves foráneas se revisan al final de toda la sentencia: las cifras de un
      -- curso encuentran la fila de su maestro.
      insert into private.teacher_period_course_figures (run_id, period_id, teacher_id, course_id, full_lessons, half_lessons, students)
      select v_run, p_period, f.teacher_id, f.course_id, f.full_lessons, f.half_lessons, f.students
      from figures f
      where f.by_teacher = 0;
      select pg_catalog.count(*)::integer into v_teachers from private.teacher_period_estimates e where e.run_id = v_run;
    exception when others then
      v_error := sqlstate || ': ' || pg_catalog.left(sqlerrm, 200);
    end;
  end if;

  if v_error is not null then
    insert into private.teacher_estimate_runs (period_id, status, error, started_at, finished_at)
    values (p_period, 'failed', v_error, v_started, pg_catalog.clock_timestamp())
    returning id into v_run;
    return pg_catalog.jsonb_build_object('outcome', 'failed', 'run_id', v_run, 'error', v_error);
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'estimated', 'run_id', v_run, 'teachers', v_teachers);
end
$$;
revoke all on function private.teacher_estimates_step(public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- La corrida de cada noche (t602_congelado), con el estimado: después de cerrar la corrida de cada periodo, el paso, con su propio `commit` y en
-- su bloque. Se le llama aunque la consolidación haya fallado: entonces deja su corrida fallida sin calcular, y el panel dice que la de anoche no se
-- completó. Lo que falle del paso no toca el estado de la corrida de la consolidación, que es lo que mira el cierre: si lanza fuera de su propio
-- bloque, se anota en `details` de esa corrida (`teacher_estimates_failed`) y en el registro de la base, y la noche sigue. El bloque atrapa también
-- `query_canceled`, que `others` no atrapa: una cancelación del paso cortaría la noche entera.
create or replace procedure private.nightly_rollup(p_full boolean default false, p_period integer default null)
language plpgsql
as $$
declare
  v_estimate_error text;
  v_start timestamptz := pg_catalog.clock_timestamp();
  v_path text := pg_catalog.current_setting('search_path');
  v_window integer[];
  v_periods integer[];
  v_period integer;
  v_run uuid;
  v_step jsonb;
  v_error text;
  v_anomalies jsonb;
  v_after_profile uuid;
  v_after_lesson uuid;
  v_consolidated integer[] := '{}';
  v_transition jsonb;
  v_transition_start timestamptz;
  v_photos jsonb;
  v_seal integer;
  v_to_seal integer[];
  v_sealed integer[];
  v_seal_failed jsonb;
begin
  v_window := array(select private.rollup_window());
  v_periods := v_window;
  if p_period is not null then
    if not p_period = any (v_periods) then
      raise exception 'period % is not in the consolidation window', p_period using errcode = '22023';
    end if;
    v_periods := array[p_period];
  elsif not p_full then
    v_periods := array(select p from (select pg_catalog.unnest(v_periods) as p
                                      union select d.period_id from private.rollup_dirty d) s
                       where not exists (select 1 from public.payout_periods c
                                         where c.period_id = s.p and c.status in ('closed', 'paid'))
                       order by p);
  end if;
  -- De la sesión y no de la transacción: un ajuste local se iría con el primer `commit`. Se
  -- devuelve al terminar; si algo lanza a la mitad, la sesión se queda sin él (pg_cron y
  -- `db:rollup` cierran la conexión).
  perform pg_catalog.set_config('search_path', '', false);

  -- La foto de los periodos que terminaron, antes de consolidar y de detectar: la alerta y el cierre
  -- leen el mismo porcentaje.
  if p_period is null then
    begin
      v_photos := private.period_photos();
    exception when others then
      v_photos := pg_catalog.jsonb_build_object('photos_failed', sqlstate || ': ' || pg_catalog.left(sqlerrm, 200));
    end;
    commit;
  end if;

  foreach v_period in array v_periods loop
    v_run := private.open_job_run('nightly_rollup', v_period, private.rollup_mode(v_period, p_full));
    commit;
    continue when v_run is null;
    v_error := null;
    v_anomalies := null;
    v_after_profile := null;
    v_after_lesson := null;
    loop
      begin
        v_step := private.rollup_step(v_run, v_start, v_after_profile, v_after_lesson);
      exception when others then
        v_error := sqlstate || ': ' || pg_catalog.left(sqlerrm, 200);
      end;
      commit;
      exit when v_error is not null or (v_step ->> 'read')::integer = 0;
      v_after_profile := (v_step ->> 'last_profile')::uuid;
      v_after_lesson := (v_step ->> 'last_lesson')::uuid;
    end loop;
    if v_error is null then
      v_consolidated := v_consolidated || v_period;
    end if;
    if v_error is null and v_period = any (v_window) then
      begin
        v_anomalies := private.detect_anomalies(v_period, pg_catalog.clock_timestamp());
      exception when others then
        v_anomalies := pg_catalog.jsonb_build_object('anomalies_failed', sqlstate || ': ' || pg_catalog.left(sqlerrm, 200));
      end;
      update public.job_runs j set details = j.details || v_anomalies where j.id = v_run;
      commit;
    end if;
    perform private.close_job_run(v_run, coalesce(v_error,
      case when v_anomalies ? 'anomalies_failed' then 'anomalies failed: ' || (v_anomalies ->> 'anomalies_failed') end));
    commit;
    -- El estimado de los maestros (T-408), con lo que esta corrida dejó.
    v_estimate_error := null;
    begin
      perform private.teacher_estimates_step(v_period);
    exception when query_canceled or others then
      v_estimate_error := sqlstate || ': ' || pg_catalog.left(sqlerrm, 200);
    end;
    if v_estimate_error is not null then
      update public.job_runs j set details = j.details || pg_catalog.jsonb_build_object('teacher_estimates_failed', v_estimate_error)
      where j.id = v_run;
      raise warning 'teacher estimates for period % failed: %', v_period, v_estimate_error;
    end if;
    commit;
  end loop;

  if p_period is null then
    v_transition_start := pg_catalog.clock_timestamp();
    v_error := null;
    v_transition := null;
    begin
      v_transition := private.period_transition(v_consolidated);
    exception when others then
      v_error := sqlstate || ': ' || pg_catalog.left(sqlerrm, 200);
    end;
    -- Sellar la partición de los latidos de cada periodo cerrado o pagado que no lo esté (T-602),
    -- cada una en su bloque: la que no se pudo (un candado ocupado) se intenta la noche siguiente.
    -- Cada sellado confirma enseguida: su candado exclusivo no dura más que él.
    v_sealed := '{}';
    v_seal_failed := '{}'::jsonb;
    begin
      v_to_seal := array(select u.period_id from private.unsealed_partitions() u);
    exception when others then
      v_to_seal := '{}';
      v_seal_failed := pg_catalog.jsonb_build_object('unsealed_partitions', sqlstate || ': ' || pg_catalog.left(sqlerrm, 200));
    end;
    foreach v_seal in array v_to_seal loop
      begin
        if private.seal_watch_partition(v_seal) then
          v_sealed := v_sealed || v_seal;
        end if;
      exception when others then
        v_seal_failed := v_seal_failed || pg_catalog.jsonb_build_object(v_seal::text, sqlstate || ': ' || pg_catalog.left(sqlerrm, 200));
      end;
      commit;
    end loop;
    v_error := nullif(pg_catalog.array_to_string(array[
      v_error,
      case when v_transition ? 'open_failed' then 'open failed: ' || pg_catalog.left((v_transition -> 'open_failed')::text, 250) end,
      case when v_photos ? 'failed' then 'photos failed: ' || pg_catalog.left((v_photos -> 'failed')::text, 250) end,
      case when v_photos ? 'photos_failed' then 'photos failed: ' || (v_photos ->> 'photos_failed') end,
      case when v_transition ? 'photo_missing' then 'photo missing: ' || (v_transition -> 'photo_missing')::text end,
      case when v_transition ? 'held_open_again' then 'held open again: ' || (v_transition -> 'held_open_again')::text end,
      case when v_seal_failed <> '{}'::jsonb then 'seal failed: ' || pg_catalog.left(v_seal_failed::text, 250) end], '; '), '');
    insert into public.job_runs (job, status, started_at, heartbeat_at, finished_at, details, error)
    values ('period_transition', case when v_error is null then 'succeeded' else 'failed' end::public.run_status,
            v_transition_start, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
            coalesce(v_transition, '{}'::jsonb) || pg_catalog.jsonb_build_object('photos', v_photos, 'sealed', pg_catalog.to_jsonb(v_sealed))
              || case when v_seal_failed = '{}'::jsonb then '{}'::jsonb else pg_catalog.jsonb_build_object('seal_failed', v_seal_failed) end,
            v_error);
    commit;
  end if;
  perform pg_catalog.set_config('search_path', v_path, false);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Lo que lee el maestro: su panel (PA-41), de solo lectura.

-- La última corrida del estimado de un periodo, buena o cualquiera.
create function private.teacher_estimate_last_run(p_period public.period_id, p_good boolean) returns private.teacher_estimate_runs
language sql stable set search_path = ''
as $$
  select r.* from private.teacher_estimate_runs r
  where r.period_id = p_period and (not p_good or r.status = 'succeeded')
  order by r.finished_at desc, r.id desc
  limit 1
$$;
revoke all on function private.teacher_estimate_last_run(public.period_id, boolean) from public;

-- El panel, con una lista cerrada de claves:
--   current        el mes en curso: lo asignado y las cifras de la última corrida buena y su fecha (nulos si no hay ninguna; ceros si el maestro
--                  no tiene fila en ella), si la última corrida falló (`last_failed`) y si la buena tiene más de 26 horas (`stale`: la noche no
--                  la renovó, aunque no haya dejado una fallida)
--   courses        cada curso suyo que se publicó alguna vez, y cada uno con cifras suyas en esa corrida, con su título y sus cifras
--   series         hasta 12 periodos, del más viejo al más nuevo: los cerrados o pagados con su total (`payout_teacher_totals.total_cents`, 0 si no
--                  tiene, como PA-46), y los que están en cierre o siguen abiertos antes del mes en curso (entre el día 1 y la corrida, o con un
--                  paso a cierre fallido) con lo asignado de su última corrida buena, marcados como estimado; desde el primero en que publicó, o
--                  en que tiene cifra
--   has_published  si tiene algún curso publicado ahora
-- Sin el porcentaje del bote ni nada por alumno.
create function private.teacher_dashboard() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.actor_teacher_id();
  v_period public.period_id;
  v_good private.teacher_estimate_runs;
  v_last private.teacher_estimate_runs;
  v_mine private.teacher_period_estimates;
  v_first public.period_id;
begin
  if v_teacher is null then
    return '{"outcome": "not_teacher"}'::jsonb;
  end if;
  v_period := private.period_of(pg_catalog.now());
  v_good := private.teacher_estimate_last_run(v_period, true);
  v_last := private.teacher_estimate_last_run(v_period, false);
  select * into v_mine from private.teacher_period_estimates e where e.run_id = v_good.id and e.teacher_id = v_teacher;
  v_first := private.teacher_first_period(v_teacher);
  return pg_catalog.jsonb_build_object(
    'outcome', 'ok',
    'has_published', exists (select 1 from public.course_registry r where r.teacher_id = v_teacher and r.state in ('published', 'changes_pending')),
    'current', pg_catalog.jsonb_build_object(
      'period_id', v_period,
      'estimated_cents', case when v_good.id is not null then coalesce(v_mine.assigned_cents, 0) end,
      'full_lessons', case when v_good.id is not null then coalesce(v_mine.full_lessons, 0) end,
      'half_lessons', case when v_good.id is not null then coalesce(v_mine.half_lessons, 0) end,
      'students', case when v_good.id is not null then coalesce(v_mine.students, 0) end,
      'updated_at', v_good.finished_at,
      'last_failed', coalesce(v_last.status = 'failed', false),
      'stale', coalesce(v_good.finished_at < pg_catalog.now() - interval '26 hours', false)),
    'courses', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'course_id', x.course_id, 'title', coalesce(pc.title, d.title),
               'full_lessons', case when v_good.id is not null then coalesce(f.full_lessons, 0) end,
               'half_lessons', case when v_good.id is not null then coalesce(f.half_lessons, 0) end,
               'students', case when v_good.id is not null then coalesce(f.students, 0) end)
             order by coalesce(pc.title, d.title), x.course_id)
      from (select r.course_id from public.course_registry r where r.teacher_id = v_teacher and r.first_published_at is not null
            union
            select g.course_id from private.teacher_period_course_figures g where g.run_id = v_good.id and g.teacher_id = v_teacher) x
      left join public.published_courses pc on pc.course_id = x.course_id
      left join public.course_drafts d on d.course_id = x.course_id
      left join private.teacher_period_course_figures f on f.run_id = v_good.id and f.teacher_id = v_teacher and f.course_id = x.course_id),
      '[]'::jsonb),
    'series', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('period_id', s.period_id, 'cents', s.cents, 'estimated', s.estimated)
                                  order by s.period_id)
      from (select q.period_id, q.estimated, q.cents
            from (select p.period_id, p.status in ('closing', 'open') as estimated,
                         case when p.status in ('closing', 'open') then
                           case when g.id is not null then coalesce(e.assigned_cents, 0) end
                         else coalesce(t.total_cents, 0) end as cents,
                         t.teacher_id is not null or e.teacher_id is not null as has_figure
                  from public.payout_periods p
                  left join public.payout_teacher_totals t on t.period_id = p.period_id and t.teacher_id = v_teacher and p.status in ('closed', 'paid')
                  left join lateral (select (private.teacher_estimate_last_run(p.period_id, true)).id) g (id) on p.status in ('closing', 'open')
                  left join private.teacher_period_estimates e on e.run_id = g.id and e.teacher_id = v_teacher
                  where p.status in ('closing', 'closed', 'paid') or (p.status = 'open' and p.period_id < v_period)) q
            where q.has_figure or q.period_id >= v_first
            order by q.period_id desc
            limit 12) s), '[]'::jsonb));
end
$$;
revoke all on function private.teacher_dashboard() from public;
grant execute on function private.teacher_dashboard() to app_service;

-- ---------------------------------------------------------------------------------------
-- La retención, de quien opera (no de la aplicación): de cada periodo cerrado o pagado deja solo su última corrida buena, con sus filas, y quita
-- las demás (cada noche deja una por periodo, y una vez cerrado nadie las lee: la serie toma el total del cierre). De un periodo abierto o en
-- cierre no quita nada. Lo congelado y lo de solo inserción no dejan borrar, así que la función corre en réplica (`session_replication_role`,
-- en su propia configuración: Postgres lo devuelve al salir, también si lanza), que apaga sus disparadores y las claves foráneas solo mientras
-- ella corre; por eso borra en una sola sentencia las filas de cada corrida que quita, y nada más. Es segura sin candado: un periodo cerrado ya no
-- recibe estimados, y nadie lo reabre. Contesta cuántas corridas, estimados y cifras de curso quitó.
create function private.teacher_estimates_purge() returns jsonb
language plpgsql volatile set search_path = '' set session_replication_role = 'replica'
as $$
declare
  v_runs integer;
  v_estimates integer;
  v_figures integer;
begin
  with doomed as (
    select r.id
    from private.teacher_estimate_runs r
    join public.payout_periods p on p.period_id = r.period_id and p.status in ('closed', 'paid')
    where r.id is distinct from (private.teacher_estimate_last_run(r.period_id, true)).id),
  figures as (
    delete from private.teacher_period_course_figures f using doomed d where f.run_id = d.id returning 1),
  estimates as (
    delete from private.teacher_period_estimates e using doomed d where e.run_id = d.id returning 1),
  runs as (
    delete from private.teacher_estimate_runs x using doomed d where x.id = d.id returning 1)
  select (select pg_catalog.count(*) from runs), (select pg_catalog.count(*) from estimates), (select pg_catalog.count(*) from figures)
  into v_runs, v_estimates, v_figures;
  return pg_catalog.jsonb_build_object('runs', v_runs, 'estimates', v_estimates, 'course_figures', v_figures);
end
$$;
revoke all on function private.teacher_estimates_purge() from public;

-- ---------------------------------------------------------------------------------------
-- El vigilante del estimado (área del carril A): las tablas sin permisos, con seguridad por fila, congeladas y de solo inserción; el panel, la
-- única puerta; el paso, su ayudante y la retención, del sistema; toda función que nombre las tablas, en una lista cerrada; y la corrida de cada
-- noche llama al paso, en un bloque que atrapa también la cancelación.

create function private.schema_violations_teacher_estimates()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  -- Las únicas funciones que nombran las tablas. Una nueva es una puerta nueva, aunque se llame igual en otro esquema o con otra firma.
  estimate_known (oid) as (
    select pg_catalog.to_regprocedure(k.signature)::oid
    from (values ('private.teacher_estimates_step(public.period_id)'), ('private.teacher_estimate_last_run(public.period_id, boolean)'),
                 ('private.teacher_dashboard()'), ('private.teacher_estimates_purge()'),
                 ('private.schema_violations_teacher_estimates()')) k (signature)),
  estimate_tables (table_name) as (
    values ('private.teacher_estimate_runs'), ('private.teacher_period_estimates'), ('private.teacher_period_course_figures')),
  estimate_triggers (table_name, trigger_name, definition) as (
    select t.table_name, x.trigger_name, x.definition
    from estimate_tables t
    cross join lateral (values (pg_catalog.split_part(t.table_name, '.', 2) || '_frozen', 'BEFORE INSERT OR DELETE OR UPDATE%guard_frozen_period(''period_id'')'),
                               ('ledger_no_update_delete', 'BEFORE DELETE OR UPDATE%reject_mutation()'),
                               ('ledger_no_truncate', 'BEFORE TRUNCATE%reject_mutation()')) x (trigger_name, definition)),
  system_functions (signature) as (
    values ('private.teacher_estimates_step(public.period_id)'), ('private.teacher_estimate_last_run(public.period_id, boolean)'),
           ('private.teacher_estimates_purge()'))
  select 'teacher estimates table reachable by ' || r.rolname, t.table_name
  from app_roles r cross join estimate_tables t
  where pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'select, insert, update, delete, truncate, references, trigger')
     or pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'select, insert, update, references')
  union all
  select 'teacher estimates table without row security', t.table_name
  from estimate_tables t
  where not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = t.table_name::regclass)
  union all
  select 'teacher estimates trigger missing: ' || g.trigger_name, g.table_name
  from estimate_triggers g
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = g.table_name::regclass and tg.tgname = g.trigger_name and tg.tgenabled in ('O', 'A')
      and pg_catalog.pg_get_triggerdef(tg.oid) like '%' || g.definition || '%')
  union all
  select 'teacher dashboard door missing or wrong', 'private.teacher_dashboard()'
  where pg_catalog.to_regprocedure('private.teacher_dashboard()') is null
     or not coalesce((select p.prosecdef and p.provolatile = 's' and p.proconfig @> array['search_path=""']
                      from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('private.teacher_dashboard()')), false)
     or not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.teacher_dashboard()')) like '%actor_teacher_id()%', false)
     or not pg_catalog.has_function_privilege('app_service', 'private.teacher_dashboard()', 'execute')
     or pg_catalog.has_function_privilege('authenticated', 'private.teacher_dashboard()', 'execute')
     or pg_catalog.has_function_privilege('anon', 'private.teacher_dashboard()', 'execute')
     or pg_catalog.has_function_privilege('service_role', 'private.teacher_dashboard()', 'execute')
  union all
  select 'teacher estimates system function reachable or wrong', f.signature
  from system_functions f
  where pg_catalog.to_regprocedure(f.signature) is null
     or (select p.prosecdef or not coalesce(p.proconfig, '{}') @> array['search_path=""']
         from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(f.signature))
     or exists (select 1 from app_roles r where pg_catalog.has_function_privilege(r.rolname::name, f.signature, 'execute'))
  union all
  select 'teacher estimates function not in the list', n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and (coalesce(p.prosrc, '') || coalesce(pg_catalog.pg_get_function_sqlbody(p.oid), '')) ~ '(teacher_period_estimates|teacher_period_course_figures|teacher_estimate_runs)'
    and p.oid not in (select k.oid from estimate_known k where k.oid is not null)
  union all
  select 'nightly rollup does not estimate, or a cancellation stops it', 'private.nightly_rollup(boolean, integer)'
  where pg_catalog.pg_get_functiondef('private.nightly_rollup(boolean, integer)'::regprocedure)
        not like '%perform private.teacher_estimates_step(v_period);%exception when query_canceled or others then%'
$$;
revoke all on function private.schema_violations_teacher_estimates() from public;
