-- T-401 · La cola de las suspensiones por fraude dice de qué alerta sale cada propuesta: con eso, PA-68 sabe cuál
-- propuesta es de cuál alerta, y quien la propuso la retira desde ahí. Y quien es del equipo y además maestro, sobre sí, solo
-- lee lo que lee cualquier maestro (decisión de Sergio del 2026-10-30): ni el motivo interno, ni una propuesta pendiente.
begin;
\ir _ayuda.psql
select plan(17);

-- kf tiene Contenido y finanzas; f1, finanzas; a1 es alumna; mara es maestra.
select pruebas.alta('c6200000-0000-0000-0000-000000000001', 'kf-62@prueba.test');
select pruebas.alta('c6200000-0000-0000-0000-000000000002', 'f1-62@prueba.test');
select pruebas.alta('c6200000-0000-0000-0000-000000000003', 'a1-62@prueba.test');
select pruebas.alta('a6200000-0000-0000-0000-000000000001', 'mara-62@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-62@prueba.test';
select pruebas.dar_capacidad('c6200000-0000-0000-0000-000000000001', 'content');
select pruebas.dar_capacidad('c6200000-0000-0000-0000-000000000001', 'finance');
select pruebas.dar_capacidad('c6200000-0000-0000-0000-000000000002', 'finance');
select pruebas.equipar(id) from auth.users where email in ('kf-62@prueba.test', 'f1-62@prueba.test');

create function pruebas.kf() returns uuid language sql immutable as $$ select 'c6200000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.f1() returns uuid language sql immutable as $$ select 'c6200000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.a1() returns uuid language sql immutable as $$ select 'c6200000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.mara() returns uuid language sql immutable as $$ select 'a6200000-0000-0000-0000-000000000001'::uuid $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.como_dueno_sistema();
insert into public.teachers (profile_id, status) values (pruebas.mara(), 'active') returning id as mara_m \gset
select private.open_period(private.period_of(clock_timestamp()));
insert into public.anomaly_alerts (period_id, kind, teacher_id, metric_value, threshold_value)
  values (private.period_of(clock_timestamp()), 'teacher_points_jump', :'mara_m', 500, 300) returning id as alerta \gset
select pruebas.limpiar();

select is(pruebas.pide(pruebas.kf(), format('private.review_alert(%L, %L, true, %L)::text', :'alerta', 'revisada', 'evidencia'))::jsonb ->> 'outcome',
  'reviewed', 'kf marca la alerta como fraude');
select is(pruebas.pide(pruebas.f1(), format('private.propose_fraud_suspension(%L, %L)', :'alerta', 'Puntos inflados')), 'proposed',
  'f1 propone');

select is(pruebas.pide(pruebas.f1(), 'private.fraud_suspension_queue()::text')::jsonb -> 'requests' -> 0 ->> 'alert_id', :'alerta',
  'la cola dice de qué alerta sale la propuesta');
select is(pruebas.pide(pruebas.a1(), 'private.fraud_suspension_queue()::text'), null, 'a una alumna no le contesta');
-- ---------------------------------------------------------------------------------------
-- Sobre sí: cm tiene Contenido y además es maestra.

select pruebas.alta('c6200000-0000-0000-0000-000000000004', 'cm-62@prueba.test');
select pruebas.confirmar(id) from auth.users where email = 'cm-62@prueba.test';
select pruebas.dar_capacidad('c6200000-0000-0000-0000-000000000004', 'content');
select pruebas.equipar(id) from auth.users where email = 'cm-62@prueba.test';
create function pruebas.cm() returns uuid language sql immutable as $$ select 'c6200000-0000-0000-0000-000000000004'::uuid $$;
create function pruebas.fila(p_lector uuid, p_teacher uuid) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_lector);
  select t into v from jsonb_array_elements(private.teacher_roster() -> 'teachers') t where t ->> 'teacher_id' = p_teacher::text;
  perform pruebas.limpiar();
  return v;
end
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;
select pruebas.como_dueno_sistema();
insert into public.teachers (profile_id, status) values (pruebas.cm(), 'active') returning id as cm_m \gset
insert into public.anomaly_alerts (period_id, kind, teacher_id, metric_value, threshold_value)
  values (private.period_of(clock_timestamp()), 'teacher_points_jump', :'cm_m', 500, 300) returning id as alerta_cm \gset
select pruebas.limpiar();
select pruebas.pide(pruebas.kf(), format('private.review_alert(%L, %L, true, %L)::text', :'alerta_cm', 'revisada', 'evidencia'));
select is(pruebas.pide(pruebas.f1(), format('private.propose_fraud_suspension(%L, %L)', :'alerta_cm', 'Sobre cm')), 'proposed', 'f1 propone sobre cm');

select is((select count(*) from jsonb_array_elements(pruebas.pide(pruebas.cm(), 'private.fraud_suspension_queue()::text')::jsonb -> 'requests') r
           where r ->> 'teacher_id' = :'cm_m'), 0::bigint, 'cm no ve en la cola la propuesta sobre sí');
select is((select count(*) from jsonb_array_elements(pruebas.pide(pruebas.kf(), 'private.fraud_suspension_queue()::text')::jsonb -> 'requests') r
           where r ->> 'teacher_id' = :'cm_m'), 1::bigint, 'otra persona sí');
select is((pruebas.fila(pruebas.cm(), :'cm_m') ->> 'fraud_pending')::boolean, false, 'y su fila no dice que hay una propuesta');
select is((pruebas.fila(pruebas.kf(), :'cm_m') ->> 'fraud_pending')::boolean, true, 'la de otra persona, sí');

select is(pruebas.pide(pruebas.kf(), format('private.decide_fraud_suspension(%L, true, null, %L)',
  (select r.id from private.teacher_suspension_requests r where r.teacher_id = :'cm_m'), 'Revisamos un caso')), 'proposer',
  'kf marcó la alerta: no confirma');
select pruebas.pide(pruebas.f1(), format('private.withdraw_fraud_suspension(%L)', (select r.id from private.teacher_suspension_requests r where r.teacher_id = :'cm_m')));
select is(pruebas.pide(pruebas.kf(), format('private.suspend_teacher(%L, %L, %L)', :'cm_m', 'Motivo interno', 'Lo que lee')), 'suspended', 'kf la suspende');
select is(pruebas.fila(pruebas.cm(), :'cm_m') ->> 'suspension_reason', null, 'sobre sí, sin el motivo interno');
select is(pruebas.fila(pruebas.cm(), :'cm_m') ->> 'suspension', null, 'ni de qué clase es');
select is(pruebas.fila(pruebas.cm(), :'cm_m') ->> 'suspension_notice', 'Lo que lee', 'y sí lo que lee cualquier maestro');

select is_empty('select * from private.schema_violations()', 'el vigilante en cero');

create or replace function private.fraud_suspension_queue() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin return '{"requests": []}'::jsonb; end $$;
select ok(exists (select 1 from private.schema_violations()
                  where problem = 'teachers self rule missing: private.fraud_suspension_queue()'),
  've a la cola que le lista a alguien la propuesta sobre sí');
create or replace function private.teacher_roster() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin return '{"teachers": []}'::jsonb; end $$;
select ok(exists (select 1 from private.schema_violations()
                  where problem = 'teachers self rule missing: private.teacher_roster()'),
  've a la lista que le da a alguien su motivo interno');

select * from finish();
rollback;
