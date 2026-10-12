-- T-105 · El segundo factor en Auth (RF-106). TRD §9.2, fila «Segundo factor»; esquema §6.2.
-- Primera entrega de T-105.
--
-- Prender el segundo factor (TOTP) en Supabase Auth trae dos cosas a la base.
--
-- 1. El freno de los códigos. Un código son seis dígitos, y Auth solo limita los intentos
--    por dirección de quien llama. Quien ya tiene la contraseña de una cuenta puede abrir
--    una sesión y probar códigos llamando directo a Auth, sin pasar por la aplicación: un
--    freno en la aplicación no lo ve. Además, un código equivocado no gasta el reto (medido
--    el 2026-10-12 contra Auth v2.197.0). Por eso el freno vive donde Auth sí pregunta:
--    su gancho de intento de verificación, que es esta función.
--
-- 2. Saber si una cuenta tiene un factor verificado. Con uno, Auth exige una sesión de
--    segundo nivel para cambiar la contraseña, y el servicio tiene que saberlo antes.

-- ---------------------------------------------------------------------------------------
-- La tabla del freno. Privada y sin permisos para nadie: solo la toca el gancho.
--
-- No apunta a auth.mfa_factors: es del esquema de Supabase. Una fila de un factor que ya no
-- existe no estorba, y se olvida sola como cualquier otra.

create table private.second_factor_attempts (
  factor_id uuid primary key,                 -- el mismo valor que auth.mfa_factors.id
  failed_count integer not null check (failed_count > 0),
  last_failed_at timestamptz not null,
  locked_until timestamptz                    -- nulo mientras no llega al límite
);
comment on table private.second_factor_attempts is 'Fallos seguidos de cada factor al verificar su código. La escribe solo private.second_factor_attempt(), que Supabase Auth llama en cada intento.';

alter table private.second_factor_attempts enable row level security;

-- ---------------------------------------------------------------------------------------
-- El gancho. Auth lo llama en cada intento de verificación, antes de contestar, con
-- `{factor_id, user_id, factor_type, valid, metadata}`. Contesta `continue` o `reject`.
--
-- La regla es la del freno de entrar, con sus mismos parámetros: desde el fallo número
-- INTENTOS_ANTES_DE_FRENO el factor espera FRENO_ESPERA_BASE, y cada fallo siguiente el
-- doble, hasta FRENO_ESPERA_TOPE. Un acierto borra la cuenta; FRENO_OLVIDO sin fallar,
-- también. Mientras dura la espera no pasa ni el código correcto: si pasara, la espera no
-- frenaría a quien adivina.
--
--   · Cuando esto contesta `reject`, Auth además cierra la sesión del intento (medido): quien
--     adivina tiene que volver a entrar, y la persona que se equivocó de más, también.
--   · Si esta función lanza, Auth rechaza toda verificación (medido). Falla cerrado, y por
--     eso lo que no se entiende se rechaza en vez de lanzar.
--   · Los intentos de un mismo factor van uno tras otro, con un candado consultivo: dos a la
--     vez no se pisan la cuenta.

create function private.second_factor_attempt(event jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_continue constant jsonb := pg_catalog.jsonb_build_object('decision', 'continue');
  v_reject constant jsonb := pg_catalog.jsonb_build_object(
    'decision', 'reject', 'message', 'Too many second factor attempts.');
  v_text text := second_factor_attempt.event ->> 'factor_id';
  v_valid boolean := coalesce((second_factor_attempt.event ->> 'valid') = 'true', false);
  v_factor uuid;
  v_now timestamptz;
  v_threshold integer := (private.parameter_value('INTENTOS_ANTES_DE_FRENO'))::integer;
  v_base interval := pg_catalog.make_interval(mins => (private.parameter_value('FRENO_ESPERA_BASE'))::integer);
  v_top interval := pg_catalog.make_interval(mins => (private.parameter_value('FRENO_ESPERA_TOPE'))::integer);
  v_forget interval := pg_catalog.make_interval(mins => (private.parameter_value('FRENO_OLVIDO'))::integer);
  v_count integer;
  v_locked timestamptz;
  v_last timestamptz;
  v_wait interval;
begin
  -- Un intento que no dice de qué factor es, o cuyo factor no tiene forma de serlo.
  if v_text is null
     or v_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return v_reject;
  end if;
  v_factor := v_text::uuid;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('second_factor:' || v_text, 0));
  v_now := pg_catalog.clock_timestamp();

  select a.failed_count, a.locked_until, a.last_failed_at into v_count, v_locked, v_last
  from private.second_factor_attempts a where a.factor_id = v_factor;

  -- La espera manda sobre todo lo demás, también sobre el olvido: mientras dure, no pasa nada.
  if v_locked is not null and v_locked > v_now then
    return v_reject;
  end if;

  -- Fallos viejos: se olvidan, y la cuenta empieza de nuevo.
  if found and v_last < v_now - v_forget then
    delete from private.second_factor_attempts a where a.factor_id = v_factor;
    v_count := null;
  end if;

  if v_valid then
    delete from private.second_factor_attempts a where a.factor_id = v_factor;
    return v_continue;
  end if;

  v_count := coalesce(v_count, 0) + 1;
  if v_count < v_threshold then
    v_locked := null;
  else
    -- El doble por cada fallo de más, sin pasar del tope. El exponente se acota antes de
    -- elevar: con muchos fallos acumulados, la potencia se desbordaría.
    v_wait := least(v_base * pg_catalog.power(2, least(v_count - v_threshold, 20)), v_top);
    v_locked := v_now + v_wait;
  end if;

  insert into private.second_factor_attempts as a (factor_id, failed_count, last_failed_at, locked_until)
  values (v_factor, v_count, v_now, v_locked)
  on conflict (factor_id) do update
    set failed_count = excluded.failed_count,
        last_failed_at = excluded.last_failed_at,
        locked_until = excluded.locked_until;

  return case when v_locked is null then v_continue else v_reject end;
end
$$;

-- Quien llama al gancho es el rol con el que Auth entra a la base. Necesita llegar al
-- esquema privado, y de él solo ejecuta esta función.
grant usage on schema private to supabase_auth_admin;
grant execute on function private.second_factor_attempt(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------------------------
-- ¿Quien actúa tiene un factor verificado? Uno que quedó a medias no cuenta: Auth tampoco
-- lo cuenta para exigir segundo nivel.

create function private.has_verified_factor() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from auth.mfa_factors f
    where f.user_id = private.actor_id() and f.status = 'verified')
$$;

grant execute on function private.has_verified_factor() to app_service;
