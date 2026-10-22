-- T-207 · Consolidación nocturna (RF-405, RF-408, RN-04; 05 §5.4, §5.7, §5.9, §8.2 y §13).
-- Decisiones de Sergio del 2026-10-21: la lanza pg_cron y todo vive en la base (la regla de los
-- puntos también); el alias del alumno llega con T-408; un día de práctica es un tramo visible
-- aceptado, y se guardan sus segundos; cada noche se consolidan el mes en curso y el anterior,
-- sin tabla de periodos todavía (T-601).
--
-- El latido deja dos cosas más: la marca del par (periodo, alumno, lección) cuando acepta un tramo
-- que cuenta para el reparto, y los segundos visibles del día de práctica. Cada noche la corrida
-- consolida los pares marcados: por cada uno, todos sus tramos del periodo que cuentan, unidos
-- (segundos distintos: repetir no suma), y sus medios puntos. Si nada cambió, la fila no se
-- escribe: correrla dos veces da lo mismo, hasta la hora en que cambió.
--
-- Lo que cambia respecto del esquema escrito (05 §8.2):
--   · los puntos se deciden en la base (`private.half_points()`), no en TypeScript: la corrida no
--     sale de la base (decisión de Sergio);
--   · los umbrales son los que rigen desde el periodo (`effective_period_id`), no los de la hora
--     en que corre: el día 1 se consolida el mes que terminó;
--   · las marcas se leen sin bloquearlas y se borran al final solo si nadie las tocó en medio
--     (`touched_at`): un latido que llega mientras se consolida su par deja la marca para la
--     siguiente corrida, y nunca espera a un lote entero;
--   · la duración es la del video que se acreditó, la que validó sus tramos (la menor de sus
--     reproducciones), no la de `video_assets`, que puede ser nula;
--   · además de la ventana, cada noche se consolidan los periodos anteriores que todavía tengan
--     marcas: el último día de un mes llegan latidos atrasados del anterior después de la corrida;
--   · nada de la aplicación escribe las marcas, los días ni el consolidado (el 05 le daba al
--     servidor insertar, cambiar y borrar).
-- Sin el estimado (T-407 y T-408), las alertas y las exclusiones (T-208), ni congelar lo cerrado
-- (T-601 y T-602): llegan con sus tareas.

-- ---------------------------------------------------------------------------------------
-- Las corridas (05 §5.9): qué trabajos hay y cómo terminó cada corrida (RNF-16).

create type public.run_status as enum ('running', 'succeeded', 'failed');

create table public.job_definitions (
  job text primary key,
  description text not null,
  schedule text not null,                     -- la expresión de pg_cron, en UTC
  expected_every interval,                    -- nulo si corre por evento o a mano
  alert_after interval,                       -- cuánto atraso dispara la alerta
  is_active boolean not null default true
);
comment on table public.job_definitions is 'Los trabajos programados y cada cuánto se espera que corran (05 §5.9).';
alter table public.job_definitions enable row level security;
revoke all on public.job_definitions from public, anon, authenticated, service_role, app_service;

insert into public.job_definitions (job, description, schedule, expected_every, alert_after) values
  ('nightly_rollup', 'Consolidación nocturna', '0 9 * * *', interval '1 day', interval '150 minutes');

create table public.job_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null references public.job_definitions (job),
  period_id public.period_id,
  status public.run_status not null default 'running',
  triggered_by uuid references public.profiles (id),   -- nulo: lo disparó el calendario
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),     -- una corrida viva lo actualiza en cada lote
  finished_at timestamptz,
  rows_read bigint not null default 0,
  rows_written bigint not null default 0,
  details jsonb not null default '{}'::jsonb,
  error text,                                           -- el código y un mensaje acotado
  constraint job_runs_finished_consistent check ((status = 'running') = (finished_at is null))
);
comment on table public.job_runs is 'Cada corrida de un trabajo programado: cuándo, cómo terminó y cuánto tocó (RNF-16).';
-- El candado: una sola corrida viva por trabajo y periodo.
create unique index job_runs_one_running_uq on public.job_runs (job, coalesce(period_id, 0)) where status = 'running';
create index job_runs_last_idx on public.job_runs (job, started_at desc);
alter table public.job_runs enable row level security;
revoke all on public.job_runs from public, anon, authenticated, service_role, app_service;

-- ---------------------------------------------------------------------------------------
-- Las marcas, los días y el consolidado.

-- Los pares tocados desde la última corrida (05 §5.4). Buscarlos por fecha en `watch_events`
-- pediría un tercer índice sobre la tabla más grande. Sin claves foráneas: la escribe cada lote.
create table private.rollup_dirty (
  period_id public.period_id not null,
  profile_id uuid not null,
  lesson_id uuid not null,
  touched_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (period_id, profile_id, lesson_id)
);
comment on table private.rollup_dirty is 'Pares de alumno y lección con tramos nuevos que cuentan, por periodo (RF-405). La escribe private.record_heartbeats(); la vacía la corrida.';
-- Cada paso lee las más viejas de su periodo.
create index rollup_dirty_touched_idx on private.rollup_dirty (period_id, touched_at);
alter table private.rollup_dirty enable row level security;
revoke all on private.rollup_dirty from public, anon, authenticated, service_role, app_service;

-- Los días en que una cuenta practicó, con sus segundos visibles (05 §5.7, RF-807). Sostiene las
-- rachas cuando los latidos crudos ya se purgaron; con los segundos, T-505 puede pedir un mínimo
-- sin rehacer nada (decisión de Sergio del 2026-10-21). Es historial: se borra con la cuenta. Sin
-- clave foránea a `profiles`: el primer lote del día tomaría un candado que choca con el de anotar
-- una sesión. La persona la leerá cuando haya quien la pinte (T-505).
create table public.practice_days (
  profile_id uuid not null,
  day date not null,                          -- la del tope, en ZONA_HORARIA_PERIODO
  seconds integer not null,                   -- visibles y aceptados, a cualquier velocidad
  primary key (profile_id, day),
  constraint practice_days_seconds_positive check (seconds > 0)
);
comment on table public.practice_days is 'Días de práctica de cada cuenta y sus segundos visibles (RF-807, T-207). La escribe solo private.record_heartbeats().';
alter table public.practice_days enable row level security;
revoke all on public.practice_days from public, anon, authenticated, service_role, app_service;

-- El consolidado (05 §5.4): por periodo, alumno y lección, los segundos distintos que cuentan y
-- sus medios puntos. Recalculable con el periodo abierto; congelarlo al cerrar llega con T-602, y
-- su clave foránea al periodo con T-601. La clave foránea a `profiles` toma en cada escritura un
-- candado que choca con el de anotar una sesión: una entrada a la hora de la corrida espera, a lo
-- más, un paso (cada paso confirma). En `practice_days` no se acepta, porque va en cada latido.
create table public.watch_rollup (
  period_id public.period_id not null,
  profile_id uuid not null references public.profiles (id),
  lesson_id uuid not null references public.published_lessons (id),
  course_id uuid not null references public.course_registry (course_id),
  teacher_id uuid not null references public.teachers (id),     -- el vigente al consolidar (RN-14)
  video_asset_id uuid not null references public.video_assets (id),   -- el video que se acreditó
  lesson_duration_seconds integer not null,   -- la de ese video, la que validó sus tramos
  covered_seconds integer not null,           -- segundos distintos que cuentan en el periodo (RF-405)
  half_points smallint not null,              -- 0, 1 o 2: cero, PUNTOS_MEDIO o PUNTOS_COMPLETO (RN-04)
  computed_at timestamptz not null default now(),   -- cuándo cambió por última vez
  job_run_id uuid references public.job_runs (id),
  primary key (period_id, profile_id, lesson_id),
  constraint watch_rollup_duration_positive check (lesson_duration_seconds > 0),
  constraint watch_rollup_covered_range check (covered_seconds between 0 and lesson_duration_seconds),
  constraint watch_rollup_half_points_range check (half_points in (0, 1, 2))
);
comment on table public.watch_rollup is 'Consolidado (RF-405). Una fila por periodo, alumno y lección: repetir no suma. Recalculable con el periodo abierto (RF-408). Lo escriben solo las funciones de la corrida.';
-- Puntos por maestro: estimado nocturno, entrada del cierre y panel del maestro.
create index watch_rollup_teacher_idx on public.watch_rollup (period_id, teacher_id);
alter table public.watch_rollup enable row level security;
revoke all on public.watch_rollup from public, anon, authenticated, service_role, app_service;

-- ---------------------------------------------------------------------------------------
-- Los puntos (RN-04).

-- Medios puntos de una lección: 0 debajo del umbral medio, 1 (PUNTOS_MEDIO) desde él, 2
-- (PUNTOS_COMPLETO, que es también el tope) desde el completo. Los umbrales en puntos base. Es el
-- mismo redondeo que el progreso: llegar a ceil(duración × umbral / 10 000). Con un nulo da nulo,
-- nunca cero: el consolidado no lo acepta.
create function private.half_points(p_covered integer, p_duration integer, p_half_bps integer, p_full_bps integer)
returns smallint
language sql immutable strict parallel safe set search_path = ''
as $$
  select case when p_covered::bigint * 10000 >= p_duration::bigint * p_full_bps then 2
              when p_covered::bigint * 10000 >= p_duration::bigint * p_half_bps then 1
              else 0 end::smallint
$$;
revoke all on function private.half_points(integer, integer, integer, integer) from public;

-- Los umbrales de un periodo: los que rigen desde ese periodo (RF-707: un cambio que afecta al
-- reparto entra al empezar un periodo), no los de la hora en que corre la consolidación. Lanza si
-- falta alguno, si no es un entero de 1 a 10 000 o si el medio pasa del completo: no se adivina.
create function private.payout_thresholds(p_period public.period_id, out half_bps integer, out full_bps integer)
language plpgsql stable set search_path = ''
as $$
declare
  v_half jsonb;
  v_full jsonb;
begin
  select b.value into v_half from public.business_parameters b
  where b.key = 'UMBRAL_MEDIO_PCT' and b.canceled_at is null and b.effective_period_id <= p_period
  order by b.effective_period_id desc, b.effective_from desc limit 1;
  select b.value into v_full from public.business_parameters b
  where b.key = 'UMBRAL_COMPLETO_PCT' and b.canceled_at is null and b.effective_period_id <= p_period
  order by b.effective_period_id desc, b.effective_from desc limit 1;
  if pg_catalog.jsonb_typeof(v_half) is distinct from 'number' or (v_half)::text !~ '^[1-9][0-9]{0,4}$'
     or pg_catalog.jsonb_typeof(v_full) is distinct from 'number' or (v_full)::text !~ '^[1-9][0-9]{0,4}$' then
    raise exception 'payout thresholds are not set for period %', p_period using errcode = 'P0001';
  end if;
  half_bps := (v_half)::text::integer;
  full_bps := (v_full)::text::integer;
  if full_bps > 10000 or half_bps > full_bps then
    raise exception 'payout thresholds are not valid for period %', p_period using errcode = 'P0001';
  end if;
end
$$;
revoke all on function private.payout_thresholds(public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- Consolidar un par.

-- Todos los tramos que cuentan del par en el periodo, por video: si la lección cambió de video a
-- medio periodo, cada uno se mide contra su propia duración y se queda el de más medios puntos
-- (después, más segundos; después, el vigente; al final, uno fijo). Nunca se suman dos videos.
-- Sin tramos que cuenten, la fila se borra. Si nada cambió, no se escribe: el consolidado queda
-- idéntico. Devuelve cuántas filas cambió (0 o 1).
create function private.rollup_pair(p_period public.period_id, p_profile uuid, p_lesson uuid, p_run uuid,
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
    select s.video_asset_id, pg_catalog.min(s.lesson_duration_seconds) as duration,
           pg_catalog.range_agg(pg_catalog.int4range(e.from_second, e.to_second)) as spans
    from public.watch_events e
    join public.playback_sessions s on s.id = e.playback_session_id
    where e.period_id = p_period and e.profile_id = p_profile and e.lesson_id = p_lesson and e.counts_for_payout
    group by s.video_asset_id
  ) v
  -- Lo que cae dentro de la duración, no un total recortado: [20, 100) contra 80 s son 60.
  cross join lateral (select v.video_asset_id, v.duration,
                             private.span_seconds(v.spans * pg_catalog.int4multirange(pg_catalog.int4range(0, v.duration))) as covered) c
  left join public.published_lessons l on l.id = p_lesson
  order by private.half_points(c.covered, c.duration, p_half_bps, p_full_bps) desc, c.covered desc,
           (c.video_asset_id = l.video_asset_id) desc, c.video_asset_id
  limit 1;

  if v_video is null then
    delete from public.watch_rollup w where w.period_id = p_period and w.profile_id = p_profile and w.lesson_id = p_lesson;
    get diagnostics v_written = row_count;
    return v_written;
  end if;

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
revoke all on function private.rollup_pair(public.period_id, uuid, uuid, uuid, integer, integer) from public;

-- ---------------------------------------------------------------------------------------
-- La corrida: los periodos, abrir y cerrar, y cada paso.

-- Los periodos que todavía reciben latidos: el en curso y el anterior, en ZONA_HORARIA_PERIODO
-- (la misma ventana que private.record_heartbeats()). Son los que se consolidan cada noche.
create function private.rollup_window() returns setof public.period_id
language plpgsql stable set search_path = ''
as $$
declare
  v_zone text := private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}';
  v_month timestamp;
begin
  if v_zone is null then
    raise exception 'ZONA_HORARIA_PERIODO is not set' using errcode = 'P0001';
  end if;
  v_month := pg_catalog.date_trunc('month', pg_catalog.timezone(v_zone, pg_catalog.now()));
  return next pg_catalog.to_char(v_month - interval '1 month', 'YYYYMM')::integer;
  return next pg_catalog.to_char(v_month, 'YYYYMM')::integer;
end
$$;
revoke all on function private.rollup_window() from public;

-- Abre la corrida de un trabajo para un periodo, en modo `dirty` (los pares marcados) o `full`
-- (todos los del periodo, RF-408). Una corrida viva del trabajo que no latió en 15 minutos se dio
-- por caída (un reinicio la deja con el candado tomado): queda fallida, sea del periodo que sea,
-- para que ninguna se quede viva en un periodo que ya no se abre. Si otra del mismo periodo sigue
-- viva, no abre: nulo.
create function private.open_job_run(p_job text, p_period public.period_id, p_mode text) returns uuid
language plpgsql volatile set search_path = ''
as $$
declare
  v_run uuid;
begin
  if p_mode not in ('dirty', 'full') then
    raise exception 'unknown mode %', p_mode using errcode = '22023';
  end if;
  update public.job_runs j
  set status = 'failed', finished_at = pg_catalog.clock_timestamp(), error = 'stale'
  where j.job = p_job and j.status = 'running' and j.heartbeat_at < pg_catalog.clock_timestamp() - interval '15 minutes';
  begin
    insert into public.job_runs (job, period_id, started_at, heartbeat_at, details)
    values (p_job, p_period, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
            pg_catalog.jsonb_build_object('mode', p_mode))
    returning id into v_run;
  exception when unique_violation then
    return null;
  end;
  return v_run;
end
$$;
revoke all on function private.open_job_run(text, public.period_id, text) from public;

-- Cierra una corrida: bien si no hubo error ni falló un par; si no, fallida, con el error o con
-- cuántos pares fallaron. Anota las marcas que quedan de periodos fuera de la ventana: la corrida
-- de cada noche también los recorre (el recálculo completo no), así que después de ella solo
-- queda ahí lo que falló (T-601 no cerrará un periodo con marcas).
create function private.close_job_run(p_run uuid, p_error text) returns void
language sql volatile set search_path = ''
as $$
  update public.job_runs j
  set status = case when p_error is null and coalesce((j.details ->> 'pairs_failed')::integer, 0) = 0 then 'succeeded'
                    else 'failed' end::public.run_status,
      finished_at = pg_catalog.clock_timestamp(),
      error = pg_catalog.left(coalesce(p_error, case when coalesce((j.details ->> 'pairs_failed')::integer, 0) > 0
        then 'pairs failed: ' || (j.details ->> 'pairs_failed') || ' (' || (j.details ->> 'first_failure') || ')' end), 300),
      details = j.details || pg_catalog.jsonb_build_object('marks_outside_window',
        (select pg_catalog.count(*) from private.rollup_dirty d
         where d.period_id <> all (array(select private.rollup_window()))))
  where j.id = p_run and j.status = 'running'
$$;
revoke all on function private.close_job_run(uuid, text) from public;

-- Un paso de una corrida: hasta `p_limit` pares de su periodo, cada uno consolidado entero.
--   · `dirty`: las marcas anteriores al arranque de la corrida (`p_before`), las más viejas
--     primero. Se leen sin bloquearlas y, ya consolidados sus pares, se borran solo las que
--     siguen como se leyeron: un latido que llegó en medio cambió `touched_at`, y su marca se
--     queda para la siguiente corrida. Cada cálculo es una sentencia posterior a la lectura y ve
--     lo confirmado hasta ese momento.
--   · `full`: los pares con latidos en el periodo y los que ya tiene el consolidado (para borrar
--     los que dejaron de contar), en orden, después de (`p_after_profile`, `p_after_lesson`).
-- Los umbrales se leen solo si hay algo que consolidar: un periodo sin marcas no los necesita.
-- Un par que falla no detiene a los demás: va en su propio bloque, queda marcado con la hora de
-- ahora (después del arranque: esta corrida no lo relee y la de la noche siguiente lo vuelve a
-- intentar, también si falló en el recálculo completo) y la corrida lo
-- cuenta en `details` (`pairs_failed`, y el código del primero). Pasos de 50 pares: cada bloque
-- que escribe es una subtransacción, y pasar de 64 en una transacción vuelve lentas a las demás.
-- Devuelve {read, written, last_profile, last_lesson}; `read` en 0 es que ya no queda nada.
create function private.rollup_step(p_run uuid, p_before timestamptz, p_after_profile uuid default null,
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
revoke all on function private.rollup_step(uuid, timestamptz, uuid, uuid, integer) from public;

-- La corrida (05 §8.2). Por cada periodo de la ventana, y cada noche también por los anteriores
-- que todavía tengan marcas (el último día de un mes llegan, después de las 03:00, latidos
-- atrasados del mes anterior; a las 03:00 del día 1 ese mes ya salió de la ventana): abre su
-- corrida, da pasos hasta que no quede nada y la cierra. Con `p_period`, solo ese, y solo si está
-- en la ventana. Hace `commit` después de abrir, de cada paso y de cerrar: un paso corto suelta
-- pronto lo que tomó, un corte no deshace lo hecho (cada par se recalcula entero: la marca que no
-- se borró lo retoma la noche siguiente; un recálculo completo cortado se vuelve a pedir) y la
-- corrida queda anotada aunque falle. Por eso es un procedimiento sin `security definer` ni
-- `set search_path` (con cualquiera de los dos, Postgres no deja hacer `commit`), y el `commit` va
-- fuera de los bloques con excepción. Lo corre el dueño de la base: pg_cron cada noche, y a mano
-- `pnpm db:rollup`. Nadie de la aplicación lo ejecuta. `p_full`: el recálculo completo del
-- periodo (RF-408), solo de la ventana.
create procedure private.nightly_rollup(p_full boolean default false, p_period integer default null)
language plpgsql
as $$
declare
  v_start timestamptz := pg_catalog.clock_timestamp();
  v_path text := pg_catalog.current_setting('search_path');
  v_periods integer[];
  v_period integer;
  v_run uuid;
  v_step jsonb;
  v_error text;
  v_after_profile uuid;
  v_after_lesson uuid;
begin
  v_periods := array(select private.rollup_window());
  if p_period is not null then
    if not p_period = any (v_periods) then
      raise exception 'period % no longer receives heartbeats', p_period using errcode = '22023';
    end if;
    v_periods := array[p_period];
  elsif not p_full then
    v_periods := array(select p from (select pg_catalog.unnest(v_periods) as p
                                      union select d.period_id from private.rollup_dirty d) s order by p);
  end if;
  -- De la sesión y no de la transacción: un ajuste local se iría con el primer `commit`. Se
  -- devuelve al terminar; si algo lanza a la mitad, la sesión se queda sin él (pg_cron y
  -- `db:rollup` cierran la conexión).
  perform pg_catalog.set_config('search_path', '', false);

  foreach v_period in array v_periods loop
    v_run := private.open_job_run('nightly_rollup', v_period, case when p_full then 'full' else 'dirty' end);
    commit;
    continue when v_run is null;
    v_error := null;
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
    perform private.close_job_run(v_run, v_error);
    commit;
  end loop;
  perform pg_catalog.set_config('search_path', v_path, false);
end
$$;
revoke all on procedure private.nightly_rollup(boolean, integer) from public;

-- Cada noche a las 03:00 de la Ciudad de México (09:00 UTC; ya no cambia de horario), antes de
-- asegurar las particiones (09:17). El trabajo es solo la llamada: así puede hacer `commit`.
select cron.schedule('nightly_rollup', '0 9 * * *', 'call private.nightly_rollup()');

-- ---------------------------------------------------------------------------------------
-- Los latidos, con la marca y el día de práctica. Lo demás no cambia (T-205 y T-206).

-- Lo que se agrega al final del lote (05 §9.2, el bloque que quedó pendiente para T-207, sin el
-- alias, que llega con T-408): la marca del par si se aceptó un tramo que cuenta para el reparto,
-- y los segundos visibles del día de práctica.

create or replace function private.record_heartbeats(p_session uuid, p_events jsonb, p_access_counts boolean, p_at timestamptz)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_auth uuid := private.actor_session();
  v_row public.playback_sessions%rowtype;
  v_window interval;
  v_top timestamptz;
  v_max_rate numeric;
  v_zone text;
  v_period integer;
  v_elapsed numeric;
  v_budget numeric;
  v_media integer := 0;
  v_seen int4multirange;
  v_item record;
  v_event jsonb;
  v_seq integer;
  v_from integer;
  v_to integer;
  v_rate numeric;
  v_visible boolean;
  v_qualifies boolean;
  v_counts boolean;
  v_reason text;
  v_inserted integer;
  v_accepted integer[] := '{}';
  v_duplicate integer[] := '{}';
  v_rejected jsonb := '[]';
  v_out_of_range integer := 0;
  v_too_fast integer := 0;
  v_spans int4multirange;
  v_last_seq integer;
  v_last_to integer;
  v_progress jsonb;
  v_counted boolean := false;
  v_practice integer := 0;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.record_heartbeats() needs read committed isolation' using errcode = '25000';
  end if;
  if v_actor is null or v_auth is null then
    return null;
  end if;
  -- El candado de la cuenta, como la presencia: los lotes de una cuenta, de uno en uno.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('playback:' || v_actor::text, 0));

  -- Todo lo que sigue se deshace solo, sin tocar lo que ya hizo la transacción (la presencia).
  begin
    if p_events is null or pg_catalog.jsonb_typeof(p_events) <> 'array' or pg_catalog.jsonb_array_length(p_events) > 50 then
      return pg_catalog.jsonb_build_object('outcome', 'failed', 'code', 'batch_shape');
    end if;

    v_window := pg_catalog.make_interval(secs => 3 * (private.playback_limits()).heartbeat_seconds);
    select * into v_row from public.playback_sessions s
    where s.id = p_session and s.profile_id = v_actor
      and (s.auth_session_id = v_auth or s.revoked_at is not null
           or not exists (select 1 from private.app_sessions a where a.session_id = s.auth_session_id))
    for update;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;

    v_max_rate := (private.parameter_value('VELOCIDAD_MAX') #>> '{}')::numeric;
    v_zone := private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}';
    if v_max_rate is null or v_max_rate <= 0 or v_zone is null then
      raise exception 'VELOCIDAD_MAX or ZONA_HORARIA_PERIODO is not set' using errcode = 'P0001';
    end if;

    v_top := least(pg_catalog.now(), v_row.revoked_at, v_row.last_heartbeat_at + v_window);
    if v_top is distinct from p_at then
      return pg_catalog.jsonb_build_object('outcome', 'failed', 'code', 'clock_moved');
    end if;
    v_period := pg_catalog.to_char(pg_catalog.timezone(v_zone, v_top), 'YYYYMM')::integer;
    if v_period < pg_catalog.to_char(pg_catalog.date_trunc('month', pg_catalog.timezone(v_zone, pg_catalog.now())) - interval '1 month',
                                      'YYYYMM')::integer then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    v_elapsed := v_row.live_seconds + greatest(extract(epoch from v_top - v_row.last_heartbeat_at), 0);
    v_budget := v_elapsed * v_max_rate + least(5, v_elapsed);
    v_seen := v_row.seqs_received;

    for v_item in
      select e.value as event
      from pg_catalog.jsonb_array_elements(p_events) with ordinality e
      order by case when pg_catalog.jsonb_typeof(e.value -> 'seq') = 'number' then (e.value ->> 'seq')::numeric end nulls last,
               e.ordinality
    loop
      v_event := v_item.event;
      v_reason := null;
      v_seq := null;

      -- La forma. Un número que no es entero no es un consecutivo ni un segundo.
      if pg_catalog.jsonb_typeof(v_event) <> 'object'
         or pg_catalog.jsonb_typeof(v_event -> 'seq') is distinct from 'number'
         or (v_event ->> 'seq') !~ '^[0-9]{1,7}$' or (v_event ->> 'seq')::integer > 1000000 then
        v_reason := 'out_of_range';
      else
        v_seq := (v_event ->> 'seq')::integer;
        if v_seen @> v_seq then
          v_duplicate := v_duplicate || v_seq;
          continue;
        end if;
        v_seen := v_seen + pg_catalog.int4multirange(pg_catalog.int4range(v_seq, v_seq + 1));

        if pg_catalog.jsonb_typeof(v_event -> 'from') is distinct from 'number'
           or pg_catalog.jsonb_typeof(v_event -> 'to') is distinct from 'number'
           or pg_catalog.jsonb_typeof(v_event -> 'rate') is distinct from 'number'
           or pg_catalog.jsonb_typeof(v_event -> 'visible') is distinct from 'boolean'
           or (v_event ->> 'from') !~ '^[0-9]{1,7}$' or (v_event ->> 'to') !~ '^[0-9]{1,7}$' then
          v_reason := 'out_of_range';
        else
          v_from := (v_event ->> 'from')::integer;
          v_to := (v_event ->> 'to')::integer;
          v_rate := pg_catalog.round((v_event ->> 'rate')::numeric, 2);
          v_visible := (v_event ->> 'visible')::boolean;
          if v_to > v_row.lesson_duration_seconds and v_to <= v_row.lesson_duration_seconds + 2 then
            v_to := v_row.lesson_duration_seconds;
          end if;
          if v_to <= v_from or v_to > v_row.lesson_duration_seconds or v_rate <= 0 or v_rate > 9.99 then
            v_reason := 'out_of_range';
          elsif v_media + (v_to - v_from) > v_budget - v_row.accepted_media_seconds then
            v_reason := 'faster_than_clock';
          end if;
        end if;
      end if;

      if v_reason is not null then
        v_rejected := v_rejected || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('seq', coalesce(pg_catalog.to_jsonb(v_seq), v_event -> 'seq'), 'reason', v_reason));
        if v_reason = 'out_of_range' then
          v_out_of_range := v_out_of_range + 1;
        else
          v_too_fast := v_too_fast + 1;
        end if;
        continue;
      end if;

      v_qualifies := v_visible and v_rate <= v_max_rate;
      v_counts := v_qualifies and v_row.counts_for_payout and coalesce(p_access_counts, false);
      insert into public.watch_events (
        period_id, playback_session_id, seq, profile_id, lesson_id, from_second, to_second,
        playback_rate, was_visible, qualifies, counts_for_payout)
      values (
        v_period, p_session, v_seq, v_row.profile_id, v_row.lesson_id, v_from, v_to,
        v_rate, v_visible, v_qualifies, v_counts)
      on conflict (period_id, playback_session_id, seq) do nothing;
      get diagnostics v_inserted = row_count;
      if v_inserted = 0 then
        -- Ya estaba, aunque `seqs_received` no lo dijera: la clave es la segunda defensa.
        v_duplicate := v_duplicate || v_seq;
      else
        v_accepted := v_accepted || v_seq;
        v_media := v_media + (v_to - v_from);
        -- Para la consolidación y los días de práctica (T-207).
        v_counted := v_counted or v_counts;
        if v_visible then
          v_practice := v_practice + (v_to - v_from);
        end if;
        -- Para el progreso (T-206): el último aceptado mueve la posición, sirva o no; solo lo que
        -- sirve se funde. El bucle va en orden de consecutivo: el último es el mayor.
        v_last_seq := v_seq;
        v_last_to := v_to;
        if v_qualifies then
          v_spans := coalesce(v_spans, '{}'::int4multirange) + pg_catalog.int4multirange(pg_catalog.int4range(v_from, v_to));
        end if;
      end if;
    end loop;

    update public.playback_sessions s
    set accepted_media_seconds = s.accepted_media_seconds + v_media,
        seqs_received = v_seen
    where s.id = p_session;

    if v_out_of_range > 0 or v_too_fast > 0 then
      insert into private.heartbeat_rejection_counts as h (day, profile_id, reason, rejections)
      select pg_catalog.timezone(v_zone, pg_catalog.now())::date, v_row.profile_id, r.reason, r.n
      from (values ('out_of_range', v_out_of_range), ('faster_than_clock', v_too_fast)) as r (reason, n)
      where r.n > 0
      on conflict (day, profile_id, reason) do update set rejections = h.rejections + excluded.rejections;
    end if;

    -- La marca del par para la consolidación (T-207), en el bloque del lote: si falla, el lote
    -- no entra y el navegador lo reintenta, porque perderla perdería consumo. La hora es la del
    -- reloj, no la de la transacción: la corrida borra una marca solo si sigue como la leyó, y un
    -- lote que llega mientras consolida su par tiene que cambiarla.
    if v_counted then
      insert into private.rollup_dirty (period_id, profile_id, lesson_id, touched_at)
      values (v_period, v_row.profile_id, v_row.lesson_id, pg_catalog.clock_timestamp())
      on conflict (period_id, profile_id, lesson_id) do update set touched_at = excluded.touched_at;
    end if;

    -- El día de práctica (T-207; decisión de Sergio del 2026-10-21): lo visible aceptado, a
    -- cualquier velocidad, en el día del tope. En su propio bloque: si falla, el lote se queda y
    -- esos segundos se pierden (aceptado), con un aviso en el registro de la base, sin datos de
    -- nadie. La vista previa del dueño no es práctica.
    if v_practice > 0 and v_row.access_basis <> 'owner_preview' then
      begin
        insert into public.practice_days as p (profile_id, day, seconds)
        values (v_row.profile_id, pg_catalog.timezone(v_zone, v_top)::date, v_practice)
        on conflict (profile_id, day) do update set seconds = p.seconds + excluded.seconds;
      exception when others then
        raise warning 'practice day not recorded (%)', sqlstate;
      end;
    end if;

    -- El progreso (T-206), en su propio bloque: si falla, el libro y lo demás se quedan, y el
    -- progreso se rehace después desde el libro (decisión de Sergio del 2026-10-20). La vista
    -- previa del dueño no deja progreso.
    if v_row.access_basis <> 'owner_preview' then
      begin
        v_progress := private.merge_progress(v_row, v_spans, v_last_seq, v_last_to, v_top);
      exception when others then
        v_progress := pg_catalog.jsonb_build_object('outcome', 'failed', 'code', sqlstate);
        insert into private.progress_rebuilds (profile_id, lesson_id, code)
        values (v_row.profile_id, v_row.lesson_id, sqlstate)
        on conflict (profile_id, lesson_id) do update set failed_at = excluded.failed_at, code = excluded.code;
      end;
    end if;

    return pg_catalog.jsonb_build_object('outcome', 'recorded', 'accepted', pg_catalog.to_jsonb(v_accepted),
                                         'duplicate', pg_catalog.to_jsonb(v_duplicate), 'rejected', v_rejected,
                                         'progress', v_progress);
  exception when others then
    return pg_catalog.jsonb_build_object('outcome', 'failed', 'code', sqlstate);
  end;
end
$$;

-- ---------------------------------------------------------------------------------------
-- El vigilante aprende la consolidación: nadie de la aplicación toca sus tablas, y nadie ejecuta
-- sus funciones.

create or replace function private.schema_violations()
returns table (problem text, object_name text)
language sql stable security definer set search_path = ''
as $$
  with ledgers (table_schema, table_name) as (
    values
      ('public', 'watch_events'), ('public', 'charges'), ('public', 'charge_reversals'),
      ('public', 'revenue_allocations'), ('public', 'payout_student_pools'), ('public', 'payout_shares'),
      ('public', 'payout_teacher_totals'), ('public', 'payout_status_events'),
      ('public', 'payout_adjustments'), ('public', 'teacher_balance_entries'),
      ('public', 'reserve_entries'), ('public', 'legal_documents'), ('public', 'consents'),
      ('public', 'licenses'), ('public', 'audit_log'), ('private', 'teacher_tax_profiles'),
      ('private', 'student_aliases'), ('private', 'moderation_actions'),
      ('private', 'moderation_case_access_log')),
  app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  watch_tables (oid) as (
    select 'public.watch_events'::regclass::oid
    union all
    select i.inhrelid from pg_catalog.pg_inherits i where i.inhparent = 'public.watch_events'::regclass)
  -- Tablas propias sin seguridad por fila (RNF-08).
  select 'table without row level security', n.nspname || '.' || c.relname
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and not c.relrowsecurity
  union all
  -- Funciones security definer sin search_path fijo.
  select 'security definer function without a fixed search_path', n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosecdef
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%')
  union all
  -- Funciones propias que cualquiera puede ejecutar.
  select 'function executable by PUBLIC', n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and pg_catalog.has_function_privilege('public', p.oid, 'execute')
  union all
  -- Escrituras a nivel de tabla para roles de usuario, fuera de la única prevista.
  select 'unexpected write privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  where g.grantee in ('anon', 'authenticated')
    and g.table_schema in ('public', 'private')
    and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    and not (g.grantee = 'authenticated' and g.table_name = 'saved_courses'
             and g.privilege_type in ('INSERT', 'DELETE'))
  union all
  -- Lo mismo, columna por columna, que no sale en la consulta de arriba. La única escritura
  -- por columnas prevista es la de la persona sobre sus propios datos de perfil.
  select distinct 'unexpected column write privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.grantee in ('anon', 'authenticated')
    and g.table_schema in ('public', 'private')
    and g.privilege_type in ('INSERT', 'UPDATE')
    and not (g.grantee = 'authenticated' and g.table_schema = 'public' and g.table_name = 'profiles'
             and g.privilege_type = 'UPDATE'
             and g.column_name in ('display_name', 'country_code', 'country_is_self_declared', 'locale'))
    and not (g.grantee = 'authenticated' and g.table_schema = 'public' and g.table_name = 'saved_courses'
             and g.privilege_type = 'INSERT')
  union all
  -- Del esquema privado, ni una columna, ni para leer.
  select distinct 'unexpected column privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.table_schema = 'private' and g.grantee in ('anon', 'authenticated')
  union all
  -- Nada concedido a todos: PUBLIC incluye al visitante y a cualquier rol que llegue después.
  select distinct 'privilege granted to PUBLIC', g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.grantee = 'PUBLIC' and g.table_schema in ('public', 'private')
  union all
  -- La clave secreta no toca tablas propias. Ningún rol de usuario toca el esquema privado.
  select 'unexpected privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  where (g.grantee = 'service_role' and g.table_schema in ('public', 'private'))
     or (g.grantee in ('anon', 'authenticated') and g.table_schema = 'private')
  union all
  -- Ningún rol de la aplicación puede editar ni borrar un libro.
  select 'ledger writable by ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  join ledgers l on l.table_schema = g.table_schema and l.table_name = g.table_name
  where g.grantee in (select r.rolname from app_roles r)
    and g.privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
  union all
  -- Ni editar una sola de sus columnas: el permiso por columna no sale en la consulta de arriba.
  select 'ledger column writable by ' || r.rolname, l.table_schema || '.' || l.table_name
  from ledgers l
  join pg_catalog.pg_namespace n on n.nspname = l.table_schema
  join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = l.table_name
  cross join app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, c.oid, 'UPDATE')
  union all
  -- El libro de latidos y cada partición: solo private.record_heartbeats() escribe, y nadie de
  -- la aplicación lee los latidos crudos (T-205).
  select 'watch ledger reachable by ' || r.rolname, 'public.' || c.relname
  from watch_tables w
  join pg_catalog.pg_class c on c.oid = w.oid
  cross join app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, c.oid, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- El seguro contra vaciar no pasa de la madre a las particiones: cada una lleva el suyo.
  select 'watch partition without truncate guard', 'public.' || c.relname
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.watch_events'::regclass
    and not exists (
      select 1 from pg_catalog.pg_trigger t
      where t.tgrelid = c.oid and t.tgname = 'ledger_no_truncate' and t.tgenabled <> 'D')
  union all
  -- El seguro de editar y borrar sí pasa de la madre, pero se puede apagar en una partición.
  select 'watch partition without update guard', 'public.' || c.relname
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.watch_events'::regclass
    and not exists (
      select 1 from pg_catalog.pg_trigger t
      where t.tgrelid = c.oid and t.tgname = 'ledger_no_update_delete' and t.tgenabled <> 'D')
  union all
  -- Sin partición por omisión: un tramo sin su mes no entra.
  select 'watch default partition', 'public.' || c.relname
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.watch_events'::regclass and c.relpartbound is not null
    and pg_catalog.pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
  union all
  -- La partición del mes que sigue ya existe: si pg_cron dejó de correr, se sabe antes de que
  -- los latidos empiecen a fallar.
  select 'watch partition missing for next month', 'public.watch_events_' || m.period
  from (select pg_catalog.to_char(
                 pg_catalog.date_trunc('month', pg_catalog.timezone(
                   coalesce(private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}', 'UTC'), pg_catalog.now()))
                 + interval '1 month', 'YYYYMM') as period) m
  where pg_catalog.to_regclass('public.watch_events_' || m.period) is null
  union all
  -- Los rechazos solo los escribe private.record_heartbeats() (T-205).
  select 'heartbeat rejections reachable by ' || r.rolname, 'private.heartbeat_rejection_counts'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'private.heartbeat_rejection_counts'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, 'private.heartbeat_rejection_counts'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- La marca de contraseña solo la cambia private.claim_account() (TRD 9.2).
  select 'password_reset_required writable by ' || r.rolname, 'public.profiles'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.profiles'::regclass, 'password_reset_required', 'UPDATE')
  union all
  -- Las capacidades solo se escriben con las funciones que cambian el equipo (T-105).
  select 'admin_capabilities writable by ' || r.rolname, 'public.admin_capabilities'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.admin_capabilities'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.admin_capabilities'::regclass, 'DELETE, TRUNCATE')
  union all
  -- Las invitaciones y las ataduras no las toca ningún rol de la aplicación, ni para leer.
  select 'team table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('private.admin_invitations'), ('private.admin_factors')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Las prácticas y los niveles solo los escriben las funciones de las listas (T-106).
  select 'catalog list writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.practices'), ('public.levels')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Lo publicado y lo que lo sostiene solo lo escriben las funciones de cargar y aprobar
  -- (T-107).
  select 'publication table writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.teachers'), ('public.published_teachers'), ('public.course_registry'),
                     ('public.video_assets'), ('public.published_courses'), ('public.published_modules'),
                     ('public.published_lessons')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Los hechos de la cuenta todavía no los escribe nadie de la aplicación (T-202). La
  -- escritura llega con quien la necesita: las suscripciones con T-302 y T-303, la cortesía
  -- con T-307, y cada una la abre aquí.
  select 'account facts table writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.subscriptions'), ('public.courtesy_grants')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- El orden de desempate de un maestro nunca sale de la base (RN-07).
  select 'teachers.tiebreak_rank readable by ' || r.rolname, 'public.teachers'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.teachers'::regclass, 'tiebreak_rank', 'SELECT')
  union all
  -- Lo que solo corre el dueño de la base, declarado sistema, no lo ejecuta nadie más. Las
  -- particiones de latidos las crea el dueño (la migración y pg_cron).
  select 'system function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.system_catalog_add(public.catalog_list, text)'),
                     ('private.system_add_teacher(text, text, text)'),
                     ('private.system_load_course(uuid, jsonb)'),
                     ('private.catalog_place(public.catalog_list, text)'),
                     ('private.create_watch_partition(public.period_id)'),
                     ('private.ensure_watch_partitions(integer, text)'),
                     ('private.half_points(integer, integer, integer, integer)'),
                     ('private.payout_thresholds(public.period_id)'),
                     ('private.rollup_pair(public.period_id, uuid, uuid, uuid, integer, integer)'),
                     ('private.rollup_window()'),
                     ('private.open_job_run(text, public.period_id, text)'),
                     ('private.close_job_run(uuid, text)'),
                     ('private.rollup_step(uuid, timestamptz, uuid, uuid, integer)'),
                     ('private.nightly_rollup(boolean, integer)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
  union all
  -- Las reproducciones solo las escriben sus funciones (T-204): abrir, latir y, con T-205, los
  -- latidos con medición.
  select 'playback table writable by ' || r.rolname, 'public.playback_sessions'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.playback_sessions'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.playback_sessions'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- El progreso solo lo escribe private.record_heartbeats() (T-206), y el servidor no lo lee
  -- entero: pregunta dónde se quedó quien actúa con private.lesson_position().
  select 'progress writable by ' || r.rolname, 'public.lesson_progress'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.lesson_progress'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.lesson_progress'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  select 'progress readable by ' || r.rolname, 'public.lesson_progress'
  from app_roles r
  where r.rolname <> 'authenticated'
    and pg_catalog.has_any_column_privilege(r.rolname::name, 'public.lesson_progress'::regclass, 'SELECT')
  union all
  -- La persona lee su avance, no los tramos ni de qué reproducción vino.
  select 'progress spans readable by authenticated', 'public.lesson_progress'
  where pg_catalog.has_column_privilege('authenticated', 'public.lesson_progress'::regclass, 'covered', 'SELECT')
     or pg_catalog.has_column_privilege('authenticated', 'public.lesson_progress'::regclass, 'last_playback_session_id', 'SELECT')
     or pg_catalog.has_column_privilege('authenticated', 'public.lesson_progress'::regclass, 'last_seq', 'SELECT')
  union all
  -- Lo que falta rehacer no lo toca nadie de la aplicación.
  select 'progress rebuilds reachable by ' || r.rolname, 'private.progress_rebuilds'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'private.progress_rebuilds'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, 'private.progress_rebuilds'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Dónde se quedó alguien lo pregunta solo el servidor, y fundir no lo ejecuta nadie.
  select 'progress function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.lesson_position(uuid)'),
                     ('private.merge_progress(public.playback_sessions, int4multirange, integer, integer, timestamptz)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
    and not (r.rolname = 'app_service' and f.signature = 'private.lesson_position(uuid)')
  union all
  -- La consolidación (T-207): las marcas, los días, el consolidado y las corridas no los toca
  -- ningún rol de la aplicación, ni para leer. Los escriben private.record_heartbeats() y la
  -- corrida; los días los leerá la persona cuando haya quien los pinte (T-505), y el
  -- consolidado, el maestro y finanzas por sus funciones (T-408, T-605).
  select 'consolidation table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('private.rollup_dirty'), ('public.practice_days'), ('public.watch_rollup'),
                     ('public.job_definitions'), ('public.job_runs')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
$$;
