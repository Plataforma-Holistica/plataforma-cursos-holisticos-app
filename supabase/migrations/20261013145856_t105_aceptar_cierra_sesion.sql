-- T-105 · Aceptar una invitación cierra todas las sesiones de la cuenta, también aquella
-- con la que se acepta (RF-105, RF-106). TRD §9.2, fila «Invitaciones»; esquema §6.2.
--
-- Decidido por Sergio el 2026-10-13: quien acepta una invitación entra de nuevo y da su
-- código. La sesión con la que se acepta existía antes de la atadura. Si sobreviviera,
-- pasaría la puerta del equipo (private.team_session) sin haber dado un código después de
-- atar, y con ella cualquier copia de su cookie.
--
-- Hasta aquí la función borraba las demás sesiones y conservaba esa, y cerrarla quedaba al
-- servidor como un paso aparte, después de confirmada la transacción: si Supabase Auth no
-- contestaba en ese instante, o el proceso moría entre una cosa y otra, la sesión se quedaba
-- abierta y de equipo. Ahora se cierra aquí, en la misma transacción que ata el factor: o
-- pasan las dos cosas, o ninguna.
--
-- La función es la de la migración t105_invitaciones, sin más cambio que su final: las
-- mismas condiciones, en el mismo orden, y las mismas respuestas. private.team_standing(),
-- que las refleja, no cambia. `create or replace` conserva sus permisos.
--
--   accepted             atado, con sus capacidades si la invitación las daba, y sin
--                        ninguna sesión abierta: la persona entra de nuevo y da su código

create or replace function private.accept_admin_invitation(p_ticket text, p_factor uuid, p_handoff text default null) returns text
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
  v_invitation private.admin_invitations;
  v_minutes integer;
  v_limit integer;
  v_window bigint;
  v_ticket text;
  v_proven timestamptz;
  v_proven_email text;
  v_has_capabilities boolean;
  v_factor uuid;
begin
  if v_actor is null then
    return 'ineligible';
  end if;
  -- Antes de cualquier candado: casi nadie tiene una invitación, y no debe esperar a nadie.
  select pg_catalog.lower(u.email) into v_email from auth.users u where u.id = v_actor;
  if not exists (
      select 1 from private.admin_invitations i
      where i.accepted_at is null and i.revoked_at is null and i.email = v_email) then
    return 'no_invitation';
  end if;

  perform private.team_lock();
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
  select i.* into v_invitation from private.admin_invitations i
  where i.accepted_at is null and i.revoked_at is null and i.email = v_email
    and (i.profile_id is null or i.profile_id = v_actor) and i.expires_at > v_now;
  if not found then
    return 'no_invitation';
  end if;
  if exists (select 1 from private.admin_factors f where f.profile_id = v_actor) then
    return 'already_bound';
  end if;

  -- La prueba del buzón. Vale para toda invitación, también las del dueño.
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

  -- Quien invitó tiene que seguir siendo del equipo, con configuración. No se mira su sesión.
  if v_invitation.invited_by is not null and not (
       exists (select 1 from public.profiles p where p.id = v_invitation.invited_by and p.status = 'active')
       and exists (
         select 1 from public.admin_capabilities c
         where c.profile_id = v_invitation.invited_by and c.capability = 'config' and c.revoked_at is null)
       and exists (select 1 from private.admin_factors f where f.profile_id = v_invitation.invited_by)) then
    update private.admin_invitations i set revoked_at = v_now where i.id = v_invitation.id;
    return 'inviter_lost_config';
  end if;

  -- Una que da capacidades es para quien no tiene ninguna; una de restablecimiento, para
  -- quien conserva alguna. La que ya no corresponde se revoca.
  v_has_capabilities := exists (
    select 1 from public.admin_capabilities c
    where c.profile_id = v_actor and c.revoked_at is null);
  if (v_invitation.kind = 'grant') = v_has_capabilities then
    update private.admin_invitations i set revoked_at = v_now where i.id = v_invitation.id;
    return 'no_invitation';
  end if;

  -- El código dictado. Solo llega aquí quien ya trajo el resguardo: los intentos no se
  -- gastan desde fuera.
  if v_invitation.kind = 'rebind' then
    v_limit := private.second_factor_limit('INTENTOS_ANTES_DE_FRENO');
    if v_limit is null then
      raise warning 'falta INTENTOS_ANTES_DE_FRENO, o no es un entero de 1 en adelante. No se acepta un restablecimiento.';
      return 'unavailable';
    end if;
    if p_handoff is null or v_invitation.handoff is distinct from p_handoff then
      update private.admin_invitations i
      set handoff_failures = i.handoff_failures + 1,
          revoked_at = case when i.handoff_failures + 1 >= v_limit then v_now end
      where i.id = v_invitation.id;
      return 'needs_handoff';
    end if;
  end if;

  -- La sesión y su factor, en una sola consulta: el factor que se ata es el que se leyó.
  v_window := private.recent_code_seconds();
  if v_window is null then
    return 'needs_code';
  end if;
  select s.factor_id into v_factor
  from auth.sessions s
  join private.app_sessions x on x.session_id = s.id and x.profile_id = v_actor
  join auth.mfa_factors m on m.id = s.factor_id and m.user_id = v_actor
    and m.status = 'verified' and m.factor_type = 'totp'
  where s.id = v_session and s.user_id = v_actor
    and s.aal = 'aal2' and s.factor_id = p_factor
    and (s.not_after is null or s.not_after > v_now)
    and exists (
      select 1 from auth.mfa_amr_claims c
      where c.session_id = s.id and c.authentication_method = 'totp'
        and extract(epoch from (v_now - c.updated_at)) < v_window
        and extract(epoch from (v_now - c.updated_at)) > -300);
  if v_factor is null then
    return 'needs_code';
  end if;

  insert into private.admin_factors (profile_id, factor_id, bound_email) values (v_actor, v_factor, v_email);
  if v_invitation.kind = 'grant' then
    insert into public.admin_capabilities (profile_id, capability, granted_by)
    select v_actor, u.capability, v_invitation.invited_by
    from unnest(v_invitation.capabilities) with ordinality as u(capability, ord)
    order by u.ord;
  end if;
  update private.admin_invitations i set accepted_at = v_now, accepted_by = v_actor where i.id = v_invitation.id;
  update private.account_security s set mailbox_ticket = null where s.profile_id = v_actor;
  -- Lo que no es de esta aceptación se va: los otros factores de la cuenta, y todas sus
  -- sesiones. También aquella con la que acepta: existía antes de la atadura.
  perform private.drop_unbound_factors(v_actor);
  perform private.close_all_sessions(v_actor);
  return 'accepted';
end
$$;
