-- T-303, cuarta solicitud · La conciliación con Stripe y las dos respuestas nuevas del cierre (RF-208, RF-501; plan aprobado por Sergio el 2026-11-08, en
-- `~/.claude/plans/t303-s4-plan.md`, con la revisión independiente del diseño). Decisiones de Sergio: la conciliación y el libro de lo que liquida Stripe van aquí,
-- con comparación exacta, y el cierre se frena si no coincide o si hay avisos sin procesar (2026-11-06, decisión 4); lo que espera a T-307 frena (decisión 3); una
-- diferencia se explica con nota obligatoria y auditoría, una sola persona (decisión 6); y del 2026-11-08: lo fallido y lo que espera a T-307 frenan sin importar
-- su fecha (RN-10) y lo pendiente solo si es de antes del fin del mes, un cobro del libro que Stripe no tiene (o con otro monto) no se explica con nota, y la cuenta
-- de Stripe cobra solo para la Plataforma.
--
-- El servidor lista los cargos de Stripe de la ventana del periodo y los manda tal como los leyó; la base los clasifica, calcula lo propio, compara y guarda la
-- comparación con cada diferencia. «Coincide y está vigente» tiene una sola definición (`billing_reconciliation_current`), que usan el cierre, sus dos lecturas y
-- lo que pide el trabajo. Una comparación no se cambia: el reloj de la base le pone la hora, y lo explicado se suma con notas aparte, así que explicar no obliga a
-- volver a leer Stripe.
--
-- Decisiones mías sin confirmar: la base clasifica, no el servidor; lo propio es por `period_id`, sin mirar `livemode`; un cargo pendiente o sin capturar, o un
-- listado incompleto, no dejan coincidir; 10 minutos de margen después del fin del mes, como la foto; la huella es cuántos cobros de Stripe tiene el periodo
-- (`charges` solo crece); hasta 200 diferencias; a lo más una comparación pedida por una persona por minuto y por periodo; completar lo que liquidó Stripe no frena.

-- ---------------------------------------------------------------------------------------
-- Las comparaciones, sus diferencias y lo que las explica: tres libros, sin permisos para la aplicación.

create table private.billing_reconciliations (
  id uuid primary key default gen_random_uuid(),
  period_id public.period_id not null references public.payout_periods (period_id),
  provider text not null default 'stripe',
  livemode boolean not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  complete boolean not null,                        -- Stripe se listó hasta el final
  own_count integer not null,                       -- la huella de lo propio: los cobros de Stripe del periodo
  own_cents bigint not null,
  provider_count integer not null,                  -- lo exitoso, capturado y en pesos
  provider_cents bigint not null,
  provider_pending integer not null,                -- pendiente, o exitoso sin capturar
  provider_other_currency integer not null,
  differences integer not null,                     -- cuántas hubo; se guardan hasta 200
  too_many boolean not null,
  requested_by uuid references public.profiles (id),   -- nulo: el sistema
  registered_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint billing_reconciliations_provider_known check (provider in ('stripe')),
  constraint billing_reconciliations_window check (window_end > window_start),
  constraint billing_reconciliations_counts check (own_count >= 0 and own_cents >= 0 and provider_count >= 0 and provider_cents >= 0
                                                   and provider_pending >= 0 and provider_other_currency >= 0 and differences >= 0
                                                   and too_many = (differences > 200))
);
create index billing_reconciliations_period_idx on private.billing_reconciliations (period_id, registered_at desc, id desc);
alter table private.billing_reconciliations enable row level security;
revoke all on table private.billing_reconciliations from public, anon, authenticated, service_role, app_service;

-- La hora de una comparación es la del reloj al escribirla: nadie la pone en el pasado ni después del fin del mes sin que lo sea.
create function private.guard_billing_reconciliation() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.registered_at := pg_catalog.clock_timestamp();
  return new;
end
$$;
revoke all on function private.guard_billing_reconciliation() from public;
create trigger billing_reconciliations_guard before insert on private.billing_reconciliations
  for each row execute function private.guard_billing_reconciliation();
create trigger ledger_no_update_delete before update or delete on private.billing_reconciliations
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.billing_reconciliations
  for each statement execute function private.reject_mutation();

create table private.billing_reconciliation_differences (
  reconciliation_id uuid not null references private.billing_reconciliations (id),
  side text not null,
  provider_charge_id text not null,
  own_cents bigint,
  provider_cents bigint,
  currency text not null,
  constraint billing_reconciliation_differences_pk primary key (reconciliation_id, side, provider_charge_id),
  constraint billing_reconciliation_differences_side_known check (side in ('only_provider', 'only_own', 'amount', 'other_currency')),
  constraint billing_reconciliation_differences_id_format check (provider_charge_id ~ '^[!-~]{1,255}$'),
  constraint billing_reconciliation_differences_currency_format check (currency ~ '^[a-z]{3}$'),
  constraint billing_reconciliation_differences_amounts check (
    case side when 'only_own' then own_cents is not null and provider_cents is null
              when 'amount' then own_cents is not null and provider_cents is not null and own_cents <> provider_cents
              else own_cents is null and provider_cents is not null end)
);
alter table private.billing_reconciliation_differences enable row level security;
revoke all on table private.billing_reconciliation_differences from public, anon, authenticated, service_role, app_service;
create trigger ledger_no_update_delete before update or delete on private.billing_reconciliation_differences
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.billing_reconciliation_differences
  for each statement execute function private.reject_mutation();

-- Una nota explica una diferencia exacta: si el mismo cargo vuelve con otro monto, es otra. Solo lo que Stripe cobró y el libro no tiene (decisión de Sergio del
-- 2026-11-08).
create table private.billing_reconciliation_notes (
  id uuid primary key default gen_random_uuid(),
  period_id public.period_id not null references public.payout_periods (period_id),
  side text not null,
  provider_charge_id text not null,
  provider_cents bigint not null,
  currency text not null,
  note text not null,
  explained_by uuid not null references public.profiles (id),
  explained_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint billing_reconciliation_notes_side_known check (side in ('only_provider', 'other_currency')),
  constraint billing_reconciliation_notes_id_format check (provider_charge_id ~ '^[!-~]{1,255}$'),
  constraint billing_reconciliation_notes_currency_format check (currency ~ '^[a-z]{3}$'),
  constraint billing_reconciliation_notes_note check (char_length(note) between 1 and 500),
  constraint billing_reconciliation_notes_uq unique (period_id, side, provider_charge_id, provider_cents, currency)
);
alter table private.billing_reconciliation_notes enable row level security;
revoke all on table private.billing_reconciliation_notes from public, anon, authenticated, service_role, app_service;
create trigger ledger_no_update_delete before update or delete on private.billing_reconciliation_notes
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.billing_reconciliation_notes
  for each statement execute function private.reject_mutation();
-- Sin la nota: es texto libre, y configuración lee la auditoría.
create trigger audit_changes after insert on private.billing_reconciliation_notes
  for each row execute function private.audit_row_change('money', 'note');

-- ---------------------------------------------------------------------------------------
-- Las definiciones únicas.

-- ¿Coincide esta comparación? Completa, sin pendientes ni demasiadas diferencias, registrada después del fin del mes con su margen, con la huella de lo propio de
-- ahora, cada diferencia explicada, y el periodo sin cobros de un proveedor que no se compara.
create function private.billing_reconciliation_ok(p_id uuid) returns boolean
language sql stable set search_path = ''
as $$
  select coalesce((
    select r.complete and not r.too_many and r.provider_pending = 0
       and r.registered_at >= p.ends_at + interval '10 minutes'
       and r.own_count = (select pg_catalog.count(*) from public.charges c where c.provider = 'stripe' and c.period_id = r.period_id)
       and not exists (select 1 from public.charges c where c.period_id = r.period_id and c.provider not in ('stripe', 'manual'))
       and not exists (select 1 from private.billing_reconciliation_differences d
                       where d.reconciliation_id = r.id
                         and not exists (select 1 from private.billing_reconciliation_notes n
                                         where n.period_id = r.period_id and n.side = d.side and n.provider_charge_id = d.provider_charge_id
                                           and n.provider_cents = d.provider_cents and n.currency = d.currency))
    from private.billing_reconciliations r
    join public.payout_periods p on p.period_id = r.period_id
    where r.id = p_id), false)
$$;
revoke all on function private.billing_reconciliation_ok(uuid) from public;

-- La comparación vigente de un periodo: la última, si coincide. Una más nueva que ve otra cosa en Stripe deja al periodo sin conciliar hasta explicarla o volver a
-- comparar: es la que más sabe (decisión mía sin confirmar; la otra lectura, «alguna que coincidió», confiaría en un listado que el siguiente desmiente).
create function private.billing_reconciliation_current(p_period public.period_id) returns uuid
language sql stable set search_path = ''
as $$
  select l.id from (select r.id from private.billing_reconciliations r
                    where r.period_id = p_period
                    order by r.registered_at desc, r.id desc
                    limit 1) l
  where private.billing_reconciliation_ok(l.id)
$$;
revoke all on function private.billing_reconciliation_current(public.period_id) from public;

-- Los avisos de cobro que frenan el cierre de un periodo que termina en `p_ends` (decisiones de Sergio del 2026-11-06 y del 2026-11-08): lo fallido y lo que espera
-- a T-307 de cualquier fecha (RN-10: un reembolso antes del cierre saca ese cobro del bote), y lo pendiente de antes del fin con el margen de la foto.
create function private.billing_events_blocking(p_ends timestamptz) returns bigint
language sql stable set search_path = ''
as $$
  select pg_catalog.count(*) from private.provider_events e
  where e.status in ('failed', 'deferred')
     or (e.status in ('pending', 'processing') and e.occurred_at < p_ends + interval '10 minutes')
$$;
revoke all on function private.billing_events_blocking(timestamptz) from public;

-- Quién compara: un trabajo del sistema, o una persona con finanzas (sin código reciente: comparar no cambia dinero).
create function private.billing_reconciliation_allowed() returns boolean
language sql stable set search_path = ''
as $$
  select private.actor_is_system() or (private.actor_id() is not null and private.actor_has_capability('finance'))
$$;
revoke all on function private.billing_reconciliation_allowed() from public;

-- ---------------------------------------------------------------------------------------
-- Las puertas, todas del servidor.

-- La ventana que se lista: los extremos del periodo en segundos. Hasta 10 minutos después de su fin todavía no se compara.
create function private.billing_reconciliation_window(p_period public.period_id) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  p public.payout_periods;
begin
  if not private.billing_reconciliation_allowed() then
    return '{"outcome": "forbidden"}'::jsonb;
  end if;
  select * into p from public.payout_periods x where x.period_id = p_period;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if p.status in ('closed', 'paid') then
    return '{"outcome": "closed"}'::jsonb;
  end if;
  if pg_catalog.clock_timestamp() < p.ends_at + interval '10 minutes' then
    return pg_catalog.jsonb_build_object('outcome', 'too_early', 'from', p.ends_at + interval '10 minutes');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'window', 'starts_at', extract(epoch from p.starts_at)::bigint,
                                       'ends_at', extract(epoch from p.ends_at)::bigint);
end
$$;
revoke all on function private.billing_reconciliation_window(public.period_id) from public;
grant execute on function private.billing_reconciliation_window(public.period_id) to app_service;

-- Registra una comparación con los cargos que el servidor leyó de Stripe en la ventana, tal como los leyó. Lo propio lo calcula después de tomar el periodo para
-- compartir: un cierre en vuelo termina antes, y un cobro en vuelo (que toma la fila igual) ya se ve al contar.
create function private.billing_reconciliation_record(p_period public.period_id, p_livemode boolean, p_starts bigint, p_ends bigint, p_complete boolean,
                                                      p_charges jsonb) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_system boolean := private.actor_is_system();
  p public.payout_periods;
  v_id uuid;
  v_own_count integer;
  v_own_cents bigint;
  v_count integer;
  v_cents bigint;
  v_pending integer;
  v_other integer;
  v_diffs jsonb;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'reconciliations run in read committed' using errcode = '25000';
  end if;
  if not private.billing_reconciliation_allowed() then
    return '{"outcome": "forbidden"}'::jsonb;
  end if;
  if p_period is null or p_livemode is null or p_complete is null or p_starts is null or p_ends is null
     or p_charges is null or pg_catalog.jsonb_typeof(p_charges) <> 'array' then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select * into p from public.payout_periods x where x.period_id = p_period for share;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if p.status in ('closed', 'paid') then
    return '{"outcome": "closed"}'::jsonb;
  end if;
  if pg_catalog.clock_timestamp() < p.ends_at + interval '10 minutes' then
    return pg_catalog.jsonb_build_object('outcome', 'too_early', 'from', p.ends_at + interval '10 minutes');
  end if;
  if p_starts <> extract(epoch from p.starts_at)::bigint or p_ends <> extract(epoch from p.ends_at)::bigint then
    return '{"outcome": "malformed", "reason": "window"}'::jsonb;
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_charges) c
             where not coalesce(pg_catalog.jsonb_typeof(c) = 'object'
                                and c ->> 'id' ~ '^[a-z]{2,4}_[A-Za-z0-9_]{1,250}$'
                                and c ->> 'status' in ('succeeded', 'pending', 'failed')
                                and pg_catalog.jsonb_typeof(c -> 'captured') = 'boolean'
                                and c ->> 'currency' ~ '^[a-z]{3}$'
                                and pg_catalog.jsonb_typeof(c -> 'livemode') = 'boolean' and (c ->> 'livemode')::boolean = p_livemode
                                and pg_catalog.jsonb_typeof(c -> 'created') = 'number' and c ->> 'created' ~ '^[0-9]{1,12}$'
                                and (c ->> 'created')::bigint >= p_starts and (c ->> 'created')::bigint < p_ends
                                and pg_catalog.jsonb_typeof(c -> 'amount_captured') = 'number' and c ->> 'amount_captured' ~ '^[0-9]{1,12}$', false)) then
    return '{"outcome": "malformed", "reason": "charge"}'::jsonb;
  end if;
  if (select pg_catalog.count(*) <> pg_catalog.count(distinct c ->> 'id') from pg_catalog.jsonb_array_elements(p_charges) c) then
    return '{"outcome": "malformed", "reason": "repeated"}'::jsonb;
  end if;
  -- A lo más una pedida por una persona por minuto en cada periodo (como el ensayo). El sistema no tiene tope.
  if not v_system and exists (select 1 from private.billing_reconciliations r
                              where r.period_id = p_period and r.requested_by is not null
                                and r.registered_at > pg_catalog.clock_timestamp() - interval '1 minute') then
    return '{"outcome": "rate_limited"}'::jsonb;
  end if;

  with s as (
    select c ->> 'id' as id, c ->> 'status' as status, (c ->> 'captured')::boolean as captured, c ->> 'currency' as currency,
           (c ->> 'amount_captured')::bigint as cents
    from pg_catalog.jsonb_array_elements(p_charges) c),
  theirs as (select s.id, s.cents from s where s.status = 'succeeded' and s.captured and s.currency = 'mxn'),
  mine as (select c.provider_charge_id as id, c.gross_cents as cents from public.charges c where c.provider = 'stripe' and c.period_id = p_period),
  diffs as (
    select 'only_provider' as side, t.id, null::bigint as own_cents, t.cents as provider_cents, 'mxn' as currency
    from theirs t where not exists (select 1 from mine m where m.id = t.id)
    union all
    select 'only_own', m.id, m.cents, null::bigint, 'mxn' from mine m where not exists (select 1 from theirs t where t.id = m.id)
    union all
    select 'amount', m.id, m.cents, t.cents, 'mxn' from mine m join theirs t on t.id = m.id where m.cents <> t.cents
    union all
    select 'other_currency', s.id, null::bigint, s.cents, s.currency from s where s.status = 'succeeded' and s.captured and s.currency <> 'mxn')
  select (select pg_catalog.count(*) from mine), (select coalesce(pg_catalog.sum(m.cents), 0) from mine m),
         (select pg_catalog.count(*) from theirs), (select coalesce(pg_catalog.sum(t.cents), 0) from theirs t),
         (select pg_catalog.count(*) from s where s.status = 'pending' or (s.status = 'succeeded' and not s.captured)),
         (select pg_catalog.count(*) from s where s.status = 'succeeded' and s.captured and s.currency <> 'mxn'),
         coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) order by d.side, d.id) from diffs d), '[]'::jsonb)
    into v_own_count, v_own_cents, v_count, v_cents, v_pending, v_other, v_diffs;

  insert into private.billing_reconciliations (period_id, livemode, window_start, window_end, complete, own_count, own_cents, provider_count,
                                               provider_cents, provider_pending, provider_other_currency, differences, too_many, requested_by)
  values (p_period, p_livemode, p.starts_at, p.ends_at, p_complete, v_own_count, v_own_cents, v_count, v_cents, v_pending, v_other,
          pg_catalog.jsonb_array_length(v_diffs), pg_catalog.jsonb_array_length(v_diffs) > 200,
          case when v_system then null else private.actor_id() end)
  returning id into v_id;
  insert into private.billing_reconciliation_differences (reconciliation_id, side, provider_charge_id, own_cents, provider_cents, currency)
  select v_id, x.e ->> 'side', x.e ->> 'id', (x.e ->> 'own_cents')::bigint, (x.e ->> 'provider_cents')::bigint, x.e ->> 'currency'
  from pg_catalog.jsonb_array_elements(v_diffs) with ordinality as x (e, n)
  where x.n <= 200;

  return pg_catalog.jsonb_build_object('outcome', 'recorded', 'reconciliation_id', v_id, 'matches', private.billing_reconciliation_ok(v_id),
                                       'own_count', v_own_count, 'provider_count', v_count, 'pending', v_pending,
                                       'differences', pg_catalog.jsonb_array_length(v_diffs));
end
$$;
revoke all on function private.billing_reconciliation_record(public.period_id, boolean, bigint, bigint, boolean, jsonb) from public;
grant execute on function private.billing_reconciliation_record(public.period_id, boolean, bigint, bigint, boolean, jsonb) to app_service;

-- Lo que pide el trabajo de cada día: todo periodo terminado (con su margen) que no está cerrado y no tiene una comparación vigente. Así se compara también antes
-- de `DIA_CIERRE`, cuando finanzas revisa el mes (OP-01, fase A).
create function private.billing_reconciliation_due() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.billing_reconciliation_allowed() then
    return null;
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(x.period_id order by x.period_id)
    from (select p.period_id from public.payout_periods p
          where p.status in ('open', 'closing') and p.ends_at + interval '10 minutes' <= pg_catalog.clock_timestamp()
            and private.billing_reconciliation_current(p.period_id) is null
          order by p.period_id
          limit 12) x), '[]'::jsonb);
end
$$;
revoke all on function private.billing_reconciliation_due() from public;
grant execute on function private.billing_reconciliation_due() to app_service;

-- Finanzas explica lo que Stripe cobró y el libro no tiene, con nota (decisión 6 de Sergio). Solo una diferencia exacta de la última comparación del periodo. Lo que
-- el libro tiene y Stripe no, o con otro monto, no se explica: frena hasta corregirse (decisión de Sergio del 2026-11-08).
create function private.billing_reconciliation_explain(p_period public.period_id, p_side text, p_charge text, p_own_cents bigint, p_provider_cents bigint,
                                                       p_currency text, p_note text) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text := private.finance_change_gate();
  v_note text := pg_catalog.btrim(p_note);
  p public.payout_periods;
  v_last uuid;
  v_id uuid;
begin
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_side in ('only_own', 'amount') then
    return '{"outcome": "not_explainable"}'::jsonb;
  end if;
  if p_period is null or p_side is null or p_side not in ('only_provider', 'other_currency') or p_charge is null or p_charge !~ '^[!-~]{1,255}$'
     or p_own_cents is not null or p_provider_cents is null or p_currency is null or p_currency !~ '^[a-z]{3}$'
     or v_note is null or char_length(v_note) not between 1 and 500 then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select * into p from public.payout_periods x where x.period_id = p_period for share;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if p.status in ('closed', 'paid') then
    return '{"outcome": "closed"}'::jsonb;
  end if;
  select r.id into v_last from private.billing_reconciliations r where r.period_id = p_period order by r.registered_at desc, r.id desc limit 1;
  if not exists (select 1 from private.billing_reconciliation_differences d
                 where d.reconciliation_id = v_last and d.side = p_side and d.provider_charge_id = p_charge
                   and d.provider_cents = p_provider_cents and d.currency = p_currency) then
    return '{"outcome": "not_in_comparison"}'::jsonb;
  end if;
  insert into private.billing_reconciliation_notes (period_id, side, provider_charge_id, provider_cents, currency, note, explained_by)
  values (p_period, p_side, p_charge, p_provider_cents, p_currency, v_note, private.actor_id())
  on conflict on constraint billing_reconciliation_notes_uq do nothing
  returning id into v_id;
  if v_id is null then
    return '{"outcome": "exists"}'::jsonb;
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'explained', 'current', private.billing_reconciliation_current(p_period) is not null);
end
$$;
revoke all on function private.billing_reconciliation_explain(public.period_id, text, text, bigint, bigint, text, text) from public;
grant execute on function private.billing_reconciliation_explain(public.period_id, text, text, bigint, bigint, text, text) to app_service;

-- ---------------------------------------------------------------------------------------
-- Lo que liquidó Stripe (decisión 4 de Sergio): los cobros que llegaron sin su transacción de saldo se completan aquí. Desde la 125, `charge.updated` no se aplica.

create function private.billing_settlements_missing(p_period public.period_id) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.billing_reconciliation_allowed() then
    return null;
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(x.provider_charge_id order by x.provider_charge_id)
    from (select c.provider_charge_id from public.charges c
          where c.provider = 'stripe' and c.period_id = p_period
            and not exists (select 1 from private.provider_settlements s where s.charge_id = c.id)
          order by c.provider_charge_id
          limit 100) x), '[]'::jsonb);
end
$$;
revoke all on function private.billing_settlements_missing(public.period_id) from public;
grant execute on function private.billing_settlements_missing(public.period_id) to app_service;

-- Con las mismas reglas de `billing_apply`: uno por cobro, el bruto del cobro, y el neto es el bruto menos la comisión. Nunca toca el cobro.
create function private.billing_settlement_complete(p_charge text, p_transaction text, p_gross bigint, p_fee bigint, p_net bigint, p_available_on timestamptz)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v public.charges;
  v_id uuid;
begin
  if not private.billing_reconciliation_allowed() then
    return '{"outcome": "forbidden"}'::jsonb;
  end if;
  if p_charge is null or p_transaction is null or p_transaction !~ '^[!-~]{1,255}$' or p_gross is null or p_gross <= 0
     or p_fee is null or p_fee < 0 or p_net is null or p_gross - p_fee <> p_net then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select * into v from public.charges c where c.provider = 'stripe' and c.provider_charge_id = p_charge;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if v.gross_cents <> p_gross then
    return '{"outcome": "mismatch"}'::jsonb;
  end if;
  insert into private.provider_settlements (charge_id, provider, balance_transaction_id, gross_cents, fee_cents, net_cents, available_on, read_at)
  values (v.id, 'stripe', p_transaction, p_gross, p_fee, p_net, p_available_on, pg_catalog.clock_timestamp())
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    return '{"outcome": "exists"}'::jsonb;
  end if;
  return '{"outcome": "recorded"}'::jsonb;
end
$$;
revoke all on function private.billing_settlement_complete(text, text, bigint, bigint, bigint, timestamptz) from public;
grant execute on function private.billing_settlement_complete(text, text, bigint, bigint, bigint, timestamptz) to app_service;

-- ---------------------------------------------------------------------------------------
-- El cierre gana sus dos respuestas, y sus dos lecturas las mismas definiciones. Lo demás de las tres funciones no cambia.

create or replace function private.close_period(p_period public.period_id, p_run uuid) returns jsonb
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
  -- Los avisos de cobro sin terminar (T-303; decisiones de Sergio del 2026-11-06 y del 2026-11-08), con la misma definición que PA-80.
  if private.billing_events_blocking(v_period.ends_at) > 0 then
    return '{"outcome": "billing_events_pending"}'::jsonb;
  end if;
  -- Y una comparación con Stripe que coincide y sigue vigente (T-303, cuarta solicitud). Vale también para un mes sin cobros propios.
  if private.billing_reconciliation_current(p_period) is null then
    return '{"outcome": "charges_match_provider"}'::jsonb;
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
      'rollup_marks', exists (select 1 from private.rollup_dirty d where d.period_id = p_period),
      'billing_events', private.billing_events_blocking(p.ends_at),
      'charges_match', private.billing_reconciliation_current(p_period) is not null),
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
                       order by q.requested_at desc limit 1),
    -- La última comparación con Stripe (T-303, cuarta solicitud), con sus diferencias y lo que las explica, y si hay una vigente.
    'reconciliation', (select pg_catalog.jsonb_build_object(
                         'id', r.id, 'registered_at', r.registered_at, 'livemode', r.livemode, 'complete', r.complete, 'too_many', r.too_many,
                         'own_count', r.own_count, 'own_cents', r.own_cents, 'provider_count', r.provider_count,
                         'provider_cents', r.provider_cents, 'provider_pending', r.provider_pending,
                         'provider_other_currency', r.provider_other_currency, 'differences_total', r.differences,
                         'requested', r.requested_by is not null, 'matches', private.billing_reconciliation_ok(r.id),
                         'current', private.billing_reconciliation_current(p_period) is not null,
                         'differences', coalesce((
                           select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                    'side', d.side, 'charge', d.provider_charge_id, 'own_cents', d.own_cents,
                                    'provider_cents', d.provider_cents, 'currency', d.currency, 'explained', n.id is not null,
                                    'note', n.note, 'explained_at', n.explained_at)
                                  order by d.side, d.provider_charge_id)
                           from private.billing_reconciliation_differences d
                           left join private.billing_reconciliation_notes n
                             on n.period_id = r.period_id and n.side = d.side and n.provider_charge_id = d.provider_charge_id
                            and n.provider_cents = d.provider_cents and n.currency = d.currency
                           where d.reconciliation_id = r.id), '[]'::jsonb))
                       from private.billing_reconciliations r where r.period_id = p_period
                       order by r.registered_at desc, r.id desc limit 1));
end
$$;

-- ---------------------------------------------------------------------------------------
-- Los dos vigilantes: el de los avisos con las tablas y las puertas nuevas, y el del cierre con sus dos comprobaciones del cobro.

create or replace function private.schema_violations_billing()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  tables (table_name) as (
    values ('private.provider_events'), ('private.provider_event_actions'), ('private.provider_settlements'),
           ('private.billing_reconciliations'), ('private.billing_reconciliation_differences'), ('private.billing_reconciliation_notes')),
  doors (name, signature) as (
    values ('provider_event_receive', 'private.provider_event_receive(text, text, text, boolean, text, text, timestamptz)'),
           ('provider_event_claim', 'private.provider_event_claim(uuid)'),
           ('provider_event_claim_due', 'private.provider_event_claim_due(integer)'),
           ('provider_event_release', 'private.provider_event_release(uuid, integer, text)'),
           ('provider_event_finish', 'private.provider_event_finish(uuid, integer, text, text)'),
           ('billing_apply', 'private.billing_apply(uuid, integer, jsonb, jsonb, jsonb)'),
           ('provider_event_retry', 'private.provider_event_retry(uuid, integer)'),
           ('provider_event_resolve', 'private.provider_event_resolve(uuid, text, integer)'),
           ('provider_events_health', 'private.provider_events_health()'),
           ('provider_events_list', 'private.provider_events_list()'),
           ('provider_events_count', 'private.provider_events_count()'),
           ('billing_reconciliation_window', 'private.billing_reconciliation_window(public.period_id)'),
           ('billing_reconciliation_record', 'private.billing_reconciliation_record(public.period_id, boolean, bigint, bigint, boolean, jsonb)'),
           ('billing_reconciliation_due', 'private.billing_reconciliation_due()'),
           ('billing_reconciliation_explain', 'private.billing_reconciliation_explain(public.period_id, text, text, bigint, bigint, text, text)'),
           ('billing_settlements_missing', 'private.billing_settlements_missing(public.period_id)'),
           ('billing_settlement_complete', 'private.billing_settlement_complete(text, text, bigint, bigint, bigint, timestamptz)')),
  helpers (name, signature) as (
    values ('billing_state', 'private.billing_state(text, boolean)'), ('billing_plan', 'private.billing_plan(text, integer)'),
           ('billing_instant', 'private.billing_instant(text)'), ('billing_snapshot_ok', 'private.billing_snapshot_ok(jsonb)'),
           ('billing_payment_ok', 'private.billing_payment_ok(jsonb)'), ('billing_failure_ok', 'private.billing_failure_ok(jsonb)'),
           ('guard_provider_event', 'private.guard_provider_event()'), ('billing_event_kind', 'private.billing_event_kind(text)'),
           ('provider_event_owner', 'private.provider_event_owner(text)'), ('queue_billing_alert', 'private.queue_billing_alert()'),
           ('guard_billing_reconciliation', 'private.guard_billing_reconciliation()'),
           ('billing_reconciliation_ok', 'private.billing_reconciliation_ok(uuid)'),
           ('billing_reconciliation_current', 'private.billing_reconciliation_current(public.period_id)'),
           ('billing_events_blocking', 'private.billing_events_blocking(timestamptz)'),
           ('billing_reconciliation_allowed', 'private.billing_reconciliation_allowed()'))
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
               ('provider_events_no_truncate', 'private.provider_events', '%reject_mutation%'),
               ('provider_events_alert', 'private.provider_events',
                '%AFTER UPDATE OF status%WHEN%old.status IS DISTINCT FROM ''failed''%new.status = ''failed''%queue_billing_alert%'),
               ('ledger_no_update_delete', 'private.provider_event_actions', '%reject_mutation%'),
               ('ledger_no_truncate', 'private.provider_event_actions', '%reject_mutation%'),
               ('audit_changes', 'private.provider_event_actions', '%audit_row_change%'),
               ('ledger_no_update_delete', 'private.provider_settlements', '%reject_mutation%'),
               ('ledger_no_truncate', 'private.provider_settlements', '%reject_mutation%'),
               ('billing_reconciliations_guard', 'private.billing_reconciliations', '%BEFORE INSERT%guard_billing_reconciliation%'),
               ('ledger_no_update_delete', 'private.billing_reconciliations', '%reject_mutation%'),
               ('ledger_no_truncate', 'private.billing_reconciliations', '%reject_mutation%'),
               ('ledger_no_update_delete', 'private.billing_reconciliation_differences', '%reject_mutation%'),
               ('ledger_no_truncate', 'private.billing_reconciliation_differences', '%reject_mutation%'),
               ('ledger_no_update_delete', 'private.billing_reconciliation_notes', '%reject_mutation%'),
               ('ledger_no_truncate', 'private.billing_reconciliation_notes', '%reject_mutation%'),
               ('audit_changes', 'private.billing_reconciliation_notes', '%audit_row_change%')) t (name, table_name, pattern)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = t.table_name::regclass and tg.tgname = t.name
      and tg.tgenabled in ('O', 'A') and pg_catalog.pg_get_triggerdef(tg.oid) like t.pattern)
  union all
  select 'billing apply without its order', 'billing_apply'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.billing_apply(uuid, integer, jsonb, jsonb, jsonb)'))
                     like '%from private.provider_events e where e.id = p_event for update%pg_advisory_xact_lock%:= private.record_charge(%update public.subscriptions s set%set status = ''processed''%', false)
  union all
  select 'period photo without the billing wait', 'period_photos'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.period_photos()'))
                     like '%not exists (select 1 from private.provider_events e%e.status in (''pending'', ''processing'') and e.occurred_at < p.ends_at + interval%', false)
  union all
  select 'active students without the provider start', 'active_students_at'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.active_students_at(timestamptz)'))
                     like '%and coalesce(s.provider_started_at, s.created_at) <= p_at%', false)
  union all
  select 'mail claim without the clabe first', 'mail_claim'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.mail_claim(integer)')) like '%order by m.template <> ''CO-27'', m.created_at%', false)
  union all
  select 'finance door without the self check: ' || f.name, f.name
  from (values ('provider_event_retry', 'private.provider_event_retry(uuid, integer)'),
               ('provider_event_resolve', 'private.provider_event_resolve(uuid, text, integer)'),
               ('provider_events_list', 'private.provider_events_list()')) f (name, signature)
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(f.signature))
                     like '%v.profile_id = private.actor_id() or private.provider_event_owner(v.object_id) = private.actor_id()%', false)
  union all
  select 'billing release without its exhaustion', 'provider_event_release'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.provider_event_release(uuid, integer, text)'))
                     like '%status = case when e.attempts >= 10 then ''failed''%last_error = case when e.attempts >= 10 then ''attempts_exhausted''%', false)
  union all
  select 'billing claim without its exhaustion', 'provider_event_claim'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.provider_event_claim(uuid)'))
                     like '%if v.attempts >= 10 then%set status = ''failed'', last_error = ''attempts_exhausted''%''exhausted'', true%', false)
  union all
  select 'finance read without the finance gate: ' || f.name, f.name
  from (values ('provider_events_list', 'private.provider_events_list()'),
               ('provider_events_count', 'private.provider_events_count()')) f (name, signature)
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(f.signature))
                     like '%if private.actor_id() is null or not private.actor_has_capability(''finance'') then%return null;%', false)
  union all
  select 'mail claim without its index', 'private.mail_outbox'
  where pg_catalog.to_regclass('private.mail_outbox_due_order_idx') is null
  union all
  select 'finance door without the reconciliation gate: ' || f.name, f.name
  from (values ('billing_reconciliation_window', 'private.billing_reconciliation_window(public.period_id)'),
               ('billing_reconciliation_record', 'private.billing_reconciliation_record(public.period_id, boolean, bigint, bigint, boolean, jsonb)'),
               ('billing_reconciliation_due', 'private.billing_reconciliation_due()'),
               ('billing_settlements_missing', 'private.billing_settlements_missing(public.period_id)'),
               ('billing_settlement_complete', 'private.billing_settlement_complete(text, text, bigint, bigint, bigint, timestamptz)')) f (name, signature)
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(f.signature)) like '%if not private.billing_reconciliation_allowed() then%', false)
  union all
  select 'reconciliation explain without its gate', 'billing_reconciliation_explain'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.billing_reconciliation_explain(public.period_id, text, text, bigint, bigint, text, text)'))
                     like '%v_gate text := private.finance_change_gate();%if p_side in (''only_own'', ''amount'') then%not_explainable%', false)
  union all
  select 'charge without its event key', 'public.charges'
  where not exists (select 1 from pg_catalog.pg_constraint c
                    where c.conrelid = 'public.charges'::regclass and c.conname = 'charges_event_fk' and c.contype = 'f'
                      and c.confrelid = 'private.provider_events'::regclass)
$$;
revoke all on function private.schema_violations_billing() from public;

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
  -- Las dos comprobaciones del cobro (T-303), después de las alertas y antes del ensayo, con las definiciones únicas.
  select 'close without the billing checks', 'private.close_period'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.close_period(public.period_id, uuid)'))
                     like '%"open_alerts"%private.billing_events_blocking(v_period.ends_at) > 0%"billing_events_pending"%private.billing_reconciliation_current(p_period) is null%"charges_match_provider"%"rehearsal_missing"%', false)
  union all
  -- Sin su trabajo, los pedidos se quedarían pendientes y el índice único negaría los nuevos.
  select 'close job missing or inactive: rollup_requests', 'cron.job'
  where not exists (select 1 from cron.job j where j.jobname = 'rollup_requests' and j.active
                    and j.schedule = '* * * * *' and j.command = 'call private.run_rollup_requests()')
$$;
