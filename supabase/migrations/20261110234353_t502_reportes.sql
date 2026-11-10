-- T-502, segunda solicitud · Reportar y ocultar (RF-803; FL-16). Plan aprobado por Sergio el 2026-11-09
-- (`~/.claude/plans/t502-plan.md`), con la revisión independiente del diseño y sus decisiones de ese día.
--
-- Cualquiera que lee un comentario publicado lo puede reportar, con un motivo y una nota opcional, una vez. Para ocultarlo cuentan
-- solo los reportes de quienes pueden escribir ahí (con suscripción, o el maestro): eso lo decide el servidor con la regla de
-- acceso, en la misma transacción, y lo manda en `cuenta`; la base no ve la regla. Al llegar a `REPORTES_PARA_OCULTAR` reportes que
-- cuentan, el comentario queda oculto hasta que moderación lo revise (T-503). Sin valor en el parámetro, no se oculta.
--
-- La puerta toma la lección del comentario, nunca de quien llama, y contesta igual a lo que no existe, a lo propio, a lo que no está
-- publicado y a lo ya oculto; y contesta lo mismo oculte o no (FL-16 A3: nunca se sabe cuántos reportaron). Cada reporte guarda el
-- texto que se reportó: si el autor lo edita, la evidencia se queda (decisión de Sergio del 2026-11-09). Nadie de la aplicación lee
-- ni escribe la tabla.
--
-- Lo oculto, para los demás (también la maestra: decisión de Sergio del 2026-11-09), sale sin texto, sin nombre y sin decir si era
-- del maestro, como lo borrado; su autor lo ve con su texto. Sus respuestas se ocultan con él (protocolo de riesgo) y salen del
-- número de la pestaña. En PA-45 y en «Mis comentarios» no aparece.
--
-- Decisiones mías sin confirmar: el freno de 10 reportes por hora por cuenta; reportar pide el interruptor y el cerrojo de producción,
-- como publicar; una cuenta con el veto sí reporta; sin valor en el parámetro no se oculta; lo oculto no aparece en PA-45.

create type public.report_reason as enum ('spam', 'abusive', 'medical_advice', 'concern_for_person', 'other');

create table public.comment_reports (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.comments (id) on delete cascade,
  reporter_id uuid references public.profiles (id) on delete set null,   -- nulo al eliminar la cuenta
  reason public.report_reason not null,
  note text,
  reported_body text not null,              -- el texto que se reportó: si el autor lo edita, la evidencia se queda
  counts boolean not null,                  -- si quien reportó podía escribir ahí (cuenta para ocultar)
  created_at timestamptz not null default now(),
  constraint comment_reports_note_ok check (note is null or private.comment_text_ok(note, 1000, true))
);
comment on table public.comment_reports is 'Reportes de comentarios con su motivo, uno por persona (RF-803). Nadie de la aplicación la lee ni la escribe: solo private.comment_report.';
alter table public.comment_reports enable row level security;
revoke all on public.comment_reports from public;
-- `REPORTES_PARA_OCULTAR` cuenta personas.
create unique index comment_reports_one_per_person on public.comment_reports (comment_id, reporter_id) where reporter_id is not null;
create index comment_reports_reporter_idx on public.comment_reports (reporter_id) where reporter_id is not null;

-- El guardián de los reportes: solo escribe el dueño de la tabla, nadie los borra, y lo único que cambia es quién reportó, a nulo,
-- al eliminar su cuenta.
create function private.guard_comment_report() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
begin
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner from pg_catalog.pg_class c where c.oid = tg_relid;
  if current_user::name <> v_owner then
    raise exception 'public.comment_reports: only through its functions' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'public.comment_reports: a report is never deleted' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.reporter_id is not null
     or (new.id, new.comment_id, new.reason, new.note, new.reported_body, new.counts, new.created_at)
        is distinct from (old.id, old.comment_id, old.reason, old.note, old.reported_body, old.counts, old.created_at)) then
    raise exception 'public.comment_reports: a report does not change' using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function private.guard_comment_report() from public;
create trigger comment_reports_guard before insert or update or delete on public.comment_reports
  for each row execute function private.guard_comment_report();

-- ---------------------------------------------------------------------------------------
-- El guardián de los comentarios, con ocultar. Lo demás, igual que en `t502_filtro`.

create or replace function private.guard_comment() returns trigger
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
    if new.status <> 'in_filter' or new.filter_verdict is not null or new.filter_provider is not null
       or new.filter_checked_at is not null or new.edited_at is not null or new.deleted_at is not null
       or new.hidden_at is not null or new.report_count <> 0 or new.revision <> 1 then
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
        -- Solo el aprobado de un proveedor conocido publica: ni la lista, ni el barrido, ni la falta de proveedor, ni un nombre
        -- que no esté aquí. Hoy solo el de prueba, con su marca local; el real entra a esta lista cuando se elija (RF-802).
        if old.status <> 'in_filter' or new.filter_verdict is distinct from 'pass'
           or new.filter_provider is distinct from 'test'
           or not exists (select 1 from private.local_flags f where f.flag = 'comments_test_filter') then
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
        -- El veredicto era del texto de antes: si se quedara, el texto nuevo se publicaría con él.
        if new.filter_verdict is not null or new.filter_provider is not null or new.filter_checked_at is not null then
          raise exception 'public.comments: back to the filter without the verdict of the old text' using errcode = '23514';
        end if;
      when 'hidden' then
        -- Se oculta lo publicado, por reportes, con su hora (RF-803). Volver es de moderación (T-503).
        if old.status <> 'published' or new.hidden_at is null or new.report_count < 1 then
          raise exception 'public.comments: only reports hide a published comment' using errcode = '23514';
        end if;
      when 'deleted' then
        if old.status = 'hidden' then
          raise exception 'public.comments: a hidden comment waits for moderation' using errcode = '23514';
        end if;
      else
        raise exception 'public.comments: % is not reachable yet', new.status using errcode = '23514';
    end case;
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Lo oculto, al leer.

-- Lo que se ve de un comentario. Lo oculto, para quien no es su autor, sale sin texto, sin nombre y sin decir si era del maestro.
create or replace function private.comment_view(p_comment public.comments, p_viewer uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_comment.id,
    'name', case when p_comment.status = 'hidden' and p_comment.author_id is distinct from p_viewer then null else private.comment_name(p_comment) end,
    'body', case when p_comment.status = 'hidden' and p_comment.author_id is distinct from p_viewer then null else p_comment.body end,
    'state', case p_comment.status when 'published' then 'published' when 'deleted' then 'deleted' when 'hidden' then 'hidden' else 'in_review' end,
    'own', p_comment.author_id is not distinct from p_viewer and p_comment.author_id is not null,
    'teacher', p_comment.is_teacher_reply and p_comment.status not in ('deleted', 'hidden'),
    'edited', p_comment.edited_at is not null and p_comment.status not in ('deleted', 'hidden'),
    'created_at', p_comment.created_at,
    'revision', case when p_comment.author_id = p_viewer then p_comment.revision end)
$$;

-- Si quien mira ve un comentario: publicado, oculto (como su lugar), o suyo en filtro o en revisión.
create or replace function private.comment_visible(p_comment public.comments, p_viewer uuid) returns boolean
language sql stable set search_path = ''
as $$
  select p_comment.status in ('published', 'hidden')
      or (p_comment.status in ('in_filter', 'in_review') and p_comment.author_id = p_viewer)
$$;

-- Las respuestas de un comentario que ve quien mira. Las de uno oculto se ocultan con él.
create or replace function private.comment_reply_page(p_parent uuid, p_viewer uuid, p_after_at timestamptz, p_after_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with visible as (
    select r, pg_catalog.row_number() over (order by r.created_at, r.id) as n
    from public.comments r
    where r.parent_id = p_parent and private.comment_visible(r, p_viewer)
      and not exists (select 1 from public.comments p where p.id = p_parent and p.status = 'hidden')
      and (p_after_at is null
           or (r.created_at, r.id) > (p_after_at, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    order by r.created_at, r.id
    limit 21)
  select pg_catalog.jsonb_build_object(
    'items', coalesce((select pg_catalog.jsonb_agg(private.comment_view(v.r, p_viewer) order by v.n)
                       from visible v where v.n <= 20), '[]'::jsonb),
    'more', (select count(*) from visible) > 20)
$$;

-- ---------------------------------------------------------------------------------------
-- Las dos puertas.

-- La lección de un comentario publicado: con ella el servidor corre la regla de acceso antes de reportar. Nunca la de quien llama.
create function private.comment_report_lesson(p_comment uuid) returns uuid
language sql stable security definer set search_path = ''
as $$ select c.lesson_id from public.comments c where c.id = p_comment and c.status = 'published' $$;
revoke all on function private.comment_report_lesson(uuid) from public;
grant execute on function private.comment_report_lesson(uuid) to app_service;

-- Reportar (RF-803; FL-16). `p_counts` es lo que decidió el servidor con la regla: si quien reporta puede escribir ahí.
create function private.comment_report(p_comment uuid, p_reason text, p_note text, p_counts boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_bucket text := 'comment_report:' || private.actor_id();
  v_minute timestamptz := pg_catalog.date_trunc('minute', now());
  v_comment public.comments;
  v_threshold integer;
begin
  if not private.comments_open() or not exists (select 1 from private.local_flags f where f.flag = 'comments_accept') then
    return '{"answer": "closed"}'::jsonb;
  end if;
  if v_actor is null or not exists (select 1 from public.profiles p where p.id = v_actor and p.status = 'active') then
    return '{"answer": "suspended_account"}'::jsonb;
  end if;
  if p_counts is null or p_reason is null or p_reason not in ('spam', 'abusive', 'medical_advice', 'concern_for_person', 'other')
     or (p_note is not null and not private.comment_text_ok(p_note, 1000, true)) then
    return '{"answer": "invalid"}'::jsonb;
  end if;
  -- La fila tomada: dos reportes a la vez suman uno tras otro.
  select c.* into v_comment from public.comments c where c.id = p_comment for update;
  if v_comment.id is null or v_comment.status <> 'published' or v_comment.author_id is not distinct from v_actor
     or (private.comment_lesson(v_comment.lesson_id)).id is null
     or (v_comment.parent_id is not null
         and not exists (select 1 from public.comments p where p.id = v_comment.parent_id and p.status = 'published')) then
    return '{"answer": "not_found"}'::jsonb;
  end if;
  if exists (select 1 from public.comment_reports r where r.comment_id = p_comment and r.reporter_id = v_actor) then
    return '{"answer": "already"}'::jsonb;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_bucket, 0));
  if (select coalesce(sum(c.hits), 0) from private.rate_limit_counters c
      where c.bucket = v_bucket and c.window_start > v_minute - interval '1 hour') >= 10 then
    return '{"answer": "throttled"}'::jsonb;
  end if;
  insert into private.rate_limit_counters as c (bucket, window_start, hits)
  values (v_bucket, v_minute, 1)
  on conflict (bucket, window_start) do update set hits = c.hits + 1;
  insert into public.comment_reports (comment_id, reporter_id, reason, note, reported_body, counts)
  values (p_comment, v_actor, p_reason::public.report_reason, p_note, v_comment.body, p_counts);
  if p_counts then
    v_threshold := (private.parameter_value('REPORTES_PARA_OCULTAR') #>> '{}')::integer;
    update public.comments
    set report_count = report_count + 1,
        status = case when v_threshold is not null and report_count + 1 >= v_threshold then 'hidden' else status end,
        hidden_at = case when v_threshold is not null and report_count + 1 >= v_threshold then now() else hidden_at end
    where id = p_comment;
  end if;
  return '{"answer": "ok"}'::jsonb;
end
$$;
revoke all on function private.comment_report(uuid, text, text, boolean) from public;
grant execute on function private.comment_report(uuid, text, text, boolean) to app_service;

-- ---------------------------------------------------------------------------------------
-- El área `comments` del vigilante, con los reportes. Lo demás, igual que en `t502_filtro`.

create or replace function private.schema_violations_comments()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  tables (table_name) as (
    values ('public.comments'), ('public.profile_privacy'), ('public.comment_reports'),
           ('private.comment_filter_terms'), ('private.comment_evidence')),
  -- Las que el servidor llama, y nadie más.
  doors (signature) as (
    values ('private.comment_post(uuid,uuid,text)'), ('private.comment_edit(uuid,text,bigint)'),
           ('private.comment_delete(uuid,bigint)'), ('private.comment_set_pseudonym(text)'),
           ('private.comment_settle(uuid,bigint,text,text)'),
           ('private.comment_report(uuid,text,text,boolean)'), ('private.comment_report_lesson(uuid)'),
           ('private.comments_for_lesson(uuid,timestamp with time zone,uuid)'),
           ('private.comment_replies(uuid,uuid,timestamp with time zone,uuid)'),
           ('private.comments_for_teacher(uuid,boolean,timestamp with time zone,uuid)'),
           ('private.comment_can_write(uuid)'), ('private.comment_lesson_of(uuid)'),
           ('private.comments_of_author(timestamp with time zone,uuid)')),
  -- Las piezas de adentro, que no ejecuta nadie de la aplicación.
  inner_parts (signature) as (
    values ('private.comments_open()'), ('private.comment_text_ok(text,integer,boolean)'), ('private.comment_lesson(uuid)'),
           ('private.comment_gate(uuid)'), ('private.comment_hit()'), ('private.comment_name(public.comments)'),
           ('private.comment_view(public.comments,uuid)'), ('private.comment_visible(public.comments,uuid)'),
           ('private.comment_reply_page(uuid,uuid,timestamp with time zone,uuid)'),
           ('private.comment_normalize(text)'), ('private.comment_terms_hit(text)'), ('private.comment_screen(uuid)'),
           ('private.comment_filter_sweep()'))
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
  -- Los guardianes y la profundidad, fila por fila, antes, con su función y prendidos para las sesiones normales (`O`, o `A`
  -- siempre). El tipo es la suma de fila (1), antes (2), insertar (4), borrar (8) y actualizar (16).
  select 'comments without ' || g.label, g.rel
  from (values ('guard', 'public.comments', 'comments_guard', 'private.guard_comment()', 31),
               ('depth check', 'public.comments', 'comments_parent_depth', 'private.check_comment_depth()', 23),
               ('report guard', 'public.comment_reports', 'comment_reports_guard', 'private.guard_comment_report()', 31))
       as g (label, rel, name, fn, kind)
  where not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = g.rel::regclass and t.tgname = g.name
      and t.tgfoid = g.fn::regprocedure and t.tgtype = g.kind and t.tgenabled in ('O', 'A'))
  union all
  -- Los guardianes deciden por quién ejecuta: como dueño (`security definer`) dejarían pasar a todos. Lo mismo la profundidad.
  select 'comment trigger function runs as its owner', g.fn
  from (values ('private.guard_comment()'), ('private.check_comment_depth()'), ('private.guard_comment_report()')) as g (fn)
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
  -- Un término que ya no es como lo deja la normalización (si esta cambia, la migración que la cambie los renormaliza) no
  -- coincide nunca, sin avisar. Se dice cuántos, nunca cuáles: el servidor ejecuta el vigilante, y la lista es privada.
  select 'comment filter terms not normalized: ' || count(*), 'private.comment_filter_terms'
  from private.comment_filter_terms t
  where t.term is distinct from private.comment_normalize(t.term)
  having count(*) > 0
  union all
  -- El barrido corre cada minuto.
  select 'comment filter sweep not scheduled', 'cron.job comment_filter_sweep'
  where not exists (
    select 1 from cron.job j
    where j.jobname = 'comment_filter_sweep' and j.schedule = '* * * * *' and j.active
      and j.command = 'select private.comment_filter_sweep()')
  union all
  -- Una función nueva que nombre las tablas es una puerta nueva: entra a una de las dos listas.
  select 'comment function not listed', p.oid::regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname in ('private', 'public')
  where (p.proname ~ '^comments?_'
         or p.prosrc ~ '(public\.(comments|profile_privacy|comment_reports)|private\.comment_(filter_terms|evidence))\M')
    and p.proname not in ('guard_comment', 'check_comment_depth', 'guard_comment_report', 'schema_violations_comments')
    and p.oid::regprocedure::text not in (select signature from doors union all select signature from inner_parts)
$$;
