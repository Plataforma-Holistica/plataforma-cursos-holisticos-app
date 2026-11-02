-- T-409 · La espera antes de que rija una CLABE nueva (decisiones de Sergio del 2026-11-01; FL-31, A1). Dura `ESPERA_CLABE_HORAS`, también en la primera captura, y
-- mientras tanto finanzas no recibe ningún dato: no se paga a ninguna cuenta, y nadie la adelanta. Cambiar el RFC, la razón social o el régimen no la toca. Una contraseña
-- cambiada o un fraude confirmado dentro de la espera la anulan, para siempre; con una propuesta de fraude pendiente no madura, sin que el maestro lo note.
begin;
\ir _ayuda.psql
select plan(79);

select pruebas.alta('a6600000-0000-0000-0000-000000000001', 'mara-66@prueba.test');
select pruebas.alta('c6600000-0000-0000-0000-000000000001', 'f1-66@prueba.test');
select pruebas.alta('c6600000-0000-0000-0000-000000000002', 'k1-66@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-66@prueba.test';
select pruebas.dar_capacidad('c6600000-0000-0000-0000-000000000001', 'finance');
select pruebas.dar_capacidad('c6600000-0000-0000-0000-000000000002', 'content');
select pruebas.equipar(id) from auth.users where email in ('f1-66@prueba.test', 'k1-66@prueba.test');

create function pruebas.mara() returns uuid language sql immutable as $$ select 'a6600000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.f1() returns uuid language sql immutable as $$ select 'c6600000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.k1() returns uuid language sql immutable as $$ select 'c6600000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.sellado(p_largo integer) returns bytea language sql immutable
as $$ select decode('010001' || repeat('ab', 12 + p_largo + 16), 'hex') $$;

-- Guardar, diciendo si la CLABE cambió, como lo dice el servidor.
create function pruebas.guarda(p_teacher uuid, p_vista integer, p_cambio boolean, p_ultimos text default '7771', p_regimen text default '612') returns text
language plpgsql as $$
declare
  v text;
begin
  perform pruebas.a_nombre_de(pruebas.mara());
  v := private.tax_profile_save(p_teacher, p_vista, pruebas.sellado(13), pruebas.sellado(20), p_regimen, 'person', pruebas.sellado(18), p_ultimos, 1, p_cambio);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.ultima(p_teacher uuid) returns private.teacher_tax_profiles language sql security definer
as $$ select x from private.teacher_tax_profiles x where x.teacher_id = p_teacher order by x.version desc limit 1 $$;
create function pruebas.vista(p_teacher uuid) returns integer language sql security definer
as $$ select coalesce(max(x.version), 0)::integer from private.teacher_tax_profiles x where x.teacher_id = p_teacher $$;
-- Mueve las fechas de la última versión: el libro no admite cambios, salvo apagando sus disparadores.
create function pruebas.mueve(p_teacher uuid, p_cambio timestamptz, p_rige timestamptz) returns void language plpgsql as $$
begin
  set local session_replication_role = replica;
  update private.teacher_tax_profiles x set clabe_changed_at = p_cambio, clabe_effective_from = p_rige
  where x.teacher_id = p_teacher and x.version = pruebas.vista(p_teacher);
  set local session_replication_role = origin;
end
$$;
create function pruebas.finanzas(p_pago uuid) returns jsonb language plpgsql as $$
begin
  return pruebas.pide(pruebas.f1(), format('private.tax_profile_for_payout(%L)', p_pago))::jsonb;
end
$$;
create function pruebas.estado() returns jsonb language plpgsql as $$
begin
  return pruebas.pide(pruebas.mara(), 'private.tax_profile_state()')::jsonb;
end
$$;
create function pruebas.lecturas() returns bigint language sql security definer
as $$ select count(*) from public.audit_log a where a.action = 'tax_profile.read' and a.actor_id = pruebas.f1() $$;
create function pruebas.parametro(p_valor jsonb) returns void language plpgsql as $$
begin
  set local session_replication_role = replica;
  update public.business_parameters set value = p_valor where key = 'ESPERA_CLABE_HORAS';
  set local session_replication_role = origin;
end
$$;
create function pruebas.contrasena(p_cuando timestamptz) returns void language sql security definer as $$
  insert into private.account_security (profile_id, password_changed_at) values (pruebas.mara(), p_cuando)
  on conflict (profile_id) do update set password_changed_at = excluded.password_changed_at
$$;
-- Una propuesta de fraude, en el estado que diga la prueba, sin pasar por sus puertas: esas se prueban en la 59.
create function pruebas.propuesta(p_teacher uuid, p_estado public.suspension_request_status, p_propuesta timestamptz, p_decidida timestamptz default null) returns uuid language plpgsql as $$
declare
  v uuid;
begin
  set local session_replication_role = replica;
  insert into private.teacher_suspension_requests (teacher_id, anomaly_alert_id, reason, proposed_by, proposed_at, status, decided_by, decided_at)
  values (p_teacher, gen_random_uuid(), 'prueba', pruebas.f1(), p_propuesta, p_estado,
          case when p_estado in ('confirmed', 'rejected') then pruebas.k1() end, p_decidida)
  returning id into v;
  set local session_replication_role = origin;
  return v;
end
$$;
create function pruebas.sin_propuestas() returns void language plpgsql as $$
begin
  set local session_replication_role = replica;
  delete from private.teacher_suspension_requests;
  set local session_replication_role = origin;
end
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.como_dueno_sistema();
alter table public.legal_documents disable trigger ledger_no_update_delete;
delete from public.legal_documents where doc_type = 'teacher_privacy_notice';
alter table public.legal_documents enable trigger ledger_no_update_delete;
insert into public.legal_documents (doc_type, version, title, body, effective_from) values ('teacher_privacy_notice', 1, 'Aviso', 'Texto', now());
insert into public.teachers (profile_id, status) values (pruebas.mara(), 'active') returning id as m \gset
select set_config('app.actor_id', pruebas.mara()::text, true);
insert into public.consents (profile_id, legal_document_id, origin) values (pruebas.mara(), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
select pruebas.limpiar();
set local session_replication_role = replica;
insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, subtotal_cents, net_cents)
  values (202610, :'m', gen_random_uuid(), 100, 100, 100) returning id as pago \gset
insert into public.withholding_rules (tax_regime_code, payee_kind, vat_rate, income_tax_withholding_rate, vat_withholding_rate, effective_from, note)
  values ('612', 'person', 0, 0, 0, '2000-01-01', 'regla en 0 de la prueba');
set local session_replication_role = origin;
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- La primera captura también espera, y el parámetro dice cuánto.

select is((private.parameter_value('ESPERA_CLABE_HORAS'))::integer, 72, 'la espera es de 72 horas');
select is(pruebas.guarda(:'m', 0, true), 'saved', 'la primera captura se guarda');
select is((select (u).clabe_effective_from - (u).clabe_changed_at from (select pruebas.ultima(:'m') as u) x), interval '72 hours', 'y rige a las 72 horas');
select ok((pruebas.ultima(:'m')).clabe_changed_at > now(), 'contadas desde el reloj, no desde el inicio de la transacción');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_waiting', 'finanzas no recibe nada');
select is((pruebas.finanzas(:'pago') ->> 'until')::timestamptz, (pruebas.ultima(:'m')).clabe_effective_from, 'solo desde cuándo rige');
select is(pruebas.finanzas(:'pago') - 'outcome' - 'until', '{}'::jsonb, 'y nada más: ni los últimos cuatro');
select is(pruebas.lecturas(), 0::bigint, 'sin datos, no hay lectura que auditar');
select is((pruebas.estado() ->> 'clabe_waits_until')::timestamptz, (pruebas.ultima(:'m')).clabe_effective_from, 'el maestro ve desde cuándo rige');
select is(pruebas.estado() ->> 'clabe_recapture', 'false', 'y que no hay que volver a escribirla');
select is(private.payout_tax_row(:'m', 100000, 1)  ->> 'tax_state', 'ready', 'no detiene el cálculo: las retenciones no miran la CLABE');

-- ---------------------------------------------------------------------------------------
-- Un segundo antes y al llegar.

select pruebas.mueve(:'m', now() - interval '72 hours', now() + interval '1 second');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_waiting', 'un segundo antes, todavía no');
select pruebas.mueve(:'m', now() - interval '72 hours', now());
select is(pruebas.finanzas(:'pago') ->> 'clabe_last4', '7771', 'al llegar la fecha, rige');
select is(pruebas.lecturas(), 1::bigint, 'y esa sí queda en la auditoría');
select is(pruebas.estado() ->> 'clabe_waits_until', null, 'y el maestro ya no ve espera');

-- ---------------------------------------------------------------------------------------
-- Cambiar lo demás no la toca.

select pruebas.mueve(:'m', now() - interval '100 hours', now() - interval '28 hours');
select is(pruebas.guarda(:'m', 1, false), 'saved', 'cambiar el RFC con la CLABE vigente');
select is((pruebas.ultima(:'m')).clabe_effective_from, now() - interval '28 hours', 'hereda su fecha');
select is(pruebas.finanzas(:'pago') ->> 'version', '2', 'y sigue vigente, sin espera');

-- Una CLABE nueva, y durante su espera cambian el régimen y el RFC.
select is(pruebas.guarda(:'m', 2, true, '8881'), 'saved', 'una CLABE nueva');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_waiting', 'espera, aunque la anterior regía');
select pruebas.mueve(:'m', now() - interval '1 hour', now() + interval '71 hours');
select is(pruebas.guarda(:'m', 3, false, '8881', '626'), 'saved', 'cambiar el régimen durante la espera');
select is((pruebas.ultima(:'m')).clabe_effective_from, now() + interval '71 hours', 'no mueve la fecha');
select is((pruebas.ultima(:'m')).clabe_changed_at, now() - interval '1 hour', 'ni desde cuándo se cuenta');
select is((select regime from private.tax_profile_fiscal(:'m')), '626', 'y el régimen nuevo rige de inmediato, para las retenciones');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_waiting', 'la CLABE sigue esperando');

-- ---------------------------------------------------------------------------------------
-- Solo cuenta la última: una CLABE reemplazada nunca rige.

select is(pruebas.guarda(:'m', 4, true, '9991'), 'saved', 'otra CLABE encima de la que esperaba');
select cmp_ok((pruebas.ultima(:'m')).clabe_effective_from, '>', now() + interval '71 hours', 'empieza de nuevo');
set local session_replication_role = replica;
update private.teacher_tax_profiles set clabe_effective_from = now() - interval '1 hour', clabe_changed_at = now() - interval '73 hours' where teacher_id = :'m' and version = 4;
set local session_replication_role = origin;
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_waiting', 'aunque a la de en medio ya le tocara, no rige');
select is(pruebas.guarda(:'m', 5, true, '7771'), 'saved', 'volver a la primera CLABE');
select cmp_ok((pruebas.ultima(:'m')).clabe_effective_from, '>', now() + interval '71 hours', 'también espera');

-- ---------------------------------------------------------------------------------------
-- Si el servidor no lo dice, o dice lo que no cuadra, cuenta como cambio.

select pruebas.mueve(:'m', now() - interval '100 hours', now() - interval '28 hours');
select is(pruebas.guarda(:'m', 6, false, '1234'), 'saved', 'dice que no cambió, con otros últimos cuatro');
select cmp_ok((pruebas.ultima(:'m')).clabe_effective_from, '>', now(), 'cuenta como cambio');
select pruebas.mueve(:'m', now() - interval '100 hours', now() - interval '28 hours');
select is(pruebas.guarda(:'m', 7, null, '1234'), 'saved', 'no dice si cambió');
select cmp_ok((pruebas.ultima(:'m')).clabe_effective_from, '>', now(), 'también');
select pruebas.mueve(:'m', now() - interval '100 hours', now() - interval '28 hours');
select pruebas.a_nombre_de(pruebas.mara());
select is(private.tax_profile_save(:'m', 8, pruebas.sellado(13), pruebas.sellado(20), '612', 'person', pruebas.sellado(18), '1234', 1), 'saved', 'una llamada sin ese dato');
select pruebas.limpiar();
select cmp_ok((pruebas.ultima(:'m')).clabe_effective_from, '>', now(), 'también');

-- ---------------------------------------------------------------------------------------
-- El parámetro: sin uno válido no se guarda una CLABE nueva, y cambiarlo no toca lo guardado.

select pruebas.mueve(:'m', now() - interval '100 hours', now() - interval '28 hours');
select pruebas.parametro('0'::jsonb);
select pruebas.a_nombre_de(pruebas.mara());
select throws_ok(format($$select private.tax_profile_save(%L, 9, pruebas.sellado(13), pruebas.sellado(20), '612', 'person', pruebas.sellado(18), '1234', 1, true)$$, :'m'), 'P0001', null, 'con 0 horas, una CLABE nueva no se guarda');
select pruebas.limpiar();
select pruebas.parametro('"tres"'::jsonb);
select pruebas.a_nombre_de(pruebas.mara());
select throws_ok(format($$select private.tax_profile_save(%L, 9, pruebas.sellado(13), pruebas.sellado(20), '612', 'person', pruebas.sellado(18), '1234', 1, true)$$, :'m'), 'P0001', null, 'ni con algo que no es un número');
select pruebas.limpiar();
select pruebas.parametro('null'::jsonb);
select pruebas.a_nombre_de(pruebas.mara());
select throws_ok(format($$select private.tax_profile_save(%L, 9, pruebas.sellado(13), pruebas.sellado(20), '612', 'person', pruebas.sellado(18), '1234', 1, true)$$, :'m'), 'P0001', null, 'ni sin valor');
select pruebas.limpiar();
select is(pruebas.guarda(:'m', 9, false, '1234'), 'saved', 'cambiar lo demás no lo necesita');
select pruebas.parametro('24'::jsonb);
select is((pruebas.ultima(:'m')).clabe_effective_from, now() - interval '28 hours', 'cambiar el parámetro no toca lo guardado');
select is(pruebas.guarda(:'m', 10, true, '4321'), 'saved', 'una CLABE nueva');
select is((select (u).clabe_effective_from - (u).clabe_changed_at from (select pruebas.ultima(:'m') as u) x), interval '24 hours', 'toma el valor de ese momento');
select pruebas.parametro('72'::jsonb);
select is((select (u).clabe_effective_from - (u).clabe_changed_at from (select pruebas.ultima(:'m') as u) x), interval '24 hours', 'y lo conserva');

-- ---------------------------------------------------------------------------------------
-- Un cambio de contraseña dentro de la espera la anula. Es el camino de quien recupera su cuenta.

select pruebas.mueve(:'m', now() - interval '10 hours', now() + interval '62 hours');
select pruebas.contrasena(now() - interval '11 hours');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_waiting', 'una contraseña cambiada antes no importa');
select pruebas.contrasena(now() - interval '1 hour');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_recapture', 'dentro de la espera, la anula');
select is(pruebas.estado() ->> 'clabe_recapture', 'true', 'el maestro ve que hay que volver a escribirla');
select is(pruebas.estado() ->> 'clabe_waits_until', null, 'y ya no una fecha');
select pruebas.mueve(:'m', now() - interval '100 hours', now() - interval '28 hours');
select pruebas.contrasena(now() - interval '1 hour');
select is(pruebas.finanzas(:'pago') ->> 'version', '11', 'cambiada después de que rigió, no importa');
-- Dentro de la espera otra vez, y al escribirla de nuevo no hereda lo anulado, aunque sea la misma.
select pruebas.mueve(:'m', now() - interval '10 hours', now() + interval '62 hours');
select is(pruebas.guarda(:'m', 11, false, '4321'), 'saved', 'escribe la misma CLABE');
select cmp_ok((pruebas.ultima(:'m')).clabe_changed_at, '>', now() - interval '1 second', 'empieza de nuevo: no hereda lo anulado');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_waiting', 'y espera');
-- Reclamar la cuenta, como al recuperarla, también.
select pruebas.reclamar(pruebas.mara());
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_recapture', 'recuperar la cuenta la anula, por donde de verdad se recupera');

-- ---------------------------------------------------------------------------------------
-- Un fraude confirmado dentro de la espera la anula para siempre.

select pruebas.contrasena(now() - interval '1 year');
select pruebas.mueve(:'m', now() - interval '10 hours', now() + interval '62 hours');
select pruebas.propuesta(:'m', 'confirmed', now() - interval '6 hours', now() - interval '5 hours');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_recapture', 'confirmado dentro de la espera, la anula');
select pruebas.mueve(:'m', now() - interval '100 hours', now() - interval '1 hour');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_recapture', 'también si la fecha ya pasó: nunca madura, ni al levantarse la suspensión');
-- Detenida por una propuesta, y decidida ya pasada la fecha: nunca rigió. Confirmarla no la deja regir.
select pruebas.sin_propuestas();
select pruebas.mueve(:'m', now() - interval '100 hours', now() - interval '28 hours');
select pruebas.propuesta(:'m', 'confirmed', now() - interval '90 hours', now() - interval '1 hour');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_recapture', 'propuesta durante la espera y confirmada después de la fecha: la anula');
-- La contraseña cambiada mientras seguía detenida la anula, aunque ya pasara la fecha.
select pruebas.sin_propuestas();
select pruebas.propuesta(:'m', 'rejected', now() - interval '90 hours', now() - interval '1 hour');
select pruebas.contrasena(now() - interval '5 hours');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_recapture', 'contraseña cambiada mientras seguía detenida, aunque luego se rechace la propuesta');
select pruebas.contrasena(now() - interval '30 minutes');
select is(pruebas.finanzas(:'pago') ->> 'clabe_last4', '4321', 'cambiada después de rechazarla, ya regía: no importa');
select pruebas.sin_propuestas();
select pruebas.propuesta(:'m', 'pending', now() - interval '90 hours');
select pruebas.contrasena(now() - interval '5 hours');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_recapture', 'con la propuesta aún pendiente, también');
select pruebas.contrasena(now() - interval '1 year');
select pruebas.sin_propuestas();
select pruebas.propuesta(:'m', 'confirmed', now() - interval '6 hours', now() - interval '5 hours');
select pruebas.mueve(:'m', now() - interval '100 hours', now() - interval '28 hours');
select is(pruebas.finanzas(:'pago') ->> 'clabe_last4', '4321', 'confirmado cuando ya regía, sigue');
select pruebas.mueve(:'m', now() - interval '4 hours', now() + interval '68 hours');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_waiting', 'confirmado antes de cambiarla, ese fraude no la anula');
select pruebas.sin_propuestas();

-- ---------------------------------------------------------------------------------------
-- Con una propuesta pendiente no madura, y el maestro no lo nota.

select pruebas.mueve(:'m', now() - interval '10 hours', now() + interval '62 hours');
create temporary table sin_propuesta on commit drop as select pruebas.estado() as respuesta;
grant select on sin_propuesta to anon, authenticated, app_service;
select pruebas.propuesta(:'m', 'pending', now() - interval '1 hour');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_held', 'finanzas ve que está detenida');
select is(pruebas.finanzas(:'pago') - 'outcome', '{}'::jsonb, 'sin más datos');
select is(pruebas.estado(), (select respuesta from sin_propuesta), 'el maestro recibe exactamente lo mismo que sin propuesta');
select pruebas.mueve(:'m', now() - interval '100 hours', now() - interval '1 minute');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_held', 'aunque la fecha pase');
select is(pruebas.estado() ->> 'clabe_waits_until', null, 'y el maestro ve lo de cualquier CLABE que ya llegó a su fecha');
select pruebas.sin_propuestas();
select pruebas.propuesta(:'m', 'pending', now());
select is(pruebas.finanzas(:'pago') ->> 'clabe_last4', '4321', 'propuesta cuando ya regía: sigue');
select pruebas.sin_propuestas();
select pruebas.propuesta(:'m', 'rejected', now() - interval '1 hour', now() - interval '30 minutes');
select is(pruebas.finanzas(:'pago') ->> 'clabe_last4', '4321', 'rechazada, rige por su fecha');
select pruebas.sin_propuestas();
select pruebas.propuesta(:'m', 'withdrawn', now() - interval '1 hour', now() - interval '30 minutes');
select is(pruebas.finanzas(:'pago') ->> 'clabe_last4', '4321', 'retirada, también');
select pruebas.sin_propuestas();

-- ---------------------------------------------------------------------------------------
-- La fila: una escrita sin sus fechas no rige; lo de antes de esta regla, sí.

select pruebas.como_dueno_sistema();
insert into private.teacher_tax_profiles (teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version, created_by)
  values (:'m', 50, pruebas.sellado(13), pruebas.sellado(20), '612', 'person', pruebas.sellado(18), '7771', 1, pruebas.mara());
select pruebas.como_dueno();
select is((pruebas.ultima(:'m')).clabe_effective_from, 'infinity'::timestamptz, 'una fila escrita sin sus fechas no rige nunca');
select pruebas.mueve(:'m', '-infinity', '-infinity');
select is(pruebas.finanzas(:'pago') ->> 'version', '50', 'una de antes de esta regla, sí');
select throws_ok(format($$update private.teacher_tax_profiles set clabe_changed_at = now(), clabe_effective_from = now() - interval '1 day' where teacher_id = %L$$, :'m'), null, null, 'el libro no admite cambiar la fecha');
set local session_replication_role = replica;
select throws_ok(format($$update private.teacher_tax_profiles set clabe_changed_at = now(), clabe_effective_from = now() - interval '1 day' where teacher_id = %L$$, :'m'), '23514', null, 'y no puede regir antes de cambiar');
set local session_replication_role = origin;

-- ---------------------------------------------------------------------------------------
-- El dinero no mira la CLABE: un reloj que vence cambiaría la huella sin que nada cambiara.

select is(array_agg(f), null, 'ninguna función de liberar ni de soltar nombra la CLABE')
from unnest(array['private.payout_tax_row(uuid, bigint, bigint)', 'private.release_preview(public.period_id)', 'private.release_payouts(public.period_id, text)',
                  'private.release_payout(uuid, bigint, jsonb)', 'private.unhold_preview(uuid)', 'private.unhold_payout(uuid, text, text)', 'private.assert_payout_released(uuid)',
                  'private.tax_profile_fiscal(uuid, integer)']) f
where pg_get_functiondef(f::regprocedure) ~ 'clabe';

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is((select count(*)::int from private.schema_violations() where object_name like 'tax%' or object_name like '%tax%'), 0, 'el vigilante no ve nada');
grant execute on function private.tax_clabe_standing(uuid, timestamptz, timestamptz) to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'tax_clabe_standing reachable'), 've que la aplicación llega a la regla');
revoke execute on function private.tax_clabe_standing(uuid, timestamptz, timestamptz) from app_service;
alter table private.teacher_tax_profiles drop constraint teacher_tax_profiles_clabe_dates;
select ok(exists (select 1 from private.schema_violations() where problem = 'tax table constraint missing: teacher_tax_profiles_clabe_dates'), 've la restricción de las fechas quitada');
alter table private.teacher_tax_profiles add constraint teacher_tax_profiles_clabe_dates check (clabe_effective_from >= clabe_changed_at);
create or replace function private.tax_profile_for_payout(p_payout uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$ begin perform 1 from public.audit_log; perform private.finance_change_gate(); perform private.actor_owns_teacher(gen_random_uuid()); insert into public.audit_log (action) select 'tax_profile.read' where false; return (select to_jsonb(x) from private.teacher_tax_profiles x limit 1); end $$;
select ok(exists (select 1 from private.schema_violations() where problem = 'tax finance read without the clabe wait'), 've una lectura de finanzas que no mira la espera');
create or replace function private.tax_profile_save(
  p_teacher uuid, p_seen_version integer, p_rfc bytea, p_legal_name bytea, p_regime text, p_payee text, p_clabe bytea, p_last4 text, p_key_version integer, p_clabe_changed boolean default true)
returns text
language plpgsql volatile security definer set search_path = ''
as $$ begin return 'saved'; end $$;
select ok(exists (select 1 from private.schema_violations() where problem = 'tax save without the clabe wait'), 've guardar sin la espera');

select * from finish();
rollback;
