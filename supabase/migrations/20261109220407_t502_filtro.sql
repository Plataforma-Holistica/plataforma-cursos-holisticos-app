-- T-502, primera solicitud · El filtro antes de publicar (RF-802; FL-15 E4). Plan aprobado por Sergio el 2026-11-09
-- (`~/.claude/plans/t502-plan.md`), con la revisión independiente del diseño y sus decisiones de ese día.
--
-- Un comentario nace en el filtro y se asienta en dos tiempos. Al publicar o editar, en la misma transacción, lo mira la
-- lista de términos de la base (privada: el repositorio es público, y una lista a la vista se esquiva); si la lista lo
-- marca, queda en revisión ahí mismo. Si no, el servidor le pregunta al modelo externo fuera de la transacción y asienta
-- después con `comment_settle`, que lleva la revisión que se filtró (un veredicto que llega tarde no publica un texto
-- editado después) y el proveedor que lo dio. El aprobado del proveedor de prueba (`test`) solo vale con la marca local
-- `comments_test_filter`, que pone `db:login` y en producción nadie, como `video_test`; se retira `comments_unfiltered`. Lo
-- que se quede en el filtro (el servidor cayó entre las dos transacciones) lo pasa a revisión un barrido cada minuto: nunca
-- se publica sin filtro y nunca se pierde.
--
-- Lo oculto (llega con la segunda solicitud) no se edita ni se borra hasta que moderación decida, y borrar lo que está en
-- revisión, o lo que tiene reportes, deja antes una copia para moderación (decisiones de Sergio del 2026-11-09). El
-- seudónimo pasa por la misma lista y tiene su freno. El cerrojo de producción (`comments_accept`) se queda hasta T-503.
--
-- Decisiones mías sin confirmar: el freno del seudónimo (cinco intentos al día, también los que la lista marca, para que la
-- lista no se averigüe probando); dos minutos antes de barrer; la lista nace vacía también en local (las pruebas ponen la suya);
-- asentar no vuelve a mirar el interruptor, el veto ni la suspensión de quien envió justo antes; editar lo que está en revisión
-- también deja la copia, como borrarlo; un aprobado solo vale de un proveedor conocido (hoy solo el de prueba, con su marca).

-- ---------------------------------------------------------------------------------------
-- La lista de términos y la normalización.

-- El texto como lo mira la lista: en su forma de compatibilidad (las letras de ancho completo, matemáticas o en círculo son las
-- de siempre), sin acentos ni marcas combinantes ni uniones de ancho cero, en minúsculas, las cifras y las letras cirílicas que se
-- parecen a las latinas como esas latinas, lo que no es letra como espacio, y las letras sueltas con separadores juntas («p.u.t.a»
-- y «p u t a» son «puta»). Límites conocidos: una lista de términos no ve todo lo que se parece; la ñ queda como n; y juntar letras
-- sueltas y leer cifras como letras inventa palabras («de 9 a 5»), que solo mandan de más a revisión.
create function private.comment_normalize(p_text text) returns text
language sql immutable set search_path = ''
as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.regexp_replace(
      pg_catalog.translate(
        pg_catalog.regexp_replace(
          pg_catalog.lower(pg_catalog.regexp_replace(normalize(coalesce(p_text, ''), NFKD),
            '[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]', '', 'g')),
          '[\u200b-\u200d\u2060\ufeff]', '', 'g'),
        'аеорсхуіј01345789@$',
        'aeopcxyijoieastbgas'),
      '[^a-z]+', ' ', 'g'),
    '(?<=(?:^| )[a-z]) (?=[a-z](?: |$))', '', 'g'))
$$;
revoke all on function private.comment_normalize(text) from public;

-- La lista: palabras o frases ya normalizadas. Nadie de la aplicación la lee ni la escribe; la llena quien opera
-- (manual de operación).
create table private.comment_filter_terms (
  term text primary key,
  added_at timestamptz not null default now(),
  constraint comment_filter_terms_normalized check (
    term ~ '^[a-z]+( [a-z]+)*$' and pg_catalog.char_length(term) between 2 and 100 and term = private.comment_normalize(term))
);
comment on table private.comment_filter_terms is 'La lista de términos del filtro de comentarios (RF-802, ADR-30), normalizada. Privada: el repositorio es público.';
alter table private.comment_filter_terms enable row level security;
revoke all on private.comment_filter_terms from public;

-- Si el texto trae algún término de la lista, como palabra o frase entera.
create function private.comment_terms_hit(p_text text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from private.comment_filter_terms t
    where ' ' || private.comment_normalize(p_text) || ' ' like '% ' || t.term || ' %')
$$;
revoke all on function private.comment_terms_hit(text) from public;

-- ---------------------------------------------------------------------------------------
-- El comentario: quién dio el veredicto y desde cuándo está en el filtro.

alter table public.comments add column filter_provider text;
-- Lo que T-501 dejó en revisión sin marca local (local solamente: en producción no hay comentarios) no tuvo proveedor.
update public.comments set filter_provider = 'none' where filter_verdict is not null;
alter table public.comments
  add column filter_entered_at timestamptz not null default now(),
  add constraint comments_filter_provider_form check (filter_provider ~ '^[a-z][a-z0-9_]{0,30}$'),
  add constraint comments_filter_verdict_with_provider check ((filter_verdict is null) = (filter_provider is null));

-- Lo que está en el filtro, para el barrido.
create index comments_in_filter_idx on public.comments (filter_entered_at) where status = 'in_filter';

-- La copia que deja borrar lo que está en revisión o lo reportado (decisión de Sergio del 2026-11-09): el texto y el autor,
-- para moderación. Nadie de la aplicación la lee ni la escribe; la escribe `comment_delete`.
create table private.comment_evidence (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references public.comments (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null,
  body text not null,
  status public.comment_status not null,
  filter_verdict text,
  report_count integer not null,
  deleted_at timestamptz not null default now()
);
comment on table private.comment_evidence is 'Lo que el autor borró estando en revisión o reportado (RF-801, protocolo de riesgo §8): el texto y el autor, para moderación (T-503).';
alter table private.comment_evidence enable row level security;
revoke all on private.comment_evidence from public;
create index comment_evidence_comment_idx on private.comment_evidence (comment_id);
create index comment_evidence_author_idx on private.comment_evidence (author_id) where author_id is not null;

-- ---------------------------------------------------------------------------------------
-- El guardián, con el filtro. Lo demás, igual que en `t501_comentarios`.

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
-- Asentar. La de una transacción (`comment_settle(uuid)`) se va: publicar y editar ya no asientan.

drop function private.comment_settle(uuid);

-- La lista, dentro de publicar y editar: si marca el texto, queda en revisión ahí mismo, sin llamar a nadie. Devuelve el
-- estado con que quedó.
create function private.comment_screen(p_comment uuid) returns public.comment_status
language plpgsql security definer set search_path = ''
as $$
declare
  v_status public.comment_status;
begin
  update public.comments
  set status = 'in_review', filter_verdict = 'flagged', filter_provider = 'terms', filter_checked_at = now()
  where id = p_comment and status = 'in_filter' and private.comment_terms_hit(body)
  returning status into v_status;
  return coalesce(v_status, 'in_filter');
end
$$;
revoke all on function private.comment_screen(uuid) from public;

-- El veredicto del modelo externo, de vuelta (FL-15 E4). Solo de lo propio, solo si sigue en el filtro con la revisión que se
-- filtró. Solo de un proveedor conocido (hoy, el de prueba); sin proveedor, el servidor manda `unavailable` con `none`.
create function private.comment_settle(p_comment uuid, p_revision bigint, p_verdict text, p_provider text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_comment public.comments;
begin
  if p_revision is null or p_verdict is null or p_verdict not in ('pass', 'flagged', 'risk', 'unavailable')
     or p_provider is null or p_provider not in ('test', 'none')
     or (p_provider = 'none' and p_verdict <> 'unavailable') then
    return '{"answer": "invalid"}'::jsonb;
  end if;
  select c.* into v_comment from public.comments c
  where c.id = p_comment and c.author_id = private.actor_id() and c.status <> 'deleted'
  for update;
  if v_comment.id is null or private.actor_id() is null then
    return '{"answer": "not_found"}'::jsonb;
  end if;
  if v_comment.status <> 'in_filter' or v_comment.revision is distinct from p_revision then
    return pg_catalog.jsonb_build_object('answer', 'stale',
      'state', case v_comment.status when 'published' then 'published' else 'in_review' end);
  end if;
  update public.comments
  set status = case p_verdict when 'pass' then 'published' else 'in_review' end::public.comment_status,
      filter_verdict = p_verdict, filter_provider = p_provider, filter_checked_at = now()
  where id = p_comment;
  return pg_catalog.jsonb_build_object('answer', 'ok',
    'state', case p_verdict when 'pass' then 'published' else 'in_review' end);
end
$$;
revoke all on function private.comment_settle(uuid, bigint, text, text) from public;
grant execute on function private.comment_settle(uuid, bigint, text, text) to app_service;

-- El barrido: lo que lleva más de dos minutos en el filtro pasa a revisión. Devuelve cuántos tomó.
create function private.comment_filter_sweep() returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.comments
  set status = 'in_review', filter_verdict = 'unavailable', filter_provider = 'sweep', filter_checked_at = now()
  where status = 'in_filter' and filter_entered_at < now() - interval '2 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;
revoke all on function private.comment_filter_sweep() from public;
select cron.schedule('comment_filter_sweep', '* * * * *', 'select private.comment_filter_sweep()');

-- ---------------------------------------------------------------------------------------
-- Publicar y editar: dejan el texto en el filtro y contestan su revisión. Lo demás, igual que en `t501_comentarios`.

create or replace function private.comment_post(p_lesson uuid, p_parent uuid, p_body text) returns jsonb
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
  if not private.comment_text_ok(p_body, 4000, true) then
    return '{"answer": "invalid"}'::jsonb;
  end if;
  if p_parent is not null then
    -- Para compartir: borrar el padre a la vez espera a esta respuesta.
    select c.* into v_parent from public.comments c where c.id = p_parent for share;
    if v_parent.parent_id is not null then
      -- La respuesta a la que se responde también tiene que estar publicada: borrada o en revisión, no se ve.
      if v_parent.status <> 'published' then
        return '{"answer": "bad_parent"}'::jsonb;
      end if;
      select c.* into v_parent from public.comments c where c.id = v_parent.parent_id for share;
    end if;
    if v_parent.id is null or v_parent.lesson_id <> p_lesson or v_parent.parent_id is not null or v_parent.status <> 'published' then
      return '{"answer": "bad_parent"}'::jsonb;
    end if;
  end if;
  if not private.comment_hit() then
    return '{"answer": "throttled"}'::jsonb;
  end if;
  insert into public.comments (lesson_id, course_id, teacher_id, author_id, parent_id, is_teacher_reply, body)
  values (p_lesson, (v_gate ->> 'course')::uuid, (v_gate ->> 'teacher')::uuid, private.actor_id(), v_parent.id,
          (v_gate ->> 'is_teacher')::boolean, p_body)
  returning id into v_id;
  v_status := private.comment_screen(v_id);
  return pg_catalog.jsonb_build_object('answer', 'ok', 'id', v_id, 'revision', 1, 'state', v_status);
end
$$;

-- Editar lo propio, otra vez por el filtro. Lo oculto espera a moderación.
create or replace function private.comment_edit(p_comment uuid, p_body text, p_seen bigint) returns jsonb
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
  if v_comment.status = 'hidden' then
    return '{"answer": "hidden"}'::jsonb;
  end if;
  v_gate := private.comment_gate(v_comment.lesson_id);
  if v_gate ->> 'answer' <> 'ok' then
    return v_gate;
  end if;
  if not private.comment_text_ok(p_body, 4000, true) then
    return '{"answer": "invalid"}'::jsonb;
  end if;
  -- Ya con la fila tomada, otra vez: pudo cambiar entre leer y tomar.
  select c.* into v_comment from public.comments c
  where c.id = p_comment and c.author_id = private.actor_id() and c.status <> 'deleted'
  for update;
  if v_comment.id is null then
    return '{"answer": "not_found"}'::jsonb;
  end if;
  if v_comment.status = 'hidden' then
    return '{"answer": "hidden"}'::jsonb;
  end if;
  if v_comment.revision is distinct from p_seen then
    return '{"answer": "changed"}'::jsonb;
  end if;
  -- El mismo texto: nada que escribir ni que volver a filtrar.
  if p_body = v_comment.body then
    return pg_catalog.jsonb_build_object('answer', 'ok', 'id', p_comment, 'revision', v_comment.revision,
      'state', case v_comment.status when 'published' then 'published' when 'in_filter' then 'in_filter' else 'in_review' end);
  end if;
  if not private.comment_hit() then
    return '{"answer": "throttled"}'::jsonb;
  end if;
  -- El texto que se reemplaza, si estaba en revisión o reportado, se queda para moderación, como al borrar.
  if v_comment.status = 'in_review' or v_comment.report_count > 0 then
    insert into private.comment_evidence (comment_id, author_id, body, status, filter_verdict, report_count)
    values (v_comment.id, v_comment.author_id, v_comment.body, v_comment.status, v_comment.filter_verdict, v_comment.report_count);
  end if;
  update public.comments
  set body = p_body, status = 'in_filter', filter_verdict = null, filter_provider = null, filter_checked_at = null,
      filter_entered_at = now(), edited_at = now(), revision = revision + 1
  where id = p_comment;
  v_status := private.comment_screen(p_comment);
  return pg_catalog.jsonb_build_object('answer', 'ok', 'id', p_comment, 'revision', v_comment.revision + 1, 'state', v_status);
end
$$;

-- Borrar lo propio (RF-801). Lo oculto espera a moderación; lo que está en revisión, o lo reportado, deja antes su copia.
create or replace function private.comment_delete(p_comment uuid, p_seen bigint) returns jsonb
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
  if v_comment.status = 'hidden' then
    return '{"answer": "hidden"}'::jsonb;
  end if;
  if v_comment.revision is distinct from p_seen then
    return '{"answer": "changed"}'::jsonb;
  end if;
  if v_comment.status = 'in_review' or v_comment.report_count > 0 then
    insert into private.comment_evidence (comment_id, author_id, body, status, filter_verdict, report_count)
    values (v_comment.id, v_comment.author_id, v_comment.body, v_comment.status, v_comment.filter_verdict, v_comment.report_count);
  end if;
  update public.comments
  set body = null, status = 'deleted', deleted_at = now(), author_id = null, revision = revision + 1
  where id = p_comment;
  return '{"answer": "ok"}'::jsonb;
end
$$;

-- El seudónimo, por la lista y con su freno: cinco intentos en un día, contando también los que la lista marca, y el freno antes
-- que la lista, para que no se averigüe probando palabra por palabra.
create or replace function private.comment_set_pseudonym(p_pseudonym text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_bucket text := 'pseudonym:' || private.actor_id();
  v_minute timestamptz := pg_catalog.date_trunc('minute', now());
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
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_bucket, 0));
  if (select coalesce(sum(c.hits), 0) from private.rate_limit_counters c
      where c.bucket = v_bucket and c.window_start > v_minute - interval '1 day') >= 5 then
    return '{"answer": "throttled"}'::jsonb;
  end if;
  insert into private.rate_limit_counters as c (bucket, window_start, hits)
  values (v_bucket, v_minute, 1)
  on conflict (bucket, window_start) do update set hits = c.hits + 1;
  if private.comment_terms_hit(p_pseudonym) then
    return '{"answer": "flagged"}'::jsonb;
  end if;
  insert into public.profile_privacy as x (profile_id, pseudonym) values (v_actor, p_pseudonym)
  on conflict (profile_id) do update set pseudonym = excluded.pseudonym;
  return pg_catalog.jsonb_build_object('answer', 'ok', 'pseudonym', p_pseudonym);
end
$$;

-- La marca de publicar sin filtro ya no existe (solo en una base local).
delete from private.local_flags where flag = 'comments_unfiltered';

-- ---------------------------------------------------------------------------------------
-- El área `comments` del vigilante, con lo nuevo. Lo demás, igual que en `t501_mis_comentarios`.

create or replace function private.schema_violations_comments()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  tables (table_name) as (
    values ('public.comments'), ('public.profile_privacy'), ('private.comment_filter_terms'), ('private.comment_evidence')),
  -- Las que el servidor llama, y nadie más.
  doors (signature) as (
    values ('private.comment_post(uuid,uuid,text)'), ('private.comment_edit(uuid,text,bigint)'),
           ('private.comment_delete(uuid,bigint)'), ('private.comment_set_pseudonym(text)'),
           ('private.comment_settle(uuid,bigint,text,text)'),
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
  where (p.proname ~ '^comments?_' or p.prosrc ~ '(public\.(comments|profile_privacy)|private\.comment_(filter_terms|evidence))\M')
    and p.proname not in ('guard_comment', 'check_comment_depth', 'schema_violations_comments')
    and p.oid::regprocedure::text not in (select signature from doors union all select signature from inner_parts)
$$;
