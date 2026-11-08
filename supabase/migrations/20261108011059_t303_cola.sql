-- T-303, tercera solicitud · La cola visible de los avisos (PA-84) y lo que avisa (RF-208, RF-710; plan aprobado por Sergio el 2026-11-07). Tres cosas en la base:
-- lo que agota sus intentos queda fallido al soltarlo (antes esperaba un día, al reclamo once, y nadie lo sabía); finanzas lee la lista y su cuenta; y cada aviso que
-- pasa a fallido le deja un CO-22 a cada persona con finanzas vigente, a lo más uno por hora, con cuántos fallaron y el tipo y la hora del primero (decisiones de
-- Sergio del 2026-11-07). CO-22 lo encola un disparador sobre el paso a fallido, así que lo dejan igual `billing_apply`, terminar, soltar y los dos reclamos, y
-- encolarlo nunca impide que el aviso quede fallido.
--
-- Decisiones mías sin confirmar: la hora cuenta desde el último CO-22 enviado o en camino, y el que espera sale con la primera salida de correo después de esa hora
-- (lo más tarde, el respaldo diario); y la lista suma lo pendiente que lleva más de 30 minutos desde que se recibió.

-- ---------------------------------------------------------------------------------------
-- Soltar el décimo intento lo deja fallido.

create or replace function private.provider_event_release(p_id uuid, p_attempt integer, p_code text) returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_code is null or p_code !~ '^[a-z0-9_]{1,64}$' then
    raise exception 'a released provider event needs its code' using errcode = '22023';
  end if;
  update private.provider_events e set status = case when e.attempts >= 10 then 'failed' else 'pending' end, locked_until = null,
         last_error = case when e.attempts >= 10 then 'attempts_exhausted' else p_code end,
         next_attempt_at = pg_catalog.clock_timestamp() + case e.attempts when 1 then interval '1 minute' when 2 then interval '5 minutes'
                                                                          when 3 then interval '30 minutes' when 4 then interval '2 hours'
                                                                          when 5 then interval '12 hours' else interval '1 day' end
  where e.id = p_id and e.status = 'processing' and e.attempts = p_attempt;
  return found;
end
$$;

-- El reclamo de respaldo dice cuándo lo agotó él (un décimo intento que se cortó sin soltarse), para que la entrega lo reporte.
create or replace function private.provider_event_claim(p_id uuid) returns jsonb
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
    return pg_catalog.jsonb_build_object('outcome', 'finished', 'id', v.id, 'status', 'failed', 'exhausted', true);
  end if;
  update private.provider_events e set status = 'processing', attempts = e.attempts + 1, locked_until = v_now + interval '2 minutes' where e.id = p_id;
  return pg_catalog.jsonb_build_object('outcome', 'claimed', 'id', v.id, 'attempt', v.attempts + 1, 'event_type', v.event_type, 'object_id', v.object_id,
                                       'occurred_at', v.occurred_at);
end
$$;

-- ---------------------------------------------------------------------------------------
-- CO-22 (FL-62 paso 6): un aviso de cobro no se procesó.

alter table private.mail_outbox
  drop constraint mail_outbox_template_known,
  add constraint mail_outbox_template_known check (template in ('CO-27', 'CO-03', 'CO-22'));

-- A cada persona con finanzas vigente y con correo, una fila. Lo que falla mientras su CO-22 todavía no sale (ni se ha reclamado para enviar) se le suma; si no hay,
-- nace otro, que espera hasta una hora después del último enviado o en camino. Cada persona en fila por su candado: dos fallas a la vez no dejan dos. La fila a la que
-- se suma se toma y se vuelve a mirar al escribir: si la salida la reclamó en medio, la falla va en otra, y no en un correo que ya salió sin ella. Lleva el tipo y la
-- hora del primero y cuántos, nunca la cuenta ni montos. Toma cada perfil para compartir su llave (la clave foránea de la salida), después del aviso y de lo que tenga
-- quien lo dejó fallido; espera a `note_session`, que lo toma para escribir, y no se encontró ciclo. Cada persona va en su propio subbloque: si falla para una, las
-- demás reciben el suyo, y el aviso queda fallido igual (lo dice PA-84, y la salud del barrido lo reporta cada día).
create function private.queue_billing_alert() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_person record;
  v_pending uuid;
  v_last timestamptz;
begin
  for v_person in
    select c.profile_id, pg_catalog.lower(u.email) as email
    from public.admin_capabilities c
    join public.profiles p on p.id = c.profile_id and p.status = 'active'
    join auth.users u on u.id = c.profile_id
    where c.capability = 'finance' and c.revoked_at is null and nullif(pg_catalog.btrim(u.email), '') is not null
    order by c.profile_id
  loop
    begin
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('billing_alert:' || v_person.profile_id::text, 0));
      select m.id into v_pending from private.mail_outbox m
      where m.template = 'CO-22' and m.profile_id = v_person.profile_id and m.sent_at is null and m.failed_at is null and m.attempts = 0
      order by m.created_at limit 1
      for update;
      if v_pending is not null then
        update private.mail_outbox m set params = m.params || pg_catalog.jsonb_build_object('count', (m.params ->> 'count')::integer + 1)
        where m.id = v_pending and m.sent_at is null and m.failed_at is null and m.attempts = 0;
        if not found then
          v_pending := null;
        end if;
      end if;
      if v_pending is null then
        select max(coalesce(m.sent_at, m.failed_at, pg_catalog.clock_timestamp())) into v_last from private.mail_outbox m
        where m.template = 'CO-22' and m.profile_id = v_person.profile_id;
        insert into private.mail_outbox (idempotency_key, template, profile_id, recipient, params, claimed_until)
        values ('CO-22:' || v_person.profile_id::text || ':' || new.id::text || ':' || new.revision::text, 'CO-22', v_person.profile_id, v_person.email,
                pg_catalog.jsonb_build_object('count', 1, 'first_type', new.event_type, 'first_at', new.occurred_at),
                case when v_last > pg_catalog.clock_timestamp() - interval '1 hour' then v_last + interval '1 hour' end)
        on conflict on constraint mail_outbox_key_unique do nothing;
      end if;
    exception when others then
      raise warning 'CO-22 no se pudo encolar para el aviso % a una persona de finanzas: %', new.id, sqlstate;
    end;
  end loop;
  return null;
end
$$;
revoke all on function private.queue_billing_alert() from public;
create trigger provider_events_alert after update of status on private.provider_events
  for each row when (old.status is distinct from 'failed' and new.status = 'failed')
  execute function private.queue_billing_alert();

-- ---------------------------------------------------------------------------------------
-- Lo que lee finanzas.

-- PA-84: nulo si quien actúa no pasa la puerta del equipo con finanzas (como `private.finance_alerts()`); si no, si su código es reciente, cuántos hay y hasta 100:
-- lo fallido, lo que espera a T-307 y lo pendiente que lleva más de 30 minutos desde que se recibió. Lo fallido va primero, que es lo que pide acción: lo que espera a
-- T-307 se acumula y no lo deja fuera. Cada grupo, del más viejo al más nuevo en Stripe. Por fila, lo que la
-- pantalla muestra, la revisión que lleva cada acción y si es el aviso del pago propio. Nunca la nota de quien resolvió ni quién fue.
create function private.provider_events_list() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.actor_id() is null or not private.actor_has_capability('finance') then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.finance_change_gate() is null,
    'total', (select pg_catalog.count(*) from private.provider_events e
              where e.status in ('failed', 'deferred')
                 or (e.status in ('pending', 'processing') and e.received_at < pg_catalog.now() - interval '30 minutes')),
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', v.id, 'revision', v.revision, 'provider_event_id', v.provider_event_id, 'event_type', v.event_type, 'livemode', v.livemode,
               'object_id', v.object_id, 'occurred_at', v.occurred_at, 'received_at', v.received_at, 'status', v.status, 'attempts', v.attempts,
               'next_attempt_at', v.next_attempt_at, 'last_error', v.last_error,
               'is_self', coalesce(v.profile_id = private.actor_id() or private.provider_event_owner(v.object_id) = private.actor_id(), false))
             order by v.status <> 'failed', v.occurred_at, v.id)
      from (select e.* from private.provider_events e
            where e.status in ('failed', 'deferred')
               or (e.status in ('pending', 'processing') and e.received_at < pg_catalog.now() - interval '30 minutes')
            order by e.status <> 'failed', e.occurred_at, e.id limit 100) v), '[]'::jsonb));
end
$$;
revoke all on function private.provider_events_list() from public;
grant execute on function private.provider_events_list() to app_service;

-- La tarjeta del inicio de administración: cuántos fallidos, que es lo que pide acción. Nulo sin finanzas.
create function private.provider_events_count() returns integer
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.actor_id() is null or not private.actor_has_capability('finance') then
    return null;
  end if;
  return (select pg_catalog.count(*)::integer from private.provider_events e where e.status = 'failed');
end
$$;
revoke all on function private.provider_events_count() from public;
grant execute on function private.provider_events_count() to app_service;

-- ---------------------------------------------------------------------------------------
-- El vigilante de los avisos (carril A), con las puertas nuevas, el disparador de CO-22 y la lista entre lo que mira «sobre sí».

create or replace function private.schema_violations_billing()
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
           ('provider_events_health', 'private.provider_events_health()'),
           ('provider_events_list', 'private.provider_events_list()'),
           ('provider_events_count', 'private.provider_events_count()')),
  helpers (name, signature) as (
    values ('billing_state', 'private.billing_state(text, boolean)'), ('billing_plan', 'private.billing_plan(text, integer)'),
           ('billing_instant', 'private.billing_instant(text)'), ('billing_snapshot_ok', 'private.billing_snapshot_ok(jsonb)'),
           ('billing_payment_ok', 'private.billing_payment_ok(jsonb)'), ('billing_failure_ok', 'private.billing_failure_ok(jsonb)'),
           ('guard_provider_event', 'private.guard_provider_event()'), ('billing_event_kind', 'private.billing_event_kind(text)'),
           ('provider_event_owner', 'private.provider_event_owner(text)'), ('queue_billing_alert', 'private.queue_billing_alert()'))
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
               ('ledger_no_truncate', 'private.provider_settlements', '%reject_mutation%')) t (name, table_name, pattern)
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
  select 'charge without its event key', 'public.charges'
  where not exists (select 1 from pg_catalog.pg_constraint c
                    where c.conrelid = 'public.charges'::regclass and c.conname = 'charges_event_fk' and c.contype = 'f'
                      and c.confrelid = 'private.provider_events'::regclass)
$$;
revoke all on function private.schema_violations_billing() from public;
