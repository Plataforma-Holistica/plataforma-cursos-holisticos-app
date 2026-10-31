-- T-409 · Los datos fiscales y bancarios del maestro (RF-510; 05 §10). Ningún rol de la aplicación toca las tablas: solo funciones, y cada
-- lectura de lo cifrado queda en la auditoría, en la misma transacción, antes de devolverlo. El maestro guarda y lee lo suyo; finanzas lee por
-- una liquidación, nunca por un maestro; nadie actúa sobre sí. La base no ve el texto: revisa la forma de lo cifrado, y una CLABE en claro no entra.
begin;
\ir _ayuda.psql
select plan(71);

-- mara y susi son maestras (susi, suspendida); nita, maestra sin el aviso; alu, alumna; f1, finanzas; k1, Contenido; fm, finanzas y maestra.
select pruebas.alta('a6300000-0000-0000-0000-000000000001', 'mara-63@prueba.test');
select pruebas.alta('a6300000-0000-0000-0000-000000000002', 'susi-63@prueba.test');
select pruebas.alta('a6300000-0000-0000-0000-000000000003', 'nita-63@prueba.test');
select pruebas.alta('a6300000-0000-0000-0000-000000000004', 'alu-63@prueba.test');
select pruebas.alta('c6300000-0000-0000-0000-000000000001', 'f1-63@prueba.test');
select pruebas.alta('c6300000-0000-0000-0000-000000000002', 'k1-63@prueba.test');
select pruebas.alta('c6300000-0000-0000-0000-000000000003', 'fm-63@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-63@prueba.test';
select pruebas.dar_capacidad('c6300000-0000-0000-0000-000000000001', 'finance');
select pruebas.dar_capacidad('c6300000-0000-0000-0000-000000000002', 'content');
select pruebas.dar_capacidad('c6300000-0000-0000-0000-000000000003', 'finance');
select pruebas.equipar(id) from auth.users where email in ('f1-63@prueba.test', 'k1-63@prueba.test', 'fm-63@prueba.test');

create function pruebas.mara() returns uuid language sql immutable as $$ select 'a6300000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.susi() returns uuid language sql immutable as $$ select 'a6300000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.nita() returns uuid language sql immutable as $$ select 'a6300000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.alu() returns uuid language sql immutable as $$ select 'a6300000-0000-0000-0000-000000000004'::uuid $$;
create function pruebas.f1() returns uuid language sql immutable as $$ select 'c6300000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.k1() returns uuid language sql immutable as $$ select 'c6300000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.fm() returns uuid language sql immutable as $$ select 'c6300000-0000-0000-0000-000000000003'::uuid $$;

-- Lo que el cifrado de la aplicación guarda: formato, versión de la llave, vector, cifrado y etiqueta. Aquí, sin cifrar nada: la base solo ve la forma.
create function pruebas.sellado(p_largo integer, p_llave integer default 1) returns bytea
language sql immutable as $$
  select decode('01' || lpad(to_hex(p_llave), 4, '0') || repeat('ab', 12 + p_largo + 16), 'hex')
$$;
-- Guardar, con lo demás bien, cambiando lo que diga la prueba.
create function pruebas.guarda(
  p_id uuid, p_teacher uuid, p_vista integer default 0, p_rfc bytea default pruebas.sellado(13), p_nombre bytea default pruebas.sellado(20),
  p_regimen text default '612', p_tipo text default 'person', p_clabe bytea default pruebas.sellado(18), p_ultimos text default '7771',
  p_llave integer default 1) returns text
language plpgsql as $$
declare
  v text;
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.tax_profile_save(p_teacher, p_vista, p_rfc, p_nombre, p_regimen, p_tipo, p_clabe, p_ultimos, p_llave);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.lecturas(p_actor uuid) returns bigint
language sql security definer as $$
  select count(*) from public.audit_log a where a.action = 'tax_profile.read' and a.actor_id = p_actor
$$;
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

-- El aviso del maestro, los maestros y sus liquidaciones.
select pruebas.como_dueno_sistema();
alter table public.legal_documents disable trigger ledger_no_update_delete;
delete from public.legal_documents where doc_type = 'teacher_privacy_notice';
alter table public.legal_documents enable trigger ledger_no_update_delete;
insert into public.legal_documents (doc_type, version, title, body, effective_from) values ('teacher_privacy_notice', 1, 'Aviso', 'Texto', now());
insert into public.teachers (profile_id, status) values (pruebas.mara(), 'active') returning id as mara_m \gset
insert into public.teachers (profile_id, status, suspended_at, suspension_reason) values (pruebas.susi(), 'suspended', now(), 'prueba') returning id as susi_m \gset
insert into public.teachers (profile_id, status) values (pruebas.nita(), 'active') returning id as nita_m \gset
insert into public.teachers (profile_id, status) values (pruebas.fm(), 'active') returning id as fm_m \gset
select pruebas.limpiar();
select set_config('app.actor_id', p::text, true) from unnest(array[pruebas.mara()]) p;
insert into public.consents (profile_id, legal_document_id, origin)
  select p, private.current_legal_document('teacher_privacy_notice'), 'account_settings' from unnest(array[pruebas.mara()]) p;
select pruebas.limpiar();
select set_config('app.actor_id', pruebas.susi()::text, true);
insert into public.consents (profile_id, legal_document_id, origin) values (pruebas.susi(), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
select pruebas.limpiar();
select set_config('app.actor_id', pruebas.fm()::text, true);
insert into public.consents (profile_id, legal_document_id, origin) values (pruebas.fm(), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
select pruebas.limpiar();

set local session_replication_role = replica;
insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, subtotal_cents, net_cents)
  values (202610, :'mara_m', gen_random_uuid(), 100, 100, 100) returning id as pago_mara \gset
insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, subtotal_cents, net_cents)
  values (202610, :'fm_m', gen_random_uuid(), 100, 100, 100) returning id as pago_fm \gset
insert into public.payouts (period_id, teacher_id, close_run_id, pool_cents, subtotal_cents, net_cents)
  values (202610, :'nita_m', gen_random_uuid(), 100, 100, 100) returning id as pago_nita \gset
set local session_replication_role = origin;

-- ---------------------------------------------------------------------------------------
-- Nadie de la aplicación toca las tablas.

select ok(not has_table_privilege(r, 'private.teacher_tax_profiles', 'select, insert, update, delete, truncate, references, trigger'), r || ' no tiene ningún permiso sobre los perfiles')
  from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) r;
select ok(not has_any_column_privilege(r, 'private.teacher_tax_profiles', 'select, insert, update, references'), r || ' tampoco por columna')
  from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) r;
select ok((select relrowsecurity from pg_class where oid = 'private.teacher_tax_profiles'::regclass), 'con seguridad por fila');
select pruebas.a_nombre_de(pruebas.f1());
select throws_ok('select * from private.teacher_tax_profiles', '42501', null, 'finanzas no lee la tabla directo: no quedaría en la auditoría');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Guardar.

select is(pruebas.guarda(pruebas.mara(), :'mara_m'), 'saved', 'la maestra guarda lo suyo');
select is((select version::int from private.teacher_tax_profiles where teacher_id = :'mara_m'), 1, 'en su versión 1');
select is((select created_by from private.teacher_tax_profiles where teacher_id = :'mara_m'), pruebas.mara(), 'con quién');
select is(pruebas.guarda(pruebas.mara(), :'mara_m', 0), 'changed', 'con lo visto de antes: otra pestaña ya guardó');
select is(pruebas.guarda(pruebas.mara(), :'nita_m', 1), 'changed', 'otro maestro: el identificador entra a los datos asociados, y no sería el suyo');
select is(pruebas.guarda(pruebas.alu(), :'mara_m'), 'not_teacher', 'una alumna no');
select is(pruebas.guarda(pruebas.susi(), :'susi_m'), 'suspended', 'una suspendida no cambia sus datos');
select is(pruebas.guarda(pruebas.nita(), :'nita_m'), 'needs_notice', 'sin el aviso aceptado, tampoco');
select is(pruebas.guarda(pruebas.mara(), :'mara_m', 1), 'saved', 'con la versión vista, sí, y agrega otra');
select is((select max(version)::int from private.teacher_tax_profiles where teacher_id = :'mara_m'), 2, 'no reescribe: es de solo inserción');

-- ---------------------------------------------------------------------------------------
-- La forma: la base no ve el texto, pero una CLABE en claro no entra.

select is(pruebas.guarda(pruebas.mara(), :'mara_m', 2, p_clabe => '002010077777777771'::bytea), 'invalid', 'una CLABE en claro');
select is(pruebas.guarda(pruebas.mara(), :'mara_m', 2, p_clabe => pruebas.sellado(17)), 'invalid', 'cifrada de otro largo');
select is(pruebas.guarda(pruebas.mara(), :'mara_m', 2, p_rfc => 'GOMA800101AB1'::bytea), 'invalid', 'un RFC en claro');
select is(pruebas.guarda(pruebas.mara(), :'mara_m', 2, p_nombre => 'Nombre en claro'::bytea), 'invalid', 'una razón social en claro');
select is(pruebas.guarda(pruebas.mara(), :'mara_m', 2, p_rfc => pruebas.sellado(13, 2)), 'invalid', 'una columna con otra versión de llave');
select is(pruebas.guarda(pruebas.mara(), :'mara_m', 2, p_llave => 0), 'invalid', 'una versión de llave sin forma');
select is(pruebas.guarda(pruebas.mara(), :'mara_m', 2, p_ultimos => '777'), 'invalid', 'unos últimos cuatro sin forma');
select is(pruebas.guarda(pruebas.mara(), :'mara_m', 2, p_regimen => '609'), 'invalid', 'un régimen fuera del catálogo');
select is(pruebas.guarda(pruebas.mara(), :'mara_m', 2, p_regimen => '601'), 'invalid', 'un régimen de persona moral con una física');
select is(pruebas.guarda(pruebas.mara(), :'mara_m', 2, p_tipo => 'otro'), 'invalid', 'un tipo de persona desconocido');
select is(pruebas.guarda(pruebas.mara(), :'mara_m', 2, p_regimen => '626', p_tipo => 'company'), 'saved', 'el 626 aplica a los dos');

select pruebas.como_dueno_sistema();
select throws_ok(format($$insert into private.teacher_tax_profiles (teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version, created_by)
  values (%L, 9, %L, %L, '612', 'person', %L, '7771', 1, %L)$$, :'mara_m', pruebas.sellado(13), pruebas.sellado(20), '002010077777777771'::bytea, pruebas.mara()),
  '23514', null, 'la tabla tampoco, ni para el dueño');
select throws_ok(format($$update private.teacher_tax_profiles set clabe_last4 = '0000' where teacher_id = %L$$, :'mara_m'), null, null, 'ni se edita');
select throws_ok(format($$delete from private.teacher_tax_profiles where teacher_id = %L$$, :'mara_m'), null, null, 'ni se borra');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- La auditoría del cambio no trae lo que hay en la tabla: configuración lee la auditoría.

select is((select count(*) from public.audit_log a where a.action = 'teacher_tax_profiles.insert'
            and (a.new_value ?| array['rfc_enc', 'legal_name_enc', 'clabe_enc', 'clabe_last4', 'tax_regime_code', 'payee_kind'])), 0::bigint,
  'la auditoría de escribir no guarda ni lo cifrado, ni los últimos cuatro, ni el régimen');
select ok((select count(*) from public.audit_log a where a.action = 'teacher_tax_profiles.insert' and a.category = 'privacy' and a.entity_id is not null) >= 1,
  'y sí dice qué fila, en la categoría de privacidad');

-- ---------------------------------------------------------------------------------------
-- El maestro lee lo suyo.

select pruebas.a_nombre_de(pruebas.mara());
select is(private.tax_profile_state() ->> 'version', '3', 'el estado dice qué versión hay');
select is(private.tax_profile_state() - 'version' - 'outcome' - 'updated_at', '{}'::jsonb, 'y nada más: no trae ni lo cifrado ni los últimos cuatro');
select pruebas.limpiar();
select is(pruebas.lecturas(pruebas.mara()), 0::bigint, 'el estado no es una lectura');

select pruebas.a_nombre_de(pruebas.mara());
select is(private.tax_profile_mine() ->> 'outcome', 'ok', 'lee lo suyo');
select pruebas.limpiar();
select is(pruebas.lecturas(pruebas.mara()), 1::bigint, 'y queda en la auditoría, en la misma transacción');
select pruebas.a_nombre_de(pruebas.mara());
select is((private.tax_profile_mine() ->> 'version')::int, 3, 'la versión vigente es la mayor');
select is(private.tax_profile_mine() ->> 'clabe_last4', '7771', 'con los últimos cuatro');
select is(decode(private.tax_profile_mine() ->> 'clabe', 'base64'), pruebas.sellado(18), 'y lo cifrado, en base64: quien abre es la aplicación');
select pruebas.limpiar();

select is(pruebas.pide(pruebas.alu(), 'private.tax_profile_mine() ->> $$outcome$$'), 'not_teacher', 'a una alumna, nada');
select is(pruebas.lecturas(pruebas.alu()), 0::bigint, 'y no hay lectura que auditar');
select is(pruebas.pide(pruebas.susi(), 'private.tax_profile_mine() ->> $$outcome$$'), 'no_profile', 'una suspendida lee, si tiene: está en solo lectura');
select is(pruebas.lecturas(pruebas.susi()), 0::bigint, 'sin nada que leer, sin lectura');

-- ---------------------------------------------------------------------------------------
-- Finanzas lee por una liquidación, nunca por un maestro.

select is(pruebas.pide(pruebas.k1(), format('private.tax_profile_for_payout(%L) ->> $$outcome$$', :'pago_mara')), 'forbidden', 'Contenido no');
select is(pruebas.pide(pruebas.alu(), format('private.tax_profile_for_payout(%L) ->> $$outcome$$', :'pago_mara')), 'forbidden', 'una alumna no');
select is(pruebas.lecturas(pruebas.k1()), 0::bigint, 'sin lectura que auditar');
select pruebas.sin_codigo(pruebas.f1());
select is(pruebas.pide(pruebas.f1(), format('private.tax_profile_for_payout(%L) ->> $$outcome$$', :'pago_mara')), 'needs_fresh_code', 'finanzas sin código reciente no');
select pruebas.equipar(pruebas.f1());
select is(pruebas.pide(pruebas.f1(), format('private.tax_profile_for_payout(%L) ->> $$outcome$$', gen_random_uuid())), 'not_found', 'una liquidación que no existe');
select is(pruebas.pide(pruebas.f1(), format('private.tax_profile_for_payout(%L) ->> $$outcome$$', :'pago_nita')), 'no_profile', 'un maestro sin datos');
select is(pruebas.lecturas(pruebas.f1()), 0::bigint, 'nada de eso es una lectura');
select is(pruebas.pide(pruebas.f1(), format('private.tax_profile_for_payout(%L) ->> $$clabe_last4$$', :'pago_mara')), '7771', 'finanzas, por su liquidación, sí');
select is(pruebas.lecturas(pruebas.f1()), 1::bigint, 'y queda en la auditoría');
select is(pruebas.pide(pruebas.fm(), format('private.tax_profile_for_payout(%L) ->> $$outcome$$', :'pago_fm')), 'self', 'nadie sobre sí: lo suyo se lee por su pantalla');
select is(pruebas.lecturas(pruebas.fm()), 0::bigint, 'sin lectura');

-- ---------------------------------------------------------------------------------------
-- Contenido sabe si ya los capturó, sin verlos.

select is((pruebas.fila(pruebas.k1(), :'mara_m') ->> 'has_tax_data')::boolean, true, 'con datos');
select is((pruebas.fila(pruebas.k1(), :'nita_m') ->> 'has_tax_data')::boolean, false, 'sin datos');

-- ---------------------------------------------------------------------------------------
-- Las reglas de retención: sin filas hasta que conteste el contador, y fracciones, no enteros.

select is((select count(*) from public.withholding_rules), 0::bigint, 'no hay reglas');
select ok(not has_table_privilege('app_service', 'public.withholding_rules', 'insert, update, delete'), 'el servidor no las escribe');
select pruebas.como_dueno_sistema();
select lives_ok($$insert into public.withholding_rules (tax_regime_code, payee_kind, vat_rate, income_tax_withholding_rate, vat_withholding_rate, effective_from)
  values ('612', 'person', 0.16, 0.10, 0.106667, '2027-01-01')$$, 'caben dos tercios de 16 %');
select throws_ok($$insert into public.withholding_rules (tax_regime_code, payee_kind, vat_rate, income_tax_withholding_rate, vat_withholding_rate, effective_from)
  values ('612', 'person', 1.5, 0, 0, '2028-01-01')$$, '23514', null, 'una tasa de más de 1 no');
select throws_ok($$insert into public.withholding_rules (tax_regime_code, payee_kind, vat_rate, income_tax_withholding_rate, vat_withholding_rate, effective_from)
  values ('601', 'person', 0, 0, 0, '2028-01-01')$$, '23514', null, 'un régimen de otro tipo de persona no');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is_empty('select * from private.schema_violations()', 'el vigilante en cero');
grant select on private.teacher_tax_profiles to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'tax table privilege for app_service'), 've un permiso de leer la tabla');
revoke select on private.teacher_tax_profiles from app_service;
create or replace function private.tax_profile_mine() returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$ begin return (select to_jsonb(p) from private.teacher_tax_profiles p limit 1); end $$;
select ok(exists (select 1 from private.schema_violations() where problem = 'tax read without audit: private.tax_profile_mine()'), 've una lectura sin auditoría');
create or replace function private.tax_profile_save(
  p_teacher uuid, p_seen_version integer, p_rfc bytea, p_legal_name bytea, p_regime text, p_payee text, p_clabe bytea, p_last4 text, p_key_version integer)
returns text
language plpgsql volatile security definer set search_path = ''
as $$ begin return 'saved'; end $$;
select ok(exists (select 1 from private.schema_violations() where problem = 'tax save without the balance lock'), 've guardar sin el candado del saldo');
create function private.tax_otra_lectura() returns bigint
language sql security definer set search_path = ''
as $$ select count(*) from private.teacher_tax_profiles $$;
select ok(exists (select 1 from private.schema_violations() where problem = 'tax function not in the list' and object_name = 'tax_otra_lectura'), 've una función nueva que nombra la tabla');

select * from finish();
rollback;
