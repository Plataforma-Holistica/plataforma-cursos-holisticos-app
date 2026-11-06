-- T-408, segunda solicitud · El avance de los alumnos de un curso (RF-612, RF-613, RN-15; PA-51; plan en ~/.claude/plans/t408-pa51-diseno.md,
-- aprobado por Sergio el 2026-11-05 con sus cuatro decisiones de ese día: la lista por alumno es semanal y las cifras diarias, todo guardado en la
-- consolidación; otro alias para PA-51; «a medio curso» es empezado y sin terminar; y cuenta todo el que avanzó alguna vez, sin el propio maestro ni
-- las cuentas borradas, con las suspendidas).
--
-- Cada noche `private.course_progress_step` guarda, con corte en la medianoche, las tres cifras y lo terminado por lección de cada curso, y con
-- corte en el lunes a las 00:00 la lista por alumno, una vez por semana. El maestro lo lee con `private.teacher_course_students`, que crea al leer
-- el alias de PA-51 (`private.progress_aliases`), otro que el de PA-47. La inserción de los alias es una sola para los dos (`private.alias_insert`),
-- y el tramo de números sube dentro del ciclo: con miles de alumnos de una vez ya no gasta cientos de miles de intentos.
--
-- La corrida de cada noche es un procedimiento con `commit` y no se llama aquí: que llame al paso y que una falla o una cancelación del paso no la
-- deje fallida lo prueba la integración 111. Aquí, el paso con su reloj (2045, para no depender del día en que corre), la lectura y el vigilante.
begin;
\ir _ayuda.psql
select plan(129);

select pruebas.alta('a8300000-0000-0000-0000-000000000001', 'tere-83@prueba.test');
select pruebas.alta('a8300000-0000-0000-0000-000000000002', 'beto-83@prueba.test');
select pruebas.alta('a8300000-0000-0000-0000-000000000004', 'nadie-83@prueba.test');
select pruebas.alta(('d8300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'alumno' || n || '-83@prueba.test') from generate_series(1, 7) n;
select pruebas.alta(('d8300000-0000-4000-8001-' || lpad(n::text, 12, '0'))::uuid, 'bloque' || n || '-83@prueba.test') from generate_series(1, 55) n;
select pruebas.confirmar(id) from auth.users where email like '%-83@prueba.test';

create function pruebas.tere() returns uuid language sql immutable as $$ select 'a8300000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.beto() returns uuid language sql immutable as $$ select 'a8300000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.nadie() returns uuid language sql immutable as $$ select 'a8300000-0000-0000-0000-000000000004'::uuid $$;
-- El alumno n, y el n del bloque de 55 que llena dos páginas.
create function pruebas.a(n integer) returns uuid language sql immutable as $$ select ('d8300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pruebas.b(n integer) returns uuid language sql immutable as $$ select ('d8300000-0000-4000-8001-' || lpad(n::text, 12, '0'))::uuid $$;
create function pruebas.curso(p_slug text) returns jsonb language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', (
      select jsonb_agg(jsonb_build_object('title', t, 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'Asset' || p_slug || n, 'playback_id', 'Playback' || p_slug || n, 'duration_seconds', 100)) order by n)
      from unnest(array['Uno', 'Dos', 'Tres']) with ordinality as l (t, n)))))
$$;
-- Las horas del reloj del paso: la semana del lunes 2045-03-06, en la zona del periodo (sin horario de verano).
create function pruebas.h(p text) returns timestamptz language sql immutable as $$ select (p || ' America/Mexico_City')::timestamptz $$;
create function pruebas.paso(p_now text) returns jsonb language sql as $$ select private.course_progress_step(pruebas.h(p_now)) $$;
create function pruebas.lee(p_quien uuid, p_curso uuid, p_orden text default 'progress', p_pagina integer default 1) returns jsonb language sql as $$
  select pruebas.pide(p_quien, format('private.teacher_course_students(%L, %L, %s)', p_curso, p_orden, p_pagina))::jsonb
$$;
create function pruebas.cifras(r jsonb) returns text language sql immutable as $$
  select format('%s:%s:%s', r -> 'figures' ->> 'started', r -> 'figures' ->> 'in_progress', r -> 'figures' ->> 'finished')
$$;
create function pruebas.lecciones(r jsonb) returns text[] language sql immutable as $$
  select array(select format('%s:%s', x ->> 'title', coalesce(x ->> 'finished', '-')) from jsonb_array_elements(r -> 'lessons') with ordinality as l (x, n) order by n)
$$;
create function pruebas.lista(r jsonb) returns text[] language sql immutable as $$
  select array(select format('%s/%s', x ->> 'completed', x ->> 'total') from jsonb_array_elements(r -> 'students') with ordinality as l (x, n) order by n)
$$;
create function pruebas.alias_de(r jsonb) returns text[] language sql immutable as $$
  select array(select x ->> 'alias' from jsonb_array_elements(r -> 'students') with ordinality as l (x, n) order by n)
$$;
-- Quién es cada alias de la lista, como el número del alumno (solo la prueba lo sabe).
create function pruebas.quienes(p_teacher uuid, r jsonb) returns text[] language sql stable security definer as $$
  select array(select coalesce((select 'a' || n from generate_series(1, 7) n where pruebas.a(n) = p.profile_id),
                               (select 'b' || n from generate_series(1, 55) n where pruebas.b(n) = p.profile_id), '?')
               from jsonb_array_elements(r -> 'students') with ordinality as l (x, k)
               join private.progress_aliases p on p.teacher_id = p_teacher and p.alias = x ->> 'alias'
               order by k)
$$;
create function pruebas.estado() returns private.course_progress_state language sql stable security definer as $$
  select * from private.course_progress_state
$$;
-- Lo que las dos áreas del vigilante encuentran, y si encuentran un problema que empieza así.
create function pruebas.cp_con(p_problem text) returns boolean language sql security definer as $$
  select exists (select 1 from private.schema_violations_course_progress() v where v.problem like p_problem || '%')
$$;
create function pruebas.cp() returns text[] language sql security definer as $$
  select array(select v.problem || ' @ ' || v.object_name from private.schema_violations_course_progress() v order by 1)
$$;
create function pruebas.tr_con(p_problem text) returns boolean language sql security definer as $$
  select exists (select 1 from private.schema_violations_teacher_reports() v where v.problem like p_problem || '%')
$$;
create function pruebas.tr() returns text[] language sql security definer as $$
  select array(select v.problem || ' @ ' || v.object_name from private.schema_violations_teacher_reports() v order by 1)
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- Dos maestros con cuenta. Tere con tres cursos publicados: A (el de casi todo), B (55 alumnos, dos páginas) y E (nadie lo ha visto). Beto con C
-- publicado y D, que nunca se publicó.
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
create temporary table maestros as
  select x.n, private.system_add_teacher('Maestra ' || x.s, 'maestra-' || x.s, null) as id
  from unnest(array['e83-tere', 'e83-beto']) with ordinality as x (s, n);
create function pruebas.m(n integer) returns uuid language sql stable as $$ select id from maestros where maestros.n = $1 $$;
grant execute on function pruebas.m(integer) to app_service;
select private.system_load_course(pruebas.m(x.t), pruebas.curso(x.s))
from (values (1, 'e83-a'), (1, 'e83-b'), (1, 'e83-e'), (2, 'e83-c'), (2, 'e83-d')) x (t, s);
select pruebas.como_dueno();
set local session_replication_role = replica;
update public.teachers t set profile_id = x.profile, status = 'active'
from (values (1, pruebas.tere()), (2, pruebas.beto())) x (n, profile)
where t.id = pruebas.m(x.n);
update public.course_registry r set state = x.state::public.course_state, first_published_at = x.published
from public.published_courses c,
     (values ('e83-a', 'published', now() - interval '1 year'), ('e83-b', 'published', now() - interval '1 year'),
             ('e83-e', 'published', now() - interval '1 year'), ('e83-c', 'published', now() - interval '1 year'),
             ('e83-d', 'in_review', null)) x (slug, state, published)
where c.course_id = r.course_id and c.slug = x.slug;
set local session_replication_role = origin;
create function pruebas.curso_de(p_slug text) returns uuid language sql stable as $$ select course_id from public.published_courses where slug = p_slug $$;
create function pruebas.lec(p_slug text, p_title text) returns uuid language sql stable as $$
  select l.id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug = p_slug and l.title = p_title
$$;
grant execute on function pruebas.curso_de(text), pruebas.lec(text, text) to app_service;
-- El avance de una cuenta en una lección: cuándo la empezó y, si la terminó, cuándo.
create function pruebas.avance(p_quien uuid, p_leccion uuid, p_desde text, p_hasta text default null) returns void language sql as $$
  insert into public.lesson_progress (profile_id, lesson_id, course_id, video_asset_id, last_position_seconds, first_watched_at, last_watched_at,
                                      completed_at, last_playback_session_id, last_seq)
  select p_quien, l.id, l.course_id, l.video_asset_id, 50, pruebas.h(p_desde), coalesce(pruebas.h(p_hasta), pruebas.h(p_desde)),
         pruebas.h(p_hasta), gen_random_uuid(), 1
  from public.published_lessons l where l.id = p_leccion
$$;

-- El resumen empieza vacío: la base local pudo correr una noche.
delete from private.course_progress_figures;
delete from private.course_lesson_figures;
delete from private.course_student_progress;
update private.course_progress_state set daily_cut_at = null, daily_built_at = null, weekly_cut_at = null, weekly_built_at = null,
       failed_at = null, error = null;

-- ---------------------------------------------------------------------------------------
-- Lo que la aplicación ve: nada de las tablas, y solo el servidor lee.

select ok(not has_table_privilege('app_service', t, 'select, insert, update, delete'), 'el servidor no toca ' || t)
from unnest(array['private.progress_aliases', 'private.course_progress_figures', 'private.course_lesson_figures',
                  'private.course_student_progress', 'private.course_progress_state']) t;
select ok(has_function_privilege('app_service', 'private.teacher_course_students(uuid, text, integer)', 'execute')
          and not has_function_privilege('authenticated', 'private.teacher_course_students(uuid, text, integer)', 'execute')
          and not has_function_privilege('anon', 'private.teacher_course_students(uuid, text, integer)', 'execute'),
  'el avance lo pide el servidor, y nadie más');
select ok(not has_function_privilege('app_service', 'private.course_progress_step(timestamptz)', 'execute'), 'guardar el resumen no es de la aplicación');
select ok(not has_function_privilege('app_service', 'private.alias_insert(text, uuid, uuid[])', 'execute'), 'crear alias tampoco');
select ok(not (select prosecdef from pg_proc where oid = 'private.course_progress_step(timestamptz)'::regprocedure),
  'el paso corre como quien lo llama: la corrida de cada noche');
select ok((select prosecdef and provolatile = 'v' from pg_proc where oid = 'private.teacher_course_students(uuid, text, integer)'::regprocedure),
  'la lectura es del dueño y volátil: crea alias');
select ok(pg_get_functiondef('private.ensure_student_aliases(uuid, public.period_id)'::regprocedure) like '%private.alias_insert(''student''%',
  'los alias de PA-47 pasan por la misma inserción');

-- ---------------------------------------------------------------------------------------
-- La inserción de los alias: con miles de alumnos de una vez, el tramo sube sin gastar intentos (el error de la 110). Cada candidato se cuenta
-- con un envoltorio que llama al de verdad. Los perfiles no existen: en réplica, sin claves foráneas.

alter function private.progress_alias_candidate(integer) rename to progress_alias_candidate_real;
create function private.progress_alias_candidate(p_try integer) returns text language plpgsql volatile set search_path = '' as $$
begin
  perform pg_catalog.set_config('pruebas.intentos', (coalesce(nullif(pg_catalog.current_setting('pruebas.intentos', true), ''), '0')::integer + 1)::text, true);
  return private.progress_alias_candidate_real(p_try);
end
$$;
alter function private.alias_candidate(integer) rename to alias_candidate_real;
create function private.alias_candidate(p_try integer) returns text language plpgsql volatile set search_path = '' as $$
begin
  perform pg_catalog.set_config('pruebas.intentos', (coalesce(nullif(pg_catalog.current_setting('pruebas.intentos', true), ''), '0')::integer + 1)::text, true);
  return private.alias_candidate_real(p_try);
end
$$;
create temporary table muchos as select gen_random_uuid() as id from generate_series(1, 13000);
set local session_replication_role = replica;
select set_config('pruebas.intentos', '0', true);
select private.alias_insert('student', pruebas.m(2), array(select id from muchos));
select is((select count(*)::integer from private.student_aliases where teacher_id = pruebas.m(2)), 13000, '13 000 alias de PA-47 de una vez');
select cmp_ok(current_setting('pruebas.intentos')::integer, '<', 20000, 'con menos de 20 000 intentos: el tramo sube dentro del ciclo');
-- El tramo de PA-51 cuenta solo los de PA-51: con 13 000 de PA-47, los primeros de PA-51 siguen siendo de dos cifras.
select private.alias_insert('progress', pruebas.m(2), array(select id from muchos order by id limit 10));
select ok((select bool_and(alias ~ ' [1-9][0-9]$') from private.progress_aliases where teacher_id = pruebas.m(2)), 'cada tipo cuenta su propio tramo');
select set_config('pruebas.intentos', '0', true);
select private.alias_insert('progress', pruebas.m(2), array(select id from muchos));
select is((select count(*)::integer from private.progress_aliases where teacher_id = pruebas.m(2)), 13000, 'y 13 000 de PA-51');
select cmp_ok(current_setting('pruebas.intentos')::integer, '<', 20000, 'también con menos de 20 000 intentos');
select is(private.alias_insert('progress', pruebas.m(2), array[pruebas.a(7), pruebas.a(7)]), 1, 'un perfil repetido en la lista recibe un solo alias');
select is((select count(*)::integer from private.progress_aliases p join private.student_aliases s using (teacher_id, profile_id) where p.alias = s.alias),
  0, 'ningún alumno tiene el mismo alias en las dos pantallas');
select set_config('pruebas.intentos', '0', true);
select private.alias_insert('progress', pruebas.m(2), array(select id from muchos limit 10));
select is(current_setting('pruebas.intentos'), '0', 'quien ya tiene alias no gasta intentos');
set local session_replication_role = origin;
drop function private.progress_alias_candidate(integer);
alter function private.progress_alias_candidate_real(integer) rename to progress_alias_candidate;
drop function private.alias_candidate(integer);
alter function private.alias_candidate_real(integer) rename to alias_candidate;
set local session_replication_role = replica;
delete from private.progress_aliases where teacher_id = pruebas.m(2);
delete from private.student_aliases where teacher_id = pruebas.m(2);
set local session_replication_role = origin;

-- Las palabras de PA-51 no son las de PA-47: «Ceiba 42» no puede ser dos personas en dos pantallas.
create temporary table palabras as
  select 'progress' as kind, split_part(private.progress_alias_candidate(0), ' ', 1) as w from generate_series(1, 3000)
  union all
  select 'student', split_part(private.alias_candidate(0), ' ', 1) from generate_series(1, 3000);
select is((select count(distinct w)::integer from palabras where kind = 'progress'), 40, 'PA-51 tiene 40 palabras');
select is((select count(*)::integer from (select w from palabras where kind = 'progress' intersect select w from palabras where kind = 'student') x), 0,
  'y ninguna es de las de PA-47');
select ok((select bool_and(private.progress_alias_candidate(t) ~ '^[A-Z][a-z]+ [1-9][0-9]{1,3}$') from generate_series(0, 100) t),
  'con la forma de «Garza 42», en los tres tramos');

-- Si los alias se agotan, falla entero. Las funciones que la prueba rompe se guardan antes y se restauran después.
create temporary table definiciones (k text primary key, d text);
insert into definiciones values
  ('candidato', pg_get_functiondef('private.progress_alias_candidate(integer)'::regprocedure)),
  ('noche', pg_get_functiondef('private.nightly_rollup(boolean, integer)'::regprocedure)),
  ('lectura', pg_get_functiondef('private.teacher_course_students(uuid, text, integer)'::regprocedure)),
  ('reporte', pg_get_functiondef('private.payout_report_students(uuid, public.period_id)'::regprocedure));
create function pruebas.restaurar(p_k text) returns void language plpgsql as $$
begin
  execute (select d from definiciones where k = p_k);
end
$$;
create or replace function private.progress_alias_candidate(p_try integer) returns text language sql volatile set search_path = ''
as $$ select case when pg_catalog.random() < 0.5 then 'Garza 10' else 'Garza 11' end $$;
set local session_replication_role = replica;
select throws_ok(format('select private.alias_insert(%L, %L, %L)', 'progress', pruebas.m(2), array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()]),
  'P0001', 'progress alias space exhausted', 'si los alias de PA-51 se agotan, falla');
select is((select count(*)::integer from private.progress_aliases where teacher_id = pruebas.m(2)), 0, 'y no deja la mitad');
set local session_replication_role = origin;
select pruebas.restaurar('candidato');
select throws_ok(format('select private.alias_insert(%L, %L, %L)', 'other', pruebas.m(2), array[pruebas.a(1)]), '22023', null, 'solo hay dos tipos de alias');

-- ---------------------------------------------------------------------------------------
-- Antes de la primera noche: quién no lee, y un curso propio sin resumen todavía.

create temporary table lect (k text primary key, r jsonb);
select is(pruebas.lee(pruebas.nadie(), pruebas.curso_de('e83-a')), '{"outcome": "not_teacher"}'::jsonb, 'quien no es maestro no lee nada');
select is(pruebas.lee(pruebas.tere(), pruebas.curso_de('e83-c')), '{"outcome": "not_found"}'::jsonb, 'el curso de otro maestro no existe para Tere');
select is(pruebas.lee(pruebas.tere(), gen_random_uuid()), '{"outcome": "not_found"}'::jsonb, 'uno que no existe contesta igual');
select is(pruebas.lee(pruebas.beto(), pruebas.curso_de('e83-d')), '{"outcome": "not_found"}'::jsonb, 'y uno suyo que nunca se publicó, igual');
select throws_ok(format('select pruebas.lee(%L, %L, %L)', pruebas.tere(), pruebas.curso_de('e83-a'), 'otro'), '22023', null, 'solo dos órdenes');
insert into lect values ('r0', pruebas.lee(pruebas.tere(), pruebas.curso_de('e83-a')));
select is((select r ->> 'outcome' from lect where k = 'r0'), 'ok', 'su curso se lee antes de la primera noche');
select is((select r -> 'figures' from lect where k = 'r0'), 'null'::jsonb, 'sin cifras');
select is(pruebas.lecciones((select r from lect where k = 'r0')), array['Uno:-', 'Dos:-', 'Tres:-'], 'las lecciones del temario, sin cifra');
select is((select r -> 'students' from lect where k = 'r0'), '[]'::jsonb, 'sin lista');
select is((select (r ->> 'stale')::boolean from lect where k = 'r0'), true, 'y con el aviso de que no hay resumen al día');

-- ---------------------------------------------------------------------------------------
-- Lo que pasa en la semana del lunes 2045-03-06. En el curso A:
--   a1 lo terminó el jueves anterior; a2 terminó la Uno y empezó la Dos el martes; a3 empezó el martes; a4 empezó y terminó la Uno el miércoles a
--   la 01:00, después de la medianoche; a5 lo terminó y borró su cuenta; a6 empezó y está suspendido; a7 solo vio la Tres, y la terminó el miércoles a las 02:00, después de la medianoche; y Tere vio todo su curso.
-- En el B, 55 alumnos que empezaron la Uno. En el C, de Beto, a2 terminó la Uno.

select pruebas.avance(pruebas.a(1), pruebas.lec('e83-a', t), '2045-03-01 10:00', '2045-03-02 10:00') from unnest(array['Uno', 'Dos', 'Tres']) t;
select pruebas.avance(pruebas.a(2), pruebas.lec('e83-a', 'Uno'), '2045-03-01 10:00', '2045-03-02 10:00');
select pruebas.avance(pruebas.a(2), pruebas.lec('e83-a', 'Dos'), '2045-03-07 10:00');
select pruebas.avance(pruebas.a(3), pruebas.lec('e83-a', 'Uno'), '2045-03-07 10:00');
select pruebas.avance(pruebas.a(4), pruebas.lec('e83-a', 'Uno'), '2045-03-08 01:00', '2045-03-08 02:00');
select pruebas.avance(pruebas.a(5), pruebas.lec('e83-a', t), '2045-03-01 10:00', '2045-03-02 10:00') from unnest(array['Uno', 'Dos', 'Tres']) t;
select pruebas.avance(pruebas.a(6), pruebas.lec('e83-a', 'Uno'), '2045-03-01 10:00');
select pruebas.avance(pruebas.a(7), pruebas.lec('e83-a', 'Tres'), '2045-03-01 10:00', '2045-03-08 02:00');
select pruebas.avance(pruebas.tere(), pruebas.lec('e83-a', t), '2045-03-01 10:00', '2045-03-02 10:00') from unnest(array['Uno', 'Dos', 'Tres']) t;
select pruebas.avance(pruebas.b(n), pruebas.lec('e83-b', 'Uno'), '2045-03-01 10:00') from generate_series(1, 55) n;
select pruebas.avance(pruebas.a(2), pruebas.lec('e83-c', 'Uno'), '2045-03-01 10:00', '2045-03-02 10:00');
select pruebas.suspender(pruebas.a(6));
set local session_replication_role = replica;
update public.profiles set status = 'deleted', deleted_at = now(), display_name = null, country_code = null, adult_declared_at = null, comment_ban_until = null
  where id = pruebas.a(5);
set local session_replication_role = origin;

-- La primera noche: el miércoles a las 03:00.
insert into lect values ('p1', pruebas.paso('2045-03-08 03:00'));
select is((select r ->> 'outcome' from lect where k = 'p1'), 'built', 'la primera noche guarda el resumen');
select is((select (r ->> 'weekly_rebuilt')::boolean from lect where k = 'p1'), true, 'y la lista de la semana');
select is((select count(*)::integer from private.progress_aliases where teacher_id = pruebas.m(1)), 0, 'el paso no crea alias: se crean al leer');

insert into lect values ('r1', pruebas.lee(pruebas.tere(), pruebas.curso_de('e83-a')));
select is(pruebas.cifras((select r from lect where k = 'r1')), '5:4:1',
  'cinco lo empezaron (con el suspendido, sin Tere, sin la cuenta borrada y sin lo de después de la medianoche), cuatro van a medias y uno lo terminó');
select is(pruebas.lecciones((select r from lect where k = 'r1')), array['Uno:2', 'Dos:1', 'Tres:1'], 'lo terminado por lección, en el orden del temario');
select is((select (r -> 'figures' ->> 'cut_at')::timestamptz from lect where k = 'r1'), pruebas.h('2045-03-08 00:00'), 'las cifras, a la medianoche de hoy');
select is((select (r ->> 'list_cut_at')::timestamptz from lect where k = 'r1'), pruebas.h('2045-03-06 00:00'), 'la lista, al lunes a las 00:00');
select is(pruebas.lista((select r from lect where k = 'r1')), array['3/3', '1/3', '0/3', '0/3'],
  'la lista: quien empezó antes del lunes, de más a menos avance (a3 empezó el martes y no está)');
select is((pruebas.quienes(pruebas.m(1), (select r from lect where k = 'r1')))[1:2], array['a1', 'a2'], 'el que terminó, y el que lleva una');
select is((select array(select unnest(x) order by 1) from (select (pruebas.quienes(pruebas.m(1), (select r from lect where k = 'r1')))[3:4] as x) y),
  array['a6', 'a7'], 'y los dos que no han terminado ninguna');
select ok((pruebas.alias_de((select r from lect where k = 'r1')))[3] < (pruebas.alias_de((select r from lect where k = 'r1')))[4],
  'entre iguales, por alias');
select is((select (r ->> 'total_students')::integer from lect where k = 'r1'), 4, 'cuatro en la lista');
select is((select (r ->> 'stale')::boolean from lect where k = 'r1'), false, 'el resumen está al día');
select is((select r ->> 'title' from lect where k = 'r1'), 'Curso e83-a', 'con el título del curso');

-- La lectura: una lista cerrada de claves y nada que identifique a nadie.
select is((select array(select jsonb_object_keys(r) order by 1) from lect where k = 'r1'),
  array['figures', 'lessons', 'list_cut_at', 'outcome', 'page', 'pages', 'stale', 'students', 'title', 'total_students'], 'las claves de la lectura');
select is((select array(select jsonb_object_keys(r -> 'figures') order by 1) from lect where k = 'r1'),
  array['cut_at', 'finished', 'in_progress', 'started'], 'las de las cifras');
select is(array(select distinct c from lect, jsonb_array_elements(r -> 'lessons') x, jsonb_object_keys(x) c where k = 'r1' order by 1),
  array['finished', 'title'], 'las de cada lección');
select is(array(select distinct c from lect, jsonb_array_elements(r -> 'students') x, jsonb_object_keys(x) c where k = 'r1' order by 1),
  array['alias', 'completed', 'total'], 'y las de cada alumno: alias, terminadas y total');
select ok((select r::text !~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' from lect where k = 'r1'), 'sin ningún identificador');

-- El alias de PA-51: se crea al leer, solo para la lista, estable, con forma, sin auditoría y de solo inserción; otro que el de PA-47.
select is((select count(*)::integer from private.progress_aliases where teacher_id = pruebas.m(1)), 4, 'leer creó los cuatro alias de la lista');
select ok(not exists (select 1 from private.progress_aliases where teacher_id = pruebas.m(1) and profile_id = pruebas.a(3)), 'a3, fuera de la lista, no tiene');
select ok((select bool_and(a ~ '^[A-Z][a-z]+ [1-9][0-9]{1,3}$') from unnest(pruebas.alias_de((select r from lect where k = 'r1'))) a),
  'cada alias tiene la forma de «Garza 42»');
insert into lect values ('r1b', pruebas.lee(pruebas.tere(), pruebas.curso_de('e83-a')));
select is(pruebas.alias_de((select r from lect where k = 'r1b')), pruebas.alias_de((select r from lect where k = 'r1')), 'leer otra vez da los mismos');
select is((select count(*)::integer from private.progress_aliases where teacher_id = pruebas.m(1)), 4, 'y no crea más');
set local session_replication_role = replica;
select private.alias_insert('student', pruebas.m(1), array[pruebas.a(1)]);
set local session_replication_role = origin;
select isnt((select alias from private.student_aliases where teacher_id = pruebas.m(1) and profile_id = pruebas.a(1)),
            (select alias from private.progress_aliases where teacher_id = pruebas.m(1) and profile_id = pruebas.a(1)), 'a1 se llama distinto en PA-47');
select is((select count(*)::integer from audit_log where entity_table like '%progress_aliases' or entity_table like '%course_progress%'
           or entity_table like '%course_lesson_figures' or entity_table like '%course_student_progress' or new_value ? 'alias'), 0,
  'ni el alias ni el resumen dejan rastro en la auditoría');
select throws_ok($$ update private.progress_aliases set alias = 'Garza 10' $$, '42501', null, 'un alias no cambia');
select throws_ok($$ delete from private.progress_aliases $$, '42501', null, 'ni se borra');
select throws_ok($$ truncate private.progress_aliases $$, '42501', null, 'ni se vacía');

-- El orden por alias.
insert into lect values ('r1c', pruebas.lee(pruebas.tere(), pruebas.curso_de('e83-a'), 'alias'));
select is(pruebas.alias_de((select r from lect where k = 'r1c')),
  (select array(select a from unnest(pruebas.alias_de((select r from lect where k = 'r1'))) a order by a)), 'por alias');

-- Un curso que nadie ha visto, y las páginas.
insert into lect values ('re', pruebas.lee(pruebas.tere(), pruebas.curso_de('e83-e')));
select is(pruebas.cifras((select r from lect where k = 're')), '0:0:0', 'un curso que nadie ha visto: ceros');
select is(pruebas.lecciones((select r from lect where k = 're')), array['Uno:0', 'Dos:0', 'Tres:0'], 'y cada lección en cero');
select is((select format('%s:%s:%s', r -> 'students', r ->> 'total_students', r ->> 'pages') from lect where k = 're'), '[]:0:1', 'sin lista, en una página');
insert into lect select 'b' || p, pruebas.lee(pruebas.tere(), pruebas.curso_de('e83-b'), 'progress', p) from unnest(array[0, 1, 2, 9]) p;
select is((select format('%s:%s:%s:%s', jsonb_array_length(r -> 'students'), r ->> 'page', r ->> 'pages', r ->> 'total_students') from lect where k = 'b1'),
  '50:1:2:55', 'páginas de 50');
select is((select format('%s:%s', jsonb_array_length(r -> 'students'), r ->> 'page') from lect where k = 'b2'), '5:2', 'la segunda trae el resto');
select is((select format('%s:%s', jsonb_array_length(r -> 'students'), r ->> 'page') from lect where k = 'b9'), '5:2', 'una página de más da la última');
select is((select format('%s:%s', jsonb_array_length(r -> 'students'), r ->> 'page') from lect where k = 'b0'), '50:1', 'y una de menos, la primera');
select is((select count(*)::integer from (select jsonb_array_elements(r -> 'students') ->> 'alias' from lect where k in ('b1', 'b2') intersect all
                                         select jsonb_array_elements(r -> 'students') ->> 'alias' from lect where k = 'b1') x), 50,
  'sin repetir a nadie entre las dos');
select is((select count(*)::integer from private.progress_aliases where teacher_id = pruebas.m(1)), 59, 'leer una página crea los alias de toda la lista');

-- El curso de Beto, también suspendido.
insert into lect values ('rc', pruebas.lee(pruebas.beto(), pruebas.curso_de('e83-c')));
select is(pruebas.lista((select r from lect where k = 'rc')), array['1/3'], 'Beto ve a a2 en su curso, con lo de su curso');
set local session_replication_role = replica;
update public.teachers set status = 'suspended', suspended_at = now(), suspended_by = pruebas.tere(), suspension_reason = 'prueba',
       suspension_notice = 'Tu cuenta de maestro está en pausa.'
where id = pruebas.m(2);
set local session_replication_role = origin;
select is((pruebas.lee(pruebas.beto(), pruebas.curso_de('e83-c'))) ->> 'outcome', 'ok', 'un maestro suspendido lee su avance');

-- ---------------------------------------------------------------------------------------
-- El jueves: las cifras cambian cada noche; la lista, no hasta el lunes.

insert into definiciones select 'semana', weekly_built_at::text from pruebas.estado();
insert into lect values ('p2', pruebas.paso('2045-03-09 03:00'));
select is((select format('%s:%s', r ->> 'outcome', r ->> 'weekly_rebuilt') from lect where k = 'p2'), 'built:false', 'el jueves no rehace la lista');
select is((select weekly_built_at::text from pruebas.estado()), (select d from definiciones where k = 'semana'), 'la lista sigue siendo la del lunes');
insert into lect values ('r2', pruebas.lee(pruebas.tere(), pruebas.curso_de('e83-a')));
select is(pruebas.cifras((select r from lect where k = 'r2')), '6:5:1', 'a4 ya cuenta en las cifras');
select is(pruebas.lecciones((select r from lect where k = 'r2')), array['Uno:3', 'Dos:1', 'Tres:2'], 'y en su lección; y a7 ya terminó la Tres');
select is(pruebas.lista((select r from lect where k = 'r2')), array['3/3', '1/3', '0/3', '0/3'], 'pero no en la lista');

-- Un paso que falla deja el resumen anterior, y lo anota.
create function pruebas.rompe() returns trigger language plpgsql as $$ begin raise exception 'roto a propósito'; end $$;
create trigger rompe before insert on private.course_lesson_figures for each statement execute function pruebas.rompe();
insert into lect values ('p3', pruebas.paso('2045-03-10 03:00'));
select is((select r ->> 'outcome' from lect where k = 'p3'), 'failed', 'el paso que falla lo dice');
select is((select r ->> 'error' from lect where k = 'p3'), 'P0001: roto a propósito', 'con el código y el mensaje');
select is((select format('%s:%s', (daily_cut_at = pruebas.h('2045-03-09 00:00'))::text, error) from pruebas.estado()), 'true:P0001: roto a propósito',
  'el estado guarda el último corte bueno y la falla');
insert into lect values ('r3', pruebas.lee(pruebas.tere(), pruebas.curso_de('e83-a')));
select is(format('%s@%s', pruebas.cifras((select r from lect where k = 'r3')), (select ((r -> 'figures' ->> 'cut_at')::timestamptz = pruebas.h('2045-03-09 00:00'))::text from lect where k = 'r3')),
  '6:5:1@true', 'y se sigue leyendo el del jueves');
drop trigger rompe on private.course_lesson_figures;

-- El lunes siguiente, con la Tres retirada: lo retirado no cuenta, y la lista se rehace.
set local session_replication_role = replica;
update public.published_lessons set is_current = false, retired_at = now() where id = pruebas.lec('e83-a', 'Tres');
set local session_replication_role = origin;
insert into lect values ('p4', pruebas.paso('2045-03-13 03:00'));
select is((select format('%s:%s', r ->> 'outcome', r ->> 'weekly_rebuilt') from lect where k = 'p4'), 'built:true', 'el lunes rehace la lista');
insert into lect values ('r4', pruebas.lee(pruebas.tere(), pruebas.curso_de('e83-a')));
select is(pruebas.cifras((select r from lect where k = 'r4')), '5:4:1', 'a7 solo vio lo retirado: ya no cuenta');
select is(pruebas.lecciones((select r from lect where k = 'r4')), array['Uno:3', 'Dos:1'], 'ni la lección retirada');
select is(pruebas.lista((select r from lect where k = 'r4')), array['2/2', '1/2', '1/2', '0/2', '0/2'], 'la lista nueva, de las lecciones vigentes');
select ok('a3' = any (pruebas.quienes(pruebas.m(1), (select r from lect where k = 'r4'))) and 'a4' = any (pruebas.quienes(pruebas.m(1), (select r from lect where k = 'r4'))),
  'con quienes empezaron la semana pasada');
select ok(not ('a7' = any (pruebas.quienes(pruebas.m(1), (select r from lect where k = 'r4')))), 'y sin quien solo vio lo retirado');
select is((select (r ->> 'list_cut_at')::timestamptz from lect where k = 'r4'), pruebas.h('2045-03-13 00:00'), 'al lunes nuevo');
select is((select (r ->> 'total_students')::integer from lect where k = 'r4'), 5, 'y cuenta solo la lista nueva, aunque la anterior siga guardada');

-- Una lección nueva: quien lo había terminado deja de contar como terminado.
set local session_replication_role = replica;
insert into public.published_lessons (id, course_id, module_id, teacher_id, video_asset_id, title, position, duration_seconds)
select gen_random_uuid(), l.course_id, l.module_id, l.teacher_id, l.video_asset_id, 'Seis',
       (select max(x.position) + 1 from public.published_lessons x where x.course_id = l.course_id), 100
from public.published_lessons l where l.id = pruebas.lec('e83-a', 'Uno');
set local session_replication_role = origin;
insert into lect values ('p5', pruebas.paso('2045-03-14 03:00'));
insert into lect values ('r5', pruebas.lee(pruebas.tere(), pruebas.curso_de('e83-a')));
select is(pruebas.cifras((select r from lect where k = 'r5')), '5:5:0', 'con una lección nueva, nadie lo ha terminado');
select is(pruebas.lecciones((select r from lect where k = 'r5')), array['Uno:3', 'Dos:1', 'Seis:0'], 'y la nueva sale en cero');

-- Lo de después del corte espera a la noche: una lección que llega o se retira a media semana no cambia hasta que la noche la cuente, y una
-- cuenta que se borra sale de la lista al leer.
set local session_replication_role = replica;
insert into public.published_lessons (id, course_id, module_id, teacher_id, video_asset_id, title, position, duration_seconds)
select gen_random_uuid(), l.course_id, l.module_id, l.teacher_id, l.video_asset_id, 'Siete',
       (select max(x.position) + 1 from public.published_lessons x where x.course_id = l.course_id), 100
from public.published_lessons l where l.id = pruebas.lec('e83-a', 'Uno');
update public.published_lessons set is_current = false, retired_at = now() where id = pruebas.lec('e83-a', 'Dos');
update public.profiles set status = 'deleted', deleted_at = now(), display_name = null, country_code = null, adult_declared_at = null, comment_ban_until = null
  where id = pruebas.a(3);
set local session_replication_role = origin;
insert into lect values ('r6', pruebas.lee(pruebas.tere(), pruebas.curso_de('e83-a')));
select is(pruebas.lecciones((select r from lect where k = 'r6')), array['Uno:3', 'Dos:1', 'Seis:0'], 'las lecciones son las del corte, como las cifras');
select is((select (r ->> 'total_students')::integer from lect where k = 'r6'), 4, 'la cuenta borrada sale de la lista al leer');
select ok(not ('a3' = any (pruebas.quienes(pruebas.m(1), (select r from lect where k = 'r6')))), 'y no se ve su alias');

-- El aviso de viejo, y que el resumen no guarda historia.
update private.course_progress_state set daily_built_at = now() - interval '27 hours';
select is((pruebas.lee(pruebas.tere(), pruebas.curso_de('e83-a'))) ->> 'stale', 'true', 'un resumen de hace más de 26 horas lleva el aviso');
update private.course_progress_state set daily_built_at = now();
select is(array(select distinct cut_at from private.course_progress_figures union select distinct cut_at from private.course_lesson_figures order by 1),
  array[pruebas.h('2045-03-13 00:00'), pruebas.h('2045-03-14 00:00')], 'las cifras guardan el corte de hoy y el anterior, entero, y nada más');
select is(array(select distinct cut_at from private.course_student_progress order by 1), array[pruebas.h('2045-03-06 00:00'), pruebas.h('2045-03-13 00:00')],
  'y la lista, el lunes de esta semana y el anterior');

-- ---------------------------------------------------------------------------------------
-- El vigilante: las dos áreas, limpias, y cada regla rota a propósito.

select is(pruebas.cp(), '{}'::text[], 'el área del avance no encuentra nada');
select is(pruebas.tr(), '{}'::text[], 'ni la de los alias');
select is((select count(*)::integer from private.schema_violations() v
           where v.object_name ~ '(course_progress|course_lesson_figures|course_student_progress|progress_alias|teacher_course_students|alias_insert|student_aliases|nightly_rollup)'),
  0, 'ni el vigilante entero');

grant select on private.course_progress_figures to app_service;
select ok(pruebas.cp_con('course progress table reachable by app_service'), 'una tabla del resumen al alcance del servidor');
revoke select on private.course_progress_figures from app_service;
grant select (course_id) on private.course_student_progress to authenticated;
select ok(pruebas.cp_con('course progress table reachable by authenticated'), 'también por una sola columna');
revoke select (course_id) on private.course_student_progress from authenticated;
grant truncate on private.course_progress_state to app_service;
select ok(pruebas.cp_con('course progress table reachable by app_service'), 'y por un permiso que no es de columnas');
revoke truncate on private.course_progress_state from app_service;
alter table private.course_lesson_figures disable row level security;
select ok(pruebas.cp_con('course progress table without row security'), 'sin seguridad por fila');
alter table private.course_lesson_figures enable row level security;
create view private.v83 as select course_id from private.course_student_progress;
select ok(pruebas.cp_con('course progress table read by a view'), 'una vista que lee el resumen');
drop view private.v83;
create function private.f83() returns bigint language sql as 'select count(*) from private.course_progress_figures';
select ok(pruebas.cp_con('course progress function not in the list'), 'una función que nombra el resumen y no está en la lista');
drop function private.f83();
create trigger t83 after insert on private.course_student_progress for each row execute function private.audit_row_change();
select ok(pruebas.cp_con('course progress table with a trigger'), 'un disparador sobre el resumen, que lo copiaría a otro lado');
drop trigger t83 on private.course_student_progress;
revoke execute on function private.teacher_course_students(uuid, text, integer) from app_service;
select ok(pruebas.cp_con('teacher course students door missing or wrong'), 'la lectura sin el servidor');
grant execute on function private.teacher_course_students(uuid, text, integer) to app_service;
grant execute on function private.teacher_course_students(uuid, text, integer) to authenticated;
select ok(pruebas.cp_con('teacher course students door missing or wrong'), 'o para la persona');
revoke execute on function private.teacher_course_students(uuid, text, integer) from authenticated;
grant execute on function private.course_progress_step(timestamptz) to app_service;
select ok(pruebas.cp_con('course progress system function reachable or wrong'), 'el paso al alcance del servidor');
revoke execute on function private.course_progress_step(timestamptz) from app_service;
alter function private.teacher_course_students(uuid, text, integer) stable;
select ok(pruebas.cp_con('teacher course students door missing or wrong'), 'una lectura que no es volátil no puede crear los alias');
alter function private.teacher_course_students(uuid, text, integer) volatile;
select pruebas.restaurar('noche');
do $$ begin execute replace((select d from definiciones where k = 'noche'), 'v_progress := private.course_progress_step();', 'v_progress := null;'); end $$;
select ok(pruebas.cp_con('nightly rollup does not build the course progress'), 'una noche que no guarda el resumen');
select pruebas.restaurar('noche');
do $$ begin execute replace((select d from definiciones where k = 'noche'), 'exception when query_canceled or others then', 'exception when others then'); end $$;
select ok(pruebas.cp_con('nightly rollup does not build the course progress'), 'o en un bloque que no atrapa la cancelación');
select pruebas.restaurar('noche');
select is(pruebas.cp(), '{}'::text[], 'restaurado, el área no encuentra nada');

grant select on private.progress_aliases to app_service;
select ok(pruebas.tr_con('progress aliases privilege for app_service'), 'los alias de PA-51 al alcance del servidor');
revoke select on private.progress_aliases from app_service;
alter table private.progress_aliases disable row level security;
select ok(pruebas.tr_con('progress aliases without row security'), 'sin seguridad por fila');
alter table private.progress_aliases enable row level security;
alter table private.progress_aliases disable trigger ledger_no_truncate;
select ok(pruebas.tr_con('teacher report trigger missing: ledger_no_truncate'), 'sin su candado de solo inserción');
alter table private.progress_aliases enable trigger ledger_no_truncate;
create trigger audit_row_change after insert on private.progress_aliases for each row execute function private.audit_row_change();
select ok(pruebas.tr_con('progress aliases audited'), 'auditados');
drop trigger audit_row_change on private.progress_aliases;
create function private.f83() returns text language sql as 'select alias from private.progress_aliases limit 1';
select ok(pruebas.tr_con('alias function not in the list'), 'una función que nombra los alias de PA-51 y no está en la lista');
drop function private.f83();
create function private.f83() returns text language sql as 'select alias from private.student_aliases limit 1';
select ok(pruebas.tr_con('alias function not in the list'), 'o los de PA-47');
drop function private.f83();
-- Cada función de la lista nombra solo la tabla que le toca: la lectura de PA-51 no puede leer los alias de PA-47, ni el reporte los de PA-51.
create or replace function private.teacher_course_students(p_course uuid, p_order text, p_page integer) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$ begin perform private.actor_teacher_id(); return (select pg_catalog.to_jsonb(pg_catalog.count(*)) from private.student_aliases); end $$;
select ok(pruebas.tr_con('alias function not in the list'), 'la lectura de PA-51 que nombra los alias de PA-47');
select pruebas.restaurar('lectura');
create or replace function private.payout_report_students(p_teacher uuid, p_period public.period_id) returns jsonb
language sql stable set search_path = ''
as $$ select coalesce(pg_catalog.jsonb_agg(a.alias), '[]'::jsonb) from private.progress_aliases a where a.teacher_id = p_teacher $$;
select ok(pruebas.tr_con('alias function not in the list'), 'el reporte de PA-47 que nombra los alias de PA-51');
select pruebas.restaurar('reporte');
create view private.v83 as select teacher_id from private.progress_aliases;
select ok(pruebas.tr_con('aliases read by a view'), 'una vista que lee los alias');
drop view private.v83;
grant execute on function private.alias_insert(text, uuid, uuid[]) to app_service;
select ok(pruebas.tr_con('teacher report helper reachable: alias_insert'), 'crear alias al alcance del servidor');
revoke execute on function private.alias_insert(text, uuid, uuid[]) from app_service;
select is(pruebas.tr(), '{}'::text[], 'restaurado, el área de los alias no encuentra nada');

select * from finish();
rollback;
