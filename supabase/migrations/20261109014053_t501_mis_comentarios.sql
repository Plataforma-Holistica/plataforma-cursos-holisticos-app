-- T-501 · «Mis comentarios» (RF-801, RF-808; PA-24). Decisiones de Sergio del 2026-11-08: quien perdió el acceso a una lección
-- tiene que poder borrar lo suyo, y para eso necesita el id y la revisión de cada comentario, que hasta aquí solo daba leer la
-- lección (y eso pide acceso). Esta puerta da lo propio de quien actúa: sin parámetro de autor, sin pedir acceso, el
-- interruptor ni la marca `comments_accept`, porque es su privacidad, como borrar. Lo oculto por moderación no aparece: el
-- protocolo de riesgo lo conserva como evidencia (lo trae T-502). Los títulos de lo que ya no se ve sí: es su propio historial;
-- el enlace, solo si la lección se ve, con la regla de los comentarios (`comment_lesson`), no con una copia.
--
-- Cada fila con una lista exacta de claves: nada del comentario al que responde, del maestro, del filtro ni de los reportes.

create function private.comments_of_author(p_before_at timestamptz, p_before_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_rows jsonb;
begin
  if v_actor is null then
    return '{"answer": "not_found"}'::jsonb;
  end if;
  with page as (
    select c.id, c.revision, c.body, c.status, c.edited_at, c.created_at, c.parent_id, c.lesson_id,
           l.title as lesson_title, pc.title as course_title, pc.slug as course_slug,
           (private.comment_lesson(c.lesson_id)).id is not null as visible
    from public.comments c
    join public.published_lessons l on l.id = c.lesson_id
    join public.published_courses pc on pc.course_id = c.course_id
    -- Lo que su autor ve: publicado, en revisión, o en el filtro (que se dice en revisión). Ni lo oculto ni lo borrado.
    where c.author_id = v_actor
      and c.status in ('published', 'in_review', 'in_filter')
      and (p_before_at is null or p_before_id is null or (c.created_at, c.id) < (p_before_at, p_before_id))
    order by c.created_at desc, c.id desc
    limit 21)
  select coalesce(jsonb_agg(
           pg_catalog.jsonb_build_object(
             'id', p.id,
             'revision', p.revision,
             'body', p.body,
             'state', case p.status when 'published' then 'published' when 'in_review' then 'in_review' when 'in_filter' then 'in_review' end,
             'edited', p.edited_at is not null,
             'created_at', p.created_at,
             'is_reply', p.parent_id is not null,
             'course_title', p.course_title,
             'lesson_title', p.lesson_title,
             'course_slug', case when p.visible then p.course_slug end,
             'lesson_id', case when p.visible then p.lesson_id end)
           order by p.created_at desc, p.id desc), '[]'::jsonb)
  into v_rows
  from page p;
  return pg_catalog.jsonb_build_object(
    'answer', 'ok',
    'items', (select coalesce(jsonb_agg(e order by o), '[]'::jsonb) from jsonb_array_elements(v_rows) with ordinality as t (e, o) where o <= 20),
    'more', jsonb_array_length(v_rows) > 20);
end
$$;
revoke all on function private.comments_of_author(timestamptz, uuid) from public;
grant execute on function private.comments_of_author(timestamptz, uuid) to app_service;

-- ---------------------------------------------------------------------------------------
-- El área `comments` del vigilante, con la puerta nueva. Lo demás, igual que en `t501_puertas`.

create or replace function private.schema_violations_comments()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  tables (table_name) as (
    values ('public.comments'), ('public.profile_privacy')),
  -- Las que el servidor llama, y nadie más.
  doors (signature) as (
    values ('private.comment_post(uuid,uuid,text)'), ('private.comment_edit(uuid,text,bigint)'),
           ('private.comment_delete(uuid,bigint)'), ('private.comment_set_pseudonym(text)'),
           ('private.comments_for_lesson(uuid,timestamp with time zone,uuid)'),
           ('private.comment_replies(uuid,uuid,timestamp with time zone,uuid)'),
           ('private.comments_for_teacher(uuid,boolean,timestamp with time zone,uuid)'),
           ('private.comment_can_write(uuid)'), ('private.comment_lesson_of(uuid)'),
           ('private.comments_of_author(timestamp with time zone,uuid)')),
  -- Las piezas de adentro, que no ejecuta nadie de la aplicación.
  inner_parts (signature) as (
    values ('private.comments_open()'), ('private.comment_text_ok(text,integer,boolean)'), ('private.comment_lesson(uuid)'),
           ('private.comment_gate(uuid)'), ('private.comment_hit()'), ('private.comment_settle(uuid)'), ('private.comment_name(public.comments)'),
           ('private.comment_view(public.comments,uuid)'), ('private.comment_visible(public.comments,uuid)'),
           ('private.comment_reply_page(uuid,uuid,timestamp with time zone,uuid)'))
  -- Nadie de la aplicación toca las tablas: ni leer, ni escribir una columna. Todo pasa por las funciones.
  select 'comments table reachable by ' || r.rolname, t.table_name
  from app_roles r cross join tables t
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  select 'comments table without row security', t.table_name
  from tables t
  where not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = t.table_name::regclass)
  union all
  select 'comments table with a policy', t.table_name
  from tables t
  where exists (select 1 from pg_catalog.pg_policy p where p.polrelid = t.table_name::regclass)
  union all
  -- El guardián y la profundidad, fila por fila, antes, con su función y prendidos para las sesiones normales (`O`, o `A`
  -- siempre). El tipo es la suma de fila (1), antes (2), insertar (4), borrar (8) y actualizar (16).
  select 'comments without ' || g.label, 'public.comments'
  from (values ('guard', 'comments_guard', 'private.guard_comment()', 31),
               ('depth check', 'comments_parent_depth', 'private.check_comment_depth()', 23)) as g (label, name, fn, kind)
  where not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.comments'::regclass and t.tgname = g.name
      and t.tgfoid = g.fn::regprocedure and t.tgtype = g.kind and t.tgenabled in ('O', 'A'))
  union all
  -- El guardián decide por quién ejecuta: como dueño (`security definer`) dejaría pasar a todos. Lo mismo la profundidad.
  select 'comment trigger function runs as its owner', g.fn
  from (values ('private.guard_comment()'), ('private.check_comment_depth()')) as g (fn)
  where (select p.prosecdef from pg_catalog.pg_proc p where p.oid = g.fn::regprocedure)
  union all
  select 'comment function not executable by app_service', d.signature
  from doors d
  where not pg_catalog.has_function_privilege('app_service', d.signature::regprocedure, 'EXECUTE')
  union all
  select 'comment function executable by ' || r.rolname, d.signature
  from app_roles r cross join doors d
  where r.rolname <> 'app_service' and pg_catalog.has_function_privilege(r.rolname::name, d.signature::regprocedure, 'EXECUTE')
  union all
  select 'comment inner function executable by ' || r.rolname, i.signature
  from app_roles r cross join inner_parts i
  where pg_catalog.has_function_privilege(r.rolname::name, i.signature::regprocedure, 'EXECUTE')
  union all
  -- Una función nueva que nombre las tablas es una puerta nueva: entra a una de las dos listas.
  select 'comment function not listed', p.oid::regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname in ('private', 'public')
  where (p.proname ~ '^comments?_' or p.prosrc ~ 'public\.(comments|profile_privacy)\M')
    and p.proname not in ('guard_comment', 'check_comment_depth', 'schema_violations_comments')
    and p.oid::regprocedure::text not in (select signature from doors union all select signature from inner_parts)
$$;
