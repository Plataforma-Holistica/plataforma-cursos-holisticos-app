-- T-611 · El reparto lineal (RNF-06, RNF-07; 05 §8.4 y §14.4). Decisiones de Sergio del 2026-10-26:
-- la misma regla y la misma salida que T-407, con `allocate_largest_remainder` como única rutina de
-- redondeo (RN-07).
--
-- El oráculo es el reparto de T-407 copiado aquí tal cual (`t407_reparto`): `compute_payout` y
-- `check_payout_lines` de antes, con su red de antes. Lo nuevo tiene que dar exactamente lo mismo: el
-- mismo texto de las líneas, en el mismo orden, y con una entrada mala el mismo `sqlstate` y el mismo
-- mensaje. Que ya no crezca con el cuadrado de los alumnos lo mide la prueba de escala.
begin;
\ir _ayuda.psql
set constraints all immediate;
select plan(30);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a0000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.ma(p_n integer) returns uuid language sql immutable
as $$ select ('f0000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.b(p_n integer, p_cents bigint) returns private.payout_base language sql immutable
as $$ select row(pruebas.al(p_n), p_cents)::private.payout_base $$;
create function pruebas.p(p_n integer, p_t integer, p_half integer, p_rank bigint default null) returns private.payout_points
language sql immutable as $$ select row(pruebas.al(p_n), pruebas.ma(p_t), coalesce(p_rank, p_t), p_half)::private.payout_points $$;
create function pruebas.linea(p_kind private.payout_line_kind, p_n integer, p_t integer, p_cents bigint, p_base bigint, p_half integer)
returns private.payout_line language sql immutable
as $$
  select row(p_kind, case when p_n is not null then pruebas.al(p_n) end, case when p_t is not null then pruebas.ma(p_t) end,
             p_t, p_cents, p_base, p_half)::private.payout_line
$$;

-- ---------------------------------------------------------------------------------------
-- El oráculo: la red y el reparto de T-407, sin cambiar nada más que su nombre (y que el reparto
-- llama a esta red, no a la nueva).

create function pruebas.check_payout_lines_t407(p_carried_in_cents bigint, p_lines private.payout_line[])
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
    when exists (select 1 from l where l.kind in ('share', 'unconsumed_share') and (l.teacher_id is null or l.tiebreak_rank is null))
      or exists (select 1 from l where l.kind = 'share' group by l.profile_id, l.teacher_id having pg_catalog.count(*) > 1)
      or exists (select 1 from l where l.kind = 'unconsumed_share' group by l.teacher_id having pg_catalog.count(*) > 1)
      then 'a share without its teacher, or repeated'
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

create function pruebas.compute_payout_t407(p_pool_bps integer, p_carried_in_cents bigint,
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

  perform pruebas.check_payout_lines_t407(p_carried_in_cents, v_lines);
  return query
  select l.* from pg_catalog.unnest(v_lines) l
  order by l.kind, l.profile_id nulls first, l.tiebreak_rank nulls first;
end
$$;

-- Lo que sale de un reparto, como texto: las líneas en el orden en que salen, o el error con su
-- `sqlstate` y su mensaje. Con `nueva`, el de ahora; sin ella, el oráculo.
create function pruebas.salida(p_nueva boolean, p_bps integer, p_carried bigint,
                               p_bases private.payout_base[], p_points private.payout_points[])
returns text language plpgsql
as $$
begin
  if p_nueva then
    return (select coalesce(array_agg(row(l.kind, l.profile_id, l.teacher_id, l.tiebreak_rank, l.cents, l.base_cents, l.half_points)::private.payout_line
                                      order by l.o), '{}')::text
            from private.compute_payout(p_bps, p_carried, p_bases, p_points)
                 with ordinality as l (kind, profile_id, teacher_id, tiebreak_rank, cents, base_cents, half_points, o));
  end if;
  return (select coalesce(array_agg(row(l.kind, l.profile_id, l.teacher_id, l.tiebreak_rank, l.cents, l.base_cents, l.half_points)::private.payout_line
                                    order by l.o), '{}')::text
          from pruebas.compute_payout_t407(p_bps, p_carried, p_bases, p_points)
               with ordinality as l (kind, profile_id, teacher_id, tiebreak_rank, cents, base_cents, half_points, o));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$$;
-- Lo que dice la red de unas líneas: `ok`, o el error con su `sqlstate` y su mensaje.
create function pruebas.red(p_nueva boolean, p_carried bigint, p_lines private.payout_line[])
returns text language plpgsql
as $$
begin
  if p_nueva then
    perform private.check_payout_lines(p_carried, p_lines);
  else
    perform pruebas.check_payout_lines_t407(p_carried, p_lines);
  end if;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$$;
create function pruebas.lineas(p_bps integer, p_carried bigint, p_bases private.payout_base[], p_points private.payout_points[])
returns private.payout_line[] language sql stable
as $$
  select coalesce(array_agg(row(l.kind, l.profile_id, l.teacher_id, l.tiebreak_rank, l.cents, l.base_cents, l.half_points)::private.payout_line
                            order by l.o), '{}')
  from pruebas.compute_payout_t407(p_bps, p_carried, p_bases, p_points)
       with ordinality as l (kind, profile_id, teacher_id, tiebreak_rank, cents, base_cents, half_points, o)
$$;

select is_empty($$select * from private.schema_violations_payout()$$,
  'el reparto y la red siguen puros, inmutables, sin `security definer` y fuera del alcance de la aplicación');

-- ---------------------------------------------------------------------------------------
-- Periodos al azar con entrada buena (semilla fija), como los de `34_reparto_alerta_y_propiedades`:
-- hasta 12 alumnos (algunos sin base, con puntos), hasta 6 maestros con un orden al azar, bases
-- chicas y a veces enormes, medios puntos de 1 a 20, porcentaje y arrastre al azar.

create temporary table azar (i integer primary key, bps integer, carried bigint, bases private.payout_base[], points private.payout_points[]);
select setseed(0.611);
do $$
declare
  v_students integer;
  v_teachers integer;
  v_ranks bigint[];
begin
  for i in 1 .. 3000 loop
    v_students := floor(random() * 13)::integer;
    v_teachers := 1 + floor(random() * 6)::integer;
    v_ranks := array(select (1 + floor(random() * 1000000))::bigint * 10 + n from generate_series(1, v_teachers) n order by random());
    insert into azar values (
      i,
      case when random() < 0.1 then 10000 when random() < 0.1 then 1 else 1 + floor(random() * 10000)::integer end,
      case when random() < 0.7 then 0 else floor(random() * 1000000)::bigint end,
      array(select pruebas.b(s, case when random() < 0.05 then (1 + floor(random() * 1e15))::bigint
                                     else (1 + floor(random() * case when random() < 0.3 then 50 else 300000 end))::bigint end)
            from generate_series(1, v_students) s where random() < 0.85),
      array(select pruebas.p(s, t, 1 + floor(random() * 20)::integer, v_ranks[t])
            from generate_series(1, v_students + 2) s, generate_series(1, v_teachers) t where random() < 0.35));
  end loop;
end
$$;
create temporary table salidas as
  select a.i, pruebas.salida(true, a.bps, a.carried, a.bases, a.points) as nueva, pruebas.salida(false, a.bps, a.carried, a.bases, a.points) as antes
  from azar a;

select is((select count(*)::integer from salidas where nueva like '{%'), 3000, 'tres mil periodos al azar, todos con reparto');
select cmp_ok((select count(*)::integer from salidas where nueva like '%(unconsumed_share,%' and nueva like '%(share,%'), '>', 600,
  'muchos con sin consumo y con asignado a la vez');
select cmp_ok((select count(*)::integer from salidas where nueva like '%carried_over%'), '>', 40,
  'y algunos donde todo pasa al periodo siguiente');
select is((select count(*)::integer from salidas where nueva is distinct from antes), 0,
  'en los tres mil, el reparto de ahora da exactamente las líneas de T-407, en el mismo orden');

-- ---------------------------------------------------------------------------------------
-- Periodos al azar con entrada mala: elementos nulos, alumnos y pares repetidos, órdenes que chocan,
-- medios puntos de 0 o enormes, bases que suman más de lo que cabe, porcentajes y arrastres fuera de
-- rango. Lo que falla tiene que fallar igual: el mismo `sqlstate` y el mismo mensaje.

create temporary table azar_malo (i integer primary key, bps integer, carried bigint, bases private.payout_base[], points private.payout_points[]);
select setseed(0.6112);
do $$
declare
  v_students integer;
  v_teachers integer;
  v_ranks bigint[];
  v_bases private.payout_base[];
  v_points private.payout_points[];
begin
  for i in 1 .. 2000 loop
    v_students := 1 + floor(random() * 8)::integer;
    v_teachers := 1 + floor(random() * 4)::integer;
    v_ranks := array(select (1 + floor(random() * 1000))::bigint * 10 + n from generate_series(1, v_teachers) n order by random());
    v_bases := array(
      select pruebas.b(s, case when random() < 0.08 then 4000000000000000000 + floor(random() * 5e18)::bigint
                               else (1 + floor(random() * 300000))::bigint end)
      from generate_series(1, v_students) s where random() < 0.85);
    v_points := array(
      select pruebas.p(s, t, case when random() < 0.06 then 2147483647 - floor(random() * 3)::integer
                                  else 1 + floor(random() * 20)::integer end, v_ranks[t])
      from generate_series(1, v_students + 1) s, generate_series(1, v_teachers) t where random() < 0.45);
    if random() < 0.03 then v_bases := v_bases || null::private.payout_base; end if;
    if random() < 0.03 then v_points := v_points || null::private.payout_points; end if;
    if random() < 0.03 and cardinality(v_bases) > 0 then v_bases := v_bases || v_bases[1]; end if;
    if random() < 0.03 and cardinality(v_points) > 0 then v_points := v_points || v_points[1]; end if;
    if random() < 0.03 then v_points := v_points || pruebas.p(1, 9, 2, v_ranks[1]); end if;
    if random() < 0.03 then v_points := v_points || pruebas.p(2, 1, 2, 99999); end if;
    if random() < 0.03 then v_points := v_points || pruebas.p(3, 1, 0); end if;
    if random() < 0.02 then v_bases := v_bases || pruebas.b(20, 0); end if;
    insert into azar_malo values (
      i,
      case when random() < 0.02 then null when random() < 0.02 then 0 when random() < 0.02 then 10001 else 1 + floor(random() * 10000)::integer end,
      case when random() < 0.02 then null when random() < 0.02 then -1 when random() < 0.05 then 9000000000000000000
           else floor(random() * 1000)::bigint end,
      v_bases, v_points);
  end loop;
end
$$;
create temporary table salidas_malas as
  select a.i, pruebas.salida(true, a.bps, a.carried, a.bases, a.points) as nueva, pruebas.salida(false, a.bps, a.carried, a.bases, a.points) as antes
  from azar_malo a;

select cmp_ok((select count(*)::integer from salidas_malas where nueva like '22023 %'), '>', 300, 'cientos que no pasan las validaciones');
select cmp_ok((select count(*)::integer from salidas_malas where nueva like '22003 %'), '>', 50,
  'decenas que no caben (medios puntos que no caben en un entero, botes que no caben en un bigint)');
select cmp_ok((select count(*)::integer from salidas_malas where nueva like '{%'), '>', 300, 'y cientos con reparto');
select is((select count(*)::integer from salidas_malas where nueva is distinct from antes), 0,
  'en los dos mil, lo de ahora sale igual que T-407: las mismas líneas, o el mismo error con el mismo mensaje');

-- Los casos que la revisión del plan pidió nombrar.
select is(pruebas.salida(true, 6000, 0, array[pruebas.b(1, 100)], array[pruebas.p(1, 1, 2147483647), pruebas.p(1, 2, 2)]),
          '22003 integer out of range', 'medios puntos que no caben en un entero, de un alumno con base: lanza');
select is(pruebas.salida(true, 6000, 0, array[pruebas.b(1, 100)], array[pruebas.p(1, 1, 2), pruebas.p(9, 1, 2147483647), pruebas.p(9, 2, 2)]),
          pruebas.salida(false, 6000, 0, array[pruebas.b(1, 100)], array[pruebas.p(1, 1, 2), pruebas.p(9, 1, 2147483647), pruebas.p(9, 2, 2)]),
  'de un alumno sin base no cuentan, y no lanzan');
select ok(pruebas.salida(true, 6000, 0, array[pruebas.b(1, 100)], array[pruebas.p(1, 1, 2), pruebas.p(9, 1, 2147483647), pruebas.p(9, 2, 2)]) like '{%',
  'sale el reparto');
select is(pruebas.salida(true, 10000, 0, array[pruebas.b(1, 9000000000000000000), pruebas.b(2, 9000000000000000000)], '{}'),
          '22003 bigint out of range', 'botes que suman más de lo que cabe en un bigint: lanza');
select is(pruebas.salida(true, 6000, 0, array[null::private.payout_base], '{}'),
          '22023 each student appears once in the bases, with a positive base', 'una base nula no entra');
select is(pruebas.salida(true, 6000, 0, array[pruebas.b(1, 100)], array[null::private.payout_points]),
          '22023 each student and teacher appear once in the points, with positive half points', 'unos puntos nulos tampoco');

-- Un periodo grande, después de miles de llamadas en esta sesión, con el plan que la sesión ya tenía
-- guardado (casi seguro el genérico) y con uno a la medida, que es el que ve el largo de los arreglos:
-- el que tendrá cada conexión del servidor en sus primeras llamadas. La salida tiene que ser la misma.
create temporary table grande as
  select array(select row(pg_catalog.md5('a' || g)::uuid, (25000 + (g * 37) % 9000)::bigint)::private.payout_base
               from generate_series(1, 1000) g order by 1) as bases,
         array(select row(pg_catalog.md5('a' || g)::uuid, pg_catalog.md5('t' || t)::uuid, t::bigint,
                          (1 + (pg_catalog.hashtext(g::text || '-' || t) & 255))::integer)::private.payout_points
               from generate_series(1, 1050) g
               cross join lateral (select distinct 1 + ((g * 7 + k * 13) % 100) as t from generate_series(1, 18) k) x
               where g % 10 <> 0 order by 1) as points;
create temporary table grande_antes as select pruebas.salida(false, 6000, 12345, bases, points) as antes from grande;
select is((select pruebas.salida(true, 6000, 12345, bases, points) from grande), (select antes from grande_antes),
  'mil alumnos con 18 maestros cada uno (y 45 con puntos y sin base): las mismas líneas');
select set_config('plan_cache_mode', 'force_custom_plan', true);
select is((select pruebas.salida(true, 6000, 12345, bases, points) from grande), (select antes from grande_antes),
  'y con un plan a la medida, que sabe que son mil, también');
select set_config('plan_cache_mode', 'auto', true);
select cmp_ok((select count(*)::integer from grande, private.compute_payout(6000, 12345, bases, points)), '>', 17000,
  'que son más de diecisiete mil');

-- ---------------------------------------------------------------------------------------
-- La red, contra la de T-407: líneas de verdad alteradas de una en una y de dos en dos. Cada defecto
-- tiene que decir lo mismo, también cuando hay dos y el orden de las revisiones decide cuál se dice.

create function pruebas.muta(p_lines private.payout_line[], p_m integer, p_i integer) returns private.payout_line[]
language plpgsql immutable
as $$
declare
  v private.payout_line[] := p_lines;
  l private.payout_line;
  n integer := pg_catalog.cardinality(p_lines);
  i integer;
begin
  if n = 0 then
    return v;
  end if;
  i := 1 + (p_i % n);
  l := v[i];
  case p_m
    when 0 then l.cents := l.cents + 1;
    when 1 then l.cents := l.cents - 1;
    when 2 then l.cents := null;
    when 3 then l.kind := null;
    when 4 then l.profile_id := null;
    when 5 then l.teacher_id := null;
    when 6 then l.tiebreak_rank := null;
    when 7 then l.half_points := null;
    when 8 then l.half_points := coalesce(l.half_points, 0) + 1;
    when 9 then return v[1:i - 1] || v[i + 1:n];
    when 10 then return v || l;
    when 11 then l.kind := (array['student_pool', 'share', 'unconsumed_share', 'carried_over']::private.payout_line_kind[])[1 + (p_i % 4)];
    when 12 then return v || row('carried_over', null, null, null, 0, null, null)::private.payout_line;
    when 13 then l.profile_id := pruebas.al(999);
    when 14 then return array(select x from pg_catalog.unnest(v) x where not (x.kind = 'share' and x.profile_id is not distinct from l.profile_id));
    else l.cents := -1;
  end case;
  v[i] := l;
  return v;
end
$$;
create temporary table redes as
  with base as (
    select a.i, a.carried, pruebas.lineas(a.bps, a.carried, a.bases, a.points) as lines from azar a where a.i <= 600),
  una as (
    select b.i, b.carried, pruebas.muta(b.lines, m, b.i * 7 + k) as lines
    from base b, generate_series(0, 15) m, generate_series(0, 1) k),
  dos as (
    select b.i, b.carried, pruebas.muta(pruebas.muta(b.lines, (b.i * 3 + k) % 16, b.i + k), (b.i * 5 + k * 11) % 16, b.i * 13 + k) as lines
    from base b, generate_series(0, 3) k),
  arrastre as (select b.i, b.carried + 1 as carried, b.lines from base b)
  select r.i, r.carried, r.lines, pruebas.red(true, r.carried, r.lines) as nueva, pruebas.red(false, r.carried, r.lines) as antes
  from (select * from una union all select * from dos union all select * from arrastre) r;

select cmp_ok((select count(distinct nueva)::integer from redes where nueva like 'XX000 %'), '>=', 7,
  'las líneas alteradas pasan por los siete defectos que la red sabe nombrar');
select cmp_ok((select count(*)::integer from redes where nueva = 'ok'), '>', 100,
  'y algunas alteraciones cuadran: tocan lo que la red no revisa (el maestro de un bote, un arrastre de 0 sin nada asignado)');
select is((select count(*)::integer from redes where nueva is distinct from antes), 0,
  'la red de ahora dice lo mismo que la de T-407 en cada una');

-- Los casos que la revisión del plan pidió nombrar.
select is(pruebas.red(true, 0, array[pruebas.linea('student_pool', 1, null, 100, 200, 2), pruebas.linea('share', null, 1, 100, null, 2)]),
          'XX000 payout does not balance: a share without its student pool', 'una parte sin alumno no tiene bote');
select is(pruebas.red(true, 0, array[pruebas.linea('student_pool', 1, null, 100, 200, 2), pruebas.linea('share', 1, 1, 100, null, null)]),
          'XX000 payout does not balance: the shares of a student do not add up to its pool', 'unas partes con medios puntos nulos no suman');
select is(pruebas.red(true, 0, array[pruebas.linea('student_pool', 1, null, 100, 200, 2), pruebas.linea('unconsumed_share', null, 1, 100, null, null)]),
          'XX000 payout does not balance: the shares of a student do not add up to its pool', 'ni un bote con medios puntos y sin partes');
select is(pruebas.red(true, null, '{}'), pruebas.red(false, null, '{}'), 'sin arrastre, lo mismo');

-- ---------------------------------------------------------------------------------------
-- Con otros planes. Lo de arriba corrió con los planes que Postgres eligió; lo de ahora no puede
-- depender de eso. Se vuelve a correr una parte con cada ajuste del planificador, contra lo que dio
-- T-407 arriba, con el plan a la medida en cada llamada (un ajuste no invalida un plan guardado),
-- salvo en el caso del plan genérico.

create function pruebas.difiere_con(p_name text, p_value text) returns integer language plpgsql
as $$
declare
  v_cache text := pg_catalog.current_setting('plan_cache_mode');
  v_old text := pg_catalog.current_setting(p_name);
  v_n integer;
begin
  perform pg_catalog.set_config('plan_cache_mode', 'force_custom_plan', true);
  perform pg_catalog.set_config(p_name, p_value, true);
  select (select count(*) from salidas s join azar a using (i)
          where s.i <= 1000 and pruebas.salida(true, a.bps, a.carried, a.bases, a.points) is distinct from s.antes)
       + (select count(*) from salidas_malas s join azar_malo a using (i)
          where s.i <= 1000 and pruebas.salida(true, a.bps, a.carried, a.bases, a.points) is distinct from s.antes)
       + (select count(*) from redes r where r.i <= 200 and pruebas.red(true, r.carried, r.lines) is distinct from r.antes)
  into v_n;
  perform pg_catalog.set_config(p_name, v_old, true);
  perform pg_catalog.set_config('plan_cache_mode', v_cache, true);
  return v_n;
end
$$;
select is(pruebas.difiere_con('plan_cache_mode', 'force_generic_plan'), 0, 'con el plan genérico, lo mismo que T-407');
select is(pruebas.difiere_con('enable_presorted_aggregate', 'off'), 0, 'sin agregados con la entrada ya ordenada, lo mismo');
select is(pruebas.difiere_con('enable_hashjoin', 'off'), 0, 'sin uniones por hash, lo mismo');
select is(pruebas.difiere_con('enable_nestloop', 'off'), 0, 'sin ciclos anidados, lo mismo');
select is(pruebas.difiere_con('enable_hashagg', 'off'), 0, 'sin agrupar por hash, lo mismo');

select * from finish();
rollback;
