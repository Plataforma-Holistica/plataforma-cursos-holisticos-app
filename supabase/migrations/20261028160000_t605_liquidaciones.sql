-- T-605 · PA-81 mínimo: las liquidaciones del periodo, liberar, retener y soltar, y decidir el bono del fundador
-- desde el servidor (RF-505, RF-506, RF-508, RN-12, RN-17; 05 §5.5 y §8.7). Cuarta y última solicitud de T-605.
-- Decisiones de Sergio del 2026-10-28: el plan con las huellas de la revisión independiente del diseño, y en
-- producción no se libera hasta T-409 (lo frena la aplicación, con `APP_ENV`).
--
-- Como el cierre en la 72, nadie libera algo distinto de lo que vio. Liberar suma al confirmar bonos, ajustes y
-- el saldo de cada maestro, y entre ver y confirmar alguien pudo confirmar un bono, retener, soltar o (en otro
-- periodo) mover un saldo. Por eso:
-- - `private.release_preview(p)` es la única definición de lo que liberar escribiría, con su huella;
-- - `release_payouts(p, huella)` toma la fila del periodo y los candados de saldo de sus maestros, recalcula la
--   vista y solo libera si la huella es la vista (`preview_changed` si no);
-- - `unhold_payout(y, nota, huella)` exige la huella de su liquidación (`private.unhold_preview`), porque soltar
--   una calculada de un mes liberado la libera ahí mismo;
-- - `hold_payout(y, motivo, estado visto, alerta)` contesta `changed` si ya no está en el estado que se vio.
-- Las firmas de antes se borran: una sola puerta. Decisiones mías sin confirmar (PROGRESO, 2026-10-28): liberar
-- toma los candados de saldo de todos sus maestros (cierra la carrera con soltar en otro periodo; con 100
-- maestros son 100 candados consultivos en la transacción); retener desde la pantalla no enlaza una alerta.

-- ---------------------------------------------------------------------------------------
-- Lo que liberar escribiría.

-- La vista de liberar un periodo: una fila por maestro con liquidación o con algo pendiente (saldo, ajuste o
-- bono confirmado), con lo que `release_payout` sumaría y si llegaría al mínimo, y la huella de todo eso. La
-- cifra del bote de quien no tiene liquidación es la que le daría `ensure_payout`.
create function private.release_preview(p_period public.period_id) returns jsonb
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
           'reaches_minimum', case when v_minimum is not null then x.subtotal_cents >= v_minimum and x.subtotal_cents > 0 end)
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
revoke all on function private.release_preview(public.period_id) from public;

-- Lo que soltar una retenida haría: a qué estado vuelve, si se libera ahí mismo (estaba calculada y su periodo
-- ya se liberó) y con qué cifras; liberada, las escritas. Con su huella. Nula si no existe.
create function private.unhold_preview(p_payout uuid) returns jsonb
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
    'reaches_minimum', case when v_minimum is not null then v_subtotal >= v_minimum and v_subtotal > 0 end);
  return v || pg_catalog.jsonb_build_object(
    'fingerprint', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v::text, 'UTF8')), 'hex'));
end
$$;
revoke all on function private.unhold_preview(uuid) from public;

-- ---------------------------------------------------------------------------------------
-- Las funciones de finanzas, con lo que se vio. Las de antes se borran.

drop function private.release_payouts(public.period_id);
drop function private.hold_payout(uuid, text, uuid);
drop function private.unhold_payout(uuid, text);

-- Liberar (RF-505): en orden desde el arranque, con los bonos del fundador decididos, el mínimo del periodo y la
-- huella de la vista que se tenía delante. Le da su liquidación a quien tiene algo pendiente, libera cada
-- calculada (las retenidas no), marca el periodo como liberado y, si no queda nada por pagar, lo pasa a pagado.
create function private.release_payouts(p_period public.period_id, p_seen text) returns jsonb
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

  -- Se libera la vista que se comparó, no una consulta nueva: en read committed otra sentencia vería a quien
  -- pasó a tener algo pendiente después (soltando en otro periodo), y le daría y liberaría una liquidación que
  -- nadie vio. Ese saldo entra al periodo siguiente sin liberar, como todo lo que llega después.
  for v_row in select x.value from pg_catalog.jsonb_array_elements(v_preview -> 'rows') x
               where x.value ->> 'status' is null or x.value ->> 'status' = 'calculated'
               order by x.value ->> 'teacher_id' loop
    v_payout := coalesce((v_row ->> 'payout_id')::uuid, private.ensure_payout(p_period, (v_row ->> 'teacher_id')::uuid));
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
revoke all on function private.release_payouts(public.period_id, text) from public;

-- Retener una liquidación mientras se investiga (RN-17), con su motivo, el estado en que se vio y, si la hay, su
-- alerta. Si ya no está en el estado que se vio (se liberó mientras tanto), no se retiene: `changed`.
create function private.hold_payout(p_payout uuid, p_reason text, p_seen text, p_alert uuid default null) returns jsonb
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
  if p_payout is null or pg_catalog.btrim(coalesce(p_reason, '')) = '' or pg_catalog.char_length(p_reason) > 2000
     or p_seen is null then
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
  if y.status::text <> p_seen then
    return pg_catalog.jsonb_build_object('outcome', 'changed', 'status', y.status);
  end if;
  if y.status in ('carried_forward', 'paid', 'payment_returned') then
    return pg_catalog.jsonb_build_object('outcome', 'not_holdable', 'status', y.status);
  end if;
  update public.payouts x set status = 'on_hold', hold_reason = pg_catalog.btrim(p_reason), anomaly_alert_id = p_alert
  where x.id = p_payout;
  return pg_catalog.jsonb_build_object('outcome', 'held', 'from', y.status);
end
$$;
revoke all on function private.hold_payout(uuid, text, text, uuid) from public;

-- Soltar una retenida con la huella de lo que se vio (`private.unhold_preview`): vuelve al estado en que estaba,
-- con la nota en su historia. Si estaba calculada y el periodo ya se liberó, se libera ahí mismo; y si ya no queda
-- nada por pagar, el periodo pasa a pagado.
create function private.unhold_payout(p_payout uuid, p_note text, p_seen text) returns jsonb
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
  if p_payout is null or pg_catalog.char_length(p_note) > 2000 or p_seen is null then
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
  -- El candado del saldo de su maestro antes de mirar la huella: liberar ahí mismo lo usa.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('teacher_balance:' || y.teacher_id::text, 0));
  if private.unhold_preview(p_payout) ->> 'fingerprint' is distinct from p_seen then
    return '{"outcome": "changed"}'::jsonb;
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
revoke all on function private.unhold_payout(uuid, text, text) from public;

-- ---------------------------------------------------------------------------------------
-- PA-81: la lectura de las liquidaciones del periodo. Nula si quien actúa no tiene finanzas; leer no pide el
-- código reciente, y lo dice (`fresh_code`). Sin el identificador de ningún alumno ni datos bancarios.
--
-- Sin liberar, cada fila es la de la vista de liberar (estimada) y trae la huella con la que se libera.
-- Liberado, solo las liquidaciones, con sus cifras escritas, salvo la retenida desde calculada, que soltar
-- liberaría: estimada. Cada retenida trae la huella con la que se suelta.
create function private.finance_payouts(p_period public.period_id) returns jsonb
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
               'reaches_minimum', case when v_minimum is not null then z.subtotal_cents >= v_minimum and z.subtotal_cents > 0 end,
               'unhold_fingerprint', case when z.status = 'on_hold' then private.unhold_preview(z.payout_id) ->> 'fingerprint' end)
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
                 as subtotal_cents
        from pg_catalog.jsonb_array_elements(v_preview -> 'rows') r
        left join public.payouts y on y.id = (r ->> 'payout_id')::uuid
        left join public.published_teachers pt on pt.teacher_id = (r ->> 'teacher_id')::uuid
        where v_unreleased or y.id is not null) z), '[]'::jsonb));
end
$$;
revoke all on function private.finance_payouts(public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- El servidor libera, retiene, suelta, decide el bono del fundador y lee PA-81. Capturar bonos y ajustes
-- sigue cerrado (PA-83).

grant execute on function private.release_payouts(public.period_id, text), private.hold_payout(uuid, text, text, uuid),
  private.unhold_payout(uuid, text, text), private.confirm_founder_bonus(uuid), private.void_bonus(uuid, text),
  private.finance_payouts(public.period_id) to app_service;

-- ---------------------------------------------------------------------------------------
-- El vigilante del área: la columna `server` (qué abre el servidor), en los dos sentidos, como el del cierre.

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
revoke all on function private.schema_violations_payouts() from public;
