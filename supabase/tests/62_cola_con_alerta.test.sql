-- T-401 · La cola de las suspensiones por fraude dice de qué alerta sale cada propuesta: con eso, PA-68 sabe cuál
-- propuesta es de cuál alerta, y quien la propuso la retira desde ahí.
begin;
\ir _ayuda.psql
select plan(5);

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
select is_empty('select * from private.schema_violations()', 'el vigilante en cero');

select * from finish();
rollback;
