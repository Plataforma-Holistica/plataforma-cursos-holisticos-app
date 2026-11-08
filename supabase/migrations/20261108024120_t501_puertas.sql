-- T-501, segunda solicitud · Las dos puertas que le faltan al servidor, y el cerrojo de producción (RF-801; FL-15).
-- Plan aprobado por Sergio el 2026-11-07 (`~/.claude/plans/t501-solicitud2-plan.md`), con la revisión independiente del
-- diseño.
--
-- El acceso (RN-01) lo decide el servidor con la regla única, en la misma transacción en que llama a la base. Para editar
-- necesita la lección del comentario, y la tiene que dar la base: si la tomara del formulario, quien tiene acceso a una
-- lección podría editar con ella un comentario suyo de otra (`comment_lesson_of`). Para pintar el campo o su sustituto
-- antes de que alguien escriba, la pantalla pregunta lo que contestaría el portón (`comment_can_write`).
--
-- El cerrojo (decisión de Sergio del 2026-11-07): hasta T-502 no hay filtro, y prender `COMENTARIOS_ABIERTOS` en
-- producción aceptaría comentarios que nadie revisa. Publicar, editar y elegir el seudónimo piden además la marca local
-- `comments_accept`, que pone `db:login` y en producción nadie pone, como `comments_unfiltered`. Sin ella contestan
-- `closed`. Leer y borrar no la piden: no aceptan nada nuevo. T-502 la quita.
--
-- Decisiones mías sin confirmar: las dos puertas, de solo lectura; `comment_can_write` dice solo la respuesta, sin el
-- curso ni el maestro, y no cuenta el freno.

-- ---------------------------------------------------------------------------------------
-- El portón, con el cerrojo. Lo demás, igual que en `t501_comentarios`.

create or replace function private.comment_gate(p_lesson uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_lesson public.published_lessons;
  v_teacher public.teachers;
begin
  if not private.comments_open() or not exists (select 1 from private.local_flags f where f.flag = 'comments_accept') then
    return '{"answer": "closed"}'::jsonb;
  end if;
  if v_actor is null or not exists (select 1 from public.profiles p where p.id = v_actor and p.status = 'active') then
    return '{"answer": "suspended_account"}'::jsonb;
  end if;
  v_lesson := private.comment_lesson(p_lesson);
  if v_lesson.id is null then
    return '{"answer": "not_found"}'::jsonb;
  end if;
  if exists (select 1 from public.profiles p where p.id = v_actor and p.comment_ban_until > now()) then
    return '{"answer": "banned"}'::jsonb;
  end if;
  select t.* into v_teacher from public.teachers t where t.id = v_lesson.teacher_id;
  if v_teacher.profile_id is not distinct from v_actor then
    if v_teacher.status <> 'active' then
      return '{"answer": "suspended"}'::jsonb;
    end if;
    if private.teacher_notice_pending(v_actor) then
      return '{"answer": "needs_notice"}'::jsonb;
    end if;
    if private.current_active_teacher_id() is distinct from v_teacher.id then
      return '{"answer": "suspended"}'::jsonb;
    end if;
  else
    if not exists (select 1 from public.profile_privacy x where x.profile_id = v_actor and x.pseudonym is not null) then
      return '{"answer": "needs_pseudonym"}'::jsonb;
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'answer', 'ok', 'course', v_lesson.course_id, 'teacher', v_lesson.teacher_id,
    'is_teacher', v_teacher.profile_id is not distinct from v_actor);
end
$$;

-- Elegir o cambiar el seudónimo, con el cerrojo: también es aceptar algo que se publica.
create or replace function private.comment_set_pseudonym(p_pseudonym text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
begin
  if not exists (select 1 from private.local_flags f where f.flag = 'comments_accept') then
    return '{"answer": "closed"}'::jsonb;
  end if;
  if v_actor is null or not exists (select 1 from public.profiles p where p.id = v_actor and p.status = 'active') then
    return '{"answer": "suspended_account"}'::jsonb;
  end if;
  -- Con el veto no: el seudónimo renombra lo que ya publicó, y sería escribir sin derecho a comentar. Con el interruptor
  -- COMENTARIOS_ABIERTOS apagado sí, porque es de su privacidad (RF-808) y nadie lo ve; el cerrojo de arriba sí lo cierra.
  if exists (select 1 from public.profiles p where p.id = v_actor and p.comment_ban_until > now()) then
    return '{"answer": "banned"}'::jsonb;
  end if;
  if not private.comment_text_ok(p_pseudonym, 40, false) or pg_catalog.char_length(p_pseudonym) < 2 then
    return '{"answer": "invalid"}'::jsonb;
  end if;
  insert into public.profile_privacy as x (profile_id, pseudonym) values (v_actor, p_pseudonym)
  on conflict (profile_id) do update set pseudonym = excluded.pseudonym;
  return pg_catalog.jsonb_build_object('answer', 'ok', 'pseudonym', p_pseudonym);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Las dos puertas nuevas.

-- Lo que contestaría el portón a quien actúa en esa lección, sin escribir ni contar el freno: si la pantalla pinta el
-- campo o su sustituto. Solo la respuesta. Es volátil porque el portón toma la fila del maestro para compartir.
create function private.comment_can_write(p_lesson uuid) returns jsonb
language sql security definer set search_path = ''
as $$ select pg_catalog.jsonb_build_object('answer', private.comment_gate(p_lesson) ->> 'answer') $$;
revoke all on function private.comment_can_write(uuid) from public;
grant execute on function private.comment_can_write(uuid) to app_service;

-- La lección de un comentario propio sin borrar, o nada: con ella decide el servidor si se puede editar. Un comentario no
-- cambia de lección (`guard_comment`), así que leerla aparte de editar no abre ninguna carrera.
create function private.comment_lesson_of(p_comment uuid) returns uuid
language sql stable security definer set search_path = ''
as $$
  select c.lesson_id from public.comments c
  where c.id = p_comment and c.author_id = private.actor_id() and c.status <> 'deleted'
$$;
revoke all on function private.comment_lesson_of(uuid) from public;
grant execute on function private.comment_lesson_of(uuid) to app_service;

-- ---------------------------------------------------------------------------------------
-- El área `comments` del vigilante, con las dos puertas.

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
           ('private.comment_can_write(uuid)'), ('private.comment_lesson_of(uuid)')),
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
