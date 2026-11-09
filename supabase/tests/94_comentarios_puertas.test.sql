-- T-501, segunda solicitud · Las dos puertas del servidor y el cerrojo de producción (RF-801; FL-15). Plan aprobado por
-- Sergio el 2026-11-07, con su decisión: el cerrojo va en la base, con la marca local `comments_accept`. Aquí: lo que
-- contesta `comment_can_write` (sin escribir ni contar el freno), la lección que da `comment_lesson_of` (solo de lo propio
-- sin borrar), el cerrojo en cada puerta, y el vigilante con las dos nuevas.
begin;
\ir _ayuda.psql
select plan(47);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a9400000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
-- 1 Ana, con seudónimo; 2 Beto, sin él; 3 la maestra del curso uno; 4 el maestro del curso dos, sin su aviso; 5 Contenido;
-- 6 Cata, vetada.
select pruebas.alta(pruebas.p(n), 'puertas-' || n || '@prueba.test') from generate_series(1, 6) n;
select pruebas.confirmar(pruebas.p(n)) from generate_series(1, 6) n;
select pruebas.dar_capacidad(pruebas.p(5), 'content');
select pruebas.equipar(pruebas.p(5));

create table pruebas.ids (k text primary key, v uuid not null);
create function pruebas.id(p_k text) returns uuid language sql stable as $$ select v from pruebas.ids where k = p_k $$;
grant select, insert on pruebas.ids to app_service;
grant select on pruebas.ids to authenticated;

-- Lo que contesta una función como el servidor a nombre de alguien. Con `p_k`, guarda el id que devolvió.
create function pruebas.c(p_actor uuid, p_call text, p_k text default null) returns jsonb
language plpgsql as $$
declare
  v jsonb;
  v_test boolean;
begin
  perform pruebas.a_nombre_de(p_actor);
  execute 'select ' || p_call into v;
  perform pruebas.limpiar();
  -- Como el servidor (T-502): lo que queda en el filtro lo asienta con el proveedor de prueba si está su marca, y si no, sin
  -- proveedor.
  if v ->> 'state' = 'in_filter' then
    v_test := exists (select 1 from private.local_flags where flag = 'comments_test_filter');
    perform pruebas.a_nombre_de(p_actor);
    v := v || jsonb_build_object('state', private.comment_settle((v ->> 'id')::uuid, (v ->> 'revision')::bigint,
      case when v_test then 'pass' else 'unavailable' end, case when v_test then 'test' else 'none' end) ->> 'state');
    perform pruebas.limpiar();
  end if;
  if p_k is not null and v ->> 'id' is not null then
    insert into pruebas.ids values (p_k, (v ->> 'id')::uuid);
  end if;
  return v;
end
$$;
create function pruebas.r(p_actor uuid, p_call text, p_k text default null) returns text
language sql as $$ select pruebas.c(p_actor, p_call, p_k) ->> 'answer' $$;
create function pruebas.puede(p_actor uuid, p_lesson uuid) returns text
language sql as $$ select pruebas.r(p_actor, format('private.comment_can_write(%L)', p_lesson)) $$;
create function pruebas.leccion_de(p_actor uuid, p_comment uuid) returns uuid
language plpgsql as $$
declare
  v uuid;
begin
  perform pruebas.a_nombre_de(p_actor);
  v := private.comment_lesson_of(p_comment);
  perform pruebas.limpiar();
  return v;
end
$$;
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
-- Lo que hay escrito: los comentarios y lo que cuenta el freno.
create function pruebas.escrito() returns integer[]
language sql as $$
  select array[(select count(*)::int from public.comments),
               (select coalesce(sum(hits), 0)::int from private.rate_limit_counters where bucket like 'comments:%')]
$$;
create function pruebas.vigila() returns text[]
language sql as $$
  select coalesce(array_agg(v.problem || ' ' || v.object_name order by v.problem, v.object_name), '{}')
  from private.schema_violations_comments() v
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
  ('t3', private.system_add_teacher('Maestra Puerta', 'maestra-puerta', null)),
  ('t4', private.system_add_teacher('Maestro Umbral', 'maestro-umbral', null));
update public.teachers set profile_id = pruebas.p(3), status = 'active' where id = pruebas.id('t3');
update public.teachers set profile_id = pruebas.p(4), status = 'active' where id = pruebas.id('t4');
select private.system_load_course(pruebas.id('t3'), pruebas.curso('puertas-uno', array['Lección a', 'Lección b']));
select private.system_load_course(pruebas.id('t4'), pruebas.curso('puertas-dos', array['Lección c']));
select pruebas.limpiar();
-- Con el aviso del maestro: la maestra lo aceptó y el maestro no. Una base sin borradores no lo trae.
select pruebas.como_dueno_sistema();
insert into public.legal_documents (doc_type, version, title, body, effective_from)
select 'teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now()
where private.current_legal_document('teacher_privacy_notice') is null;
select pruebas.limpiar();
select set_config('app.actor_id', pruebas.p(3)::text, true);
insert into public.consents (profile_id, legal_document_id, origin)
values (pruebas.p(3), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
select pruebas.limpiar();
select is(pruebas.pide(pruebas.p(5), format('private.approve_course(%L)', course_id)), 'approved', 'se aprueba ' || slug)
from public.course_registry r join public.published_courses c using (course_id)
where c.slug in ('puertas-uno', 'puertas-dos') order by c.slug;
insert into pruebas.ids select 'L' || substr(l.title, 9, 1), l.id from public.published_lessons l
where l.course_id in (select course_id from public.published_courses where slug like 'puertas-%');
insert into private.app_sessions (session_id, profile_id) select pruebas.sesion(pruebas.p(n)), pruebas.p(n) from generate_series(1, 6) n
on conflict (session_id) do nothing;
select pruebas.marca('comments_accept', true), pruebas.marca('comments_test_filter', true), pruebas.interruptor('true');
select is(pruebas.r(pruebas.p(1), $$private.comment_set_pseudonym('Ana')$$), 'ok', 'Ana elige su seudónimo');
select is(pruebas.r(pruebas.p(6), $$private.comment_set_pseudonym('Cata')$$), 'ok', 'y Cata el suyo');
select pruebas.como_dueno_sistema();
update public.profiles set comment_ban_until = now() + interval '1 day' where id = pruebas.p(6);
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- El vigilante y quién ejecuta las dos puertas.

select is(pruebas.vigila(), '{}', 'el área comments no dice nada con las dos puertas');
select pruebas.como_usuario(pruebas.p(1));
select throws_ok(format('select private.comment_can_write(%L)', pruebas.id('La')), '42501', null, 'la persona no pregunta al portón');
select throws_ok(format('select private.comment_lesson_of(%L)', gen_random_uuid()), '42501', null, 'ni pide la lección de un comentario');
select pruebas.limpiar();
revoke execute on function private.comment_lesson_of(uuid) from app_service;
select is(pruebas.vigila(), array['comment function not executable by app_service private.comment_lesson_of(uuid)'],
  'el vigilante ve una puerta que el servidor no ejecuta');
grant execute on function private.comment_lesson_of(uuid) to app_service;
grant execute on function private.comment_can_write(uuid) to authenticated;
select is(pruebas.vigila(), array['comment function executable by authenticated private.comment_can_write(uuid)'],
  'y una que ejecuta la persona');
revoke execute on function private.comment_can_write(uuid) from authenticated;

-- ---------------------------------------------------------------------------------------
-- Lo que contesta `comment_can_write`: la respuesta del portón y nada más.

select is(pruebas.puede(pruebas.p(1), pruebas.id('La')), 'ok', 'Ana, con seudónimo, puede escribir');
select is((select array_agg(k) from jsonb_object_keys(pruebas.c(pruebas.p(1), format('private.comment_can_write(%L)', pruebas.id('La')))) k),
  array['answer'], 'y solo se dice la respuesta, sin el curso ni el maestro');
select is(pruebas.puede(pruebas.p(2), pruebas.id('La')), 'needs_pseudonym', 'Beto, sin seudónimo, tiene que elegirlo');
select is(pruebas.puede(pruebas.p(3), pruebas.id('La')), 'ok', 'la maestra, en lo suyo, sin seudónimo');
select is(pruebas.puede(pruebas.p(3), pruebas.id('Lc')), 'needs_pseudonym', 'en lo ajeno, como cualquiera');
select is(pruebas.puede(pruebas.p(4), pruebas.id('Lc')), 'needs_notice', 'el maestro sin su aviso al día');
select is(pruebas.puede(pruebas.p(6), pruebas.id('La')), 'banned', 'Cata, vetada');
select is(pruebas.puede(pruebas.p(1), gen_random_uuid()), 'not_found', 'una lección que no existe');
select is(pruebas.puede(null, pruebas.id('La')), 'suspended_account', 'sin nadie que actúe');
select pruebas.interruptor('false');
select is(pruebas.puede(pruebas.p(1), pruebas.id('La')), 'closed', 'con el interruptor apagado, cerrado');
select pruebas.interruptor('true');
-- Ni escribe ni cuenta el freno: con diez publicados en diez minutos, publicar se frena y preguntar sigue diciendo que sí.
select is((select array_agg(pruebas.r(pruebas.p(1), format('private.comment_post(%L, null, %L)', pruebas.id('La'), 'Uno más ' || n)) order by n)
           from generate_series(1, 10) n), array_fill('ok'::text, array[10]), 'Ana publica diez');
select is(pruebas.r(pruebas.p(1), format('private.comment_post(%L, null, %L)', pruebas.id('La'), 'El undécimo')), 'throttled', 'y el undécimo se frena');
create temp table antes as select pruebas.escrito() as v;
select is(pruebas.puede(pruebas.p(1), pruebas.id('La')), 'ok', 'preguntar no cuenta el freno');
select is(pruebas.puede(pruebas.p(1), pruebas.id('Lb')), 'ok', 'tampoco en otra lección');
select is(pruebas.escrito(), (select v from antes), 'y no escribió nada: ni un comentario ni una cuenta del freno');

-- ---------------------------------------------------------------------------------------
-- La lección de un comentario: solo de lo propio, sin borrar.

delete from private.rate_limit_counters where bucket in ('comments:' || pruebas.p(1), 'comments:' || pruebas.p(3));
select is(pruebas.r(pruebas.p(1), format('private.comment_post(%L, null, %L)', pruebas.id('Lb'), 'De Ana en la b'), 'a1'), 'ok', 'Ana comenta en la b');
select is(pruebas.r(pruebas.p(3), format('private.comment_post(%L, null, %L)', pruebas.id('La'), 'De la maestra'), 'm1'), 'ok', 'y la maestra en la a');
select is(pruebas.leccion_de(pruebas.p(1), pruebas.id('a1')), pruebas.id('Lb'), 'de lo suyo, su lección');
select is(pruebas.leccion_de(pruebas.p(3), pruebas.id('m1')), pruebas.id('La'), 'también a la maestra');
select is(pruebas.leccion_de(pruebas.p(3), pruebas.id('a1')), null, 'de lo ajeno, nada: ni a la maestra del curso');
select is(pruebas.leccion_de(pruebas.p(2), pruebas.id('a1')), null, 'ni a otro alumno');
select is(pruebas.leccion_de(null, pruebas.id('a1')), null, 'ni sin nadie que actúe');
select is(pruebas.leccion_de(pruebas.p(1), gen_random_uuid()), null, 'de uno que no existe, nada');
select is(pruebas.r(pruebas.p(1), format('private.comment_delete(%L, 1)', pruebas.id('a1'))), 'ok', 'Ana lo borra');
select is(pruebas.leccion_de(pruebas.p(1), pruebas.id('a1')), null, 'y de lo borrado, nada');
-- Borrar deja la fila sin autor; aunque un borrado conservara el suyo (forzado a mano), tampoco.
select pruebas.limpiar();
set local session_replication_role = replica;
update public.comments set author_id = pruebas.p(1) where id = pruebas.id('a1');
set local session_replication_role = origin;
select is(pruebas.leccion_de(pruebas.p(1), pruebas.id('a1')), null, 'ni de uno borrado que conserva su autor');

-- ---------------------------------------------------------------------------------------
-- El cerrojo: sin `comments_accept`, nada nuevo entra. Leer y borrar siguen.

select is(pruebas.r(pruebas.p(1), format('private.comment_post(%L, null, %L)', pruebas.id('Lb'), 'Para editar'), 'a2'), 'ok', 'con la marca, Ana publica');
select pruebas.marca('comments_accept', false);
select is(pruebas.r(pruebas.p(1), format('private.comment_post(%L, null, %L)', pruebas.id('Lb'), 'Sin la marca')), 'closed', 'sin ella, publicar contesta cerrado');
select is(pruebas.r(pruebas.p(3), format('private.comment_post(%L, null, %L)', pruebas.id('La'), 'Sin la marca')), 'closed', 'también a la maestra');
select is(pruebas.r(pruebas.p(1), format('private.comment_edit(%L, %L, 1)', pruebas.id('a2'), 'Editado')), 'closed', 'editar, también');
select is(pruebas.r(pruebas.p(1), $$private.comment_set_pseudonym('Ana la nueva')$$), 'closed', 'y elegir el seudónimo');
select is(pruebas.r(null, $$private.comment_set_pseudonym('Nadie')$$), 'closed', 'el cerrojo va antes que todo');
select is(pruebas.puede(pruebas.p(1), pruebas.id('Lb')), 'closed', 'y la pantalla lo sabe antes de escribir');
select is(pruebas.r(pruebas.p(1), format('private.comments_for_lesson(%L, null, null)', pruebas.id('Lb'))), 'ok', 'leer sigue');
select is(pruebas.r(pruebas.p(1), format('private.comment_delete(%L, 1)', pruebas.id('a2'))), 'ok', 'y lo propio se borra');
select is((select pseudonym from public.profile_privacy where profile_id = pruebas.p(1)), 'Ana', 'el seudónimo no cambió');
-- Con la marca y sin la de publicar sin filtro, se acepta y queda en revisión.
select pruebas.marca('comments_accept', true), pruebas.marca('comments_test_filter', false);
select is(pruebas.r(pruebas.p(1), format('private.comment_post(%L, null, %L)', pruebas.id('Lb'), 'Se revisa'), 'a3'), 'ok',
  'sin publicar sin filtro, se acepta');
select is((select status::text from public.comments where id = pruebas.id('a3')), 'in_review', 'y queda en revisión');

select * from finish();
rollback;
