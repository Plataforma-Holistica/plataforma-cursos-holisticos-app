-- T-401 · Nadie actúa sobre sí, también en finanzas y en el equipo (decisiones de Sergio del 2026-10-29 y del
-- 2026-10-30). Alguien del equipo puede ser maestro o alumno, pero nunca actúa sobre sí:
--   · no revisa una alerta de su cuenta o de su maestro (`review_alert`);
--   · no excluye su propio consumo, ni revierte una exclusión de su cuenta (`self`); y quien cobra en un periodo
--     (su maestro tiene puntos o reproducciones en él) no excluye ni revierte en ese periodo (`conflict`):
--     excluir el consumo de otros mueve el bote sin consumo, que se reparte entre todos los maestros;
--   · excluir por fraude lo hace alguien distinto de quien marcó la alerta como fraude (`proposer`). Quién la
--     marcó queda en `anomaly_alerts.fraud_marked_by`; para una marcada antes, cuenta quien la revisó;
--   · no retiene ni suelta su liquidación, no confirma ni anula su bono, y no se captura un bono ni un ajuste;
--   · no se da una capacidad (decisión mía sin confirmar: es la misma regla).
-- Liberar las liquidaciones del periodo no se bloquea aunque incluya la propia: la lectura de PA-81 dice cuál
-- es (`is_self`). Con un fundador en finanzas hacen falta dos personas con finanzas para su bono.
--
-- Cada función queda como estaba, con una sola comprobación más: después de la puerta y de tomar lo que ya
-- tomaba, antes de mirar su estado. Ninguna toma un candado nuevo: `teachers` se lee sin tomar su fila.

-- ---------------------------------------------------------------------------------------
-- Quién marcó el fraude.

alter table public.anomaly_alerts add column fraud_marked_by uuid references public.profiles (id);
alter table public.anomaly_alerts add constraint anomaly_alerts_fraud_marker check (fraud_marked_by is null or is_fraud is true);

-- ---------------------------------------------------------------------------------------
-- Los ayudantes. Ninguno tiene permisos para la aplicación.

-- ¿Es ese maestro el de quien actúa? En cualquier estado: un maestro suspendido o que se fue sigue cobrando.
create function private.actor_owns_teacher(p_teacher uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.actor_id() is not null
     and exists (select 1 from public.teachers t where t.id = p_teacher and t.profile_id = private.actor_id())
$$;
revoke all on function private.actor_owns_teacher(uuid) from public;

-- ¿Cobra quien actúa en alguno de esos periodos? Su maestro tiene puntos consolidados, o reproducciones que la
-- consolidación todavía no pasó, en ellos.
create function private.actor_earns_in(p_periods public.period_id[]) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.actor_id() is not null and (
    exists (select 1 from public.watch_rollup w join public.teachers t on t.id = w.teacher_id
            where t.profile_id = private.actor_id() and w.period_id = any (p_periods))
    or exists (select 1 from public.watch_events e
               join public.published_lessons l on l.id = e.lesson_id
               join public.teachers t on t.id = l.teacher_id
               where t.profile_id = private.actor_id() and e.period_id = any (p_periods)))
$$;
revoke all on function private.actor_earns_in(public.period_id[]) from public;

-- ---------------------------------------------------------------------------------------
-- El guardián de las alertas (t208): `fraud_marked_by` cambia con la revisión, una vez.

create or replace function private.guard_anomaly_alerts() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
begin
  if tg_op = 'TRUNCATE' then
    raise exception '%.%: alerts are reviewed, not deleted', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner from pg_catalog.pg_class c where c.oid = tg_relid;
  if current_user::name <> v_owner then
    raise exception '%.%: only the detection and the finance functions write alerts', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception '%.%: alerts are reviewed, not deleted', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if not private.actor_is_system() or new.status <> 'open' or new.reviewed_at is not null or new.is_fraud is not null
       or new.evidence is not null or new.teacher_notified_at is not null or new.fraud_marked_by is not null then
      raise exception '%.%: only the nightly detection opens alerts', tg_table_schema, tg_table_name using errcode = '42501';
    end if;
    return new;
  end if;
  if private.finance_change_gate() is not null
     or (pg_catalog.to_jsonb(new) - array['status', 'review_note', 'reviewed_by', 'reviewed_at', 'evidence', 'is_fraud', 'fraud_marked_by'])
        is distinct from (pg_catalog.to_jsonb(old) - array['status', 'review_note', 'reviewed_by', 'reviewed_at', 'evidence', 'is_fraud', 'fraud_marked_by'])
     or (old.status = 'reviewed' and (new.status, new.review_note, new.reviewed_by, new.reviewed_at)
                                     is distinct from (old.status, old.review_note, old.reviewed_by, old.reviewed_at))
     or (old.is_fraud is true and new.is_fraud is not true)
     or (old.evidence is not null and new.evidence is distinct from old.evidence)
     or (old.fraud_marked_by is not null and new.fraud_marked_by is distinct from old.fraud_marked_by) then
    raise exception '%.%: only the review changes, once; a fraud decision stays', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Revisar una alerta (t208_alertas_lectura): `self` si es de su cuenta o de su maestro; anota quién marca el
-- fraude.

create or replace function private.review_alert(p_alert uuid, p_note text, p_is_fraud boolean, p_evidence text) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_note text := nullif(pg_catalog.btrim(p_note), '');
  v_evidence text := nullif(pg_catalog.btrim(p_evidence), '');
  v_row public.anomaly_alerts;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'finance decisions run in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_alert is null or pg_catalog.length(coalesce(v_note, '')) > 4000
     or (p_is_fraud is true and (v_evidence is null or pg_catalog.length(v_evidence) > 4000)) then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select * into v_row from public.anomaly_alerts a where a.id = p_alert for update;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if v_row.profile_id = private.actor_id() or private.actor_owns_teacher(v_row.teacher_id) then
    return '{"outcome": "self"}'::jsonb;
  end if;
  if v_row.status = 'open' then
    if v_note is null then
      return '{"outcome": "malformed"}'::jsonb;
    end if;
    update public.anomaly_alerts a
    set status = 'reviewed', review_note = v_note, reviewed_by = private.actor_id(), reviewed_at = pg_catalog.now(),
        is_fraud = p_is_fraud, evidence = case when p_is_fraud then v_evidence end,
        fraud_marked_by = case when p_is_fraud then private.actor_id() end
    where a.id = p_alert;
    return '{"outcome": "reviewed"}'::jsonb;
  end if;
  if p_is_fraud is true and v_row.is_fraud is not true then
    update public.anomaly_alerts a set is_fraud = true, evidence = v_evidence, fraud_marked_by = private.actor_id() where a.id = p_alert;
    return '{"outcome": "marked_fraud"}'::jsonb;
  end if;
  return '{"outcome": "already_reviewed"}'::jsonb;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Excluir (t602_congelado): `self` con su propia cuenta; `proposer` si excluye por fraude quien lo marcó;
-- `conflict` si cobra en los periodos que excluye. `exclude_alert_account` la llama y contesta lo mismo.

create or replace function private.exclude_consumption(p_scope public.exclusion_scope, p_period public.period_id, p_profile uuid,
                                            p_session uuid, p_lesson uuid, p_from integer, p_to integer,
                                            p_reason_code text, p_reason text, p_alert uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_actor uuid;
  v_reason text := pg_catalog.btrim(p_reason);
  v_alert public.anomaly_alerts;
  v_window public.period_id[];
  v_periods public.period_id[];
  v_period public.period_id;
  v_id uuid;
  v_ids uuid[] := '{}';
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'finance decisions run in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  v_actor := private.actor_id();
  if p_scope is null or p_profile is null or p_reason_code is null
     or p_reason_code not in ('fraud', 'technical_error', 'test_account', 'other')
     or v_reason is null or v_reason = '' or pg_catalog.length(v_reason) > 2000
     or (p_scope = 'account' and (p_period is null or p_session is not null or p_lesson is not null
                                  or p_from is not null or p_to is not null))
     or (p_scope = 'session' and (p_session is null or p_lesson is not null or p_from is not null or p_to is not null))
     or (p_scope = 'interval' and (p_period is null or p_session is not null or p_lesson is null
                                   or p_from is null or p_to is null or p_from < 0 or p_to <= p_from)) then
    return '{"outcome": "malformed"}'::jsonb;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exclusions:' || p_profile::text, 0));
  if not exists (select 1 from public.profiles p where p.id = p_profile) then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if p_profile = v_actor then
    return '{"outcome": "self"}'::jsonb;
  end if;
  v_window := array(select private.rollup_window());
  if p_scope = 'session' then
    if not exists (select 1 from public.playback_sessions s where s.id = p_session and s.profile_id = p_profile) then
      return '{"outcome": "not_found"}'::jsonb;
    end if;
    v_periods := array(select distinct e.period_id from public.watch_events e
                       where e.playback_session_id = p_session and e.period_id = any (v_window) order by 1);
    if pg_catalog.cardinality(v_periods) = 0 then
      return '{"outcome": "outside_window"}'::jsonb;
    end if;
  else
    if not p_period = any (v_window) then
      return '{"outcome": "outside_window"}'::jsonb;
    end if;
    if p_scope = 'interval' and not exists (select 1 from public.published_lessons l where l.id = p_lesson) then
      return '{"outcome": "not_found"}'::jsonb;
    end if;
    v_periods := array[p_period];
  end if;

  if p_alert is not null then
    select * into v_alert from public.anomaly_alerts a where a.id = p_alert for update;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', case when p_reason_code = 'fraud' then 'needs_fraud_decision' else 'not_found' end);
    end if;
  end if;
  if p_reason_code = 'fraud' then
    -- RN-17: decide finanzas, con la evidencia escrita en la alerta; solo el periodo de la alerta.
    if v_alert.id is null or v_alert.is_fraud is not true or not v_alert.period_id = any (v_periods) then
      return '{"outcome": "needs_fraud_decision"}'::jsonb;
    end if;
    if coalesce(v_alert.fraud_marked_by, v_alert.reviewed_by) = v_actor then
      return '{"outcome": "proposer"}'::jsonb;
    end if;
    v_periods := array[v_alert.period_id];
    if not (
        (v_alert.kind = 'impossible_completion' and v_alert.profile_id = p_profile)
        or (v_alert.kind = 'teacher_points_jump' and (
              exists (select 1 from public.watch_rollup w
                      where w.period_id = v_alert.period_id and w.profile_id = p_profile and w.teacher_id = v_alert.teacher_id)
              or exists (select 1 from public.watch_events e join public.published_lessons l on l.id = e.lesson_id
                         where e.period_id = v_alert.period_id and e.profile_id = p_profile and l.teacher_id = v_alert.teacher_id))
            -- Por tramo o por reproducción, solo lo de ese maestro.
            and (p_scope <> 'interval' or exists (select 1 from public.published_lessons l
                                                  where l.id = p_lesson and l.teacher_id = v_alert.teacher_id))
            and (p_scope <> 'session' or exists (select 1 from public.playback_sessions s join public.published_lessons l on l.id = s.lesson_id
                                                 where s.id = p_session and l.teacher_id = v_alert.teacher_id)))) then
      return '{"outcome": "not_related"}'::jsonb;
    end if;
  end if;

  if private.actor_earns_in(v_periods) then
    return '{"outcome": "conflict"}'::jsonb;
  end if;
  foreach v_period in array v_periods loop
    continue when exists (
      select 1 from public.consumption_exclusions x
      where x.period_id = v_period and x.profile_id = p_profile and x.scope = p_scope and x.revoked_at is null
        and x.playback_session_id is not distinct from p_session and x.lesson_id is not distinct from p_lesson
        and x.from_second is not distinct from p_from and x.to_second is not distinct from p_to
        and x.reason_code = p_reason_code and x.anomaly_alert_id is not distinct from p_alert);
    -- La exclusión apunta a su periodo (T-602): su fila se abre antes, si falta.
    perform private.open_period(v_period);
    insert into public.consumption_exclusions (period_id, scope, profile_id, playback_session_id, lesson_id, from_second, to_second,
                                               reason_code, reason, anomaly_alert_id, created_by)
    values (v_period, p_scope, p_profile, p_session, p_lesson, p_from, p_to, p_reason_code, v_reason, p_alert, v_actor)
    returning id into v_id;
    v_ids := v_ids || v_id;
    perform private.mark_pairs_for(p_profile, v_period, p_lesson, p_session);
  end loop;
  if pg_catalog.cardinality(v_ids) = 0 then
    return '{"outcome": "already_excluded"}'::jsonb;
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'excluded', 'ids', pg_catalog.to_jsonb(v_ids));
end
$$;

-- ---------------------------------------------------------------------------------------
-- Revertir una exclusión (t208): `self` si es de su cuenta; `conflict` si cobra en su periodo.

create or replace function private.revoke_exclusion(p_exclusion uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_reason text := pg_catalog.btrim(p_reason);
  v_profile uuid;
  v_row public.consumption_exclusions;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'finance decisions run in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_exclusion is null or v_reason is null or v_reason = '' or pg_catalog.length(v_reason) > 2000 then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select x.profile_id into v_profile from public.consumption_exclusions x where x.id = p_exclusion;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exclusions:' || v_profile::text, 0));
  select * into v_row from public.consumption_exclusions x where x.id = p_exclusion for update;
  if v_row.profile_id = private.actor_id() then
    return '{"outcome": "self"}'::jsonb;
  end if;
  if private.actor_earns_in(array[v_row.period_id]) then
    return '{"outcome": "conflict"}'::jsonb;
  end if;
  if v_row.revoked_at is not null then
    return '{"outcome": "already_revoked"}'::jsonb;
  end if;
  if not v_row.period_id = any (array(select private.rollup_window())) then
    return '{"outcome": "outside_window"}'::jsonb;
  end if;
  update public.consumption_exclusions x
  set revoked_at = pg_catalog.now(), revoked_by = private.actor_id(), revoke_reason = v_reason
  where x.id = p_exclusion;
  perform private.mark_pairs_for(v_row.profile_id, v_row.period_id, v_row.lesson_id, v_row.playback_session_id);
  return '{"outcome": "revoked"}'::jsonb;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Retener y soltar (t605_liquidaciones): no la liquidación de su maestro.

create or replace function private.hold_payout(p_payout uuid, p_reason text, p_seen text, p_alert uuid default null) returns jsonb
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
  if private.actor_owns_teacher(y.teacher_id) then
    return '{"outcome": "self"}'::jsonb;
  end if;
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

-- ---------------------------------------------------------------------------------------
-- Bonos y ajustes (t603_liberar): no los de su maestro.

create or replace function private.capture_bonus(p_teacher uuid, p_kind text, p_amount bigint, p_period public.period_id, p_reason text)
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
  if private.actor_owns_teacher(p_teacher) then
    return '{"outcome": "self"}'::jsonb;
  end if;
  select pg_catalog.min(t.effective_period_id) into v_launch from public.pool_tiers t where t.canceled_at is null;
  if v_launch is null or p_period < v_launch then
    return '{"outcome": "before_launch"}'::jsonb;
  end if;
  -- Un mes sin fila más allá de un año no se abre por un bono: es un error de captura.
  if p_period > private.period_plus(private.period_of(pg_catalog.now()), 12)
     and not exists (select 1 from public.payout_periods p where p.period_id = p_period) then
    return '{"outcome": "malformed"}'::jsonb;
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

create or replace function private.capture_adjustment(p_teacher uuid, p_origin public.period_id, p_amount bigint, p_reason text,
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
  if private.actor_owns_teacher(p_teacher) then
    return '{"outcome": "self"}'::jsonb;
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

create or replace function private.confirm_founder_bonus(p_bonus uuid) returns jsonb
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
  if private.actor_owns_teacher(b.teacher_id) then
    return '{"outcome": "self"}'::jsonb;
  end if;
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

create or replace function private.void_bonus(p_bonus uuid, p_reason text) returns jsonb
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
  if private.actor_owns_teacher(b.teacher_id) then
    return '{"outcome": "self"}'::jsonb;
  end if;
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

-- ---------------------------------------------------------------------------------------
-- Dar una capacidad (t105_invitaciones): no a sí mismo.

create or replace function private.grant_capability(p_profile uuid, p_capability public.capability) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_status public.profile_status;
begin
  perform private.team_lock();
  v_gate := private.team_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  if p_capability is null then
    return 'invalid';
  end if;
  if p_profile = private.actor_id() then
    return 'self';
  end if;
  select p.status into v_status from public.profiles p where p.id = p_profile for no key update;
  if not found or v_status <> 'active' then
    return 'ineligible';
  end if;
  if not exists (select 1 from private.admin_factors f where f.profile_id = p_profile) then
    return 'not_member';
  end if;
  if exists (
      select 1 from public.admin_capabilities c
      where c.profile_id = p_profile and c.capability = p_capability and c.revoked_at is null) then
    return 'already_has';
  end if;
  insert into public.admin_capabilities (profile_id, capability, granted_by)
  values (p_profile, p_capability, private.actor_id());
  return 'granted';
end
$$;

-- ---------------------------------------------------------------------------------------
-- La lectura de PA-81 (t605_liquidaciones): cada fila dice si es la liquidación de quien lee.

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
                 as subtotal_cents
        from pg_catalog.jsonb_array_elements(v_preview -> 'rows') r
        left join public.payouts y on y.id = (r ->> 'payout_id')::uuid
        left join public.published_teachers pt on pt.teacher_id = (r ->> 'teacher_id')::uuid
        where v_unreleased or y.id is not null) z), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------------------
-- El área `teachers` del vigilante (carril A): los ayudantes, y que cada función nombre su comprobación.

create or replace function private.schema_violations_teachers()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  teacher_functions (signature, definer, callers) as (
    values ('private.current_active_teacher_id()', true, array[]::text[]),
           -- Un disparador: no se mira quién lo ejecuta (no hace nada fuera de su tabla), sí que no sea definer.
           ('private.guard_publication()', false, null::text[]),
           ('private.teacher_invitation_lock()', true, array[]::text[]),
           ('private.teacher_name_ok(text)', false, array[]::text[]),
           ('private.teacher_notice_pending(uuid)', true, array[]::text[]),
           ('private.place_teacher_invitation(uuid, text, text, uuid)', true, array[]::text[]),
           ('private.teacher_inviter_ok(uuid)', true, array[]::text[]),
           ('private.system_invite_teacher(uuid, text)', false, array[]::text[]),
           ('private.teacher_change_lock(uuid)', true, array[]::text[]),
           ('private.actor_owns_teacher(uuid)', true, array[]::text[]),
           ('private.actor_earns_in(public.period_id[])', true, array[]::text[]),
           ('private.invite_teacher(text, text)', true, array['app_service']),
           ('private.reinvite_teacher(uuid)', true, array['app_service']),
           ('private.revoke_teacher_invitation(uuid)', true, array['app_service']),
           ('private.accept_teacher_invitation(text, uuid, uuid, inet, text)', true, array['app_service']),
           ('private.teacher_standing(text)', true, array['app_service']),
           ('private.teacher_roster()', true, array['app_service']),
           ('private.set_teacher_founder(uuid, date)', true, array['app_service']),
           ('private.suspend_teacher(uuid, text, text)', true, array['app_service']),
           ('private.lift_teacher_suspension(uuid)', true, array['app_service']),
           ('private.propose_fraud_suspension(uuid, text)', true, array['app_service']),
           ('private.withdraw_fraud_suspension(uuid)', true, array['app_service']),
           ('private.decide_fraud_suspension(uuid, boolean, text, text)', true, array['app_service']),
           ('private.fraud_suspension_queue()', true, array['app_service'])),
  teacher_tables (relname) as (
    values ('private.teacher_invitations'::regclass), ('private.teacher_suspension_requests'::regclass)),
  -- «Una viva por maestro y por correo», «se acepta una vez» y «una pendiente por maestro».
  teacher_indexes (relname, name) as (
    values ('private.teacher_invitations'::regclass, 'teacher_invitations_live_teacher_uq'),
           ('private.teacher_invitations'::regclass, 'teacher_invitations_live_email_uq'),
           ('private.teacher_invitations'::regclass, 'teacher_invitations_accepted_teacher_uq'),
           ('private.teacher_suspension_requests'::regclass, 'teacher_suspension_requests_one_pending_uq'),
           ('private.teacher_suspension_requests'::regclass, 'teacher_suspension_requests_alert_uq')),
  found as (
    select f.signature, f.definer, f.callers, p.oid, p.proname, p.prosecdef, p.proconfig, p.provolatile, p.proowner
    from teacher_functions f
    join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(f.signature))
  select 'teachers function missing', f.signature
  from teacher_functions f
  where not exists (select 1 from found where found.signature = f.signature)
  union all
  select 'teachers function executable by ' || r.rolname, found.oid::regprocedure::text
  from app_roles r cross join found
  where found.callers is not null
    and pg_catalog.has_function_privilege(r.rolname::name, found.oid, 'EXECUTE')
    and not r.rolname = any (found.callers)
  union all
  select 'teachers function not executable by ' || c, found.oid::regprocedure::text
  from found cross join unnest(found.callers) c
  where not pg_catalog.has_function_privilege(c::name, found.oid, 'EXECUTE')
  union all
  select 'teachers function security definer or without fixed search_path', found.oid::regprocedure::text
  from found
  where (found.prosecdef and not found.definer)
     or not coalesce(found.proconfig, '{}') @> array['search_path=""']
  union all
  select 'teachers function not security definer', found.oid::regprocedure::text
  from found
  where found.definer and not found.prosecdef
  union all
  -- Toman la fila del maestro: una función estable no puede.
  select 'teachers function not volatile', found.oid::regprocedure::text
  from found
  where found.proname in ('current_active_teacher_id', 'teacher_change_lock') and found.provolatile <> 'v'
  union all
  select 'teachers function not owned by the table owner', found.oid::regprocedure::text
  from found
  where found.definer
    and found.proowner <> (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.teachers'::regclass)
  union all
  -- Las tablas privadas: con seguridad de filas, sin permisos para la aplicación y con su auditoría.
  select 'teachers table without row level security', x.relname::text
  from teacher_tables x join pg_catalog.pg_class c on c.oid = x.relname
  where not c.relrowsecurity
  union all
  select 'teachers table privilege for ' || r.rolname, x.relname::text
  from teacher_tables x cross join app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, x.relname, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     or pg_catalog.has_any_column_privilege(r.rolname::name, x.relname, 'SELECT, INSERT, UPDATE, REFERENCES')
  union all
  select 'teachers unique index missing: ' || x.name, x.relname::text
  from teacher_indexes x
  where not exists (
    select 1 from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
    where i.indrelid = x.relname and c.relname = x.name and i.indisunique and i.indisvalid)
  union all
  select 'teachers audit trigger missing or disabled: ' || a.tgname, a.relname::text
  from (values ('private.teacher_invitations'::regclass, 'audit_changes'),
               ('private.teacher_suspension_requests'::regclass, 'audit_changes'),
               ('public.teachers'::regclass, 'audit_founder')) a (relname, tgname)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    where tg.tgrelid = a.relname and tg.tgname = a.tgname
      and tg.tgenabled in ('O', 'A') and p.proname = 'audit_row_change'
      and p.pronamespace = 'private'::regnamespace)
  union all
  -- La auditoría del fundador, como dinero y después de cambiar esas dos columnas.
  select 'teachers founder audit not as money after update', 'public.teachers'
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'public.teachers'::regclass and tg.tgname = 'audit_founder'
      and (tg.tgtype & 31) = 17
      and pg_catalog.pg_get_triggerdef(tg.oid) like '%AFTER UPDATE OF is_founder, founder_since ON public.teachers%'
      and pg_catalog.pg_get_triggerdef(tg.oid) like '%audit_row_change(''money''%')
  union all
  -- La marca del fundador y la suspensión mueven dinero y acceso: ningún rol de la aplicación escribe maestros.
  select 'teachers table writable by ' || r.rolname, 'public.teachers'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.teachers', 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.teachers', 'DELETE, TRUNCATE')
  union all
  -- Los dos candados de la fila del maestro se excluyen entre sí: cambiarlo y escribir a su nombre van uno
  -- tras otro. Sin esto, un suspendido podría enviar un curso a la vez que lo suspenden.
  select 'teachers lock changed: ' || l.name, 'private.' || l.name
  from (values ('teacher_change_lock', '%from public.teachers t where t.id = p_teacher for no key update%'),
               ('current_active_teacher_id', '%for share of t%')) l (name, pattern)
  where not exists (
    select 1 from found
    where found.proname = l.name and pg_catalog.pg_get_functiondef(found.oid) like l.pattern)
  union all
  -- Nadie actúa sobre sí: cada función de finanzas y del equipo que actúa sobre una persona nombra su comprobación.
  select 'teachers self rule missing: ' || s.signature, s.signature
  from (values ('private.review_alert(uuid, text, boolean, text)', '%actor_owns_teacher(v_row.teacher_id)%'),
               ('private.exclude_consumption(public.exclusion_scope, public.period_id, uuid, uuid, uuid, integer, integer, text, text, uuid)', '%actor_earns_in(v_periods)%'),
               ('private.revoke_exclusion(uuid, text)', '%actor_earns_in(array[v_row.period_id])%'),
               ('private.hold_payout(uuid, text, text, uuid)', '%actor_owns_teacher(y.teacher_id)%'),
               ('private.unhold_payout(uuid, text, text)', '%actor_owns_teacher(y.teacher_id)%'),
               ('private.capture_bonus(uuid, text, bigint, public.period_id, text)', '%actor_owns_teacher(p_teacher)%'),
               ('private.capture_adjustment(uuid, public.period_id, bigint, text, uuid)', '%actor_owns_teacher(p_teacher)%'),
               ('private.confirm_founder_bonus(uuid)', '%actor_owns_teacher(b.teacher_id)%'),
               ('private.void_bonus(uuid, text)', '%actor_owns_teacher(b.teacher_id)%'),
               ('private.grant_capability(uuid, public.capability)', '%p_profile = private.actor_id()%')) s (signature, pattern)
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(s.signature)) like s.pattern, false)
  union all
  -- Lo de adentro de una suspensión no lo lee el maestro.
  select 'teachers suspension column readable by ' || r.rolname || ': ' || c.col, 'public.teachers'
  from (values ('anon'), ('authenticated')) r (rolname)
  cross join (values ('suspended_by'), ('suspension_approved_by'), ('suspension_reason')) c (col)
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.teachers', c.col, 'SELECT')
  union all
  select 'teachers trigger missing or disabled: ' || t.tgname, r.relname::text
  -- El de cada fila: por fila (1), antes (2), al insertar (4), al borrar (8) y al cambiar (16). El de
  -- vaciar: por sentencia (sin el 1), antes (2) y al vaciar (32).
  from (values ('public.course_registry'::regclass), ('public.teachers'::regclass)) r (relname)
  cross join (values ('publication_guard', 31, 31), ('publication_no_truncate', 35, 34)) t (tgname, mask, bits)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = r.relname and tg.tgname = t.tgname
      and tg.tgenabled in ('O', 'A') and n.nspname = 'private' and p.proname = 'guard_publication'
      and (tg.tgtype & t.mask) = t.bits)
$$;
revoke all on function private.schema_violations_teachers() from public;

