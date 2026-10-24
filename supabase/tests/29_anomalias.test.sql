-- T-208 · Alertas de anomalía (RF-406, RN-17; 05 §5.4 y §8.2 paso 7). Decisiones de Sergio del
-- 2026-10-21: la alerta de lecciones imposibles es una red de seguridad, tal cual el PRD; la de
-- salto de puntos compara el mes terminado contra el anterior, con un piso de puntos en el mes de
-- comparación. La del bote sin consumo espera al bote (T-407).
--
-- La corrida de cada noche detecta al final de cada periodo de la ventana
-- (`private.detect_anomalies()`, aquí con la hora explícita) y abre una alerta una sola vez por
-- periodo, tipo y sujeto. Finanzas la revisa con una nota, y la decide como fraude con evidencia
-- escrita; solo entonces se puede excluir por fraude el consumo de quien la provocó.
--
-- El consolidado se escribe aquí directo, como el dueño: lo que se prueba es la detección.
begin;
\ir _ayuda.psql
select plan(58);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana-anomalia@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto-anomalia@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000003', 'carla-anomalia@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido-anomalia@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000002', 'finanzas-anomalia@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-anomalia@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000002', 'finance');
select pruebas.equipar('b0000000-0000-0000-0000-000000000002');

create function pruebas.ana() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.beto() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.carla() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b0000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.periodo(p_months_back integer default 0) returns integer
language sql stable as $$
  select to_char(date_trunc('month', timezone('America/Mexico_City', now())) - make_interval(months => p_months_back), 'YYYYMM')::integer
$$;
-- El inicio de un periodo: el día 1 a las 00:00 en la zona del periodo.
create function pruebas.inicio(p_period integer) returns timestamptz
language sql stable as $$ select timezone('America/Mexico_City', to_date(p_period::text || '01', 'YYYYMMDD')::timestamp) $$;
create function pruebas.leccion(p_course text, p_title text) returns uuid
language sql as $$
  select l.id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id
  where c.slug = p_course and l.title = p_title
$$;
create function pruebas.maestro(p_course text) returns uuid
language sql as $$ select teacher_id from public.published_courses where slug = p_course $$;
-- Una fila del consolidado, escrita como el dueño.
create function pruebas.fila(p_period integer, p_profile uuid, p_lesson uuid, p_covered integer, p_half_points integer) returns void
language sql as $$
  insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                   lesson_duration_seconds, covered_seconds, half_points)
  select p_period, p_profile, l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, p_covered, p_half_points
  from public.published_lessons l where l.id = p_lesson
$$;
-- Lecciones completas de una cuenta con un maestro en un periodo: las primeras `n` de su curso.
create function pruebas.completas(p_period integer, p_profile uuid, p_course text, p_n integer) returns void
language sql as $$
  select pruebas.fila(p_period, p_profile, pruebas.leccion(p_course, t), 100, 2)
  from unnest((array['Uno', 'Dos', 'Tres'])[1:p_n]) as t
$$;
create function pruebas.detecta(p_period integer, p_now timestamptz) returns jsonb
language sql as $$
  select private.detect_anomalies(p_period, p_now)
$$;
create function pruebas.alerta(p_period integer, p_kind text, p_subject uuid) returns public.anomaly_alerts
language sql as $$
  select * from public.anomaly_alerts where period_id = p_period and kind = p_kind::public.anomaly_kind
    and coalesce(profile_id, teacher_id) = p_subject
$$;
create function pruebas.revisa(p_actor uuid, p_alert uuid, p_note text, p_fraud boolean default null, p_evidence text default null) returns text
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_actor);
  select private.review_alert(p_alert, p_note, p_fraud, p_evidence) into v;
  perform pruebas.limpiar();
  return v ->> 'outcome';
end
$$;
create function pruebas.excluye(p_actor uuid, p_profile uuid, p_period integer, p_alert uuid) returns text
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_actor);
  select private.exclude_consumption('account', p_period, p_profile, null, null, null, null, 'fraud',
                                     'Cuentas creadas para inflar los puntos.', p_alert) into v;
  perform pruebas.limpiar();
  return v ->> 'outcome';
end
$$;
create function pruebas.excluye_con(p_actor uuid, p_scope text, p_profile uuid, p_period integer, p_lesson uuid,
                                    p_reason_code text, p_alert uuid) returns text
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_actor);
  select private.exclude_consumption(p_scope::public.exclusion_scope, p_period, p_profile, null, p_lesson,
                                     case when p_scope = 'interval' then 0 end, case when p_scope = 'interval' then 10 end,
                                     p_reason_code, 'Una prueba.', p_alert) into v;
  perform pruebas.limpiar();
  return v ->> 'outcome';
end
$$;
create function pruebas.curso(p_slug text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', (
      select jsonb_agg(jsonb_build_object('title', t, 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'Asset' || p_slug || n, 'playback_id', 'Playback' || p_slug || n, 'duration_seconds', 100)) order by n)
      from unnest(array['Uno', 'Dos', 'Tres']) with ordinality as l (t, n)))))
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra ' || s, 'maestra-' || s, null), pruebas.curso(s))
from unnest(array['anomalia-a', 'anomalia-b', 'anomalia-c']) as s;
select pruebas.limpiar();
select is(pruebas.pide('b0000000-0000-0000-0000-000000000001', format('private.approve_course(%L)', course_id)), 'approved',
  'se aprueba ' || slug) from public.published_courses where slug like 'anomalia-%';
select pruebas.como_dueno();
create temporary table r (name text primary key, id uuid);
grant select, insert on r to app_service, authenticated;
-- El piso del salto, más bajo que el de arranque, para no necesitar decenas de cuentas.
alter table public.business_parameters disable trigger user;
insert into public.business_parameters (key, value, status, effective_from)
values ('ALERTA_SALTO_MINIMO_MEDIOS_PUNTOS', '5', 'proposed', now() - interval '1 second');
-- Los meses de prueba pueden ser anteriores al arranque (202610): la velocidad máxima rige desde
-- el más viejo.
insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
values ('VELOCIDAD_MAX', '"2"', 'decided', now() - interval '2 seconds', pruebas.periodo(2));

-- ---------------------------------------------------------------------------------------
-- Quién la corre: el dueño de la base, en la corrida. El parámetro del piso existe.

select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) r
                      where has_function_privilege(r, 'private.detect_anomalies(public.period_id, timestamptz)', 'execute')),
  'detectar, nadie de la aplicación');
select ok(has_function_privilege('app_service', 'private.review_alert(uuid, text, boolean, text)', 'execute')
          and not has_function_privilege('authenticated', 'private.review_alert(uuid, text, boolean, text)', 'execute'),
  'revisar, solo el servidor');
select is((select row(value_type, affects_payout, group_name)::text from public.parameter_definitions
           where key = 'ALERTA_SALTO_MINIMO_MEDIOS_PUNTOS'), '(integer,f,measurement)', 'el piso del salto es un parámetro entero que no afecta al reparto');

-- ---------------------------------------------------------------------------------------
-- Lecciones imposibles: las terminadas, a la velocidad máxima, piden más tiempo que el que pasó.

select pruebas.completas(pruebas.periodo(), pruebas.ana(), 'anomalia-a', 3);           -- 300 s, a 2x: 150 s
select pruebas.fila(pruebas.periodo(), pruebas.ana(), pruebas.leccion('anomalia-b', 'Uno'), 100, 1);   -- a medias: no cuenta
select pruebas.completas(pruebas.periodo(), pruebas.beto(), 'anomalia-a', 1);          -- 100 s, a 2x: 50 s

select is(pruebas.detecta(pruebas.periodo(), pruebas.inicio(pruebas.periodo()) - interval '1 minute') ->> 'alerts_opened', '0',
  'antes de empezar el periodo no se evalúa');
select is(pruebas.detecta(pruebas.periodo(), pruebas.inicio(pruebas.periodo()) + interval '150 seconds') ->> 'alerts_opened', '0',
  'con justo el tiempo que necesitan, no hay alerta');
select is(pruebas.detecta(pruebas.periodo(), pruebas.inicio(pruebas.periodo()) + interval '149 seconds') ->> 'alerts_opened', '1',
  'con un segundo menos, se abre una');
select is((select row(metric_value::integer, threshold_value::integer, status, is_fraud)::text
           from pruebas.alerta(pruebas.periodo(), 'impossible_completion', pruebas.ana())), '(150,149,open,)',
  'de Ana: lo que necesitaba y el tiempo que había pasado');
select is((select details -> 'lessons' from pruebas.alerta(pruebas.periodo(), 'impossible_completion', pruebas.ana())), '3'::jsonb,
  'con cuántas lecciones terminadas, sin la que va a medias');
select is(pruebas.alerta(pruebas.periodo(), 'impossible_completion', pruebas.beto()), null, 'Beto, no');
select is(pruebas.detecta(pruebas.periodo(), pruebas.inicio(pruebas.periodo()) + interval '149 seconds') ->> 'alerts_opened', '0',
  'detectar otra vez no abre otra para lo mismo');
select is((select count(*)::integer from public.anomaly_alerts where kind = 'impossible_completion'), 1, 'sigue habiendo una');
select ok(exists (select 1 from public.audit_log where entity_table = 'public.anomaly_alerts' and actor_kind = 'system' and category = 'money'),
  'la abrió el sistema, y queda en la auditoría');
select is(pruebas.alerta(pruebas.periodo(), 'teacher_points_jump', pruebas.maestro('anomalia-a')), null,
  'en el mes en curso no se compara el salto de puntos');

-- ---------------------------------------------------------------------------------------
-- Salto de puntos: el mes terminado contra el que le precede, con piso (aquí, 5 medios puntos).

select pruebas.completas(pruebas.periodo(2), pruebas.ana(), 'anomalia-a', 3);           -- A: 6
select pruebas.completas(pruebas.periodo(1), pruebas.ana(), 'anomalia-a', 3);
select pruebas.completas(pruebas.periodo(1), pruebas.beto(), 'anomalia-a', 2);          -- A: 10, sube 66 %
select pruebas.completas(pruebas.periodo(2), pruebas.ana(), 'anomalia-b', 2);           -- B: 4, bajo el piso
select pruebas.completas(pruebas.periodo(1), pruebas.ana(), 'anomalia-b', 3);
select pruebas.completas(pruebas.periodo(1), pruebas.beto(), 'anomalia-b', 2);          -- B: 10
select pruebas.completas(pruebas.periodo(2), pruebas.ana(), 'anomalia-c', 3);           -- C: 6
select pruebas.completas(pruebas.periodo(1), pruebas.ana(), 'anomalia-c', 3);
select pruebas.completas(pruebas.periodo(1), pruebas.beto(), 'anomalia-c', 1);
select pruebas.fila(pruebas.periodo(1), pruebas.carla(), pruebas.leccion('anomalia-c', 'Uno'), 50, 1);   -- C: 9, sube justo 50 %

select is(pruebas.detecta(pruebas.periodo(1), now()) ->> 'alerts_opened', '1', 'en el mes terminado se abre una');
select isnt(pruebas.alerta(pruebas.periodo(1), 'teacher_points_jump', pruebas.maestro('anomalia-a')), null,
  'de la maestra A, que subió más del 50 %');
select is(pruebas.alerta(pruebas.periodo(1), 'teacher_points_jump', pruebas.maestro('anomalia-b')), null,
  'no de B: venía de menos que el piso');
select is(pruebas.alerta(pruebas.periodo(1), 'teacher_points_jump', pruebas.maestro('anomalia-c')), null,
  'ni de C: subió justo el 50 %, no más');
select is((select row(round(metric_value), threshold_value)::text
           from pruebas.alerta(pruebas.periodo(1), 'teacher_points_jump', pruebas.maestro('anomalia-a'))), '(6667,5000)',
  'el salto en puntos base y el umbral de hoy');
select is((select details - 'floor' from pruebas.alerta(pruebas.periodo(1), 'teacher_points_jump', pruebas.maestro('anomalia-a'))),
  '{"before": 6, "after": 10, "students_before": 1, "students_after": 2}'::jsonb, 'con las cifras de los dos meses, sin nadie con nombre');

-- Un periodo que ya no recibe latidos no se detecta, aunque tenga lecciones imposibles.
select is(pruebas.detecta(pruebas.periodo(2), pruebas.inicio(pruebas.periodo(2)) + interval '10 seconds') ->> 'alerts_opened', '0',
  'fuera de la ventana no se detecta');
select is((select count(*)::integer from public.anomaly_alerts where period_id = pruebas.periodo(2)), 0, 'ni queda nada de ese periodo');

-- En el mes en curso no se compara, aunque haya un salto: va a medias.
select pruebas.completas(pruebas.periodo(), p, 'anomalia-c', 3) from unnest(array[pruebas.ana(), pruebas.beto(), pruebas.carla()]) as p;
select pruebas.detecta(pruebas.periodo(), now());
select is((select count(*)::integer from public.anomaly_alerts where period_id = pruebas.periodo() and kind = 'teacher_points_jump'), 0,
  'C sube del mes terminado al en curso, y no hay alerta del mes en curso');

-- Sin el umbral o sin el piso no se adivina: la detección falla y la corrida lo dirá.
update public.business_parameters set canceled_at = now(), canceled_by = pruebas.finanzas() where key = 'ALERTA_SALTO_MINIMO_MEDIOS_PUNTOS';
select throws_ok(format('select private.detect_anomalies(%s, now())', pruebas.periodo(1)), 'P0001', null,
  'sin el piso, la detección del salto falla');

-- ---------------------------------------------------------------------------------------
-- Las alertas solo las escribe la detección, y cambian solo con la revisión de finanzas.

select throws_ok(format('insert into public.anomaly_alerts (period_id, kind, profile_id, metric_value, threshold_value) values (%s, %L, %L, 1, 1)',
  pruebas.periodo(), 'impossible_completion', pruebas.beto()), '42501', null, 'nadie abre una alerta a mano');
-- Como el dueño y con alguien que actúa, para que no lo detenga antes la auditoría.
create function pruebas.dueno_a_nombre_de(p_id uuid) returns void
language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', p_id::text, true), set_config('app.actor_session', pruebas.sesion(p_id)::text, true);
$$;
select pruebas.dueno_a_nombre_de(pruebas.ana());
select throws_ok(format('insert into public.anomaly_alerts (period_id, kind, profile_id, metric_value, threshold_value) values (%s, %L, %L, 1, 1)',
  pruebas.periodo(), 'impossible_completion', pruebas.carla()), '42501', null, 'ni con alguien que actúa: solo la detección abre alertas');
select pruebas.dueno_a_nombre_de(pruebas.finanzas());
select throws_ok(format('update public.anomaly_alerts set metric_value = 0 where kind = %L', 'impossible_completion'),
  '42501', null, 'ni finanzas le cambia la medida');
select throws_ok('delete from public.anomaly_alerts', '42501', null, 'ni la borra');
select throws_ok('truncate public.anomaly_alerts cascade', '42501', null, 'ni las vacía');
select pruebas.limpiar();

insert into r select 'imposible', id from pruebas.alerta(pruebas.periodo(), 'impossible_completion', pruebas.ana());
insert into r select 'salto', id from pruebas.alerta(pruebas.periodo(1), 'teacher_points_jump', pruebas.maestro('anomalia-a'));

select is(pruebas.revisa(pruebas.ana(), (select id from r where name = 'imposible'), 'Nada raro.'), 'forbidden', 'una alumna no revisa');
select is(pruebas.revisa(pruebas.finanzas(), (select id from r where name = 'imposible'), '  '), 'malformed', 'sin nota, no');
select is(pruebas.revisa(pruebas.finanzas(), (select id from r where name = 'imposible'), 'Cuentas raras.', true), 'malformed',
  'fraude sin evidencia, no');
select is(pruebas.revisa(pruebas.finanzas(), gen_random_uuid(), 'Nada.'), 'not_found', 'una que no existe');
select is(pruebas.excluye(pruebas.finanzas(), pruebas.ana(), pruebas.periodo(), (select id from r where name = 'imposible')),
  'needs_fraud_decision', 'sin decidirla como fraude, no se excluye por fraude');
select is(pruebas.revisa(pruebas.finanzas(), (select id from r where name = 'imposible'), 'Lo revisé con el otro socio.'), 'reviewed',
  'se revisa con una nota');
select is((select row(status, reviewed_by, review_note)::text from public.anomaly_alerts where id = (select id from r where name = 'imposible')),
  row('reviewed', pruebas.finanzas(), 'Lo revisé con el otro socio.')::text, 'queda revisada, con quién y la nota');
select is(pruebas.revisa(pruebas.finanzas(), (select id from r where name = 'imposible'), 'Otra nota.'), 'already_reviewed', 'una sola vez');
select is(pruebas.revisa(pruebas.finanzas(), (select id from r where name = 'imposible'), 'Ya respondió.', true,
  'Doce lecciones terminadas en diez minutos desde una cuenta de un día.'), 'marked_fraud',
  'después de revisarla, todavía se puede decidir como fraude, con evidencia');
select is((select row(is_fraud, review_note)::text from public.anomaly_alerts where id = (select id from r where name = 'imposible')),
  '(t,"Lo revisé con el otro socio.")', 'la nota de la revisión se queda');
select is(pruebas.revisa(pruebas.finanzas(), (select id from r where name = 'imposible'), 'No era.', false), 'already_reviewed',
  'y una decisión de fraude no se deshace');
select pruebas.dueno_a_nombre_de(pruebas.finanzas());
select throws_ok(format('update public.anomaly_alerts set is_fraud = false where id = %L', (select id from r where name = 'imposible')),
  '42501', null, 'ni por fuera de la función');
select pruebas.limpiar();
select ok((select count(*) from public.audit_log where entity_table = 'public.anomaly_alerts' and actor_kind = 'user'
           and entity_id = (select id from r where name = 'imposible')::text) = 2, 'cada decisión queda en la auditoría');

-- ---------------------------------------------------------------------------------------
-- Excluir por fraude: con la alerta decidida, del mismo periodo, y de quien la provocó.

select is(pruebas.excluye(pruebas.finanzas(), pruebas.beto(), pruebas.periodo(), (select id from r where name = 'imposible')),
  'not_related', 'no a otra cuenta que la de la alerta');
select is(pruebas.excluye(pruebas.finanzas(), pruebas.ana(), pruebas.periodo(1), (select id from r where name = 'imposible')),
  'needs_fraud_decision', 'ni en otro periodo que el de la alerta');
select is(pruebas.excluye_con(pruebas.finanzas(), 'account', pruebas.ana(), pruebas.periodo(), null, 'other', null),
  'excluded', 'antes, una exclusión de la cuenta por otra causa');
select is(pruebas.excluye(pruebas.finanzas(), pruebas.ana(), pruebas.periodo(), (select id from r where name = 'imposible')),
  'excluded', 'que no impide la de fraude: a Ana, en su periodo, sí');
select is((select anomaly_alert_id from public.consumption_exclusions where reason_code = 'fraud' and profile_id = pruebas.ana()),
  (select id from r where name = 'imposible'), 'ligada a la alerta');
select is(pruebas.revisa(pruebas.finanzas(), (select id from r where name = 'salto'), 'Dos cuentas nuevas sostienen el salto.', true,
  'Las dos cuentas se crearon el mismo día y solo ven a esta maestra.'), 'reviewed', 'el salto de la maestra A, decidido como fraude');
select is(pruebas.excluye(pruebas.finanzas(), pruebas.carla(), pruebas.periodo(1), (select id from r where name = 'salto')),
  'not_related', 'del salto, no a quien no vio a esa maestra');
select is(pruebas.excluye_con(pruebas.finanzas(), 'interval', pruebas.beto(), pruebas.periodo(1), pruebas.leccion('anomalia-c', 'Uno'),
  'fraud', (select id from r where name = 'salto')), 'not_related', 'del salto, no un tramo de otro maestro');
select is(pruebas.excluye(pruebas.finanzas(), pruebas.beto(), pruebas.periodo(1), (select id from r where name = 'salto')),
  'excluded', 'a quien sí la vio en ese periodo, sí');

-- ---------------------------------------------------------------------------------------
-- El vigilante: su área está y avisa.

select ok(exists (select 1 from private.watchdog_areas() where function_name = 'schema_violations_anomalies' and unusable_reason is null),
  'el área de las anomalías está');
grant select on public.anomaly_alerts to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'anomalies table reachable by app_service'
                  and object_name = 'public.anomaly_alerts'), 'avisa si alguien le deja al servidor leer las alertas');
revoke select on public.anomaly_alerts from app_service;
grant update (suspended_for_fraud) on public.profiles to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'suspended_for_fraud writable by app_service'),
  'o prender la marca de fraude');
revoke update (suspended_for_fraud) on public.profiles from app_service;
grant execute on function private.review_alert(uuid, text, boolean, text) to authenticated;
select ok(exists (select 1 from private.schema_violations() where problem = 'finance function executable by authenticated'),
  'o le deja a una persona decidir por finanzas');
revoke execute on function private.review_alert(uuid, text, boolean, text) from authenticated;
-- Los disparadores de los parámetros, otra vez prendidos: el vigilante de los periodos los mira (T-601).
alter table public.business_parameters enable trigger user;
select is((select count(*)::integer from private.schema_violations()), 0, 'sin nada concedido, nada');

select * from finish();
rollback;
