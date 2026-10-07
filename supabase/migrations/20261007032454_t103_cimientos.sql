-- T-103 · Cimientos: esquemas, roles propios, privilegios por omisión y tipos.
-- Esquema de backend §3 (bloques 3.A y 3.B), recortado a lo que usa esta tarea.

-- ---------------------------------------------------------------------------------------
-- Esquemas, roles y privilegios por omisión (3.A)

create schema if not exists private;
create schema if not exists payload;

comment on schema private is 'Tablas y funciones que solo toca el servidor. La API de datos no lo expone.';
comment on schema payload is 'Colecciones de Payload CMS (ADR-20). Lo migra Payload, no esta carpeta.';

-- Roles propios. El permiso de entrada y la contraseña se asignan a mano,
-- fuera del repositorio: alter role app_service login password '...';
create role app_service nologin bypassrls;
create role payload_app nologin;

grant usage on schema public to anon, authenticated, app_service;
grant usage on schema private to authenticated, app_service;
grant usage, create on schema payload to payload_app;

-- Nada queda expuesto por omisión: cada tabla y cada función recibe su permiso a mano.
-- Se revoca todo, no solo leer y escribir: Supabase concede también truncate, references y
-- trigger, y a truncate no lo detiene la seguridad por fila.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
-- Postgres concede "execute" a PUBLIC en toda función nueva. Se revoca de forma global,
-- porque un privilegio por omisión global no se puede revocar esquema por esquema.
alter default privileges for role postgres
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------------------
-- Dominios y tipos enumerados (3.B). Solo los de esta tarea: los demás llegan con su tabla.

-- Un periodo es un mes: 202610.
create domain public.period_id as integer
  check (value between 202001 and 209912 and value % 100 between 1 and 12);
-- Un porcentaje, en puntos base: 6000 es 60 %.
create domain public.bps as integer check (value between 0 and 10000);

create type public.capability as enum ('content', 'finance', 'moderation', 'support', 'config');
create type public.profile_status as enum ('active', 'suspended', 'deleted');
create type public.parameter_status as enum ('decided', 'to_confirm', 'proposed', 'open');
create type public.audit_category as enum ('money', 'access', 'content', 'moderation', 'config', 'privacy');
