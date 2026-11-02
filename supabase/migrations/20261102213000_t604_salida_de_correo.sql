-- T-604, primera solicitud: la salida de correo y el aviso de CLABE (CO-27; decisión 7 de Sergio del 2026-11-02). Sin el correo enviado esa CLABE no se abre, y la espera cuenta desde el envío.
-- La fila nace en la misma transacción del cambio, con su llave única y el destinatario fijado al escribir. Enviar es «al menos una vez»: la aplicación reclama, manda y anota, y un duplicado es
-- aceptable. Las direcciones se quitan a los 30 días. La aplicación no toca la tabla: entra por cuatro funciones.
--
-- Decisiones mías sin confirmar: la fecha sale de lo que ya se guardó (la espera es `clabe_effective_from - clabe_changed_at`, así que cambiar el parámetro no mueve nada), diez intentos con diez minutos
-- entre uno y otro, 30 días para quitar las direcciones, y un maestro sin cuenta no deja aviso: esa CLABE no se abre. CO-13, CO-14 y CO-15 usarán esta misma tabla y nunca detienen nada.

create table private.mail_outbox (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  template text not null,
  profile_id uuid references public.profiles (id) on delete set null,
  recipient text,
  params jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  claimed_until timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint mail_outbox_key_unique unique (idempotency_key),
  constraint mail_outbox_key_length check (char_length(idempotency_key) between 1 and 256),
  constraint mail_outbox_template_known check (template in ('CO-27')),
  constraint mail_outbox_attempts_positive check (attempts >= 0),
  constraint mail_outbox_recipient_clean check (recipient is null or recipient = lower(recipient) and recipient ~ '^[^[:space:]@]+@[^[:space:]@]+$')
);
comment on table private.mail_outbox is 'Lo que sale por correo propio. De ella depende que una CLABE rija (`tax_clabe_effective`). Sin cuerpo: se arma al enviar.';
alter table private.mail_outbox enable row level security;
revoke all on table private.mail_outbox from public;
create index mail_outbox_due_idx on private.mail_outbox (created_at) where sent_at is null and failed_at is null;

-- Una vez escrita, solo cambia lo que la salida anota. Lo enviado no se desmarca ni cambia de hora, porque de esa hora cuenta la espera. La dirección solo se va, y se va con la cuenta.
create function private.guard_mail_outbox() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.profile_id is null and old.profile_id is not null then
    new.recipient := null;
    new.params := '{}'::jsonb;
  end if;
  if new.id <> old.id or new.idempotency_key <> old.idempotency_key or new.template <> old.template or new.created_at <> old.created_at
     or (new.profile_id is distinct from old.profile_id and new.profile_id is not null)
     or (new.recipient is distinct from old.recipient and new.recipient is not null)
     or (old.sent_at is not null and new.sent_at is distinct from old.sent_at) then
    raise exception 'mail_outbox only records what happened to the mail' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function private.guard_mail_outbox() from public;
create trigger mail_outbox_guard before update on private.mail_outbox
  for each row execute function private.guard_mail_outbox();
create trigger ledger_no_delete before delete on private.mail_outbox
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.mail_outbox
  for each statement execute function private.reject_mutation();

-- La llave del aviso de una CLABE. Sale del instante y no de su texto: el texto depende de la zona de la sesión.
create function private.clabe_notice_key(p_teacher uuid, p_changed timestamptz) returns text
language sql immutable set search_path = ''
as $$
  select 'CO-27:' || p_teacher::text || ':' || (extract(epoch from p_changed) * 1000000)::bigint::text
$$;
revoke all on function private.clabe_notice_key(uuid, timestamptz) from public;

-- Toda CLABE con fecha deja su aviso. Heredar la misma fecha no manda otro: la llave ya existe. Sin correo no hay aviso, y esa CLABE no se abre.
create function private.queue_clabe_notice() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_profile uuid;
  v_email text;
begin
  if not (pg_catalog.isfinite(new.clabe_changed_at) and pg_catalog.isfinite(new.clabe_effective_from)) then
    return null;
  end if;
  select t.profile_id, pg_catalog.lower(u.email) into v_profile, v_email
  from public.teachers t join auth.users u on u.id = t.profile_id
  where t.id = new.teacher_id;
  if v_email is null then
    return null;
  end if;
  insert into private.mail_outbox (idempotency_key, template, profile_id, recipient, params)
  values (private.clabe_notice_key(new.teacher_id, new.clabe_changed_at), 'CO-27', v_profile, v_email,
          pg_catalog.jsonb_build_object('hours', (extract(epoch from new.clabe_effective_from - new.clabe_changed_at) / 3600)::integer))
  on conflict (idempotency_key) do nothing;
  return null;
end
$$;
revoke all on function private.queue_clabe_notice() from public;
create trigger clabe_notice_queue after insert on private.teacher_tax_profiles
  for each row execute function private.queue_clabe_notice();

-- Desde cuándo rige de verdad. Sin el aviso enviado, nunca (`infinity`). Enviado, el mayor entre la fecha guardada y el envío más la misma espera que se guardó.
create function private.tax_clabe_effective(p_teacher uuid, p_changed timestamptz, p_effective timestamptz) returns timestamptz
language sql stable set search_path = ''
as $$
  select case
    when not (pg_catalog.isfinite(p_changed) and pg_catalog.isfinite(p_effective)) then p_effective
    else coalesce(
      (select greatest(p_effective, m.sent_at + (p_effective - p_changed)) from private.mail_outbox m
       where m.idempotency_key = private.clabe_notice_key(p_teacher, p_changed) and m.sent_at is not null),
      'infinity'::timestamptz)
  end
$$;
revoke all on function private.tax_clabe_effective(uuid, timestamptz, timestamptz) from public;

-- La única definición de si una CLABE rige (`t409_espera_clabe`), ahora con la fecha de verdad: sin aviso, una contraseña o una propuesta siguen contando, porque la espera ni ha empezado.
create or replace function private.tax_clabe_standing(p_teacher uuid, p_changed timestamptz, p_effective timestamptz) returns text
language sql stable set search_path = ''
as $$
  with e as (select private.tax_clabe_effective(p_teacher, p_changed, p_effective) as at)
  select case
    when exists (
        select 1 from private.teacher_suspension_requests r
        where r.teacher_id = p_teacher and r.status = 'confirmed' and r.decided_at > p_changed and r.proposed_at < e.at)
      or exists (
        select 1 from public.teachers t join private.account_password_changes c on c.profile_id = t.profile_id
        where t.id = p_teacher and c.changed_at > p_changed and c.changed_at < e.at) then 'dead'
    when exists (
        select 1 from private.teacher_suspension_requests r
        where r.teacher_id = p_teacher and r.status = 'pending' and r.proposed_at < e.at) then 'held'
    when e.at = 'infinity' and p_effective <> 'infinity' then 'notice_pending'
    when pg_catalog.now() < e.at then 'waiting'
    else 'in_force'
  end
  from e
$$;

create or replace function private.tax_profile_state() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.actor_teacher_id();
  v_version integer;
  v_at timestamptz;
  v_changed timestamptz;
  v_effective timestamptz;
  v_real timestamptz;
  v_pending boolean;
begin
  if v_teacher is null then
    return '{"outcome": "not_teacher"}'::jsonb;
  end if;
  select x.version, x.created_at, x.clabe_changed_at, x.clabe_effective_from into v_version, v_at, v_changed, v_effective from private.teacher_tax_profiles x
  where x.teacher_id = v_teacher order by x.version desc limit 1;
  v_real := private.tax_clabe_effective(v_teacher, v_changed, v_effective);
  -- Sin el aviso no hay fecha que decir. Una fila sin sus fechas sigue contestando la suya, que la aplicación no puede leer: «no se supo».
  v_pending := v_version is not null and v_real = 'infinity' and v_effective <> 'infinity' and private.tax_clabe_standing(v_teacher, v_changed, v_effective) <> 'dead';
  return pg_catalog.jsonb_build_object(
    'outcome', 'ok', 'version', coalesce(v_version, 0), 'updated_at', v_at,
    -- Con una propuesta pendiente dice lo mismo que sin ella: la fecha, y cuando pasa, nada.
    'clabe_waits_until', case when v_version is not null and not v_pending and pg_catalog.now() < v_real and private.tax_clabe_standing(v_teacher, v_changed, v_effective) <> 'dead' then v_real end,
    'clabe_notice_pending', coalesce(v_pending, false),
    'clabe_recapture', v_version is not null and private.tax_clabe_standing(v_teacher, v_changed, v_effective) = 'dead',
    'can_save', exists (select 1 from public.teachers t where t.id = v_teacher and (t.status = 'active' or t.suspension_approved_by is null)));
end
$$;

create or replace function private.tax_profile_for_payout(p_payout uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_teacher uuid;
  p private.teacher_tax_profiles;
  v_standing text;
begin
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  select y.teacher_id into v_teacher from public.payouts y where y.id = p_payout;
  if v_teacher is null then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if private.actor_owns_teacher(v_teacher) then
    return '{"outcome": "self"}'::jsonb;
  end if;
  select x.* into p from private.teacher_tax_profiles x where x.teacher_id = v_teacher order by x.version desc limit 1;
  if p.id is null then
    return '{"outcome": "no_profile"}'::jsonb;
  end if;
  -- Antes de la auditoría: sin datos, no hay lectura.
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
  insert into public.audit_log (actor_id, actor_kind, category, action, entity_table, entity_id, new_value, reason, request_id)
  values (private.actor_id(), 'user', 'privacy', 'tax_profile.read', 'private.teacher_tax_profiles', p.id::text, pg_catalog.jsonb_build_object('teacher_id', p.teacher_id, 'payout_id', p_payout),
          nullif(pg_catalog.current_setting('app.reason', true), ''),
          nullif(pg_catalog.current_setting('app.request_id', true), ''));
  return private.tax_profile_payload(p);
end
$$;

-- Lo que toca mandar. Cada fila queda apartada diez minutos: si la aplicación se cae a la mitad, otra la vuelve a tomar. Dos a la vez no toman la misma.
create function private.mail_claim(p_limit integer)
returns table (id uuid, idempotency_key text, template text, recipient text, params jsonb, attempt integer)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'mail_claim takes from 1 to 100' using errcode = '22023';
  end if;
  update private.mail_outbox m set failed_at = pg_catalog.clock_timestamp(), claimed_until = null
  where m.sent_at is null and m.failed_at is null and m.attempts >= 10 and (m.claimed_until is null or m.claimed_until <= pg_catalog.clock_timestamp());
  return query
  with due as (
    select m.id from private.mail_outbox m
    where m.sent_at is null and m.failed_at is null and m.recipient is not null and m.attempts < 10
      and (m.claimed_until is null or m.claimed_until <= pg_catalog.clock_timestamp())
    order by m.created_at
    limit p_limit
    for update skip locked)
  update private.mail_outbox m set attempts = m.attempts + 1, claimed_until = pg_catalog.clock_timestamp() + interval '10 minutes'
  from due where m.id = due.id
  returning m.id, m.idempotency_key, m.template, m.recipient, m.params, m.attempts;
end
$$;
revoke all on function private.mail_claim(integer) from public;
grant execute on function private.mail_claim(integer) to app_service;

-- Salió: gana sobre todo, también sobre un intento vencido o un fallo anotado. La hora que vale es la primera.
create function private.mail_sent(p_id uuid) returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  update private.mail_outbox m set sent_at = pg_catalog.clock_timestamp(), claimed_until = null, failed_at = null
  where m.id = p_id and m.sent_at is null;
  return found;
end
$$;
revoke all on function private.mail_sent(uuid) from public;
grant execute on function private.mail_sent(uuid) to app_service;

-- El proveedor dijo que no lo va a mandar nunca. Solo si es el intento que está en curso: uno viejo no le quita la vida a otro.
create function private.mail_rejected(p_id uuid, p_attempt integer) returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
begin
  update private.mail_outbox m set failed_at = pg_catalog.clock_timestamp(), claimed_until = null
  where m.id = p_id and m.sent_at is null and m.failed_at is null and m.attempts = p_attempt;
  return found;
end
$$;
revoke all on function private.mail_rejected(uuid, integer) from public;
grant execute on function private.mail_rejected(uuid, integer) to app_service;

-- Lo que el barrido reporta, sin nombrar a nadie.
create function private.mail_health() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'failed', count(*) filter (where m.sent_at is null and m.failed_at is not null and m.recipient is not null),
    'overdue', count(*) filter (where m.sent_at is null and m.failed_at is null and m.created_at < pg_catalog.now() - interval '1 day'))
  from private.mail_outbox m
$$;
revoke all on function private.mail_health() from public;
grant execute on function private.mail_health() to app_service;

-- Las direcciones no se quedan: a los 30 días de terminar, la fila sigue y la dirección no.
create function private.mail_purge() returns integer
language plpgsql volatile set search_path = ''
as $$
declare
  v_count integer;
begin
  update private.mail_outbox m set recipient = null, params = '{}'::jsonb
  where m.recipient is not null and (m.sent_at < pg_catalog.now() - interval '30 days' or m.failed_at < pg_catalog.now() - interval '30 days');
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke all on function private.mail_purge() from public;
select cron.schedule('mail_purge', '17 8 * * *', 'select private.mail_purge()');

-- El vigilante de la salida de correo. El nombre de la tabla fiscal se arma aquí: el área `tax` cuenta como puerta toda función que lo escriba, y esta no lee nada de ella.
create function private.schema_violations_mail()
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
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_clabe_standing(uuid, timestamptz, timestamptz)')) like '%tax_clabe_effective%notice_pending%', false)
  union all
  select 'finance read without the notice', 'tax_profile_for_payout'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_for_payout(uuid)')) like '%tax_clabe_standing%clabe_notice_pending%audit_log%', false)
  union all
  select 'mail job not scheduled: mail_purge', 'cron.job'
  where not exists (select 1 from cron.job j where j.jobname = 'mail_purge' and j.active)
$$;
revoke all on function private.schema_violations_mail() from public;
