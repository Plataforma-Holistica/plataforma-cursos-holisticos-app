-- T-401 · El aviso del maestro al escribir, «sobre sí» con la invitación propia y las dos firmas del fraude
-- (decisiones de Sergio del 2026-10-30; hallazgos de la revisión del diseño de las pantallas).
--   · Con el aviso de privacidad del maestro pendiente, la base no deja escribir a su nombre: una pestaña abierta no
--     sigue guardando. A un suspendido nunca se le pide (ya no llega aquí) y al levantarlo se le pide.
--   · El maestro de una invitación al correo propio cuenta como propio, aunque todavía no tenga cuenta atada y
--     aunque la hayan revocado: nadie se marca fundador antes de aceptar, ni entre que se la revocan y se la reenvían.
--     La lista de PA-65 lo dice en `is_self`.
--   · Una suspensión por fraude no la confirma quien marcó la alerta como fraude, ni quien la propuso (`proposer`).
--     La cola de PA-66 dice quién la marcó (`marked_by_self`), para no ofrecerle confirmar.
--   · La lista de PA-65 dice si el código es reciente (`fresh_code`), como las de prácticas y de revisión.

-- ---------------------------------------------------------------------------------------
-- El maestro activo: sin el aviso pendiente. Lo demás, como en t401_maestro_activo.

create or replace function private.current_active_teacher_id() returns uuid
language sql volatile security definer set search_path = ''
as $$
  select t.id
  from public.teachers t
  join public.profiles p on p.id = t.profile_id
  where t.profile_id = private.actor_id() and t.status = 'active' and p.status = 'active'
    and not private.teacher_notice_pending(t.profile_id)
  for share of t
$$;

-- ---------------------------------------------------------------------------------------
-- ¿Es ese maestro el de quien actúa? Su cuenta atada, o una invitación a su correo en cualquier estado: caducada o
-- revocada, reenviarla la revive, porque el correo de un maestro se fija con la primera.

create or replace function private.actor_owns_teacher(p_teacher uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.actor_id() is not null
     and (exists (select 1 from public.teachers t where t.id = p_teacher and t.profile_id = private.actor_id())
          or exists (select 1 from private.teacher_invitations i
                     join auth.users u on u.id = private.actor_id() and pg_catalog.lower(u.email) = i.email
                     where i.teacher_id = p_teacher))
$$;

-- ---------------------------------------------------------------------------------------
-- El fundador y suspender, con esa misma comprobación.

create or replace function private.set_teacher_founder(p_teacher uuid, p_since date) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_row public.teachers;
  v_current public.period_id;
  v_month_start date;
  v_from public.period_id;
begin
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  v_row := private.teacher_change_lock(p_teacher);
  if v_row.id is null then
    return 'not_found';
  end if;
  if private.actor_owns_teacher(p_teacher) then
    return 'self';
  end if;
  if v_row.founder_since is not distinct from p_since then
    return 'unchanged';
  end if;

  v_current := private.period_of(pg_catalog.clock_timestamp());
  v_month_start := pg_catalog.make_date(v_current / 100, v_current % 100, 1);
  if p_since is not null and p_since < v_month_start then
    return 'too_early';
  end if;
  -- Ya fundador: fijo si algún periodo desde su mes y hasta hoy salió de abierto.
  if v_row.founder_since is not null then
    v_from := (pg_catalog.date_part('year', v_row.founder_since)::integer * 100
               + pg_catalog.date_part('month', v_row.founder_since)::integer)::public.period_id;
    if exists (
        select 1
        from pg_catalog.generate_series(
               pg_catalog.make_date(v_from / 100, v_from % 100, 1), v_month_start, interval '1 month') as m (month)
        where private.period_status_of(
                (pg_catalog.date_part('year', m.month)::integer * 100 + pg_catalog.date_part('month', m.month)::integer)::public.period_id)
              <> 'open') then
      return 'locked';
    end if;
  end if;

  update public.teachers t set is_founder = p_since is not null, founder_since = p_since where t.id = p_teacher;
  return case when p_since is null then 'cleared' else 'set' end;
end
$$;

create or replace function private.suspend_teacher(p_teacher uuid, p_reason text, p_notice text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_row public.teachers;
  v_reason text := pg_catalog.btrim(p_reason);
  v_notice text := pg_catalog.btrim(p_notice);
begin
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  v_row := private.teacher_change_lock(p_teacher);
  if v_row.id is null then
    return 'not_found';
  end if;
  if private.actor_owns_teacher(p_teacher) then
    return 'self';
  end if;
  if v_reason is null or v_reason = '' or pg_catalog.length(v_reason) > 1000
     or v_notice is null or v_notice = '' or pg_catalog.length(v_notice) > 300 then
    return 'invalid';
  end if;
  if v_row.status = 'suspended' then
    return 'already_suspended';
  end if;
  if v_row.status <> 'active' then
    return 'not_active';
  end if;
  update public.teachers t
  set status = 'suspended', suspended_at = pg_catalog.clock_timestamp(), suspended_by = private.actor_id(),
      suspension_approved_by = null, suspension_reason = v_reason, suspension_notice = v_notice
  where t.id = p_teacher;
  return 'suspended';
end
$$;

-- ---------------------------------------------------------------------------------------
-- Decidir una propuesta de fraude: tampoco quien marcó la alerta. Para una marcada antes, cuenta quien la revisó.

create or replace function private.decide_fraud_suspension(p_request uuid, p_confirm boolean, p_note text, p_notice text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_teacher uuid;
  v_request private.teacher_suspension_requests;
  v_row public.teachers;
  v_actor uuid := private.actor_id();
  v_note text := nullif(pg_catalog.btrim(p_note), '');
  v_notice text := nullif(pg_catalog.btrim(p_notice), '');
  v_now timestamptz;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'teacher changes need read committed isolation' using errcode = '25000';
  end if;
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  select r.teacher_id into v_teacher from private.teacher_suspension_requests r where r.id = p_request;
  v_row := private.teacher_change_lock(v_teacher);
  select r.* into v_request from private.teacher_suspension_requests r where r.id = p_request;
  if v_request.id is null or v_request.status <> 'pending' or p_confirm is null then
    return 'not_found';
  end if;
  if v_row.profile_id is not distinct from v_actor then
    return 'self';
  end if;
  if v_request.proposed_by = v_actor or exists (
      select 1 from public.anomaly_alerts a
      where a.id = v_request.anomaly_alert_id and coalesce(a.fraud_marked_by, a.reviewed_by) = v_actor) then
    return 'proposer';
  end if;
  if pg_catalog.length(coalesce(v_note, '')) > 4000
     or (p_confirm and (v_notice is null or pg_catalog.length(v_notice) > 300)) then
    return 'invalid';
  end if;
  v_now := pg_catalog.clock_timestamp();
  if p_confirm then
    if v_row.status not in ('active', 'suspended') then
      return 'not_active';
    end if;
    -- Sobre una suspensión a mano, queda la de fraude desde que se suspendió.
    update public.teachers t
    set status = 'suspended', suspended_at = coalesce(t.suspended_at, v_now), suspended_by = v_request.proposed_by,
        suspension_approved_by = v_actor, suspension_reason = v_request.reason, suspension_notice = v_notice
    where t.id = v_row.id;
  end if;
  update private.teacher_suspension_requests r
  set status = case when p_confirm then 'confirmed' else 'rejected' end::public.suspension_request_status,
      decided_by = v_actor, decided_at = v_now, decision_note = v_note
  where r.id = p_request;
  return case when p_confirm then 'confirmed' else 'rejected' end;
end
$$;

-- ---------------------------------------------------------------------------------------
-- La lista de PA-65: si el código es reciente, y cuál es el maestro de quien lee, también por su invitación.

create or replace function private.teacher_roster() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if v_actor is null or not private.actor_has_capability('content') then
    return null;
  end if;
  return pg_catalog.jsonb_build_object('fresh_code', private.content_change_gate() is null, 'teachers', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'teacher_id', t.id,
             'display_name', p.display_name,
             'slug', p.slug,
             'status', t.status,
             'is_founder', t.is_founder,
             'founder_since', t.founder_since,
             'email', coalesce(pg_catalog.lower(u.email), l.email),
             'invitation', case
                             when l.id is null then 'none'
                             when l.accepted_at is not null then 'accepted'
                             when l.revoked_at is not null then 'revoked'
                             when l.expires_at <= v_now then 'expired'
                             else 'pending'
                           end,
             'invited_at', l.created_at,
             'expires_at', l.expires_at,
             'suspension', case
                             when t.status <> 'suspended' then null
                             when t.suspension_approved_by is not null then 'fraud'
                             else 'manual'
                           end,
             'suspended_at', t.suspended_at,
             'suspension_reason', t.suspension_reason,
             'suspension_notice', t.suspension_notice,
             'fraud_pending', exists (
               select 1 from private.teacher_suspension_requests r where r.teacher_id = t.id and r.status = 'pending'),
             'is_self', private.actor_owns_teacher(t.id))
           order by p.display_name, t.id)
    from public.teachers t
    left join public.published_teachers p on p.teacher_id = t.id
    left join auth.users u on u.id = t.profile_id
    left join lateral (
      select i.* from private.teacher_invitations i
      where i.teacher_id = t.id order by i.created_at desc limit 1) as l on true), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------------------
-- La cola de PA-66, con quién marcó la alerta. Lo demás, como en t401_fundador_y_suspension.

create or replace function private.fraud_suspension_queue() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
begin
  if v_actor is null or not (private.actor_has_capability('content') or private.actor_has_capability('finance')) then
    return null;
  end if;
  return pg_catalog.jsonb_build_object('requests', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'request_id', r.id,
             'teacher_id', r.teacher_id,
             'display_name', p.display_name,
             'teacher_status', t.status,
             'reason', r.reason,
             'proposed_at', r.proposed_at,
             'proposed_by_self', r.proposed_by = v_actor,
             'marked_by_self', coalesce(a.fraud_marked_by, a.reviewed_by) is not distinct from v_actor,
             'about_self', t.profile_id is not distinct from v_actor,
             'alert_period', a.period_id,
             'alert_metric', a.metric_value,
             'alert_threshold', a.threshold_value)
           order by r.proposed_at, r.id)
    from private.teacher_suspension_requests r
    join public.teachers t on t.id = r.teacher_id
    left join public.published_teachers p on p.teacher_id = r.teacher_id
    join public.anomaly_alerts a on a.id = r.anomaly_alert_id
    where r.status = 'pending'), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------------------
-- El área `teachers` del vigilante: suma estas comprobaciones.

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
               ('private.grant_capability(uuid, public.capability)', '%p_profile = private.actor_id()%'),
               ('private.set_teacher_founder(uuid, date)', '%actor_owns_teacher(p_teacher)%'),
               ('private.suspend_teacher(uuid, text, text)', '%actor_owns_teacher(p_teacher)%'),
               ('private.current_active_teacher_id()', '%teacher_notice_pending%'),
               ('private.decide_fraud_suspension(uuid, boolean, text, text)', '%fraud_marked_by%')) s (signature, pattern)
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

