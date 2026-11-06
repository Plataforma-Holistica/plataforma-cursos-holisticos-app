-- T-408, segunda solicitud · El avance de los alumnos de un curso (RF-612, RF-613, RN-15; PA-51; plan en ~/.claude/plans/t408-pa51-diseno.md,
-- aprobado por Sergio el 2026-11-05 con sus decisiones de ese día: la lista por alumno es semanal y las cifras diarias, todo guardado en la
-- consolidación; otro alias para PA-51; «a medio curso» es empezado y sin terminar; y cuenta todo el que avanzó alguna vez, sin el propio maestro ni
-- las cuentas borradas, con las suspendidas).
--
-- Cada noche, al final de la corrida, `private.course_progress_step` guarda por curso las tres cifras y lo terminado en cada lección, con corte en la
-- medianoche de hoy, y una vez por semana la lista por alumno, con corte en el lunes a las 00:00. El maestro lo lee con
-- `private.teacher_course_students`, sin decir quién es: la pantalla nunca lee el progreso en vivo. Por alumno salen el alias de PA-51, lo
-- terminado y el total, y nada más: ni identificadores ni fechas. El alias de PA-51 es otro que el de PA-47 (decisión 2 de Sergio): con el mismo, el
-- maestro deduciría quién no pagó un mes, quién tiene una cortesía o a quién se le excluyó el consumo.
--
-- De paso, el arreglo del error de la 110: el tramo de números del alias se calculaba una vez antes del ciclo, y crear miles de alias de una vez
-- gastaba cientos de miles de intentos que chocaban. La inserción es ahora una sola para los dos alias (`private.alias_insert`), y el tramo sube
-- dentro del ciclo.

-- ---------------------------------------------------------------------------------------
-- El alias de PA-51. Con las reglas del de PA-47: al azar, uno por alumno y maestro, de solo inserción, sin auditoría y sin permisos.

create table private.progress_aliases (
  teacher_id uuid not null references public.teachers (id),
  profile_id uuid not null references public.profiles (id),
  alias text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (teacher_id, profile_id),
  constraint progress_aliases_alias_uq unique (teacher_id, alias),
  constraint progress_aliases_alias_form check (alias ~ '^[A-Z][a-z]+ [1-9][0-9]{1,3}$')
);
comment on table private.progress_aliases is 'El alias de cada alumno con cada maestro en el avance (PA-51, RN-15), otro que el del reporte (student_aliases). Solo inserción, sin auditoría.';

alter table private.progress_aliases enable row level security;
revoke all on private.progress_aliases from public, anon, authenticated, service_role, app_service;
create trigger ledger_no_update_delete before update or delete on private.progress_aliases
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.progress_aliases
  for each statement execute function private.reject_mutation();

-- Un alias de PA-51: una de 40 aves, ríos y montañas de México, ninguna de las palabras de PA-47 (decisión mía sin confirmar: con las mismas,
-- «Ceiba 42» serían dos personas distintas en dos pantallas), y los tramos de números de `alias_candidate`.
create function private.progress_alias_candidate(p_try integer) returns text
language sql volatile set search_path = ''
as $$
  select (array['Colibri', 'Quetzal', 'Garza', 'Tucan', 'Halcon', 'Aguila', 'Gorrion', 'Jilguero', 'Cenzontle', 'Calandria',
                'Paloma', 'Tecolote', 'Pelicano', 'Flamenco', 'Cardenal', 'Golondrina', 'Zanate', 'Chachalaca', 'Guacamaya', 'Perico',
                'Usumacinta', 'Grijalva', 'Papaloapan', 'Balsas', 'Lerma', 'Panuco', 'Conchos', 'Bravo', 'Yaqui', 'Fuerte',
                'Santiago', 'Nazas', 'Popocatepetl', 'Iztaccihuatl', 'Citlaltepetl', 'Malinche', 'Tacana', 'Ajusco', 'Perote', 'Pinacate'])
           [1 + pg_catalog.floor(pg_catalog.random() * 40)::integer]
         || ' ' || case when p_try < 20 then 10 + pg_catalog.floor(pg_catalog.random() * 90)::integer
                        when p_try < 60 then 100 + pg_catalog.floor(pg_catalog.random() * 900)::integer
                        else 1000 + pg_catalog.floor(pg_catalog.random() * 9000)::integer end
$$;
revoke all on function private.progress_alias_candidate(integer) from public;

-- Los perfiles de la lista, sin repetir, que todavía no tienen alias de ese tipo con ese maestro.
create function private.alias_missing(p_kind text, p_teacher uuid, p_profiles uuid[]) returns table (profile_id uuid)
language sql stable set search_path = ''
as $$
  select distinct x.profile_id from pg_catalog.unnest(p_profiles) x (profile_id)
  where x.profile_id is not null
    and not (p_kind = 'student' and exists (select 1 from private.student_aliases a where a.teacher_id = p_teacher and a.profile_id = x.profile_id))
    and not (p_kind = 'progress' and exists (select 1 from private.progress_aliases a where a.teacher_id = p_teacher and a.profile_id = x.profile_id))
$$;
revoke all on function private.alias_missing(text, uuid, uuid[]) from public;

-- La inserción de los dos alias: que cada perfil de la lista tenga el suyo con el maestro. Bajo el candado del maestro y del tipo: dos lecturas a la
-- vez no chocan en el único, y PA-47 y PA-51 no se esperan entre sí. Si no cabe, falla entera: un alumno sin alias desaparecería. El tramo de
-- números sale de cuántos alias tiene ya el maestro, contando los que esta llamada va creando: con la mitad de un tramo ocupada se empieza en el
-- siguiente. Contesta cuántos creó.
create function private.alias_insert(p_kind text, p_teacher uuid, p_profiles uuid[]) returns integer
language plpgsql set search_path = ''
as $$
declare
  v_profile uuid;
  v_try integer;
  v_start integer;
  v_count integer;
  v_made integer := 0;
begin
  if p_kind is null or p_kind not in ('student', 'progress') then
    raise exception 'unknown alias kind: %', p_kind using errcode = '22023';
  end if;
  -- Si no falta ninguno, no se toma el candado: una lectura que no crea nada no espera a otra del mismo maestro.
  if not exists (select 1 from private.alias_missing(p_kind, p_teacher, p_profiles)) then
    return 0;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    case p_kind when 'student' then 'student_aliases:' else 'progress_aliases:' end || p_teacher::text, 0));
  if p_kind = 'student' then
    select pg_catalog.count(*)::integer into v_count from private.student_aliases a where a.teacher_id = p_teacher;
  else
    select pg_catalog.count(*)::integer into v_count from private.progress_aliases a where a.teacher_id = p_teacher;
  end if;
  -- Al azar: el tramo depende de cuántos se crearon antes, y en el mismo orden en las dos tablas los primeros alumnos recibirían números del
  -- mismo largo en PA-47 y en PA-51, que cruzaría en parte a los dos alias.
  for v_profile in
    select m.profile_id from private.alias_missing(p_kind, p_teacher, p_profiles) m order by pg_catalog.random()
  loop
    v_start := case when v_count >= 21600 then 60 when v_count >= 1800 then 20 else 0 end;
    v_try := v_start;
    loop
      if p_kind = 'student' then
        insert into private.student_aliases (teacher_id, profile_id, alias)
        values (p_teacher, v_profile, private.alias_candidate(v_try))
        on conflict (teacher_id, alias) do nothing;
      else
        insert into private.progress_aliases (teacher_id, profile_id, alias)
        values (p_teacher, v_profile, private.progress_alias_candidate(v_try))
        on conflict (teacher_id, alias) do nothing;
      end if;
      exit when found;
      v_try := v_try + 1;
      if v_try >= v_start + 400 then
        raise exception '% alias space exhausted', p_kind using errcode = 'P0001';
      end if;
    end loop;
    v_count := v_count + 1;
    v_made := v_made + 1;
  end loop;
  return v_made;
end
$$;
revoke all on function private.alias_insert(text, uuid, uuid[]) from public;

-- Los alias del reporte (PA-47), con la misma firma y lo mismo que hacían: los de los alumnos del maestro en el periodo.
create or replace function private.ensure_student_aliases(p_teacher uuid, p_period public.period_id) returns void
language plpgsql set search_path = ''
as $$
begin
  perform private.alias_insert('student', p_teacher, array(
    select s.profile_id from public.payout_shares s where s.period_id = p_period and s.teacher_id = p_teacher order by s.profile_id));
end
$$;

-- ---------------------------------------------------------------------------------------
-- El resumen. En `private`, sin ningún permiso para la aplicación ni claves foráneas (lo escribe solo el paso, como el estimado). No guarda
-- historia (decisión mía sin confirmar): cada noche reemplaza las cifras y cada lunes la lista, y se queda solo el corte anterior, para que una
-- lectura que empezó con él lo encuentre entero.

create table private.course_progress_figures (
  cut_at timestamptz not null,
  course_id uuid not null,
  started integer not null,            -- lo empezaron: alguna lección vigente empezada antes del corte
  in_progress integer not null,        -- van a medio curso: empezado y sin terminar (decisión 3 de Sergio)
  finished integer not null,           -- lo terminaron: todas las lecciones vigentes terminadas antes del corte
  primary key (cut_at, course_id),
  constraint course_progress_figures_consistent check (in_progress >= 0 and finished >= 0 and started = in_progress + finished)
);
comment on table private.course_progress_figures is 'Las tres cifras de cada curso con avance, al corte de cada noche (PA-51, RF-613). Sin fila, ceros.';

create table private.course_lesson_figures (
  cut_at timestamptz not null,
  course_id uuid not null,
  lesson_id uuid not null,
  position integer not null,           -- su lugar en el temario al corte
  finished integer not null,           -- cuántos la terminaron antes del corte
  primary key (cut_at, course_id, lesson_id),
  constraint course_lesson_figures_not_negative check (finished >= 0)
);
comment on table private.course_lesson_figures is 'Cada lección vigente al corte de cada noche, con cuántos la terminaron (PA-51, RF-613): la pantalla muestra las lecciones del corte, como las cifras.';

create table private.course_student_progress (
  cut_at timestamptz not null,
  course_id uuid not null,
  profile_id uuid not null,
  completed integer not null,          -- lecciones vigentes terminadas antes del corte
  total integer not null,              -- lecciones vigentes del curso al armar la lista
  primary key (cut_at, course_id, profile_id),
  constraint course_student_progress_range check (completed >= 0 and total >= 1 and completed <= total)
);
comment on table private.course_student_progress is 'La lista de cada curso por alumno, al lunes a las 00:00 (PA-51; decisión 1 de Sergio del 2026-11-05: semanal). La pantalla la muestra con el alias de PA-51.';

create table private.course_progress_state (
  id boolean primary key default true,
  daily_cut_at timestamptz,            -- el corte de las cifras que se leen
  daily_built_at timestamptz,          -- cuándo se guardaron: con más de 26 horas, el aviso
  weekly_cut_at timestamptz,           -- el lunes de la lista que se lee
  weekly_built_at timestamptz,
  failed_at timestamptz,               -- el último intento fallido, con su error
  error text,
  constraint course_progress_state_single check (id),
  constraint course_progress_state_daily check ((daily_cut_at is null) = (daily_built_at is null)),
  constraint course_progress_state_weekly check ((weekly_cut_at is null) = (weekly_built_at is null)),
  constraint course_progress_state_failed check ((failed_at is null) = (error is null) and pg_catalog.length(error) <= 300)
);
comment on table private.course_progress_state is 'Qué corte del avance de los alumnos se lee y el último intento fallido (PA-51). Una sola fila.';
insert into private.course_progress_state default values;

alter table private.course_progress_figures enable row level security;
alter table private.course_lesson_figures enable row level security;
alter table private.course_student_progress enable row level security;
alter table private.course_progress_state enable row level security;
revoke all on private.course_progress_figures, private.course_lesson_figures, private.course_student_progress, private.course_progress_state
  from public, anon, authenticated, service_role, app_service;

-- ---------------------------------------------------------------------------------------
-- El paso.

-- Lo que cuenta a un corte: cada fila de progreso en una lección vigente, empezada antes del corte, y si se terminó antes del corte. Sin el propio
-- maestro (su vista previa no es la de un alumno) ni las cuentas borradas; las suspendidas se quedan, porque quitarlas dejaría ver la suspensión
-- (decisión 4 de Sergio). Un lote atrasado puede escribir una hora anterior a la de llegada: cuenta como se lee al correr el paso.
create function private.course_progress_rows(p_cut timestamptz) returns table (course_id uuid, lesson_id uuid, profile_id uuid, done boolean)
language sql stable set search_path = ''
as $$
  -- El curso, el de la lección: de ella salen también los totales.
  select l.course_id, lp.lesson_id, lp.profile_id, coalesce(lp.completed_at <= p_cut, false)
  from public.lesson_progress lp
  join public.published_lessons l on l.id = lp.lesson_id and l.is_current
  join public.teachers t on t.id = l.teacher_id
  join public.profiles p on p.id = lp.profile_id
  where lp.first_watched_at <= p_cut
    and p.status <> 'deleted'
    and t.profile_id is distinct from lp.profile_id
$$;
revoke all on function private.course_progress_rows(timestamptz) from public;

-- Lo llama la corrida de cada noche al terminar (no un recálculo pedido), con su propio `commit` y en su bloque. El reloj es el de la corrida; una
-- prueba le da otro. Las cifras se cortan en la medianoche de hoy y la lista en el lunes a las 00:00 (`ZONA_HORARIA_PERIODO`): la lista se arma en
-- la primera noche después de su lunes y no otra vez esa semana. Todo va en un bloque que atrapa también `query_canceled`: si algo falla, el resumen
-- anterior se queda entero, y el estado anota la falla. Contesta:
--   {outcome: 'built', daily_cut_at, weekly_cut_at, weekly_rebuilt}
--   {outcome: 'failed', error}
create function private.course_progress_step(p_now timestamptz default null) returns jsonb
language plpgsql volatile set search_path = '' set lock_timeout = '30s'
as $$
declare
  v_now timestamptz := coalesce(p_now, pg_catalog.clock_timestamp());
  v_zone text;
  v_day timestamptz;
  v_week timestamptz;
  v_state private.course_progress_state;
  v_rebuild boolean := false;
  v_error text;
begin
  begin
    v_zone := private.period_zone();
    v_day := pg_catalog.date_trunc('day', v_now at time zone v_zone) at time zone v_zone;
    v_week := pg_catalog.date_trunc('week', v_now at time zone v_zone) at time zone v_zone;
    -- Dos pasos a la vez van uno tras otro.
    select * into v_state from private.course_progress_state s for update;
    v_rebuild := v_state.weekly_cut_at is null or v_state.weekly_cut_at < v_week;

    delete from private.course_progress_figures f where f.cut_at = v_day or f.cut_at < coalesce(v_state.daily_cut_at, v_day);
    delete from private.course_lesson_figures f where f.cut_at = v_day or f.cut_at < coalesce(v_state.daily_cut_at, v_day);
    with progress as (select * from private.course_progress_rows(v_day)),
    -- Todas las lecciones vigentes, también las que nadie ha visto: la pantalla muestra las del corte, no las de ahora.
    lessons as (
      insert into private.course_lesson_figures (cut_at, course_id, lesson_id, position, finished)
      select v_day, l.course_id, l.id, l.position, coalesce(f.finished, 0)
      from public.published_lessons l
      left join (select x.lesson_id, (pg_catalog.count(*) filter (where x.done))::integer as finished from progress x group by x.lesson_id) f
        on f.lesson_id = l.id
      where l.is_current),
    totals as (
      select l.course_id, pg_catalog.count(*)::integer as n from public.published_lessons l where l.is_current group by l.course_id),
    students as (
      select x.course_id, x.profile_id, (pg_catalog.count(*) filter (where x.done))::integer as done
      from progress x
      group by x.course_id, x.profile_id)
    insert into private.course_progress_figures (cut_at, course_id, started, in_progress, finished)
    select v_day, s.course_id, pg_catalog.count(*)::integer, (pg_catalog.count(*) filter (where s.done < t.n))::integer,
           (pg_catalog.count(*) filter (where s.done = t.n))::integer
    from students s
    join totals t on t.course_id = s.course_id
    group by s.course_id;

    if v_rebuild then
      delete from private.course_student_progress c where c.cut_at = v_week or c.cut_at < coalesce(v_state.weekly_cut_at, v_week);
      insert into private.course_student_progress (cut_at, course_id, profile_id, completed, total)
      select v_week, s.course_id, s.profile_id, s.done, t.n
      from (select x.course_id, x.profile_id, (pg_catalog.count(*) filter (where x.done))::integer as done
            from private.course_progress_rows(v_week) x
            group by x.course_id, x.profile_id) s
      join (select l.course_id, pg_catalog.count(*)::integer as n from public.published_lessons l where l.is_current group by l.course_id) t
        on t.course_id = s.course_id;
    end if;

    update private.course_progress_state s
    set daily_cut_at = v_day, daily_built_at = pg_catalog.clock_timestamp(),
        weekly_cut_at = case when v_rebuild then v_week else s.weekly_cut_at end,
        weekly_built_at = case when v_rebuild then pg_catalog.clock_timestamp() else s.weekly_built_at end;
  exception when query_canceled or others then
    v_error := sqlstate || ': ' || pg_catalog.left(sqlerrm, 200);
  end;

  if v_error is not null then
    update private.course_progress_state s set failed_at = pg_catalog.clock_timestamp(), error = v_error;
    return pg_catalog.jsonb_build_object('outcome', 'failed', 'error', v_error);
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'built', 'daily_cut_at', v_day,
                                       'weekly_cut_at', case when v_rebuild then v_week else v_state.weekly_cut_at end, 'weekly_rebuilt', v_rebuild);
end
$$;
revoke all on function private.course_progress_step(timestamptz) from public;

-- ---------------------------------------------------------------------------------------
-- La corrida de cada noche (t408_estimado), con el avance de los alumnos al final: solo en la corrida de la noche, sin periodo (un recálculo pedido
-- trae uno), después de anotar la corrida del paso a cierre, con su propio `commit` y en su bloque, que atrapa también `query_canceled`: una
-- cancelación del paso cortaría la noche entera. Lo que falle lo anotan el estado del paso y los detalles de esa corrida.
create or replace procedure private.nightly_rollup(p_full boolean default false, p_period integer default null)
language plpgsql
as $$
declare
  v_estimate_error text;
  v_progress_error text;
  v_progress jsonb;
  v_transition_run uuid;
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
            v_error)
    returning id into v_transition_run;
    commit;
    -- El avance de los alumnos (T-408, PA-51), con su `commit`, después de anotar la corrida del paso a cierre: si la base muere a la mitad, esa
    -- corrida ya está. Lo que falle, dentro del paso o fuera de su bloque, se suma a sus detalles (`course_progress_failed`), sin cambiar su
    -- estado, y va al registro de la base.
    v_progress_error := null;
    begin
      v_progress := private.course_progress_step();
      if v_progress ->> 'outcome' = 'failed' then
        v_progress_error := v_progress ->> 'error';
      end if;
    exception when query_canceled or others then
      v_progress_error := sqlstate || ': ' || pg_catalog.left(sqlerrm, 200);
    end;
    if v_progress_error is not null then
      update public.job_runs j set details = j.details || pg_catalog.jsonb_build_object('course_progress_failed', v_progress_error)
      where j.id = v_transition_run;
      raise warning 'course progress failed: %', v_progress_error;
    end if;
    commit;
  end if;
  perform pg_catalog.set_config('search_path', v_path, false);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Lo que lee el maestro (PA-51).

-- El avance de un curso suyo que se publicó alguna vez, con una lista cerrada de claves:
--   title            el título del curso
--   figures          las tres cifras al corte de la noche (`cut_at`); nulo antes de la primera noche
--   lessons          cada lección vigente en el orden del temario, con cuántos la terminaron al corte (0 si no estaba; nulo sin corte)
--   students         una página de 50 de la lista del lunes: alias de PA-51, terminadas y total. Por avance (y entre iguales por alias) o por alias
--   page, pages, total_students, list_cut_at   la página que se da (la pedida, dentro de las que hay), cuántas, cuántos y el lunes de la lista
--   stale            sin resumen, o con uno guardado hace más de 26 horas
-- Otro curso contesta igual que uno que no existe. Antes de leer crea los alias que falten de toda la lista, no solo de la página, bajo el candado
-- del maestro: es volátil. Lee el corte que dice el estado al empezar, y el paso guarda el anterior: una noche que confirma a la mitad no la parte.
create function private.teacher_course_students(p_course uuid, p_order text, p_page integer) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.actor_teacher_id();
  v_title text;
  v_state private.course_progress_state;
  v_total integer;
  v_pages integer;
  v_page integer;
begin
  if v_teacher is null then
    return '{"outcome": "not_teacher"}'::jsonb;
  end if;
  if p_order is null or p_order not in ('progress', 'alias') then
    raise exception 'unknown order: %', p_order using errcode = '22023';
  end if;
  select c.title into v_title
  from public.course_registry r
  join public.published_courses c on c.course_id = r.course_id
  where r.course_id = p_course and r.teacher_id = v_teacher and r.first_published_at is not null;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  select * into v_state from private.course_progress_state;
  if v_state.weekly_cut_at is not null then
    perform private.alias_insert('progress', v_teacher, array(
      select s.profile_id from private.course_student_progress s
      join public.profiles p on p.id = s.profile_id and p.status <> 'deleted'
      where s.cut_at = v_state.weekly_cut_at and s.course_id = p_course));
  end if;
  select pg_catalog.count(*)::integer into v_total
  from private.course_student_progress s
  join public.profiles p on p.id = s.profile_id and p.status <> 'deleted'
  where s.cut_at = v_state.weekly_cut_at and s.course_id = p_course;
  v_pages := greatest(1, (v_total + 49) / 50);
  v_page := least(greatest(coalesce(p_page, 1), 1), v_pages);
  return pg_catalog.jsonb_build_object(
    'outcome', 'ok',
    'title', v_title,
    'figures', case when v_state.daily_cut_at is not null then (
      select pg_catalog.jsonb_build_object('started', coalesce(f.started, 0), 'in_progress', coalesce(f.in_progress, 0),
                                           'finished', coalesce(f.finished, 0), 'cut_at', v_state.daily_cut_at)
      from (select 1) one
      left join private.course_progress_figures f on f.cut_at = v_state.daily_cut_at and f.course_id = p_course) end,
    -- Las lecciones del corte, como las cifras; antes de la primera noche, las de ahora, sin cifra.
    'lessons', coalesce(case when v_state.daily_cut_at is not null then (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('title', l.title, 'finished', g.finished) order by g.position)
      from private.course_lesson_figures g
      join public.published_lessons l on l.id = g.lesson_id
      where g.cut_at = v_state.daily_cut_at and g.course_id = p_course)
    else (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('title', l.title, 'finished', null) order by l.position)
      from public.published_lessons l
      where l.course_id = p_course and l.is_current) end, '[]'::jsonb),
    'students', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('alias', x.alias, 'completed', x.completed, 'total', x.total) order by x.n)
      from (select a.alias, s.completed, s.total,
                   pg_catalog.row_number() over (order by case when p_order = 'progress' then s.completed end desc nulls last, a.alias) as n
            from private.course_student_progress s
            join private.progress_aliases a on a.teacher_id = v_teacher and a.profile_id = s.profile_id
            -- Una cuenta que se borró después del lunes sale de la lista al leer (decisión mía sin confirmar).
            join public.profiles p on p.id = s.profile_id and p.status <> 'deleted'
            where s.cut_at = v_state.weekly_cut_at and s.course_id = p_course
            order by n
            offset (v_page - 1) * 50
            limit 50) x), '[]'::jsonb),
    'page', v_page,
    'pages', v_pages,
    'total_students', v_total,
    'list_cut_at', v_state.weekly_cut_at,
    'stale', v_state.daily_built_at is null or v_state.daily_built_at < pg_catalog.now() - interval '26 hours');
end
$$;
revoke all on function private.teacher_course_students(uuid, text, integer) from public;
grant execute on function private.teacher_course_students(uuid, text, integer) to app_service;

-- ---------------------------------------------------------------------------------------
-- El vigilante de los alias (t604_reporte), con los de PA-51 y la regla que faltaba: toda función que nombre una de las dos tablas de alias está en
-- una lista cerrada, y ninguna vista las lee.

create or replace function private.schema_violations_teacher_reports()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  alias_tables (table_name, label) as (
    values ('private.student_aliases', 'student aliases'), ('private.progress_aliases', 'progress aliases')),
  doors (name, signature) as (
    values ('payouts_mine', 'private.payouts_mine()'), ('payout_report_mine', 'private.payout_report_mine(public.period_id)'),
           ('payout_report_csv_mine', 'private.payout_report_csv_mine(public.period_id)')),
  helpers (name, signature) as (
    values ('alias_candidate', 'private.alias_candidate(integer)'), ('progress_alias_candidate', 'private.progress_alias_candidate(integer)'),
           ('alias_insert', 'private.alias_insert(text, uuid, uuid[])'), ('alias_missing', 'private.alias_missing(text, uuid, uuid[])'),
           ('ensure_student_aliases', 'private.ensure_student_aliases(uuid, public.period_id)'),
           ('payout_teacher_status', 'private.payout_teacher_status(public.payouts)'),
           ('payout_mine_row', 'private.payout_mine_row(public.period_id, public.payouts)'),
           ('teacher_first_period', 'private.teacher_first_period(uuid)'),
           ('payout_report_students', 'private.payout_report_students(uuid, public.period_id)'),
           ('csv_half_points', 'private.csv_half_points(integer)')),
  -- Las únicas funciones que nombran cada tabla de alias. Una nueva es una puerta nueva, aunque se llame igual en otro esquema o con otra firma; y
  -- la lista es por tabla, porque la lectura de PA-51 que nombrara los alias de PA-47 (o el reporte los de PA-51) los cruzaría.
  alias_known (table_name, oid) as (
    select k.table_name, pg_catalog.to_regprocedure(k.signature)::oid
    from (values ('student_aliases', 'private.alias_insert(text, uuid, uuid[])'), ('student_aliases', 'private.alias_missing(text, uuid, uuid[])'),
                 ('student_aliases', 'private.payout_report_students(uuid, public.period_id)'),
                 ('student_aliases', 'private.schema_violations_teacher_reports()'), ('student_aliases', 'private.schema_violations_ledgers()'),
                 ('progress_aliases', 'private.alias_insert(text, uuid, uuid[])'), ('progress_aliases', 'private.alias_missing(text, uuid, uuid[])'),
                 ('progress_aliases', 'private.teacher_course_students(uuid, text, integer)'),
                 ('progress_aliases', 'private.schema_violations_teacher_reports()')) k (table_name, signature))
  select t.label || ' privilege for ' || r.rolname, t.table_name
  from alias_tables t cross join app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'select, insert, update, delete, truncate, references, trigger')
     or pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'select, insert, update, references')
  union all
  select t.label || ' without row security', t.table_name
  from alias_tables t
  where not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = t.table_name::regclass)
  union all
  select t.label || ' audited', t.table_name
  from alias_tables t
  where exists (select 1 from pg_catalog.pg_trigger tg where tg.tgrelid = t.table_name::regclass
                  and pg_catalog.pg_get_triggerdef(tg.oid) like '%audit_row_change%')
  union all
  select 'teacher report door missing or wrong: ' || d.name, d.name
  from doors d
  where pg_catalog.to_regprocedure(d.signature) is null
     or not coalesce((select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(d.signature)), false)
     or not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(d.signature)) like '%actor_teacher_id()%', false)
     or not pg_catalog.has_function_privilege('app_service', d.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', d.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', d.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', d.signature, 'execute')
  union all
  select 'teacher report helper reachable: ' || h.name, h.name
  from helpers h
  where pg_catalog.to_regprocedure(h.signature) is null
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(h.signature))
     or pg_catalog.has_function_privilege('app_service', h.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', h.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', h.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', h.signature, 'execute')
  union all
  select 'teacher report trigger missing: ' || x.name, t.table_name
  from alias_tables t
  cross join (values ('ledger_no_update_delete'), ('ledger_no_truncate')) x (name)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = t.table_name::regclass and tg.tgname = x.name
      and tg.tgenabled in ('O', 'A') and pg_catalog.pg_get_triggerdef(tg.oid) like '%reject_mutation%')
  union all
  select 'alias function not in the list: ' || x.table_name, n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  cross join (values ('student_aliases'), ('progress_aliases')) x (table_name)
  where n.nspname in ('public', 'private')
    and (coalesce(p.prosrc, '') || coalesce(pg_catalog.pg_get_function_sqlbody(p.oid), '')) ~ ('\m' || x.table_name || '\M')
    and p.oid not in (select k.oid from alias_known k where k.table_name = x.table_name and k.oid is not null)
  union all
  -- Sin nombrar la tabla, una función llegaría a los alias de la otra pantalla por una ayudante: la lectura de PA-51 no llama a las de PA-47 (ni pide
  -- alias de pagos), y las de PA-47 no llaman a la de PA-51 (ni piden alias del avance).
  select 'aliases crossed through a helper', d.signature
  from (values ('private.teacher_course_students(uuid, text, integer)', '(payout_report_students|ensure_student_aliases|''student'')'),
               ('private.payout_report_mine(public.period_id)', '(teacher_course_students|''progress'')'),
               ('private.payout_report_csv_mine(public.period_id)', '(teacher_course_students|''progress'')'),
               ('private.payout_report_students(uuid, public.period_id)', '(teacher_course_students|''progress'')'),
               ('private.ensure_student_aliases(uuid, public.period_id)', '(teacher_course_students|''progress'')')) d (signature, pattern)
  where pg_catalog.to_regprocedure(d.signature) is not null
    and pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(d.signature)) ~ d.pattern
  union all
  -- Una vista corre como su dueño: saltaría los permisos (como en el área `tax`).
  select 'aliases read by a view', vn.nspname || '.' || c.relname
  from pg_catalog.pg_depend d
  join pg_catalog.pg_rewrite w on w.oid = d.objid
  join pg_catalog.pg_class c on c.oid = w.ev_class
  join pg_catalog.pg_namespace vn on vn.oid = c.relnamespace
  where d.classid = 'pg_catalog.pg_rewrite'::regclass and d.refclassid = 'pg_catalog.pg_class'::regclass
    and d.refobjid in (select t.table_name::regclass::oid from alias_tables t)
$$;

-- ---------------------------------------------------------------------------------------
-- El vigilante del avance (área nueva del carril A): las tablas del resumen sin permisos, con seguridad por fila y sin vistas; toda función que las
-- nombre, en una lista cerrada; la lectura, la única puerta; el paso y su ayudante, del sistema; y la corrida de cada noche llama al paso, en un
-- bloque que atrapa también la cancelación.

create function private.schema_violations_course_progress()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  progress_tables (table_name) as (
    values ('private.course_progress_figures'), ('private.course_lesson_figures'), ('private.course_student_progress'),
           ('private.course_progress_state')),
  progress_known (oid) as (
    select pg_catalog.to_regprocedure(k.signature)::oid
    from (values ('private.course_progress_step(timestamptz)'), ('private.teacher_course_students(uuid, text, integer)'),
                 ('private.schema_violations_course_progress()')) k (signature)),
  system_functions (signature) as (
    values ('private.course_progress_step(timestamptz)'), ('private.course_progress_rows(timestamptz)'))
  select 'course progress table reachable by ' || r.rolname, t.table_name
  from app_roles r cross join progress_tables t
  where pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'select, insert, update, delete, truncate, references, trigger')
     or pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'select, insert, update, references')
  union all
  select 'course progress table without row security', t.table_name
  from progress_tables t
  where not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = t.table_name::regclass)
  union all
  -- Ningún disparador: uno de auditoría copiaría a cada alumno y su avance a donde lo lee otro.
  select 'course progress table with a trigger', t.table_name
  from progress_tables t
  where exists (select 1 from pg_catalog.pg_trigger tg where tg.tgrelid = t.table_name::regclass and not tg.tgisinternal)
  union all
  select 'teacher course students door missing or wrong', 'private.teacher_course_students(uuid, text, integer)'
  where pg_catalog.to_regprocedure('private.teacher_course_students(uuid, text, integer)') is null
     or not coalesce((select p.prosecdef and p.provolatile = 'v' and p.proconfig @> array['search_path=""']
                      from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('private.teacher_course_students(uuid, text, integer)')), false)
     or not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.teacher_course_students(uuid, text, integer)'))
                     like '%actor_teacher_id()%', false)
     or not pg_catalog.has_function_privilege('app_service', 'private.teacher_course_students(uuid, text, integer)', 'execute')
     or pg_catalog.has_function_privilege('authenticated', 'private.teacher_course_students(uuid, text, integer)', 'execute')
     or pg_catalog.has_function_privilege('anon', 'private.teacher_course_students(uuid, text, integer)', 'execute')
     or pg_catalog.has_function_privilege('service_role', 'private.teacher_course_students(uuid, text, integer)', 'execute')
  union all
  select 'course progress system function reachable or wrong', f.signature
  from system_functions f
  where pg_catalog.to_regprocedure(f.signature) is null
     or (select p.prosecdef or not coalesce(p.proconfig, '{}') @> array['search_path=""']
         from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(f.signature))
     or exists (select 1 from app_roles r where pg_catalog.has_function_privilege(r.rolname::name, f.signature, 'execute'))
  union all
  select 'course progress function not in the list', n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and (coalesce(p.prosrc, '') || coalesce(pg_catalog.pg_get_function_sqlbody(p.oid), ''))
        ~ '\m(course_progress_figures|course_lesson_figures|course_student_progress|course_progress_state)\M'
    and p.oid not in (select k.oid from progress_known k where k.oid is not null)
  union all
  -- Una vista corre como su dueño: saltaría los permisos.
  select 'course progress table read by a view', vn.nspname || '.' || c.relname
  from pg_catalog.pg_depend d
  join pg_catalog.pg_rewrite w on w.oid = d.objid
  join pg_catalog.pg_class c on c.oid = w.ev_class
  join pg_catalog.pg_namespace vn on vn.oid = c.relnamespace
  where d.classid = 'pg_catalog.pg_rewrite'::regclass and d.refclassid = 'pg_catalog.pg_class'::regclass
    and d.refobjid in (select t.table_name::regclass::oid from progress_tables t)
  union all
  select 'nightly rollup does not build the course progress, or a cancellation stops it', 'private.nightly_rollup(boolean, integer)'
  where pg_catalog.pg_get_functiondef('private.nightly_rollup(boolean, integer)'::regprocedure)
        not like '%:= private.course_progress_step();%exception when query_canceled or others then%'
$$;
revoke all on function private.schema_violations_course_progress() from public;
