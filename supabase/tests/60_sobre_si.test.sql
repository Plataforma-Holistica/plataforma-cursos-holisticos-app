-- T-401 · Nadie actúa sobre sí, también en finanzas (decisiones de Sergio del 2026-10-29 y del 2026-10-30).
--
-- Alguien del equipo puede ser maestro o alumno, pero nunca actúa sobre sí: no revisa una alerta suya, no
-- excluye su propio consumo, no se da un bono ni un ajuste, y no se da una capacidad. Y como excluir el
-- consumo de otros mueve el bote sin consumo, que se reparte entre todos los maestros, quien cobra en un
-- periodo no excluye ni revierte en él (`conflict`). Excluir por fraude lo hace alguien distinto de quien
-- marcó el fraude (`proposer`). Las liquidaciones y los bonos del fundador se prueban en la 55.
begin;
\ir _ayuda.psql
select plan(33);

-- f1 es de finanzas y maestra (del curso «sobre-a»); f2 y f3 son de finanzas y no son maestras; cf tiene
-- configuración. ana y beto son alumnos.
select pruebas.alta('b6000000-0000-0000-0000-000000000001', 'f1-sobre@prueba.test');
select pruebas.alta('b6000000-0000-0000-0000-000000000002', 'f2-sobre@prueba.test');
select pruebas.alta('b6000000-0000-0000-0000-000000000003', 'f3-sobre@prueba.test');
select pruebas.alta('b6000000-0000-0000-0000-000000000004', 'cf-sobre@prueba.test');
select pruebas.alta('b6000000-0000-0000-0000-000000000005', 'contenido-sobre@prueba.test');
select pruebas.alta('a6000000-0000-0000-0000-000000000001', 'ana-sobre@prueba.test');
select pruebas.alta('a6000000-0000-0000-0000-000000000002', 'beto-sobre@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-sobre@prueba.test';
select pruebas.dar_capacidad(id, 'finance') from (values
  ('b6000000-0000-0000-0000-000000000001'::uuid), ('b6000000-0000-0000-0000-000000000002'::uuid),
  ('b6000000-0000-0000-0000-000000000003'::uuid)) v (id);
select pruebas.dar_capacidad('b6000000-0000-0000-0000-000000000004', 'config');
select pruebas.dar_capacidad('b6000000-0000-0000-0000-000000000005', 'content');
select pruebas.equipar(id) from auth.users where email in
  ('f1-sobre@prueba.test', 'f2-sobre@prueba.test', 'f3-sobre@prueba.test', 'cf-sobre@prueba.test',
   'contenido-sobre@prueba.test');

create function pruebas.f1() returns uuid language sql immutable as $$ select 'b6000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.f2() returns uuid language sql immutable as $$ select 'b6000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.f3() returns uuid language sql immutable as $$ select 'b6000000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.cf() returns uuid language sql immutable as $$ select 'b6000000-0000-0000-0000-000000000004'::uuid $$;
create function pruebas.ana() returns uuid language sql immutable as $$ select 'a6000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.beto() returns uuid language sql immutable as $$ select 'a6000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.periodo() returns integer language sql stable
as $$ select private.period_of(clock_timestamp()) $$;
create function pruebas.curso(p_slug text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', jsonb_build_array(
      jsonb_build_object('title', 'Uno', 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'Asset' || p_slug, 'playback_id', 'Playback' || p_slug, 'duration_seconds', 100))))))
$$;
create function pruebas.leccion(p_slug text) returns uuid
language sql as $$
  select l.id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id where c.slug = p_slug
$$;
create function pruebas.maestro(p_slug text) returns uuid
language sql as $$ select teacher_id from public.published_courses where slug = p_slug $$;
-- Una fila del consolidado, escrita como el dueño, como en la 29.
create function pruebas.fila(p_profile uuid, p_slug text) returns void
language sql as $$
  select private.open_period(pruebas.periodo());
  insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                   lesson_duration_seconds, covered_seconds, half_points)
  select pruebas.periodo(), p_profile, l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, 100, 2
  from public.published_lessons l where l.id = pruebas.leccion(p_slug)
$$;
-- Una alerta del periodo, abierta por el sistema.
create function pruebas.alerta(p_kind text, p_teacher uuid, p_profile uuid) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(pruebas.periodo());
  insert into public.anomaly_alerts (period_id, kind, teacher_id, profile_id, metric_value, threshold_value)
  values (pruebas.periodo(), p_kind::public.anomaly_kind, p_teacher, p_profile, 9, 3) returning id into v_id;
  perform pruebas.limpiar();
  return v_id;
end
$$;
-- Lo que contesta una función de finanzas, a nombre de una persona por el servidor.
create function pruebas.o(p_id uuid, p_call text) returns text
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_id);
  execute 'select ' || p_call into v;
  perform pruebas.limpiar();
  return v ->> 'outcome';
end
$$;
-- Lo mismo, como el dueño a nombre de esa persona: capturar bonos y ajustes no está abierto al servidor.
create function pruebas.o_dueno(p_id uuid, p_call text) returns text
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.limpiar();
  perform set_config('app.actor_id', p_id::text, true), set_config('app.actor_session', pruebas.sesion(p_id)::text, true);
  execute 'select ' || p_call into v;
  perform pruebas.limpiar();
  return v ->> 'outcome';
end
$$;
create function pruebas.excluye(p_id uuid, p_profile uuid, p_code text, p_alert uuid default null) returns text
language sql as $$
  select pruebas.o(p_id, format('private.exclude_consumption(%L, %s, %L, null, null, null, null, %L, %L, %L)',
                                'account', pruebas.periodo(), p_profile, p_code, 'motivo de prueba', p_alert))
$$;
create function pruebas.exclusion(p_profile uuid, p_by uuid) returns uuid
language sql security definer as $$
  select x.id from public.consumption_exclusions x
  where x.profile_id = p_profile and x.created_by = p_by and x.revoked_at is null order by x.created_at desc limit 1
$$;

-- El dueño a nombre de una persona, con su sesión de pruebas, sin cambiar de rol.
create function pruebas.dueno_a_nombre_de(p_id uuid) returns void
language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', p_id::text, true), set_config('app.actor_session', pruebas.sesion(p_id)::text, true);
$$;

grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra ' || s, 'maestra-' || s, null), pruebas.curso(s))
from unnest(array['sobre-a', 'sobre-b']) as s;
-- f1 es la maestra de «sobre-a».
update public.teachers set profile_id = pruebas.f1() where id = pruebas.maestro('sobre-a');
select pruebas.limpiar();
select pruebas.pide('b6000000-0000-0000-0000-000000000005', format('private.approve_course(%L)', course_id))
from public.published_courses where slug like 'sobre-%';
-- Este mes, ana vio a las dos maestras y beto solo a la de «sobre-b»: f1 cobra este mes.
select pruebas.como_dueno();
select pruebas.fila(pruebas.ana(), 'sobre-a'), pruebas.fila(pruebas.ana(), 'sobre-b'), pruebas.fila(pruebas.beto(), 'sobre-b');

-- ---------------------------------------------------------------------------------------
-- Revisar una alerta.

select pruebas.alerta('teacher_points_jump', pruebas.maestro('sobre-a'), null) as salto_a \gset
select pruebas.alerta('teacher_points_jump', pruebas.maestro('sobre-b'), null) as salto_b \gset
select pruebas.alerta('impossible_completion', null, pruebas.f1()) as imposible_f1 \gset
select pruebas.alerta('impossible_completion', null, pruebas.ana()) as imposible_ana \gset
select pruebas.alerta('impossible_completion', null, pruebas.beto()) as imposible_beto \gset

select is(pruebas.o(pruebas.f1(), format('private.review_alert(%L, %L, null, null)', :'salto_a', 'revisada')),
  'self', 'nadie revisa la alerta de su propio maestro');
select is(pruebas.o(pruebas.f1(), format('private.review_alert(%L, %L, null, null)', :'imposible_f1', 'revisada')),
  'self', 'ni la de su propia cuenta');
select pruebas.como_dueno();
select is((select count(*)::int from public.anomaly_alerts where id in (:'salto_a', :'imposible_f1') and status = 'open'), 2,
  'y las dos siguen abiertas');
select is(pruebas.o(pruebas.f2(), format('private.review_alert(%L, %L, null, null)', :'salto_a', 'revisada')),
  'reviewed', 'otra persona de finanzas sí la revisa');
select is(pruebas.o(pruebas.f1(), format('private.review_alert(%L, %L, null, null)', :'salto_b', 'revisada')),
  'reviewed', 'y f1 revisa la alerta de otra maestra');

-- Quién marcó el fraude queda escrito: al revisar, o después.
select is(pruebas.o(pruebas.f2(), format('private.review_alert(%L, %L, true, %L)', :'imposible_ana', 'revisada', 'evidencia')),
  'reviewed', 'f2 revisa y marca fraude');
select is(pruebas.o(pruebas.f2(), format('private.review_alert(%L, %L, false, null)', :'imposible_beto', 'revisada')),
  'reviewed', 'f2 revisa sin fraude');
select is(pruebas.o(pruebas.f3(), format('private.review_alert(%L, %L, true, %L)', :'imposible_beto', 'otra', 'evidencia')),
  'marked_fraud', 'y f3 la marca como fraude después');
select pruebas.como_dueno();
select results_eq(
  format($$select id, fraud_marked_by from public.anomaly_alerts where id in (%L, %L) order by fraud_marked_by$$,
         :'imposible_ana', :'imposible_beto'),
  format($$values (%L::uuid, %L::uuid), (%L::uuid, %L::uuid)$$,
         :'imposible_ana', pruebas.f2(), :'imposible_beto', pruebas.f3()),
  'cada alerta dice quién la marcó como fraude');

-- ---------------------------------------------------------------------------------------
-- Excluir y revertir.

select is(pruebas.excluye(pruebas.f1(), pruebas.f1(), 'test_account'), 'self', 'nadie excluye su propio consumo');
select is(pruebas.excluye(pruebas.f1(), pruebas.beto(), 'test_account'), 'conflict',
  'quien cobra este mes no excluye a nadie de este mes, aunque no la haya visto a ella');
select is(pruebas.excluye(pruebas.f2(), pruebas.beto(), 'test_account'), 'excluded', 'otra persona de finanzas, sí');
select is(pruebas.o(pruebas.f1(), format('private.exclude_consumption(%L, %s, %L, null, null, null, null, %L, %L, null)',
                                         'account', private.period_plus(pruebas.periodo(), -1), pruebas.beto(), 'test_account', 'el mes pasado')),
  'excluded', 'y f1 sí excluye en un mes en que no cobra');
select pruebas.como_dueno();
select is((select count(*)::int from public.consumption_exclusions where created_by = pruebas.f1() and period_id = pruebas.periodo()), 0,
  'f1 no dejó ninguna exclusión de este mes');

-- Por fraude: quien marcó el fraude no excluye.
select is(pruebas.excluye(pruebas.f2(), pruebas.ana(), 'fraud', :'imposible_ana'), 'proposer',
  'quien marcó el fraude no excluye por fraude');
select is(pruebas.excluye(pruebas.f3(), pruebas.beto(), 'fraud', :'imposible_beto'), 'proposer',
  'tampoco si lo marcó después de revisar');
select is(pruebas.excluye(pruebas.f3(), pruebas.ana(), 'fraud', :'imposible_ana'), 'excluded', 'otra persona, sí');
select is(pruebas.excluye(pruebas.f2(), pruebas.beto(), 'fraud', :'imposible_beto'), 'excluded',
  'y quien solo revisó sin marcar, también');
-- Una alerta marcada antes de esta solicitud no tiene quién: cuenta quien la revisó.
select pruebas.como_dueno_sistema();
alter table public.anomaly_alerts disable trigger alerts_guard;
update public.anomaly_alerts set fraud_marked_by = null where id = :'imposible_ana';
alter table public.anomaly_alerts enable trigger alerts_guard;
select pruebas.limpiar();
select is(pruebas.excluye(pruebas.f2(), pruebas.ana(), 'fraud', :'imposible_ana'), 'proposer',
  'sin quién marcó el fraude, cuenta quien revisó');

-- Quién marcó el fraude no se reescribe, ni siquiera desde finanzas por fuera de la función.
select pruebas.alerta('impossible_completion', null, pruebas.cf()) as imposible_cf \gset
select pruebas.dueno_a_nombre_de(pruebas.f2());
-- El control: la misma persona, por la misma vía, sí revisa una alerta abierta. Así lo que falla abajo es la regla
-- de quién marcó, no la puerta.
select lives_ok(format($$update public.anomaly_alerts set status = 'reviewed', review_note = 'x', reviewed_by = %L, reviewed_at = now()
                         where id = %L$$, pruebas.f2(), :'imposible_cf'),
  'la puerta de finanzas pasa por fuera de la función');
select throws_ok(format('update public.anomaly_alerts set fraud_marked_by = %L where id = %L', pruebas.f2(), :'imposible_beto'),
  '42501', null, 'quién marcó el fraude queda fijo');
select pruebas.limpiar();

-- Revertir.
select pruebas.exclusion(pruebas.beto(), pruebas.f2()) as excl_beto \gset
select is(pruebas.o(pruebas.f1(), format('private.revoke_exclusion(%L, %L)', :'excl_beto', 'se revisó')), 'conflict',
  'quien cobra este mes no revierte una exclusión de este mes');
select is(pruebas.excluye(pruebas.f2(), pruebas.f1(), 'test_account'), 'excluded', 'f2 excluye el consumo de f1');
select pruebas.exclusion(pruebas.f1(), pruebas.f2()) as excl_f1 \gset
select is(pruebas.o(pruebas.f1(), format('private.revoke_exclusion(%L, %L)', :'excl_f1', 'no era')), 'self',
  'y f1 no revierte la exclusión de su propia cuenta');
select is(pruebas.o(pruebas.f3(), format('private.revoke_exclusion(%L, %L)', :'excl_beto', 'se revisó')), 'revoked',
  'otra persona que no cobra, sí revierte');

-- ---------------------------------------------------------------------------------------
-- Bonos y ajustes: capturarlos para su propio maestro, no. (No están abiertos al servidor: el dueño.)

select is(pruebas.o_dueno(pruebas.f1(), format('private.capture_bonus(%L, %L, 1000, %s, %L)',
                                               pruebas.maestro('sobre-a'), 'discretionary', pruebas.periodo(), 'bono')),
  'self', 'nadie se captura un bono');
select isnt(pruebas.o_dueno(pruebas.f2(), format('private.capture_bonus(%L, %L, 1000, %s, %L)',
                                                 pruebas.maestro('sobre-a'), 'discretionary', pruebas.periodo(), 'bono')),
  'self', 'otra persona pasa a las demás comprobaciones');
select is(pruebas.o_dueno(pruebas.f1(), format('private.capture_adjustment(%L, %s, 1000, %L)',
                                               pruebas.maestro('sobre-a'), pruebas.periodo(), 'ajuste')),
  'self', 'ni un ajuste');
select is(pruebas.o_dueno(pruebas.f2(), format('private.capture_adjustment(%L, %s, 1000, %L)',
                                               pruebas.maestro('sobre-a'), pruebas.periodo(), 'ajuste')),
  'origin_not_closed', 'otra persona sí llega a las demás comprobaciones');

-- ---------------------------------------------------------------------------------------
-- Capacidades: nadie se da una a sí mismo.

select is(pruebas.pide(pruebas.cf(), format('private.grant_capability(%L, %L)', pruebas.cf(), 'finance')), 'self',
  'configuración no se da finanzas');
select is(pruebas.pide(pruebas.cf(), format('private.grant_capability(%L, %L)', pruebas.f3(), 'support')), 'granted',
  'pero se la da a otra persona del equipo');

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is_empty('select * from private.schema_violations()', 'el vigilante en cero');
-- Una función de finanzas que pierde su comprobación se ve. Va al final: la prueba se revierte entera.
create or replace function private.void_bonus(p_bonus uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$ begin return null; end $$;
select ok(exists (select 1 from private.schema_violations() where problem = 'teachers self rule missing: private.void_bonus(uuid, text)'),
  've una función de finanzas sin su comprobación');

select * from finish();
rollback;
