-- T-604, primera solicitud · La salida de correo y el aviso de CLABE (decisión 7 de Sergio del 2026-11-02): sin el correo enviado esa CLABE no se abre, y la espera cuenta desde el envío. Si el correo
-- sale tarde la fecha se mueve; si no sale, nunca rige. La fila nace en la misma transacción que la CLABE, con el destinatario fijado al escribir. Enviar es «al menos una vez»: se reclama por tiempo y por
-- intentos. La aplicación no toca la tabla: entra por `mail_claim`, `mail_sent`, `mail_rejected` y `mail_health`.
begin;
\ir _ayuda.psql
select plan(110);

select pruebas.alta('a6700000-0000-0000-0000-000000000001', 'mara-67@prueba.test');
select pruebas.alta('c6700000-0000-0000-0000-000000000001', 'f1-67@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-67@prueba.test';
select pruebas.dar_capacidad('c6700000-0000-0000-0000-000000000001', 'finance');
select pruebas.equipar('c6700000-0000-0000-0000-000000000001');

create function pruebas.mara() returns uuid language sql immutable as $$ select 'a6700000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.f1() returns uuid language sql immutable as $$ select 'c6700000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.sellado(p_largo integer) returns bytea language sql immutable
as $$ select decode('010001' || repeat('ab', 12 + p_largo + 16), 'hex') $$;
create function pruebas.guarda(p_teacher uuid, p_vista integer, p_cambio boolean, p_ultimos text default '7771') returns text
language plpgsql as $$
declare
  v text;
begin
  perform pruebas.a_nombre_de(pruebas.mara());
  v := private.tax_profile_save(p_teacher, p_vista, pruebas.sellado(13), pruebas.sellado(20), '612', 'person', pruebas.sellado(18), p_ultimos, 1, p_cambio);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.ultima(p_teacher uuid) returns private.teacher_tax_profiles language sql security definer
as $$ select x from private.teacher_tax_profiles x where x.teacher_id = p_teacher order by x.version desc limit 1 $$;
create function pruebas.vista(p_teacher uuid) returns integer language sql security definer
as $$ select coalesce(max(x.version), 0)::integer from private.teacher_tax_profiles x where x.teacher_id = p_teacher $$;
-- «Ya llamé» a la CLABE vigente, para que la primera vez no la detenga: aquí se prueba la espera, y la llamada en la 68 (T-604, segunda solicitud).
create function pruebas.ya_llamo(p_pago uuid) returns void language plpgsql security definer as $$
declare
  v_teacher uuid;
  v_cambio timestamptz;
begin
  select y.teacher_id into v_teacher from public.payouts y where y.id = p_pago;
  select x.clabe_changed_at into v_cambio from private.teacher_tax_profiles x where x.teacher_id = v_teacher order by x.version desc limit 1;
  if v_cambio is null then
    return;
  end if;
  set local session_replication_role = replica;
  insert into private.payout_account_calls (teacher_id, clabe_changed_at, spoke_with, called_at, recorded_by)
  values (v_teacher, v_cambio, 'prueba', now(), pruebas.f1());
  set local session_replication_role = origin;
end
$$;
create function pruebas.finanzas(p_pago uuid) returns jsonb language plpgsql as $$
begin
  perform pruebas.ya_llamo(p_pago);
  return pruebas.pide(pruebas.f1(), format('private.payout_account_open(%L)', p_pago))::jsonb;
end
$$;
create function pruebas.estado() returns jsonb language plpgsql as $$
begin
  return pruebas.pide(pruebas.mara(), 'private.tax_profile_state()')::jsonb;
end
$$;
create function pruebas.aviso(p_teacher uuid) returns private.mail_outbox language sql security definer
as $$ select m from private.mail_outbox m where m.idempotency_key = private.clabe_notice_key(p_teacher, (pruebas.ultima(p_teacher)).clabe_changed_at) $$;
-- Como el servidor, sin persona: así corre el barrido.
create function pruebas.reclama(p_limite integer default 20) returns setof jsonb language plpgsql as $$
begin
  perform pruebas.limpiar();
  set local role app_service;
  return query select to_jsonb(c) from private.mail_claim(p_limite) c;
  reset role;
end
$$;
-- Mueve las horas de la fila: la tabla no deja cambiarlas, salvo apagando sus disparadores.
create function pruebas.correo_en(p_teacher uuid, p_columnas text) returns void language plpgsql as $$
begin
  set local session_replication_role = replica;
  execute format('update private.mail_outbox m set %s where m.idempotency_key = %L', p_columnas, (pruebas.aviso(p_teacher)).idempotency_key);
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
insert into public.teachers (status) values ('invited') returning id as sin_cuenta \gset
select set_config('app.actor_id', pruebas.mara()::text, true);
insert into public.consents (profile_id, legal_document_id, origin) values (pruebas.mara(), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
select pruebas.limpiar();
set local session_replication_role = replica;
-- Lista para pago: abrir la cuenta solo se puede así (T-604, segunda solicitud).
insert into public.payouts (period_id, teacher_id, close_run_id, status, pool_cents, subtotal_cents, net_cents, released_at, released_by)
  values (202610, :'m', gen_random_uuid(), 'ready_to_pay', 100, 100, 100, now(), pruebas.f1()) returning id as pago \gset
set local session_replication_role = origin;
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- Guardar una CLABE deja el aviso en la misma transacción, con su destinatario.

select is(pruebas.guarda(:'m', 0, true), 'saved', 'la primera captura se guarda');
select is((pruebas.aviso(:'m')).template, 'CO-27', 'y deja su aviso');
select is((pruebas.aviso(:'m')).recipient, 'mara-67@prueba.test', 'con el correo de la cuenta');
select is((pruebas.aviso(:'m')).profile_id, pruebas.mara(), 'y de quién es');
select is(((pruebas.aviso(:'m')).params ->> 'hours')::integer, 72, 'dice cuántas horas va a esperar');
select is((pruebas.aviso(:'m')).sent_at, null, 'todavía sin enviar');
select unalike((pruebas.aviso(:'m')).params::text, '%7771%', 'y sin nada de la cuenta, ni los últimos cuatro');

-- Heredar la misma CLABE no manda otro; una nueva, sí.
select is(pruebas.guarda(:'m', 1, false), 'saved', 'cambiar el RFC con la misma CLABE');
select is((select count(*)::int from private.mail_outbox m where m.profile_id = pruebas.mara()), 1, 'no manda otro aviso');
select is(pruebas.guarda(:'m', 2, true, '8881'), 'saved', 'una CLABE nueva');
select is((select count(*)::int from private.mail_outbox m where m.profile_id = pruebas.mara()), 2, 'sí manda el suyo');

-- Un cambio de correo después no toca lo ya escrito.
select pruebas.como_dueno_sistema();
update auth.users set email = 'mara-otro-67@prueba.test' where id = pruebas.mara();
select pruebas.como_dueno();
select is((pruebas.aviso(:'m')).recipient, 'mara-67@prueba.test', 'el destinatario queda fijado al escribir');
select pruebas.como_dueno_sistema();
update auth.users set email = 'mara-67@prueba.test' where id = pruebas.mara();
select pruebas.como_dueno();

-- La llave no depende de la zona de la sesión: con eso, una lectura en otra zona no encontraría el envío.
set local timezone = 'Asia/Tokyo';
select is(private.clabe_notice_key(:'m', '2030-01-01 12:00:00+00'), (select 'CO-27:' || :'m' || ':' || (extract(epoch from '2030-01-01 12:00:00+00'::timestamptz) * 1000000)::bigint), 'la llave sale del instante');
set local timezone = 'UTC';
select is(private.clabe_notice_key(:'m', '2030-01-01 12:00:00+00'), private.clabe_notice_key(:'m', '2030-01-01 06:00:00-06'), 'el mismo instante da la misma llave');

-- Sin cuenta no hay a quién avisarle, y esa CLABE no se abre.
select pruebas.como_dueno_sistema();
insert into private.teacher_tax_profiles (teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version, created_by, clabe_changed_at, clabe_effective_from)
  values (:'sin_cuenta', 1, pruebas.sellado(13), pruebas.sellado(20), '612', 'person', pruebas.sellado(18), '7771', 1, pruebas.mara(), now() - interval '100 hours', now() - interval '28 hours');
select pruebas.como_dueno();
select is((pruebas.aviso(:'sin_cuenta')).id, null, 'un maestro sin cuenta no deja aviso');
select is(private.tax_clabe_standing(:'sin_cuenta', (pruebas.ultima(:'sin_cuenta')).clabe_changed_at, (pruebas.ultima(:'sin_cuenta')).clabe_effective_from), 'notice_pending', 'y su CLABE no rige, aunque pase la fecha');

-- ---------------------------------------------------------------------------------------
-- Sin el correo enviado no se abre, aunque pase la fecha.

select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_notice_pending', 'finanzas no recibe nada');
select is(pruebas.finanzas(:'pago') - 'outcome', '{}'::jsonb, 'ni una fecha: todavía no se sabe');
select is((select count(*)::int from public.audit_log a where a.action = 'tax_profile.read' and a.actor_id = pruebas.f1()), 0, 'y no hay lectura que auditar');
select is(pruebas.estado() ->> 'clabe_notice_pending', 'true', 'el maestro ve que falta el aviso');
select is(pruebas.estado() ->> 'clabe_waits_until', null, 'y ninguna fecha');
set local session_replication_role = replica;
update private.teacher_tax_profiles set clabe_changed_at = now() - interval '100 hours', clabe_effective_from = now() - interval '28 hours' where teacher_id = :'m' and version = 3;
insert into private.mail_outbox (idempotency_key, template, profile_id, recipient, params)
  values (private.clabe_notice_key(:'m', now() - interval '100 hours'), 'CO-27', pruebas.mara(), 'mara-67@prueba.test', '{"hours": 72}');
set local session_replication_role = origin;
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_notice_pending', 'pasada la fecha sin el correo, tampoco');
select is(pruebas.estado() ->> 'clabe_waits_until', null, 'y el maestro sigue sin fecha');

-- ---------------------------------------------------------------------------------------
-- La espera cuenta desde el envío.

-- Salió a tiempo: rige en su fecha.
select pruebas.correo_en(:'m', format('sent_at = %L', now() - interval '100 hours'));
select is(private.tax_clabe_effective(:'m', now() - interval '100 hours', now() - interval '28 hours'), now() - interval '28 hours', 'enviado al guardar, la fecha no se mueve');
select is(pruebas.finanzas(:'pago') ->> 'clabe_last4', '8881', 'y ya se abre');
select is(pruebas.estado() ->> 'clabe_notice_pending', 'false', 'y el maestro ya no ve el aviso');
-- Salió tarde: la fecha se mueve.
select pruebas.correo_en(:'m', format('sent_at = %L', now() - interval '10 hours'));
select is(private.tax_clabe_effective(:'m', now() - interval '100 hours', now() - interval '28 hours'), now() + interval '62 hours', 'enviado 90 horas después, se mueve 90 horas');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_waiting', 'finanzas sigue esperando');
select is((pruebas.finanzas(:'pago') ->> 'until')::timestamptz, now() + interval '62 hours', 'con la fecha nueva');
select is((pruebas.estado() ->> 'clabe_waits_until')::timestamptz, now() + interval '62 hours', 'y el maestro ve la misma');
-- La espera es la que se guardó, aunque el parámetro cambie después.
set local session_replication_role = replica;
update public.business_parameters set value = '24'::jsonb where key = 'ESPERA_CLABE_HORAS';
set local session_replication_role = origin;
select is(private.tax_clabe_effective(:'m', now() - interval '100 hours', now() - interval '28 hours'), now() + interval '62 hours', 'cambiar el parámetro no la toca');
set local session_replication_role = replica;
update public.business_parameters set value = '72'::jsonb where key = 'ESPERA_CLABE_HORAS';
set local session_replication_role = origin;

-- Una contraseña cambiada durante la espera nueva anula, aunque la fecha de antes ya pasara.
set local session_replication_role = replica;
insert into private.account_password_changes (profile_id, changed_at) values (pruebas.mara(), now() - interval '1 hour');
set local session_replication_role = origin;
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_recapture', 'una contraseña antes de la fecha nueva la anula');
set local session_replication_role = replica;
delete from private.account_password_changes where profile_id = pruebas.mara();
set local session_replication_role = origin;

-- Lo de antes de la regla y una fila sin fechas siguen igual.
select is(private.tax_clabe_effective(:'m', '-infinity', '-infinity'), '-infinity'::timestamptz, 'lo de antes de la regla rige desde siempre, sin aviso');
select is(private.tax_clabe_standing(:'m', '-infinity', '-infinity'), 'in_force', 'y sigue rigiendo');
select is(private.tax_clabe_effective(:'m', 'infinity', 'infinity'), 'infinity'::timestamptz, 'una fila sin fechas no rige nunca');
select is(private.tax_clabe_standing(:'m', 'infinity', 'infinity'), 'waiting', 'y no se confunde con la falta del aviso');

-- Con el aviso pendiente, el maestro tampoco nota una propuesta de fraude.
select pruebas.correo_en(:'m', 'sent_at = null');
create temporary table pendiente_sin_propuesta on commit drop as select pruebas.estado() as respuesta;
grant select on pendiente_sin_propuesta to anon, authenticated, app_service;
select is((select respuesta ->> 'clabe_notice_pending' from pendiente_sin_propuesta), 'true', 'el aviso está pendiente');
set local session_replication_role = replica;
insert into private.teacher_suspension_requests (teacher_id, anomaly_alert_id, reason, proposed_by, proposed_at) values (:'m', gen_random_uuid(), 'prueba', pruebas.f1(), now());
set local session_replication_role = origin;
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_held', 'finanzas la ve detenida');
select is(pruebas.estado(), (select respuesta from pendiente_sin_propuesta), 'y el maestro recibe exactamente lo mismo que sin propuesta');
set local session_replication_role = replica;
delete from private.teacher_suspension_requests where teacher_id = :'m';
set local session_replication_role = origin;

-- ---------------------------------------------------------------------------------------
-- Un aviso que ya no va a salir anula esa CLABE, y se vuelve a escribir. Sin eso no tendría salida: la misma CLABE hereda sus fechas y su llave.

select pruebas.correo_en(:'m', 'failed_at = now()');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_recapture', 'finanzas ve que hay que escribirla otra vez');
select is(pruebas.estado() ->> 'clabe_recapture', 'true', 'y el maestro también');
select is(pruebas.estado() ->> 'clabe_notice_pending', 'false', 'ya no dice que se lo estamos mandando');
select is(pruebas.estado() ->> 'clabe_waits_until', null, 'ni una fecha');
-- Quien opera lo intenta de nuevo (OP-22): el guardián lo deja, y vuelve a estar pendiente.
update private.mail_outbox set failed_at = null, attempts = 0 where idempotency_key = (pruebas.aviso(:'m')).idempotency_key;
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_notice_pending', 'volver a intentar lo deja pendiente otra vez');
-- Si salió, gana.
select pruebas.correo_en(:'m', 'failed_at = now()');
select is(private.mail_sent((pruebas.aviso(:'m')).id), true, 'un envío que llega tarde gana sobre el fallo');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_waiting', 'y ya no está anulada: espera desde ese envío');
-- La misma CLABE, con el correo ya corregido: aviso nuevo, al correo de ahora, y espera nueva.
select pruebas.correo_en(:'m', 'sent_at = null, failed_at = now()');
select pruebas.como_dueno_sistema();
update auth.users set email = 'Mara-Corregido-67@prueba.test' where id = pruebas.mara();
select pruebas.como_dueno();
select is(pruebas.guarda(:'m', pruebas.vista(:'m'), false, '8881'), 'saved', 'vuelve a escribir la misma CLABE');
select cmp_ok((pruebas.ultima(:'m')).clabe_changed_at, '>', now() - interval '1 second', 'no hereda lo anulado: empieza de nuevo');
select is((pruebas.aviso(:'m')).recipient, 'mara-corregido-67@prueba.test', 'su aviso va al correo de ahora');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_notice_pending', 'y espera a que salga');
-- Un correo que Auth acepta y que parece raro no impide guardar: si no sirve, lo dice el proveedor.
select pruebas.como_dueno_sistema();
update auth.users set email = 'dos@arrobas@prueba.test' where id = pruebas.mara();
select pruebas.como_dueno();
select is(pruebas.guarda(:'m', pruebas.vista(:'m'), true, '6661'), 'saved', 'un correo con forma rara no impide guardar');
select is((pruebas.aviso(:'m')).recipient, 'dos@arrobas@prueba.test', 'y el aviso se intenta');
select pruebas.como_dueno_sistema();
update auth.users set email = '' where id = pruebas.mara();
select pruebas.como_dueno();
select is(pruebas.guarda(:'m', pruebas.vista(:'m'), true, '5551'), 'saved', 'tampoco un correo vacío');
select is((pruebas.aviso(:'m')).id, null, 'sin correo no hay aviso');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_notice_pending', 'y no se abre');
select pruebas.como_dueno_sistema();
update auth.users set email = 'mara-67@prueba.test' where id = pruebas.mara();
select pruebas.como_dueno();

-- Lo enviado no muere: ni con las dos marcas, que no deberían existir juntas, ni por un rechazo que llega tarde.
select is(pruebas.guarda(:'m', pruebas.vista(:'m'), true, '4441'), 'saved', 'otra CLABE');
select pruebas.correo_en(:'m', 'sent_at = now(), failed_at = now()');
select is(private.tax_clabe_notice_failed(:'m', (pruebas.ultima(:'m')).clabe_changed_at), false, 'con las dos marcas cuenta como enviada');
select pruebas.correo_en(:'m', 'failed_at = null');
select is(private.mail_rejected((pruebas.aviso(:'m')).id, (pruebas.aviso(:'m')).attempts), false, 'un rechazo sobre lo enviado no cuenta');
select is((pruebas.aviso(:'m')).failed_at, null, 'y no la anula');

-- La CLABE reemplazada queda atrás: su aviso fallido no se vuelve a intentar, no cuenta como cuenta sin abrir, y si sale tarde no abre la nueva.
select is(pruebas.guarda(:'m', pruebas.vista(:'m'), true, '3331'), 'saved', 'otra CLABE');
select pruebas.correo_en(:'m', 'failed_at = now()');
select (pruebas.aviso(:'m')).id as aviso_viejo \gset
select is((private.mail_health() ->> 'failed')::int, 1, 'mientras nadie la reemplaza, el fallo se dice');
select is(pruebas.guarda(:'m', pruebas.vista(:'m'), false, '3331'), 'saved', 'la vuelve a escribir');
select is((select recipient from private.mail_outbox where id = :'aviso_viejo'), null, 'el aviso viejo se queda sin dirección');
select is((pruebas.aviso(:'m')).recipient, 'mara-67@prueba.test', 'el nuevo la conserva');
select is((private.mail_health() ->> 'failed')::int, 0, 'y ya no hay falsa alarma');
select is(private.mail_sent(:'aviso_viejo'), true, 'el aviso viejo sale tarde');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_notice_pending', 'y no abre la CLABE nueva');
-- Un aviso que todavía se está intentando conserva su dirección: el maestro tiene derecho a enterarse de ese cambio.
select is(pruebas.guarda(:'m', pruebas.vista(:'m'), true, '2221'), 'saved', 'otra CLABE');
select (pruebas.aviso(:'m')).id as aviso_vivo \gset
select is(pruebas.guarda(:'m', pruebas.vista(:'m'), true, '2222'), 'saved', 'y otra encima, con el aviso sin salir');
select is((select recipient from private.mail_outbox where id = :'aviso_vivo'), 'mara-67@prueba.test', 'el aviso pendiente conserva su dirección');

-- Volver a intentar no revive lo que anuló una contraseña.
select pruebas.correo_en(:'m', 'failed_at = now()');
set local session_replication_role = replica;
insert into private.account_password_changes (profile_id, changed_at) values (pruebas.mara(), clock_timestamp());
set local session_replication_role = origin;
update private.mail_outbox set failed_at = null, attempts = 0 where idempotency_key = (pruebas.aviso(:'m')).idempotency_key;
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_recapture', 'una contraseña cambiada la sigue anulando');
set local session_replication_role = replica;
delete from private.account_password_changes where profile_id = pruebas.mara();
set local session_replication_role = origin;

-- Con el aviso fallido, el maestro tampoco nota una propuesta. Y al reescribirla, la propuesta la sigue deteniendo.
select pruebas.correo_en(:'m', 'failed_at = now()');
create temporary table fallido_sin_propuesta on commit drop as select pruebas.estado() as respuesta;
grant select on fallido_sin_propuesta to anon, authenticated, app_service;
set local session_replication_role = replica;
insert into private.teacher_suspension_requests (teacher_id, anomaly_alert_id, reason, proposed_by, proposed_at) values (:'m', gen_random_uuid(), 'prueba', pruebas.f1(), now());
set local session_replication_role = origin;
select is(pruebas.estado(), (select respuesta from fallido_sin_propuesta), 'con el aviso fallido recibe exactamente lo mismo que sin propuesta');
select is(pruebas.guarda(:'m', pruebas.vista(:'m'), false, '3331'), 'saved', 'la vuelve a escribir');
select is(pruebas.finanzas(:'pago') ->> 'outcome', 'clabe_held', 'y la propuesta la detiene');
set local session_replication_role = replica;
delete from private.teacher_suspension_requests where teacher_id = :'m';
set local session_replication_role = origin;

-- ---------------------------------------------------------------------------------------
-- Reclamar: por tiempo y por intentos, sin que dos tomen el mismo.

set local session_replication_role = replica;
delete from private.mail_outbox;
set local session_replication_role = origin;
select pruebas.como_dueno_sistema();
insert into private.mail_outbox (idempotency_key, template, profile_id, recipient, params) values ('CO-27:prueba-1', 'CO-27', pruebas.mara(), 'mara-67@prueba.test', '{"hours": 72}');
select pruebas.como_dueno();
select is((select count(*)::int from pruebas.reclama()), 1, 'reclama lo que toca');
select pruebas.como_dueno();
select is((select attempts from private.mail_outbox where idempotency_key = 'CO-27:prueba-1'), 1, 'cuenta el intento');
select ok((select claimed_until > now() from private.mail_outbox where idempotency_key = 'CO-27:prueba-1'), 'y lo aparta por un rato');
select is((select count(*)::int from pruebas.reclama()), 0, 'mientras está apartado nadie más lo toma');
select pruebas.como_dueno();
update private.mail_outbox set claimed_until = now() - interval '1 second' where idempotency_key = 'CO-27:prueba-1';
select is((select (r ->> 'attempt')::int from pruebas.reclama() r), 2, 'vencido, se reclama otra vez');
select pruebas.como_dueno();
-- Al llegar al tope ya no se intenta, y queda dicho.
update private.mail_outbox set claimed_until = now() - interval '1 second', attempts = 10 where idempotency_key = 'CO-27:prueba-1';
select is((select count(*)::int from pruebas.reclama()), 0, 'con diez intentos no se reclama');
select pruebas.como_dueno();
select ok((select failed_at is not null from private.mail_outbox where idempotency_key = 'CO-27:prueba-1'), 'y queda como fallido');
select is((private.mail_health() ->> 'failed')::int, 1, 'y lo dice la salud');
-- `mail_sent` gana sobre todo: el correo salió.
select is(private.mail_sent((select id from private.mail_outbox where idempotency_key = 'CO-27:prueba-1')), true, 'marcar enviado');
select ok((select sent_at is not null from private.mail_outbox where idempotency_key = 'CO-27:prueba-1'), 'deja la hora');
create temporary table primera_hora on commit drop as select sent_at from private.mail_outbox where idempotency_key = 'CO-27:prueba-1';
select is(private.mail_sent((select id from private.mail_outbox where idempotency_key = 'CO-27:prueba-1')), false, 'otra vez no cambia nada');
select is((select sent_at from private.mail_outbox where idempotency_key = 'CO-27:prueba-1'), (select sent_at from primera_hora), 'y la hora es la primera');
select is((private.mail_health() ->> 'failed')::int, 0, 'enviado ya no cuenta como fallido');

-- Rechazado: no se reintenta. Un rechazo de un intento viejo no cuenta.
select pruebas.como_dueno_sistema();
insert into private.mail_outbox (idempotency_key, template, profile_id, recipient, params) values ('CO-27:prueba-2', 'CO-27', pruebas.mara(), 'mara-67@prueba.test', '{"hours": 72}');
select pruebas.como_dueno();
select is((select count(*)::int from pruebas.reclama()), 1, 'reclama el segundo');
select pruebas.como_dueno();
select is(private.mail_rejected((select id from private.mail_outbox where idempotency_key = 'CO-27:prueba-2'), 7), false, 'el rechazo de otro intento no cuenta');
select is((select failed_at from private.mail_outbox where idempotency_key = 'CO-27:prueba-2'), null, 'sigue vivo');
select is(private.mail_rejected((select id from private.mail_outbox where idempotency_key = 'CO-27:prueba-2'), 1), true, 'el de este intento, sí');
select is((select count(*)::int from pruebas.reclama()), 0, 'rechazado no se reclama');
select pruebas.como_dueno();

-- Lo que lleva tiempo sin salir se dice.
select pruebas.como_dueno_sistema();
insert into private.mail_outbox (idempotency_key, template, profile_id, recipient, params, created_at) values ('CO-27:prueba-3', 'CO-27', pruebas.mara(), 'mara-67@prueba.test', '{"hours": 72}', now() - interval '2 days');
select pruebas.como_dueno();
select is((private.mail_health() ->> 'overdue')::int, 1, 'lo que lleva más de un día sin salir');

-- ---------------------------------------------------------------------------------------
-- La tabla no se deja cambiar, y las direcciones se van.

select throws_ok($$update private.mail_outbox set sent_at = null where idempotency_key = 'CO-27:prueba-1'$$, '42501', null, 'lo enviado no se desmarca');
select throws_ok($$update private.mail_outbox set sent_at = now() - interval '1 year' where idempotency_key = 'CO-27:prueba-1'$$, '42501', null, 'ni se mueve la hora');
select throws_ok($$update private.mail_outbox set recipient = 'otra@prueba.test' where idempotency_key = 'CO-27:prueba-3'$$, '42501', null, 'ni se cambia el destinatario');
select throws_ok($$update private.mail_outbox set idempotency_key = 'CO-27:otra' where idempotency_key = 'CO-27:prueba-3'$$, '42501', null, 'ni la llave');
select throws_ok($$delete from private.mail_outbox$$, '42501', null, 'ni se borra');

set local session_replication_role = replica;
update private.mail_outbox set sent_at = now() - interval '29 days' where idempotency_key = 'CO-27:prueba-3';
update private.mail_outbox set sent_at = now() - interval '31 days' where idempotency_key = 'CO-27:prueba-1';
update private.mail_outbox set failed_at = now() - interval '31 days' where idempotency_key = 'CO-27:prueba-2';
insert into private.mail_outbox (idempotency_key, template, recipient, params, failed_at) values ('CO-27:prueba-5', 'CO-27', 'reciente@prueba.test', '{}', now() - interval '29 days');
set local session_replication_role = origin;
select is(private.mail_purge(), 2, 'a los 30 días se quitan las direcciones');
select is((select recipient from private.mail_outbox where idempotency_key = 'CO-27:prueba-1'), null, 'sin dirección');
select is((select count(*)::int from private.mail_outbox where recipient is not null), 2, 'y lo de menos de 30 días se queda, enviado o fallido');

-- Una cuenta que se borra se lleva la dirección.
select pruebas.como_dueno_sistema();
insert into private.mail_outbox (idempotency_key, template, profile_id, recipient, params) values ('CO-27:prueba-4', 'CO-27', pruebas.f1(), 'f1-67@prueba.test', '{"hours": 72}');
select pruebas.como_dueno();
update private.mail_outbox set profile_id = null where idempotency_key = 'CO-27:prueba-4';
select is((select recipient from private.mail_outbox where idempotency_key = 'CO-27:prueba-4'), null, 'sin cuenta, sin dirección');
select is((select count(*)::int from pruebas.reclama()), 0, 'y sin dirección no se reclama');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is((select count(*)::int from private.schema_violations()), 0, 'el vigilante no ve nada');
grant select on private.mail_outbox to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'mail table privilege for app_service'), 've la tabla al alcance de la aplicación');
revoke select on private.mail_outbox from app_service;
alter table private.teacher_tax_profiles disable trigger clabe_notice_queue;
select ok(exists (select 1 from private.schema_violations() where problem = 'mail trigger missing: clabe_notice_queue'), 've el disparador del aviso apagado');
alter table private.teacher_tax_profiles enable trigger clabe_notice_queue;
grant execute on function private.tax_clabe_effective(uuid, timestamptz, timestamptz) to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'mail helper reachable: tax_clabe_effective'), 've la fecha al alcance de la aplicación');
revoke execute on function private.tax_clabe_effective(uuid, timestamptz, timestamptz) from app_service;
grant execute on function private.tax_clabe_notice_failed(uuid, timestamptz) to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'mail helper reachable: tax_clabe_notice_failed'), 've el fallo del aviso al alcance de la aplicación');
revoke execute on function private.tax_clabe_notice_failed(uuid, timestamptz) from app_service;
create or replace function private.tax_clabe_standing(p_teacher uuid, p_changed timestamptz, p_effective timestamptz) returns text
language sql stable set search_path = '' as $$ select 'in_force'::text $$;
select ok(exists (select 1 from private.schema_violations() where problem = 'clabe standing without the notice'), 've una regla que no mira el aviso');
select cron.unschedule('mail_purge');
select ok(exists (select 1 from private.schema_violations() where problem = 'mail job not scheduled: mail_purge'), 've el trabajo de quitar direcciones sin programar');

select * from finish();
rollback;
