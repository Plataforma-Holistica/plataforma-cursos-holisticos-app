-- T-611 · La selección de pares del recálculo completo, por índice (RNF-06, RNF-07; 05 §8.2 y §14.4).
-- Plan con revisión independiente, aprobado por Sergio el 2026-10-26.
--
-- El modo completo de `private.rollup_step()` (el recálculo de RF-408 y la primera noche en cierre)
-- elegía cada paso con la unión entera de los latidos y el consolidado del periodo, ordenada y cortada
-- después del cursor. A `HORIZONTE_ESCALA` (9.36 M latidos, unos 260 000 pares) cada paso costaba
-- 1.6 s y el recálculo, unas 2.3 h solo en elegir: no cabía en los 30 min del 05 §14.4. Ahora cada
-- rama corta por su índice desde el cursor (`watch_events_rollup_idx` y la llave del consolidado) y
-- la unión de los dos cortes se vuelve a cortar: unos 3 ms por paso con los latidos como llegan.
--
-- Da los mismos pares en el mismo orden: los primeros n de la unión están siempre entre los primeros
-- n de cada rama, siempre que la de los latidos no repita un par (por eso su `distinct`: sin él, un
-- par con muchos latidos llena el corte y el cursor salta los que siguen). La compara contra la
-- selección de antes la prueba 49.
--
-- Va en su propia función para fijarle el plan: con un plan genérico (el que Postgres guarda tras
-- unas llamadas con los mismos parámetros) el límite se estima como una parte de la tabla y vuelve el
-- recorrido de la partición entera, más de 1 s por paso. `plan_cache_mode` solo vale dentro de ella:
-- `rollup_pair`, que corre 260 000 veces, sigue con el plan que Postgres elija.

-- ---------------------------------------------------------------------------------------
-- Los siguientes pares del periodo después del cursor, en orden. Sin cursor (o sin el alumno del
-- cursor), desde el principio, como antes: la comparación de filas con una lección nula deja pasar
-- solo a los alumnos que siguen.

create function private.rollup_full_pairs(p_period public.period_id, p_after_profile uuid, p_after_lesson uuid,
                                          p_limit integer)
returns table (profile_id uuid, lesson_id uuid)
language plpgsql stable
set search_path = ''
set plan_cache_mode = force_custom_plan
as $$
begin
  if p_after_profile is null then
    return query
    select p.profile_id, p.lesson_id
    from ((select distinct e.profile_id, e.lesson_id from public.watch_events e
           where e.period_id = p_period
           order by e.profile_id, e.lesson_id limit p_limit)
          union
          (select w.profile_id, w.lesson_id from public.watch_rollup w
           where w.period_id = p_period
           order by w.profile_id, w.lesson_id limit p_limit)) p
    order by p.profile_id, p.lesson_id limit p_limit;
  else
    return query
    select p.profile_id, p.lesson_id
    from ((select distinct e.profile_id, e.lesson_id from public.watch_events e
           where e.period_id = p_period and (e.profile_id, e.lesson_id) > (p_after_profile, p_after_lesson)
           order by e.profile_id, e.lesson_id limit p_limit)
          union
          (select w.profile_id, w.lesson_id from public.watch_rollup w
           where w.period_id = p_period and (w.profile_id, w.lesson_id) > (p_after_profile, p_after_lesson)
           order by w.profile_id, w.lesson_id limit p_limit)) p
    order by p.profile_id, p.lesson_id limit p_limit;
  end if;
end
$$;
revoke all on function private.rollup_full_pairs(public.period_id, uuid, uuid, integer) from public;

-- ---------------------------------------------------------------------------------------
-- Un paso de la corrida (t602_congelado): igual, salvo la selección del modo completo.

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
    -- Por el índice, desde el cursor (T-611): antes armaba la unión entera del periodo en cada paso.
    select pg_catalog.array_agg(m.profile_id order by m.ord), pg_catalog.array_agg(m.lesson_id order by m.ord)
    into v_profiles, v_lessons
    from private.rollup_full_pairs(v_period, p_after_profile, p_after_lesson, p_limit)
      with ordinality as m (profile_id, lesson_id, ord);
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

-- ---------------------------------------------------------------------------------------
-- El vigilante: el área de la consolidación (w0_vigilante_por_areas), con la función nueva.

create or replace function private.schema_violations_rollup()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service'))
  -- Las marcas, los días, el consolidado y las corridas no los toca ningún rol de la
  -- aplicación, ni para leer. Los escriben private.record_heartbeats() y la corrida; los días
  -- los leerá la persona cuando haya quien los pinte (T-505), y el consolidado, el maestro y
  -- finanzas por sus funciones (T-408, T-605).
  select 'consolidation table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('private.rollup_dirty'), ('public.practice_days'), ('public.watch_rollup'),
                     ('public.job_definitions'), ('public.job_runs')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- La consolidación la corre solo el dueño de la base (pg_cron, y db:rollup en local).
  select 'system function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.half_points(integer, integer, integer, integer)'),
                     ('private.payout_thresholds(public.period_id)'),
                     ('private.rollup_pair(public.period_id, uuid, uuid, uuid, integer, integer)'),
                     ('private.rollup_window()'),
                     ('private.open_job_run(text, public.period_id, text)'),
                     ('private.close_job_run(uuid, text)'),
                     ('private.rollup_step(uuid, timestamptz, uuid, uuid, integer)'),
                     ('private.rollup_full_pairs(public.period_id, uuid, uuid, integer)'),
                     ('private.nightly_rollup(boolean, integer)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
$$;
