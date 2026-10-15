-- T-203 · Los subtítulos se recuerdan en la cuenta (RF-310; diseño, sección 5.4; decisión de
-- Sergio del 2026-10-15): quien los encendió los encuentra encendidos en la siguiente lección
-- y en otro dispositivo.
--
-- Una columna de `profiles` que nace apagada. La escribe el servidor, a nombre de quien actúa,
-- por su columna: `app_service` no tiene `update` de la tabla entera (T-104), y una columna
-- nueva se le concede aquí a mano. La persona la lee con la política de su propio perfil; no
-- la escribe con su sesión. No se audita: no es un acto administrativo.

alter table public.profiles
  add column captions_on boolean not null default false;

comment on column public.profiles.captions_on is
  'Si la persona dejó los subtítulos encendidos la última vez (RF-310). Solo es una preferencia: no decide acceso.';

grant update (captions_on) on public.profiles to app_service;
