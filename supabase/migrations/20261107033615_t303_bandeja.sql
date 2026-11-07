-- T-303, primera solicitud · La bandeja de los avisos de Stripe y lo que un aviso aplica (RF-208, RF-710, RN-01, RN-02, RN-13; 05 §5.3 y §9.1). Plan aprobado por
-- Sergio el 2026-11-06 (`~/.claude/plans/t303-avisos-plan.md`), con sus decisiones de ese día: se procesa dentro de la petición y Stripe reenvía lo que falla de
-- paso; un reembolso o un contracargo espera a T-307 y frena el cierre; lo que no se puede aplicar solo, finanzas lo resuelve a mano con nota; una factura de 0 no
-- da acceso; y el recibo (CO-03) sale una vez por cobro.
--
-- Lo que cambia respecto del 05:
--   · la bandeja no guarda el cuerpo del aviso ni su huella: procesar no confía en él, lee el estado de ahora en Stripe, y un repetido se reconoce por su id;
--   · nadie de la aplicación llama a `record_charge`: la llama `billing_apply`, del dueño, que en una sola transacción registra los cobros de una factura, deja la
--     suscripción al día y marca el aviso. `record_charge` recibe el aviso al final (con valor por omisión: las llamadas de catorce siguen sirviendo);
--   · el estado propio sale de una sola traducción (`billing_state`) de lo que dice Stripe y de si hubo periodo pagado, y el periodo pagado lo avanza solo un
--     cobro (el fin de la línea de la factura, nunca hacia atrás). Así quien pagó no se queda en `pending` por el orden en que lleguen los avisos;
--   · `ended_at` no se escribe desde Stripe (es de T-304 y T-307): una cancelación inmediata no corta días pagados;
--   · la falla de una renovación se anota con la hora de Stripe solo si la factura de ciclo sigue sin pagar, se conserva si ya había una, y la limpia el cobro cuyo
--     periodo termina después de ella;
--   · la foto del tramo del bote espera a que no haya avisos sin terminar de antes del fin del mes, y los alumnos activos cuentan el inicio de la suscripción en
--     Stripe en vez de la hora de su fila.
--
-- Decisiones mías sin confirmar: diez intentos con espera creciente (1 min, 5 min, 30 min, 2 h, 12 h, y después un día), reclamar por 2 minutos, la falla de una
-- renovación con un día de holgura antes del fin del periodo pagado, y una segunda suscripción viva de la misma cuenta falla sin escribir su cobro (la
-- conciliación lo dirá hasta que se explique).

-- ---------------------------------------------------------------------------------------
-- La bandeja.

create table private.provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  livemode boolean not null,
  api_version text,
  object_id text not null,
  occurred_at timestamptz not null,                 -- el `created` del evento en Stripe
  received_at timestamptz not null default pg_catalog.clock_timestamp(),
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default pg_catalog.clock_timestamp(),
  locked_until timestamptz,
  last_error text,                                  -- un código propio, nunca texto del proveedor
  finished_at timestamptz,
  resolved_by uuid references public.profiles (id),
  resolution_note text,
  constraint provider_events_uq unique (provider, provider_event_id),
  constraint provider_events_provider_known check (provider in ('stripe')),
  constraint provider_events_ids_format check (provider_event_id ~ '^[!-~]{1,255}$' and object_id ~ '^[!-~]{1,255}$'),
  constraint provider_events_type_format check (event_type ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$' and char_length(event_type) <= 100),
  constraint provider_events_api_version_format check (api_version ~ '^[!-~]{1,40}$'),
  constraint provider_events_status_known check (status in ('pending', 'processing', 'processed', 'ignored', 'deferred', 'failed', 'resolved')),
  constraint provider_events_attempts_positive check (attempts >= 0),
  constraint provider_events_error_format check (last_error ~ '^[a-z0-9_]{1,64}$'),
  constraint provider_events_finished check ((status in ('processed', 'ignored', 'resolved')) = (finished_at is not null)),
  constraint provider_events_locked check (status = 'processing' or locked_until is null),
  constraint provider_events_waits_with_reason check (status not in ('deferred', 'failed') or last_error is not null),
  constraint provider_events_resolved check ((status = 'resolved') = (resolved_by is not null and resolution_note is not null)),
  constraint provider_events_note_length check (char_length(resolution_note) between 1 and 500)
);
comment on table private.provider_events is 'Los avisos del proveedor de cobro (RF-208): uno por su id, sin su cuerpo. Sin terminar (pendiente, en proceso, fallido o en espera) frena la foto del mes y, con T-303, el cierre.';
alter table private.provider_events enable row level security;
revoke all on table private.provider_events from public, anon, authenticated, service_role, app_service;
-- Lo que el barrido toma.
create index provider_events_due_idx on private.provider_events (next_attempt_at) where status in ('pending', 'processing');
-- Lo que frena la foto del mes y el cierre.
create index provider_events_unfinished_idx on private.provider_events (occurred_at) where status in ('pending', 'processing', 'failed', 'deferred');

-- Lo que dijo Stripe no cambia, nada se borra, y lo terminado no vuelve atrás. Los intentos solo bajan al reabrir uno fallido.
create function private.guard_provider_event() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'provider_events are not deleted' using errcode = '42501';
  end if;
  if (new.id, new.provider, new.provider_event_id, new.event_type, new.livemode, new.api_version, new.object_id, new.occurred_at, new.received_at)
     is distinct from (old.id, old.provider, old.provider_event_id, old.event_type, old.livemode, old.api_version, old.object_id, old.occurred_at, old.received_at) then
    raise exception 'provider event % keeps what the provider said', old.id using errcode = '42501';
  end if;
  if old.status in ('processed', 'ignored', 'resolved') then
    raise exception 'provider event % is finished', old.id using errcode = '42501';
  end if;
  if new.attempts < old.attempts and not (old.status = 'failed' and new.status = 'pending') then
    raise exception 'provider event % attempts only go down when it is reopened', old.id using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function private.guard_provider_event() from public;
create trigger provider_events_guard before update or delete on private.provider_events
  for each row execute function private.guard_provider_event();
create trigger ledger_no_truncate before truncate on private.provider_events
  for each statement execute function private.reject_mutation();

-- Lo que finanzas hizo con un aviso (RF-710): reintentarlo o resolverlo a mano. Un libro.
create table private.provider_event_actions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references private.provider_events (id),
  action text not null,
  actor uuid not null references public.profiles (id),
  note text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint provider_event_actions_known check (action in ('retry', 'resolve')),
  constraint provider_event_actions_note check ((action = 'resolve') = (note is not null) and (note is null or char_length(note) between 1 and 500))
);
alter table private.provider_event_actions enable row level security;
revoke all on table private.provider_event_actions from public, anon, authenticated, service_role, app_service;
create trigger ledger_no_update_delete before update or delete on private.provider_event_actions
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.provider_event_actions
  for each statement execute function private.reject_mutation();
-- Sin la nota: es texto libre, y configuración lee la auditoría.
create trigger audit_changes after insert on private.provider_event_actions
  for each row execute function private.audit_row_change('money', 'note');

-- Lo que liquida el proveedor por cada cobro (decisión de Sergio del 2026-10-23): la comisión y el neto reales, para comparar con el depósito. Un libro aparte; el
-- reparto sigue con la comisión fija de RN-02. Uno por cobro: el primero que llega con su transacción de saldo.
create table private.provider_settlements (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid not null references public.charges (id),
  provider text not null,
  balance_transaction_id text not null,
  gross_cents bigint not null,
  fee_cents bigint not null,
  net_cents bigint not null,
  available_on timestamptz,
  read_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint provider_settlements_charge_uq unique (charge_id),
  constraint provider_settlements_transaction_uq unique (provider, balance_transaction_id),
  constraint provider_settlements_provider_known check (provider in ('stripe')),
  constraint provider_settlements_transaction_format check (balance_transaction_id ~ '^[!-~]{1,255}$'),
  constraint provider_settlements_amounts check (gross_cents > 0 and fee_cents >= 0 and net_cents = gross_cents - fee_cents)
);
alter table private.provider_settlements enable row level security;
revoke all on table private.provider_settlements from public, anon, authenticated, service_role, app_service;
create trigger ledger_no_update_delete before update or delete on private.provider_settlements
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.provider_settlements
  for each statement execute function private.reject_mutation();

-- ---------------------------------------------------------------------------------------
-- Lo que se toca de lo que ya existía.

alter table public.subscriptions
  add column provider_status text,
  add column provider_started_at timestamptz,
  add constraint subscriptions_provider_status_format check (provider_status ~ '^[a-z_]{1,40}$'),
  add constraint subscriptions_provider_started_finite check (pg_catalog.isfinite(provider_started_at));
comment on column public.subscriptions.provider_status is 'Lo último que dijo el proveedor de su estado (T-303). El estado propio sale de él y del periodo pagado (`private.billing_state`).';
comment on column public.subscriptions.provider_started_at is 'Cuándo empezó en el proveedor. Los alumnos activos de un instante la cuentan desde ahí, no desde su fila (RN-13).';

alter table public.charges
  drop constraint charges_event_later,
  add constraint charges_event_fk foreign key (provider_event_id) references private.provider_events (id);

alter table private.mail_outbox
  drop constraint mail_outbox_template_known,
  add constraint mail_outbox_template_known check (template in ('CO-27', 'CO-03'));

-- Registrar un cobro (T-301 y T-601), ahora con el aviso que lo trajo, al final. Lo demás no cambia: el aviso no entra en lo que se compara al repetirlo.
drop function private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint, bigint, bigint, text, text, text);
create function private.record_charge(
  p_profile uuid, p_subscription uuid, p_provider text, p_provider_charge_id text, p_provider_invoice_id text,
  p_plan public.subscription_plan, p_charged_at timestamptz, p_currency text, p_gross_cents bigint,
  p_provider_fee_cents bigint, p_provider_net_cents bigint, p_payment_method text, p_country_code text,
  p_receipt_url text, p_provider_event uuid default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_found public.charges;
  v_period public.period_id;
  v_iva integer;
  v_fee integer;
  v_rule text;
  v_net_of_tax bigint;
  v_net bigint;
  v_start public.period_id;
begin
  -- Si dos llegan a la vez, la segunda espera a la primera y tiene que ver su cobro ya confirmado.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.record_charge() needs read committed isolation' using errcode = '25000';
  end if;

  if p_profile is null or p_subscription is null or p_plan is null or p_charged_at is null
     or p_provider is null or p_provider not in ('stripe', 'mercadopago', 'manual')
     or p_provider_charge_id is null or p_provider_charge_id !~ '^[!-~]{1,255}$'
     or p_provider_invoice_id !~ '^[!-~]{1,255}$'
     or p_currency is null or p_currency !~ '^[A-Z]{3}$'
     or p_gross_cents is null or p_gross_cents not between 1 and 1000000000
     or p_provider_fee_cents < 0 or p_provider_net_cents < 0
     or p_payment_method not in ('card', 'oxxo', 'bank_transfer', 'other')
     or p_country_code !~ '^[A-Z]{2}$'
     or p_receipt_url !~ '^https://' or length(p_receipt_url) > 2048
     or p_charged_at > pg_catalog.now() + interval '5 minutes'
     or p_charged_at < timestamptz '2020-01-01 00:00Z' then
    return jsonb_build_object('outcome', 'malformed', 'charge_id', null::uuid);
  end if;
  if p_currency <> 'MXN' then
    return jsonb_build_object('outcome', 'unsupported_currency', 'charge_id', null::uuid);
  end if;
  -- Con candado: que no cambie de cuenta ni de proveedor antes de escribir el cobro.
  perform 1 from public.subscriptions s
  where s.id = p_subscription and s.profile_id = p_profile and s.provider = p_provider
  for key share;
  if not found then
    return jsonb_build_object('outcome', 'not_found', 'charge_id', null::uuid);
  end if;

  select * into v_found from public.charges c
  where c.provider = p_provider and c.provider_charge_id = p_provider_charge_id;
  if not found then
    v_period := private.period_of(p_charged_at);
    select r.iva_bps, r.fee_bps, r.rule into v_iva, v_fee, v_rule from private.revenue_rule(v_period) r;
    select m.net_of_tax_cents, m.revenue_net_cents into v_net_of_tax, v_net from private.revenue_amounts(p_gross_cents, v_iva, v_fee) m;
    v_start := private.allocation_start(v_period);

    insert into public.charges (
      profile_id, subscription_id, provider, provider_charge_id, provider_invoice_id, provider_event_id, plan, charged_at, period_id,
      allocation_start_period_id, currency, gross_cents, tax_cents, provider_fee_cents, provider_net_cents, fx_rate_to_mxn, fx_source,
      gross_mxn_cents, net_of_tax_mxn_cents, iva_bps, fee_bps, revenue_net_mxn_cents, payment_method, country_code,
      receipt_url)
    values (
      p_profile, p_subscription, p_provider, p_provider_charge_id, p_provider_invoice_id, p_provider_event, p_plan, p_charged_at, v_period,
      v_start, p_currency, p_gross_cents, p_gross_cents - v_net_of_tax, p_provider_fee_cents, p_provider_net_cents, 1, 'same_currency',
      p_gross_cents, v_net_of_tax, v_iva, v_fee, v_net, p_payment_method, p_country_code, p_receipt_url)
    on conflict on constraint charges_provider_uq do nothing
    returning id into v_id;

    if v_id is not null then
      insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
      select v_id, p_profile, p.period_id, 'charge', p.part_no, p.parts_total, p.base_cents, v_fee,
             case when v_start <> v_period then 'late_charge_v1' else v_rule end
      from private.revenue_parts(v_net, p_plan, v_start) p;
      -- La red del criterio: las partes suman exactamente el ingreso neto.
      if (select sum(a.base_cents) from public.revenue_allocations a where a.charge_id = v_id) is distinct from v_net then
        raise exception 'revenue parts of charge % do not add up', v_id using errcode = 'P0001';
      end if;
      return jsonb_build_object('outcome', 'recorded', 'charge_id', v_id)
             || case when v_start <> v_period then '{"late": true}'::jsonb else '{}'::jsonb end;
    end if;

    -- Otro lo registró mientras tanto; ya confirmado, se ve.
    select * into v_found from public.charges c
    where c.provider = p_provider and c.provider_charge_id = p_provider_charge_id;
  end if;

  if v_found.profile_id = p_profile and v_found.subscription_id = p_subscription and v_found.plan = p_plan
     and v_found.charged_at = p_charged_at and v_found.currency = p_currency and v_found.gross_cents = p_gross_cents then
    return jsonb_build_object('outcome', 'already_recorded', 'charge_id', v_found.id);
  end if;
  return jsonb_build_object('outcome', 'conflict', 'charge_id', null::uuid);
end
$$;
revoke all on function private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint, bigint, bigint, text, text, text, uuid) from public;

-- ---------------------------------------------------------------------------------------
-- Las piezas de la traducción. Ninguna la ejecuta la aplicación.

-- El estado propio, de lo que dice Stripe y de si hubo periodo pagado. Sin periodo pagado nunca está viva; con él, viva (también `past_due`: la gracia es de T-304)
-- o cancelada. Un estado que no se conoce es nulo: no se adivina.
create function private.billing_state(p_status text, p_paid boolean) returns public.subscription_status
language sql immutable set search_path = ''
as $$
  select case
    when p_status not in ('incomplete', 'active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete_expired') or p_paid is null then null
    when not p_paid then 'pending'
    when p_status = 'incomplete' then 'pending'
    when p_status in ('active', 'trialing', 'past_due') then 'active'
    else 'canceled'
  end::public.subscription_status
$$;
revoke all on function private.billing_state(text, boolean) from public;

-- El plan, del intervalo del precio: un mes o un año. Lo demás es nulo.
create function private.billing_plan(p_interval text, p_count integer) returns public.subscription_plan
language sql immutable set search_path = ''
as $$
  select case when p_count = 1 and p_interval = 'month' then 'monthly' when p_count = 1 and p_interval = 'year' then 'annual' end::public.subscription_plan
$$;
revoke all on function private.billing_plan(text, integer) from public;

-- Un instante escrito por el servidor, o nulo si no tiene forma. Así una lectura rara no lanza: falla con su código.
create function private.billing_instant(p text) returns timestamptz
language plpgsql immutable set search_path = ''
as $$
declare
  v timestamptz;
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    return null;
  end if;
  v := p::timestamptz;
  return case when pg_catalog.isfinite(v) then v end;
exception when others then
  return null;
end
$$;
revoke all on function private.billing_instant(text) from public;

-- La forma de lo que el servidor leyó. Solo forma: lo que dice se decide en `billing_apply`.
create function private.billing_snapshot_ok(p jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_typeof(p) = 'object'
    and (p ->> 'id') ~ '^[!-~]{1,255}$'
    and (p -> 'customer' is null or pg_catalog.jsonb_typeof(p -> 'customer') = 'null' or (p ->> 'customer') ~ '^[!-~]{1,255}$')
    and coalesce(pg_catalog.jsonb_typeof(p -> 'profile_id'), 'null') in ('null', 'string')
    and (p ->> 'status') ~ '^[a-z_]{1,40}$'
    and (p ->> 'interval') ~ '^[a-z]{1,10}$'
    and pg_catalog.jsonb_typeof(p -> 'interval_count') = 'number' and (p ->> 'interval_count') ~ '^[0-9]{1,4}$'
    and (p ->> 'currency') ~ '^[A-Za-z]{3}$'
    and pg_catalog.jsonb_typeof(p -> 'cancel_at_period_end') = 'boolean'
    and (coalesce(pg_catalog.jsonb_typeof(p -> 'canceled_at'), 'null') = 'null' or private.billing_instant(p ->> 'canceled_at') is not null)
    and private.billing_instant(p ->> 'started_at') is not null
    and private.billing_instant(p ->> 'read_at') is not null, false)
$$;
revoke all on function private.billing_snapshot_ok(jsonb) from public;

create function private.billing_payment_ok(p jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_typeof(p) = 'object'
    and (p ->> 'charge') ~ '^[!-~]{1,255}$'
    and (coalesce(pg_catalog.jsonb_typeof(p -> 'invoice'), 'null') = 'null' or (p ->> 'invoice') ~ '^[!-~]{1,255}$')
    and private.billing_instant(p ->> 'charged_at') is not null
    and pg_catalog.jsonb_typeof(p -> 'gross_cents') = 'number' and (p ->> 'gross_cents') ~ '^[0-9]{1,10}$'
    and (p ->> 'currency') ~ '^[A-Za-z]{3}$'
    and coalesce(pg_catalog.jsonb_typeof(p -> 'method'), 'null') in ('null', 'string')
    and coalesce(pg_catalog.jsonb_typeof(p -> 'country'), 'null') in ('null', 'string')
    and coalesce(pg_catalog.jsonb_typeof(p -> 'receipt_url'), 'null') in ('null', 'string')
    and (p ->> 'interval') ~ '^[a-z]{1,10}$'
    and pg_catalog.jsonb_typeof(p -> 'interval_count') = 'number' and (p ->> 'interval_count') ~ '^[0-9]{1,4}$'
    and private.billing_instant(p ->> 'period_start') < private.billing_instant(p ->> 'period_end')
    and (coalesce(pg_catalog.jsonb_typeof(p -> 'fee_cents'), 'null') = 'null' or (p ->> 'fee_cents') ~ '^[0-9]{1,10}$')
    and (coalesce(pg_catalog.jsonb_typeof(p -> 'net_cents'), 'null') = 'null' or (p ->> 'net_cents') ~ '^[0-9]{1,10}$')
    and (coalesce(pg_catalog.jsonb_typeof(p -> 'balance_transaction'), 'null') = 'null' or (p ->> 'balance_transaction') ~ '^[!-~]{1,255}$')
    and (coalesce(pg_catalog.jsonb_typeof(p -> 'available_on'), 'null') = 'null' or private.billing_instant(p ->> 'available_on') is not null), false)
$$;
revoke all on function private.billing_payment_ok(jsonb) from public;

create function private.billing_failure_ok(p jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_typeof(p) = 'object'
    and (p ->> 'invoice') ~ '^[!-~]{1,255}$'
    and private.billing_instant(p ->> 'failed_at') is not null
    and pg_catalog.jsonb_typeof(p -> 'unpaid') = 'boolean'
    and pg_catalog.jsonb_typeof(p -> 'cycle') = 'boolean', false)
$$;
revoke all on function private.billing_failure_ok(jsonb) from public;

-- ---------------------------------------------------------------------------------------
-- Las puertas del aviso. Las ejecuta el servidor, como sistema (la ruta del aviso y el barrido), salvo reintentar y resolver, que son de finanzas.

-- Guarda un aviso, una vez por su id. Contesta {outcome, id, status}: `stored`, `duplicate` (con cómo va: un reenvío lo vuelve a intentar si sigue pendiente),
-- `conflict` (el mismo id con otro tipo, objeto o modo) o `malformed`.
create function private.provider_event_receive(p_provider text, p_event_id text, p_type text, p_livemode boolean, p_api_version text,
                                               p_object_id text, p_occurred_at timestamptz)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v private.provider_events;
begin
  if p_provider is distinct from 'stripe' or p_event_id is null or p_event_id !~ '^[!-~]{1,255}$'
     or p_type is null or p_type !~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$' or char_length(p_type) > 100
     or p_livemode is null or p_api_version !~ '^[!-~]{1,40}$'
     or p_object_id is null or p_object_id !~ '^[!-~]{1,255}$'
     or p_occurred_at is null or not pg_catalog.isfinite(p_occurred_at)
     or p_occurred_at > pg_catalog.now() + interval '5 minutes' or p_occurred_at < timestamptz '2020-01-01 00:00Z' then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  insert into private.provider_events (provider, provider_event_id, event_type, livemode, api_version, object_id, occurred_at)
  values (p_provider, p_event_id, p_type, p_livemode, p_api_version, p_object_id, p_occurred_at)
  on conflict on constraint provider_events_uq do nothing
  returning id into v_id;
  if v_id is not null then
    return pg_catalog.jsonb_build_object('outcome', 'stored', 'id', v_id, 'status', 'pending');
  end if;
  select * into v from private.provider_events e where e.provider = p_provider and e.provider_event_id = p_event_id;
  if (v.event_type, v.object_id, v.livemode) is distinct from (p_type, p_object_id, p_livemode) then
    return pg_catalog.jsonb_build_object('outcome', 'conflict', 'id', v.id);
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'duplicate', 'id', v.id, 'status', v.status);
end
$$;
revoke all on function private.provider_event_receive(text, text, text, boolean, text, text, timestamptz) from public;
grant execute on function private.provider_event_receive(text, text, text, boolean, text, text, timestamptz) to app_service;

-- Reclama un aviso para procesarlo ahora (la ruta, con cada entrega de Stripe): por 2 minutos, sin mirar su espera. Contesta `claimed` con el intento, `busy` si
-- otro lo tiene, `finished` si ya no toca (terminado, en espera de otra tarea o fallido: lo reabre finanzas) o `not_found`. Con diez intentos queda fallido.
create function private.provider_event_claim(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v private.provider_events;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select * into v from private.provider_events e where e.id = p_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found', 'id', p_id);
  end if;
  if v.status in ('processed', 'ignored', 'resolved', 'deferred', 'failed') then
    return pg_catalog.jsonb_build_object('outcome', 'finished', 'id', v.id, 'status', v.status);
  end if;
  if v.status = 'processing' and v.locked_until > v_now then
    return pg_catalog.jsonb_build_object('outcome', 'busy', 'id', v.id);
  end if;
  if v.attempts >= 10 then
    update private.provider_events e set status = 'failed', last_error = 'attempts_exhausted', locked_until = null where e.id = p_id;
    return pg_catalog.jsonb_build_object('outcome', 'finished', 'id', v.id, 'status', 'failed');
  end if;
  update private.provider_events e set status = 'processing', attempts = e.attempts + 1, locked_until = v_now + interval '2 minutes' where e.id = p_id;
  return pg_catalog.jsonb_build_object('outcome', 'claimed', 'id', v.id, 'attempt', v.attempts + 1, 'event_type', v.event_type, 'object_id', v.object_id);
end
$$;
revoke all on function private.provider_event_claim(uuid) from public;
grant execute on function private.provider_event_claim(uuid) to app_service;

-- El barrido de respaldo: lo pendiente con su espera cumplida y lo apartado que venció, sin tomar lo que otro tiene.
create function private.provider_event_claim_due(p_limit integer)
returns table (id uuid, attempt integer, event_type text, object_id text)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'provider_event_claim_due takes from 1 to 100' using errcode = '22023';
  end if;
  update private.provider_events e set status = 'failed', last_error = 'attempts_exhausted', locked_until = null
  where e.attempts >= 10 and (e.status = 'pending' or (e.status = 'processing' and e.locked_until <= pg_catalog.clock_timestamp()));
  return query
  with due as (
    select e.id from private.provider_events e
    where e.attempts < 10
      and ((e.status = 'pending' and e.next_attempt_at <= pg_catalog.clock_timestamp())
           or (e.status = 'processing' and e.locked_until <= pg_catalog.clock_timestamp()))
    order by e.next_attempt_at
    limit p_limit
    for update skip locked)
  update private.provider_events e set status = 'processing', attempts = e.attempts + 1,
                                       locked_until = pg_catalog.clock_timestamp() + interval '2 minutes'
  from due where e.id = due.id
  returning e.id, e.attempts, e.event_type, e.object_id;
end
$$;
revoke all on function private.provider_event_claim_due(integer) from public;
grant execute on function private.provider_event_claim_due(integer) to app_service;

-- Falló de paso (Stripe no contestó, el tope venció): vuelve a la fila con su código y su espera. Solo el intento en curso.
create function private.provider_event_release(p_id uuid, p_attempt integer, p_code text) returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_code is null or p_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'a released provider event needs its code' using errcode = '22023';
  end if;
  update private.provider_events e set status = 'pending', locked_until = null, last_error = p_code,
         next_attempt_at = pg_catalog.clock_timestamp() + case e.attempts when 1 then interval '1 minute' when 2 then interval '5 minutes'
                                                                          when 3 then interval '30 minutes' when 4 then interval '2 hours'
                                                                          when 5 then interval '12 hours' else interval '1 day' end
  where e.id = p_id and e.status = 'processing' and e.attempts = p_attempt;
  return found;
end
$$;
revoke all on function private.provider_event_release(uuid, integer, text) from public;
grant execute on function private.provider_event_release(uuid, integer, text) to app_service;

-- Termina sin aplicar: `ignored` (un tipo que no es de cobro), `deferred` (su regla es de otra tarea: un reembolso, T-307) o `failed` (no se puede aplicar nunca:
-- una factura de 0, un cargo sin suscripción). Los dos últimos llevan su código. Solo el intento en curso. Procesado lo marca solo `billing_apply`.
create function private.provider_event_finish(p_id uuid, p_attempt integer, p_status text, p_code text) returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('ignored', 'deferred', 'failed') or (p_status <> 'ignored' and p_code is null)
     or p_code !~ '^[a-z0-9_]{1,64}$' then
    return false;
  end if;
  update private.provider_events e set status = p_status, locked_until = null, last_error = p_code,
         finished_at = case when p_status = 'ignored' then pg_catalog.clock_timestamp() end
  where e.id = p_id and e.status = 'processing' and e.attempts = p_attempt;
  return found;
end
$$;
revoke all on function private.provider_event_finish(uuid, integer, text, text) from public;
grant execute on function private.provider_event_finish(uuid, integer, text, text) to app_service;

-- Aplica lo que el servidor leyó de Stripe para un aviso reclamado, en una sola transacción: la suscripción (`p_subscription`), los pagos de una factura pagada
-- (`p_payments`, un arreglo, vacío si no hay) y la falla de una renovación (`p_failure`, o nulo). Contesta `processed` (con `subscription_id` y cuántos cobros
-- nuevos), `failed` con su código (no escribió nada más que el aviso) o `stale` (no es el intento en curso: no escribe).
--
-- El orden de candados: el aviso, el candado consultivo de la suscripción de Stripe (dos avisos de la misma van en fila), su fila, y después `record_charge` (la
-- suscripción para compartir y el periodo para compartir, en `allocation_start`). Nada toma `payout_periods` para escribir, así que no se cruza con el cierre.
create function private.billing_apply(p_event uuid, p_attempt integer, p_subscription jsonb, p_payments jsonb, p_failure jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_event private.provider_events;
  v_sub_id text;
  v_profile uuid;
  v_plan public.subscription_plan;
  v_pay_plan public.subscription_plan;
  v_read timestamptz;
  v_row public.subscriptions;
  v_newer boolean;
  v_payment jsonb;
  v_answer jsonb;
  v_charge uuid;
  v_recorded integer := 0;
  v_end timestamptz;
  v_start timestamptz;
  v_failed timestamptz;
  v_provider_status text;
  v_status public.subscription_status;
  v_email text;
  v_code text;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.billing_apply() needs read committed isolation' using errcode = '25000';
  end if;
  if p_payments is null or pg_catalog.jsonb_typeof(p_payments) <> 'array' then
    raise exception 'billing_apply takes the payments as an array' using errcode = '22023';
  end if;
  select * into v_event from private.provider_events e where e.id = p_event for update;
  if not found or v_event.status <> 'processing' or v_event.attempts is distinct from p_attempt then
    return '{"outcome": "stale"}'::jsonb;
  end if;

  begin
    if not private.billing_snapshot_ok(p_subscription)
       or exists (select 1 from pg_catalog.jsonb_array_elements(p_payments) x where not private.billing_payment_ok(x))
       or (coalesce(pg_catalog.jsonb_typeof(p_failure), 'null') <> 'null' and not private.billing_failure_ok(p_failure)) then
      raise exception using errcode = 'PB303', message = 'malformed_snapshot';
    end if;
    v_sub_id := p_subscription ->> 'id';
    v_read := private.billing_instant(p_subscription ->> 'read_at');
    if pg_catalog.lower(p_subscription ->> 'currency') <> 'mxn'
       or exists (select 1 from pg_catalog.jsonb_array_elements(p_payments) x where pg_catalog.lower(x ->> 'currency') <> 'mxn') then
      raise exception using errcode = 'PB303', message = 'unsupported_currency';
    end if;
    v_plan := private.billing_plan(p_subscription ->> 'interval', (p_subscription ->> 'interval_count')::integer);
    if v_plan is null
       or exists (select 1 from pg_catalog.jsonb_array_elements(p_payments) x
                  where private.billing_plan(x ->> 'interval', (x ->> 'interval_count')::integer) is null) then
      raise exception using errcode = 'PB303', message = 'unknown_plan';
    end if;
    if private.billing_state(p_subscription ->> 'status', false) is null then
      raise exception using errcode = 'PB303', message = 'unknown_subscription_status';
    end if;
    if coalesce(p_subscription ->> 'profile_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode = 'PB303', message = 'unknown_account';
    end if;
    v_profile := (p_subscription ->> 'profile_id')::uuid;
    if not exists (select 1 from public.profiles p where p.id = v_profile) then
      raise exception using errcode = 'PB303', message = 'unknown_account';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('billing_subscription:' || v_sub_id, 0));
    select * into v_row from public.subscriptions s where s.provider = 'stripe' and s.provider_subscription_id = v_sub_id for update;
    if found and v_row.profile_id <> v_profile then
      raise exception using errcode = 'PB303', message = 'account_mismatch';
    end if;
    if not found then
      insert into public.subscriptions (profile_id, provider, provider_subscription_id, provider_customer_id, plan, status, currency, provider_started_at)
      values (v_profile, 'stripe', v_sub_id, p_subscription ->> 'customer', v_plan, 'pending', 'MXN', private.billing_instant(p_subscription ->> 'started_at'))
      returning * into v_row;
    end if;

    -- Los cobros. Cada uno entra una vez; el periodo pagado es el fin más lejano de sus líneas, y nunca va hacia atrás.
    v_end := v_row.current_period_end;
    v_start := v_row.current_period_start;
    select nullif(pg_catalog.lower(u.email), '') into v_email from auth.users u where u.id = v_profile;
    for v_payment in select x from pg_catalog.jsonb_array_elements(p_payments) x loop
      v_pay_plan := private.billing_plan(v_payment ->> 'interval', (v_payment ->> 'interval_count')::integer);
      v_answer := private.record_charge(v_profile, v_row.id, 'stripe', v_payment ->> 'charge', v_payment ->> 'invoice', v_pay_plan,
                                        private.billing_instant(v_payment ->> 'charged_at'), pg_catalog.upper(v_payment ->> 'currency'),
                                        (v_payment ->> 'gross_cents')::bigint, (v_payment ->> 'fee_cents')::bigint, (v_payment ->> 'net_cents')::bigint,
                                        v_payment ->> 'method', v_payment ->> 'country', v_payment ->> 'receipt_url', p_event);
      if v_answer ->> 'outcome' not in ('recorded', 'already_recorded') then
        raise exception using errcode = 'PB303', message = 'charge_' || (v_answer ->> 'outcome');
      end if;
      v_charge := (v_answer ->> 'charge_id')::uuid;
      if v_answer ->> 'outcome' = 'recorded' then
        v_recorded := v_recorded + 1;
        -- El recibo (CO-03), una vez por cobro (decisión 8 de Sergio). Sin correo no hay a quién.
        if v_email is not null then
          insert into private.mail_outbox (idempotency_key, template, profile_id, recipient, params)
          values ('CO-03:' || v_charge, 'CO-03', v_profile, v_email,
                  pg_catalog.jsonb_build_object('gross_cents', (v_payment ->> 'gross_cents')::bigint, 'plan', v_pay_plan,
                                                'charged_at', private.billing_instant(v_payment ->> 'charged_at')))
          on conflict on constraint mail_outbox_key_unique do nothing;
        end if;
      end if;
      -- Lo que liquida Stripe, si ya se sabe y cuadra; si no, lo completa otro aviso. Nunca hace fallar el cobro.
      insert into private.provider_settlements (charge_id, provider, balance_transaction_id, gross_cents, fee_cents, net_cents, available_on, read_at)
      select v_charge, 'stripe', v_payment ->> 'balance_transaction', (v_payment ->> 'gross_cents')::bigint, (v_payment ->> 'fee_cents')::bigint,
             (v_payment ->> 'net_cents')::bigint, private.billing_instant(v_payment ->> 'available_on'), v_read
      where v_payment ->> 'balance_transaction' is not null and v_payment ->> 'fee_cents' is not null and v_payment ->> 'net_cents' is not null
        and (v_payment ->> 'gross_cents')::bigint - (v_payment ->> 'fee_cents')::bigint = (v_payment ->> 'net_cents')::bigint
      on conflict do nothing;
      if private.billing_instant(v_payment ->> 'period_end') > coalesce(v_end, '-infinity'::timestamptz) then
        v_end := private.billing_instant(v_payment ->> 'period_end');
        v_start := private.billing_instant(v_payment ->> 'period_start');
      end if;
    end loop;

    -- La falla de una renovación: la limpia el cobro cuyo periodo termina después de ella; la anota, con la hora de Stripe, una factura de ciclo que sigue sin
    -- pagar al leerla, después de un periodo pagado (con un día de holgura antes de su fin) y si no había otra.
    v_failed := v_row.last_renewal_failed_at;
    if v_failed is not null and v_end > v_failed then
      v_failed := null;
    end if;
    if coalesce(pg_catalog.jsonb_typeof(p_failure), 'null') <> 'null' and (p_failure ->> 'unpaid')::boolean and (p_failure ->> 'cycle')::boolean
       and v_failed is null and v_end is not null
       and private.billing_instant(p_failure ->> 'failed_at') >= v_end - interval '1 day' then
      v_failed := private.billing_instant(p_failure ->> 'failed_at');
    end if;

    -- El estado: lo de Stripe solo si la lectura es más nueva que la guardada; la traducción, siempre otra vez, con el periodo pagado de ahora.
    v_newer := v_row.provider_state_at is null or v_row.provider_state_at < v_read;
    v_provider_status := case when v_newer then p_subscription ->> 'status' else coalesce(v_row.provider_status, p_subscription ->> 'status') end;
    v_status := private.billing_state(v_provider_status, v_end is not null);
    if v_status in ('active', 'in_grace') and exists (
        select 1 from public.subscriptions s where s.profile_id = v_profile and s.id <> v_row.id and s.status in ('active', 'in_grace')) then
      raise exception using errcode = 'PB303', message = 'second_live_subscription';
    end if;
    update public.subscriptions s set
      status = v_status,
      provider_status = v_provider_status,
      plan = case when v_newer then v_plan else s.plan end,
      provider_customer_id = case when v_newer then coalesce(p_subscription ->> 'customer', s.provider_customer_id) else s.provider_customer_id end,
      cancel_at_period_end = case when v_newer then (p_subscription ->> 'cancel_at_period_end')::boolean else s.cancel_at_period_end end,
      canceled_at = case when v_newer then private.billing_instant(p_subscription ->> 'canceled_at') else s.canceled_at end,
      provider_started_at = coalesce(s.provider_started_at, private.billing_instant(p_subscription ->> 'started_at')),
      provider_state_at = case when v_newer then v_read else s.provider_state_at end,
      current_period_start = v_start,
      current_period_end = v_end,
      last_renewal_failed_at = v_failed
    where s.id = v_row.id;

    update private.provider_events e set status = 'processed', finished_at = pg_catalog.clock_timestamp(), locked_until = null, last_error = null
    where e.id = p_event;
    return pg_catalog.jsonb_build_object('outcome', 'processed', 'subscription_id', v_row.id, 'recorded', v_recorded);
  exception
    when sqlstate 'PB303' then
      v_code := sqlerrm;
    -- Sin la regla de RN-02 del mes del cobro, o sin periodo abierto para uno tardío (`revenue_rule`, `allocation_start`).
    when sqlstate 'P0001' then
      v_code := 'charge_rule_unavailable';
    -- Otra suscripción de la misma cuenta se volvió viva a la vez (`subscriptions_one_live_uq`).
    when unique_violation then
      v_code := 'second_live_subscription';
  end;
  update private.provider_events e set status = 'failed', last_error = v_code, locked_until = null where e.id = p_event;
  return pg_catalog.jsonb_build_object('outcome', 'failed', 'code', v_code);
end
$$;
revoke all on function private.billing_apply(uuid, integer, jsonb, jsonb, jsonb) from public;
grant execute on function private.billing_apply(uuid, integer, jsonb, jsonb, jsonb) to app_service;

-- Finanzas reabre un aviso fallido (RF-710): vuelve pendiente, con sus intentos desde cero. Lleva los intentos que vio: si cambiaron, `changed`.
create function private.provider_event_retry(p_id uuid, p_seen_attempts integer) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text := private.finance_change_gate();
  v private.provider_events;
begin
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  select * into v from private.provider_events e where e.id = p_id for update;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if v.status <> 'failed' then
    return pg_catalog.jsonb_build_object('outcome', 'not_failed', 'status', v.status);
  end if;
  if v.attempts is distinct from p_seen_attempts then
    return '{"outcome": "changed"}'::jsonb;
  end if;
  update private.provider_events e set status = 'pending', attempts = 0, next_attempt_at = pg_catalog.clock_timestamp(), locked_until = null
  where e.id = p_id;
  insert into private.provider_event_actions (event_id, action, actor) values (p_id, 'retry', private.actor_id());
  return '{"outcome": "retried"}'::jsonb;
end
$$;
revoke all on function private.provider_event_retry(uuid, integer) from public;
grant execute on function private.provider_event_retry(uuid, integer) to app_service;

-- Finanzas lo resuelve a mano (decisión 6 de Sergio): con una nota de 1 a 500 caracteres, queda terminado y deja de frenar. Solo uno fallido: lo que espera a otra
-- tarea (un reembolso, T-307) no se resuelve a mano.
create function private.provider_event_resolve(p_id uuid, p_note text, p_seen_attempts integer) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text := private.finance_change_gate();
  v_note text := pg_catalog.btrim(p_note);
  v private.provider_events;
begin
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if v_note is null or char_length(v_note) not between 1 and 500 then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select * into v from private.provider_events e where e.id = p_id for update;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if v.status <> 'failed' then
    return pg_catalog.jsonb_build_object('outcome', 'not_failed', 'status', v.status);
  end if;
  if v.attempts is distinct from p_seen_attempts then
    return '{"outcome": "changed"}'::jsonb;
  end if;
  update private.provider_events e set status = 'resolved', resolved_by = private.actor_id(), resolution_note = v_note,
         finished_at = pg_catalog.clock_timestamp(), locked_until = null
  where e.id = p_id;
  insert into private.provider_event_actions (event_id, action, actor, note) values (p_id, 'resolve', private.actor_id(), v_note);
  return '{"outcome": "resolved"}'::jsonb;
end
$$;
revoke all on function private.provider_event_resolve(uuid, text, integer) from public;
grant execute on function private.provider_event_resolve(uuid, text, integer) to app_service;

-- Lo que el barrido reporta, sin nombrar a nadie.
create function private.provider_events_health() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'pending', count(*) filter (where e.status in ('pending', 'processing')),
    'failed', count(*) filter (where e.status = 'failed'),
    'deferred', count(*) filter (where e.status = 'deferred'),
    'oldest_pending_at', min(e.received_at) filter (where e.status in ('pending', 'processing')))
  from private.provider_events e
$$;
revoke all on function private.provider_events_health() from public;
grant execute on function private.provider_events_health() to app_service;

-- ---------------------------------------------------------------------------------------
-- Los alumnos activos y la foto del mes (T-601), con los avisos.

-- Como en T-601, contando una suscripción desde su inicio en el proveedor: su fila nace cuando se procesa el aviso, que puede ser después del instante.
create or replace function private.active_students_at(p_at timestamptz) returns integer
language plpgsql stable set search_path = ''
as $$
declare
  v_count integer;
  v_unknown boolean;
begin
  if p_at is null or not pg_catalog.isfinite(p_at) then
    raise exception 'active students need an instant' using errcode = '22023';
  end if;
  with candidates as (
    select s.profile_id, s.current_period_end, s.ended_at,
           s.last_renewal_failed_at is not null and s.last_renewal_failed_at <= p_at as failed,
           case when s.last_renewal_failed_at <= p_at and pg_catalog.jsonb_typeof(g.days) = 'number' and (g.days)::text ~ '^[0-9]{1,5}$'
                then s.last_renewal_failed_at + pg_catalog.make_interval(hours => 24 * (g.days)::text::integer) end as grace_until
    from public.subscriptions s
    join public.profiles p on p.id = s.profile_id
    cross join lateral (select private.parameter_value('GRACIA_COBRO_DIAS', s.last_renewal_failed_at) as days) g
    where p.status = 'active' and not p.suspended_for_fraud
      and s.status <> 'pending' and coalesce(s.provider_started_at, s.created_at) <= p_at and s.current_period_end is not null)
  select pg_catalog.count(distinct c.profile_id) filter (
           where (p_at < c.current_period_end or p_at < c.grace_until) and (c.ended_at is null or p_at < c.ended_at)),
         coalesce(pg_catalog.bool_or(c.failed and c.grace_until is null), false)
  into v_count, v_unknown
  from candidates c;
  if v_unknown then
    raise exception 'GRACIA_COBRO_DIAS is not set at a renewal failure before %', p_at using errcode = 'P0001';
  end if;
  return v_count;
end
$$;

-- Como en T-601, y un periodo espera su foto mientras haya un aviso sin terminar (pendiente, en proceso, fallido o en espera) de antes de su fin: un pago de las
-- 23:58 que se procesa a las 00:01 sí cuenta. Sin la foto, el periodo no pasa a cierre.
create or replace function private.period_photos() returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_kind text := pg_catalog.current_setting('app.actor_kind', true);
  v_period record;
  v_students integer;
  v_bps integer;
  v_taken integer[] := '{}';
  v_failed jsonb := '{}'::jsonb;
begin
  perform pg_catalog.set_config('app.actor_kind', 'system', true);
  for v_period in
    select p.period_id, p.ends_at from public.payout_periods p
    where p.active_students is null and p.status in ('open', 'closing') and p.ends_at <= pg_catalog.now()
      and not exists (select 1 from private.provider_events e
                      where e.status in ('pending', 'processing', 'failed', 'deferred') and e.occurred_at < p.ends_at)
    order by p.period_id
  loop
    begin
      v_students := private.active_students_at(v_period.ends_at - interval '1 microsecond');
      v_bps := case when (select t.thresholds from private.pool_tiers_for(v_period.period_id) t) is not null
                    then private.effective_pool_bps(v_period.period_id, v_students) end;
      update public.payout_periods p set active_students = v_students, pool_bps = v_bps where p.period_id = v_period.period_id;
      v_taken := v_taken || v_period.period_id::integer;
    exception when others then
      v_failed := v_failed || pg_catalog.jsonb_build_object(v_period.period_id::text, sqlstate || ': ' || pg_catalog.left(sqlerrm, 200));
    end;
  end loop;
  perform pg_catalog.set_config('app.actor_kind', coalesce(v_kind, ''), true);
  return pg_catalog.jsonb_build_object('taken', pg_catalog.to_jsonb(v_taken))
    || case when v_failed = '{}'::jsonb then '{}'::jsonb else pg_catalog.jsonb_build_object('failed', v_failed) end;
end
$$;

-- ---------------------------------------------------------------------------------------
-- El vigilante de los avisos (carril A).

create function private.schema_violations_billing()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  tables (table_name) as (
    values ('private.provider_events'), ('private.provider_event_actions'), ('private.provider_settlements')),
  doors (name, signature) as (
    values ('provider_event_receive', 'private.provider_event_receive(text, text, text, boolean, text, text, timestamptz)'),
           ('provider_event_claim', 'private.provider_event_claim(uuid)'),
           ('provider_event_claim_due', 'private.provider_event_claim_due(integer)'),
           ('provider_event_release', 'private.provider_event_release(uuid, integer, text)'),
           ('provider_event_finish', 'private.provider_event_finish(uuid, integer, text, text)'),
           ('billing_apply', 'private.billing_apply(uuid, integer, jsonb, jsonb, jsonb)'),
           ('provider_event_retry', 'private.provider_event_retry(uuid, integer)'),
           ('provider_event_resolve', 'private.provider_event_resolve(uuid, text, integer)'),
           ('provider_events_health', 'private.provider_events_health()')),
  helpers (name, signature) as (
    values ('billing_state', 'private.billing_state(text, boolean)'), ('billing_plan', 'private.billing_plan(text, integer)'),
           ('billing_instant', 'private.billing_instant(text)'), ('billing_snapshot_ok', 'private.billing_snapshot_ok(jsonb)'),
           ('billing_payment_ok', 'private.billing_payment_ok(jsonb)'), ('billing_failure_ok', 'private.billing_failure_ok(jsonb)'),
           ('guard_provider_event', 'private.guard_provider_event()'))
  select 'billing table privilege for ' || r.rolname, t.table_name
  from app_roles r cross join tables t
  where pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'select, insert, update, delete, truncate, references, trigger')
     or pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'select, insert, update, references')
  union all
  select 'billing table without row security', t.table_name
  from tables t
  where not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = t.table_name::regclass)
  union all
  select 'billing door missing or wrong: ' || d.name, d.name
  from doors d
  where pg_catalog.to_regprocedure(d.signature) is null
     or not coalesce((select p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']
                      from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(d.signature)), false)
     or not pg_catalog.has_function_privilege('app_service', d.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', d.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', d.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', d.signature, 'execute')
  union all
  select 'billing helper reachable: ' || h.name, h.name
  from helpers h
  where pg_catalog.to_regprocedure(h.signature) is null
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(h.signature))
     or pg_catalog.has_function_privilege('app_service', h.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', h.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', h.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', h.signature, 'execute')
  union all
  select 'billing trigger missing: ' || t.name, t.table_name
  from (values ('provider_events_guard', 'private.provider_events', '%guard_provider_event%'),
               ('ledger_no_truncate', 'private.provider_events', '%reject_mutation%'),
               ('ledger_no_update_delete', 'private.provider_event_actions', '%reject_mutation%'),
               ('ledger_no_truncate', 'private.provider_event_actions', '%reject_mutation%'),
               ('audit_changes', 'private.provider_event_actions', '%audit_row_change%'),
               ('ledger_no_update_delete', 'private.provider_settlements', '%reject_mutation%'),
               ('ledger_no_truncate', 'private.provider_settlements', '%reject_mutation%')) t (name, table_name, pattern)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = t.table_name::regclass and tg.tgname = t.name
      and tg.tgenabled in ('O', 'A') and pg_catalog.pg_get_triggerdef(tg.oid) like t.pattern)
  union all
  select 'billing apply without its order', 'billing_apply'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.billing_apply(uuid, integer, jsonb, jsonb, jsonb)'))
                     like '%for update%pg_advisory_xact_lock%record_charge%update public.subscriptions%update private.provider_events%', false)
  union all
  select 'period photo without the billing wait', 'period_photos'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.period_photos()')) like '%private.provider_events%', false)
  union all
  select 'active students without the provider start', 'active_students_at'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.active_students_at(timestamptz)')) like '%provider_started_at%', false)
  union all
  select 'charge without its event key', 'public.charges'
  where not exists (select 1 from pg_catalog.pg_constraint c
                    where c.conrelid = 'public.charges'::regclass and c.conname = 'charges_event_fk' and c.contype = 'f'
                      and c.confrelid = 'private.provider_events'::regclass)
$$;
revoke all on function private.schema_violations_billing() from public;
