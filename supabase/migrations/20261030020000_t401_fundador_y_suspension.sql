-- T-401, tercera solicitud · El fundador, la suspensión y el fraude (RF-104, RF-702, RN-12, RN-17, FL-46,
-- FL-64; esquema §6.2).
--
-- Decisiones de Sergio del 2026-10-29:
--   · el fundador lo marca Contenido, sin fecha atrás;
--   · suspender lo hace una persona con Contenido, salvo por fraude: lo propone finanzas, con una alerta
--     de salto de puntos de ese maestro decidida como fraude, y lo confirma otra persona con Contenido;
--   · una suspensión por fraude la levanta una persona con Contenido que no la propuso;
--   · alguien del equipo puede ser maestro, pero nunca actúa sobre sí. Aquí eso alcanza también a aprobar
--     un curso propio (hallazgo de la revisión de la 81).
--
-- Decisiones mías sin confirmar:
--   · «sin fecha atrás» es: el mes de la fecha es el mes en curso o uno posterior (el del mes en curso
--     siempre está abierto). Quitar la marca o mover su fecha solo mientras ningún periodo desde el mes de la marca haya
--     salido de abierto; después queda fija y se contesta `locked` (se corrige con OP-02). Así nadie alarga
--     la ventana quitando y volviendo a poner, y un cierre no pierde un bono que ya se ensayó;
--   · suspender no toca la cuenta de alumno. Levantar vacía las columnas de la suspensión: la historia
--     queda en la auditoría y en las solicitudes de fraude;
--   · confirmar un fraude sobre una suspensión a mano la convierte en la de fraude, con las dos firmas y
--     su fecha de origen;
--   · las solicitudes son privadas, como las alertas: se leen por `fraud_suspension_queue()`;
--   · los cambios del fundador se auditan además como dinero.
--
-- El candado: la fila del maestro, tomada para cambiar (`teacher_change_lock`). Escribir un curso a su
-- nombre la toma para compartir (`current_active_teacher_id`), así que suspender y escribir van uno tras
-- otro; ninguna de estas funciones toma otro candado después.

create type public.suspension_request_status as enum ('pending', 'confirmed', 'rejected', 'withdrawn');

-- ---------------------------------------------------------------------------------------
-- Las solicitudes de suspensión por fraude.

create table private.teacher_suspension_requests (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id),
  anomaly_alert_id uuid not null references public.anomaly_alerts (id),
  reason text not null,
  proposed_by uuid not null references public.profiles (id),   -- finanzas, en PA-68
  proposed_at timestamptz not null,
  status public.suspension_request_status not null default 'pending',
  decided_by uuid references public.profiles (id),             -- Contenido, en PA-66; nulo al retirarla
  decided_at timestamptz,
  decision_note text,
  constraint teacher_suspension_requests_decided_consistent check ((status = 'pending') = (decided_at is null)),
  constraint teacher_suspension_requests_decider_consistent
    check ((status in ('confirmed', 'rejected')) = (decided_by is not null)),
  constraint teacher_suspension_requests_two_people check (decided_by is null or decided_by <> proposed_by),
  constraint teacher_suspension_requests_text_lengths check (
    pg_catalog.length(reason) between 1 and 4000 and pg_catalog.length(coalesce(decision_note, '')) <= 4000)
);
comment on table private.teacher_suspension_requests is 'La propuesta de finanzas de suspender a un maestro por fraude y su decisión por otra persona con Contenido (RN-17, FL-64). Solo la escriben las funciones de la suspensión.';

create unique index teacher_suspension_requests_one_pending_uq on private.teacher_suspension_requests (teacher_id)
  where status = 'pending';

alter table private.teacher_suspension_requests enable row level security;
revoke all on private.teacher_suspension_requests from public, anon, authenticated, service_role, app_service;

create trigger audit_changes after insert or update or delete on private.teacher_suspension_requests
  for each row execute function private.audit_row_change('access');

-- El fundador mueve dinero: su cambio queda además como dinero.
create trigger audit_founder after update of is_founder, founder_since on public.teachers
  for each row when (old.is_founder is distinct from new.is_founder or old.founder_since is distinct from new.founder_since)
  execute function private.audit_row_change('money', 'tiebreak_rank');

-- ---------------------------------------------------------------------------------------
-- Piezas internas.

-- Toma la fila del maestro para cambiarla y la devuelve. Nula si no existe.
create function private.teacher_change_lock(p_teacher uuid) returns public.teachers
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.teachers;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'teacher changes need read committed isolation' using errcode = '25000';
  end if;
  select t.* into v_row from public.teachers t where t.id = p_teacher for update;
  return v_row;
end
$$;
revoke all on function private.teacher_change_lock(uuid) from public;

-- ---------------------------------------------------------------------------------------
-- El fundador.
--   forbidden, needs_fresh_code   la puerta de Contenido
--   not_found        no existe ese maestro
--   self             es el maestro de quien actúa
--   unchanged        ya está así
--   too_early        la fecha es de un mes anterior al en curso
--   locked           ya es fundador y algún periodo desde su mes salió de abierto: queda fijo
--   set / cleared
create function private.set_teacher_founder(p_teacher uuid, p_since date) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_row public.teachers;
  v_current public.period_id;
  v_month_start date;
  v_from public.period_id;
begin
  v_row := private.teacher_change_lock(p_teacher);
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  if v_row.id is null then
    return 'not_found';
  end if;
  if v_row.profile_id is not distinct from private.actor_id() then
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
revoke all on function private.set_teacher_founder(uuid, date) from public;
grant execute on function private.set_teacher_founder(uuid, date) to app_service;

-- ---------------------------------------------------------------------------------------
-- Suspender y levantar, a mano: una persona con Contenido.

-- Suspender a un maestro activo, con un motivo de 1 a 1 000 caracteres.
--   forbidden, needs_fresh_code, not_found, self, invalid, already_suspended, not_active, suspended
create function private.suspend_teacher(p_teacher uuid, p_reason text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_row public.teachers;
  v_reason text := pg_catalog.btrim(p_reason);
begin
  v_row := private.teacher_change_lock(p_teacher);
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  if v_row.id is null then
    return 'not_found';
  end if;
  if v_row.profile_id is not distinct from private.actor_id() then
    return 'self';
  end if;
  if v_reason is null or v_reason = '' or pg_catalog.length(v_reason) > 1000 then
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
      suspension_approved_by = null, suspension_reason = v_reason
  where t.id = p_teacher;
  return 'suspended';
end
$$;
revoke all on function private.suspend_teacher(uuid, text) from public;
grant execute on function private.suspend_teacher(uuid, text) to app_service;

-- Levantar una suspensión. Una de fraude (con las dos firmas) no la levanta quien la propuso.
--   forbidden, needs_fresh_code, not_found, self, not_suspended, lifted
create function private.lift_teacher_suspension(p_teacher uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_row public.teachers;
  v_actor uuid := private.actor_id();
begin
  v_row := private.teacher_change_lock(p_teacher);
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  if v_row.id is null then
    return 'not_found';
  end if;
  if v_row.profile_id is not distinct from v_actor
     or (v_row.suspension_approved_by is not null and v_row.suspended_by is not distinct from v_actor) then
    return 'self';
  end if;
  if v_row.status <> 'suspended' then
    return 'not_suspended';
  end if;
  update public.teachers t
  set status = 'active', suspended_at = null, suspended_by = null, suspension_approved_by = null, suspension_reason = null
  where t.id = p_teacher;
  return 'lifted';
end
$$;
revoke all on function private.lift_teacher_suspension(uuid) from public;
grant execute on function private.lift_teacher_suspension(uuid) to app_service;

-- ---------------------------------------------------------------------------------------
-- El fraude: propone finanzas, decide otra persona con Contenido.

-- Proponer la suspensión del maestro de una alerta de salto de puntos decidida como fraude.
--   forbidden, needs_fresh_code      la puerta de finanzas
--   needs_fraud_decision             la alerta no existe, no es de un maestro o no se decidió como fraude
--   invalid                          el motivo falta o pasa de 4 000 caracteres
--   self                             es el maestro de quien propone
--   not_active                       el maestro no está activo ni suspendido
--   already_suspended                ya está suspendido por fraude
--   already_pending                  ya tiene una propuesta pendiente
--   proposed
create function private.propose_fraud_suspension(p_alert uuid, p_reason text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_alert public.anomaly_alerts;
  v_row public.teachers;
  v_reason text := pg_catalog.btrim(p_reason);
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'teacher changes need read committed isolation' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  select a.* into v_alert from public.anomaly_alerts a where a.id = p_alert;
  if v_alert.id is null or v_alert.kind <> 'teacher_points_jump' or v_alert.is_fraud is not true then
    return 'needs_fraud_decision';
  end if;
  if v_reason is null or v_reason = '' or pg_catalog.length(v_reason) > 4000 then
    return 'invalid';
  end if;
  v_row := private.teacher_change_lock(v_alert.teacher_id);
  if v_row.profile_id is not distinct from private.actor_id() then
    return 'self';
  end if;
  if v_row.status = 'suspended' and v_row.suspension_approved_by is not null then
    return 'already_suspended';
  end if;
  if v_row.status not in ('active', 'suspended') then
    return 'not_active';
  end if;
  if exists (
      select 1 from private.teacher_suspension_requests r where r.teacher_id = v_row.id and r.status = 'pending') then
    return 'already_pending';
  end if;
  insert into private.teacher_suspension_requests (teacher_id, anomaly_alert_id, reason, proposed_by, proposed_at)
  values (v_row.id, v_alert.id, v_reason, private.actor_id(), pg_catalog.clock_timestamp());
  return 'proposed';
end
$$;
revoke all on function private.propose_fraud_suspension(uuid, text) from public;
grant execute on function private.propose_fraud_suspension(uuid, text) to app_service;

-- Retirar una propuesta pendiente: solo quien la propuso.
--   forbidden, needs_fresh_code, not_found, not_yours, withdrawn
create function private.withdraw_fraud_suspension(p_request uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_teacher uuid;
  v_request private.teacher_suspension_requests;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'teacher changes need read committed isolation' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  select r.teacher_id into v_teacher from private.teacher_suspension_requests r where r.id = p_request;
  perform private.teacher_change_lock(v_teacher);
  select r.* into v_request from private.teacher_suspension_requests r where r.id = p_request;
  if v_request.id is null or v_request.status <> 'pending' then
    return 'not_found';
  end if;
  if v_request.proposed_by is distinct from private.actor_id() then
    return 'not_yours';
  end if;
  update private.teacher_suspension_requests r
  set status = 'withdrawn', decided_at = pg_catalog.clock_timestamp()
  where r.id = p_request;
  return 'withdrawn';
end
$$;
revoke all on function private.withdraw_fraud_suspension(uuid) from public;
grant execute on function private.withdraw_fraud_suspension(uuid) to app_service;

-- Decidir una propuesta pendiente: confirmar suspende con las dos firmas; rechazar la cierra. Nota
-- opcional de hasta 4 000 caracteres.
--   forbidden, needs_fresh_code      la puerta de Contenido
--   not_found                        no existe o ya no está pendiente
--   self                             quien decide la propuso, o es el maestro
--   invalid                          la nota pasa de 4 000 caracteres
--   not_active                       el maestro ya no está activo ni suspendido (la propuesta sigue)
--   confirmed / rejected
create function private.decide_fraud_suspension(p_request uuid, p_confirm boolean, p_note text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_teacher uuid;
  v_request private.teacher_suspension_requests;
  v_row public.teachers;
  v_actor uuid := private.actor_id();
  v_note text := nullif(pg_catalog.btrim(p_note), '');
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
  if v_request.proposed_by = v_actor or v_row.profile_id is not distinct from v_actor then
    return 'self';
  end if;
  if pg_catalog.length(coalesce(v_note, '')) > 4000 then
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
        suspension_approved_by = v_actor, suspension_reason = v_request.reason
    where t.id = v_row.id;
  end if;
  update private.teacher_suspension_requests r
  set status = case when p_confirm then 'confirmed' else 'rejected' end::public.suspension_request_status,
      decided_by = v_actor, decided_at = v_now, decision_note = v_note
  where r.id = p_request;
  return case when p_confirm then 'confirmed' else 'rejected' end;
end
$$;
revoke all on function private.decide_fraud_suspension(uuid, boolean, text) from public;
grant execute on function private.decide_fraud_suspension(uuid, boolean, text) to app_service;

-- Las propuestas pendientes, para PA-66: Contenido o finanzas, sin código reciente para leer; nulo para
-- los demás. Con la alerta (su periodo y lo medido) y si es de quien lee.
create function private.fraud_suspension_queue() returns jsonb
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
revoke all on function private.fraud_suspension_queue() from public;
grant execute on function private.fraud_suspension_queue() to app_service;

-- ---------------------------------------------------------------------------------------
-- La lista de PA-65, con la suspensión: `suspension` es nula, `manual` o `fraud` (con las dos firmas), y
-- `fraud_pending` dice si hay una propuesta pendiente.

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
  return pg_catalog.jsonb_build_object('teachers', coalesce((
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
             'fraud_pending', exists (
               select 1 from private.teacher_suspension_requests r where r.teacher_id = t.id and r.status = 'pending'),
             'is_self', t.profile_id is not distinct from v_actor)
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
-- Aprobar: lo de T-107, más que nadie aprueba un curso suyo (`self`, después de `not_pending`).

create or replace function private.approve_course(p_course uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_state public.course_state;
  v_practice uuid;
  v_level uuid;
begin
  perform private.catalog_lock('practices');
  perform private.catalog_lock('levels');
  perform private.course_lock(p_course);
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;

  select state into v_state from public.course_registry where course_id = p_course for no key update;
  if v_state is null then
    return 'not_found';
  elsif v_state <> 'in_review' then
    return 'not_pending';
  end if;
  if exists (
      select 1 from public.course_registry c join public.teachers t on t.id = c.teacher_id
      where c.course_id = p_course and t.profile_id = private.actor_id()) then
    return 'self';
  end if;
  select practice_id, level_id into v_practice, v_level from public.published_courses where course_id = p_course;
  if v_practice is null or v_level is null then
    return 'incomplete';
  end if;
  if not exists (select 1 from public.practices where id = v_practice and is_active) then
    return 'practice_inactive';
  end if;
  if not exists (select 1 from public.levels where id = v_level and is_active) then
    return 'level_inactive';
  end if;
  if exists (
    select 1 from public.published_lessons l join public.video_assets v on v.id = l.video_asset_id
    where l.course_id = p_course and l.is_current and v.status <> 'ready') then
    return 'videos_not_ready';
  end if;

  update public.course_registry set state = 'published', first_published_at = coalesce(first_published_at, now())
  where course_id = p_course;
  update public.published_courses set is_listed = true, published_at = now() where course_id = p_course;
  -- Y la ficha de su maestro, si todavía no estaba listada.
  update public.published_teachers set is_listed = true
  where teacher_id = (select teacher_id from public.course_registry where course_id = p_course) and not is_listed;
  return 'approved';
end
$$;

-- ---------------------------------------------------------------------------------------
-- El área `teachers` del vigilante (carril A), con lo de esta solicitud: sus funciones, la tabla de las
-- solicitudes (como la de las invitaciones) y la auditoría del fundador.

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
           ('private.invite_teacher(text, text)', true, array['app_service']),
           ('private.reinvite_teacher(uuid)', true, array['app_service']),
           ('private.revoke_teacher_invitation(uuid)', true, array['app_service']),
           ('private.accept_teacher_invitation(text, uuid, uuid, inet, text)', true, array['app_service']),
           ('private.teacher_standing(text)', true, array['app_service']),
           ('private.teacher_roster()', true, array['app_service']),
           ('private.set_teacher_founder(uuid, date)', true, array['app_service']),
           ('private.suspend_teacher(uuid, text)', true, array['app_service']),
           ('private.lift_teacher_suspension(uuid)', true, array['app_service']),
           ('private.propose_fraud_suspension(uuid, text)', true, array['app_service']),
           ('private.withdraw_fraud_suspension(uuid)', true, array['app_service']),
           ('private.decide_fraud_suspension(uuid, boolean, text)', true, array['app_service']),
           ('private.fraud_suspension_queue()', true, array['app_service'])),
  teacher_tables (relname) as (
    values ('private.teacher_invitations'::regclass), ('private.teacher_suspension_requests'::regclass)),
  -- «Una viva por maestro y por correo», «se acepta una vez» y «una pendiente por maestro».
  teacher_indexes (relname, name) as (
    values ('private.teacher_invitations'::regclass, 'teacher_invitations_live_teacher_uq'),
           ('private.teacher_invitations'::regclass, 'teacher_invitations_live_email_uq'),
           ('private.teacher_invitations'::regclass, 'teacher_invitations_accepted_teacher_uq'),
           ('private.teacher_suspension_requests'::regclass, 'teacher_suspension_requests_one_pending_uq')),
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
