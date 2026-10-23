-- T-407 · La alerta del bote sin consumo (RF-406) y el reparto con periodos al azar (RF-502,
-- RN-05 a RN-07, RNF-04; TRD §5.4). Decisiones de Sergio del 2026-10-23: el reparto vive en la
-- base, y la alerta que T-208 dejó esperando entra con él.
--
-- La alerta mira el mes que terminó, así que esta parte usa periodos relativos a hoy, con sus
-- parámetros escritos aquí como el dueño. Los periodos al azar no tocan tablas: van directo a
-- `private.compute_payout()` y comprueban sus invariantes con un oráculo en enteros.
begin;
\ir _ayuda.psql
set constraints all immediate;
select plan(24);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a0000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.ma(p_n integer) returns uuid language sql immutable
as $$ select ('f0000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.periodo(p_months_back integer default 0) returns integer
language sql stable as $$
  select to_char(date_trunc('month', timezone('America/Mexico_City', now())) - make_interval(months => p_months_back), 'YYYYMM')::integer
$$;
create function pruebas.inicio(p_period integer) returns timestamptz
language sql stable as $$ select timezone('America/Mexico_City', to_date(p_period::text || '01', 'YYYYMMDD')::timestamp) $$;
create function pruebas.parametro(p_key text, p_value jsonb, p_period integer, p_from timestamptz default null) returns void
language sql as $$
  insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
  values (p_key, p_value, 'decided',
          coalesce(p_from, timezone('America/Mexico_City', to_date(p_period::text || '01', 'YYYYMMDD')::timestamp)), p_period)
$$;
create function pruebas.cobra(p_n integer, p_at timestamptz, p_gross bigint) returns text language sql
as $$
  select private.record_charge(pruebas.al(p_n), ('c0000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid, 'manual',
                               'cobro-alerta-' || p_n || '-' || p_gross, null, 'monthly', p_at, 'MXN', p_gross,
                               null, null, 'card', 'MX', null) ->> 'outcome'
$$;
create function pruebas.curso(p_slug text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', jsonb_build_array(
      jsonb_build_object('title', 'Uno', 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'Asset' || p_slug, 'playback_id', 'Playback' || p_slug, 'duration_seconds', 100))))))
$$;
create function pruebas.sin_consumo(p_period integer) returns public.anomaly_alerts
language sql as $$ select * from public.anomaly_alerts where period_id = p_period and kind = 'unconsumed_pool_ratio' $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- La alerta del bote sin consumo (RF-406): solo el mes que terminó, una vez por periodo.

select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido-alerta@prueba.test');
select pruebas.alta(pruebas.al(n), format('alumno%s-alerta@prueba.test', n)) from generate_series(11, 14) n;
select pruebas.confirmar(id) from auth.users where email like '%-alerta@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra alerta', 'maestra-alerta', null), pruebas.curso('alerta-m1'));
select pruebas.limpiar();
select is(pruebas.pide('b0000000-0000-0000-0000-000000000001', format('private.approve_course(%L)', course_id)), 'approved',
  'se aprueba el curso') from public.published_courses where slug = 'alerta-m1';
select pruebas.como_dueno();
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
select ('c0000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, pruebas.al(n), 'manual', 'sus-alerta-' || n, 'monthly', 'pending', 'MXN'
from generate_series(11, 14) n;

-- Un mes sin bases no abre nada, ni falla: ni siquiera busca el porcentaje, que en un mes anterior al
-- arranque no existe (aquí, todavía sin los parámetros de abajo).
select is(private.detect_anomalies(pruebas.periodo(1), now() + interval '90 minutes'), '{"alerts_opened": 0}'::jsonb,
  'un mes sin bases no abre nada, ni falla');

-- El mes que terminó puede ser anterior al arranque: sus reglas, con los valores de la semilla.
select pruebas.como_dueno_sistema();
select pruebas.parametro(k, v, pruebas.periodo(2))
from (values ('IVA_EN_PRECIO', 'true'::jsonb), ('IVA_PCT', '1600'), ('COMISION_COBRO_PCT', '500'), ('BASE_COMISION', '"fixed_rate"'),
             ('INGRESO_POR_PERIODO', '"monthly_when_charged_annual_in_twelfths"'), ('BOTE_PCT_BASE', '6000'),
             ('BOTE_SIN_CONSUMO', '"proportional_to_assigned_pool"'), ('VELOCIDAD_MAX', '"2"')) as x (k, v)
where pruebas.periodo(2) < 202610;
-- El umbral se lee al detectar (no afecta al reparto): versiones en el futuro, para que la de la
-- semilla no estorbe; y una que no vale al empezar el mes que terminó.
select pruebas.parametro('ALERTA_SIN_CONSUMO_PCT', '0', null, pruebas.inicio(pruebas.periodo(1)) + interval '5 seconds');
select pruebas.parametro('ALERTA_SIN_CONSUMO_PCT', '5000', null, now() + interval '1 hour');
select pruebas.parametro('ALERTA_SIN_CONSUMO_PCT', '5001', null, now() + interval '2 hours');
select pruebas.parametro('ALERTA_SIN_CONSUMO_PCT', '4999', null, now() + interval '3 hours');

-- La cuenta 11 terminó la lección de M1 en el mes; la 12 y la 13 no vieron nada.
insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                 lesson_duration_seconds, covered_seconds, half_points)
select pruebas.periodo(1), pruebas.al(11), l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, 100, 2
from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug = 'alerta-m1';

select is(pruebas.cobra(13, pruebas.inicio(pruebas.periodo(1)) + interval '2 days', 2), 'recorded', 'un cobro de 2 centavos: base 1, bote 0');
select is(private.detect_anomalies(pruebas.periodo(1), now() + interval '90 minutes'), '{"alerts_opened": 0}'::jsonb,
  'con el bote en 0 no hay proporción: nada, sin dividir entre cero');
select is(array[pruebas.cobra(11, pruebas.inicio(pruebas.periodo(1)) + interval '3 days', 34900),
                pruebas.cobra(12, pruebas.inicio(pruebas.periodo(1)) + interval '4 days', 34900)],
  array['recorded', 'recorded'], 'dos mensuales: la mitad del bote sin consumo');
select ok((select r ? 'anomalies_failed' and (r ->> 'alerts_opened')::integer = 1
           from private.detect_anomalies(pruebas.periodo(1), pruebas.inicio(pruebas.periodo(1)) + interval '10 seconds') r),
  'sin un umbral que valga, la alerta falla y lo dice, y la de lecciones imposibles sí se abre');
select ok(exists (select 1 from public.anomaly_alerts where period_id = pruebas.periodo(1) and kind = 'impossible_completion'
                  and profile_id = pruebas.al(11)), 'la otra alerta quedó');
select is((pruebas.sin_consumo(pruebas.periodo(1))).id, null, 'la del sin consumo no');
select is(private.detect_anomalies(pruebas.periodo(1), now() + interval '90 minutes'), '{"alerts_opened": 0}'::jsonb,
  'en el umbral (50 %) no se abre');
select is(private.detect_anomalies(pruebas.periodo(1), now() + interval '150 minutes'), '{"alerts_opened": 0}'::jsonb, 'debajo tampoco');
select is(private.detect_anomalies(pruebas.periodo(1), now() + interval '210 minutes'), '{"alerts_opened": 1}'::jsonb, 'arriba, sí');
select is(((pruebas.sin_consumo(pruebas.periodo(1))).metric_value, (pruebas.sin_consumo(pruebas.periodo(1))).threshold_value,
           (pruebas.sin_consumo(pruebas.periodo(1))).teacher_id, (pruebas.sin_consumo(pruebas.periodo(1))).profile_id)::text,
  '(5000.000,4999,,)', 'la proporción en puntos base y el umbral, sin señalar a nadie');
select is((pruebas.sin_consumo(pruebas.periodo(1))).details,
  '{"pool_cents": 34296, "assigned_cents": 17148, "unconsumed_cents": 17148, "pool_bps": 6000, "students": 3, "students_without_points": 2}'::jsonb,
  'con sus cifras: el bote, lo asignado, lo sin consumo, el porcentaje y los alumnos');
select is(private.detect_anomalies(pruebas.periodo(1), now() + interval '210 minutes'), '{"alerts_opened": 0}'::jsonb,
  'una vez por periodo');
select is(pruebas.cobra(14, now() - interval '1 second', 34900), 'recorded', 'un cobro de este mes, sin consumo');
select is(private.detect_anomalies(pruebas.periodo(0), now() + interval '210 minutes'), '{"alerts_opened": 0}'::jsonb,
  'el mes en curso no se mira: a medio mes casi todo el bote está sin consumo');
select is((pruebas.sin_consumo(pruebas.periodo(0))).id, null, 'ninguna alerta del mes en curso');

-- ---------------------------------------------------------------------------------------
-- Periodos al azar (semilla fija): los invariantes del TRD §5.4 y la caracterización de RN-07,
-- con un oráculo en enteros que no usa la implementación.

-- Lo que falla de un reparto: el nombre de cada invariante que no se cumple.
create function pruebas.fallas(p_bps integer, p_carried bigint, p_bases private.payout_base[], p_points private.payout_points[])
returns text[] language sql stable
as $$
  with l as (select * from private.compute_payout(p_bps, p_carried, p_bases, p_points)),
  b as (select * from unnest(p_bases)),
  pt as (select x.* from unnest(p_points) x join b on b.profile_id = x.profile_id),
  pool as (select * from l where kind = 'student_pool'),
  sh as (select * from l where kind = 'share'),
  un as (select * from l where kind = 'unconsumed_share'),
  co as (select * from l where kind = 'carried_over'),
  -- El bote de cada alumno: hacia abajo, con su base y sus medios puntos.
  bad_pool as (
    select 1 from b full join pool on pool.profile_id = b.profile_id
    where pool.profile_id is null or b.profile_id is null
       or pool.cents <> div(b.base_cents::numeric * p_bps, 10000)
       or pool.base_cents <> b.base_cents
       or pool.half_points <> coalesce((select sum(pt.half_points) from pt where pt.profile_id = b.profile_id), 0)),
  -- Cada par con base tiene su parte, y nada más.
  bad_pairs as (
    select 1 from pt full join sh on sh.profile_id = pt.profile_id and sh.teacher_id = pt.teacher_id
    where sh.profile_id is null or pt.profile_id is null or sh.half_points <> pt.half_points or sh.tiebreak_rank <> pt.tiebreak_rank),
  -- RN-07 dentro de cada alumno: piso o piso más uno, y el centavo extra al mayor residuo.
  sh_x as (
    select sh.*, div(pool.cents::numeric * sh.half_points, pool.half_points) as f,
           mod(pool.cents::numeric * sh.half_points, pool.half_points) as r
    from sh join pool on pool.profile_id = sh.profile_id),
  bad_share_bounds as (select 1 from sh_x where cents - f not in (0, 1)),
  bad_share_order as (
    select 1 from sh_x g join sh_x n on n.profile_id = g.profile_id and g.cents - g.f = 1 and n.cents - n.f = 0
    where n.r > g.r or (n.r = g.r and n.tiebreak_rank < g.tiebreak_rank)),
  bad_student_sum as (
    select 1 from pool where pool.half_points > 0
      and pool.cents <> coalesce((select sum(sh.cents) from sh where sh.profile_id = pool.profile_id), 0)),
  -- RN-06: el sin consumo, en proporción a lo asignado, con el mismo redondeo.
  assigned as (select teacher_id, min(tiebreak_rank) as tiebreak_rank, sum(cents) as cents from sh group by teacher_id),
  totals as (
    select (select coalesce(sum(cents), 0) from assigned) as a,
           (select coalesce(sum(cents), 0) from pool where half_points = 0) + p_carried as u,
           (select coalesce(sum(cents), 0) from pool) + p_carried as total),
  un_x as (
    select a.teacher_id, a.tiebreak_rank, coalesce(un.cents, 0) as cents,
           div(t.u::numeric * a.cents, t.a) as f, mod(t.u::numeric * a.cents, t.a) as r
    from assigned a cross join totals t left join un on un.teacher_id = a.teacher_id
    where a.cents > 0 and t.a > 0),
  bad_unconsumed_bounds as (select 1 from un_x where cents - f not in (0, 1)),
  bad_unconsumed_order as (
    select 1 from un_x g join un_x n on g.cents - g.f = 1 and n.cents - n.f = 0
    where n.r > g.r or (n.r = g.r and n.tiebreak_rank < g.tiebreak_rank)),
  bad_unconsumed_who as (
    select 1 from un where un.cents <= 0
       or not exists (select 1 from assigned a where a.teacher_id = un.teacher_id and a.cents > 0)),
  bad_carry as (
    select 1 from totals t
    where (t.a > 0 and exists (select 1 from co))
       or (t.a = 0 and t.total > 0 and (select coalesce(sum(cents), -1) from co) <> t.total)
       or (t.a = 0 and t.total = 0 and exists (select 1 from co))
       or (t.a = 0 and exists (select 1 from un))
       or (select count(*) from co) > 1),
  bad_balance as (
    select 1 from totals t
    where t.total <> (select coalesce(sum(cents), 0) from l where kind in ('share', 'unconsumed_share', 'carried_over')))
  select array_remove(array[
    case when exists (select 1 from bad_pool) then 'bote del alumno' end,
    case when exists (select 1 from bad_pairs) then 'pares' end,
    case when exists (select 1 from bad_share_bounds) then 'piso de las partes' end,
    case when exists (select 1 from bad_share_order) then 'residuo de las partes' end,
    case when exists (select 1 from bad_student_sum) then 'suma por alumno' end,
    case when exists (select 1 from bad_unconsumed_bounds) then 'piso del sin consumo' end,
    case when exists (select 1 from bad_unconsumed_order) then 'residuo del sin consumo' end,
    case when exists (select 1 from bad_unconsumed_who) then 'quién recibe el sin consumo' end,
    case when exists (select 1 from bad_carry) then 'arrastre' end,
    case when exists (select 1 from bad_balance) then 'suma del bote' end], null)
$$;

-- Un periodo al azar: hasta 12 alumnos (algunos sin base, con puntos), hasta 6 maestros con un
-- orden al azar, bases chicas y a veces enormes, medios puntos de 1 a 20, porcentaje y arrastre al
-- azar.
create temporary table azar (i integer primary key, bps integer, carried bigint, bases private.payout_base[], points private.payout_points[]);
select setseed(0.407);
do $$
declare
  v_students integer;
  v_teachers integer;
  v_ranks bigint[];
  v_bases private.payout_base[];
  v_points private.payout_points[];
begin
  for i in 1 .. 3000 loop
    v_students := floor(random() * 13)::integer;
    v_teachers := 1 + floor(random() * 6)::integer;
    v_ranks := array(select (1 + floor(random() * 1000000))::bigint * 10 + n from generate_series(1, v_teachers) n order by random());
    v_bases := array(
      select row(pruebas.al(s), case when random() < 0.05 then (1 + floor(random() * 1e15))::bigint
                                     else (1 + floor(random() * case when random() < 0.3 then 50 else 300000 end))::bigint end)::private.payout_base
      from generate_series(1, v_students) s where random() < 0.85);
    v_points := array(
      select row(pruebas.al(s), pruebas.ma(t), v_ranks[t], 1 + floor(random() * 20)::integer)::private.payout_points
      from generate_series(1, v_students + 2) s, generate_series(1, v_teachers) t where random() < 0.35);
    insert into azar values (i, case when random() < 0.1 then 10000 when random() < 0.1 then 1 else 1 + floor(random() * 10000)::integer end,
                             case when random() < 0.7 then 0 else floor(random() * 1000000)::bigint end, v_bases, v_points);
  end loop;
end
$$;

select cmp_ok((select count(*)::integer from azar a
               where exists (select 1 from unnest(a.bases) b where not exists (select 1 from unnest(a.points) p where p.profile_id = b.profile_id))
                 and exists (select 1 from unnest(a.points) p join unnest(a.bases) b on b.profile_id = p.profile_id)), '>', 600,
  'y muchos con sin consumo y con asignado a la vez');
select cmp_ok((select count(*)::integer from azar a
               where not exists (select 1 from unnest(a.points) p join unnest(a.bases) b on b.profile_id = p.profile_id)
                 and cardinality(a.bases) > 0), '>', 40, 'y algunos donde nadie con base tuvo puntos');
select is((select count(*)::integer from azar a, unnest(pruebas.fallas(a.bps, a.carried, a.bases, a.points)) f), 0,
  'tres mil periodos al azar: ningún invariante falla');
select is((select array_agg(distinct f) from azar a, unnest(pruebas.fallas(a.bps, a.carried, a.bases, a.points)) f), null,
  'ni uno solo, ni el bote, ni los pares, ni el piso, ni el residuo, ni el arrastre, ni la suma');
select is((select count(*)::integer from azar a
           where array(select l from private.compute_payout(a.bps, a.carried, a.bases, a.points) l)
                 is distinct from array(select l from private.compute_payout(
                   a.bps, a.carried,
                   array(select x from unnest(a.bases) with ordinality as u (profile_id, base_cents, o)
                         cross join lateral (select row(u.profile_id, u.base_cents)::private.payout_base as x) y order by u.o desc),
                   array(select x from unnest(a.points) with ordinality as u (profile_id, teacher_id, tiebreak_rank, half_points, o)
                         cross join lateral (select row(u.profile_id, u.teacher_id, u.tiebreak_rank, u.half_points)::private.payout_points as x) y
                         order by u.o desc)) l)), 0,
  'el orden de la entrada no cambia la salida, ni su orden');

-- La cuenta falsa (RN-06): una cuenta que solo ve a un maestro le deja a lo más su propio bote más
-- piso(U × p ÷ (A + p)) y dos centavos de redondeo, donde U es el sin consumo, A lo asignado y p su bote.
create function pruebas.total_de(p_lines private.payout_line[], p_teacher uuid) returns numeric language sql stable
as $$ select coalesce(sum(l.cents), 0) from unnest(p_lines) l where l.kind in ('share', 'unconsumed_share') and l.teacher_id = p_teacher $$;
create function pruebas.calcula(p_bps integer, p_carried bigint, p_bases private.payout_base[], p_points private.payout_points[])
returns private.payout_line[] language sql stable
as $$ select coalesce(array_agg(l), '{}') from private.compute_payout(p_bps, p_carried, p_bases, p_points) as l $$;
create temporary table falsas as
select a.i, a.bps, a.carried, a.bases, a.points, x.teacher_id, x.tiebreak_rank,
       (1 + floor(random() * 300000))::bigint as fake_base
from azar a
cross join lateral (select p.teacher_id, p.tiebreak_rank from unnest(a.points) p join unnest(a.bases) b on b.profile_id = p.profile_id
                    order by random() limit 1) x
where a.i <= 1000;
select cmp_ok((select count(*)::integer from falsas), '>', 600, 'cientos de periodos con una cuenta falsa');
select is((select count(*)::integer from falsas f
           cross join lateral (select pruebas.calcula(f.bps, f.carried, f.bases, f.points) as sin,
                                      pruebas.calcula(f.bps, f.carried, f.bases || row(pruebas.al(99), f.fake_base)::private.payout_base,
                                                      f.points || row(pruebas.al(99), f.teacher_id, f.tiebreak_rank, 2)::private.payout_points) as con) c
           cross join lateral (select div(f.fake_base::numeric * f.bps, 10000) as p,
                                      (select coalesce(sum(l.cents), 0) from unnest(c.sin) l where l.kind = 'share') as a,
                                      (select coalesce(sum(l.cents), 0) from unnest(c.sin) l where l.kind = 'student_pool' and l.half_points = 0) + f.carried as u) m
           where m.a > 0
             and pruebas.total_de(c.con, f.teacher_id) - pruebas.total_de(c.sin, f.teacher_id) > m.p + div(m.u * m.p, m.a + m.p) + 2), 0,
  'una cuenta falsa nunca recupera más que su bote y su fracción del sin consumo');

select * from finish();
rollback;
