-- T-105 · Restablecer por la versión de la persona (RF-712, PA-86). TRD §9.2, fila
-- «Invitaciones»; esquema §6.2. Sale de lo que la quinta entrega dejó abierto (decisión de
-- Sergio del 2026-10-13).
--
-- Restablecer un segundo factor no tiene tope de repetición: un formulario reenviado (un
-- doble clic sin JavaScript, o recargar) lo haría otra vez y mataría el código ya dictado.
-- Antes lo impedía un testigo en una cookie, que no era un candado: dos envíos a la vez lo
-- leían los dos. Ahora el botón de confirmar lleva la versión de la persona, y
-- private.reset_second_factor() la compara dentro del candado del equipo. El segundo
-- envío espera al primero, ve que la persona ya cambió y no hace nada.

-- ---------------------------------------------------------------------------------------
-- La versión: dos contadores sobre las invitaciones de esa persona, en cualquier estado
-- (las que apuntan a su cuenta y las que ella aceptó): cuántas hay y cuántas se aceptaron,
-- como «n.a». Los dos solo crecen, porque nada borra invitaciones ni deshace una
-- aceptación, así que no dependen del reloj ni empatan.
--
-- Cambia con cada restablecimiento (private.reset_factor() inserta una invitación, también
-- en la emergencia) y cuando la persona vuelve y acepta. No la cambian dar ni quitar
-- capacidades, revocar una invitación, ni invitar a quien ya es del equipo (contesta
-- already_member sin insertar). Es interna: la leen la lista y la comparación.

create function private.reset_version(p_profile uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select pg_catalog.count(*)::text || '.' || pg_catalog.count(i.accepted_at)::text
  from private.admin_invitations i
  where i.profile_id = p_profile or i.accepted_by = p_profile
$$;

-- ---------------------------------------------------------------------------------------
-- Restablecer, con la versión que se confirmó. Cambia de firma: la de dos argumentos se
-- borra, y con ella su permiso.
--
--   forbidden, needs_fresh_code   la puerta del equipo, como antes
--   self                          nadie se restablece a sí mismo
--   already_sent                  la versión ya no es esa, y la persona tiene una invitación
--                                 para volver, viva, que hizo quien actúa: es su propio envío
--                                 repetido. El código que ya dictó sigue siendo el que vale
--   changed                       la versión ya no es esa por cualquier otra cosa (otra
--                                 persona la restableció, volvió, o se revocó lo pendiente):
--                                 hay que ver la confirmación de nuevo
--   invalid, unavailable, ineligible, not_member, reset   private.reset_factor(), como antes
--
-- La puerta y «a sí misma» van antes que la versión: lo que contestan no depende de ella.
-- La comparación va después del candado, y la función es volátil: cada sentencia ve lo que
-- confirmó el envío que tenía el candado (team_lock() exige read committed). Ninguna rama
-- escribe antes de rechazar, así que el reintento por un choque de candados sigue siendo
-- seguro.

drop function private.reset_second_factor(uuid, text);

create function private.reset_second_factor(p_profile uuid, p_handoff text, p_version text) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_actor uuid := private.actor_id();
begin
  perform private.team_lock();
  v_gate := private.team_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  if p_profile = v_actor then
    return 'self';
  end if;
  if private.reset_version(p_profile) is distinct from p_version then
    if exists (
        select 1 from private.admin_invitations i
        where i.kind = 'rebind' and i.profile_id = p_profile and i.invited_by = v_actor
          and i.accepted_at is null and i.revoked_at is null) then
      return 'already_sent';
    end if;
    return 'changed';
  end if;
  return private.reset_factor(p_profile, p_handoff, v_actor, null);
end
$$;

grant execute on function private.reset_second_factor(uuid, text, text) to app_service;

-- ---------------------------------------------------------------------------------------
-- La lista del equipo suma la versión de cada persona: la pantalla la pone en el botón de
-- confirmar. No es un secreto: dice cuántas invitaciones tuvo esa cuenta y cuántas aceptó.
-- El resto es la versión de 20261013233342, sin cambios.

create or replace function private.team_roster() returns jsonb
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
      p.id = v_actor as is_self,
      private.reset_version(p.id) as reset_version
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
                 'config_removable', m.config_removable, 'is_self', m.is_self,
                 'reset_version', m.reset_version)
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
