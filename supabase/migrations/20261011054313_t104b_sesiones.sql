-- T-104 · Las sesiones que la aplicación reconoce (RF-102, RNF-08). TRD §9.2, esquema §5.1 y §6.2.
-- Segunda entrega de T-104.
--
-- Cualquiera con la llave publicable puede pedirle una sesión directo a Supabase Auth. Y
-- Auth abre la sesión sin volver a mirar la cuenta: una entrada que leyó la contraseña
-- vieja termina de compararla y nace después de que el cambio de contraseña borró todas
-- las demás (medido contra el Auth local el 2026-10-10: en seis rondas de seis). Por eso
-- la aplicación no da por buena una sesión solo porque Auth la tiene:
--
--   · solo reconoce las sesiones que el servidor anotó al abrirlas;
--   · y solo anota una si su intento empezó después del último cambio de contraseña.
--
-- Lo que esto no cubre: quien ya tiene una sesión viva en Auth puede cambiar la contraseña
-- por fuera y entrar después por la aplicación. Cerrarlo pide sellar la contraseña, que se
-- decide aparte (TRD §9.2, «lo que no cubre»).
--
-- Tres cosas que esta migración da por sentadas:
--
--   · No rellena private.account_security. Ninguna base tiene todavía una cuenta reclamada
--     antes de esta migración; si la tuviera, esa cuenta no anotaría sesiones hasta
--     recuperar su contraseña. Falla cerrado.
--   · «Viva en Auth» mira solo auth.sessions.not_after. Los topes de duración y de
--     inactividad de Auth (timebox, inactivity_timeout) no se guardan ahí, y hoy están
--     apagados en supabase/config.toml: si se prenden, esto se revisa.
--   · El orden entre reclamar y anotar depende de que cada sentencia vea lo ya confirmado
--     (read committed, que es como abre sus transacciones el adaptador). Con otro
--     aislamiento las dos funciones se niegan a correr.

-- ---------------------------------------------------------------------------------------
-- Tablas. Privadas y sin permisos para nadie: solo las tocan las funciones de abajo.

create table private.app_sessions (
  session_id uuid primary key,                -- el mismo valor que auth.sessions.id
  profile_id uuid not null references public.profiles (id) on delete cascade,
  opened_at timestamptz not null default now()
);
comment on table private.app_sessions is 'Las sesiones que abrió la aplicación. Una sesión de Auth que no está aquí no entra. Solo se escribe con private.note_session().';
-- Lo anotado de una cuenta: al reclamarla se borra, y al anotar se limpia.
create index app_sessions_profile_idx on private.app_sessions (profile_id);

-- Aparte de profiles a propósito: su dueña lee profiles entera por la API de datos, y saber
-- cuándo cambió la contraseña sirve para afinar la carrera de arriba.
create table private.account_security (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  password_changed_at timestamptz not null    -- la escribe private.claim_account(), con el reloj de la base
);
comment on table private.account_security is 'Desde cuándo vale la contraseña de cada cuenta. Sin fila, la cuenta no anota sesiones.';

alter table private.app_sessions enable row level security;
alter table private.account_security enable row level security;

-- ---------------------------------------------------------------------------------------
-- Reclamar una cuenta también fecha el cambio de contraseña y borra lo anotado.
--
-- El servicio la llama después de fijar una contraseña, nunca antes. Fechar y borrar no
-- dependen de que la cuenta se pueda reclamar: si alguien fijó la contraseña de una cuenta
-- suspendida, lo anotado antes tampoco vale. Las respuestas no cambian.

create or replace function private.claim_account() returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_status public.profile_status;
  v_pending boolean;
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
  -- el mismo candado que toma private.note_session(): una sesión se anota antes del
  -- reclamo, y el reclamo la borra, o después, y ve la fecha nueva.
  select p.status, p.password_reset_required into v_status, v_pending
  from public.profiles p where p.id = v_actor for update;
  if not found then
    return 'ineligible';
  end if;

  insert into private.account_security (profile_id, password_changed_at)
  values (v_actor, pg_catalog.clock_timestamp())
  on conflict (profile_id) do update set password_changed_at = excluded.password_changed_at;
  delete from private.app_sessions s where s.profile_id = v_actor;

  if v_status <> 'active' then
    return 'ineligible';
  end if;
  if not exists (select 1 from auth.users u where u.id = v_actor and u.email_confirmed_at is not null) then
    return 'ineligible';
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

-- ---------------------------------------------------------------------------------------
-- Anotar una sesión: la única manera de que la aplicación la reconozca.
--
-- Actúa sobre la cuenta por la que el servidor declaró actuar, con el token que verificó.
-- p_started es la hora de la base que el servicio leyó ANTES de preguntarle a Auth.
--
--   noted       quedó anotada (o ya lo estaba)
--   stale       el intento empezó antes del último cambio de contraseña: Auth lo aceptó
--               con una contraseña que ya no vale
--   skewed      el intento viene del futuro, o tardó más de lo que tarda cualquier llamada
--               a Auth: el reloj no es de fiar, y no se sabe
--   unclaimed   la marca de contraseña sigue prendida, o la cuenta no tiene fecha de reclamo
--   gone        Auth no tiene esa sesión para esa cuenta, o ya pasó su fecha tope
--   ineligible  sin actor, sin perfil, cuenta que no está activa, o faltan datos
--
-- Límite, que vale para todo el camino de servicio (ADR-31): por quién se actúa lo declara
-- el servidor. Esto impide anotar una sesión vieja o ajena por descuido; no detiene a quien
-- ya pueda ejecutar consultas arbitrarias como app_service.

create function private.note_session(p_session uuid, p_started timestamptz) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_status public.profile_status;
  v_pending boolean;
  v_changed timestamptz;
  v_now timestamptz;
begin
  if v_actor is null or p_session is null or p_started is null then
    return 'ineligible';
  end if;
  -- Con una foto fija de la base, la fecha de abajo sería la de antes de un reclamo que
  -- acaba de confirmar, y su entrada vieja quedaría anotada.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.note_session() needs read committed isolation' using errcode = '25000';
  end if;
  select p.status, p.password_reset_required into v_status, v_pending
  from public.profiles p where p.id = v_actor for update;
  if not found or v_status <> 'active' then
    return 'ineligible';
  end if;
  if v_pending then
    return 'unclaimed';
  end if;
  select s.password_changed_at into v_changed
  from private.account_security s where s.profile_id = v_actor;
  if v_changed is null then
    return 'unclaimed';
  end if;

  -- Después del candado: si un reclamo iba delante, su fecha ya está escrita.
  v_now := pg_catalog.clock_timestamp();
  if p_started > v_now or p_started < v_now - interval '2 minutes' then
    return 'skewed';
  end if;
  if p_started < v_changed then
    return 'stale';
  end if;

  if not exists (
      select 1 from auth.sessions a
      where a.id = p_session and a.user_id = v_actor
        and (a.not_after is null or a.not_after > v_now)) then
    return 'gone';
  end if;

  -- De paso, lo anotado que Auth ya no tiene: no hay otro trabajo que lo limpie.
  delete from private.app_sessions x
  where x.profile_id = v_actor
    and not exists (select 1 from auth.sessions a where a.id = x.session_id);
  insert into private.app_sessions (session_id, profile_id) values (p_session, v_actor)
  on conflict (session_id) do nothing;
  return 'noted';
end
$$;

-- ---------------------------------------------------------------------------------------
-- ¿Reconoce la aplicación esta sesión? La guarda lo pregunta en cada entrada con sesión, en
-- la misma transacción en la que lee el perfil: no hace falta preguntarle a Auth.
--
--   recognized  anotada para quien actúa, y viva en Auth
--   not_noted   la aplicación no la abrió (o ya se borró lo anotado al cambiar la contraseña)
--   gone        anotada, pero Auth ya no la tiene o pasó su fecha tope
--   unknown     sin actor o sin identificador de sesión

create function private.session_recognized(p_session uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when private.actor_id() is null or p_session is null then 'unknown'
    when not exists (
      select 1 from private.app_sessions x
      where x.session_id = p_session and x.profile_id = private.actor_id()) then 'not_noted'
    when not exists (
      select 1 from auth.sessions a
      where a.id = p_session and a.user_id = private.actor_id()
        and (a.not_after is null or a.not_after > pg_catalog.clock_timestamp())) then 'gone'
    else 'recognized'
  end
$$;

grant execute on function private.note_session(uuid, timestamptz), private.session_recognized(uuid)
  to app_service;
