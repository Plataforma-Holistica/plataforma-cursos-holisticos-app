-- T-105 · Las invitaciones de administrador (RF-105, RF-106, RF-712). TRD §9.2, fila
-- «Invitaciones»; esquema §6.2. Tercera entrega de T-105.
--
-- Hasta aquí nadie podía atar un factor, así que nadie pasaba la puerta del equipo, y el
-- servidor todavía podía escribir public.admin_capabilities sin que nadie comprobara quién
-- daba. Esta migración cierra las dos cosas: una capacidad solo se recibe aceptando una
-- invitación, o de quien tiene configuración si ya se es del equipo, y todo pasa por
-- funciones que comprueban quién actúa.
--
-- Aceptar pide tres hechos, y ninguno es la contraseña:
--
--   · el resguardo del buzón: quien abre un enlace del correo y fija su contraseña demostró
--     en ese navegador que controla el buzón. El servidor deja ahí un secreto de un solo
--     uso y le pasa a la base su huella (private.claim_account). Quien ya sabía la
--     contraseña, quien la cambia por fuera o quien tiene una entrada en vuelo no lo tiene;
--   · una sesión que la aplicación abrió, en segundo nivel, con el factor que el servidor
--     dio de alta en ese navegador, verificada hace menos de
--     VIGENCIA_CODIGO_RECIENTE_MINUTOS. Ese es el factor que queda atado;
--   · y, si es un restablecimiento, el código que quien restableció le dicta a la persona
--     por otro canal.
--
-- Cambiar el equipo (invitar, dar, quitar, restablecer) pide configuración y ese mismo
-- código reciente: con la sesión robada de alguien con configuración no alcanza, salvo
-- dentro de esa ventana. Cambiar un parámetro pide lo mismo: si no, quien tiene esa sesión
-- se alargaría la ventana.
--
-- Lo que esta migración no trae: que el servidor emita el resguardo, deje su cookie y la
-- lea al aceptar. Llega con el servicio que acepta. Hasta entonces los servicios reclaman
-- sin resguardo y ninguna invitación se puede aceptar. Falla cerrado.
--
-- Límites conocidos:
--   · Borrar factores, bajar sesiones y cerrar sesiones escribe en tablas de Supabase Auth
--     (auth.mfa_factors, auth.mfa_amr_claims, auth.sessions). Los permisos del dueño sobre
--     ellas están medidos en la pila local; al crear el proyecto de producción se miden.
--   · El correo de una cuenta es el que Auth tenga. Que cambiarlo exija confirmar desde el
--     correo anterior es configuración de Auth (double_confirm_changes), no de esta base.
--   · Una persona con configuración y un código reciente puede invitar y restablecer sin
--     que una segunda lo apruebe.

-- ---------------------------------------------------------------------------------------
-- Los parámetros. Sus valores de arranque están en supabase/seeds/business_parameters.sql,
-- transcritos de 00-fundamentos.md §4. VIGENCIA_INVITACION_DIAS ya existía.

insert into public.parameter_definitions (key, description, value_type, unit, group_name, affects_payout) values
  ('VIGENCIA_CODIGO_RECIENTE_MINUTOS', 'Cuánto vale una verificación del segundo factor para una acción delicada', 'integer', 'minutos', 'product', false),
  ('VIGENCIA_PRUEBA_BUZON_MINUTOS', 'Cuánto vale haber abierto un enlace del correo para aceptar una invitación', 'integer', 'minutos', 'product', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------
-- Tablas.

-- El resguardo del buzón vive junto a la fecha de la contraseña. La huella, la hora y el
-- correo que tenía la cuenta al probarlo los escribe private.claim_account(); aceptar y
-- restablecer solo anulan la huella.
alter table private.account_security
  add column mailbox_proven_at timestamptz,
  add column mailbox_proven_email text,
  add column mailbox_ticket text constraint account_security_ticket_shape check (mailbox_ticket ~ '^[0-9a-f]{64}$');

-- Con qué correo aceptó cada persona del equipo. La tabla está vacía en todo entorno: nadie
-- ha podido atar un factor. Sirve al restablecer: a quien le cambiaron el correo por fuera
-- no se le manda la invitación al correo nuevo.
alter table private.admin_factors add column bound_email text not null;

create table private.admin_invitations (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                         -- 'grant' da capacidades; 'rebind' devuelve la atadura a quien las conserva
  email text not null,                        -- en minúsculas y sin espacios en los extremos
  profile_id uuid references public.profiles (id),   -- la cuenta, si ya existía al invitar
  capabilities public.capability[] not null,
  invited_by uuid references public.profiles (id),   -- nulo: la puso el dueño de la base
  handoff text,                               -- huella del código que dicta quien restablece
  handoff_failures integer not null default 0,
  created_at timestamptz not null,            -- la pone la función con el reloj, no con now()
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references public.profiles (id),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id),   -- nulo: revocación automática o del dueño
  constraint admin_invitations_kind_known check (kind in ('grant', 'rebind')),
  constraint admin_invitations_expires_later check (expires_at > created_at),
  constraint admin_invitations_acceptance_consistent check ((accepted_at is null) = (accepted_by is null)),
  constraint admin_invitations_one_end check (accepted_at is null or revoked_at is null),
  constraint admin_invitations_grant_gives check (kind <> 'grant' or (cardinality(capabilities) >= 1 and handoff is null)),
  constraint admin_invitations_rebind_gives_nothing check (
    kind <> 'rebind' or (cardinality(capabilities) = 0 and profile_id is not null and handoff is not null)),
  constraint admin_invitations_handoff_shape check (handoff ~ '^[0-9a-f]{64}$')
);
comment on table private.admin_invitations is 'Las invitaciones de administrador. Una viva por correo y por cuenta. Solo se escribe con las funciones de private que cambian el equipo.';

-- Viva: ni aceptada ni revocada. Una caducada sigue viva hasta que alguien reinvita.
create unique index admin_invitations_live_email_uq on private.admin_invitations (email)
  where accepted_at is null and revoked_at is null;
create unique index admin_invitations_live_profile_uq on private.admin_invitations (profile_id)
  where accepted_at is null and revoked_at is null and profile_id is not null;

alter table private.admin_invitations enable row level security;

-- Invitar, aceptar y revocar son actos administrativos (RF-706). El correo invitado queda
-- escrito (decisión del 2026-10-12); la huella del código dictado, no.
create trigger audit_changes after insert or update or delete on private.admin_invitations
  for each row execute function private.audit_row_change('access', 'handoff');

-- ---------------------------------------------------------------------------------------
-- Piezas internas. Ninguna tiene permisos para nadie: las llaman las funciones de abajo.

-- Un correo, normalizado. Lo que no tiene forma de correo es nulo.
create function private.clean_email(p_email text) returns text
language sql immutable set search_path = ''
as $$
  select case when v.e ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and pg_catalog.length(v.e) <= 254 then v.e end
  from (select pg_catalog.lower(pg_catalog.btrim(p_email)) as e) as v
$$;

-- El candado de los cambios al equipo. Con él por delante, las funciones que cambian el
-- equipo van una tras otra; después toman, como mucho, el candado de fila de un perfil, y
-- solo entonces tocan filas de Auth. Las de sesión (anotar, reclamar, cerrar) toman un
-- solo candado de perfil y nunca este: no hay ciclo. (Insertar una fila que apunta a otro
-- perfil toma además el candado compartido de su clave. No choca con los de aquí; a
-- private.note_session(), que todavía pide el candado entero, la hace esperar, sin ciclo.)
-- Con una foto fija de la base, lo confirmado mientras se esperaba el candado no se vería.
create function private.team_lock() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'team changes need read committed isolation' using errcode = '25000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('team', 0));
end
$$;

-- Borra de una cuenta todo factor de Supabase Auth que no sea el atado, y deja sus sesiones
-- como las deja Auth al quitar un factor: sin la verificación y en primer nivel. También
-- las que apuntan a un factor que ya no existe. El factor atado de alguien del equipo no se
-- toca. Bloquea primero los factores y toca las verificaciones antes que sus sesiones, que
-- es el orden de Auth al verificar un código (leído en su código, v2.197.0): los dos piden
-- lo mismo primero y no hay ciclo. Si otra versión de Auth lo cambiara, la base cortaría a
-- uno de los dos (40P01) y quien llama reintenta.
create function private.drop_unbound_factors(p_user uuid) returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_bound uuid;
  v_dropped integer;
begin
  select f.factor_id into v_bound from private.admin_factors f where f.profile_id = p_user;
  perform 1 from auth.mfa_factors m
  where m.user_id = p_user and m.id is distinct from v_bound for update;
  delete from auth.mfa_amr_claims c using auth.sessions s
  where c.session_id = s.id and s.user_id = p_user and c.authentication_method = 'totp'
    and (v_bound is null or s.factor_id is distinct from v_bound);
  update auth.sessions s set aal = 'aal1', factor_id = null
  where s.user_id = p_user
    and (v_bound is null or s.factor_id is distinct from v_bound)
    and (s.factor_id is not null or s.aal is distinct from 'aal1');
  delete from private.second_factor_attempts a
  where a.factor_id in (
    select m.id from auth.mfa_factors m where m.user_id = p_user and m.id is distinct from v_bound);
  delete from auth.mfa_factors m where m.user_id = p_user and m.id is distinct from v_bound;
  get diagnostics v_dropped = row_count;
  return v_dropped;
end
$$;

-- Cierra todas las sesiones de una cuenta: en Auth y en lo anotado.
create function private.close_all_sessions(p_user uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from auth.sessions a where a.user_id = p_user;
  delete from private.app_sessions x where x.profile_id = p_user;
end
$$;

-- La ventana del código reciente, en segundos. Sin el parámetro, o con uno que no vale, no
-- hay ventana: ningún código es reciente, y queda dicho en el registro.
create function private.recent_code_seconds() returns bigint
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_minutes integer := private.second_factor_limit('VIGENCIA_CODIGO_RECIENTE_MINUTOS');
begin
  if v_minutes is null then
    raise warning 'falta VIGENCIA_CODIGO_RECIENTE_MINUTOS, o no es un entero de 1 en adelante. Ningún código cuenta como reciente.';
    return null;
  end if;
  return v_minutes::bigint * 60;
end
$$;

-- ¿Esta sesión de esta persona dio hace poco el código de su factor atado? En una sola
-- consulta: una verificación con otro factor, confirmada mientras tanto, no cuela.
create function private.fresh_code(p_user uuid, p_session uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_window bigint := private.recent_code_seconds();
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if v_window is null then
    return false;
  end if;
  return exists (
    select 1
    from private.admin_factors f
    join auth.sessions s on s.user_id = f.profile_id and s.factor_id = f.factor_id
    join auth.mfa_amr_claims c on c.session_id = s.id
    where f.profile_id = p_user and s.id = p_session and s.aal = 'aal2'
      and c.authentication_method = 'totp'
      and extract(epoch from (v_now - c.updated_at)) < v_window
      and extract(epoch from (v_now - c.updated_at)) > -300);
end
$$;

-- La puerta de los cambios al equipo. Nulo si pasa.
--   forbidden         quien actúa no tiene configuración (o no hay quien actúe)
--   needs_fresh_code  la tiene, pero su sesión no pasa la puerta del equipo o su código no
--                     es reciente: que dé su código otra vez
create function private.team_change_gate() returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
begin
  if v_actor is null or not exists (
      select 1 from public.admin_capabilities c
      where c.profile_id = v_actor and c.capability = 'config' and c.revoked_at is null) then
    return 'forbidden';
  end if;
  if not private.actor_has_capability('config')
     or not private.fresh_code(v_actor, private.actor_session()) then
    return 'needs_fresh_code';
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Reclamar una cuenta deja además la prueba del buzón.
--
-- La firma cambia, así que la de antes se borra: con las dos vivas, la vieja seguiría
-- ejecutable y sin lo de aquí. Los servicios de hoy la llaman sin argumento: siguen
-- funcionando y no dejan resguardo.
--
-- Lo que cambia respecto a la versión anterior (20261011054313):
--   · con un resguardo con forma de huella, y solo si la cuenta se puede reclamar, guarda la
--     huella, la hora y el correo de la cuenta. Sin él, el resguardo anterior se anula y la
--     hora de la prueba no se mueve;
--   · si la cuenta tiene una invitación viva, borra los factores que tuviera: quien acepte
--     tiene que atar uno dado de alta después (decisión del 2026-10-12). A las demás cuentas
--     no se les toca: recuperar la contraseña no quita un segundo factor;
--   · si la cuenta tiene alguna capacidad, deja un renglón de auditoría: alguien del equipo
--     fijó su contraseña con el correo, sin el código;
--   · el candado del perfil pasa a ser el que no estorba a quien inserta una fila que
--     apunta al perfil.

drop function private.claim_account();

create function private.claim_account(p_ticket text default null) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_status public.profile_status;
  v_pending boolean;
  v_now timestamptz;
  v_email text;
  v_confirmed boolean;
  v_proves boolean;
begin
  if v_actor is null then
    return 'ineligible';
  end if;
  -- Con una foto fija de la base, el borrado de abajo no vería una sesión anotada y
  -- confirmada mientras este reclamo esperaba el candado.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.claim_account() needs read committed isolation' using errcode = '25000';
  end if;
  -- Con candado: dos reclamos a la vez de la misma cuenta se ordenan, y solo uno apaga. Es
  -- el mismo que toman anotar una sesión e invitar a esta cuenta: una invitación queda
  -- fechada antes de este reclamo, o después.
  select p.status, p.password_reset_required into v_status, v_pending
  from public.profiles p where p.id = v_actor for no key update;
  if not found then
    return 'ineligible';
  end if;

  -- La hora se toma con el candado ya tomado.
  v_now := pg_catalog.clock_timestamp();
  select pg_catalog.lower(u.email), u.email_confirmed_at is not null into v_email, v_confirmed
  from auth.users u where u.id = v_actor;
  v_proves := v_status = 'active' and coalesce(v_confirmed, false)
    and coalesce(p_ticket ~ '^[0-9a-f]{64}$', false);

  insert into private.account_security as s
    (profile_id, password_changed_at, mailbox_proven_at, mailbox_proven_email, mailbox_ticket)
  values (
    v_actor, v_now,
    case when v_proves then v_now end,
    case when v_proves then v_email end,
    case when v_proves then p_ticket end)
  on conflict (profile_id) do update set
    password_changed_at = excluded.password_changed_at,
    mailbox_proven_at = coalesce(excluded.mailbox_proven_at, s.mailbox_proven_at),
    mailbox_proven_email = case when excluded.mailbox_proven_at is null then s.mailbox_proven_email
                                else excluded.mailbox_proven_email end,
    mailbox_ticket = excluded.mailbox_ticket;
  delete from private.app_sessions x where x.profile_id = v_actor;

  if exists (
      select 1 from private.admin_invitations i
      where i.accepted_at is null and i.revoked_at is null and i.email = v_email) then
    perform private.drop_unbound_factors(v_actor);
  end if;

  if v_status <> 'active' then
    return 'ineligible';
  end if;
  if not coalesce(v_confirmed, false) then
    return 'ineligible';
  end if;
  if exists (
      select 1 from public.admin_capabilities c
      where c.profile_id = v_actor and c.revoked_at is null) then
    insert into public.audit_log (actor_id, actor_kind, category, action, entity_table, entity_id, reason, request_id)
    values (
      v_actor, 'user', 'access', 'account.claimed', 'public.profiles', v_actor::text,
      nullif(pg_catalog.current_setting('app.reason', true), ''),
      nullif(pg_catalog.current_setting('app.request_id', true), ''));
  end if;
  if not v_pending then
    return 'already_claimed';
  end if;
  perform pg_catalog.set_config('app.claiming_account', 'on', true);
  update public.profiles set password_reset_required = false where id = v_actor;
  perform pg_catalog.set_config('app.claiming_account', '', true);
  return 'claimed';
end
$$;

grant execute on function private.claim_account(text) to app_service;

-- ---------------------------------------------------------------------------------------
-- Dejar una invitación que da capacidades. La comparten invitar y el arranque: p_by es
-- quién invita, o nulo si es el dueño de la base. Quien llama ya tomó el candado del equipo.
--
-- A una cuenta que ya existe no se le toca nada (decisión del 2026-10-12): ni marca, ni
-- sesiones, ni factores. Un correo mal escrito no saca a nadie. Lo que la protege es que
-- aceptar pide un resguardo posterior a esta invitación.
--
-- La hora de la invitación es la del reloj, y se toma: si la cuenta existe, con su candado
-- de fila ya tomado, que es el mismo de private.claim_account(): un reclamo confirmado
-- antes queda con hora anterior, y uno posterior espera y toma la suya después. Si no
-- existe, antes de buscarla: una cuenta que la búsqueda no vio se confirmó después.

create function private.place_invitation(p_email text, p_capabilities public.capability[], p_by uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := private.clean_email(p_email);
  v_capabilities public.capability[];
  v_days integer;
  v_created timestamptz;
  v_expires timestamptz;
  v_user uuid;
  v_status public.profile_status;
begin
  if v_email is null or p_capabilities is null or pg_catalog.cardinality(p_capabilities) = 0 then
    return 'invalid';
  end if;
  -- Una lista de listas tampoco, y va antes: buscarle nulos lanzaría.
  if pg_catalog.array_ndims(p_capabilities) <> 1 then
    return 'invalid';
  end if;
  if pg_catalog.array_position(p_capabilities, null) is not null then
    return 'invalid';
  end if;
  -- Sin repetidos, en el orden en que llegaron.
  select pg_catalog.array_agg(d.capability order by d.first_seen) into v_capabilities
  from (
    select u.capability, min(u.ord) as first_seen
    from unnest(p_capabilities) with ordinality as u(capability, ord)
    group by u.capability) as d;
  v_days := private.second_factor_limit('VIGENCIA_INVITACION_DIAS');
  if v_days is null then
    raise warning 'falta VIGENCIA_INVITACION_DIAS, o no es un entero de 1 en adelante. No se puede invitar.';
    return 'unavailable';
  end if;

  v_created := pg_catalog.clock_timestamp();
  -- Auth guarda los correos en minúsculas; se compara igual que al aceptar, por si acaso.
  select u.id into v_user from auth.users u where pg_catalog.lower(u.email) = v_email and not u.is_sso_user;
  if v_user is not null then
    select p.status into v_status from public.profiles p where p.id = v_user for no key update;
    if not found or v_status <> 'active' then
      return 'ineligible';
    end if;
    -- Quien tiene una capacidad ya es del equipo, tenga o no su factor atado: si lo perdió,
    -- se le restablece.
    if exists (
        select 1 from public.admin_capabilities c
        where c.profile_id = v_user and c.revoked_at is null) then
      return 'already_member';
    end if;
    v_created := pg_catalog.clock_timestamp();
  end if;
  -- Un plazo que se sale del calendario no lanza: no se puede invitar, y ya.
  begin
    v_expires := v_created + pg_catalog.make_interval(days => v_days);
  exception when datetime_field_overflow or interval_field_overflow then
    raise warning 'VIGENCIA_INVITACION_DIAS se sale del calendario. No se puede invitar.';
    return 'unavailable';
  end;

  if exists (
      select 1 from private.admin_invitations i
      where i.accepted_at is null and i.revoked_at is null
        and (i.email = v_email or i.profile_id = v_user) and i.expires_at > v_created) then
    return 'already_invited';
  end if;
  update private.admin_invitations i set revoked_at = v_created, revoked_by = p_by
  where i.accepted_at is null and i.revoked_at is null
    and (i.email = v_email or i.profile_id = v_user);
  insert into private.admin_invitations (kind, email, profile_id, capabilities, invited_by, created_at, expires_at)
  values ('grant', v_email, v_user, v_capabilities, p_by, v_created, v_expires);
  return case when v_user is null then 'invited_new' else 'invited_existing' end;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Quitarle a alguien del equipo su atadura para que vuelva con un factor nuevo. La comparten
-- restablecer y la emergencia. p_by es quién restablece, o nulo si es el dueño. p_email es
-- a qué correo va la invitación: nulo quiere decir «al de la cuenta, si es el mismo con el
-- que aceptó»; el dueño puede escribir otro. La emergencia nunca pasa nulo: sin correo
-- escrito pasa el de la cuenta, sin compararlo, y lo que frena a quien lo hubiera cambiado
-- es el código dictado.
--
-- No toca las capacidades de la persona: sin atadura no le sirven, y volver no se las da.
-- La invitación que deja no lleva ninguna, así que aceptarla nunca devuelve una que se
-- quitó entretanto. Y lleva la huella del código que quien restablece le dicta por otro
-- canal: con el buzón solo no se vuelve.

create function private.reset_factor(p_profile uuid, p_handoff text, p_by uuid, p_email text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := private.clean_email(p_email);
  v_current text;
  v_reference text;
  v_days integer;
  v_status public.profile_status;
  v_created timestamptz;
  v_expires timestamptz;
begin
  if p_handoff is null or p_handoff !~ '^[0-9a-f]{64}$' or (p_email is not null and v_email is null) then
    return 'invalid';
  end if;
  v_days := private.second_factor_limit('VIGENCIA_INVITACION_DIAS');
  if v_days is null then
    raise warning 'falta VIGENCIA_INVITACION_DIAS, o no es un entero de 1 en adelante. No se puede restablecer.';
    return 'unavailable';
  end if;
  select p.status into v_status from public.profiles p where p.id = p_profile for no key update;
  if not found or v_status <> 'active' then
    return 'ineligible';
  end if;
  if not exists (
      select 1 from public.admin_capabilities c
      where c.profile_id = p_profile and c.revoked_at is null) then
    return 'not_member';
  end if;

  select pg_catalog.lower(u.email) into v_current from auth.users u where u.id = p_profile and not u.is_sso_user;
  if v_email is null then
    -- El correo con el que aceptó; ya sin atadura, el de su última invitación.
    select f.bound_email into v_reference from private.admin_factors f where f.profile_id = p_profile;
    if v_reference is null then
      select i.email into v_reference from private.admin_invitations i
      where i.profile_id = p_profile or i.accepted_by = p_profile
      order by i.created_at desc limit 1;
    end if;
    if v_current is null or v_reference is distinct from v_current then
      return 'ineligible';
    end if;
    v_email := v_current;
  end if;

  v_created := pg_catalog.clock_timestamp();
  begin
    v_expires := v_created + pg_catalog.make_interval(days => v_days);
  exception when datetime_field_overflow or interval_field_overflow then
    raise warning 'VIGENCIA_INVITACION_DIAS se sale del calendario. No se puede restablecer.';
    return 'unavailable';
  end;

  delete from private.admin_factors f where f.profile_id = p_profile;
  perform private.drop_unbound_factors(p_profile);
  perform private.close_all_sessions(p_profile);
  -- La marca de contraseña, por el mismo camino que la apaga el reclamo: el guardián mira
  -- quién ejecuta además del ajuste.
  perform pg_catalog.set_config('app.claiming_account', 'on', true);
  update public.profiles set password_reset_required = true where id = p_profile;
  perform pg_catalog.set_config('app.claiming_account', '', true);
  update private.account_security s set mailbox_ticket = null where s.profile_id = p_profile;
  -- Las invitaciones vivas dirigidas a ella, y las que ella hizo: si se le restablece porque
  -- alguien usó su sesión, lo que esa sesión invitó no debe poder aceptarse.
  update private.admin_invitations i set revoked_at = v_created, revoked_by = p_by
  where i.accepted_at is null and i.revoked_at is null
    and (i.profile_id = p_profile or i.email = v_email or i.invited_by = p_profile);
  insert into private.admin_invitations (kind, email, profile_id, capabilities, invited_by, handoff, created_at, expires_at)
  values ('rebind', v_email, p_profile, '{}', p_by, p_handoff, v_created, v_expires);
  return 'reset';
end
$$;

-- ---------------------------------------------------------------------------------------
-- Las funciones del servidor. Ninguna recibe quién actúa: es private.actor_id(), que el
-- servidor declaró con el token que verificó.

-- Invitar a un correo a recibir capacidades.
--   forbidden, needs_fresh_code   la puerta de los cambios
--   invalid           el correo no lo es, o la lista viene vacía o con nulos
--   unavailable       falta el plazo de las invitaciones
--   ineligible        la cuenta de ese correo no está activa
--   already_member    esa cuenta ya es del equipo: se le da la capacidad, no se le invita
--   already_invited   ya tiene una invitación viva y sin caducar
--   invited_new       invitado; el correo no tiene cuenta (el servidor le manda su registro)
--   invited_existing  invitado; ya tenía cuenta (para aceptar recupera su contraseña)
create function private.invite_admin(p_email text, p_capabilities public.capability[]) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
begin
  perform private.team_lock();
  v_gate := private.team_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  return private.place_invitation(p_email, p_capabilities, private.actor_id());
end
$$;

-- Revocar una invitación viva, de cualquier tipo, caducada o no. No le devuelve nada a nadie.
--   forbidden, needs_fresh_code, not_found, revoked
create function private.revoke_admin_invitation(p_id uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
begin
  perform private.team_lock();
  v_gate := private.team_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  update private.admin_invitations i
  set revoked_at = pg_catalog.clock_timestamp(), revoked_by = private.actor_id()
  where i.id = p_id and i.accepted_at is null and i.revoked_at is null;
  if not found then
    return 'not_found';
  end if;
  return 'revoked';
end
$$;

-- Aceptar la invitación de quien actúa. p_ticket es la huella del resguardo que el servidor
-- leyó de la cookie de ese navegador; p_factor, el factor que el servidor dio de alta ahí;
-- p_handoff, la huella del código dictado, si es un restablecimiento.
--   ineligible           sin actor, o la cuenta no está activa, tiene la marca prendida, no
--                        confirmó su correo o es de acceso federado
--   no_invitation        no hay invitación viva y sin caducar para el correo de la cuenta
--   already_bound        ya tiene un factor atado
--   needs_mailbox_proof  falta el resguardo, es otro, es anterior a la invitación, se hizo
--                        con otro correo o ya venció
--   inviter_lost_config  quien invitó ya no es del equipo con configuración (se revoca)
--   unavailable          falta el límite de códigos dictados
--   needs_handoff        el código dictado no es (cada fallo cuenta, y al límite se revoca)
--   needs_code           la sesión no está verificada con ese factor, o no hace poco
--   accepted             atado, y con sus capacidades si la invitación las daba
create function private.accept_admin_invitation(p_ticket text, p_factor uuid, p_handoff text default null) returns text
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
  -- Lo que no es de esta aceptación se va: otros factores de la cuenta y sus demás sesiones.
  perform private.drop_unbound_factors(v_actor);
  delete from auth.sessions a where a.user_id = v_actor and a.id <> v_session;
  delete from private.app_sessions x where x.profile_id = v_actor and x.session_id <> v_session;
  return 'accepted';
end
$$;

-- Dar una capacidad a alguien que ya es del equipo (tiene su factor atado). A los demás se
-- les invita.
--   forbidden, needs_fresh_code, invalid, ineligible, not_member, already_has, granted
create function private.grant_capability(p_profile uuid, p_capability public.capability) returns text
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

-- Quitar una capacidad. Corta en el acto: cierra todas las sesiones de esa persona, también
-- si es quien actúa (RF-712). Quien pierde configuración pierde las invitaciones que hizo;
-- quien pierde la última deja de ser del equipo: sin atadura, sin factor y sin invitación.
--   forbidden, needs_fresh_code, not_found
--   min_config   quedarían menos de dos cuentas activas con configuración
--   revoked
create function private.revoke_capability(p_profile uuid, p_capability public.capability) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_actor uuid := private.actor_id();
  v_row uuid;
  v_now timestamptz;
begin
  perform private.team_lock();
  v_gate := private.team_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  perform 1 from public.profiles p where p.id = p_profile for no key update;
  if not found then
    return 'not_found';
  end if;
  select c.id into v_row from public.admin_capabilities c
  where c.profile_id = p_profile and c.capability = p_capability and c.revoked_at is null;
  if v_row is null then
    return 'not_found';
  end if;
  if p_capability = 'config' and (
      select count(distinct c.profile_id)
      from public.admin_capabilities c
      join public.profiles p on p.id = c.profile_id
      where c.capability = 'config' and c.revoked_at is null
        and p.status = 'active' and c.profile_id <> p_profile) < 2 then
    return 'min_config';
  end if;

  v_now := pg_catalog.clock_timestamp();
  update public.admin_capabilities set revoked_at = v_now, revoked_by = v_actor where id = v_row;
  perform private.close_all_sessions(p_profile);
  if p_capability = 'config' then
    update private.admin_invitations i set revoked_at = v_now, revoked_by = v_actor
    where i.accepted_at is null and i.revoked_at is null and i.invited_by = p_profile;
  end if;
  if not exists (
      select 1 from public.admin_capabilities c
      where c.profile_id = p_profile and c.revoked_at is null) then
    delete from private.admin_factors f where f.profile_id = p_profile;
    perform private.drop_unbound_factors(p_profile);
    update private.admin_invitations i set revoked_at = v_now, revoked_by = v_actor
    where i.accepted_at is null and i.revoked_at is null and i.profile_id = p_profile;
  end if;
  return 'revoked';
end
$$;

-- Restablecer el segundo factor de otra persona del equipo. p_handoff es la huella del
-- código que quien restablece va a dictarle.
--   forbidden, needs_fresh_code
--   self         nadie se restablece a sí mismo
--   invalid      la huella no lo es
--   unavailable  falta el plazo de las invitaciones
--   ineligible   la cuenta no existe, no está activa, o su correo ya no es el de su atadura
--   not_member   no tiene ninguna capacidad
--   reset
create function private.reset_second_factor(p_profile uuid, p_handoff text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
begin
  perform private.team_lock();
  v_gate := private.team_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  if p_profile = private.actor_id() then
    return 'self';
  end if;
  return private.reset_factor(p_profile, p_handoff, private.actor_id(), null);
end
$$;

grant execute on function
  private.invite_admin(text, public.capability[]),
  private.revoke_admin_invitation(uuid),
  private.accept_admin_invitation(text, uuid, text),
  private.grant_capability(uuid, public.capability),
  private.revoke_capability(uuid, public.capability),
  private.reset_second_factor(uuid, text)
  to app_service;

-- ---------------------------------------------------------------------------------------
-- El arranque y la emergencia: solo el dueño de la base (decisión del 2026-10-12).
--
-- No son «security definer» y no tienen permisos para nadie: aunque alguien les diera el
-- de ejecutar, quien no es dueño no puede llamar a las piezas internas. Y piden que la
-- transacción se declare como sistema, para que la auditoría diga que no fue una persona.

-- Las dos primeras personas con configuración, y cualquier invitación que nadie del equipo
-- pueda hacer. Se acepta como todas: con el resguardo del buzón y un factor nuevo.
create function private.system_invite_admin(p_email text, p_capabilities public.capability[]) returns text
language plpgsql set search_path = ''
as $$
begin
  if not private.actor_is_system() then
    raise exception 'private.system_invite_admin(): declare the system actor first' using errcode = '42501';
  end if;
  perform private.team_lock();
  return private.place_invitation(p_email, p_capabilities, null);
end
$$;

-- Cuando nadie del equipo puede restablecer a alguien: quien podía perdió también su
-- factor, o a la persona le cambiaron el correo. p_email es a qué correo va la
-- invitación; nulo, al de la cuenta. Aceptarla pide que la cuenta tenga ese correo.
create function private.system_reset_second_factor(p_profile uuid, p_handoff text, p_email text) returns text
language plpgsql set search_path = ''
as $$
declare
  v_email text := p_email;
begin
  if not private.actor_is_system() then
    raise exception 'private.system_reset_second_factor(): declare the system actor first' using errcode = '42501';
  end if;
  perform private.team_lock();
  if v_email is null then
    select u.email into v_email from auth.users u where u.id = p_profile;
  end if;
  return private.reset_factor(p_profile, p_handoff, null, v_email);
end
$$;

-- ---------------------------------------------------------------------------------------
-- El servidor deja de escribir las capacidades: dar y quitar pasan por las funciones.

revoke insert, update on public.admin_capabilities from app_service;
revoke update (revoked_at, revoked_by) on public.admin_capabilities from app_service;

-- RF-712, segunda capa: el disparador cuenta lo mismo que private.revoke_capability(),
-- cuentas activas con configuración. Suspender a quien la tiene no pasa por aquí.
create or replace function private.guard_min_config_admins() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.capability = 'config' and old.revoked_at is null and new.revoked_at is not null then
    if (select count(distinct c.profile_id)
        from public.admin_capabilities c
        join public.profiles p on p.id = c.profile_id
        where c.capability = 'config' and c.revoked_at is null and p.status = 'active') < 2 then
      raise exception 'at least two people must keep the config capability (RF-712)'
        using errcode = '23514';
    end if;
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Cambiar un parámetro pide también el código reciente. Los plazos de arriba son
-- parámetros: con la puerta de 12 horas sola, quien tiene la sesión de alguien con
-- configuración se alargaría la ventana del código reciente y con ella invitaría. Vale
-- para todo parámetro y no para una lista: uno nuevo queda cubierto sin acordarse de él.
-- El sistema (la semilla, un trabajo) no da códigos. Corre después de
-- business_parameters_actor, que sigue diciendo lo suyo a quien no tiene configuración.

create function private.guard_parameter_fresh_code() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.actor_is_system() and private.team_change_gate() is not null then
    raise exception '%.%: a recent second factor code is required', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger business_parameters_fresh_code before insert or update on public.business_parameters
  for each row execute function private.guard_parameter_fresh_code();

-- ---------------------------------------------------------------------------------------
-- El vigilante aprende dos cosas: nadie de la aplicación escribe las capacidades, y nadie
-- toca las tablas del equipo. Lo demás es la versión de 20261010060736, sin cambios.

create or replace function private.schema_violations()
returns table (problem text, object_name text)
language sql stable security definer set search_path = ''
as $$
  with ledgers (table_schema, table_name) as (
    values
      ('public', 'watch_events'), ('public', 'charges'), ('public', 'charge_reversals'),
      ('public', 'revenue_allocations'), ('public', 'payout_student_pools'), ('public', 'payout_shares'),
      ('public', 'payout_teacher_totals'), ('public', 'payout_status_events'),
      ('public', 'payout_adjustments'), ('public', 'teacher_balance_entries'),
      ('public', 'reserve_entries'), ('public', 'legal_documents'), ('public', 'consents'),
      ('public', 'licenses'), ('public', 'audit_log'), ('private', 'teacher_tax_profiles'),
      ('private', 'student_aliases'), ('private', 'moderation_actions'),
      ('private', 'moderation_case_access_log')),
  app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service'))
  -- Tablas propias sin seguridad por fila (RNF-08).
  select 'table without row level security', n.nspname || '.' || c.relname
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and not c.relrowsecurity
  union all
  -- Funciones security definer sin search_path fijo.
  select 'security definer function without a fixed search_path', n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosecdef
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%')
  union all
  -- Funciones propias que cualquiera puede ejecutar.
  select 'function executable by PUBLIC', n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and pg_catalog.has_function_privilege('public', p.oid, 'execute')
  union all
  -- Escrituras a nivel de tabla para roles de usuario, fuera de la única prevista.
  select 'unexpected write privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  where g.grantee in ('anon', 'authenticated')
    and g.table_schema in ('public', 'private')
    and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    and not (g.grantee = 'authenticated' and g.table_name = 'saved_courses'
             and g.privilege_type in ('INSERT', 'DELETE'))
  union all
  -- Lo mismo, columna por columna, que no sale en la consulta de arriba. La única escritura
  -- por columnas prevista es la de la persona sobre sus propios datos de perfil.
  select distinct 'unexpected column write privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.grantee in ('anon', 'authenticated')
    and g.table_schema in ('public', 'private')
    and g.privilege_type in ('INSERT', 'UPDATE')
    and not (g.grantee = 'authenticated' and g.table_schema = 'public' and g.table_name = 'profiles'
             and g.privilege_type = 'UPDATE'
             and g.column_name in ('display_name', 'country_code', 'country_is_self_declared', 'locale'))
    and not (g.grantee = 'authenticated' and g.table_schema = 'public' and g.table_name = 'saved_courses'
             and g.privilege_type = 'INSERT')
  union all
  -- Del esquema privado, ni una columna, ni para leer.
  select distinct 'unexpected column privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.table_schema = 'private' and g.grantee in ('anon', 'authenticated')
  union all
  -- Nada concedido a todos: PUBLIC incluye al visitante y a cualquier rol que llegue después.
  select distinct 'privilege granted to PUBLIC', g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.grantee = 'PUBLIC' and g.table_schema in ('public', 'private')
  union all
  -- La clave secreta no toca tablas propias. Ningún rol de usuario toca el esquema privado.
  select 'unexpected privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  where (g.grantee = 'service_role' and g.table_schema in ('public', 'private'))
     or (g.grantee in ('anon', 'authenticated') and g.table_schema = 'private')
  union all
  -- Ningún rol de la aplicación puede editar ni borrar un libro.
  select 'ledger writable by ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  join ledgers l on l.table_schema = g.table_schema and l.table_name = g.table_name
  where g.grantee in (select r.rolname from app_roles r)
    and g.privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
  union all
  -- Ni editar una sola de sus columnas: el permiso por columna no sale en la consulta de arriba.
  select 'ledger column writable by ' || r.rolname, l.table_schema || '.' || l.table_name
  from ledgers l
  join pg_catalog.pg_namespace n on n.nspname = l.table_schema
  join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = l.table_name
  cross join app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, c.oid, 'UPDATE')
  union all
  -- La marca de contraseña solo la cambia private.claim_account() (TRD 9.2).
  select 'password_reset_required writable by ' || r.rolname, 'public.profiles'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.profiles'::regclass, 'password_reset_required', 'UPDATE')
  union all
  -- Las capacidades solo se escriben con las funciones que cambian el equipo (T-105).
  select 'admin_capabilities writable by ' || r.rolname, 'public.admin_capabilities'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.admin_capabilities'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.admin_capabilities'::regclass, 'DELETE, TRUNCATE')
  union all
  -- Las invitaciones y las ataduras no las toca ningún rol de la aplicación, ni para leer.
  select 'team table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('private.admin_invitations'), ('private.admin_factors')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
$$;
