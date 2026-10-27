-- T-611 · El reparto lineal (RNF-06, RNF-07; 05 §8.4 y §14.4). Segunda de dos solicitudes; la primera
-- (`t611_pares_por_indice`) es la selección de pares del recálculo completo y la prueba de escala.
-- Decisiones de Sergio del 2026-10-26: el reparto lineal va dentro de T-611, con la misma regla y la
-- misma salida; `allocate_largest_remainder` sigue siendo la única rutina de redondeo (RN-07); y la
-- escritura del cierre se mide aquí y la decide T-605.
--
-- Lo que cambia: `compute_payout` y `check_payout_lines` crecían con el cuadrado de los alumnos (medido
-- el 2026-10-26: 2.5 s a 1 000 alumnos y 9.9 s a 2 000; a 13 000, más de siete minutos). Las dos
-- buscaban, por cada alumno, en todo lo que salía de `unnest`: subconsultas correlacionadas que
-- recorrían todos los puntos (en la red, todas las líneas) por cada fila. Quitarlas no basta: Postgres
-- no sabe cuántas filas salen de `unnest` ni de un CTE filtrado (con el plan genérico supone 10), y una
-- unión entre ellos la resuelve con un ciclo anidado. Una reescritura con `left join` a agregados
-- tardaba 0.4 s a 2 000 alumnos y 43 s a 13 000: el plan cambió con el tamaño. Por eso aquí no hay
-- uniones entre lo que sale de `unnest`: todo es un solo `group by` por alumno. Con 13 000 alumnos y
-- 210 000 medios puntos de una entrada sintética, 2.4 s.
--
-- La salida es la misma, línea por línea y en el mismo orden: la huella del cierre y
-- `assert_period_balanced` comparan el texto de las líneas, y un periodo cerrado con el reparto de
-- T-407 se vuelve a calcular con este. La prueba es `supabase/tests/50_reparto_lineal.test.sql`, contra
-- las dos funciones de T-407 copiadas como oráculo. `code_version` cambia con esta migración: un
-- periodo que esté en cierre al desplegarla se ensaya otra vez (`rehearsal_stale`).

-- ---------------------------------------------------------------------------------------
-- RNF-04, la red. Las revisiones, su orden y sus mensajes son los de T-407; cambian las dos que
-- cruzaban las partes con los botes, que ahora salen de una sola pasada por alumno.

create or replace function private.check_payout_lines(p_carried_in_cents bigint, p_lines private.payout_line[])
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
  pools as (select * from l where l.kind = 'student_pool'),
  -- El bote de cada alumno y la suma de sus partes, lado a lado. Cuando se lee, cada alumno tiene a lo
  -- más un bote (lo revisa la rama de los botes repetidos, que va antes). Las partes sin alumno caen
  -- juntas en el grupo nulo, que no tiene bote.
  per as (
    select l.profile_id,
           pg_catalog.count(*) filter (where l.kind = 'student_pool') as pools,
           pg_catalog.min(l.cents) filter (where l.kind = 'student_pool') as pool_cents,
           pg_catalog.min(l.half_points) filter (where l.kind = 'student_pool') as pool_half_points,
           coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'share'), 0) as share_cents,
           coalesce(pg_catalog.sum(l.half_points) filter (where l.kind = 'share'), 0) as share_half_points,
           pg_catalog.count(*) filter (where l.kind = 'share') as shares
    from l group by l.profile_id)
  select case
    when exists (select 1 from l where l.kind is null or l.cents is null or l.cents < 0) then 'a line without kind or amount, or negative'
    when exists (select 1 from pools where pools.profile_id is null or pools.half_points is null)
      or (select pg_catalog.count(*) from pools) <> (select pg_catalog.count(distinct pools.profile_id) from pools)
      then 'a student pool without its student or repeated'
    when exists (select 1 from l where l.kind in ('share', 'unconsumed_share') and (l.teacher_id is null or l.tiebreak_rank is null))
      or exists (select 1 from l where l.kind = 'share' group by l.profile_id, l.teacher_id having pg_catalog.count(*) > 1)
      or exists (select 1 from l where l.kind = 'unconsumed_share' group by l.teacher_id having pg_catalog.count(*) > 1)
      then 'a share without its teacher, or repeated'
    when exists (select 1 from per where per.shares > 0 and per.pools = 0)
      then 'a share without its student pool'
    when exists (select 1 from per
                 where per.pools > 0
                   and ((per.pool_half_points > 0 and (per.share_cents <> per.pool_cents or per.share_half_points <> per.pool_half_points))
                        or (per.pool_half_points = 0 and per.shares > 0)))
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
-- El reparto de un periodo, puro: no lee tablas. La regla, la entrada, las validaciones y la salida son
-- las de T-407 (`t407_reparto`); cambia cómo se arman los botes y las partes.

create or replace function private.compute_payout(p_pool_bps integer, p_carried_in_cents bigint,
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

  -- RN-03 y RN-05: el bote de cada alumno, y sus partes. Bases y puntos van juntos y agrupados por
  -- alumno, sin unir lo que sale de `unnest`: de cada grupo, la base, la suma de sus medios puntos y sus
  -- maestros en orden de `tiebreak_rank`, con sus pesos. Los puntos de quien no tiene base no cuentan:
  -- su grupo no tiene base y no llega a `pools`, y su suma no se convierte a `integer` (no lanza). Un
  -- alumno con puntos y bote de 0 lleva sus partes de 0, con sus medios puntos. Las partes salen solo
  -- de los alumnos con medios puntos: uno sin ellos llegaría a `allocate_largest_remainder` con
  -- arreglos nulos, y lanzaría. El redondeo y los maestros del alumno van juntos por posición en un
  -- solo `rows from` (el redondeo devuelve las partes en el orden en que llegaron): una llamada por
  -- alumno con cualquier plan. Con dos laterales, según el orden de la unión, se llamaba una vez por
  -- cada maestro del alumno.
  with x as (
    select b.profile_id, b.base_cents, null::uuid as teacher_id, null::bigint as tiebreak_rank, null::integer as half_points
    from pg_catalog.unnest(p_bases) b
    union all
    select p.profile_id, null, p.teacher_id, p.tiebreak_rank, p.half_points from pg_catalog.unnest(p_points) p),
  g as (
    select x.profile_id, pg_catalog.max(x.base_cents) as base_cents, pg_catalog.sum(x.half_points) as half_points,
           pg_catalog.array_agg(x.teacher_id order by x.tiebreak_rank) filter (where x.teacher_id is not null) as ids,
           pg_catalog.array_agg(x.half_points::bigint order by x.tiebreak_rank) filter (where x.teacher_id is not null) as weights,
           pg_catalog.array_agg(x.tiebreak_rank order by x.tiebreak_rank) filter (where x.teacher_id is not null) as ranks
    from x group by x.profile_id),
  pools as materialized (
    select g.profile_id, g.base_cents, pg_catalog.div(g.base_cents::numeric * p_pool_bps, 10000)::bigint as cents,
           coalesce(g.half_points, 0)::integer as half_points, g.ids, g.weights, g.ranks
    from g where g.base_cents is not null),
  scored as materialized (select * from pools where pools.half_points > 0),
  shares as (
    select s.profile_id, y.teacher_id, y.tiebreak_rank, y.cents, y.half_points::integer as half_points
    from scored s
    cross join lateral rows from (private.allocate_largest_remainder(s.cents, s.ids, s.weights, s.ranks),
                                  pg_catalog.unnest(s.ids), pg_catalog.unnest(s.ranks), pg_catalog.unnest(s.weights))
      as y (id, cents, teacher_id, tiebreak_rank, half_points)
    -- Si alguna vez no salieran alineadas, la parte se pierde aquí y la red la rechaza: no se le da a
    -- otro maestro.
    where y.id = y.teacher_id)
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
