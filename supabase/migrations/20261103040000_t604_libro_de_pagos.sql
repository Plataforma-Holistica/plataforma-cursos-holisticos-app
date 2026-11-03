-- T-604, segunda solicitud: los estados de la liquidación y el libro de pagos (RF-501, RF-505, RF-512; FL-31 A1; plan aprobado por Sergio el 2026-11-02, en
-- `~/.claude/plans/t604-pago-plan.md`). Sin pantalla: PA-82 llega con la quinta y la sexta solicitud, y la factura con la tercera.
--
-- Lo que entra:
--   · el día en que vence la factura, que la base pone al liberar (`invoice_due_on`: el mayor entre `LIMITE_FACTURA` hábiles antes de `DIA_PAGO` y
--     `PLAZO_FACTURA_MIN_DIAS` hábiles después de liberar), y el trabajo de cada noche que marca las vencidas (`invoice_deadline`). Una sola regla dice cuándo
--     un periodo está pagado (`period_settled`): pagada, acumulada o vencida de factura;
--   · el libro de lecturas de la cuenta (`payout_account_reads`), el de llamadas (`payout_account_calls`), el de pagos (`payout_payments`) y el de lo que
--     confirma una segunda persona (`payout_requests`). Toda transferencia reportada entra al libro, también la que choca, porque ya salió;
--   · abrir la cuenta (`payout_account_open`, que reemplaza a `tax_profile_for_payout`: mira el estado de la liquidación y el fraude, y la primera vez pide
--     «ya llamé»), anotar la llamada, marcar pagada, devolver un pago, retirar una propuesta y reabrir una devuelta. Retener desde devuelta, y soltar con fraude
--     decidido lo confirma otra persona (decisión 3 de Sergio);
--   · la comprobación al confirmar: una pagada tiene un pago vivo, y una lista para pago o devuelta, ninguno.
--
-- Decisiones mías sin confirmar: una transferencia que choca (referencia repetida, otro monto, una investigación que nació después de abrir, una lectura vieja,
-- o la liquidación ya pagada, retenida o devuelta) entra al libro y retiene la liquidación con `hold_kind = 'payment'`; soltar a pagada lo confirma otra
-- persona, siempre; mientras una lectura de la cuenta no tenga su pago ni esté anulada, nadie más la abre; lo que confirma una segunda persona vive en una sola
-- tabla; CO-14 llega con la sexta solicitud, que es la que paga.

-- ---------------------------------------------------------------------------------------
-- El parámetro.

insert into public.parameter_definitions (key, description, value_type, unit, group_name, affects_payout) values
  ('PLAZO_FACTURA_MIN_DIAS', 'Días hábiles mínimos entre liberar una liquidación y que venza su factura', 'integer', 'días hábiles', 'payout', false);

-- ---------------------------------------------------------------------------------------
-- Las columnas de la liquidación.

alter table public.payouts
  add column invoice_due_on date,
  add column invoice_overdue_at timestamptz,
  add constraint payouts_overdue_has_due check (invoice_overdue_at is null or invoice_due_on is not null),
  drop constraint payouts_hold_kind_known,
  add constraint payouts_hold_kind_known check (hold_kind in ('investigation', 'tax_data', 'payment')),
  drop constraint payouts_hold_from,
  add constraint payouts_hold_from check (
    held_from_status is null
    or held_from_status in ('calculated', 'awaiting_invoice', 'invoice_in_review', 'invoice_rejected', 'ready_to_pay', 'payment_returned'));
comment on column public.payouts.invoice_due_on is 'El día, en ZONA_HORARIA_PERIODO, en que vence su factura. Lo pone la base al liberar.';
comment on column public.payouts.invoice_overdue_at is 'Cuándo el trabajo de cada noche la marcó vencida de factura. No detiene al periodo, y no se borra (RF-501).';
comment on column public.payouts.hold_kind is 'Por qué está retenida. tax_data no detiene la purga de los latidos; payment es una transferencia que chocó.';

-- ---------------------------------------------------------------------------------------
-- Los libros.

-- Cada apertura de la cuenta: con qué versión y con qué CLABE. Marcar pagada lleva la suya, así que «la versión que abrió» no es palabra de quien llama.
create table private.payout_account_reads (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.payouts (id),
  teacher_id uuid not null references public.teachers (id),
  tax_profile_id uuid not null,
  tax_profile_version smallint not null,
  clabe_changed_at timestamptz not null,
  first_time boolean not null,
  read_by uuid not null references public.profiles (id),
  read_at timestamptz not null default clock_timestamp()
);
comment on table private.payout_account_reads is 'Cada apertura de la cuenta de un maestro para pagarle (PA-82). Solo inserción.';
create index payout_account_reads_payout_idx on private.payout_account_reads (payout_id);

-- «No transferí»: quien abrió la cuenta anula su lectura, y con eso otra persona la puede abrir. Mientras no, una lectura sin pago es una transferencia que
-- quizá ya salió.
create table private.payout_account_read_voids (
  read_id uuid primary key references private.payout_account_reads (id),
  voided_by uuid not null references public.profiles (id),
  voided_at timestamptz not null default clock_timestamp(),
  note text not null,
  constraint payout_account_read_voids_note_length check (pg_catalog.char_length(note) between 1 and 2000)
);
comment on table private.payout_account_read_voids is 'Las lecturas de la cuenta que quien las abrió anuló sin transferir. Solo inserción.';

-- «Ya llamé» (decisión 2): por maestro y por CLABE, que se identifica por cuándo cambió, sin descifrarla.
create table private.payout_account_calls (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id),
  clabe_changed_at timestamptz not null,
  spoke_with text not null,
  called_at timestamptz not null,
  recorded_by uuid not null references public.profiles (id),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint payout_account_calls_spoke_with_length check (pg_catalog.char_length(spoke_with) between 1 and 200)
);
comment on table private.payout_account_calls is 'Las llamadas que confirman una cuenta antes del primer pago a ella. Solo inserción.';
create index payout_account_calls_teacher_idx on private.payout_account_calls (teacher_id, clabe_changed_at);

-- Toda transferencia reportada, también la que choca: ya salió. Un pago está vivo mientras no se confirme su devolución.
create table private.payout_payments (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.payouts (id),
  teacher_id uuid not null references public.teachers (id),
  read_id uuid not null references private.payout_account_reads (id),
  tax_profile_version smallint not null,
  clabe_changed_at timestamptz not null,
  reference text not null,
  paid_on date not null,
  amount_cents bigint not null,
  first_time boolean not null,
  account_changed_since_read boolean not null,
  conflict text,
  recorded_by uuid not null references public.profiles (id),
  recorded_at timestamptz not null default clock_timestamp(),
  constraint payout_payments_amount_positive check (amount_cents > 0),
  constraint payout_payments_reference_form check (pg_catalog.char_length(reference) between 1 and 100 and reference = pg_catalog.btrim(reference)),
  constraint payout_payments_conflict_known check (
    conflict is null or conflict in ('on_hold', 'already_paid', 'under_investigation', 'amount_differs', 'duplicate_reference', 'not_ready', 'stale_read'))
);
comment on table private.payout_payments is 'El libro de pagos a maestros (RF-505): cada transferencia reportada, con la lectura con que se abrió la cuenta. Solo inserción.';
create index payout_payments_payout_idx on private.payout_payments (payout_id);
create index payout_payments_read_idx on private.payout_payments (read_id);
create index payout_payments_teacher_idx on private.payout_payments (teacher_id, clabe_changed_at);
-- La misma referencia del mismo día no paga dos liquidaciones, y una lectura paga una sola vez.
create unique index payout_payments_reference_uq on private.payout_payments (pg_catalog.upper(reference), paid_on) where conflict is null;
create unique index payout_payments_clean_read_uq on private.payout_payments (read_id) where conflict is null;

-- Lo que confirma una segunda persona (decisión 3): devolver un pago, y soltar una retenida con fraude decidido.
create table private.payout_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payout_id uuid not null references public.payouts (id),
  payment_id uuid references private.payout_payments (id),
  fingerprint text,
  note text not null,
  proposed_by uuid not null references public.profiles (id),
  proposed_at timestamptz not null default clock_timestamp(),
  status text not null default 'pending',
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  decision_note text,
  constraint payout_requests_kind_known check (kind in ('payment_return', 'hold_release')),
  constraint payout_requests_kind_shape check (
    (kind = 'payment_return' and payment_id is not null and fingerprint is null)
    or (kind = 'hold_release' and payment_id is null and fingerprint is not null)),
  constraint payout_requests_status_known check (status in ('pending', 'withdrawn', 'confirmed', 'superseded')),
  constraint payout_requests_decision_consistent check ((status = 'pending') = (decided_at is null) and (decided_at is null) = (decided_by is null)),
  constraint payout_requests_second_person check (status <> 'confirmed' or decided_by <> proposed_by),
  constraint payout_requests_withdrawn_by_proposer check (status <> 'withdrawn' or decided_by = proposed_by),
  constraint payout_requests_note_length check (pg_catalog.char_length(note) between 1 and 2000),
  constraint payout_requests_decision_note_length check (decision_note is null or pg_catalog.char_length(decision_note) between 1 and 2000)
);
comment on table private.payout_requests is 'Lo que en finanzas pide a dos personas: la devolución de un pago y soltar una retenida con fraude decidido (decisión de Sergio del 2026-11-02).';
create unique index payout_requests_pending_return_uq on private.payout_requests (payment_id) where kind = 'payment_return' and status = 'pending';
create unique index payout_requests_returned_uq on private.payout_requests (payment_id) where kind = 'payment_return' and status = 'confirmed';
create unique index payout_requests_pending_release_uq on private.payout_requests (payout_id) where kind = 'hold_release' and status = 'pending';

alter table private.payout_account_reads enable row level security;
alter table private.payout_account_calls enable row level security;
alter table private.payout_payments enable row level security;
alter table private.payout_requests enable row level security;
revoke all on private.payout_account_reads, private.payout_account_calls, private.payout_payments, private.payout_requests
  from public, anon, authenticated, service_role, app_service;

create trigger ledger_no_update_delete before update or delete on private.payout_account_reads
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.payout_account_reads
  for each statement execute function private.reject_mutation();
create trigger ledger_no_update_delete before update or delete on private.payout_account_calls
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.payout_account_calls
  for each statement execute function private.reject_mutation();
-- Sin con quién se habló: puede traer un teléfono, y configuración lee la auditoría.
create trigger audit_changes after insert on private.payout_account_calls
  for each row execute function private.audit_row_change('money', 'spoke_with');
alter table private.payout_account_read_voids enable row level security;
revoke all on private.payout_account_read_voids from public, anon, authenticated, service_role, app_service;
create trigger ledger_no_update_delete before update or delete on private.payout_account_read_voids
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.payout_account_read_voids
  for each statement execute function private.reject_mutation();
create trigger ledger_no_update_delete before update or delete on private.payout_payments
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.payout_payments
  for each statement execute function private.reject_mutation();
-- Sin el monto: es el neto, y con el bruto de la liquidación diría lo retenido y de ahí el régimen (decisión de Sergio del 2026-11-01).
create trigger audit_changes after insert on private.payout_payments
  for each row execute function private.audit_row_change('money', 'amount_cents');

-- Una propuesta nace pendiente, y solo cambia su decisión: la retira quien la hizo, la confirma otra persona, o la reemplaza una más nueva.
create function private.guard_payout_request() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or pg_catalog.num_nonnulls(new.decided_by, new.decided_at, new.decision_note) > 0 then
      raise exception '%.%: a request is born pending', tg_table_schema, tg_table_name using errcode = '23514';
    end if;
    new.proposed_at := pg_catalog.clock_timestamp();
    return new;
  end if;
  if tg_op <> 'UPDATE' then
    raise exception '%.%: requests are not deleted', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  if old.status <> 'pending' or new.status = 'pending'
     or (new.id, new.kind, new.payout_id, new.payment_id, new.fingerprint, new.note, new.proposed_by, new.proposed_at)
        is distinct from (old.id, old.kind, old.payout_id, old.payment_id, old.fingerprint, old.note, old.proposed_by, old.proposed_at) then
    raise exception '%.%: request % changes only its decision, once', tg_table_schema, tg_table_name, old.id using errcode = '23514';
  end if;
  new.decided_at := pg_catalog.clock_timestamp();
  return new;
end
$$;
revoke all on function private.guard_payout_request() from public;
create trigger payout_requests_guard before insert or update or delete on private.payout_requests
  for each row execute function private.guard_payout_request();
create trigger ledger_no_truncate before truncate on private.payout_requests
  for each statement execute function private.reject_mutation();
create trigger audit_changes after insert or update on private.payout_requests
  for each row execute function private.audit_row_change('money');

-- ---------------------------------------------------------------------------------------
-- Las reglas.

-- Días hábiles: de lunes a viernes, sin feriados (HO-18). Hacia adelante o hacia atrás; cero no mueve.
create function private.business_days_add(p_day date, p_days integer) returns date
language plpgsql immutable set search_path = ''
as $$
declare
  v date := p_day;
  v_left integer := pg_catalog.abs(p_days);
  v_step integer := pg_catalog.sign(p_days)::integer;
begin
  if p_day is null or p_days is null or v_left > 1000 then
    raise exception 'business_days_add needs a day and at most 1000 days' using errcode = '22023';
  end if;
  while v_left > 0 loop
    v := v + v_step;
    if pg_catalog.date_part('isodow', v) < 6 then
      v_left := v_left - 1;
    end if;
  end loop;
  return v;
end
$$;
revoke all on function private.business_days_add(date, integer) from public;

-- El día en que vence la factura de una liquidación del periodo, liberada ese día. Un parámetro que falta o que no tiene forma no se adivina: liberar falla.
create function private.invoice_due_on(p_period public.period_id, p_released date) returns date
language plpgsql stable set search_path = ''
as $$
declare
  v_pay jsonb := private.parameter_value('DIA_PAGO');
  v_limit jsonb := private.parameter_value('LIMITE_FACTURA');
  v_min jsonb := private.parameter_value('PLAZO_FACTURA_MIN_DIAS');
  v_month date;
begin
  if pg_catalog.jsonb_typeof(v_pay) is distinct from 'number' or pg_catalog.jsonb_typeof(v_limit) is distinct from 'number'
     or pg_catalog.jsonb_typeof(v_min) is distinct from 'number'
     or (v_pay #>> '{}')::numeric not between 1 and 28 or (v_limit #>> '{}')::numeric not between 0 and 20 or (v_min #>> '{}')::numeric not between 0 and 60
     or (v_pay #>> '{}')::numeric <> pg_catalog.trunc((v_pay #>> '{}')::numeric) or (v_limit #>> '{}')::numeric <> pg_catalog.trunc((v_limit #>> '{}')::numeric)
     or (v_min #>> '{}')::numeric <> pg_catalog.trunc((v_min #>> '{}')::numeric) then
    raise exception 'DIA_PAGO, LIMITE_FACTURA or PLAZO_FACTURA_MIN_DIAS is missing or malformed' using errcode = 'P0001';
  end if;
  if p_period is null or p_released is null then
    raise exception 'an invoice due day needs a period and a release day' using errcode = '22023';
  end if;
  v_month := (pg_catalog.make_date((p_period / 100)::integer, (p_period % 100)::integer, 1) + interval '1 month')::date;
  return greatest(
    private.business_days_add(v_month + ((v_pay #>> '{}')::integer - 1), -(v_limit #>> '{}')::integer),
    private.business_days_add(p_released, (v_min #>> '{}')::integer));
end
$$;
revoke all on function private.invoice_due_on(public.period_id, date) from public;

-- Lo ya liberado antes de esta migración: su día, el del día en que se liberó. Sin él, `invoice_deadline` nunca la vencería.
set local session_replication_role = replica;
update public.payouts y set invoice_due_on = private.invoice_due_on(y.period_id, (y.released_at at time zone private.period_zone())::date)
where y.released_at is not null and y.invoice_due_on is null
  and (y.status in ('awaiting_invoice', 'invoice_in_review', 'invoice_rejected', 'ready_to_pay')
       or y.held_from_status in ('awaiting_invoice', 'invoice_in_review', 'invoice_rejected', 'ready_to_pay'));
set local session_replication_role = origin;

-- Cuándo un periodo liberado está pagado (RF-501): cada liquidación pagada, acumulada o vencida de factura. Una sola regla, para el periodo y para quien lo paga.
create function private.period_settled(p_period public.period_id) returns boolean
language sql stable set search_path = ''
as $$
  select exists (select 1 from public.payout_periods p where p.period_id = p_period and p.payouts_released_at is not null)
     and not exists (
       select 1 from public.payouts y
       where y.period_id = p_period
         and not (y.status in ('paid', 'carried_forward')
                  or (y.status in ('awaiting_invoice', 'invoice_rejected') and y.invoice_overdue_at is not null)))
$$;
revoke all on function private.period_settled(public.period_id) from public;

-- Desde cuándo está lista para pago esta vez: una lectura de antes (de antes de pagarse y devolverse, o de retenerse y soltarse) es vieja.
create function private.payout_ready_since(p_payout uuid) returns timestamptz
language sql stable set search_path = ''
as $$
  select coalesce(pg_catalog.max(e.occurred_at), '-infinity'::timestamptz) from public.payout_status_events e
  where e.payout_id = p_payout and e.to_status = 'ready_to_pay'
$$;
revoke all on function private.payout_ready_since(uuid) from public;

-- La lectura abierta de una liquidación: de esta vez, sin anular y sin un pago que la use. Mientras exista, la transferencia quizá ya salió.
create function private.payout_open_read(p_payout uuid) returns private.payout_account_reads
language sql stable set search_path = ''
as $$
  select r.* from private.payout_account_reads r
  where r.payout_id = p_payout and r.read_at >= private.payout_ready_since(p_payout)
    and not exists (select 1 from private.payout_account_read_voids v where v.read_id = r.id)
    and not exists (select 1 from private.payout_payments x where x.read_id = r.id)
  order by r.read_at desc
  limit 1
$$;
revoke all on function private.payout_open_read(uuid) from public;

-- Los pagos vivos de una liquidación: los que no tienen su devolución confirmada.
create function private.payout_live_payments(p_payout uuid) returns bigint
language sql stable set search_path = ''
as $$
  select pg_catalog.count(*) from private.payout_payments x
  where x.payout_id = p_payout
    and not exists (select 1 from private.payout_requests r where r.payment_id = x.id and r.kind = 'payment_return' and r.status = 'confirmed')
$$;
revoke all on function private.payout_live_payments(uuid) from public;

-- Mientras se investiga no se paga: una alerta abierta o de fraude de ese mes, su fraude confirmado, o una propuesta de suspensión pendiente de cualquier mes.
create function private.payout_under_review(p_teacher uuid, p_period public.period_id) returns boolean
language sql stable set search_path = ''
as $$
  select private.payout_under_investigation(p_teacher, p_period)
      or exists (select 1 from private.teacher_suspension_requests r where r.teacher_id = p_teacher and r.status = 'pending')
$$;
revoke all on function private.payout_under_review(uuid, public.period_id) from public;

-- Fraude decidido: una alerta de ese maestro en ese mes marcada como fraude, o su suspensión por fraude confirmada. Soltar entonces pide dos personas.
create function private.payout_fraud_decided(p_teacher uuid, p_period public.period_id) returns boolean
language sql stable set search_path = ''
as $$
  select exists (select 1 from public.anomaly_alerts a where a.teacher_id = p_teacher and a.period_id = p_period and a.is_fraud is true)
      or exists (select 1 from public.teachers t where t.id = p_teacher and t.suspension_approved_by is not null)
$$;
revoke all on function private.payout_fraud_decided(uuid, public.period_id) from public;

-- La identidad de la CLABE vigente de un maestro, sin nada cifrado: con qué fila, qué versión y cuándo cambió. Solo para las funciones del dueño.
create function private.tax_profile_account(p_teacher uuid)
returns table (id uuid, version smallint, clabe_changed_at timestamptz, clabe_effective_from timestamptz)
language sql stable set search_path = ''
as $$
  select x.id, x.version, x.clabe_changed_at, x.clabe_effective_from
  from private.teacher_tax_profiles x where x.teacher_id = p_teacher order by x.version desc limit 1
$$;
revoke all on function private.tax_profile_account(uuid) from public;

-- ---------------------------------------------------------------------------------------
-- El guardián de la liquidación, entero.

create or replace function private.guard_payout() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_period record;
  v_total bigint;
begin
  if tg_op = 'INSERT' then
    -- Con el IVA en 0, las retenciones también (el neto es el subtotal).
    if new.pool_cents < 0 or new.adjustments_cents <> 0 or new.balance_applied_cents <> 0 or new.vat_cents <> 0
       or new.subtotal_cents <> new.pool_cents or new.net_cents <> new.pool_cents
       or pg_catalog.num_nonnulls(new.released_at, new.released_by, new.held_from_status, new.held_at, new.held_by,
                                  new.hold_reason, new.anomaly_alert_id, new.withholding_rule_id, new.withholding_profile_version, new.hold_kind,
                                  new.invoice_due_on, new.invoice_overdue_at) > 0 then
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

  -- Liberar. La que espera factura sabe desde aquí el día en que vence.
  if old.status = 'calculated' and new.status in ('awaiting_invoice', 'carried_forward') then
    if pg_catalog.num_nonnulls(new.held_from_status, new.held_at, new.held_by, new.hold_reason, new.anomaly_alert_id, new.invoice_overdue_at) > 0 then
      raise exception '%.%: payout % is released without a hold', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    -- Solo la que se va a pagar lleva impuestos, y con su regla. Que sean los de esa regla lo revisa `assert_payout_released` al confirmar.
    if new.status = 'carried_forward' and (new.vat_cents <> 0 or new.income_tax_withheld_cents <> 0 or new.vat_withheld_cents <> 0
                                           or new.net_cents <> new.subtotal_cents or new.withholding_rule_id is not null) then
      raise exception '%.%: payout % is carried forward without taxes', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    if new.status = 'awaiting_invoice' and new.withholding_rule_id is null then
      raise exception '%.%: payout % waits for its invoice with its withholding rule', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    if private.actor_id() is null then
      raise exception '%.%: payout % is released by someone', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    new.released_at := pg_catalog.now();
    new.released_by := private.actor_id();
    new.invoice_due_on := case when new.status = 'awaiting_invoice' then private.invoice_due_on(new.period_id, private.release_day()) end;
    return new;
  end if;

  if (new.bonuses_cents, new.adjustments_cents, new.balance_applied_cents, new.subtotal_cents, new.vat_cents,
      new.income_tax_withheld_cents, new.vat_withheld_cents, new.net_cents, new.released_at, new.released_by,
      new.withholding_rule_id, new.withholding_profile_version, new.invoice_due_on)
     is distinct from
     (old.bonuses_cents, old.adjustments_cents, old.balance_applied_cents, old.subtotal_cents, old.vat_cents,
      old.income_tax_withheld_cents, old.vat_withheld_cents, old.net_cents, old.released_at, old.released_by,
      old.withholding_rule_id, old.withholding_profile_version, old.invoice_due_on) then
    raise exception '%.%: payout %: its amounts change only when it is released (RF-505)', tg_table_schema, tg_table_name, old.id
      using errcode = '23514';
  end if;

  -- Vencida de factura (RF-501): la marca el trabajo de cada noche, una vez, sola, y no se borra.
  if new.invoice_overdue_at is distinct from old.invoice_overdue_at then
    if old.invoice_overdue_at is not null or new.invoice_overdue_at is null
       or (pg_catalog.to_jsonb(new) - array['invoice_overdue_at', 'updated_at']) is distinct from (pg_catalog.to_jsonb(old) - array['invoice_overdue_at', 'updated_at']) then
      raise exception '%.%: payout % is marked overdue once, alone, and it stays', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    if not private.actor_is_system() or old.status not in ('awaiting_invoice', 'invoice_rejected')
       or old.invoice_due_on is null or old.invoice_due_on >= private.release_day() then
      raise exception '%.%: payout % is marked overdue by the nightly job, past its day', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    new.invoice_overdue_at := pg_catalog.now();
    return new;
  end if;

  -- Una retención por datos pasa a investigación si aparece otra causa: esa sí detiene la purga. Solo en ese sentido.
  if old.status = 'on_hold' and new.status = 'on_hold' then
    if old.hold_kind = 'tax_data' and new.hold_kind = 'investigation' and new.held_from_status is not distinct from old.held_from_status
       and private.actor_id() is not null then
      new.held_at := pg_catalog.now();
      new.held_by := private.actor_id();
      return new;
    end if;
    raise exception '%.%: payout % stays on hold as it is', tg_table_schema, tg_table_name, old.id using errcode = '23514';
  end if;

  -- Retener (RN-17): también una devuelta, para que un fraude no tenga que pasar por lista para pago.
  if new.status = 'on_hold'
     and old.status in ('calculated', 'awaiting_invoice', 'invoice_in_review', 'invoice_rejected', 'ready_to_pay', 'payment_returned') then
    if private.actor_id() is null then
      raise exception '%.%: payout % is held by someone', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    new.hold_kind := coalesce(new.hold_kind, 'investigation');
    new.held_from_status := old.status;
    new.held_at := pg_catalog.now();
    new.held_by := private.actor_id();
    return new;
  end if;

  -- Soltar: vuelve al estado en que estaba, o a pagada si tiene un pago vivo (la comprobación al confirmar lo exige).
  if old.status = 'on_hold'
     and (new.status = old.held_from_status or (new.status = 'paid' and old.held_from_status in ('ready_to_pay', 'payment_returned'))) then
    new.hold_kind := null;
    new.held_from_status := null;
    new.held_at := null;
    new.held_by := null;
    new.hold_reason := null;
    new.anomaly_alert_id := null;
    return new;
  end if;

  -- Pagar, devolver y reabrir: con una persona, y con el libro de pagos que lo respalde al confirmar.
  if (old.status = 'ready_to_pay' and new.status = 'paid') or (old.status = 'paid' and new.status = 'payment_returned')
     or (old.status = 'payment_returned' and new.status = 'ready_to_pay') then
    if private.actor_id() is null then
      raise exception '%.%: payout % changes to % by someone', tg_table_schema, tg_table_name, old.id, new.status using errcode = '23514';
    end if;
    return new;
  end if;

  raise exception '%.%: payout % does not go from % to % (the invoice comes with the third request of T-604)', tg_table_schema, tg_table_name,
    old.id, old.status, new.status using errcode = '23514';
end
$$;

-- Una pagada tiene un pago vivo; una lista para pago o devuelta, ninguno. Al confirmar, porque pagar y devolver escriben en dos tablas.
create function private.assert_payout_payments(p_payout uuid) returns void
language plpgsql stable set search_path = ''
as $$
declare
  v_status public.payout_status;
  v_live bigint;
begin
  select y.status into v_status from public.payouts y where y.id = p_payout;
  v_live := private.payout_live_payments(p_payout);
  if v_status = 'paid' and v_live = 0 then
    raise exception 'payout % is paid without a live payment', p_payout using errcode = '23514';
  end if;
  if v_status in ('ready_to_pay', 'payment_returned') and v_live > 0 then
    raise exception 'payout % is % with a live payment', p_payout, v_status using errcode = '23514';
  end if;
end
$$;
revoke all on function private.assert_payout_payments(uuid) from public;

create function private.check_payout_payments() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'payouts' then
    perform private.assert_payout_payments(new.id);
  else
    perform private.assert_payout_payments(new.payout_id);
  end if;
  return null;
end
$$;
revoke all on function private.check_payout_payments() from public;

create constraint trigger payouts_payments after update of status on public.payouts
  deferrable initially deferred for each row execute function private.check_payout_payments();
create constraint trigger payout_payments_payments after insert on private.payout_payments
  deferrable initially deferred for each row execute function private.check_payout_payments();
create constraint trigger payout_requests_payments after insert or update on private.payout_requests
  deferrable initially deferred for each row execute function private.check_payout_payments();

-- ---------------------------------------------------------------------------------------
-- El periodo pagado: una sola regla.

create or replace function private.settle_period(p_period public.period_id) returns public.period_status
language plpgsql set search_path = ''
as $$
declare
  v public.period_status;
begin
  update public.payout_periods p set status = 'paid'
  where p.period_id = p_period and p.status = 'closed' and private.period_settled(p_period);
  select p.status into v from public.payout_periods p where p.period_id = p_period;
  return v;
end
$$;

-- El trabajo de cada noche: marca vencidas las que pasaron su día sin factura, y paga los periodos que ya no tienen nada pendiente. Periodo por periodo, con
-- el periodo tomado antes que sus liquidaciones, en el orden de las demás funciones de finanzas.
create function private.invoice_deadline() returns integer
language plpgsql set search_path = ''
as $$
declare
  v_kind text := pg_catalog.current_setting('app.actor_kind', true);
  v_period public.period_id;
  v_marked integer := 0;
  v_count integer;
begin
  perform pg_catalog.set_config('app.actor_kind', 'system', true);
  for v_period in
    select p.period_id from public.payout_periods p
    where p.status = 'closed' and p.payouts_released_at is not null order by p.period_id
  loop
    perform 1 from public.payout_periods p where p.period_id = v_period for update;
    update public.payouts y set invoice_overdue_at = pg_catalog.now()
    where y.period_id = v_period and y.status in ('awaiting_invoice', 'invoice_rejected') and y.invoice_overdue_at is null
      and y.invoice_due_on < private.release_day();
    get diagnostics v_count = row_count;
    v_marked := v_marked + v_count;
    perform private.settle_period(v_period);
  end loop;
  perform pg_catalog.set_config('app.actor_kind', coalesce(v_kind, ''), true);
  return v_marked;
end
$$;
revoke all on function private.invoice_deadline() from public;
select cron.schedule('invoice_deadline', '30 6 * * *', 'select private.invoice_deadline()');

-- ---------------------------------------------------------------------------------------
-- Abrir la cuenta, anotar la llamada.

-- Reemplaza a `tax_profile_for_payout`: solo con la liquidación lista para pago, sin nada que investigar, y la primera vez que se paga a esa cuenta, con
-- «ya llamé». Contesta antes de auditar: sin datos, no hay lectura. Toma el periodo y la liquidación, para ir uno tras otro con quien marca.
create function private.payout_account_open(p_payout uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_period public.period_id;
  y public.payouts;
  p private.teacher_tax_profiles;
  v_standing text;
  v_first boolean;
  v_read uuid;
  v_open private.payout_account_reads;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'payout accounts open in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  select x.period_id into v_period from public.payouts x where x.id = p_payout;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  perform 1 from public.payout_periods x where x.period_id = v_period for update;
  select * into y from public.payouts x where x.id = p_payout for update;
  if private.actor_owns_teacher(y.teacher_id) then
    return '{"outcome": "self"}'::jsonb;
  end if;
  if y.status = 'on_hold' then
    return '{"outcome": "on_hold"}'::jsonb;
  end if;
  if y.status <> 'ready_to_pay' then
    return '{"outcome": "not_ready"}'::jsonb;
  end if;
  select x.* into p from private.teacher_tax_profiles x where x.teacher_id = y.teacher_id order by x.version desc limit 1;
  if p.id is null then
    return '{"outcome": "no_profile"}'::jsonb;
  end if;
  v_standing := private.tax_clabe_standing(p.teacher_id, p.clabe_changed_at, p.clabe_effective_from);
  if v_standing = 'dead' then
    return '{"outcome": "clabe_recapture"}'::jsonb;
  end if;
  if v_standing = 'held' then
    return '{"outcome": "clabe_held"}'::jsonb;
  end if;
  if v_standing = 'notice_pending' then
    return '{"outcome": "clabe_notice_pending"}'::jsonb;
  end if;
  if v_standing = 'waiting' then
    return pg_catalog.jsonb_build_object('outcome', 'clabe_waiting', 'until', private.tax_clabe_effective(p.teacher_id, p.clabe_changed_at, p.clabe_effective_from));
  end if;
  if private.payout_under_review(y.teacher_id, y.period_id) then
    return '{"outcome": "under_investigation"}'::jsonb;
  end if;
  -- La primera vez: ningún pago vivo a este maestro con esta CLABE. Uno devuelto no cuenta, y no caduca.
  v_first := not exists (
    select 1 from private.payout_payments x
    where x.teacher_id = y.teacher_id and x.clabe_changed_at = p.clabe_changed_at
      and not exists (select 1 from private.payout_requests r where r.payment_id = x.id and r.kind = 'payment_return' and r.status = 'confirmed'));
  if v_first and not exists (
      select 1 from private.payout_account_calls c where c.teacher_id = y.teacher_id and c.clabe_changed_at = p.clabe_changed_at) then
    return '{"outcome": "needs_call"}'::jsonb;
  end if;
  -- Una lectura sin pago es una transferencia que quizá ya salió: otra persona no recibe la cuenta hasta que se marque o se anule. Quien la abrió vuelve a ver la
  -- suya, o, si sus datos cambiaron desde entonces, recibe una lectura nueva.
  v_open := private.payout_open_read(p_payout);
  if v_open.id is not null and v_open.read_by <> private.actor_id() then
    return pg_catalog.jsonb_build_object('outcome', 'already_open', 'read_by', v_open.read_by, 'read_at', v_open.read_at);
  end if;
  insert into public.audit_log (actor_id, actor_kind, category, action, entity_table, entity_id, new_value, reason, request_id)
  values (private.actor_id(), 'user', 'privacy', 'tax_profile.read', 'private.teacher_tax_profiles', p.id::text, pg_catalog.jsonb_build_object('teacher_id', p.teacher_id, 'payout_id', p_payout),
          nullif(pg_catalog.current_setting('app.reason', true), ''),
          nullif(pg_catalog.current_setting('app.request_id', true), ''));
  if v_open.id is not null and v_open.tax_profile_id = p.id then
    return private.tax_profile_payload(p) || pg_catalog.jsonb_build_object('read_id', v_open.id, 'first_time', v_open.first_time);
  end if;
  insert into private.payout_account_reads (payout_id, teacher_id, tax_profile_id, tax_profile_version, clabe_changed_at, first_time, read_by)
  values (p_payout, y.teacher_id, p.id, p.version, p.clabe_changed_at, v_first, private.actor_id())
  returning id into v_read;
  return private.tax_profile_payload(p) || pg_catalog.jsonb_build_object('read_id', v_read, 'first_time', v_first);
end
$$;
revoke all on function private.payout_account_open(uuid) from public;
drop function private.tax_profile_for_payout(uuid);

-- «No transferí»: quien abrió anula su lectura, con su nota. Una que ya tiene su pago no se anula: esa transferencia salió.
create function private.payout_account_void_read(p_read uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  r private.payout_account_reads;
  v_period public.period_id;
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'reads are voided in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_read is null or v_note is null or pg_catalog.char_length(v_note) > 2000 then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select * into r from private.payout_account_reads x where x.id = p_read;
  if r.id is null then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  select y.period_id into v_period from public.payouts y where y.id = r.payout_id;
  perform 1 from public.payout_periods x where x.period_id = v_period for update;
  perform 1 from public.payouts y where y.id = r.payout_id for update;
  if r.read_by <> private.actor_id() then
    return '{"outcome": "not_yours"}'::jsonb;
  end if;
  if exists (select 1 from private.payout_payments x where x.read_id = p_read) then
    return '{"outcome": "used"}'::jsonb;
  end if;
  insert into private.payout_account_read_voids (read_id, voided_by, note) values (p_read, private.actor_id(), v_note)
  on conflict (read_id) do nothing;
  return '{"outcome": "voided"}'::jsonb;
end
$$;
revoke all on function private.payout_account_void_read(uuid, text) from public;

-- «Ya llamé», con quién y cuándo. Una llamada de antes del cambio no confirma esta cuenta.
create function private.payout_account_call(p_payout uuid, p_spoke_with text, p_called_at timestamptz) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_teacher uuid;
  a record;
  v uuid;
begin
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_payout is null or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_spoke_with, ''))) not between 1 and 200
     or p_called_at is null or p_called_at > pg_catalog.clock_timestamp() + interval '1 minute' then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select x.teacher_id into v_teacher from public.payouts x where x.id = p_payout;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if private.actor_owns_teacher(v_teacher) then
    return '{"outcome": "self"}'::jsonb;
  end if;
  select * into a from private.tax_profile_account(v_teacher);
  if a.id is null then
    return '{"outcome": "no_profile"}'::jsonb;
  end if;
  if p_called_at < a.clabe_changed_at then
    return '{"outcome": "before_change"}'::jsonb;
  end if;
  insert into private.payout_account_calls (teacher_id, clabe_changed_at, spoke_with, called_at, recorded_by)
  values (v_teacher, a.clabe_changed_at, pg_catalog.btrim(p_spoke_with), p_called_at, private.actor_id())
  returning id into v;
  return pg_catalog.jsonb_build_object('outcome', 'recorded', 'call_id', v);
end
$$;
revoke all on function private.payout_account_call(uuid, text, timestamptz) from public;

-- ---------------------------------------------------------------------------------------
-- Marcar pagada.

-- Con la lectura con que se abrió la cuenta. Toda transferencia entra al libro, también una segunda con la misma lectura: la que choca no la paga, la retiene,
-- y queda para revisar. Reintentar con lo mismo contesta el mismo pago.
create function private.payout_mark_paid(p_payout uuid, p_read uuid, p_reference text, p_paid_on date, p_amount_cents bigint) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_period public.period_id;
  y public.payouts;
  r private.payout_account_reads;
  v_existing private.payout_payments;
  v_reference text := pg_catalog.btrim(coalesce(p_reference, ''));
  v_conflict text;
  v_first boolean;
  v_changed boolean;
  v_payment uuid;
  v_constraint text;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'payments are marked in read committed' using errcode = '25000';
  end if;
  set constraints private.payout_payments_payments, public.payouts_payments deferred;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_payout is null or p_read is null or pg_catalog.char_length(v_reference) not between 1 and 100
     or p_paid_on is null or p_paid_on > private.release_day() or p_amount_cents is null or p_amount_cents <= 0 then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select x.period_id into v_period from public.payouts x where x.id = p_payout;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  perform 1 from public.payout_periods x where x.period_id = v_period for update;
  select * into y from public.payouts x where x.id = p_payout for update;
  if private.actor_owns_teacher(y.teacher_id) then
    return '{"outcome": "self"}'::jsonb;
  end if;
  if y.released_at is null or p_paid_on < (y.released_at at time zone private.period_zone())::date then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select * into v_existing from private.payout_payments x
  where x.read_id = p_read and x.payout_id = p_payout and pg_catalog.upper(x.reference) = pg_catalog.upper(v_reference)
    and x.paid_on = p_paid_on and x.amount_cents = p_amount_cents
  order by x.recorded_at limit 1;
  if v_existing.id is not null then
    return pg_catalog.jsonb_build_object('outcome', 'already_reported', 'payment_id', v_existing.id, 'conflict', v_existing.conflict, 'status', y.status);
  end if;
  select * into r from private.payout_account_reads x where x.id = p_read and x.payout_id = p_payout;
  if r.id is null then
    return '{"outcome": "needs_read"}'::jsonb;
  end if;

  v_conflict := case
    when y.status = 'paid' then 'already_paid'
    when y.status = 'on_hold' then 'on_hold'
    when y.status <> 'ready_to_pay' then 'not_ready'
    -- De antes de esta vez en lista para pago, anulada, o ya usada: una transferencia que nadie esperaba.
    when r.read_at < private.payout_ready_since(p_payout) or exists (select 1 from private.payout_account_read_voids v where v.read_id = r.id)
         or exists (select 1 from private.payout_payments x where x.read_id = r.id) then 'stale_read'
    when private.payout_under_review(y.teacher_id, y.period_id) then 'under_investigation'
    when exists (select 1 from private.payout_payments x
                 where pg_catalog.upper(x.reference) = pg_catalog.upper(v_reference) and x.paid_on = p_paid_on and x.conflict is null) then 'duplicate_reference'
    when p_amount_cents <> y.net_cents then 'amount_differs'
  end;
  v_first := not exists (
    select 1 from private.payout_payments x
    where x.teacher_id = y.teacher_id and x.clabe_changed_at = r.clabe_changed_at
      and not exists (select 1 from private.payout_requests q where q.payment_id = x.id and q.kind = 'payment_return' and q.status = 'confirmed'));
  -- La CLABE, no la fila: cambiar el RFC o la razón social no cambia la cuenta a la que se transfirió.
  v_changed := (select a.clabe_changed_at from private.tax_profile_account(y.teacher_id) a) is distinct from r.clabe_changed_at;
  begin
    insert into private.payout_payments (payout_id, teacher_id, read_id, tax_profile_version, clabe_changed_at, reference, paid_on, amount_cents,
                                         first_time, account_changed_since_read, conflict, recorded_by)
    values (p_payout, y.teacher_id, p_read, r.tax_profile_version, r.clabe_changed_at, v_reference, p_paid_on, p_amount_cents,
            v_first, v_changed, v_conflict, private.actor_id())
    returning id into v_payment;
  exception when unique_violation then
    -- La misma referencia la confirmó otra liquidación de otro periodo mientras tanto: entra, con su conflicto.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'payout_payments_reference_uq' then
      raise;
    end if;
    v_conflict := 'duplicate_reference';
    insert into private.payout_payments (payout_id, teacher_id, read_id, tax_profile_version, clabe_changed_at, reference, paid_on, amount_cents,
                                         first_time, account_changed_since_read, conflict, recorded_by)
    values (p_payout, y.teacher_id, p_read, r.tax_profile_version, r.clabe_changed_at, v_reference, p_paid_on, p_amount_cents,
            v_first, v_changed, v_conflict, private.actor_id())
    returning id into v_payment;
  end;

  if v_conflict is null then
    update public.payouts x set status = 'paid' where x.id = p_payout;
  elsif y.status in ('ready_to_pay', 'payment_returned') then
    update public.payouts x set status = 'on_hold', hold_kind = 'payment',
      hold_reason = case v_conflict
        when 'under_investigation' then 'Se reportó una transferencia con una investigación abierta.'
        when 'duplicate_reference' then 'Se reportó una transferencia con una referencia que ya se usó ese día.'
        when 'amount_differs' then 'Se reportó una transferencia por otro monto que el neto.'
        when 'stale_read' then 'Se reportó una transferencia con una lectura de la cuenta vieja, anulada o ya usada.'
        else 'Se reportó una transferencia sobre una liquidación devuelta.' end
    where x.id = p_payout;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', case when v_conflict is null then 'paid' else 'conflict' end, 'conflict', v_conflict, 'payment_id', v_payment,
    'status', (select x.status from public.payouts x where x.id = p_payout), 'period_status', private.settle_period(v_period));
end
$$;
revoke all on function private.payout_mark_paid(uuid, uuid, text, date, bigint) from public;

-- ---------------------------------------------------------------------------------------
-- Devolver, retirar y reabrir.

-- La primera persona propone; otra, con la misma llamada, confirma. Sin pagos vivos, la pagada queda devuelta.
create function private.payout_return_payment(p_payment uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_payout uuid;
  v_period public.period_id;
  y public.payouts;
  q private.payout_requests;
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v uuid;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'payments are returned in read committed' using errcode = '25000';
  end if;
  set constraints private.payout_requests_payments, public.payouts_payments deferred;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_payment is null or v_note is null or pg_catalog.char_length(v_note) > 2000 then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select x.payout_id into v_payout from private.payout_payments x where x.id = p_payment;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  select x.period_id into v_period from public.payouts x where x.id = v_payout;
  perform 1 from public.payout_periods x where x.period_id = v_period for update;
  select * into y from public.payouts x where x.id = v_payout for update;
  if private.actor_owns_teacher(y.teacher_id) then
    return '{"outcome": "self"}'::jsonb;
  end if;
  if exists (select 1 from private.payout_requests r where r.payment_id = p_payment and r.kind = 'payment_return' and r.status = 'confirmed') then
    return '{"outcome": "already_returned"}'::jsonb;
  end if;
  select * into q from private.payout_requests r where r.payment_id = p_payment and r.kind = 'payment_return' and r.status = 'pending';
  if q.id is null then
    insert into private.payout_requests (kind, payout_id, payment_id, note, proposed_by)
    values ('payment_return', v_payout, p_payment, v_note, private.actor_id())
    returning id into v;
    return pg_catalog.jsonb_build_object('outcome', 'proposed', 'request_id', v);
  end if;
  if q.proposed_by = private.actor_id() then
    return pg_catalog.jsonb_build_object('outcome', 'awaiting_second', 'request_id', q.id);
  end if;
  update private.payout_requests r set status = 'confirmed', decided_by = private.actor_id(), decision_note = v_note where r.id = q.id;
  if y.status = 'paid' and private.payout_live_payments(v_payout) = 0 then
    update public.payouts x set status = 'payment_returned' where x.id = v_payout;
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'returned', 'request_id', q.id, 'status', (select x.status from public.payouts x where x.id = v_payout));
end
$$;
revoke all on function private.payout_return_payment(uuid, text) from public;

-- Quien propuso, y solo mientras está pendiente.
create function private.payout_withdraw_request(p_request uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  q private.payout_requests;
begin
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  select * into q from private.payout_requests r where r.id = p_request;
  if q.id is null then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  perform 1 from public.payout_periods x join public.payouts y on y.period_id = x.period_id where y.id = q.payout_id for update of x;
  select * into q from private.payout_requests r where r.id = p_request for update;
  if q.status <> 'pending' then
    return '{"outcome": "not_pending"}'::jsonb;
  end if;
  if q.proposed_by <> private.actor_id() then
    return '{"outcome": "not_yours"}'::jsonb;
  end if;
  update private.payout_requests r set status = 'withdrawn', decided_by = private.actor_id() where r.id = p_request;
  return '{"outcome": "withdrawn"}'::jsonb;
end
$$;
revoke all on function private.payout_withdraw_request(uuid) from public;

-- Una devuelta vuelve a lista para pago, con el estado que se vio. Los pagos vivos los cuenta la comprobación al confirmar.
create function private.payout_reopen(p_payout uuid, p_seen text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_period public.period_id;
  y public.payouts;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'payouts reopen in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_payout is null or p_seen is null then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select x.period_id into v_period from public.payouts x where x.id = p_payout;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  perform 1 from public.payout_periods x where x.period_id = v_period for update;
  select * into y from public.payouts x where x.id = p_payout for update;
  if private.actor_owns_teacher(y.teacher_id) then
    return '{"outcome": "self"}'::jsonb;
  end if;
  if y.status::text <> p_seen then
    return pg_catalog.jsonb_build_object('outcome', 'changed', 'status', y.status);
  end if;
  if y.status <> 'payment_returned' then
    return pg_catalog.jsonb_build_object('outcome', 'not_returned', 'status', y.status);
  end if;
  update public.payouts x set status = 'ready_to_pay' where x.id = p_payout;
  return '{"outcome": "reopened"}'::jsonb;
end
$$;
revoke all on function private.payout_reopen(uuid, text) from public;

-- ---------------------------------------------------------------------------------------
-- Retener y soltar.

-- Como antes, también desde devuelta, y con el periodo tomado para escribir desde el inicio: marcar lo toma igual, y subirlo después interbloquearía.
create or replace function private.hold_payout(p_payout uuid, p_reason text, p_seen text, p_alert uuid default null) returns jsonb
language plpgsql security definer set search_path = ''
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
  if p_payout is null or pg_catalog.btrim(coalesce(p_reason, '')) = '' or pg_catalog.char_length(p_reason) > 2000
     or p_seen is null then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select x.period_id into v_period from public.payouts x where x.id = p_payout;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  perform 1 from public.payout_periods p where p.period_id = v_period for update;
  select * into y from public.payouts x where x.id = p_payout for update;
  if private.actor_owns_teacher(y.teacher_id) then
    return '{"outcome": "self"}'::jsonb;
  end if;
  if p_alert is not null and not exists (select 1 from public.anomaly_alerts a where a.id = p_alert) then
    return '{"outcome": "no_alert"}'::jsonb;
  end if;
  if y.status = 'on_hold' then
    -- Retenida porque faltan datos, y ahora hay otra causa: se investiga, y eso sí detiene la purga.
    if y.hold_kind = 'tax_data' and p_seen = 'on_hold' then
      update public.payouts x set hold_kind = 'investigation', hold_reason = pg_catalog.btrim(p_reason), anomaly_alert_id = p_alert
      where x.id = p_payout;
      return pg_catalog.jsonb_build_object('outcome', 'held', 'from', y.held_from_status);
    end if;
    return '{"outcome": "already_held"}'::jsonb;
  end if;
  if y.status::text <> p_seen then
    return pg_catalog.jsonb_build_object('outcome', 'changed', 'status', y.status);
  end if;
  if y.status in ('carried_forward', 'paid') then
    return pg_catalog.jsonb_build_object('outcome', 'not_holdable', 'status', y.status);
  end if;
  update public.payouts x set status = 'on_hold', hold_reason = pg_catalog.btrim(p_reason), anomaly_alert_id = p_alert
  where x.id = p_payout;
  return pg_catalog.jsonb_build_object('outcome', 'held', 'from', y.status);
end
$$;

-- La vista de soltar dice además cuántos pagos vivos tiene: con uno, soltarla la paga.
create or replace function private.unhold_preview(p_payout uuid) returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  y public.payouts;
  v_released timestamptz;
  v_minimum bigint;
  v_bonuses bigint;
  v_adjustments bigint;
  v_balance bigint;
  v_subtotal bigint;
  v jsonb;
begin
  select * into y from public.payouts x where x.id = p_payout;
  if not found then
    return null;
  end if;
  select p.payouts_released_at into v_released from public.payout_periods p where p.period_id = y.period_id;
  v_minimum := private.minimum_payout(y.period_id);
  if y.released_at is not null then
    v_bonuses := y.bonuses_cents;
    v_adjustments := y.adjustments_cents;
    v_balance := y.balance_applied_cents;
    v_subtotal := y.subtotal_cents;
  else
    select coalesce(pg_catalog.sum(b.amount_cents), 0) into v_bonuses
    from public.bonuses b where b.period_id = y.period_id and b.teacher_id = y.teacher_id and b.status = 'confirmed';
    select coalesce(pg_catalog.sum(a.amount_cents), 0) into v_adjustments
    from public.payout_adjustments a where a.applied_period_id = y.period_id and a.teacher_id = y.teacher_id;
    v_balance := private.teacher_balance(y.teacher_id);
    v_subtotal := y.pool_cents + v_bonuses + v_adjustments + v_balance;
  end if;
  v := pg_catalog.jsonb_build_object(
    'payout_id', y.id, 'status', y.status, 'held_from_status', y.held_from_status,
    'releases', y.status = 'on_hold' and y.held_from_status = 'calculated' and v_released is not null,
    'pool_cents', y.pool_cents, 'bonuses_cents', v_bonuses, 'adjustments_cents', v_adjustments, 'balance_cents', v_balance,
    'subtotal_cents', v_subtotal,
    'reaches_minimum', case when v_minimum is not null then v_subtotal >= v_minimum and v_subtotal > 0 end,
    -- Si soltarla la libera ahí mismo, con lo que rige hoy. Si ya se liberó, lo que tiene no cambia.
    'tax', case when y.status = 'on_hold' and y.held_from_status = 'calculated' and v_released is not null
                then private.payout_tax_row(y.teacher_id, v_subtotal, v_minimum) end,
    'live_payments', private.payout_live_payments(y.id),
    'fraud_decided', private.payout_fraud_decided(y.teacher_id, y.period_id));
  return v || pg_catalog.jsonb_build_object(
    'fingerprint', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v::text, 'UTF8')), 'hex'));
end
$$;

-- Como antes; con fraude decidido (decisión 3), o si soltarla la paga porque tiene un pago vivo, la primera persona propone y otra, con la misma vista, suelta:
-- si no, una sola persona convertiría en pagada una transferencia que chocó por el monto o por la referencia.
create or replace function private.unhold_payout(p_payout uuid, p_note text, p_seen text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_period public.payout_periods;
  v_period_id public.period_id;
  y public.payouts;
  v_to public.payout_status;
  v_reason text;
  v_minimum bigint;
  v_preview jsonb;
  q private.payout_requests;
  v uuid;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'holds run in read committed' using errcode = '25000';
  end if;
  set constraints public.payouts_released, public.payouts_payments, private.payout_requests_payments deferred;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_payout is null or pg_catalog.char_length(p_note) > 2000 or p_seen is null then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select x.period_id into v_period_id from public.payouts x where x.id = p_payout;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  select * into v_period from public.payout_periods p where p.period_id = v_period_id for update;
  select * into y from public.payouts x where x.id = p_payout for update;
  if private.actor_owns_teacher(y.teacher_id) then
    return '{"outcome": "self"}'::jsonb;
  end if;
  if y.status <> 'on_hold' then
    return '{"outcome": "not_held"}'::jsonb;
  end if;
  -- El candado del saldo de su maestro antes de mirar la huella: liberar ahí mismo lo usa.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('teacher_balance:' || y.teacher_id::text, 0));
  v_preview := private.unhold_preview(p_payout);
  if v_preview ->> 'fingerprint' is distinct from p_seen then
    return '{"outcome": "changed"}'::jsonb;
  end if;
  -- Soltarla la libera ahí mismo: sin sus datos o sin su regla, se queda retenida.
  if v_preview #>> '{tax,tax_state}' = 'no_data' then
    return '{"outcome": "tax_data_missing"}'::jsonb;
  end if;
  if v_preview #>> '{tax,tax_state}' = 'no_rule' then
    return '{"outcome": "withholding_rules_missing"}'::jsonb;
  end if;
  v_to := case when (v_preview ->> 'live_payments')::bigint > 0 and y.held_from_status in ('ready_to_pay', 'payment_returned') then 'paid'
               else y.held_from_status end;
  if (v_preview ->> 'fraud_decided')::boolean or v_to = 'paid' then
    select * into q from private.payout_requests r where r.payout_id = p_payout and r.kind = 'hold_release' and r.status = 'pending' for update;
    if q.id is null or q.fingerprint <> p_seen then
      if q.id is not null then
        update private.payout_requests r set status = 'superseded', decided_by = private.actor_id() where r.id = q.id;
      end if;
      insert into private.payout_requests (kind, payout_id, fingerprint, note, proposed_by)
      values ('hold_release', p_payout, p_seen, coalesce(nullif(pg_catalog.btrim(p_note), ''), 'Soltar'), private.actor_id())
      returning id into v;
      return pg_catalog.jsonb_build_object('outcome', 'proposed', 'request_id', v);
    end if;
    if q.proposed_by = private.actor_id() then
      return pg_catalog.jsonb_build_object('outcome', 'awaiting_second', 'request_id', q.id);
    end if;
    update private.payout_requests r set status = 'confirmed', decided_by = private.actor_id(), decision_note = nullif(pg_catalog.btrim(p_note), '')
    where r.id = q.id;
  end if;
  v_reason := pg_catalog.current_setting('app.reason', true);
  perform pg_catalog.set_config('app.reason', coalesce(nullif(pg_catalog.btrim(p_note), ''), ''), true);
  update public.payouts x set status = v_to where x.id = p_payout;
  perform pg_catalog.set_config('app.reason', coalesce(v_reason, ''), true);
  if v_to = 'calculated' and v_period.payouts_released_at is not null then
    v_minimum := private.minimum_payout(v_period_id);
    if v_minimum is null then
      raise exception 'period % was released without a minimum payout', v_period_id using errcode = 'P0001';
    end if;
    v_to := private.release_payout(p_payout, v_minimum, v_preview -> 'tax');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'released_from_hold', 'to', v_to, 'period_status', private.settle_period(v_period_id));
end
$$;

grant execute on function private.payout_account_open(uuid), private.payout_account_call(uuid, text, timestamptz),
  private.payout_mark_paid(uuid, uuid, text, date, bigint), private.payout_return_payment(uuid, text), private.payout_withdraw_request(uuid),
  private.payout_reopen(uuid, text), private.payout_account_void_read(uuid, text) to app_service;

-- ---------------------------------------------------------------------------------------
-- El guardián del periodo: el mismo, con la regla única de pagado.

create or replace function private.guard_payout_period()
 returns trigger
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
      if exists (select 1 from public.payouts y where y.period_id = old.period_id and y.status = 'calculated') then
        raise exception '%.%: period % still has payouts to release', tg_table_schema, tg_table_name, old.period_id
          using errcode = '23514';
      end if;
      new.payouts_released_by := private.actor_id();
      new.payouts_released_at := pg_catalog.now();
      return new;
    end if;
    -- De cerrado a pagado (RF-501): liberado, y con todas sus liquidaciones pagadas, acumuladas o vencidas de factura. La hora
    -- la pone la base.
    if new.status = 'paid'
       and (pg_catalog.to_jsonb(new) - array['status', 'paid_at']) is not distinct from (pg_catalog.to_jsonb(old) - array['status', 'paid_at']) then
      if old.payouts_released_at is null then
        raise exception '%.%: period % is paid only once its payouts are released', tg_table_schema, tg_table_name, old.period_id
          using errcode = '23514';
      end if;
      if not private.period_settled(old.period_id) then
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
-- El vigilante: las liquidaciones suman sus libros, sus funciones, sus disparadores y el trabajo; lo fiscal abre por la cuenta de la liquidación.

create or replace function private.schema_violations_payouts()
 returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  payout_tables (table_name) as (
    values ('public.payouts'), ('public.payout_status_events'), ('public.bonuses'), ('public.payout_adjustments'),
           ('public.teacher_balance_entries'), ('private.payout_account_reads'), ('private.payout_account_calls'), ('private.payout_payments'),
           ('private.payout_requests'), ('private.payout_account_read_voids')),
  payout_functions (name, definer, server, fixed_path) as (
    values ('founder_bonus', false, false, true), ('close_founder_bonuses', false, false, true),
           ('guard_payout', false, false, true), ('guard_bonus', false, false, true), ('log_payout_status', false, false, true),
           ('guard_payout_adjustment', false, false, true), ('guard_balance_entry', false, false, true),
           ('teacher_balance', false, false, true), ('payout_pending_teachers', false, false, true),
           ('first_unreleased_period', false, false, true), ('ensure_payout', false, false, true),
           ('settle_period', false, false, true), ('release_payout', false, false, true), ('minimum_payout', false, false, true),
           ('assert_payout_released', false, false, true), ('check_payout_released', true, false, true),
           ('release_payouts', true, true, true), ('hold_payout', true, true, true), ('unhold_payout', true, true, true),
           ('capture_bonus', true, false, true), ('confirm_founder_bonus', true, true, true), ('void_bonus', true, true, true),
           ('capture_adjustment', true, false, true), ('purge_watch_partition', false, false, true),
           ('purge_playback_sessions', false, false, true), ('release_preview', false, false, true),
           ('unhold_preview', false, false, true), ('finance_payouts', true, true, true),
           ('compute_withholdings', false, false, true), ('payout_tax_row', false, false, true), ('release_day', false, false, true),
           ('hold_payout_for_tax_data', true, true, true), ('payout_under_investigation', false, false, true),
           ('raw_retention', false, false, false), ('business_days_add', false, false, true), ('invoice_due_on', false, false, true),
           ('period_settled', false, false, true), ('payout_live_payments', false, false, true), ('payout_under_review', false, false, true),
           ('payout_fraud_decided', false, false, true), ('assert_payout_payments', false, false, true), ('check_payout_payments', true, false, true),
           ('guard_payout_request', false, false, true), ('invoice_deadline', false, false, true), ('payout_account_open', true, true, true),
           ('payout_account_call', true, true, true), ('payout_mark_paid', true, true, true), ('payout_return_payment', true, true, true),
           ('payout_withdraw_request', true, true, true), ('payout_reopen', true, true, true), ('payout_account_void_read', true, true, true),
           ('payout_ready_since', false, false, true), ('payout_open_read', false, false, true)),
  found as (
    select f.name, f.definer, f.server, f.fixed_path, p.oid, p.prosecdef, p.proconfig
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
           ('public.teacher_balance_entries', 'ledger_no_truncate', 'reject_mutation', false),
           ('public.payouts', 'payouts_payments', 'check_payout_payments', true),
           ('private.payout_account_reads', 'ledger_no_update_delete', 'reject_mutation', false),
           ('private.payout_account_reads', 'ledger_no_truncate', 'reject_mutation', false),
           ('private.payout_account_calls', 'ledger_no_update_delete', 'reject_mutation', false),
           ('private.payout_account_calls', 'ledger_no_truncate', 'reject_mutation', false),
           ('private.payout_account_calls', 'audit_changes', 'audit_row_change', false),
           ('private.payout_payments', 'ledger_no_update_delete', 'reject_mutation', false),
           ('private.payout_payments', 'ledger_no_truncate', 'reject_mutation', false),
           ('private.payout_payments', 'audit_changes', 'audit_row_change', false),
           ('private.payout_payments', 'payout_payments_payments', 'check_payout_payments', true),
           ('private.payout_requests', 'payout_requests_guard', 'guard_payout_request', false),
           ('private.payout_requests', 'ledger_no_truncate', 'reject_mutation', false),
           ('private.payout_requests', 'audit_changes', 'audit_row_change', false),
           ('private.payout_requests', 'payout_requests_payments', 'check_payout_payments', true),
           ('private.payout_account_read_voids', 'ledger_no_update_delete', 'reject_mutation', false),
           ('private.payout_account_read_voids', 'ledger_no_truncate', 'reject_mutation', false))
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
    and not (found.server and r.rolname = 'app_service')
  union all
  select 'payouts function not executable by app_service', found.oid::regprocedure::text
  from found
  where found.server and not pg_catalog.has_function_privilege('app_service', found.oid, 'EXECUTE')
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
  select 'payouts job not scheduled: ' || k.jobname, 'cron.job'
  from (values ('raw_retention', 'call private.raw_retention()'), ('invoice_deadline', 'select private.invoice_deadline()')) k (jobname, command)
  where not exists (select 1 from cron.job j where j.jobname = k.jobname and j.active and j.command = k.command)
  union all
  -- Abrir, marcar, devolver, reabrir, retener y soltar toman el periodo para escribir antes que la liquidación: con «para compartir» que después sube a
  -- escribir, dos marcas se interbloquearían con la transferencia ya hecha.
  select 'payouts function without the period lock', k.name
  from (values ('payout_account_open'), ('payout_mark_paid'), ('payout_return_payment'), ('payout_reopen'), ('hold_payout'), ('unhold_payout'),
               ('payout_account_void_read')) k (name)
  where not exists (select 1 from found where found.name = k.name
                      and pg_catalog.pg_get_functiondef(found.oid) ~ 'from public\.payout_periods [a-z]+ where [a-z]+\.period_id = v_period(_id)? for update;')
  union all
  -- La auditoría de los pagos no lleva el monto (con el bruto diría el régimen), y la de las llamadas, con quién se habló.
  select 'payouts audit names what it must not: ' || k.table_name, k.table_name
  from (values ('private.payout_payments', '%audit_row_change(''money'', ''amount_cents'')%'),
               ('private.payout_account_calls', '%audit_row_change(''money'', ''spoke_with'')%')) k (table_name, pattern)
  where not exists (select 1 from pg_catalog.pg_trigger tg where tg.tgrelid = pg_catalog.to_regclass(k.table_name) and tg.tgname = 'audit_changes'
                      and pg_catalog.pg_get_triggerdef(tg.oid) like k.pattern)
$$;

create or replace function private.schema_violations_tax()
 returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  tax_functions (name, signature, reads) as (
    values ('tax_profile_save', 'private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer, boolean)', false),
           ('tax_profile_state', 'private.tax_profile_state()', false),
           ('tax_profile_mine', 'private.tax_profile_mine()', true),
           ('payout_account_open', 'private.payout_account_open(uuid)', true)),
  -- Las que nombran la tabla sin leer lo cifrado: la lista de PA-65 solo dice si hay una fila, y el vigilante la vigila.
  tax_known (oid) as (
    select pg_catalog.to_regprocedure(f.signature)::oid from tax_functions f
    union all
    select pg_catalog.to_regprocedure(k.signature)::oid
    from (values ('private.teacher_roster()'), ('private.tax_profile_fiscal(uuid, integer)'), ('private.tax_profile_account(uuid)'), ('private.schema_violations_tax()'), ('private.schema_violations_ledgers()')) k (signature))
  -- Ningún rol de la aplicación toca la tabla, ni por columna: una lectura directa no quedaría en la auditoría.
  select 'tax table privilege for ' || r.rolname, 'private.teacher_tax_profiles'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'private.teacher_tax_profiles'::regclass, 'select, insert, update, delete, truncate, references, trigger')
     or pg_catalog.has_any_column_privilege(r.rolname::name, 'private.teacher_tax_profiles'::regclass, 'select, insert, update, references')
  union all
  select 'tax table privilege for ' || r.rolname, 'public.withholding_rules'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'public.withholding_rules'::regclass, 'select, insert, update, delete, truncate, references, trigger')
  union all
  -- Toda función nombrada existe, es del dueño y solo la ejecuta el servidor.
  select 'tax function missing or wrong: ' || f.signature, f.name
  from tax_functions f
  where pg_catalog.to_regprocedure(f.signature) is null
     or not coalesce((select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(f.signature)), false)
     or not pg_catalog.has_function_privilege('app_service', f.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', f.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', f.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', f.signature, 'execute')
  union all
  -- Quien lee lo cifrado, audita.
  select 'tax read without audit: ' || f.signature, f.name
  from tax_functions f
  where f.reads and not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(f.signature)) like '%''tax_profile.read''%', false)
  union all
  -- Finanzas lee con su puerta, y nunca sobre sí.
  select 'tax finance read without its gate', 'payout_account_open'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.payout_account_open(uuid)')) like '%finance_change_gate%actor_owns_teacher%', false)
  union all
  -- Guardar toma el candado del saldo: liberar lee este perfil, y la carrera no se ve en una prueba de una sola conexión.
  select 'tax save without the clabe wait', 'tax_profile_save'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer, boolean)')) like '%tax_clabe_standing%tax_clabe_wait%clabe_effective_from%', false)
  union all
  select 'tax finance read without the clabe wait', 'payout_account_open'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.payout_account_open(uuid)')) like '%tax_clabe_standing%clabe_waiting%audit_log%', false)
  union all
  -- Y abrir la cuenta mira la liquidación, lo que se investiga y la primera vez (T-604): sin eso, se le pagaría a una cuenta en plena investigación.
  select 'tax finance read without the payout checks', 'payout_account_open'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.payout_account_open(uuid)')) like '%ready_to_pay%payout_under_review%payout_account_calls%payout_account_reads%', false)
  union all
  select k.name || ' reachable', k.name
  from (values ('tax_clabe_standing', 'private.tax_clabe_standing(uuid, timestamptz, timestamptz)'), ('tax_clabe_wait', 'private.tax_clabe_wait()'),
               ('tax_profile_account', 'private.tax_profile_account(uuid)')) k (name, signature)
  where pg_catalog.to_regprocedure(k.signature) is null
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(k.signature))
     or pg_catalog.has_function_privilege('app_service', k.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', k.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', k.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', k.signature, 'execute')
  union all
  select 'password change log missing', 'private.account_security'
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'private.account_security'::regclass and tg.tgname = 'password_change_log' and tg.tgenabled in ('O', 'A')
      and tg.tgfoid = 'private.log_password_change()'::regprocedure)
  union all
  select 'password change log reachable', 'private.account_password_changes'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'private.account_password_changes'::regclass, 'select, insert, update, delete, truncate, references, trigger')
  union all
  select 'tax save without the balance lock', 'tax_profile_save'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer, boolean)')) like '%teacher_balance:%', false)
  union all
  -- Y la fila del maestro, para ir uno tras otro con quien confirma un fraude: un candado que se mueva de sentencia dejaría escribir después de confirmado.
  select 'tax save without the teacher row', 'tax_profile_save'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer, boolean)')) like '%from public.teachers t join public.profiles p on p.id = t.profile_id%for share of t%', false)
  union all
  -- El estado y la lista de PA-65 no leen lo que hay en la tabla: no quedan en la auditoría.
  select 'tax data out of its doors: ' || d.name, d.name
  from (values ('tax_profile_state', 'private.tax_profile_state()'), ('teacher_roster', 'private.teacher_roster()')) d (name, signature)
  where coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(d.signature)), '') ~ '(rfc_enc|legal_name_enc|clabe_enc|clabe_last4|tax_regime_code|payee_kind)'
  union all
  -- Lo fiscal en claro lee el régimen y el tipo de persona, porque el dinero los necesita; lo cifrado y los últimos cuatro, no.
  select 'tax data out of its doors: tax_profile_fiscal', 'tax_profile_fiscal'
  where coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_fiscal(uuid, integer)')), '') ~ '(rfc_enc|legal_name_enc|clabe_enc|clabe_last4)'
  union all
  -- Y no es de nadie más que del dueño: sin auditoría, entregaría el régimen de cada maestro.
  select 'tax_profile_fiscal reachable', 'tax_profile_fiscal'
  where pg_catalog.to_regprocedure('private.tax_profile_fiscal(uuid, integer)') is null
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('private.tax_profile_fiscal(uuid, integer)'))
     or pg_catalog.has_function_privilege('app_service', 'private.tax_profile_fiscal(uuid, integer)', 'execute')
     or pg_catalog.has_function_privilege('authenticated', 'private.tax_profile_fiscal(uuid, integer)', 'execute')
     or pg_catalog.has_function_privilege('anon', 'private.tax_profile_fiscal(uuid, integer)', 'execute')
     or pg_catalog.has_function_privilege('service_role', 'private.tax_profile_fiscal(uuid, integer)', 'execute')
  union all
  -- Lo que garantiza que el neto sea positivo, y que regla y versión vayan juntas.
  select 'tax constraint missing: ' || c.name, c.name
  from (values ('withholding_rules_something_left', 'public.withholding_rules'), ('payouts_withholding_together', 'public.payouts'),
               ('payouts_hold_kind_when_held', 'public.payouts'), ('payouts_hold_kind_known', 'public.payouts')) c (name, table_name)
  where not exists (select 1 from pg_catalog.pg_constraint k where k.conname = c.name and k.conrelid = c.table_name::regclass and k.convalidated)
  union all
  -- La auditoría de las liquidaciones no dice con qué regla ni con qué impuestos: configuración la lee, y las reglas dicen el régimen.
  select 'payouts audit names the withholding rule', 'public.payouts'
  where not exists (select 1 from pg_catalog.pg_trigger tg where tg.tgrelid = 'public.payouts'::regclass and tg.tgname = 'audit_changes'
                      and pg_catalog.pg_get_triggerdef(tg.oid) like '%withholding_rule_id%vat_cents%income_tax_withheld_cents%vat_withheld_cents%net_cents%')
  union all
  -- Toda otra función que nombre la tabla es una puerta nueva, aunque se llame igual en otro esquema o con otra firma.
  select 'tax function not in the list', p.proname::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and coalesce(p.prosrc, '') || coalesce(pg_catalog.pg_get_function_sqlbody(p.oid), '') like '%teacher_tax_profiles%'
    and p.oid not in (select k.oid from tax_known k where k.oid is not null)
  union all
  -- Una vista corre como su dueño: saltaría los permisos y la auditoría.
  select 'tax table read by a view', c.relname::text
  from pg_catalog.pg_depend d
  join pg_catalog.pg_rewrite w on w.oid = d.objid
  join pg_catalog.pg_class c on c.oid = w.ev_class
  where d.classid = 'pg_catalog.pg_rewrite'::regclass and d.refclassid = 'pg_catalog.pg_class'::regclass
    and d.refobjid = 'private.teacher_tax_profiles'::regclass
  union all
  -- Los disparadores: de solo inserción, y la auditoría sin lo que hay en la tabla.
  select 'tax table trigger missing: ' || t.name, 'private.teacher_tax_profiles'
  from (values ('ledger_no_update_delete', '%reject_mutation%'), ('ledger_no_truncate', '%reject_mutation%'),
               ('audit_changes', '%rfc_enc%legal_name_enc%clabe_enc%clabe_last4%tax_regime_code%payee_kind%')) t (name, pattern)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'private.teacher_tax_profiles'::regclass and tg.tgname = t.name
      and tg.tgenabled in ('O', 'A') and pg_catalog.pg_get_triggerdef(tg.oid) like t.pattern)
  union all
  select 'tax rules trigger missing: ' || t.name, 'public.withholding_rules'
  from (values ('audit_changes', '%audit_row_change%'), ('withholding_rules_guard', '%guard_withholding_rule%')) t (name, pattern)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'public.withholding_rules'::regclass and tg.tgname = t.name
      and tg.tgenabled in ('O', 'A') and pg_catalog.pg_get_triggerdef(tg.oid) like t.pattern)
  union all
  -- Toda columna cifrada queda fuera de la auditoría.
  select 'tax column not redacted in the audit: ' || a.attname, 'private.teacher_tax_profiles'
  from pg_catalog.pg_attribute a
  where a.attrelid = 'private.teacher_tax_profiles'::regclass and a.attnum > 0 and not a.attisdropped and a.attname like '%\_enc'
    and not coalesce((select pg_catalog.pg_get_triggerdef(tg.oid) like '%' || a.attname || '%' from pg_catalog.pg_trigger tg
                      where tg.tgrelid = 'private.teacher_tax_profiles'::regclass and tg.tgname = 'audit_changes'), false)
  union all
  -- La forma de lo cifrado se revisa por lo que dice, no por su nombre. Sin los últimos cuatro, la CLABE entera cabría en claro.
  select 'tax table constraint missing: ' || c.name, 'private.teacher_tax_profiles'
  from (values ('teacher_tax_profiles_rfc_sealed', '%get_byte(rfc_enc%'), ('teacher_tax_profiles_legal_name_sealed', '%get_byte(legal_name_enc%'),
               ('teacher_tax_profiles_clabe_sealed', '%octet_length(clabe_enc) = 49%'), ('teacher_tax_profiles_last4_form', '%[0-9]{4}%'),
               ('teacher_tax_profiles_clabe_dates', '%clabe_effective_from%clabe_changed_at%')) c (name, pattern)
  where not exists (
    select 1 from pg_catalog.pg_constraint k
    where k.conrelid = 'private.teacher_tax_profiles'::regclass and k.conname = c.name and k.convalidated
      and pg_catalog.pg_get_constraintdef(k.oid) like c.pattern)
$$;

-- El de la salida de correo, con la lectura de finanzas por su nombre nuevo.

create or replace function private.schema_violations_mail()
 returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  doors (name, signature) as (
    values ('mail_claim', 'private.mail_claim(integer)'), ('mail_sent', 'private.mail_sent(uuid)'),
           ('mail_rejected', 'private.mail_rejected(uuid, integer)'), ('mail_health', 'private.mail_health()')),
  helpers (name, signature) as (
    values ('clabe_notice_key', 'private.clabe_notice_key(uuid, timestamptz)'), ('queue_clabe_notice', 'private.queue_clabe_notice()'),
           ('tax_clabe_effective', 'private.tax_clabe_effective(uuid, timestamptz, timestamptz)'), ('mail_purge', 'private.mail_purge()'),
           ('tax_clabe_notice_failed', 'private.tax_clabe_notice_failed(uuid, timestamptz)'),
           ('guard_mail_outbox', 'private.guard_mail_outbox()'))
  select 'mail table privilege for ' || r.rolname, 'private.mail_outbox'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'private.mail_outbox'::regclass, 'select, insert, update, delete, truncate, references, trigger')
     or pg_catalog.has_any_column_privilege(r.rolname::name, 'private.mail_outbox'::regclass, 'select, insert, update, references')
  union all
  select 'mail table without row security', 'private.mail_outbox'
  where not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'private.mail_outbox'::regclass)
  union all
  select 'mail door missing or wrong: ' || d.name, d.name
  from doors d
  where pg_catalog.to_regprocedure(d.signature) is null
     or not coalesce((select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(d.signature)), false)
     or not pg_catalog.has_function_privilege('app_service', d.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', d.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', d.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', d.signature, 'execute')
  union all
  select 'mail helper reachable: ' || h.name, h.name
  from helpers h
  where pg_catalog.to_regprocedure(h.signature) is null
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(h.signature))
     or pg_catalog.has_function_privilege('app_service', h.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', h.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', h.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', h.signature, 'execute')
  union all
  select 'mail trigger missing: ' || t.name, t.table_name
  from (values ('clabe_notice_queue', 'private.teacher' || '_tax_profiles', '%queue_clabe_notice%'),
               ('mail_outbox_guard', 'private.mail_outbox', '%guard_mail_outbox%'),
               ('ledger_no_delete', 'private.mail_outbox', '%reject_mutation%'),
               ('ledger_no_truncate', 'private.mail_outbox', '%reject_mutation%')) t (name, table_name, pattern)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = t.table_name::regclass and tg.tgname = t.name
      and tg.tgenabled in ('O', 'A') and pg_catalog.pg_get_triggerdef(tg.oid) like t.pattern)
  union all
  select 'clabe standing without the notice', 'tax_clabe_standing'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_clabe_standing(uuid, timestamptz, timestamptz)')) like '%tax_clabe_effective%tax_clabe_notice_failed%notice_pending%', false)
  union all
  select 'finance read without the notice', 'payout_account_open'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.payout_account_open(uuid)')) like '%tax_clabe_standing%clabe_notice_pending%audit_log%', false)
  union all
  select 'mail job not scheduled: mail_purge', 'cron.job'
  where not exists (select 1 from cron.job j where j.jobname = 'mail_purge' and j.active)
$$;
