-- T-105 · La puerta del equipo (RF-105, RF-106). TRD §9.2, fila «Segundo factor»; esquema §6.2.
-- Segunda entrega de T-105, primera parte.
--
-- Hasta aquí, «con segundo factor» lo decía el token: private.is_aal2() lee su campo `aal`.
-- Pero un token ya emitido sigue diciendo `aal2` hasta que vence, aunque la sesión haya
-- perdido el nivel, y con una sesión verificada cualquiera puede borrar su factor y dar de
-- alta otro llamando directo a Supabase Auth (medido el 2026-10-12 contra Auth v2.197.0).
-- Por eso ser del equipo pasa a comprobarse en la base, en cada consulta. Hacen falta:
--
--   · una capacidad activa (public.admin_capabilities, que ya existía);
--   · un factor atado a la persona (private.admin_factors, que nace aquí);
--   · y una sesión que la aplicación abrió y que Auth tiene en segundo nivel con ese mismo
--     factor, verificada hace menos de VIGENCIA_SEGUNDO_FACTOR_HORAS.
--
-- Lo que esta migración no trae: quién ata un factor. Lo hará aceptar una invitación, que
-- llega en la siguiente. Mientras tanto nadie puede atar uno, así que nadie pasa la puerta:
-- una capacidad sin atadura no sirve de nada. Falla cerrado.

-- ---------------------------------------------------------------------------------------
-- El parámetro. Su valor de arranque está en supabase/seeds/business_parameters.sql,
-- transcrito de 00-fundamentos.md §4. En una base que ya corre se inserta a mano: sin él,
-- la puerta no deja pasar a nadie.

insert into public.parameter_definitions (key, description, value_type, unit, group_name, affects_payout) values
  ('VIGENCIA_SEGUNDO_FACTOR_HORAS', 'Cuánto vale una verificación del segundo factor para entrar a administración', 'integer', 'horas', 'product', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------
-- Qué factor de Auth es el de cada persona del equipo. Privada y sin permisos para nadie.
--
-- No apunta a auth.mfa_factors: es del esquema de Supabase. Un factor atado que Auth ya no
-- tiene, o que dejó de estar verificado, no pasa la puerta.

create table private.admin_factors (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles (id) on delete cascade,
  factor_id uuid not null unique,             -- el mismo valor que auth.mfa_factors.id
  bound_at timestamptz not null default now()
);
comment on table private.admin_factors is 'El factor de Supabase Auth de cada persona del equipo: uno por persona. Una sesión verificada con otro factor no pasa la puerta.';

alter table private.admin_factors enable row level security;

-- Atar y desatar un factor son actos administrativos: quedan en la auditoría (RF-706).
create trigger audit_changes after insert or update or delete on private.admin_factors
  for each row execute function private.audit_row_change('access');

-- ---------------------------------------------------------------------------------------
-- Con qué sesión se actúa. En el camino del usuario la dice su token; en el de servicio la
-- declara el servidor, que la saca del token que verificó: es el mismo trato que
-- app.actor_id. Lo que no tiene forma de identificador no se convierte: no hay sesión.
-- La forma se mira en un `case` antes de convertir, que es lo que garantiza el orden.

create function private.actor_session() returns uuid
language sql stable security definer set search_path = ''
as $$
  select case
    when v.raw ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then v.raw::uuid
  end
  from (
    select case
      when (select auth.uid()) is not null then (select auth.jwt()) ->> 'session_id'
      else pg_catalog.current_setting('app.actor_session', true)
    end as raw
  ) as v
$$;

-- ---------------------------------------------------------------------------------------
-- La puerta: ¿esta sesión de esta persona es una sesión del equipo? No mira capacidades: eso
-- lo preguntan las dos funciones de abajo, que son las únicas que la llaman. Nadie más
-- tiene permiso de ejecutarla, porque recibe de quién se pregunta.
--
-- Un paso por sentencia, de lo más barato a lo que lee Auth. Nunca lanza.

create function private.team_session(p_user uuid, p_session uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_factor uuid;
  v_hours integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  -- Sin persona o sin sesión no hace falta mirar aquí: abajo nada casa con un nulo.
  -- La cuenta: activa, y con la contraseña fijada por quien controla su buzón.
  if not exists (
      select 1 from public.profiles p
      where p.id = p_user and p.status = 'active' and not p.password_reset_required) then
    return false;
  end if;
  -- El factor atado, y que Auth lo siga teniendo verificado para esa misma cuenta. Sin
  -- atadura tampoco casa nada.
  select f.factor_id into v_factor from private.admin_factors f where f.profile_id = p_user;
  if not exists (
      select 1 from auth.mfa_factors m
      where m.id = v_factor and m.user_id = p_user
        and m.status = 'verified' and m.factor_type = 'totp') then
    return false;
  end if;
  -- La sesión: de las que abrió la aplicación, viva, y en segundo nivel con ese factor. La
  -- sesión de Auth no apunta al factor con una clave foránea: por eso se miró arriba.
  if not exists (
      select 1 from private.app_sessions x
      where x.session_id = p_session and x.profile_id = p_user) then
    return false;
  end if;
  if not exists (
      select 1 from auth.sessions s
      where s.id = p_session and s.user_id = p_user
        and s.aal = 'aal2' and s.factor_id = v_factor
        and (s.not_after is null or s.not_after > v_now)) then
    return false;
  end if;
  -- La verificación: del código, y reciente. Auth mueve esa hora al volver a verificar y no
  -- al renovar el token (medido). Sin el parámetro, o con uno que no vale, no pasa nadie.
  v_hours := private.second_factor_limit('VIGENCIA_SEGUNDO_FACTOR_HORAS');
  if v_hours is null then
    raise warning 'private.team_session: falta VIGENCIA_SEGUNDO_FACTOR_HORAS, o no es un entero de 1 en adelante. Nadie del equipo pasa.';
    return false;
  end if;
  -- En segundos y no con un intervalo: restarle a la hora un intervalo de muchas horas se
  -- sale del rango de una fecha, y eso lanzaría.
  return exists (
    select 1 from auth.mfa_amr_claims c
    where c.session_id = p_session and c.authentication_method = 'totp'
      and extract(epoch from (v_now - c.updated_at)) < v_hours::bigint * 3600);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Las dos preguntas de siempre, ahora sobre la puerta. Sus nombres, sus argumentos y quién
-- las ejecuta no cambian: las usan las políticas y los disparadores que ya existen.
--
-- Primero la capacidad, en un `case`: quien no la tiene no llega a leer nada de Auth ni el
-- parámetro. Es casi todo el mundo, porque estas funciones viven en políticas de tablas
-- que lee cualquier cuenta.

-- ¿La persona de la sesión tiene esta capacidad, en una sesión del equipo?
-- Lee las tablas en cada consulta: quitar una capacidad, desatar el factor o perder el
-- segundo nivel surten efecto de inmediato (RF-105), con el token todavía vigente.
create or replace function private.has_capability(p_capability public.capability) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when not exists (
      select 1 from public.admin_capabilities c
      where c.profile_id = (select auth.uid())
        and c.capability = p_capability
        and c.revoked_at is null) then false
    else private.team_session((select auth.uid()), private.actor_session())
  end
$$;

-- ¿Quien actúa tiene esta capacidad? Sirve a los dos caminos. Lo usan los disparadores
-- para que una ruta que olvidó comprobar no pueda escribir. El sistema no es del equipo:
-- no tiene ni cuenta ni sesión, y aquí contesta que no.
create or replace function private.actor_has_capability(p_capability public.capability) returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when not exists (
      select 1 from public.admin_capabilities c
      where c.profile_id = private.actor_id()
        and c.capability = p_capability
        and c.revoked_at is null) then false
    else private.team_session(private.actor_id(), private.actor_session())
  end
$$;
