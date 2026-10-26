-- T-603 · Liberar las liquidaciones, retenerlas, los bonos a mano, los ajustes, el saldo, el paso a pagado y
-- la purga de los latidos (RF-501, RF-505 a RF-508, RN-11, RN-12, RN-17; 05 §5.5, §7.3, §8.1, §9.4, §11.4 y
-- §13). Segunda de dos solicitudes; la primera (`t603_liquidaciones`) crea las liquidaciones al cerrar.
-- Decisiones de Sergio del 2026-10-25:
--   · se paga si el bruto (lo del bote, los bonos confirmados, los ajustes y el saldo anterior) llega a
--     `PAGO_MINIMO` (`>=`, y mayor que 0); si no, la liquidación queda acumulada y su bruto pasa al saldo,
--     que puede ser negativo (saldo en contra) y se descuenta de las siguientes;
--   · liberar lo hace finanzas con código reciente, en orden desde el arranque, con los bonos del
--     fundador decididos; las retenciones y el IVA quedan en 0 hasta T-409 (la lista de salida exige
--     T-409 antes de liberar en producción); la factura y pagada llegan con T-604;
--   · la retenida (RN-17), desde cualquier estado antes de pagada salvo acumulada, vuelve al estado en
--     que estaba; liberar no la toca, y soltar una retenida desde calculada en un periodo ya liberado
--     la libera ahí mismo;
--   · los bonos a mano nacen confirmados y se anulan mientras su periodo no se libere (después, con un
--     ajuste); uno capturado sobre un periodo liberado va al primero sin liberar después;
--   · un ajuste va al primer periodo sin liberar después de su origen (RF-507);
--   · todo maestro con algo pendiente tiene liquidación, aunque no tenga reparto en el periodo;
--   · el periodo pasa a pagado al instante, cuando su última liquidación queda pagada o acumulada;
--   · la purga de los latidos: `pg_cron` diario como el dueño, con cuatro condiciones (cerrado,
--     `RETENCION_LATIDOS` desde el cierre, sin retenidas, sin progreso por rehacer que dependa de esos
--     latidos), y borra las reproducciones que ya no tienen ninguna partición.
--
-- Nadie de la aplicación ejecuta estas funciones todavía (PA-81 a PA-83, T-605). El correo de cierre
-- listo sale al liberar y lo construye T-607.

-- ---------------------------------------------------------------------------------------
-- Las tablas.

create type public.balance_entry_kind as enum ('carried_forward', 'applied_to_payout', 'paid_on_exit');
revoke usage on type public.balance_entry_kind from public;

create table public.payout_adjustments (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id),
  origin_period_id public.period_id not null references public.payout_periods (period_id),
  applied_period_id public.period_id not null references public.payout_periods (period_id),
  amount_cents bigint not null,                     -- con signo: positivo a favor del maestro
  reason text not null,
  anomaly_alert_id uuid references public.anomaly_alerts (id),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint payout_adjustments_not_zero check (amount_cents <> 0),
  constraint payout_adjustments_later_period check (applied_period_id > origin_period_id),
  constraint payout_adjustments_reason_length check (pg_catalog.char_length(reason) between 1 and 2000)
);
comment on table public.payout_adjustments is 'Las correcciones de un periodo cerrado, en el primero sin liberar después (RF-507). Solo inserción.';
create index payout_adjustments_applied_idx on public.payout_adjustments (applied_period_id, teacher_id);

create table public.teacher_balance_entries (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id),
  payout_id uuid not null references public.payouts (id),
  period_id public.period_id not null references public.payout_periods (period_id),
  kind public.balance_entry_kind not null,
  amount_cents bigint not null,                     -- con signo; el saldo es la suma y puede ser negativo
  created_at timestamptz not null default clock_timestamp(),
  constraint teacher_balance_entries_not_zero check (amount_cents <> 0),
  constraint teacher_balance_entries_once unique (payout_id, kind)
);
comment on table public.teacher_balance_entries is 'El saldo de cada maestro como libro: lo acumulado por pago mínimo y el saldo en contra (RF-506, RF-507). Solo inserción.';
create index teacher_balance_entries_teacher_idx on public.teacher_balance_entries (teacher_id, created_at);

alter table public.payout_adjustments enable row level security;
alter table public.teacher_balance_entries enable row level security;
revoke all on public.payout_adjustments, public.teacher_balance_entries
  from public, anon, authenticated, service_role, app_service;

-- La liberación y el pago de un periodo. Las reglas van en su guardián, no en restricciones: las pruebas
-- que fuerzan un estado lo hacen con el guardián apagado.
alter table public.payout_periods
  add column payouts_released_at timestamptz,
  add column payouts_released_by uuid references public.profiles (id),
  add column paid_at timestamptz,
  add constraint payout_periods_released_pair check ((payouts_released_at is null) = (payouts_released_by is null));

-- Lo que el ensayo estima de cada liquidación: fuera de la huella.
alter table public.close_runs add column payout_preview jsonb;

-- ---------------------------------------------------------------------------------------
-- El guardián del periodo: un periodo cerrado se libera una vez y pasa a pagado; uno pagado no cambia.

create or replace function private.guard_payout_period() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_bounds record;
  v_close constant text[] := array['net_revenue_cents', 'student_pools_cents', 'pool_cents', 'assigned_cents',
                                   'unconsumed_cents', 'carried_out_cents', 'close_run_id', 'closed_at', 'closed_by'];
  v_previous record;
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception '%.%: periods are not deleted', tg_table_schema, tg_table_name using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.timezone is null or new.timezone !~ '^(UTC|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2})$' then
      raise exception '%.%: period % needs a named time zone', tg_table_schema, tg_table_name, new.period_id using errcode = '23514';
    end if;
    begin
      perform pg_catalog.timezone(new.timezone, pg_catalog.now());
    exception when others then
      raise exception '%.%: unknown time zone %', tg_table_schema, tg_table_name, new.timezone using errcode = '23514';
    end;
    select * into v_bounds from private.month_bounds(new.period_id, new.timezone) b;
    if new.starts_at is distinct from v_bounds.starts_at or new.ends_at is distinct from v_bounds.ends_at then
      raise exception '%.%: period % needs the instants of its month in %', tg_table_schema, tg_table_name, new.period_id, new.timezone
        using errcode = '23514';
    end if;
    if new.status not in ('open', 'closing') or new.carried_in_cents <> 0 or new.active_students is not null or new.pool_bps is not null
       or pg_catalog.num_nonnulls(new.net_revenue_cents, new.student_pools_cents, new.pool_cents, new.assigned_cents,
                                  new.unconsumed_cents, new.carried_out_cents, new.close_run_id, new.closed_at, new.closed_by,
                                  new.payouts_released_at, new.payouts_released_by, new.paid_at) > 0 then
      raise exception '%.%: period % starts open or closing, without figures', tg_table_schema, tg_table_name, new.period_id
        using errcode = '23514';
    end if;
    if new.status = 'closing' and not private.period_reached_closing(new.period_id) then
      raise exception '%.%: period % has not reached its closing day', tg_table_schema, tg_table_name, new.period_id
        using errcode = '23514';
    end if;
    new.entered_closing_at := case when new.status = 'closing' then pg_catalog.now() end;
    new.created_at := pg_catalog.now();
    return new;
  end if;

  if old.status = 'paid' then
    if pg_catalog.to_jsonb(new) is distinct from pg_catalog.to_jsonb(old) then
      raise exception '%.%: period % is paid: it does not change', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    return new;
  end if;
  if old.status = 'closed' then
    if pg_catalog.to_jsonb(new) is not distinct from pg_catalog.to_jsonb(old) then
      return new;
    end if;
    -- Liberar las liquidaciones (T-603): una vez, solo eso, con los bonos del fundador decididos; la hora
    -- y quién los pone la base.
    if (pg_catalog.to_jsonb(new) - array['payouts_released_at', 'payouts_released_by'])
       is not distinct from (pg_catalog.to_jsonb(old) - array['payouts_released_at', 'payouts_released_by']) then
      if old.payouts_released_at is not null or new.payouts_released_at is null then
        raise exception '%.%: the payouts of period % are released once', tg_table_schema, tg_table_name, old.period_id
          using errcode = '23514';
      end if;
      if private.actor_id() is null then
        raise exception '%.%: the payouts of period % are released by someone', tg_table_schema, tg_table_name, old.period_id
          using errcode = '23514';
      end if;
      if exists (select 1 from public.bonuses b where b.period_id = old.period_id and b.kind = 'founder' and b.status = 'proposed') then
        raise exception '%.%: period % still has founder bonuses to decide', tg_table_schema, tg_table_name, old.period_id
          using errcode = '23514';
      end if;
      new.payouts_released_by := private.actor_id();
      new.payouts_released_at := pg_catalog.now();
      return new;
    end if;
    -- De cerrado a pagado (RF-501): liberado, y con todas sus liquidaciones pagadas o acumuladas. La hora
    -- la pone la base.
    if new.status = 'paid'
       and (pg_catalog.to_jsonb(new) - array['status', 'paid_at']) is not distinct from (pg_catalog.to_jsonb(old) - array['status', 'paid_at']) then
      if old.payouts_released_at is null then
        raise exception '%.%: period % is paid only once its payouts are released', tg_table_schema, tg_table_name, old.period_id
          using errcode = '23514';
      end if;
      if exists (select 1 from public.payouts y where y.period_id = old.period_id and y.status not in ('paid', 'carried_forward')) then
        raise exception '%.%: period % still has payouts to settle', tg_table_schema, tg_table_name, old.period_id
          using errcode = '23514';
      end if;
      new.paid_at := pg_catalog.now();
      return new;
    end if;
    raise exception '%.%: period % is closed: it changes only to release its payouts or to paid', tg_table_schema, tg_table_name,
      old.period_id using errcode = '23514';
  end if;

  if new.carried_in_cents is distinct from old.carried_in_cents then
    if (pg_catalog.to_jsonb(new) - 'carried_in_cents') is distinct from (pg_catalog.to_jsonb(old) - 'carried_in_cents')
       or old.carried_in_cents <> 0 then
      raise exception '%.%: what period % receives is written once, alone', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    select p.status, p.carried_out_cents into v_previous
    from public.payout_periods p where p.period_id = private.period_plus(old.period_id, -1);
    if v_previous.status is distinct from 'closed' or v_previous.carried_out_cents is distinct from new.carried_in_cents then
      raise exception '%.%: period % receives only what the closed period before it passes on', tg_table_schema, tg_table_name,
        old.period_id using errcode = '23514';
    end if;
    return new;
  end if;

  if new.status = 'closed' then
    if old.status <> 'closing' then
      raise exception '%.%: period % closes only from closing', tg_table_schema, tg_table_name, old.period_id using errcode = '23514';
    end if;
    if (pg_catalog.to_jsonb(new) - (v_close || 'status'::text)) is distinct from (pg_catalog.to_jsonb(old) - (v_close || 'status'::text)) then
      raise exception '%.%: closing period % writes only its close figures', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    if pg_catalog.num_nulls(new.net_revenue_cents, new.student_pools_cents, new.pool_cents, new.assigned_cents,
                            new.unconsumed_cents, new.carried_out_cents, new.close_run_id) > 0
       or old.active_students is null or old.pool_bps is null then
      raise exception '%.%: period % closes with all its figures and its photo', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    if private.actor_id() is null then
      raise exception '%.%: period % is closed by someone', tg_table_schema, tg_table_name, old.period_id using errcode = '23514';
    end if;
    new.closed_by := private.actor_id();
    new.closed_at := pg_catalog.now();
    return new;
  end if;

  if (pg_catalog.to_jsonb(new) - array['status', 'entered_closing_at', 'active_students', 'pool_bps'])
     is distinct from (pg_catalog.to_jsonb(old) - array['status', 'entered_closing_at', 'active_students', 'pool_bps']) then
    raise exception '%.%: only the status of period % changes', tg_table_schema, tg_table_name, old.period_id using errcode = '23514';
  end if;
  if new.active_students is distinct from old.active_students or new.pool_bps is distinct from old.pool_bps then
    if not private.actor_is_system() then
      raise exception '%.%: the photo of period % is taken by the system', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    if old.active_students is not null or old.pool_bps is not null or new.active_students is null then
      raise exception '%.%: the photo of period % is taken once, with its active students', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    if pg_catalog.now() < old.ends_at then
      raise exception '%.%: period % has not ended: no photo yet', tg_table_schema, tg_table_name, old.period_id using errcode = '23514';
    end if;
    if new.status is distinct from old.status or new.entered_closing_at is distinct from old.entered_closing_at then
      raise exception '%.%: the photo of period % does not change its status', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.status = old.status then
    if new.entered_closing_at is distinct from old.entered_closing_at then
      raise exception '%.%: the closing time of period % does not change', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    return new;
  end if;
  if not (old.status = 'open' and new.status = 'closing') then
    raise exception '%.%: period % goes only from open to closing, and from closing to closed', tg_table_schema, tg_table_name,
      old.period_id using errcode = '23514';
  end if;
  if old.active_students is null then
    raise exception '%.%: period % needs its photo before closing', tg_table_schema, tg_table_name, old.period_id
      using errcode = '23514';
  end if;
  if not private.period_reached_closing(old.period_id) then
    raise exception '%.%: period % has not reached its closing day', tg_table_schema, tg_table_name, old.period_id
      using errcode = '23514';
  end if;
  new.entered_closing_at := pg_catalog.now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Los guardianes de las liquidaciones, los bonos, los ajustes y el saldo. Escribe solo el dueño (nadie
-- de la aplicación tiene permisos); los guardianes dicen qué pasos hay.

-- Una liquidación nace calculada con lo que le tocó del bote: en el cierre (el periodo en cierre, con su
-- corrida) o después, en un periodo cerrado sin liberar, para quien tiene algo pendiente (con su total, o
-- 0). Sus pasos en T-603: liberar (de calculada a en espera de factura o acumulada, y solo aquí cambian
-- los montos), retener desde cualquier estado antes de pagada salvo acumulada (guarda a dónde vuelve), y
-- soltar (vuelve a ese estado). Lo demás llega con T-604.
create or replace function private.guard_payout() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_period record;
  v_total bigint;
begin
  if tg_op = 'INSERT' then
    if new.pool_cents < 0 or new.adjustments_cents <> 0 or new.balance_applied_cents <> 0
       or new.subtotal_cents <> new.pool_cents or new.net_cents <> new.pool_cents
       or pg_catalog.num_nonnulls(new.released_at, new.released_by, new.held_from_status, new.held_at, new.held_by,
                                  new.hold_reason, new.anomaly_alert_id) > 0 then
      raise exception '%.%: a payout is born calculated, with its share of the pool and nothing else', tg_table_schema, tg_table_name
        using errcode = '23514';
    end if;
    select p.status, p.close_run_id, p.payouts_released_at into v_period
    from public.payout_periods p where p.period_id = new.period_id;
    if v_period.status = 'closing' then
      if not exists (select 1 from public.close_runs r
                     where r.id = new.close_run_id and r.period_id = new.period_id and r.kind = 'close') then
        raise exception '%.%: period % is not being closed', tg_table_schema, tg_table_name, new.period_id using errcode = '55000';
      end if;
    elsif v_period.status = 'closed' and v_period.payouts_released_at is null then
      select t.total_cents into v_total
      from public.payout_teacher_totals t where t.period_id = new.period_id and t.teacher_id = new.teacher_id;
      if new.close_run_id is distinct from v_period.close_run_id or new.pool_cents <> coalesce(v_total, 0) then
        raise exception '%.%: a payout of period % carries its close run and what the teacher got from the pool',
          tg_table_schema, tg_table_name, new.period_id using errcode = '23514';
      end if;
    else
      raise exception '%.%: period % takes no new payouts', tg_table_schema, tg_table_name, new.period_id using errcode = '55000';
    end if;
    new.created_at := pg_catalog.now();
    new.updated_at := pg_catalog.now();
    return new;
  end if;

  if pg_catalog.to_jsonb(new) is not distinct from pg_catalog.to_jsonb(old) then
    return new;
  end if;
  if (new.id, new.period_id, new.teacher_id, new.close_run_id, new.pool_cents, new.created_at)
     is distinct from (old.id, old.period_id, old.teacher_id, old.close_run_id, old.pool_cents, old.created_at) then
    raise exception '%.%: payout %: its period, teacher, close run and share of the pool do not change', tg_table_schema,
      tg_table_name, old.id using errcode = '23514';
  end if;
  new.updated_at := pg_catalog.now();

  -- Liberar.
  if old.status = 'calculated' and new.status in ('awaiting_invoice', 'carried_forward') then
    if new.vat_cents <> 0 or new.income_tax_withheld_cents <> 0 or new.vat_withheld_cents <> 0 or new.net_cents <> new.subtotal_cents
       or pg_catalog.num_nonnulls(new.held_from_status, new.held_at, new.held_by, new.hold_reason, new.anomaly_alert_id) > 0 then
      raise exception '%.%: payout % is released without taxes (they come with T-409) and without a hold', tg_table_schema,
        tg_table_name, old.id using errcode = '23514';
    end if;
    if private.actor_id() is null then
      raise exception '%.%: payout % is released by someone', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    new.released_at := pg_catalog.now();
    new.released_by := private.actor_id();
    return new;
  end if;

  if (new.bonuses_cents, new.adjustments_cents, new.balance_applied_cents, new.subtotal_cents, new.vat_cents,
      new.income_tax_withheld_cents, new.vat_withheld_cents, new.net_cents, new.released_at, new.released_by)
     is distinct from
     (old.bonuses_cents, old.adjustments_cents, old.balance_applied_cents, old.subtotal_cents, old.vat_cents,
      old.income_tax_withheld_cents, old.vat_withheld_cents, old.net_cents, old.released_at, old.released_by) then
    raise exception '%.%: payout %: its amounts change only when it is released (RF-505)', tg_table_schema, tg_table_name, old.id
      using errcode = '23514';
  end if;

  -- Retener (RN-17).
  if new.status = 'on_hold' and old.status in ('calculated', 'awaiting_invoice', 'invoice_in_review', 'invoice_rejected', 'ready_to_pay') then
    if private.actor_id() is null then
      raise exception '%.%: payout % is held by someone', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    new.held_from_status := old.status;
    new.held_at := pg_catalog.now();
    new.held_by := private.actor_id();
    return new;
  end if;

  -- Soltar: vuelve al estado en que estaba.
  if old.status = 'on_hold' and new.status = old.held_from_status then
    new.held_from_status := null;
    new.held_at := null;
    new.held_by := null;
    new.hold_reason := null;
    new.anomaly_alert_id := null;
    return new;
  end if;

  raise exception '%.%: payout % does not go from % to % (the invoice and paid come with T-604)', tg_table_schema, tg_table_name,
    old.id, old.status, new.status using errcode = '23514';
end
$$;
revoke all on function private.guard_payout() from public;

-- Cada nacimiento y cada cambio de estado, con quién (nulo si es el sistema) y una nota: el motivo al
-- retener, y si no, el de la sesión (`app.reason`), como en la auditoría.
create or replace function private.log_payout_status() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status = old.status then
    return null;
  end if;
  insert into public.payout_status_events (payout_id, from_status, to_status, actor_id, note)
  values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, private.actor_id(),
          case when new.status = 'on_hold' then new.hold_reason
               else nullif(pg_catalog.current_setting('app.reason', true), '') end);
  return null;
end
$$;
revoke all on function private.log_payout_status() from public;

-- El bono del fundador nace propuesto en el cierre (el periodo en cierre, con su corrida). Uno a mano
-- nace confirmado, a nombre de quien lo captura, en un periodo sin liberar. El del fundador se confirma;
-- cualquiera se anula con su motivo. Todo cambio, mientras su periodo no se libere: después, un ajuste.
create or replace function private.guard_bonus() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_period record;
begin
  if tg_op = 'INSERT' then
    if new.kind = 'founder' then
      if new.status <> 'proposed'
         or pg_catalog.num_nonnulls(new.decided_at, new.decided_by, new.voided_at, new.voided_by, new.void_reason) > 0 then
        raise exception '%.%: the founder bonus is born proposed', tg_table_schema, tg_table_name using errcode = '23514';
      end if;
      if (select p.status from public.payout_periods p where p.period_id = new.period_id) is distinct from 'closing'
         or not exists (select 1 from public.close_runs r
                        where r.id = new.close_run_id and r.period_id = new.period_id and r.kind = 'close') then
        raise exception '%.%: period % is not being closed', tg_table_schema, tg_table_name, new.period_id using errcode = '55000';
      end if;
      new.created_at := pg_catalog.now();
      return new;
    end if;
    if private.actor_id() is null
       or pg_catalog.num_nonnulls(new.voided_at, new.voided_by, new.void_reason) > 0 then
      raise exception '%.%: a bonus by hand is captured by someone, confirmed', tg_table_schema, tg_table_name using errcode = '23514';
    end if;
    select p.status, p.payouts_released_at into v_period from public.payout_periods p where p.period_id = new.period_id;
    if not found or v_period.payouts_released_at is not null or v_period.status = 'paid' then
      raise exception '%.%: period % is released: a bonus goes to the next one', tg_table_schema, tg_table_name, new.period_id
        using errcode = '55000';
    end if;
    new.status := 'confirmed';
    new.created_by := private.actor_id();
    new.decided_by := private.actor_id();
    new.decided_at := pg_catalog.now();
    new.created_at := pg_catalog.now();
    return new;
  end if;

  if (new.id, new.teacher_id, new.period_id, new.kind, new.amount_cents, new.basis_cents, new.multiplier_bps, new.reason,
      new.close_run_id, new.created_by, new.created_at)
     is distinct from (old.id, old.teacher_id, old.period_id, old.kind, old.amount_cents, old.basis_cents, old.multiplier_bps,
                       old.reason, old.close_run_id, old.created_by, old.created_at) then
    raise exception '%.%: bonus % is not edited: it is voided', tg_table_schema, tg_table_name, old.id using errcode = '23514';
  end if;
  if (select p.payouts_released_at from public.payout_periods p where p.period_id = old.period_id) is not null then
    raise exception '%.%: bonus % belongs to a released period: it is corrected with an adjustment', tg_table_schema, tg_table_name,
      old.id using errcode = '55000';
  end if;
  if private.actor_id() is null then
    raise exception '%.%: bonus % is decided by someone', tg_table_schema, tg_table_name, old.id using errcode = '23514';
  end if;
  if old.status = 'proposed' and new.status = 'confirmed' and old.kind = 'founder' then
    new.decided_by := private.actor_id();
    new.decided_at := pg_catalog.now();
    return new;
  end if;
  if old.status in ('proposed', 'confirmed') and new.status = 'void' then
    new.voided_by := private.actor_id();
    new.voided_at := pg_catalog.now();
    if old.status = 'proposed' then
      new.decided_by := private.actor_id();
      new.decided_at := pg_catalog.now();
    end if;
    return new;
  end if;
  raise exception '%.%: bonus % does not go from % to %', tg_table_schema, tg_table_name, old.id, old.status, new.status
    using errcode = '23514';
end
$$;
revoke all on function private.guard_bonus() from public;

-- Un ajuste sale de un periodo cerrado o pagado y entra a uno sin liberar después; lo captura alguien.
create function private.guard_payout_adjustment() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_applied record;
begin
  if private.actor_id() is null then
    raise exception '%.%: an adjustment is captured by someone', tg_table_schema, tg_table_name using errcode = '23514';
  end if;
  if (select p.status from public.payout_periods p where p.period_id = new.origin_period_id) not in ('closed', 'paid') then
    raise exception '%.%: period % is not closed: an adjustment corrects a closed one', tg_table_schema, tg_table_name,
      new.origin_period_id using errcode = '55000';
  end if;
  select p.status, p.payouts_released_at into v_applied from public.payout_periods p where p.period_id = new.applied_period_id;
  if not found or v_applied.payouts_released_at is not null or v_applied.status = 'paid' then
    raise exception '%.%: period % is released: the adjustment goes to the next one', tg_table_schema, tg_table_name,
      new.applied_period_id using errcode = '55000';
  end if;
  new.created_by := private.actor_id();
  new.created_at := pg_catalog.now();
  return new;
end
$$;
revoke all on function private.guard_payout_adjustment() from public;

-- Un renglón del saldo es de su liquidación. Pagar el saldo al salir llega con la baja de un maestro.
create function private.guard_balance_entry() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.kind = 'paid_on_exit' then
    raise exception '%.%: paying a balance on exit comes when a teacher can leave', tg_table_schema, tg_table_name
      using errcode = '23514';
  end if;
  if not exists (select 1 from public.payouts y
                 where y.id = new.payout_id and y.teacher_id = new.teacher_id and y.period_id = new.period_id) then
    raise exception '%.%: a balance entry belongs to its payout', tg_table_schema, tg_table_name using errcode = '23514';
  end if;
  new.created_at := pg_catalog.clock_timestamp();
  return new;
end
$$;
revoke all on function private.guard_balance_entry() from public;

-- Las liquidaciones nacen también después del cierre, y los bonos a mano en un periodo abierto: lo que
-- `require_period_closing` revisaba lo revisan ahora sus guardianes.
drop trigger require_period_closing on public.payouts;
drop trigger require_period_closing on public.bonuses;
create trigger payout_adjustments_guard before insert on public.payout_adjustments
  for each row execute function private.guard_payout_adjustment();
create trigger ledger_no_update_delete before update or delete on public.payout_adjustments
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on public.payout_adjustments
  for each statement execute function private.reject_mutation();
create trigger audit_changes after insert on public.payout_adjustments
  for each row execute function private.audit_row_change('money');
create trigger teacher_balance_entries_guard before insert on public.teacher_balance_entries
  for each row execute function private.guard_balance_entry();
create trigger ledger_no_update_delete before update or delete on public.teacher_balance_entries
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on public.teacher_balance_entries
  for each statement execute function private.reject_mutation();

-- ---------------------------------------------------------------------------------------
-- Las piezas de liberar.

-- El saldo de un maestro: la suma de su libro.
create function private.teacher_balance(p_teacher uuid) returns bigint
language sql stable set search_path = ''
as $$
  select coalesce(pg_catalog.sum(e.amount_cents), 0)::bigint from public.teacher_balance_entries e where e.teacher_id = p_teacher
$$;
revoke all on function private.teacher_balance(uuid) from public;

-- Quién tiene algo pendiente en un periodo: saldo distinto de 0, un ajuste que entra ahí o un bono
-- confirmado ahí.
create function private.payout_pending_teachers(p_period public.period_id) returns setof uuid
language sql stable set search_path = ''
as $$
  select x.teacher_id from (
    select e.teacher_id from public.teacher_balance_entries e group by e.teacher_id having pg_catalog.sum(e.amount_cents) <> 0
    union
    select a.teacher_id from public.payout_adjustments a where a.applied_period_id = p_period
    union
    select b.teacher_id from public.bonuses b where b.period_id = p_period and b.status = 'confirmed') x
  order by x.teacher_id
$$;
revoke all on function private.payout_pending_teachers(public.period_id) from public;

-- El primer periodo sin liberar desde uno dado (puede no tener fila todavía).
create function private.first_unreleased_period(p_from public.period_id) returns public.period_id
language plpgsql stable set search_path = ''
as $$
declare
  v public.period_id := p_from;
begin
  while exists (select 1 from public.payout_periods p where p.period_id = v and p.payouts_released_at is not null) loop
    v := private.period_plus(v, 1);
  end loop;
  return v;
end
$$;
revoke all on function private.first_unreleased_period(public.period_id) from public;

-- La liquidación de un maestro en un periodo cerrado sin liberar: la que tiene, o una nueva con su total
-- (o 0).
create function private.ensure_payout(p_period public.period_id, p_teacher uuid) returns uuid
language plpgsql volatile set search_path = ''
as $$
declare
  v uuid;
begin
  select y.id into v from public.payouts y where y.period_id = p_period and y.teacher_id = p_teacher;
  if found then
    return v;
  end if;
  insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, subtotal_cents, net_cents)
  select p_period, p_teacher, p.close_run_id, coalesce(t.total_cents, 0), coalesce(t.total_cents, 0), coalesce(t.total_cents, 0)
  from public.payout_periods p
  left join public.payout_teacher_totals t on t.period_id = p.period_id and t.teacher_id = p_teacher
  where p.period_id = p_period
  returning id into v;
  return v;
end
$$;
revoke all on function private.ensure_payout(public.period_id, uuid) from public;

-- Un periodo liberado pasa a pagado al instante cuando no le queda ninguna liquidación por pagar (las
-- vencidas de factura las suma T-604). Devuelve su estado.
create function private.settle_period(p_period public.period_id) returns public.period_status
language plpgsql volatile set search_path = ''
as $$
declare
  v public.period_status;
begin
  update public.payout_periods p set status = 'paid'
  where p.period_id = p_period and p.status = 'closed' and p.payouts_released_at is not null
    and not exists (select 1 from public.payouts y where y.period_id = p_period and y.status not in ('paid', 'carried_forward'));
  select p.status into v from public.payout_periods p where p.period_id = p_period;
  return v;
end
$$;
revoke all on function private.settle_period(public.period_id) from public;

-- Libera una liquidación calculada (RF-505, RF-506): suma sus bonos confirmados, sus ajustes y el saldo
-- de su maestro; si el bruto llega al mínimo (y es mayor que 0) espera su factura, y si no queda
-- acumulada y su bruto pasa al saldo. Con el candado del saldo del maestro: dos liberaciones del mismo
-- maestro van una tras otra.
create function private.release_payout(p_payout uuid, p_minimum bigint) returns public.payout_status
language plpgsql volatile set search_path = ''
as $$
declare
  y public.payouts;
  v_balance bigint;
  v_bonuses bigint;
  v_adjustments bigint;
  v_subtotal bigint;
  v_status public.payout_status;
begin
  select * into strict y from public.payouts x where x.id = p_payout for update;
  if y.status <> 'calculated' then
    return y.status;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('teacher_balance:' || y.teacher_id::text, 0));
  v_balance := private.teacher_balance(y.teacher_id);
  select coalesce(pg_catalog.sum(b.amount_cents), 0) into v_bonuses
  from public.bonuses b where b.period_id = y.period_id and b.teacher_id = y.teacher_id and b.status = 'confirmed';
  select coalesce(pg_catalog.sum(a.amount_cents), 0) into v_adjustments
  from public.payout_adjustments a where a.applied_period_id = y.period_id and a.teacher_id = y.teacher_id;
  v_subtotal := y.pool_cents + v_bonuses + v_adjustments + v_balance;
  v_status := case when v_subtotal >= p_minimum and v_subtotal > 0 then 'awaiting_invoice' else 'carried_forward' end;
  if v_balance <> 0 then
    insert into public.teacher_balance_entries (teacher_id, payout_id, period_id, kind, amount_cents)
    values (y.teacher_id, y.id, y.period_id, 'applied_to_payout', -v_balance);
  end if;
  if v_status = 'carried_forward' and v_subtotal <> 0 then
    insert into public.teacher_balance_entries (teacher_id, payout_id, period_id, kind, amount_cents)
    values (y.teacher_id, y.id, y.period_id, 'carried_forward', v_subtotal);
  end if;
  -- `released_at` va en la sentencia (el guardián pone la hora y quién): la comprobación al confirmar
  -- cuelga de esa columna.
  update public.payouts x
  set status = v_status, bonuses_cents = v_bonuses, adjustments_cents = v_adjustments, balance_applied_cents = v_balance,
      subtotal_cents = v_subtotal, net_cents = v_subtotal, released_at = pg_catalog.now(), released_by = private.actor_id()
  where x.id = p_payout;
  return v_status;
end
$$;
revoke all on function private.release_payout(uuid, bigint) from public;

-- El mínimo de un periodo, o nulo si no está o no es un número entero de centavos.
create function private.minimum_payout(p_period public.period_id) returns bigint
language plpgsql stable set search_path = ''
as $$
declare
  v jsonb := private.period_parameter('PAGO_MINIMO', p_period);
begin
  if pg_catalog.jsonb_typeof(v) is distinct from 'number' then
    return null;
  end if;
  if (v #>> '{}')::numeric <> pg_catalog.trunc((v #>> '{}')::numeric) or (v #>> '{}')::numeric < 0 then
    return null;
  end if;
  return (v #>> '{}')::bigint;
end
$$;
revoke all on function private.minimum_payout(public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- Las funciones de finanzas. Corren como el dueño, solo en read committed y con la puerta de finanzas
-- (`forbidden`, `needs_fresh_code`); contestan con su resultado. Toman la fila del periodo antes que
-- cualquier liquidación: liberar la toma para sí, las demás con candado compartido (soltar, para sí:
-- puede pasar el periodo a pagado).

-- Liberar (RF-505): en orden desde el arranque, con los bonos del fundador decididos y el mínimo del
-- periodo. Le da su liquidación a quien tiene algo pendiente, libera cada calculada (las retenidas no),
-- marca el periodo como liberado y, si no queda nada por pagar, lo pasa a pagado.
create function private.release_payouts(p_period public.period_id) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_period public.payout_periods;
  v_blocking public.period_id;
  v_pending integer;
  v_minimum bigint;
  v_teacher uuid;
  v_payout uuid;
  v_status public.payout_status;
  v_released integer := 0;
  v_awaiting integer := 0;
  v_carried integer := 0;
  v_held integer;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'releases run in read committed' using errcode = '25000';
  end if;
  set constraints public.payouts_released deferred;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_period is null then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select * into v_period from public.payout_periods p where p.period_id = p_period for update;
  if not found or v_period.status in ('open', 'closing') then
    return '{"outcome": "not_closed"}'::jsonb;
  end if;
  if v_period.payouts_released_at is not null then
    return pg_catalog.jsonb_build_object('outcome', 'already_released', 'period_id', p_period);
  end if;
  select pg_catalog.min(q.period_id) into v_blocking
  from public.payout_periods q
  where q.period_id < p_period and q.payouts_released_at is null
    and q.period_id >= (select pg_catalog.min(t.effective_period_id) from public.pool_tiers t where t.canceled_at is null);
  if v_blocking is not null then
    return pg_catalog.jsonb_build_object('outcome', 'previous_not_released', 'period', v_blocking);
  end if;
  select pg_catalog.count(*) into v_pending
  from public.bonuses b where b.period_id = p_period and b.kind = 'founder' and b.status = 'proposed';
  if v_pending > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'founder_bonuses_pending', 'count', v_pending);
  end if;
  v_minimum := private.minimum_payout(p_period);
  if v_minimum is null then
    return '{"outcome": "no_minimum"}'::jsonb;
  end if;

  for v_teacher in select * from private.payout_pending_teachers(p_period) loop
    perform private.ensure_payout(p_period, v_teacher);
  end loop;
  for v_payout in select y.id from public.payouts y where y.period_id = p_period and y.status = 'calculated' order by y.teacher_id loop
    v_status := private.release_payout(v_payout, v_minimum);
    v_released := v_released + 1;
    if v_status = 'awaiting_invoice' then
      v_awaiting := v_awaiting + 1;
    else
      v_carried := v_carried + 1;
    end if;
  end loop;
  select pg_catalog.count(*) into v_held from public.payouts y where y.period_id = p_period and y.status = 'on_hold';
  update public.payout_periods p set payouts_released_at = pg_catalog.now() where p.period_id = p_period;
  return pg_catalog.jsonb_build_object(
    'outcome', 'released', 'period_id', p_period, 'released', v_released, 'awaiting_invoice', v_awaiting,
    'carried_forward', v_carried, 'held', v_held, 'period_status', private.settle_period(p_period));
end
$$;
revoke all on function private.release_payouts(public.period_id) from public;

-- Retener una liquidación mientras se investiga (RN-17), con su motivo y, si la hay, su alerta.
create function private.hold_payout(p_payout uuid, p_reason text, p_alert uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_period public.period_id;
  y public.payouts;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'holds run in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_payout is null or pg_catalog.btrim(coalesce(p_reason, '')) = '' or pg_catalog.char_length(p_reason) > 2000 then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select x.period_id into v_period from public.payouts x where x.id = p_payout;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  perform 1 from public.payout_periods p where p.period_id = v_period for share;
  select * into y from public.payouts x where x.id = p_payout for update;
  if p_alert is not null and not exists (select 1 from public.anomaly_alerts a where a.id = p_alert) then
    return '{"outcome": "no_alert"}'::jsonb;
  end if;
  if y.status = 'on_hold' then
    return '{"outcome": "already_held"}'::jsonb;
  end if;
  if y.status in ('carried_forward', 'paid', 'payment_returned') then
    return pg_catalog.jsonb_build_object('outcome', 'not_holdable', 'status', y.status);
  end if;
  update public.payouts x set status = 'on_hold', hold_reason = pg_catalog.btrim(p_reason), anomaly_alert_id = p_alert
  where x.id = p_payout;
  return pg_catalog.jsonb_build_object('outcome', 'held', 'from', y.status);
end
$$;
revoke all on function private.hold_payout(uuid, text, uuid) from public;

-- Soltar una retenida: vuelve al estado en que estaba, con la nota en su historia. Si estaba calculada y
-- el periodo ya se liberó, se libera ahí mismo; y si ya no queda nada por pagar, el periodo pasa a
-- pagado.
create function private.unhold_payout(p_payout uuid, p_note text) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_period public.payout_periods;
  v_period_id public.period_id;
  y public.payouts;
  v_to public.payout_status;
  v_reason text;
  v_minimum bigint;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'holds run in read committed' using errcode = '25000';
  end if;
  set constraints public.payouts_released deferred;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_payout is null or pg_catalog.char_length(p_note) > 2000 then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select x.period_id into v_period_id from public.payouts x where x.id = p_payout;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  select * into v_period from public.payout_periods p where p.period_id = v_period_id for update;
  select * into y from public.payouts x where x.id = p_payout for update;
  if y.status <> 'on_hold' then
    return '{"outcome": "not_held"}'::jsonb;
  end if;
  v_to := y.held_from_status;
  v_reason := pg_catalog.current_setting('app.reason', true);
  perform pg_catalog.set_config('app.reason', coalesce(nullif(pg_catalog.btrim(p_note), ''), ''), true);
  update public.payouts x set status = v_to where x.id = p_payout;
  perform pg_catalog.set_config('app.reason', coalesce(v_reason, ''), true);
  if v_to = 'calculated' and v_period.payouts_released_at is not null then
    v_minimum := private.minimum_payout(v_period_id);
    if v_minimum is null then
      raise exception 'period % was released without a minimum payout', v_period_id using errcode = 'P0001';
    end if;
    v_to := private.release_payout(p_payout, v_minimum);
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'released_from_hold', 'to', v_to, 'period_status', private.settle_period(v_period_id));
end
$$;
revoke all on function private.unhold_payout(uuid, text) from public;

-- Capturar un bono a mano (RF-508): nace confirmado. Sobre un periodo liberado va al primero sin liberar
-- después (le abre la fila si hace falta); si ese periodo ya cerró, el maestro recibe su liquidación.
create function private.capture_bonus(p_teacher uuid, p_kind text, p_amount bigint, p_period public.period_id, p_reason text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_launch public.period_id;
  v_target public.period_id;
  v_row record;
  v_bonus uuid;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'bonuses are captured in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_teacher is null or p_period is null or p_amount is null or p_amount <= 0 or p_kind is null
     or p_kind not in ('open_course', 'discretionary') or pg_catalog.btrim(coalesce(p_reason, '')) = ''
     or pg_catalog.char_length(p_reason) > 2000 then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  if not exists (select 1 from public.teachers t where t.id = p_teacher) then
    return '{"outcome": "no_teacher"}'::jsonb;
  end if;
  select pg_catalog.min(t.effective_period_id) into v_launch from public.pool_tiers t where t.canceled_at is null;
  if v_launch is null or p_period < v_launch then
    return '{"outcome": "before_launch"}'::jsonb;
  end if;
  loop
    v_target := private.first_unreleased_period(p_period);
    perform private.open_period(v_target);
    select p.status, p.payouts_released_at into v_row from public.payout_periods p where p.period_id = v_target for share;
    exit when v_row.payouts_released_at is null;
  end loop;
  insert into public.bonuses (teacher_id, period_id, kind, amount_cents, reason)
  values (p_teacher, v_target, p_kind::public.bonus_kind, p_amount, pg_catalog.btrim(p_reason))
  returning id into v_bonus;
  if v_row.status = 'closed' then
    perform private.ensure_payout(v_target, p_teacher);
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'captured', 'bonus_id', v_bonus, 'period_id', v_target,
                                       'moved', v_target <> p_period);
end
$$;
revoke all on function private.capture_bonus(uuid, text, bigint, public.period_id, text) from public;

-- Confirmar el bono que el cierre propuso a un fundador (RN-12), antes de liberar su periodo.
create function private.confirm_founder_bonus(p_bonus uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_period public.period_id;
  v_released timestamptz;
  b public.bonuses;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'bonuses are decided in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_bonus is null then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select x.period_id into v_period from public.bonuses x where x.id = p_bonus;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  select p.payouts_released_at into v_released from public.payout_periods p where p.period_id = v_period for share;
  select * into b from public.bonuses x where x.id = p_bonus for update;
  if b.kind <> 'founder' then
    return '{"outcome": "not_founder"}'::jsonb;
  end if;
  if b.status <> 'proposed' then
    return pg_catalog.jsonb_build_object('outcome', 'already_decided', 'status', b.status);
  end if;
  if v_released is not null then
    return '{"outcome": "period_released"}'::jsonb;
  end if;
  update public.bonuses x set status = 'confirmed' where x.id = p_bonus;
  return '{"outcome": "confirmed"}'::jsonb;
end
$$;
revoke all on function private.confirm_founder_bonus(uuid) from public;

-- Anular un bono, propuesto o confirmado, con su motivo, mientras su periodo no se libere.
create function private.void_bonus(p_bonus uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_period public.period_id;
  v_released timestamptz;
  b public.bonuses;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'bonuses are decided in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_bonus is null or pg_catalog.btrim(coalesce(p_reason, '')) = '' or pg_catalog.char_length(p_reason) > 2000 then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select x.period_id into v_period from public.bonuses x where x.id = p_bonus;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  select p.payouts_released_at into v_released from public.payout_periods p where p.period_id = v_period for share;
  select * into b from public.bonuses x where x.id = p_bonus for update;
  if b.status = 'void' then
    return '{"outcome": "already_void"}'::jsonb;
  end if;
  if v_released is not null then
    return '{"outcome": "period_released"}'::jsonb;
  end if;
  update public.bonuses x set status = 'void', void_reason = pg_catalog.btrim(p_reason) where x.id = p_bonus;
  return '{"outcome": "voided"}'::jsonb;
end
$$;
revoke all on function private.void_bonus(uuid, text) from public;

-- Capturar un ajuste (RF-507): de un periodo cerrado, al primero sin liberar después de él; si ese
-- periodo ya cerró, el maestro recibe su liquidación.
create function private.capture_adjustment(p_teacher uuid, p_origin public.period_id, p_amount bigint, p_reason text,
                                           p_alert uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_target public.period_id;
  v_row record;
  v_adjustment uuid;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'adjustments are captured in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_teacher is null or p_origin is null or p_amount is null or p_amount = 0
     or pg_catalog.btrim(coalesce(p_reason, '')) = '' or pg_catalog.char_length(p_reason) > 2000 then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  if not exists (select 1 from public.teachers t where t.id = p_teacher) then
    return '{"outcome": "no_teacher"}'::jsonb;
  end if;
  if (select p.status from public.payout_periods p where p.period_id = p_origin) is distinct from 'closed'
     and (select p.status from public.payout_periods p where p.period_id = p_origin) is distinct from 'paid' then
    return '{"outcome": "origin_not_closed"}'::jsonb;
  end if;
  if p_alert is not null and not exists (select 1 from public.anomaly_alerts a where a.id = p_alert) then
    return '{"outcome": "no_alert"}'::jsonb;
  end if;
  loop
    v_target := private.first_unreleased_period(private.period_plus(p_origin, 1));
    perform private.open_period(v_target);
    select p.status, p.payouts_released_at into v_row from public.payout_periods p where p.period_id = v_target for share;
    exit when v_row.payouts_released_at is null;
  end loop;
  insert into public.payout_adjustments (teacher_id, origin_period_id, applied_period_id, amount_cents, reason, anomaly_alert_id)
  values (p_teacher, p_origin, v_target, p_amount, pg_catalog.btrim(p_reason), p_alert)
  returning id into v_adjustment;
  if v_row.status = 'closed' then
    perform private.ensure_payout(v_target, p_teacher);
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'captured', 'adjustment_id', v_adjustment, 'applied_period_id', v_target);
end
$$;
revoke all on function private.capture_adjustment(uuid, public.period_id, bigint, text, uuid) from public;

-- ---------------------------------------------------------------------------------------
-- El cierre y el ensayo, con lo pendiente: el cierre le da su liquidación a quien tiene algo pendiente
-- sin reparto en el periodo, y el ensayo estima las liquidaciones. La comprobación al confirmar admite
-- esas liquidaciones de 0.

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
  v_minimum jsonb;
  v_preview jsonb;
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

  -- Lo que quedaría al liberar, con lo de ahora (FL-50, paso 4): lo del bote, el bono del fundador como si
  -- se confirmara, los bonos confirmados, los ajustes y el saldo. Es un estimado: no entra a la huella.
  v_minimum := private.period_parameter('PAGO_MINIMO', p_period);
  if pg_catalog.jsonb_typeof(v_minimum) is distinct from 'number' then
    v_minimum := null;
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'teacher_id', x.teacher_id, 'pool_cents', x.pool, 'founder_bonus_cents', x.founder, 'bonuses_cents', x.bonuses,
           'adjustments_cents', x.adjustments, 'balance_cents', x.balance,
           'estimate_cents', x.pool + x.founder + x.bonuses + x.adjustments + x.balance,
           'below_minimum', case when v_minimum is not null then
             x.pool + x.founder + x.bonuses + x.adjustments + x.balance < (v_minimum #>> '{}')::numeric
             or x.pool + x.founder + x.bonuses + x.adjustments + x.balance <= 0 end)
           order by x.teacher_id), '[]'::jsonb)
    into v_preview
  from (select t.teacher_id, coalesce(c.total_cents, 0) as pool, coalesce(f.amount_cents, 0) as founder,
               coalesce((select pg_catalog.sum(b.amount_cents) from public.bonuses b
                         where b.period_id = p_period and b.teacher_id = t.teacher_id and b.status = 'confirmed'), 0) as bonuses,
               coalesce((select pg_catalog.sum(a.amount_cents) from public.payout_adjustments a
                         where a.applied_period_id = p_period and a.teacher_id = t.teacher_id), 0) as adjustments,
               private.teacher_balance(t.teacher_id) as balance
        from (select c0.teacher_id from private.close_teacher_totals(v_lines) c0
              union select z.teacher_id from private.payout_pending_teachers(p_period) as z (teacher_id)) t
        left join private.close_teacher_totals(v_lines) c on c.teacher_id = t.teacher_id
        left join pg_catalog.jsonb_to_recordset(v_bonuses) as f (teacher_id uuid, amount_cents bigint) on f.teacher_id = t.teacher_id) x;

  insert into public.close_runs (period_id, kind, status, period_status_at_run, input_hash, result_hash, code_version, parameters,
                                 active_students, pool_bps, carried_in_cents, net_revenue_cents, student_pools_cents, pool_cents,
                                 assigned_cents, unconsumed_cents, carried_out_cents, started_by, payout_preview)
  values (p_period, 'rehearsal', 'succeeded', v_status, v_in.input_hash, v_result, v_in.code_version, v_in.parameters,
          v_in.active_students, v_in.pool_bps, v_in.carried_in_cents, v_net, v_pools, v_pools + v_in.carried_in_cents,
          v_assigned, v_pools + v_in.carried_in_cents - v_assigned, v_carried_out, private.actor_id(), v_preview)
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
                        from pg_catalog.jsonb_array_elements(v_bonuses) b),
    'below_minimum', case when v_minimum is not null then
      (select coalesce(pg_catalog.jsonb_agg(e -> 'teacher_id' order by e ->> 'teacher_id'), '[]'::jsonb)
       from pg_catalog.jsonb_array_elements(v_preview) e where (e ->> 'below_minimum')::boolean) end);
end
$$;

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
  -- y la de quien no tiene total (tiene algo pendiente: saldo, ajuste o bono) es de 0 del bote (RF-505).
  -- No se exige que estén todos los pendientes: el barrido de liberar es la red.
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
  where y.period_id = p_period and (y.pool_cents <> 0 or y.status <> 'calculated' or y.close_run_id <> p.close_run_id)
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

-- ---------------------------------------------------------------------------------------
-- La comprobación al confirmar de cada liberación: los bonos y los ajustes son los de su periodo, el
-- estado sigue la regla del mínimo, los renglones del saldo son exactos y no hay otros, y el saldo del
-- maestro justo al liberarla es lo que esta acumuló (o 0).

create function private.assert_payout_released(p_payout uuid) returns void
language plpgsql stable set search_path = ''
as $$
declare
  y public.payouts;
  v_bonuses bigint;
  v_adjustments bigint;
  v_minimum bigint;
  v_expected public.payout_status;
  v_status public.payout_status;
  v_entries text[];
  v_wanted text[] := '{}';
  v_left bigint;
  v_at timestamptz;
  v_after bigint;
begin
  select * into strict y from public.payouts x where x.id = p_payout;
  select coalesce(pg_catalog.sum(b.amount_cents), 0) into v_bonuses
  from public.bonuses b where b.period_id = y.period_id and b.teacher_id = y.teacher_id and b.status = 'confirmed';
  if y.bonuses_cents <> v_bonuses then
    raise exception 'payout %: bonuses % are not the confirmed ones of its period (%)', p_payout, y.bonuses_cents, v_bonuses
      using errcode = '23514';
  end if;
  select coalesce(pg_catalog.sum(a.amount_cents), 0) into v_adjustments
  from public.payout_adjustments a where a.applied_period_id = y.period_id and a.teacher_id = y.teacher_id;
  if y.adjustments_cents <> v_adjustments then
    raise exception 'payout %: adjustments % are not the ones of its period (%)', p_payout, y.adjustments_cents, v_adjustments
      using errcode = '23514';
  end if;
  if y.vat_cents <> 0 or y.income_tax_withheld_cents <> 0 or y.vat_withheld_cents <> 0 or y.net_cents <> y.subtotal_cents then
    raise exception 'payout %: taxes come with T-409', p_payout using errcode = '23514';
  end if;
  v_minimum := private.minimum_payout(y.period_id);
  v_expected := case when y.subtotal_cents >= v_minimum and y.subtotal_cents > 0 then 'awaiting_invoice' else 'carried_forward' end;
  v_status := case when y.status = 'on_hold' then y.held_from_status else y.status end;
  if v_status is distinct from v_expected then
    raise exception 'payout %: % does not follow the minimum payout (% against %)', p_payout, v_status, y.subtotal_cents, v_minimum
      using errcode = '23514';
  end if;
  if y.balance_applied_cents <> 0 then
    v_wanted := v_wanted || ('applied_to_payout:' || (-y.balance_applied_cents)::text);
  end if;
  if v_expected = 'carried_forward' and y.subtotal_cents <> 0 then
    v_wanted := v_wanted || ('carried_forward:' || y.subtotal_cents::text);
  end if;
  select coalesce(pg_catalog.array_agg(e.kind::text || ':' || e.amount_cents::text order by e.kind::text), '{}') into v_entries
  from public.teacher_balance_entries e where e.payout_id = p_payout;
  if v_entries is distinct from (select coalesce(pg_catalog.array_agg(w order by w), '{}') from pg_catalog.unnest(v_wanted) w) then
    raise exception 'payout %: its balance entries are not what it applied and carried', p_payout using errcode = '23514';
  end if;
  -- El saldo del maestro justo al liberarla (sus renglones hasta el de la historia que lo dice; las dos
  -- horas son del reloj, y cada liberación del mismo maestro espera a la anterior): lo que acumuló, o 0.
  -- Una liberación posterior, también de un periodo anterior al soltar una retenida, lo cambia después.
  v_left := case when v_expected = 'carried_forward' then y.subtotal_cents else 0 end;
  select e.occurred_at into v_at from public.payout_status_events e
  where e.payout_id = p_payout and e.from_status = 'calculated' and e.to_status in ('awaiting_invoice', 'carried_forward')
  order by e.occurred_at desc limit 1;
  select coalesce(pg_catalog.sum(b.amount_cents), 0) into v_after
  from public.teacher_balance_entries b where b.teacher_id = y.teacher_id and b.created_at <= v_at;
  if v_at is null or v_after <> v_left then
    raise exception 'payout %: the teacher balance was % right after it, not %', p_payout, v_after, v_left
      using errcode = '23514';
  end if;
end
$$;
revoke all on function private.assert_payout_released(uuid) from public;

create function private.check_payout_released() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_payout_released(new.id);
  return null;
end
$$;
revoke all on function private.check_payout_released() from public;

create constraint trigger payouts_released after update of released_at on public.payouts
  deferrable initially deferred
  for each row when (old.released_at is null and new.released_at is not null)
  execute function private.check_payout_released();

-- ---------------------------------------------------------------------------------------
-- La purga de los latidos (05 §11.4, §13.2). Una partición se borra cuando su periodo está cerrado o
-- pagado, pasó `RETENCION_LATIDOS` desde el cierre, no tiene liquidaciones retenidas (el crudo es la
-- evidencia de una investigación) y no queda progreso por rehacer que lea esos latidos. Con un candado
-- de 2 s: borrar una partición toma el de la tabla madre, y un latido no espera más. Después borra las
-- reproducciones que ya no tienen ninguna partición viva, salvo las que otra señala como la que tomó su
-- lugar (se borran en una vuelta posterior, cuando se borra esa). Solo la corre el dueño.

create function private.purge_watch_partition(p_period public.period_id) returns text
language plpgsql volatile set search_path = ''
as $$
declare
  v_days integer;
  v_period public.payout_periods;
  v_name text := 'watch_events_' || p_period::text;
  v_window interval;
  v_lock text;
  v_deleted integer;
begin
  begin
    v_days := (private.parameter_value('RETENCION_LATIDOS') #>> '{}')::integer;
  exception when others then
    v_days := null;
  end;
  if v_days is null or v_days < 0 then
    return 'no_retention';
  end if;
  select * into v_period from public.payout_periods p where p.period_id = p_period for update;
  if not found or v_period.status not in ('closed', 'paid') then
    return 'not_closed';
  end if;
  if v_period.closed_at > pg_catalog.now() - pg_catalog.make_interval(days => v_days) then
    return 'within_retention';
  end if;
  if exists (select 1 from public.payouts y where y.period_id = p_period and y.status = 'on_hold') then
    return 'on_hold';
  end if;
  if pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(v_name)) is null then
    return 'no_partition';
  end if;
  v_window := pg_catalog.make_interval(secs => 3 * (private.playback_limits()).heartbeat_seconds);
  if exists (select 1 from private.progress_rebuilds r
             join public.playback_sessions s on s.profile_id = r.profile_id and s.lesson_id = r.lesson_id
             where s.started_at < v_period.ends_at and s.last_heartbeat_at + v_window >= v_period.starts_at) then
    return 'progress_pending';
  end if;
  v_lock := pg_catalog.current_setting('lock_timeout');
  perform pg_catalog.set_config('lock_timeout', '2s', true);
  execute pg_catalog.format('drop table public.%I', v_name);
  perform pg_catalog.set_config('lock_timeout', v_lock, true);
  loop
    delete from public.playback_sessions s
    where s.started_at < v_period.ends_at
      and not exists (select 1 from public.playback_sessions o where o.revoked_by = s.id)
      and not exists (
        select 1
        from pg_catalog.generate_series(pg_catalog.date_trunc('month', pg_catalog.timezone(v_period.timezone, s.started_at)),
                                        pg_catalog.timezone(v_period.timezone, s.last_heartbeat_at + v_window), interval '1 month') m
        where pg_catalog.to_regclass('public.watch_events_' || pg_catalog.to_char(m, 'YYYYMM')) is not null);
    get diagnostics v_deleted = row_count;
    exit when v_deleted = 0;
  end loop;
  return 'purged';
end
$$;
revoke all on function private.purge_watch_partition(public.period_id) from public;

-- La corrida diaria: los periodos cerrados o pagados que todavía tienen partición, del más viejo al más
-- nuevo, cada uno en su propia transacción; anota en `job_runs` cuántos borró, cuántos se saltó y
-- cuántos fallaron.
create procedure private.raw_retention()
language plpgsql
as $$
declare
  v_start timestamptz := pg_catalog.clock_timestamp();
  v_period public.period_id;
  v_outcome text;
  v_purged integer := 0;
  v_skipped integer := 0;
  v_failed integer := 0;
  v_first text;
begin
  -- De la sesión, como en la consolidación: un ajuste local se iría con el primer `commit`.
  perform pg_catalog.set_config('search_path', '', false);
  perform pg_catalog.set_config('app.actor_kind', 'system', false);
  for v_period in
    select p.period_id from public.payout_periods p
    where p.status in ('closed', 'paid') and pg_catalog.to_regclass('public.watch_events_' || p.period_id::text) is not null
    order by p.period_id
  loop
    begin
      v_outcome := private.purge_watch_partition(v_period);
      if v_outcome = 'purged' then
        v_purged := v_purged + 1;
      else
        v_skipped := v_skipped + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
      v_first := coalesce(v_first, v_period::text || ': ' || sqlstate || ': ' || pg_catalog.left(sqlerrm, 200));
    end;
    commit;
  end loop;
  insert into public.job_runs (job, status, started_at, heartbeat_at, finished_at, rows_read, rows_written, details, error)
  values ('raw_retention', case when v_failed = 0 then 'succeeded' else 'failed' end::public.run_status, v_start,
          pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), v_purged + v_skipped + v_failed, v_purged,
          pg_catalog.jsonb_build_object('purged', v_purged, 'skipped', v_skipped, 'failed', v_failed), v_first);
  commit;
end
$$;
revoke all on procedure private.raw_retention() from public;

insert into public.job_definitions (job, description, schedule, expected_every, alert_after) values
  ('raw_retention', 'Purga de los latidos de los periodos cerrados', '45 9 * * *', interval '1 day', interval '3 days');
select cron.schedule('raw_retention', '45 9 * * *', 'call private.raw_retention()');

-- ---------------------------------------------------------------------------------------
-- El vigilante: el área de las liquidaciones, con lo nuevo. Las funciones de finanzas y la comprobación
-- al confirmar corren como el dueño; ninguna otra; la purga y su corrida no las ejecuta la aplicación, y
-- la corrida está programada.

create or replace function private.schema_violations_payouts()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  payout_tables (table_name) as (
    values ('public.payouts'), ('public.payout_status_events'), ('public.bonuses'), ('public.payout_adjustments'),
           ('public.teacher_balance_entries')),
  payout_functions (name, definer, fixed_path) as (
    values ('founder_bonus', false, true), ('close_founder_bonuses', false, true), ('guard_payout', false, true),
           ('guard_bonus', false, true), ('log_payout_status', false, true), ('guard_payout_adjustment', false, true),
           ('guard_balance_entry', false, true), ('teacher_balance', false, true), ('payout_pending_teachers', false, true),
           ('first_unreleased_period', false, true), ('ensure_payout', false, true), ('settle_period', false, true),
           ('release_payout', false, true), ('minimum_payout', false, true), ('assert_payout_released', false, true),
           ('check_payout_released', true, true), ('release_payouts', true, true), ('hold_payout', true, true),
           ('unhold_payout', true, true), ('capture_bonus', true, true), ('confirm_founder_bonus', true, true),
           ('void_bonus', true, true), ('capture_adjustment', true, true), ('purge_watch_partition', false, true),
           ('raw_retention', false, false)),
  found as (
    select f.name, f.definer, f.fixed_path, p.oid, p.prosecdef, p.proconfig
    from payout_functions f
    join pg_catalog.pg_proc p on p.proname = f.name
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private'),
  payout_triggers (table_name, trigger_name, function_name, deferred) as (
    values ('public.payouts', 'payouts_guard', 'guard_payout', false),
           ('public.payouts', 'payouts_no_delete', 'reject_mutation', false),
           ('public.payouts', 'payouts_no_truncate', 'reject_mutation', false),
           ('public.payouts', 'payouts_log_status', 'log_payout_status', false),
           ('public.payouts', 'audit_changes', 'audit_row_change', false),
           ('public.payouts', 'payouts_released', 'check_payout_released', true),
           ('public.payout_status_events', 'ledger_no_update_delete', 'reject_mutation', false),
           ('public.payout_status_events', 'ledger_no_truncate', 'reject_mutation', false),
           ('public.bonuses', 'bonuses_guard', 'guard_bonus', false),
           ('public.bonuses', 'bonuses_no_delete', 'reject_mutation', false),
           ('public.bonuses', 'bonuses_no_truncate', 'reject_mutation', false),
           ('public.bonuses', 'audit_changes', 'audit_row_change', false),
           ('public.payout_adjustments', 'payout_adjustments_guard', 'guard_payout_adjustment', false),
           ('public.payout_adjustments', 'ledger_no_update_delete', 'reject_mutation', false),
           ('public.payout_adjustments', 'ledger_no_truncate', 'reject_mutation', false),
           ('public.payout_adjustments', 'audit_changes', 'audit_row_change', false),
           ('public.teacher_balance_entries', 'teacher_balance_entries_guard', 'guard_balance_entry', false),
           ('public.teacher_balance_entries', 'ledger_no_update_delete', 'reject_mutation', false),
           ('public.teacher_balance_entries', 'ledger_no_truncate', 'reject_mutation', false))
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
  where (found.prosecdef and not found.definer)
     or (found.fixed_path and not coalesce(found.proconfig, '{}') @> array['search_path=""'])
  union all
  select 'payouts function not security definer', found.oid::regprocedure::text
  from found
  where found.definer and not found.prosecdef
  union all
  select 'payouts type usable by ' || r.rolname, t.type_name
  from app_roles r
  cross join (values ('public.payout_status'), ('public.bonus_kind'), ('public.bonus_status'), ('public.balance_entry_kind'))
       as t (type_name)
  where pg_catalog.has_type_privilege(r.rolname::name, t.type_name, 'USAGE')
  union all
  select 'payouts trigger missing or disabled: ' || g.trigger_name, g.table_name
  from payout_triggers g
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = pg_catalog.to_regclass(g.table_name) and tg.tgname = g.trigger_name and tg.tgenabled in ('O', 'A')
      and n.nspname = 'private' and p.proname = g.function_name)
  union all
  select 'payouts trigger not deferred: ' || g.trigger_name, g.table_name
  from payout_triggers g
  join pg_catalog.pg_trigger tg on tg.tgrelid = pg_catalog.to_regclass(g.table_name) and tg.tgname = g.trigger_name
  where g.deferred and (tg.tgconstraint = 0 or not tg.tgdeferrable or not tg.tginitdeferred)
  union all
  select 'payouts job not scheduled: raw_retention', 'cron.job'
  where not exists (select 1 from cron.job j where j.jobname = 'raw_retention' and j.active
                      and j.command = 'call private.raw_retention()')
$$;
revoke all on function private.schema_violations_payouts() from public;
