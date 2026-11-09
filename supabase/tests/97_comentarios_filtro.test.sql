-- T-502, primera solicitud · El filtro antes de publicar (RF-802; FL-15 E4). Plan aprobado por Sergio el 2026-11-09, con sus
-- decisiones de ese día. Aquí: la normalización y la lista de términos de la base, publicar y editar que dejan el comentario en
-- el filtro (o en revisión si la lista lo marca), asentar con la revisión y el proveedor (el de prueba, solo con su marca
-- local), el barrido de lo que se quedó en el filtro, lo oculto que no se edita ni se borra, la copia de lo que está en
-- revisión al borrarlo, el seudónimo por la lista y con su freno, y el vigilante.
begin;
\ir _ayuda.psql
select plan(74);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a9700000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
-- 1 Ana y 2 Beto, con seudónimo; 3 la maestra del curso; 4 Cata, sin seudónimo.
select pruebas.alta(pruebas.p(n), 'filtro-' || n || '@prueba.test') from generate_series(1, 4) n;
select pruebas.confirmar(pruebas.p(n)) from generate_series(1, 4) n;

create table pruebas.ids (k text primary key, v uuid not null);
create function pruebas.id(p_k text) returns uuid language sql stable as $$ select v from pruebas.ids where k = p_k $$;
grant select, insert on pruebas.ids to app_service;
grant select on pruebas.ids to authenticated;

-- Lo que contesta una función como el servidor a nombre de alguien. Con `p_k`, guarda el id que devolvió. Aquí no se asienta
-- solo: es lo que se prueba.
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
create function pruebas.publica(p_actor uuid, p_body text, p_k text) returns jsonb
language sql as $$ select pruebas.c(p_actor, format('private.comment_post(%L, null, %L)', pruebas.id('La'), p_body), p_k) $$;
create function pruebas.asienta(p_actor uuid, p_k text, p_revision bigint, p_verdict text, p_provider text) returns jsonb
language sql as $$
  select pruebas.c(p_actor, format('private.comment_settle(%L, %s, %L, %L)', pruebas.id(p_k), p_revision, p_verdict, p_provider))
$$;
create function pruebas.rev(p_k text) returns bigint language sql stable
as $$ select revision from public.comments where id = pruebas.id(p_k) $$;
create function pruebas.fila(p_k text) returns text language sql stable
as $$ select concat_ws(' ', status, coalesce(filter_verdict, '-'), coalesce(filter_provider, '-')) from public.comments where id = pruebas.id(p_k) $$;
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
-- Forzar una fila como estaría después (en réplica, sin el guardián).
create function pruebas.fuerza(p_k text, p_set text) returns void
language plpgsql as $$
begin
  perform pruebas.limpiar();
  set local session_replication_role = replica;
  execute format('update public.comments set %s where id = %L', p_set, pruebas.id(p_k));
  set local session_replication_role = origin;
end
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
insert into pruebas.ids values ('t3', private.system_add_teacher('Maestra Filtro', 'maestra-filtro', null));
update public.teachers set profile_id = pruebas.p(3), status = 'active' where id = pruebas.id('t3');
select private.system_load_course(pruebas.id('t3'), pruebas.curso('filtro-uno', array['Lección a']));
select pruebas.limpiar();
select pruebas.como_dueno_sistema();
insert into public.legal_documents (doc_type, version, title, body, effective_from)
select 'teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now()
where private.current_legal_document('teacher_privacy_notice') is null;
select pruebas.limpiar();
select set_config('app.actor_id', pruebas.p(3)::text, true);
insert into public.consents (profile_id, legal_document_id, origin)
values (pruebas.p(3), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
select pruebas.limpiar();
select pruebas.dar_capacidad(pruebas.p(4), 'content');
select pruebas.equipar(pruebas.p(4));
select is(pruebas.pide(pruebas.p(4), format('private.approve_course(%L)', course_id)), 'approved', 'se aprueba el curso')
from public.published_courses where slug = 'filtro-uno';
insert into pruebas.ids select 'L' || substr(l.title, 9, 1), l.id from public.published_lessons l
where l.course_id = (select course_id from public.published_courses where slug = 'filtro-uno');
insert into private.app_sessions (session_id, profile_id) select pruebas.sesion(pruebas.p(n)), pruebas.p(n) from generate_series(1, 4) n
on conflict (session_id) do nothing;
select pruebas.marca('comments_accept', true), pruebas.marca('comments_test_filter', true), pruebas.interruptor('true');
select is(pruebas.r(pruebas.p(1), $$private.comment_set_pseudonym('Ana')$$), 'ok', 'Ana elige su seudónimo');
select is(pruebas.r(pruebas.p(2), $$private.comment_set_pseudonym('Beto')$$), 'ok', 'y Beto el suyo');
-- La lista de la base: un término de una palabra y uno de dos. Nadie de la aplicación la lee.
insert into private.comment_filter_terms (term) values ('zorbak'), ('mal sitio');

-- ---------------------------------------------------------------------------------------
-- La normalización y la lista.

select is(private.comment_normalize('Hola, Mundo!'), 'hola mundo', 'minúsculas, y lo que no es letra separa');
select is(private.comment_normalize('Ñandú ácido'), 'nandu acido', 'sin acentos');
select is(private.comment_normalize('z.o.r.b.a.k'), 'zorbak', 'las letras sueltas con separadores se juntan');
select is(private.comment_normalize('z o r b a k'), 'zorbak', 'también con espacios');
select is(private.comment_normalize('z0rb4k'), 'zorbak', 'las cifras que se parecen a letras');
select is(private.comment_normalize('zоrbаk'), 'zorbak', 'y las letras cirílicas que se parecen a las latinas');
select is(private.comment_normalize(E'zor\u200dbak'), 'zorbak', 'sin las uniones de ancho cero');
select is(private.comment_normalize(E'\uff5a\uff4f\uff52\uff42\uff41\uff4b'), 'zorbak', 'las letras de ancho completo son las de siempre');
select is(private.comment_normalize(E'\U0001d433\U0001d428\U0001d42b\U0001d41b\U0001d41a\U0001d424'), 'zorbak', 'y las matemáticas');
select is(private.comment_normalize(E'zor\u20d2bak'), 'zorbak', 'sin las marcas combinantes de otros rangos');
select is(private.comment_terms_hit('Esto es Z0RB4K!'), true, 'la lista ve el término así escrito');
select is(private.comment_terms_hit('zorbaku y zorbakes'), false, 'solo la palabra entera');
select is(private.comment_terms_hit('un   mal,  sitio'), true, 'y el de dos palabras');
select is(private.comment_terms_hit('Un comentario normal'), false, 'lo demás no');
select throws_ok($$insert into private.comment_filter_terms (term) values ('Zorbak')$$, '23514', null, 'un término se guarda ya normalizado');
select throws_ok($$insert into private.comment_filter_terms (term) values ('z')$$, '23514', null, 'y de al menos dos letras');
select throws_ok($$insert into private.comment_filter_terms (term) values ('a b')$$, '23514', null, 'y como lo deja la normalización');

-- ---------------------------------------------------------------------------------------
-- Publicar deja el comentario en el filtro; la lista lo detiene ahí mismo.

select is((select array_agg(k order by k) from jsonb_object_keys(pruebas.publica(pruebas.p(1), 'Hola a todos', 'c1')) k),
  array['answer', 'id', 'revision', 'state'], 'publicar contesta esas claves');
select is(pruebas.fila('c1'), 'in_filter - -', 'y deja el comentario en el filtro, sin veredicto');
select is(pruebas.publica(pruebas.p(1), 'Esto es zorbak', 'c2') ->> 'state', 'in_review', 'lo que marca la lista queda en revisión');
select is(pruebas.fila('c2'), 'in_review flagged terms', 'con el veredicto de la lista');

-- ---------------------------------------------------------------------------------------
-- Asentar, con la revisión y el proveedor.

select is(pruebas.asienta(pruebas.p(2), 'c1', 1, 'pass', 'test') ->> 'answer', 'not_found', 'nadie asienta lo de otro');
select is(pruebas.asienta(pruebas.p(1), 'c1', 7, 'pass', 'test') ->> 'answer', 'stale', 'ni con otra revisión');
select is(pruebas.fila('c1'), 'in_filter - -', 'que no cambia nada');
select is(pruebas.asienta(pruebas.p(1), 'c1', 1, 'pass', 'terms') ->> 'answer', 'invalid', 'el servidor no dice que fue la lista');
select is(pruebas.asienta(pruebas.p(1), 'c1', 1, 'pass', 'sweep') ->> 'answer', 'invalid', 'ni el barrido');
select is(pruebas.asienta(pruebas.p(1), 'c1', 1, 'maybe', 'test') ->> 'answer', 'invalid', 'ni un veredicto que no existe');
select is(pruebas.asienta(pruebas.p(1), 'c1', 1, 'pass', 'none') ->> 'answer', 'invalid', 'sin proveedor no hay aprobado');
select is(pruebas.asienta(pruebas.p(1), 'c1', 1, 'pass', 'modelo') ->> 'answer', 'invalid', 'ni de un proveedor que no se conoce');
select is(pruebas.c(pruebas.p(1), format('private.comment_settle(%L, null, %L, %L)', pruebas.id('c1'), 'pass', 'test')) ->> 'answer', 'invalid',
  'ni sin revisión');
select is(pruebas.asienta(pruebas.p(1), 'c1', 1, 'pass', 'test'), '{"answer": "ok", "state": "published"}'::jsonb, 'con el aprobado de prueba, se publica');
select is(pruebas.fila('c1'), 'published pass test', 'con su veredicto y su proveedor');
select is(pruebas.asienta(pruebas.p(1), 'c1', 1, 'pass', 'test'), '{"answer": "stale", "state": "published"}'::jsonb, 'asentar otra vez no cambia nada');
select pruebas.publica(pruebas.p(1), 'Una duda', 'c3');
select is(pruebas.asienta(pruebas.p(1), 'c3', 1, 'risk', 'test'), '{"answer": "ok", "state": "in_review"}'::jsonb, 'una señal de riesgo queda en revisión');
select pruebas.publica(pruebas.p(1), 'Otra duda', 'c4');
select is(pruebas.asienta(pruebas.p(1), 'c4', 1, 'unavailable', 'none') ->> 'state', 'in_review', 'sin proveedor, en revisión');
select is(pruebas.fila('c4'), 'in_review unavailable none', 'con lo que pasó');
-- El aprobado del proveedor de prueba solo vale con su marca local: en producción nadie la pone.
select pruebas.marca('comments_test_filter', false);
select pruebas.publica(pruebas.p(1), 'Sin la marca', 'c5');
select throws_ok(format('select pruebas.asienta(%L, %L, 1, %L, %L)', pruebas.p(1), 'c5', 'pass', 'test'), '23514', null,
  'sin la marca, el aprobado de prueba no publica');
select pruebas.marca('comments_test_filter', true);
select is(pruebas.fila('c5'), 'in_filter - -', 'y el comentario sigue en el filtro');
-- El guardián tampoco deja publicar con lo que no es un proveedor.
select pruebas.limpiar();
select throws_ok(format($$update public.comments set status = 'published', filter_verdict = 'pass', filter_provider = 'terms', filter_checked_at = now() where id = %L$$, pruebas.id('c5')),
  '23514', null, 'ni el dueño publica con el veredicto de la lista');
select throws_ok(format($$update public.comments set status = 'published', filter_verdict = null where id = %L$$, pruebas.id('c5')),
  '23514', null, 'ni sin veredicto');
select throws_ok(format($$update public.comments set status = 'published', filter_verdict = 'pass', filter_provider = 'modelo', filter_checked_at = now() where id = %L$$, pruebas.id('c5')),
  '23514', null, 'ni con un proveedor que no está en su lista');

-- ---------------------------------------------------------------------------------------
-- Editar vuelve al filtro; un veredicto viejo no publica el texto nuevo.

-- Un comentario de hace una hora: editarlo pone la hora en que el texto nuevo entró al filtro.
select pruebas.fuerza('c1', $$filter_entered_at = now() - interval '1 hour'$$);
select is(pruebas.c(pruebas.p(1), format('private.comment_edit(%L, %L, %s)', pruebas.id('c1'), 'Hola a todos, otra vez', pruebas.rev('c1')))
  - 'id', '{"answer": "ok", "revision": 2, "state": "in_filter"}'::jsonb, 'editar deja el texto nuevo en el filtro');
select is(pruebas.fila('c1'), 'in_filter - -', 'sin el veredicto del texto de antes');
select is((select filter_entered_at = now() from public.comments where id = pruebas.id('c1')), true, 'y con la hora en que volvió a entrar');
select is(pruebas.asienta(pruebas.p(1), 'c1', 1, 'pass', 'test') ->> 'answer', 'stale', 'el veredicto del texto de antes llega tarde y no publica');
select is(pruebas.fila('c1'), 'in_filter - -', 'el texto nuevo sigue esperando el suyo');
select is(pruebas.c(pruebas.p(1), format('private.comment_edit(%L, %L, %s)', pruebas.id('c3'), 'Mal sitio para preguntar', pruebas.rev('c3'))) ->> 'state',
  'in_review', 'editar con un término de la lista lo deja en revisión');
select is((select (body, filter_verdict) from private.comment_evidence where comment_id = pruebas.id('c3')), ('Una duda'::text, 'risk'::text),
  'y el texto que estaba en revisión se queda para moderación, con su veredicto');

-- ---------------------------------------------------------------------------------------
-- El barrido: lo que se quedó en el filtro (el servidor cayó entre las dos transacciones) pasa a revisión.

select pruebas.fuerza('c5', $$filter_entered_at = now() - interval '3 minutes'$$);
-- Lo de hace un minuto todavía espera su veredicto.
select pruebas.fuerza('c1', $$filter_entered_at = now() - interval '1 minute'$$);
select pruebas.limpiar();
select is(private.comment_filter_sweep() >= 1, true, 'el barrido toma lo que lleva más de dos minutos en el filtro');
select is(pruebas.fila('c5'), 'in_review unavailable sweep', 'y lo deja en revisión: nunca se publica sin filtro');
select is(pruebas.fila('c1'), 'in_filter - -', 'lo recién editado no lo toca, aunque el comentario sea viejo');
select is((select count(*)::int from cron.job where jobname = 'comment_filter_sweep' and schedule = '* * * * *'), 1, 'corre cada minuto');

-- ---------------------------------------------------------------------------------------
-- Lo oculto no se edita ni se borra hasta que moderación decida (decisiones de Sergio del 2026-11-09).

select pruebas.publica(pruebas.p(1), 'Lo que van a ocultar', 'c6');
select pruebas.asienta(pruebas.p(1), 'c6', 1, 'pass', 'test');
select pruebas.fuerza('c6', $$status = 'hidden', hidden_at = now(), report_count = 3$$);
select is(pruebas.r(pruebas.p(1), format('private.comment_edit(%L, %L, %s)', pruebas.id('c6'), 'Lo cambio', pruebas.rev('c6'))), 'hidden', 'lo oculto no se edita');
select is(pruebas.r(pruebas.p(1), format('private.comment_delete(%L, %s)', pruebas.id('c6'), pruebas.rev('c6'))), 'hidden', 'ni se borra');
select is((select (status::text, body) from public.comments where id = pruebas.id('c6')), ('hidden'::text, 'Lo que van a ocultar'::text), 'y se queda como estaba');

-- ---------------------------------------------------------------------------------------
-- Borrar lo que está en revisión, o lo que tiene reportes, deja una copia para moderación.

select is(pruebas.r(pruebas.p(1), format('private.comment_delete(%L, %s)', pruebas.id('c2'), pruebas.rev('c2'))), 'ok', 'Ana borra lo suyo en revisión');
select is((select (status::text, body, author_id) from public.comments where id = pruebas.id('c2')), ('deleted'::text, null::text, null::uuid), 'para todos se va');
select is((select (body, author_id, status::text, filter_verdict) from private.comment_evidence where comment_id = pruebas.id('c2')),
  ('Esto es zorbak'::text, pruebas.p(1), 'in_review'::text, 'flagged'::text), 'pero queda la copia con su texto y su autor');
select pruebas.publica(pruebas.p(1), 'Publicado y reportado', 'c7');
select pruebas.asienta(pruebas.p(1), 'c7', 1, 'pass', 'test');
select pruebas.fuerza('c7', 'report_count = 1');
select pruebas.publica(pruebas.p(1), 'Publicado y en paz', 'c8');
select pruebas.asienta(pruebas.p(1), 'c8', 1, 'pass', 'test');
select is((select array_agg(pruebas.r(pruebas.p(1), format('private.comment_delete(%L, %s)', pruebas.id(k), pruebas.rev(k))) order by k)
  from unnest(array['c7', 'c8']) k), array['ok', 'ok'], 'Ana borra lo reportado y lo que no');
select is((select array_agg(c.k order by c.k) from pruebas.ids c join private.comment_evidence e on e.comment_id = c.v), array['c2', 'c3', 'c7'],
  'lo reportado deja copia; lo publicado sin reportes, no');
select pruebas.como_servicio(pruebas.p(1));
select throws_ok('select count(*) from private.comment_evidence', '42501', null, 'el servidor no lee la copia');
select throws_ok('select count(*) from private.comment_filter_terms', '42501', null, 'ni la lista');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- El seudónimo: por la lista, y con su freno de cinco al día.

select is(pruebas.r(pruebas.p(4), $$private.comment_set_pseudonym('Z0rbak')$$), 'flagged', 'un seudónimo que marca la lista se rechaza');
select is((select count(*)::int from public.profile_privacy where profile_id = pruebas.p(4)), 0, 'y no se guarda');
select is((select array_agg(pruebas.r(pruebas.p(4), format('private.comment_set_pseudonym(%L)', 'Cata ' || n)) order by n) from generate_series(1, 5) n),
  array['ok', 'ok', 'ok', 'ok', 'throttled'], 'cinco intentos al día, contando el que la lista marcó, y el siguiente espera');
select is((select pseudonym from public.profile_privacy where profile_id = pruebas.p(4)), 'Cata 4', 'se queda el último que se guardó');
select is(pruebas.r(pruebas.p(4), $$private.comment_set_pseudonym('Zorbak')$$), 'throttled',
  'con el freno agotado, la lista ya no contesta: no se averigua probando');

-- ---------------------------------------------------------------------------------------
-- El vigilante, y quién ejecuta asentar.

select is(pruebas.vigila(), '{}', 'el área comments no dice nada con lo nuevo');
grant select on private.comment_evidence to app_service;
select is(pruebas.vigila(), array['comments table reachable by app_service private.comment_evidence'], 'el vigilante ve un permiso de más sobre la copia');
revoke select on private.comment_evidence from app_service;
select pruebas.como_usuario(pruebas.p(1));
select throws_ok(format('select private.comment_settle(%L, 1, %L, %L)', gen_random_uuid(), 'pass', 'test'), '42501', null, 'la persona no asienta');
select pruebas.limpiar();
select is((select count(*)::int from private.local_flags where flag = 'comments_unfiltered'), 0, 'la marca de publicar sin filtro ya no existe');

select * from finish();
rollback;
