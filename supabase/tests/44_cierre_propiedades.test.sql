-- T-602 · El cierre con periodos al azar (RF-502, RNF-04, RN-06; 05 §8.6). Cada ronda cobra al azar en
-- octubre de 2026 (anuales que se reparten en doce meses y mensuales), consume al azar en cada uno de
-- esos doce meses (a veces nadie, y entonces todo pasa al siguiente), y los ensaya y los cierra en
-- orden, con un porcentaje al azar en cada foto. De cada periodo cerrado se exige:
--   · lo escrito es exactamente lo que devuelve `private.payout_for_period()` con lo que recibió;
--   · lo que recibió es lo que pasó el anterior;
--   · el ensayo y el cierre dan la misma huella, de la entrada y del resultado;
--   · RNF-04: lo que reciben los maestros más lo que pasa al siguiente es el bote, al centavo (la
--     comprobación al confirmar se adelanta después de cada cierre, y también lo exige);
--   · desde T-603, cada maestro con total tiene su liquidación por ese total, y el bono del fundador es
--     el piso del total por el multiplicador menos uno dentro de su ventana, y nada fuera de ella (con
--     fundadores, fechas y regla al azar en cada ronda).
-- Cada ronda se deshace al terminar (con una excepción atrapada): lo que se mide vive en variables.
-- Los meses van forzados (abierto, en cierre): la prueba no depende del día en que corre.
begin;
\ir _ayuda.psql
select plan(9);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a6020000-0000-0000-0000-' || lpad((440 + p_n)::text, 12, '0'))::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b6020000-0000-0000-0000-000000000044'::uuid $$;
create function pruebas.como_finanzas() returns void language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', pruebas.finanzas()::text, true),
         set_config('app.actor_session', pruebas.sesion(pruebas.finanzas())::text, true);
$$;
create function pruebas.forzar(p_period integer, p_status text, p_students integer default null, p_bps integer default null) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(p_period);
  alter table public.payout_periods disable trigger payout_periods_guard;
  update public.payout_periods set status = p_status::public.period_status,
         entered_closing_at = case when p_status = 'open' then null else now() - interval '2 days' end,
         active_students = p_students, pool_bps = p_bps
  where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard;
  perform pruebas.como_dueno();
end
$$;
create function pruebas.curso(p_slug text) returns jsonb language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', (
      select jsonb_agg(jsonb_build_object('title', t, 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'Asset' || p_slug || n, 'playback_id', 'Playback' || p_slug || n, 'duration_seconds', 100)) order by n)
      from unnest(array['Uno', 'Dos', 'Tres']) with ordinality as l (t, n)))))
$$;
-- Las líneas que quedaron escritas de un periodo cerrado, en la forma y el orden de las del reparto.
create function pruebas.escritas(p_period integer) returns text[] language sql stable as $$
  select array(
    select l::text from (
      select row('student_pool', s.profile_id, null, null, s.pool_cents, s.base_cents, s.half_points)::private.payout_line as l,
             1 as k, s.profile_id as a, null::bigint as b
      from public.payout_student_pools s where s.period_id = p_period
      union all
      select row('share', s.profile_id, s.teacher_id, t.tiebreak_rank, s.amount_cents, null, s.half_points)::private.payout_line,
             2, s.profile_id, t.tiebreak_rank
      from public.payout_shares s join public.teachers t on t.id = s.teacher_id where s.period_id = p_period
      union all
      select row('unconsumed_share', null, x.teacher_id, t.tiebreak_rank, x.unconsumed_cents, null, null)::private.payout_line,
             3, null, t.tiebreak_rank
      from public.payout_teacher_totals x join public.teachers t on t.id = x.teacher_id
      where x.period_id = p_period and x.unconsumed_cents > 0
      union all
      select row('carried_over', null, null, null, p.carried_out_cents, null, null)::private.payout_line, 4, null, null
      from public.payout_periods p where p.period_id = p_period and p.carried_out_cents > 0) x
    order by x.k, x.a nulls first, x.b nulls first)
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;
-- Las corridas que el `pg_cron` de la base local haya dejado de estos meses no cuentan aquí.
delete from public.job_runs where period_id between 202610 and 202709;

-- Ocho alumnos (los impares anuales), finanzas y cuatro maestros con tres lecciones cada uno.
select pruebas.alta(pruebas.al(n), format('alumno%s-cierre-azar@prueba.test', n)) from generate_series(1, 8) n;
select pruebas.alta(pruebas.finanzas(), 'finanzas-cierre-azar@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-cierre-azar@prueba.test';
select pruebas.dar_capacidad(pruebas.finanzas(), 'finance');
select pruebas.equipar(pruebas.finanzas());
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra ' || s, 'maestra-' || s, null), pruebas.curso(s))
from unnest(array['azar-m1', 'azar-m2', 'azar-m3', 'azar-m4']) with ordinality as x (s, n) order by n;
select pruebas.como_dueno();
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
select ('c6020000-0000-0000-0000-' || lpad((440 + n)::text, 12, '0'))::uuid, pruebas.al(n), 'manual', 'sus-cierre-azar-' || n,
       case when n % 2 = 1 then 'annual' else 'monthly' end::public.subscription_plan, 'pending', 'MXN'
from generate_series(1, 8) n;
create temporary table lecciones as
  select row_number() over (order by c.slug, l.title) as n, l.id, l.course_id, l.teacher_id, l.video_asset_id
  from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug like 'azar-m%';
select is((select count(*)::integer from lecciones), 12, 'doce lecciones de cuatro maestros');

create temporary table resultado (ronda integer, periodo integer, problema text);
create temporary table cuenta (ronda integer, periodo integer, arrastre boolean, sin_consumo boolean, bonos integer);
select setseed(0.602);

do $$
declare
  v_round integer;
  v_period integer;
  v_periods integer[] := array(select (to_char(date '2026-10-01' + make_interval(months => m), 'YYYYMM'))::integer from generate_series(0, 11) m);
  v_r jsonb;
  v_c jsonb;
  v_problems text[];
  v_seen text[];
  v_previous_out bigint;
  v_row public.payout_periods;
  v_bps integer;
  v_months integer;
begin
  for v_round in 1..15 loop
    v_problems := '{}';
    v_seen := '{}';
    begin
      perform pruebas.forzar(202610, 'open');
      -- Los fundadores, sus fechas y la regla, al azar (T-603).
      v_bps := 1 + floor(random() * 5000)::integer;
      v_months := 1 + floor(random() * 36)::integer;
      perform pruebas.como_dueno_sistema();
      update public.teachers t set is_founder = f.founder, founder_since = case when f.founder then f.since end
      from (select l.teacher_id, random() < 0.6 as founder, date '2024-06-01' + floor(random() * 970)::integer as since
            from (select distinct teacher_id from lecciones) l) f
      where t.id = f.teacher_id;
      insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
      values ('FUNDADOR_MULTIPLICADOR', jsonb_build_object('multiplier', ((10000 + v_bps)::numeric / 10000)::text, 'months', v_months),
              'decided', now() - interval '1 second', 202610);
      perform pruebas.como_dueno();
      -- Los cobros: casi todos cobran, con montos chicos, medianos y a veces enormes.
      perform private.record_charge(pruebas.al(n), ('c6020000-0000-0000-0000-' || lpad((440 + n)::text, 12, '0'))::uuid, 'manual',
                                    'cobro-azar-' || v_round || '-' || n, null,
                                    case when n % 2 = 1 then 'annual' else 'monthly' end::public.subscription_plan,
                                    timestamptz '2026-10-05 12:00-06' + make_interval(hours => n), 'MXN',
                                    case when random() < 0.05 then 1 + floor(random() * 1000000000)::bigint
                                         when random() < 0.2 then 1 + floor(random() * 300)::bigint
                                         else 1000 + floor(random() * 3000000)::bigint end,
                                    null, null, 'card', 'MX', null)
      from generate_series(1, 8) n where random() < 0.85;
      -- El consumo de cada mes: a veces nadie.
      foreach v_period in array v_periods loop
        perform pruebas.forzar(v_period, 'open');
        if random() < 0.75 then
          insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                           lesson_duration_seconds, covered_seconds, half_points)
          select v_period, pruebas.al(s), l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, 100, 1 + floor(random() * 2)::integer
          from generate_series(1, 8) s cross join lecciones l
          where random() < 0.2;
        end if;
      end loop;

      -- En orden: la foto con un porcentaje al azar, el recálculo completo, el ensayo y el cierre.
      foreach v_period in array v_periods loop
        perform pruebas.forzar(v_period, 'closing', floor(random() * 5000)::integer,
                               case when random() < 0.1 then 10000 when random() < 0.1 then 1 else 1 + floor(random() * 10000)::integer end);
        insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
        values ('nightly_rollup', v_period, 'succeeded', now() - interval '1 hour', now() - interval '1 hour', now() - interval '59 minutes',
                '{"mode": "full"}');
        perform pruebas.como_finanzas();
        v_r := private.rehearse_close(v_period);
        v_c := private.close_period(v_period);
        set constraints payout_periods_balanced immediate;
        set constraints payout_periods_balanced deferred;
        perform pruebas.como_dueno();
        if v_c ->> 'outcome' is distinct from 'closed' then
          v_problems := v_problems || format('%s no cerró: %s / %s', v_period, v_r, v_c);
          exit;
        end if;
        select * into v_row from public.payout_periods p where p.period_id = v_period;
        if pruebas.escritas(v_period) is distinct from array(select l::text from private.payout_for_period(v_period, v_row.carried_in_cents) l) then
          v_problems := v_problems || format('%s: lo escrito no es el reparto', v_period);
        end if;
        if v_period > 202610 and v_row.carried_in_cents is distinct from v_previous_out then
          v_problems := v_problems || format('%s: recibió %s y el anterior pasó %s', v_period, v_row.carried_in_cents, v_previous_out);
        end if;
        if (v_r ->> 'input_hash', v_r ->> 'result_hash') is distinct from (v_c ->> 'input_hash', v_c ->> 'result_hash') then
          v_problems := v_problems || format('%s: el ensayo y el cierre no dan la misma huella', v_period);
        end if;
        if (select coalesce(sum(t.total_cents), 0) from public.payout_teacher_totals t where t.period_id = v_period) + v_row.carried_out_cents
           <> v_row.pool_cents then
          v_problems := v_problems || format('%s: no cuadra (RNF-04)', v_period);
        end if;
        if (select count(*) from public.payouts y where y.period_id = v_period)
             <> (select count(*) from public.payout_teacher_totals t where t.period_id = v_period)
           or exists (select 1 from public.payout_teacher_totals t
                      left join public.payouts y on y.period_id = t.period_id and y.teacher_id = t.teacher_id
                      where t.period_id = v_period and (y.id is null or y.pool_cents <> t.total_cents or y.status <> 'calculated')) then
          v_problems := v_problems || format('%s: las liquidaciones no son los totales', v_period);
        end if;
        if exists (select 1 from public.payout_teacher_totals t join public.teachers m on m.id = t.teacher_id
                   left join public.bonuses b on b.period_id = t.period_id and b.teacher_id = t.teacher_id and b.kind = 'founder'
                   where t.period_id = v_period
                     and coalesce(b.amount_cents, 0) <> case
                       when m.is_founder and ((v_period / 100) * 12 + v_period % 100)
                                             - (extract(year from m.founder_since)::integer * 12 + extract(month from m.founder_since)::integer)
                                             between 0 and v_months - 1
                       then t.total_cents * v_bps / 10000 else 0 end)
           or exists (select 1 from public.bonuses b where b.period_id = v_period
                      and (b.status <> 'proposed' or not exists (select 1 from public.payout_teacher_totals t
                                                                 where t.period_id = v_period and t.teacher_id = b.teacher_id))) then
          v_problems := v_problems || format('%s: el bono del fundador no es el de la regla', v_period);
        end if;
        v_seen := v_seen || format('%s:%s:%s:%s', v_period, v_row.carried_out_cents > 0, v_row.unconsumed_cents > v_row.carried_out_cents,
                                   (select count(*) from public.bonuses b where b.period_id = v_period));
        v_previous_out := v_row.carried_out_cents;
      end loop;
      raise exception 'deshacer la ronda' using errcode = 'P0003';
    exception when sqlstate 'P0003' then
      null;
    end;
    insert into resultado select v_round, null, p from unnest(v_problems) p;
    insert into cuenta select v_round, split_part(s, ':', 1)::integer, split_part(s, ':', 2)::boolean, split_part(s, ':', 3)::boolean,
                              split_part(s, ':', 4)::integer
    from unnest(v_seen) s;
  end loop;
end
$$;

select is((select count(*)::integer from cuenta), 15 * 12, 'quince rondas de doce periodos, todos cerrados');
select is(array(select ronda || ': ' || problema from resultado order by ronda), '{}'::text[],
  'lo escrito es el reparto, lo recibido es lo que pasó el anterior, la misma huella, RNF-04, las liquidaciones y el bono, en cada uno');
select cmp_ok((select sum(bonos)::integer from cuenta), '>=', 20, 'muchos fundadores reciben su bono');
select cmp_ok((select count(*)::integer from cuenta where arrastre), '>=', 10, 'muchos periodos pasan todo al siguiente');
select cmp_ok((select count(*)::integer from cuenta where sin_consumo), '>=', 50, 'y muchos reparten un sin consumo');
select ok(exists (select 1 from cuenta a join cuenta b on b.ronda = a.ronda and b.periodo = private.period_plus(a.periodo, 1)
                  where a.arrastre and not b.arrastre), 'algún periodo reparte lo que recibió');
select is((select count(*)::integer from public.payout_periods where status = 'closed'), 0, 'y nada quedó: cada ronda se deshizo');
select is((select count(*)::integer from public.close_runs), 0, 'ni sus corridas');

select * from finish();
rollback;
