-- T-408, primera solicitud · El estimado del maestro y su panel (RF-601, RF-602, RF-612; PA-41; plan en ~/.claude/plans/t408-panel-diseno.md, con
-- las decisiones de Sergio del 2026-11-04: sin el bote sin consumo y sin las barras por día). Cada noche, después de consolidar un periodo, el paso
-- `private.teacher_estimates_step` calcula con la entrada del cierre lo asignado a cada maestro con puntos y las cifras por curso, en su propia corrida;
-- el maestro lo lee con `private.teacher_dashboard()`. Todas las cifras son de alumnos con base: uno sin base no se puede deducir de un estimado en 0.
--
-- La corrida de cada noche es un procedimiento con `commit` y no se llama aquí: que llame al paso, que un recálculo pedido estime, que una falla
-- o una cancelación del paso no deje fallida la consolidación lo prueba la integración 110. Aquí, el paso, la lectura y el vigilante
-- (que rompe la corrida de cada noche dentro de la transacción). Los meses de 2045 van forzados (abierto, en cierre): la prueba no depende del día
-- en que corre; el panel lee el mes en curso, que se limpia de corridas de estimado al empezar.
begin;
\ir _ayuda.psql
select plan(117);

select pruebas.alta('a8200000-0000-0000-0000-000000000001', 'tere-82@prueba.test');
select pruebas.alta('a8200000-0000-0000-0000-000000000002', 'beto-82@prueba.test');
select pruebas.alta('a8200000-0000-0000-0000-000000000003', 'susi-82@prueba.test');
select pruebas.alta('a8200000-0000-0000-0000-000000000004', 'nadie-82@prueba.test');
select pruebas.alta('c8200000-0000-0000-0000-000000000001', 'f1-82@prueba.test');
select pruebas.alta(('d8200000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'alumno' || n || '-82@prueba.test') from generate_series(1, 7) n;
select pruebas.confirmar(id) from auth.users where email like '%-82@prueba.test';
select pruebas.dar_capacidad('c8200000-0000-0000-0000-000000000001', 'finance');
select pruebas.equipar('c8200000-0000-0000-0000-000000000001');

create function pruebas.tere() returns uuid language sql immutable as $$ select 'a8200000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.beto() returns uuid language sql immutable as $$ select 'a8200000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.susi() returns uuid language sql immutable as $$ select 'a8200000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.nadie() returns uuid language sql immutable as $$ select 'a8200000-0000-0000-0000-000000000004'::uuid $$;
create function pruebas.f1() returns uuid language sql immutable as $$ select 'c8200000-0000-0000-0000-000000000001'::uuid $$;
-- El alumno n.
create function pruebas.a(n integer) returns uuid language sql immutable as $$ select ('d8200000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pruebas.mes_en_curso() returns public.period_id language sql stable as $$ select private.period_of(now()) $$;
create function pruebas.mes_anterior() returns public.period_id language sql stable as $$ select private.period_plus(private.period_of(now()), -1) $$;
create function pruebas.como_finanzas() returns void language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', pruebas.f1()::text, true),
         set_config('app.actor_session', pruebas.sesion(pruebas.f1())::text, true);
$$;
-- Un periodo forzado a un estado, con su foto si va en cierre.
create function pruebas.forzar(p_period integer, p_status text, p_students integer default null, p_bps integer default null) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(p_period);
  alter table public.payout_periods disable trigger payout_periods_guard;
  update public.payout_periods set status = p_status::public.period_status,
         entered_closing_at = case when p_status = 'open' then null else now() - interval '2 days' end,
         active_students = p_students, pool_bps = p_bps
  where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard;
  perform pruebas.como_dueno();
end
$$;
-- Un periodo cerrado sin pasar por el cierre, sin nada de nadie (como en la 81).
create function pruebas.cerrado(p integer) returns void language plpgsql as $$
declare
  v_run uuid := gen_random_uuid();
begin
  set local session_replication_role = replica;
  insert into public.close_runs (id, period_id, kind, status, period_status_at_run, code_version, parameters, started_by, error)
  values (v_run, p, 'rehearsal', 'failed', 'open', 'prueba', '{}', pruebas.f1(), 'prueba');
  insert into public.payout_periods (period_id, starts_at, ends_at, timezone, status, entered_closing_at, active_students, pool_bps,
                                     net_revenue_cents, student_pools_cents, pool_cents, assigned_cents, unconsumed_cents, carried_out_cents,
                                     close_run_id, closed_at, closed_by)
  select p, b.starts_at, b.ends_at, 'America/Mexico_City', 'closed', now(), 0, 6000, 0, 0, 0, 0, 0, 0, v_run, now(), pruebas.f1()
  from private.month_bounds(p, 'America/Mexico_City') b;
  set local session_replication_role = origin;
end
$$;
create function pruebas.curso(p_slug text) returns jsonb language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', (
      select jsonb_agg(jsonb_build_object('title', t, 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'Asset' || p_slug || n, 'playback_id', 'Playback' || p_slug || n, 'duration_seconds', 100)) order by n)
      from unnest(array['Uno', 'Dos', 'Tres']) with ordinality as l (t, n)))))
$$;
-- Lo de un periodo: seis alumnos con base (el sexto no pagó, y el séptimo pagó y no vio nada: siempre hay bote sin consumo), el consumo de
-- siempre y, si se pide, una consolidación que terminó bien.
--   Tere (lecciones 1 a 6, dos cursos): terminadas 1, 1, 4, 2 y 3 de alumnos distintos; a medias la 2 y la 4.
--   Beto (lecciones 7 a 9): solo el alumno 6, que no pagó: puntos que no entran a ninguna cifra.
--   Susi (lecciones 10 a 12): el alumno 1 y el 4; y el 5, con una fila de cero medios puntos, que no cuenta.
create function pruebas.datos(p integer, p_corrida boolean default true) returns void language plpgsql as $$
begin
  set local session_replication_role = replica;
  insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
  select gen_random_uuid(), pruebas.a(n), p, 'charge', 1, 1, 28000 + n * 581, 500, 'charge_date_v1' from unnest(array[1, 2, 3, 4, 5, 7]) n;
  set local session_replication_role = origin;
  insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id, lesson_duration_seconds, covered_seconds, half_points)
  select p, pruebas.a(v.alumno), l.id, l.course_id, l.teacher_id, l.video_asset_id, 100,
         case v.medios when 2 then 100 when 1 then 60 else 10 end, v.medios
  from (values (1, 1, 2), (1, 2, 1), (1, 4, 2), (1, 10, 2), (2, 1, 2), (3, 2, 2), (3, 3, 2), (4, 10, 1), (4, 11, 2), (5, 12, 0),
               (5, 4, 1), (6, 7, 2), (6, 8, 2)) v (alumno, leccion, medios)
  join lecciones l on l.n = v.leccion;
  if p_corrida then
    perform pruebas.consolidado(p, 'succeeded');
  end if;
end
$$;
-- Una consolidación del periodo que terminó ahora, bien o mal.
create function pruebas.consolidado(p integer, p_status text) returns void language sql as $$
  insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details, error)
  values ('nightly_rollup', p, p_status::public.run_status, clock_timestamp(), clock_timestamp(), clock_timestamp(), '{"mode": "full"}',
          case when p_status = 'failed' then 'prueba' end)
$$;
create function pruebas.paso(p integer) returns jsonb language sql as $$ select private.teacher_estimates_step(p) $$;
-- Un ensayo de finanzas: su corrida.
create function pruebas.ensayo(p integer) returns uuid language plpgsql as $$
declare
  v_r jsonb;
begin
  perform pruebas.como_finanzas();
  v_r := private.rehearse_close(p);
  perform pruebas.como_dueno();
  if v_r ->> 'outcome' <> 'rehearsed' then
    raise exception 'el ensayo de % no salió: %', p, v_r;
  end if;
  return (v_r ->> 'run_id')::uuid;
end
$$;
-- Lo asignado por maestro: en un ensayo, y en una corrida del estimado.
create function pruebas.del_ensayo(p_run uuid) returns text[] language sql stable as $$
  select array(select format('%s:%s:%s:%s', t.teacher_id, t.assigned_cents, t.half_points, t.students)
               from public.close_run_teacher_totals t where t.close_run_id = p_run order by t.teacher_id)
$$;
create function pruebas.del_estimado(p_run uuid) returns text[] language sql stable as $$
  select array(select format('%s:%s:%s:%s', e.teacher_id, e.assigned_cents, e.half_points, e.students)
               from private.teacher_period_estimates e where e.run_id = p_run order by e.teacher_id)
$$;
create function pruebas.fila(p_run uuid, p_teacher uuid) returns text language sql stable as $$
  select format('%s:%s:%s:%s:%s', e.assigned_cents, e.half_points, e.students, e.full_lessons, e.half_lessons)
  from private.teacher_period_estimates e where e.run_id = p_run and e.teacher_id = p_teacher
$$;
create function pruebas.panel(p_quien uuid) returns jsonb language sql as $$ select pruebas.pide(p_quien, 'private.teacher_dashboard()')::jsonb $$;
create function pruebas.cursos(p_quien uuid) returns text[] language sql as $$
  select array(select format('%s:%s:%s:%s', x ->> 'title', x ->> 'full_lessons', x ->> 'half_lessons', x ->> 'students')
               from jsonb_array_elements(pruebas.panel(p_quien) -> 'courses') with ordinality as c (x, n) order by n)
$$;
create function pruebas.serie(p_quien uuid) returns text[] language sql as $$
  select array(select format('%s:%s:%s', x ->> 'period_id', x ->> 'cents', x ->> 'estimated')
               from jsonb_array_elements(pruebas.panel(p_quien) -> 'series') with ordinality as c (x, n) order by n)
$$;
-- Lo que el área del estimado encuentra, y si encuentra un problema que empieza así.
create function pruebas.vigila() returns text[] language sql security definer as $$
  select array(select v.problem || ' @ ' || v.object_name from private.schema_violations_teacher_estimates() v order by 1)
$$;
create function pruebas.vigila_con(p_problem text) returns boolean language sql security definer as $$
  select exists (select 1 from private.schema_violations_teacher_estimates() v where v.problem like p_problem || '%')
$$;
-- Y lo que el vigilante entero dice de estos objetos (las otras áreas también pueden quejarse).
create function pruebas.vigila_todo() returns text[] language sql security definer as $$
  select array(select v.problem || ' @ ' || v.object_name from private.schema_violations() v
               where v.object_name ~ '(teacher_estimate|teacher_period_estimates|teacher_period_course_figures|teacher_dashboard|nightly_rollup)'
               order by 1)
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- Tres maestros con cuenta: Tere con dos cursos (uno publicado y otro retirado), Beto con uno que nunca se publicó y Susi, suspendida, con uno publicado.
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
create temporary table maestros as
  select x.n, private.system_add_teacher('Maestra ' || x.s, 'maestra-' || x.s, null) as id
  from unnest(array['e82-tere', 'e82-beto', 'e82-susi']) with ordinality as x (s, n);
create function pruebas.m(n integer) returns uuid language sql stable as $$ select id from maestros where maestros.n = $1 $$;
grant execute on function pruebas.m(integer) to app_service;
select private.system_load_course(pruebas.m(x.t), pruebas.curso(x.s))
from (values (1, 'e82-a1'), (1, 'e82-a2'), (2, 'e82-b1'), (3, 'e82-c1')) x (t, s);
select pruebas.como_dueno();
set local session_replication_role = replica;
update public.teachers t set profile_id = x.profile, status = x.status::public.teacher_status,
       suspended_at = case when x.status = 'suspended' then now() end, suspended_by = case when x.status = 'suspended' then pruebas.f1() end,
       suspension_reason = case when x.status = 'suspended' then 'prueba' end,
       suspension_notice = case when x.status = 'suspended' then 'Tu cuenta de maestro está en pausa.' end
from (values (1, pruebas.tere(), 'active'), (2, pruebas.beto(), 'active'), (3, pruebas.susi(), 'suspended')) x (n, profile, status)
where t.id = pruebas.m(x.n);
update public.course_registry r set state = x.state::public.course_state, first_published_at = x.published,
       withdrawn_at = case when x.state = 'withdrawn' then '2045-06-01 12:00-06'::timestamptz end,
       withdrawal_reason = case when x.state = 'withdrawn' then 'prueba' end
from public.published_courses c,
     (values ('e82-a1', 'published', '2044-12-10 12:00-06'::timestamptz), ('e82-a2', 'withdrawn', '2045-01-10 12:00-06'::timestamptz),
             ('e82-b1', 'in_review', null), ('e82-c1', 'published', '2044-11-10 12:00-06'::timestamptz)) x (slug, state, published)
where c.course_id = r.course_id and c.slug = x.slug;
set local session_replication_role = origin;
create temporary table lecciones as
  select row_number() over (order by c.slug, l.title) as n, l.id, l.course_id, l.teacher_id, l.video_asset_id
  from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug like 'e82-%';
create function pruebas.curso_de(p_slug text) returns uuid language sql stable as $$ select course_id from public.published_courses where slug = p_slug $$;
grant execute on function pruebas.curso_de(text) to app_service;
create temporary table r (k text primary key, id uuid);

-- ---------------------------------------------------------------------------------------
-- Lo que la aplicación ve: nada de las tablas, y solo el servidor lee el panel.

select ok(not has_table_privilege('app_service', t, 'select, insert, update, delete'), 'el servidor no toca ' || t)
from unnest(array['private.teacher_estimate_runs', 'private.teacher_period_estimates', 'private.teacher_period_course_figures']) t;
select ok(has_function_privilege('app_service', 'private.teacher_dashboard()', 'execute')
          and not has_function_privilege('authenticated', 'private.teacher_dashboard()', 'execute')
          and not has_function_privilege('anon', 'private.teacher_dashboard()', 'execute'), 'el panel lo pide el servidor, y nadie más');
select ok(not has_function_privilege('app_service', 'private.teacher_estimates_step(public.period_id)', 'execute'), 'estimar no es de la aplicación');
select ok(not (select prosecdef from pg_proc where oid = 'private.teacher_estimates_step(public.period_id)'::regprocedure),
  'el paso corre como quien lo llama: la corrida de cada noche');
select ok((select provolatile = 's' from pg_proc where oid = 'private.teacher_dashboard()'::regprocedure), 'el panel es de solo lectura');
select is(pruebas.panel(pruebas.nadie()), '{"outcome": "not_teacher"}'::jsonb, 'quien no es maestro no lee nada');

-- ---------------------------------------------------------------------------------------
-- El estimado es lo asignado del ensayo, al centavo, con la misma entrada: en cierre.

select pruebas.forzar(204501, 'closing', 6, 5300);
select pruebas.datos(204501);
insert into r values ('e1', (pruebas.paso(204501) ->> 'run_id')::uuid);
select is((select status from private.teacher_estimate_runs where id = (select id from r where k = 'e1')), 'succeeded', 'el paso estima un periodo en cierre');
insert into r values ('s1', pruebas.ensayo(204501));
select is(pruebas.del_estimado((select id from r where k = 'e1')), pruebas.del_ensayo((select id from r where k = 's1')),
  'lo asignado, los medios puntos y los alumnos de cada maestro son los del ensayo');
select cmp_ok(cardinality(pruebas.del_estimado((select id from r where k = 'e1'))), '=', 2, 'Tere y Susi tienen partes, y solo ellas tienen fila');
select is((select input_hash from private.teacher_estimate_runs where id = (select id from r where k = 'e1')),
          (select input_hash from public.close_runs where id = (select id from r where k = 's1')), 'con la misma huella de la entrada');
select is(pruebas.fila((select id from r where k = 'e1'), pruebas.m(1)),
  (select format('%s:%s:4:5:2', assigned_cents, half_points) from public.close_run_teacher_totals
   where close_run_id = (select id from r where k = 's1') and teacher_id = pruebas.m(1)), 'Tere: cuatro alumnos, cinco terminadas y dos a medias');
select is(pruebas.fila((select id from r where k = 'e1'), pruebas.m(2)), null::text,
  'Beto solo tiene puntos de un alumno sin base: sin fila, porque con una en 0 se deduciría a ese alumno');
select is((select format('%s:%s:%s', full_lessons, half_lessons, students) from private.teacher_period_estimates
           where run_id = (select id from r where k = 'e1') and teacher_id = pruebas.m(3)), '2:1:2', 'una fila con cero medios puntos no cuenta');
select is(array(select format('%s:%s:%s:%s', c.slug, f.full_lessons, f.half_lessons, f.students)
                from private.teacher_period_course_figures f join public.published_courses c on c.course_id = f.course_id
                where f.run_id = (select id from r where k = 'e1') order by c.slug),
  array['e82-a1:4:1:3', 'e82-a2:1:1:2', 'e82-c1:2:1:2'], 'las cifras de cada curso, sin el de Beto');
select ok((select assigned_cents from private.teacher_period_estimates where run_id = (select id from r where k = 'e1') and teacher_id = pruebas.m(1)) > 0,
  'Tere tiene algo asignado');
select is((select count(*)::integer from private.teacher_period_estimates e join private.teacher_estimate_runs x on x.id = e.run_id
           where e.run_id = (select id from r where k = 'e1') and e.period_id = x.period_id), 2, 'en el periodo de su corrida');

-- ---------------------------------------------------------------------------------------
-- El panel del mes en curso. Sin corridas de estimado del mes (las de otra prueba se quitan aquí), con una buena vieja, con una buena, con una que
-- falló después y con una en que Tere se quedó sin puntos.

select pruebas.forzar(pruebas.mes_en_curso(), 'open');
set local session_replication_role = replica;
delete from private.teacher_period_course_figures where period_id = pruebas.mes_en_curso();
delete from private.teacher_period_estimates where period_id = pruebas.mes_en_curso();
delete from private.teacher_estimate_runs where period_id = pruebas.mes_en_curso();
set local session_replication_role = origin;
select pruebas.datos(pruebas.mes_en_curso());

select is(pruebas.panel(pruebas.tere()) -> 'current', jsonb_build_object('period_id', pruebas.mes_en_curso(), 'estimated_cents', null, 'full_lessons', null,
  'half_lessons', null, 'students', null, 'updated_at', null, 'last_failed', false, 'stale', false), 'sin ninguna corrida, el panel no inventa una cifra');
select is(pruebas.cursos(pruebas.tere()), array['Curso e82-a1:::', 'Curso e82-a2:::'], 'ni las de sus cursos');

-- Una corrida buena de hace 27 horas, sin nada más: la noche no la renovó.
insert into private.teacher_estimate_runs (period_id, input_hash, status, started_at, finished_at)
values (pruebas.mes_en_curso(), '\x00', 'succeeded', now() - interval '28 hours', now() - interval '27 hours');
select is(pruebas.panel(pruebas.tere()) -> 'current' ->> 'stale', 'true', 'una corrida buena de más de 26 horas se marca vieja');
select is(pruebas.panel(pruebas.tere()) -> 'current' ->> 'last_failed', 'false', 'aunque la última no haya fallado');

insert into r values ('c1', (pruebas.paso(pruebas.mes_en_curso()) ->> 'run_id')::uuid);
select is(pruebas.panel(pruebas.tere()) -> 'current', jsonb_build_object('period_id', pruebas.mes_en_curso(),
  'estimated_cents', (select assigned_cents from private.teacher_period_estimates where run_id = (select id from r where k = 'c1') and teacher_id = pruebas.m(1)),
  'full_lessons', 5, 'half_lessons', 2, 'students', 4,
  'updated_at', (select finished_at from private.teacher_estimate_runs where id = (select id from r where k = 'c1')), 'last_failed', false, 'stale', false),
  'el mes en curso: lo asignado de la última corrida buena, sus cifras y su fecha');
select ok((pruebas.panel(pruebas.tere()) #>> '{current,estimated_cents}')::bigint > 0, 'Tere tiene un estimado');
select is(pruebas.cursos(pruebas.tere()), array['Curso e82-a1:4:1:3', 'Curso e82-a2:1:1:2'], 'cada curso suyo con sus cifras, también el retirado');
select is((select array_agg(k order by k) from jsonb_object_keys(pruebas.panel(pruebas.tere())) k),
  array['courses', 'current', 'has_published', 'outcome', 'series'], 'el panel trae una lista cerrada de claves');
select is((select array_agg(k order by k) from jsonb_object_keys(pruebas.panel(pruebas.tere()) -> 'current') k),
  array['estimated_cents', 'full_lessons', 'half_lessons', 'last_failed', 'period_id', 'stale', 'students', 'updated_at'], 'y el mes en curso también');
select is((select array_agg(distinct k order by k) from jsonb_array_elements(pruebas.panel(pruebas.tere()) -> 'courses') x, jsonb_object_keys(x) k),
  array['course_id', 'full_lessons', 'half_lessons', 'owned', 'students', 'title'], 'y cada curso');
select is(array(select x ->> 'owned' from jsonb_array_elements(pruebas.panel(pruebas.tere()) -> 'courses') x), array['true', 'true'],
  'los dos cursos de Tere son suyos');
select is(pruebas.panel(pruebas.tere()) ->> 'outcome', 'ok', 'una maestra activa lee su panel');
select is(pruebas.panel(pruebas.tere()) ->> 'has_published', 'true', 'y tiene un curso publicado');
select is(pruebas.panel(pruebas.beto()) ->> 'has_published', 'false', 'Beto no publicó');
select is((pruebas.panel(pruebas.beto()) -> 'current') - 'updated_at', jsonb_build_object('period_id', pruebas.mes_en_curso(), 'estimated_cents', 0,
  'full_lessons', 0, 'half_lessons', 0, 'students', 0, 'last_failed', false, 'stale', false),
  'su único alumno no pagó: todo en 0, sin lecciones que lo delaten');
select is(pruebas.cursos(pruebas.beto()), '{}'::text[], 'y su curso, que nunca se publicó y no tiene cifras con base, no sale');
select is(pruebas.panel(pruebas.susi()) -> 'current' ->> 'estimated_cents',
  (select assigned_cents::text from private.teacher_period_estimates where run_id = (select id from r where k = 'c1') and teacher_id = pruebas.m(3)),
  'una maestra suspendida lee lo suyo');
select ok(position(pruebas.curso_de('e82-b1')::text in pruebas.panel(pruebas.tere())::text) = 0
          and position(pruebas.curso_de('e82-c1')::text in pruebas.panel(pruebas.tere())::text) = 0
          and position(pruebas.m(3)::text in pruebas.panel(pruebas.tere())::text) = 0, 'Tere no ve los cursos ni el estimado de otro');
select ok(position(pruebas.a(1)::text in pruebas.panel(pruebas.tere())::text) = 0 and position('pool_bps' in pruebas.panel(pruebas.tere())::text) = 0,
  'ni un alumno, ni el porcentaje del bote');

-- La consolidación de anoche falló: el panel lo dice y se queda con las cifras de la última buena.
select pruebas.consolidado(pruebas.mes_en_curso(), 'failed');
select is(pruebas.paso(pruebas.mes_en_curso()) - 'run_id', '{"outcome": "failed", "error": "rollup failed"}'::jsonb, 'con la consolidación fallida no estima');
select is(pruebas.panel(pruebas.tere()) -> 'current' ->> 'last_failed', 'true', 'el panel dice que la última no se completó');
select is((pruebas.panel(pruebas.tere()) #>> '{current,updated_at}')::timestamptz,
          (select finished_at from private.teacher_estimate_runs where id = (select id from r where k = 'c1')), 'y sus cifras son de la buena');

-- Tere se queda sin puntos: 0, no la cifra de ayer.
select pruebas.consolidado(pruebas.mes_en_curso(), 'succeeded');
delete from public.watch_rollup where period_id = pruebas.mes_en_curso() and teacher_id = pruebas.m(1);
insert into r values ('c3', (pruebas.paso(pruebas.mes_en_curso()) ->> 'run_id')::uuid);
select is(pruebas.fila((select id from r where k = 'c3'), pruebas.m(1)), null::text, 'sin puntos, Tere no tiene fila');
select is((pruebas.panel(pruebas.tere()) -> 'current') - 'updated_at', jsonb_build_object('period_id', pruebas.mes_en_curso(), 'estimated_cents', 0,
  'full_lessons', 0, 'half_lessons', 0, 'students', 0, 'last_failed', false, 'stale', false), 'su estimado es 0');
select is(pruebas.cursos(pruebas.tere()), array['Curso e82-a1:0:0:0', 'Curso e82-a2:0:0:0'], 'y sus cursos, en cero');

-- Un curso de Tere que el consolidado acredita a Beto (RN-14), visto por un alumno con base: sus cifras son de Beto, no de Tere.
insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id, lesson_duration_seconds, covered_seconds, half_points)
select pruebas.mes_en_curso(), pruebas.a(2), l.id, l.course_id, pruebas.m(2), l.video_asset_id, 100, 100, 2 from lecciones l where l.n = 3;
insert into r values ('c4', (pruebas.paso(pruebas.mes_en_curso()) ->> 'run_id')::uuid);
select is(pruebas.cursos(pruebas.tere()), array['Curso e82-a1:0:0:0', 'Curso e82-a2:0:0:0'], 'Tere no ve las cifras de Beto en su curso');
select is(pruebas.cursos(pruebas.beto()), array['Curso e82-a1:1:0:1'], 'Beto sí, y solo las de su alumno con base');
select is((select x ->> 'owned' from jsonb_array_elements(pruebas.panel(pruebas.beto()) -> 'courses') x where x ->> 'title' = 'Curso e82-a1'), 'false',
  'pero ese curso no es suyo: le llega solo por sus cifras, y no se enlaza a su editor');

-- Una corrida de otro trabajo del periodo, fallida, no es la consolidación.
insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, error)
values ('period_transition', pruebas.mes_en_curso(), 'failed', clock_timestamp(), clock_timestamp(), clock_timestamp(), 'prueba');
select is(pruebas.paso(pruebas.mes_en_curso()) ->> 'outcome', 'estimated', 'el paso mira solo la consolidación');

-- Con su único curso publicado retirado, Susi ya no tiene curso publicado; con cambios pendientes, sí.
set local session_replication_role = replica;
update public.course_registry set state = 'withdrawn', withdrawn_at = now(), withdrawal_reason = 'prueba' where course_id = pruebas.curso_de('e82-c1');
set local session_replication_role = origin;
select is(pruebas.panel(pruebas.susi()) ->> 'has_published', 'false', 'un curso retirado no cuenta como publicado');
set local session_replication_role = replica;
update public.course_registry set state = 'changes_pending', pending_version_state = 'draft', withdrawn_at = null, withdrawal_reason = null
where course_id = pruebas.curso_de('e82-c1');
set local session_replication_role = origin;
select is(pruebas.panel(pruebas.susi()) ->> 'has_published', 'true', 'uno con una versión en camino sigue publicado');

-- ---------------------------------------------------------------------------------------
-- Un paso que falla deja su corrida fallida, y el periodo se ensaya y se cierra igual.

create function pruebas.romper() returns trigger language plpgsql as $$ begin raise exception 'roto a propósito' using errcode = 'P0001'; end $$;
create trigger romper before insert on private.teacher_period_estimates for each row execute function pruebas.romper();
insert into r values ('e2', (pruebas.paso(204501) ->> 'run_id')::uuid);
select is((select format('%s:%s:%s', status, input_hash is null, error) from private.teacher_estimate_runs where id = (select id from r where k = 'e2')),
  'failed:t:P0001: roto a propósito', 'la corrida del paso queda fallida, con el código');
select is((select count(*)::integer from private.teacher_period_estimates where run_id = (select id from r where k = 'e2'))
          + (select count(*)::integer from private.teacher_period_course_figures where run_id = (select id from r where k = 'e2')), 0, 'y sin nada a medias');
drop trigger romper on private.teacher_period_estimates;
select is((select id from private.teacher_estimate_runs where period_id = 204501 and status = 'succeeded' order by finished_at desc, id desc limit 1),
  (select id from r where k = 'e1'), 'la última buena sigue siendo la de antes');
select is((select status::text from public.job_runs where job = 'nightly_rollup' and period_id = 204501 order by started_at desc limit 1), 'succeeded',
  'la consolidación no se toca');
-- El cierre va en orden desde el arranque: lo de antes, abierto o en cierre, se quita (se deshace al terminar).
set local session_replication_role = replica;
delete from public.payout_periods where period_id < 204501 and status in ('open', 'closing');
set local session_replication_role = origin;
insert into r values ('s2', pruebas.ensayo(204501));
select ok((select id from r where k = 's2') is not null, 'se ensaya');
select pruebas.como_finanzas();
select is(private.close_period(204501, private.last_rehearsal(204501)) ->> 'outcome', 'closed', 'y se cierra');
set constraints payout_periods_balanced immediate;
set constraints payout_periods_balanced deferred;
select pruebas.como_dueno();

-- Un periodo cerrado o pagado no se estima, ni se escribe.
select is(pruebas.paso(204501), '{"outcome": "closed"}'::jsonb, 'un periodo cerrado no se estima');
select is((select count(*)::integer from private.teacher_estimate_runs where period_id = 204501), 2, 'ni deja corrida');
select throws_ok($$ insert into private.teacher_estimate_runs (period_id, input_hash, status, started_at, finished_at)
                    values (204501, '\x00', 'succeeded', now(), now()) $$, '55000', null, 'una corrida de un periodo cerrado no entra');
select throws_ok(format($$ insert into private.teacher_period_estimates (run_id, period_id, teacher_id, half_points, assigned_cents,
                                                                        full_lessons, half_lessons, students)
                           values (%L, 204501, %L, 0, 0, 0, 0, 0) $$, (select id from r where k = 'e2'), pruebas.m(2)),
  '55000', null, 'ni un estimado');
select throws_ok(format($$ insert into private.teacher_period_course_figures (run_id, period_id, teacher_id, course_id, full_lessons, half_lessons, students)
                           values (%L, 204501, %L, %L, 0, 0, 0) $$, (select id from r where k = 'e1'), pruebas.m(1), pruebas.curso_de('e82-b1')),
  '55000', null, 'ni las cifras de un curso');
select throws_ok($$ update private.teacher_estimate_runs set error = null where period_id = 204501 $$, '42501', null, 'una corrida no cambia');
select throws_ok($$ delete from private.teacher_period_estimates where period_id = 204501 $$, '42501', null, 'un estimado no se borra');
select throws_ok($$ truncate private.teacher_period_course_figures $$, '42501', null, 'ni se vacían las cifras');
-- Una corrida fallida sí entra: sin cifras, y sin tomar el periodo (si el paso falló por no alcanzar ese candado, no se podría anotar).
select lives_ok($$ insert into private.teacher_estimate_runs (period_id, status, error, started_at, finished_at)
                   values (204501, 'failed', 'prueba', now(), now()) $$, 'una corrida fallida de un periodo cerrado sí entra');
set local session_replication_role = replica;
update public.payout_periods set status = 'paid' where period_id = 204501;
set local session_replication_role = origin;
select is(pruebas.paso(204501), '{"outcome": "closed"}'::jsonb, 'un periodo pagado tampoco');

-- ---------------------------------------------------------------------------------------
-- Con lo arrastrado distinto de 0 y un fundador: el estimado sigue siendo lo asignado del ensayo, sin el bono.

select pruebas.forzar(204502, 'closing', 6, 7100);
select pruebas.datos(204502);
set local session_replication_role = replica;
update public.payout_periods set carried_in_cents = 123457 where period_id = 204502;
update public.teachers set is_founder = true, founder_since = '2044-06-01' where id = pruebas.m(1);
set local session_replication_role = origin;
insert into r values ('e3', (pruebas.paso(204502) ->> 'run_id')::uuid);
insert into r values ('s3', pruebas.ensayo(204502));
select is((select carried_in_cents from public.close_runs where id = (select id from r where k = 's3')), 123457::bigint, 'el ensayo recibe lo arrastrado');
select ok((select founder_bonus_cents from public.close_run_teacher_totals where close_run_id = (select id from r where k = 's3') and teacher_id = pruebas.m(1)) > 0,
  'y le propone a Tere su bono de fundadora');
select is(pruebas.del_estimado((select id from r where k = 'e3')), pruebas.del_ensayo((select id from r where k = 's3')),
  'lo asignado de cada maestro es el del ensayo');
select is((select input_hash from private.teacher_estimate_runs where id = (select id from r where k = 'e3')),
          (select input_hash from public.close_runs where id = (select id from r where k = 's3')), 'con la misma entrada');
select ok((select e.assigned_cents from private.teacher_period_estimates e where e.run_id = (select id from r where k = 'e3') and e.teacher_id = pruebas.m(1))
          < (select t.assigned_cents + t.founder_bonus_cents from public.close_run_teacher_totals t
             where t.close_run_id = (select id from r where k = 's3') and t.teacher_id = pruebas.m(1)), 'el estimado no lleva el bono');
select ok((select e.assigned_cents from private.teacher_period_estimates e where e.run_id = (select id from r where k = 'e3') and e.teacher_id = pruebas.m(1))
          < (select t.total_cents from public.close_run_teacher_totals t where t.close_run_id = (select id from r where k = 's3') and t.teacher_id = pruebas.m(1)),
  'ni el bote sin consumo');

-- Con el periodo abierto, el porcentaje es el de los alumnos activos de ahora, el mismo del ensayo.
select pruebas.forzar(204503, 'open');
select pruebas.datos(204503);
insert into r values ('e4', (pruebas.paso(204503) ->> 'run_id')::uuid);
insert into r values ('s4', pruebas.ensayo(204503));
select is(pruebas.del_estimado((select id from r where k = 'e4')), pruebas.del_ensayo((select id from r where k = 's4')), 'abierto: lo mismo que el ensayo');
select is((select input_hash from private.teacher_estimate_runs where id = (select id from r where k = 'e4')),
          (select input_hash from public.close_runs where id = (select id from r where k = 's4')), 'con la misma entrada');

-- ---------------------------------------------------------------------------------------
-- Sin una consolidación buena no se estima; antes del arranque, tampoco, y sin corrida fallida.

select pruebas.forzar(204504, 'open');
select pruebas.datos(204504);
select pruebas.consolidado(204504, 'failed');
select is(pruebas.paso(204504) - 'run_id', '{"outcome": "failed", "error": "rollup failed"}'::jsonb, 'si la última consolidación falló, no estima');
select pruebas.forzar(204505, 'open');
select pruebas.datos(204505, false);
select is(pruebas.paso(204505) - 'run_id', '{"outcome": "failed", "error": "rollup missing"}'::jsonb, 'ni si el periodo no se consolidó');
select is((select count(*)::integer from private.teacher_period_estimates where period_id in (204504, 204505)), 0, 'y no deja estimados');
select is((select count(*)::integer from private.teacher_estimate_runs where period_id in (204504, 204505) and status = 'failed' and input_hash is null), 2,
  'pero sí su corrida fallida, que el panel ve');
-- La carrera: una consolidación del periodo que sigue viva (con latido reciente) aunque la última en empezar ya terminó bien. Lo leído pudo cambiar.
select pruebas.forzar(204506, 'open');
select pruebas.datos(204506);
insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, details)
values ('nightly_rollup', 204506, 'running', now() - interval '1 hour', clock_timestamp(), '{"mode": "full"}');
select is(pruebas.paso(204506) - 'run_id', '{"outcome": "failed", "error": "rollup running"}'::jsonb, 'con otra consolidación viva del periodo, no guarda como bueno');
-- Una que se quedó corriendo sin latir en 15 minutos está caída: no detiene el estimado (la siguiente corrida la da por fallida).
select pruebas.forzar(204507, 'open');
select pruebas.datos(204507);
insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, details)
values ('nightly_rollup', 204507, 'running', now() - interval '1 hour', clock_timestamp() - interval '20 minutes', '{"mode": "full"}');
select is(pruebas.paso(204507) ->> 'outcome', 'estimated', 'una caída, sin latido, no la detiene');
-- Otro trabajo del periodo vivo, con latido, no es una consolidación: tampoco la detiene.
insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, details)
values ('period_transition', 204507, 'running', now() - interval '1 minute', clock_timestamp(), '{}');
select is(pruebas.paso(204507) ->> 'outcome', 'estimated', 'otro trabajo vivo del periodo no la detiene');
-- Un periodo de la ventana sin fila (en una base nueva, antes del primer paso a cierre) también se estima: no hay nada que tomar ni que cerrar.
select pruebas.consolidado(204512, 'succeeded');
select is(pruebas.paso(204512) - 'run_id', '{"outcome": "estimated", "teachers": 0}'::jsonb, 'un periodo sin fila que se consolidó, se estima');
select is((select count(*)::integer from private.teacher_estimate_runs where period_id = 204512 and status = 'succeeded'), 1, 'con su corrida');
-- Septiembre de 2026 es de antes del arranque (los tramos de la semilla rigen desde octubre).
select pruebas.consolidado(202609, 'succeeded');
select is(pruebas.paso(202609), '{"outcome": "before_launch"}'::jsonb, 'antes del arranque no se estima');
select is((select count(*)::integer from private.teacher_estimate_runs where period_id = 202609), 0, 'ni queda una corrida fallida cada noche');
select throws_ok('select private.teacher_estimates_step(null)', '22023', null, 'sin periodo, lanza');

-- ---------------------------------------------------------------------------------------
-- La serie: los cerrados o pagados con su total, y los que están en cierre o siguen abiertos antes del mes en curso con su último estimado, marcados.

-- El mes anterior sigue abierto (entre el día 1 y la corrida, o con un paso a cierre fallido), con un alumno con base que vio a Beto.
select pruebas.forzar(pruebas.mes_anterior(), 'open');
select pruebas.datos(pruebas.mes_anterior());
insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id, lesson_duration_seconds, covered_seconds, half_points)
select pruebas.mes_anterior(), pruebas.a(2), l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, 100, 2 from lecciones l where l.n = 7;
insert into r values ('e5', (pruebas.paso(pruebas.mes_anterior()) ->> 'run_id')::uuid);
create function pruebas.estimado(p_key text, p_maestro integer) returns bigint language sql stable as $$
  select e.assigned_cents from private.teacher_period_estimates e where e.run_id = (select id from r where k = p_key) and e.teacher_id = pruebas.m(p_maestro)
$$;
grant execute on function pruebas.estimado(text, integer) to app_service;
grant select on r to app_service;
select is(pruebas.serie(pruebas.tere()), array[
  pruebas.mes_anterior() || ':' || pruebas.estimado('e5', 1) || ':true',
  '204501:' || (select total_cents from public.payout_teacher_totals where period_id = 204501 and teacher_id = pruebas.m(1)) || ':false',
  '204502:' || pruebas.estimado('e3', 1) || ':true'],
  'Tere: el mes anterior abierto con su estimado, el pagado con su total, y el que está en cierre con su estimado');
select ok((select total_cents from public.payout_teacher_totals where period_id = 204501 and teacher_id = pruebas.m(1)) > pruebas.estimado('e1', 1),
  'el total cerrado lleva el sin consumo, que el estimado no');
select is(pruebas.serie(pruebas.beto()), array[pruebas.mes_anterior() || ':' || pruebas.estimado('e5', 2) || ':true'],
  'Beto no publicó: solo el periodo en que tiene cifra');
select is((select array_agg(distinct k order by k) from jsonb_array_elements(pruebas.panel(pruebas.tere()) -> 'series') x, jsonb_object_keys(x) k),
  array['cents', 'estimated', 'period_id'], 'cada barra trae una lista cerrada de claves');
-- El mes en curso, abierto y con estimado de Tere, va en sus cifras y no en la serie.
select pruebas.forzar(pruebas.mes_en_curso(), 'open');
with corrida as (
  insert into private.teacher_estimate_runs (period_id, input_hash, status, started_at, finished_at)
  values (pruebas.mes_en_curso(), '\x01', 'succeeded', now(), clock_timestamp()) returning id)
insert into private.teacher_period_estimates (run_id, period_id, teacher_id, half_points, assigned_cents, full_lessons, half_lessons, students)
select c.id, pruebas.mes_en_curso(), pruebas.m(1), 2, 500, 1, 0, 1 from corrida c;
select ok(exists (select 1 from private.teacher_period_estimates e
                  where e.run_id = (private.teacher_estimate_last_run(pruebas.mes_en_curso(), true)).id and e.teacher_id = pruebas.m(1)),
  'Tere tiene estimado en el mes en curso');
select ok(not exists (select 1 from unnest(pruebas.serie(pruebas.tere())) s where s like pruebas.mes_en_curso() || ':%'),
  'pero el mes en curso no va en la serie');
-- Un periodo en cierre sin ninguna corrida buena: su barra, sin cifra.
select pruebas.forzar(204504, 'closing', 6, 6000);
select is(pruebas.serie(pruebas.tere()), array[
  pruebas.mes_anterior() || ':' || pruebas.estimado('e5', 1) || ':true',
  '204501:' || (select total_cents from public.payout_teacher_totals where period_id = 204501 and teacher_id = pruebas.m(1)) || ':false',
  '204502:' || pruebas.estimado('e3', 1) || ':true', '204504::true'], 'en cierre sin estimado bueno: la barra sin cifra');
-- Un cerrado sin total de nadie, en noviembre de 2044: Susi publicó ese mes y lo ve en 0, como en PA-46; Tere publicó en diciembre y no.
select pruebas.cerrado(204411);
select ok('204411:0:false' = any (pruebas.serie(pruebas.susi())), 'desde su primer mes publicado, un cerrado sin total va en 0');
select ok(not exists (select 1 from unnest(pruebas.serie(pruebas.tere())) s where s like '204411:%'), 'y antes de publicar, sin cifra, no sale');
-- Con doce cerrados más, solo los doce más nuevos, del más viejo al más nuevo.
select pruebas.cerrado(204600 + n) from generate_series(1, 12) n;
select is(pruebas.serie(pruebas.tere()), array(select (204600 + n) || ':0:false' from generate_series(1, 12) n order by n),
  'la serie se queda con los últimos doce');

-- ---------------------------------------------------------------------------------------
-- Un periodo pagado sigue congelado para el estimado.

select throws_ok($$ insert into private.teacher_estimate_runs (period_id, input_hash, status, started_at, finished_at)
                    values (204501, '\x00', 'succeeded', now(), now()) $$, '55000', null, 'el periodo pagado sigue congelado');

-- ---------------------------------------------------------------------------------------
-- El vigilante: en cero, y cada regla del área, rota a propósito.

select is(pruebas.vigila(), '{}'::text[], 'el área del estimado no encuentra nada');
select is(pruebas.vigila_todo(), '{}'::text[], 'ni el vigilante entero');
grant select on private.teacher_period_estimates to app_service;
select ok(pruebas.vigila_con('teacher estimates table reachable by app_service'), 'un permiso de más se ve');
revoke select on private.teacher_period_estimates from app_service;
grant truncate on private.teacher_estimate_runs to app_service;
select ok(pruebas.vigila_con('teacher estimates table reachable by app_service'), 'también uno que no es de columnas');
revoke truncate on private.teacher_estimate_runs from app_service;
grant select (teacher_id) on private.teacher_period_course_figures to app_service;
select ok(pruebas.vigila_con('teacher estimates table reachable by app_service'), 'y uno de una sola columna');
revoke select (teacher_id) on private.teacher_period_course_figures from app_service;
alter table private.teacher_estimate_runs disable row level security;
select ok(pruebas.vigila_con('teacher estimates table without row security'), 'y una tabla sin seguridad por fila');
alter table private.teacher_estimate_runs enable row level security;
alter table private.teacher_period_course_figures disable trigger teacher_period_course_figures_frozen;
select ok(pruebas.vigila_con('teacher estimates trigger missing: teacher_period_course_figures_frozen'), 'y un congelado apagado');
alter table private.teacher_period_course_figures enable trigger teacher_period_course_figures_frozen;
alter table private.teacher_estimate_runs disable trigger ledger_no_update_delete;
select ok(pruebas.vigila_con('teacher estimates trigger missing: ledger_no_update_delete'), 'y el que no deja cambiar ni borrar');
alter table private.teacher_estimate_runs enable trigger ledger_no_update_delete;
alter table private.teacher_period_estimates disable trigger ledger_no_truncate;
select ok(pruebas.vigila_con('teacher estimates trigger missing: ledger_no_truncate'), 'y el que no deja vaciar');
alter table private.teacher_period_estimates enable trigger ledger_no_truncate;
grant execute on function private.teacher_estimates_step(public.period_id) to app_service;
select ok(pruebas.vigila_con('teacher estimates system function reachable or wrong'), 'y el paso al alcance de la aplicación');
revoke execute on function private.teacher_estimates_step(public.period_id) from app_service;
alter function private.teacher_estimates_step(public.period_id) security definer;
select ok(pruebas.vigila_con('teacher estimates system function reachable or wrong'), 'y el paso como su dueño');
alter function private.teacher_estimates_step(public.period_id) security invoker;
revoke execute on function private.teacher_dashboard() from app_service;
select ok(pruebas.vigila_con('teacher dashboard door missing or wrong'), 'y el panel fuera del alcance del servidor');
grant execute on function private.teacher_dashboard() to app_service;
grant execute on function private.teacher_dashboard() to authenticated;
select ok(pruebas.vigila_con('teacher dashboard door missing or wrong'), 'y el panel al alcance de una persona');
revoke execute on function private.teacher_dashboard() from authenticated;
alter function private.teacher_dashboard() security invoker;
select ok(pruebas.vigila_con('teacher dashboard door missing or wrong'), 'y el panel sin correr como su dueño');
alter function private.teacher_dashboard() security definer;
alter function private.teacher_dashboard() volatile;
select ok(pruebas.vigila_con('teacher dashboard door missing or wrong'), 'y el panel con permiso de escribir');
alter function private.teacher_dashboard() stable;
create temporary table definiciones as
  select 'panel' as k, pg_get_functiondef('private.teacher_dashboard()'::regprocedure) as def
  union all
  select 'noche', pg_get_functiondef('private.nightly_rollup(boolean, integer)'::regprocedure);
do $$ begin execute replace((select def from definiciones where k = 'panel'), 'private.actor_teacher_id()', '(select null::uuid)'); end $$;
select ok(pruebas.vigila_con('teacher dashboard door missing or wrong'), 'y el panel que no pregunta quién es el maestro');
do $$ begin execute (select def from definiciones where k = 'panel'); end $$;
do $$ begin execute replace((select def from definiciones where k = 'noche'), 'perform private.teacher_estimates_step(v_period);', 'null;'); end $$;
select ok(pruebas.vigila_con('nightly rollup does not estimate'), 'y la corrida de cada noche sin el paso');
do $$ begin execute replace((select def from definiciones where k = 'noche'), 'when query_canceled or others then', 'when others then'); end $$;
select ok(pruebas.vigila_con('nightly rollup does not estimate'), 'y la corrida de cada noche que una cancelación cortaría');
do $$ begin execute (select def from definiciones where k = 'noche'); end $$;
create function private.zz_82_lee() returns bigint language sql stable set search_path = ''
as $$ select pg_catalog.count(*) from private.teacher_period_estimates $$;
revoke all on function private.zz_82_lee() from public;
select ok(pruebas.vigila_con('teacher estimates function not in the list'), 'y una función nueva que nombra las tablas');
drop function private.zz_82_lee();
create view private.zz_82_vista as select run_id, teacher_id, assigned_cents from private.teacher_period_estimates;
select ok(pruebas.vigila_con('teacher estimates table read by a view'), 'y una vista sobre las tablas, que correría como su dueño');
drop view private.zz_82_vista;
select is(pruebas.vigila(), '{}'::text[], 'y en cero otra vez');

select * from finish();
rollback;
