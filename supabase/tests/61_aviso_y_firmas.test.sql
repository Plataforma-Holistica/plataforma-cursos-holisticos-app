-- T-401 · El aviso del maestro al escribir, «sobre sí» con la invitación propia y las dos firmas del fraude
-- (decisiones de Sergio del 2026-10-30).
--
-- Con el aviso de privacidad del maestro pendiente, la base no deja escribir a su nombre: una pestaña abierta no
-- sigue guardando. El maestro de una invitación viva al correo propio cuenta como propio, aunque todavía no tenga
-- cuenta atada. Y una suspensión por fraude no la confirma quien la propuso ni quien marcó la alerta como fraude.
begin;
\ir _ayuda.psql
select plan(27);

-- k1 y k2 tienen Contenido; kf, Contenido y finanzas; f1, finanzas; cf, configuración; mara es maestra.
select pruebas.alta('c6100000-0000-0000-0000-000000000001', 'k1-61@prueba.test');
select pruebas.alta('c6100000-0000-0000-0000-000000000002', 'k2-61@prueba.test');
select pruebas.alta('c6100000-0000-0000-0000-000000000003', 'kf-61@prueba.test');
select pruebas.alta('c6100000-0000-0000-0000-000000000004', 'f1-61@prueba.test');
select pruebas.alta('c6100000-0000-0000-0000-000000000005', 'cf-61@prueba.test');
select pruebas.alta('a6100000-0000-0000-0000-000000000001', 'mara-61@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-61@prueba.test';
select pruebas.dar_capacidad('c6100000-0000-0000-0000-000000000001', 'content');
select pruebas.dar_capacidad('c6100000-0000-0000-0000-000000000002', 'content');
select pruebas.dar_capacidad('c6100000-0000-0000-0000-000000000003', 'content');
select pruebas.dar_capacidad('c6100000-0000-0000-0000-000000000003', 'finance');
select pruebas.dar_capacidad('c6100000-0000-0000-0000-000000000004', 'finance');
select pruebas.dar_capacidad('c6100000-0000-0000-0000-000000000005', 'config');
select pruebas.equipar(id) from auth.users where email in
  ('k1-61@prueba.test', 'k2-61@prueba.test', 'kf-61@prueba.test', 'f1-61@prueba.test', 'cf-61@prueba.test');

create function pruebas.k1() returns uuid language sql immutable as $$ select 'c6100000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.k2() returns uuid language sql immutable as $$ select 'c6100000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.kf() returns uuid language sql immutable as $$ select 'c6100000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.f1() returns uuid language sql immutable as $$ select 'c6100000-0000-0000-0000-000000000004'::uuid $$;
create function pruebas.cf() returns uuid language sql immutable as $$ select 'c6100000-0000-0000-0000-000000000005'::uuid $$;
create function pruebas.mara() returns uuid language sql immutable as $$ select 'a6100000-0000-0000-0000-000000000001'::uuid $$;

-- El dueño a nombre de una persona, con su sesión de pruebas, sin cambiar de rol.
create function pruebas.dueno_a_nombre_de(p_id uuid) returns void
language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', p_id::text, true), set_config('app.actor_session', pruebas.sesion(p_id)::text, true);
$$;
create function pruebas.aviso() returns uuid
language sql security definer as $$ select private.current_legal_document('teacher_privacy_notice') $$;
-- Un consentimiento del aviso vigente, o su retiro, de esa persona.
create function pruebas.consiente(p_id uuid, p_action text default 'granted') returns void
language plpgsql as $$
begin
  perform pruebas.dueno_a_nombre_de(p_id);
  insert into public.consents (profile_id, legal_document_id, action, origin)
  values (p_id, pruebas.aviso(), p_action::public.consent_action, 'account_settings');
  perform pruebas.limpiar();
end
$$;
-- ¿Qué maestro activo ve la base para esa persona?
create function pruebas.activo(p_id uuid) returns uuid
language plpgsql as $$
declare
  v uuid;
begin
  perform pruebas.dueno_a_nombre_de(p_id);
  v := private.current_active_teacher_id();
  perform pruebas.limpiar();
  return v;
end
$$;
-- Una alerta de salto de puntos de ese maestro, abierta por el sistema.
create function pruebas.alerta(p_teacher uuid) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(private.period_of(clock_timestamp()));
  insert into public.anomaly_alerts (period_id, kind, teacher_id, metric_value, threshold_value)
  values (private.period_of(clock_timestamp()), 'teacher_points_jump', p_teacher, 500, 300) returning id into v_id;
  perform pruebas.limpiar();
  return v_id;
end
$$;
create function pruebas.solicitud(p_teacher uuid) returns uuid
language sql security definer as $$ select r.id from private.teacher_suspension_requests r where r.teacher_id = p_teacher order by r.proposed_at desc limit 1 $$;
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

-- Los textos del maestro, los de esta prueba: una versión 1 del sistema, y las demás las publica configuración.
select pruebas.como_dueno_sistema();
alter table public.legal_documents disable trigger ledger_no_update_delete;
delete from public.legal_documents where doc_type in ('teacher_agreement', 'teacher_privacy_notice');
alter table public.legal_documents enable trigger ledger_no_update_delete;
insert into public.legal_documents (doc_type, version, title, body, effective_from) values
  ('teacher_agreement', 1, 'Contrato', 'Texto del contrato', now()),
  ('teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now());
insert into public.teachers (profile_id, status) values (pruebas.mara(), 'active') returning id as mara_m \gset
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- El aviso al escribir.

select is(pruebas.activo(pruebas.mara()), null, 'sin haber aceptado el aviso, no es maestra activa para escribir');
select pruebas.dueno_a_nombre_de(pruebas.mara());
select throws_ok(format($$insert into public.course_registry (teacher_id) values (%L)$$, :'mara_m'), '42501', null,
  'y la base no deja dar de alta un borrador a su nombre');
select pruebas.limpiar();
select pruebas.consiente(pruebas.mara());
select is(pruebas.activo(pruebas.mara()), :'mara_m'::uuid, 'con el aviso aceptado, sí');
select pruebas.dueno_a_nombre_de(pruebas.mara());
select lives_ok(format($$insert into public.course_registry (teacher_id) values (%L)$$, :'mara_m'), 'y da de alta su borrador');
select pruebas.limpiar();

select pruebas.dueno_a_nombre_de(pruebas.cf());
insert into public.legal_documents (doc_type, version, title, body, effective_from)
  values ('teacher_privacy_notice', 2, 'Aviso', 'Texto del aviso, segunda versión', now());
select pruebas.limpiar();
select is(pruebas.activo(pruebas.mara()), null, 'con un aviso nuevo, vuelve a faltarle');
select pruebas.a_nombre_de(pruebas.mara());
select is((select state from private.teacher_standing(null)), 'needs_notice', 'y el estado lo dice');
select pruebas.limpiar();
select pruebas.consiente(pruebas.mara());
select is(pruebas.activo(pruebas.mara()), :'mara_m'::uuid, 'al aceptarlo, vuelve a ser activa');
select pruebas.consiente(pruebas.mara(), 'withdrawn');
select is(pruebas.activo(pruebas.mara()), null, 'y retirarlo cuenta como no aceptado');
select pruebas.consiente(pruebas.mara());

-- ---------------------------------------------------------------------------------------
-- «Sobre sí» con la invitación propia: k2 todavía no tiene su cuenta atada al maestro.

select is(pruebas.pide(pruebas.k1(), $$private.invite_teacher('Contenido Dos', 'k2-61@prueba.test')$$), 'invited_existing',
  'k1 invita a k2');
select teacher_id as k2_m from private.teacher_invitations where email = 'k2-61@prueba.test' \gset
select make_date(private.period_of(clock_timestamp()) / 100, private.period_of(clock_timestamp()) % 100, 1) as mes \gset
select is(pruebas.pide(pruebas.k2(), format('private.set_teacher_founder(%L, %L)', :'k2_m', :'mes')), 'self',
  'k2 no se marca fundador antes de aceptar');
select is(pruebas.pide(pruebas.k2(), format('private.suspend_teacher(%L, %L, %L)', :'k2_m', 'motivo', 'aviso')), 'self',
  'ni se suspende');
select is((pruebas.fila(pruebas.k2(), :'k2_m') ->> 'is_self')::boolean, true, 'y la lista le dice a k2 que es el suyo');
select is((pruebas.fila(pruebas.k1(), :'k2_m') ->> 'is_self')::boolean, false, 'a k1, no');
select pruebas.dueno_a_nombre_de(pruebas.k2());
select is(private.actor_owns_teacher(:'k2_m'), true, 'el ayudante cuenta la invitación viva');
select pruebas.limpiar();
select is(pruebas.pide(pruebas.k1(), format('private.set_teacher_founder(%L, %L)', :'k2_m', :'mes')), 'set', 'k1 sí lo marca');
select is(pruebas.pide(pruebas.k1(), format('private.revoke_teacher_invitation(%L)', :'k2_m')), 'revoked', 'k1 revoca');
select is((pruebas.fila(pruebas.k2(), :'k2_m') ->> 'is_self')::boolean, false, 'revocada, ya no es suyo');
select is(pruebas.pide(pruebas.k2(), format('private.set_teacher_founder(%L, null)', :'k2_m')), 'cleared',
  'y k2 ya puede actuar sobre ese maestro');
-- Un maestro sin cuenta ni invitación no es de nadie.
select pruebas.dueno_a_nombre_de(pruebas.k2());
select is(private.actor_owns_teacher(gen_random_uuid()), false, 'un maestro que no existe, no');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- La lista dice si el código es reciente.

select is((select r ->> 'fresh_code' from (select pruebas.pide(pruebas.k1(), 'private.teacher_roster()::text')::jsonb as r) x), 'true',
  'con el código reciente, lo dice');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '20 minutes' where session_id = pruebas.sesion(pruebas.k1());
select is((select r ->> 'fresh_code' from (select pruebas.pide(pruebas.k1(), 'private.teacher_roster()::text')::jsonb as r) x), 'false',
  'vencido, también, y la lista se sigue leyendo');
select pruebas.equipar(pruebas.k1());

-- ---------------------------------------------------------------------------------------
-- Las dos firmas: kf marca la alerta como fraude, f1 propone.

select pruebas.alerta(:'mara_m') as alerta \gset
select is(pruebas.pide(pruebas.kf(), format('private.review_alert(%L, %L, true, %L)::text', :'alerta', 'revisada', 'evidencia'))::jsonb ->> 'outcome',
  'reviewed', 'kf marca la alerta como fraude');
select is(pruebas.pide(pruebas.f1(), format('private.propose_fraud_suspension(%L, %L)', :'alerta', 'Puntos inflados')), 'proposed',
  'f1 propone');
select pruebas.solicitud(:'mara_m') as solicitud \gset
select is(pruebas.pide(pruebas.kf(), format('private.decide_fraud_suspension(%L, true, null, %L)', :'solicitud', 'aviso')), 'proposer',
  'quien marcó el fraude no confirma, aunque tenga Contenido');
select is(pruebas.pide(pruebas.k1(), format('private.decide_fraud_suspension(%L, true, null, %L)', :'solicitud', 'aviso')), 'confirmed',
  'otra persona con Contenido, sí');

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is_empty('select * from private.schema_violations()', 'el vigilante en cero');
create or replace function private.set_teacher_founder(p_teacher uuid, p_since date) returns text
language plpgsql security definer set search_path = ''
as $$ begin return 'set'; end $$;
select ok(exists (select 1 from private.schema_violations()
                  where problem = 'teachers self rule missing: private.set_teacher_founder(uuid, date)'),
  've al fundador sin su comprobación');

select * from finish();
rollback;
