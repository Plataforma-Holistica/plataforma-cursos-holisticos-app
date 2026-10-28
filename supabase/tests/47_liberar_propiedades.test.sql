-- T-603 · Liberar con meses al azar (RF-505 a RF-508, RN-11, RN-12, RN-17; 05 §5.5 y §8.1). Cada ronda
-- cobra y consume al azar en doce meses encadenados, con fundadores, un `PAGO_MINIMO`, bonos a mano
-- (algunos anulados), ajustes con signo y retenciones al azar. Cada mes se cierra, se deciden los bonos
-- del fundador, se libera y a veces se suelta lo retenido. Después de cada liberación (con la
-- comprobación de cada liquidación adelantada) se exige:
--   · conservación: lo que espera factura más el saldo de todos los maestros es lo del bote, los bonos
--     confirmados y los ajustes de todo lo liberado, al centavo;
--   · ninguna liquidación liberada tiene un bruto que no sea la suma de sus partes;
--   · un periodo liberado está pagado si y solo si no le queda nada por pagar (ni en espera ni retenido).
-- La comprobación al confirmar de cada liberación exige además el estado por el mínimo y el saldo. Cada
-- ronda se deshace al terminar (con una excepción atrapada); lo que se mide vive en variables.
begin;
\ir _ayuda.psql
select plan(7);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a6050000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b6050000-0000-0000-0000-000000000001'::uuid $$;
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
grant execute on all functions in schema pruebas to anon, authenticated, app_service;
delete from public.job_runs where period_id between 202610 and 202709;

-- Ocho alumnos (los impares anuales), finanzas y cuatro maestros con tres lecciones cada uno.
select pruebas.alta(pruebas.al(n), format('alumno%s-liberar-azar@prueba.test', n)) from generate_series(1, 8) n;
select pruebas.alta(pruebas.finanzas(), 'finanzas-liberar-azar@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-liberar-azar@prueba.test';
select pruebas.dar_capacidad(pruebas.finanzas(), 'finance');
select pruebas.equipar(pruebas.finanzas());
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra ' || s, 'maestra-' || s, null), pruebas.curso(s))
from unnest(array['libazar-m1', 'libazar-m2', 'libazar-m3', 'libazar-m4']) with ordinality as x (s, n) order by n;
select pruebas.como_dueno();
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
select ('c6050000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, pruebas.al(n), 'manual', 'sus-liberar-azar-' || n,
       case when n % 2 = 1 then 'annual' else 'monthly' end::public.subscription_plan, 'pending', 'MXN'
from generate_series(1, 8) n;
create temporary table lecciones as
  select row_number() over (order by c.slug, l.title) as n, l.id, l.course_id, l.teacher_id, l.video_asset_id
  from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug like 'libazar-m%';
create temporary table maestras as select distinct teacher_id from lecciones;
select is((select count(*)::integer from maestras), 4, 'cuatro maestros');

create temporary table resultado (ronda integer, problema text);
create temporary table cuenta (ronda integer, periodo integer, esperando integer, acumuladas integer, retenidas integer,
                               saldo_negativo boolean, pagado boolean);
select setseed(0.603);

do $$
declare
  v_round integer;
  v_period integer;
  v_periods integer[] := array(select (to_char(date '2026-10-01' + make_interval(months => m), 'YYYYMM'))::integer from generate_series(0, 11) m);
  v_r jsonb;
  v_preview jsonb;
  v_problems text[];
  v_seen text[];
  v_y record;
  v_b record;
  v_minimum integer;
  v_left bigint;
  v_right bigint;
  v_paid boolean;
  v_pending boolean;
begin
  for v_round in 1..10 loop
    v_problems := '{}';
    v_seen := '{}';
    begin
      perform pruebas.forzar(202610, 'open');
      -- Los fundadores, el mínimo y la regla del fundador de esta ronda.
      v_minimum := 1 + floor(random() * 40000)::integer;
      perform pruebas.como_dueno_sistema();
      update public.teachers t set is_founder = f.founder, founder_since = case when f.founder then f.since end
      from (select m.teacher_id, random() < 0.5 as founder, date '2025-06-01' + floor(random() * 600)::integer as since from maestras m) f
      where t.id = f.teacher_id;
      insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
      values ('PAGO_MINIMO', to_jsonb(v_minimum), 'decided', clock_timestamp() - interval '1 second', 202610),
             ('FUNDADOR_MULTIPLICADOR', jsonb_build_object('multiplier', ((10000 + 1 + floor(random() * 3000)::integer)::numeric / 10000)::text,
                                                           'months', 1 + floor(random() * 24)::integer),
              'decided', clock_timestamp() - interval '1 second', 202610);
      perform pruebas.como_dueno();
      -- Los cobros de octubre y el consumo de cada mes.
      perform private.record_charge(pruebas.al(n), ('c6050000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'manual',
                                    'cobro-liberar-azar-' || v_round || '-' || n, null,
                                    case when n % 2 = 1 then 'annual' else 'monthly' end::public.subscription_plan,
                                    timestamptz '2026-10-05 12:00-06' + make_interval(hours => n), 'MXN',
                                    case when random() < 0.2 then 1 + floor(random() * 300)::bigint
                                         else 1000 + floor(random() * 3000000)::bigint end,
                                    null, null, 'card', 'MX', null)
      from generate_series(1, 8) n where random() < 0.85;
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

      foreach v_period in array v_periods loop
        perform pruebas.como_finanzas();
        -- Bonos a mano al mes (a veces anulados) antes de cerrarlo.
        for v_b in select m.teacher_id from maestras m where random() < 0.3 loop
          v_r := private.capture_bonus(v_b.teacher_id, case when random() < 0.5 then 'discretionary' else 'open_course' end,
                                       1 + floor(random() * 30000)::bigint, v_period, 'Bono al azar.');
          if random() < 0.25 then
            perform private.void_bonus((v_r ->> 'bonus_id')::uuid, 'Anulado al azar.');
          end if;
        end loop;
        perform pruebas.como_dueno();
        -- El cierre.
        perform pruebas.forzar(v_period, 'closing', floor(random() * 5000)::integer, 1 + floor(random() * 10000)::integer);
        insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
        values ('nightly_rollup', v_period, 'succeeded', now() - interval '1 hour', now() - interval '1 hour', now() - interval '59 minutes',
                '{"mode": "full"}');
        perform pruebas.como_finanzas();
        perform private.rehearse_close(v_period);
        v_r := private.close_period(v_period, private.last_rehearsal(v_period));
        set constraints payout_periods_balanced immediate;
        set constraints payout_periods_balanced deferred;
        if v_r ->> 'outcome' is distinct from 'closed' then
          v_problems := v_problems || format('%s no cerró: %s', v_period, v_r);
          exit;
        end if;
        -- Los bonos del fundador: confirmados o anulados. Algunas liquidaciones, retenidas.
        for v_b in select b.id from public.bonuses b where b.period_id = v_period and b.kind = 'founder' loop
          if random() < 0.8 then
            perform private.confirm_founder_bonus(v_b.id);
          else
            perform private.void_bonus(v_b.id, 'El fundador no aplica.');
          end if;
        end loop;
        for v_y in select y.id from public.payouts y where y.period_id = v_period and y.status = 'calculated' and random() < 0.15 loop
          perform private.hold_payout(v_y.id, 'Retenida al azar.', 'calculated');
        end loop;
        -- Liberar, y a veces soltar lo retenido de este mes o de antes.
        v_preview := private.release_preview(v_period);
        v_r := private.release_payouts(v_period, v_preview ->> 'fingerprint');
        if v_r ->> 'outcome' is distinct from 'released' then
          v_problems := v_problems || format('%s no se liberó: %s', v_period, v_r);
          exit;
        end if;
        -- La vista de liberar (T-605, cuarta solicitud) dice lo que liberar escribió: el bruto y si llega al mínimo.
        select v_problems || array_agg(format('%s: la vista decía %s, se liberó %s %s', v_period, x, y.status, y.subtotal_cents))
        into v_problems
        from jsonb_array_elements(v_preview -> 'rows') x
        join public.payouts y on y.period_id = v_period and y.teacher_id = (x ->> 'teacher_id')::uuid
        where x ->> 'status' is distinct from 'on_hold'
          and (y.subtotal_cents <> (x ->> 'subtotal_cents')::bigint
               or (y.status = 'awaiting_invoice') <> (x ->> 'reaches_minimum')::boolean);
        v_problems := coalesce(v_problems, '{}');
        for v_y in select y.id from public.payouts y where y.status = 'on_hold' and random() < 0.5 order by y.period_id, y.id loop
          perform private.unhold_payout(v_y.id, 'Suelta al azar.', private.unhold_preview(v_y.id) ->> 'fingerprint');
        end loop;
        -- Un ajuste con signo, de este mes al siguiente.
        if random() < 0.5 then
          perform private.capture_adjustment((select m.teacher_id from maestras m order by random() limit 1), v_period,
                                             (case when random() < 0.5 then -1 else 1 end) * (1 + floor(random() * 50000)::bigint),
                                             'Ajuste al azar.');
        end if;
        set constraints payouts_released immediate;
        set constraints payouts_released deferred;
        perform pruebas.como_dueno();

        -- Conservación sobre todo lo liberado.
        select coalesce(sum(y.subtotal_cents) filter (where coalesce(y.held_from_status, y.status) = 'awaiting_invoice'), 0)
               + (select coalesce(sum(e.amount_cents), 0) from public.teacher_balance_entries e),
               coalesce(sum(y.pool_cents + y.bonuses_cents + y.adjustments_cents), 0)
          into v_left, v_right
        from public.payouts y where y.released_at is not null;
        if v_left is distinct from v_right then
          v_problems := v_problems || format('%s: en espera más saldo %s, liberado %s', v_period, v_left, v_right);
        end if;
        if exists (select 1 from public.payouts y
                   where y.released_at is not null
                     and y.subtotal_cents <> y.pool_cents + y.bonuses_cents + y.adjustments_cents + y.balance_applied_cents) then
          v_problems := v_problems || format('%s: un bruto que no suma', v_period);
        end if;
        for v_y in select p.period_id, p.status from public.payout_periods p where p.payouts_released_at is not null loop
          v_paid := v_y.status = 'paid';
          v_pending := exists (select 1 from public.payouts y where y.period_id = v_y.period_id and y.status not in ('paid', 'carried_forward'));
          if v_paid = v_pending then
            v_problems := v_problems || format('%s: pagado=%s con liquidaciones por pagar=%s', v_y.period_id, v_paid, v_pending);
          end if;
        end loop;
        v_seen := v_seen || format('%s:%s:%s:%s:%s:%s', v_period,
          (select count(*) from public.payouts y where y.period_id = v_period and y.status = 'awaiting_invoice'),
          (select count(*) from public.payouts y where y.period_id = v_period and y.status = 'carried_forward'),
          (select count(*) from public.payouts y where y.status = 'on_hold'),
          exists (select 1 from public.teacher_balance_entries e group by e.teacher_id having sum(e.amount_cents) < 0),
          (select status = 'paid' from public.payout_periods where period_id = v_period));
      end loop;
      raise exception 'deshacer la ronda' using errcode = 'P0003';
    exception when sqlstate 'P0003' then
      null;
    end;
    insert into resultado select v_round, p from unnest(v_problems) p;
    insert into cuenta select v_round, split_part(s, ':', 1)::integer, split_part(s, ':', 2)::integer, split_part(s, ':', 3)::integer,
                              split_part(s, ':', 4)::integer, split_part(s, ':', 5)::boolean, split_part(s, ':', 6)::boolean
    from unnest(v_seen) s;
  end loop;
end
$$;

select is((select count(*)::integer from cuenta), 10 * 12, 'diez rondas de doce meses, todos cerrados y liberados');
select is(array(select ronda || ': ' || problema from resultado order by ronda), '{}'::text[],
  'la conservación, el bruto de cada liquidación y el pagado, en cada liberación');
select cmp_ok((select sum(esperando)::integer from cuenta), '>=', 30, 'muchas liquidaciones esperan factura');
select cmp_ok((select sum(acumuladas)::integer from cuenta), '>=', 30, 'muchas se acumulan');
select ok(exists (select 1 from cuenta where saldo_negativo) and exists (select 1 from cuenta where retenidas > 0)
          and exists (select 1 from cuenta where pagado),
  'hay saldos en contra, retenidas y periodos que pasan a pagados');
select is((select count(*)::integer from public.payouts), 0, 'y nada quedó: cada ronda se deshizo');

select * from finish();
rollback;
