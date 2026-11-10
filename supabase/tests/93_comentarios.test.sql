-- T-501, primera solicitud · Comentarios por lección y respuesta del maestro, en la base (RF-801, RF-609; FL-15, FL-38).
-- Plan aprobado por Sergio el 2026-11-06, con sus decisiones: tras el interruptor, el seudónimo mínimo, la regla única de
-- acceso (que decide el servidor) y borrar deja la fila vacía. Aquí: el guardián que impide publicar sin filtro, las
-- respuestas del portón y de cada función, con la marca local y sin ella, lo que ve cada quien y el área `comments`.
begin;
\ir _ayuda.psql
select plan(213);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a9300000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
-- 1 Ana y 2 Beto, alumnos; 3 la maestra del curso uno; 4 el maestro del curso dos; 5 Contenido.
select pruebas.alta(pruebas.p(n), 'comenta-' || n || '@prueba.test') from generate_series(1, 5) n;
select pruebas.confirmar(pruebas.p(n)) from generate_series(1, 5) n;
select pruebas.dar_capacidad(pruebas.p(5), 'content');
select pruebas.equipar(pruebas.p(5));

create table pruebas.ids (k text primary key, v uuid not null);
create function pruebas.id(p_k text) returns uuid language sql stable as $$ select v from pruebas.ids where k = p_k $$;
grant select, insert on pruebas.ids to app_service;

-- Lo que contesta una función como el servidor a nombre de alguien. Con `p_k`, guarda el id que devolvió.
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
-- Publicar como alguien: la respuesta. Todo nace en esta transacción, con la misma hora: para que el orden se pueda mirar,
-- cada uno queda un milisegundo después del anterior (en réplica, sin el guardián). La paginación, abajo, conserva el empate.
create sequence pruebas.reloj;
create function pruebas.publica(p_actor uuid, p_lesson text, p_body text, p_parent text default null, p_k text default null)
returns text language plpgsql as $$
declare
  v jsonb := pruebas.c(p_actor, format('private.comment_post(%L, %L, %L)', pruebas.id(p_lesson), pruebas.id(p_parent), p_body), p_k);
begin
  if v ->> 'id' is not null then
    -- Con la sentencia: Supabase deja al dueño ponerlo así, no con `set_config`.
    set local session_replication_role = replica;
    update public.comments set created_at = now() + nextval('pruebas.reloj') * interval '1 millisecond' where id = (v ->> 'id')::uuid;
    set local session_replication_role = origin;
  end if;
  return v ->> 'answer';
end
$$;
create function pruebas.rev(p_k text) returns bigint language sql stable
as $$ select revision from public.comments where id = pruebas.id(p_k) $$;
-- Que pasen diez minutos para el freno de alguien: lo ya vencido se va y lo vigente queda 11 minutos antes. En dos pasos,
-- porque correr todo en una sentencia choca con la llave cuando hay una fila vencida y otra vigente.
-- Que pasen unos minutos para el freno de alguien (sin llegar a diez, para no chocar con la llave).
create function pruebas.pasan(p_actor uuid, p_minutes integer) returns void
language sql as $$
  update private.rate_limit_counters set window_start = window_start - p_minutes * interval '1 minute'
  where bucket = 'comments:' || p_actor
$$;
create function pruebas.pasan_diez(p_actor uuid) returns void
language plpgsql as $$
begin
  perform pruebas.limpiar();
  delete from private.rate_limit_counters
  where bucket = 'comments:' || p_actor and window_start <= now() - interval '10 minutes';
  update private.rate_limit_counters set window_start = window_start - interval '11 minutes'
  where bucket = 'comments:' || p_actor;
end
$$;
create function pruebas.estado(p_k text) returns text language sql stable
as $$ select status::text from public.comments where id = pruebas.id(p_k) $$;
-- El interruptor, tal cual se guarda (un valor de `business_parameters`).
create function pruebas.interruptor(p_value jsonb) returns void
language plpgsql as $$
begin
  perform pruebas.limpiar();
  alter table public.business_parameters disable trigger user;
  update public.business_parameters set value = p_value where key = 'COMENTARIOS_ABIERTOS' and canceled_at is null;
  alter table public.business_parameters enable trigger user;
end
$$;
-- La marca local de publicar sin filtro. Pone siempre la de aceptar comentarios (`t501_puertas`), que no es lo que se
-- prueba aquí (es de la 94): en la integración continua la primera corrida va antes de `db:login`, que la pone.
create function pruebas.marca(p_on boolean) returns void
language plpgsql as $$
begin
  perform pruebas.limpiar();
  insert into private.local_flags (flag) values ('comments_accept') on conflict do nothing;
  if p_on then
    insert into private.local_flags (flag) values ('comments_test_filter') on conflict do nothing;
  else
    delete from private.local_flags where flag = 'comments_test_filter';
  end if;
end
$$;
-- Lo que ve alguien de una lección: cada comentario como «nombre: texto [estado]», con sus respuestas sangradas.
create function pruebas.ve(p_actor uuid, p_lesson text) returns text[]
language plpgsql as $$
declare
  v jsonb := pruebas.c(p_actor, format('private.comments_for_lesson(%L, null, null)', pruebas.id(p_lesson)));
  v_out text[] := '{}';
  v_item jsonb;
  v_reply jsonb;
begin
  for v_item in select * from jsonb_array_elements(v -> 'items') loop
    v_out := v_out || (coalesce(v_item ->> 'name', '-') || ': ' || coalesce(v_item ->> 'body', '-') || ' [' || (v_item ->> 'state') || ']');
    for v_reply in select * from jsonb_array_elements(v_item -> 'replies' -> 'items') loop
      v_out := v_out || ('  ' || coalesce(v_reply ->> 'name', '-') || ': ' || coalesce(v_reply ->> 'body', '-') || ' [' || (v_reply ->> 'state') || ']');
    end loop;
  end loop;
  return v_out;
end
$$;
create function pruebas.vigila() returns text[]
language sql as $$
  select coalesce(array_agg(v.problem || ' ' || v.object_name order by v.problem, v.object_name), '{}')
  from private.schema_violations_comments() v
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- Dos maestros con cuenta, su aviso aceptado, y un curso cada uno: el uno con dos lecciones, el dos con una.
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
  ('t3', private.system_add_teacher('Maestra Luz', 'maestra-luz', null)),
  ('t4', private.system_add_teacher('Maestro Sol', 'maestro-sol', null)),
  ('t5', private.system_add_teacher('Maestra Sin Cuenta', 'maestra-sin-cuenta', null));
update public.teachers set profile_id = pruebas.p(3), status = 'active' where id = pruebas.id('t3');
update public.teachers set profile_id = pruebas.p(4), status = 'active' where id = pruebas.id('t4');
select private.system_load_course(pruebas.id('t3'), pruebas.curso('comenta-uno', array['Lección a', 'Lección b']));
select private.system_load_course(pruebas.id('t4'), pruebas.curso('comenta-dos', array['Lección c']));
select private.system_load_course(pruebas.id('t5'), pruebas.curso('comenta-tres', array['Lección d']));
select pruebas.limpiar();
-- Con el aviso del maestro aceptado: sin él, la base no lo deja escribir a su nombre. Una base sin borradores no lo trae.
select pruebas.como_dueno_sistema();
insert into public.legal_documents (doc_type, version, title, body, effective_from)
select 'teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now()
where private.current_legal_document('teacher_privacy_notice') is null;
select pruebas.limpiar();
create function pruebas.aviso(p_n integer) returns void
language plpgsql as $$
begin
  perform pruebas.limpiar();
  perform set_config('app.actor_id', pruebas.p(p_n)::text, true);
  insert into public.consents (profile_id, legal_document_id, origin)
  values (pruebas.p(p_n), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
  perform pruebas.limpiar();
end
$$;
select pruebas.aviso(3), pruebas.aviso(4);
select is(pruebas.pide(pruebas.p(5), format('private.approve_course(%L)', course_id)), 'approved', 'se aprueba ' || slug)
from public.course_registry r join public.published_courses c using (course_id)
where c.slug in ('comenta-uno', 'comenta-dos', 'comenta-tres') order by c.slug;
insert into pruebas.ids select 'L' || substr(l.title, 9, 1), l.id from public.published_lessons l
where l.course_id in (select course_id from public.published_courses where slug like 'comenta-%');
insert into private.app_sessions (session_id, profile_id) select pruebas.sesion(pruebas.p(n)), pruebas.p(n) from generate_series(1, 5) n
on conflict (session_id) do nothing;
select pruebas.marca(true), pruebas.interruptor('true');

-- ---------------------------------------------------------------------------------------
-- La estructura, los permisos y el vigilante.

select has_table('public', 'comments', 'existe public.comments');
select has_table('public', 'profile_privacy', 'existe public.profile_privacy');
select enum_has_labels('public', 'comment_status', array['in_filter', 'published', 'in_review', 'hidden', 'deleted'], 'los estados del 05');
select is(pruebas.vigila(), '{}', 'el área comments no dice nada');
select is((select count(*)::int from private.schema_violations() v where v.object_name like '%comment%' or v.object_name like '%profile_privacy%'),
  0, 'y el vigilante entero tampoco');
select pruebas.como_usuario(pruebas.p(1));
select throws_ok('select count(*) from public.comments', '42501', null, 'la persona con sesión no lee la tabla');
select throws_ok('select count(*) from public.profile_privacy', '42501', null, 'ni la de privacidad');
select pruebas.como_servicio(pruebas.p(1));
select throws_ok('select count(*) from public.comments', '42501', null, 'tampoco el servidor: solo por las funciones');
select throws_ok($$insert into public.comments (lesson_id, course_id, teacher_id, author_id, body) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x')$$,
  '42501', null, 'ni escribe');
select is(private.comment_settle(gen_random_uuid(), 1, 'pass', 'test') ->> 'answer', 'not_found', 'asienta solo lo propio que sigue en el filtro');
select throws_ok('select private.comment_gate(gen_random_uuid())', '42501', null, 'ni llama al portón');
select pruebas.limpiar();
-- El vigilante ve un permiso de más, un guardián apagado y una función nueva sin lista.
grant select on public.comments to app_service;
select is(pruebas.vigila(), array['comments table reachable by app_service public.comments'], 'el vigilante ve un permiso de lectura de más');
revoke select on public.comments from app_service;
alter table public.comments disable trigger comments_guard;
select is(pruebas.vigila(), array['comments without guard public.comments'], 'y el guardián apagado');
alter table public.comments enable trigger comments_guard;
create function private.comment_extra() returns integer language sql as $$ select 1 $$;
select is(pruebas.vigila(), array['comment function not listed private.comment_extra()'], 'y una puerta nueva sin lista');
drop function private.comment_extra();
grant execute on function private.comment_gate(uuid) to authenticated;
select is(pruebas.vigila(), array['comment inner function executable by authenticated private.comment_gate(uuid)'],
  'y una pieza de adentro que ejecuta la persona');
revoke execute on function private.comment_gate(uuid) from authenticated;
alter table public.comments disable trigger comments_parent_depth;
select is(pruebas.vigila(), array['comments without depth check public.comments'], 'y la profundidad apagada');
alter table public.comments enable trigger comments_parent_depth;
alter table public.comments disable row level security;
select is(pruebas.vigila(), array['comments table without row security public.comments'], 'y la tabla sin seguridad por fila');
alter table public.comments enable row level security;
create policy prueba on public.profile_privacy for select using (true);
select is(pruebas.vigila(), array['comments table with a policy public.profile_privacy'], 'y una política');
drop policy prueba on public.profile_privacy;
alter function private.guard_comment() security definer;
select is(pruebas.vigila(), array['comment trigger function runs as its owner private.guard_comment()'],
  'y el guardián corriendo como su dueño, que dejaría pasar a todos');
alter function private.guard_comment() security invoker;
create function public.comment_hoja() returns integer language sql as $$ select count(*)::int from public.comments $$;
select is(pruebas.vigila(), array['comment function not listed public.comment_hoja()'], 'y una función de public que nombra la tabla');
drop function public.comment_hoja();
grant execute on function private.comment_post(uuid, uuid, text) to authenticated;
select is(pruebas.vigila(), array['comment function executable by authenticated private.comment_post(uuid,uuid,text)'],
  'y una puerta que ejecuta la persona');
select ok(exists (select 1 from private.schema_violations() v where v.problem = 'comment function executable by authenticated'),
  'y el vigilante entero también la ve');
revoke execute on function private.comment_post(uuid, uuid, text) from authenticated;

-- ---------------------------------------------------------------------------------------
-- El seudónimo (RF-808).

select is(pruebas.publica(pruebas.p(1), 'La', 'Hola'), 'needs_pseudonym', 'sin seudónimo, primero se elige');
select is(pruebas.r(pruebas.p(1), $$private.comment_set_pseudonym('A')$$), 'invalid', 'de una letra, no');
select is(pruebas.r(pruebas.p(1), format('private.comment_set_pseudonym(%L)', repeat('a', 41))), 'invalid', 'de 41, no');
select is(pruebas.r(pruebas.p(1), $$private.comment_set_pseudonym(' Ana')$$), 'invalid', 'con espacio en la punta, no');
select is(pruebas.r(pruebas.p(1), format('private.comment_set_pseudonym(%L)', 'An' || chr(10) || 'a')), 'invalid', 'en dos líneas, no');
select is(pruebas.r(pruebas.p(1), $$private.comment_set_pseudonym('Anita')$$), 'ok', 'Anita, sí');
select is(pruebas.r(pruebas.p(1), format('private.comment_set_pseudonym(%L)', U&'Ana \+01F9D8\200D\2640\FE0F')), 'ok', 'con un emoji compuesto (ZWJ), sí');
select is(pruebas.r(pruebas.p(1), format('private.comment_set_pseudonym(%L)', U&'Ana\200D')), 'invalid', 'con la unión en la punta, no');
select is(pruebas.r(pruebas.p(1), format('private.comment_set_pseudonym(%L)', U&'Ana \200Dx')), 'invalid', 'ni pegada a un espacio');
select is(pruebas.r(pruebas.p(1), format('private.comment_set_pseudonym(%L)', U&'Ana\00A0\200Dx')), 'invalid', 'ni a un espacio duro');
select is(pruebas.r(pruebas.p(1), format('private.comment_set_pseudonym(%L)', U&'Ana\200D\200Dx')), 'invalid', 'ni dos seguidas');
select is(pruebas.r(pruebas.p(1), format('private.comment_set_pseudonym(%L)', U&'Mehr\200Cdad')), 'ok', 'la no unión entre letras, sí');
select is(pruebas.r(pruebas.p(1), format('private.comment_set_pseudonym(%L)', repeat('a', 20) || U&'\200D' || repeat('a', 20))), 'invalid',
  'y cuenta para el largo: 41 con ella, no');
select is(pruebas.r(pruebas.p(1), format('private.comment_set_pseudonym(%L)', U&'An\202Ea')), 'invalid', 'una inversión de dirección sigue sin pasar');
select is(pruebas.r(pruebas.p(1), format('private.comment_set_pseudonym(%L)', U&'An\200Ba')), 'invalid', 'ni un espacio de ancho cero entre letras');
select is(pruebas.r(pruebas.p(1), $$private.comment_set_pseudonym('Ana la del bosque')$$), 'ok', 'y se cambia');
select is((select pseudonym from public.profile_privacy where profile_id = pruebas.p(1)), 'Ana la del bosque', 'queda el último');
select is(pruebas.r(null, $$private.comment_set_pseudonym('Nadie')$$), 'suspended_account', 'sin nadie que actúe, no');

-- ---------------------------------------------------------------------------------------
-- Publicar, con la marca local: el portón.

select is(pruebas.publica(pruebas.p(1), 'La', 'Primer comentario', null, 'c1'), 'ok', 'Ana publica');
select is(pruebas.estado('c1'), 'published', 'con la marca del proveedor de prueba, publicado');
select is((select (filter_verdict, filter_provider) from public.comments where id = pruebas.id('c1')), ('pass'::text, 'test'::text), 'con el veredicto y el proveedor que lo dio (T-502)');
select is((select (is_teacher_reply, author_id = pruebas.p(1), teacher_id = pruebas.id('t3')) from public.comments where id = pruebas.id('c1')),
  (false, true, true), 'de alumna, suyo, del maestro de la lección');
select is(pruebas.publica(pruebas.p(1), 'La', ''), 'invalid', 'vacío, no');
select is(pruebas.publica(pruebas.p(1), 'La', ' hola'), 'invalid', 'con espacio en la punta, no');
select is(pruebas.publica(pruebas.p(1), 'La', repeat('a', 4001)), 'invalid', 'de 4 001, no');
select is(pruebas.publica(pruebas.p(1), 'La', 'Uno' || chr(8238) || 'dos'), 'invalid', 'con una inversión de dirección, no');
select is(pruebas.publica(pruebas.p(1), 'La', 'Primera línea' || chr(10) || 'segunda'), 'ok', 'en dos líneas, sí');
select is(pruebas.r(pruebas.p(1), format('private.comment_post(%L, null, %L)', gen_random_uuid(), 'x')), 'not_found', 'en una lección que no existe, no');

select pruebas.interruptor('false');
select is(pruebas.publica(pruebas.p(1), 'La', 'Cerrado'), 'closed', 'con el interruptor apagado, cerrado');
select pruebas.interruptor('null');
select is(pruebas.publica(pruebas.p(1), 'La', 'Cerrado'), 'closed', 'nulo cuenta como cerrado');
select pruebas.interruptor('"true"');
select is(pruebas.publica(pruebas.p(1), 'La', 'Cerrado'), 'closed', 'un texto no es un booleano: cerrado');
select pruebas.interruptor('true');

select pruebas.suspender(pruebas.p(2));
select is(pruebas.publica(pruebas.p(2), 'La', 'Suspendido'), 'suspended_account', 'una cuenta suspendida no comenta');
select is(pruebas.r(pruebas.p(2), $$private.comment_set_pseudonym('Beto')$$), 'suspended_account', 'ni elige seudónimo');
select pruebas.como_dueno_sistema();
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = pruebas.p(2);
select pruebas.limpiar();
select is(pruebas.r(pruebas.p(2), $$private.comment_set_pseudonym('Beto')$$), 'ok', 'Beto elige su seudónimo');
select pruebas.como_dueno_sistema();
update public.profiles set comment_ban_until = now() + interval '1 day' where id = pruebas.p(2);
select pruebas.limpiar();
select is(pruebas.r(pruebas.p(2), $$private.comment_set_pseudonym('Beto el vetado')$$), 'banned',
  'vetado, no cambia de seudónimo: renombraría lo que ya publicó');
select is(pruebas.publica(pruebas.p(2), 'La', 'Vetado'), 'banned', 'con el derecho a comentar suspendido, no');
select pruebas.como_dueno_sistema();
update public.profiles set comment_ban_until = now() - interval '1 second' where id = pruebas.p(2);
select pruebas.limpiar();
select is(pruebas.publica(pruebas.p(2), 'La', 'Ya puedo', null, 'b1'), 'ok', 'con el veto vencido, sí');
-- Un curso por guion: su maestro no tiene cuenta, y nadie escribe como él.
select is(pruebas.publica(pruebas.p(2), 'Ld', 'En un curso por guion', null, 'd1'), 'ok', 'en el curso de un maestro sin cuenta, sí');
select is((select is_teacher_reply from public.comments where id = pruebas.id('d1')), false, 'y no como su maestro');
select is((select array_agg(k order by k) from jsonb_object_keys(
  pruebas.c(pruebas.p(2), format('private.comment_post(%L, null, %L)', pruebas.id('Ld'), 'Otra en la d'))) k),
  array['answer', 'id', 'revision', 'state'], 'publicar contesta esas claves');

-- Una lección retirada, un curso sin listar o en borrador: no existen para comentar.
select pruebas.como_dueno();
set local session_replication_role = replica;
update public.published_lessons set is_current = false, retired_at = now() where id = pruebas.id('Lb');
reset session_replication_role;
select is(pruebas.publica(pruebas.p(1), 'Lb', 'Retirada'), 'not_found', 'en una lección retirada, no');
set local session_replication_role = replica;
update public.published_lessons set is_current = true, retired_at = null where id = pruebas.id('Lb');
update public.published_courses set is_listed = false where slug = 'comenta-uno';
reset session_replication_role;
select is(pruebas.publica(pruebas.p(1), 'Lb', 'Sin listar'), 'not_found', 'en un curso sin listar, no');
set local session_replication_role = replica;
update public.published_courses set is_listed = true where slug = 'comenta-uno';
reset session_replication_role;
set local session_replication_role = replica;
create temporary table registro_antes on commit drop as
  select * from public.course_registry where course_id = (select course_id from public.published_courses where slug = 'comenta-uno');
update public.course_registry set state = 'withdrawn', withdrawn_at = now(), withdrawal_reason = 'prueba', is_open = false, open_since = null
where course_id = (select course_id from registro_antes);
reset session_replication_role;
select is(pruebas.publica(pruebas.p(1), 'Lb', 'Retirado'), 'not_found', 'en un curso retirado, aunque siga listado, no');
set local session_replication_role = replica;
update public.course_registry r set state = a.state, withdrawn_at = a.withdrawn_at, withdrawal_reason = a.withdrawal_reason,
  is_open = a.is_open, open_since = a.open_since
from registro_antes a where r.course_id = a.course_id;
reset session_replication_role;
select is(pruebas.publica(pruebas.p(1), 'Lb', 'En la b', null, 'cb'), 'ok', 'listado otra vez, sí');

-- ---------------------------------------------------------------------------------------
-- El maestro (RF-609, FL-38).

select is(pruebas.publica(pruebas.p(3), 'La', 'Gracias por comentar', 'c1', 'm1'), 'ok', 'la maestra responde sin seudónimo');
select is((select is_teacher_reply from public.comments where id = pruebas.id('m1')), true, 'como maestra del curso');
select is(pruebas.publica(pruebas.p(3), 'La', 'Un aviso de la maestra', null, 'm2'), 'ok', 'y comenta en su lección');
select is(pruebas.publica(pruebas.p(4), 'La', 'Soy otro maestro'), 'needs_pseudonym', 'en un curso ajeno es como cualquiera: pide seudónimo');
select is(pruebas.r(pruebas.p(4), $$private.comment_set_pseudonym('Sol')$$), 'ok', 'lo elige');
select is(pruebas.publica(pruebas.p(4), 'La', 'Soy otro maestro', null, 'o1'), 'ok', 'y comenta');
select is((select is_teacher_reply from public.comments where id = pruebas.id('o1')), false, 'no como maestro de ese curso');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba' where id = pruebas.id('t3');
select pruebas.limpiar();
select is(pruebas.publica(pruebas.p(3), 'La', 'Suspendida'), 'suspended', 'la maestra suspendida no escribe');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'active', suspended_at = null, suspension_reason = null where id = pruebas.id('t3');
select pruebas.limpiar();
select pruebas.suspender(pruebas.p(3));
select is(pruebas.publica(pruebas.p(3), 'La', 'Cuenta suspendida'), 'suspended_account', 'ni la maestra con la cuenta suspendida');
select pruebas.como_dueno_sistema();
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = pruebas.p(3);
select pruebas.limpiar();
select pruebas.como_dueno();
set local session_replication_role = replica;
update public.consents set action = 'withdrawn' where profile_id = pruebas.p(3);
reset session_replication_role;
select is(pruebas.publica(pruebas.p(3), 'La', 'Sin aviso'), 'needs_notice', 'con el aviso pendiente, primero el aviso');
set local session_replication_role = replica;
update public.consents set action = 'granted' where profile_id = pruebas.p(3);
reset session_replication_role;
select pruebas.como_dueno_sistema();
update public.profiles set comment_ban_until = now() + interval '1 day' where id = pruebas.p(3);
select pruebas.limpiar();
select is(pruebas.publica(pruebas.p(3), 'La', 'Vetada'), 'banned', 'el veto también detiene a la maestra en sus lecciones');
select pruebas.como_dueno_sistema();
update public.profiles set comment_ban_until = null where id = pruebas.p(3);
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Las respuestas: un solo nivel, de la misma lección, a algo publicado.

select is(pruebas.publica(pruebas.p(2), 'La', 'Respondo a Ana', 'c1', 'r1'), 'ok', 'Beto responde a Ana');
select is(pruebas.publica(pruebas.p(3), 'La', 'A una respuesta', 'r1', 'rr'), 'ok', 'a una respuesta, sí (FL-15 A1)');
select is((select parent_id from public.comments where id = pruebas.id('rr')), pruebas.id('c1'), 'y cuelga del comentario original');
select is(pruebas.r(pruebas.p(3), format('private.comment_delete(%L, %s)', pruebas.id('rr'), pruebas.rev('rr'))), 'ok', 'la maestra la borra');
select is(pruebas.publica(pruebas.p(1), 'La', 'A la respuesta borrada', 'rr'), 'bad_parent', 'a una respuesta borrada, no');
select is(pruebas.publica(pruebas.p(1), 'Lc', 'En otra lección', 'c1'), 'bad_parent', 'a un comentario de otra lección, no');
select is(pruebas.r(pruebas.p(1), format('private.comment_post(%L, %L, %L)', pruebas.id('La'), gen_random_uuid(), 'x')), 'bad_parent', 'a uno que no existe, no');
select pruebas.como_dueno();
select throws_ok(format($$insert into public.comments (lesson_id, course_id, teacher_id, author_id, parent_id, body)
                          select lesson_id, course_id, teacher_id, author_id, %L, 'x' from public.comments where id = %L$$,
                        pruebas.id('r1'), pruebas.id('r1')),
  '23514', null, 'la base tampoco deja un segundo nivel');
select throws_ok(format($$insert into public.comments (lesson_id, course_id, teacher_id, author_id, parent_id, body)
                          select l.id, l.course_id, l.teacher_id, %L, %L, 'x' from public.published_lessons l where l.id = %L$$,
                        pruebas.p(1), pruebas.id('c1'), pruebas.id('Lc')),
  '23514', null, 'ni una respuesta en otra lección');

-- ---------------------------------------------------------------------------------------
-- El guardián: nada se publica sin filtro, ni a mano.

select pruebas.marca(false);
select is(pruebas.publica(pruebas.p(1), 'La', 'Sin marca', null, 'sm'), 'ok', 'sin la marca local, se acepta');
select is(pruebas.estado('sm'), 'in_review', 'pero queda en revisión');
select is((select filter_verdict from public.comments where id = pruebas.id('sm')), 'unavailable', 'con el filtro que no respondió (FL-15 E4)');
select is(pruebas.publica(pruebas.p(2), 'La', 'Respondo a lo que está en revisión', 'sm'), 'bad_parent', 'a algo en revisión no se responde');
select is(pruebas.publica(pruebas.p(1), 'Lb', 'Para el guardián', null, 'g1'), 'ok', 'otro en revisión, para probar el guardián a mano');
select pruebas.como_dueno();
-- Aunque alguien tuviera permiso sobre la tabla, solo escriben sus funciones.
grant insert on public.comments to authenticated;
grant select on pruebas.ids to authenticated;
select pruebas.como_usuario(pruebas.p(1));
select throws_ok(format($$insert into public.comments (lesson_id, course_id, teacher_id, author_id, body) values (%L, %L, %L, %L, 'x')$$,
                        pruebas.id('Lb'), (select course_id from public.published_lessons where id = pruebas.id('Lb')), pruebas.id('t3'), pruebas.p(1)),
  '42501', 'public.comments: only through its functions', 'con permiso sobre la tabla, la persona tampoco escribe');
select pruebas.como_dueno();
revoke insert on public.comments from authenticated;
revoke select on pruebas.ids from authenticated;
select throws_ok(format($$update public.comments set status = 'published' where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: nothing is published without the filter (RF-802)', 'el dueño tampoco lo publica a mano desde revisión');
select throws_ok(format($$update public.comments set status = 'published', filter_verdict = 'pass' where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: nothing is published without the filter (RF-802)', 'ni con el veredicto: se publica solo desde filtro');
select throws_ok(format($$update public.comments set status = 'in_filter' where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: only an edit goes back to the filter', 'a filtro no vuelve sin un texto nuevo');
select throws_ok(format($$update public.comments set status = 'in_filter', body = 'otro' where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: back to the filter without the verdict of the old text', 'ni con otro texto, si guarda el veredicto del de antes');
select throws_ok(format($$update public.comments set status = 'in_filter', body = 'otro', filter_verdict = null, filter_provider = null where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: back to the filter without the verdict of the old text', 'ni sin veredicto, si guarda cuándo se filtró');
select lives_ok(format($$update public.comments set status = 'in_filter', body = 'otro', filter_verdict = null, filter_provider = null, filter_checked_at = null where id = %L$$, pruebas.id('g1')),
  'lo vuelve a filtro con otro texto, sin veredicto y sin hora del filtro (como al editar)');
select throws_ok(format($$update public.comments set status = 'published' where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: nothing is published without the filter (RF-802)', 'y de filtro, sin veredicto ni marca, no se publica');
select throws_ok(format($$update public.comments set status = 'in_review' where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: a comment goes to review from the filter', 'a revisión no va sin veredicto');
select throws_ok(format($$update public.comments set status = 'in_review', filter_verdict = 'pass' where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: a comment goes to review from the filter', 'ni con el veredicto que lo deja pasar');
select throws_ok(format($$update public.comments set status = 'published', filter_verdict = 'pass', filter_provider = 'modelo' where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: nothing is published without the filter (RF-802)', 'ni con el aprobado de un proveedor que no se conoce (T-502)');
select pruebas.marca(true);
select lives_ok(format($$update public.comments set status = 'published', filter_verdict = 'pass', filter_provider = 'test' where id = %L$$, pruebas.id('g1')),
  'con el aprobado del proveedor de prueba y su marca, sí (T-502)');
select pruebas.marca(false);
select throws_ok(format($$update public.comments set status = 'in_review', filter_verdict = 'flagged', filter_provider = 'modelo' where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: a comment goes to review from the filter', 'lo publicado no va a revisión sin pasar por filtro');
select throws_ok(format($$update public.comments set body = 'cambiado' where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: a new text goes through the filter', 'un texto nuevo no se queda publicado');
select throws_ok(format($$update public.comments set status = 'hidden' where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: hidden is not reachable yet', 'ocultar todavía no existe');
select throws_ok(format($$update public.comments set author_id = %L where id = %L$$, pruebas.p(2), pruebas.id('g1')),
  '23514', 'public.comments: what a comment is does not change', 'el autor no cambia');
select throws_ok(format($$update public.comments set created_at = created_at - interval '1 day' where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: what a comment is does not change', 'ni cuándo nació');
select throws_ok(format($$update public.comments set is_teacher_reply = true where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: what a comment is does not change', 'ni si es del maestro');
select throws_ok(format($$update public.comments set parent_id = null where id = %L$$, pruebas.id('r1')),
  '23514', 'public.comments: what a comment is does not change', 'ni de quién es respuesta');
select throws_ok(format($$delete from public.comments where id = %L$$, pruebas.id('g1')),
  '42501', 'public.comments: a comment is emptied, never deleted', 'y no se borra una fila');
select throws_ok($$insert into public.comments (lesson_id, course_id, teacher_id, author_id, body, status)
                   select id, course_id, teacher_id, 'a9300000-0000-0000-0000-000000000001', 'x', 'published' from public.published_lessons limit 1$$,
  '23514', 'public.comments: a comment is born in the filter', 'ni nace publicado');
select throws_ok($$insert into public.comments (lesson_id, course_id, teacher_id, author_id, body, filter_verdict)
                   select id, course_id, teacher_id, 'a9300000-0000-0000-0000-000000000001', 'x', 'pass' from public.published_lessons limit 1$$,
  '23514', 'public.comments: a comment is born in the filter', 'ni con veredicto');
select throws_ok($$insert into public.comments (lesson_id, course_id, teacher_id, author_id, body, edited_at)
                   select id, course_id, teacher_id, 'a9300000-0000-0000-0000-000000000001', 'x', now() from public.published_lessons limit 1$$,
  '23514', 'public.comments: a comment is born in the filter', 'ni editado');
select throws_ok($$insert into public.comments (lesson_id, course_id, teacher_id, author_id, body, revision)
                   select id, course_id, teacher_id, 'a9300000-0000-0000-0000-000000000001', 'x', 2 from public.published_lessons limit 1$$,
  '23514', 'public.comments: a comment is born in the filter', 'ni en otra versión');
select pruebas.marca(true);
select is(pruebas.r(pruebas.p(1), format('private.comment_delete(%L, %s)', pruebas.id('g1'), pruebas.rev('g1'))), 'ok', 'Ana lo borra');
select pruebas.como_dueno();
select throws_ok(format($$update public.comments set status = 'published', filter_verdict = 'pass' where id = %L$$, pruebas.id('g1')),
  '23514', 'public.comments: a deleted comment does not change', 'lo borrado ya no cambia');

-- ---------------------------------------------------------------------------------------
-- Editar (FL-15 paso 8): lo propio, con lo que se vio, otra vez por el filtro y con las mismas puertas.

select is(pruebas.r(pruebas.p(2), format('private.comment_edit(%L, %L, %s)', pruebas.id('c1'), 'Ajeno', pruebas.rev('c1'))), 'not_found', 'lo ajeno no se edita');
select is(pruebas.r(pruebas.p(1), format('private.comment_edit(%L, %L, %s)', pruebas.id('c1'), 'Viejo', pruebas.rev('c1') - 1)), 'changed', 'con otra versión, no');
select is(pruebas.r(pruebas.p(1), format('private.comment_edit(%L, %L, %s)', pruebas.id('c1'), '', pruebas.rev('c1'))), 'invalid', 'vacío, no');
select is(pruebas.r(pruebas.p(1), format('private.comment_edit(%L, %L, %s)', pruebas.id('c1'), 'Primer comentario, corregido', pruebas.rev('c1'))), 'ok', 'Ana lo corrige');
select is((select (body, status::text, edited_at is not null, revision) from public.comments where id = pruebas.id('c1')),
  ('Primer comentario, corregido'::text, 'published'::text, true, 2::bigint), 'con su texto, otra vez asentado, editado y una versión más');
select is(pruebas.r(pruebas.p(1), format('private.comment_edit(%L, %L, %s)', pruebas.id('c1'), 'Primer comentario, corregido', pruebas.rev('c1'))),
  'ok', 'con el mismo texto, se acepta');
select is(pruebas.rev('c1'), 2::bigint, 'sin escribir nada');
select is((select array_agg(k order by k) from jsonb_object_keys(pruebas.c(pruebas.p(1),
  format('private.comment_edit(%L, %L, %s)', pruebas.id('c1'), 'Primer comentario, corregido', pruebas.rev('c1')))) k),
  array['answer', 'id', 'revision', 'state'], 'editar contesta esas claves');
select pruebas.interruptor('false');
select is(pruebas.r(pruebas.p(1), format('private.comment_edit(%L, %L, %s)', pruebas.id('c1'), 'Cerrado', pruebas.rev('c1'))), 'closed', 'cerrados, no se edita');
select pruebas.interruptor('true');
select pruebas.suspender(pruebas.p(1));
select is(pruebas.r(pruebas.p(1), format('private.comment_edit(%L, %L, %s)', pruebas.id('c1'), 'Suspendida', pruebas.rev('c1'))),
  'suspended_account', 'con la cuenta suspendida, no se edita');
select pruebas.como_dueno_sistema();
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = pruebas.p(1);
select pruebas.limpiar();
set local session_replication_role = replica;
update public.published_lessons set is_current = false, retired_at = now() where id = pruebas.id('Lb');
reset session_replication_role;
select is(pruebas.r(pruebas.p(1), format('private.comment_edit(%L, %L, %s)', pruebas.id('cb'), 'En la retirada', pruebas.rev('cb'))),
  'not_found', 'en una lección retirada, no se edita');
select is(pruebas.r(pruebas.p(1), format('private.comment_replies(%L, %L, null, null)', pruebas.id('Lb'), pruebas.id('cb'))),
  'not_found', 'ni se piden sus respuestas');
select is(pruebas.r(pruebas.p(1), format('private.comments_for_lesson(%L, null, null)', pruebas.id('Lb'))), 'not_found', 'ni se leen sus comentarios');
select ok(not exists (select 1 from jsonb_array_elements(pruebas.c(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)') -> 'items') i
                      where i ->> 'body' = 'En la b'), 'ni los lista PA-45');
set local session_replication_role = replica;
update public.published_lessons set is_current = true, retired_at = null where id = pruebas.id('Lb');
update public.consents set action = 'withdrawn' where profile_id = pruebas.p(3);
reset session_replication_role;
select ok(exists (select 1 from jsonb_array_elements(pruebas.c(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)') -> 'items') i
                  where i ->> 'body' = 'En la b'), 'vigente otra vez, PA-45 lo lista');
select is(pruebas.r(pruebas.p(3), format('private.comment_edit(%L, %L, %s)', pruebas.id('m1'), 'Sin aviso', pruebas.rev('m1'))),
  'needs_notice', 'ni la maestra con el aviso pendiente');
set local session_replication_role = replica;
update public.consents set action = 'granted' where profile_id = pruebas.p(3);
reset session_replication_role;
select pruebas.como_dueno_sistema();
update public.profiles set comment_ban_until = now() + interval '1 day' where id = pruebas.p(2);
select pruebas.limpiar();
select is(pruebas.r(pruebas.p(2), format('private.comment_edit(%L, %L, %s)', pruebas.id('r1'), 'Abuso', pruebas.rev('r1'))), 'banned', 'con veto, tampoco se reescribe lo publicado');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba' where id = pruebas.id('t3');
select pruebas.limpiar();
select is(pruebas.r(pruebas.p(3), format('private.comment_edit(%L, %L, %s)', pruebas.id('m1'), 'Otra', pruebas.rev('m1'))), 'suspended', 'ni la maestra suspendida');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'active', suspended_at = null, suspension_reason = null where id = pruebas.id('t3');
select pruebas.limpiar();
select pruebas.marca(false);
select is(pruebas.r(pruebas.p(1), format('private.comment_edit(%L, %L, %s)', pruebas.id('c1'), 'Editado sin marca', pruebas.rev('c1'))), 'ok', 'sin la marca, se acepta');
select is(pruebas.estado('c1'), 'in_review', 'y lo editado queda en revisión');
select pruebas.marca(true);

-- ---------------------------------------------------------------------------------------
-- Lo que ve cada quien (PA-22): lo publicado, y lo propio en revisión solo su autor.

select is(pruebas.ve(pruebas.p(1), 'La'), array[
  'Ana la del bosque: Sin marca [in_review]',
  'Sol: Soy otro maestro [published]',
  'Maestra Luz: Un aviso de la maestra [published]',
  'Beto: Ya puedo [published]',
  'Ana la del bosque: Primera línea' || chr(10) || 'segunda [published]',
  'Ana la del bosque: Editado sin marca [in_review]',
  '  Maestra Luz: Gracias por comentar [published]',
  '  Beto: Respondo a Ana [published]'],
  'Ana ve lo publicado y lo suyo en revisión, del más reciente al más antiguo, y las respuestas al revés');
select is(pruebas.ve(pruebas.p(2), 'La'), array[
  'Sol: Soy otro maestro [published]',
  'Maestra Luz: Un aviso de la maestra [published]',
  'Beto: Ya puedo [published]',
  'Ana la del bosque: Primera línea' || chr(10) || 'segunda [published]'],
  'Beto no ve lo de Ana en revisión, ni el hilo que cuelga de ello');
select ok(not exists (
  select 1 from jsonb_array_elements(pruebas.c(pruebas.p(2), format('private.comments_for_lesson(%L, null, null)', pruebas.id('La'))) -> 'items') i
  where i ->> 'body' in ('Sin marca', 'Editado sin marca')), 'el texto en revisión no le llega a nadie más');
select is((select array_agg(k order by k) from jsonb_object_keys(
  pruebas.c(pruebas.p(1), format('private.comments_for_lesson(%L, null, null)', pruebas.id('La'))) -> 'items' -> 0) k),
  array['body', 'created_at', 'edited', 'id', 'name', 'own', 'replies', 'revision', 'state', 'teacher'],
  'cada comentario lleva exactamente esas claves: ni autor, ni alias, ni correo');
select is((select array_agg(k order by k) from jsonb_object_keys(
  pruebas.c(pruebas.p(1), format('private.comments_for_lesson(%L, null, null)', pruebas.id('La')))) k),
  array['answer', 'count', 'items', 'me', 'more'], 'y la respuesta, esas');
select is(pruebas.c(pruebas.p(2), format('private.comments_for_lesson(%L, null, null)', pruebas.id('La'))) -> 'items' -> 0 ->> 'revision', null,
  'la versión de lo ajeno no viaja');
select is(pruebas.c(pruebas.p(1), format('private.comments_for_lesson(%L, null, null)', pruebas.id('La'))) ->> 'count', '4',
  'cuenta lo publicado que todos ven, con sus respuestas: no las de lo que está en revisión');
select is(pruebas.c(pruebas.p(1), format('private.comments_for_lesson(%L, null, null)', pruebas.id('La'))) -> 'me',
  '{"teacher": false, "pseudonym": "Ana la del bosque"}'::jsonb, 'Ana sabe con qué nombre aparece');
select is(pruebas.c(pruebas.p(3), format('private.comments_for_lesson(%L, null, null)', pruebas.id('La'))) -> 'me',
  '{"teacher": true, "pseudonym": null}'::jsonb, 'la maestra sabe que es la maestra');
select pruebas.interruptor('false');
select is(pruebas.r(pruebas.p(1), format('private.comments_for_lesson(%L, null, null)', pruebas.id('La'))), 'closed', 'cerrados, no se leen');
select is(pruebas.r(pruebas.p(1), format('private.comment_replies(%L, %L, null, null)', pruebas.id('La'), pruebas.id('c1'))), 'closed', 'ni sus respuestas');
select pruebas.interruptor('true');
select is(pruebas.r(pruebas.p(1), format('private.comments_for_lesson(%L, null, null)', gen_random_uuid())), 'not_found', 'de una lección que no existe, nada');
select is(pruebas.r(pruebas.p(1), format('private.comment_replies(%L, %L, null, null)', pruebas.id('La'), pruebas.id('c1'))), 'ok', 'más respuestas de un comentario de la lección');
select is(pruebas.r(pruebas.p(1), format('private.comment_replies(%L, %L, null, null)', pruebas.id('Lc'), pruebas.id('c1'))), 'not_found', 'pero no pidiéndolas desde otra lección');
select is(pruebas.r(pruebas.p(2), format('private.comment_replies(%L, %L, null, null)', pruebas.id('La'), pruebas.id('c1'))), 'not_found',
  'ni las de un comentario que no ve');
select is((select array_agg(k order by k) from jsonb_object_keys(
  pruebas.c(pruebas.p(1), format('private.comment_replies(%L, %L, null, null)', pruebas.id('La'), pruebas.id('c1')))) k),
  array['answer', 'items', 'more'], 'y contesta esas claves');

-- ---------------------------------------------------------------------------------------
-- Borrar (RF-801): siempre se puede lo propio, y deja la fila vacía.

select is(pruebas.r(pruebas.p(2), format('private.comment_delete(%L, %s)', pruebas.id('c1'), pruebas.rev('c1'))), 'not_found', 'lo ajeno no se borra');
select is(pruebas.r(pruebas.p(1), format('private.comment_delete(%L, %s)', pruebas.id('cb'), pruebas.rev('cb') - 1)), 'changed', 'con otra versión, no');
select pruebas.interruptor('false');
select is(pruebas.r(pruebas.p(1), format('private.comment_delete(%L, %s)', pruebas.id('cb'), pruebas.rev('cb'))), 'ok', 'aunque estén cerrados, se borra');
select pruebas.interruptor('true');
select is((select (body, author_id, status::text, deleted_at is not null) from public.comments where id = pruebas.id('cb')),
  (null::text, null::uuid, 'deleted'::text, true), 'sin texto ni autor');
select is(pruebas.r(pruebas.p(1), format('private.comment_delete(%L, %s)', pruebas.id('cb'), pruebas.rev('cb'))), 'not_found', 'y no se borra dos veces');
select is(pruebas.ve(pruebas.p(1), 'Lb'), '{}', 'sin respuestas, desaparece');
select is(pruebas.publica(pruebas.p(3), 'Lb', 'Un aviso que se borra', null, 'm3'), 'ok', 'la maestra comenta en la b');
-- Sol llega con la ventana vacía, para que el freno de abajo cuente lo mismo.
select pruebas.como_dueno();
select pruebas.pasan_diez(pruebas.p(4));
select is(pruebas.publica(pruebas.p(4), 'Lb', 'Respondo al aviso', 'm3'), 'ok', 'Sol le responde');
select is(pruebas.r(pruebas.p(3), format('private.comment_delete(%L, %s)', pruebas.id('m3'), pruebas.rev('m3'))), 'ok', 'y ella lo borra');
select is(pruebas.ve(pruebas.p(1), 'Lb'), array['-: - [deleted]', '  Sol: Respondo al aviso [published]'],
  'lo borrado de la maestra tampoco lleva su nombre');
select is(pruebas.c(pruebas.p(1), format('private.comments_for_lesson(%L, null, null)', pruebas.id('Lb'))) -> 'items' -> 0 -> 'teacher',
  'false'::jsonb, 'ni dice que era de la maestra');
-- Con veto, también: es un derecho sobre lo propio. Beto borra su respuesta a Ana, y otra suya que nadie respondió.
select is(pruebas.r(pruebas.p(2), format('private.comment_delete(%L, %s)', pruebas.id('b1'), pruebas.rev('b1'))), 'ok', 'con veto, se borra');
-- Ana borra su comentario con respuestas: queda «borrado» para quien ve alguna.
select is(pruebas.r(pruebas.p(1), format('private.comment_edit(%L, %L, %s)', pruebas.id('c1'), 'Lo vuelvo a publicar', pruebas.rev('c1'))), 'ok', 'Ana lo vuelve a editar');
select is(pruebas.r(pruebas.p(1), format('private.comment_delete(%L, %s)', pruebas.id('c1'), pruebas.rev('c1'))), 'ok', 'y lo borra');
select is(pruebas.ve(pruebas.p(4), 'La'), array[
  'Sol: Soy otro maestro [published]',
  'Maestra Luz: Un aviso de la maestra [published]',
  'Ana la del bosque: Primera línea' || chr(10) || 'segunda [published]',
  '-: - [deleted]',
  '  Maestra Luz: Gracias por comentar [published]',
  '  Beto: Respondo a Ana [published]'],
  'el borrado con respuestas sale sin nombre ni texto, y sus respuestas siguen');
select is((select i -> 'edited' from jsonb_array_elements(
  pruebas.c(pruebas.p(4), format('private.comments_for_lesson(%L, null, null)', pruebas.id('La'))) -> 'items') i where i ->> 'state' = 'deleted'),
  'false'::jsonb, 'ni dice que se había editado');
select is(pruebas.c(pruebas.p(4), format('private.comments_for_lesson(%L, null, null)', pruebas.id('La'))) ->> 'count', '5',
  'el número cuenta las respuestas de lo borrado');
select is(pruebas.r(pruebas.p(4), format('private.comment_replies(%L, %L, null, null)', pruebas.id('La'), pruebas.id('c1'))), 'ok',
  'las respuestas de lo borrado se piden');
select is(pruebas.r(pruebas.p(4), format('private.comment_replies(%L, %L, null, null)', pruebas.id('La'),
  (select id from public.comments where body = 'Respondo a Ana' and status = 'published'))), 'not_found',
  'una respuesta no tiene respuestas que pedir');
select is(pruebas.publica(pruebas.p(2), 'La', 'Respondo a lo borrado', 'c1'), 'banned', 'Beto sigue vetado');
select is(pruebas.publica(pruebas.p(4), 'La', 'Respondo a lo borrado', 'c1'), 'bad_parent', 'a lo borrado no se responde');

-- ---------------------------------------------------------------------------------------
-- Las páginas: 20 a la vez, con su cursor.

select is(array_agg(pruebas.r(pruebas.p(4), format('private.comment_post(%L, null, %L)', pruebas.id('Lc'), 'Página ' || n)) order by n),
  array_fill('ok'::text, array[9]), 'Sol publica nueve en Lc') from generate_series(1, 9) n;
select is(pruebas.publica(pruebas.p(4), 'Lc', 'Página 10'), 'throttled', 'el freno: la undécima de Sol en 10 minutos no pasa');
select is(pruebas.r(pruebas.p(4), format('private.comment_edit(%L, %L, %s)', pruebas.id('o1'), 'Otra vez', pruebas.rev('o1'))), 'throttled', 'y editar también cuenta');
select pruebas.como_dueno();
select pruebas.pasan(pruebas.p(4), 9);
select is(pruebas.publica(pruebas.p(4), 'Lc', 'Página 10'), 'throttled', 'a los nueve minutos, todavía no');
select pruebas.como_dueno();
select pruebas.pasan(pruebas.p(4), 1);
select is(pruebas.publica(pruebas.p(4), 'Lc', 'Página 10'), 'throttled', 'a los diez minutos justos, todavía no');
select pruebas.como_dueno();
select pruebas.pasan_diez(pruebas.p(4));
select is(pruebas.publica(pruebas.p(4), 'Lc', 'Página 10'), 'ok', 'pasados 10 minutos, sí');
select pruebas.como_dueno();
select pruebas.pasan_diez(pruebas.p(4));
select is(array_agg(pruebas.r(pruebas.p(4), format('private.comment_post(%L, null, %L)', pruebas.id('Lc'), 'Página ' || n)) order by n),
  array_fill('ok'::text, array[9]), 'otras nueve, con la ventana corrida') from generate_series(11, 19) n;
select pruebas.como_dueno();
select pruebas.pasan_diez(pruebas.p(4));
select is(array_agg(pruebas.r(pruebas.p(4), format('private.comment_post(%L, null, %L)', pruebas.id('Lc'), 'Página ' || n)) order by n),
  array_fill('ok'::text, array[3]), 'y las tres últimas') from generate_series(20, 22) n;
-- Todos nacieron en la misma transacción (con la misma hora): el cursor desempata por id.
select is(jsonb_array_length(pruebas.c(pruebas.p(1), format('private.comments_for_lesson(%L, null, null)', pruebas.id('Lc'))) -> 'items'), 20, 'la primera página trae 20');
select is(pruebas.c(pruebas.p(1), format('private.comments_for_lesson(%L, null, null)', pruebas.id('Lc'))) ->> 'more', 'true', 'y dice que hay más');
select is((
  with p1 as (select pruebas.c(pruebas.p(1), format('private.comments_for_lesson(%L, null, null)', pruebas.id('Lc'))) -> 'items' as items),
       last as (select (items -> 19 ->> 'created_at')::timestamptz as at, (items -> 19 ->> 'id')::uuid as id from p1),
       p2 as (select pruebas.c(pruebas.p(1), format('private.comments_for_lesson(%L, %L, %L)', pruebas.id('Lc'), last.at, last.id)) as page from last)
  select (jsonb_array_length(page -> 'items'), page ->> 'more') from p2),
  (2, 'false'::text), 'la segunda, las 2 que faltan, y no hay más');
select is((select count(distinct i ->> 'id')::int from (
  with p1 as (select pruebas.c(pruebas.p(1), format('private.comments_for_lesson(%L, null, null)', pruebas.id('Lc'))) -> 'items' as items),
       last as (select (items -> 19 ->> 'created_at')::timestamptz as at, (items -> 19 ->> 'id')::uuid as id from p1)
  select jsonb_array_elements(items) as i from p1
  union all
  select jsonb_array_elements(pruebas.c(pruebas.p(1), format('private.comments_for_lesson(%L, %L, %L)', pruebas.id('Lc'), last.at, last.id)) -> 'items')
  from last) x), 22, 'sin repetir ni saltarse ninguno');
select is((select (jsonb_array_length(r -> 'items'), r ->> 'more') from (select pruebas.c(pruebas.p(1), format('private.comments_for_lesson(%L, %L, null)',
  pruebas.id('Lc'), (select created_at from public.comments where body = 'Página 1'))) as r) x),
  (20, 'true'::text), 'un cursor con la hora y sin id empieza por todo lo de esa hora');
-- Las respuestas, de 20 en 20. Se cargan a mano (en réplica, sin el guardián ni el freno), todas con la misma hora.
select pruebas.como_dueno();
set local session_replication_role = replica;
insert into public.comments (lesson_id, course_id, teacher_id, author_id, parent_id, body, status, filter_verdict, filter_provider)
select c.lesson_id, c.course_id, c.teacher_id, pruebas.p(2), c.id, 'Respuesta ' || n, 'published', 'pass', 'test'
from public.comments c, generate_series(1, 22) n where c.body = 'Página 1';
reset session_replication_role;
insert into pruebas.ids select 'p1', id from public.comments where body = 'Página 1';
select is((select (jsonb_array_length(r -> 'items'), r ->> 'more') from (select pruebas.c(pruebas.p(1),
  format('private.comment_replies(%L, %L, null, null)', pruebas.id('Lc'), pruebas.id('p1'))) as r) x),
  (20, 'true'::text), 'las respuestas, 20 a la vez');
select is((
  with p1 as (select pruebas.c(pruebas.p(1), format('private.comment_replies(%L, %L, null, null)', pruebas.id('Lc'), pruebas.id('p1'))) -> 'items' as items),
       last as (select (items -> 19 ->> 'created_at')::timestamptz as at, (items -> 19 ->> 'id')::uuid as id from p1),
       p2 as (select pruebas.c(pruebas.p(1), format('private.comment_replies(%L, %L, %L, %L)', pruebas.id('Lc'), pruebas.id('p1'), last.at, last.id)) as page from last)
  select (jsonb_array_length(page -> 'items'), page ->> 'more') from p2),
  (2, 'false'::text), 'la segunda, las 2 que faltan');
select is((select count(distinct i ->> 'id')::int from (
  with p1 as (select pruebas.c(pruebas.p(1), format('private.comment_replies(%L, %L, null, null)', pruebas.id('Lc'), pruebas.id('p1'))) -> 'items' as items),
       last as (select (items -> 19 ->> 'created_at')::timestamptz as at, (items -> 19 ->> 'id')::uuid as id from p1)
  select jsonb_array_elements(items) as i from p1
  union all
  select jsonb_array_elements(pruebas.c(pruebas.p(1), format('private.comment_replies(%L, %L, %L, %L)', pruebas.id('Lc'), pruebas.id('p1'), last.at, last.id)) -> 'items')
  from last) x), 22, 'sin repetir ni saltarse ninguna');
select is((select (jsonb_array_length(r -> 'items'), r ->> 'more') from (select pruebas.c(pruebas.p(1), format('private.comment_replies(%L, %L, %L, null)',
  pruebas.id('Lc'), pruebas.id('p1'), (select created_at from public.comments where body = 'Respuesta 1'))) as r) x),
  (20, 'true'::text), 'y en las respuestas, un cursor sin id empieza por todo lo de esa hora');

-- ---------------------------------------------------------------------------------------
-- El maestro en PA-45: lo publicado de sus lecciones, y si ya respondió.

select is(pruebas.r(pruebas.p(1), 'private.comments_for_teacher(null, false, null, null)'), 'not_teacher', 'una alumna no tiene PA-45');
select is((select array_agg(i ->> 'body' order by i ->> 'body') from jsonb_array_elements(
  pruebas.c(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)') -> 'items') i),
  array['Primera línea' || chr(10) || 'segunda', 'Soy otro maestro', 'Un aviso de la maestra'],
  'la maestra ve lo publicado de sus lecciones, sin lo borrado ni lo que está en revisión');
select is((select array_agg(i ->> 'body' order by i ->> 'body') from jsonb_array_elements(
  pruebas.c(pruebas.p(3), 'private.comments_for_teacher(null, true, null, null)') -> 'items') i),
  array['Primera línea' || chr(10) || 'segunda', 'Soy otro maestro'],
  'sin responder: lo de los demás, porque su respuesta colgaba de lo que se borró; su propio aviso no espera respuesta');
select is((select i ->> 'answered' from jsonb_array_elements(
  pruebas.c(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)') -> 'items') i where i ->> 'body' = 'Un aviso de la maestra'),
  'true', 'y de lo suyo dice que no le falta respuesta');
select is(pruebas.publica(pruebas.p(3), 'La', 'Gracias, Sol', 'o1'), 'ok', 'la maestra responde a Sol');
select is((select array_agg(i ->> 'body' order by i ->> 'body') from jsonb_array_elements(
  pruebas.c(pruebas.p(3), 'private.comments_for_teacher(null, true, null, null)') -> 'items') i),
  array['Primera línea' || chr(10) || 'segunda'],
  'y Sol ya no está entre los sin responder');
select is((select i ->> 'answered' from jsonb_array_elements(
  pruebas.c(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)') -> 'items') i where i ->> 'body' = 'Soy otro maestro'),
  'true', 'y dice que ya le respondió');
select pruebas.interruptor('false');
select is(pruebas.r(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)'), 'closed', 'cerrados, la maestra tampoco los lee');
select pruebas.interruptor('true');
select is((select count(*)::int from jsonb_array_elements(
  pruebas.c(pruebas.p(3), format('private.comments_for_teacher(%L, false, null, null)', (select course_id from public.published_courses where slug = 'comenta-dos'))) -> 'items')),
  0, 'de un curso que no es suyo, nada');
select is((select array_agg(k order by k) from jsonb_object_keys(
  pruebas.c(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)') -> 'items' -> 0) k),
  array['answered', 'body', 'course', 'course_slug', 'course_title', 'created_at', 'edited', 'id', 'lesson', 'lesson_title',
        'name', 'own', 'replies', 'revision', 'state', 'teacher'],
  'cada comentario de PA-45 lleva exactamente esas claves');
-- PA-45 también va de 20 en 20: Beto deja 21 más en la b (a mano, como arriba).
select pruebas.como_dueno();
set local session_replication_role = replica;
insert into public.comments (lesson_id, course_id, teacher_id, author_id, body, status, filter_verdict, filter_provider)
select l.id, l.course_id, l.teacher_id, pruebas.p(2), 'En la b ' || n, 'published', 'pass', 'test'
from public.published_lessons l, generate_series(1, 21) n where l.id = pruebas.id('Lb');
reset session_replication_role;
select is((select (jsonb_array_length(r -> 'items'), r ->> 'more') from (
  select pruebas.c(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)') as r) x),
  (20, 'true'::text), 'la maestra los ve de 20 en 20');
select is((
  with p1 as (select pruebas.c(pruebas.p(3), 'private.comments_for_teacher(null, false, null, null)') -> 'items' as items),
       last as (select (items -> 19 ->> 'created_at')::timestamptz as at, (items -> 19 ->> 'id')::uuid as id from p1)
  select count(distinct i ->> 'id')::int from (
    select jsonb_array_elements(items) as i from p1
    union all
    select jsonb_array_elements(pruebas.c(pruebas.p(3), format('private.comments_for_teacher(null, false, %L, %L)', last.at, last.id)) -> 'items')
    from last) x),
  24, 'y con el cursor, los 24 sin repetir ni saltarse');
select is((select (jsonb_array_length(r -> 'items'), r ->> 'more') from (select pruebas.c(pruebas.p(3), format('private.comments_for_teacher(null, false, %L, null)',
  (select created_at from public.comments where body = 'En la b 1'))) as r) x),
  (20, 'true'::text), 'un cursor con la hora y sin id empieza por todo lo de esa hora');

-- ---------------------------------------------------------------------------------------
-- Al final, para no mover las listas de arriba: un emoji compuesto, y responder a una respuesta que no está publicada.

select is(pruebas.publica(pruebas.p(4), 'La', U&'Gracias \+01F9D8\200D\2640\FE0F', null, 'em'), 'ok', 'un comentario con un emoji compuesto (ZWJ) se acepta');
select is(pruebas.estado('em'), 'published', 'y se publica');
select is(pruebas.publica(pruebas.p(4), 'La', U&'Gracias\200D'), 'invalid', 'la unión suelta en la punta, no');
select pruebas.marca(false);
select is(pruebas.publica(pruebas.p(4), 'La', 'Una respuesta que se revisa', 'em', 're'), 'ok', 'Sol se responde, sin la marca');
select is(pruebas.estado('re'), 'in_review', 'y su respuesta queda en revisión');
select is(pruebas.publica(pruebas.p(1), 'La', 'A lo que se revisa', 're'), 'bad_parent', 'a una respuesta en revisión no se responde, aunque el original esté publicado');

select * from finish();
rollback;
