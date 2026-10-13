-- T-105 · En qué estado está una persona respecto al equipo (RF-105, RF-106). TRD §9.2,
-- fila «Invitaciones»; esquema §6.2. Cuarta entrega de T-105, primera parte.
--
-- La puerta del equipo contesta sí o no, y por una capacidad concreta. La guarda de
-- administración necesita saber además por qué no, para mandar a la persona a donde toca:
-- a dar su código, a configurar su segundo factor, a probar su buzón, o a pedir que la
-- restablezcan. Y el servidor no puede leer las invitaciones ni las ataduras: el vigilante
-- lo exige. Por eso es una función, que solo habla de quien actúa.
--
-- Lo que dice tiene que coincidir con lo que haría private.accept_admin_invitation(): una
-- invitación que aceptar revocaría (quien invitó ya no puede, o el tipo ya no corresponde)
-- no cuenta como invitación. Si no, la persona daría vueltas entre dos pantallas.
--
-- No escribe nada, no toma candados y no lanza. No comprueba que la cuenta esté activa ni
-- la marca de contraseña: eso lo decide la guarda de sesión, que corre antes.

-- ---------------------------------------------------------------------------------------
-- Cuánto vive el resguardo del buzón, en segundos, para la cookie que lo guarda. Nulo si
-- falta el parámetro o no vale: el servidor entonces no deja cookie, y el registro o la
-- recuperación terminan igual. El servidor no ejecuta private.second_factor_limit().

create function private.mailbox_proof_seconds() returns bigint
language sql stable security definer set search_path = ''
as $$ select private.second_factor_limit('VIGENCIA_PRUEBA_BUZON_MINUTOS')::bigint * 60 $$;

grant execute on function private.mailbox_proof_seconds() to app_service;

-- ---------------------------------------------------------------------------------------
-- El estado. Siempre una fila.
--
--   none              no es del equipo ni tiene una invitación que pueda aceptar
--   member            tiene alguna capacidad y su sesión pasa la puerta: `factor` es el
--                     atado y `capabilities`, las activas
--   needs_code        tiene alguna capacidad y su factor atado, pero esta sesión no pasa la
--                     puerta: que dé su código. `factor` es con cuál
--   unbound           conserva capacidades y no tiene con qué volver: sin atadura y sin una
--                     invitación de restablecimiento que le sirva, o atada a un factor que
--                     Auth ya no tiene. Alguien con configuración la restablece
--   invited           tiene una invitación que puede aceptar, y p_ticket es su resguardo
--                     del buzón: `kind` es el tipo y `capabilities`, las que recibiría
--   invited_unproven  la tiene, pero sin resguardo que valga: que abra un enlace de su
--                     correo en este navegador. No se le dice qué recibiría

create function private.team_standing(p_ticket text default null)
returns table (state text, factor uuid, kind text, capabilities text[])
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_email text;
  v_active text[];
  v_bound uuid;
  v_invitation private.admin_invitations;
  v_minutes integer;
  v_ticket text;
  v_proven timestamptz;
  v_proven_email text;
begin
  if v_actor is null then
    return query select 'none'::text, null::uuid, null::text, '{}'::text[];
    return;
  end if;
  select coalesce(pg_catalog.array_agg(c.capability::text order by c.capability::text), '{}') into v_active
  from public.admin_capabilities c where c.profile_id = v_actor and c.revoked_at is null;
  select f.factor_id into v_bound from private.admin_factors f where f.profile_id = v_actor;

  -- Con capacidades y con atadura: del equipo, o le falta el código, o su factor ya no está.
  if pg_catalog.cardinality(v_active) > 0 and v_bound is not null then
    if private.team_session(v_actor, private.actor_session()) then
      return query select 'member'::text, v_bound, null::text, v_active;
    elsif exists (
        select 1 from auth.mfa_factors m
        where m.id = v_bound and m.user_id = v_actor
          and m.status = 'verified' and m.factor_type = 'totp') then
      return query select 'needs_code'::text, v_bound, null::text, '{}'::text[];
    else
      return query select 'unbound'::text, null::uuid, null::text, '{}'::text[];
    end if;
    return;
  end if;

  -- La invitación que aceptar tomaría: viva, vigente, al correo actual de la cuenta. Una
  -- cuenta de acceso federado no acepta: aquí no tiene correo con qué buscarla.
  select pg_catalog.lower(u.email) into v_email from auth.users u where u.id = v_actor and not u.is_sso_user;
  select i.* into v_invitation from private.admin_invitations i
  where i.accepted_at is null and i.revoked_at is null and i.email = v_email
    and (i.profile_id is null or i.profile_id = v_actor) and i.expires_at > v_now;
  -- Y que aceptar no revocaría: sin atadura, del tipo que corresponde (una que da
  -- capacidades es para quien no tiene ninguna; una de restablecimiento, para quien
  -- conserva alguna), y de alguien que sigue pudiendo invitar.
  if v_invitation.id is null
     or v_bound is not null
     or (v_invitation.kind = 'grant') = (pg_catalog.cardinality(v_active) > 0)
     or (v_invitation.invited_by is not null and not (
          exists (select 1 from public.profiles p where p.id = v_invitation.invited_by and p.status = 'active')
          and exists (
            select 1 from public.admin_capabilities c
            where c.profile_id = v_invitation.invited_by and c.capability = 'config' and c.revoked_at is null)
          and exists (select 1 from private.admin_factors f where f.profile_id = v_invitation.invited_by))) then
    return query select
      case when pg_catalog.cardinality(v_active) > 0 then 'unbound' else 'none' end::text,
      null::uuid, null::text, '{}'::text[];
    return;
  end if;

  -- El resguardo, con las mismas condiciones que al aceptar.
  v_minutes := private.second_factor_limit('VIGENCIA_PRUEBA_BUZON_MINUTOS');
  select s.mailbox_ticket, s.mailbox_proven_at, s.mailbox_proven_email
  into v_ticket, v_proven, v_proven_email
  from private.account_security s where s.profile_id = v_actor;
  if v_minutes is null or p_ticket is null or v_ticket is null or v_ticket <> p_ticket
     or v_proven is null or v_proven <= v_invitation.created_at
     or v_proven_email is distinct from v_invitation.email
     or extract(epoch from (v_now - v_proven)) >= v_minutes::bigint * 60 then
    return query select 'invited_unproven'::text, null::uuid, v_invitation.kind, '{}'::text[];
    return;
  end if;
  return query select 'invited'::text, null::uuid, v_invitation.kind, v_invitation.capabilities::text[];
end
$$;

grant execute on function private.team_standing(text) to app_service;
