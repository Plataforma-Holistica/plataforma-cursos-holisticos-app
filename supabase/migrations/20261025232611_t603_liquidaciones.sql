-- T-603 · Las liquidaciones y el bono del fundador, al cerrar (RF-505, RF-508, RN-12; 05 §5.5, §7.3, §8.1,
-- §8.6 y §8.7). Primera de dos solicitudes: esta crea, la segunda (`t603_liberar`) libera. Decisiones de
-- Sergio del 2026-10-25:
--   · T-603 llega hasta liberar; la factura y pagada llegan con T-604 y T-409;
--   · el bono del fundador es el piso del total del periodo (su parte del bote, con la del sin consumo)
--     por el multiplicador menos uno (RN-12), durante 24 periodos contando el que contiene
--     `founder_since`; lo cobra aunque esté suspendido o se haya ido; si da 0 no hay fila;
--   · la regla del fundador y quiénes lo son entran a la huella del ensayo: un cambio deja viejo el
--     ensayo, y el ensayo dice el bono que el cierre propondrá.
--
-- Lo que entra:
--   · `payouts`, una liquidación por maestro con total, que nace calculada con lo que le tocó del bote;
--     su historia (`payout_status_events`); y `bonuses`, donde el cierre propone el del fundador. Ya
--     llevan las columnas de la segunda solicitud (liberar y retener), sin que nada las escriba todavía;
--     lo de la factura y el pago (T-604, T-409) no;
--   · el cierre las escribe en la misma transacción, y la comprobación al confirmar suma dos: cada
--     maestro con total tiene su liquidación (la 9; la 6 del 05, que aquí ya era otra) y el bono del
--     fundador es el que da la regla con lo escrito (la 10);
--   · el área `payouts` del vigilante.
--
-- Nadie de la aplicación toca estas tablas todavía (T-604, T-605). Como el reparto, todo vive en la
-- base: el bono del fundador no tiene lugar en TypeScript.

-- ---------------------------------------------------------------------------------------
-- Los tipos y las tablas.

-- Los nueve estados de RF-505: los siete del camino normal y dos de excepción.
create type public.payout_status as enum (
  'calculated', 'awaiting_invoice', 'invoice_in_review', 'invoice_rejected',
  'ready_to_pay', 'paid', 'carried_forward', 'on_hold', 'payment_returned');
create type public.bonus_kind as enum ('founder', 'open_course', 'discretionary');
create type public.bonus_status as enum ('proposed', 'confirmed', 'void');

create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  period_id public.period_id not null references public.payout_periods (period_id),
  teacher_id uuid not null references public.teachers (id),
  close_run_id uuid not null references public.close_runs (id),
  status public.payout_status not null default 'calculated',
  pool_cents bigint not null,                       -- lo que le tocó del bote; no cambia nunca
  bonuses_cents bigint not null default 0,          -- bonos confirmados del periodo (RN-12)
  adjustments_cents bigint not null default 0,      -- ajustes aplicados; con signo (RF-507)
  balance_applied_cents bigint not null default 0,  -- saldo anterior que se suma; con signo (RF-506)
  subtotal_cents bigint not null,                   -- el «monto bruto» de RF-505
  vat_cents bigint not null default 0,              -- IVA trasladado (ADR-16, con T-409)
  income_tax_withheld_cents bigint not null default 0,
  vat_withheld_cents bigint not null default 0,
  net_cents bigint not null,                        -- lo que se transfiere
  released_at timestamptz,
  released_by uuid references public.profiles (id),
  held_from_status public.payout_status,            -- a dónde vuelve al soltarla (RF-505)
  held_at timestamptz,
  held_by uuid references public.profiles (id),
  hold_reason text,                                 -- por qué está retenida (RN-17)
  anomaly_alert_id uuid references public.anomaly_alerts (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payouts_period_teacher_uq unique (period_id, teacher_id),
  constraint payouts_parts_positive check (
    pool_cents >= 0 and bonuses_cents >= 0 and vat_cents >= 0 and income_tax_withheld_cents >= 0 and vat_withheld_cents >= 0),
  constraint payouts_subtotal_is_sum
    check (subtotal_cents = pool_cents + bonuses_cents + adjustments_cents + balance_applied_cents),
  constraint payouts_net_is_sum
    check (net_cents = subtotal_cents + vat_cents - income_tax_withheld_cents - vat_withheld_cents),
  -- Sin liberar está la calculada, también retenida desde calculada.
  constraint payouts_released_consistent check (
    (released_at is null) = (status = 'calculated' or coalesce(held_from_status = 'calculated', false))
    and (released_at is null) = (released_by is null)),
  constraint payouts_payable_is_positive check (
    status in ('calculated', 'carried_forward') or coalesce(held_from_status = 'calculated', false) or net_cents > 0),
  constraint payouts_hold_consistent check (
    (status = 'on_hold') = (held_from_status is not null)
    and (held_from_status is null) = (held_at is null) and (held_at is null) = (held_by is null)
    and (held_by is null) = (hold_reason is null)
    and (anomaly_alert_id is null or status = 'on_hold')),
  constraint payouts_hold_from check (
    held_from_status is null
    or held_from_status in ('calculated', 'awaiting_invoice', 'invoice_in_review', 'invoice_rejected', 'ready_to_pay')),
  constraint payouts_hold_reason_length check (hold_reason is null or pg_catalog.char_length(hold_reason) between 1 and 2000)
);
comment on table public.payouts is 'La liquidación de cada maestro por periodo (RF-505). Nace calculada al cierre; lo del bote no cambia nunca.';
create index payouts_teacher_idx on public.payouts (teacher_id, period_id desc);
create index payouts_open_idx on public.payouts (period_id, status) where status not in ('paid', 'carried_forward');

create table public.payout_status_events (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.payouts (id),
  from_status public.payout_status,                 -- nulo en el nacimiento
  to_status public.payout_status not null,
  actor_id uuid references public.profiles (id),    -- nulo si lo hizo el sistema
  note text,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint payout_status_events_changes check (from_status is distinct from to_status)
);
comment on table public.payout_status_events is 'La historia de cada liquidación: cada cambio de estado, quién y cuándo. Solo inserción.';
create index payout_status_events_payout_idx on public.payout_status_events (payout_id, occurred_at);

create table public.bonuses (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id),
  period_id public.period_id not null references public.payout_periods (period_id),
  kind public.bonus_kind not null,
  status public.bonus_status not null default 'proposed',
  amount_cents bigint not null,
  basis_cents bigint,                               -- sobre qué se calculó el del fundador (RN-12)
  multiplier_bps integer,                           -- FUNDADOR_MULTIPLICADOR menos uno, en puntos base
  reason text,
  close_run_id uuid references public.close_runs (id),
  created_by uuid references public.profiles (id),  -- nulo: lo calculó el cierre
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  void_reason text,
  voided_by uuid references public.profiles (id),
  voided_at timestamptz,
  constraint bonuses_amount_positive check (amount_cents > 0),
  constraint bonuses_founder_is_computed check (
    (kind = 'founder' and coalesce(basis_cents >= 0, false) and coalesce(multiplier_bps between 1 and 10000, false)
     and close_run_id is not null and created_by is null and reason is null)
    or (kind <> 'founder' and reason is not null and created_by is not null
        and basis_cents is null and multiplier_bps is null and close_run_id is null)),
  constraint bonuses_reason_length check (reason is null or pg_catalog.char_length(reason) between 1 and 2000),
  constraint bonuses_decision_consistent check (
    (status = 'proposed') = (decided_at is null) and (decided_at is null) = (decided_by is null)),
  constraint bonuses_void_consistent check (
    (status = 'void') = (voided_at is not null) and (voided_at is null) = (voided_by is null)
    and (voided_by is null) = (void_reason is null)),
  constraint bonuses_void_reason_length check (void_reason is null or pg_catalog.char_length(void_reason) between 1 and 2000)
);
comment on table public.bonuses is 'Los bonos a maestros (RF-508). Salen de la parte de la Plataforma, nunca del bote (RN-12). El del fundador lo propone el cierre.';
create unique index bonuses_founder_uq on public.bonuses (period_id, teacher_id) where kind = 'founder';
create index bonuses_period_idx on public.bonuses (period_id, teacher_id);

alter table public.payouts enable row level security;
alter table public.payout_status_events enable row level security;
alter table public.bonuses enable row level security;
revoke all on public.payouts, public.payout_status_events, public.bonuses
  from public, anon, authenticated, service_role, app_service;

-- Lo que finanzas ve en un ensayo: también el bono del fundador que el cierre propondría.
alter table public.close_run_teacher_totals
  add column founder_bonus_cents bigint not null default 0,
  add constraint close_run_teacher_totals_founder_bonus_positive check (founder_bonus_cents >= 0);

-- ---------------------------------------------------------------------------------------
-- El bono del fundador (RN-12).

-- El de un maestro fundador en un periodo, de su total: el multiplicador menos uno, en puntos base, y
-- el piso del total por eso. Vale en los `months` periodos que empiezan en el que contiene
-- `founder_since`; fuera de ellos da 0. Una regla que falta o que no cabe en puntos base no se adivina.
create function private.founder_bonus(p_total bigint, p_founder_since date, p_period public.period_id, p_rule jsonb,
  out multiplier_bps integer, out amount_cents bigint)
language plpgsql immutable set search_path = ''
as $$
declare
  v_multiplier numeric;
  v_months integer;
  v_bps numeric;
  v_since integer;
  v_offset integer;
begin
  begin
    v_multiplier := (p_rule ->> 'multiplier')::numeric;
    v_months := (p_rule ->> 'months')::integer;
  exception when others then
    v_multiplier := null;
  end;
  if v_multiplier is null or v_months is null or v_months < 1 then
    raise exception 'FUNDADOR_MULTIPLICADOR is missing or malformed: %', p_rule using errcode = 'P0001';
  end if;
  v_bps := (v_multiplier - 1) * 10000;
  if v_bps < 0 or v_bps > 10000 or v_bps <> pg_catalog.trunc(v_bps) then
    raise exception 'FUNDADOR_MULTIPLICADOR % does not fit in basis points', v_multiplier using errcode = 'P0001';
  end if;
  if p_total is null or p_total < 0 or p_founder_since is null or p_period is null then
    raise exception 'a founder bonus needs a total, a founder date and a period' using errcode = '22023';
  end if;
  multiplier_bps := v_bps::integer;
  v_since := pg_catalog.to_char(p_founder_since, 'YYYYMM')::integer;
  v_offset := ((p_period / 100) * 12 + p_period % 100) - ((v_since / 100) * 12 + v_since % 100);
  amount_cents := case when v_offset >= 0 and v_offset < v_months then p_total * multiplier_bps / 10000 else 0 end;
end
$$;
revoke all on function private.founder_bonus(bigint, date, public.period_id, jsonb) from public;

-- Los bonos de un cierre, de sus líneas: los fundadores con total y un bono mayor que 0. No mira el
-- estado del maestro (lo cobra aunque esté suspendido o se haya ido), y sin fundadores no lee la regla.
create function private.close_founder_bonuses(p_lines private.payout_line[], p_founders jsonb, p_rule jsonb,
                                              p_period public.period_id)
returns table (teacher_id uuid, basis_cents bigint, multiplier_bps integer, amount_cents bigint)
language sql immutable set search_path = ''
as $$
  select t.teacher_id, t.total_cents, b.multiplier_bps, b.amount_cents
  from private.close_teacher_totals(p_lines) t
  join pg_catalog.jsonb_to_recordset(coalesce(p_founders, '[]'::jsonb)) as f (teacher_id uuid, founder_since date)
    on f.teacher_id = t.teacher_id
  cross join lateral private.founder_bonus(t.total_cents, f.founder_since, p_period, p_rule) b
  where b.amount_cents > 0
  order by t.teacher_id
$$;
revoke all on function private.close_founder_bonuses(private.payout_line[], jsonb, jsonb, public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- Los guardianes.

-- Una liquidación nace calculada, con lo que le tocó del bote y nada más; la escribe el cierre (la
-- revisión de que el periodo está en cierre, con su corrida, es `require_period_closing`). Sin fecha de
-- liberación ni retención, las restricciones de la tabla solo admiten el estado calculado; y con el
-- subtotal igual a lo del bote y sin ajustes ni saldo, los bonos son 0. En esta solicitud no cambia:
-- liberar y retener llegan con la segunda. No se borra ni se vacía.
create function private.guard_payout() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.pool_cents < 0 or new.adjustments_cents <> 0 or new.balance_applied_cents <> 0
       or new.vat_cents <> 0 or new.income_tax_withheld_cents <> 0 or new.vat_withheld_cents <> 0
       or new.subtotal_cents <> new.pool_cents or new.net_cents <> new.pool_cents
       or pg_catalog.num_nonnulls(new.released_at, new.released_by, new.held_from_status, new.held_at, new.held_by,
                                  new.hold_reason, new.anomaly_alert_id) > 0 then
      raise exception '%.%: a payout is born calculated, with its share of the pool and nothing else', tg_table_schema, tg_table_name
        using errcode = '23514';
    end if;
    new.created_at := pg_catalog.now();
    new.updated_at := pg_catalog.now();
    return new;
  end if;
  raise exception '%.%: payout % does not change yet: releasing comes with the second request of T-603',
    tg_table_schema, tg_table_name, old.id using errcode = '23514';
end
$$;
revoke all on function private.guard_payout() from public;

-- Cada nacimiento y cada cambio de estado, con quién (nulo si es el sistema).
create function private.log_payout_status() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status = old.status then
    return null;
  end if;
  insert into public.payout_status_events (payout_id, from_status, to_status, actor_id, note)
  values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, private.actor_id(),
          case when new.status = 'on_hold' then new.hold_reason end);
  return null;
end
$$;
revoke all on function private.log_payout_status() from public;

-- En esta solicitud solo nace el bono del fundador, propuesto, del cierre (`require_period_closing`
-- revisa el periodo y la corrida; sin decisión ni anulación, las restricciones solo admiten el estado
-- propuesto). Capturar, confirmar y anular llegan con la segunda.
create function private.guard_bonus() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.kind <> 'founder' then
      raise exception '%.%: a bonus by hand comes with the second request of T-603', tg_table_schema, tg_table_name
        using errcode = '23514';
    end if;
    if pg_catalog.num_nonnulls(new.decided_at, new.decided_by, new.voided_at, new.voided_by, new.void_reason) > 0 then
      raise exception '%.%: the founder bonus is born proposed', tg_table_schema, tg_table_name using errcode = '23514';
    end if;
    new.created_at := pg_catalog.now();
    return new;
  end if;
  raise exception '%.%: bonus % does not change yet: deciding comes with the second request of T-603',
    tg_table_schema, tg_table_name, old.id using errcode = '23514';
end
$$;
revoke all on function private.guard_bonus() from public;

create trigger payouts_guard before insert or update on public.payouts
  for each row execute function private.guard_payout();
create trigger require_period_closing before insert on public.payouts
  for each row execute function private.require_period_closing();
create trigger payouts_no_delete before delete on public.payouts
  for each row execute function private.reject_mutation();
create trigger payouts_no_truncate before truncate on public.payouts
  for each statement execute function private.reject_mutation();
create trigger payouts_log_status after insert or update of status on public.payouts
  for each row execute function private.log_payout_status();
create trigger audit_changes after insert or update on public.payouts
  for each row execute function private.audit_row_change('money');
create trigger ledger_no_update_delete before update or delete on public.payout_status_events
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on public.payout_status_events
  for each statement execute function private.reject_mutation();
create trigger bonuses_guard before insert or update on public.bonuses
  for each row execute function private.guard_bonus();
create trigger require_period_closing before insert on public.bonuses
  for each row execute function private.require_period_closing();
create trigger bonuses_no_delete before delete on public.bonuses
  for each row execute function private.reject_mutation();
create trigger bonuses_no_truncate before truncate on public.bonuses
  for each statement execute function private.reject_mutation();
create trigger audit_changes after insert or update on public.bonuses
  for each row execute function private.audit_row_change('money');

-- ---------------------------------------------------------------------------------------
-- La entrada, con la regla del fundador y quiénes lo son (todos, aunque no tengan consumo: así
-- cualquier cambio de un fundador deja viejo el ensayo).

create or replace function private.close_input(p_period public.period_id,
  out pool_bps integer, out carried_in_cents bigint, out active_students integer,
  out bases private.payout_base[], out points private.payout_points[],
  out parameters jsonb, out code_version text, out input_hash bytea)
language sql stable set search_path = ''
as $$
  with p as (select x.carried_in_cents, x.active_students from public.payout_periods x where x.period_id = p_period),
  i as (
    select private.pool_bps(p_period) as pool_bps,
           coalesce((select p.carried_in_cents from p), 0)::bigint as carried_in_cents,
           (select p.active_students from p) as active_students,
           array(select row(s.profile_id, s.base_cents)::private.payout_base
                 from private.close_input_students(p_period) s order by s.profile_id) as bases,
           array(select row(x.profile_id, x.teacher_id, x.tiebreak_rank, x.half_points)::private.payout_points
                 from private.close_input_points(p_period) x order by x.profile_id, x.teacher_id) as points,
           (select pg_catalog.jsonb_build_object('thresholds', t.thresholds, 'bps', t.bps) from private.pool_tiers_for(p_period) t) as tiers,
           (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('teacher_id', t.id, 'founder_since', t.founder_since)
                                                 order by t.id), '[]'::jsonb)
            from public.teachers t where t.is_founder) as founders,
           private.code_version() as code_version),
  k as (
    select i.*, pg_catalog.jsonb_build_object(
             'BOTE_REGLA_TRAMO', private.period_parameter('BOTE_REGLA_TRAMO', p_period),
             'BOTE_SIN_CONSUMO', private.period_parameter('BOTE_SIN_CONSUMO', p_period),
             'FUNDADOR_MULTIPLICADOR', private.period_parameter('FUNDADOR_MULTIPLICADOR', p_period),
             'founders', i.founders,
             'tiers', i.tiers, 'active_students', i.active_students) as parameters
    from i)
  select k.pool_bps, k.carried_in_cents, k.active_students, k.bases, k.points, k.parameters, k.code_version,
         pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'period', p_period, 'code_version', k.code_version, 'pool_bps', k.pool_bps,
           'carried_in_cents', k.carried_in_cents, 'parameters', k.parameters,
           'bases', pg_catalog.to_jsonb(k.bases), 'points', pg_catalog.to_jsonb(k.points))::text, 'UTF8'))
  from k
$$;
revoke all on function private.close_input(public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- El ensayo, con el bono que el cierre propondría (FL-50, paso 4). Lo calcula dentro del bloque que
-- atrapa errores: una regla mal escrita deja la corrida fallida.

create or replace function private.rehearse_close(p_period public.period_id) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_status public.period_status;
  v_row record;
  v_in record;
  v_lines private.payout_line[];
  v_bonuses jsonb;
  v_result bytea;
  v_error text;
  v_run uuid;
  v_net bigint;
  v_pools bigint;
  v_assigned bigint;
  v_carried_out bigint;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'rehearsals run in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_period is null then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  if (select t.thresholds from private.pool_tiers_for(p_period) t) is null then
    return '{"outcome": "before_launch"}'::jsonb;
  end if;
  if not exists (select 1 from public.payout_periods p where p.period_id = p_period) then
    return '{"outcome": "no_period"}'::jsonb;
  end if;

  select p.status, p.active_students, p.pool_bps, p.close_run_id into v_row
  from public.payout_periods p where p.period_id = p_period for share;
  v_status := v_row.status;
  if v_status in ('closed', 'paid') then
    return pg_catalog.jsonb_build_object('outcome', 'already_closed', 'close_run_id', v_row.close_run_id);
  end if;
  if v_status = 'closing' and v_row.active_students is null then
    return '{"outcome": "photo_missing"}'::jsonb;
  end if;
  if v_status = 'closing' and v_row.pool_bps is null then
    return '{"outcome": "no_pool_bps"}'::jsonb;
  end if;

  begin
    select * into v_in from private.close_input(p_period) i;
    v_lines := array(select row(x.kind, x.profile_id, x.teacher_id, x.tiebreak_rank, x.cents, x.base_cents, x.half_points)::private.payout_line
                     from private.compute_payout(v_in.pool_bps, v_in.carried_in_cents, v_in.bases, v_in.points) with ordinality x
                     order by x.ordinality);
    v_bonuses := coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(b) order by b.teacher_id)
                           from private.close_founder_bonuses(v_lines, v_in.parameters -> 'founders',
                                                              v_in.parameters -> 'FUNDADOR_MULTIPLICADOR', p_period) b),
                          '[]'::jsonb);
  exception when others then
    v_error := sqlstate || ': ' || pg_catalog.left(sqlerrm, 250);
  end;
  if v_error is not null then
    insert into public.close_runs (period_id, kind, status, period_status_at_run, code_version, parameters, started_by, error)
    values (p_period, 'rehearsal', 'failed', v_status, private.code_version(), '{}'::jsonb, private.actor_id(), v_error)
    returning id into v_run;
    return pg_catalog.jsonb_build_object('outcome', 'failed', 'run_id', v_run, 'error', v_error);
  end if;

  v_result := pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(v_lines)::text, 'UTF8'));
  select coalesce(pg_catalog.sum(l.base_cents) filter (where l.kind = 'student_pool'), 0),
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'student_pool'), 0),
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'share'), 0),
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'carried_over'), 0)
    into v_net, v_pools, v_assigned, v_carried_out
  from pg_catalog.unnest(v_lines) l;

  insert into public.close_runs (period_id, kind, status, period_status_at_run, input_hash, result_hash, code_version, parameters,
                                 active_students, pool_bps, carried_in_cents, net_revenue_cents, student_pools_cents, pool_cents,
                                 assigned_cents, unconsumed_cents, carried_out_cents, started_by)
  values (p_period, 'rehearsal', 'succeeded', v_status, v_in.input_hash, v_result, v_in.code_version, v_in.parameters,
          v_in.active_students, v_in.pool_bps, v_in.carried_in_cents, v_net, v_pools, v_pools + v_in.carried_in_cents,
          v_assigned, v_pools + v_in.carried_in_cents - v_assigned, v_carried_out, private.actor_id())
  returning id into v_run;
  insert into public.close_run_teacher_totals (close_run_id, teacher_id, half_points, students, assigned_cents, unconsumed_cents,
                                               total_cents, founder_bonus_cents)
  select v_run, t.teacher_id, t.half_points, t.students, t.assigned_cents, t.unconsumed_cents, t.total_cents, coalesce(b.amount_cents, 0)
  from private.close_teacher_totals(v_lines) t
  left join pg_catalog.jsonb_to_recordset(v_bonuses) as b (teacher_id uuid, amount_cents bigint) on b.teacher_id = t.teacher_id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'rehearsed', 'run_id', v_run, 'period_status_at_run', v_status,
    'input_hash', pg_catalog.encode(v_in.input_hash, 'hex'), 'result_hash', pg_catalog.encode(v_result, 'hex'),
    'pool_bps', v_in.pool_bps, 'carried_in_cents', v_in.carried_in_cents, 'net_revenue_cents', v_net,
    'student_pools_cents', v_pools, 'pool_cents', v_pools + v_in.carried_in_cents, 'assigned_cents', v_assigned,
    'unconsumed_cents', v_pools + v_in.carried_in_cents - v_assigned, 'carried_out_cents', v_carried_out,
    'founder_bonus_cents', (select coalesce(pg_catalog.sum((b ->> 'amount_cents')::bigint), 0)
                            from pg_catalog.jsonb_array_elements(v_bonuses) b),
    'founder_bonuses', (select coalesce(pg_catalog.jsonb_agg(b - 'multiplier_bps'), '[]'::jsonb)
                        from pg_catalog.jsonb_array_elements(v_bonuses) b));
end
$$;
revoke all on function private.rehearse_close(public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- El cierre, con las liquidaciones y el bono del fundador propuesto (05 §8.6, pasos 9 y 10). Todo se
-- escribe con el periodo todavía en cierre, en la misma transacción, antes de cerrarlo.

create or replace function private.close_period(p_period public.period_id) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_period public.payout_periods;
  v_blocking public.period_id;
  v_last public.run_status;
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
  select j.status into v_last
  from public.job_runs j
  where j.job = 'nightly_rollup' and j.period_id = p_period and j.started_at >= v_period.entered_closing_at
  order by j.started_at desc
  limit 1;
  if v_last is distinct from 'succeeded' and v_last is not null then
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

  select * into v_in from private.close_input(p_period) i;
  if not exists (select 1 from public.close_runs r
                 where r.period_id = p_period and r.kind = 'rehearsal' and r.status = 'succeeded'
                   and r.period_status_at_run = 'closing') then
    return '{"outcome": "rehearsal_missing"}'::jsonb;
  end if;
  if not exists (select 1 from public.close_runs r
                 where r.period_id = p_period and r.kind = 'rehearsal' and r.status = 'succeeded'
                   and r.period_status_at_run = 'closing' and r.input_hash = v_in.input_hash) then
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
  get diagnostics v_payouts = row_count;
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
    'outcome', 'closed', 'close_run_id', v_run,
    'input_hash', pg_catalog.encode(v_in.input_hash, 'hex'), 'result_hash', pg_catalog.encode(v_result, 'hex'),
    'pool_bps', v_in.pool_bps, 'carried_in_cents', v_in.carried_in_cents, 'net_revenue_cents', v_net,
    'student_pools_cents', v_pools, 'pool_cents', v_pools + v_in.carried_in_cents, 'assigned_cents', v_assigned,
    'unconsumed_cents', v_pools + v_in.carried_in_cents - v_assigned, 'carried_out_cents', v_carried_out,
    'carried_to', v_next, 'payouts', v_payouts,
    'founder_bonus_cents', (select coalesce(pg_catalog.sum((b ->> 'amount_cents')::bigint), 0)
                            from pg_catalog.jsonb_array_elements(v_bonuses) b));
end
$$;
revoke all on function private.close_period(public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- La comprobación al confirmar, con las liquidaciones (la 9) y el bono del fundador (la 10). La 6 del
-- 05 (las liquidaciones) aquí es la 9: la 6 ya era lo que pasa al siguiente.

create or replace function private.assert_period_balanced(p_period public.period_id) returns void
language plpgsql stable set search_path = ''
as $$
declare
  p public.payout_periods;
  v_pools bigint;
  v_bases bigint;
  v_shares bigint;
  v_totals bigint;
  v_bad integer;
  v_written private.payout_line[];
  v_computed private.payout_line[];
  v_params jsonb;
begin
  select * into strict p from public.payout_periods x where x.period_id = p_period;

  -- 1. Los botes de los alumnos suman el del periodo, y sus bases, el ingreso (RN-02, RN-03).
  select coalesce(pg_catalog.sum(s.pool_cents), 0), coalesce(pg_catalog.sum(s.base_cents), 0) into v_pools, v_bases
  from public.payout_student_pools s where s.period_id = p_period;
  if v_pools is distinct from p.student_pools_cents then
    raise exception 'period %: student pools sum % but the period says %', p_period, v_pools, p.student_pools_cents
      using errcode = '23514';
  end if;
  if v_bases is distinct from p.net_revenue_cents then
    raise exception 'period %: student bases sum % but the net revenue says %', p_period, v_bases, p.net_revenue_cents
      using errcode = '23514';
  end if;

  -- 2. Cada alumno con puntos reparte exactamente su bote, con sus medios puntos (RN-05, RN-07).
  select pg_catalog.count(*) into v_bad
  from public.payout_student_pools sp
  left join (select s.profile_id, pg_catalog.sum(s.amount_cents) as shared, pg_catalog.sum(s.half_points) as points
             from public.payout_shares s where s.period_id = p_period group by s.profile_id) x on x.profile_id = sp.profile_id
  where sp.period_id = p_period
    and (coalesce(x.points, 0) <> sp.half_points or (sp.half_points > 0 and coalesce(x.shared, 0) <> sp.pool_cents));
  if v_bad > 0 then
    raise exception 'period %: % students whose shares do not add up to their pool', p_period, v_bad using errcode = '23514';
  end if;

  -- 3. Lo asignado es la suma de las partes.
  select coalesce(pg_catalog.sum(s.amount_cents), 0) into v_shares from public.payout_shares s where s.period_id = p_period;
  if v_shares is distinct from p.assigned_cents then
    raise exception 'period %: shares sum % but assigned says %', p_period, v_shares, p.assigned_cents using errcode = '23514';
  end if;

  -- 4. Cada maestro con partes tiene su total, y sale de sus partes.
  select pg_catalog.count(*) into v_bad
  from (select distinct s.teacher_id from public.payout_shares s where s.period_id = p_period) s
  where not exists (select 1 from public.payout_teacher_totals t where t.period_id = p_period and t.teacher_id = s.teacher_id);
  if v_bad > 0 then
    raise exception 'period %: a teacher with shares has no total (%)', p_period, v_bad using errcode = '23514';
  end if;
  select pg_catalog.count(*) into v_bad
  from public.payout_teacher_totals t
  left join (select s.teacher_id, pg_catalog.sum(s.amount_cents) as cents, pg_catalog.sum(s.half_points) as points,
                    pg_catalog.count(*) as students
             from public.payout_shares s where s.period_id = p_period group by s.teacher_id) s on s.teacher_id = t.teacher_id
  where t.period_id = p_period
    and (s.teacher_id is null or t.assigned_cents <> s.cents or t.half_points <> s.points or t.students <> s.students);
  if v_bad > 0 then
    raise exception 'period %: % teacher totals do not match their shares', p_period, v_bad using errcode = '23514';
  end if;

  -- 5. RNF-04: lo que reciben los maestros, más lo que pasa al periodo siguiente, es el bote. Al centavo.
  select coalesce(pg_catalog.sum(t.total_cents), 0) into v_totals from public.payout_teacher_totals t where t.period_id = p_period;
  if v_totals + p.carried_out_cents is distinct from p.pool_cents then
    raise exception 'period %: teachers get % plus carried out % but the pool is % (RNF-04)',
      p_period, v_totals, p.carried_out_cents, p.pool_cents using errcode = '23514';
  end if;

  -- 6. Lo que pasa al siguiente llega (RN-06).
  if p.carried_out_cents > 0 and not exists (
       select 1 from public.payout_periods n
       where n.period_id = private.period_plus(p_period, 1) and n.carried_in_cents = p.carried_out_cents) then
    raise exception 'period %: the next period did not receive what this one passes on (%)', p_period, p.carried_out_cents
      using errcode = '23514';
  end if;

  -- 7. La corrida del cierre dice las mismas cifras, y le corresponde un ensayo con los datos finales y
  -- la misma entrada (RF-503).
  if not exists (
       select 1 from public.close_runs c
       where c.id = p.close_run_id and c.period_id = p_period and c.kind = 'close' and c.status = 'succeeded'
         and (c.active_students, c.pool_bps, c.carried_in_cents, c.net_revenue_cents, c.student_pools_cents, c.pool_cents,
              c.assigned_cents, c.unconsumed_cents, c.carried_out_cents)
             is not distinct from (p.active_students, p.pool_bps, p.carried_in_cents, p.net_revenue_cents, p.student_pools_cents,
                                   p.pool_cents, p.assigned_cents, p.unconsumed_cents, p.carried_out_cents)) then
    raise exception 'period %: the close run does not match the period', p_period using errcode = '23514';
  end if;
  if not exists (
       select 1 from public.close_runs c
       join public.close_runs r
         on r.period_id = c.period_id and r.kind = 'rehearsal' and r.status = 'succeeded'
        and r.period_status_at_run = 'closing' and r.input_hash = c.input_hash and r.result_hash = c.result_hash
       where c.id = p.close_run_id) then
    raise exception 'period %: no rehearsal with final data, the same input and the same result (RF-503)', p_period
      using errcode = '23514';
  end if;

  -- 8. Lo escrito es lo que calcula el reparto con lo escrito (las bases, los medios puntos, el
  -- porcentaje y lo recibido), línea por línea y en su orden, y su huella es la de la corrida. Así
  -- tampoco pasa un centavo movido entre dos partes del sin consumo o entre dos botes sin puntos, que
  -- las sumas de arriba no ven.
  v_written := array(
    select x.l from (
      select row('student_pool', s.profile_id, null, null, s.pool_cents, s.base_cents, s.half_points)::private.payout_line as l,
             1 as k, s.profile_id as a, null::bigint as b
      from public.payout_student_pools s where s.period_id = p_period
      union all
      select row('share', s.profile_id, s.teacher_id, t.tiebreak_rank, s.amount_cents, null, s.half_points)::private.payout_line,
             2, s.profile_id, t.tiebreak_rank
      from public.payout_shares s join public.teachers t on t.id = s.teacher_id where s.period_id = p_period
      union all
      select row('unconsumed_share', null, u.teacher_id, t.tiebreak_rank, u.unconsumed_cents, null, null)::private.payout_line,
             3, null, t.tiebreak_rank
      from public.payout_teacher_totals u join public.teachers t on t.id = u.teacher_id
      where u.period_id = p_period and u.unconsumed_cents > 0
      union all
      select row('carried_over', null, null, null, p.carried_out_cents, null, null)::private.payout_line, 4, null, null
      where p.carried_out_cents > 0) x
    order by x.k, x.a nulls first, x.b nulls first);
  v_computed := array(
    select row(c.kind, c.profile_id, c.teacher_id, c.tiebreak_rank, c.cents, c.base_cents, c.half_points)::private.payout_line
    from private.compute_payout(
      p.pool_bps, p.carried_in_cents,
      array(select row(s.profile_id, s.base_cents)::private.payout_base
            from public.payout_student_pools s where s.period_id = p_period order by s.profile_id),
      array(select row(s.profile_id, s.teacher_id, t.tiebreak_rank, s.half_points)::private.payout_points
            from public.payout_shares s join public.teachers t on t.id = s.teacher_id
            where s.period_id = p_period order by s.profile_id, s.teacher_id)) with ordinality c
    order by c.ordinality);
  if v_written::text is distinct from v_computed::text then
    raise exception 'period %: what was written is not what the payout computes', p_period using errcode = '23514';
  end if;
  if pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(v_written)::text, 'UTF8'))
     is distinct from (select c.result_hash from public.close_runs c where c.id = p.close_run_id) then
    raise exception 'period %: the close run result does not match what was written', p_period using errcode = '23514';
  end if;

  -- 9. Cada maestro con total tiene su liquidación, calculada, por su total y con la corrida del cierre;
  -- y no hay liquidación de quien no tiene total (RF-505).
  select pg_catalog.count(*) into v_bad
  from public.payout_teacher_totals t
  left join public.payouts y on y.period_id = t.period_id and y.teacher_id = t.teacher_id
  where t.period_id = p_period
    and (y.id is null or y.status <> 'calculated' or y.pool_cents <> t.total_cents or y.close_run_id <> p.close_run_id);
  if v_bad > 0 then
    raise exception 'period %: % teachers without a matching payout', p_period, v_bad using errcode = '23514';
  end if;
  select pg_catalog.count(*) into v_bad
  from public.payouts y
  where y.period_id = p_period
    and not exists (select 1 from public.payout_teacher_totals t where t.period_id = p_period and t.teacher_id = y.teacher_id);
  if v_bad > 0 then
    raise exception 'period %: % payouts without a teacher total', p_period, v_bad using errcode = '23514';
  end if;

  -- 10. Los bonos del fundador son exactamente los que da la regla con lo escrito y con la regla y los
  -- fundadores que leyó el cierre (no los de ahora): propuestos, con la corrida. Y la corrida dice lo
  -- mismo (RN-12).
  select c.parameters into v_params from public.close_runs c where c.id = p.close_run_id;
  if coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'teacher_id', b.teacher_id, 'basis_cents', b.basis_cents, 'multiplier_bps', b.multiplier_bps,
                        'amount_cents', b.amount_cents, 'status', b.status, 'close_run_id', b.close_run_id) order by b.teacher_id)
               from public.bonuses b where b.period_id = p_period and b.kind = 'founder'), '[]'::jsonb)
     is distinct from
     coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(b)
                        || pg_catalog.jsonb_build_object('status', 'proposed', 'close_run_id', p.close_run_id) order by b.teacher_id)
               from private.close_founder_bonuses(v_written, v_params -> 'founders', v_params -> 'FUNDADOR_MULTIPLICADOR', p_period) b),
              '[]'::jsonb) then
    raise exception 'period %: the founder bonuses are not what the close computes (RN-12)', p_period using errcode = '23514';
  end if;
  select pg_catalog.count(*) into v_bad
  from public.close_run_teacher_totals r
  left join public.bonuses b on b.period_id = p_period and b.kind = 'founder' and b.teacher_id = r.teacher_id
  where r.close_run_id = p.close_run_id and r.founder_bonus_cents <> coalesce(b.amount_cents, 0);
  if v_bad > 0 then
    raise exception 'period %: the close run founder bonus does not match (%)', p_period, v_bad using errcode = '23514';
  end if;
end
$$;
revoke all on function private.assert_period_balanced(public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- El vigilante: el área de las liquidaciones (de este carril). Nadie de la aplicación toca sus
-- tablas ni ejecuta sus funciones; ninguna corre como el dueño; y sus guardias están prendidas.

create function private.schema_violations_payouts()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  payout_tables (table_name) as (
    values ('public.payouts'), ('public.payout_status_events'), ('public.bonuses')),
  payout_functions (name) as (
    values ('founder_bonus'), ('close_founder_bonuses'), ('guard_payout'), ('guard_bonus'), ('log_payout_status')),
  found as (
    select f.name, p.oid, p.prosecdef, p.proconfig
    from payout_functions f
    join pg_catalog.pg_proc p on p.proname = f.name
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private'),
  payout_triggers (table_name, trigger_name, function_name) as (
    values ('public.payouts', 'payouts_guard', 'guard_payout'),
           ('public.payouts', 'require_period_closing', 'require_period_closing'),
           ('public.payouts', 'payouts_no_delete', 'reject_mutation'),
           ('public.payouts', 'payouts_no_truncate', 'reject_mutation'),
           ('public.payouts', 'payouts_log_status', 'log_payout_status'),
           ('public.payouts', 'audit_changes', 'audit_row_change'),
           ('public.payout_status_events', 'ledger_no_update_delete', 'reject_mutation'),
           ('public.payout_status_events', 'ledger_no_truncate', 'reject_mutation'),
           ('public.bonuses', 'bonuses_guard', 'guard_bonus'),
           ('public.bonuses', 'require_period_closing', 'require_period_closing'),
           ('public.bonuses', 'bonuses_no_delete', 'reject_mutation'),
           ('public.bonuses', 'bonuses_no_truncate', 'reject_mutation'),
           ('public.bonuses', 'audit_changes', 'audit_row_change'))
  select 'payouts table reachable by ' || r.rolname, t.table_name
  from app_roles r cross join payout_tables t
  where pg_catalog.to_regclass(t.table_name) is not null
    and (pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
         or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER'))
  union all
  select 'payouts function missing', 'private.' || f.name
  from payout_functions f
  where not exists (select 1 from found where found.name = f.name)
  union all
  select 'payouts function executable by ' || r.rolname, found.oid::regprocedure::text
  from app_roles r cross join found
  where pg_catalog.has_function_privilege(r.rolname::name, found.oid, 'EXECUTE')
  union all
  select 'payouts function security definer or without fixed search_path', found.oid::regprocedure::text
  from found
  where found.prosecdef or not coalesce(found.proconfig, '{}') @> array['search_path=""']
  union all
  select 'payouts trigger missing or disabled: ' || g.trigger_name, g.table_name
  from payout_triggers g
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = pg_catalog.to_regclass(g.table_name) and tg.tgname = g.trigger_name and tg.tgenabled in ('O', 'A')
      and n.nspname = 'private' and p.proname = g.function_name)
$$;
revoke all on function private.schema_violations_payouts() from public;
