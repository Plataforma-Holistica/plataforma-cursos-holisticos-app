-- T-407 · El reparto (RF-502, RN-03, RN-05, RN-06, RN-07, RNF-04; 01 §6.2 y §6.3, 05 §8.4 y §8.7).
-- Decisiones de Sergio del 2026-10-23:
--   · el reparto vive en la base: lo usan la alerta de cada noche, el estimado del maestro (T-408)
--     y el cierre (T-602), que corren en la base con `pg_cron`, sin TypeScript de por medio (como
--     los puntos en T-207 y el libro de ingresos en T-301). No hay `computePayout` en el dominio;
--     un oráculo aparte, solo en las pruebas, lo compara en miles de periodos al azar;
--   · el bote de una cuenta suspendida por fraude va al bote sin consumo: su consumo ya no está
--     (T-208) y su base sigue, así que se reparte como el de quien no vio nada (RN-06);
--   · alcance: el cálculo, su entrada y la alerta del bote sin consumo (RF-406), que T-208 dejó
--     esperando. El porcentaje sale de `BOTE_PCT_BASE` hasta que T-601 traiga los tramos (RN-13);
--     el estimado va con T-408, y el bono y el pago mínimo con T-603.
--
-- La regla, en enteros:
--   · RN-03: el bote de cada alumno es `piso(base × porcentaje ÷ 10 000)`, con la base sumada de
--     sus partes del periodo;
--   · RN-05: el bote de cada alumno con puntos se reparte entre sus maestros por sus medios puntos;
--     los puntos de quien no tiene base no cuentan;
--   · RN-06: el sin consumo (los botes de los alumnos sin puntos, más lo que llegó del periodo
--     anterior) se reparte en proporción a lo asignado a cada maestro. Si lo asignado es cero, no hay
--     proporción que seguir y todo pasa al periodo siguiente;
--   · RN-07: cada división, hacia abajo, y los centavos que sobran uno por uno a los de mayor
--     residuo; en empate, al maestro de `tiebreak_rank` menor. En división entera (`div`, `mod`):
--     una división en `numeric` se redondea antes del piso y, con montos grandes, se equivoca.
--
-- Lo que cambia respecto del esquema escrito (05 §8.4): `close_input_students` y
-- `close_input_points` no son `security definer` ni las ejecuta el servidor (nadie de la aplicación
-- calcula el reparto); y la salida del cálculo son líneas con su base y sus medios puntos, para
-- que el cierre (T-602) escriba lo que devuelve sin volver a cruzar la entrada.

-- ---------------------------------------------------------------------------------------
-- Los tipos. En `private`, como las funciones que los usan: nadie de la aplicación los ve.

create type private.payout_base as (profile_id uuid, base_cents bigint);
create type private.payout_points as (profile_id uuid, teacher_id uuid, tiebreak_rank bigint, half_points integer);
-- El bote de un alumno, su parte a un maestro, la parte de un maestro en el sin consumo, y lo que
-- pasa al periodo siguiente.
create type private.payout_line_kind as enum ('student_pool', 'share', 'unconsumed_share', 'carried_over');
create type private.payout_line as (
  kind private.payout_line_kind,
  profile_id uuid,        -- el alumno (bote y parte)
  teacher_id uuid,        -- el maestro (parte y sin consumo)
  tiebreak_rank bigint,   -- el orden del maestro, para los empates (RN-07)
  cents bigint,
  base_cents bigint,      -- la base del alumno (en su bote)
  half_points integer     -- sus medios puntos: todos en su bote, los de ese maestro en la parte
);

-- ---------------------------------------------------------------------------------------
-- RN-07: la única rutina de redondeo. Reparte un monto entre partes con peso: cada una hacia
-- abajo, y los centavos que sobran uno por uno a las de mayor residuo; en empate, a la de orden
-- menor. Devuelve las partes en el orden en que llegaron. Un peso cero no entra (quien llama lo
-- deja fuera), y sin partes no devuelve nada.

create function private.allocate_largest_remainder(p_total bigint, p_ids uuid[], p_weights bigint[], p_ranks bigint[])
returns table (id uuid, cents bigint)
language plpgsql immutable set search_path = ''
as $$
declare
  v_n integer := pg_catalog.cardinality(p_ids);
begin
  if p_total is null or p_total < 0 then
    raise exception 'allocation total must be zero or more' using errcode = '22023';
  end if;
  if p_ids is null or p_weights is null or p_ranks is null then
    raise exception 'allocation needs ids, weights and ranks' using errcode = '22023';
  end if;
  -- Con arreglos de distinto largo, `rows from` rellena con nulos: los rechaza la revisión de abajo.
  if exists (select 1 from rows from (pg_catalog.unnest(p_ids), pg_catalog.unnest(p_weights), pg_catalog.unnest(p_ranks)) as x (i, w, r) where x.i is null or x.w is null or x.r is null or x.w <= 0)
     or (select pg_catalog.count(distinct x.i) from pg_catalog.unnest(p_ids) as x (i)) <> v_n
     or (select pg_catalog.count(distinct x.r) from pg_catalog.unnest(p_ranks) as x (r)) <> v_n then
    raise exception 'allocation parts need a unique id, a positive weight and a unique rank' using errcode = '22023';
  end if;
  return query
  with parts as (
    select x.i, x.w::numeric as w, x.r, x.o from rows from (pg_catalog.unnest(p_ids), pg_catalog.unnest(p_weights), pg_catalog.unnest(p_ranks)) with ordinality as x (i, w, r, o)),
  exact as (
    select p.i, p.r, p.o,
           pg_catalog.div(p_total::numeric * p.w, s.total) as floor_cents,
           pg_catalog.mod(p_total::numeric * p.w, s.total) as rest
    from parts p cross join (select pg_catalog.sum(parts.w) as total from parts) s),
  placed as (
    select e.*, pg_catalog.row_number() over (order by e.rest desc, e.r) as place,
           p_total - pg_catalog.sum(e.floor_cents) over () as left_over
    from exact e)
  select placed.i, (placed.floor_cents + case when placed.place <= placed.left_over then 1 else 0 end)::bigint
  from placed order by placed.o;
end
$$;
revoke all on function private.allocate_largest_remainder(bigint, uuid[], bigint[], bigint[]) from public;

-- ---------------------------------------------------------------------------------------
-- RNF-04, la red: las líneas de un reparto cuadran al centavo, o se lanza. Aparte del cálculo para
-- poder probarla con líneas alteradas: un error del código, no de la entrada (XX000).

create function private.check_payout_lines(p_carried_in_cents bigint, p_lines private.payout_line[])
returns void
language plpgsql immutable set search_path = ''
as $$
declare
  v_problem text;
begin
  if p_carried_in_cents is null or p_carried_in_cents < 0 or p_lines is null then
    raise exception 'payout does not balance: no carried amount or no lines' using errcode = 'XX000';
  end if;
  with l as (select * from pg_catalog.unnest(p_lines)),
  pools as (select * from l where l.kind = 'student_pool')
  select case
    when exists (select 1 from l where l.kind is null or l.cents is null or l.cents < 0) then 'a line without kind or amount, or negative'
    when exists (select 1 from pools where pools.profile_id is null or pools.half_points is null)
      or (select pg_catalog.count(*) from pools) <> (select pg_catalog.count(distinct pools.profile_id) from pools)
      then 'a student pool without its student or repeated'
    when exists (select 1 from l where l.kind = 'share' and not exists (select 1 from pools p where p.profile_id = l.profile_id))
      then 'a share without its student pool'
    when exists (select 1 from pools p
                 cross join lateral (select coalesce(pg_catalog.sum(s.cents), 0) as cents, coalesce(pg_catalog.sum(s.half_points), 0) as half_points,
                                            pg_catalog.count(*) as n
                                     from l s where s.kind = 'share' and s.profile_id = p.profile_id) s
                 where (p.half_points > 0 and (s.cents <> p.cents or s.half_points <> p.half_points))
                    or (p.half_points = 0 and s.n > 0))
      then 'the shares of a student do not add up to its pool'
    when (select pg_catalog.count(*) from l where l.kind = 'carried_over') > 1
      or (exists (select 1 from l where l.kind = 'carried_over')
          and exists (select 1 from l where l.kind = 'unconsumed_share' or (l.kind = 'share' and l.cents > 0)))
      then 'carried over while something was assigned'
    when (select coalesce(pg_catalog.sum(pools.cents), 0) from pools) + p_carried_in_cents
         <> (select coalesce(pg_catalog.sum(l.cents), 0) from l where l.kind in ('share', 'unconsumed_share', 'carried_over'))
      then 'the lines do not add up to the pool'
  end into v_problem;
  if v_problem is not null then
    raise exception 'payout does not balance: %', v_problem using errcode = 'XX000';
  end if;
end
$$;
revoke all on function private.check_payout_lines(bigint, private.payout_line[]) from public;

-- ---------------------------------------------------------------------------------------
-- El reparto de un periodo, puro: no lee tablas. Recibe el porcentaje del bote, lo que llegó del
-- periodo anterior, la base de cada alumno y sus medios puntos con cada maestro; devuelve las
-- líneas en orden estable (tipo, alumno, orden del maestro), que la huella del cierre necesita.

create function private.compute_payout(p_pool_bps integer, p_carried_in_cents bigint,
                                       p_bases private.payout_base[], p_points private.payout_points[])
returns setof private.payout_line
language plpgsql immutable set search_path = ''
as $$
declare
  v_lines private.payout_line[];
  v_assigned bigint;
  v_unconsumed bigint;
  v_total bigint;
begin
  if p_pool_bps is null or p_pool_bps < 1 or p_pool_bps > 10000 then
    raise exception 'pool percentage must be between 1 and 10000 basis points' using errcode = '22023';
  end if;
  if p_carried_in_cents is null or p_carried_in_cents < 0 then
    raise exception 'carried in amount must be zero or more' using errcode = '22023';
  end if;
  if p_bases is null or p_points is null then
    raise exception 'payout needs bases and points' using errcode = '22023';
  end if;
  if exists (select 1 from pg_catalog.unnest(p_bases) b where b.profile_id is null or b.base_cents is null or b.base_cents <= 0)
     or exists (select 1 from pg_catalog.unnest(p_bases) b group by b.profile_id having pg_catalog.count(*) > 1) then
    raise exception 'each student appears once in the bases, with a positive base' using errcode = '22023';
  end if;
  if exists (select 1 from pg_catalog.unnest(p_points) p
             where p.profile_id is null or p.teacher_id is null or p.tiebreak_rank is null or p.half_points is null or p.half_points <= 0)
     or exists (select 1 from pg_catalog.unnest(p_points) p group by p.profile_id, p.teacher_id having pg_catalog.count(*) > 1) then
    raise exception 'each student and teacher appear once in the points, with positive half points' using errcode = '22023';
  end if;
  if exists (select 1 from pg_catalog.unnest(p_points) p group by p.teacher_id having pg_catalog.count(distinct p.tiebreak_rank) > 1)
     or exists (select 1 from pg_catalog.unnest(p_points) p group by p.tiebreak_rank having pg_catalog.count(distinct p.teacher_id) > 1) then
    raise exception 'each teacher has one rank, and each rank one teacher' using errcode = '22023';
  end if;

  -- RN-03 y RN-05: el bote de cada alumno, y sus partes. Los puntos de quien no tiene base no
  -- cuentan; un alumno con puntos y bote de 0 lleva sus partes de 0, con sus medios puntos.
  with b as (select * from pg_catalog.unnest(p_bases)),
  pt as (select p.* from pg_catalog.unnest(p_points) p join b on b.profile_id = p.profile_id),
  pools as (
    select b.profile_id, b.base_cents, pg_catalog.div(b.base_cents::numeric * p_pool_bps, 10000)::bigint as cents,
           coalesce((select pg_catalog.sum(pt.half_points) from pt where pt.profile_id = b.profile_id), 0)::integer as half_points
    from b),
  shares as (
    select pools.profile_id, pt.teacher_id, pt.tiebreak_rank, a.cents, pt.half_points
    from pools
    cross join lateral private.allocate_largest_remainder(
      pools.cents,
      array(select x.teacher_id from pt x where x.profile_id = pools.profile_id order by x.tiebreak_rank),
      array(select x.half_points::bigint from pt x where x.profile_id = pools.profile_id order by x.tiebreak_rank),
      array(select x.tiebreak_rank from pt x where x.profile_id = pools.profile_id order by x.tiebreak_rank)) a
    join pt on pt.profile_id = pools.profile_id and pt.teacher_id = a.id
    where pools.half_points > 0)
  select array(select row('student_pool', pools.profile_id, null, null, pools.cents, pools.base_cents, pools.half_points)::private.payout_line
               from pools)
         || array(select row('share', shares.profile_id, shares.teacher_id, shares.tiebreak_rank, shares.cents, null, shares.half_points)::private.payout_line
                  from shares)
  into v_lines;

  select coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'share'), 0),
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'student_pool' and l.half_points = 0), 0) + p_carried_in_cents,
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'student_pool'), 0) + p_carried_in_cents
  into v_assigned, v_unconsumed, v_total
  from pg_catalog.unnest(v_lines) l;

  -- RN-06: el sin consumo, en proporción a lo asignado a cada maestro. Un maestro con puntos y 0
  -- asignado no entra (un peso cero no tiene residuo que comparar). Sin asignado, todo pasa al
  -- periodo siguiente.
  if v_assigned > 0 then
    with t as (
      select l.teacher_id, pg_catalog.min(l.tiebreak_rank) as tiebreak_rank, pg_catalog.sum(l.cents)::bigint as cents
      from pg_catalog.unnest(v_lines) l where l.kind = 'share'
      group by l.teacher_id having pg_catalog.sum(l.cents) > 0)
    select v_lines || array(
      select row('unconsumed_share', null, a.id, t.tiebreak_rank, a.cents, null, null)::private.payout_line
      from private.allocate_largest_remainder(
        v_unconsumed,
        array(select t.teacher_id from t order by t.tiebreak_rank),
        array(select t.cents from t order by t.tiebreak_rank),
        array(select t.tiebreak_rank from t order by t.tiebreak_rank)) a
      join t on t.teacher_id = a.id
      where a.cents > 0)
    into v_lines;
  elsif v_total > 0 then
    v_lines := v_lines || row('carried_over', null, null, null, v_total, null, null)::private.payout_line;
  end if;

  perform private.check_payout_lines(p_carried_in_cents, v_lines);
  return query
  select l.* from pg_catalog.unnest(v_lines) l
  order by l.kind, l.profile_id nulls first, l.tiebreak_rank nulls first;
end
$$;
revoke all on function private.compute_payout(integer, bigint, private.payout_base[], private.payout_points[]) from public;

-- ---------------------------------------------------------------------------------------
-- La entrada (05 §8.4), leída de los dos libros: la base de cada alumno, la suma de sus partes del
-- periodo (con los reversos, cuando T-307 los traiga; una suma de cero o negativa no aporta); y sus
-- medios puntos con cada maestro, del consolidado, con el orden del maestro para los empates. No
-- se filtra a las cuentas suspendidas por fraude: su consumo ya no está en el consolidado (T-208),
-- y su base va al sin consumo (decisión de Sergio). Un maestro suspendido sigue cobrando (RF-702).

create function private.close_input_students(p_period_id public.period_id)
returns table (profile_id uuid, base_cents bigint)
language sql stable set search_path = ''
as $$
  select a.profile_id, pg_catalog.sum(a.base_cents)::bigint
  from public.revenue_allocations a
  where a.period_id = p_period_id
  group by a.profile_id
  having pg_catalog.sum(a.base_cents) > 0
$$;
revoke all on function private.close_input_students(public.period_id) from public;

create function private.close_input_points(p_period_id public.period_id)
returns table (profile_id uuid, teacher_id uuid, tiebreak_rank bigint, half_points integer)
language sql stable set search_path = ''
as $$
  select r.profile_id, r.teacher_id, t.tiebreak_rank, pg_catalog.sum(r.half_points)::integer
  from public.watch_rollup r
  join public.teachers t on t.id = r.teacher_id
  where r.period_id = p_period_id and r.half_points > 0
  group by r.profile_id, r.teacher_id, t.tiebreak_rank
$$;
revoke all on function private.close_input_points(public.period_id) from public;

-- El porcentaje del bote de un periodo: `BOTE_PCT_BASE`, leído por periodo (RF-707), con la regla
-- del sin consumo que este cálculo sigue (PQ-06); otra lanza, no se adivina. T-601 la reemplaza por
-- los tramos (RN-13).
create function private.pool_bps(p_period public.period_id) returns integer
language plpgsql stable set search_path = ''
as $$
declare
  v_bps jsonb := private.period_parameter('BOTE_PCT_BASE', p_period);
  v_rule jsonb := private.period_parameter('BOTE_SIN_CONSUMO', p_period);
begin
  if v_bps is null then
    raise exception 'pool percentage is not set for period %', p_period using errcode = 'P0001';
  end if;
  -- Sin la regla también lanza: nulo es distinto de la que sigue este cálculo.
  if v_rule is distinct from '"proportional_to_assigned_pool"'::jsonb then
    raise exception 'pool for period % has an unknown BOTE_SIN_CONSUMO', p_period using errcode = 'P0001';
  end if;
  if pg_catalog.jsonb_typeof(v_bps) is distinct from 'number' or (v_bps)::text !~ '^[0-9]{1,5}$'
     or (v_bps)::text::integer < 1 or (v_bps)::text::integer > 10000 then
    raise exception 'pool for period % has an invalid BOTE_PCT_BASE', p_period using errcode = 'P0001';
  end if;
  return (v_bps)::text::integer;
end
$$;
revoke all on function private.pool_bps(public.period_id) from public;

-- El reparto de un periodo con su entrada armada. Lo arrastrado del periodo anterior no tiene valor
-- por omisión: quien llama lo pasa (la alerta, 0; el cierre de T-602, lo que guardó T-601).
create function private.payout_for_period(p_period public.period_id, p_carried_in_cents bigint)
returns setof private.payout_line
language sql stable set search_path = ''
as $$
  select * from private.compute_payout(
    private.pool_bps(p_period), p_carried_in_cents,
    array(select row(s.profile_id, s.base_cents)::private.payout_base from private.close_input_students(p_period) s),
    array(select row(p.profile_id, p.teacher_id, p.tiebreak_rank, p.half_points)::private.payout_points
          from private.close_input_points(p_period) p))
$$;
revoke all on function private.payout_for_period(public.period_id, bigint) from public;

-- ---------------------------------------------------------------------------------------
-- La alerta del bote sin consumo (RF-406), en la detección de cada noche (T-208). Lo de antes, sin
-- cambio; al final, un tercer bloque, solo para el mes que terminó (como el salto de puntos: a medio
-- mes casi todo el bote está sin consumo) y en su propio bloque: si falla, las otras dos alertas se
-- quedan y la función lo devuelve en `anomalies_failed`, que la corrida anota y con el que termina
-- fallida. La proporción es contra el bote del periodo, sin lo arrastrado; el umbral se lee al
-- detectar, como los otros dos.

create or replace function private.detect_anomalies(p_period public.period_id, p_now timestamptz default pg_catalog.now())
returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_kind text := pg_catalog.current_setting('app.actor_kind', true);
  v_window public.period_id[] := array(select private.rollup_window());
  v_zone text := private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}';
  v_month timestamp := pg_catalog.to_date(p_period::text || '01', 'YYYYMMDD')::timestamp;
  v_start timestamptz;
  v_end timestamptz;
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

  v_start := pg_catalog.timezone(v_zone, v_month);
  v_end := pg_catalog.timezone(v_zone, v_month + interval '1 month');
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

  v_previous := pg_catalog.to_char(v_month - interval '1 month', 'YYYYMM')::integer;
  if p_period = (select pg_catalog.min(p) from pg_catalog.unnest(v_window) as p)
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

  -- El bote sin consumo (T-407): solo el mes que terminó, y solo si tiene bases. En su propio
  -- bloque: lo de arriba ya quedó, falle o no.
  if p_period = (select pg_catalog.min(p) from pg_catalog.unnest(v_window) as p)
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
revoke all on function private.detect_anomalies(public.period_id, timestamptz) from public;

-- ---------------------------------------------------------------------------------------
-- El vigilante: el área del reparto (de este carril). Cada función existe (renombrar una no pasa
-- en silencio), nadie de la aplicación la ejecuta, ninguna es `security definer`, todas tienen el
-- `search_path` fijo, y el cálculo, el redondeo y la red no leen tablas.

create function private.schema_violations_payout()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  payout_functions (name, pure) as (
    values ('allocate_largest_remainder', true), ('check_payout_lines', true), ('compute_payout', true),
           ('close_input_students', false), ('close_input_points', false), ('pool_bps', false), ('payout_for_period', false)),
  found as (
    select f.name, f.pure, p.oid, p.prosecdef, p.proconfig, p.provolatile
    from payout_functions f
    join pg_catalog.pg_proc p on p.proname = f.name
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private')
  select 'payout function missing', 'private.' || f.name
  from payout_functions f
  where not exists (select 1 from found where found.name = f.name)
  union all
  select 'payout function executable by ' || r.rolname, found.oid::regprocedure::text
  from app_roles r cross join found
  where pg_catalog.has_function_privilege(r.rolname::name, found.oid, 'EXECUTE')
  union all
  select 'payout function security definer or without fixed search_path', found.oid::regprocedure::text
  from found
  where found.prosecdef or not coalesce(found.proconfig, '{}') @> array['search_path=""']
  union all
  select 'payout function not immutable', found.oid::regprocedure::text
  from found
  where found.pure and found.provolatile <> 'i'
$$;
revoke all on function private.schema_violations_payout() from public;
