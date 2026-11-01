-- T-409, cuarta solicitud: las retenciones al liberar, y el freno de producción pasa a datos (decisiones de Sergio del 2026-10-31).
--
-- Mientras no haya una regla vigente, `release_payouts` contesta `withholding_rules_missing`: cuando conteste el contador se cargan filas, sin despliegue.
-- Quien llega al mínimo y no capturó sus datos detiene con `tax_data_missing`, y finanzas lo retiene para liberar a los demás. Al soltar se calcula con lo
-- vigente. Quien no llega al mínimo no necesita nada, y el mínimo se mide contra el bruto. Las versiones de `hold_payout` y `finance_payouts` de las que se
-- parte son las de `t401_sobre_si`.
--
-- Decisiones mías sin confirmar, para el contador: la regla es la que rige el día de liberar en `ZONA_HORARIA_PERIODO`; el IVA se redondea y lo retenido va
-- hacia abajo, con lo que el neto nunca llega a 0 mientras lo retenido sume menos de 1.

alter table public.payouts
  add column withholding_rule_id uuid references public.withholding_rules (id),
  add column withholding_profile_version smallint,
  add constraint payouts_withholding_together check ((withholding_rule_id is null) = (withholding_profile_version is null));
comment on column public.payouts.withholding_rule_id is 'La regla con que se calcularon los impuestos al liberar. Nula si no llegó al mínimo.';
comment on column public.payouts.withholding_profile_version is 'La versión de los datos fiscales con que se calcularon. Con qué se pagó es otra cosa: T-604.';

-- Una regla que retiene todo dejaría el neto en 0, y una liquidación en espera de factura lo exige positivo.
alter table public.withholding_rules
  add constraint withholding_rules_something_left check (income_tax_withholding_rate + vat_withholding_rate < 1);

-- El cálculo, puro. El IVA se redondea; lo retenido va hacia abajo.
create function private.compute_withholdings(p_subtotal bigint, p_vat numeric, p_income numeric, p_vat_withheld numeric) returns jsonb
language sql immutable set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'vat_cents', v.vat, 'income_tax_withheld_cents', v.income, 'vat_withheld_cents', v.vat_withheld,
    'net_cents', p_subtotal + v.vat - v.income - v.vat_withheld)
  from (select pg_catalog.round(p_subtotal * p_vat)::bigint as vat,
               pg_catalog.floor(p_subtotal * p_income)::bigint as income,
               pg_catalog.floor(p_subtotal * p_vat_withheld)::bigint as vat_withheld) v
$$;
revoke all on function private.compute_withholdings(bigint, numeric, numeric, numeric) from public;

-- Lo fiscal en claro de un maestro: régimen, tipo de persona y versión. Nada cifrado ni los últimos cuatro: no es una lectura, y no queda en la auditoría.
-- Sin versión, la vigente. La única puerta del dinero a la tabla.
create function private.tax_profile_fiscal(p_teacher uuid, p_version integer default null)
returns table (version smallint, regime text, payee text)
language sql stable set search_path = ''
as $$
  select x.version, x.tax_regime_code, x.payee_kind
  from private.teacher_tax_profiles x
  where x.teacher_id = p_teacher and (p_version is null or x.version = p_version)
  order by x.version desc limit 1
$$;
revoke all on function private.tax_profile_fiscal(uuid, integer) from public;

-- El día que cuenta para la regla: el de liberar, en la zona de los periodos. `now()` es el del inicio de la transacción, y es el que escribe el guardián.
create function private.release_day() returns date
language sql stable set search_path = ''
as $$ select (pg_catalog.now() at time zone private.period_zone())::date $$;
revoke all on function private.release_day() from public;

-- Los impuestos de una liquidación que se va a liberar con ese bruto. `not_needed`: no llega al mínimo. `no_data`: no capturó sus datos. `no_rule`: su
-- régimen no tiene regla ese día. Lee, no escribe: la vista y soltar la comparan, y liberar escribe lo comparado.
create function private.payout_tax_row(p_teacher uuid, p_subtotal bigint, p_minimum bigint) returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  v_profile record;
  v_rule public.withholding_rules;
  v_amounts jsonb;
  v_base jsonb := pg_catalog.jsonb_build_object('subtotal_cents', p_subtotal);
begin
  if p_minimum is null or p_subtotal < p_minimum or p_subtotal <= 0 then
    return v_base || pg_catalog.jsonb_build_object(
      'tax_state', 'not_needed', 'profile_version', null, 'rule_id', null, 'vat_cents', 0,
      'income_tax_withheld_cents', 0, 'vat_withheld_cents', 0, 'net_cents', p_subtotal);
  end if;
  select * into v_profile from private.tax_profile_fiscal(p_teacher);
  if v_profile.version is null then
    return v_base || pg_catalog.jsonb_build_object(
      'tax_state', 'no_data', 'profile_version', null, 'rule_id', null, 'vat_cents', null,
      'income_tax_withheld_cents', null, 'vat_withheld_cents', null, 'net_cents', null);
  end if;
  select r.* into v_rule from public.withholding_rules r
  where r.tax_regime_code = v_profile.regime and r.payee_kind = v_profile.payee
    and r.effective_from <= private.release_day() and (r.effective_to is null or r.effective_to > private.release_day());
  if v_rule.id is null then
    return v_base || pg_catalog.jsonb_build_object(
      'tax_state', 'no_rule', 'profile_version', v_profile.version, 'rule_id', null, 'vat_cents', null,
      'income_tax_withheld_cents', null, 'vat_withheld_cents', null, 'net_cents', null);
  end if;
  v_amounts := private.compute_withholdings(p_subtotal, v_rule.vat_rate, v_rule.income_tax_withholding_rate, v_rule.vat_withholding_rate);
  return v_base || v_amounts || pg_catalog.jsonb_build_object('tax_state', 'ready', 'profile_version', v_profile.version, 'rule_id', v_rule.id);
end
$$;
revoke all on function private.payout_tax_row(uuid, bigint, bigint) from public;


create or replace function private.release_preview(p_period public.period_id) returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  v_minimum bigint := private.minimum_payout(p_period);
  v_rows jsonb;
begin
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'teacher_id', x.teacher_id, 'payout_id', x.payout_id, 'status', x.status, 'held_from_status', x.held_from_status,
           'pool_cents', x.pool_cents, 'founder_bonus', x.founder_bonus, 'bonuses_cents', x.bonuses_cents,
           'manual_bonuses_cents', x.manual_bonuses_cents, 'adjustments_cents', x.adjustments_cents,
           'balance_cents', x.balance_cents, 'subtotal_cents', x.subtotal_cents,
           'reaches_minimum', case when v_minimum is not null then x.subtotal_cents >= v_minimum and x.subtotal_cents > 0 end,
           -- Solo de lo que este liberar escribiría; una retenida se calcula al soltar.
           'tax', case when x.status is null or x.status = 'calculated' then private.payout_tax_row(x.teacher_id, x.subtotal_cents, v_minimum) end)
         order by x.teacher_id), '[]'::jsonb)
  into v_rows
  from (
    select t.teacher_id, y.id as payout_id, y.status, y.held_from_status, s.pool_cents, f.founder_bonus, s.bonuses_cents,
           s.manual_bonuses_cents, s.adjustments_cents, s.balance_cents,
           s.pool_cents + s.bonuses_cents + s.adjustments_cents + s.balance_cents as subtotal_cents
    from (select y.teacher_id from public.payouts y where y.period_id = p_period
          union
          select x from private.payout_pending_teachers(p_period) as x) t
    left join public.payouts y on y.period_id = p_period and y.teacher_id = t.teacher_id
    cross join lateral (
      select coalesce(y.pool_cents, (select tt.total_cents from public.payout_teacher_totals tt
                                     where tt.period_id = p_period and tt.teacher_id = t.teacher_id), 0) as pool_cents,
             coalesce((select pg_catalog.sum(b.amount_cents) from public.bonuses b
                       where b.period_id = p_period and b.teacher_id = t.teacher_id and b.status = 'confirmed'), 0)::bigint as bonuses_cents,
             coalesce((select pg_catalog.sum(b.amount_cents) from public.bonuses b
                       where b.period_id = p_period and b.teacher_id = t.teacher_id and b.status = 'confirmed'
                         and b.kind <> 'founder'), 0)::bigint as manual_bonuses_cents,
             coalesce((select pg_catalog.sum(a.amount_cents) from public.payout_adjustments a
                       where a.applied_period_id = p_period and a.teacher_id = t.teacher_id), 0)::bigint as adjustments_cents,
             private.teacher_balance(t.teacher_id) as balance_cents) s
    left join lateral (
      select pg_catalog.jsonb_build_object('bonus_id', b.id, 'status', b.status, 'amount_cents', b.amount_cents,
                                           'basis_cents', b.basis_cents) as founder_bonus
      from public.bonuses b where b.period_id = p_period and b.teacher_id = t.teacher_id and b.kind = 'founder'
      order by b.created_at desc, b.id limit 1) f on true) x;
  return pg_catalog.jsonb_build_object(
    'period_id', p_period, 'minimum_cents', v_minimum, 'rows', v_rows,
    'fingerprint', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object('period_id', p_period, 'minimum_cents', v_minimum, 'rows', v_rows)::text, 'UTF8')), 'hex'));
end
$$;

drop function private.release_payout(uuid, bigint);
create function private.release_payout(p_payout uuid, p_minimum bigint, p_tax jsonb) returns public.payout_status
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
  -- Escribe lo que se comparó con lo que se vio, sin otra consulta: en read committed otra sentencia vería una regla recién cargada.
  if p_tax ->> 'subtotal_cents' is distinct from v_subtotal::text
     or (v_status = 'awaiting_invoice' and p_tax ->> 'tax_state' is distinct from 'ready')
     or (v_status = 'carried_forward' and p_tax ->> 'tax_state' is distinct from 'not_needed') then
    raise exception 'payout %: what was compared is not what is released', p_payout using errcode = '23514';
  end if;
  if v_balance <> 0 then
    insert into public.teacher_balance_entries (teacher_id, payout_id, period_id, kind, amount_cents)
    values (y.teacher_id, y.id, y.period_id, 'applied_to_payout', -v_balance);
  end if;
  if v_status = 'carried_forward' and v_subtotal <> 0 then
    insert into public.teacher_balance_entries (teacher_id, payout_id, period_id, kind, amount_cents)
    values (y.teacher_id, y.id, y.period_id, 'carried_forward', v_subtotal);
  end if;
  update public.payouts x
  set status = v_status, bonuses_cents = v_bonuses, adjustments_cents = v_adjustments, balance_applied_cents = v_balance,
      subtotal_cents = v_subtotal, vat_cents = (p_tax ->> 'vat_cents')::bigint,
      income_tax_withheld_cents = (p_tax ->> 'income_tax_withheld_cents')::bigint, vat_withheld_cents = (p_tax ->> 'vat_withheld_cents')::bigint,
      net_cents = (p_tax ->> 'net_cents')::bigint, withholding_rule_id = (p_tax ->> 'rule_id')::uuid,
      withholding_profile_version = (p_tax ->> 'profile_version')::smallint,
      released_at = pg_catalog.now(), released_by = private.actor_id()
  where x.id = p_payout;
  return v_status;
end
$$;
revoke all on function private.release_payout(uuid, bigint, jsonb) from public;


create or replace function private.release_payouts(p_period public.period_id, p_seen text) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_period public.payout_periods;
  v_blocking public.period_id;
  v_pending integer;
  v_minimum bigint;
  v_teacher uuid;
  v_locked uuid[] := '{}';
  v_preview jsonb;
  v_row jsonb;
  v_payout uuid;
  v_status public.payout_status;
  v_released integer := 0;
  v_awaiting integer := 0;
  v_carried integer := 0;
  v_held integer;
  v_no_data uuid[];
  v_no_rule uuid[];
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'releases run in read committed' using errcode = '25000';
  end if;
  set constraints public.payouts_released deferred;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_period is null or p_seen is null then
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
  -- Los candados de saldo de sus maestros, en orden, antes de mirar la vista: soltar una retenida de otro
  -- periodo mueve un saldo con su candado, y así no lo mueve entre la vista y la liberación. Soltar toma uno
  -- solo: no hay ciclo.
  for v_teacher in select y.teacher_id from public.payouts y where y.period_id = p_period
                   union select x from private.payout_pending_teachers(p_period) as x
                   order by 1 loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('teacher_balance:' || v_teacher::text, 0));
    v_locked := v_locked || v_teacher;
  end loop;
  v_preview := private.release_preview(p_period);
  if v_preview ->> 'fingerprint' is distinct from p_seen then
    return '{"outcome": "preview_changed"}'::jsonb;
  end if;
  -- Quien pasó a tener algo pendiente entre los candados y la vista no tiene el suyo: su saldo podría moverse.
  if exists (select 1 from pg_catalog.jsonb_array_elements(v_preview -> 'rows') x
             where not ((x.value ->> 'teacher_id')::uuid = any (v_locked))) then
    return '{"outcome": "preview_changed"}'::jsonb;
  end if;

  -- El freno: sin ninguna regla vigente, o sin la de alguien, detiene todo; sin los datos de alguien, finanzas lo retiene y libera a los demás. Quien no
  -- tiene liquidación todavía (llega por su saldo) se queda con una, para que se pueda retener.
  select coalesce(pg_catalog.array_agg((x.value ->> 'teacher_id')::uuid) filter (where x.value #>> '{tax,tax_state}' = 'no_data'), '{}'),
         coalesce(pg_catalog.array_agg((x.value ->> 'teacher_id')::uuid) filter (where x.value #>> '{tax,tax_state}' = 'no_rule'), '{}')
  into v_no_data, v_no_rule
  from pg_catalog.jsonb_array_elements(v_preview -> 'rows') x;
  if pg_catalog.cardinality(v_no_data) + pg_catalog.cardinality(v_no_rule) > 0 then
    foreach v_teacher in array v_no_data || v_no_rule loop
      perform private.ensure_payout(p_period, v_teacher);
    end loop;
    if pg_catalog.cardinality(v_no_rule) > 0 or not exists (
         select 1 from public.withholding_rules r
         where r.effective_from <= private.release_day() and (r.effective_to is null or r.effective_to > private.release_day())) then
      return pg_catalog.jsonb_build_object('outcome', 'withholding_rules_missing', 'teachers', pg_catalog.to_jsonb(v_no_rule || v_no_data));
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'tax_data_missing', 'teachers', pg_catalog.to_jsonb(v_no_data));
  end if;

  -- Se libera la vista que se comparó, no una consulta nueva: en read committed otra sentencia vería a quien
  -- pasó a tener algo pendiente después (soltando en otro periodo), y le daría y liberaría una liquidación que
  -- nadie vio. Ese saldo entra al periodo siguiente sin liberar, como todo lo que llega después.
  for v_row in select x.value from pg_catalog.jsonb_array_elements(v_preview -> 'rows') x
               where x.value ->> 'status' is null or x.value ->> 'status' = 'calculated'
               order by x.value ->> 'teacher_id' loop
    v_payout := coalesce((v_row ->> 'payout_id')::uuid, private.ensure_payout(p_period, (v_row ->> 'teacher_id')::uuid));
    v_status := private.release_payout(v_payout, v_minimum, v_row -> 'tax');
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
                then private.payout_tax_row(y.teacher_id, v_subtotal, v_minimum) end);
  return v || pg_catalog.jsonb_build_object(
    'fingerprint', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v::text, 'UTF8')), 'hex'));
end
$$;

create or replace function private.unhold_payout(p_payout uuid, p_note text, p_seen text) returns jsonb
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
  v_preview jsonb;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'holds run in read committed' using errcode = '25000';
  end if;
  set constraints public.payouts_released deferred;
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
    v_to := private.release_payout(p_payout, v_minimum, v_preview -> 'tax');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'released_from_hold', 'to', v_to, 'period_status', private.settle_period(v_period_id));
end
$$;

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
                                  new.hold_reason, new.anomaly_alert_id, new.withholding_rule_id, new.withholding_profile_version) > 0 then
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
    if pg_catalog.num_nonnulls(new.held_from_status, new.held_at, new.held_by, new.hold_reason, new.anomaly_alert_id) > 0 then
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
    return new;
  end if;

  if (new.bonuses_cents, new.adjustments_cents, new.balance_applied_cents, new.subtotal_cents, new.vat_cents,
      new.income_tax_withheld_cents, new.vat_withheld_cents, new.net_cents, new.released_at, new.released_by,
      new.withholding_rule_id, new.withholding_profile_version)
     is distinct from
     (old.bonuses_cents, old.adjustments_cents, old.balance_applied_cents, old.subtotal_cents, old.vat_cents,
      old.income_tax_withheld_cents, old.vat_withheld_cents, old.net_cents, old.released_at, old.released_by,
      old.withholding_rule_id, old.withholding_profile_version) then
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

create or replace function private.assert_payout_released(p_payout uuid) returns void
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
  v_rule public.withholding_rules;
  v_profile record;
  v_day date;
  v_amounts jsonb;
begin
  select * into strict y from public.payouts x where x.id = p_payout;
  if (select p.payouts_released_at from public.payout_periods p where p.period_id = y.period_id) is null then
    raise exception 'payout %: released outside the release of its period', p_payout using errcode = '23514';
  end if;
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
  v_minimum := private.minimum_payout(y.period_id);
  v_expected := case when y.subtotal_cents >= v_minimum and y.subtotal_cents > 0 then 'awaiting_invoice' else 'carried_forward' end;
  v_status := case when y.status = 'on_hold' then y.held_from_status else y.status end;
  if v_status is distinct from v_expected then
    raise exception 'payout %: % does not follow the minimum payout (% against %)', p_payout, v_status, y.subtotal_cents, v_minimum
      using errcode = '23514';
  end if;
  -- Los impuestos, con la regla y la versión escritas, no con las de ahora: una regla o unos datos posteriores no cambian lo liberado.
  if v_expected = 'carried_forward' then
    if y.vat_cents <> 0 or y.income_tax_withheld_cents <> 0 or y.vat_withheld_cents <> 0 or y.net_cents <> y.subtotal_cents
       or y.withholding_rule_id is not null or y.withholding_profile_version is not null then
      raise exception 'payout %: carried forward with taxes', p_payout using errcode = '23514';
    end if;
  else
    select r.* into v_rule from public.withholding_rules r where r.id = y.withholding_rule_id;
    select * into v_profile from private.tax_profile_fiscal(y.teacher_id, y.withholding_profile_version);
    v_day := (y.released_at at time zone private.period_zone())::date;
    if v_rule.id is null or v_profile.version is null or v_profile.regime <> v_rule.tax_regime_code or v_profile.payee <> v_rule.payee_kind
       or v_rule.effective_from > v_day or (v_rule.effective_to is not null and v_rule.effective_to <= v_day) then
      raise exception 'payout %: its withholding rule is not the one for its data on that day', p_payout using errcode = '23514';
    end if;
    v_amounts := private.compute_withholdings(y.subtotal_cents, v_rule.vat_rate, v_rule.income_tax_withholding_rate, v_rule.vat_withholding_rate);
    if (v_amounts ->> 'vat_cents')::bigint <> y.vat_cents or (v_amounts ->> 'income_tax_withheld_cents')::bigint <> y.income_tax_withheld_cents
       or (v_amounts ->> 'vat_withheld_cents')::bigint <> y.vat_withheld_cents or (v_amounts ->> 'net_cents')::bigint <> y.net_cents then
      raise exception 'payout %: its taxes are not what its rule says', p_payout using errcode = '23514';
    end if;
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

create or replace function private.finance_payouts(p_period public.period_id) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.payout_periods;
  v_minimum bigint;
  v_preview jsonb;
  v_unreleased boolean;
begin
  if private.actor_id() is null or not private.actor_has_capability('finance') then
    return null;
  end if;
  select * into p from public.payout_periods x where x.period_id = p_period;
  if not found then
    return pg_catalog.jsonb_build_object('fresh_code', private.finance_change_gate() is null, 'period', null);
  end if;
  v_minimum := private.minimum_payout(p_period);
  v_unreleased := p.payouts_released_at is null;
  if p.status in ('closed', 'paid') then
    v_preview := private.release_preview(p_period);
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.finance_change_gate() is null,
    'period', pg_catalog.jsonb_build_object(
      'period_id', p.period_id, 'status', p.status, 'closed_at', p.closed_at, 'payouts_released_at', p.payouts_released_at,
      'paid_at', p.paid_at, 'minimum_cents', v_minimum,
      -- El último cambio a sus liquidaciones o a sus bonos: el aviso «Listo» se pinta solo si fue hace un momento.
      'changed_at', (select pg_catalog.max(t) from (
                       select y.updated_at from public.payouts y where y.period_id = p_period
                       union all select b.decided_at from public.bonuses b where b.period_id = p_period
                       union all select b.voided_at from public.bonuses b where b.period_id = p_period) c (t))),
    'release', case when v_preview is not null and v_unreleased then pg_catalog.jsonb_build_object(
                 'fingerprint', v_preview ->> 'fingerprint',
                 'pending_founder_bonuses', (select pg_catalog.count(*) from public.bonuses b
                                             where b.period_id = p_period and b.kind = 'founder' and b.status = 'proposed')) end,
    'payouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'teacher_id', z.teacher_id, 'name', z.name, 'payout_id', z.payout_id, 'status', z.status,
               'held_from_status', z.held_from_status, 'hold_reason', z.hold_reason, 'held_at', z.held_at,
               'released_at', z.released_at, 'pool_cents', z.pool_cents, 'founder_bonus', z.founder_bonus,
               'manual_bonuses_cents', z.manual_bonuses_cents, 'adjustments_cents', z.adjustments_cents,
               'balance_cents', z.balance_cents, 'subtotal_cents', z.subtotal_cents, 'estimated', z.released_at is null,
               'tax_state', z.tax_state, 'has_tax_data', exists (select 1 from private.tax_profile_fiscal(z.teacher_id)),
               'vat_cents', z.vat_cents, 'income_tax_withheld_cents', z.income_tax_withheld_cents,
               'vat_withheld_cents', z.vat_withheld_cents, 'net_cents', z.net_cents,
               'reaches_minimum', case when v_minimum is not null then z.subtotal_cents >= v_minimum and z.subtotal_cents > 0 end,
               'unhold_fingerprint', case when z.status = 'on_hold' then private.unhold_preview(z.payout_id) ->> 'fingerprint' end,
               'is_self', private.actor_owns_teacher(z.teacher_id))
             order by z.name collate "C" nulls last, z.teacher_id)
      from (
        select (r ->> 'teacher_id')::uuid as teacher_id, pt.display_name as name, y.id as payout_id, y.status,
               y.held_from_status, y.hold_reason, y.held_at, y.released_at, (r ->> 'pool_cents')::bigint as pool_cents,
               r -> 'founder_bonus' as founder_bonus,
               case when y.released_at is not null
                    then y.bonuses_cents - case when r #>> '{founder_bonus,status}' = 'confirmed'
                                                then (r #>> '{founder_bonus,amount_cents}')::bigint else 0 end
                    else (r ->> 'manual_bonuses_cents')::bigint end as manual_bonuses_cents,
               case when y.released_at is not null then y.adjustments_cents else (r ->> 'adjustments_cents')::bigint end
                 as adjustments_cents,
               case when y.released_at is not null then y.balance_applied_cents else (r ->> 'balance_cents')::bigint end
                 as balance_cents,
               case when y.released_at is not null then y.subtotal_cents else (r ->> 'subtotal_cents')::bigint end
                 as subtotal_cents,
               r #>> '{tax,tax_state}' as tax_state,
               case when y.released_at is not null then y.vat_cents else (r #>> '{tax,vat_cents}')::bigint end as vat_cents,
               case when y.released_at is not null then y.income_tax_withheld_cents else (r #>> '{tax,income_tax_withheld_cents}')::bigint end
                 as income_tax_withheld_cents,
               case when y.released_at is not null then y.vat_withheld_cents else (r #>> '{tax,vat_withheld_cents}')::bigint end
                 as vat_withheld_cents,
               case when y.released_at is not null then y.net_cents else (r #>> '{tax,net_cents}')::bigint end as net_cents
        from pg_catalog.jsonb_array_elements(v_preview -> 'rows') r
        left join public.payouts y on y.id = (r ->> 'payout_id')::uuid
        left join public.published_teachers pt on pt.teacher_id = (r ->> 'teacher_id')::uuid
        where v_unreleased or y.id is not null) z), '[]'::jsonb));
end
$$;

create or replace function private.schema_violations_payouts()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  payout_tables (table_name) as (
    values ('public.payouts'), ('public.payout_status_events'), ('public.bonuses'), ('public.payout_adjustments'),
           ('public.teacher_balance_entries')),
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
           ('raw_retention', false, false, false)),
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
  select 'payouts job not scheduled: raw_retention', 'cron.job'
  where not exists (select 1 from cron.job j where j.jobname = 'raw_retention' and j.active
                      and j.command = 'call private.raw_retention()')
$$;

create or replace function private.schema_violations_tax()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  tax_functions (name, signature, reads) as (
    values ('tax_profile_save', 'private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer)', false),
           ('tax_profile_state', 'private.tax_profile_state()', false),
           ('tax_profile_mine', 'private.tax_profile_mine()', true),
           ('tax_profile_for_payout', 'private.tax_profile_for_payout(uuid)', true)),
  -- Las que nombran la tabla sin leer lo cifrado: la lista de PA-65 solo dice si hay una fila, y el vigilante la vigila.
  tax_known (oid) as (
    select pg_catalog.to_regprocedure(f.signature)::oid from tax_functions f
    union all
    select pg_catalog.to_regprocedure(k.signature)::oid
    from (values ('private.teacher_roster()'), ('private.tax_profile_fiscal(uuid, integer)'), ('private.schema_violations_tax()'), ('private.schema_violations_ledgers()')) k (signature))
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
  select 'tax finance read without its gate', 'tax_profile_for_payout'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_for_payout(uuid)')) like '%finance_change_gate%actor_owns_teacher%', false)
  union all
  -- Guardar toma el candado del saldo: liberar lee este perfil, y la carrera no se ve en una prueba de una sola conexión.
  select 'tax save without the balance lock', 'tax_profile_save'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer)')) like '%teacher_balance:%', false)
  union all
  -- El estado y la lista de PA-65 no leen lo que hay en la tabla: no quedan en la auditoría.
  select 'tax data out of its doors: ' || d.name, d.name
  from (values ('tax_profile_state', 'private.tax_profile_state()'), ('teacher_roster', 'private.teacher_roster()'),
               ('tax_profile_fiscal', 'private.tax_profile_fiscal(uuid, integer)')) d (name, signature)
  where coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(d.signature)), '') ~ '(rfc_enc|legal_name_enc|clabe_enc|clabe_last4|tax_regime_code|payee_kind)'
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
               ('teacher_tax_profiles_clabe_sealed', '%octet_length(clabe_enc) = 49%'), ('teacher_tax_profiles_last4_form', '%[0-9]{4}%')) c (name, pattern)
  where not exists (
    select 1 from pg_catalog.pg_constraint k
    where k.conrelid = 'private.teacher_tax_profiles'::regclass and k.conname = c.name and k.convalidated
      and pg_catalog.pg_get_constraintdef(k.oid) like c.pattern)
$$;
