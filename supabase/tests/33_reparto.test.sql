-- T-407 · El reparto (RF-502, RN-03, RN-05, RN-06, RN-07, RNF-04; 01 §6.3, 05 §8.4 y §8.7).
-- Decisiones de Sergio del 2026-10-23: el reparto vive en la base (lo usan la alerta de cada
-- noche, el estimado de T-408 y el cierre de T-602, sin TypeScript de por medio); el bote de una
-- cuenta suspendida por fraude va al bote sin consumo; y T-407 son el cálculo, su entrada y la
-- alerta del bote sin consumo (RF-406). El porcentaje sale de `BOTE_PCT_BASE` hasta T-601.
--
-- Los ejemplos del PRD van en octubre de 2026 (el periodo de la semilla y el de 05 §8.7). La
-- alerta mira el mes que terminó, así que esa parte usa periodos relativos a hoy, con sus
-- parámetros escritos aquí como el dueño.
begin;
\ir _ayuda.psql
set constraints all immediate;
select plan(110);

-- Alumnos `a…n` y maestros `f…n` de mentira, para el cálculo puro; en la parte de punta a punta
-- los maestros son de verdad y se nombran en `etiquetas`.
create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a0000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.ma(p_n integer) returns uuid language sql immutable
as $$ select ('f0000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.b(p_n integer, p_cents bigint) returns private.payout_base language sql immutable
as $$ select row(pruebas.al(p_n), p_cents)::private.payout_base $$;
-- Medios puntos de un alumno con un maestro; el orden del maestro es su número, salvo que se diga.
create function pruebas.p(p_n integer, p_t integer, p_half integer, p_rank bigint default null) returns private.payout_points
language sql immutable as $$ select row(pruebas.al(p_n), pruebas.ma(p_t), coalesce(p_rank, p_t), p_half)::private.payout_points $$;
create temporary table etiquetas (id uuid primary key, name text not null);
create function pruebas.et(p_id uuid) returns text language sql stable
as $$
  select coalesce((select e.name from etiquetas e where e.id = p_id),
    case when p_id::text like 'a0000000-%' then 'a' || right(p_id::text, 12)::bigint
         when p_id::text like 'f0000000-%' then 'm' || right(p_id::text, 12)::bigint end)
$$;
create function pruebas.texto(p private.payout_line) returns text language sql stable
as $$
  select case p.kind
    when 'student_pool' then format('pool %s %s base=%s hp=%s', pruebas.et(p.profile_id), p.cents, p.base_cents, p.half_points)
    when 'share' then format('share %s %s %s hp=%s', pruebas.et(p.profile_id), pruebas.et(p.teacher_id), p.cents, p.half_points)
    when 'unconsumed_share' then format('unconsumed %s %s', pruebas.et(p.teacher_id), p.cents)
    when 'carried_over' then format('carried %s', p.cents)
  end
$$;
-- Las líneas del reparto en palabras, en el orden en que salen.
create function pruebas.lineas(p_lines private.payout_line[]) returns text[] language sql stable
as $$ select coalesce(array_agg(pruebas.texto(l) order by o), '{}') from unnest(p_lines) with ordinality as x (kind, profile_id, teacher_id, tiebreak_rank, cents, base_cents, half_points, o)
      cross join lateral (select row(x.kind, x.profile_id, x.teacher_id, x.tiebreak_rank, x.cents, x.base_cents, x.half_points)::private.payout_line as l) y $$;
create function pruebas.calcula(p_bps integer, p_carried bigint, p_bases private.payout_base[], p_points private.payout_points[])
returns private.payout_line[] language sql stable
as $$ select coalesce(array_agg(l), '{}') from private.compute_payout(p_bps, p_carried, p_bases, p_points) as l $$;
create function pruebas.reparto(p_bps integer, p_carried bigint, p_bases private.payout_base[], p_points private.payout_points[])
returns text[] language sql stable
as $$ select pruebas.lineas(pruebas.calcula(p_bps, p_carried, p_bases, p_points)) $$;
-- Lo que recibe cada maestro en el periodo: lo asignado más su parte del sin consumo.
create function pruebas.totales(p_lines private.payout_line[]) returns text[] language sql stable
as $$
  select coalesce(array_agg(format('%s %s', pruebas.et(t.teacher_id), t.cents) order by t.rank), '{}')
  from (select l.teacher_id, min(l.tiebreak_rank) as rank, sum(l.cents) as cents from unnest(p_lines) l
        where l.kind in ('share', 'unconsumed_share') group by l.teacher_id) t
$$;
-- El reparto de un monto por mayor residuo, en palabras: «id centavos».
create function pruebas.residuo(p_total bigint, p_n integer[], p_weights bigint[], p_ranks bigint[]) returns text[]
language sql stable
as $$
  select coalesce(array_agg(format('%s %s', pruebas.et(r.id), r.cents) order by r.o), '{}')
  from private.allocate_largest_remainder(p_total, array(select pruebas.ma(n) from unnest(p_n) with ordinality as x (n, o) order by o),
                                          p_weights, p_ranks) with ordinality as r (id, cents, o)
$$;
-- Una línea alterada: el primer renglón de ese tipo (y de ese maestro, si se dice) con otro monto
-- o con otros medios puntos.
create function pruebas.altera(p_lines private.payout_line[], p_kind text, p_teacher integer, p_cents_delta bigint, p_half_delta integer default 0)
returns private.payout_line[] language plpgsql stable
as $$
declare
  v private.payout_line[] := p_lines;
begin
  for i in 1 .. coalesce(array_length(v, 1), 0) loop
    if v[i].kind::text = p_kind and (p_teacher is null or v[i].teacher_id = pruebas.ma(p_teacher)) then
      v[i].cents := v[i].cents + p_cents_delta;
      v[i].half_points := v[i].half_points + p_half_delta;
      return v;
    end if;
  end loop;
  raise exception 'no line % %', p_kind, p_teacher;
end
$$;
create function pruebas.sin(p_lines private.payout_line[], p_kind text) returns private.payout_line[] language sql stable
as $$ select array(select l from unnest(p_lines) with ordinality as x (kind, profile_id, teacher_id, tiebreak_rank, cents, base_cents, half_points, o)
                   cross join lateral (select row(x.kind, x.profile_id, x.teacher_id, x.tiebreak_rank, x.cents, x.base_cents, x.half_points)::private.payout_line as l) y
                   where x.o <> (select min(o2) from unnest(p_lines) with ordinality as z (kind, profile_id, teacher_id, tiebreak_rank, cents, base_cents, half_points, o2)
                                 where z.kind::text = p_kind)
                   order by x.o) $$;
create function pruebas.revisa_lineas(p_carried bigint, p_lines private.payout_line[]) returns void language sql stable
as $$ select private.check_payout_lines(p_carried, p_lines) $$;

-- La entrada del ejemplo del PRD (05 §8.7): A, B y D mensuales y C anual en su primer periodo;
-- M1, M2 y M3 en ese orden.
create function pruebas.bases_prd() returns private.payout_base[] language sql immutable
as $$ select array[pruebas.b(1, 28581), pruebas.b(2, 28581), pruebas.b(3, 20405), pruebas.b(4, 28581)] $$;
create function pruebas.puntos_prd() returns private.payout_points[] language sql immutable
as $$ select array[pruebas.p(1, 1, 8), pruebas.p(1, 2, 5), pruebas.p(2, 2, 1), pruebas.p(3, 1, 6), pruebas.p(3, 2, 2), pruebas.p(3, 3, 2)] $$;
create function pruebas.prd() returns private.payout_line[] language sql stable
as $$ select pruebas.calcula(6000, 0, pruebas.bases_prd(), pruebas.puntos_prd()) $$;

grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- Las piezas: funciones de la base que nadie de la aplicación ejecuta.

select has_type('private', 'payout_base', 'la base de un alumno en el periodo');
select has_type('private', 'payout_points', 'sus medios puntos con un maestro');
select has_type('private', 'payout_line', 'una línea del reparto');
select enum_has_labels('private', 'payout_line_kind', array['student_pool', 'share', 'unconsumed_share', 'carried_over'],
  'cuatro tipos de línea: el bote del alumno, su parte a un maestro, el sin consumo y lo que pasa al siguiente');
select ok(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r (rolname)
    where n.nspname = 'private'
      and p.proname in ('allocate_largest_remainder', 'compute_payout', 'check_payout_lines', 'close_input_students',
                        'close_input_points', 'pool_bps', 'payout_for_period')
      and has_function_privilege(r.rolname, p.oid, 'EXECUTE')),
  'nadie de la aplicación ejecuta el reparto');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private'
             and p.proname in ('allocate_largest_remainder', 'compute_payout', 'check_payout_lines', 'close_input_students',
                               'close_input_points', 'pool_bps', 'payout_for_period')
             and not p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']), 7,
  'las siete funciones, del dueño sin `security definer` y con `search_path` fijo');
select is((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.provolatile = 'i'
             and p.proname in ('allocate_largest_remainder', 'compute_payout', 'check_payout_lines')),
  array['allocate_largest_remainder', 'check_payout_lines', 'compute_payout'],
  'el cálculo, el redondeo y la red son puros: no leen tablas');

-- ---------------------------------------------------------------------------------------
-- RN-07: el mayor residuo, la única rutina de redondeo.

select is(pruebas.residuo(17, array[1], array[5]::bigint[], array[1]::bigint[]), array['m1 17'], 'un solo peso se lleva todo');
select is(pruebas.residuo(3, array[1, 2, 3], array[1, 1, 1]::bigint[], array[3, 1, 2]::bigint[]), array['m1 1', 'm2 1', 'm3 1'],
  'sin centavos de sobra, cada quien lo suyo');
select is(pruebas.residuo(2, array[1, 2, 3], array[1, 1, 1]::bigint[], array[3, 1, 2]::bigint[]), array['m1 0', 'm2 1', 'm3 1'],
  'en empate, los centavos van a los de orden menor');
select is(pruebas.residuo(10, array[1, 2], array[1, 2]::bigint[], array[1, 2]::bigint[]), array['m1 3', 'm2 7'],
  'el centavo va al de mayor residuo, no al de orden menor');
select is(pruebas.residuo(0, array[1, 2], array[1, 2]::bigint[], array[1, 2]::bigint[]), array['m1 0', 'm2 0'], 'cero da ceros');
select is(pruebas.residuo(5, '{}', '{}', '{}'), '{}', 'sin partes no hay filas');
select is(pruebas.residuo(9000000000000000000, array[1, 2], array[9000000000000000000, 1]::bigint[], array[1, 2]::bigint[]),
  array['m1 8999999999999999999', 'm2 1'], 'montos que desbordarían un bigint, al centavo');
select throws_ok($$select pruebas.residuo(-1, array[1], array[1]::bigint[], array[1]::bigint[])$$, '22023', null, 'un total negativo no');
select throws_ok($$select pruebas.residuo(null, array[1], array[1]::bigint[], array[1]::bigint[])$$, '22023', null, 'ni nulo');
select throws_ok($$select pruebas.residuo(5, array[1, 2], array[1]::bigint[], array[1, 2]::bigint[])$$, '22023', null,
  'los tres arreglos del mismo largo');
select throws_ok($$select pruebas.residuo(5, array[1, 1], array[1, 1]::bigint[], array[1, 2]::bigint[])$$, '22023', null, 'un id una vez');
select throws_ok($$select pruebas.residuo(5, array[1, 2], array[1, 1]::bigint[], array[1, 1]::bigint[])$$, '22023', null, 'un orden una vez');
select throws_ok($$select pruebas.residuo(5, array[1, 2], array[1, 0]::bigint[], array[1, 2]::bigint[])$$, '22023', null, 'ningún peso cero');
select throws_ok($$select pruebas.residuo(5, array[1, 2], array[1, -1]::bigint[], array[1, 2]::bigint[])$$, '22023', null, 'ni negativo');
select throws_ok($$select pruebas.residuo(5, array[1, 2], array[1, null]::bigint[], array[1, 2]::bigint[])$$, '22023', null, 'ni nulo');
select throws_ok($$select pruebas.residuo(5, array[1, 2], array[1, 1]::bigint[], array[1, null]::bigint[])$$, '22023', null, 'ni un orden nulo');
select throws_ok($$select * from private.allocate_largest_remainder(5, array[null]::uuid[], array[1]::bigint[], array[1]::bigint[])$$,
  '22023', null, 'ni un id nulo');

-- ---------------------------------------------------------------------------------------
-- Los ejemplos del PRD (§6.3), al centavo.

select is(pruebas.reparto(6000, 0, array[pruebas.b(1, 28581)], array[pruebas.p(1, 1, 8), pruebas.p(1, 2, 5)]),
  array['pool a1 17148 base=28581 hp=13', 'share a1 m1 10553 hp=8', 'share a1 m2 6595 hp=5'],
  'ejemplo 1: el bote de A (171.48) da 105.53 a M1 y 65.95 a M2; el centavo, al mayor residuo');
select is(pruebas.reparto(6000, 0, array[pruebas.b(2, 28581)], array[pruebas.p(2, 2, 1)]),
  array['pool a2 17148 base=28581 hp=1', 'share a2 m2 17148 hp=1'],
  'ejemplo 2: B vio media lección de M2, que recibe los 171.48 completos');
select is(pruebas.reparto(6000, 0, array[pruebas.b(3, 20405)], array[pruebas.p(3, 1, 6), pruebas.p(3, 2, 2), pruebas.p(3, 3, 2)]),
  array['pool a3 12243 base=20405 hp=10', 'share a3 m1 7346 hp=6', 'share a3 m2 2449 hp=2', 'share a3 m3 2448 hp=2'],
  'ejemplo 3: el anual de C (122.43); el primer centavo a M1, el segundo a M2 por orden menor');
select is(pruebas.lineas(pruebas.prd()),
  array['pool a1 17148 base=28581 hp=13', 'pool a2 17148 base=28581 hp=1', 'pool a3 12243 base=20405 hp=10', 'pool a4 17148 base=28581 hp=0',
        'share a1 m1 10553 hp=8', 'share a1 m2 6595 hp=5', 'share a2 m2 17148 hp=1',
        'share a3 m1 7346 hp=6', 'share a3 m2 2449 hp=2', 'share a3 m3 2448 hp=2',
        'unconsumed m1 6595', 'unconsumed m2 9651', 'unconsumed m3 902'],
  'ejemplo 4: los 171.48 de D se reparten en proporción a lo asignado; el centavo, a M2');
select is(pruebas.totales(pruebas.prd()), array['m1 24494', 'm2 35843', 'm3 3350'],
  'el periodo: 244.94, 358.43 y 33.50');
select is((select sum(cents) from unnest(pruebas.prd()) where kind = 'student_pool')::bigint, 63687::bigint,
  'el bote del periodo, 636.87, igual a la suma de los totales');
select is(pruebas.reparto(6000, 0, array[pruebas.b(4, 28581), pruebas.b(3, 20405), pruebas.b(2, 28581), pruebas.b(1, 28581)],
                          array[pruebas.p(3, 3, 2), pruebas.p(2, 2, 1), pruebas.p(1, 2, 5), pruebas.p(3, 1, 6), pruebas.p(1, 1, 8), pruebas.p(3, 2, 2)]),
  pruebas.lineas(pruebas.prd()), 'el orden de la entrada no cambia nada, ni el de la salida');

-- ---------------------------------------------------------------------------------------
-- Los bordes.

select is(pruebas.reparto(6000, 0, '{}', '{}'), '{}', 'un periodo sin nadie: nada');
select is(pruebas.reparto(6000, 0, array[pruebas.b(4, 28581)], '{}'), array['pool a4 17148 base=28581 hp=0', 'carried 17148'],
  'nadie vio nada: el bote entero pasa al periodo siguiente (RN-06)');
select is(pruebas.reparto(6000, 500, '{}', '{}'), array['carried 500'], 'lo que llegó arrastrado, sin nadie, pasa otra vez');
select is(pruebas.reparto(6000, 500, array[pruebas.b(4, 100)], '{}'), array['pool a4 60 base=100 hp=0', 'carried 560'],
  'y sin asignado, pasa con el bote del periodo');
select is(pruebas.reparto(6000, 1000, array[pruebas.b(1, 28581)], array[pruebas.p(1, 1, 8), pruebas.p(1, 2, 5)]),
  array['pool a1 17148 base=28581 hp=13', 'share a1 m1 10553 hp=8', 'share a1 m2 6595 hp=5', 'unconsumed m1 615', 'unconsumed m2 385'],
  'con asignado, lo arrastrado se suma al sin consumo y sigue su regla');
select is(pruebas.reparto(6000, 0, array[pruebas.b(1, 28581)], array[pruebas.p(1, 1, 2), pruebas.p(9, 2, 4)]),
  array['pool a1 17148 base=28581 hp=2', 'share a1 m1 17148 hp=2'],
  'los puntos de un alumno sin base no cuentan: su maestro no recibe nada de él');
select is(pruebas.reparto(6000, 0, array[pruebas.b(4, 100)], array[pruebas.p(9, 1, 2)]), array['pool a4 60 base=100 hp=0', 'carried 60'],
  'con solo puntos sin base, no hay asignado: se arrastra todo');
select is(pruebas.reparto(6000, 0, array[pruebas.b(5, 1)], array[pruebas.p(5, 1, 2), pruebas.p(5, 2, 2)]),
  array['pool a5 0 base=1 hp=4', 'share a5 m1 0 hp=2', 'share a5 m2 0 hp=2'],
  'un bote de 0 centavos con puntos lleva sus partes de 0, con sus medios puntos (05 §8.6)');
select is(pruebas.reparto(6000, 0, array[pruebas.b(1, 28581), pruebas.b(4, 28581), pruebas.b(6, 2)],
                          array[pruebas.p(6, 1, 1), pruebas.p(6, 3, 1), pruebas.p(1, 2, 2)]),
  array['pool a1 17148 base=28581 hp=2', 'pool a4 17148 base=28581 hp=0', 'pool a6 1 base=2 hp=2',
        'share a1 m2 17148 hp=2', 'share a6 m1 1 hp=1', 'share a6 m3 0 hp=1', 'unconsumed m1 1', 'unconsumed m2 17147'],
  'un maestro con puntos y 0 asignado no entra al sin consumo (y no lanza)');
select is(pruebas.reparto(6000, 0, array[pruebas.b(1, 28581), pruebas.b(4, 28581)], array[pruebas.p(1, 1, 2)]),
  array['pool a1 17148 base=28581 hp=2', 'pool a4 17148 base=28581 hp=0', 'share a1 m1 17148 hp=2', 'unconsumed m1 17148'],
  'un solo maestro con asignado se lleva todo el sin consumo');
select is(pruebas.reparto(6000, 0, array[pruebas.b(1, 28581)], array[pruebas.p(1, 1, 2)]),
  array['pool a1 17148 base=28581 hp=2', 'share a1 m1 17148 hp=2'], 'sin bote sin consumo no hay línea de 0');
select is(pruebas.reparto(10000, 0, array[pruebas.b(1, 28581)], array[pruebas.p(1, 1, 2)]),
  array['pool a1 28581 base=28581 hp=2', 'share a1 m1 28581 hp=2'], 'con el bote al 100 %, la base entera');
select is(pruebas.reparto(1, 0, array[pruebas.b(1, 28581)], array[pruebas.p(1, 1, 2)]),
  array['pool a1 2 base=28581 hp=2', 'share a1 m1 2 hp=2'], 'con 0.01 %, hacia abajo (RN-03)');
select is(pruebas.reparto(6000, 0, array[pruebas.b(1, 9000000000000000000)], array[pruebas.p(1, 1, 1), pruebas.p(1, 2, 1)]),
  array['pool a1 5400000000000000000 base=9000000000000000000 hp=2', 'share a1 m1 2700000000000000000 hp=1', 'share a1 m2 2700000000000000000 hp=1'],
  'una base enorme no desborda');
select is(pruebas.totales(pruebas.calcula(6000, 0, array[pruebas.b(1, 28581), pruebas.b(2, 28581)], array[pruebas.p(1, 1, 2), pruebas.p(2, 1, 1)])),
  array['m1 34296'], 'un maestro con dos alumnos suma lo de los dos');
-- La cuenta falsa (RN-06): no le deja a su maestro más que su propio bote más una fracción del sin
-- consumo. Aquí M3 recibe 3 350 sin ella y la cuenta aporta 17 148.
-- U = 17 148 (D), A = 46 539 y la cuenta aporta p = 17 148: la ganancia de M3 es a lo más
-- p + piso(U × p ÷ (A + p)) más dos centavos de redondeo.
create function pruebas.total_de(p_lines private.payout_line[], p_teacher integer) returns bigint language sql stable
as $$ select coalesce(sum(l.cents), 0)::bigint from unnest(p_lines) l where l.kind in ('share', 'unconsumed_share') and l.teacher_id = pruebas.ma(p_teacher) $$;
select cmp_ok(pruebas.total_de(pruebas.calcula(6000, 0, pruebas.bases_prd() || pruebas.b(7, 28581), pruebas.puntos_prd() || pruebas.p(7, 3, 2)), 3)
              - pruebas.total_de(pruebas.prd(), 3),
  '<=', (17148 + div(17148 * 17148, 46539 + 17148) + 2)::bigint,
  'una cuenta falsa recupera a lo más su bote y una fracción del sin consumo (RN-06)');
select is(pruebas.total_de(pruebas.calcula(6000, 0, pruebas.bases_prd() || pruebas.b(7, 28581), pruebas.puntos_prd() || pruebas.p(7, 3, 2)), 3)
          - pruebas.total_de(pruebas.prd(), 3), 21522::bigint, 'aquí, 215.22: su bote de 171.48 y 43.74 del sin consumo');

-- Lo que no entra.
select throws_ok($$select pruebas.reparto(0, 0, '{}', '{}')$$, '22023', null, 'el porcentaje, de 1 a 10 000 puntos base');
select throws_ok($$select pruebas.reparto(10001, 0, '{}', '{}')$$, '22023', null, 'no más del 100 %');
select throws_ok($$select pruebas.reparto(null, 0, '{}', '{}')$$, '22023', null, 'ni nulo');
select throws_ok($$select pruebas.reparto(6000, -1, '{}', '{}')$$, '22023', null, 'lo arrastrado no es negativo');
select throws_ok($$select pruebas.reparto(6000, null, '{}', '{}')$$, '22023', null, 'ni nulo');
select throws_ok($$select pruebas.reparto(6000, 0, null, '{}')$$, '22023', null, 'las bases no son nulas');
select throws_ok($$select pruebas.reparto(6000, 0, '{}', null)$$, '22023', null, 'ni los puntos');
select throws_ok($$select pruebas.reparto(6000, 0, array[pruebas.b(1, 0)], '{}')$$, '22023', null, 'una base es positiva');
select throws_ok($$select pruebas.reparto(6000, 0, array[pruebas.b(1, -5)], '{}')$$, '22023', null, 'no negativa (los reversos los resta la entrada)');
select throws_ok($$select pruebas.reparto(6000, 0, array[pruebas.b(1, null)], '{}')$$, '22023', null, 'ni nula');
select throws_ok($$select pruebas.reparto(6000, 0, array[row(null, 5)::private.payout_base], '{}')$$, '22023', null, 'ni sin alumno');
select throws_ok($$select pruebas.reparto(6000, 0, array[pruebas.b(1, 5), pruebas.b(1, 6)], '{}')$$, '22023', null, 'un alumno una vez');
select throws_ok($$select pruebas.reparto(6000, 0, array[pruebas.b(1, 5)], array[pruebas.p(1, 1, 0)])$$, '22023', null,
  'los medios puntos son positivos');
select throws_ok($$select pruebas.reparto(6000, 0, array[pruebas.b(1, 5)], array[pruebas.p(1, 1, null)])$$, '22023', null, 'ni nulos');
select throws_ok($$select pruebas.reparto(6000, 0, array[pruebas.b(1, 5)], array[row(pruebas.al(1), null, 1, 2)::private.payout_points])$$,
  '22023', null, 'ni sin maestro');
select throws_ok($$select pruebas.reparto(6000, 0, array[pruebas.b(1, 5)], array[pruebas.p(1, 1, 2, null), row(pruebas.al(1), pruebas.ma(2), null, 2)::private.payout_points])$$,
  '22023', null, 'ni sin orden');
select throws_ok($$select pruebas.reparto(6000, 0, array[pruebas.b(1, 5)], array[pruebas.p(1, 1, 2), pruebas.p(1, 1, 3)])$$, '22023', null,
  'un par alumno y maestro una vez');
select throws_ok($$select pruebas.reparto(6000, 0, array[pruebas.b(1, 5), pruebas.b(2, 5)], array[pruebas.p(1, 1, 2, 1), pruebas.p(2, 1, 2, 7)])$$,
  '22023', null, 'un maestro con un solo orden');
select throws_ok($$select pruebas.reparto(6000, 0, array[pruebas.b(1, 5)], array[pruebas.p(1, 1, 2, 4), pruebas.p(1, 2, 2, 4)])$$,
  '22023', null, 'y un orden por maestro');

-- ---------------------------------------------------------------------------------------
-- La red (RNF-04): lo que no cuadra no sale.

select lives_ok($$select pruebas.revisa_lineas(0, pruebas.prd())$$, 'el reparto del PRD cuadra');
select throws_ok($$select pruebas.revisa_lineas(0, pruebas.altera(pruebas.prd(), 'unconsumed_share', 1, 1))$$, 'XX000', null,
  'un centavo de más no cuadra');
select throws_ok($$select pruebas.revisa_lineas(0, pruebas.altera(pruebas.altera(pruebas.prd(), 'share', 1, 1), 'unconsumed_share', 1, -1))$$,
  'XX000', null, 'ni un centavo movido de lo sin consumo a la parte de un alumno');
select throws_ok($$select pruebas.revisa_lineas(0, pruebas.sin(pruebas.prd(), 'share'))$$, 'XX000', null, 'ni una parte perdida');
select throws_ok($$select pruebas.revisa_lineas(0, pruebas.sin(pruebas.prd(), 'student_pool'))$$, 'XX000', null,
  'ni una parte sin el bote de su alumno');
select throws_ok($$select pruebas.revisa_lineas(0, pruebas.altera(pruebas.prd(), 'share', 1, 0, 1))$$, 'XX000', null,
  'ni medios puntos que no suman los del alumno');
select throws_ok($$select pruebas.revisa_lineas(1, pruebas.prd())$$, 'XX000', null, 'ni olvidar lo arrastrado');
select throws_ok($$select pruebas.revisa_lineas(0, pruebas.altera(pruebas.calcula(6000, 0, array[pruebas.b(4, 28581)], '{}'), 'carried_over', null, -100))$$,
  'XX000', null, 'ni un arrastre parcial');
select throws_ok($$select pruebas.revisa_lineas(0, pruebas.prd() || row('carried_over', null, null, null, 0, null, null)::private.payout_line)$$,
  'XX000', null, 'ni un arrastre junto al sin consumo');
select throws_ok($$select pruebas.revisa_lineas(0, pruebas.altera(pruebas.altera(pruebas.prd(), 'unconsumed_share', 1, -6596), 'unconsumed_share', 2, 6596))$$,
  'XX000', null, 'ni un monto negativo, aunque la suma cuadre');

-- ---------------------------------------------------------------------------------------
-- El porcentaje del bote, por periodo (`BOTE_PCT_BASE`, hasta los tramos de T-601).

create function pruebas.parametro(p_key text, p_value jsonb, p_period integer, p_from timestamptz default null) returns void
language sql as $$
  insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
  values (p_key, p_value, 'decided',
          coalesce(p_from, timezone('America/Mexico_City', to_date(p_period::text || '01', 'YYYYMMDD')::timestamp)), p_period)
$$;
-- Los parámetros los escribe el sistema, como la semilla.
select pruebas.como_dueno_sistema();
select is(private.pool_bps(202610), 6000, 'octubre de 2026: el 60 % de la semilla');
select is(private.pool_bps(202703), 6000, 'y los meses que siguen, mientras no cambie');
select throws_ok($$select private.pool_bps(202412)$$, 'P0001', null, 'un periodo sin porcentaje lanza');
select pruebas.parametro('BOTE_PCT_BASE', '5000', 202502);
select throws_ok($$select private.pool_bps(202502)$$, 'P0001', null, 'y sin la regla del sin consumo, también');
select pruebas.parametro('BOTE_SIN_CONSUMO', '"proportional_to_assigned_pool"', 202502);
select is(private.pool_bps(202502), 5000, 'el porcentaje es el de su periodo');
select is(private.pool_bps(202503), 5000, 'y rige en los siguientes');
select pruebas.parametro('BOTE_PCT_BASE', '10000', 202504);
select is(private.pool_bps(202504), 10000, 'hasta el 100 %');
select pruebas.parametro('BOTE_PCT_BASE', '1', 202505);
select is(private.pool_bps(202505), 1, 'desde 1 punto base');
select pruebas.parametro('BOTE_PCT_BASE', '0', 202506);
select throws_ok($$select private.pool_bps(202506)$$, 'P0001', null, 'cero no vale');
-- La tabla de parámetros ya rechaza lo que no es un número de puntos base; la función se defiende
-- igual, por si un día lo deja pasar.
alter table public.business_parameters disable trigger business_parameters_effective;
select pruebas.parametro('BOTE_PCT_BASE', '10001', 202507);
select pruebas.parametro('BOTE_PCT_BASE', '"6000"', 202508);
alter table public.business_parameters enable trigger business_parameters_effective;
select throws_ok($$select private.pool_bps(202507)$$, 'P0001', null, 'más del 100 % tampoco');
select throws_ok($$select private.pool_bps(202508)$$, 'P0001', null, 'ni un texto');
select pruebas.parametro('BOTE_PCT_BASE', '6000', 202509);
select pruebas.parametro('BOTE_SIN_CONSUMO', '"by_points"', 202509);
select throws_ok($$select private.pool_bps(202509)$$, 'P0001', null, 'otra regla del sin consumo lanza: no se adivina (PQ-06)');

-- ---------------------------------------------------------------------------------------
-- De punta a punta: el ejemplo del PRD desde sus cobros y su consolidado (05 §8.7).

select pruebas.alta(pruebas.al(n), format('alumno%s-reparto@prueba.test', n)) from generate_series(1, 5) n;
insert into etiquetas select pruebas.al(n), (array['A', 'B', 'C', 'D', 'E'])[n] from generate_series(1, 5) n;
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
select ('c0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, pruebas.al(n), 'manual', 'sus-reparto-' || n,
       case when n = 3 then 'annual' else 'monthly' end::public.subscription_plan, 'pending', 'MXN'
from generate_series(1, 5) n;
create function pruebas.cobra(p_n integer, p_at timestamptz, p_gross bigint) returns text language sql
as $$
  select private.record_charge(pruebas.al(p_n), ('c0000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid, 'manual',
                               'cobro-reparto-' || p_n || '-' || p_gross || '-' || extract(epoch from p_at)::bigint, null,
                               (select plan from public.subscriptions where profile_id = pruebas.al(p_n) limit 1),
                               p_at, 'MXN', p_gross, null, null, 'card', 'MX', null) ->> 'outcome'
$$;
create function pruebas.curso(p_slug text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', (
      select jsonb_agg(jsonb_build_object('title', t, 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'Asset' || p_slug || n, 'playback_id', 'Playback' || p_slug || n, 'duration_seconds', 100)) order by n)
      from unnest(array['Uno', 'Dos', 'Tres', 'Cuatro']) with ordinality as l (t, n)))))
$$;
create function pruebas.leccion(p_course text, p_title text) returns uuid
language sql as $$
  select l.id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id
  where c.slug = p_course and l.title = p_title
$$;
create function pruebas.fila(p_period integer, p_profile uuid, p_course text, p_title text, p_half_points integer) returns void
language sql as $$
  insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                   lesson_duration_seconds, covered_seconds, half_points)
  select p_period, p_profile, l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, 50 * p_half_points, p_half_points
  from public.published_lessons l where l.id = pruebas.leccion(p_course, p_title)
$$;
create function pruebas.en_periodo(p_period integer) returns text[] language sql stable
as $$ select pruebas.lineas(array(select l from private.payout_for_period(p_period, 0) l)) $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido-reparto@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-reparto@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
-- En este orden: el orden de M1, M2 y M3 decide el empate del ejemplo 3.
select private.system_load_course(private.system_add_teacher('Maestra ' || s, 'maestra-' || s, null), pruebas.curso(s))
from unnest(array['reparto-m1', 'reparto-m2', 'reparto-m3']) with ordinality as x (s, n) order by n;
select pruebas.limpiar();
select is(pruebas.pide('b0000000-0000-0000-0000-000000000001', format('private.approve_course(%L)', course_id)), 'approved',
  'se aprueba ' || slug) from public.published_courses where slug like 'reparto-m%' order by slug;
select pruebas.como_dueno();
insert into etiquetas select teacher_id, 'M' || right(slug, 1) from public.published_courses where slug like 'reparto-m%';
select is(array(select pruebas.et(t.id) from public.teachers t join public.published_courses c on c.teacher_id = t.id
                 where c.slug like 'reparto-m%' order by t.tiebreak_rank),
  array['M1', 'M2', 'M3'], 'M1, M2 y M3 quedaron en ese orden');

select is(array[pruebas.cobra(1, '2026-10-05 12:00-06', 34900), pruebas.cobra(2, '2026-10-06 12:00-06', 34900),
                pruebas.cobra(3, '2026-10-07 12:00-06', 299000), pruebas.cobra(4, '2026-10-08 12:00-06', 34900)],
  array['recorded', 'recorded', 'recorded', 'recorded'], 'los cuatro cobros del ejemplo');
select pruebas.fila(202610, pruebas.al(1), 'reparto-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres', 'Cuatro']) t;
select pruebas.fila(202610, pruebas.al(1), 'reparto-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(1), 'reparto-m2', 'Dos', 2),
       pruebas.fila(202610, pruebas.al(1), 'reparto-m2', 'Tres', 1);
select pruebas.fila(202610, pruebas.al(2), 'reparto-m2', 'Uno', 1);
select pruebas.fila(202610, pruebas.al(3), 'reparto-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres']) t;
select pruebas.fila(202610, pruebas.al(3), 'reparto-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(3), 'reparto-m3', 'Uno', 2);
-- Una fila con 0 medios puntos (vio menos del umbral) no entra.
select pruebas.fila(202610, pruebas.al(4), 'reparto-m3', 'Dos', 0);

select results_eq($$select pruebas.et(profile_id), base_cents from private.close_input_students(202610) order by 1$$,
  $$values ('A', 28581::bigint), ('B', 28581::bigint), ('C', 20405::bigint), ('D', 28581::bigint)$$,
  'la base de cada alumno sale de sus partes del periodo (el anual, 204.05)');
select results_eq($$select pruebas.et(profile_id), pruebas.et(teacher_id), half_points from private.close_input_points(202610) order by 1, 2$$,
  $$values ('A', 'M1', 8), ('A', 'M2', 5), ('B', 'M2', 1), ('C', 'M1', 6), ('C', 'M2', 2), ('C', 'M3', 2)$$,
  'los medios puntos, sumados por alumno y maestro, sin las filas en cero');
select is(pruebas.en_periodo(202610),
  array['pool A 17148 base=28581 hp=13', 'pool B 17148 base=28581 hp=1', 'pool C 12243 base=20405 hp=10', 'pool D 17148 base=28581 hp=0',
        'share A M1 10553 hp=8', 'share A M2 6595 hp=5', 'share B M2 17148 hp=1',
        'share C M1 7346 hp=6', 'share C M2 2449 hp=2', 'share C M3 2448 hp=2',
        'unconsumed M1 6595', 'unconsumed M2 9651', 'unconsumed M3 902'],
  'de punta a punta: los cobros y el consolidado dan el reparto del PRD, al centavo');
select is(pruebas.en_periodo(202611), array['pool C 12243 base=20405 hp=0', 'carried 12243'],
  'noviembre, sin consumo: el anual de C sigue aportando, y su bote pasa al siguiente');

-- Una cuenta suspendida por fraude: su consumo ya no está (T-208), y su bote va al sin consumo.
select pruebas.cobra(5, '2026-10-09 12:00-06', 34900);
select pruebas.fila(202610, pruebas.al(5), 'reparto-m3', 'Tres', 2);
select pruebas.como_dueno_sistema();
update public.profiles set suspended_for_fraud = true where id = pruebas.al(5);
select pruebas.como_dueno();
delete from public.watch_rollup where profile_id = pruebas.al(5);
select ok(exists (select 1 from private.close_input_students(202610) where profile_id = pruebas.al(5) and base_cents = 28581),
  'una cuenta suspendida por fraude conserva su base');
select is(pruebas.totales(array(select l from private.payout_for_period(202610, 0) l)), array['M1 31089', 'M2 45494', 'M3 4252'],
  'y su bote se reparte en proporción a lo asignado, como el de quien no vio nada (decisión de Sergio)');
select is((select sum(l.cents) from private.payout_for_period(202610, 250) l where l.kind in ('share', 'unconsumed_share'))::bigint,
  (63687 + 17148 + 250)::bigint, 'lo arrastrado entra por el argumento y se reparte con el sin consumo');

-- ---------------------------------------------------------------------------------------
-- El vigilante: el área del reparto (de este carril).

select ok(exists (select 1 from private.watchdog_areas() where function_name = 'schema_violations_payout' and unusable_reason is null),
  'el área del reparto está y se puede usar');
select is((select count(*)::integer from private.schema_violations()), 0, 'y no encuentra nada');
grant execute on function private.compute_payout(integer, bigint, private.payout_base[], private.payout_points[]) to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'payout function executable by app_service'
                  and object_name like 'private.compute_payout(%'), 've el cálculo ejecutable por el servidor');
revoke execute on function private.compute_payout(integer, bigint, private.payout_base[], private.payout_points[]) from app_service;
grant execute on function private.payout_for_period(public.period_id, bigint) to anon;
select ok(exists (select 1 from private.schema_violations() where problem = 'payout function executable by anon'),
  've la entrada armada ejecutable por un visitante');
revoke execute on function private.payout_for_period(public.period_id, bigint) from anon;
alter function private.close_input_students(public.period_id) security definer;
select ok(exists (select 1 from private.schema_violations() where problem = 'payout function security definer or without fixed search_path'
                  and object_name like 'private.close_input_students(%'), 've una función del reparto como `security definer`');
alter function private.close_input_students(public.period_id) security invoker;
alter function private.pool_bps(public.period_id) reset search_path;
select ok(exists (select 1 from private.schema_violations() where problem = 'payout function security definer or without fixed search_path'
                  and object_name like 'private.pool_bps(%'), 've una sin `search_path` fijo');
alter function private.pool_bps(public.period_id) set search_path = '';
alter function private.check_payout_lines(bigint, private.payout_line[]) stable;
select ok(exists (select 1 from private.schema_violations() where problem = 'payout function not immutable'
                  and object_name like 'private.check_payout_lines(%'), 've la red como si leyera tablas');
alter function private.check_payout_lines(bigint, private.payout_line[]) immutable;
alter function private.close_input_points(public.period_id) rename to close_input_points_renombrada;
select ok(exists (select 1 from private.schema_violations() where problem = 'payout function missing'
                  and object_name = 'private.close_input_points'), 've una función del reparto que falta');
alter function private.close_input_points_renombrada(public.period_id) rename to close_input_points;
select is((select count(*)::integer from private.schema_violations()), 0, 'todo en su lugar, nada');

select * from finish();
rollback;
