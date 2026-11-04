-- T-604, tercera solicitud · La factura del maestro, sin pantalla (RF-501, RF-512, FL-40; decisión 1 de Sergio del 2026-11-02: si el RFC o los montos no
-- coinciden se rechaza al subir, sin tolerancia; decisiones de Sergio del 2026-11-03: el XML cifrado, PUE y uso no rechazan, el receptor es el vigente al
-- subir y al aceptar). El maestro empieza (la base reserva la fila y la ruta del PDF), sube el PDF a la cubeta y manda el XML ya leído y cifrado; la base
-- compara con la liquidación y la pasa a revisión. Finanzas acepta (lista para pago) o rechaza con motivo. Una pagada exige una factura aceptada.
begin;
\ir _ayuda.psql
select plan(106);

select pruebas.alta('a8000000-0000-0000-0000-000000000001', 'tere-80@prueba.test');
select pruebas.alta('a8000000-0000-0000-0000-000000000002', 'otra-80@prueba.test');
select pruebas.alta('a8000000-0000-0000-0000-000000000003', 'susi-80@prueba.test');
select pruebas.alta('c8000000-0000-0000-0000-000000000001', 'f1-80@prueba.test');
select pruebas.alta('c8000000-0000-0000-0000-000000000002', 'f2-80@prueba.test');
select pruebas.alta('c8000000-0000-0000-0000-000000000003', 'k1-80@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-80@prueba.test';
select pruebas.dar_capacidad('c8000000-0000-0000-0000-000000000001', 'finance');
select pruebas.dar_capacidad('c8000000-0000-0000-0000-000000000002', 'finance');
select pruebas.dar_capacidad('c8000000-0000-0000-0000-000000000003', 'content');
select pruebas.equipar(id) from auth.users where email in ('f1-80@prueba.test', 'f2-80@prueba.test', 'k1-80@prueba.test');

create function pruebas.tere() returns uuid language sql immutable as $$ select 'a8000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.otra() returns uuid language sql immutable as $$ select 'a8000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.susi() returns uuid language sql immutable as $$ select 'a8000000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.f1() returns uuid language sql immutable as $$ select 'c8000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.f2() returns uuid language sql immutable as $$ select 'c8000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.k1() returns uuid language sql immutable as $$ select 'c8000000-0000-0000-0000-000000000003'::uuid $$;
-- Los maestros: m(1) es Tere, m(2) Otra, m(3) Susi (suspendida) y m(4) es f2, que también es maestra.
create function pruebas.m(n integer) returns uuid language sql immutable as $$ select ('e8000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
-- La liquidación n es la del periodo 20310n (o 2031nn).
create function pruebas.p(n integer) returns uuid language sql immutable as $$ select ('b8000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pruebas.sellado(p_largo integer) returns bytea language sql immutable
as $$ select decode('010001' || repeat('ab', 12 + p_largo + 16), 'hex') $$;
create function pruebas.huella(n integer) returns bytea language sql immutable as $$ select sha256(convert_to('xml ' || n, 'UTF8')) $$;

create function pruebas.periodo(p_period public.period_id) returns void language plpgsql as $$
declare
  v_run uuid := gen_random_uuid();
begin
  set local session_replication_role = replica;
  insert into public.close_runs (id, period_id, kind, status, period_status_at_run, code_version, parameters, started_by, error)
  values (v_run, p_period, 'rehearsal', 'failed', 'open', 'prueba', '{}', pruebas.f1(), 'prueba');
  insert into public.payout_periods (period_id, starts_at, ends_at, timezone, status, entered_closing_at, active_students, pool_bps,
                                     net_revenue_cents, student_pools_cents, pool_cents, assigned_cents, unconsumed_cents, carried_out_cents,
                                     close_run_id, closed_at, closed_by, payouts_released_at, payouts_released_by)
  select p_period, b.starts_at, b.ends_at, 'America/Mexico_City', 'closed', now(), 0, 6000, 0, 0, 0, 0, 0, 0,
         v_run, now(), pruebas.f1(), now(), pruebas.f1()
  from private.month_bounds(p_period, 'America/Mexico_City') b;
  set local session_replication_role = origin;
end
$$;
-- Honorarios de 1 000 pesos: 16 % de IVA, 10 % de ISR y dos tercios del IVA retenidos, al centavo.
-- El periodo de la liquidación n: los meses de 2031, y de la 13 en adelante, los de 2032.
create function pruebas.mes(n integer) returns integer language sql immutable as $$ select case when n <= 12 then 203100 + n else 203200 + n - 12 end $$;
create function pruebas.liquidacion(n integer, p_teacher integer, p_estado public.payout_status default 'awaiting_invoice') returns uuid language plpgsql as $$
begin
  perform pruebas.periodo(pruebas.mes(n)::public.period_id);
  set local session_replication_role = replica;
  insert into public.payouts (id, period_id, teacher_id, close_run_id, status, pool_cents, subtotal_cents, vat_cents, income_tax_withheld_cents,
                              vat_withheld_cents, net_cents, released_at, released_by, invoice_due_on)
  values (pruebas.p(n), pruebas.mes(n), pruebas.m(p_teacher), (select close_run_id from public.payout_periods where period_id = pruebas.mes(n)), p_estado,
          100000, 100000, 16000, 10000, 10667, 95333, now(), pruebas.f1(), current_date + 30);
  set local session_replication_role = origin;
  return pruebas.p(n);
end
$$;
-- Lo que el servidor leyó del XML de la liquidación n: su folio fiscal lleva n.
create function pruebas.hechos(n integer, p_cambio jsonb default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'uuid', '6f9619ff-8b86-d011-b42d-' || lpad(n::text, 12, '0'), 'series', 'A', 'folio', n::text,
    'issued_at', '2026-11-03T10:00:00', 'stamped_at', '2026-11-03T10:01:00', 'issuer_regime', '612',
    'receiver_rfc', 'PHO200101AB1', 'receiver_regime', '601', 'use', 'G03', 'payment_method', 'PUE',
    'subtotal_cents', 100000, 'vat_cents', 16000, 'income_tax_withheld_cents', 10000, 'vat_withheld_cents', 10667, 'total_cents', 95333) || p_cambio
$$;
create function pruebas.empieza(p_pago uuid, p_visto text default 'awaiting_invoice', p_quien uuid default 'a8000000-0000-0000-0000-000000000001') returns jsonb
language sql as $$ select pruebas.pide(p_quien, format('private.invoice_begin(%L, %L)', p_pago, p_visto))::jsonb $$;
-- El PDF en la cubeta, como lo deja Storage.
create function pruebas.objeto(p_factura uuid, p_mime text default 'application/pdf', p_size bigint default 2000) returns void language plpgsql security definer as $$
begin
  insert into storage.objects (bucket_id, name, version, metadata)
  select 'teacher-invoices', i.pdf_path, gen_random_uuid()::text, jsonb_build_object('size', p_size, 'mimetype', p_mime)
  from private.teacher_invoices i where i.id = p_factura;
end
$$;
create function pruebas.sube(p_factura uuid, p_hechos jsonb, p_emisor boolean default true, p_version integer default 1, p_pdf boolean default true,
                             p_quien uuid default 'a8000000-0000-0000-0000-000000000001') returns jsonb
language sql as $$
  select pruebas.pide(p_quien, format('private.invoice_submit(%L, %L, %L, %L, %L, %s, %L)', p_factura, pruebas.sellado(4000), pruebas.huella(1),
                                      p_hechos, p_emisor, p_version, p_pdf))::jsonb
$$;
create function pruebas.acepta(p_factura uuid, p_quien uuid default 'c8000000-0000-0000-0000-000000000001') returns jsonb
language sql as $$ select pruebas.pide(p_quien, format('private.invoice_accept(%L)', p_factura))::jsonb $$;
create function pruebas.rechaza(p_factura uuid, p_motivo text, p_quien uuid default 'c8000000-0000-0000-0000-000000000001') returns jsonb
language sql as $$ select pruebas.pide(p_quien, format('private.invoice_reject(%L, %L)', p_factura, p_motivo))::jsonb $$;
create function pruebas.estado(p_pago uuid) returns text language sql security definer as $$ select status::text from public.payouts where id = p_pago $$;
create function pruebas.fila(p_factura uuid) returns text language sql security definer as $$ select coalesce((select status from private.teacher_invoices where id = p_factura), 'gone') $$;
create function pruebas.id(p jsonb) returns uuid language sql immutable as $$ select (p ->> 'invoice_id')::uuid $$;
-- Empieza, deja el PDF y sube: la factura de la liquidación n, en revisión.
create function pruebas.en_revision(n integer, p_quien uuid default 'a8000000-0000-0000-0000-000000000001') returns uuid language plpgsql as $$
declare
  v uuid := pruebas.id(pruebas.empieza(pruebas.p(n), 'awaiting_invoice', p_quien));
begin
  perform pruebas.objeto(v);
  if pruebas.sube(v, pruebas.hechos(n), p_quien => p_quien) ->> 'outcome' <> 'submitted' then
    raise exception 'no subió la %', n;
  end if;
  return v;
end
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- Los maestros y sus datos fiscales: persona física en honorarios (612).
select pruebas.como_dueno_sistema();
insert into public.teachers (id, profile_id, status) values
  (pruebas.m(1), pruebas.tere(), 'active'), (pruebas.m(2), pruebas.otra(), 'active'), (pruebas.m(3), pruebas.susi(), 'active'), (pruebas.m(4), pruebas.f2(), 'active');
set local session_replication_role = replica;
update public.teachers set status = 'suspended', suspended_at = now(), suspended_by = pruebas.k1(), suspension_reason = 'prueba',
       suspension_notice = 'Tu cuenta de maestro está en pausa.' where id = pruebas.m(3);
insert into private.teacher_tax_profiles (teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version, created_by,
                                          clabe_changed_at, clabe_effective_from)
select pruebas.m(n), 1, pruebas.sellado(13), pruebas.sellado(20), '612', 'person', pruebas.sellado(18), '7771', 1, pruebas.tere(), now() - interval '10 days', now() - interval '7 days'
from generate_series(1, 4) n;
set local session_replication_role = origin;
select pruebas.como_dueno();

select pruebas.liquidacion(1, 1);
select pruebas.liquidacion(2, 1);
select pruebas.liquidacion(3, 2);
select pruebas.liquidacion(4, 3);
select pruebas.liquidacion(5, 4);
select pruebas.liquidacion(6, 1, 'ready_to_pay');
select pruebas.liquidacion(7, 1);
select pruebas.liquidacion(8, 1);
select pruebas.liquidacion(9, 1);

-- ---------------------------------------------------------------------------------------
-- Lo que la aplicación ve: nada de la tabla, la cubeta privada y solo PDF.

select ok(not has_table_privilege('app_service', 'private.teacher_invoices', 'select, insert, update, delete'), 'el servidor no toca la tabla de frente');
select ok(not has_table_privilege('authenticated', 'private.teacher_invoices', 'select'), 'ni una persona');
select is((select row(public, file_size_limit, allowed_mime_types)::text from storage.buckets where id = 'teacher-invoices'),
  row(false, 5242880::bigint, array['application/pdf']::text[])::text, 'la cubeta es privada, solo PDF y hasta 5 MB');
select ok(not has_function_privilege('app_service', 'private.invoice_expire()', 'execute'), 'vencer lo que no se subió es del sistema');

-- ---------------------------------------------------------------------------------------
-- Sin el RFC de quien recibe (PQ-20), no se empieza.

select is(private.invoice_receiver_rfc(), null, 'el valor de arranque no tiene forma de RFC: no hay receptor');
select is(pruebas.empieza(pruebas.p(1)) ->> 'outcome', 'receiver_missing', 'y sin receptor no se empieza');
set local session_replication_role = replica;
update public.business_parameters set value = '"PHO200101AB1"' where key = 'RFC_RECEPTOR';
set local session_replication_role = origin;
select is(private.invoice_receiver_rfc(), 'PHO200101AB1', 'con él, sí');

-- ---------------------------------------------------------------------------------------
-- Empezar.

select is(pruebas.empieza(pruebas.p(1), 'awaiting_invoice', pruebas.f1()) ->> 'outcome', 'not_teacher', 'quien no es maestro no factura');
select is(pruebas.empieza(pruebas.p(3)) ->> 'outcome', 'not_found', 'ni la liquidación de otra maestra');
select is(pruebas.empieza(pruebas.p(1), 'invoice_rejected') ->> 'outcome', 'changed', 'con otro estado a la vista, changed');
select is(pruebas.empieza(pruebas.p(6), 'ready_to_pay') ->> 'outcome', 'not_awaiting', 'una lista para pago no espera factura');
select pruebas.empieza(pruebas.p(1)) as empieza1 \gset
select is(:'empieza1'::jsonb ->> 'outcome', 'begun', 'Tere empieza la de enero');
select is(:'empieza1'::jsonb ->> 'path', pruebas.m(1) || '/' || pruebas.p(1) || '/' || (:'empieza1'::jsonb ->> 'invoice_id') || '.pdf',
  'la ruta del PDF la pone la base: maestro, liquidación y factura');
select is(pruebas.empieza(pruebas.p(1)) ->> 'outcome', 'already_in_progress', 'otra subida a la vez, no');
select is(pruebas.empieza(pruebas.p(4), 'awaiting_invoice', pruebas.susi()) ->> 'outcome', 'begun', 'una maestra suspendida factura (FL-40 E3)');
select pruebas.id(:'empieza1') as f1 \gset
-- La ruta del PDF, para que el servidor lo lea antes de subir, y en qué va: solo a su maestra.
select is(pruebas.pide(pruebas.tere(), format('private.invoice_upload(%L)', :'f1'))::jsonb,
  jsonb_build_object('outcome', 'ok', 'path', :'empieza1'::jsonb ->> 'path', 'payout_id', pruebas.p(1), 'status', 'uploading'), 'su maestra sabe a dónde subió');
select is(pruebas.pide(pruebas.otra(), format('private.invoice_upload(%L)', :'f1'))::jsonb ->> 'outcome', 'not_found', 'otra maestra no');

-- ---------------------------------------------------------------------------------------
-- Subir: el PDF tiene que estar, y lo leído tiene que coincidir.

select is(pruebas.sube(:'f1', pruebas.hechos(1)) ->> 'outcome', 'not_uploaded', 'sin el PDF en la cubeta, no');
select is(pruebas.fila(:'f1'), 'uploading', 'y la fila se queda, para cuando llegue');
select pruebas.objeto(:'f1', 'text/plain');
select is(pruebas.sube(:'f1', pruebas.hechos(1)) ->> 'outcome', 'not_uploaded', 'lo que Storage no guardó como PDF tampoco');
-- Storage no deja borrar de sus tablas: se le cambia lo que dice del objeto.
update storage.objects set metadata = '{"size": 6000000, "mimetype": "application/pdf"}' where bucket_id = 'teacher-invoices';
select is(pruebas.sube(:'f1', pruebas.hechos(1)) ->> 'outcome', 'not_uploaded', 'ni lo que pasa del tope');
update storage.objects set metadata = '{"size": 2000, "mimetype": "application/pdf"}' where bucket_id = 'teacher-invoices';
select is(pruebas.sube(:'f1', pruebas.hechos(1), p_version => 2) ->> 'outcome', 'profile_changed', 'comparado con otra versión de sus datos, se vuelve a comparar');
select is(pruebas.fila(:'f1'), 'uploading', 'y la fila se queda');
select is(pruebas.sube(:'f1', pruebas.hechos(1), p_quien => pruebas.otra()) ->> 'outcome', 'not_found', 'otra maestra no sube la de Tere');

-- Por la decisión 1, lo que no coincide se rechaza al subir, y la fila se va: se empieza otra vez.
select is(pruebas.sube(:'f1', pruebas.hechos(1), p_emisor => false) ->> 'outcome', 'issuer_mismatch', 'el RFC del emisor no es el suyo');
select is(pruebas.fila(:'f1'), 'gone', 'rechazada al subir, la fila se va');
select is((select count(*)::integer from private.invoice_unused_objects(pruebas.p(1))), 1, 'y su PDF queda para borrarse');

create function pruebas.rechazo(n integer, p_hechos jsonb, p_pdf boolean default true) returns jsonb language plpgsql as $$
declare
  v uuid := pruebas.id(pruebas.empieza(pruebas.p(n)));
  r jsonb;
begin
  perform pruebas.objeto(v);
  r := pruebas.sube(v, p_hechos, p_pdf => p_pdf);
  return r || jsonb_build_object('row', pruebas.fila(v));
end
$$;
grant execute on function pruebas.rechazo(integer, jsonb, boolean) to app_service;
select is(pruebas.rechazo(1, pruebas.hechos(1), false) ->> 'outcome', 'pdf_invalid', 'un PDF que no empieza como PDF');
select is(pruebas.rechazo(1, pruebas.hechos(1, '{"issuer_regime": "626"}')) ->> 'outcome', 'regime_mismatch', 'un régimen que no es el de sus datos');
select is(pruebas.rechazo(1, pruebas.hechos(1, '{"receiver_rfc": "XYZ200101AB1"}')) ->> 'outcome', 'receiver_mismatch', 'facturada a otro receptor');
select is(pruebas.rechazo(1, pruebas.hechos(1, '{"vat_cents": 16001, "total_cents": 95334}')) - 'row',
  '{"outcome": "amounts_mismatch", "fields": ["vat_cents", "total_cents"]}'::jsonb, 'un centavo de IVA de más, y dice cuáles no coinciden');
select is(pruebas.rechazo(1, pruebas.hechos(1, '{"income_tax_withheld_cents": 9999}')) -> 'fields', '["income_tax_withheld_cents"]'::jsonb, 'ni un centavo de ISR de menos, aunque el total cuadre');
select is(pruebas.rechazo(1, pruebas.hechos(1, '{"vat_withheld_cents": 10666, "subtotal_cents": 99999}')) -> 'fields', '["subtotal_cents", "vat_withheld_cents"]'::jsonb,
  'ni del IVA retenido o el subtotal');
select is(pruebas.rechazo(1, pruebas.hechos(1, '{"uuid": "no-es-un-folio"}')) ->> 'outcome', 'malformed', 'un folio fiscal sin forma');
select is(pruebas.rechazo(1, pruebas.hechos(1, '{"subtotal_cents": "100000"}')) ->> 'outcome', 'malformed', 'un monto que no es número');
select is(pruebas.rechazo(1, pruebas.hechos(1, jsonb_build_object('stamped_at', to_char(now() at time zone 'America/Mexico_City' + interval '3 days', 'YYYY-MM-DD"T"HH24:MI:SS')))) ->> 'outcome',
  'malformed', 'timbrada en el futuro');
select is(pruebas.rechazo(1, pruebas.hechos(1, '{"issued_at": "2026-11-03T11:02:00"}')) ->> 'outcome', 'malformed', 'expedida más de una hora después de timbrada');
select is(pruebas.rechazo(1, pruebas.hechos(1, '{"issued_at": "2026-02-31T10:00:00"}')) ->> 'outcome', 'malformed', 'un 31 de febrero no tiene forma, y no tumba nada');
-- Expedida en Quintana Roo (una hora adelante del Centro, donde se timbra), PPD y otro uso: no rechazan.
select is(pruebas.rechazo(1, pruebas.hechos(1, '{"issued_at": "2026-11-03T11:01:00", "payment_method": "PPD", "use": "S01"}')) ->> 'outcome', 'submitted',
  'expedida en Quintana Roo justo una hora «después» de timbrada en el Centro, PPD y otro uso no rechazan: finanzas los ve (decisión 3 de Sergio del 2026-11-03)');
select is(pruebas.estado(pruebas.p(1)), 'invoice_in_review', 'la liquidación pasa a factura en revisión');
select is((select row(status, cfdi_uuid::text, octet_length(xml_sha256), payment_method)::text from private.teacher_invoices where payout_id = pruebas.p(1) and status <> 'uploading'),
  row('in_review', '6f9619ff-8b86-d011-b42d-000000000001', 32, 'PPD')::text, 'la factura, en revisión, con su folio fiscal y su huella');
select is(pruebas.empieza(pruebas.p(1), 'invoice_in_review') ->> 'outcome', 'not_awaiting', 'una en revisión no se vuelve a subir');
select is(pruebas.pide(pruebas.tere(), format('private.invoice_upload(%L)', (select id from private.teacher_invoices where payout_id = pruebas.p(1) and status = 'in_review')))::jsonb ->> 'status',
  'in_review', 'su maestra sabe que ya está en revisión: un reintento no oye que no existe');
select is(pruebas.pide(pruebas.otra(), format('private.invoice_upload(%L)', (select id from private.teacher_invoices where payout_id = pruebas.p(1) and status = 'in_review')))::jsonb ->> 'outcome',
  'not_found', 'y otra maestra, en ningún estado');

-- El mismo folio fiscal no respalda otra liquidación, tampoco en mayúsculas.
select is(pruebas.rechazo(2, pruebas.hechos(1, '{"uuid": "6F9619FF-8B86-D011-B42D-000000000001"}')) ->> 'outcome', 'duplicate_cfdi', 'el mismo folio en mayúsculas, no');

-- Una subida que no se terminó vence.
select pruebas.id(pruebas.empieza(pruebas.p(2))) as f2 \gset
select pruebas.objeto(:'f2');
set local session_replication_role = replica;
update private.teacher_invoices set expires_at = now() - interval '1 minute' where id = :'f2';
set local session_replication_role = origin;
select is(pruebas.sube(:'f2', pruebas.hechos(2)) ->> 'outcome', 'expired', 'vencida, no se sube');
select is(pruebas.fila(:'f2'), 'gone', 'y se va');
select pruebas.id(pruebas.empieza(pruebas.p(2))) as f2b \gset
select is(pruebas.pide(pruebas.tere(), format('private.invoice_cancel(%L)', :'f2b'))::jsonb ->> 'outcome', 'cancelled', 'cancelar una subida');
select is(pruebas.fila(:'f2b'), 'gone', 'la borra');

-- ---------------------------------------------------------------------------------------
-- Finanzas acepta o rechaza.

select (select id from private.teacher_invoices where payout_id = pruebas.p(1) and status = 'in_review') as r1 \gset
select is(pruebas.acepta(:'r1', pruebas.k1()) ->> 'outcome', 'forbidden', 'Contenido no acepta');
select is(pruebas.acepta(gen_random_uuid()) ->> 'outcome', 'not_found', 'una que no existe');
select pruebas.en_revision(5, pruebas.f2()) as r5 \gset
select is(pruebas.acepta(:'r5', pruebas.f2()) ->> 'outcome', 'self', 'nadie acepta su propia factura');
select is(pruebas.acepta(:'r5') ->> 'outcome', 'accepted', 'otra persona de finanzas, sí');
-- Retenida mientras se revisa: se dice, y no se acepta.
select pruebas.en_revision(7) as r7 \gset
select is(pruebas.pide(pruebas.f2(), format('private.hold_payout(%L, %L, %L)', pruebas.p(7), 'Se investiga', 'invoice_in_review'))::jsonb ->> 'outcome', 'held', 'se retiene en revisión');
select is(pruebas.acepta(:'r7') ->> 'outcome', 'on_hold', 'retenida, no se acepta');
select is(pruebas.rechaza(:'r7', 'No cuadra') ->> 'outcome', 'on_hold', 'ni se rechaza');
-- Si la sociedad cambió de RFC, la que estaba en revisión ya no se acepta (decisión 4 de Sergio del 2026-11-03).
set local session_replication_role = replica;
update public.business_parameters set value = '"PHO210101AB1"' where key = 'RFC_RECEPTOR';
set local session_replication_role = origin;
select is(pruebas.acepta(:'r1') ->> 'outcome', 'receiver_changed', 'con otro receptor vigente, no se acepta');
set local session_replication_role = replica;
update public.business_parameters set value = '"PHO200101AB1"' where key = 'RFC_RECEPTOR';
set local session_replication_role = origin;
select is(pruebas.acepta(:'r1') ->> 'outcome', 'accepted', 'aceptada');
select is(pruebas.estado(pruebas.p(1)), 'ready_to_pay', 'la liquidación queda lista para pago');
select is(pruebas.fila(:'r1'), 'accepted', 'y la factura, aceptada');
select is(pruebas.acepta(:'r1') ->> 'outcome', 'not_in_review', 'dos veces, no');

-- Rechazar con motivo, y volver a subir el mismo CFDI corregido.
select pruebas.en_revision(8) as r8 \gset
select is(pruebas.rechaza(:'r8', '  ') ->> 'outcome', 'malformed', 'sin motivo, no');
select is(pruebas.rechaza(:'r8', 'El concepto no es el del curso') ->> 'outcome', 'rejected', 'rechazada con motivo');
select is(pruebas.estado(pruebas.p(8)), 'invoice_rejected', 'la liquidación, con factura rechazada');
select is(pruebas.empieza(pruebas.p(8), 'invoice_rejected') ->> 'outcome', 'begun', 'Tere vuelve a empezar');
select (select id from private.teacher_invoices where payout_id = pruebas.p(8) and status = 'uploading') as f8 \gset
select pruebas.objeto(:'f8');
select is(pruebas.sube(:'f8', pruebas.hechos(8)) ->> 'outcome', 'submitted', 'y el mismo folio fiscal entra otra vez: el rechazado no cuenta');

-- ---------------------------------------------------------------------------------------
-- Una factura tardía (RF-501): vencida, se sube y se paga igual.

set local session_replication_role = replica;
update public.payouts set invoice_overdue_at = now() - interval '1 day' where id = pruebas.p(9);
set local session_replication_role = origin;
select is(pruebas.estado(pruebas.p(9)), 'awaiting_invoice', 'vencida de factura, sigue esperándola');
select pruebas.en_revision(9) as r9 \gset
select is(pruebas.acepta(:'r9') ->> 'outcome', 'accepted', 'y se acepta');

-- ---------------------------------------------------------------------------------------
-- El guardián: solo se llega a revisión subiendo, y a lista para pago aceptando.

create function pruebas.a_mano(p_quien uuid, p_sql text) returns void language plpgsql as $$
begin
  perform pruebas.limpiar();
  perform set_config('app.actor_id', p_quien::text, true);
  execute p_sql;
  perform pruebas.limpiar();
end
$$;
-- Todo esto corre en la misma hora: el freno de Tere (veinte por hora) empieza de nuevo aquí, y otra vez abajo.
delete from private.rate_limit_counters where bucket = 'invoice_upload:' || pruebas.m(1);
select pruebas.liquidacion(10, 1);
create function pruebas.a_estado(p_quien uuid, p_pago uuid, p_estado text) returns text language sql immutable as $$
  select format('select pruebas.a_mano(%L, %L)', p_quien, format('update public.payouts set status = %L where id = %L', p_estado, p_pago))
$$;
select throws_like(pruebas.a_estado(pruebas.tere(), pruebas.p(10), 'invoice_in_review'),
  '%does not go from awaiting_invoice to invoice_in_review%', 'a revisión sin una factura en revisión, no');
select pruebas.en_revision(10) as r10 \gset
select throws_like(pruebas.a_estado(pruebas.f1(), pruebas.p(10), 'ready_to_pay'),
  '%does not go from invoice_in_review to ready_to_pay%', 'a lista para pago sin una factura aceptada, no');
select throws_like(pruebas.a_estado(pruebas.f1(), pruebas.p(10), 'invoice_rejected'),
  '%does not go from invoice_in_review to invoice_rejected%', 'ni a rechazada con la factura en revisión');
select throws_ok(format($$update private.teacher_invoices set status = 'in_review' where id = %L$$, :'r1'), '23514', null, 'una aceptada no cambia');
select throws_ok(format($$delete from private.teacher_invoices where id = %L$$, :'r10'), '23514', null, 'una en revisión no se borra');
select throws_ok(format($$update private.teacher_invoices set subtotal_cents = 1 where id = %L$$, :'r10'), '23514', null, 'ni se cambia lo leído');

-- Quién hace cada paso, también a mano: a revisión solo su maestra; aceptar, nunca su maestra; y la ruta al nacer, la de su liquidación.
-- Todo esto corre en la misma hora: el freno de Tere empieza de nuevo aquí.
delete from private.rate_limit_counters where bucket = 'invoice_upload:' || pruebas.m(1);
select pruebas.liquidacion(13, 1);
select throws_ok(format($$insert into private.teacher_invoices (payout_id, teacher_id, pdf_path, expires_at) values (%L, %L, 'otra/ruta.pdf', now() + interval '1 hour')$$,
  pruebas.p(13), pruebas.m(1)), '23514', null, 'una factura nace en la ruta de su liquidación');
select pruebas.id(pruebas.empieza(pruebas.p(13))) as f13 \gset
select throws_like(format($$select pruebas.a_mano(%L, %L)$$, pruebas.f1(), format('update private.teacher_invoices set status = %L where id = %L', 'in_review', :'f13')),
  '%submitted by its teacher%', 'nadie más que su maestra la pasa a revisión');
select throws_like(format($$select pruebas.a_mano(%L, %L)$$, pruebas.tere(), format('update private.teacher_invoices set status = %L where id = %L', 'accepted', :'r10')),
  '%reviewed by someone else%', 'su maestra no la acepta');
select throws_like(format($$select pruebas.a_mano(%L, %L)$$, pruebas.f2(),
  format('update private.teacher_invoices set status = %L, subtotal_cents = 1 where id = %L', 'accepted', :'r7')),
  '%reviewed by someone else, without changing what was read%', 'ni finanzas la acepta cambiando lo leído');
set local session_replication_role = replica;
update private.teacher_invoices set status = 'accepted', reviewed_by = pruebas.f1(), reviewed_at = now() where id = :'r10';
set local session_replication_role = origin;
select throws_like(pruebas.a_estado(pruebas.tere(), pruebas.p(10), 'ready_to_pay'), '%does not go from invoice_in_review to ready_to_pay%',
  'ni pone su liquidación lista para pago, aunque la factura esté aceptada');
select lives_ok(pruebas.a_estado(pruebas.f1(), pruebas.p(10), 'ready_to_pay'), 'finanzas, sí');
select is(pruebas.pide(pruebas.tere(), format('private.invoice_cancel(%L)', :'r1'))::jsonb ->> 'outcome', 'not_uploading', 'cancelar una que ya no se sube, no');
-- Retenida entre empezar y subir: ya no espera factura, y la subida se va.
select (select id from private.teacher_invoices where payout_id = pruebas.p(4) and status = 'uploading') as f4 \gset
select pruebas.pide(pruebas.f1(), format('private.hold_payout(%L, %L, %L)', pruebas.p(4), 'Se investiga', 'awaiting_invoice'));
select is(pruebas.sube(:'f4', pruebas.hechos(4), p_quien => pruebas.susi()) ->> 'outcome', 'changed', 'retenida entre empezar y subir, changed');
select is(pruebas.fila(:'f4'), 'gone', 'y la subida se va');
-- El freno: veinte por hora por maestro.
create function pruebas.hasta_frenar(p_pago uuid) returns text language plpgsql as $$
declare
  r jsonb;
begin
  for i in 1..30 loop
    r := pruebas.empieza(p_pago);
    if r ->> 'outcome' <> 'begun' then
      return r ->> 'outcome';
    end if;
    perform pruebas.pide(pruebas.tere(), format('private.invoice_cancel(%L)', r ->> 'invoice_id'));
  end loop;
  return 'nunca';
end
$$;
select pruebas.pide(pruebas.tere(), format('private.invoice_cancel(%L)', :'f13'));
select is(pruebas.hasta_frenar(pruebas.p(13)), 'throttled', 'después de veinte en una hora, se frena');
delete from private.rate_limit_counters where bucket = 'invoice_upload:' || pruebas.m(1);

-- Una pagada exige una factura aceptada (al confirmar).
select pruebas.liquidacion(11, 1, 'paid');
set local session_replication_role = replica;
insert into private.payout_account_reads (id, payout_id, teacher_id, tax_profile_id, tax_profile_version, clabe_changed_at, first_time, read_by)
values ('d8000000-0000-4000-8000-000000000011', pruebas.p(11), pruebas.m(1), gen_random_uuid(), 1, now() - interval '10 days', false, pruebas.f1());
insert into private.payout_payments (payout_id, teacher_id, tax_profile_version, clabe_changed_at, read_id, reference, paid_on, amount_cents, first_time, account_changed_since_read, recorded_by)
values (pruebas.p(11), pruebas.m(1), 1, now() - interval '10 days', 'd8000000-0000-4000-8000-000000000011', 'REF-80', current_date, 95333, false, false, pruebas.f1());
set local session_replication_role = origin;
select throws_like(format($$select private.assert_payout_payments(%L)$$, pruebas.p(11)), '%paid without an accepted invoice%', 'pagada sin factura aceptada, no');
select lives_ok(format($$select private.assert_payout_payments(%L)$$, pruebas.p(5)), 'una lista para pago con su factura aceptada pasa');

-- ---------------------------------------------------------------------------------------
-- Bajar: su maestra o finanzas, sin sobre sí; finanzas deja la lectura en la auditoría.

select is(pruebas.pide(pruebas.tere(), format('private.invoice_file(%L, %L)', :'r1', 'pdf'))::jsonb ->> 'outcome', 'ok', 'Tere baja su PDF');
select is(pruebas.pide(pruebas.otra(), format('private.invoice_file(%L, %L)', :'r1', 'pdf'))::jsonb ->> 'outcome', 'not_found', 'otra maestra no');
select is(pruebas.pide(pruebas.f2(), format('private.invoice_file(%L, %L)', :'r5', 'xml'))::jsonb ->> 'outcome', 'ok', 'f2 baja la suya como maestra');
select is(pruebas.pide(pruebas.f1(), format('private.invoice_file(%L, %L)', :'r1', 'xml'))::jsonb ->> 'outcome', 'ok', 'finanzas baja el XML');
select is((select count(*)::integer from public.audit_log where action = 'invoice.read' and entity_id = :'r1'), 1, 'y queda en la auditoría');
-- Como al abrir la cuenta, con su código reciente: el XML trae RFC, nombre y régimen.
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '20 minutes' where session_id = pruebas.sesion(pruebas.f1());
select is(pruebas.pide(pruebas.f1(), format('private.invoice_file(%L, %L)', :'r1', 'xml'))::jsonb ->> 'outcome', 'needs_fresh_code', 'sin código reciente, finanzas no baja');
select pruebas.equipar(pruebas.f1());
-- Un PDF que ya no es el que se subió no se entrega.
update storage.objects set version = 'otra' where bucket_id = 'teacher-invoices' and name = (select pdf_path from private.teacher_invoices where id = :'r1');
select is(pruebas.pide(pruebas.tere(), format('private.invoice_file(%L, %L)', :'r1', 'pdf'))::jsonb ->> 'outcome', 'file_changed', 'un PDF reemplazado no baja');
select is(pruebas.pide(pruebas.f1(), format('private.invoice_file(%L, %L)', :'r1', 'pdf'))::jsonb ->> 'outcome', 'file_changed', 'ni a finanzas');
select is((select count(*)::integer from public.audit_log where action = 'invoice.read' and entity_id = :'r1'), 1, 'y lo que no se entregó no queda como lectura');

-- ---------------------------------------------------------------------------------------
-- La auditoría no dice montos, régimen, XML ni motivo: configuración la lee.

select is((select count(*)::integer from public.audit_log a where a.entity_table = 'private.teacher_invoices'
           and (a.new_value ?| array['subtotal_cents', 'vat_cents', 'total_cents', 'issuer_regime', 'xml_enc', 'rejection_reason', 'receiver_regime']
                or a.old_value ?| array['subtotal_cents', 'vat_cents', 'total_cents', 'issuer_regime', 'xml_enc', 'rejection_reason', 'receiver_regime'])), 0,
  'la auditoría de las facturas no lleva montos, régimen, XML ni motivo');
select cmp_ok((select count(*)::integer from public.audit_log a where a.entity_table = 'private.teacher_invoices'), '>', 0, 'pero sí cada cambio');

-- ---------------------------------------------------------------------------------------
-- Vencer lo que no se subió, y lo que sobra en la cubeta.

select pruebas.liquidacion(12, 1);
select pruebas.id(pruebas.empieza(pruebas.p(12))) as f12 \gset
set local session_replication_role = replica;
update private.teacher_invoices set expires_at = now() - interval '1 minute' where id = :'f12';
set local session_replication_role = origin;
select pruebas.como_dueno_sistema();
select private.invoice_expire();
select pruebas.como_dueno();
select is(pruebas.fila(:'f12'), 'gone', 'el trabajo se lleva la subida vencida');
select cmp_ok((select count(*)::integer from private.invoice_sweep()), '>=', 1, 'y el barrido dice qué PDF ya nadie nombra');
select is((select count(*)::integer from private.invoice_sweep() s join private.teacher_invoices i on i.pdf_path = s.path), 0, 'nunca uno que una fila nombra');
select is((select count(*)::integer from private.invoice_unused_objects(pruebas.p(1)) u join private.teacher_invoices i on i.pdf_path = u.path), 0,
  'ni por liquidación');
select cmp_ok((select count(*)::integer from private.invoice_unused_objects(pruebas.p(1))), '>=', 1, 'aunque en su carpeta sobren otros');

-- ---------------------------------------------------------------------------------------
-- El vigilante.

select is_empty($$select * from private.schema_violations_payouts()$$, 'el vigilante de las liquidaciones no ve nada');
grant select on private.teacher_invoices to app_service;
select ok((select count(*) > 0 from private.schema_violations_payouts() where object_name = 'private.teacher_invoices'), 've un permiso sobre las facturas');
revoke select on private.teacher_invoices from app_service;
update storage.buckets set public = true where id = 'teacher-invoices';
select ok((select count(*) > 0 from private.schema_violations_payouts() where problem like '%teacher-invoices%'), 've la cubeta pública');
update storage.buckets set public = false where id = 'teacher-invoices';
drop trigger audit_changes on private.teacher_invoices;
create trigger audit_changes after insert or update or delete on private.teacher_invoices for each row execute function private.audit_row_change('money');
select ok((select count(*) > 0 from private.schema_violations_payouts() where problem = 'payouts audit names what it must not: private.teacher_invoices'),
  've la auditoría con montos');

select * from finish();
rollback;
