-- T-401, segunda solicitud · La invitación del maestro (RF-104, FL-30, CO-10). Esquema §6.2.
--
-- Contenido invita con nombre y correo, como el equipo y sin correo propio (decisión de Sergio del
-- 2026-10-29). La persona se registra con ese correo, o recupera su contraseña, y en ese navegador
-- queda el resguardo del buzón. Aceptar pide ese resguardo, posterior a la invitación, los dos textos
-- vigentes del maestro (el contrato y su aviso de privacidad) y una invitación viva y sin caducar a su
-- correo actual. Sirve una vez. Nadie actúa sobre sí: no se invita, no se reenvía ni se revoca.
begin;
\ir _ayuda.psql
select plan(148);

-- Contenido: k1 y k2. Configuración: cf. Personas: nora (con cuenta), suse (cuenta suspendida), tomas
-- (alumno), vale (maestra activa), lalo (maestro suspendido), pia (pendiente de su contraseña).
select pruebas.alta('c0000000-0000-0000-0000-000000000001', 'contenido1@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000002', 'contenido2@prueba.test');
select pruebas.alta('c0000000-0000-0000-0000-000000000003', 'config@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'nora@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'suse@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000003', 'tomas@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000004', 'vale@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000005', 'lalo@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000006', 'pia@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%@prueba.test';
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'content');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000002', 'content');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000003', 'config');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');
select pruebas.equipar('c0000000-0000-0000-0000-000000000002');
select pruebas.equipar('c0000000-0000-0000-0000-000000000003');
select pruebas.suspender('a0000000-0000-0000-0000-000000000002');
select count(*)::int as maestros_0 from public.teachers \gset

-- El dueño a nombre de una persona, con su sesión de pruebas, sin cambiar de rol.
create function pruebas.dueno_a_nombre_de(p_id uuid) returns void
language sql
as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', p_id::text, true),
         set_config('app.actor_session', pruebas.sesion(p_id)::text, true);
$$;

-- Un maestro con cuenta, como lo dejaría el sistema.
create function pruebas.maestro_con_cuenta(p_profile uuid, p_status text) returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  perform pruebas.como_dueno_sistema();
  insert into public.teachers (profile_id, status, suspended_at, suspension_reason)
  values (p_profile, p_status::public.teacher_status,
          case when p_status = 'suspended' then now() end, case when p_status = 'suspended' then 'prueba' end)
  returning id into v_id;
  perform pruebas.limpiar();
  return v_id;
end
$$;

-- Lo que leen las pruebas de la tabla privada, como el dueño.
create function pruebas.viva(p_email text) returns private.teacher_invitations
language sql security definer
as $$ select i from private.teacher_invitations i where i.email = p_email and i.accepted_at is null and i.revoked_at is null $$;

create function pruebas.ultima(p_email text) returns private.teacher_invitations
language sql security definer
as $$ select i from private.teacher_invitations i where i.email = p_email order by i.created_at desc limit 1 $$;

create function pruebas.texto(p_type text) returns uuid
language sql security definer
as $$ select private.current_legal_document(p_type::public.legal_doc_type) $$;

-- Aceptar con los textos vigentes, salvo que se digan otros.
create function pruebas.acepta(p_id uuid, p_ticket text, p_agreement uuid default null, p_notice uuid default null)
returns text
language plpgsql
as $$
declare
  v_agreement uuid := coalesce(p_agreement, pruebas.texto('teacher_agreement'));
  v_notice uuid := coalesce(p_notice, pruebas.texto('teacher_privacy_notice'));
  v_state text;
begin
  perform pruebas.a_nombre_de(p_id);
  v_state := private.accept_teacher_invitation(p_ticket, v_agreement, v_notice, '203.0.113.7'::inet, 'navegador de prueba');
  perform pruebas.limpiar();
  return v_state;
end
$$;

create function pruebas.estado(p_id uuid, p_ticket text default null) returns text
language plpgsql
as $$
declare
  v_state text;
begin
  perform pruebas.a_nombre_de(p_id);
  select s.state into v_state from private.teacher_standing(p_ticket) s;
  perform pruebas.limpiar();
  return v_state;
end
$$;

grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- Estructura y permisos.

select ok(
  not has_any_column_privilege('app_service', 'private.teacher_invitations', 'select, insert, update')
    and not has_table_privilege('app_service', 'private.teacher_invitations', 'delete')
    and not has_any_column_privilege('authenticated', 'private.teacher_invitations', 'select, insert, update')
    and not has_any_column_privilege('anon', 'private.teacher_invitations', 'select, insert, update')
    and not has_any_column_privilege('service_role', 'private.teacher_invitations', 'select, insert, update'),
  'nadie de la aplicación toca las invitaciones de maestro');
select ok(
  bool_and(has_function_privilege('app_service', f, 'execute')
           and not has_function_privilege('authenticated', f, 'execute')
           and not has_function_privilege('anon', f, 'execute')
           and not has_function_privilege('service_role', f, 'execute')),
  'las seis funciones del servidor las ejecuta solo el servidor')
from unnest(array[
  'private.invite_teacher(text, text)',
  'private.reinvite_teacher(uuid)',
  'private.revoke_teacher_invitation(uuid)',
  'private.accept_teacher_invitation(text, uuid, uuid, inet, text)',
  'private.teacher_standing(text)',
  'private.teacher_roster()']) as f;
select ok(
  bool_and(not has_function_privilege('app_service', f, 'execute')
           and not has_function_privilege('authenticated', f, 'execute')
           and not has_function_privilege('anon', f, 'execute')
           and not has_function_privilege('service_role', f, 'execute')),
  'las internas y la del dueño no las ejecuta nadie de la aplicación')
from unnest(array[
  'private.teacher_invitation_lock()',
  'private.teacher_name_ok(text)',
  'private.teacher_notice_pending(uuid)',
  'private.teacher_inviter_ok(uuid)',
  'private.place_teacher_invitation(uuid, text, text, uuid)',
  'private.system_invite_teacher(uuid, text)']) as f;
select is_empty('select * from private.schema_violations()', 'el vigilante en cero al empezar');

-- ---------------------------------------------------------------------------------------
-- La puerta: Contenido con un código reciente.

select is(pruebas.pide('a0000000-0000-0000-0000-000000000003', $$private.invite_teacher('Tomás', 'otro@prueba.test')$$),
  'forbidden', 'un alumno no invita');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003', $$private.invite_teacher('Tomás', 'otro@prueba.test')$$),
  'forbidden', 'configuración no es Contenido');
select pruebas.sin_codigo('c0000000-0000-0000-0000-000000000001');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('Tomás', 'otro@prueba.test')$$),
  'needs_fresh_code', 'Contenido sin código reciente lo da otra vez');
select pruebas.equipar('c0000000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------------------------------
-- Sin los dos textos del maestro no se invita (decisión mía sin confirmar): nadie recibe una
-- invitación que no podría aceptar. Se quitan los borradores que hubiera, solo en esta transacción.

select pruebas.como_dueno_sistema();
alter table public.legal_documents disable trigger ledger_no_update_delete;
delete from public.legal_documents where doc_type in ('teacher_agreement', 'teacher_privacy_notice');
alter table public.legal_documents enable trigger ledger_no_update_delete;
select pruebas.limpiar();

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('Nora Luz', 'nora@prueba.test')$$),
  'unavailable', 'sin el contrato ni el aviso del maestro no se invita');
select pruebas.como_dueno_sistema();
insert into public.legal_documents (doc_type, version, title, body, effective_from)
  values ('teacher_agreement', 1, 'Contrato', 'Texto del contrato', now());
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('Nora Luz', 'nora@prueba.test')$$),
  'unavailable', 'con el contrato y sin el aviso, tampoco');
select pruebas.como_dueno();
select is((select count(*)::int from public.teachers), :maestros_0, 'y no quedó ningún maestro');
select pruebas.como_dueno_sistema();
insert into public.legal_documents (doc_type, version, title, body, effective_from)
  values ('teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now());
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Lo que llega.

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('', 'nora@prueba.test')$$),
  'invalid', 'sin nombre no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher(null, 'nora@prueba.test')$$),
  'invalid', 'con nombre nulo no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher(E'Nora\nLuz', 'nora@prueba.test')$$),
  'invalid', 'con un salto de línea en el nombre no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher(E'Nora​Luz', 'nora@prueba.test')$$),
  'invalid', 'con un carácter invisible en el nombre no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.invite_teacher(%L, %L)', repeat('a', 81), 'nora@prueba.test')),
  'invalid', 'con un nombre de 81 caracteres no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('---', 'nora@prueba.test')$$),
  'invalid', 'con un nombre sin letras ni cifras no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('Nora Luz', 'nora')$$),
  'invalid', 'con algo que no es un correo no');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('Nora Luz', null)$$),
  'invalid', 'sin correo no');

-- Nadie se invita a sí mismo (decisión de Sergio del 2026-10-29), aunque escriba su correo distinto.
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('Yo', '  CONTENIDO1@prueba.test ')$$),
  'self', 'Contenido no se invita a sí mismo');

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('Susana', 'suse@prueba.test')$$),
  'ineligible', 'una cuenta suspendida no se invita');
select pruebas.maestro_con_cuenta('a0000000-0000-0000-0000-000000000004', 'active') as vale \gset
select pruebas.maestro_con_cuenta('a0000000-0000-0000-0000-000000000005', 'suspended') as lalo \gset
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('Vale', 'vale@prueba.test')$$),
  'already_teacher', 'quien ya es maestro no se invita');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('Lalo', 'lalo@prueba.test')$$),
  'already_teacher', 'ni quien está suspendido como maestro');
select pruebas.como_dueno();
select is((select count(*)::int from public.teachers), :maestros_0 + 2, 'ninguno de los rechazos dejó un maestro');

-- ---------------------------------------------------------------------------------------
-- Invitar.

select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('  Nora Luz ', ' NORA@prueba.test ')$$),
  'invited_existing', 'a una cuenta que ya existe');
select pruebas.como_dueno();
select (pruebas.viva('nora@prueba.test')).teacher_id as nora_m \gset
select results_eq(
  format($$select t.status::text, t.profile_id, t.created_by, t.is_founder from public.teachers t where t.id = %L$$, :'nora_m'),
  $$values ('invited', null::uuid, 'c0000000-0000-0000-0000-000000000001'::uuid, false)$$,
  'el maestro nace invitado, sin cuenta y a nombre de quien invitó');
select results_eq(
  format($$select p.slug, p.display_name, p.is_listed from public.published_teachers p where p.teacher_id = %L$$, :'nora_m'),
  $$values ('nora-luz', 'Nora Luz', false)$$,
  'y su ficha sin listar, con el nombre limpio');
select ok(
  (select i.email = 'nora@prueba.test' and i.profile_id = 'a0000000-0000-0000-0000-000000000001'
      and i.invited_by = 'c0000000-0000-0000-0000-000000000001'
      and i.expires_at = i.created_at + interval '7 days' and i.created_at <= clock_timestamp()
   from pruebas.viva('nora@prueba.test') i),
  'la invitación: el correo limpio, la cuenta, quién invitó y su plazo');
select ok(
  exists (select 1 from public.audit_log a
          where a.entity_table = 'private.teacher_invitations' and a.action = 'teacher_invitations.insert'
            and a.category = 'access' and a.actor_id = 'c0000000-0000-0000-0000-000000000001'),
  'invitar queda en la auditoría de acceso');

select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', $$private.invite_teacher('Nora', 'nora@prueba.test')$$),
  'already_invited', 'el mismo correo no se invita dos veces');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('Nora Luz', 'olga@prueba.test')$$),
  'invited_new', 'a un correo sin cuenta');
select pruebas.como_dueno();
select (pruebas.viva('olga@prueba.test')).teacher_id as olga_m \gset
select is((select slug from public.published_teachers where teacher_id = :'olga_m'), 'nora-luz-2',
  'el mismo nombre toma otra dirección');
select ok((select i.profile_id is null from pruebas.viva('olga@prueba.test') i), 'sin cuenta, la invitación no apunta a ninguna');
-- Alguien del equipo puede ser maestro (decisión de Sergio del 2026-10-29).
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('Contenido Dos', 'contenido2@prueba.test')$$),
  'invited_existing', 'alguien del equipo puede ser invitado por otra persona');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('Pía', 'pia@prueba.test')$$),
  'invited_existing', 'una cuenta que no ha fijado su contraseña también se invita');

-- ---------------------------------------------------------------------------------------
-- El estado de quien entra.

select is(pruebas.estado('a0000000-0000-0000-0000-000000000003'), 'none', 'un alumno no tiene nada que ver aquí');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001'), 'invited_unproven',
  'la invitada sin resguardo tiene que probar su buzón');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000005'), 'suspended', 'el maestro suspendido');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000004'), 'needs_notice',
  'la maestra activa que no aceptó el aviso del maestro');
select pruebas.dueno_a_nombre_de('a0000000-0000-0000-0000-000000000004');
insert into public.consents (profile_id, legal_document_id, origin)
  values ('a0000000-0000-0000-0000-000000000004', pruebas.texto('teacher_privacy_notice'), 'teacher_invitation');
select pruebas.limpiar();
select is(pruebas.estado('a0000000-0000-0000-0000-000000000004'), 'active', 'con el aviso aceptado, activa');
select pruebas.dueno_a_nombre_de('a0000000-0000-0000-0000-000000000005');
insert into public.consents (profile_id, legal_document_id, origin)
  values ('a0000000-0000-0000-0000-000000000005', pruebas.texto('teacher_privacy_notice'), 'teacher_invitation');
insert into public.consents (profile_id, legal_document_id, action, origin)
  values ('a0000000-0000-0000-0000-000000000005', pruebas.texto('teacher_privacy_notice'), 'withdrawn', 'account_settings');
select pruebas.limpiar();
select pruebas.como_dueno_sistema();
update public.teachers set status = 'active', suspended_at = null, suspension_reason = null where id = :'lalo';
select pruebas.limpiar();
select is(pruebas.estado('a0000000-0000-0000-0000-000000000005'), 'needs_notice',
  'un aviso retirado cuenta como no aceptado');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba' where id = :'lalo';
select pruebas.limpiar();
select pruebas.a_nombre_de('a0000000-0000-0000-0000-000000000004');
select is((select s.teacher_id from private.teacher_standing(null) s), :'vale'::uuid, 'el estado dice de qué maestro');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Aceptar: el resguardo del buzón.

select is(pruebas.acepta('a0000000-0000-0000-0000-000000000001', null), 'ineligible',
  'con la contraseña sin fijar no se acepta');
select is(pruebas.reclamar('a0000000-0000-0000-0000-000000000001', null), 'claimed', 'nora fija su contraseña sin resguardo');
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000001', null), 'needs_mailbox_proof', 'sin resguardo no se acepta');
select is(pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-1')), 'already_claimed',
  'nora recupera su contraseña desde el correo');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-1')), 'invited',
  'con su resguardo, invitada');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('otro')), 'invited_unproven',
  'con otro resguardo, no');
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000001', pruebas.huella('otro')), 'needs_mailbox_proof',
  'con otro resguardo no se acepta');
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000001', 'nora-1'), 'needs_mailbox_proof',
  'ni con el secreto sin su huella');
select pruebas.como_dueno_sistema();
update private.teacher_invitations set created_at = clock_timestamp() - interval '2 hours'
  where id = (pruebas.viva('nora@prueba.test')).id;
update private.account_security set mailbox_proven_at = clock_timestamp() - interval '61 minutes'
  where profile_id = 'a0000000-0000-0000-0000-000000000001';
select pruebas.limpiar();
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-1')), 'needs_mailbox_proof',
  'ni con un resguardo vencido');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-1')), 'invited_unproven',
  'y el estado dice lo mismo');
-- La invitación de hace diez minutos: un resguardo de su misma hora está vigente, y solo falla por no
-- ser posterior a ella.
select pruebas.como_dueno_sistema();
update private.teacher_invitations set created_at = clock_timestamp() - interval '10 minutes'
  where id = (pruebas.viva('nora@prueba.test')).id;
update private.account_security set mailbox_proven_at = (pruebas.viva('nora@prueba.test')).created_at
  where profile_id = 'a0000000-0000-0000-0000-000000000001';
select pruebas.limpiar();
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-1')), 'needs_mailbox_proof',
  'ni con uno de la misma hora que la invitación');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-1')), 'invited_unproven',
  'y el estado dice lo mismo');
-- Posterior y vigente, pero probado con otro correo.
select pruebas.como_dueno();
update private.account_security
  set mailbox_proven_at = clock_timestamp() - interval '1 minute', mailbox_proven_email = 'otra@prueba.test'
  where profile_id = 'a0000000-0000-0000-0000-000000000001';
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-1')), 'needs_mailbox_proof',
  'ni con uno probado con otro correo');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-1')), 'invited_unproven',
  'y el estado dice lo mismo');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-2'));

-- Los textos.
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-2'),
                          pruebas.texto('teacher_privacy_notice'), pruebas.texto('teacher_agreement')),
  'changed', 'con los textos cruzados no se acepta');
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-2'),
                          gen_random_uuid(), null),
  'changed', 'ni con un contrato que no existe');
select pruebas.a_nombre_de('a0000000-0000-0000-0000-000000000001');
select is(private.accept_teacher_invitation(pruebas.huella('nora-2'), null, null, null, null), 'changed',
  'ni sin decir qué textos vio');
select pruebas.limpiar();
-- Un aviso nuevo entre mostrar y aceptar.
select pruebas.texto('teacher_privacy_notice') as aviso_1 \gset
select pruebas.dueno_a_nombre_de('c0000000-0000-0000-0000-000000000003');
insert into public.legal_documents (doc_type, version, title, body, effective_from)
  values ('teacher_privacy_notice', 2, 'Aviso', 'Texto del aviso, segunda versión', now());
select pruebas.limpiar();
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-2'), null, :'aviso_1'),
  'changed', 'si el aviso cambió entre mostrarlo y aceptar, se vuelve a mostrar');
select pruebas.como_dueno();
select is((select count(*)::int from public.consents where profile_id = 'a0000000-0000-0000-0000-000000000001'), 0,
  'ningún rechazo dejó un consentimiento');

-- Otras dos sesiones de nora, que aceptar cierra; la suya se queda.
select pruebas.verificar('a0000000-0000-0000-0000-000000000001', null, 'e0000000-0000-0000-0000-000000000001');
select pruebas.como_dueno();
insert into auth.sessions (id, user_id, aal, created_at, updated_at)
  values (pruebas.sesion('a0000000-0000-0000-0000-000000000001'), 'a0000000-0000-0000-0000-000000000001', 'aal1', now(), now())
  on conflict (id) do nothing;
insert into private.app_sessions (session_id, profile_id)
  values (pruebas.sesion('a0000000-0000-0000-0000-000000000001'), 'a0000000-0000-0000-0000-000000000001')
  on conflict (session_id) do nothing;

select is(pruebas.acepta('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-2')), 'accepted', 'nora acepta');
select pruebas.como_dueno();
select results_eq(
  format($$select t.status::text, t.profile_id from public.teachers t where t.id = %L$$, :'nora_m'),
  $$values ('active', 'a0000000-0000-0000-0000-000000000001'::uuid)$$,
  'su maestro queda activo y atado a su cuenta');
select ok(
  (select i.accepted_by = 'a0000000-0000-0000-0000-000000000001' and i.accepted_at is not null and i.revoked_at is null
   from pruebas.ultima('nora@prueba.test') i),
  'la invitación queda aceptada');
select results_eq(
  $$select d.doc_type::text, c.action::text, c.origin, host(c.ip), c.user_agent
    from public.consents c join public.legal_documents d on d.id = c.legal_document_id
    where c.profile_id = 'a0000000-0000-0000-0000-000000000001' order by d.doc_type::text$$,
  $$values ('teacher_agreement', 'granted', 'teacher_invitation', '203.0.113.7', 'navegador de prueba'),
           ('teacher_privacy_notice', 'granted', 'teacher_invitation', '203.0.113.7', 'navegador de prueba')$$,
  'con los dos consentimientos, desde la invitación');
select ok(
  (select c.legal_document_id = pruebas.texto('teacher_privacy_notice') from public.consents c
   join public.legal_documents d on d.id = c.legal_document_id
   where c.profile_id = 'a0000000-0000-0000-0000-000000000001' and d.doc_type = 'teacher_privacy_notice'),
  'el aviso aceptado es el vigente');
select is((select s.mailbox_ticket from private.account_security s where s.profile_id = 'a0000000-0000-0000-0000-000000000001'),
  null, 'el resguardo se gasta');
select results_eq(
  $$select s.id from auth.sessions s where s.user_id = 'a0000000-0000-0000-0000-000000000001'$$,
  $$select pruebas.sesion('a0000000-0000-0000-0000-000000000001')$$,
  'las otras sesiones se cierran y la suya se queda');
select results_eq(
  $$select x.session_id from private.app_sessions x where x.profile_id = 'a0000000-0000-0000-0000-000000000001'$$,
  $$select pruebas.sesion('a0000000-0000-0000-0000-000000000001')$$,
  'también en lo anotado');
select ok(
  exists (select 1 from public.audit_log a
          where a.entity_table = 'public.teachers' and a.action = 'teachers.update'
            and a.actor_id = 'a0000000-0000-0000-0000-000000000001' and a.entity_id = :'nora_m'),
  'el cambio del maestro queda a su nombre en la auditoría');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000001'), 'active', 'y entra como maestra activa');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-3'));
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000001', pruebas.huella('nora-3')), 'no_invitation',
  'la invitación sirve una vez');
select pruebas.a_nombre_de('a0000000-0000-0000-0000-000000000001');
select is(private.teacher_roster(), null, 'una maestra no lee la lista de maestros');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Aceptar: la cuenta.

select is(pruebas.reclamar('a0000000-0000-0000-0000-000000000006', null), 'claimed', 'pía fija su contraseña sin resguardo');
select pruebas.como_dueno();
select pruebas.reclamar('a0000000-0000-0000-0000-000000000006', pruebas.huella('pia-1'));
select pruebas.como_dueno();
update auth.users set email_confirmed_at = null where id = 'a0000000-0000-0000-0000-000000000006';
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000006', pruebas.huella('pia-1')), 'ineligible',
  'con el correo sin confirmar no se acepta');
select pruebas.confirmar('a0000000-0000-0000-0000-000000000006');
select pruebas.como_dueno();
select set_config('app.claiming_account', 'on', true);
update public.profiles set password_reset_required = true where id = 'a0000000-0000-0000-0000-000000000006';
select pruebas.limpiar();
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000006', pruebas.huella('pia-1')), 'ineligible',
  'con la contraseña pendiente no se acepta');
select pruebas.como_dueno();
select set_config('app.claiming_account', 'on', true);
update public.profiles set password_reset_required = false where id = 'a0000000-0000-0000-0000-000000000006';
select pruebas.limpiar();
update auth.users set is_sso_user = true where id = 'a0000000-0000-0000-0000-000000000006';
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000006', pruebas.huella('pia-1')), 'ineligible',
  'una cuenta de acceso federado no acepta');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000006', pruebas.huella('pia-1')), 'none',
  'y su estado no dice invitación');
update auth.users set is_sso_user = false where id = 'a0000000-0000-0000-0000-000000000006';

-- El correo cambió en Auth después de invitar: la invitación es del correo, no de la cuenta.
update auth.users set email = 'pia.nueva@prueba.test' where id = 'a0000000-0000-0000-0000-000000000006';
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000006', pruebas.huella('pia-1')), 'no_invitation',
  'con otro correo en la cuenta no hay invitación');
-- Y otra cuenta que toma ese correo no acepta lo que se invitó a la primera.
select pruebas.alta('a0000000-0000-0000-0000-000000000007', 'pia@prueba.test');
select pruebas.confirmar('a0000000-0000-0000-0000-000000000007');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000007', pruebas.huella('pia-otra'));
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000007', pruebas.huella('pia-otra')), 'no_invitation',
  'otra cuenta con el mismo correo no acepta');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000007', pruebas.huella('pia-otra')), 'none',
  'ni la ve como suya');
update auth.users set email = 'pia.siete@prueba.test' where id = 'a0000000-0000-0000-0000-000000000007';
update auth.users set email = 'pia@prueba.test' where id = 'a0000000-0000-0000-0000-000000000006';
select pruebas.suspender('a0000000-0000-0000-0000-000000000006');
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000006', pruebas.huella('pia-1')), 'ineligible',
  'una cuenta suspendida no acepta');

-- Quien invitó ya no tiene Contenido: la invitación ya no vale y se revoca.
select pruebas.alta('a0000000-0000-0000-0000-000000000008', 'quique@prueba.test');
select pruebas.confirmar('a0000000-0000-0000-0000-000000000008');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', $$private.invite_teacher('Quique', 'quique@prueba.test')$$),
  'invited_existing', 'k2 invita a quique');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000008', pruebas.huella('quique-1'));
select pruebas.como_dueno_sistema();
update public.admin_capabilities set revoked_at = now(), revoked_by = 'c0000000-0000-0000-0000-000000000003'
  where profile_id = 'c0000000-0000-0000-0000-000000000002' and capability = 'content';
select pruebas.limpiar();
select is(pruebas.estado('a0000000-0000-0000-0000-000000000008', pruebas.huella('quique-1')), 'none',
  'sin Contenido de quien invitó, el estado no dice invitación');
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000008', pruebas.huella('quique-1')), 'inviter_lost_content',
  'y aceptar la revoca');
select ok((select i.revoked_at is not null from pruebas.ultima('quique@prueba.test') i), 'queda revocada');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000002', 'content');
select pruebas.equipar('c0000000-0000-0000-0000-000000000002');

-- La cuenta se volvió maestra por otro camino mientras tanto.
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001',
  format('private.reinvite_teacher(%L)', (pruebas.ultima('quique@prueba.test')).teacher_id)),
  'invited_existing', 'k1 le reenvía la invitación a quique');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000008', pruebas.huella('quique-2'));
select pruebas.maestro_con_cuenta('a0000000-0000-0000-0000-000000000008', 'active');
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000008', pruebas.huella('quique-2')), 'already_teacher',
  'quien ya es maestro no acepta otra invitación');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000008', pruebas.huella('quique-2')), 'needs_notice',
  'su estado es el de su maestro, no el de la invitación');

-- ---------------------------------------------------------------------------------------
-- Caducar, reenviar y revocar.

select pruebas.alta('a0000000-0000-0000-0000-000000000009', 'rosa@prueba.test');
select pruebas.confirmar('a0000000-0000-0000-0000-000000000009');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', $$private.invite_teacher('Rosa', 'rosa@prueba.test')$$),
  'invited_existing', 'rosa invitada');
select (pruebas.viva('rosa@prueba.test')).teacher_id as rosa_m \gset
select (pruebas.viva('rosa@prueba.test')).id as rosa_i1 \gset
select pruebas.reclamar('a0000000-0000-0000-0000-000000000009', pruebas.huella('rosa-1'));
select pruebas.como_dueno_sistema();
update private.teacher_invitations
  set created_at = clock_timestamp() - interval '1 minute', expires_at = clock_timestamp() - interval '1 millisecond'
  where id = :'rosa_i1';
select pruebas.limpiar();
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000009', pruebas.huella('rosa-1')), 'no_invitation',
  'una invitación caducada no se acepta');
select is(pruebas.estado('a0000000-0000-0000-0000-000000000009', pruebas.huella('rosa-1')), 'none',
  'ni cuenta como invitación');
select pruebas.como_dueno_sistema();
update private.teacher_invitations set expires_at = clock_timestamp() + interval '1 minute' where id = :'rosa_i1';
select pruebas.limpiar();
select is(pruebas.estado('a0000000-0000-0000-0000-000000000009', pruebas.huella('rosa-1')), 'invited',
  'un minuto antes de caducar, sí');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', $$private.invite_teacher('Rosa', 'rosa@prueba.test')$$),
  'already_invited', 'a quien ya tiene invitación se le reenvía, no se le invita otra vez');

select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.reinvite_teacher(%L)', :'rosa_m')),
  'invited_existing', 'reenviar');
select ok(
  (select i.revoked_at is not null and i.revoked_by = 'c0000000-0000-0000-0000-000000000002'
   from private.teacher_invitations i where i.id = :'rosa_i1'),
  'la anterior queda revocada por quien reenvió');
select ok(
  (select i.id <> :'rosa_i1' and i.teacher_id = :'rosa_m' and i.email = 'rosa@prueba.test'
      and i.invited_by = 'c0000000-0000-0000-0000-000000000002'
   from pruebas.viva('rosa@prueba.test') i),
  'la nueva es del mismo maestro y del mismo correo');
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000009', pruebas.huella('rosa-1')), 'needs_mailbox_proof',
  'el resguardo de antes de reenviar ya no vale');

select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.revoke_teacher_invitation(%L)', :'rosa_m')),
  'revoked', 'revocar');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.revoke_teacher_invitation(%L)', :'rosa_m')),
  'not_found', 'revocar dos veces no');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000009', pruebas.huella('rosa-2'));
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000009', pruebas.huella('rosa-2')), 'no_invitation',
  'una revocada no se acepta');
select pruebas.como_dueno();
select is((select status::text from public.teachers where id = :'rosa_m'), 'invited', 'su maestro sigue invitado');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', $$private.invite_teacher('Rosa', 'rosa@prueba.test')$$),
  'already_invited', 'y no se le crea otro: se le reenvía');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.reinvite_teacher(%L)', :'rosa_m')),
  'invited_existing', 'reenviar reusa al maestro revocado');
select pruebas.reclamar('a0000000-0000-0000-0000-000000000009', pruebas.huella('rosa-3'));
select is(pruebas.acepta('a0000000-0000-0000-0000-000000000009', pruebas.huella('rosa-3')), 'accepted', 'y rosa acepta');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.reinvite_teacher(%L)', :'rosa_m')),
  'already_teacher', 'a quien ya aceptó no se le reenvía');
update auth.users set email = 'rosa.nueva@prueba.test' where id = 'a0000000-0000-0000-0000-000000000009';
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.reinvite_teacher(%L)', :'rosa_m')),
  'already_teacher', 'ni aunque su cuenta ya tenga otro correo');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.reinvite_teacher(%L)', gen_random_uuid())),
  'not_found', 'reenviar a un maestro que no existe');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003', format('private.reinvite_teacher(%L)', :'rosa_m')),
  'forbidden', 'configuración no reenvía');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000003', format('private.revoke_teacher_invitation(%L)', :'rosa_m')),
  'forbidden', 'ni revoca');

-- Sobre sí: k2 tiene una invitación de maestro (la puso k1) y no la reenvía ni la revoca.
select (pruebas.viva('contenido2@prueba.test')).teacher_id as k2_m \gset
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.reinvite_teacher(%L)', :'k2_m')),
  'self', 'nadie se reenvía su propia invitación');
select is(pruebas.pide('c0000000-0000-0000-0000-000000000002', format('private.revoke_teacher_invitation(%L)', :'k2_m')),
  'self', 'ni la revoca');
select pruebas.reclamar('c0000000-0000-0000-0000-000000000002', pruebas.huella('k2-1'));
select is(pruebas.acepta('c0000000-0000-0000-0000-000000000002', pruebas.huella('k2-1')), 'accepted',
  'pero sí la acepta: es suya');

-- ---------------------------------------------------------------------------------------
-- El maestro que cargó el sistema: su correo lo ata el dueño de la base, no Contenido
-- (decisión mía sin confirmar).

select pruebas.como_dueno_sistema();
select private.system_add_teacher('Sistema Uno', 'sistema-uno', null) as sis_m \gset
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.reinvite_teacher(%L)', :'sis_m')),
  'not_found', 'Contenido no le pone correo a un maestro del sistema');
select pruebas.dueno_a_nombre_de('c0000000-0000-0000-0000-000000000001');
select throws_ok(format('select private.system_invite_teacher(%L, %L)', :'sis_m', 'sis@prueba.test'),
  '42501', null, 'sin declararse sistema, el dueño no le pone correo');
select pruebas.como_dueno_sistema();
select is(private.system_invite_teacher(:'sis_m', 'sis@prueba.test'), 'invited_new', 'el dueño declarado sistema, sí');
select is(private.system_invite_teacher(:'sis_m', 'otro.sis@prueba.test'), 'already_invited', 'una sola vez');
select ok((select i.invited_by is null from pruebas.viva('sis@prueba.test') i), 'sin persona que invite');
select pruebas.limpiar();
select is(pruebas.pide('c0000000-0000-0000-0000-000000000001', format('private.reinvite_teacher(%L)', :'sis_m')),
  'invited_new', 'después, Contenido le reenvía al mismo correo');
select ok((select i.email = 'sis@prueba.test' from pruebas.viva('sis@prueba.test') i), 'que no cambia');

-- ---------------------------------------------------------------------------------------
-- El guardián: fuera del sistema y de Contenido, solo aceptar ata la cuenta al maestro.

select pruebas.alta('a0000000-0000-0000-0000-000000000010', 'uri@prueba.test');
select pruebas.confirmar('a0000000-0000-0000-0000-000000000010');
select pruebas.como_dueno_sistema();
select private.system_add_teacher('Uri', 'uri', null) as uri_m \gset
insert into private.teacher_invitations (teacher_id, email, profile_id, created_at, expires_at, accepted_at, accepted_by)
  values (:'uri_m', 'uri@prueba.test', 'a0000000-0000-0000-0000-000000000010',
          clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 day',
          clock_timestamp(), 'a0000000-0000-0000-0000-000000000010');
select pruebas.dueno_a_nombre_de('a0000000-0000-0000-0000-000000000004');
select throws_ok(
  format($$update public.teachers set status = 'active', profile_id = 'a0000000-0000-0000-0000-000000000004' where id = %L$$, :'uri_m'),
  '42501', 'public.teachers: only the publication functions write this table',
  'una cuenta que no aceptó esa invitación no se ata');
select pruebas.dueno_a_nombre_de('a0000000-0000-0000-0000-000000000010');
select throws_ok(
  format($$update public.teachers set status = 'active', profile_id = 'a0000000-0000-0000-0000-000000000010',
                                      is_founder = true, founder_since = current_date where id = %L$$, :'uri_m'),
  '42501', 'public.teachers: only the publication functions write this table',
  'atarse no trae nada más');
select throws_ok(
  format($$update public.teachers set profile_id = 'a0000000-0000-0000-0000-000000000010' where id = %L$$, :'uri_m'),
  '42501', 'public.teachers: only the publication functions write this table',
  'ni deja al maestro invitado con cuenta');
select throws_ok(
  format($$update public.teachers set status = 'active', profile_id = 'a0000000-0000-0000-0000-000000000004' where id = %L$$, :'vale'),
  '42501', 'public.teachers: only the publication functions write this table',
  'ni toca a un maestro que ya tiene cuenta');
select pruebas.dueno_a_nombre_de('a0000000-0000-0000-0000-000000000004');
select throws_ok(
  format($$update public.teachers set status = 'active', profile_id = 'a0000000-0000-0000-0000-000000000010' where id = %L$$, :'uri_m'),
  '42501', 'public.teachers: only the publication functions write this table',
  'nadie ata a otra persona, aunque esa persona sí aceptó');
select pruebas.alta('a0000000-0000-0000-0000-000000000011', 'ximena@prueba.test');
select pruebas.como_dueno_sistema();
insert into public.teachers (profile_id, status) values ('a0000000-0000-0000-0000-000000000011', 'invited') returning id as xim_m \gset
insert into private.teacher_invitations (teacher_id, email, profile_id, created_at, expires_at, accepted_at, accepted_by)
  values (:'xim_m', 'ximena@prueba.test', 'a0000000-0000-0000-0000-000000000011',
          clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 day',
          clock_timestamp(), 'a0000000-0000-0000-0000-000000000011');
select pruebas.dueno_a_nombre_de('a0000000-0000-0000-0000-000000000011');
select throws_ok(
  format($$update public.teachers set status = 'active' where id = %L$$, :'xim_m'),
  '42501', 'public.teachers: only the publication functions write this table',
  'ni un maestro invitado que ya apunta a una cuenta pasa a activo así');
select pruebas.dueno_a_nombre_de('a0000000-0000-0000-0000-000000000010');
select lives_ok(
  format($$update public.teachers set status = 'active', profile_id = 'a0000000-0000-0000-0000-000000000010' where id = %L$$, :'uri_m'),
  'quien aceptó esa invitación, sí');
select pruebas.a_nombre_de('a0000000-0000-0000-0000-000000000010');
select throws_ok(
  format($$update public.teachers set status = 'suspended' where id = %L$$, :'uri_m'),
  '42501', null, 'el servidor no escribe la tabla de maestros');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- La lista para PA-65.

select pruebas.a_nombre_de('a0000000-0000-0000-0000-000000000003');
select is(private.teacher_roster(), null, 'un alumno no lee la lista');
select pruebas.a_nombre_de('c0000000-0000-0000-0000-000000000003');
select is(private.teacher_roster(), null, 'configuración tampoco');
select pruebas.a_nombre_de('c0000000-0000-0000-0000-000000000001');
select private.teacher_roster() as lista \gset
select pruebas.limpiar();
select ok(jsonb_typeof(:'lista'::jsonb -> 'teachers') = 'array', 'Contenido la lee');
select is(
  (select t ->> 'invitation' from jsonb_array_elements(:'lista'::jsonb -> 'teachers') t where t ->> 'teacher_id' = :'olga_m'),
  'pending', 'olga: invitación pendiente');
select is(
  (select t ->> 'email' from jsonb_array_elements(:'lista'::jsonb -> 'teachers') t where t ->> 'teacher_id' = :'olga_m'),
  'olga@prueba.test', 'con el correo invitado');
select is(
  (select t ->> 'invitation' from jsonb_array_elements(:'lista'::jsonb -> 'teachers') t where t ->> 'teacher_id' = :'nora_m'),
  'accepted', 'nora: aceptada');
select is(
  (select t ->> 'status' from jsonb_array_elements(:'lista'::jsonb -> 'teachers') t where t ->> 'teacher_id' = :'nora_m'),
  'active', 'y activa');
select is(
  (select t ->> 'invitation' from jsonb_array_elements(:'lista'::jsonb -> 'teachers') t
   where t ->> 'teacher_id' = (pruebas.ultima('pia@prueba.test')).teacher_id::text),
  'pending', 'pía: pendiente aunque su cuenta esté suspendida (lo decide aceptar)');
select is(
  (select t ->> 'invitation' from jsonb_array_elements(:'lista'::jsonb -> 'teachers') t where t ->> 'teacher_id' = :'sis_m'),
  'pending', 'el del sistema, ya con correo');
select is(
  (select t ->> 'invitation' from jsonb_array_elements(:'lista'::jsonb -> 'teachers') t where t ->> 'teacher_id' = :'vale'),
  'none', 'vale nunca tuvo invitación');
select is(
  (select (t ->> 'is_self')::boolean from jsonb_array_elements(:'lista'::jsonb -> 'teachers') t where t ->> 'teacher_id' = :'k2_m'),
  false, 'k2 no es k1');
select pruebas.como_dueno_sistema();
update private.teacher_invitations
  set created_at = clock_timestamp() - interval '2 seconds', expires_at = clock_timestamp() - interval '1 second'
  where id = (pruebas.viva('olga@prueba.test')).id;
select pruebas.a_nombre_de('c0000000-0000-0000-0000-000000000001');
select is(
  (select t ->> 'invitation' from jsonb_array_elements(private.teacher_roster() -> 'teachers') t where t ->> 'teacher_id' = :'olga_m'),
  'expired', 'una caducada dice caducada');
-- Reclamar su cuenta para aceptar le cerró a k2 sus sesiones del equipo: entra y da su código otra vez.
select pruebas.equipar('c0000000-0000-0000-0000-000000000002');
select pruebas.a_nombre_de('c0000000-0000-0000-0000-000000000002');
select is(
  (select (t ->> 'is_self')::boolean from jsonb_array_elements(private.teacher_roster() -> 'teachers') t where t ->> 'teacher_id' = :'k2_m'),
  true, 'quien lee ve cuál es el suyo');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is_empty('select * from private.schema_violations()', 'en cero después de todo');
grant select on private.teacher_invitations to app_service;
select ok(exists (select 1 from private.schema_violations()
                  where object_name = 'private.teacher_invitations' and problem like '%teachers table privilege for app_service'),
  've un permiso sobre las invitaciones de maestro');
revoke select on private.teacher_invitations from app_service;
grant execute on function private.place_teacher_invitation(uuid, text, text, uuid) to app_service;
select ok(exists (select 1 from private.schema_violations() where object_name like 'private.place_teacher_invitation%'),
  've una interna que el servidor ejecuta');
revoke execute on function private.place_teacher_invitation(uuid, text, text, uuid) from app_service;
revoke execute on function private.accept_teacher_invitation(text, uuid, uuid, inet, text) from app_service;
select ok(exists (select 1 from private.schema_violations() where object_name like 'private.accept_teacher_invitation%'),
  've una del servidor que el servidor ya no ejecuta');
grant execute on function private.accept_teacher_invitation(text, uuid, uuid, inet, text) to app_service;
alter table private.teacher_invitations disable trigger audit_changes;
select ok(exists (select 1 from private.schema_violations() where object_name = 'private.teacher_invitations'),
  've la auditoría de las invitaciones apagada');
alter table private.teacher_invitations enable trigger audit_changes;
alter table public.teachers disable trigger publication_guard;
select ok(exists (select 1 from private.schema_violations() where object_name = 'public.teachers'),
  've el guardián de los maestros apagado');
alter table public.teachers enable trigger publication_guard;
drop index private.teacher_invitations_live_email_uq;
select ok(exists (select 1 from private.schema_violations()
                  where problem = 'teachers unique index missing: teacher_invitations_live_email_uq'),
  've que falta el índice de una viva por correo');
create unique index teacher_invitations_live_email_uq on private.teacher_invitations (email)
  where accepted_at is null and revoked_at is null;
select is_empty('select * from private.schema_violations()', 'en cero al restaurar');

select * from finish();
rollback;
