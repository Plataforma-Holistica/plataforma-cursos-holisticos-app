-- T-611 · La selección de pares del recálculo completo, por índice (RNF-06, RNF-07; 05 §8.2 y
-- §14.4). Plan revisado y aprobado por Sergio el 2026-10-26.
--
-- El modo completo de `private.rollup_step()` elige en cada paso los siguientes pares (alumno,
-- lección) del periodo, de los latidos y del consolidado. Antes armaba la unión entera de las dos
-- tablas en cada paso: a `HORIZONTE_ESCALA` eran unas 2 h solo en elegir. Ahora lo hace
-- `private.rollup_full_pairs()`: cada rama corta por el índice desde el cursor, y la unión de los
-- dos cortes se vuelve a cortar. Esta prueba la compara contra la selección de antes, copiada aquí
-- como oráculo: si salta o repite un par, el consolidado queda viejo y el cierre paga mal.
--
-- Los meses son de 2049, que ninguna otra prueba toca. Cada ronda al azar escribe dentro de una
-- subtransacción que se deshace al terminar: los latidos son un libro y no se borran.
begin;
\ir _ayuda.psql
select plan(30);

create function pruebas.periodo() returns integer language sql immutable as $$ select 204901 $$;
create function pruebas.otro() returns integer language sql immutable as $$ select 204902 $$;
create function pruebas.inicio(p_period integer) returns timestamptz
language sql stable as $$ select timezone('America/Mexico_City', to_date(p_period::text || '01', 'YYYYMMDD')::timestamp) $$;
create function pruebas.fila(p_period integer) returns void
language sql as $$
  select pruebas.como_dueno_sistema();
  insert into public.payout_periods (period_id, starts_at, ends_at, timezone, status)
  values (p_period, pruebas.inicio(p_period), pruebas.inicio(p_period) + interval '1 month', 'America/Mexico_City', 'open');
  select pruebas.como_dueno();
$$;
-- Seis alumnos con perfil, que pueden tener consolidado, y dos que solo aparecen en latidos
-- (los latidos no tienen llave a los perfiles), intercalados en el orden.
create function pruebas.alumno(p_n integer) returns uuid language sql immutable
as $$ select ('a0000000-0000-0000-0000-0000000490' || lpad(p_n::text, 2, '0'))::uuid $$;
create function pruebas.alumnos() returns uuid[] language sql immutable
as $$ select array[pruebas.alumno(10), pruebas.alumno(20), pruebas.alumno(30), pruebas.alumno(40), pruebas.alumno(50), pruebas.alumno(60)] $$;
create function pruebas.sin_perfil() returns uuid[] language sql immutable
as $$ select array[pruebas.alumno(15), pruebas.alumno(45)] $$;
create function pruebas.lecciones() returns uuid[] language sql stable
as $$ select array(select l.id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id
                   where c.slug = 'curso-pares' order by l.id) $$;
-- Una lección que solo aparece en latidos (tampoco tienen llave a las lecciones).
create function pruebas.leccion_suelta() returns uuid language sql immutable
as $$ select 'f0000000-0000-0000-0000-000000004901'::uuid $$;
create function pruebas.curso() returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', 'curso-pares', 'title', 'Curso pares', 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', (
      select jsonb_agg(jsonb_build_object('title', 'Lección ' || n, 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'AssetPares' || n, 'playback_id', 'PlaybackPares' || n, 'duration_seconds', 100)))
      from generate_series(1, 5) n))))
$$;

-- Un latido suelto, sin reproducción: la selección solo mira el periodo, el alumno y la lección.
create function pruebas.latido(p_period integer, p_profile uuid, p_lesson uuid) returns void
language sql as $$
  insert into public.watch_events (period_id, playback_session_id, seq, profile_id, lesson_id, from_second, to_second,
                                   playback_rate, was_visible, qualifies, counts_for_payout)
  values (p_period, gen_random_uuid(), 0, p_profile, p_lesson, 0, 30, 1, true, true, true)
$$;
create function pruebas.consolidado(p_period integer, p_profile uuid, p_lesson uuid) returns void
language sql as $$
  insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                   lesson_duration_seconds, covered_seconds, half_points)
  select p_period, p_profile, l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, 50, 1
  from public.published_lessons l where l.id = p_lesson
  on conflict do nothing
$$;

-- El oráculo: la selección del modo completo como estaba en t602_congelado (`rollup_step`).
create function pruebas.vieja(p_period integer, p_after_profile uuid, p_after_lesson uuid, p_limit integer)
returns table (profile_id uuid, lesson_id uuid)
language sql stable as $$
  select p.profile_id, p.lesson_id
  from (select e.profile_id, e.lesson_id from public.watch_events e where e.period_id = p_period
        union
        select w.profile_id, w.lesson_id from public.watch_rollup w where w.period_id = p_period) p
  where p_after_profile is null or (p.profile_id, p.lesson_id) > (p_after_profile, p_after_lesson)
  order by p.profile_id, p.lesson_id limit p_limit
$$;
-- Un paso como texto, para comparar en una línea.
create function pruebas.texto_vieja(p_after_profile uuid, p_after_lesson uuid, p_limit integer) returns text
language sql stable as $$
  select coalesce(string_agg(profile_id || '/' || lesson_id, ' ' order by profile_id, lesson_id), '')
  from pruebas.vieja(pruebas.periodo(), p_after_profile, p_after_lesson, p_limit)
$$;
create function pruebas.texto_nueva(p_after_profile uuid, p_after_lesson uuid, p_limit integer) returns text
language sql stable as $$
  select coalesce(string_agg(profile_id || '/' || lesson_id, ' ' order by ordinality), '')
  from private.rollup_full_pairs(pruebas.periodo(), p_after_profile, p_after_lesson, p_limit) with ordinality
$$;
-- Recorre el periodo a la par con las dos, paso por paso desde el mismo cursor. Devuelve los pasos
-- que difieren (en conjunto o en orden) y, aparte, cuántos pasos dio.
create function pruebas.recorre(p_limit integer, out diferencias integer, out pasos integer)
language plpgsql as $$
declare
  v_profile uuid;
  v_lesson uuid;
  v_old uuid[];
  v_old_lessons uuid[];
  v_new uuid[];
  v_new_lessons uuid[];
begin
  diferencias := 0;
  pasos := 0;
  loop
    select array_agg(o.profile_id order by o.profile_id, o.lesson_id), array_agg(o.lesson_id order by o.profile_id, o.lesson_id)
    into v_old, v_old_lessons from pruebas.vieja(pruebas.periodo(), v_profile, v_lesson, p_limit) o;
    select array_agg(n.profile_id order by n.ord), array_agg(n.lesson_id order by n.ord)
    into v_new, v_new_lessons
    from private.rollup_full_pairs(pruebas.periodo(), v_profile, v_lesson, p_limit) with ordinality as n (profile_id, lesson_id, ord);
    if v_old is distinct from v_new or v_old_lessons is distinct from v_new_lessons then
      diferencias := diferencias + 1;
    end if;
    exit when v_old is null or pasos > 10000;
    pasos := pasos + 1;
    v_profile := v_old[pg_catalog.array_length(v_old, 1)];
    v_lesson := v_old_lessons[pg_catalog.array_length(v_old_lessons, 1)];
  end loop;
end
$$;
-- Una ronda al azar: latidos repetidos de alumnos con y sin perfil (también de una lección suelta),
-- consolidado de pares que tienen latidos y de pares que no, y latidos y consolidado del otro mes,
-- que no cuentan.
-- Se deshace al terminar.
create function pruebas.ronda(p_limit integer, out diferencias integer, out pasos integer)
language plpgsql as $$
declare
  v_all uuid[] := pruebas.alumnos() || pruebas.sin_perfil();
  v_lessons uuid[] := pruebas.lecciones();
begin
  begin
    perform pruebas.latido(case when random() < 0.9 then pruebas.periodo() else pruebas.otro() end,
                           v_all[1 + floor(random() * pg_catalog.array_length(v_all, 1))::integer],
                           case when random() < 0.1 then pruebas.leccion_suelta()
                                else v_lessons[1 + floor(random() * pg_catalog.array_length(v_lessons, 1))::integer] end)
    from generate_series(1, floor(random() * 60)::integer);
    perform pruebas.consolidado(case when random() < 0.9 then pruebas.periodo() else pruebas.otro() end,
                                (pruebas.alumnos())[1 + floor(random() * 6)::integer],
                                v_lessons[1 + floor(random() * pg_catalog.array_length(v_lessons, 1))::integer])
    from generate_series(1, floor(random() * 15)::integer);
    select r.diferencias, r.pasos into diferencias, pasos from pruebas.recorre(p_limit) r;
    raise exception using errcode = 'P9611', message = 'deshacer la ronda';
  exception when sqlstate 'P9611' then
    null;
  end;
end
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.alta(a, 'pares-' || right(a::text, 2) || '@prueba.test') from unnest(pruebas.alumnos()) a;
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra pares', 'maestra-pares', null), pruebas.curso());
select pruebas.como_dueno();
select pruebas.fila(pruebas.periodo());
select pruebas.fila(pruebas.otro());
select private.create_watch_partition(pruebas.periodo());
select private.create_watch_partition(pruebas.otro());

-- ---------------------------------------------------------------------------------------
-- La función: de la consolidación, solo para el dueño, y con el plan a la medida de cada paso.

select ok(to_regprocedure('private.rollup_full_pairs(public.period_id, uuid, uuid, integer)') is not null, 'existe la selección por índice');
select is((select provolatile::text from pg_proc where oid = 'private.rollup_full_pairs(public.period_id, uuid, uuid, integer)'::regprocedure),
  's', 'solo lee: estable');
select is((select prosecdef from pg_proc where oid = 'private.rollup_full_pairs(public.period_id, uuid, uuid, integer)'::regprocedure),
  false, 'no corre como el dueño');
-- Un plan genérico (el que Postgres guarda tras unas llamadas) estima el límite como una parte de la
-- tabla y recorre la partición entera: de 3 ms a más de 1 s por paso a esta escala (T-611).
select ok((select 'plan_cache_mode=force_custom_plan' = any (proconfig)
           from pg_proc where oid = 'private.rollup_full_pairs(public.period_id, uuid, uuid, integer)'::regprocedure),
  'planea cada paso con su cursor, nunca con un plan genérico');
select ok(not has_function_privilege(r, 'private.rollup_full_pairs(public.period_id, uuid, uuid, integer)', 'EXECUTE'),
  'ningún rol de la aplicación la ejecuta: ' || r)
from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) r;
select is_empty($$select * from private.schema_violations_rollup()$$, 'el vigilante de la consolidación no ve nada');

-- ---------------------------------------------------------------------------------------
-- Casos a mano. Con las lecciones L1 < L2 < L3 (por id) y los alumnos A10 < A15 < A20 < A30:
--   A10 · L1  tres latidos, sin consolidado
--   A10 · L2  solo consolidado
--   A10 · L3  latidos y consolidado
--   A15 · L1  latidos de un alumno sin perfil
--   A20 · L2  solo consolidado
--   A20 · L1  consolidado del otro mes: tampoco
--   A30 · L1  latido del otro mes: no es de este periodo
--   A30 · L3  latidos y consolidado

select is(pruebas.texto_nueva(null, null, 50), '', 'un periodo sin nada no da pares');

select pruebas.latido(pruebas.periodo(), pruebas.alumno(10), (pruebas.lecciones())[1]) from generate_series(1, 3);
select pruebas.consolidado(pruebas.periodo(), pruebas.alumno(10), (pruebas.lecciones())[2]);
select pruebas.latido(pruebas.periodo(), pruebas.alumno(10), (pruebas.lecciones())[3]);
select pruebas.consolidado(pruebas.periodo(), pruebas.alumno(10), (pruebas.lecciones())[3]);
select pruebas.latido(pruebas.periodo(), pruebas.alumno(15), (pruebas.lecciones())[1]) from generate_series(1, 2);
select pruebas.consolidado(pruebas.periodo(), pruebas.alumno(20), (pruebas.lecciones())[2]);
select pruebas.consolidado(pruebas.otro(), pruebas.alumno(20), (pruebas.lecciones())[1]);
select pruebas.latido(pruebas.otro(), pruebas.alumno(30), (pruebas.lecciones())[1]);
select pruebas.latido(pruebas.periodo(), pruebas.alumno(30), (pruebas.lecciones())[3]) from generate_series(1, 2);
select pruebas.consolidado(pruebas.periodo(), pruebas.alumno(30), (pruebas.lecciones())[3]);

create function pruebas.par(p_profile integer, p_lesson integer) returns text language sql stable
as $$ select pruebas.alumno(p_profile) || '/' || (pruebas.lecciones())[p_lesson] $$;

select is(pruebas.texto_nueva(null, null, 50),
  concat_ws(' ', pruebas.par(10, 1), pruebas.par(10, 2), pruebas.par(10, 3), pruebas.par(15, 1), pruebas.par(20, 2), pruebas.par(30, 3)),
  'todos los pares del periodo, una vez cada uno y en orden: los repetidos y los de las dos tablas, juntos');
select is(pruebas.texto_nueva(null, null, 2), concat_ws(' ', pruebas.par(10, 1), pruebas.par(10, 2)),
  'el primer paso, con un límite menor que lo que trae una rama: los latidos repetidos no gastan el límite');
select is(pruebas.texto_nueva(pruebas.alumno(10), (pruebas.lecciones())[2], 2), concat_ws(' ', pruebas.par(10, 3), pruebas.par(15, 1)),
  'desde un cursor que cae en un par que solo está en el consolidado');
select is(pruebas.texto_nueva(pruebas.alumno(10), (pruebas.lecciones())[1], 1), pruebas.par(10, 2),
  'desde un cursor que cae en un par que solo está en los latidos');
select is(pruebas.texto_nueva(pruebas.alumno(15), (pruebas.lecciones())[1], 50), concat_ws(' ', pruebas.par(20, 2), pruebas.par(30, 3)),
  'desde el par de un alumno sin perfil');
select is(pruebas.texto_nueva(pruebas.alumno(30), (pruebas.lecciones())[3], 50), '', 'después del último par no queda nada');
select is(pruebas.texto_nueva(pruebas.alumno(10), null, 50), pruebas.texto_vieja(pruebas.alumno(10), null, 50),
  'un cursor sin lección deja pasar solo a los alumnos que siguen, como antes');
select is(pruebas.texto_nueva(pruebas.alumno(10), null, 50), concat_ws(' ', pruebas.par(15, 1), pruebas.par(20, 2), pruebas.par(30, 3)),
  'y son los que siguen');
select is(pruebas.texto_nueva(null, (pruebas.lecciones())[2], 2), pruebas.texto_nueva(null, null, 2),
  'un cursor sin alumno es el primer paso, como antes');
select is(pruebas.texto_nueva(null, null, null), pruebas.texto_nueva(null, null, 50), 'sin límite, todos, como antes');
select is(pruebas.texto_nueva(pruebas.alumno(10), (pruebas.lecciones())[1], null), pruebas.texto_vieja(pruebas.alumno(10), (pruebas.lecciones())[1], null),
  'sin límite y con cursor, como antes');
select is(pruebas.texto_nueva(null, null, 0), '', 'con límite cero, nada');
select is((select diferencias from pruebas.recorre(1)), 0, 'recorrido de a un par: igual a la selección de antes en cada paso');
select is((select diferencias from pruebas.recorre(2)), 0, 'de a dos: igual en cada paso');
select is((select pasos from pruebas.recorre(4)), 2, 'de a cuatro: dos pasos para los seis pares');

-- ---------------------------------------------------------------------------------------
-- La propiedad: 400 rondas al azar con límites de 1 a 7, recorridas a la par con la selección de
-- antes. Con pocos alumnos y lecciones los pares chocan: latidos repetidos, pares en las dos ramas,
-- pares solo en una, cursores que caen en cada caso.

select setseed(0.611);
create temporary table rondas as
select l.n, r.diferencias, r.pasos
from generate_series(1, 400) l (n), lateral pruebas.ronda(1 + (l.n % 7)) r;
select is((select sum(diferencias)::integer from rondas), 0, 'en 400 rondas al azar, ningún paso distinto de la selección de antes');
select cmp_ok((select sum(pasos)::integer from rondas), '>', 2000, 'y las rondas dieron pasos de verdad');

-- Lo mismo sin los índices: las dos ramas leen la tabla entera y ordenan o agrupan por su cuenta, y
-- un periodo o un corte que falten se notan igual. (Apagar además el orden no cambia el plan:
-- Postgres vuelve a los índices, porque los dos caminos quedan con un nodo apagado.)
set local enable_indexscan = off;
set local enable_indexonlyscan = off;
set local enable_bitmapscan = off;
create temporary table rondas_otro_plan as
select l.n, r.diferencias, r.pasos
from generate_series(1, 200) l (n), lateral pruebas.ronda(1 + (l.n % 7)) r;
set local enable_indexscan = on;
set local enable_indexonlyscan = on;
set local enable_bitmapscan = on;
select is((select sum(diferencias)::integer from rondas_otro_plan), 0, 'con otro plan, 200 rondas más: tampoco');
select cmp_ok((select sum(pasos)::integer from rondas_otro_plan), '>', 1000, 'también con pasos de verdad');

-- ---------------------------------------------------------------------------------------
-- El paso del modo completo la usa: recorrido de a dos, lee cada par una vez. Los pares no tienen
-- reproducciones, así que lo que la consolidación haga con cada uno no importa: aquí solo cuenta qué leyó.

create function pruebas.lee_completo(p_limit integer) returns text
language plpgsql as $$
declare
  v_run uuid := private.open_job_run('nightly_rollup', pruebas.periodo(), 'full');
  v jsonb;
  v_profile uuid;
  v_lesson uuid;
  v_ends text := '';
  v_read integer := 0;
begin
  loop
    v := private.rollup_step(v_run, clock_timestamp(), v_profile, v_lesson, p_limit);
    exit when (v ->> 'read')::integer = 0;
    v_read := v_read + (v ->> 'read')::integer;
    v_profile := (v ->> 'last_profile')::uuid;
    v_lesson := (v ->> 'last_lesson')::uuid;
    v_ends := v_ends || v_profile || '/' || v_lesson || ' ';
    -- Un paso que no avanza el cursor daría vueltas para siempre.
    exit when v_read > 100;
  end loop;
  perform private.close_job_run(v_run, null);
  return v_read || ': ' || v_ends;
end
$$;
select is(pruebas.lee_completo(2),
  '6: ' || pruebas.par(10, 2) || ' ' || pruebas.par(15, 1) || ' ' || pruebas.par(30, 3) || ' ',
  'el recálculo completo lee los seis pares de dos en dos, sin saltar ni repetir');

select * from finish();
rollback;
