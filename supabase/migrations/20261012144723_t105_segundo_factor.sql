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
-- existe no estorba, y hoy nada la quita: limpiarlas queda para una tarea de mantenimiento.

create table private.second_factor_attempts (
  factor_id uuid primary key,                 -- el mismo valor que auth.mfa_factors.id
  failed_count integer not null check (failed_count > 0),
  last_failed_at timestamptz not null,
  locked_until timestamptz                    -- nulo mientras no llega al límite
);
comment on table private.second_factor_attempts is 'Fallos seguidos de cada factor al verificar su código. La escribe solo private.second_factor_attempt(), que Supabase Auth llama en cada intento.';

alter table private.second_factor_attempts enable row level security;

-- ---------------------------------------------------------------------------------------
-- Un parámetro del freno, en minutos o en intentos: un entero de 1 en adelante, o nulo si
-- falta o no lo es. Nunca lanza, tampoco con un número que no cabe en un entero: de eso
-- depende que el gancho pueda rechazar en vez de tumbarse. La forma se mira antes de
-- convertir, un paso por sentencia.
--
-- No tiene máximo propio: acepta todo entero positivo que quepa, y con cualquiera de ellos
-- el cálculo de la espera cabe. Que la combinación tenga sentido no lo mira esta función.
-- El guardián de los parámetros deja guardar además cero, negativos y enteros más grandes:
-- con esos el gancho rechaza todo. Que no se puedan guardar es asunto del guardián.

create function private.second_factor_limit(p_key text) returns integer
language plpgsql stable set search_path = ''
as $$
declare
  v_value jsonb := private.parameter_value(p_key);
  v_digits text;
begin
  -- Uno que falta tampoco es un número.
  if pg_catalog.jsonb_typeof(v_value) is distinct from 'number' then
    return null;
  end if;
  v_digits := v_value #>> '{}';
  -- Diez cifras caben siempre en un bigint: ahí se compara, y solo después se convierte.
  if v_digits !~ '^[0-9]{1,10}$' then
    return null;
  end if;
  if v_digits::bigint < 1 or v_digits::bigint > 2147483647 then
    return null;
  end if;
  return v_digits::integer;
end
$$;

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
--   · Cuando esto contesta `reject`, Auth además cierra TODAS las sesiones de esa cuenta,
--     no solo la del intento (medido). Quien adivina tiene que volver a entrar, y la dueña
--     de la cuenta también: entra de nuevo, o recupera su contraseña desde su correo.
--   · Si esta función lanza, Auth rechaza toda verificación (medido). Por eso no lanza con
--     nada que pueda llegarle: lo que no entiende lo rechaza. Y falla cerrado también con
--     sus parámetros: si falta uno, o no es un entero de 1 en adelante, rechaza todo hasta
--     que se corrija, en vez de quedarse sin freno. Ese rechazo no es el del freno: lleva
--     otro mensaje y deja un aviso en el registro de la base, para que quien opera lo vea.
--   · Los intentos de un mismo factor van uno tras otro, con un candado consultivo: dos a la
--     vez no se pisan la cuenta.

create function private.second_factor_attempt(event jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_continue constant jsonb := pg_catalog.jsonb_build_object('decision', 'continue');
  v_reject constant jsonb := pg_catalog.jsonb_build_object(
    'decision', 'reject', 'message', 'Too many second factor attempts.');
  v_unavailable constant jsonb := pg_catalog.jsonb_build_object(
    'decision', 'reject', 'message', 'Second factor verification is not available.');
  v_text text := second_factor_attempt.event ->> 'factor_id';
  -- Solo el booleano de JSON es un acierto: un texto que diga «true» no lo es.
  v_valid boolean := coalesce((second_factor_attempt.event -> 'valid') = 'true'::jsonb, false);
  v_factor uuid;
  v_now timestamptz;
  v_threshold integer := private.second_factor_limit('INTENTOS_ANTES_DE_FRENO');
  v_base integer := private.second_factor_limit('FRENO_ESPERA_BASE');
  v_top integer := private.second_factor_limit('FRENO_ESPERA_TOPE');
  v_forget integer := private.second_factor_limit('FRENO_OLVIDO');
  v_count integer;
  v_locked timestamptz;
  v_last timestamptz;
  v_wait integer;
begin
  -- Un intento que no dice de qué factor es, o cuyo factor no tiene forma de serlo.
  if v_text is null
     or v_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return v_reject;
  end if;
  -- Sin sus cuatro parámetros no hay regla que aplicar: no pasa nadie, y queda dicho.
  if v_threshold is null or v_base is null or v_top is null or v_forget is null then
    raise warning 'private.second_factor_attempt: se rechaza toda verificación del segundo factor. Falta, o no es un entero de 1 en adelante: %',
      pg_catalog.concat_ws(', ',
        case when v_threshold is null then 'INTENTOS_ANTES_DE_FRENO' end,
        case when v_base is null then 'FRENO_ESPERA_BASE' end,
        case when v_top is null then 'FRENO_ESPERA_TOPE' end,
        case when v_forget is null then 'FRENO_OLVIDO' end);
    return v_unavailable;
  end if;
  v_factor := v_text::uuid;

  -- Con el identificador ya en su forma única: escrito en mayúsculas es el mismo factor.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('second_factor:' || v_factor::text, 0));
  v_now := pg_catalog.clock_timestamp();

  select a.failed_count, a.locked_until, a.last_failed_at into v_count, v_locked, v_last
  from private.second_factor_attempts a where a.factor_id = v_factor;

  -- La espera manda sobre todo lo demás, también sobre el olvido: mientras dure, no pasa nada.
  if v_locked is not null and v_locked > v_now then
    return v_reject;
  end if;

  -- Fallos viejos: se olvidan, y la cuenta empieza de nuevo.
  if found and v_last < v_now - pg_catalog.make_interval(mins => v_forget) then
    delete from private.second_factor_attempts a where a.factor_id = v_factor;
    v_count := null;
  end if;

  if v_valid then
    delete from private.second_factor_attempts a where a.factor_id = v_factor;
    return v_continue;
  end if;

  -- La cuenta se queda en el entero más grande: sumarle uno lanzaría.
  v_count := least(coalesce(v_count, 0), 2147483646) + 1;
  if v_count < v_threshold then
    v_locked := null;
  else
    -- El doble por cada fallo de más, sin pasar del tope. El exponente se acota antes de
    -- elevar: con muchos fallos acumulados, la potencia se desbordaría.
    v_wait := least(v_base::bigint * (2 ^ least(v_count - v_threshold, 20))::bigint, v_top::bigint)::integer;
    v_locked := v_now + pg_catalog.make_interval(mins => v_wait);
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
