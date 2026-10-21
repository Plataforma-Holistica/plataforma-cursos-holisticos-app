-- T-206 · Progreso al momento (RF-307; 05 §5.7 y §9.2). Decisiones de Sergio del 2026-10-20:
-- si el progreso falla, el libro se guarda igual.
--
-- `private.record_heartbeats()` funde en `lesson_progress`, en la misma transacción que el
-- libro, los tramos aceptados que sirven (visibles y dentro de `VELOCIDAD_MAX`), y mueve la
-- posición con el último aceptado, sirva o no. Al llegar a `UMBRAL_COMPLETO_PCT` de los segundos
-- distintos de la lección, la marca terminada, y ya no la desmarca. Un video nuevo reinicia los
-- tramos; lo atrasado del video anterior no toca el progreso. Lo atrasado del mismo video se
-- funde, pero no regresa la posición ni el orden. La vista previa del dueño no deja progreso.
-- Nadie de la aplicación escribe la tabla; la persona lee lo suyo.
--
-- En una prueba de base todo corre en una transacción y `now()` no avanza: el tope de una
-- reproducción se mueve moviendo hacia atrás su último latido.
begin;
\ir _ayuda.psql
select plan(112);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana-avanza@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto-avanza@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido-avanza@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-avanza@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');

create function pruebas.ana() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.beto() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.computadora() returns uuid language sql immutable as $$ select 'c2000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.telefono() returns uuid language sql immutable as $$ select 'c2000000-0000-0000-0000-000000000002'::uuid $$;

create function pruebas.como(p_id uuid, p_session uuid) returns void
language plpgsql as $$
begin
  perform pruebas.a_nombre_de(p_id, p_session);
  perform set_config('app.actor_session', coalesce(p_session::text, ''), true);
end
$$;
create function pruebas.leccion(p_title text) returns uuid
language sql as $$
  select l.id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id
  where c.slug = 'curso-avance' and l.title = p_title
$$;
-- El playback id vigente de una lección.
create function pruebas.video(p_lesson uuid) returns text
language sql as $$
  select v.provider_playback_id from public.published_lessons l join public.video_assets v on v.id = l.video_asset_id
  where l.id = p_lesson
$$;
-- Abre una reproducción de la lección con el video vigente, y le da tiempo vivo de sobra.
create function pruebas.abre(p_id uuid, p_session uuid, p_lesson uuid, p_basis text default 'subscription',
                             p_counts boolean default true, p_closing uuid default null) returns uuid
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como(p_id, p_session);
  select private.open_playback(p_lesson, pruebas.video(p_lesson), p_basis::public.access_basis, p_counts, p_closing) into v;
  perform pruebas.limpiar();
  if v ->> 'outcome' <> 'opened' then
    raise exception 'no abrió: %', v;
  end if;
  update public.playback_sessions set live_seconds = 1000, started_at = now() - interval '1 hour'
  where id = (v ->> 'session_id')::uuid;
  return (v ->> 'session_id')::uuid;
end
$$;
-- Como el servidor: con el tope que dio el blanco.
create function pruebas.registra(p_id uuid, p_session uuid, p_playback uuid, p_events jsonb) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como(p_id, p_session);
  select private.record_heartbeats(p_playback, p_events, true, (private.heartbeat_target(p_playback) ->> 'at')::timestamptz) into v;
  perform pruebas.limpiar();
  return v;
end
$$;
-- Solo lo que contestó del progreso.
create function pruebas.avanza(p_id uuid, p_session uuid, p_playback uuid, p_events jsonb) returns jsonb
language sql as $$ select nullif(pruebas.registra(p_id, p_session, p_playback, p_events) -> 'progress', 'null'::jsonb) $$;
create function pruebas.tramo(p_seq integer, p_from integer, p_to integer, p_rate numeric default 1, p_visible boolean default true) returns jsonb
language sql immutable as $$
  select jsonb_build_object('seq', p_seq, 'from', p_from, 'to', p_to, 'rate', p_rate, 'visible', p_visible)
$$;
create function pruebas.fila(p_id uuid, p_lesson uuid) returns public.lesson_progress
language sql as $$ select * from public.lesson_progress where profile_id = p_id and lesson_id = p_lesson $$;
create function pruebas.estado(p_lesson uuid, p_covered integer, p_completed boolean, p_just boolean) returns jsonb
language sql as $$
  select jsonb_build_object('outcome', 'tracked', 'lesson_id', p_lesson, 'covered_seconds', p_covered,
                            'completed', p_completed, 'just_completed', p_just)
$$;
create function pruebas.posicion(p_id uuid, p_session uuid, p_lesson uuid) returns integer
language plpgsql as $$
declare
  v integer;
begin
  perform pruebas.como(p_id, p_session);
  select private.lesson_position(p_lesson) into v;
  perform pruebas.limpiar();
  return v;
end
$$;
-- Le cambia el video a una lección, como lo haría una versión nueva del curso.
create function pruebas.cambia_video(p_lesson uuid, p_playback text) returns void
language plpgsql as $$
declare
  v_video uuid;
begin
  perform pruebas.como_dueno_sistema();
  insert into public.video_assets (course_id, teacher_id, lesson_id, provider, provider_asset_id, provider_playback_id, status, duration_seconds)
  select l.course_id, l.teacher_id, l.id, 'mux', 'Asset' || p_playback, p_playback, 'ready', l.duration_seconds
  from public.published_lessons l where l.id = p_lesson
  returning id into v_video;
  update public.published_lessons set video_asset_id = v_video where id = p_lesson;
  perform pruebas.limpiar();
end
$$;
create function pruebas.curso() returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', 'curso-avance', 'title', 'Curso avance', 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', jsonb_build_array(
      jsonb_build_object('title', 'Lección uno', 'video',
        jsonb_build_object('provider', 'mux', 'asset_id', 'AssetAvanceuno', 'playback_id', 'PlaybackAvanceuno', 'duration_seconds', 100)),
      jsonb_build_object('title', 'Lección dos', 'video',
        jsonb_build_object('provider', 'mux', 'asset_id', 'AssetAvancedos', 'playback_id', 'PlaybackAvancedos', 'duration_seconds', 200)),
      jsonb_build_object('title', 'Lección tres', 'video',
        jsonb_build_object('provider', 'mux', 'asset_id', 'AssetAvancetres', 'playback_id', 'PlaybackAvancetres', 'duration_seconds', 105))))))
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
create temporary table maestra as select private.system_add_teacher('Maestra que avanza', 'maestra-que-avanza', null) as id;
select private.system_load_course((select id from maestra), pruebas.curso());
select pruebas.limpiar();
select is(pruebas.pide('b0000000-0000-0000-0000-000000000001',
  format('private.approve_course(%L)', course_id)), 'approved', 'se aprueba el curso')
  from public.published_courses where slug = 'curso-avance';
select pruebas.como_dueno();
insert into private.app_sessions (session_id, profile_id) values
  (pruebas.computadora(), pruebas.ana()), (pruebas.telefono(), pruebas.ana()),
  (pruebas.sesion(pruebas.beto()), pruebas.beto());
select is(private.parameter_value('UMBRAL_COMPLETO_PCT'), '9000'::jsonb, 'terminada al 90 %');
select is(private.parameter_value('VELOCIDAD_MAX'), '"2"'::jsonb, 'sirve hasta 2×');
create temporary table r (name text primary key, id uuid);
grant select on r to app_service, authenticated;

-- ---------------------------------------------------------------------------------------
-- La tabla y quién la toca.

select has_table('public', 'lesson_progress', 'existe el progreso');
select col_is_pk('public', 'lesson_progress', array['profile_id', 'lesson_id'], 'uno por cuenta y lección');
select columns_are('public', 'lesson_progress', array[
  'profile_id', 'lesson_id', 'course_id', 'video_asset_id', 'last_position_seconds', 'covered', 'covered_seconds',
  'completed_at', 'first_watched_at', 'last_watched_at', 'last_playback_session_id', 'last_seq', 'updated_at'],
  'con sus columnas');
select is((select attgenerated::text from pg_attribute where attrelid = 'public.lesson_progress'::regclass and attname = 'covered_seconds'),
  's', 'los segundos cubiertos salen de los tramos: no se desfasan');
select has_index('public', 'lesson_progress', 'lesson_progress_course_idx', array['profile_id', 'course_id'], 'el avance de un curso');
select has_index('public', 'lesson_progress', 'lesson_progress_recent_idx', array['profile_id', 'last_watched_at'], 'continuar viendo');
select has_index('public', 'lesson_progress', 'lesson_progress_lesson_idx', array['lesson_id'], 'el avance de una lección');
select ok((select relrowsecurity from pg_class where oid = 'public.lesson_progress'::regclass), 'con seguridad por fila');
select ok(
  not has_table_privilege(r, 'public.lesson_progress', 'insert, update, delete, truncate, trigger')
  and not has_any_column_privilege(r, 'public.lesson_progress', 'insert, update'),
  r || ' no escribe el progreso: solo la función de los latidos')
from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r;
select ok(not has_any_column_privilege(r, 'public.lesson_progress', 'select'), r || ' no lo lee')
from unnest(array['anon', 'service_role', 'app_service']) as r;
select ok(
  has_column_privilege('authenticated', 'public.lesson_progress', 'completed_at', 'select')
  and has_column_privilege('authenticated', 'public.lesson_progress', 'last_position_seconds', 'select')
  and not has_column_privilege('authenticated', 'public.lesson_progress', 'covered', 'select')
  and not has_column_privilege('authenticated', 'public.lesson_progress', 'last_playback_session_id', 'select'),
  'la persona lee su avance, no los tramos ni de qué reproducción vino');
select ok(
  has_function_privilege('app_service', 'private.lesson_position(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.lesson_position(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.lesson_position(uuid)', 'execute'),
  'el servidor pregunta dónde se quedó');
select ok(
  not has_function_privilege(r, 'private.merge_progress(public.playback_sessions, int4multirange, integer, integer, timestamptz)', 'execute'),
  r || ' no funde progreso por su cuenta')
from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r;

-- ---------------------------------------------------------------------------------------
-- Fundir (RF-307): la unión de lo visto que sirve, la posición del último aceptado.

insert into r values ('p1', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Lección uno')));
select set_config('pruebas.uno', pruebas.leccion('Lección uno')::text, true);
select is(pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno')), null, 'sin latidos no hay fila');
select is(pruebas.posicion(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Lección uno')), null, 'ni posición');

select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p1'), jsonb_build_array(pruebas.tramo(0, 0, 30))),
  pruebas.estado(pruebas.leccion('Lección uno'), 30, false, false), 'el primer tramo crea el avance');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).covered, '{[0,30)}'::int4multirange, 'con su tramo');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).last_position_seconds, 30, 'y la posición');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).last_watched_at, now(), 'visto a la hora del tope');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).course_id,
  (select course_id from public.published_lessons where id = pruebas.leccion('Lección uno')), 'del curso de la lección');
select is(pruebas.posicion(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Lección uno')), 30, 'el servidor sabe dónde se quedó');
select is(pruebas.posicion(pruebas.ana(), pruebas.telefono(), pruebas.leccion('Lección uno')), 30, 'desde cualquier sesión de la cuenta');
select is(pruebas.posicion(pruebas.beto(), pruebas.sesion(pruebas.beto()), pruebas.leccion('Lección uno')), null, 'otra cuenta no');
select is(pruebas.posicion(pruebas.ana(), null, pruebas.leccion('Lección uno')), null, 'ni sin sesión declarada');

select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p1'), jsonb_build_array(pruebas.tramo(1, 20, 50))),
  pruebas.estado(pruebas.leccion('Lección uno'), 50, false, false), 'un tramo que se traslapa suma solo lo nuevo');
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p1'),
    jsonb_build_array(pruebas.tramo(2, 50, 70, 1, false), pruebas.tramo(3, 70, 80, 2.5))),
  pruebas.estado(pruebas.leccion('Lección uno'), 50, false, false), 'lo oculto y lo más rápido que VELOCIDAD_MAX no sirven (RF-403)');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).last_position_seconds, 80, 'pero mueven la posición: el video avanzó');
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p1'), jsonb_build_array(pruebas.tramo(0, 0, 30))),
  pruebas.estado(pruebas.leccion('Lección uno'), 50, false, false), 'un lote repetido contesta el estado vigente');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).last_position_seconds, 80, 'y no mueve la posición');
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p1'), jsonb_build_array(pruebas.tramo(4, 0, 103))),
  pruebas.estado(pruebas.leccion('Lección uno'), 50, false, false), 'un rechazado tampoco funde');
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p1'), '[]'::jsonb),
  pruebas.estado(pruebas.leccion('Lección uno'), 50, false, false), 'ni un lote vacío');

-- El umbral, en el borde: 90 de 100 segundos distintos.
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p1'), jsonb_build_array(pruebas.tramo(5, 50, 89))),
  pruebas.estado(pruebas.leccion('Lección uno'), 89, false, false), 'a un segundo del umbral no está terminada');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).completed_at, null, 'sin fecha');
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p1'), jsonb_build_array(pruebas.tramo(6, 89, 90))),
  pruebas.estado(pruebas.leccion('Lección uno'), 90, true, true), 'en el umbral queda terminada al momento');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).completed_at, now(), 'con la hora del tope');
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p1'), jsonb_build_array(pruebas.tramo(7, 90, 100))),
  pruebas.estado(pruebas.leccion('Lección uno'), 100, true, false), 'terminar otra vez no es terminar de nuevo');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).last_position_seconds, 100, 'la posición llega al final');
select is(
  (select count(*)::integer from public.lesson_progress where profile_id = pruebas.ana()), 1, 'una sola fila por lección');

-- ---------------------------------------------------------------------------------------
-- Lo atrasado: la cola del navegador manda tarde lo de una reproducción vieja.

-- Otra lección: P2 en la computadora, y después P3 en el teléfono, que cierra P2.
insert into r values ('p2', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Lección dos')));
-- El último latido de P2 fue hace tres minutos: su tope es el último latido más la ventana.
update public.playback_sessions set last_heartbeat_at = now() - interval '3 minutes' where id = (select id from r where name = 'p2');
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p2'), jsonb_build_array(pruebas.tramo(0, 0, 40))),
  pruebas.estado(pruebas.leccion('Lección dos'), 40, false, false), 'otra lección, su propio avance');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección dos'))).last_watched_at, now() - interval '90 seconds',
  'visto al tope de esa reproducción');
insert into r values ('p3', pruebas.abre(pruebas.ana(), pruebas.telefono(), pruebas.leccion('Lección dos'), 'subscription', true,
                                         (select id from r where name = 'p2')));
select is(
  pruebas.avanza(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'p3'), jsonb_build_array(pruebas.tramo(0, 60, 80))),
  pruebas.estado(pruebas.leccion('Lección dos'), 60, false, false), 'en el teléfono sigue sumando');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección dos'))).last_position_seconds, 80, 'la posición del teléfono');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección dos'))).last_playback_session_id, (select id from r where name = 'p3'),
  'de qué reproducción vino');
-- Lo atrasado de P2, cerrada, con su tope de antes: funde, y no regresa la posición ni el orden.
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p2'), jsonb_build_array(pruebas.tramo(1, 40, 50))),
  pruebas.estado(pruebas.leccion('Lección dos'), 70, false, false), 'lo atrasado se funde: la unión no depende del orden');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección dos'))).last_position_seconds, 80, 'pero no regresa la posición');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección dos'))).last_watched_at, now(), 'ni el orden de continuar viendo');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección dos'))).first_watched_at, now() - interval '90 seconds',
  'la primera vez se queda');
-- La misma reproducción, varios lotes con el mismo tope: manda el consecutivo.
select is(
  pruebas.avanza(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'p3'), jsonb_build_array(pruebas.tramo(1, 80, 90))),
  pruebas.estado(pruebas.leccion('Lección dos'), 80, false, false), 'el siguiente lote de la misma reproducción');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección dos'))).last_position_seconds, 90,
  'mueve la posición aunque el tope sea el mismo');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección dos'))).last_seq, 1, 'y anota su consecutivo');
-- Un empate de topes entre dos reproducciones no mueve: la guardada se queda.
update public.lesson_progress
set last_watched_at = (select last_heartbeat_at + interval '90 seconds' from public.playback_sessions where id = (select id from r where name = 'p2'))
where profile_id = pruebas.ana() and lesson_id = pruebas.leccion('Lección dos');
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p2'), jsonb_build_array(pruebas.tramo(2, 50, 52))),
  pruebas.estado(pruebas.leccion('Lección dos'), 82, false, false), 'con el mismo tope, de otra reproducción');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección dos'))).last_position_seconds, 90, 'no mueve la posición');
-- Si el tope de la reproducción guardada es más viejo, otra más nueva sí mueve la posición.
update public.lesson_progress set last_watched_at = now() - interval '1 day'
where profile_id = pruebas.ana() and lesson_id = pruebas.leccion('Lección dos');
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p2'), jsonb_build_array(pruebas.tramo(3, 52, 55))),
  pruebas.estado(pruebas.leccion('Lección dos'), 85, false, false), 'una reproducción con tope más nuevo');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección dos'))).last_position_seconds, 55, 'mueve la posición');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección dos'))).last_watched_at,
  (select last_heartbeat_at + interval '90 seconds' from public.playback_sessions where id = (select id from r where name = 'p2')),
  'al tope de esa reproducción');

-- ---------------------------------------------------------------------------------------
-- El video de la lección cambia (05 §5.7): los tramos del anterior ya no dicen nada.

select pruebas.cambia_video(pruebas.leccion('Lección uno'), 'PlaybackAvanceunonuevo');
select is(pruebas.posicion(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Lección uno')), null,
  'con otro video no hay dónde seguir');
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p1'), jsonb_build_array(pruebas.tramo(8, 0, 10))),
  null, 'lo atrasado del video anterior no toca el progreso');
select is(
  (select count(*)::integer from public.watch_events where playback_session_id = (select id from r where name = 'p1') and seq = 8),
  1, 'pero queda en el libro');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).covered_seconds, 100, 'el avance sigue como estaba');
insert into r values ('p4', pruebas.abre(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Lección uno'), 'subscription', true,
                                         (select id from r where name = 'p3')));
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p4'), jsonb_build_array(pruebas.tramo(0, 0, 10))),
  pruebas.estado(pruebas.leccion('Lección uno'), 10, true, false), 'con el video nuevo, los tramos empiezan de cero');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).covered, '{[0,10)}'::int4multirange, 'solo lo del video nuevo');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).last_position_seconds, 10, 'y la posición también');
select isnt((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).completed_at, null, 'terminada se queda terminada');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).video_asset_id,
  (select video_asset_id from public.published_lessons where id = pruebas.leccion('Lección uno')), 'atada al video nuevo');
select is(pruebas.posicion(pruebas.ana(), pruebas.computadora(), pruebas.leccion('Lección uno')), 10, 'y desde ahí se sigue');

-- ---------------------------------------------------------------------------------------
-- Con qué regla entró: la vista previa del dueño no deja progreso; cortesía y curso abierto sí.

insert into r values ('previa', pruebas.abre(pruebas.beto(), pruebas.sesion(pruebas.beto()), pruebas.leccion('Lección dos'), 'owner_preview', false));
select is(
  pruebas.avanza(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'previa'), jsonb_build_array(pruebas.tramo(0, 0, 30))),
  null, 'la vista previa del dueño no deja progreso');
select is(pruebas.fila(pruebas.beto(), pruebas.leccion('Lección dos')), null, 'ni fila');
insert into r values ('cortesia', pruebas.abre(pruebas.beto(), pruebas.sesion(pruebas.beto()), pruebas.leccion('Lección dos'), 'courtesy', false));
select is(
  pruebas.avanza(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'cortesia'), jsonb_build_array(pruebas.tramo(0, 0, 30))),
  pruebas.estado(pruebas.leccion('Lección dos'), 30, false, false), 'una cortesía avanza aunque no cuente para el reparto');
insert into r values ('abierto', pruebas.abre(pruebas.beto(), pruebas.sesion(pruebas.beto()), pruebas.leccion('Lección dos'), 'open_course', false));
select is(
  pruebas.avanza(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'abierto'), jsonb_build_array(pruebas.tramo(0, 30, 60))),
  pruebas.estado(pruebas.leccion('Lección dos'), 60, false, false), 'y el curso abierto también');
-- Sin acceso que cuente (terminó a media lección), lo visto avanza igual: el progreso no mira el dinero.
select is(
  (select private.record_heartbeats((select id from r where name = 'abierto'), jsonb_build_array(pruebas.tramo(1, 60, 70)), false,
     (private.heartbeat_target((select id from r where name = 'abierto')) ->> 'at')::timestamptz) -> 'progress'
   from pruebas.como(pruebas.beto(), pruebas.sesion(pruebas.beto()))),
  pruebas.estado(pruebas.leccion('Lección dos'), 70, false, false), 'sin acceso que cuente, avanza igual');
select pruebas.limpiar();

-- Una lección retirada a media sesión deja de contar para el reparto, pero lo visto avanza.
select pruebas.como_dueno_sistema();
update public.published_lessons set is_current = false, retired_at = now() where id = pruebas.leccion('Lección dos');
select pruebas.limpiar();
select is(
  pruebas.avanza(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'abierto'), jsonb_build_array(pruebas.tramo(2, 70, 80))),
  pruebas.estado(pruebas.leccion('Lección dos'), 80, false, false), 'una lección retirada con el mismo video sigue avanzando');
select pruebas.como_dueno_sistema();
update public.published_lessons set is_current = true, retired_at = null where id = pruebas.leccion('Lección dos');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Quién lee: la persona, lo suyo.

select pruebas.como_usuario(pruebas.ana());
select is((select count(*)::integer from public.lesson_progress), 2, 'Ana lee sus dos lecciones');
select is((select count(*)::integer from public.lesson_progress where profile_id <> pruebas.ana()), 0, 'y nada de Beto');
select is((select completed_at is not null from public.lesson_progress where lesson_id = pruebas.leccion('Lección uno')), true,
  'lee si la terminó');
select throws_ok('select covered from public.lesson_progress', '42501', null, 'los tramos no');
select throws_ok(format('update public.lesson_progress set completed_at = null where lesson_id = %L', pruebas.leccion('Lección uno')),
  '42501', null, 'no se desmarca sola');
select throws_ok(format($$insert into public.lesson_progress (profile_id, lesson_id, course_id, video_asset_id, first_watched_at,
  last_watched_at, last_playback_session_id, last_seq) select %L, id, course_id, video_asset_id, now(), now(), gen_random_uuid(), 0
  from public.published_lessons where id = %L$$, pruebas.ana(), pruebas.leccion('Lección uno')),
  '42501', null, 'ni se da avance');
select throws_ok('delete from public.lesson_progress', '42501', null, 'ni lo borra');
select pruebas.como_usuario(pruebas.beto());
select is((select count(*)::integer from public.lesson_progress), 1, 'Beto lee solo lo suyo');
select pruebas.como_usuario('b0000000-0000-0000-0000-000000000001', 'aal2');
select is((select count(*)::integer from public.lesson_progress), 0, 'Contenido no ve el progreso de nadie (05 A12)');
select pruebas.como_servicio(pruebas.ana());
select throws_ok('select 1 from public.lesson_progress', '42501', null, 'el servidor no lo lee directo');
select throws_ok(format('update public.lesson_progress set completed_at = now() where profile_id = %L', pruebas.ana()),
  '42501', null, 'ni lo escribe');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Si el progreso falla, el libro se guarda igual (decisión de Sergio del 2026-10-20).

alter table public.business_parameters disable trigger user;
update public.business_parameters set effective_from = effective_from + interval '100 years' where key = 'UMBRAL_COMPLETO_PCT';
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p4'), jsonb_build_array(pruebas.tramo(1, 10, 20))),
  '{"outcome": "recorded", "accepted": [1], "duplicate": [], "rejected": [], "progress": {"outcome": "failed", "code": "P0001"}}'::jsonb,
  'sin UMBRAL_COMPLETO_PCT el progreso falla, y el lote se registra');
select is(
  (select count(*)::integer from public.watch_events where playback_session_id = (select id from r where name = 'p4') and seq = 1),
  1, 'el tramo queda en el libro');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).covered, '{[0,10)}'::int4multirange, 'el progreso no se tocó');
select is((pruebas.fila(pruebas.ana(), pruebas.leccion('Lección uno'))).last_position_seconds, 10, 'ni la posición');
update public.business_parameters set effective_from = effective_from - interval '100 years' where key = 'UMBRAL_COMPLETO_PCT';
update public.business_parameters set value = '"noventa"' where key = 'UMBRAL_COMPLETO_PCT'
  and effective_from = (select max(effective_from) from public.business_parameters where key = 'UMBRAL_COMPLETO_PCT');
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p4'), jsonb_build_array(pruebas.tramo(2, 20, 30))),
  '{"outcome": "failed", "code": "P0001"}'::jsonb, 'un umbral que no es un número tampoco se adivina');
update public.business_parameters set value = '10001' where key = 'UMBRAL_COMPLETO_PCT'
  and effective_from = (select max(effective_from) from public.business_parameters where key = 'UMBRAL_COMPLETO_PCT');
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p4'), jsonb_build_array(pruebas.tramo(3, 30, 40))),
  '{"outcome": "failed", "code": "P0001"}'::jsonb, 'ni uno de más del 100 %');
update public.business_parameters set value = '9000' where key = 'UMBRAL_COMPLETO_PCT'
  and effective_from = (select max(effective_from) from public.business_parameters where key = 'UMBRAL_COMPLETO_PCT');
alter table public.business_parameters enable trigger user;
select is(
  pruebas.avanza(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'p4'), jsonb_build_array(pruebas.tramo(4, 40, 50))),
  pruebas.estado(pruebas.leccion('Lección uno'), 20, true, false), 'con el umbral de vuelta, sigue: lo de en medio se rehace desde el libro');

-- Lo que no funde contesta el estado sin fila: una lección empezada solo con lo oculto.
insert into r values ('oculta', pruebas.abre(pruebas.beto(), pruebas.sesion(pruebas.beto()), pruebas.leccion('Lección uno')));
select is(
  pruebas.avanza(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'oculta'),
    jsonb_build_array(pruebas.tramo(0, 0, 30, 1, false))),
  pruebas.estado(pruebas.leccion('Lección uno'), 0, false, false), 'solo lo oculto: sin segundos, pero con fila');
select is((pruebas.fila(pruebas.beto(), pruebas.leccion('Lección uno'))).last_position_seconds, 30, 'para seguir donde se quedó');
select is(
  pruebas.avanza(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'oculta'), jsonb_build_array(pruebas.tramo(0, 0, 30))),
  pruebas.estado(pruebas.leccion('Lección uno'), 0, false, false), 'y repetido, el mismo estado');

-- El umbral se redondea hacia arriba, y lo terminado lleva la hora en que se vio: 105 s al 90 %
-- son 94.5, y hacen falta 95. La reproducción latió por última vez hace tres minutos.
insert into r values ('tres', pruebas.abre(pruebas.beto(), pruebas.sesion(pruebas.beto()), pruebas.leccion('Lección tres')));
update public.playback_sessions set last_heartbeat_at = now() - interval '3 minutes' where id = (select id from r where name = 'tres');
select is(
  pruebas.avanza(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'tres'), jsonb_build_array(pruebas.tramo(0, 0, 200))),
  pruebas.estado(pruebas.leccion('Lección tres'), 0, false, false), 'un lote sin nada aceptado contesta el estado');
select is(pruebas.fila(pruebas.beto(), pruebas.leccion('Lección tres')), null, 'y no crea fila');
select is(
  pruebas.avanza(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'tres'), jsonb_build_array(pruebas.tramo(1, 0, 94))),
  pruebas.estado(pruebas.leccion('Lección tres'), 94, false, false), '94 de 105 no es el 90 %');
select is(
  pruebas.avanza(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'tres'), jsonb_build_array(pruebas.tramo(2, 94, 95))),
  pruebas.estado(pruebas.leccion('Lección tres'), 95, true, true), '95 sí');
select is((pruebas.fila(pruebas.beto(), pruebas.leccion('Lección tres'))).completed_at, now() - interval '90 seconds',
  'terminada a la hora en que se vio, no a la de llegada');

-- ---------------------------------------------------------------------------------------
-- El vigilante.

grant insert on public.lesson_progress to app_service;
select ok(
  exists (select 1 from private.schema_violations() where problem = 'progress writable by app_service' and object_name = 'public.lesson_progress'),
  'el vigilante dice si alguien le concede escribir el progreso al servidor');
revoke insert on public.lesson_progress from app_service;
grant update (completed_at) on public.lesson_progress to app_service;
select ok(
  exists (select 1 from private.schema_violations() where problem = 'progress writable by app_service'),
  'también una sola columna');
revoke update (completed_at) on public.lesson_progress from app_service;
grant select on public.lesson_progress to app_service;
select ok(
  exists (select 1 from private.schema_violations() where problem = 'progress readable by app_service'),
  'o leerlo entero');
revoke select on public.lesson_progress from app_service;
select is_empty('select * from private.schema_violations()', 'sin nada concedido, el vigilante no dice nada');

select * from finish();
rollback;
