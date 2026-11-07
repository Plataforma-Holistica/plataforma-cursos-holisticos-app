-- T-501, primera solicitud · Comentarios por lección y respuesta del maestro, en la base (RF-801, RF-609; FL-15, FL-38).
-- Esquema §5.6. Plan aprobado por Sergio el 2026-11-06 (`~/.claude/plans/t501-comentarios-plan.md`), con la revisión
-- independiente del diseño.
--
-- Decisiones de Sergio del 2026-11-06: se construye tras el interruptor (`COMENTARIOS_ABIERTOS`, apagado); del seudónimo se
-- adelanta solo `profile_privacy.pseudonym`; comenta quien pasa la regla única de acceso, y el maestro del curso en sus
-- lecciones; borrar deja la fila vacía.
--
-- «Nunca se publica sin filtro» (RF-802, FL-15 E4) lo cuidan, en la base, dos cosas. Nadie de la aplicación tiene permisos
-- sobre las tablas: solo ejecuta funciones. Y un guardián solo deja publicar lo que viene del filtro (`filter_verdict =
-- 'pass'`, que llega con T-502) o lo que se asienta sin filtro con la marca local `comments_unfiltered` (la pone `db:login`;
-- en producción nadie la pone). Un comentario nace `in_filter` y se asienta en la misma transacción: sin la marca, queda en
-- revisión con `unavailable`, que es lo que FL-15 E4 dice de un filtro que no responde. La aplicación nunca elige el estado.
--
-- El acceso (RN-01) no lo decide la base: lo decide el servidor con la regla única, en la misma transacción en que escribe,
-- como al bajar un recurso. La base comprueba lo que no lo necesita: el interruptor, la cuenta activa, la lección vigente
-- de un curso publicado y listado, el maestro, el veto, el seudónimo y el freno.
--
-- Decisiones mías sin confirmar: `profile_privacy` la escribe solo el servidor (el 05 planeaba que la persona la escribiera
-- directo) y nace al elegir el seudónimo, no en `handle_new_user`, que es del área `account`, congelada; el freno de 10 cada
-- 10 minutos (TRD §9) se cuenta por minuto y suma los últimos diez, para que el cambio de ventana no deje pasar el doble, y
-- cuenta publicar y editar; borrar lo propio siempre se puede; un comentario editado no lo ven los demás mientras se asienta;
-- los de una lección retirada no se muestran ni aceptan respuestas.

create type public.comment_status as enum ('in_filter', 'published', 'in_review', 'hidden', 'deleted');

-- ---------------------------------------------------------------------------------------
-- El seudónimo (RF-808), como lo dejó el 05 §5.6. T-506 suma las pantallas y lo demás de la privacidad.

create table public.profile_privacy (
  profile_id uuid primary key references public.profiles (id),
  pseudonym text,                             -- con qué nombre aparece en los comentarios
  show_name_to_teachers boolean not null default false,   -- RN-15: si no, el maestro ve el alias
  is_public boolean not null default false,
  show_badges boolean not null default false,
  show_courses boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint profile_privacy_pseudonym_length check (char_length(pseudonym) between 2 and 40),
  constraint profile_privacy_no_public_profiles_yet
    check (not is_public and not show_badges and not show_courses)
);
comment on table public.profile_privacy is 'La privacidad de cada cuenta (RF-808). Por ahora solo el seudónimo de los comentarios (T-501); la escribe el servidor.';
alter table public.profile_privacy enable row level security;
create trigger touch_updated_at before update on public.profile_privacy
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------
-- Los comentarios (05 §5.6). `revision` no está en el 05: es lo que lleva editar y borrar para no pisar otra pestaña.

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null,
  course_id uuid not null,
  teacher_id uuid not null,                   -- el maestro de la lección
  author_id uuid references public.profiles (id),             -- nulo cuando se borra
  parent_id uuid references public.comments (id),             -- un solo nivel de respuesta (RF-801)
  is_teacher_reply boolean not null default false,            -- se distingue visualmente (RF-609)
  body text,                                                  -- nulo al borrarse
  status public.comment_status not null default 'in_filter',
  filter_verdict text,
  filter_checked_at timestamptz,
  report_count integer not null default 0,
  hidden_at timestamptz,                      -- cuenta para REINCIDENCIA_COMENTARIOS (T-502)
  revision bigint not null default 1,
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint comments_lesson_fk foreign key (lesson_id, course_id) references public.published_lessons (id, course_id),
  constraint comments_course_fk foreign key (course_id, teacher_id) references public.published_courses (course_id, teacher_id),
  constraint comments_body_ok check (body is null or private.draft_text_ok(body, 4000, true)),
  constraint comments_filter_verdict_known check (filter_verdict in ('pass', 'flagged', 'risk', 'unavailable')),
  constraint comments_report_count_positive check (report_count >= 0),
  constraint comments_deleted_consistent check (
    (status = 'deleted') = (body is null) and (status = 'deleted') = (deleted_at is not null)),
  constraint comments_author_consistent check (status = 'deleted' or author_id is not null),
  constraint comments_not_own_parent check (parent_id is null or parent_id <> id)
);
comment on table public.comments is 'Comentarios y respuestas por lección (RF-801, RF-609). El único lugar donde vive su texto. Nadie de la aplicación la lee ni la escribe: solo las funciones private.comment*.';
alter table public.comments enable row level security;

-- Lo de una lección, en orden (PA-22).
create index comments_lesson_idx on public.comments (lesson_id, created_at desc, id desc) where parent_id is null;
-- Respuestas de un comentario.
create index comments_parent_idx on public.comments (parent_id, created_at, id) where parent_id is not null;
-- Los de las lecciones de un maestro (PA-45).
create index comments_teacher_idx on public.comments (teacher_id, created_at desc, id desc) where parent_id is null;
-- Lo propio de un autor, su reincidencia y el borrado al eliminar la cuenta.
create index comments_author_idx on public.comments (author_id, created_at desc) where author_id is not null;

create trigger touch_updated_at before update on public.comments
  for each row execute function private.touch_updated_at();

-- Un solo nivel de respuesta (RF-801, 05 §11), y del mismo hilo: la respuesta cuelga de un comentario de la misma lección.
create function private.check_comment_depth() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.parent_id is not null and not exists (
       select 1 from public.comments c
       where c.id = new.parent_id and c.parent_id is null and c.lesson_id = new.lesson_id) then
    raise exception 'comments allow a single level of replies, in the same lesson (RF-801)' using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function private.check_comment_depth() from public;
-- Los disparadores corren por orden de nombre: este va después del guardián (`comments_guard`), que decide primero quién
-- escribe.
create trigger comments_parent_depth before insert or update of parent_id on public.comments
  for each row execute function private.check_comment_depth();

-- El guardián. Solo escribe el dueño de la tabla (las funciones de abajo son suyas); nadie borra filas (borrar es vaciar
-- la fila). Un comentario nace en filtro y sin veredicto. Publicar viene solo de asentar uno en filtro, y solo con el
-- veredicto del filtro o con la marca local; ir a revisión, con un veredicto que lo detiene. Un texto nuevo vuelve a filtro.
-- Lo que un comentario es (lección, curso, maestro, padre, si es del maestro, cuándo nació) no cambia, y su autor solo se
-- va al borrarse. Un comentario borrado ya no cambia. Ocultar es de T-502.
create function private.guard_comment() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
begin
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner from pg_catalog.pg_class c where c.oid = tg_relid;
  if current_user::name <> v_owner then
    raise exception 'public.comments: only through its functions' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'public.comments: a comment is emptied, never deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'in_filter' or new.filter_verdict is not null or new.filter_checked_at is not null
       or new.edited_at is not null or new.deleted_at is not null or new.hidden_at is not null
       or new.report_count <> 0 or new.revision <> 1 then
      raise exception 'public.comments: a comment is born in the filter' using errcode = '23514';
    end if;
    return new;
  end if;
  if old.status = 'deleted' then
    raise exception 'public.comments: a deleted comment does not change' using errcode = '23514';
  end if;
  if (new.lesson_id, new.course_id, new.teacher_id, new.parent_id, new.is_teacher_reply, new.created_at)
     is distinct from (old.lesson_id, old.course_id, old.teacher_id, old.parent_id, old.is_teacher_reply, old.created_at)
     or (new.author_id is distinct from old.author_id and new.status <> 'deleted') then
    raise exception 'public.comments: what a comment is does not change' using errcode = '23514';
  end if;
  if new.body is distinct from old.body and new.status not in ('in_filter', 'deleted') then
    raise exception 'public.comments: a new text goes through the filter' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    case new.status
      when 'published' then
        if old.status <> 'in_filter'
           or not (new.filter_verdict is not distinct from 'pass'
                   or (new.filter_verdict is null
                       and exists (select 1 from private.local_flags f where f.flag = 'comments_unfiltered'))) then
          raise exception 'public.comments: nothing is published without the filter (RF-802)' using errcode = '23514';
        end if;
      when 'in_review' then
        if old.status <> 'in_filter' or new.filter_verdict is null or new.filter_verdict = 'pass' then
          raise exception 'public.comments: a comment goes to review from the filter' using errcode = '23514';
        end if;
      when 'in_filter' then
        if old.status not in ('published', 'in_review') or new.body is not distinct from old.body then
          raise exception 'public.comments: only an edit goes back to the filter' using errcode = '23514';
        end if;
      when 'deleted' then
        null;
      else
        raise exception 'public.comments: % is not reachable yet', new.status using errcode = '23514';
    end case;
  end if;
  return new;
end
$$;
revoke all on function private.guard_comment() from public;
create trigger comments_guard before insert or update or delete on public.comments
  for each row execute function private.guard_comment();

-- ---------------------------------------------------------------------------------------
-- Las piezas internas. Ninguna la ejecuta un rol de la aplicación.

-- El interruptor (H-11, RF-804). Solo `true` abre: un valor nulo, que falte o que no sea booleano cuenta como cerrado.
create function private.comments_open() returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.parameter_value('COMENTARIOS_ABIERTOS') = 'true'::jsonb, false) $$;
revoke all on function private.comments_open() from public;

-- La lección donde se comenta: vigente, de un curso publicado (o con una versión abierta) y listado. Nula si no.
create function private.comment_lesson(p_lesson uuid) returns public.published_lessons
language sql stable security definer set search_path = ''
as $$
  select l.*
  from public.published_lessons l
  join public.published_courses c on c.course_id = l.course_id and c.is_listed
  join public.course_registry r on r.course_id = l.course_id and r.state in ('published', 'changes_pending')
  where l.id = p_lesson and l.is_current
$$;
revoke all on function private.comment_lesson(uuid) from public;

-- El portón de escribir, común a publicar y editar (sin el freno, que va al final de cada una). Primero se sabe si quien
-- escribe es el maestro de la lección: al maestro no se le pide seudónimo (aparece con el nombre de su ficha), y lo detienen
-- su suspensión y su aviso; a los demás, el veto y el seudónimo. Para el maestro toma su fila para compartir, como toda
-- escritura a su nombre: suspenderlo y escribir van uno tras otro.
create function private.comment_gate(p_lesson uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_lesson public.published_lessons;
  v_teacher public.teachers;
begin
  if not private.comments_open() then
    return '{"answer": "closed"}'::jsonb;
  end if;
  if v_actor is null or not exists (select 1 from public.profiles p where p.id = v_actor and p.status = 'active') then
    return '{"answer": "suspended_account"}'::jsonb;
  end if;
  v_lesson := private.comment_lesson(p_lesson);
  if v_lesson.id is null then
    return '{"answer": "not_found"}'::jsonb;
  end if;
  select t.* into v_teacher from public.teachers t where t.id = v_lesson.teacher_id;
  if v_teacher.profile_id = v_actor then
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
    if exists (select 1 from public.profiles p where p.id = v_actor and p.comment_ban_until > now()) then
      return '{"answer": "banned"}'::jsonb;
    end if;
    if not exists (select 1 from public.profile_privacy x where x.profile_id = v_actor and x.pseudonym is not null) then
      return '{"answer": "needs_pseudonym"}'::jsonb;
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'answer', 'ok', 'course', v_lesson.course_id, 'teacher', v_lesson.teacher_id,
    'is_teacher', v_teacher.profile_id = v_actor);
end
$$;
revoke all on function private.comment_gate(uuid) from public;

-- El freno: 10 cada 10 minutos por cuenta (TRD §9), contando publicar y editar. Cuenta por minuto y suma los últimos diez,
-- bajo un candado de la cuenta para que dos envíos a la vez no pasen los dos con el noveno. Lo que se niega no cuenta.
create function private.comment_hit() returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_bucket text := 'comments:' || private.actor_id();
  v_minute timestamptz := pg_catalog.date_trunc('minute', now());
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_bucket, 0));
  if (select coalesce(sum(c.hits), 0) from private.rate_limit_counters c
      where c.bucket = v_bucket and c.window_start > v_minute - interval '10 minutes') >= 10 then
    return false;
  end if;
  insert into private.rate_limit_counters as c (bucket, window_start, hits)
  values (v_bucket, v_minute, 1)
  on conflict (bucket, window_start) do update set hits = c.hits + 1;
  return true;
end
$$;
revoke all on function private.comment_hit() from public;

-- Asentar un comentario que está en filtro. En T-501 no hay filtro: con la marca local se publica sin veredicto, y sin ella
-- queda en revisión con `unavailable` (FL-15 E4). T-502 la reemplaza por la que recibe el veredicto del proveedor. Devuelve
-- el estado con que quedó.
create function private.comment_settle(p_comment uuid) returns public.comment_status
language plpgsql security definer set search_path = ''
as $$
declare
  v_status public.comment_status;
begin
  if exists (select 1 from private.local_flags f where f.flag = 'comments_unfiltered') then
    update public.comments set status = 'published', filter_checked_at = now()
    where id = p_comment and status = 'in_filter'
    returning status into v_status;
  else
    update public.comments set status = 'in_review', filter_verdict = 'unavailable', filter_checked_at = now()
    where id = p_comment and status = 'in_filter'
    returning status into v_status;
  end if;
  return v_status;
end
$$;
revoke all on function private.comment_settle(uuid) from public;

-- El nombre con que aparece un comentario: el de la ficha del maestro en lo suyo, el seudónimo en lo demás. Nunca el alias
-- ni el correo.
create function private.comment_name(p_comment public.comments) returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when p_comment.status = 'deleted' then null
    when p_comment.is_teacher_reply then (select t.display_name from public.published_teachers t where t.teacher_id = p_comment.teacher_id)
    else (select x.pseudonym from public.profile_privacy x where x.profile_id = p_comment.author_id)
  end
$$;
revoke all on function private.comment_name(public.comments) from public;

-- Lo que se ve de un comentario, con la lista exacta de claves. Lo que está en filtro o en revisión se dice `in_review`,
-- y solo lo ve su autor (lo decide quien llama). Lo borrado sale sin texto ni nombre.
create function private.comment_view(p_comment public.comments, p_viewer uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_comment.id,
    'name', private.comment_name(p_comment),
    'body', p_comment.body,
    'state', case p_comment.status when 'published' then 'published' when 'deleted' then 'deleted' else 'in_review' end,
    'own', p_comment.author_id is not distinct from p_viewer and p_comment.author_id is not null,
    'teacher', p_comment.is_teacher_reply,
    'edited', p_comment.edited_at is not null,
    'created_at', p_comment.created_at,
    'revision', case when p_comment.author_id = p_viewer then p_comment.revision end)
$$;
revoke all on function private.comment_view(public.comments, uuid) from public;

-- Si quien mira ve una respuesta: publicada, o suya en filtro o en revisión.
create function private.comment_visible(p_comment public.comments, p_viewer uuid) returns boolean
language sql stable set search_path = ''
as $$
  select p_comment.status = 'published'
      or (p_comment.status in ('in_filter', 'in_review') and p_comment.author_id = p_viewer)
$$;
revoke all on function private.comment_visible(public.comments, uuid) from public;

-- Las respuestas de un comentario que ve quien mira, de la más antigua a la más reciente, desde un cursor, 20 a la vez.
create function private.comment_reply_page(p_parent uuid, p_viewer uuid, p_after_at timestamptz, p_after_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with visible as (
    select r from public.comments r
    where r.parent_id = p_parent and private.comment_visible(r, p_viewer)
      and (p_after_at is null or (r.created_at, r.id) > (p_after_at, p_after_id))
    order by r.created_at, r.id
    limit 21)
  select pg_catalog.jsonb_build_object(
    'items', coalesce((select pg_catalog.jsonb_agg(private.comment_view(v.r, p_viewer) order by (v.r).created_at, (v.r).id)
                       from (select r from visible limit 20) v), '[]'::jsonb),
    'more', (select count(*) from visible) > 20)
$$;
revoke all on function private.comment_reply_page(uuid, uuid, timestamptz, uuid) from public;

-- ---------------------------------------------------------------------------------------
-- Lo que el servidor llama. Quien actúa es `private.actor_id()`. Escribir supone que el servidor ya decidió el acceso con la
-- regla única, en esta misma transacción.

-- Publicar un comentario o una respuesta (FL-15, FL-38).
create function private.comment_post(p_lesson uuid, p_parent uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate jsonb := private.comment_gate(p_lesson);
  v_parent public.comments;
  v_id uuid;
  v_status public.comment_status;
begin
  if v_gate ->> 'answer' <> 'ok' then
    return v_gate;
  end if;
  if not private.draft_text_ok(p_body, 4000, true) then
    return '{"answer": "invalid"}'::jsonb;
  end if;
  if p_parent is not null then
    -- Para compartir: borrar el padre a la vez espera a esta respuesta.
    select c.* into v_parent from public.comments c where c.id = p_parent for share;
    if v_parent.id is null or v_parent.lesson_id <> p_lesson or v_parent.parent_id is not null or v_parent.status <> 'published' then
      return '{"answer": "bad_parent"}'::jsonb;
    end if;
  end if;
  if not private.comment_hit() then
    return '{"answer": "throttled"}'::jsonb;
  end if;
  insert into public.comments (lesson_id, course_id, teacher_id, author_id, parent_id, is_teacher_reply, body)
  values (p_lesson, (v_gate ->> 'course')::uuid, (v_gate ->> 'teacher')::uuid, private.actor_id(), p_parent,
          (v_gate ->> 'is_teacher')::boolean, p_body)
  returning id into v_id;
  v_status := private.comment_settle(v_id);
  return pg_catalog.jsonb_build_object('answer', 'ok', 'id', v_id,
    'state', case v_status when 'published' then 'published' else 'in_review' end);
end
$$;
revoke all on function private.comment_post(uuid, uuid, text) from public;
grant execute on function private.comment_post(uuid, uuid, text) to app_service;

-- Editar lo propio (RF-801, FL-15 paso 8): las mismas puertas que publicar, con el freno, y otra vez por el filtro. Lleva la
-- revisión que se vio: otra pestaña pudo cambiarlo.
create function private.comment_edit(p_comment uuid, p_body text, p_seen bigint) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_comment public.comments;
  v_gate jsonb;
  v_status public.comment_status;
begin
  select c.* into v_comment from public.comments c
  where c.id = p_comment and c.author_id = private.actor_id() and c.status <> 'deleted';
  if v_comment.id is null then
    return '{"answer": "not_found"}'::jsonb;
  end if;
  v_gate := private.comment_gate(v_comment.lesson_id);
  if v_gate ->> 'answer' <> 'ok' then
    return v_gate;
  end if;
  if not private.draft_text_ok(p_body, 4000, true) then
    return '{"answer": "invalid"}'::jsonb;
  end if;
  -- Ya con la fila tomada, otra vez: pudo cambiar entre leer y tomar.
  select c.* into v_comment from public.comments c
  where c.id = p_comment and c.author_id = private.actor_id() and c.status <> 'deleted'
  for update;
  if v_comment.id is null then
    return '{"answer": "not_found"}'::jsonb;
  end if;
  if v_comment.revision is distinct from p_seen then
    return '{"answer": "changed"}'::jsonb;
  end if;
  if not private.comment_hit() then
    return '{"answer": "throttled"}'::jsonb;
  end if;
  update public.comments
  set body = p_body, status = 'in_filter', filter_verdict = null, filter_checked_at = null,
      edited_at = now(), revision = revision + 1
  where id = p_comment;
  v_status := private.comment_settle(p_comment);
  return pg_catalog.jsonb_build_object('answer', 'ok', 'id', p_comment,
    'state', case v_status when 'published' then 'published' else 'in_review' end);
end
$$;
revoke all on function private.comment_edit(uuid, text, bigint) from public;
grant execute on function private.comment_edit(uuid, text, bigint) to app_service;

-- Borrar lo propio (RF-801): siempre se puede, aunque estén cerrados o haya veto. Vacía la fila: sin texto ni autor, para no
-- romper el hilo de las respuestas.
create function private.comment_delete(p_comment uuid, p_seen bigint) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_comment public.comments;
begin
  select c.* into v_comment from public.comments c
  where c.id = p_comment and c.author_id = private.actor_id() and c.status <> 'deleted'
  for update;
  if v_comment.id is null or private.actor_id() is null then
    return '{"answer": "not_found"}'::jsonb;
  end if;
  if v_comment.revision is distinct from p_seen then
    return '{"answer": "changed"}'::jsonb;
  end if;
  update public.comments
  set body = null, status = 'deleted', deleted_at = now(), author_id = null, revision = revision + 1
  where id = p_comment;
  return '{"answer": "ok"}'::jsonb;
end
$$;
revoke all on function private.comment_delete(uuid, bigint) from public;
grant execute on function private.comment_delete(uuid, bigint) to app_service;

-- Elegir o cambiar el seudónimo (RF-808, FL-15 paso 3): de 2 a 40, en una línea, con la regla de los textos.
create function private.comment_set_pseudonym(p_pseudonym text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
begin
  if v_actor is null or not exists (select 1 from public.profiles p where p.id = v_actor and p.status = 'active') then
    return '{"answer": "suspended_account"}'::jsonb;
  end if;
  if not private.draft_text_ok(p_pseudonym, 40, false) or pg_catalog.char_length(p_pseudonym) < 2 then
    return '{"answer": "invalid"}'::jsonb;
  end if;
  insert into public.profile_privacy as x (profile_id, pseudonym) values (v_actor, p_pseudonym)
  on conflict (profile_id) do update set pseudonym = excluded.pseudonym;
  return pg_catalog.jsonb_build_object('answer', 'ok', 'pseudonym', p_pseudonym);
end
$$;
revoke all on function private.comment_set_pseudonym(text) from public;
grant execute on function private.comment_set_pseudonym(text) to app_service;

-- Los comentarios de una lección, para quien mira (PA-22): del más reciente al más antiguo, 20 a la vez desde un cursor, cada
-- uno con sus primeras respuestas. Se ven los publicados y lo propio en revisión; un comentario borrado solo si quien mira ve
-- alguna de sus respuestas. Con quién va a aparecer quien mira (`me`) y cuántos hay publicados, con respuestas.
create function private.comments_for_lesson(p_lesson uuid, p_before_at timestamptz, p_before_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_viewer uuid := private.actor_id();
  v_lesson public.published_lessons;
  v_items jsonb;
  v_more boolean;
begin
  if not private.comments_open() then
    return '{"answer": "closed"}'::jsonb;
  end if;
  v_lesson := private.comment_lesson(p_lesson);
  if v_lesson.id is null or v_viewer is null then
    return '{"answer": "not_found"}'::jsonb;
  end if;
  with visible as (
    select c, pg_catalog.row_number() over (order by c.created_at desc, c.id desc) as n
    from public.comments c
    where c.lesson_id = p_lesson and c.parent_id is null
      and (private.comment_visible(c, v_viewer)
           or (c.status = 'deleted' and exists (
                 select 1 from public.comments r where r.parent_id = c.id and private.comment_visible(r, v_viewer))))
      and (p_before_at is null or (c.created_at, c.id) < (p_before_at, p_before_id))
    order by c.created_at desc, c.id desc
    limit 21)
  select coalesce(pg_catalog.jsonb_agg(
           private.comment_view(v.c, v_viewer) || pg_catalog.jsonb_build_object(
             'replies', private.comment_reply_page((v.c).id, v_viewer, null, null))
           order by v.n) filter (where v.n <= 20), '[]'::jsonb),
         count(*) > 20
    into v_items, v_more
  from visible v;
  return pg_catalog.jsonb_build_object(
    'answer', 'ok',
    'items', v_items,
    'more', v_more,
    'count', (select count(*) from public.comments c where c.lesson_id = p_lesson and c.status = 'published'),
    'me', pg_catalog.jsonb_build_object(
      'teacher', exists (select 1 from public.teachers t where t.id = v_lesson.teacher_id and t.profile_id = v_viewer),
      'pseudonym', (select x.pseudonym from public.profile_privacy x where x.profile_id = v_viewer)));
end
$$;
revoke all on function private.comments_for_lesson(uuid, timestamptz, uuid) from public;
grant execute on function private.comments_for_lesson(uuid, timestamptz, uuid) to app_service;

-- Más respuestas de un comentario de esa lección, después de la última que se vio.
create function private.comment_replies(p_lesson uuid, p_parent uuid, p_after_at timestamptz, p_after_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_viewer uuid := private.actor_id();
begin
  if not private.comments_open() then
    return '{"answer": "closed"}'::jsonb;
  end if;
  if private.comment_lesson(p_lesson) is null or v_viewer is null
     or not exists (select 1 from public.comments c where c.id = p_parent and c.lesson_id = p_lesson and c.parent_id is null) then
    return '{"answer": "not_found"}'::jsonb;
  end if;
  return pg_catalog.jsonb_build_object('answer', 'ok') || private.comment_reply_page(p_parent, v_viewer, p_after_at, p_after_id);
end
$$;
revoke all on function private.comment_replies(uuid, uuid, timestamptz, uuid) from public;
grant execute on function private.comment_replies(uuid, uuid, timestamptz, uuid) to app_service;

-- Los comentarios de las lecciones de quien actúa como maestro (PA-45; RF-609), también suspendido: los publicados, del más
-- reciente al más antiguo, 20 a la vez, de un curso o de todos, y si se pide, solo los que no ha respondido. Con la
-- lección y el curso de cada uno, y sus primeras respuestas.
create function private.comments_for_teacher(p_course uuid, p_unanswered boolean, p_before_at timestamptz, p_before_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_viewer uuid := private.actor_id();
  v_teacher uuid := private.actor_teacher_id();
  v_items jsonb;
  v_more boolean;
begin
  if v_teacher is null then
    return '{"answer": "not_teacher"}'::jsonb;
  end if;
  if not private.comments_open() then
    return '{"answer": "closed"}'::jsonb;
  end if;
  with visible as (
    select c, l.title as lesson_title, pc.title as course_title, pc.slug as course_slug,
           pg_catalog.row_number() over (order by c.created_at desc, c.id desc) as n
    from public.comments c
    join public.published_lessons l on l.id = c.lesson_id and l.is_current
    join public.published_courses pc on pc.course_id = c.course_id and pc.is_listed
    join public.course_registry r on r.course_id = c.course_id and r.state in ('published', 'changes_pending')
    where c.teacher_id = v_teacher and c.parent_id is null and c.status = 'published'
      and (p_course is null or c.course_id = p_course)
      and (not coalesce(p_unanswered, false) or not exists (
             select 1 from public.comments x where x.parent_id = c.id and x.is_teacher_reply and x.status = 'published'))
      and (p_before_at is null or (c.created_at, c.id) < (p_before_at, p_before_id))
    order by c.created_at desc, c.id desc
    limit 21)
  select coalesce(pg_catalog.jsonb_agg(
           private.comment_view(v.c, v_viewer) || pg_catalog.jsonb_build_object(
             'lesson', (v.c).lesson_id, 'lesson_title', v.lesson_title, 'course', (v.c).course_id,
             'course_title', v.course_title, 'course_slug', v.course_slug,
             'answered', exists (select 1 from public.comments x
                                 where x.parent_id = (v.c).id and x.is_teacher_reply and x.status = 'published'),
             'replies', private.comment_reply_page((v.c).id, v_viewer, null, null))
           order by v.n) filter (where v.n <= 20), '[]'::jsonb),
         count(*) > 20
    into v_items, v_more
  from visible v;
  return pg_catalog.jsonb_build_object('answer', 'ok', 'items', coalesce(v_items, '[]'::jsonb), 'more', v_more);
end
$$;
revoke all on function private.comments_for_teacher(uuid, boolean, timestamptz, uuid) from public;
grant execute on function private.comments_for_teacher(uuid, boolean, timestamptz, uuid) to app_service;

-- ---------------------------------------------------------------------------------------
-- El área `comments` del vigilante, del carril B.

create function private.schema_violations_comments()
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
           ('private.comments_for_teacher(uuid,boolean,timestamp with time zone,uuid)')),
  -- Las piezas de adentro, que no ejecuta nadie de la aplicación.
  inner_parts (signature) as (
    values ('private.comments_open()'), ('private.comment_lesson(uuid)'), ('private.comment_gate(uuid)'),
           ('private.comment_hit()'), ('private.comment_settle(uuid)'), ('private.comment_name(public.comments)'),
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
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private'
  where (p.proname ~ '^comments?_' or p.prosrc ~ 'public\.(comments|profile_privacy)\M')
    and p.proname not in ('guard_comment', 'check_comment_depth', 'schema_violations_comments')
    and p.oid::regprocedure::text not in (select signature from doors union all select signature from inner_parts)
$$;
revoke all on function private.schema_violations_comments() from public;
