-- T-502, segunda solicitud · Reportar y ocultar al llegar a `REPORTES_PARA_OCULTAR` (RF-803; FL-16). Plan aprobado por Sergio el
-- 2026-11-09, con sus decisiones de ese día: para ocultar cuentan solo los reportes de quienes pueden escribir ahí (eso lo decide el
-- servidor con la regla de acceso y lo manda en `cuenta`); el valor es 3; lo oculto no se borra ni se edita; la maestra ve lo oculto
-- como los demás. Aquí: la lección de un comentario que se puede reportar, la puerta del reporte (lo que no se ve, lo propio, lo que
-- no está publicado y lo que no existe contestan igual; uno por persona; la nota; el freno; el cerrojo), ocultar al tercero que
-- cuenta, lo oculto para los demás y para su autor, sus respuestas, el número de la pestaña, PA-45, «Mis comentarios», el guardián y
-- el vigilante.
begin;
\ir _ayuda.psql
select plan(64);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a9800000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
-- 1 Ana, la autora; 2 Beto, 3 Cata, 4 Dani y 5 Eva, que reportan; 6 la maestra del curso; 7 Fer, con la cuenta suspendida.
select pruebas.alta(pruebas.p(n), 'reportes-' || n || '@prueba.test') from generate_series(1, 7) n;
select pruebas.confirmar(pruebas.p(n)) from generate_series(1, 7) n;

create table pruebas.ids (k text primary key, v uuid not null);
create function pruebas.id(p_k text) returns uuid language sql stable as $$ select v from pruebas.ids where k = p_k $$;
grant select, insert on pruebas.ids to app_service;
grant select on pruebas.ids to authenticated;

-- Lo que contesta una función como el servidor a nombre de alguien; lo que queda en el filtro, asentado con el proveedor de prueba.
create function pruebas.c(p_actor uuid, p_call text, p_k text default null) returns jsonb
language plpgsql as $$
declare
  v jsonb;
  v_settled jsonb;
begin
  perform pruebas.a_nombre_de(p_actor);
  execute 'select ' || p_call into v;
  if v ->> 'state' = 'in_filter' then
    v_settled := private.comment_settle((v ->> 'id')::uuid, (v ->> 'revision')::bigint, 'pass', 'test');
    if v_settled ->> 'answer' not in ('ok', 'stale') then
      raise exception 'asentar contestó %', v_settled;
    end if;
    v := v || jsonb_build_object('state', v_settled ->> 'state');
  end if;
  perform pruebas.limpiar();
  if p_k is not null and v ->> 'id' is not null then
    insert into pruebas.ids values (p_k, (v ->> 'id')::uuid);
  end if;
  return v;
end
$$;
create function pruebas.r(p_actor uuid, p_call text, p_k text default null) returns text
language sql as $$ select pruebas.c(p_actor, p_call, p_k) ->> 'answer' $$;
create function pruebas.publica(p_actor uuid, p_body text, p_k text, p_parent text default null) returns text
language sql as $$
  select pruebas.r(p_actor, format('private.comment_post(%L, %L, %L)', pruebas.id('La'), pruebas.id(p_parent), p_body), p_k)
$$;
-- Reportar como el servidor, con lo que decidió la regla (`cuenta`).
create function pruebas.reporta(p_actor uuid, p_k text, p_reason text default 'spam', p_note text default null, p_counts boolean default true)
returns jsonb language sql as $$
  select pruebas.c(p_actor, format('private.comment_report(%L, %L, %L, %L)', pruebas.id(p_k), p_reason, p_note, p_counts))
$$;
create function pruebas.estado(p_k text) returns text language sql stable
as $$ select concat_ws(' ', status, report_count, (hidden_at is not null)::text) from public.comments where id = pruebas.id(p_k) $$;
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
create function pruebas.parametro(p_key text, p_value jsonb) returns void
language plpgsql as $$
begin
  perform pruebas.limpiar();
  alter table public.business_parameters disable trigger user;
  update public.business_parameters set value = p_value where key = p_key and canceled_at is null;
  alter table public.business_parameters enable trigger user;
end
$$;
-- Lo que ve alguien de un comentario en la lección.
create function pruebas.vista(p_actor uuid, p_k text) returns jsonb
language sql as $$
  select i from jsonb_array_elements(pruebas.c(p_actor, format('private.comments_for_lesson(%L, null, null)', pruebas.id('La'))) -> 'items') i
  where i ->> 'id' = pruebas.id(p_k)::text
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
insert into pruebas.ids values ('t6', private.system_add_teacher('Maestra Reporte', 'maestra-reporte', null));
update public.teachers set profile_id = pruebas.p(6), status = 'active' where id = pruebas.id('t6');
select private.system_load_course(pruebas.id('t6'), pruebas.curso('reportes-uno', array['Lección a']));
select pruebas.limpiar();
select pruebas.como_dueno_sistema();
insert into public.legal_documents (doc_type, version, title, body, effective_from)
select 'teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now()
where private.current_legal_document('teacher_privacy_notice') is null;
select pruebas.limpiar();
select set_config('app.actor_id', pruebas.p(6)::text, true);
insert into public.consents (profile_id, legal_document_id, origin)
values (pruebas.p(6), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
select pruebas.limpiar();
select pruebas.dar_capacidad(pruebas.p(7), 'content');
select pruebas.equipar(pruebas.p(7));
select is(pruebas.pide(pruebas.p(7), format('private.approve_course(%L)', course_id)), 'approved', 'se aprueba el curso')
from public.published_courses where slug = 'reportes-uno';
-- Fer, ya aprobado el curso, queda con la cuenta suspendida.
set local session_replication_role = replica;
update public.profiles set status = 'suspended', suspended_at = now(), suspension_reason = 'Prueba de la 98' where id = pruebas.p(7);
set local session_replication_role = origin;
insert into pruebas.ids select 'La', l.id from public.published_lessons l
where l.course_id = (select course_id from public.published_courses where slug = 'reportes-uno');
insert into private.app_sessions (session_id, profile_id) select pruebas.sesion(pruebas.p(n)), pruebas.p(n) from generate_series(1, 7) n
on conflict (session_id) do nothing;
select pruebas.marca('comments_accept', true), pruebas.marca('comments_test_filter', true), pruebas.parametro('COMENTARIOS_ABIERTOS', 'true'),
  pruebas.parametro('REPORTES_PARA_OCULTAR', '3');
select count(*) as hecho from (select pruebas.r(pruebas.p(n), format('private.comment_set_pseudonym(%L)', 'Persona ' || n)) from generate_series(1, 5) n) as llamada;
select is(pruebas.publica(pruebas.p(1), 'Un comentario de Ana', 'c1'), 'ok', 'Ana publica');
select is(pruebas.publica(pruebas.p(2), 'Beto le responde', 'r1', 'c1'), 'ok', 'y Beto le responde');
select is(pruebas.publica(pruebas.p(1), 'Otro de Ana [revisar]', 'c2'), 'ok', 'Ana publica otro');
select pruebas.limpiar();
-- El segundo, en revisión (como lo dejaría el filtro): reportarlo no es posible.
select is(pruebas.c(pruebas.p(1), format('private.comment_edit(%L, %L, %s)', pruebas.id('c2'), 'Otro de Ana, en revisión', 1)) ->> 'answer', 'ok', 'Ana lo edita');
set local session_replication_role = replica;
update public.comments set status = 'in_review', filter_verdict = 'flagged', filter_provider = 'test' where id = pruebas.id('c2');
set local session_replication_role = origin;

-- ---------------------------------------------------------------------------------------
-- La lección de un comentario que se puede reportar.

select pruebas.como_servicio(pruebas.p(2));
select is(private.comment_report_lesson(pruebas.id('c1')), pruebas.id('La'), 'de lo publicado, la lección');
select is(private.comment_report_lesson(pruebas.id('c2')), null, 'de lo que está en revisión, nada');
select is(private.comment_report_lesson(gen_random_uuid()), null, 'ni de lo que no existe');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- La puerta.

select is(pruebas.reporta(pruebas.p(2), 'c1'), '{"answer": "ok"}'::jsonb, 'Beto reporta el comentario de Ana');
select is((select (reporter_id, reason::text, note, reported_body, counts) from public.comment_reports where comment_id = pruebas.id('c1')),
  (pruebas.p(2), 'spam'::text, null::text, 'Un comentario de Ana'::text, true), 'el reporte guarda quién, el motivo, el texto que se reportó y si cuenta');
select is(pruebas.reporta(pruebas.p(2), 'c1', 'abusive') ->> 'answer', 'already', 'uno por persona');
select is(pruebas.reporta(pruebas.p(1), 'c1') ->> 'answer', 'not_found', 'lo propio no se reporta');
select is(pruebas.c(pruebas.p(2), format('private.comment_report(%L, %L, null, true)', gen_random_uuid(), 'spam')) ->> 'answer', 'not_found',
  'lo que no existe contesta igual');
select is(pruebas.reporta(pruebas.p(2), 'c2') ->> 'answer', 'not_found', 'ni lo que está en revisión');
select is(pruebas.reporta(pruebas.p(3), 'c1', 'otro') ->> 'answer', 'invalid', 'un motivo que no existe no');
select is(pruebas.reporta(pruebas.p(3), 'c1', 'other', repeat('x', 1001)) ->> 'answer', 'invalid', 'ni una nota de más de 1 000');
select is(pruebas.reporta(pruebas.p(3), 'c1', 'other', E'a‮b') ->> 'answer', 'invalid', 'ni una nota con caracteres que no se guardan');
select is(pruebas.reporta(pruebas.p(7), 'c1') ->> 'answer', 'suspended_account', 'una cuenta suspendida no reporta');
select is((select count(*)::int from public.comment_reports), 1, 'nada de eso escribió');

-- Lo que no cuenta se guarda y no suma.
select is(pruebas.reporta(pruebas.p(5), 'c1', 'concern_for_person', 'Me preocupa', false), '{"answer": "ok"}'::jsonb, 'Eva reporta, y su reporte no cuenta');
select is(pruebas.estado('c1'), 'published 1 false', 'el comentario suma solo lo que cuenta');
select is(pruebas.reporta(pruebas.p(3), 'c1', 'abusive', 'Un insulto'), '{"answer": "ok"}'::jsonb, 'Cata reporta');
select is(pruebas.estado('c1'), 'published 2 false', 'dos que cuentan: sigue publicado');
select is(pruebas.reporta(pruebas.p(4), 'c1', 'abusive'), '{"answer": "ok"}'::jsonb, 'Dani reporta, y la respuesta es la misma aunque lo oculte');
select is(pruebas.estado('c1'), 'hidden 3 true', 'al tercero que cuenta, queda oculto');
select is(pruebas.reporta(pruebas.p(6), 'c1') ->> 'answer', 'not_found', 'lo oculto ya no se reporta, y se contesta como a lo que no existe');

-- ---------------------------------------------------------------------------------------
-- Lo oculto: para los demás, sin nada; para su autora, con su texto; y sus respuestas se van con él.

select is((select array_agg(k order by k) from jsonb_object_keys(pruebas.vista(pruebas.p(2), 'c1')) k),
  array['body', 'created_at', 'edited', 'id', 'name', 'own', 'replies', 'revision', 'state', 'teacher'], 'lo oculto sale con las mismas claves');
select is(pruebas.vista(pruebas.p(2), 'c1') - 'created_at' - 'id' - 'replies',
  '{"body": null, "name": null, "own": false, "state": "hidden", "teacher": false, "edited": false, "revision": null}'::jsonb,
  'para los demás, oculto: sin texto, sin nombre y sin decir si era del maestro');
select is(pruebas.vista(pruebas.p(6), 'c1') ->> 'body', null, 'también para la maestra');
select is((pruebas.vista(pruebas.p(1), 'c1') ->> 'state', pruebas.vista(pruebas.p(1), 'c1') ->> 'body', pruebas.vista(pruebas.p(1), 'c1') ->> 'own'),
  ('hidden'::text, 'Un comentario de Ana'::text, 'true'::text), 'su autora lo ve con su texto, oculto');
select is(jsonb_array_length(pruebas.vista(pruebas.p(3), 'c1') -> 'replies' -> 'items'), 0, 'sus respuestas se van con él');
select is(jsonb_array_length(pruebas.vista(pruebas.p(2), 'c1') -> 'replies' -> 'items'), 0, 'también para quien respondió');
select is(jsonb_array_length(pruebas.c(pruebas.p(3), format('private.comment_replies(%L, %L, null, null)', pruebas.id('La'), pruebas.id('c1'))) -> 'items'), 0,
  'y no se piden aparte');
select is((pruebas.c(pruebas.p(3), format('private.comments_for_lesson(%L, null, null)', pruebas.id('La'))) ->> 'count')::int, 0,
  'el número de la pestaña no cuenta lo oculto ni sus respuestas');
select is(pruebas.r(pruebas.p(2), format('private.comment_post(%L, %L, %L)', pruebas.id('La'), pruebas.id('c1'), 'Otra respuesta')), 'bad_parent',
  'a lo oculto no se responde');
select pruebas.limpiar();
select is((select count(*)::int from jsonb_array_elements(pruebas.c(pruebas.p(6), 'private.comments_for_teacher(null, false, null, null)') -> 'items') i
  where i ->> 'id' = pruebas.id('c1')::text), 0, 'en PA-45 lo oculto no aparece');
select is((select count(*)::int from jsonb_array_elements(pruebas.c(pruebas.p(1), 'private.comments_of_author(null, null)') -> 'items') i
  where i ->> 'id' = pruebas.id('c1')::text), 0, 'ni en «Mis comentarios» de su autora');

-- ---------------------------------------------------------------------------------------
-- Una respuesta bajo un comentario borrado sigue a la vista, y se reporta; con el veto, el reporte se guarda y no cuenta.

select is(pruebas.publica(pruebas.p(4), 'Uno de Dani que se borra', 'c6'), 'ok', 'Dani publica');
select is(pruebas.publica(pruebas.p(5), 'Eva le responde', 'r6', 'c6'), 'ok', 'Eva le responde');
select is(pruebas.r(pruebas.p(4), format('private.comment_delete(%L, %s)', pruebas.id('c6'), 1)), 'ok', 'Dani borra lo suyo');
select pruebas.limpiar();
set local session_replication_role = replica;
update public.profiles set comment_ban_until = now() + interval '1 day' where id = pruebas.p(3);
set local session_replication_role = origin;
select is(pruebas.reporta(pruebas.p(3), 'r6'), '{"answer": "ok"}'::jsonb, 'Cata, con el veto, reporta la respuesta bajo lo borrado');
select is(pruebas.estado('r6'), 'published 0 false', 'y su reporte no cuenta');
select is((select counts from public.comment_reports where comment_id = pruebas.id('r6') and reporter_id = pruebas.p(3)), false, 'se guarda como que no cuenta');
set local session_replication_role = replica;
update public.profiles set comment_ban_until = null where id = pruebas.p(3);
set local session_replication_role = origin;

-- ---------------------------------------------------------------------------------------
-- Sin valor en el parámetro, se reporta y no se oculta.

-- Sin valor: el parámetro en `null` de JSON (la columna no admite el nulo de SQL).
select pruebas.parametro('REPORTES_PARA_OCULTAR', 'null');
select is(pruebas.publica(pruebas.p(3), 'Un comentario de Cata', 'c3'), 'ok', 'Cata publica');
select count(*) as hecho from (select pruebas.reporta(pruebas.p(n), 'c3') from generate_series(1, 5) n where n <> 3) as llamada;
select is(pruebas.estado('c3'), 'published 4 false', 'sin valor, cuatro reportes no lo ocultan');
select pruebas.parametro('REPORTES_PARA_OCULTAR', '3');

-- Editar lo reportado: el reporte se queda con el texto que se reportó.
select is(pruebas.c(pruebas.p(3), format('private.comment_edit(%L, %L, %s)', pruebas.id('c3'), 'Lo corrijo', 1)) ->> 'answer', 'ok', 'Cata lo corrige');
select is((select array_agg(distinct reported_body) from public.comment_reports where comment_id = pruebas.id('c3')), array['Un comentario de Cata'],
  'y cada reporte conserva el texto que se reportó');

-- ---------------------------------------------------------------------------------------
-- El freno y el cerrojo.

select is(pruebas.publica(pruebas.p(4), 'Uno de Dani', 'c4'), 'ok', 'Dani publica');
select is(pruebas.publica(pruebas.p(4), 'Otro de Dani', 'c5'), 'ok', 'Dani publica otro');
-- Eva ya reportó en esta hora: se completa a nueve, hace 50 minutos.
insert into private.rate_limit_counters (bucket, window_start, hits)
select 'comment_report:' || pruebas.p(5), date_trunc('minute', now()) - interval '50 minutes',
  9 - (select coalesce(sum(hits), 0)::int from private.rate_limit_counters where bucket = 'comment_report:' || pruebas.p(5));
select is(pruebas.reporta(pruebas.p(5), 'c4') ->> 'answer', 'ok', 'el décimo reporte en una hora pasa');
select is(pruebas.reporta(pruebas.p(5), 'c5') ->> 'answer', 'throttled', 'y el siguiente espera');
select pruebas.marca('comments_accept', false);
select is(pruebas.reporta(pruebas.p(2), 'c4') ->> 'answer', 'closed', 'sin el cerrojo abierto, no se reporta (hasta T-503)');
select pruebas.marca('comments_accept', true);
select pruebas.parametro('COMENTARIOS_ABIERTOS', 'false');
select is(pruebas.reporta(pruebas.p(2), 'c4') ->> 'answer', 'closed', 'ni con los comentarios cerrados');
select pruebas.parametro('COMENTARIOS_ABIERTOS', 'true');

-- ---------------------------------------------------------------------------------------
-- El guardián, la tabla y el vigilante.

select pruebas.limpiar();
select throws_ok(format($$update public.comments set status = 'hidden', report_count = 3 where id = %L$$, pruebas.id('c4')),
  '23514', null, 'ni el dueño oculta sin la hora');
select throws_ok(format($$update public.comments set status = 'hidden', hidden_at = now(), report_count = 3 where id = %L$$, pruebas.id('c2')),
  '23514', null, 'ni oculta lo que no está publicado');
select throws_ok(format($$update public.comments set status = 'hidden', hidden_at = now(), report_count = 0 where id = %L$$, pruebas.id('c4')),
  '23514', null, 'ni oculta sin reportes');
select throws_ok(format($$update public.comments set status = 'published' where id = %L$$, pruebas.id('c1')),
  '23514', null, 'lo oculto no vuelve a publicarse solo (es de moderación, T-503)');
select throws_ok(format($$update public.comments set status = 'in_review', filter_verdict = 'flagged', filter_provider = 'test' where id = %L$$, pruebas.id('c1')),
  '23514', null, 'ni pasa a revisión');
select throws_ok(format($$update public.comments set status = 'in_filter', body = 'Otro', filter_verdict = null, filter_provider = null, filter_checked_at = null where id = %L$$, pruebas.id('c1')),
  '23514', null, 'ni vuelve al filtro');
select throws_ok(format($$update public.comments set status = 'deleted', body = null, deleted_at = now(), author_id = null where id = %L$$, pruebas.id('c1')),
  '23514', null, 'ni se borra: espera a moderación');
select pruebas.como_servicio(pruebas.p(2));
select throws_ok('select count(*) from public.comment_reports', '42501', null, 'el servidor no lee los reportes');
select pruebas.limpiar();
select pruebas.como_usuario(pruebas.p(2));
select throws_ok(format('select private.comment_report(%L, %L, null, true)', pruebas.id('c4'), 'spam'), '42501', null, 'la persona no reporta directo');
select pruebas.limpiar();
select is(pruebas.vigila(), '{}', 'el área comments no dice nada con los reportes');
grant select on public.comment_reports to app_service;
select is(pruebas.vigila(), array['comments table reachable by app_service public.comment_reports'], 'el vigilante ve un permiso de más');
revoke select on public.comment_reports from app_service;

select * from finish();
rollback;
