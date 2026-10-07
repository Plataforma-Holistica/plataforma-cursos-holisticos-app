-- T-103 · Parámetros de negocio con vigencia (RF-707): cambiar un parámetro deja rastro,
-- el valor anterior no se pierde y solo lo cambia quien tiene configuración.
begin;
\ir _ayuda.psql
select plan(36);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana@prueba.test');      -- alumna
select pruebas.alta('c0000000-0000-0000-0000-000000000001', 'config1@prueba.test');  -- configuración
select pruebas.alta('c0000000-0000-0000-0000-000000000002', 'config2@prueba.test');  -- configuración
select pruebas.alta('f0000000-0000-0000-0000-000000000001', 'finanzas@prueba.test'); -- finanzas
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000002', 'config');
select pruebas.dar_capacidad('f0000000-0000-0000-0000-000000000001', 'finance');

-- ---------------------------------------------------------------------------------------
-- La semilla: cada parámetro definido tiene un valor vigente, del tipo que dice su definición.
select cmp_ok(
  (select count(*)::int from public.parameter_definitions), '>=', 56,
  'están las definiciones de los parámetros de 00-fundamentos.md');
select is_empty(
  $$select d.key from public.parameter_definitions d
    where private.parameter_value(d.key) is null$$,
  'tras la semilla, todo parámetro definido tiene un valor vigente');
select is_empty(
  $$select b.key from public.business_parameters b where b.changed_by is not null$$,
  'los valores de arranque no tienen autor: los cargó el sistema');

-- El valor de arranque, para comparar. Queda en una variable de psql.
select private.parameter_value('GRACIA_COBRO_DIAS') as gracia_inicial \gset

-- ---------------------------------------------------------------------------------------
-- Cambiar un parámetro: lo hace el servidor a nombre de alguien con configuración.
select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001');
select set_config('app.reason', 'Prueba de cambio', true);
select lives_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('GRACIA_COBRO_DIAS', '10', 'proposed', now() + interval '1 day')$$,
  'configuración programa un cambio de parámetro');

select results_eq(
  $$select value, previous_value, changed_by, changed_at = now()
    from public.business_parameters
    where key = 'GRACIA_COBRO_DIAS' and effective_from > now()$$,
  format($$values ('10'::jsonb, %L::jsonb, 'c0000000-0000-0000-0000-000000000001'::uuid, true)$$,
         :'gracia_inicial'),
  'la fila guarda el valor nuevo, el anterior, quién y cuándo');

-- Deja rastro (la verificación de T-103).
select pruebas.como_dueno();
select results_eq(
  $$select actor_id, actor_kind, category::text, action, entity_table, reason,
           new_value ->> 'key', new_value -> 'value', new_value -> 'previous_value'
    from public.audit_log order by id desc limit 1$$,
  format($$values ('c0000000-0000-0000-0000-000000000001'::uuid, 'user', 'config',
                   'business_parameters.insert', 'public.business_parameters', 'Prueba de cambio',
                   'GRACIA_COBRO_DIAS', '10'::jsonb, %L::jsonb)$$, :'gracia_inicial'),
  'cambiar un parámetro deja un renglón de auditoría con quién, qué, y el valor anterior y el nuevo');

-- Vigencia: el cambio rige desde su fecha, no antes.
select is(
  private.parameter_value('GRACIA_COBRO_DIAS'), :'gracia_inicial'::jsonb,
  'hoy sigue vigente el valor anterior');
select is(
  private.parameter_value('GRACIA_COBRO_DIAS', now() + interval '2 days'), '10'::jsonb,
  'pasado mañana rige el nuevo');

-- El valor no se edita ni se borra: un error se corrige con una fila nueva.
select throws_ok(
  $$update public.business_parameters set value = '99' where key = 'GRACIA_COBRO_DIAS'$$,
  '42501', null, 'ni el dueño de la tabla edita el valor de un parámetro');
select throws_ok(
  $$delete from public.business_parameters where key = 'GRACIA_COBRO_DIAS'$$,
  '42501', null, 'ni lo borra');
select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$update public.business_parameters set value = '99' where key = 'GRACIA_COBRO_DIAS'$$,
  '42501', null, 'el servidor tampoco edita el valor');

-- Un cambio programado se cancela, una sola vez.
select lives_ok(
  $$update public.business_parameters
    set canceled_at = now(), canceled_by = 'c0000000-0000-0000-0000-000000000001'
    where key = 'GRACIA_COBRO_DIAS' and effective_from > now()$$,
  'un cambio programado se puede cancelar');
select pruebas.como_dueno();
select is(
  private.parameter_value('GRACIA_COBRO_DIAS', now() + interval '2 days'), :'gracia_inicial'::jsonb,
  'cancelado, vuelve a regir el valor anterior');
select is(
  (select action from public.audit_log order by id desc limit 1), 'business_parameters.update',
  'la cancelación también deja rastro');
select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$update public.business_parameters set canceled_at = now() + interval '1 hour'
    where key = 'GRACIA_COBRO_DIAS' and effective_from > now()$$,
  '42501', null, 'una cancelación no se reescribe');

-- ---------------------------------------------------------------------------------------
-- Quién puede: solo configuración, con segundo factor, y siempre por el servidor.
select pruebas.como_servicio('f0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('GRACIA_COBRO_DIAS', '11', 'proposed', now() + interval '3 days')$$,
  '42501', null, 'finanzas no puede cambiar un parámetro');

select pruebas.como_servicio('a0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('GRACIA_COBRO_DIAS', '11', 'proposed', now() + interval '3 days')$$,
  '42501', null, 'una alumna tampoco, aunque el servidor lo intente a su nombre');

select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001', 'aal1');
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('GRACIA_COBRO_DIAS', '11', 'proposed', now() + interval '3 days')$$,
  '42501', null, 'configuración sin segundo factor no puede');

select pruebas.como_servicio();
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('GRACIA_COBRO_DIAS', '11', 'proposed', now() + interval '3 days')$$,
  '42501', null, 'sin autor declarado no hay cambio');

select pruebas.como_servicio('f0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$update public.business_parameters
    set canceled_at = now(), canceled_by = 'f0000000-0000-0000-0000-000000000001'
    where key = 'EDAD_MINIMA'$$,
  '42501', null, 'cancelar también exige configuración');

select pruebas.como_usuario('c0000000-0000-0000-0000-000000000001', 'aal2');
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('GRACIA_COBRO_DIAS', '11', 'proposed', now() + interval '3 days')$$,
  '42501', null, 'con su sesión, ni configuración escribe directo en la tabla');

-- ---------------------------------------------------------------------------------------
-- El valor tiene que ser del tipo que dice su definición.
select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001');
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('GRACIA_COBRO_DIAS', '"diez"', 'proposed', now() + interval '3 days')$$,
  '23514', null, 'un texto donde va un entero se rechaza');
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('GRACIA_COBRO_DIAS', '7.5', 'proposed', now() + interval '3 days')$$,
  '23514', null, 'un número con decimales donde va un entero se rechaza');
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('RESERVA_PCT', '10001', 'proposed', now() + interval '3 days')$$,
  '23514', null, 'más de 10 000 puntos base se rechaza');
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('PRECIO_MENSUAL', '349.00', 'proposed', now() + interval '3 days')$$,
  '23514', null, 'un precio que no está en centavos enteros se rechaza');
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('TIPO_CAMBIO', '18.5', 'proposed', now() + interval '3 days')$$,
  '23514', null, 'un decimal escrito como número, y no como texto, se rechaza');
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('COMENTARIOS_ABIERTOS', '"si"', 'proposed', now() + interval '3 days')$$,
  '23514', null, 'un texto donde va un sí o no se rechaza');
select lives_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('TIPO_CAMBIO', '"19.25"', 'to_confirm', now() + interval '3 days')$$,
  'un decimal como texto se acepta');
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('NO_EXISTE', '1', 'proposed', now() + interval '3 days')$$,
  '23503', null, 'un parámetro sin definición se rechaza');

-- Un parámetro que afecta al reparto necesita su periodo de vigencia (RF-707).
select throws_ok(
  $$insert into public.business_parameters (key, value, status, effective_from)
    values ('BOTE_PCT_BASE', '6200', 'proposed', now() + interval '40 days')$$,
  '23514', null, 'un parámetro de reparto sin periodo de vigencia se rechaza');
select lives_ok(
  $$insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
    values ('BOTE_PCT_BASE', '6200', 'proposed', now() + interval '40 days',
            to_char(now() + interval '40 days', 'YYYYMM')::integer)$$,
  'con su periodo de vigencia se acepta');

-- ---------------------------------------------------------------------------------------
-- Quién lee los parámetros con su sesión.
select pruebas.como_usuario('c0000000-0000-0000-0000-000000000001', 'aal2');
select cmp_ok((select count(*)::int from public.business_parameters), '>=', 56,
  'configuración con segundo factor lee los parámetros');
select pruebas.como_usuario('f0000000-0000-0000-0000-000000000001', 'aal2');
select cmp_ok((select count(*)::int from public.parameter_definitions), '>=', 56,
  'finanzas con segundo factor también');
select pruebas.como_usuario('c0000000-0000-0000-0000-000000000001', 'aal1');
select is((select count(*)::int from public.business_parameters), 0, 'sin segundo factor, nadie');
select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001', 'aal2');
select is((select count(*)::int from public.business_parameters), 0, 'la alumna no los lee');
select pruebas.como_visitante();
select throws_ok('select count(*) from public.business_parameters', '42501', null,
  'el visitante tampoco');

select pruebas.limpiar();
select * from finish();
rollback;
