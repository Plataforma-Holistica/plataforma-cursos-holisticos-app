-- T-104 · Freno de intentos y límites de peticiones (RF-102, RNF-08).
-- Esquema de backend §5.9 y §16.2. Segunda entrega de T-104.
--
-- Las dos tablas son "unlogged": rápidas y, si la base se reinicia de golpe, vacías. Para un
-- contador de una hora y un freno que de todos modos se olvida, es aceptable. Contar y
-- frenar es una sola sentencia del servicio (insert … on conflict do update … returning):
-- aquí no hay funciones.

-- Contadores por ventana. En entrada, registro y recuperación la clave lleva una huella
-- con secreto (HMAC), no el correo ni la IP.
create unlogged table private.rate_limit_counters (
  bucket text not null,                       -- 'comments:<profile_id>', o una huella en las rutas de cuenta
  window_start timestamptz not null,
  hits integer not null default 1,
  primary key (bucket, window_start),
  -- Cero y no uno: el intento que salió bien se descuenta, porque el tope es de fallos.
  constraint rate_limit_counters_hits_not_negative check (hits >= 0)
);

-- Freno progresivo del inicio de sesión (RF-102). Una fila por par de cuenta e IP.
-- Las dos claves son huellas HMAC-SHA256 que calcula el servicio: aquí no hay correos ni direcciones.
create unlogged table private.login_throttles (
  account_key bytea not null,                 -- huella del correo, exista o no la cuenta
  ip_key bytea not null,                      -- huella de la dirección IP
  failed_count integer not null default 0,    -- fallos seguidos; vuelve a cero al entrar bien
  locked_until timestamptz,                   -- hasta cuándo espera este par; nulo si no espera
  last_failed_at timestamptz,                 -- para olvidar tras FRENO_OLVIDO
  last_success_at timestamptz,                -- para FRENO_CONFIANZA_DIAS
  primary key (account_key, ip_key),
  constraint login_throttles_account_key_length check (octet_length(account_key) = 32),
  constraint login_throttles_ip_key_length check (octet_length(ip_key) = 32),
  constraint login_throttles_failed_not_negative check (failed_count >= 0)
);
comment on table private.login_throttles is 'Freno de inicio de sesión por par de cuenta e IP. Sin políticas: solo la toca app_service.';

-- Seguridad por fila y ninguna política: cerradas para toda persona, aunque alguien les
-- diera un permiso de más. El servidor, que la salta, lee, cuenta y purga.
alter table private.rate_limit_counters enable row level security;
alter table private.login_throttles enable row level security;

grant select, insert, update, delete on private.rate_limit_counters, private.login_throttles to app_service;

-- ---------------------------------------------------------------------------------------
-- Los parámetros del freno y de los topes (00-fundamentos.md §4). Los valores se cargan de
-- supabase/seeds/. ESPERA_REENVIO repite un valor que fija la configuración de Auth
-- (max_frequency), que se alinea cuando llegue esa configuración, con su prueba.

insert into public.parameter_definitions (key, description, value_type, unit, group_name, affects_payout) values
  ('FRENO_ESPERA_BASE', 'Espera tras el fallo que activa el freno; cada fallo seguido la duplica', 'integer', 'minutos', 'product', false),
  ('FRENO_ESPERA_TOPE', 'Espera máxima del freno de inicio de sesión', 'integer', 'minutos', 'product', false),
  ('FRENO_OLVIDO', 'Tiempo sin fallos tras el que la cuenta de fallos vuelve a cero', 'integer', 'minutos', 'product', false),
  ('FRENO_CONFIANZA_DIAS', 'Días en que una entrada correcta exime a ese par del tope por cuenta', 'integer', 'días', 'product', false),
  ('TOPE_INTENTOS_HORA', 'Inicios de sesión fallidos por hora, por IP y por cuenta', 'integer', null, 'product', false),
  ('TOPE_REGISTROS_HORA', 'Registros por hora desde una misma IP', 'integer', null, 'product', false),
  ('TOPE_ENVIOS_CORREO_HORA', 'Correos por hora hacia una misma dirección', 'integer', null, 'product', false),
  ('ESPERA_REENVIO', 'Espera entre dos correos a la misma dirección', 'integer', 'segundos', 'product', false)
on conflict (key) do nothing;
