-- T-210, tercera solicitud · Mi lista (RF-311, PA-20, PA-02, FL-11 paso 6). Esquema §5.2.
--
-- Decisión de Sergio del 2026-10-28: la escribe el servidor, y la persona solo lee la suya. El
-- esquema planeaba que la persona escribiera directo; con eso, quien tuviera su token podía
-- guardar por la API de datos un curso que no está listado (la clave foránea no mira la
-- seguridad por fila). El área `base` del vigilante, congelada mientras haya dos carriles, todavía
-- permite ese permiso: el área `catalog`, de este carril, ahora lo prohíbe.
--
-- Decisiones mías sin confirmar: la lista de un perfil borrado se va con él (en producción un
-- perfil no se borra, queda lápida; las pruebas sí los borran); un guardián exige que el curso
-- esté listado y publicado y que la fila sea de la persona por la que actúa el servidor, para que
-- la base lo impida aunque la consulta se equivoque; y sin índice extra: la clave primaria empieza
-- por la persona. Un curso que deja de estar listado no se borra de las listas: la lectura lo
-- oculta, y vuelve si se lista otra vez.

create table public.saved_courses (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  course_id uuid not null references public.published_courses (course_id),
  created_at timestamptz not null default now(),
  primary key (profile_id, course_id)
);
comment on table public.saved_courses is 'Mi lista: los cursos que cada cuenta guardó para después (RF-311, T-210). La escribe el servidor, a nombre de quien actúa y solo con cursos listados; la persona lee la suya.';

alter table public.saved_courses enable row level security;

grant select on public.saved_courses to authenticated;
grant select, insert, delete on public.saved_courses to app_service;
create policy saved_courses_self_select on public.saved_courses
  for select to authenticated using (profile_id = (select auth.uid()));

-- El guardián. Es security definer para mirar el registro igual sea quien sea quien escribe:
-- la persona no lo ve. Un curso cuenta como publicado como en el catálogo: listado, y con el
-- registro publicado o con cambios pendientes.
create function private.guard_saved_course() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.profile_id is distinct from private.actor_id() then
    raise exception 'public.saved_courses: only for the person the server acts for'
      using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.published_courses c
    join public.course_registry r on r.course_id = c.course_id and r.state in ('published', 'changes_pending')
    where c.course_id = new.course_id and c.is_listed
  ) then
    raise exception 'public.saved_courses: the course is not listed'
      using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function private.guard_saved_course() from public;

create trigger saved_courses_guard before insert on public.saved_courses
  for each row execute function private.guard_saved_course();

-- ---------------------------------------------------------------------------------------
-- El área `catalog` del vigilante, del carril B: sus reglas de antes sin cambiar una letra, y
-- las de Mi lista al final.

create or replace function private.schema_violations_catalog()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service'))
  -- Las prácticas y los niveles solo los escriben las funciones de las listas (T-106).
  select 'catalog list writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.practices'), ('public.levels')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Lo publicado y lo que lo sostiene solo lo escriben las funciones de cargar y aprobar
  -- (T-107).
  select 'publication table writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.teachers'), ('public.published_teachers'), ('public.course_registry'),
                     ('public.video_assets'), ('public.published_courses'), ('public.published_modules'),
                     ('public.published_lessons')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- El orden de desempate de un maestro nunca sale de la base (RN-07).
  select 'teachers.tiebreak_rank readable by ' || r.rolname, 'public.teachers'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.teachers'::regclass, 'tiebreak_rank', 'SELECT')
  union all
  -- Lo que solo corre el dueño de la base, declarado sistema, no lo ejecuta nadie más.
  select 'system function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.system_catalog_add(public.catalog_list, text)'),
                     ('private.system_add_teacher(text, text, text)'),
                     ('private.system_load_course(uuid, jsonb)'),
                     ('private.catalog_place(public.catalog_list, text)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
  union all
  -- Mi lista (T-210): la escribe solo el servidor, que exige el curso listado. Ni la persona ni
  -- el visitante la escriben, ni una columna.
  select 'saved list writable by ' || r.rolname, 'public.saved_courses'
  from app_roles r
  where r.rolname <> 'app_service'
    and (pg_catalog.has_any_column_privilege(r.rolname::name, 'public.saved_courses'::regclass, 'INSERT, UPDATE, REFERENCES')
         or pg_catalog.has_table_privilege(r.rolname::name, 'public.saved_courses'::regclass, 'DELETE, TRUNCATE, TRIGGER'))
  union all
  -- La lee la persona (la suya) y el servidor; nadie más.
  select 'saved list readable by ' || r.rolname, 'public.saved_courses'
  from app_roles r
  where r.rolname in ('anon', 'service_role')
    and pg_catalog.has_any_column_privilege(r.rolname::name, 'public.saved_courses'::regclass, 'SELECT')
  union all
  -- El servidor guarda y quita; no edita una fila ni vacía la tabla.
  select 'saved list editable by app_service', 'public.saved_courses'
  where pg_catalog.has_any_column_privilege('app_service', 'public.saved_courses'::regclass, 'UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege('app_service', 'public.saved_courses'::regclass, 'TRUNCATE, TRIGGER')
  union all
  -- Una sola política: la persona con sesión lee sus filas.
  select 'saved list policy other than self read', 'public.saved_courses'
  from pg_catalog.pg_policy p
  where p.polrelid = 'public.saved_courses'::regclass
    and not (p.polcmd = 'r' and p.polpermissive
             and p.polroles = array['authenticated'::regrole]::oid[]
             and pg_catalog.pg_get_expr(p.polqual, p.polrelid) = '(profile_id = ( SELECT auth.uid() AS uid))')
  union all
  -- El guardián, presente y prendido.
  select 'saved list without insert guard', 'public.saved_courses'
  where not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.saved_courses'::regclass and t.tgname = 'saved_courses_guard' and t.tgenabled <> 'D')
$$;
revoke all on function private.schema_violations_catalog() from public;
