-- T-301 · El libro propio de ingresos y la asignación del ingreso por periodo (RF-211, RN-02;
-- 05 §5.3, §7.1 y §8.7). Decisiones de Sergio del 2026-10-22:
--   · la regla vive en la base: `private.record_charge()` registra el cobro y escribe sus partes en
--     la misma transacción; no hay `allocateRevenue` en TypeScript, y el reparto (T-407) lee las
--     partes ya escritas;
--   · alcance: los cobros y sus partes; los reembolsos y contracargos (`charge_reversals`, las
--     partes negativas y su regla) llegan con T-307, y la bandeja de avisos con T-303;
--   · solo pesos, hasta que el contador diga qué tipo de cambio aplica (LF-07);
--   · nadie de la aplicación escribe: la función existe y se prueba, y T-303 la abre al aviso del
--     proveedor.
--
-- RN-02, en enteros: `sin_iva = round(bruto × 10 000 / (10 000 + IVA_PCT))`, mitad hacia arriba
-- («como en la factura»); `neto = floor(sin_iva × (10 000 − COMISION_COBRO_PCT) / 10 000)`; un
-- cobro mensual es una parte con el neto entero en su periodo; uno anual, doce partes en doce
-- periodos seguidos desde el suyo, las once primeras `floor(neto / 12)` y la última con la
-- diferencia. La regla se lee por periodo (los parámetros que afectan al reparto entran al
-- empezar uno, RF-707) y se guarda en el cobro: recalcular después no sería estable, porque una
-- versión de parámetro se puede cancelar.
--
-- Lo que cambia respecto del esquema escrito (05 §5.3):
--   · `charges` guarda además la tasa de IVA (`iva_bps`), la comisión fija (`fee_bps`) y el
--     ingreso neto del cobro (`revenue_net_mxn_cents`), y la regla está atada en la tabla: en un
--     libro que no se corrige vale más que la red dentro de la función, y una columna obligatoria
--     no se puede agregar después (el relleno sería un `update`);
--   · solo pesos (`charges_mxn_only`), y `provider_event_id` nulo hasta que T-303 cree la bandeja
--     y su clave foránea;
--   · claves compuestas: la suscripción es de la misma cuenta que el cobro, y la parte también;
--   · `revenue_allocations` sin `reversal_id`, y `revenue_allocations_sign` solo admite partes de
--     cobro (T-307 agrega la columna y reemplaza la restricción); el tipo `allocation_kind` ya
--     trae los dos valores;
--   · nadie de la aplicación lee ni escribe (el 05 le daba al servidor insertar y a finanzas y al
--     alumno leer por políticas): la lectura del alumno llega con T-306 y la de finanzas con T-605;
--   · `period_id` sin clave foránea a `payout_periods`, ni el congelado al cerrar
--     (`charges_frozen`, `revenue_allocations_frozen`): llegan con T-601.

-- ---------------------------------------------------------------------------------------
-- Las tablas.

create type public.allocation_kind as enum ('charge', 'reversal');

-- La clave compuesta del cobro hacia su suscripción.
alter table public.subscriptions add constraint subscriptions_id_profile_uq unique (id, profile_id);

create table public.charges (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id),
  subscription_id uuid not null,
  provider text not null,
  provider_charge_id text not null,
  provider_invoice_id text,
  provider_event_id uuid,                     -- el aviso que lo originó; nulo hasta T-303
  plan public.subscription_plan not null,
  charged_at timestamptz not null,
  period_id public.period_id not null,        -- el periodo en que se cobró, en ZONA_HORARIA_PERIODO
  currency text not null,
  gross_cents bigint not null,                -- lo que pagó el alumno, en su moneda
  tax_cents bigint not null,                  -- el IVA incluido en el bruto
  provider_fee_cents bigint,                  -- comisión real; no se usa en el reparto (PQ-15)
  provider_net_cents bigint,                  -- lo que liquida el proveedor
  fx_rate_to_mxn numeric(18, 8) not null,
  fx_source text not null,
  gross_mxn_cents bigint not null,
  net_of_tax_mxn_cents bigint not null,       -- el "cobro sin IVA" de RN-02, en pesos
  iva_bps public.bps not null,                -- IVA_PCT de su periodo
  fee_bps public.bps not null,                -- COMISION_COBRO_PCT de su periodo
  revenue_net_mxn_cents bigint not null,      -- el ingreso neto del cobro (RN-02): lo que suman sus partes
  payment_method text,
  country_code text,
  receipt_url text,
  created_at timestamptz not null default now(),
  constraint charges_provider_uq unique (provider, provider_charge_id),
  constraint charges_id_profile_uq unique (id, profile_id),
  constraint charges_subscription_fk foreign key (subscription_id, profile_id)
    references public.subscriptions (id, profile_id),
  constraint charges_provider_known check (provider in ('stripe', 'mercadopago', 'manual')),
  constraint charges_provider_ids_length check (
    length(provider_charge_id) between 1 and 255
    and (provider_invoice_id is null or length(provider_invoice_id) between 1 and 255)),
  constraint charges_event_later check (provider_event_id is null),
  constraint charges_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint charges_mxn_only check (currency = 'MXN'),
  constraint charges_amounts_positive check (
    gross_cents > 0 and tax_cents >= 0 and tax_cents <= gross_cents
    and gross_mxn_cents > 0 and net_of_tax_mxn_cents >= 0 and net_of_tax_mxn_cents <= gross_mxn_cents),
  -- Un tope de cordura, no una cifra de negocio: diez millones de pesos en un cobro es un error.
  constraint charges_gross_sane check (gross_cents <= 1000000000),
  constraint charges_fee_positive check (provider_fee_cents >= 0),
  constraint charges_provider_net_positive check (provider_net_cents >= 0),
  constraint charges_fx_positive check (fx_rate_to_mxn > 0),
  constraint charges_fx_source_known check (fx_source in ('same_currency', 'provider', 'parameter')),
  constraint charges_mxn_is_identity check (
    currency <> 'MXN' or (fx_rate_to_mxn = 1 and gross_mxn_cents = gross_cents and fx_source = 'same_currency')),
  -- RN-02 en la tabla: el sin IVA, redondeado mitad hacia arriba; el impuesto es la diferencia
  -- (solo pesos); el ingreso neto, hacia abajo.
  constraint charges_net_of_tax_rule check (
    net_of_tax_mxn_cents = (2 * gross_mxn_cents * 10000 + (10000 + iva_bps)) / (2 * (10000 + iva_bps))),
  constraint charges_tax_rule check (tax_cents = gross_cents - net_of_tax_mxn_cents),
  constraint charges_revenue_net_rule check (
    revenue_net_mxn_cents = net_of_tax_mxn_cents * (10000 - fee_bps) / 10000),
  constraint charges_payment_method_known
    check (payment_method in ('card', 'oxxo', 'bank_transfer', 'other')),
  constraint charges_country_format check (country_code ~ '^[A-Z]{2}$'),
  constraint charges_receipt_https check (receipt_url ~ '^https://' and length(receipt_url) <= 2048)
);
comment on table public.charges is 'El libro propio de ingresos (RF-211): un cobro por renglón, con la regla de RN-02 aplicada. No se edita ni se borra.';
-- Historial de cobros del alumno (RF-209) y de soporte (RF-703).
create index charges_profile_idx on public.charges (profile_id, charged_at desc);
-- Ingresos del periodo y conciliación con el proveedor (RF-705, precondición 4 del cierre).
create index charges_period_idx on public.charges (period_id, provider);
create index charges_subscription_idx on public.charges (subscription_id, profile_id);

create table public.revenue_allocations (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid not null,
  profile_id uuid not null,
  period_id public.period_id not null,        -- sin clave foránea: puede ser un periodo futuro
  kind public.allocation_kind not null,
  part_no smallint not null,
  parts_total smallint not null,
  base_cents bigint not null,                 -- ingreso neto del periodo: después de comisión, antes del bote
  fee_bps public.bps not null,                -- la comisión de su cobro
  rule text not null,                         -- con qué regla se asignó (PQ-12)
  created_at timestamptz not null default now(),
  constraint revenue_allocations_charge_fk foreign key (charge_id, profile_id)
    references public.charges (id, profile_id),
  constraint revenue_allocations_parts check (part_no >= 1 and part_no <= parts_total),
  constraint revenue_allocations_rule_known check (rule in ('charge_date_v1', 'service_days_v1')),
  -- Hasta T-307, solo partes de un cobro.
  constraint revenue_allocations_sign check (kind = 'charge' and base_cents >= 0)
);
comment on table public.revenue_allocations is 'Las partes del ingreso neto de cada cobro, por periodo (RN-02). No se editan ni se borran.';
-- Un cobro no se asigna dos veces.
create unique index revenue_allocations_charge_part_uq
  on public.revenue_allocations (charge_id, part_no) where kind = 'charge';
-- Entrada del cierre: base de cada alumno en el periodo (05 §8.4).
create index revenue_allocations_period_idx on public.revenue_allocations (period_id, profile_id);

-- Dos libros: ni el dueño edita, borra o vacía (05 §7.1).
create trigger ledger_no_update_delete before update or delete on public.charges
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on public.charges
  for each statement execute function private.reject_mutation();
create trigger ledger_no_update_delete before update or delete on public.revenue_allocations
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on public.revenue_allocations
  for each statement execute function private.reject_mutation();

alter table public.charges enable row level security;
alter table public.revenue_allocations enable row level security;
revoke all on public.charges from public, anon, authenticated, service_role, app_service;
revoke all on public.revenue_allocations from public, anon, authenticated, service_role, app_service;

-- ---------------------------------------------------------------------------------------
-- Periodos.

-- El periodo de un instante, en la zona de los periodos de ahora (como el latido y la
-- consolidación). Sin la zona no se adivina.
create function private.period_of(p_at timestamptz) returns public.period_id
language plpgsql stable set search_path = ''
as $$
declare
  v_zone text := private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}';
begin
  if v_zone is null then
    raise exception 'ZONA_HORARIA_PERIODO is not set' using errcode = 'P0001';
  end if;
  return pg_catalog.to_char(pg_catalog.timezone(v_zone, p_at), 'YYYYMM')::integer;
end
$$;
revoke all on function private.period_of(timestamptz) from public;

-- El periodo `p_months` meses después de otro.
create function private.period_plus(p_period public.period_id, p_months integer) returns public.period_id
language sql immutable set search_path = ''
as $$
  select ((x / 12) * 100 + x % 12 + 1)::integer
  from (select (p_period / 100) * 12 + (p_period % 100 - 1) + p_months as x) m
$$;
revoke all on function private.period_plus(public.period_id, integer) from public;

-- El valor de un parámetro que afecta al reparto, para un periodo: la versión más reciente que
-- rige desde ese periodo o antes (como `payout_thresholds`). Nulo si no hay.
create function private.period_parameter(p_key text, p_period public.period_id) returns jsonb
language sql stable set search_path = ''
as $$
  select b.value from public.business_parameters b
  where b.key = p_key and b.canceled_at is null and b.effective_period_id <= p_period
  order by b.effective_period_id desc, b.effective_from desc
  limit 1
$$;
revoke all on function private.period_parameter(text, public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- La regla.

-- La regla de un periodo. Solo la que dice RN-02: el IVA dentro del precio, la comisión fija
-- (PQ-15) y el anual en doce partes desde su periodo (PQ-12); otra cosa lanza, no se adivina.
create function private.revenue_rule(p_period public.period_id, out iva_bps integer, out fee_bps integer, out rule text)
language plpgsql stable set search_path = ''
as $$
declare
  v_in_price jsonb := private.period_parameter('IVA_EN_PRECIO', p_period);
  v_iva jsonb := private.period_parameter('IVA_PCT', p_period);
  v_fee jsonb := private.period_parameter('COMISION_COBRO_PCT', p_period);
  v_base jsonb := private.period_parameter('BASE_COMISION', p_period);
  v_rule jsonb := private.period_parameter('INGRESO_POR_PERIODO', p_period);
begin
  if v_in_price is null or v_iva is null or v_fee is null or v_base is null or v_rule is null then
    raise exception 'revenue rule is not set for period %', p_period using errcode = 'P0001';
  end if;
  if v_in_price is distinct from 'true'::jsonb then
    raise exception 'revenue rule for period % needs IVA_EN_PRECIO', p_period using errcode = 'P0001';
  end if;
  if v_base is distinct from '"fixed_rate"'::jsonb then
    raise exception 'revenue rule for period % needs BASE_COMISION fixed_rate', p_period using errcode = 'P0001';
  end if;
  if v_rule is distinct from '"monthly_when_charged_annual_in_twelfths"'::jsonb then
    raise exception 'revenue rule for period % has an unknown INGRESO_POR_PERIODO', p_period using errcode = 'P0001';
  end if;
  if pg_catalog.jsonb_typeof(v_iva) is distinct from 'number' or (v_iva)::text !~ '^[0-9]{1,5}$'
     or pg_catalog.jsonb_typeof(v_fee) is distinct from 'number' or (v_fee)::text !~ '^[0-9]{1,5}$'
     or (v_iva)::text::integer > 10000 or (v_fee)::text::integer >= 10000 then
    raise exception 'revenue rule for period % has an invalid rate', p_period using errcode = 'P0001';
  end if;
  iva_bps := (v_iva)::text::integer;
  fee_bps := (v_fee)::text::integer;
  rule := 'charge_date_v1';
end
$$;
revoke all on function private.revenue_rule(public.period_id) from public;

-- Los dos pasos de RN-02, en enteros: el sin IVA, mitad hacia arriba («como en la factura»), y el
-- ingreso neto después de la comisión fija, hacia abajo.
create function private.revenue_amounts(p_gross_cents bigint, p_iva_bps integer, p_fee_bps integer,
                                        out net_of_tax_cents bigint, out revenue_net_cents bigint)
language sql immutable set search_path = ''
as $$
  select x, x * (10000 - p_fee_bps) / 10000
  from (select (2 * p_gross_cents * 10000 + (10000 + p_iva_bps)) / (2 * (10000 + p_iva_bps)) as x) m
$$;
revoke all on function private.revenue_amounts(bigint, integer, integer) from public;

-- Las partes de un ingreso neto: la aritmética sola.
create function private.revenue_parts(p_net bigint, p_plan public.subscription_plan, p_period public.period_id)
returns table (part_no smallint, parts_total smallint, period_id public.period_id, base_cents bigint)
language sql immutable set search_path = ''
as $$
  select n::smallint, t.total::smallint, private.period_plus(p_period, n - 1),
         case when n < t.total then p_net / t.total else p_net - (t.total - 1) * (p_net / t.total) end
  from (select case p_plan when 'monthly' then 1 when 'annual' then 12 end as total) t
  cross join lateral pg_catalog.generate_series(1, t.total) as n
  order by n
$$;
revoke all on function private.revenue_parts(bigint, public.subscription_plan, public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- Registrar un cobro.

-- Registra un cobro y sus partes. Contesta {outcome, charge_id}, con outcome:
--   · recorded: lo escribió;
--   · already_recorded: el mismo cobro del mismo proveedor ya estaba, con la misma cuenta,
--     suscripción, plan, instante, moneda y monto; no escribe nada. Lo demás (comisión y neto del
--     proveedor, factura, recibo, método, país) no se compara: puede llegar en otro aviso, y lo
--     que no llegó en el primero no se agrega (el libro no se completa);
--   · conflict: el mismo identificador con otro de esos datos; no escribe;
--   · not_found: la suscripción no existe, o no es de esa cuenta ni de ese proveedor;
--   · unsupported_currency: no es en pesos;
--   · malformed: algo no se entiende.
-- Sin la regla de su periodo lanza, y no queda nada. Nadie de la aplicación la llama: T-303 la
-- abre al aviso del proveedor.
create function private.record_charge(
  p_profile uuid, p_subscription uuid, p_provider text, p_provider_charge_id text, p_provider_invoice_id text,
  p_plan public.subscription_plan, p_charged_at timestamptz, p_currency text, p_gross_cents bigint,
  p_provider_fee_cents bigint, p_provider_net_cents bigint, p_payment_method text, p_country_code text,
  p_receipt_url text)
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
begin
  -- Si dos llegan a la vez, la segunda espera a la primera y tiene que ver su cobro ya confirmado.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.record_charge() needs read committed isolation' using errcode = '25000';
  end if;

  if p_profile is null or p_subscription is null or p_plan is null or p_charged_at is null
     or p_provider is null or p_provider not in ('stripe', 'mercadopago', 'manual')
     or p_provider_charge_id is null or length(p_provider_charge_id) not between 1 and 255
     or (p_provider_invoice_id is not null and length(p_provider_invoice_id) not between 1 and 255)
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
  if not exists (select 1 from public.subscriptions s
                 where s.id = p_subscription and s.profile_id = p_profile and s.provider = p_provider) then
    return jsonb_build_object('outcome', 'not_found', 'charge_id', null::uuid);
  end if;

  select * into v_found from public.charges c
  where c.provider = p_provider and c.provider_charge_id = p_provider_charge_id;
  if not found then
    v_period := private.period_of(p_charged_at);
    select r.iva_bps, r.fee_bps, r.rule into v_iva, v_fee, v_rule from private.revenue_rule(v_period) r;
    select m.net_of_tax_cents, m.revenue_net_cents into v_net_of_tax, v_net from private.revenue_amounts(p_gross_cents, v_iva, v_fee) m;

    insert into public.charges (
      profile_id, subscription_id, provider, provider_charge_id, provider_invoice_id, plan, charged_at, period_id,
      currency, gross_cents, tax_cents, provider_fee_cents, provider_net_cents, fx_rate_to_mxn, fx_source,
      gross_mxn_cents, net_of_tax_mxn_cents, iva_bps, fee_bps, revenue_net_mxn_cents, payment_method, country_code,
      receipt_url)
    values (
      p_profile, p_subscription, p_provider, p_provider_charge_id, p_provider_invoice_id, p_plan, p_charged_at, v_period,
      p_currency, p_gross_cents, p_gross_cents - v_net_of_tax, p_provider_fee_cents, p_provider_net_cents, 1, 'same_currency',
      p_gross_cents, v_net_of_tax, v_iva, v_fee, v_net, p_payment_method, p_country_code, p_receipt_url)
    on conflict on constraint charges_provider_uq do nothing
    returning id into v_id;

    if v_id is not null then
      insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
      select v_id, p_profile, p.period_id, 'charge', p.part_no, p.parts_total, p.base_cents, v_fee, v_rule
      from private.revenue_parts(v_net, p_plan, v_period) p;
      -- La red del criterio: las partes suman exactamente el ingreso neto.
      if (select sum(a.base_cents) from public.revenue_allocations a where a.charge_id = v_id) is distinct from v_net then
        raise exception 'revenue parts of charge % do not add up', v_id using errcode = 'P0001';
      end if;
      return jsonb_build_object('outcome', 'recorded', 'charge_id', v_id);
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
revoke all on function private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint, bigint, bigint, text, text, text) from public;

-- ---------------------------------------------------------------------------------------
-- El vigilante: el área de los ingresos (de este carril). `ledgers` (congelada) ya mira que
-- nadie edite ni borre los dos libros; esta mira además que sus guardias estén y prendidas, que
-- nadie de la aplicación los lea ni los escriba, y que la regla la corra solo el dueño.

create function private.schema_violations_revenue()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service'))
  select 'revenue table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.charges'), ('public.revenue_allocations')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  select 'revenue ledger without ' || g.trigger_name, t.table_name
  from (values ('public.charges'), ('public.revenue_allocations')) as t (table_name)
  cross join (values ('ledger_no_update_delete'), ('ledger_no_truncate')) as g (trigger_name)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = t.table_name::regclass and tg.tgname = g.trigger_name and tg.tgenabled <> 'D'
      and n.nspname = 'private' and p.proname = 'reject_mutation')
  union all
  select 'revenue function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint, bigint, bigint, text, text, text)'),
                     ('private.revenue_rule(public.period_id)'),
                     ('private.revenue_parts(bigint, public.subscription_plan, public.period_id)'),
                     ('private.revenue_amounts(bigint, integer, integer)'),
                     ('private.period_of(timestamptz)'),
                     ('private.period_plus(public.period_id, integer)'),
                     ('private.period_parameter(text, public.period_id)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
  union all
  select 'revenue function not security definer with fixed search_path', p.oid::regprocedure::text
  from pg_catalog.pg_proc p
  where p.oid = 'private.record_charge(uuid, uuid, text, text, text, public.subscription_plan, timestamptz, text, bigint, bigint, bigint, text, text, text)'::regprocedure
    and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'])
$$;
revoke all on function private.schema_violations_revenue() from public;
