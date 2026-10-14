-- T-106 · Prácticas y niveles (RF-709, PA-67, FL-58). Esquema §5.2, §6 y §7.4.
-- Primera solicitud de T-106. Decisiones de Sergio del 2026-10-13: el panel de contenido son
-- pantallas propias, sin Payload; las tablas son public.practices y public.levels (la
-- fuente, no una copia publicada), arrancan vacías, el slug se fija al crear y cambiarlas
-- pide el código reciente del segundo factor.
--
-- Solo alguien del equipo con la capacidad Contenido las cambia, y solo por las funciones de
-- abajo, con auditoría en la misma transacción. El servidor solo las lee. El público lee las
-- activas. Quitar es desactivar: los cursos las referirán con llave foránea.

-- ---------------------------------------------------------------------------------------
-- Qué lista. Un tipo enumerado: ninguna función arma SQL con el texto que llega.

create type public.catalog_list as enum ('practices', 'levels');

-- La clave con que se comparan dos nombres: sin mayúsculas, sin acentos (descompuestos y
-- quitados, así cualquier letra acentuada y cualquier forma Unicode de escribirla da lo
-- mismo) y sin espacios de más, contando los espacios duros, que según la configuración
-- regional de la base `\s` vería o no. «Reiki», «Réiki» y «RÉIKI» son el mismo. Sin la
-- extensión unaccent, que no está instalada.
create function private.catalog_key(p_name text) returns text
language sql immutable set search_path = ''
as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.regexp_replace(normalize(pg_catalog.lower(p_name), NFD), '[\u0300-\u036f]', '', 'g'),
    '[\s\u00a0\u2007\u202f]+', ' ', 'g'))
$$;

-- El slug de un nombre: la clave, con todo lo que no es letra o dígito como guion. Vacío si
-- el nombre no tiene ni una letra ni un dígito.
create function private.catalog_slug(p_name text) returns text
language sql immutable set search_path = ''
as $$
  select pg_catalog.btrim(pg_catalog.left(
    pg_catalog.btrim(pg_catalog.regexp_replace(private.catalog_key(p_name), '[^a-z0-9]+', '-', 'g'), '-'), 50), '-')
$$;

-- ---------------------------------------------------------------------------------------
-- Las tablas. La posición es única y diferida: mover intercambia dos filas en dos pasos sin
-- un valor intermedio. El tono de portada (03 §4.1) lo asigna la base al crear, por rotación
-- de ocho en orden de creación; cambiarlo a mano espera a D-05.

create table public.practices (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  position integer not null,
  is_active boolean not null default true,
  cover_tone smallint not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint practices_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and pg_catalog.char_length(slug) <= 60),
  constraint practices_name_format check (
    name = pg_catalog.btrim(name) and pg_catalog.char_length(name) between 1 and 40 and name !~ '[[:cntrl:]]'
    and name is nfc normalized and name !~ '[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e007f]'),
  constraint practices_cover_tone check (cover_tone between 1 and 8),
  constraint practices_position_uq unique (position) deferrable initially deferred
);
comment on table public.practices is 'Las prácticas del catálogo (RF-709, PA-67). Solo las cambian las funciones private.catalog_*, con Contenido y el código reciente.';
create unique index practices_name_key on public.practices (private.catalog_key(name));

create table public.levels (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  position integer not null,
  is_active boolean not null default true,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint levels_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and pg_catalog.char_length(slug) <= 60),
  constraint levels_name_format check (
    name = pg_catalog.btrim(name) and pg_catalog.char_length(name) between 1 and 40 and name !~ '[[:cntrl:]]'
    and name is nfc normalized and name !~ '[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e007f]'),
  constraint levels_position_uq unique (position) deferrable initially deferred
);
comment on table public.levels is 'Los niveles del catálogo (RF-709, PA-67). Solo los cambian las funciones private.catalog_*, con Contenido y el código reciente.';
create unique index levels_name_key on public.levels (private.catalog_key(name));

alter table public.practices enable row level security;
alter table public.levels enable row level security;

-- Cualquiera lee lo activo (05 §6.5). El servidor lee todo y no escribe nada.
create policy practices_public_select on public.practices for select to anon, authenticated using (is_active);
create policy levels_public_select on public.levels for select to anon, authenticated using (is_active);
grant select on public.practices, public.levels to anon, authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- El guardián. No es security definer: mira quién ejecuta. Solo el dueño de la tabla, es
-- decir, una de las funciones de abajo, y a nombre de alguien que pasa la puerta de
-- Contenido (la capacidad y el código reciente). No acepta «el
-- sistema»: un ajuste de sesión no es una barrera, y mientras no haya semilla no hace falta.
-- Así, aunque algún día alguien le diera al servidor un permiso de escribir, escribir directo
-- no pasaría. Y nada cambia el id o el slug, ni se borra.

create function private.guard_catalog_list() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
begin
  -- Vaciar no pasa por los disparadores de cada fila: este mismo guardián lo cierra, para
  -- todos y antes que nada.
  if tg_op = 'TRUNCATE' then
    raise exception '%.%: rows are deactivated, not deleted', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner from pg_catalog.pg_class c where c.oid = tg_relid;
  if current_user::name <> v_owner or private.content_change_gate() is not null then
    raise exception '%.%: only the catalog functions write this list', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception '%.%: rows are deactivated, not deleted', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.slug is distinct from old.slug) then
    raise exception '%.%: id and slug do not change', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger catalog_guard before insert or update or delete on public.practices
  for each row execute function private.guard_catalog_list();
create trigger catalog_guard before insert or update or delete on public.levels
  for each row execute function private.guard_catalog_list();
create trigger touch_updated_at before update on public.practices
  for each row execute function private.touch_updated_at();
create trigger touch_updated_at before update on public.levels
  for each row execute function private.touch_updated_at();
create trigger audit_changes after insert or update or delete on public.practices
  for each row execute function private.audit_row_change('content');
create trigger audit_changes after insert or update or delete on public.levels
  for each row execute function private.audit_row_change('content');
create trigger catalog_no_truncate before truncate on public.practices
  for each statement execute function private.guard_catalog_list();
create trigger catalog_no_truncate before truncate on public.levels
  for each statement execute function private.guard_catalog_list();

-- ---------------------------------------------------------------------------------------
-- La puerta de Contenido. Nulo si pasa.
--   forbidden         quien actúa no tiene Contenido (o no hay quien actúe)
--   needs_fresh_code  la tiene, pero su sesión no pasa la puerta del equipo o su código no
--                     es reciente: que dé su código otra vez
-- Lo mismo que private.team_change_gate(), con Contenido en lugar de configuración: lo que
-- se cambia aquí lo ve el público, y una sesión robada no debe poder cambiarlo durante las
-- horas de la puerta (decisión de Sergio del 2026-10-13).

create function private.content_change_gate() returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
begin
  if v_actor is null or not exists (
      select 1 from public.admin_capabilities c
      where c.profile_id = v_actor and c.capability = 'content' and c.revoked_at is null) then
    return 'forbidden';
  end if;
  if not private.actor_has_capability('content')
     or not private.fresh_code(v_actor, private.actor_session()) then
    return 'needs_fresh_code';
  end if;
  return null;
end
$$;

-- Un cambio a una lista: exige read committed (cada sentencia ve lo que confirmó quien tenía
-- el candado) y toma el candado de esa lista. Dos personas reordenando van una tras otra.
create function private.catalog_lock(p_list public.catalog_list) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'catalog changes run in read committed' using errcode = '25000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('catalog:' || coalesce(p_list::text, ''), 0));
end
$$;

-- El nombre de la tabla de una lista. Del tipo enumerado, nunca del texto que llega.
create function private.catalog_table(p_list public.catalog_list) returns text
language sql immutable set search_path = ''
as $$ select case p_list when 'practices' then 'practices' when 'levels' then 'levels' end $$;

-- Un nombre con la forma de la tabla, ya sin espacios a los lados y en NFC, y que da un
-- slug: sin caracteres de control ni de formato (los de la categoría Cf de Unicode: el guion
-- suave, los de ancho cero, los que invierten o aíslan la dirección del texto, las
-- etiquetas), que no se ven y harían que dos nombres iguales no lo parecieran. Es la misma
-- clase que rechaza el servicio (`\p{Cf}`), escrita a mano.
create function private.catalog_name_ok(p_name text) returns boolean
language sql immutable set search_path = ''
as $$
  select p_name is not null and pg_catalog.char_length(p_name) between 1 and 40 and p_name !~ '[[:cntrl:]]'
     and p_name !~ '[\u00ad\u0600-\u0605\u061c\u06dd\u070f\u0890\u0891\u08e2\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\U000110bd\U000110cd\U00013430-\U0001343f\U0001bca0-\U0001bca3\U0001d173-\U0001d17a\U000e0000-\U000e007f]'
     and private.catalog_slug(p_name) <> ''
$$;

-- ---------------------------------------------------------------------------------------
-- Las funciones del servidor. Ninguna recibe quién actúa: es private.actor_id(). Todas toman
-- el candado de la lista y pasan la puerta antes de mirar lo que llega, y ninguna escribe
-- antes de rechazar: un choque de candados se puede reintentar.

--   added (con su id), duplicate, inactive_duplicate (con el id de la inactiva, para
--   reactivarla), invalid, forbidden, needs_fresh_code
create function private.catalog_add(p_list public.catalog_list, p_name text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_table text := private.catalog_table(p_list);
  v_name text := pg_catalog.btrim(normalize(p_name, NFC));
  v_slug text;
  v_try text;
  v_n integer := 1;
  v_found uuid;
  v_active boolean;
  v_position integer;
  v_id uuid;
begin
  perform private.catalog_lock(p_list);
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('answer', v_gate);
  end if;
  if v_table is null or not private.catalog_name_ok(v_name) then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;

  execute pg_catalog.format('select id, is_active from public.%I where private.catalog_key(name) = private.catalog_key($1)', v_table)
    into v_found, v_active using v_name;
  if v_found is not null then
    return pg_catalog.jsonb_build_object('answer', case when v_active then 'duplicate' else 'inactive_duplicate' end, 'id', v_found);
  end if;

  v_slug := private.catalog_slug(v_name);
  v_try := v_slug;
  loop
    execute pg_catalog.format('select id from public.%I where slug = $1', v_table) into v_found using v_try;
    exit when v_found is null;
    v_n := v_n + 1;
    v_try := v_slug || '-' || v_n;
  end loop;

  execute pg_catalog.format('select coalesce(max(position), 0) + 1 from public.%I', v_table) into v_position;
  if p_list = 'practices' then
    insert into public.practices (slug, name, position, cover_tone)
    values (v_try, v_name, v_position, (select (pg_catalog.count(*) % 8 + 1)::smallint from public.practices))
    returning id into v_id;
  else
    insert into public.levels (slug, name, position) values (v_try, v_name, v_position) returning id into v_id;
  end if;
  return pg_catalog.jsonb_build_object('answer', 'added', 'id', v_id);
end
$$;

--   renamed, unchanged (el mismo nombre: no escribe), duplicate, invalid, not_found,
--   forbidden, needs_fresh_code. El slug no cambia.
create function private.catalog_rename(p_list public.catalog_list, p_id uuid, p_name text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_table text := private.catalog_table(p_list);
  v_name text := pg_catalog.btrim(normalize(p_name, NFC));
  v_current text;
begin
  perform private.catalog_lock(p_list);
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  if v_table is null or not private.catalog_name_ok(v_name) then
    return 'invalid';
  end if;
  execute pg_catalog.format('select name from public.%I where id = $1 for no key update', v_table) into v_current using p_id;
  if v_current is null then
    return 'not_found';
  end if;
  if v_current = v_name then
    return 'unchanged';
  end if;
  execute pg_catalog.format(
    'select exists (select 1 from public.%I where id <> $1 and private.catalog_key(name) = private.catalog_key($2))', v_table)
    into v_gate using p_id, v_name;
  if v_gate::boolean then
    return 'duplicate';
  end if;
  execute pg_catalog.format('update public.%I set name = $2 where id = $1', v_table) using p_id, v_name;
  return 'renamed';
end
$$;

--   moved, edge (no hay una activa de ese lado), not_found (no existe o está inactiva),
--   invalid, forbidden, needs_fresh_code
create function private.catalog_move(p_list public.catalog_list, p_id uuid, p_direction text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_table text := private.catalog_table(p_list);
  v_position integer;
  v_active boolean;
  v_other uuid;
  v_other_position integer;
begin
  perform private.catalog_lock(p_list);
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  if v_table is null or p_direction is null or p_direction not in ('up', 'down') then
    return 'invalid';
  end if;
  execute pg_catalog.format('select position, is_active from public.%I where id = $1 for no key update', v_table)
    into v_position, v_active using p_id;
  if v_position is null or not v_active then
    return 'not_found';
  end if;
  if p_direction = 'up' then
    execute pg_catalog.format(
      'select id, position from public.%I where is_active and position < $1 order by position desc limit 1 for no key update', v_table)
      into v_other, v_other_position using v_position;
  else
    execute pg_catalog.format(
      'select id, position from public.%I where is_active and position > $1 order by position limit 1 for no key update', v_table)
      into v_other, v_other_position using v_position;
  end if;
  if v_other is null then
    return 'edge';
  end if;
  execute pg_catalog.format('update public.%I set position = $2 where id = $1', v_table) using p_id, v_other_position;
  execute pg_catalog.format('update public.%I set position = $2 where id = $1', v_table) using v_other, v_position;
  return 'moved';
end
$$;

--   deactivated, reactivated, unchanged, not_found, invalid, forbidden, needs_fresh_code.
--   Al reactivar conserva su posición.
create function private.catalog_set_active(p_list public.catalog_list, p_id uuid, p_active boolean) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_table text := private.catalog_table(p_list);
  v_active boolean;
begin
  perform private.catalog_lock(p_list);
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  if v_table is null or p_active is null then
    return 'invalid';
  end if;
  execute pg_catalog.format('select is_active from public.%I where id = $1 for no key update', v_table) into v_active using p_id;
  if v_active is null then
    return 'not_found';
  end if;
  if v_active = p_active then
    return 'unchanged';
  end if;
  execute pg_catalog.format('update public.%I set is_active = $2 where id = $1', v_table) using p_id, p_active;
  return case when p_active then 'reactivated' else 'deactivated' end;
end
$$;

-- Las dos listas, completas (inactivas incluidas), para la pantalla PA-67. Nulo para quien no
-- pasa la puerta del equipo con Contenido: una sola función, para que «no pasas» no se vea
-- como «no hay nada». No pide el código reciente: leer no cambia nada. Ese nulo no es una
-- barrera (el servidor lee la tabla entera): quien decide es la guarda del servicio.
create function private.catalog_lists() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.actor_id() is null or not private.actor_has_capability('content') then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.content_change_gate() is null,
    'practices', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', p.id, 'slug', p.slug, 'name', p.name, 'position', p.position,
               'is_active', p.is_active, 'cover_tone', p.cover_tone) order by p.position)
      from public.practices p), '[]'::jsonb),
    'levels', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', l.id, 'slug', l.slug, 'name', l.name, 'position', l.position,
               'is_active', l.is_active) order by l.position)
      from public.levels l), '[]'::jsonb));
end
$$;

grant execute on function
  private.catalog_add(public.catalog_list, text),
  private.catalog_rename(public.catalog_list, uuid, text),
  private.catalog_move(public.catalog_list, uuid, text),
  private.catalog_set_active(public.catalog_list, uuid, boolean),
  private.catalog_lists()
  to app_service;

-- ---------------------------------------------------------------------------------------
-- El vigilante aprende las dos listas: ningún rol de la aplicación las escribe, ni por
-- columna. Lo demás es la versión de 20261012233331, sin cambios.

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
  union all
  -- Las prácticas y los niveles solo los escriben las funciones de las listas (T-106).
  select 'catalog list writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.practices'), ('public.levels')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
$$;
