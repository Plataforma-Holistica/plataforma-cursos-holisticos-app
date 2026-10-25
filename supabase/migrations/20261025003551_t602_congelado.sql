-- T-602 · Lo que congela un periodo cerrado (RN-09; 05 §5.10, §7.3, §8.2 y §13.2). Primera de dos
-- solicitudes: esta deja todo listo para que un periodo cerrado no cambie; la segunda trae el ensayo y
-- el cierre. Decisiones de Sergio del 2026-10-24: el cierre va en orden, exige un recálculo completo
-- correcto desde que el periodo entró en cierre, las liquidaciones son de T-603, y las precondiciones
-- de avisos y de conciliación llegan con T-303 y T-605.
--
-- Lo que entra:
--   · las claves foráneas de `watch_rollup`, `anomaly_alerts` y `consumption_exclusions` a su
--     periodo. La fila de un mes se abre justo antes de escribir en él (la consolidación de un par,
--     la alerta del bote sin consumo, una exclusión), no al empezar la corrida: un mes de antes del
--     arranque no gana fila (la revisión del plan: con fila, sin tramos, nunca se cerraría);
--   · `watch_rollup_frozen`: el consolidado de un periodo cerrado o pagado no entra, ni cambia, ni
--     se borra. `guard_frozen_period` lee la fila vieja y la nueva, y toma candado compartido sobre
--     la fila del periodo: el cierre, que la tomará para sí, espera a cada escritura en vuelo, y la
--     siguiente lo ve cerrado. Vale para los cinco congelados;
--   · marcar pares no marca un periodo cerrado, y un paso de la corrida se detiene ante uno;
--   · el recálculo completo de la primera noche en cierre (`private.rollup_mode()`), que borra las
--     marcas de antes de empezar de los pares que procesó;
--   · sellar la partición de los latidos de cada periodo cerrado o pagado, al final de la corrida;
--   · el aviso de un periodo que se queda abierto dos noches seguidas habiendo llegado a su día;
--   · `check_revenue_parts` como el dueño: corre al confirmar, con el rol de la sesión, y el servidor
--     (T-303) no lee los libros.

-- ---------------------------------------------------------------------------------------
-- Las claves foráneas. Antes, las filas de los meses que ya tengan datos en esas tablas (en una base
-- nueva no hay ninguno: la zona de los periodos llega con la semilla, después).

do $$
declare
  v_period integer;
begin
  for v_period in
    select d.period_id from (select w.period_id from public.watch_rollup w
                             union select a.period_id from public.anomaly_alerts a
                             union select x.period_id from public.consumption_exclusions x) d
    where not exists (select 1 from public.payout_periods p where p.period_id = d.period_id)
    order by 1
  loop
    perform private.open_period(v_period);
  end loop;
end
$$;

alter table public.watch_rollup
  add constraint watch_rollup_period_fk foreign key (period_id) references public.payout_periods (period_id);
alter table public.anomaly_alerts
  add constraint anomaly_alerts_period_fk foreign key (period_id) references public.payout_periods (period_id);
alter table public.consumption_exclusions
  add constraint consumption_exclusions_period_fk foreign key (period_id) references public.payout_periods (period_id);

-- ---------------------------------------------------------------------------------------
-- Lo congelado.

-- Lo que se congela con un periodo cerrado o pagado (`t601_periodos`), ahora también al cambiar y al
-- borrar: el periodo de la fila vieja y el de la nueva. Con candado compartido sobre la fila de cada
-- periodo (en orden): el cierre toma la fila para sí y espera a la escritura en vuelo; la que llega
-- después ve el periodo cerrado. Un periodo sin fila no se congela. El primer argumento es la columna
-- del periodo. Sin `security definer`: escriben estas tablas solo funciones del dueño.
create or replace function private.guard_frozen_period() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_period integer;
  v_status public.period_status;
begin
  for v_period in
    select distinct x.p from (
      select case when tg_op <> 'INSERT' then (pg_catalog.to_jsonb(old) ->> tg_argv[0])::integer end as p
      union all
      select case when tg_op <> 'DELETE' then (pg_catalog.to_jsonb(new) ->> tg_argv[0])::integer end) x
    where x.p is not null
    order by 1
  loop
    v_status := null;
    select p.status into v_status from public.payout_periods p where p.period_id = v_period for share;
    if v_status in ('closed', 'paid') then
      raise exception '%.%: period % is closed', tg_table_schema, tg_table_name, v_period using errcode = '55000';
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create trigger watch_rollup_frozen before insert or update or delete on public.watch_rollup
  for each row execute function private.guard_frozen_period('period_id');

-- Marcar los pares de una cuenta en un periodo (t208), salvo si está cerrado o pagado: una exclusión
-- o una suspensión por fraude después del cierre no deja marcas que nadie va a consolidar (RN-09: el
-- cierre no se recalcula). Con candado compartido sobre la fila del periodo, como los congelados.
create or replace function private.mark_pairs_for(p_profile uuid, p_period public.period_id, p_lesson uuid, p_session uuid)
returns integer
language plpgsql volatile set search_path = ''
as $$
declare
  v_status public.period_status;
  v_marked integer;
begin
  select p.status into v_status from public.payout_periods p where p.period_id = p_period for share;
  if v_status in ('closed', 'paid') then
    return 0;
  end if;
  with pairs as (
    select e.lesson_id from public.watch_events e
    where e.period_id = p_period and e.profile_id = p_profile and e.counts_for_payout
      and (p_lesson is null or e.lesson_id = p_lesson)
      and (p_session is null or e.playback_session_id = p_session)
    union
    select w.lesson_id from public.watch_rollup w
    where p_session is null and w.period_id = p_period and w.profile_id = p_profile
      and (p_lesson is null or w.lesson_id = p_lesson)
  ), marked as (
    insert into private.rollup_dirty (period_id, profile_id, lesson_id, touched_at)
    select p_period, p_profile, p.lesson_id, pg_catalog.clock_timestamp() from pairs p order by p.lesson_id
    on conflict (period_id, profile_id, lesson_id) do update set touched_at = excluded.touched_at
    returning 1
  )
  select pg_catalog.count(*)::integer into v_marked from marked;
  return v_marked;
end
$$;

-- La revisión de las partes de un cobro (t601_periodos) corre al confirmar, con el rol de la sesión:
-- cuando T-303 abra `record_charge` al servidor, que no lee los libros, fallaría. Como el dueño, sin
-- permisos para nadie.
alter function private.check_revenue_parts() security definer;

-- ---------------------------------------------------------------------------------------
-- El modo de la corrida de cada periodo: completo si se pide, o si el periodo está en cierre y no tiene
-- una corrida completa correcta desde que entró en cierre (la primera noche en cierre: el cierre la
-- exige, decisión de Sergio del 2026-10-24); si no, de marcas.
create function private.rollup_mode(p_period public.period_id, p_full boolean) returns text
language sql stable set search_path = ''
as $$
  select case
    when p_full then 'full'
    when exists (
      select 1 from public.payout_periods p
      where p.period_id = p_period and p.status = 'closing'
        and not exists (
          select 1 from public.job_runs j
          where j.job = 'nightly_rollup' and j.period_id = p_period and j.status = 'succeeded'
            and j.details ->> 'mode' = 'full' and j.started_at >= p.entered_closing_at)) then 'full'
    else 'dirty' end
$$;
revoke all on function private.rollup_mode(public.period_id, boolean) from public;

-- ---------------------------------------------------------------------------------------
-- Sellar la partición de los latidos de un periodo cerrado o pagado (05 §13.2): una restricción
-- `check (false) not valid`, que no revisa lo que ya estaba ni estorba las lecturas, y con la que no
-- entra ningún latido nuevo. Toma un candado exclusivo sobre la partición, con un tope de espera de
-- 2 s: mientras espera, quien la lee se forma detrás, así que la espera se acota a eso; si no lo
-- consigue, lanza y se intenta la noche siguiente. La corrida confirma después de cada una.
-- Contesta si la partición quedó sellada (falso: no hay partición). Purgarla llega con T-603.
create function private.seal_watch_partition(p_period public.period_id) returns boolean
language plpgsql volatile set search_path = ''
as $$
declare
  v_name text := 'watch_events_' || p_period::text;
  v_status public.period_status;
  v_timeout text := pg_catalog.current_setting('lock_timeout');
begin
  select p.status into v_status from public.payout_periods p where p.period_id = p_period;
  if v_status is distinct from 'closed' and v_status is distinct from 'paid' then
    raise exception 'period % is not closed: its partition is not sealed', p_period using errcode = '23514';
  end if;
  if pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(v_name)) is null then
    return false;
  end if;
  if exists (select 1 from pg_catalog.pg_constraint c
             where c.conrelid = pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(v_name))
               and c.conname = v_name || '_sealed') then
    return true;
  end if;
  perform pg_catalog.set_config('lock_timeout', '2s', true);
  execute pg_catalog.format('alter table public.%I add constraint %I check (false) not valid', v_name, v_name || '_sealed');
  perform pg_catalog.set_config('lock_timeout', v_timeout, true);
  return true;
end
$$;
revoke all on function private.seal_watch_partition(public.period_id) from public;

-- Los periodos cerrados o pagados con partición sin sellar, en orden.
create function private.unsealed_partitions() returns table (period_id public.period_id)
language sql stable set search_path = ''
as $$
  select p.period_id from public.payout_periods p
  where p.status in ('closed', 'paid')
    and pg_catalog.to_regclass('public.watch_events_' || p.period_id::text) is not null
    and not exists (select 1 from pg_catalog.pg_constraint c
                    where c.conrelid = pg_catalog.to_regclass('public.watch_events_' || p.period_id::text)
                      and c.conname = 'watch_events_' || p.period_id::text || '_sealed')
  order by 1
$$;
revoke all on function private.unsealed_partitions() from public;

-- ---------------------------------------------------------------------------------------
-- Las funciones que cambian, copiadas de su versión vigente con solo lo de T-602.

-- La consolidación de un par (t208), que abre la fila de su periodo antes de escribir.
create or replace function private.rollup_pair(p_period public.period_id, p_profile uuid, p_lesson uuid, p_run uuid,
                                               p_half_bps integer, p_full_bps integer)
returns integer
language plpgsql volatile set search_path = ''
as $$
declare
  v_video uuid;
  v_duration integer;
  v_covered integer;
  v_points smallint;
  v_written integer;
begin
  select c.video_asset_id, c.duration, c.covered, private.half_points(c.covered, c.duration, p_half_bps, p_full_bps)
  into v_video, v_duration, v_covered, v_points
  from (
    select v0.video_asset_id, v0.duration, v0.spans - x.excluded as spans
    from (
      select s.video_asset_id, pg_catalog.min(s.lesson_duration_seconds) as duration,
             pg_catalog.range_agg(pg_catalog.int4range(e.from_second, e.to_second)) as spans
      from public.watch_events e
      join public.playback_sessions s on s.id = e.playback_session_id
      where e.period_id = p_period and e.profile_id = p_profile and e.lesson_id = p_lesson and e.counts_for_payout
        and not exists (select 1 from public.profiles p where p.id = p_profile and p.suspended_for_fraud)
        and not exists (
          select 1 from public.consumption_exclusions x
          where x.period_id = p_period and x.profile_id = p_profile and x.revoked_at is null
            and (x.scope = 'account' or (x.scope = 'session' and x.playback_session_id = e.playback_session_id)))
      group by s.video_asset_id
    ) v0
    cross join (
      select coalesce(pg_catalog.range_agg(pg_catalog.int4range(x.from_second, x.to_second)), '{}'::int4multirange) as excluded
      from public.consumption_exclusions x
      where x.period_id = p_period and x.profile_id = p_profile and x.scope = 'interval' and x.lesson_id = p_lesson
        and x.revoked_at is null
    ) x
  ) v
  -- Lo que cae dentro de la duración, no un total recortado: [20, 100) contra 80 s son 60.
  cross join lateral (select v.video_asset_id, v.duration,
                             private.span_seconds(v.spans * pg_catalog.int4multirange(pg_catalog.int4range(0, v.duration))) as covered) c
  left join public.published_lessons l on l.id = p_lesson
  where not pg_catalog.isempty(v.spans)
  order by private.half_points(c.covered, c.duration, p_half_bps, p_full_bps) desc, c.covered desc,
           (c.video_asset_id = l.video_asset_id) desc, c.video_asset_id
  limit 1;

  if v_video is null then
    delete from public.watch_rollup w where w.period_id = p_period and w.profile_id = p_profile and w.lesson_id = p_lesson;
    get diagnostics v_written = row_count;
    return v_written;
  end if;

  -- La fila del periodo existe antes de escribir su consolidado (la clave foránea, T-602); se abre
  -- aquí y no al empezar la corrida, para no abrir un mes sin nada que escribir.
  perform private.open_period(p_period);
  insert into public.watch_rollup as w (
    period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id, lesson_duration_seconds,
    covered_seconds, half_points, computed_at, job_run_id)
  select p_period, p_profile, l.id, l.course_id, l.teacher_id, v_video, v_duration, v_covered, v_points, pg_catalog.now(), p_run
  from public.published_lessons l where l.id = p_lesson
  on conflict (period_id, profile_id, lesson_id) do update
  set course_id = excluded.course_id, teacher_id = excluded.teacher_id, video_asset_id = excluded.video_asset_id,
      lesson_duration_seconds = excluded.lesson_duration_seconds, covered_seconds = excluded.covered_seconds,
      half_points = excluded.half_points, computed_at = excluded.computed_at, job_run_id = excluded.job_run_id
  where (w.course_id, w.teacher_id, w.video_asset_id, w.lesson_duration_seconds, w.covered_seconds, w.half_points)
        is distinct from
        (excluded.course_id, excluded.teacher_id, excluded.video_asset_id, excluded.lesson_duration_seconds,
         excluded.covered_seconds, excluded.half_points);
  get diagnostics v_written = row_count;
  return v_written;
end
$$;

-- Un paso de la corrida (t207): se detiene ante un periodo cerrado, y en el modo completo borra
-- las marcas de antes de empezar de los pares que procesó.
create or replace function private.rollup_step(p_run uuid, p_before timestamptz, p_after_profile uuid default null,
                                    p_after_lesson uuid default null, p_limit integer default 50)
returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_period public.period_id;
  v_mode text;
  v_profiles uuid[];
  v_lessons uuid[];
  v_touched timestamptz[];
  v_half integer;
  v_full integer;
  v_written integer := 0;
  v_failed integer := 0;
  v_first_failure text;
  v_status public.period_status;
  v_mark_profiles uuid[];
  v_mark_lessons uuid[];
begin
  -- Borrar una marca solo si sigue como se leyó pide ver lo confirmado en cada sentencia.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.rollup_step() needs read committed isolation' using errcode = '25000';
  end if;
  select j.period_id, j.details ->> 'mode' into v_period, v_mode
  from public.job_runs j where j.id = p_run and j.status = 'running';
  if not found then
    raise exception 'job run % is not running', p_run using errcode = '22023';
  end if;
  -- Un periodo cerrado o pagado ya no se consolida (T-602). Con candado compartido sobre su fila: el
  -- cierre, que la toma para sí, espera al paso en vuelo, y el siguiente paso ya lo ve cerrado.
  select p.status into v_status from public.payout_periods p where p.period_id = v_period for share;
  if v_status in ('closed', 'paid') then
    update public.job_runs j
    set heartbeat_at = pg_catalog.clock_timestamp(), details = j.details || '{"period_closed": true}'::jsonb
    where j.id = p_run;
    return pg_catalog.jsonb_build_object('read', 0, 'written', 0, 'last_profile', null, 'last_lesson', null);
  end if;

  if v_mode = 'dirty' then
    select pg_catalog.array_agg(m.profile_id order by m.touched_at, m.profile_id, m.lesson_id),
           pg_catalog.array_agg(m.lesson_id order by m.touched_at, m.profile_id, m.lesson_id),
           pg_catalog.array_agg(m.touched_at order by m.touched_at, m.profile_id, m.lesson_id)
    into v_profiles, v_lessons, v_touched
    from (select d.profile_id, d.lesson_id, d.touched_at from private.rollup_dirty d
          where d.period_id = v_period and d.touched_at < p_before
          order by d.touched_at, d.profile_id, d.lesson_id limit p_limit) m;
  else
    select pg_catalog.array_agg(m.profile_id order by m.profile_id, m.lesson_id),
           pg_catalog.array_agg(m.lesson_id order by m.profile_id, m.lesson_id)
    into v_profiles, v_lessons
    from (select p.profile_id, p.lesson_id
          from (select e.profile_id, e.lesson_id from public.watch_events e where e.period_id = v_period
                union
                select w.profile_id, w.lesson_id from public.watch_rollup w where w.period_id = v_period) p
          where p_after_profile is null or (p.profile_id, p.lesson_id) > (p_after_profile, p_after_lesson)
          order by p.profile_id, p.lesson_id limit p_limit) m;
  end if;

  if v_profiles is null then
    update public.job_runs j set heartbeat_at = pg_catalog.clock_timestamp() where j.id = p_run;
    return pg_catalog.jsonb_build_object('read', 0, 'written', 0, 'last_profile', null, 'last_lesson', null);
  end if;

  -- En el modo completo, las marcas de antes de empezar de los pares elegidos, leídas antes de
  -- consolidarlos (T-602): al final se borran solo si siguen como se leyeron. Una que confirmó durante
  -- el paso no se vio aquí, y lo suyo quizá tampoco al consolidar: se queda para la noche siguiente.
  if v_mode <> 'dirty' then
    select pg_catalog.array_agg(d.profile_id), pg_catalog.array_agg(d.lesson_id), pg_catalog.array_agg(d.touched_at)
    into v_mark_profiles, v_mark_lessons, v_touched
    from private.rollup_dirty d
    join rows from (pg_catalog.unnest(v_profiles), pg_catalog.unnest(v_lessons)) as m (profile_id, lesson_id)
      on m.profile_id = d.profile_id and m.lesson_id = d.lesson_id
    where d.period_id = v_period and d.touched_at < p_before;
  end if;

  select t.half_bps, t.full_bps into v_half, v_full from private.payout_thresholds(v_period) t;
  for i in 1 .. pg_catalog.array_length(v_profiles, 1) loop
    begin
      v_written := v_written + private.rollup_pair(v_period, v_profiles[i], v_lessons[i], p_run, v_half, v_full);
    exception when others then
      v_failed := v_failed + 1;
      v_first_failure := coalesce(v_first_failure, sqlstate);
      -- En los dos modos: en el completo, el par queda marcado para la noche siguiente.
      insert into private.rollup_dirty (period_id, profile_id, lesson_id, touched_at)
      values (v_period, v_profiles[i], v_lessons[i], pg_catalog.clock_timestamp())
      on conflict (period_id, profile_id, lesson_id) do update set touched_at = excluded.touched_at;
    end;
  end loop;

  if v_mode = 'dirty' then
    delete from private.rollup_dirty d
    using rows from (pg_catalog.unnest(v_profiles), pg_catalog.unnest(v_lessons), pg_catalog.unnest(v_touched))
      as m (profile_id, lesson_id, touched_at)
    where d.period_id = v_period and d.profile_id = m.profile_id and d.lesson_id = m.lesson_id
      and d.touched_at = m.touched_at;
  elsif v_mark_profiles is not null then
    -- El recálculo completo deja al día cada par que procesó: sus marcas de antes de que empezara la
    -- corrida sobran (T-602; si no, el cierre esperaría una noche más). Solo las que se leyeron arriba y
    -- siguen igual: las de un latido posterior, las que cambiaron durante el paso y las de un par que
    -- falló (se marcan con la hora del reloj) se quedan.
    delete from private.rollup_dirty d
    using rows from (pg_catalog.unnest(v_mark_profiles), pg_catalog.unnest(v_mark_lessons), pg_catalog.unnest(v_touched))
      as m (profile_id, lesson_id, touched_at)
    where d.period_id = v_period and d.profile_id = m.profile_id and d.lesson_id = m.lesson_id
      and d.touched_at = m.touched_at;
  end if;

  update public.job_runs j
  set heartbeat_at = pg_catalog.clock_timestamp(),
      rows_read = j.rows_read + pg_catalog.array_length(v_profiles, 1),
      rows_written = j.rows_written + v_written,
      details = case when v_failed = 0 then j.details else j.details || pg_catalog.jsonb_build_object(
        'pairs_failed', coalesce((j.details ->> 'pairs_failed')::integer, 0) + v_failed,
        'first_failure', coalesce(j.details ->> 'first_failure', v_first_failure)) end
  where j.id = p_run;
  return pg_catalog.jsonb_build_object(
    'read', pg_catalog.array_length(v_profiles, 1), 'written', v_written,
    'last_profile', v_profiles[pg_catalog.array_length(v_profiles, 1)],
    'last_lesson', v_lessons[pg_catalog.array_length(v_lessons, 1)]);
end
$$;

-- La detección (t601_periodos): abre la fila del periodo antes de la alerta del bote sin consumo.
create or replace function private.detect_anomalies(p_period public.period_id, p_now timestamptz default pg_catalog.now())
returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_kind text := pg_catalog.current_setting('app.actor_kind', true);
  v_window public.period_id[] := array(select private.rollup_window());
  v_zone text := private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}';
  v_start timestamptz;
  v_end timestamptz;
  v_ended boolean;
  v_elapsed numeric;
  v_speed numeric;
  v_bps text;
  v_floor text;
  v_previous public.period_id;
  v_count integer;
  v_opened integer := 0;
  v_unconsumed_bps text;
  v_pool bigint;
  v_assigned bigint;
  v_students integer;
  v_without integer;
  v_failed text;
begin
  if v_zone is null then
    raise exception 'ZONA_HORARIA_PERIODO is not set' using errcode = 'P0001';
  end if;
  if not p_period = any (v_window) then
    return pg_catalog.jsonb_build_object('alerts_opened', 0);
  end if;
  perform pg_catalog.set_config('app.actor_kind', 'system', true);

  select b.starts_at, b.ends_at into v_start, v_end from private.period_bounds(p_period) b;
  -- Por el reloj, no por `p_now`: lo que ya terminó (T-601; antes, solo el anterior por reloj).
  v_ended := v_end <= pg_catalog.now();
  v_elapsed := extract(epoch from (least(p_now, v_end) - v_start));
  -- Los parámetros se leen solo si hay algo que evaluar: un periodo sin consumo (el anterior al
  -- arranque, que no tiene parámetros) no los necesita.
  if v_elapsed > 0 and exists (select 1 from public.watch_rollup w where w.period_id = p_period and w.half_points = 2) then
    v_speed := private.max_speed(p_period);
    insert into public.anomaly_alerts (period_id, kind, profile_id, metric_value, threshold_value, details)
    select p_period, 'impossible_completion', c.profile_id, pg_catalog.round(c.seconds / v_speed, 3), v_elapsed,
           pg_catalog.jsonb_build_object('lessons', c.lessons, 'covered_seconds', c.seconds, 'speed', v_speed,
                                         'from', v_start, 'until', least(p_now, v_end))
    from (select w.profile_id, pg_catalog.count(*) as lessons, pg_catalog.sum(w.covered_seconds) as seconds
          from public.watch_rollup w where w.period_id = p_period and w.half_points = 2
          group by w.profile_id) c
    where c.seconds / v_speed > v_elapsed
    on conflict do nothing;
    get diagnostics v_count = row_count;
    v_opened := v_opened + v_count;
  end if;

  v_previous := private.period_plus(p_period, -1);
  if v_ended
     and exists (select 1 from public.watch_rollup w where w.period_id = v_previous)
     and exists (select 1 from public.watch_rollup w where w.period_id = p_period) then
    v_bps := private.parameter_value('ALERTA_SALTO_MAESTRO_PCT', p_now) #>> '{}';
    v_floor := private.parameter_value('ALERTA_SALTO_MINIMO_MEDIOS_PUNTOS', p_now) #>> '{}';
    if v_bps is null or v_bps !~ '^[1-9][0-9]{0,6}$' or v_floor is null or v_floor !~ '^[0-9]{1,9}$' then
      raise exception 'teacher points jump thresholds are not set' using errcode = 'P0001';
    end if;
    insert into public.anomaly_alerts (period_id, kind, teacher_id, metric_value, threshold_value, details)
    select p_period, 'teacher_points_jump', a.teacher_id, pg_catalog.round((a.points - b.points) * 10000.0 / b.points, 3),
           v_bps::integer,
           pg_catalog.jsonb_build_object('before', b.points, 'after', a.points, 'students_before', b.students,
                                         'students_after', a.students, 'floor', v_floor::integer)
    from (select w.teacher_id, pg_catalog.sum(w.half_points) as points, pg_catalog.count(distinct w.profile_id) as students
          from public.watch_rollup w where w.period_id = p_period group by w.teacher_id) a
    join (select w.teacher_id, pg_catalog.sum(w.half_points) as points, pg_catalog.count(distinct w.profile_id) as students
          from public.watch_rollup w where w.period_id = v_previous group by w.teacher_id) b on b.teacher_id = a.teacher_id
    where b.points > 0 and b.points >= v_floor::integer
      and (a.points - b.points) * 10000 > v_bps::bigint * b.points
    on conflict do nothing;
    get diagnostics v_count = row_count;
    v_opened := v_opened + v_count;
  end if;

  -- El bote sin consumo (T-407): solo un mes que terminó, y solo si tiene bases. En su propio
  -- bloque: lo de arriba ya quedó, falle o no.
  if v_ended
     and exists (select 1 from public.revenue_allocations a where a.period_id = p_period) then
    begin
      v_unconsumed_bps := private.parameter_value('ALERTA_SIN_CONSUMO_PCT', p_now) #>> '{}';
      if v_unconsumed_bps is null or v_unconsumed_bps !~ '^[1-9][0-9]{0,4}$' or v_unconsumed_bps::integer > 10000 then
        raise exception 'unconsumed pool threshold is not set' using errcode = 'P0001';
      end if;
      select coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'student_pool'), 0),
             coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'share'), 0),
             pg_catalog.count(*) filter (where l.kind = 'student_pool'),
             pg_catalog.count(*) filter (where l.kind = 'student_pool' and l.half_points = 0)
      into v_pool, v_assigned, v_students, v_without
      from private.payout_for_period(p_period, 0) l;
      -- Con el bote en 0, el sin consumo también es 0 y no se abre: no se divide entre cero.
      if (v_pool - v_assigned) * 10000 > v_unconsumed_bps::bigint * v_pool then
        -- Con la fila del periodo, que la alerta apunta a ella (T-602): un mes con bases puede no
        -- tenerla todavía (las partes de un anual caen en meses sin fila).
        perform private.open_period(p_period);
        insert into public.anomaly_alerts (period_id, kind, metric_value, threshold_value, details)
        values (p_period, 'unconsumed_pool_ratio', pg_catalog.round((v_pool - v_assigned) * 10000.0 / v_pool, 3),
                v_unconsumed_bps::integer,
                pg_catalog.jsonb_build_object('pool_cents', v_pool, 'assigned_cents', v_assigned,
                                              'unconsumed_cents', v_pool - v_assigned, 'pool_bps', private.pool_bps(p_period),
                                              'students', v_students, 'students_without_points', v_without))
        on conflict do nothing;
        get diagnostics v_count = row_count;
        v_opened := v_opened + v_count;
      end if;
    exception when others then
      v_failed := sqlstate || ': ' || pg_catalog.left(sqlerrm, 200);
    end;
  end if;

  perform pg_catalog.set_config('app.actor_kind', coalesce(v_kind, ''), true);
  return pg_catalog.jsonb_build_object('alerts_opened', v_opened)
         || case when v_failed is null then '{}'::jsonb else pg_catalog.jsonb_build_object('anomalies_failed', v_failed) end;
end
$$;

-- Excluir consumo (t208): abre la fila del periodo antes de escribir la exclusión.
create or replace function private.exclude_consumption(p_scope public.exclusion_scope, p_period public.period_id, p_profile uuid,
                                            p_session uuid, p_lesson uuid, p_from integer, p_to integer,
                                            p_reason_code text, p_reason text, p_alert uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_actor uuid;
  v_reason text := pg_catalog.btrim(p_reason);
  v_alert public.anomaly_alerts;
  v_window public.period_id[];
  v_periods public.period_id[];
  v_period public.period_id;
  v_id uuid;
  v_ids uuid[] := '{}';
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'finance decisions run in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  v_actor := private.actor_id();
  if p_scope is null or p_profile is null or p_reason_code is null
     or p_reason_code not in ('fraud', 'technical_error', 'test_account', 'other')
     or v_reason is null or v_reason = '' or pg_catalog.length(v_reason) > 2000
     or (p_scope = 'account' and (p_period is null or p_session is not null or p_lesson is not null
                                  or p_from is not null or p_to is not null))
     or (p_scope = 'session' and (p_session is null or p_lesson is not null or p_from is not null or p_to is not null))
     or (p_scope = 'interval' and (p_period is null or p_session is not null or p_lesson is null
                                   or p_from is null or p_to is null or p_from < 0 or p_to <= p_from)) then
    return '{"outcome": "malformed"}'::jsonb;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exclusions:' || p_profile::text, 0));
  if not exists (select 1 from public.profiles p where p.id = p_profile) then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  v_window := array(select private.rollup_window());
  if p_scope = 'session' then
    if not exists (select 1 from public.playback_sessions s where s.id = p_session and s.profile_id = p_profile) then
      return '{"outcome": "not_found"}'::jsonb;
    end if;
    v_periods := array(select distinct e.period_id from public.watch_events e
                       where e.playback_session_id = p_session and e.period_id = any (v_window) order by 1);
    if pg_catalog.cardinality(v_periods) = 0 then
      return '{"outcome": "outside_window"}'::jsonb;
    end if;
  else
    if not p_period = any (v_window) then
      return '{"outcome": "outside_window"}'::jsonb;
    end if;
    if p_scope = 'interval' and not exists (select 1 from public.published_lessons l where l.id = p_lesson) then
      return '{"outcome": "not_found"}'::jsonb;
    end if;
    v_periods := array[p_period];
  end if;

  if p_alert is not null then
    select * into v_alert from public.anomaly_alerts a where a.id = p_alert for update;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', case when p_reason_code = 'fraud' then 'needs_fraud_decision' else 'not_found' end);
    end if;
  end if;
  if p_reason_code = 'fraud' then
    -- RN-17: decide finanzas, con la evidencia escrita en la alerta; solo el periodo de la alerta.
    if v_alert.id is null or v_alert.is_fraud is not true or not v_alert.period_id = any (v_periods) then
      return '{"outcome": "needs_fraud_decision"}'::jsonb;
    end if;
    v_periods := array[v_alert.period_id];
    if not (
        (v_alert.kind = 'impossible_completion' and v_alert.profile_id = p_profile)
        or (v_alert.kind = 'teacher_points_jump' and (
              exists (select 1 from public.watch_rollup w
                      where w.period_id = v_alert.period_id and w.profile_id = p_profile and w.teacher_id = v_alert.teacher_id)
              or exists (select 1 from public.watch_events e join public.published_lessons l on l.id = e.lesson_id
                         where e.period_id = v_alert.period_id and e.profile_id = p_profile and l.teacher_id = v_alert.teacher_id))
            -- Por tramo o por reproducción, solo lo de ese maestro.
            and (p_scope <> 'interval' or exists (select 1 from public.published_lessons l
                                                  where l.id = p_lesson and l.teacher_id = v_alert.teacher_id))
            and (p_scope <> 'session' or exists (select 1 from public.playback_sessions s join public.published_lessons l on l.id = s.lesson_id
                                                 where s.id = p_session and l.teacher_id = v_alert.teacher_id)))) then
      return '{"outcome": "not_related"}'::jsonb;
    end if;
  end if;

  foreach v_period in array v_periods loop
    continue when exists (
      select 1 from public.consumption_exclusions x
      where x.period_id = v_period and x.profile_id = p_profile and x.scope = p_scope and x.revoked_at is null
        and x.playback_session_id is not distinct from p_session and x.lesson_id is not distinct from p_lesson
        and x.from_second is not distinct from p_from and x.to_second is not distinct from p_to
        and x.reason_code = p_reason_code and x.anomaly_alert_id is not distinct from p_alert);
    -- La exclusión apunta a su periodo (T-602): su fila se abre antes, si falta.
    perform private.open_period(v_period);
    insert into public.consumption_exclusions (period_id, scope, profile_id, playback_session_id, lesson_id, from_second, to_second,
                                               reason_code, reason, anomaly_alert_id, created_by)
    values (v_period, p_scope, p_profile, p_session, p_lesson, p_from, p_to, p_reason_code, v_reason, p_alert, v_actor)
    returning id into v_id;
    v_ids := v_ids || v_id;
    perform private.mark_pairs_for(p_profile, v_period, p_lesson, p_session);
  end loop;
  if pg_catalog.cardinality(v_ids) = 0 then
    return '{"outcome": "already_excluded"}'::jsonb;
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'excluded', 'ids', pg_catalog.to_jsonb(v_ids));
end
$$;

-- El paso a cierre (t601_tramos): avisa del periodo que se queda abierto dos noches seguidas.
create or replace function private.period_transition(p_consolidated public.period_id[]) returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_kind text := pg_catalog.current_setting('app.actor_kind', true);
  v_current public.period_id;
  v_month integer;
  v_opened integer[] := '{}';
  v_due integer[];
  v_closing integer[];
  v_missing integer[];
  v_held integer[];
  v_again integer[];
  v_failed jsonb := '{}'::jsonb;
begin
  perform pg_catalog.set_config('app.actor_kind', 'system', true);
  v_due := array(select p.period_id from public.payout_periods p
                 where p.status = 'open' and private.period_reached_closing(p.period_id) order by 1);
  v_missing := array(select p.period_id from public.payout_periods p
                     where p.period_id = any (v_due) and p.period_id = any (p_consolidated) and p.active_students is null order by 1);
  -- Las filas que se mueven, con su candado en orden de periodo (T-602): un escritor que toma candado
  -- compartido sobre varias, también en orden, no se cruza con este.
  perform 1 from public.payout_periods p
  where p.status = 'open' and p.period_id = any (v_due) and p.period_id = any (p_consolidated) and p.active_students is not null
  order by p.period_id
  for no key update;
  with moved as (
    update public.payout_periods p set status = 'closing'
    where p.status = 'open' and p.period_id = any (v_due) and p.period_id = any (p_consolidated) and p.active_students is not null
    returning p.period_id)
  select coalesce(pg_catalog.array_agg(m.period_id order by m.period_id), '{}') into v_closing from moved m;

  v_current := private.period_of(pg_catalog.now());
  foreach v_month in array array[v_current, private.period_plus(v_current, 1), private.period_plus(v_current, 2)] loop
    begin
      if private.open_period(v_month) then
        v_opened := v_opened || v_month;
      end if;
    exception when others then
      v_failed := v_failed || pg_catalog.jsonb_build_object(v_month::text, sqlstate || ': ' || pg_catalog.left(sqlerrm, 200));
    end;
  end loop;

  -- Un periodo que llegó a su día y se quedó abierto también ayer (en la zona de los periodos): que se
  -- note (T-602). Se mide por días, no por corridas: dos corridas a mano el mismo día no avisan.
  v_held := array(select d from pg_catalog.unnest(v_due) d where not d = any (v_closing) order by 1);
  v_again := array(
    select d from pg_catalog.unnest(v_held) d
    where exists (
      select 1 from public.job_runs j
      where j.job = 'period_transition' and j.details -> 'held_open' @> pg_catalog.jsonb_build_array(d)
        and pg_catalog.timezone(private.period_zone(), j.started_at)::date
            = pg_catalog.timezone(private.period_zone(), pg_catalog.now())::date - 1)
    order by 1);

  perform pg_catalog.set_config('app.actor_kind', coalesce(v_kind, ''), true);
  return pg_catalog.jsonb_build_object(
    'entered_closing', pg_catalog.to_jsonb(v_closing),
    'held_open', pg_catalog.to_jsonb(v_held),
    'opened', pg_catalog.to_jsonb(v_opened))
    || case when v_failed = '{}'::jsonb then '{}'::jsonb else pg_catalog.jsonb_build_object('open_failed', v_failed) end
    || case when pg_catalog.cardinality(v_missing) = 0 then '{}'::jsonb else pg_catalog.jsonb_build_object('photo_missing', pg_catalog.to_jsonb(v_missing)) end
    || case when pg_catalog.cardinality(v_again) = 0 then '{}'::jsonb else pg_catalog.jsonb_build_object('held_open_again', pg_catalog.to_jsonb(v_again)) end;
end
$$;

-- La corrida de cada noche (t601_tramos): el modo de cada periodo lo decide `rollup_mode`, y al
-- terminar sella las particiones de los periodos cerrados.
create or replace procedure private.nightly_rollup(p_full boolean default false, p_period integer default null)
language plpgsql
as $$
declare
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

-- El vigilante: el área de los periodos (t601_tramos), con lo de T-602.
create or replace function private.schema_violations_periods()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  period_functions (name, definer, server) as (
    values ('month_bounds', false, false), ('period_zone', false, false), ('period_bounds', false, false),
           ('period_closing_at', false, false), ('period_reached_closing', false, false), ('period_status_of', false, false),
           ('open_period', false, false), ('period_transition', false, false), ('allocation_start', false, false),
           ('guard_payout_period', false, false), ('guard_frozen_period', false, false),
           ('period_start', true, true), ('guard_payout_timing', false, false), ('guard_pool_tier', false, false),
           ('guard_pool_base_origin', false, false), ('check_pool_tiers', false, false), ('marginal_pool_bps', false, false),
           ('pool_tiers_for', false, false), ('set_pool_tiers', true, false), ('active_students_at', false, false),
           ('effective_pool_bps', false, false), ('period_photos', false, false),
           ('rollup_mode', false, false), ('seal_watch_partition', false, false), ('unsealed_partitions', false, false),
           ('check_revenue_parts', true, false)),
  found as (
    select f.name, f.definer, f.server, p.oid, p.prosecdef, p.proconfig
    from period_functions f
    join pg_catalog.pg_proc p on p.proname = f.name
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private'),
  period_triggers (table_name, trigger_name, function_name, deferred) as (
    values ('public.payout_periods', 'payout_periods_guard', 'guard_payout_period', false),
           ('public.payout_periods', 'payout_periods_no_truncate', 'guard_payout_period', false),
           ('public.payout_periods', 'audit_changes', 'audit_row_change', false),
           ('public.charges', 'charges_frozen', 'guard_frozen_period', false),
           ('public.revenue_allocations', 'revenue_allocations_frozen', 'guard_frozen_period', false),
           ('public.consumption_exclusions', 'consumption_exclusions_frozen', 'guard_frozen_period', false),
           ('public.anomaly_alerts', 'anomaly_alerts_frozen', 'guard_frozen_period', false),
           ('public.watch_rollup', 'watch_rollup_frozen', 'guard_frozen_period', false),
           ('public.pool_tiers', 'pool_tiers_actor', 'guard_config_actor', false),
           ('public.pool_tiers', 'pool_tiers_fresh_code', 'guard_parameter_fresh_code', false),
           ('public.pool_tiers', 'pool_tiers_guard', 'guard_pool_tier', false),
           ('public.pool_tiers', 'pool_tiers_no_truncate', 'guard_pool_tier', false),
           ('public.pool_tiers', 'audit_changes', 'audit_row_change', false),
           ('public.pool_tiers', 'pool_tiers_timing', 'guard_payout_timing', true),
           ('public.business_parameters', 'business_parameters_origin', 'guard_pool_base_origin', false),
           ('public.business_parameters', 'business_parameters_timing', 'guard_payout_timing', true))
  select 'period table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.payout_periods'), ('public.pool_tiers')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  select 'period function missing', 'private.' || f.name
  from period_functions f
  where not exists (select 1 from found where found.name = f.name)
  union all
  select 'period function executable by ' || r.rolname, found.oid::regprocedure::text
  from app_roles r cross join found
  where pg_catalog.has_function_privilege(r.rolname::name, found.oid, 'EXECUTE')
    and not (found.server and r.rolname = 'app_service')
  union all
  select 'period function not executable by app_service', found.oid::regprocedure::text
  from found
  where found.server and not pg_catalog.has_function_privilege('app_service', found.oid, 'EXECUTE')
  union all
  select 'period function security definer or without fixed search_path', found.oid::regprocedure::text
  from found
  where (found.prosecdef and not found.definer) or not coalesce(found.proconfig, '{}') @> array['search_path=""']
  union all
  select 'period function not security definer', found.oid::regprocedure::text
  from found
  where found.definer and not found.prosecdef
  union all
  select 'period trigger missing or disabled: ' || g.trigger_name, g.table_name
  from period_triggers g
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = g.table_name::regclass and tg.tgname = g.trigger_name and tg.tgenabled in ('O', 'A')
      and n.nspname = 'private' and p.proname = g.function_name)
  union all
  select 'period trigger not deferred: ' || g.trigger_name, g.table_name
  from period_triggers g
  join pg_catalog.pg_trigger tg on tg.tgrelid = g.table_name::regclass and tg.tgname = g.trigger_name
  where g.deferred and (tg.tgconstraint = 0 or not tg.tgdeferrable or not tg.tginitdeferred)
$$;
