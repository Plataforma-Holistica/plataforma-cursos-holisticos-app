-- T-401, tercera solicitud · El fundador, la suspensión y el fraude (RF-104, RF-702, RN-12, RN-17, FL-46,
-- FL-64). Esquema §6.2.
--
-- Decisiones de Sergio del 2026-10-29: el fundador lo marca Contenido, sin fecha atrás; suspender lo hace
-- una persona con Contenido, salvo por fraude, que propone finanzas (con una alerta de ese maestro decidida
-- como fraude) y confirma otra persona con Contenido; esa suspensión la levanta alguien con Contenido que
-- no la propuso; y nadie actúa sobre sí, tampoco al aprobar un curso suyo.
begin;
\ir _ayuda.psql
select plan(105);

-- Contenido: k1, k2 y kf (que tiene además finanzas). Finanzas: f1 y f2. Maestros: m1, m2, m3 y m4 con
-- cuenta y activos; mk1 es el maestro de k1 (alguien del equipo puede ser maestro); mi, invitado.
select pruebas.alta('c0000000-0000-0000-0000-000000000001', 'k1@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000002', 'k2@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000003', 'kf@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000004', 'f1@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000005', 'f2@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'm1@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'm2@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000003', 'm3@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000004', 'm4@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000005', 'alumno@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%@prueba.test';
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'content');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000002', 'content');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000003', 'content');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000003', 'finance');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000004', 'finance');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000005', 'finance');
select pruebas.equipar(id) from auth.users where email in
  ('k1@prueba.test', 'k2@prueba.test', 'kf@prueba.test', 'f1@prueba.test', 'f2@prueba.test');

create function pruebas.maestro(p_profile uuid, p_status text default 'active') returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  perform pruebas.como_dueno_sistema();
  insert into public.teachers (profile_id, status) values (p_profile, p_status::public.teacher_status) returning id into v_id;
  perform pruebas.limpiar();
  return v_id;
end
$$;

-- Una alerta de salto de puntos de ese maestro, abierta por el sistema, y decidida por f1. Una por maestro y
-- por periodo: las siguientes de un mismo maestro van a meses anteriores.
create function pruebas.alerta(p_teacher uuid, p_fraud boolean, p_months_back integer default 0) returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(private.period_of(clock_timestamp() - pg_catalog.make_interval(months => p_months_back)));
  insert into public.anomaly_alerts (period_id, kind, teacher_id, metric_value, threshold_value)
  values (private.period_of(clock_timestamp() - pg_catalog.make_interval(months => p_months_back)),
          'teacher_points_jump', p_teacher, 500, 300) returning id into v_id;
  perform pruebas.limpiar();
  perform pruebas.pide('c0000000-0000-0000-0000-000000000004',
    format('private.review_alert(%L, %L, %L, %L)', v_id, 'revisada', p_fraud, case when p_fraud then 'evidencia' end));
  return v_id;
end
$$;

create function pruebas.solicitud(p_teacher uuid) returns uuid
language sql security definer
as $$ select r.id from private.teacher_suspension_requests r where r.teacher_id = p_teacher order by r.proposed_at desc limit 1 $$;

grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.maestro('a0000000-0000-0000-0000-000000000001') as m1 \gset
select pruebas.maestro('a0000000-0000-0000-0000-000000000002') as m2 \gset
select pruebas.maestro('a0000000-0000-0000-0000-000000000003') as m3 \gset
select pruebas.maestro('a0000000-0000-0000-0000-000000000004') as m4 \gset
select pruebas.maestro('c0000000-0000-0000-0000-000000000001') as mk1 \gset
select pruebas.como_dueno_sistema();
select private.system_add_teacher('Invitado', 'invitado-59', null) as mi \gset
select pruebas.limpiar();

-- El mes en curso en la zona del periodo, y los vecinos.
select make_date(private.period_of(clock_timestamp()) / 100, private.period_of(clock_timestamp()) % 100, 1) as mes \gset
select (:'mes'::date - interval '1 month')::date as mes_antes, (:'mes'::date + interval '1 month')::date as mes_despues,
       (:'mes'::date - interval '1 day')::date as dia_antes \gset

-- ---------------------------------------------------------------------------------------
-- Estructura y permisos.

select ok(
  not has_any_column_privilege('app_service', 'private.teacher_suspension_requests', 'select, insert, update')
    and not has_table_privilege('app_service', 'private.teacher_suspension_requests', 'delete')
    and not has_any_column_privilege('authenticated', 'private.teacher_suspension_requests', 'select, insert, update')
    and not has_any_column_privilege('anon', 'private.teacher_suspension_requests', 'select, insert, update'),
  'nadie de la aplicación toca las solicitudes de suspensión');
select ok(
  bool_and(has_function_privilege('app_service', f, 'execute')
           and not has_function_privilege('authenticated', f, 'execute')
           and not has_function_privilege('anon', f, 'execute')
           and not has_function_privilege('service_role', f, 'execute')),
  'las siete funciones del servidor las ejecuta solo el servidor')
from unnest(array[
  'private.set_teacher_founder(uuid, date)',
  'private.suspend_teacher(uuid, text, text)',
  'private.lift_teacher_suspension(uuid)',
  'private.propose_fraud_suspension(uuid, text)',
  'private.withdraw_fraud_suspension(uuid)',
  'private.decide_fraud_suspension(uuid, boolean, text, text)',
  'private.fraud_suspension_queue()']) as f;
select ok(not has_function_privilege('app_service', 'private.teacher_change_lock(uuid)', 'execute'),
  'la interna no la ejecuta el servidor');
select is_empty('select * from private.schema_violations()', 'el vigilante en cero al empezar');

-- ---------------------------------------------------------------------------------------
-- El fundador: Contenido, sin fecha atrás, y fijo una vez que su ventana empezó a cerrarse.

select is(pruebas.pide('a0000000-0000-0000-0000-000000000005', format('private.set_teacher_founder(%L, %L)', :'m1', :'mes')),
  'forbidden', 'un alumno no marca fundador');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.set_teacher_founder(%L, %L)', :'m1', :'mes')),
  'forbidden', 'finanzas tampoco');
select pruebas.sin_codigo('c0000000-0000-0000-0000-000000000001');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.set_teacher_founder(%L, %L)', :'m1', :'mes')),
  'needs_fresh_code', 'Contenido sin código reciente lo da otra vez');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.set_teacher_founder(%L, %L)', gen_random_uuid(), :'mes')),
  'not_found', 'a un maestro que no existe no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.set_teacher_founder(%L, %L)', :'mk1', :'mes')),
  'self', 'nadie se marca fundador a sí mismo');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.set_teacher_founder(%L, %L)', :'m1', :'dia_antes')),
  'too_early', 'el último día del mes anterior es fecha atrás');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.set_teacher_founder(%L, %L)', :'m1', :'mes_antes')),
  'too_early', 'y el mes anterior también');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.set_teacher_founder(%L, null)', :'m1')),
  'unchanged', 'quitar la marca a quien no la tiene no cambia nada');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.set_teacher_founder(%L, %L)', :'m1', :'mes')),
  'set', 'el primer día del mes en curso, sí');
select pruebas.como_dueno();
select results_eq(format('select is_founder, founder_since from public.teachers where id = %L', :'m1'),
  format('values (true, %L::date)', :'mes'), 'queda marcado desde ese día');
select ok(
  exists (select 1 from public.audit_log a
          where a.entity_table = 'public.teachers' and a.entity_id = :'m1' and a.category = 'money'
            and a.actor_id = 'c0000000-0000-0000-0000-000000000001'),
  'la marca queda en la auditoría como dinero');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.set_teacher_founder(%L, %L)', :'m1', :'mes')),
  'unchanged', 'la misma fecha no cambia nada');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.set_teacher_founder(%L, %L)', :'m1', :'mes_despues')),
  'set', 'mientras su mes sigue abierto, la fecha se puede mover');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.set_teacher_founder(%L, null)', :'m1')),
  'cleared', 'y quitar');
select pruebas.como_dueno();
select results_eq(format('select is_founder, founder_since from public.teachers where id = %L', :'m1'),
  $$values (false, null::date)$$, 'sin marca');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.set_teacher_founder(%L, %L)', :'mi', :'mes')),
  'set', 'a un maestro invitado también se le marca');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.set_teacher_founder(%L, %L)', :'m4', (:'mes'::date + interval '6 months')::date)),
  'set', 'y con fecha futura');

-- Un fundador de hace dos meses: su primer mes ya pasó de abierto, así que la marca queda fija.
select pruebas.como_dueno_sistema();
update public.teachers set is_founder = true, founder_since = (:'mes'::date - interval '2 months')::date where id = :'m2';
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.set_teacher_founder(%L, null)', :'m2')),
  'locked', 'no se le quita: nadie alarga la ventana quitando y volviendo a poner');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.set_teacher_founder(%L, %L)', :'m2', :'mes')),
  'locked', 'ni se le mueve la fecha');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.set_teacher_founder(%L, %L)', :'m2', (:'mes'::date - interval '2 months')::date)),
  'unchanged', 'la misma fecha sigue contestando que no cambia');
select pruebas.como_dueno_sistema();
update public.teachers set founder_since = :'mes'::date where id = :'m2';
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.set_teacher_founder(%L, %L)', :'m2', :'mes_despues')),
  'set', 'con su primer mes todavía abierto, se mueve');

-- ---------------------------------------------------------------------------------------
-- Suspender y levantar: una persona con Contenido.

select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.suspend_teacher(%L, %L, %L)', :'m3', 'motivo', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'forbidden', 'finanzas no suspende sola');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.suspend_teacher(%L, %L, %L)', :'m3', '   ', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'invalid', 'sin motivo no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.suspend_teacher(%L, %L, %L)', :'m3', repeat('a', 1001), 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'invalid', 'ni con un motivo de más de mil caracteres');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.suspend_teacher(%L, %L, null)', :'m3', 'motivo')),
  'invalid', 'sin el texto para el maestro no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.suspend_teacher(%L, %L, %L)', :'m3', 'motivo', repeat('a', 301))),
  'invalid', 'ni con uno de más de 300 caracteres');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.suspend_teacher(%L, %L, %L)', :'mk1', 'motivo', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'self', 'nadie se suspende a sí mismo');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.suspend_teacher(%L, %L, %L)', :'mi', 'motivo', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'not_active', 'a un invitado no se le suspende');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.suspend_teacher(%L, %L, %L)', :'m3', '  No entrega lo prometido ', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'suspended', 'suspender');
select pruebas.como_dueno();
select results_eq(
  format($$select status::text, suspended_by, suspension_approved_by, suspension_reason, suspended_at is not null
           from public.teachers where id = %L$$, :'m3'),
  $$values ('suspended', 'c0000000-0000-0000-0000-000000000001'::uuid, null::uuid, 'No entrega lo prometido', true)$$,
  'queda suspendido, con quién y por qué');
select pruebas.a_nombre_de('a0000000-0000-0000-0000-000000000003');
select is((select s.state from private.teacher_standing(null) s), 'suspended', 'y entra al portal en solo lectura');
select pruebas.limpiar();
select pruebas.como_usuario('a0000000-0000-0000-0000-000000000003');
select is((select suspension_notice from public.teachers where id = :'m3'), 'Tu cuenta de maestro está en pausa mientras revisamos un caso.',
  'el maestro lee el texto que se escribió para él');
select throws_ok(format('select suspension_reason from public.teachers where id = %L', :'m3'), '42501', null,
  'pero no el motivo interno');
select throws_ok(format('select suspended_by, suspension_approved_by from public.teachers where id = %L', :'m3'), '42501', null,
  'ni quién lo suspendió');
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.suspend_teacher(%L, %L, %L)', :'m3', 'otra vez', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'already_suspended', 'dos veces no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.lift_teacher_suspension(%L)', :'m1')),
  'not_suspended', 'levantar a quien no está suspendido no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.lift_teacher_suspension(%L)', :'m3')),
  'forbidden', 'finanzas no levanta');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.lift_teacher_suspension(%L)', :'m3')),
  'lifted', 'quien suspendió a mano puede levantar');
select pruebas.como_dueno();
select results_eq(
  format($$select status::text, suspended_by, suspension_reason, suspended_at from public.teachers where id = %L$$, :'m3'),
  $$values ('active', null::uuid, null::text, null::timestamptz)$$,
  'activo de nuevo, sin las columnas de la suspensión');
select ok(
  exists (select 1 from public.audit_log a
          where a.entity_table = 'public.teachers' and a.entity_id = :'m3' and a.category = 'access'
            and a.new_value ->> 'status' = 'suspended' and a.new_value ->> 'suspension_reason' = 'No entrega lo prometido')
  and exists (select 1 from public.audit_log a
              where a.entity_table = 'public.teachers' and a.entity_id = :'m3' and a.category = 'access'
                and a.old_value ->> 'status' = 'suspended' and a.new_value ->> 'status' = 'active'),
  'la historia queda en la auditoría: la suspensión con su motivo, y el levantamiento');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspended_by = 'c0000000-0000-0000-0000-000000000002',
                           suspension_reason = 'prueba'
  where id = :'mk1';
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.lift_teacher_suspension(%L)', :'mk1')),
  'self', 'nadie levanta su propia suspensión');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'active', suspended_at = null, suspended_by = null, suspension_reason = null where id = :'mk1';
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- El fraude: lo propone finanzas con una alerta de ese maestro decidida como fraude, y lo confirma otra
-- persona con Contenido.

select pruebas.alerta(:'m2', true) as alerta_m2 \gset
select pruebas.alerta(:'m4', false) as alerta_sin_fraude \gset
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.propose_fraud_suspension(%L, %L)', :'alerta_m2', 'motivo')),
  'forbidden', 'Contenido no propone');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.propose_fraud_suspension(%L, %L)', :'alerta_sin_fraude', 'motivo')),
  'needs_fraud_decision', 'una alerta que no se decidió como fraude no basta');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.propose_fraud_suspension(%L, %L)', gen_random_uuid(), 'motivo')),
  'needs_fraud_decision', 'ni una que no existe');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.propose_fraud_suspension(%L, %L)', :'alerta_m2', '')),
  'invalid', 'sin motivo no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.propose_fraud_suspension(%L, %L)', :'alerta_m2', 'Puntos inflados con cuentas falsas')),
  'proposed', 'finanzas propone');
select pruebas.solicitud(:'m2') as sol_m2 \gset
select pruebas.como_dueno();
select results_eq(
  format($$select r.status::text, r.proposed_by, r.anomaly_alert_id, r.reason from private.teacher_suspension_requests r where r.id = %L$$, :'sol_m2'),
  format($$values ('pending', 'c0000000-0000-0000-0000-000000000004'::uuid, %L::uuid, 'Puntos inflados con cuentas falsas')$$, :'alerta_m2'),
  'pendiente, de quien la propuso y con su alerta');
select is((select status::text from public.teachers where id = :'m2'), 'active', 'proponer no suspende');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000005', format('private.propose_fraud_suspension(%L, %L)', :'alerta_m2', 'otra')),
  'already_pending', 'una pendiente por maestro');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000005', format('private.withdraw_fraud_suspension(%L)', :'sol_m2')),
  'not_yours', 'solo quien la propuso la retira');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.withdraw_fraud_suspension(%L)', :'sol_m2')),
  'forbidden', 'y Contenido no retira');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.decide_fraud_suspension(%L, true, null, %L)', :'sol_m2', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'forbidden', 'finanzas no confirma');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.withdraw_fraud_suspension(%L)', :'sol_m2')),
  'withdrawn', 'quien la propuso la retira');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.decide_fraud_suspension(%L, true, null, %L)', :'sol_m2', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'not_found', 'una retirada ya no se confirma');

select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.propose_fraud_suspension(%L, %L)', :'alerta_m2', 'Puntos inflados')),
  'proposed', 'se vuelve a proponer');
select pruebas.solicitud(:'m2') as sol_m2 \gset
select pruebas.a_nombre_de('c0000000-0000-0000-0000-000000000001');
select ok(
  (select q -> 'requests' @> format('[{"request_id": "%s", "teacher_id": "%s"}]', :'sol_m2', :'m2')::jsonb
   from private.fraud_suspension_queue() q),
  'Contenido la ve pendiente en la cola de PA-66');
select pruebas.a_nombre_de('a0000000-0000-0000-0000-000000000005');
select is(private.fraud_suspension_queue(), null, 'un alumno no lee la cola');
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.decide_fraud_suspension(%L, true, %L, %L)', :'sol_m2', repeat('a', 4001), 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'invalid', 'una nota de más de 4 000 caracteres no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.decide_fraud_suspension(%L, true, %L, null)', :'sol_m2', 'Confirmado con la evidencia')),
  'invalid', 'confirmar pide el texto para el maestro');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.decide_fraud_suspension(%L, true, %L, %L)', :'sol_m2', 'Confirmado con la evidencia', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'confirmed', 'otra persona con Contenido confirma');
select pruebas.como_dueno();
select results_eq(
  format($$select status::text, suspended_by, suspension_approved_by, suspension_reason, suspension_notice from public.teachers where id = %L$$, :'m2'),
  $$values ('suspended', 'c0000000-0000-0000-0000-000000000004'::uuid, 'c0000000-0000-0000-0000-000000000001'::uuid, 'Puntos inflados',
            'Tu cuenta de maestro está en pausa mientras revisamos un caso.')$$,
  'suspendido con las dos firmas');
select results_eq(
  format($$select r.status::text, r.decided_by, r.decision_note from private.teacher_suspension_requests r where r.id = %L$$, :'sol_m2'),
  $$values ('confirmed', 'c0000000-0000-0000-0000-000000000001'::uuid, 'Confirmado con la evidencia')$$,
  'y la solicitud queda confirmada');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.withdraw_fraud_suspension(%L)', :'sol_m2')),
  'not_found', 'una confirmada ya no se retira');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000005', format('private.propose_fraud_suspension(%L, %L)', :'alerta_m2', 'otra')),
  'already_suspended', 'a quien ya está suspendido por fraude no se le propone otra');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.suspend_teacher(%L, %L, %L)', :'m2', 'a mano', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'already_suspended', 'ni se le suspende a mano encima');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.lift_teacher_suspension(%L)', :'m2')),
  'lifted', 'la levanta alguien con Contenido que no la propuso');

-- Quien propone no confirma, aunque también tenga Contenido; ni levanta lo que propuso.
select pruebas.alerta(:'m4', true, 1) as alerta_m4 \gset
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003', format('private.propose_fraud_suspension(%L, %L)', :'alerta_m4', 'Puntos inflados')),
  'proposed', 'kf, con finanzas y Contenido, propone');
select pruebas.solicitud(:'m4') as sol_m4 \gset
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003', format('private.decide_fraud_suspension(%L, true, null, %L)', :'sol_m4', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'proposer', 'y no confirma lo que propuso');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.decide_fraud_suspension(%L, true, null, %L)', :'sol_m4', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'confirmed', 'k2 confirma');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003', format('private.lift_teacher_suspension(%L)', :'m4')),
  'proposer', 'quien la propuso no la levanta');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.lift_teacher_suspension(%L)', :'m4')),
  'lifted', 'otra persona con Contenido, sí');

-- Nadie propone sobre sí: kf también es maestra.
select pruebas.maestro('c0000000-0000-0000-0000-000000000003') as mkf \gset
select pruebas.alerta(:'mkf', true) as alerta_mkf \gset
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003', format('private.propose_fraud_suspension(%L, %L)', :'alerta_mkf', 'Fraude')),
  'self', 'nadie propone su propia suspensión');

-- Rechazar.
select pruebas.alerta(:'m4', true, 2) as alerta_m4b \gset
select pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.propose_fraud_suspension(%L, %L)', :'alerta_m4b', 'Otra vez'));
select pruebas.solicitud(:'m4') as sol_m4b \gset
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.decide_fraud_suspension(%L, false, %L, null)', :'sol_m4b', 'La evidencia no alcanza')),
  'rejected', 'Contenido rechaza');
select pruebas.como_dueno();
select is((select status::text from public.teachers where id = :'m4'), 'active', 'y el maestro sigue activo');

-- Confirmar sobre una suspensión a mano: se convierte en la de fraude, con las dos firmas.
select pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.suspend_teacher(%L, %L, %L)', :'m4', 'a mano', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.'));
select pruebas.como_dueno();
select suspended_at as suspendido_a_mano from public.teachers where id = :'m4' \gset
select pruebas.alerta(:'m4', true, 3) as alerta_m4c \gset
select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.propose_fraud_suspension(%L, %L)', :'alerta_m4c', 'Fraude')),
  'proposed', 'a un suspendido a mano se le propone fraude');
select pruebas.solicitud(:'m4') as sol_m4c \gset
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.decide_fraud_suspension(%L, true, null, %L)', :'sol_m4c', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'confirmed', 'y se confirma');
select pruebas.como_dueno();
select results_eq(
  format($$select status::text, suspended_by, suspension_approved_by, suspension_reason, suspended_at from public.teachers where id = %L$$, :'m4'),
  format($$values ('suspended', 'c0000000-0000-0000-0000-000000000004'::uuid, 'c0000000-0000-0000-0000-000000000002'::uuid, 'Fraude', %L::timestamptz)$$, :'suspendido_a_mano'),
  'queda como la de fraude, desde que se suspendió a mano');

-- El maestro mismo no confirma lo suyo.
select pruebas.alerta(:'mk1', true) as alerta_mk1 \gset
select pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.propose_fraud_suspension(%L, %L)', :'alerta_mk1', 'Fraude'));
select pruebas.solicitud(:'mk1') as sol_mk1 \gset
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.decide_fraud_suspension(%L, true, null, %L)', :'sol_mk1', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'self', 'nadie confirma una propuesta sobre sí');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.decide_fraud_suspension(%L, false, null, null)', :'sol_mk1')),
  'rejected', 'otra persona rechaza sin nota');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.propose_fraud_suspension(%L, %L)', :'alerta_m2', 'Otra')),
  'alert_used', 'una alerta que ya sostuvo una suspensión confirmada no sirve otra vez');
select pruebas.alerta(:'m2', true, 1) as alerta_m2b \gset
select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.propose_fraud_suspension(%L, %L)', :'alerta_m2b', 'Otra')),
  'proposed', 'con una alerta nueva, sí');
select pruebas.solicitud(:'m2') as sol_m2b \gset
select pruebas.como_dueno_sistema();
update public.teachers set status = 'left', left_at = now() where id = :'m2';
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.decide_fraud_suspension(%L, true, null, %L)', :'sol_m2b', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.')),
  'not_active', 'a quien se fue no se le suspende');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000004', format('private.propose_fraud_suspension(%L, %L)', :'alerta_m4c', 'Otra')),
  'already_suspended', 'ni se propone sobre quien ya está suspendido por fraude');

-- ---------------------------------------------------------------------------------------
-- Aprobar un curso propio: nunca.

select pruebas.como_dueno_sistema();
insert into public.course_registry (teacher_id, state) values (:'mk1', 'in_review') returning course_id as curso_k1 \gset
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.approve_course(%L)', :'curso_k1')),
  'self', 'quien es maestro del curso no lo aprueba');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.approve_course(%L)', :'curso_k1')),
  'incomplete', 'otra persona con Contenido sigue al resto de las comprobaciones');
select pruebas.como_dueno_sistema();
insert into public.course_registry (teacher_id) values (:'mk1') returning course_id as borrador_k1 \gset
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.approve_course(%L)', :'borrador_k1')),
  'not_pending', 'un curso suyo que no está en revisión dice eso primero');

-- ---------------------------------------------------------------------------------------
-- La lista de PA-65 dice la suspensión y si hay una propuesta pendiente.

select pruebas.a_nombre_de('c0000000-0000-0000-0000-000000000001');
select private.teacher_roster() as lista \gset
select pruebas.limpiar();
select is(
  (select t ->> 'suspension' from jsonb_array_elements(:'lista'::jsonb -> 'teachers') t where t ->> 'teacher_id' = :'m4'),
  'fraud', 'una suspensión con dos firmas es de fraude');
select is(
  (select t ->> 'suspension' from jsonb_array_elements(:'lista'::jsonb -> 'teachers') t where t ->> 'teacher_id' = :'m1'),
  null, 'un activo sin suspensión');
select is(
  (select (t ->> 'fraud_pending')::boolean from jsonb_array_elements(:'lista'::jsonb -> 'teachers') t where t ->> 'teacher_id' = :'m2'),
  true, 'y si tiene una propuesta pendiente');
select pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.suspend_teacher(%L, %L, %L)', :'m3', 'a mano', 'Tu cuenta de maestro está en pausa mientras revisamos un caso.'));
select pruebas.a_nombre_de('c0000000-0000-0000-0000-000000000001');
select is(
  (select t ->> 'suspension' from jsonb_array_elements(private.teacher_roster() -> 'teachers') t where t ->> 'teacher_id' = :'m3'),
  'manual', 'una suspensión de una persona es a mano');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is_empty('select * from private.schema_violations()', 'en cero después de todo');
grant select on private.teacher_suspension_requests to app_service;
select ok(exists (select 1 from private.schema_violations()
                  where object_name = 'private.teacher_suspension_requests' and problem like 'teachers table privilege for%'),
  've un permiso sobre las solicitudes');
revoke select on private.teacher_suspension_requests from app_service;
grant execute on function private.teacher_change_lock(uuid) to app_service;
select ok(exists (select 1 from private.schema_violations() where object_name like 'private.teacher_change_lock%'),
  've la interna que el servidor ejecuta');
revoke execute on function private.teacher_change_lock(uuid) from app_service;
alter table private.teacher_suspension_requests disable trigger audit_changes;
select ok(exists (select 1 from private.schema_violations() where object_name = 'private.teacher_suspension_requests'),
  've la auditoría de las solicitudes apagada');
alter table private.teacher_suspension_requests enable trigger audit_changes;
alter table public.teachers disable trigger audit_founder;
select ok(exists (select 1 from private.schema_violations() where problem like '%audit_founder%'),
  've la auditoría del fundador apagada');
alter table public.teachers enable trigger audit_founder;
drop trigger audit_founder on public.teachers;
create trigger audit_founder after update of is_founder, founder_since on public.teachers
  for each row execute function private.audit_row_change('access', 'tiebreak_rank');
select ok(exists (select 1 from private.schema_violations() where problem = 'teachers founder audit not as money after update'),
  've la auditoría del fundador como acceso en vez de dinero');
drop trigger audit_founder on public.teachers;
create trigger audit_founder after update of is_founder, founder_since on public.teachers
  for each row when (old.is_founder is distinct from new.is_founder or old.founder_since is distinct from new.founder_since)
  execute function private.audit_row_change('money', 'tiebreak_rank');
grant select (suspension_reason) on public.teachers to authenticated;
select ok(exists (select 1 from private.schema_violations()
                  where problem = 'teachers suspension column readable by authenticated: suspension_reason'),
  've que el maestro podría leer el motivo interno');
revoke select (suspension_reason) on public.teachers from authenticated;
grant update (founder_since) on public.teachers to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'teachers table writable by app_service'),
  've que el servidor podría escribir la fecha del fundador');
revoke update (founder_since) on public.teachers from app_service;
drop index private.teacher_suspension_requests_one_pending_uq;
select ok(exists (select 1 from private.schema_violations()
                  where problem = 'teachers unique index missing: teacher_suspension_requests_one_pending_uq'),
  've que falta el índice de una pendiente por maestro');
create unique index teacher_suspension_requests_one_pending_uq on private.teacher_suspension_requests (teacher_id)
  where status = 'pending';
drop index private.teacher_suspension_requests_alert_uq;
select ok(exists (select 1 from private.schema_violations()
                  where problem = 'teachers unique index missing: teacher_suspension_requests_alert_uq'),
  've que falta el índice de una alerta por suspensión');
create unique index teacher_suspension_requests_alert_uq on private.teacher_suspension_requests (anomaly_alert_id)
  where status in ('pending', 'confirmed');
select is_empty('select * from private.schema_violations()', 'en cero al restaurar');

select * from finish();
rollback;
