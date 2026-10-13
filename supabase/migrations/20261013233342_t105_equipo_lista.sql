-- T-105 · La lista del equipo (RF-712, PA-86). TRD §9.2, fila «Invitaciones»; esquema §6.2.
-- Quinta entrega de T-105.
--
-- La pantalla del equipo tiene que ver a quién administra, y el servidor no puede leer las
-- ataduras, las invitaciones ni el correo de una cuenta: el vigilante lo exige. Por eso es
-- una función, y una sola: las personas, las invitaciones y si quien mira dio su código
-- hace poco salen de una misma evaluación, en un solo valor. Con dos funciones en dos
-- sentencias, «no pasas» y «no hay nadie» se verían igual, y una mitad podría traer filas
-- mientras la otra no.
--
-- Solo le contesta a quien pasa la puerta del equipo con configuración
-- (private.actor_has_capability('config'): capacidad, factor atado y sesión verificada). A
-- los demás, nulo, sin decir por qué. No pide el código reciente: leer no cambia nada, y
-- quien lo tiene vencido necesita ver la lista para saber qué iba a cambiar. Es una decisión
-- consciente: una sesión de equipo robada ve los correos del equipo, quién está sin factor
-- y las invitaciones vivas.
--
-- No escribe, no toma candados y no lanza. Nunca devuelve la clave ni el identificador de
-- un factor, la huella de un código dictado, sus fallos, ni el resguardo de un buzón.
--
-- Lo que dice tiene que coincidir con lo que harían las funciones que cambian el equipo:
--   · `acceptable`, con private.team_standing() y private.accept_admin_invitation(): una
--     invitación que aceptar revocaría no se pinta como pendiente. Si se cambia una
--     condición allá, se cambia aquí;
--   · `config_removable`, con private.revoke_capability(): cuenta lo mismo.

-- Lo que devuelve, cuando contesta:
--
--   fresh_code   si un cambio al equipo pasaría hoy su puerta sin pedir el código otra vez
--   members      las cuentas con alguna capacidad activa, por correo:
--     profile_id, email (el que la cuenta tiene hoy), display_name, status
--     capabilities       las activas, en orden alfabético
--     factor             bound  tiene su factor atado y Auth lo tiene verificado
--                        lost   lo tiene atado, pero Auth ya no: hay que restablecerla
--                        none   no tiene atadura (restablecida, o nunca aceptó)
--     rebind             su invitación para volver, si tiene alguna viva:
--                        none, pending (la puede aceptar), expired, unusable (no caducó,
--                        pero aceptar la revocaría)
--     config_removable   tiene configuración y quedarían otras dos cuentas activas con ella
--     is_self            es quien pregunta
--   invitations  las vivas (ni aceptadas ni revocadas), caducadas o no, por antigüedad:
--     id, kind, email, profile_id, capabilities (en el orden en que se pidieron),
--     invited_by (nulo: la puso el dueño de la base), created_at, expires_at, expired
--     acceptable         aceptar no la revocaría: no caducó, quien invitó sigue pudiendo, y
--                        la cuenta de ese correo, si existe, es la que puede tomarla

create function private.team_roster() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_roster jsonb;
begin
  if v_actor is null or not private.actor_has_capability('config') then
    return null;
  end if;

  with live as (
    select
      i.id, i.kind, i.email, i.profile_id, i.capabilities, i.invited_by, i.created_at, i.expires_at,
      i.expires_at <= v_now as expired,
      -- Las mismas condiciones que private.team_standing(), vistas desde la invitación.
      i.expires_at > v_now
      and (i.invited_by is null or (
            exists (select 1 from public.profiles p where p.id = i.invited_by and p.status = 'active')
            and exists (
              select 1 from public.admin_capabilities c
              where c.profile_id = i.invited_by and c.capability = 'config' and c.revoked_at is null)
            and exists (select 1 from private.admin_factors f where f.profile_id = i.invited_by)))
      and case
            -- Nadie tiene todavía ese correo: solo espera la que no apunta a una cuenta.
            when a.id is null then i.profile_id is null
            -- Sin atadura, del tipo que corresponde (una que da capacidades es para quien no
            -- tiene ninguna; una de restablecimiento, para quien conserva alguna).
            else (i.profile_id is null or i.profile_id = a.id)
              and not exists (select 1 from private.admin_factors f where f.profile_id = a.id)
              and (i.kind = 'grant') <> exists (
                    select 1 from public.admin_capabilities c
                    where c.profile_id = a.id and c.revoked_at is null)
          end as acceptable
    from private.admin_invitations i
    -- La cuenta que aceptar tomaría: la de ese correo, que no sea de acceso federado.
    left join lateral (
      select u.id from auth.users u
      where pg_catalog.lower(u.email) = i.email and not u.is_sso_user
      order by u.id limit 1) as a on true
    where i.accepted_at is null and i.revoked_at is null
  ),
  holders as (
    select c.profile_id,
           pg_catalog.array_agg(c.capability::text order by c.capability::text) as capabilities,
           pg_catalog.bool_or(c.capability = 'config') as has_config
    from public.admin_capabilities c
    where c.revoked_at is null
    group by c.profile_id
  ),
  people as (
    select
      p.id as profile_id,
      pg_catalog.lower(u.email) as email,
      p.display_name,
      p.status::text as status,
      h.capabilities,
      case
        when f.factor_id is null then 'none'
        when exists (
          select 1 from auth.mfa_factors m
          where m.id = f.factor_id and m.user_id = p.id
            and m.status = 'verified' and m.factor_type = 'totp') then 'bound'
        else 'lost'
      end as factor,
      coalesce((
        select case
                 when l.expired then 'expired'
                 when l.acceptable then 'pending'
                 else 'unusable'
               end
        from live l where l.kind = 'rebind' and l.profile_id = p.id), 'none') as rebind,
      -- Lo mismo que cuenta private.revoke_capability(): otras cuentas activas con configuración.
      h.has_config and (
        select count(distinct c.profile_id)
        from public.admin_capabilities c
        join public.profiles o on o.id = c.profile_id
        where c.capability = 'config' and c.revoked_at is null
          and o.status = 'active' and c.profile_id <> p.id) >= 2 as config_removable,
      p.id = v_actor as is_self
    from holders h
    join public.profiles p on p.id = h.profile_id
    left join auth.users u on u.id = p.id
    left join private.admin_factors f on f.profile_id = p.id
  )
  select pg_catalog.jsonb_build_object(
    'fresh_code', private.team_change_gate() is null,
    -- Nunca viene vacía: quien pregunta tiene configuración, y sale en ella.
    'members', (
      select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'profile_id', m.profile_id, 'email', m.email, 'display_name', m.display_name,
                 'status', m.status, 'capabilities', pg_catalog.to_jsonb(m.capabilities),
                 'factor', m.factor, 'rebind', m.rebind,
                 'config_removable', m.config_removable, 'is_self', m.is_self)
               order by m.email, m.profile_id)
      from people m),
    'invitations', coalesce((
      select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'id', l.id, 'kind', l.kind, 'email', l.email, 'profile_id', l.profile_id,
                 'capabilities', pg_catalog.to_jsonb(l.capabilities::text[]),
                 'invited_by', l.invited_by, 'created_at', l.created_at, 'expires_at', l.expires_at,
                 'expired', l.expired, 'acceptable', l.acceptable)
               order by l.created_at, l.id)
      from live l), '[]'::jsonb))
  into v_roster;
  return v_roster;
end
$$;

grant execute on function private.team_roster() to app_service;
