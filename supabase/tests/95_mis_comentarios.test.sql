-- T-501 · «Mis comentarios» (RF-801, RF-808; PA-24). Decisiones de Sergio del 2026-11-08: quien perdió el acceso a una lección
-- borra lo suyo desde una lista de lo propio; lo oculto por moderación no aparece; los títulos de lo que ya no se ve, sí, sin
-- enlace. Aquí: que `comments_of_author` dé solo lo de quien actúa, sin lo borrado ni lo oculto, con una lista exacta de claves
-- y nada de nadie más, en orden y por cursor; que no pida acceso, ni el interruptor, ni la marca; que diga si la lección se ve;
-- y el vigilante con la puerta nueva.
begin;
\ir _ayuda.psql
select plan(35);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a9500000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
-- 1 Ana; 2 Beto; 3 la maestra de los cursos; 4 Contenido; 5 Cata, vetada; 6 Dani, sin nada escrito.
select pruebas.alta(pruebas.p(n), 'mis-' || n || '@prueba.test') from generate_series(1, 6) n;
select pruebas.confirmar(pruebas.p(n)) from generate_series(1, 6) n;
select pruebas.dar_capacidad(pruebas.p(4), 'content');
select pruebas.equipar(pruebas.p(4));

create table pruebas.ids (k text primary key, v uuid not null);
create function pruebas.id(p_k text) returns uuid language sql stable as $$ select v from pruebas.ids where k = p_k $$;
grant select, insert on pruebas.ids to app_service;
grant select on pruebas.ids to authenticated;

-- Lo que contesta una función como el servidor a nombre de alguien. Con `p_k`, guarda el id que devolvió.
create function pruebas.c(p_actor uuid, p_call text, p_k text default null) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_actor);
  execute 'select ' || p_call into v;
  perform pruebas.limpiar();
  if p_k is not null and v ->> 'id' is not null then
    insert into pruebas.ids values (p_k, (v ->> 'id')::uuid);
  end if;
  return v;
end
$$;
create function pruebas.r(p_actor uuid, p_call text, p_k text default null) returns text
language sql as $$ select pruebas.c(p_actor, p_call, p_k) ->> 'answer' $$;
-- La primera página de lo suyo, y una desde un cursor.
create function pruebas.mios(p_actor uuid) returns jsonb
language sql as $$ select pruebas.c(p_actor, 'private.comments_of_author(null, null)') $$;
create function pruebas.mios_desde(p_actor uuid, p_at timestamptz, p_id uuid) returns jsonb
language sql as $$ select pruebas.c(p_actor, format('private.comments_of_author(%L, %L)', p_at, p_id)) $$;
create function pruebas.ids_de(p_page jsonb) returns uuid[]
language sql as $$ select coalesce(array_agg((i ->> 'id')::uuid order by o), '{}') from jsonb_array_elements(p_page -> 'items') with ordinality as t (i, o) $$;
create function pruebas.fila(p_page jsonb, p_id uuid) returns jsonb
language sql as $$ select i from jsonb_array_elements(p_page -> 'items') i where (i ->> 'id')::uuid = p_id $$;
create function pruebas.marca(p_flag text, p_on boolean) returns void
language plpgsql as $$
begin
  perform pruebas.limpiar();
  if p_on then
    insert into private.local_flags (flag) values (p_flag) on conflict do nothing;
  else
    delete from private.local_flags where flag = p_flag;
  end if;
end
$$;
create function pruebas.interruptor(p_value jsonb) returns void
language plpgsql as $$
begin
  perform pruebas.limpiar();
  alter table public.business_parameters disable trigger user;
  update public.business_parameters set value = p_value where key = 'COMENTARIOS_ABIERTOS' and canceled_at is null;
  alter table public.business_parameters enable trigger user;
end
$$;
create function pruebas.vigila() returns text[]
language sql as $$
  select coalesce(array_agg(v.problem || ' ' || v.object_name order by v.problem, v.object_name), '{}')
  from private.schema_violations_comments() v
$$;
-- Un cambio a mano, sin guardianes: el estado de una fila que la aplicación todavía no alcanza (lo oculto llega con T-502).
create function pruebas.forzar(p_sql text) returns void
language plpgsql as $$
begin
  perform pruebas.limpiar();
  set local session_replication_role = replica;
  execute p_sql;
  set local session_replication_role = origin;
end
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

create function pruebas.curso(p_slug text, p_lessons text[]) returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', (
      select jsonb_agg(jsonb_build_object('title', l, 'video',
               jsonb_build_object('provider', 'mux', 'asset_id', 'Asset' || replace(p_slug || l, '-', ''),
                                  'playback_id', 'Playback' || replace(p_slug || l, '-', ''), 'duration_seconds', 100))
             order by l)
      from unnest(p_lessons) l))))
$$;
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
insert into pruebas.ids values ('t3', private.system_add_teacher('Maestra Mía', 'maestra-mia', null));
update public.teachers set profile_id = pruebas.p(3), status = 'active' where id = pruebas.id('t3');
-- Cinco cursos de una lección: la vigente, la retirada, el no listado, el que tiene una versión abierta y el retirado del catálogo.
select private.system_load_course(pruebas.id('t3'), pruebas.curso('mis-' || s, array['Lección ' || s]))
from unnest(array['vigente', 'retirada', 'nolistado', 'version', 'retirado']) s;
select pruebas.limpiar();
-- Con el aviso del maestro: la maestra lo aceptó. Una base sin borradores no lo trae.
select pruebas.como_dueno_sistema();
insert into public.legal_documents (doc_type, version, title, body, effective_from)
select 'teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now()
where private.current_legal_document('teacher_privacy_notice') is null;
select pruebas.limpiar();
select set_config('app.actor_id', pruebas.p(3)::text, true);
insert into public.consents (profile_id, legal_document_id, origin)
values (pruebas.p(3), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
select pruebas.limpiar();
select pruebas.pide(pruebas.p(4), format('private.approve_course(%L)', course_id))
from public.course_registry r join public.published_courses c using (course_id)
where c.slug like 'mis-%' order by c.slug;
insert into pruebas.ids select substr(c.slug, 5), l.id from public.published_lessons l join public.published_courses c using (course_id)
where c.slug like 'mis-%';
insert into private.app_sessions (session_id, profile_id) select pruebas.sesion(pruebas.p(n)), pruebas.p(n) from generate_series(1, 6) n
on conflict (session_id) do nothing;
select pruebas.marca('comments_accept', true), pruebas.marca('comments_unfiltered', true), pruebas.interruptor('true');
select pruebas.r(pruebas.p(n), format('private.comment_set_pseudonym(%L)', name))
from (values (1, 'Ana'), (2, 'Beto'), (5, 'Cata')) as v (n, name);

-- Lo escrito. Ana: uno en cada lección, una respuesta a Beto, uno que edita, uno en revisión, uno que borra, uno oculto, uno
-- en el filtro. Beto y la maestra, lo suyo.
select pruebas.r(pruebas.p(2), format('private.comment_post(%L, null, %L)', pruebas.id('vigente'), 'De Beto'), 'b1');
select pruebas.r(pruebas.p(3), format('private.comment_post(%L, null, %L)', pruebas.id('vigente'), 'De la maestra'), 'm1');
select pruebas.r(pruebas.p(1), format('private.comment_post(%L, null, %L)', pruebas.id(s), 'De Ana en ' || s), 'a_' || s)
from unnest(array['vigente', 'retirada', 'nolistado', 'version', 'retirado']) s;
select pruebas.r(pruebas.p(1), format('private.comment_post(%L, %L, %L)', pruebas.id('vigente'), pruebas.id('b1'), 'Ana responde a Beto'), 'a_resp');
select pruebas.r(pruebas.p(1), format('private.comment_edit(%L, %L, 1)', pruebas.id('a_vigente'), 'De Ana, editado'));
-- El freno cuenta 10 cada 10 minutos, y todo pasa en la misma transacción: se vacía para seguir escribiendo.
delete from private.rate_limit_counters where bucket = 'comments:' || pruebas.p(1);
select pruebas.r(pruebas.p(1), format('private.comment_post(%L, null, %L)', pruebas.id('vigente'), 'Lo que se va'), 'a_borra');
select pruebas.r(pruebas.p(1), format('private.comment_delete(%L, 1)', pruebas.id('a_borra')));
select pruebas.r(pruebas.p(1), format('private.comment_post(%L, null, %L)', pruebas.id('vigente'), 'Lo que se oculta'), 'a_oculto');
select pruebas.r(pruebas.p(1), format('private.comment_post(%L, null, %L)', pruebas.id('vigente'), 'En el filtro'), 'a_filtro');
select pruebas.marca('comments_unfiltered', false);
select pruebas.r(pruebas.p(1), format('private.comment_post(%L, null, %L)', pruebas.id('vigente'), 'En revisión'), 'a_revision');
select pruebas.marca('comments_unfiltered', true);
-- Lo que la aplicación todavía no alcanza, forzado: un oculto, uno en el filtro, y uno borrado que conserva su autor.
select pruebas.forzar(format($$update public.comments set status = 'hidden', hidden_at = now() where id = %L$$, pruebas.id('a_oculto')));
select pruebas.forzar(format($$update public.comments set status = 'in_filter' where id = %L$$, pruebas.id('a_filtro')));
select pruebas.forzar(format($$update public.comments set author_id = %L where id = %L$$, pruebas.p(1), pruebas.id('a_borra')));
-- Lo que ya no se ve: una lección retirada, un curso sin listar, uno con una versión abierta y uno retirado del catálogo.
select pruebas.forzar(format($$update public.published_lessons set is_current = false, retired_at = now() where id = %L$$, pruebas.id('retirada')));
select pruebas.forzar(format($$update public.published_courses set is_listed = false where course_id = (select course_id from public.published_lessons where id = %L)$$, pruebas.id('nolistado')));
select pruebas.forzar(format($$update public.course_registry set state = 'changes_pending', pending_version_state = 'draft' where course_id = (select course_id from public.published_lessons where id = %L)$$, pruebas.id('version')));
select pruebas.forzar(format($$update public.course_registry set state = 'withdrawn', withdrawn_at = now(), withdrawal_reason = 'Prueba de la 95' where course_id = (select course_id from public.published_lessons where id = %L)$$, pruebas.id('retirado')));
create temp table pagina as select pruebas.mios(pruebas.p(1)) as v;
grant select on pagina to app_service, authenticated;

-- ---------------------------------------------------------------------------------------
-- El vigilante y quién ejecuta la puerta.

select is(pruebas.vigila(), '{}', 'el área comments no dice nada con la puerta nueva');
select pruebas.como_usuario(pruebas.p(1));
select throws_ok('select private.comments_of_author(null, null)', '42501', null, 'la persona no la ejecuta');
select pruebas.limpiar();
revoke execute on function private.comments_of_author(timestamptz, uuid) from app_service;
select is(pruebas.vigila(), array['comment function not executable by app_service private.comments_of_author(timestamp with time zone,uuid)'],
  'el vigilante ve una puerta que el servidor no ejecuta');
grant execute on function private.comments_of_author(timestamptz, uuid) to app_service;

-- ---------------------------------------------------------------------------------------
-- Lo propio, y nada más.

select is((select v ->> 'answer' from pagina), 'ok', 'Ana lee lo suyo');
select is((select pruebas.ids_de(v) from pagina),
  (select array_agg(c.id order by c.created_at desc, c.id desc) from public.comments c
   where c.author_id = pruebas.p(1) and c.status in ('published', 'in_review', 'in_filter')),
  'lo suyo, del más reciente al más antiguo y, a la misma hora, por su id');
select ok(not (select pruebas.ids_de(v) && array[pruebas.id('b1'), pruebas.id('m1')] from pagina), 'nada de Beto ni de la maestra');
select ok(not (select pruebas.id('a_borra') = any (pruebas.ids_de(v)) from pagina), 'ni lo borrado, aunque conserve su autor');
select ok(not (select pruebas.id('a_oculto') = any (pruebas.ids_de(v)) from pagina), 'ni lo oculto por moderación');
select is((select array_agg(k order by k) from pagina, jsonb_object_keys(pruebas.fila(v, pruebas.id('a_vigente'))) k),
  array['body', 'course_slug', 'course_title', 'created_at', 'edited', 'id', 'is_reply', 'lesson_id', 'lesson_title', 'revision', 'state'],
  'cada fila, con una lista exacta de claves: nada del filtro, de los reportes ni de nadie más');
select is((select array_agg(k order by k) from pagina, jsonb_object_keys(v) k), array['answer', 'items', 'more'], 'y la página, con las suyas');
select is((select pruebas.fila(v, pruebas.id('a_vigente')) ->> 'body' from pagina), 'De Ana, editado', 'el texto de ahora');
select is((select (pruebas.fila(v, pruebas.id('a_vigente')) ->> 'revision')::int from pagina), 2, 'su revisión, la que lleva borrar');
select is((select (pruebas.fila(v, pruebas.id('a_vigente')) ->> 'edited')::boolean from pagina), true, 'y que se editó');
select is((select pruebas.fila(v, pruebas.id('a_vigente')) ->> 'state' from pagina), 'published', 'lo publicado, publicado');
select is((select pruebas.fila(v, pruebas.id('a_revision')) ->> 'state' from pagina), 'in_review', 'lo que está en revisión, en revisión');
select is((select pruebas.fila(v, pruebas.id('a_filtro')) ->> 'state' from pagina), 'in_review', 'y lo que está en el filtro, también');
select is((select (pruebas.fila(v, pruebas.id('a_resp')) ->> 'is_reply')::boolean from pagina), true, 'una respuesta lo dice');
select is((select pruebas.fila(v, pruebas.id('a_resp')) ->> 'body' from pagina), 'Ana responde a Beto', 'con su texto y nada de a quién respondía');
select is((select (v ->> 'more')::boolean from pagina), false, 'no hay más');

-- ---------------------------------------------------------------------------------------
-- Si la lección se ve: la regla de los comentarios (`comment_lesson`), no una copia.

select is((select jsonb_build_object('slug', f ->> 'course_slug', 'lesson', f ->> 'lesson_id', 'title', f ->> 'lesson_title')
           from pagina, pruebas.fila(v, pruebas.id('a_vigente')) f),
  jsonb_build_object('slug', 'mis-vigente', 'lesson', pruebas.id('vigente'), 'title', 'Lección vigente'), 'la vigente, con su enlace');
select is((select jsonb_build_object('slug', f ->> 'course_slug', 'lesson', f ->> 'lesson_id', 'title', f ->> 'lesson_title', 'course', f ->> 'course_title')
           from pagina, pruebas.fila(v, pruebas.id('a_retirada')) f),
  jsonb_build_object('slug', null, 'lesson', null, 'title', 'Lección retirada', 'course', 'Curso mis-retirada'), 'la retirada, con sus títulos y sin enlace');
select is((select pruebas.fila(v, pruebas.id('a_nolistado')) ->> 'course_slug' from pagina), null, 'el curso sin listar, sin enlace');
select is((select pruebas.fila(v, pruebas.id('a_version')) ->> 'course_slug' from pagina), 'mis-version', 'el curso con una versión abierta se sigue viendo');
select is((select pruebas.fila(v, pruebas.id('a_retirado')) ->> 'course_slug' from pagina), null, 'el retirado del catálogo, sin enlace');
select is((select pruebas.fila(v, pruebas.id('a_retirado')) ->> 'course_title' from pagina), 'Curso mis-retirado', 'pero con su título');

-- ---------------------------------------------------------------------------------------
-- Sin acceso, sin interruptor, sin la marca y con el veto: es lo suyo.

select pruebas.interruptor('false');
select is(pruebas.r(pruebas.p(1), 'private.comments_of_author(null, null)'), 'ok', 'con los comentarios cerrados, se lee');
select pruebas.interruptor('true');
select pruebas.marca('comments_accept', false);
select is(pruebas.r(pruebas.p(1), 'private.comments_of_author(null, null)'), 'ok', 'sin la marca de aceptar, también');
select pruebas.marca('comments_accept', true);
select pruebas.r(pruebas.p(5), format('private.comment_post(%L, null, %L)', pruebas.id('vigente'), 'De Cata'), 'c1');
select pruebas.como_dueno_sistema();
update public.profiles set comment_ban_until = now() + interval '1 day' where id = pruebas.p(5);
select pruebas.limpiar();
select is(pruebas.ids_de(pruebas.mios(pruebas.p(5))), array[pruebas.id('c1')], 'con el veto, Cata lee lo suyo');
select is(pruebas.ids_de(pruebas.mios(pruebas.p(3))), array[pruebas.id('m1')], 'la maestra, lo suyo');
select is(pruebas.mios(pruebas.p(6)), '{"answer": "ok", "items": [], "more": false}'::jsonb, 'Dani, sin nada escrito: la lista vacía');
select is(pruebas.r(null, 'private.comments_of_author(null, null)'), 'not_found', 'sin nadie que actúe, nada');
select pruebas.como_dueno_sistema();
select is(private.comments_of_author(null, null) ->> 'answer', 'not_found', 'ni como el sistema');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- De 20 en 20, por cursor: a la misma hora (todo en una transacción) desempata el id.

select pruebas.r(pruebas.p(2), format('private.comment_post(%L, null, %L)', pruebas.id('version'), 'Beto ' || n))
from generate_series(1, 9) n;
delete from private.rate_limit_counters where bucket = 'comments:' || pruebas.p(2);
select pruebas.r(pruebas.p(2), format('private.comment_post(%L, null, %L)', pruebas.id('version'), 'Beto más ' || n))
from generate_series(1, 9) n;
delete from private.rate_limit_counters where bucket = 'comments:' || pruebas.p(2);
select pruebas.r(pruebas.p(2), format('private.comment_post(%L, null, %L)', pruebas.id('version'), 'Beto todavía ' || n))
from generate_series(1, 5) n;
create temp table primera as select pruebas.mios(pruebas.p(2)) as v;
grant select on primera to app_service, authenticated;
select is((select jsonb_array_length(v -> 'items') from primera), 20, 'la primera página, de 20');
select is((select (v ->> 'more')::boolean from primera), true, 'y dice que hay más');
select is((select pruebas.ids_de(v) || pruebas.ids_de(pruebas.mios_desde(pruebas.p(2), (v -> 'items' -> 19 ->> 'created_at')::timestamptz, (v -> 'items' -> 19 ->> 'id')::uuid)) from primera),
  (select array_agg(c.id order by c.created_at desc, c.id desc) from public.comments c where c.author_id = pruebas.p(2)),
  'la segunda sigue donde terminó la primera, sin repetir ni saltar');

select * from finish();
rollback;
