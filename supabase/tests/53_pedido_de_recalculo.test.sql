-- T-605 · «Recalcular» desde PA-79 (RF-408; 05 §5.10 y §13.1). Decisión de Sergio del 2026-10-27: el
-- recálculo completo tarda minutos y hace `commit` entre pasos, así que no cabe en una transacción del
-- servidor; PA-79 deja un pedido (`private.request_rollup()`, con la puerta de finanzas) y un trabajo de
-- `pg_cron` de cada minuto lo corre (`private.run_rollup_requests()`). Uno pendiente por periodo, y solo
-- de un periodo que todavía se consolida. Que el corredor de verdad recalcula lo prueba la integración
-- (aquí nada confirma).
begin;
\ir _ayuda.psql
select plan(20);

create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b6053000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.contenido() returns uuid language sql immutable as $$ select 'b6053000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.pide_recalculo(p_actor uuid, p_period integer) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  -- A nombre de quien actúa, sin repararle nada (como el servidor).
  if p_actor is null then
    perform pruebas.como_servicio(null);
  else
    perform pruebas.a_nombre_de(p_actor);
  end if;
  v := private.request_rollup(p_period);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.estado(p_period integer, p_status text) returns void language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(p_period);
  alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
  update public.payout_periods set status = p_status::public.period_status,
         entered_closing_at = case when p_status <> 'open' then now() - interval '2 days' end
  where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
  perform pruebas.como_dueno();
end
$$;
create function pruebas.ahora() returns integer language sql stable as $$ select private.period_of(now())::integer $$;
create function pruebas.antes() returns integer language sql stable as $$ select private.period_plus(private.period_of(now()), -1)::integer $$;
create function pruebas.o(p jsonb) returns text language sql immutable as $$ select p ->> 'outcome' $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.alta(pruebas.finanzas(), 'finanzas-recalculo@prueba.test');
select pruebas.alta(pruebas.contenido(), 'contenido-recalculo@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-recalculo@prueba.test';
select pruebas.dar_capacidad(pruebas.finanzas(), 'finance');
select pruebas.equipar(pruebas.finanzas());
select pruebas.dar_capacidad(pruebas.contenido(), 'content');
select pruebas.equipar(pruebas.contenido());
select pruebas.estado(pruebas.ahora(), 'open');
delete from private.rollup_requests;

select has_table('private', 'rollup_requests', 'existen los pedidos de recálculo');
select ok(not exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('app_service')) r (rolname)
                      where has_any_column_privilege(r.rolname, 'private.rollup_requests', 'SELECT, INSERT, UPDATE, REFERENCES')
                         or has_table_privilege(r.rolname, 'private.rollup_requests', 'DELETE, TRUNCATE, TRIGGER')),
  'nadie de la aplicación los lee ni los escribe');

-- La puerta.
select is(pruebas.o(pruebas.pide_recalculo(pruebas.contenido(), pruebas.ahora())), 'forbidden', 'sin finanzas no se pide');
select is(pruebas.o(pruebas.pide_recalculo(null, pruebas.ahora())), 'forbidden', 'sin nadie que actúe tampoco');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '1 hour' where session_id = pruebas.sesion(pruebas.finanzas());
select is(pruebas.o(pruebas.pide_recalculo(pruebas.finanzas(), pruebas.ahora())), 'needs_fresh_code', 'sin el código reciente tampoco');
select pruebas.equipar(pruebas.finanzas());
select is((select count(*)::integer from private.rollup_requests), 0, 'y lo que no se pidió no queda');
select is(pruebas.o(pruebas.pide_recalculo(pruebas.finanzas(), null::integer)), 'malformed', 'sin periodo, nada');

-- Lo que no se consolida.
select is(pruebas.o(pruebas.pide_recalculo(pruebas.finanzas(), 209901)), 'not_rollable', 'un periodo que no existe no se recalcula');
select pruebas.estado(private.period_plus(private.period_of(now()), 2), 'open');
select is(pruebas.o(pruebas.pide_recalculo(pruebas.finanzas(), private.period_plus(private.period_of(now()), 2))), 'not_rollable',
  'uno que no ha empezado tampoco');
select ok(pg_get_functiondef('private.request_rollup(public.period_id)'::regprocedure) like '%rollup_window%',
  'lo que se recalcula es la ventana de la consolidación, que no tiene periodos cerrados');

-- Pedir.
create temporary table pedido as select pruebas.pide_recalculo(pruebas.finanzas(), pruebas.ahora()) as r;
select is((select pruebas.o(r) from pedido), 'requested', 'con finanzas y el código reciente, se pide el del periodo en curso');
select ok((select period_id = pruebas.ahora() and status = 'pending' and requested_by = pruebas.finanzas() and requested_at = now()
                  and started_at is null and finished_at is null and job_run_id is null
           from private.rollup_requests where id = (select (r ->> 'request_id')::uuid from pedido)),
  'queda pendiente, con quién y cuándo');
select is((select r from (select pruebas.pide_recalculo(pruebas.finanzas(), pruebas.ahora()) as r) x),
  jsonb_build_object('outcome', 'already_requested', 'request_id', (select r ->> 'request_id' from pedido)),
  'pedirlo otra vez contesta el que ya está');
select is((select count(*)::integer from private.rollup_requests), 1, 'uno pendiente por periodo');
select throws_ok($$insert into private.rollup_requests (period_id, requested_by) values (pruebas.ahora(), pruebas.finanzas())$$,
  '23505', null, 'aunque se escriba a mano');
select pruebas.estado(pruebas.antes(), 'closing');
select is(pruebas.o(pruebas.pide_recalculo(pruebas.finanzas(), pruebas.antes())), 'requested', 'el de un periodo en cierre también se pide');
select ok(exists (select 1 from public.audit_log where entity_table = 'private.rollup_requests' and action = 'rollup_requests.insert'
                  and actor_id = pruebas.finanzas()), 'pedir queda en la auditoría');

-- Lo que el panel ve.
create function pruebas.panel(p_period integer) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(pruebas.finanzas());
  v := private.finance_period(p_period);
  perform pruebas.limpiar();
  return v;
end
$$;
select is(pruebas.panel(pruebas.ahora()) #>> '{rollup_request,status}', 'pending', 'el panel ve el pedido pendiente');

-- El corredor hace `commit`: dentro de una transacción no corre.
select throws_ok($$call private.run_rollup_requests()$$, '2D000', null, 'el corredor no corre dentro de una transacción');
select ok(exists (select 1 from cron.job where jobname = 'rollup_requests'), 'lo corre `pg_cron`');

select * from finish();
rollback;
