-- T-501 · PA-45, los comentarios en el portal del maestro (RF-609; FL-38). Plan aprobado por Sergio el 2026-11-08, con la revisión
-- independiente del diseño. Sin migración: `comments_for_teacher` ya existe (`t501_comentarios`). Aquí lo que la 93 no cubre: qué
-- cursos y lecciones salen (versión abierta sí; sin listar y lección retirada no; los de otro maestro nunca), con el nombre de
-- comentarios, las respuestas de otros en revisión fuera y la propia en revisión dentro sin contar como respondido; quién lee (el
-- suspendido y el vetado sí; el que se fue, la cuenta suspendida y el alumno no); y lo que contesta el portón al maestro en cada
-- estado, que es lo que PA-45 pinta en lugar de «Responder».
begin;
\ir _ayuda.psql
select plan(29);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a9600000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
-- 1 Ana y 2 Beto, alumnos; 3 la maestra de los cursos; 4 otro maestro; 5 Contenido.
select pruebas.alta(pruebas.p(n), 'pa45-' || n || '@prueba.test') from generate_series(1, 5) n;
select pruebas.confirmar(pruebas.p(n)) from generate_series(1, 5) n;
select pruebas.dar_capacidad(pruebas.p(5), 'content');
select pruebas.equipar(pruebas.p(5));

create table pruebas.ids (k text primary key, v uuid not null);
create function pruebas.id(p_k text) returns uuid language sql stable as $$ select v from pruebas.ids where k = p_k $$;
grant select, insert on pruebas.ids to app_service;
grant select on pruebas.ids to authenticated;

-- Lo que contesta una función como el servidor a nombre de alguien. Con `p_k`, guarda el id que devolvió. Una llamada suelta
-- va dentro de un `count(*)`: un «ok» impreso lo leería `pg_prove` como una prueba.
create function pruebas.c(p_actor uuid, p_call text, p_k text default null) returns jsonb
language plpgsql as $$
declare
  v jsonb;
  v_test boolean;
  v_settled jsonb;
begin
  perform pruebas.a_nombre_de(p_actor);
  execute 'select ' || p_call into v;
  perform pruebas.limpiar();
  -- Como el servidor (T-502): lo que queda en el filtro lo asienta con el proveedor de prueba si está su marca, y si no, sin
  -- proveedor.
  if v ->> 'state' = 'in_filter' then
    v_test := exists (select 1 from private.local_flags where flag = 'comments_test_filter');
    perform pruebas.a_nombre_de(p_actor);
    v_settled := private.comment_settle((v ->> 'id')::uuid, (v ->> 'revision')::bigint,
      case when v_test then 'pass' else 'unavailable' end, case when v_test then 'test' else 'none' end);
    perform pruebas.limpiar();
    if v_settled ->> 'answer' not in ('ok', 'stale') then
      raise exception 'asentar contestó %', v_settled;
    end if;
    v := v || jsonb_build_object('state', v_settled ->> 'state');
  end if;
  if p_k is not null and v ->> 'id' is not null then
    insert into pruebas.ids values (p_k, (v ->> 'id')::uuid);
  end if;
  return v;
end
$$;
create function pruebas.r(p_actor uuid, p_call text, p_k text default null) returns text
language sql as $$ select pruebas.c(p_actor, p_call, p_k) ->> 'answer' $$;
-- Lo que ve la maestra en PA-45: todo, o de un curso, o lo sin responder.
create function pruebas.portal(p_actor uuid, p_course uuid default null, p_unanswered boolean default false) returns jsonb
language sql as $$ select pruebas.c(p_actor, format('private.comments_for_teacher(%L, %L, null, null)', p_course, p_unanswered)) $$;
create function pruebas.ids_de(p_page jsonb) returns uuid[]
language sql as $$ select coalesce(array_agg((i ->> 'id')::uuid order by (i ->> 'id')), '{}') from jsonb_array_elements(p_page -> 'items') i $$;
create function pruebas.fila(p_page jsonb, p_id uuid) returns jsonb
language sql as $$ select i from jsonb_array_elements(p_page -> 'items') i where (i ->> 'id')::uuid = p_id $$;
create function pruebas.puede(p_actor uuid, p_lesson uuid) returns text
language sql as $$ select pruebas.r(p_actor, format('private.comment_can_write(%L)', p_lesson)) $$;
create function pruebas.ordenados(p_ids uuid[]) returns uuid[]
language sql as $$ select array_agg(x order by x) from unnest(p_ids) x $$;
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
-- Un cambio a mano, sin guardianes ni auditoría (las restricciones sí valen).
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
insert into pruebas.ids values
  ('t3', private.system_add_teacher('Maestra Portal', 'maestra-portal', null)),
  ('t4', private.system_add_teacher('Maestro Otro', 'maestro-otro', null));
update public.teachers set profile_id = pruebas.p(3), status = 'active' where id = pruebas.id('t3');
update public.teachers set profile_id = pruebas.p(4), status = 'active' where id = pruebas.id('t4');
select count(*) as hecho from (select private.system_load_course(pruebas.id('t3'), pruebas.curso('pa45-' || s, array['Lección ' || s]))
  from unnest(array['vigente', 'version', 'nolistado', 'retirada']) s) as llamada;
select count(*) as hecho from (select private.system_load_course(pruebas.id('t4'), pruebas.curso('pa45-otro', array['Lección otro']))) as llamada;
select pruebas.limpiar();
-- Con el aviso del maestro, que los dos aceptaron. Una base sin borradores no lo trae.
select pruebas.como_dueno_sistema();
insert into public.legal_documents (doc_type, version, title, body, effective_from)
select 'teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now()
where private.current_legal_document('teacher_privacy_notice') is null;
select pruebas.limpiar();
select set_config('app.actor_id', pruebas.p(3)::text, true);
insert into public.consents (profile_id, legal_document_id, origin)
values (pruebas.p(3), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
select pruebas.limpiar();
select set_config('app.actor_id', pruebas.p(4)::text, true);
insert into public.consents (profile_id, legal_document_id, origin)
values (pruebas.p(4), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
select pruebas.limpiar();
select count(*) as hecho from (select pruebas.pide(pruebas.p(5), format('private.approve_course(%L)', course_id))
  from public.course_registry r join public.published_courses c using (course_id)
  where c.slug like 'pa45-%' order by c.slug) as llamada;
insert into pruebas.ids select substr(c.slug, 6), l.id from public.published_lessons l join public.published_courses c using (course_id)
where c.slug like 'pa45-%';
insert into pruebas.ids select 'c_' || substr(c.slug, 6), c.course_id from public.published_courses c where c.slug like 'pa45-%';
insert into private.app_sessions (session_id, profile_id) select pruebas.sesion(pruebas.p(n)), pruebas.p(n) from generate_series(1, 5) n
on conflict (session_id) do nothing;
select pruebas.marca('comments_accept', true), pruebas.marca('comments_test_filter', true), pruebas.interruptor('true');
select count(*) as hecho from (select pruebas.r(pruebas.p(n), format('private.comment_set_pseudonym(%L)', name))
  from (values (1, 'Ana'), (2, 'Beto')) as v (n, name)) as llamada;

-- Lo escrito: Ana en cada lección; Beto en la vigente; una respuesta de Ana a Beto en revisión; una de la maestra a Beto, en revisión.
select count(*) as hecho from (select pruebas.r(pruebas.p(1), format('private.comment_post(%L, null, %L)', pruebas.id(s), 'De Ana en ' || s), 'a_' || s)
  from unnest(array['vigente', 'version', 'nolistado', 'retirada', 'otro']) s) as llamada;
select count(*) as hecho from (select pruebas.r(pruebas.p(2), format('private.comment_post(%L, null, %L)', pruebas.id('vigente'), 'De Beto'), 'b_vigente')) as llamada;
select pruebas.marca('comments_test_filter', false);
select count(*) as hecho from (select pruebas.r(pruebas.p(1), format('private.comment_post(%L, %L, %L)', pruebas.id('vigente'), pruebas.id('b_vigente'), 'Ana responde, en revisión'), 'a_resp')) as llamada;
select count(*) as hecho from (select pruebas.r(pruebas.p(3), format('private.comment_post(%L, %L, %L)', pruebas.id('vigente'), pruebas.id('b_vigente'), 'La maestra responde, en revisión'), 'm_resp')) as llamada;
select pruebas.marca('comments_test_filter', true);
-- Lo que ya no se ve: el curso sin listar y la lección retirada. El de la versión abierta, sí.
select pruebas.forzar(format($$update public.published_courses set is_listed = false where course_id = %L$$, pruebas.id('c_nolistado')));
select pruebas.forzar(format($$update public.published_lessons set is_current = false, retired_at = now() where id = %L$$, pruebas.id('retirada')));
select pruebas.forzar(format($$update public.course_registry set state = 'changes_pending', pending_version_state = 'draft' where course_id = %L$$, pruebas.id('c_version')));
create temp table vista as select pruebas.portal(pruebas.p(3)) as v;
grant select on vista to app_service, authenticated;

-- ---------------------------------------------------------------------------------------
-- Qué sale: lo publicado de sus lecciones que se ven, nada de otro maestro.

select is((select v ->> 'answer' from vista), 'ok', 'la maestra lee lo de sus lecciones');
select is((select pruebas.ids_de(v) from vista), pruebas.ordenados(array[pruebas.id('a_vigente'), pruebas.id('b_vigente'), pruebas.id('a_version')]),
  'lo de la vigente y lo de la versión abierta; nada del curso sin listar, de la lección retirada ni del otro maestro');
select is((select array_agg(k order by k) from vista, jsonb_object_keys(pruebas.fila(v, pruebas.id('a_vigente'))) k),
  array['answered', 'body', 'course', 'course_slug', 'course_title', 'created_at', 'edited', 'id', 'lesson', 'lesson_title', 'name', 'own', 'replies', 'revision', 'state', 'teacher'],
  'cada fila, con su lista exacta de claves');
select is((select pruebas.fila(v, pruebas.id('a_vigente')) ->> 'name' from vista), 'Ana', 'el autor con su nombre de comentarios');
select is((select pruebas.fila(v, pruebas.id('a_vigente')) ->> 'revision' from vista), null, 'sin la revisión de lo ajeno');
select is((select pruebas.fila(v, pruebas.id('a_version')) ->> 'course_title' from vista), 'Curso pa45-version', 'con el título publicado del curso');
select ok(not (select pruebas.id('a_resp')::text in (select r ->> 'id' from jsonb_array_elements(pruebas.fila(v, pruebas.id('b_vigente')) -> 'replies' -> 'items') r) from vista),
  'la respuesta de Ana en revisión no sale en el hilo de Beto');
select is((select jsonb_path_query_array(pruebas.fila(v, pruebas.id('b_vigente')) -> 'replies' -> 'items', '$[*].id') from vista),
  jsonb_build_array(pruebas.id('m_resp')), 'la de la maestra en revisión sí, porque es suya');
select is((select pruebas.fila(v, pruebas.id('b_vigente')) -> 'replies' -> 'items' -> 0 ->> 'state' from vista), 'in_review', 'en revisión');
select is((select (pruebas.fila(v, pruebas.id('b_vigente')) -> 'replies' -> 'items' -> 0 ->> 'revision')::int from vista), 1, 'con la revisión que lleva editarla');
select is((select (pruebas.fila(v, pruebas.id('b_vigente')) ->> 'answered')::boolean from vista), false, 'y el comentario sigue sin responder');
select is(pruebas.ids_de(pruebas.portal(pruebas.p(3), null, true)), pruebas.ordenados(array[pruebas.id('a_vigente'), pruebas.id('b_vigente'), pruebas.id('a_version')]),
  'con «Sin responder», también');
select is(pruebas.ids_de(pruebas.portal(pruebas.p(3), pruebas.id('c_vigente'))), pruebas.ordenados(array[pruebas.id('a_vigente'), pruebas.id('b_vigente')]), 'de un curso, lo de ese curso');
select is(pruebas.ids_de(pruebas.portal(pruebas.p(3), pruebas.id('c_otro'))), '{}', 'del curso de otro maestro, nada');
select is(pruebas.ids_de(pruebas.portal(pruebas.p(4))), array[pruebas.id('a_otro')], 'el otro maestro, solo lo suyo');

-- ---------------------------------------------------------------------------------------
-- Quién lee, y lo que contesta el portón: lo que PA-45 pinta en lugar de «Responder».

select is(pruebas.puede(pruebas.p(3), pruebas.id('vigente')), 'ok', 'la maestra puede responder');
select pruebas.marca('comments_accept', false);
select is(pruebas.r(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)'), 'ok', 'sin la marca de aceptar, lee');
select is(pruebas.puede(pruebas.p(3), pruebas.id('vigente')), 'closed', 'y no responde');
select pruebas.marca('comments_accept', true);
select pruebas.forzar(format($$update public.profiles set comment_ban_until = now() + interval '1 day' where id = %L$$, pruebas.p(3)));
select is(pruebas.r(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)'), 'ok', 'con el veto, lee');
select is(pruebas.puede(pruebas.p(3), pruebas.id('vigente')), 'banned', 'y no responde');
select pruebas.forzar(format($$update public.profiles set comment_ban_until = null where id = %L$$, pruebas.p(3)));
select pruebas.forzar(format($$update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'Prueba de la 96' where id = %L$$, pruebas.id('t3')));
select is(pruebas.ids_de(pruebas.portal(pruebas.p(3))), pruebas.ordenados(array[pruebas.id('a_vigente'), pruebas.id('b_vigente'), pruebas.id('a_version')]), 'suspendida, lee lo mismo');
select is(pruebas.puede(pruebas.p(3), pruebas.id('vigente')), 'suspended', 'y no responde');
select pruebas.forzar(format($$update public.teachers set status = 'left', suspended_at = null, suspension_reason = null, left_at = now() where id = %L$$, pruebas.id('t3')));
select is(pruebas.r(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)'), 'not_teacher', 'la que se fue ya no tiene PA-45');
select pruebas.forzar(format($$update public.teachers set status = 'active', left_at = null where id = %L$$, pruebas.id('t3')));
select pruebas.forzar(format($$update public.profiles set status = 'suspended', suspended_at = now(), suspension_reason = 'Prueba de la 96' where id = %L$$, pruebas.p(3)));
select is(pruebas.r(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)'), 'not_teacher', 'con la cuenta suspendida, tampoco');
select pruebas.forzar(format($$update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = %L$$, pruebas.p(3)));
select is(pruebas.r(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)'), 'ok', 'de vuelta, lee');
select is(pruebas.r(pruebas.p(1), 'private.comments_for_teacher(null, false, null, null)'), 'not_teacher', 'una alumna no tiene PA-45');
select is(pruebas.r(null, 'private.comments_for_teacher(null, false, null, null)'), 'not_teacher', 'ni nadie sin actuar');
select pruebas.interruptor('false');
select is(pruebas.r(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)'), 'closed', 'con el interruptor apagado, cerrado');
select is(pruebas.puede(pruebas.p(3), pruebas.id('vigente')), 'closed', 'y el portón también');
select pruebas.interruptor('true');

select * from finish();
rollback;
