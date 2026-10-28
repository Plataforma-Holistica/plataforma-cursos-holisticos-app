-- T-605, tercera solicitud · El cierre congela el ensayo que se mostró (05 §8.6). Decisión de Sergio del
-- 2026-10-27, por la segunda revisión del diff de la 70; plan aprobado ese día, con revisión independiente
-- del diseño.
--
-- `close_period` aceptaba cualquier ensayo con datos finales y la huella de la entrada de ahora, y PA-80
-- muestra el último: si la entrada volvía a la de un ensayo anterior (se revierte una exclusión y se
-- recalcula), o alguien ensayaba entre abrir el diálogo y confirmar, se congelaba un reparto que quien
-- confirmaba no vio. Ahora quien cierra dice qué ensayo tenía a la vista (`close_period(p_period, p_run)`), y
-- la base solo cierra si ese es el último del periodo, salió bien con datos finales y es de la entrada de
-- ahora (`rehearsal_superseded`, `rehearsal_missing`, `rehearsal_stale`). «El último» tiene una sola
-- definición (`last_rehearsal`, por `finished_at`: `started_at` empata dentro de una transacción), la misma
-- que muestra PA-80 (`finance_close`). PA-79 y la lista toman sus cifras del último que salió bien, ordenado
-- igual.
--
-- Además, PA-79 lee el umbral de `ALERTA_SIN_CONSUMO_PCT` y si el bote sin consumo lo pasa, con la expresión
-- de la alerta (decisiones de Sergio del 2026-10-27: el umbral vigente al cerrar, solo con datos finales,
-- sobre el bote del mes sin lo que pasó del anterior).
--
-- Cambia `code_version`: un periodo que esté en cierre al aplicarla contesta `rehearsal_stale` y se ensaya
-- otra vez.

-- El último ensayo de un periodo, bueno o fallido: el que terminó más tarde (`finished_at` lo pone el guardián
-- con el reloj, ya con el candado del periodo), y a igual hora, el de identificador mayor.
create function private.last_rehearsal(p_period public.period_id) returns uuid
language sql stable set search_path = ''
as $$
  select r.id from public.close_runs r
  where r.period_id = p_period and r.kind = 'rehearsal'
  order by r.finished_at desc, r.id desc
  limit 1
$$;
revoke all on function private.last_rehearsal(public.period_id) from public;

-- Cerrar, con el ensayo que se tenía a la vista. La firma cambia: la de un argumento se quita, para que no
-- quede una puerta sin el ensayo.
drop function private.close_period(public.period_id);
create function private.close_period(p_period public.period_id, p_run uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_period public.payout_periods;
  v_blocking public.period_id;
  v_last_rollup public.run_status;
  v_in record;
  v_lines private.payout_line[];
  v_bonuses jsonb;
  v_result bytea;
  v_run uuid;
  v_net bigint;
  v_pools bigint;
  v_assigned bigint;
  v_carried_out bigint;
  v_payouts integer;
  v_next public.period_id;
  v_last public.close_runs;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'closes run in read committed' using errcode = '25000';
  end if;
  -- La comprobación corre al confirmar, cuando ya está escrito lo arrastrado al siguiente: si quien
  -- llama la puso inmediata, el cierre fallaría a la mitad.
  set constraints public.payout_periods_balanced deferred;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_period is null then
    return '{"outcome": "malformed"}'::jsonb;
  end if;

  select * into v_period from public.payout_periods p where p.period_id = p_period for update;
  if not found or v_period.status = 'open' then
    return '{"outcome": "not_closing"}'::jsonb;
  end if;
  if v_period.status in ('closed', 'paid') then
    return pg_catalog.jsonb_build_object('outcome', 'already_closed', 'close_run_id', v_period.close_run_id);
  end if;

  -- Las precondiciones.
  if (select t.thresholds from private.pool_tiers_for(p_period) t) is null then
    return '{"outcome": "before_launch"}'::jsonb;
  end if;
  -- En orden, desde el arranque: un periodo anterior con fila y sin cerrar detiene a este. Sin
  -- candado: uno cerrado no regresa, y así dos cierres no se esperan uno al otro.
  select pg_catalog.min(q.period_id) into v_blocking
  from public.payout_periods q
  where q.period_id < p_period and q.status in ('open', 'closing')
    and q.period_id >= (select pg_catalog.min(t.effective_period_id) from public.pool_tiers t where t.canceled_at is null);
  if v_blocking is not null then
    return pg_catalog.jsonb_build_object('outcome', 'previous_not_closed', 'period', v_blocking);
  end if;
  if v_period.active_students is null then
    return '{"outcome": "photo_missing"}'::jsonb;
  end if;
  if v_period.pool_bps is null then
    return '{"outcome": "no_pool_bps"}'::jsonb;
  end if;
  -- Una consolidación del periodo viva (con latido en los últimos 15 minutos) todavía puede cambiar
  -- el consolidado.
  if exists (select 1 from public.job_runs j
             where j.job = 'nightly_rollup' and j.period_id = p_period and j.status = 'running'
               and j.heartbeat_at >= pg_catalog.now() - interval '15 minutes') then
    return '{"outcome": "rollup_running"}'::jsonb;
  end if;
  -- La corrida más reciente desde que entró en cierre terminó bien: si falló, o se quedó colgada (sin
  -- latido, que solo la siguiente da por fallida), una detección pudo no abrir sus alertas.
  select j.status into v_last_rollup
  from public.job_runs j
  where j.job = 'nightly_rollup' and j.period_id = p_period and j.started_at >= v_period.entered_closing_at
  order by j.started_at desc
  limit 1;
  if v_last_rollup is distinct from 'succeeded' and v_last_rollup is not null then
    return '{"outcome": "last_rollup_failed"}'::jsonb;
  end if;
  if not exists (select 1 from public.job_runs j
                 where j.job = 'nightly_rollup' and j.period_id = p_period and j.status = 'succeeded'
                   and j.details ->> 'mode' = 'full' and j.started_at >= v_period.entered_closing_at) then
    return '{"outcome": "needs_full_rollup"}'::jsonb;
  end if;
  if exists (select 1 from private.rollup_dirty d where d.period_id = p_period) then
    return '{"outcome": "rollup_marks"}'::jsonb;
  end if;
  if exists (select 1 from public.anomaly_alerts a where a.period_id = p_period and a.status = 'open') then
    return '{"outcome": "open_alerts"}'::jsonb;
  end if;

  -- El ensayo que quien cierra tenía a la vista (T-605, decisión de Sergio del 2026-10-27). Tiene que ser
  -- el último del periodo, que es el que muestran las pantallas: si alguien ensayó después, la pantalla ya
  -- no muestra lo que se congelaría. Ya con el candado del periodo, ningún ensayo nuevo puede confirmarse
  -- antes de que este cierre termine (el ensayo toma la fila compartida).
  select * into v_last from public.close_runs r where r.id = private.last_rehearsal(p_period);
  if v_last.id is null then
    return '{"outcome": "rehearsal_missing"}'::jsonb;
  end if;
  if p_run is distinct from v_last.id then
    return '{"outcome": "rehearsal_superseded"}'::jsonb;
  end if;
  if v_last.status <> 'succeeded' or v_last.period_status_at_run <> 'closing' then
    return '{"outcome": "rehearsal_missing"}'::jsonb;
  end if;
  -- Y es de los datos de ahora: si la entrada cambió (o volvió a la de un ensayo anterior), se ensaya otra vez.
  select * into v_in from private.close_input(p_period) i;
  if v_last.input_hash is distinct from v_in.input_hash then
    return '{"outcome": "rehearsal_stale"}'::jsonb;
  end if;

  -- El cálculo, con la misma entrada que el ensayo.
  v_lines := array(select row(x.kind, x.profile_id, x.teacher_id, x.tiebreak_rank, x.cents, x.base_cents, x.half_points)::private.payout_line
                   from private.compute_payout(v_in.pool_bps, v_in.carried_in_cents, v_in.bases, v_in.points) with ordinality x
                   order by x.ordinality);
  v_bonuses := coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(b) order by b.teacher_id)
                         from private.close_founder_bonuses(v_lines, v_in.parameters -> 'founders',
                                                            v_in.parameters -> 'FUNDADOR_MULTIPLICADOR', p_period) b),
                        '[]'::jsonb);
  v_result := pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(v_lines)::text, 'UTF8'));
  select coalesce(pg_catalog.sum(l.base_cents) filter (where l.kind = 'student_pool'), 0),
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'student_pool'), 0),
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'share'), 0),
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'carried_over'), 0)
    into v_net, v_pools, v_assigned, v_carried_out
  from pg_catalog.unnest(v_lines) l;
  -- Con la misma entrada y el mismo código, el cálculo tiene que dar el resultado del ensayo mostrado. Si no,
  -- algo no determinista se coló en el reparto: no se congela, y no es «la suma no cuadra» (23514).
  if v_result is distinct from v_last.result_hash then
    raise exception 'close result differs from the rehearsal on view' using errcode = 'XX000';
  end if;

  insert into public.close_runs (period_id, kind, status, period_status_at_run, input_hash, result_hash, code_version, parameters,
                                 active_students, pool_bps, carried_in_cents, net_revenue_cents, student_pools_cents, pool_cents,
                                 assigned_cents, unconsumed_cents, carried_out_cents, started_by)
  values (p_period, 'close', 'succeeded', 'closing', v_in.input_hash, v_result, v_in.code_version, v_in.parameters,
          v_in.active_students, v_in.pool_bps, v_in.carried_in_cents, v_net, v_pools, v_pools + v_in.carried_in_cents,
          v_assigned, v_pools + v_in.carried_in_cents - v_assigned, v_carried_out, private.actor_id())
  returning id into v_run;
  insert into public.payout_student_pools (period_id, profile_id, close_run_id, base_cents, pool_cents, half_points)
  select p_period, l.profile_id, v_run, l.base_cents, l.cents, l.half_points
  from pg_catalog.unnest(v_lines) with ordinality l where l.kind = 'student_pool' order by l.ordinality;
  insert into public.payout_shares (period_id, profile_id, teacher_id, close_run_id, half_points, amount_cents)
  select p_period, l.profile_id, l.teacher_id, v_run, l.half_points, l.cents
  from pg_catalog.unnest(v_lines) with ordinality l where l.kind = 'share' order by l.ordinality;
  insert into public.payout_teacher_totals (period_id, teacher_id, close_run_id, half_points, students, assigned_cents,
                                            unconsumed_cents, total_cents)
  select p_period, t.teacher_id, v_run, t.half_points, t.students, t.assigned_cents, t.unconsumed_cents, t.total_cents
  from private.close_teacher_totals(v_lines) t;
  insert into public.close_run_teacher_totals (close_run_id, teacher_id, half_points, students, assigned_cents, unconsumed_cents,
                                               total_cents, founder_bonus_cents)
  select t.close_run_id, t.teacher_id, t.half_points, t.students, t.assigned_cents, t.unconsumed_cents, t.total_cents,
         coalesce(b.amount_cents, 0)
  from public.payout_teacher_totals t
  left join pg_catalog.jsonb_to_recordset(v_bonuses) as b (teacher_id uuid, amount_cents bigint) on b.teacher_id = t.teacher_id
  where t.period_id = p_period;
  -- Una liquidación por maestro con total, calculada con lo que le tocó del bote (RF-505).
  insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, subtotal_cents, net_cents)
  select p_period, t.teacher_id, v_run, t.total_cents, t.total_cents, t.total_cents
  from public.payout_teacher_totals t where t.period_id = p_period
  order by t.teacher_id;
  -- Y la de cada maestro con algo pendiente sin reparto en el periodo (saldo, ajuste o bono confirmado),
  -- con lo del bote en 0: así finanzas la ve antes de liberar. Liberar vuelve a buscar a los pendientes.
  insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, subtotal_cents, net_cents)
  select p_period, x.teacher_id, v_run, 0, 0, 0
  from private.payout_pending_teachers(p_period) as x (teacher_id)
  where not exists (select 1 from public.payout_teacher_totals t where t.period_id = p_period and t.teacher_id = x.teacher_id)
  order by x.teacher_id;
  select pg_catalog.count(*) into v_payouts from public.payouts y where y.period_id = p_period;
  -- El bono de cada fundador, propuesto: finanzas lo confirma (RN-12).
  insert into public.bonuses (teacher_id, period_id, kind, amount_cents, basis_cents, multiplier_bps, close_run_id)
  select b.teacher_id, p_period, 'founder', b.amount_cents, b.basis_cents, b.multiplier_bps, v_run
  from pg_catalog.jsonb_to_recordset(v_bonuses) as b (teacher_id uuid, basis_cents bigint, multiplier_bps integer, amount_cents bigint)
  order by b.teacher_id;

  update public.payout_periods p
  set status = 'closed', net_revenue_cents = v_net, student_pools_cents = v_pools, pool_cents = v_pools + v_in.carried_in_cents,
      assigned_cents = v_assigned, unconsumed_cents = v_pools + v_in.carried_in_cents - v_assigned,
      carried_out_cents = v_carried_out, close_run_id = v_run
  where p.period_id = p_period;

  -- Lo que pasa al siguiente (RN-06). Un ensayo que ya tenía queda con otra huella.
  if v_carried_out > 0 then
    v_next := private.period_plus(p_period, 1);
    perform private.open_period(v_next);
    update public.payout_periods p set carried_in_cents = v_carried_out where p.period_id = v_next;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'closed', 'close_run_id', v_run, 'rehearsal_run_id', v_last.id,
    'input_hash', pg_catalog.encode(v_in.input_hash, 'hex'), 'result_hash', pg_catalog.encode(v_result, 'hex'),
    'pool_bps', v_in.pool_bps, 'carried_in_cents', v_in.carried_in_cents, 'net_revenue_cents', v_net,
    'student_pools_cents', v_pools, 'pool_cents', v_pools + v_in.carried_in_cents, 'assigned_cents', v_assigned,
    'unconsumed_cents', v_pools + v_in.carried_in_cents - v_assigned, 'carried_out_cents', v_carried_out,
    'carried_to', v_next, 'payouts', v_payouts,
    'founder_bonus_cents', (select coalesce(pg_catalog.sum((b ->> 'amount_cents')::bigint), 0)
                            from pg_catalog.jsonb_array_elements(v_bonuses) b));
end
$$;
revoke all on function private.close_period(public.period_id, uuid) from public;
grant execute on function private.close_period(public.period_id, uuid) to app_service;

-- Las lecturas de finanzas: el mismo «último» ensayo, y PA-79 con el bote del mes y el umbral.
create or replace function private.finance_close(p_period public.period_id) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.payout_periods;
  r public.close_runs;
  c public.close_runs;
  e private.close_exports;
begin
  if private.actor_id() is null or not private.actor_has_capability('finance') then
    return null;
  end if;
  select * into p from public.payout_periods x where x.period_id = p_period;
  if not found then
    return pg_catalog.jsonb_build_object('fresh_code', private.finance_change_gate() is null, 'period', null);
  end if;
  select * into r from public.close_runs x where x.id = private.last_rehearsal(p_period);
  if p.status in ('closed', 'paid') then
    select * into c from public.close_runs x where x.id = p.close_run_id;
    select * into e from private.close_exports x where x.close_run_id = p.close_run_id;
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.finance_change_gate() is null,
    'period', pg_catalog.jsonb_build_object('period_id', p.period_id, 'status', p.status, 'ends_at', p.ends_at,
                                            'entered_closing_at', p.entered_closing_at),
    'checks', pg_catalog.jsonb_build_object(
      'open_alerts', (select pg_catalog.count(*) from public.anomaly_alerts a where a.period_id = p_period and a.status = 'open'),
      'final_rehearsal', exists (select 1 from public.close_runs x where x.period_id = p_period and x.kind = 'rehearsal'
                                 and x.status = 'succeeded' and x.period_status_at_run = 'closing'),
      'last_rollup', (select j.status from public.job_runs j where j.job = 'nightly_rollup' and j.period_id = p_period
                      order by j.started_at desc limit 1),
      'rollup_marks', exists (select 1 from private.rollup_dirty d where d.period_id = p_period)),
    'rehearsal', case when r.id is not null then pg_catalog.jsonb_build_object(
                   'run_id', r.id, 'at', r.started_at, 'status', r.status, 'period_status_at_run', r.period_status_at_run,
                   'pool_bps', r.pool_bps, 'active_students', r.active_students, 'net_revenue_cents', r.net_revenue_cents,
                   'pool_cents', r.pool_cents, 'assigned_cents', r.assigned_cents, 'unconsumed_cents', r.unconsumed_cents,
                   'carried_in_cents', r.carried_in_cents, 'carried_out_cents', r.carried_out_cents,
                   'teachers', private.finance_run_teachers(r.id, null)) end,
    'close', case when c.id is not null then pg_catalog.jsonb_build_object(
               'run_id', c.id, 'at', p.closed_at,
               'closed_by', (select f.display_name from public.profiles f where f.id = p.closed_by),
               'pool_bps', c.pool_bps, 'active_students', c.active_students, 'net_revenue_cents', c.net_revenue_cents,
               'pool_cents', c.pool_cents, 'assigned_cents', c.assigned_cents, 'unconsumed_cents', c.unconsumed_cents,
               'carried_out_cents', c.carried_out_cents,
               'export', case when e.close_run_id is not null then pg_catalog.jsonb_build_object(
                           'rows', e.row_count, 'sha256', pg_catalog.encode(e.sha256, 'hex'), 'created_at', e.created_at) end,
               'teachers', private.finance_run_teachers(c.id, e.minimum_payout_cents)) end);
end
$$;

create or replace function private.finance_periods() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.actor_id() is null or not private.actor_has_capability('finance') then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.finance_change_gate() is null,
    'periods', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'period_id', p.period_id, 'status', p.status, 'starts_at', p.starts_at, 'ends_at', p.ends_at,
               'active_students', case when p.status in ('closed', 'paid') then p.active_students else r.active_students end,
               'pool_bps', case when p.status in ('closed', 'paid') then p.pool_bps else r.pool_bps end,
               'pool_cents', case when p.status in ('closed', 'paid') then p.pool_cents else r.pool_cents end,
               'unconsumed_cents', case when p.status in ('closed', 'paid') then p.unconsumed_cents else r.unconsumed_cents end,
               'rehearsed_at', case when p.status in ('closed', 'paid') then null else r.started_at end,
               'payouts', pg_catalog.jsonb_build_object(
                 'total', (select pg_catalog.count(*) from public.payouts y where y.period_id = p.period_id),
                 'paid', (select pg_catalog.count(*) from public.payouts y where y.period_id = p.period_id and y.status = 'paid')))
             order by p.period_id desc)
      from public.payout_periods p
      left join lateral (select c.* from public.close_runs c
                         where c.period_id = p.period_id and c.kind = 'rehearsal' and c.status = 'succeeded'
                         order by c.finished_at desc, c.id desc limit 1) r on true), '[]'::jsonb));
end
$$;

create or replace function private.finance_period(p_period public.period_id) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.payout_periods;
  g public.close_runs;
  v_at timestamptz;
  v_raw text;
  v_bps integer;
  v_pools bigint;
  v_assigned bigint;
begin
  if private.actor_id() is null or not private.actor_has_capability('finance') then
    return null;
  end if;
  select * into p from public.payout_periods x where x.period_id = p_period;
  if not found then
    return pg_catalog.jsonb_build_object('fresh_code', private.finance_change_gate() is null, 'period', null);
  end if;
  -- El último ensayo que salió bien, por cuándo terminó (`started_at` empata dentro de una transacción).
  select * into g from public.close_runs r
  where r.period_id = p_period and r.kind = 'rehearsal' and r.status = 'succeeded'
  order by r.finished_at desc, r.id desc limit 1;
  -- El umbral del bote sin consumo (decisiones de Sergio del 2026-10-27): el vigente al cerrar en un periodo
  -- cerrado, el de ahora en otro; válido de 1 a 10 000, como lo exige la alerta.
  v_at := case when p.status in ('closed', 'paid') then p.closed_at else pg_catalog.now() end;
  v_raw := private.parameter_value('ALERTA_SIN_CONSUMO_PCT', v_at) #>> '{}';
  if v_raw ~ '^[1-9][0-9]{0,4}$' and v_raw::integer <= 10000 then
    v_bps := v_raw::integer;
  end if;
  -- Si lo pasa, solo con datos finales (el cierre, o un ensayo con datos finales), y con la expresión de la
  -- alerta: sobre el bote del mes, sin lo que pasó del anterior (`detect_anomalies`).
  if p.status in ('closed', 'paid') then
    v_pools := p.student_pools_cents;
    v_assigned := p.assigned_cents;
  elsif p.status = 'closing' and g.period_status_at_run = 'closing' then
    v_pools := g.student_pools_cents;
    v_assigned := g.assigned_cents;
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.finance_change_gate() is null,
    'period', pg_catalog.jsonb_build_object(
      'period_id', p.period_id, 'status', p.status, 'starts_at', p.starts_at, 'ends_at', p.ends_at,
      'entered_closing_at', p.entered_closing_at, 'active_students', p.active_students, 'pool_bps', p.pool_bps,
      'carried_in_cents', p.carried_in_cents, 'closed_at', p.closed_at, 'payouts_released_at', p.payouts_released_at,
      'paid_at', p.paid_at),
    'collected', (select pg_catalog.jsonb_build_object(
                    'charges', pg_catalog.count(*), 'gross_mxn_cents', coalesce(pg_catalog.sum(c.gross_mxn_cents), 0),
                    'revenue_net_mxn_cents', coalesce(pg_catalog.sum(c.revenue_net_mxn_cents), 0))
                  from public.charges c where c.period_id = p_period),
    'assigned', (select pg_catalog.jsonb_build_object('students', pg_catalog.count(*), 'base_cents', coalesce(pg_catalog.sum(s.base_cents), 0))
                 from private.close_input_students(p_period) s),
    'close', case when p.status in ('closed', 'paid') then pg_catalog.jsonb_build_object(
               'run_id', p.close_run_id, 'net_revenue_cents', p.net_revenue_cents, 'student_pools_cents', p.student_pools_cents,
               'pool_cents', p.pool_cents,
               'assigned_cents', p.assigned_cents, 'unconsumed_cents', p.unconsumed_cents, 'carried_out_cents', p.carried_out_cents) end,
    'rehearsal', case when g.id is not null then pg_catalog.jsonb_build_object(
                    'run_id', g.id, 'at', g.started_at, 'period_status_at_run', g.period_status_at_run,
                    'active_students', g.active_students, 'pool_bps', g.pool_bps, 'net_revenue_cents', g.net_revenue_cents,
                    'student_pools_cents', g.student_pools_cents, 'pool_cents', g.pool_cents, 'assigned_cents', g.assigned_cents,
                    'unconsumed_cents', g.unconsumed_cents, 'carried_out_cents', g.carried_out_cents) end,
    'unconsumed_alert_bps', v_bps,
    'unconsumed_over', case when v_bps is not null and v_pools is not null
                            then (v_pools - v_assigned) * 10000 > v_bps::bigint * v_pools end,
    'open_alerts', (select pg_catalog.count(*) from public.anomaly_alerts a where a.period_id = p_period and a.status = 'open'),
    'last_rollup', (select pg_catalog.jsonb_build_object('status', j.status, 'mode', j.details ->> 'mode', 'started_at', j.started_at,
                                                         'finished_at', j.finished_at)
                    from public.job_runs j where j.job = 'nightly_rollup' and j.period_id = p_period
                    order by j.started_at desc limit 1),
    'last_good_rollup', (select pg_catalog.jsonb_build_object('mode', j.details ->> 'mode', 'started_at', j.started_at,
                                                              'finished_at', j.finished_at)
                         from public.job_runs j where j.job = 'nightly_rollup' and j.period_id = p_period and j.status = 'succeeded'
                         order by j.started_at desc limit 1),
    'rollup_request', (select pg_catalog.jsonb_build_object('status', q.status, 'requested_at', q.requested_at,
                                                            'started_at', q.started_at, 'finished_at', q.finished_at)
                       from private.rollup_requests q where q.period_id = p_period
                       order by q.requested_at desc limit 1));
end
$$;

-- El vigilante del cierre, con el último ensayo.
create or replace function private.schema_violations_close()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  close_tables (table_name) as (
    values ('public.close_runs'), ('public.close_run_teacher_totals'), ('public.payout_student_pools'),
           ('public.payout_shares'), ('public.payout_teacher_totals'), ('private.close_exports'), ('private.rollup_requests')),
  close_functions (name, definer, server, pinned) as (
    values ('code_version', false, false, true), ('close_input', false, false, true), ('close_teacher_totals', false, false, true),
           ('guard_close_run', false, false, true), ('require_period_closing', false, false, true),
           ('assert_period_balanced', false, false, true), ('check_period_balanced', true, false, true),
           ('rehearse_close', true, true, true), ('close_period', true, true, true), ('last_rehearsal', false, false, true),
           ('csv_money', false, false, true), ('csv_text', false, false, true), ('close_export_csv', false, false, true),
           ('write_close_export', false, false, true), ('assert_close_export', false, false, true),
           ('close_export_download', true, true, true), ('finance_run_teachers', false, false, true),
           ('finance_periods', true, true, true), ('finance_period', true, true, true), ('finance_close', true, true, true),
           ('request_rollup', true, true, true), ('rollup_requests_paused', false, false, true),
           ('run_rollup_requests', false, false, false)),
  found as (
    select f.name, f.definer, f.server, f.pinned, p.oid, p.prosecdef, p.proconfig
    from close_functions f
    join pg_catalog.pg_proc p on p.proname = f.name
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private'),
  close_triggers (table_name, trigger_name, function_name, deferred) as (
    select t.table_name, x.trigger_name, 'reject_mutation', false
    from (values ('public.close_runs'), ('public.close_run_teacher_totals'), ('public.payout_student_pools'),
                 ('public.payout_shares'), ('public.payout_teacher_totals'), ('private.close_exports')) t (table_name)
    cross join (values ('ledger_no_update_delete'), ('ledger_no_truncate')) x (trigger_name)
    union all
    values ('public.close_runs', 'close_runs_guard', 'guard_close_run', false),
           ('public.close_runs', 'audit_changes', 'audit_row_change', false),
           ('public.payout_student_pools', 'require_period_closing', 'require_period_closing', false),
           ('public.payout_shares', 'require_period_closing', 'require_period_closing', false),
           ('public.payout_teacher_totals', 'require_period_closing', 'require_period_closing', false),
           ('public.payout_periods', 'payout_periods_balanced', 'check_period_balanced', true),
           ('public.payout_periods', 'write_close_export', 'write_close_export', false),
           ('private.rollup_requests', 'audit_changes', 'audit_row_change', false))
  select 'close table reachable by ' || r.rolname, t.table_name
  from app_roles r cross join close_tables t
  where pg_catalog.to_regclass(t.table_name) is not null
    and (pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
         or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER'))
  union all
  select 'close function missing', 'private.' || f.name
  from close_functions f
  where not exists (select 1 from found where found.name = f.name)
  union all
  select 'close function executable by ' || r.rolname, found.oid::regprocedure::text
  from app_roles r cross join found
  where pg_catalog.has_function_privilege(r.rolname::name, found.oid, 'EXECUTE')
    and not (found.server and r.rolname = 'app_service')
  union all
  select 'close function not executable by app_service', found.oid::regprocedure::text
  from found
  where found.server and not pg_catalog.has_function_privilege('app_service', found.oid, 'EXECUTE')
  union all
  select 'close function security definer or without fixed search_path', found.oid::regprocedure::text
  from found
  where (found.prosecdef and not found.definer)
     or (found.pinned and not coalesce(found.proconfig, '{}') @> array['search_path=""'])
  union all
  select 'close function not security definer', found.oid::regprocedure::text
  from found
  where found.definer and not found.prosecdef
  union all
  select 'close trigger missing or disabled: ' || g.trigger_name, g.table_name
  from close_triggers g
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = pg_catalog.to_regclass(g.table_name) and tg.tgname = g.trigger_name and tg.tgenabled in ('O', 'A')
      and n.nspname = 'private' and p.proname = g.function_name)
  union all
  select 'close trigger not deferred: ' || g.trigger_name, g.table_name
  from close_triggers g
  join pg_catalog.pg_trigger tg on tg.tgrelid = pg_catalog.to_regclass(g.table_name) and tg.tgname = g.trigger_name
  where g.deferred and (tg.tgconstraint = 0 or not tg.tgdeferrable or not tg.tginitdeferred)
  union all
  -- Sin su trabajo, los pedidos se quedarían pendientes y el índice único negaría los nuevos.
  select 'close job missing or inactive: rollup_requests', 'cron.job'
  where not exists (select 1 from cron.job j where j.jobname = 'rollup_requests' and j.active
                    and j.schedule = '* * * * *' and j.command = 'call private.run_rollup_requests()')
$$;
