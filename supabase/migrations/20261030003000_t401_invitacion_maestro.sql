-- T-401, segunda solicitud · La invitación del maestro (RF-104, FL-30, CO-10; esquema §6.2).
-- Decisiones de Sergio del 2026-10-29: la invitación llega como la del equipo, sin correo propio ni
-- enlace con token. Contenido invita con nombre y correo; la pantalla dice qué avisarle. La persona
-- se registra con ese correo, o recupera su contraseña, y en ese navegador queda el resguardo del
-- buzón (`private.claim_account`). Al entrar ve PA-40 y acepta el contrato y su aviso de privacidad.
-- Alguien del equipo puede ser maestro, pero nadie actúa sobre sí.
--
-- Lo que cambia respecto al esquema (§5.2, `public.invitations` con token), y por qué: la tabla es
-- privada y sin token, como la del equipo, porque la prueba de que la persona controla el buzón ya
-- existe y no hace falta otro secreto que guardar (decisión mía sin confirmar).
--
-- Decisiones mías sin confirmar:
--   · el correo de un maestro se fija con su primera invitación y reenviar nunca lo cambia. A un
--     maestro que cargó el sistema le pone correo el dueño de la base declarado sistema, no
--     Contenido: así nadie con Contenido se queda con los saldos de un maestro que ya tiene puntos;
--   · sin el contrato y el aviso del maestro vigentes no se invita: nadie recibe una invitación que no
--     podría aceptar;
--   · aceptar no cierra la sesión con la que se acepta (ser maestro no da capacidades ni segundo
--     nivel), pero sí las demás de la cuenta, y gasta el resguardo, como el equipo;
--   · el aviso vuelto a pedir lo exige la guarda del portal (`teacher_standing` contesta
--     `needs_notice`), no `current_active_teacher_id`: es como la guarda de sesión con el alumno.
--
-- El orden de candados: el de las invitaciones de maestro, después la fila de la cuenta y después la
-- del maestro. Reclamar la cuenta toma solo la de la cuenta; escribir un curso, la del maestro para
-- compartir (y un invitado no escribe cursos). No hay ciclo.

-- ---------------------------------------------------------------------------------------
-- La tabla.

create table private.teacher_invitations (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id),
  email text not null,                        -- en minúsculas y sin espacios en los extremos
  profile_id uuid references public.profiles (id),   -- la cuenta, si ya existía al invitar
  invited_by uuid references public.profiles (id),   -- nulo: la puso el dueño de la base
  created_at timestamptz not null,            -- la pone la función con el reloj, no con now()
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references public.profiles (id),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id),   -- nulo: revocación automática o del dueño
  constraint teacher_invitations_email_clean check (email = private.clean_email(email)),
  constraint teacher_invitations_expires_later check (expires_at > created_at),
  constraint teacher_invitations_acceptance_consistent check ((accepted_at is null) = (accepted_by is null)),
  constraint teacher_invitations_one_end check (accepted_at is null or revoked_at is null)
);
comment on table private.teacher_invitations is 'Las invitaciones de maestro (RF-104). Una viva por maestro y por correo. Solo la escriben las funciones de private de la invitación.';

-- Viva: ni aceptada ni revocada. Una caducada sigue viva hasta que alguien reenvía o revoca.
create unique index teacher_invitations_live_teacher_uq on private.teacher_invitations (teacher_id)
  where accepted_at is null and revoked_at is null;
create unique index teacher_invitations_live_email_uq on private.teacher_invitations (email)
  where accepted_at is null and revoked_at is null;
-- Un maestro acepta una sola vez.
create unique index teacher_invitations_accepted_teacher_uq on private.teacher_invitations (teacher_id)
  where accepted_at is not null;

alter table private.teacher_invitations enable row level security;
revoke all on private.teacher_invitations from public, anon, authenticated, service_role, app_service;

create trigger audit_changes after insert or update or delete on private.teacher_invitations
  for each row execute function private.audit_row_change('access');

-- ---------------------------------------------------------------------------------------
-- Piezas internas. Ninguna tiene permisos para nadie de la aplicación.

-- El candado de las invitaciones de maestro: invitar, reenviar, revocar y aceptar van una tras otra.
create function private.teacher_invitation_lock() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'teacher invitations need read committed isolation' using errcode = '25000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('teacher_invitation', 0));
end
$$;
revoke all on function private.teacher_invitation_lock() from public;

-- El nombre de un maestro: como el de una práctica (sin caracteres de control ni invisibles, con
-- letras o cifras para su dirección), hasta 80 caracteres. Ya limpio (NFC y sin espacios en los
-- extremos): quien llama lo limpia.
create function private.teacher_name_ok(p_name text) returns boolean
language sql immutable set search_path = ''
as $$
  select p_name is not null and pg_catalog.char_length(p_name) between 1 and 80 and p_name !~ '[[:cntrl:]]'
     and p_name !~ '[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e007f]'
     and private.catalog_slug(p_name) <> ''
$$;
revoke all on function private.teacher_name_ok(text) from public;

-- ¿Le falta a esta cuenta el aviso de privacidad del maestro vigente? La regla de la guarda de sesión
-- (`src/services/account/gate.ts`): el piso es la versión más alta, entre las que rigen, que pide
-- volver a aceptar, y cuenta el último consentimiento (por hora, después por versión, y en empate el
-- retiro). Sin texto vigente, le falta.
create function private.teacher_notice_pending(p_profile uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.current_legal_document('teacher_privacy_notice') is null
      or coalesce(not (
           l.action = 'granted'
           and (f.floor is null or l.version >= f.floor)), true)
  from (select max(d.version) as floor from public.legal_documents d
        where d.doc_type = 'teacher_privacy_notice' and d.requires_reconsent and d.effective_from <= now()) as f
  left join lateral (
    select d.version, c.action
    from public.consents c
    join public.legal_documents d on d.id = c.legal_document_id
    where c.profile_id = p_profile and d.doc_type = 'teacher_privacy_notice'
    order by c.occurred_at desc, d.version desc, (c.action = 'withdrawn') desc
    limit 1) as l on true
$$;
revoke all on function private.teacher_notice_pending(uuid) from public;

-- Dejar una invitación. La comparten invitar (p_teacher nulo: crea al maestro con p_name), reenviar y
-- el dueño. p_by es quién invita, o nulo si es el dueño de la base. Quien llama ya tomó el candado.
-- No escribe nada antes de rechazar.
--
-- A una cuenta que ya existe no se le toca nada: lo que la protege es que aceptar pide un resguardo
-- posterior a la invitación. La hora se toma, si la cuenta existe, con su fila ya tomada (la misma de
-- `private.claim_account`): un reclamo confirmado antes queda con hora anterior.
create function private.place_teacher_invitation(p_teacher uuid, p_name text, p_email text, p_by uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := private.clean_email(p_email);
  v_name text := pg_catalog.btrim(normalize(p_name, NFC));
  v_days integer;
  v_created timestamptz;
  v_expires timestamptz;
  v_user uuid;
  v_status public.profile_status;
  v_teacher uuid := p_teacher;
  v_slug text;
  v_try text;
  v_n integer := 1;
begin
  if v_email is null or (p_teacher is null and not coalesce(private.teacher_name_ok(v_name), false)) then
    return 'invalid';
  end if;
  if private.current_legal_document('teacher_agreement') is null
     or private.current_legal_document('teacher_privacy_notice') is null then
    raise warning 'no hay contrato o aviso de privacidad del maestro vigente. No se puede invitar.';
    return 'unavailable';
  end if;
  v_days := private.second_factor_limit('VIGENCIA_INVITACION_DIAS');
  if v_days is null then
    raise warning 'falta VIGENCIA_INVITACION_DIAS, o no es un entero de 1 en adelante. No se puede invitar.';
    return 'unavailable';
  end if;
  -- Nadie se invita a sí mismo, ni se reenvía su invitación.
  if p_by is not null and exists (
      select 1 from auth.users u where u.id = p_by and pg_catalog.lower(u.email) = v_email) then
    return 'self';
  end if;

  v_created := pg_catalog.clock_timestamp();
  select u.id into v_user from auth.users u where pg_catalog.lower(u.email) = v_email and not u.is_sso_user;
  if v_user is not null then
    select p.status into v_status from public.profiles p where p.id = v_user for no key update;
    if not found or v_status <> 'active' then
      return 'ineligible';
    end if;
    if exists (select 1 from public.teachers t where t.profile_id = v_user) then
      return 'already_teacher';
    end if;
    v_created := pg_catalog.clock_timestamp();
  end if;
  begin
    v_expires := v_created + pg_catalog.make_interval(days => v_days);
  exception when datetime_field_overflow or interval_field_overflow then
    raise warning 'VIGENCIA_INVITACION_DIAS se sale del calendario. No se puede invitar.';
    return 'unavailable';
  end;
  -- Un correo es de un solo maestro invitado: al que ya lo tiene se le reenvía.
  if exists (
      select 1 from private.teacher_invitations i
      join public.teachers t on t.id = i.teacher_id
      where i.email = v_email and i.accepted_at is null and t.status = 'invited' and t.profile_id is null
        and i.teacher_id is distinct from p_teacher) then
    return 'already_invited';
  end if;

  if v_teacher is null then
    insert into public.teachers (status, created_by) values ('invited', p_by) returning id into v_teacher;
    v_slug := private.catalog_slug(v_name);
    v_try := v_slug;
    while exists (select 1 from public.published_teachers p where p.slug = v_try) loop
      v_n := v_n + 1;
      v_try := v_slug || '-' || v_n;
    end loop;
    insert into public.published_teachers (teacher_id, slug, display_name) values (v_teacher, v_try, v_name);
  else
    update private.teacher_invitations i set revoked_at = v_created, revoked_by = p_by
    where i.teacher_id = v_teacher and i.accepted_at is null and i.revoked_at is null;
  end if;
  insert into private.teacher_invitations (teacher_id, email, profile_id, invited_by, created_at, expires_at)
  values (v_teacher, v_email, v_user, p_by, v_created, v_expires);
  return case when v_user is null then 'invited_new' else 'invited_existing' end;
end
$$;
revoke all on function private.place_teacher_invitation(uuid, text, text, uuid) from public;

-- ¿Sigue pudiendo invitar quien invitó? Con la cuenta activa, Contenido y su factor atado. No se mira
-- su sesión. Nulo (el dueño) siempre puede.
create function private.teacher_inviter_ok(p_by uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_by is null or (
    exists (select 1 from public.profiles p where p.id = p_by and p.status = 'active')
    and exists (
      select 1 from public.admin_capabilities c
      where c.profile_id = p_by and c.capability = 'content' and c.revoked_at is null)
    and exists (select 1 from private.admin_factors f where f.profile_id = p_by))
$$;
revoke all on function private.teacher_inviter_ok(uuid) from public;

-- ---------------------------------------------------------------------------------------
-- Las funciones del servidor. Ninguna recibe quién actúa: es private.actor_id().

-- Invitar a una persona a ser maestro.
--   forbidden, needs_fresh_code   la puerta de Contenido
--   invalid           el nombre o el correo no lo son
--   unavailable       faltan los textos del maestro o el plazo de las invitaciones
--   self              es el correo de quien invita
--   ineligible        la cuenta de ese correo no está activa
--   already_teacher   esa cuenta ya es maestro
--   already_invited   ese correo ya es de un maestro invitado: se le reenvía
--   invited_new       invitado; el correo no tiene cuenta (se registra con él)
--   invited_existing  invitado; ya tenía cuenta (para aceptar recupera su contraseña)
create function private.invite_teacher(p_name text, p_email text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
begin
  perform private.teacher_invitation_lock();
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  return private.place_teacher_invitation(null, p_name, p_email, private.actor_id());
end
$$;
revoke all on function private.invite_teacher(text, text) from public;
grant execute on function private.invite_teacher(text, text) to app_service;

-- Reenviar: al mismo correo de su última invitación, con plazo nuevo; revoca la viva. Sirve también a
-- un maestro cuya invitación se revocó.
--   forbidden, needs_fresh_code, not_found (no existe o nunca tuvo correo), already_teacher (ya no
--   está invitado), y las de invitar menos invalid
create function private.reinvite_teacher(p_teacher uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_status public.teacher_status;
  v_profile uuid;
  v_email text;
begin
  perform private.teacher_invitation_lock();
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  select t.status, t.profile_id into v_status, v_profile from public.teachers t where t.id = p_teacher;
  if not found then
    return 'not_found';
  end if;
  if v_status <> 'invited' or v_profile is not null then
    return 'already_teacher';
  end if;
  select i.email into v_email from private.teacher_invitations i
  where i.teacher_id = p_teacher order by i.created_at desc limit 1;
  if v_email is null then
    return 'not_found';
  end if;
  return private.place_teacher_invitation(p_teacher, null, v_email, private.actor_id());
end
$$;
revoke all on function private.reinvite_teacher(uuid) from public;
grant execute on function private.reinvite_teacher(uuid) to app_service;

-- Revocar la invitación viva de un maestro, caducada o no. Su maestro sigue invitado.
--   forbidden, needs_fresh_code, self, not_found, revoked
create function private.revoke_teacher_invitation(p_teacher uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_actor uuid := private.actor_id();
begin
  perform private.teacher_invitation_lock();
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  if exists (
      select 1 from private.teacher_invitations i
      join auth.users u on u.id = v_actor and pg_catalog.lower(u.email) = i.email
      where i.teacher_id = p_teacher and i.accepted_at is null and i.revoked_at is null) then
    return 'self';
  end if;
  update private.teacher_invitations i set revoked_at = pg_catalog.clock_timestamp(), revoked_by = v_actor
  where i.teacher_id = p_teacher and i.accepted_at is null and i.revoked_at is null;
  if not found then
    return 'not_found';
  end if;
  return 'revoked';
end
$$;
revoke all on function private.revoke_teacher_invitation(uuid) from public;
grant execute on function private.revoke_teacher_invitation(uuid) to app_service;

-- Aceptar la invitación de quien actúa. p_ticket es la huella del resguardo que el servidor leyó de la
-- cookie; p_agreement y p_notice, los textos que la pantalla le mostró; p_ip y p_user_agent, de dónde
-- se aceptó (van al consentimiento).
--   ineligible            sin actor, o la cuenta no está activa, tiene la marca de contraseña, no
--                         confirmó su correo o es de acceso federado
--   no_invitation         no hay invitación viva y sin caducar para el correo de la cuenta, o su
--                         maestro ya no está invitado (se revoca)
--   already_teacher       la cuenta ya es maestro
--   needs_mailbox_proof   falta el resguardo, es otro, es anterior a la invitación, se hizo con otro
--                         correo o ya venció
--   inviter_lost_content  quien invitó ya no tiene Contenido (se revoca)
--   unavailable           falta un texto del maestro vigente
--   changed               los textos que se mostraron no son los vigentes: se vuelven a mostrar
--   accepted              el maestro queda activo y atado a la cuenta, con los dos consentimientos
create function private.accept_teacher_invitation(
  p_ticket text, p_agreement uuid, p_notice uuid, p_ip inet, p_user_agent text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_session uuid := private.actor_session();
  v_email text;
  v_confirmed boolean;
  v_sso boolean;
  v_status public.profile_status;
  v_pending boolean;
  v_now timestamptz;
  v_invitation private.teacher_invitations;
  v_minutes integer;
  v_ticket text;
  v_proven timestamptz;
  v_proven_email text;
  v_agreement uuid;
  v_notice uuid;
  v_user_agent text := pg_catalog.left(p_user_agent, 512);
begin
  if v_actor is null then
    return 'ineligible';
  end if;
  -- Antes de cualquier candado: casi nadie tiene una invitación, y no debe esperar a nadie.
  select pg_catalog.lower(u.email) into v_email from auth.users u where u.id = v_actor;
  if not exists (
      select 1 from private.teacher_invitations i
      where i.accepted_at is null and i.revoked_at is null and i.email = v_email) then
    return 'no_invitation';
  end if;

  perform private.teacher_invitation_lock();
  select p.status, p.password_reset_required into v_status, v_pending
  from public.profiles p where p.id = v_actor for no key update;
  select pg_catalog.lower(u.email), u.email_confirmed_at is not null, u.is_sso_user
  into v_email, v_confirmed, v_sso
  from auth.users u where u.id = v_actor;
  if v_status is distinct from 'active' or v_pending
     or not coalesce(v_confirmed, false) or coalesce(v_sso, true) then
    return 'ineligible';
  end if;

  v_now := pg_catalog.clock_timestamp();
  select i.* into v_invitation from private.teacher_invitations i
  where i.accepted_at is null and i.revoked_at is null and i.email = v_email
    and (i.profile_id is null or i.profile_id = v_actor) and i.expires_at > v_now;
  if not found then
    return 'no_invitation';
  end if;
  if exists (select 1 from public.teachers t where t.profile_id = v_actor) then
    return 'already_teacher';
  end if;

  v_minutes := private.second_factor_limit('VIGENCIA_PRUEBA_BUZON_MINUTOS');
  if v_minutes is null then
    raise warning 'falta VIGENCIA_PRUEBA_BUZON_MINUTOS, o no es un entero de 1 en adelante. Ninguna prueba del buzón vale.';
    return 'needs_mailbox_proof';
  end if;
  select s.mailbox_ticket, s.mailbox_proven_at, s.mailbox_proven_email
  into v_ticket, v_proven, v_proven_email
  from private.account_security s where s.profile_id = v_actor;
  if p_ticket is null or v_ticket is null or v_ticket <> p_ticket
     or v_proven is null or v_proven <= v_invitation.created_at
     or v_proven_email is distinct from v_invitation.email
     or extract(epoch from (v_now - v_proven)) >= v_minutes::bigint * 60 then
    return 'needs_mailbox_proof';
  end if;

  if not private.teacher_inviter_ok(v_invitation.invited_by) then
    update private.teacher_invitations i set revoked_at = v_now where i.id = v_invitation.id;
    return 'inviter_lost_content';
  end if;
  -- Su maestro, tomado: tiene que seguir invitado y sin cuenta.
  perform 1 from public.teachers t
  where t.id = v_invitation.teacher_id and t.status = 'invited' and t.profile_id is null
  for update;
  if not found then
    update private.teacher_invitations i set revoked_at = v_now where i.id = v_invitation.id;
    return 'no_invitation';
  end if;

  v_agreement := private.current_legal_document('teacher_agreement');
  v_notice := private.current_legal_document('teacher_privacy_notice');
  if v_agreement is null or v_notice is null then
    raise warning 'no hay contrato o aviso de privacidad del maestro vigente. No se acepta una invitación.';
    return 'unavailable';
  end if;
  if p_agreement is distinct from v_agreement or p_notice is distinct from v_notice then
    return 'changed';
  end if;

  insert into public.consents (profile_id, legal_document_id, action, origin, ip, user_agent) values
    (v_actor, v_agreement, 'granted', 'teacher_invitation', p_ip, v_user_agent),
    (v_actor, v_notice, 'granted', 'teacher_invitation', p_ip, v_user_agent);
  update private.teacher_invitations i set accepted_at = v_now, accepted_by = v_actor where i.id = v_invitation.id;
  -- El guardián de lo publicado deja este cambio, y solo este, con la invitación ya aceptada.
  update public.teachers t set status = 'active', profile_id = v_actor where t.id = v_invitation.teacher_id;
  update private.account_security s set mailbox_ticket = null where s.profile_id = v_actor;
  -- Las demás sesiones de la cuenta se cierran; la que acepta sigue.
  delete from auth.sessions a where a.user_id = v_actor and a.id is distinct from v_session;
  delete from private.app_sessions x where x.profile_id = v_actor and x.session_id is distinct from v_session;
  return 'accepted';
end
$$;
revoke all on function private.accept_teacher_invitation(text, uuid, uuid, inet, text) from public;
grant execute on function private.accept_teacher_invitation(text, uuid, uuid, inet, text) to app_service;

-- En qué estado está quien actúa respecto a ser maestro. Siempre una fila. No escribe, no toma
-- candados y no lanza. No comprueba la cuenta ni la marca de contraseña: eso lo decide la guarda de
-- sesión, que corre antes. Lo que dice de una invitación coincide con lo que haría aceptar.
--   none              no es maestro ni tiene una invitación que pueda aceptar (también quien se fue)
--   active            maestro activo, con el aviso del maestro vigente aceptado
--   needs_notice      maestro activo al que le falta aceptar el aviso del maestro vigente
--   suspended         maestro suspendido: solo lectura
--   invited           tiene una invitación que puede aceptar, y p_ticket es su resguardo del buzón
--   invited_unproven  la tiene, pero sin resguardo que valga: que abra un enlace de su correo
create function private.teacher_standing(p_ticket text default null)
returns table (state text, teacher_id uuid)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_teacher public.teachers;
  v_email text;
  v_invitation private.teacher_invitations;
  v_minutes integer;
  v_ticket text;
  v_proven timestamptz;
  v_proven_email text;
begin
  if v_actor is null then
    return query select 'none'::text, null::uuid;
    return;
  end if;
  select t.* into v_teacher from public.teachers t where t.profile_id = v_actor;
  if v_teacher.id is not null then
    return query select
      case
        when v_teacher.status = 'suspended' then 'suspended'
        when v_teacher.status <> 'active' then 'none'
        when private.teacher_notice_pending(v_actor) then 'needs_notice'
        else 'active'
      end::text,
      case when v_teacher.status in ('active', 'suspended') then v_teacher.id end;
    return;
  end if;

  select pg_catalog.lower(u.email) into v_email from auth.users u where u.id = v_actor and not u.is_sso_user;
  select i.* into v_invitation from private.teacher_invitations i
  join public.teachers t on t.id = i.teacher_id and t.status = 'invited' and t.profile_id is null
  where i.accepted_at is null and i.revoked_at is null and i.email = v_email
    and (i.profile_id is null or i.profile_id = v_actor) and i.expires_at > v_now;
  if v_invitation.id is null or not private.teacher_inviter_ok(v_invitation.invited_by) then
    return query select 'none'::text, null::uuid;
    return;
  end if;

  v_minutes := private.second_factor_limit('VIGENCIA_PRUEBA_BUZON_MINUTOS');
  if v_minutes is null then
    raise warning 'private.teacher_standing: falta VIGENCIA_PRUEBA_BUZON_MINUTOS, o no es un entero de 1 en adelante. Ningún resguardo del buzón vale.';
  end if;
  select s.mailbox_ticket, s.mailbox_proven_at, s.mailbox_proven_email
  into v_ticket, v_proven, v_proven_email
  from private.account_security s where s.profile_id = v_actor;
  if v_minutes is null or p_ticket is null or v_ticket is null or v_ticket <> p_ticket
     or v_proven is null or v_proven <= v_invitation.created_at
     or v_proven_email is distinct from v_invitation.email
     or extract(epoch from (v_now - v_proven)) >= v_minutes::bigint * 60 then
    return query select 'invited_unproven'::text, v_invitation.teacher_id;
    return;
  end if;
  return query select 'invited'::text, v_invitation.teacher_id;
end
$$;
revoke all on function private.teacher_standing(text) from public;
grant execute on function private.teacher_standing(text) to app_service;

-- La lista de maestros para PA-65. Solo quien pasa la puerta de Contenido (sin pedir código reciente
-- para leer); nulo para los demás. `invitation` es el estado de su última invitación: none (nunca
-- tuvo), pending, expired, revoked o accepted. `email` es el de su cuenta, o el invitado si no tiene.
create function private.teacher_roster() returns jsonb
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
revoke all on function private.teacher_roster() from public;
grant execute on function private.teacher_roster() to app_service;

-- El dueño de la base, declarado sistema, le pone correo a un maestro que cargó el sistema y que nunca
-- tuvo invitación. No es security definer y no tiene permisos para nadie, como el arranque del equipo.
--   not_found (no existe, o ya no está invitado), already_invited (ya tuvo correo), y las de invitar
create function private.system_invite_teacher(p_teacher uuid, p_email text) returns text
language plpgsql set search_path = ''
as $$
begin
  if not private.actor_is_system() then
    raise exception 'private.system_invite_teacher(): declare the system actor first' using errcode = '42501';
  end if;
  perform private.teacher_invitation_lock();
  if not exists (
      select 1 from public.teachers t where t.id = p_teacher and t.status = 'invited' and t.profile_id is null) then
    return 'not_found';
  end if;
  if exists (select 1 from private.teacher_invitations i where i.teacher_id = p_teacher) then
    return 'already_invited';
  end if;
  return private.place_teacher_invitation(p_teacher, null, p_email, null);
end
$$;
revoke all on function private.system_invite_teacher(uuid, text) from public;

-- ---------------------------------------------------------------------------------------
-- El guardián de lo publicado: lo de la primera solicitud, más el paso de aceptar en `teachers`.
-- Fuera del sistema y de Contenido, solo el maestro invitado sin cuenta pasa a activo, atado a quien
-- actúa, sin ningún otro cambio, y solo si quien actúa ya aceptó una invitación de ese maestro.

create or replace function private.guard_publication() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
  v_teacher boolean := false;
begin
  if tg_op = 'TRUNCATE' then
    raise exception '%.%: rows are hidden, not deleted', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner from pg_catalog.pg_class c where c.oid = tg_relid;
  if current_user::name <> v_owner then
    raise exception '%.%: only the publication functions write this table', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  -- El maestro activo, en el registro de cursos: dar de alta un borrador limpio suyo, o borrar un
  -- borrador suyo que nunca se publicó. En su propio bloque: plpgsql resuelve `new.teacher_id` aunque
  -- la tabla sea otra. Un nulo cuenta como no.
  if tg_relid = 'public.course_registry'::regclass and not private.actor_is_system() then
    if tg_op = 'INSERT' then
      v_teacher := coalesce(
        new.teacher_id = private.current_active_teacher_id()
        and new.created_at = pg_catalog.now() and new.updated_at = pg_catalog.now()
        and new.state = 'draft' and new.pending_version_state is null and not new.is_open
        and new.open_since is null and new.first_published_at is null
        and new.withdrawn_at is null and new.withdrawn_by is null and new.withdrawal_reason is null,
        false);
    elsif tg_op = 'DELETE' then
      v_teacher := coalesce(
        old.teacher_id = private.current_active_teacher_id()
        and old.state = 'draft' and old.first_published_at is null,
        false);
    end if;
  -- Aceptar la invitación: el maestro invitado y sin cuenta se ata a quien actúa y queda activo.
  elsif tg_relid = 'public.teachers'::regclass and tg_op = 'UPDATE' and not private.actor_is_system() then
    v_teacher := coalesce(
      old.status = 'invited' and old.profile_id is null
      and new.status = 'active' and new.profile_id = private.actor_id()
      and (pg_catalog.to_jsonb(new) - array['status', 'profile_id'])
          = (pg_catalog.to_jsonb(old) - array['status', 'profile_id'])
      and exists (
        select 1 from private.teacher_invitations i
        where i.teacher_id = new.id and i.accepted_by = new.profile_id and i.accepted_at is not null),
      false);
  end if;
  if not (v_teacher or private.actor_is_system() or private.content_change_gate() is null) then
    raise exception '%.%: only the publication functions write this table', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    if v_teacher then
      return old;
    end if;
    raise exception '%.%: rows are hidden, not deleted', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  -- En dos pasos: plpgsql resuelve `new.provider` aunque la tabla no sea la de videos.
  if tg_table_name = 'video_assets' then
    if new.provider = 'test'
       -- Un ajuste que nunca se definió es nulo, y un `if` nulo no lanza: por eso el coalesce.
       and not (private.actor_is_system() and coalesce(pg_catalog.current_setting('app.local_courses', true), '') = 'on') then
      raise exception '%.%: test videos are only loaded by the local courses script', tg_table_schema, tg_table_name
        using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------
-- El área `teachers` del vigilante (carril A), con lo de esta solicitud.

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
           ('private.invite_teacher(text, text)', true, array['app_service']),
           ('private.reinvite_teacher(uuid)', true, array['app_service']),
           ('private.revoke_teacher_invitation(uuid)', true, array['app_service']),
           ('private.accept_teacher_invitation(text, uuid, uuid, inet, text)', true, array['app_service']),
           ('private.teacher_standing(text)', true, array['app_service']),
           ('private.teacher_roster()', true, array['app_service'])),
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
  -- Toma la fila del maestro: una función estable no puede.
  select 'teachers function not volatile', found.oid::regprocedure::text
  from found
  where found.proname = 'current_active_teacher_id' and found.provolatile <> 'v'
  union all
  select 'teachers function not owned by the table owner', found.oid::regprocedure::text
  from found
  where found.definer
    and found.proowner <> (select c.relowner from pg_catalog.pg_class c where c.oid = 'public.teachers'::regclass)
  union all
  -- Las invitaciones: con seguridad de filas, sin permisos para la aplicación y con su auditoría.
  select 'teachers table without row level security', 'private.teacher_invitations'
  from pg_catalog.pg_class c
  where c.oid = 'private.teacher_invitations'::regclass and not c.relrowsecurity
  union all
  select 'teachers table privilege for ' || r.rolname, 'private.teacher_invitations'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'private.teacher_invitations',
          'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
     or pg_catalog.has_any_column_privilege(r.rolname::name, 'private.teacher_invitations', 'SELECT, INSERT, UPDATE, REFERENCES')
  union all
  -- «Una viva por maestro y por correo» y «se acepta una vez» viven en estos índices.
  select 'teachers unique index missing: ' || x.name, 'private.teacher_invitations'
  from (values ('teacher_invitations_live_teacher_uq'), ('teacher_invitations_live_email_uq'),
               ('teacher_invitations_accepted_teacher_uq')) x (name)
  where not exists (
    select 1 from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
    where i.indrelid = 'private.teacher_invitations'::regclass and c.relname = x.name
      and i.indisunique and i.indisvalid)
  union all
  select 'teachers audit trigger missing or disabled', 'private.teacher_invitations'
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    where tg.tgrelid = 'private.teacher_invitations'::regclass and tg.tgname = 'audit_changes'
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
