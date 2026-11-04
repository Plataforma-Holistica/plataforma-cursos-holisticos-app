-- T-604, tercera solicitud: la factura del maestro, sin pantalla (RF-512, FL-40; plan en `~/.claude/plans/t604-pago-plan.md` y diseño en
-- `~/.claude/plans/t604-factura-diseno.md`). Trae además que nadie apruebe el curso de un maestro cuya invitación es suya (decisión de Sergio
-- del 2026-11-03).

-- ---------------------------------------------------------------------------------------
-- Aprobar: «sobre sí» como las demás funciones, con `actor_owns_teacher`, que cuenta también la invitación al correo propio. Lo demás, como en
-- `t401_fundador_y_suspension`.

create or replace function private.approve_course(p_course uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_state public.course_state;
  v_teacher uuid;
  v_practice uuid;
  v_level uuid;
begin
  perform private.catalog_lock('practices');
  perform private.catalog_lock('levels');
  perform private.course_lock(p_course);
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;

  select state, teacher_id into v_state, v_teacher from public.course_registry where course_id = p_course for no key update;
  if v_state is null then
    return 'not_found';
  elsif v_state <> 'in_review' then
    return 'not_pending';
  end if;
  if private.actor_owns_teacher(v_teacher) then
    return 'self';
  end if;
  select practice_id, level_id into v_practice, v_level from public.published_courses where course_id = p_course;
  if v_practice is null or v_level is null then
    return 'incomplete';
  end if;
  if not exists (select 1 from public.practices where id = v_practice and is_active) then
    return 'practice_inactive';
  end if;
  if not exists (select 1 from public.levels where id = v_level and is_active) then
    return 'level_inactive';
  end if;
  if exists (
    select 1 from public.published_lessons l join public.video_assets v on v.id = l.video_asset_id
    where l.course_id = p_course and l.is_current and v.status <> 'ready') then
    return 'videos_not_ready';
  end if;

  update public.course_registry set state = 'published', first_published_at = coalesce(first_published_at, now())
  where course_id = p_course;
  update public.published_courses set is_listed = true, published_at = now() where course_id = p_course;
  -- Y la ficha de su maestro, si todavía no estaba listada.
  update public.published_teachers set is_listed = true
  where teacher_id = v_teacher and not is_listed;
  return 'approved';
end
$$;

-- ---------------------------------------------------------------------------------------
-- Las retenciones se redondean al centavo más cercano, como el IVA y como el facturador del maestro (decisión de Sergio del 2026-11-03): con
-- «sin tolerancia» al subir la factura, redondear hacia abajo rechazaría cerca de la mitad de las legítimas. Lo confirma el contador.
-- Redondeado, lo retenido ya no queda siempre debajo de lo retenido exacto: con las dos tasas debajo de la mitad, lo redondeado queda debajo del
-- bruto para todo bruto positivo (a lo más medio centavo de más por cada una), y el neto sigue positivo.

create or replace function private.compute_withholdings(p_subtotal bigint, p_vat numeric, p_income numeric, p_vat_withheld numeric) returns jsonb
language sql immutable set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'vat_cents', v.vat, 'income_tax_withheld_cents', v.income, 'vat_withheld_cents', v.vat_withheld,
    'net_cents', p_subtotal + v.vat - v.income - v.vat_withheld)
  from (select pg_catalog.round(p_subtotal * p_vat)::bigint as vat,
               pg_catalog.round(p_subtotal * p_income)::bigint as income,
               pg_catalog.round(p_subtotal * p_vat_withheld)::bigint as vat_withheld) v
$$;
revoke all on function private.compute_withholdings(bigint, numeric, numeric, numeric) from public;

alter table public.withholding_rules
  drop constraint withholding_rules_something_left,
  add constraint withholding_rules_something_left check (income_tax_withholding_rate + vat_withholding_rate < 0.5);

-- ---------------------------------------------------------------------------------------
-- A quién se factura (PQ-20). Arranca con un texto que no es un RFC: hasta que Sergio lo dé, no se empieza ninguna factura.

insert into public.parameter_definitions (key, description, value_type, unit, group_name, affects_payout) values
  ('RFC_RECEPTOR', 'RFC de la sociedad, a quien le factura el maestro (PQ-20)', 'text', null, 'payout', false);

-- El vigente, solo si tiene forma de RFC de persona moral; si no, nulo.
create function private.invoice_receiver_rfc() returns text
language sql stable set search_path = ''
as $$
  select x.v from (select private.parameter_value('RFC_RECEPTOR') #>> '{}' as v) x
  where x.v ~ '^[A-Z&Ñ]{3}[0-9]{6}[A-Z0-9]{2}[0-9A]$'
$$;
revoke all on function private.invoice_receiver_rfc() from public;

-- ---------------------------------------------------------------------------------------
-- La cubeta del PDF. Privada, solo PDF y hasta 5 MB; sin políticas sobre `storage.objects`: solo el servidor, con su llave, firma. El PDF trae el RFC en
-- claro y no se cifra: pesa más de lo que Vercel deja pasar por una función (decisión 2 de Sergio del 2026-11-03, con el riesgo escrito).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('teacher-invoices', 'teacher-invoices', false, 5242880, array['application/pdf']);

-- ---------------------------------------------------------------------------------------
-- La factura. Privada y sin ningún permiso para la aplicación, como los datos fiscales: el XML trae el RFC, el nombre y el régimen, y va cifrado con la llave
-- de esos datos (decisión 2 de Sergio del 2026-11-03). Lo leído del XML lo manda el servidor, que lo leyó: la base no lee XML. Lo compara, eso sí, con la
-- liquidación, con el régimen de sus datos y con el receptor vigente.
--
-- Nace `uploading` al empezar, con la ruta que pone la base, y vive 3 h (la dirección de subida dura 2 h fijas). Al subir pasa a `in_review` con todo lo
-- leído, o se borra si no coincide (decisión 1 de Sergio del 2026-11-02: se rechaza al subir). Finanzas la acepta o la rechaza con motivo, y ya no cambia.

create table private.teacher_invoices (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.payouts (id),
  teacher_id uuid not null references public.teachers (id),
  status text not null default 'uploading',
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  pdf_path text not null,
  pdf_object_id uuid,
  pdf_object_version text,
  pdf_bytes bigint,
  xml_enc bytea,
  xml_sha256 bytea,
  cfdi_uuid uuid,
  cfdi_series text,
  cfdi_folio text,
  issued_at timestamptz,
  stamped_at timestamptz,
  issuer_regime text,
  issuer_profile_version smallint,
  receiver_rfc text,
  receiver_regime text,
  cfdi_use text,
  payment_method text,
  subtotal_cents bigint,
  vat_cents bigint,
  income_tax_withheld_cents bigint,
  vat_withheld_cents bigint,
  total_cents bigint,
  submitted_by uuid references public.profiles (id),
  submitted_at timestamptz,
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  rejection_reason text,
  constraint teacher_invoices_status_known check (status in ('uploading', 'in_review', 'accepted', 'rejected')),
  constraint teacher_invoices_uploading_expires check ((status = 'uploading') = (expires_at is not null)),
  constraint teacher_invoices_submitted check (
    (status = 'uploading') = (submitted_at is null)
    and (status = 'uploading' or pg_catalog.num_nulls(pdf_object_id, pdf_object_version, pdf_bytes, xml_enc, xml_sha256, cfdi_uuid, issued_at, stamped_at,
                                                      issuer_regime, issuer_profile_version, receiver_rfc, subtotal_cents, vat_cents, income_tax_withheld_cents,
                                                      vat_withheld_cents, total_cents, submitted_by) = 0)),
  constraint teacher_invoices_reviewed check (
    (status in ('accepted', 'rejected')) = (reviewed_at is not null) and (status in ('accepted', 'rejected')) = (reviewed_by is not null)),
  constraint teacher_invoices_rejection check ((status = 'rejected') = (rejection_reason is not null)),
  constraint teacher_invoices_reason_length check (rejection_reason is null or pg_catalog.char_length(pg_catalog.btrim(rejection_reason)) between 1 and 500),
  -- Lo cifrado tiene la forma de `tax-cipher.ts`: formato 1, y al menos encabezado, vector, un byte y etiqueta. Un XML en claro no entra.
  constraint teacher_invoices_xml_sealed check (
    xml_enc is null or (pg_catalog.octet_length(xml_enc) between 32 and 262175 and pg_catalog.get_byte(xml_enc, 0) = 1)),
  constraint teacher_invoices_sha check (xml_sha256 is null or pg_catalog.octet_length(xml_sha256) = 32),
  constraint teacher_invoices_amounts check (
    subtotal_cents >= 0 and vat_cents >= 0 and income_tax_withheld_cents >= 0 and vat_withheld_cents >= 0 and total_cents >= 0),
  constraint teacher_invoices_texts check (
    pg_catalog.char_length(coalesce(cfdi_series, '')) <= 25 and pg_catalog.char_length(coalesce(cfdi_folio, '')) <= 40
    and pg_catalog.char_length(coalesce(receiver_rfc, '')) <= 13 and pg_catalog.char_length(coalesce(cfdi_use, '')) <= 4
    and pg_catalog.char_length(coalesce(payment_method, '')) <= 3 and pg_catalog.char_length(coalesce(receiver_regime, '')) <= 3
    and pg_catalog.char_length(coalesce(issuer_regime, '')) <= 3)
);
comment on table private.teacher_invoices is 'La factura del maestro por una liquidación: el PDF en la cubeta y el XML cifrado (RF-512). Sin permisos para la aplicación.';
-- Una subida a la vez por liquidación; una factura viva por liquidación; un folio fiscal respalda una sola (una rechazada puede volver a subirse).
create unique index teacher_invoices_uploading_uq on private.teacher_invoices (payout_id) where status = 'uploading';
create unique index teacher_invoices_live_uq on private.teacher_invoices (payout_id) where status in ('in_review', 'accepted');
create unique index teacher_invoices_cfdi_uq on private.teacher_invoices (cfdi_uuid) where status in ('in_review', 'accepted');
create unique index teacher_invoices_path_uq on private.teacher_invoices (pdf_path);
create index teacher_invoices_payout_idx on private.teacher_invoices (payout_id, created_at desc);
alter table private.teacher_invoices enable row level security;
revoke all on table private.teacher_invoices from public, anon, authenticated, service_role, app_service;

-- Solo el dueño escribe, y siempre por estos pasos: nace subiéndose, para el maestro de su liquidación y en su ruta; pasa a revisión una vez, subida por su
-- maestro; se acepta o se rechaza una vez, por alguien que no es su maestro. Lo leído no cambia, y solo se borra una subida.
create function private.guard_teacher_invoice() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'uploading' or new.teacher_id is distinct from (select y.teacher_id from public.payouts y where y.id = new.payout_id)
       or new.pdf_path is distinct from (new.teacher_id || '/' || new.payout_id || '/' || new.id || '.pdf')
       or pg_catalog.num_nonnulls(new.submitted_at, new.reviewed_at, new.xml_enc, new.cfdi_uuid) > 0 then
      raise exception '%.%: an invoice is born uploading, for the teacher of its payout, at its path', tg_table_schema, tg_table_name using errcode = '23514';
    end if;
    new.created_at := pg_catalog.now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'uploading' then
      raise exception '%.%: invoice % is not deleted: only an upload is', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    return old;
  end if;
  if (new.id, new.payout_id, new.teacher_id, new.created_at, new.pdf_path) is distinct from (old.id, old.payout_id, old.teacher_id, old.created_at, old.pdf_path) then
    raise exception '%.%: invoice % keeps its payout, its teacher and its path', tg_table_schema, tg_table_name, old.id using errcode = '23514';
  end if;
  if old.status = 'uploading' and new.status = 'in_review' then
    if private.actor_teacher_id() is distinct from old.teacher_id or new.reviewed_at is not null then
      raise exception '%.%: invoice % is submitted by its teacher', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    new.expires_at := null;
    new.submitted_by := private.actor_id();
    new.submitted_at := pg_catalog.now();
    return new;
  end if;
  if old.status = 'in_review' and new.status in ('accepted', 'rejected') then
    if (pg_catalog.to_jsonb(new) - array['status', 'reviewed_by', 'reviewed_at', 'rejection_reason'])
       is distinct from (pg_catalog.to_jsonb(old) - array['status', 'reviewed_by', 'reviewed_at', 'rejection_reason'])
       or private.actor_id() is null or private.actor_owns_teacher(old.teacher_id) then
      raise exception '%.%: invoice % is reviewed by someone else, without changing what was read', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    new.reviewed_by := private.actor_id();
    new.reviewed_at := pg_catalog.now();
    return new;
  end if;
  raise exception '%.%: invoice % does not go from % to %', tg_table_schema, tg_table_name, old.id, old.status, new.status using errcode = '23514';
end
$$;
revoke all on function private.guard_teacher_invoice() from public;

create trigger teacher_invoices_guard before insert or update or delete on private.teacher_invoices
  for each row execute function private.guard_teacher_invoice();
create trigger teacher_invoices_no_truncate before truncate on private.teacher_invoices
  for each statement execute function private.reject_mutation();
-- La auditoría no lleva lo cifrado, los montos ni el régimen (con el bruto dirían el régimen, y configuración la lee), ni el motivo, que finanzas escribe a mano.
create trigger audit_changes after insert or update or delete on private.teacher_invoices
  for each row execute function private.audit_row_change('money', 'xml_enc', 'xml_sha256', 'issuer_regime', 'receiver_regime', 'cfdi_use', 'payment_method',
                                                         'subtotal_cents', 'vat_cents', 'income_tax_withheld_cents', 'vat_withheld_cents', 'total_cents',
                                                         'rejection_reason');

-- ¿Tiene forma lo que el servidor leyó? Solo forma: lo que dice se compara después.
create function private.invoice_facts_ok(p jsonb) returns boolean
language sql immutable set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p) = 'object'
     and coalesce(p ->> 'uuid', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     and coalesce(p ->> 'issued_at', '') ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$'
     and coalesce(p ->> 'stamped_at', '') ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$'
     and coalesce(p ->> 'issuer_regime', '') ~ '^[0-9]{3}$'
     and coalesce(p ->> 'receiver_rfc', '') ~ '^[A-Za-z&Ññ0-9]{12,13}$'
     and (pg_catalog.jsonb_typeof(p -> 'receiver_regime') is null or pg_catalog.jsonb_typeof(p -> 'receiver_regime') = 'null' or (p ->> 'receiver_regime') ~ '^[0-9]{3}$')
     and (pg_catalog.jsonb_typeof(p -> 'use') is null or pg_catalog.jsonb_typeof(p -> 'use') = 'null' or (p ->> 'use') ~ '^[A-Z0-9]{3,4}$')
     and (pg_catalog.jsonb_typeof(p -> 'payment_method') is null or pg_catalog.jsonb_typeof(p -> 'payment_method') = 'null' or (p ->> 'payment_method') ~ '^[A-Z]{3}$')
     and coalesce(pg_catalog.jsonb_typeof(p -> 'series'), 'null') in ('null', 'string') and pg_catalog.char_length(coalesce(p ->> 'series', '')) <= 25
     and coalesce(pg_catalog.jsonb_typeof(p -> 'folio'), 'null') in ('null', 'string') and pg_catalog.char_length(coalesce(p ->> 'folio', '')) <= 40
     and (select pg_catalog.bool_and(coalesce(pg_catalog.jsonb_typeof(p -> k) = 'number' and (p ->> k) ~ '^(0|[1-9][0-9]{0,15})$', false))
          from pg_catalog.unnest(array['subtotal_cents', 'vat_cents', 'income_tax_withheld_cents', 'vat_withheld_cents', 'total_cents']) k)
$$;
revoke all on function private.invoice_facts_ok(jsonb) from public;

-- ---------------------------------------------------------------------------------------
-- Empezar: el maestro (también suspendido, FL-40 E3) reserva la fila de una liquidación suya que espera factura o la tiene rechazada (también vencida: una
-- factura tardía se sube y se paga). Toma la liquidación para escribir: dos pestañas no empiezan dos. Veinte por hora por maestro, contado al aceptar.

create function private.invoice_begin(p_payout uuid, p_seen text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.actor_teacher_id();
  v_status public.payout_status;
  v_id uuid := pg_catalog.gen_random_uuid();
  v_hits integer;
  v_path text;
  v_expires timestamptz := pg_catalog.now() + interval '3 hours';
begin
  if v_teacher is null then
    return '{"outcome": "not_teacher"}'::jsonb;
  end if;
  select y.status into v_status from public.payouts y where y.id = p_payout and y.teacher_id = v_teacher for update;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if v_status::text is distinct from p_seen then
    return '{"outcome": "changed"}'::jsonb;
  end if;
  if v_status not in ('awaiting_invoice', 'invoice_rejected') then
    return '{"outcome": "not_awaiting"}'::jsonb;
  end if;
  if private.invoice_receiver_rfc() is null then
    return '{"outcome": "receiver_missing"}'::jsonb;
  end if;
  -- Una subida vencida que el trabajo todavía no se llevó no detiene a la siguiente.
  delete from private.teacher_invoices i where i.payout_id = p_payout and i.status = 'uploading' and i.expires_at <= pg_catalog.now();
  if exists (select 1 from private.teacher_invoices i where i.payout_id = p_payout and i.status = 'uploading') then
    return '{"outcome": "already_in_progress"}'::jsonb;
  end if;
  insert into private.rate_limit_counters as c (bucket, window_start, hits)
  values ('invoice_upload:' || v_teacher, pg_catalog.date_trunc('hour', pg_catalog.now()), 1)
  on conflict (bucket, window_start) do update set hits = c.hits + 1 where c.hits < 20
  returning c.hits into v_hits;
  if v_hits is null then
    return '{"outcome": "throttled"}'::jsonb;
  end if;
  v_path := v_teacher || '/' || p_payout || '/' || v_id || '.pdf';
  insert into private.teacher_invoices (id, payout_id, teacher_id, pdf_path, expires_at) values (v_id, p_payout, v_teacher, v_path, v_expires);
  return pg_catalog.jsonb_build_object('outcome', 'begun', 'invoice_id', v_id, 'path', v_path, 'expires_at', v_expires);
end
$$;
revoke all on function private.invoice_begin(uuid, text) from public;
grant execute on function private.invoice_begin(uuid, text) to app_service;

-- ---------------------------------------------------------------------------------------
-- Subir: el PDF ya está en la cubeta, y el servidor manda el XML cifrado, su huella, lo leído, si el RFC del emisor es el de los datos que abrió, con qué
-- versión los comparó y si el PDF empieza como PDF. Toma el periodo, la liquidación y la factura para escribir, en ese orden.
-- Lo que no coincide borra la fila (decisión 1); lo que se arregla solo (el PDF que no ha llegado, otra versión de los datos, sin receptor) la deja.

create function private.invoice_submit(p_invoice uuid, p_xml bytea, p_sha256 bytea, p_facts jsonb, p_issuer_matches boolean, p_profile_version integer,
                                       p_pdf_ok boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.actor_teacher_id();
  v_payout uuid;
  v_period public.period_id;
  v_pay public.payouts;
  v_row private.teacher_invoices;
  v_object uuid;
  v_version text;
  v_size bigint;
  v_mime text;
  v_profile record;
  v_receiver text;
  v_issued timestamptz;
  v_stamped timestamptz;
  v_uuid uuid;
  v_fields text[];
  v_refusal text;
begin
  if v_teacher is null then
    return '{"outcome": "not_teacher"}'::jsonb;
  end if;
  select i.payout_id into v_payout from private.teacher_invoices i where i.id = p_invoice and i.teacher_id = v_teacher;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  select y.period_id into v_period from public.payouts y where y.id = v_payout;
  perform 1 from public.payout_periods p where p.period_id = v_period for update;
  select * into v_pay from public.payouts y where y.id = v_payout for update;
  select * into v_row from private.teacher_invoices i where i.id = p_invoice for update;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  elsif v_row.status <> 'uploading' then
    return '{"outcome": "already_submitted"}'::jsonb;
  end if;

  if v_row.expires_at <= pg_catalog.now() then
    v_refusal := 'expired';
  elsif v_pay.status not in ('awaiting_invoice', 'invoice_rejected') then
    v_refusal := 'changed';
  end if;
  if v_refusal is null then
    select o.id, o.version, (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype' into v_object, v_version, v_size, v_mime
    from storage.objects o where o.bucket_id = 'teacher-invoices' and o.name = v_row.pdf_path;
    if v_object is null or v_version is null or v_mime is distinct from 'application/pdf' or v_size is null or v_size <= 0 or v_size > 5242880 then
      return '{"outcome": "not_uploaded"}'::jsonb;
    end if;
    if p_pdf_ok is null then
      return '{"outcome": "unavailable"}'::jsonb;
    elsif not p_pdf_ok then
      v_refusal := 'pdf_invalid';
    end if;
  end if;
  if v_refusal is null then
    if p_xml is null or pg_catalog.octet_length(p_xml) not between 32 and 262175 or pg_catalog.get_byte(p_xml, 0) <> 1
       or p_sha256 is null or pg_catalog.octet_length(p_sha256) <> 32 or p_issuer_matches is null or p_profile_version is null
       or not coalesce(private.invoice_facts_ok(p_facts), false) then
      v_refusal := 'malformed';
    else
      v_uuid := (p_facts ->> 'uuid')::uuid;
      -- La forma deja pasar un 31 de febrero: una fecha que no existe no tiene forma, y no tumba la transacción.
      begin
        v_issued := (p_facts ->> 'issued_at')::timestamp at time zone private.period_zone();
        v_stamped := (p_facts ->> 'stamped_at')::timestamp at time zone private.period_zone();
      exception when datetime_field_overflow or invalid_datetime_format then
        v_refusal := 'malformed';
      end;
      -- `Fecha` va en la hora de donde se expidió y `FechaTimbrado` en la del Centro (Anexo 20): Quintana Roo va una hora adelante todo el año, así que una
      -- expedida «después» de timbrada hasta por una hora es legítima. Timbrada a lo más hoy, con un día de holgura.
      if v_refusal is null and (v_issued > v_stamped + interval '1 hour' or v_stamped > pg_catalog.now() + interval '1 day') then
        v_refusal := 'malformed';
      end if;
    end if;
  end if;
  if v_refusal is null then
    select * into v_profile from private.tax_profile_fiscal(v_teacher);
    if v_profile.version is null or v_profile.version <> p_profile_version then
      return '{"outcome": "profile_changed"}'::jsonb;
    end if;
    v_receiver := private.invoice_receiver_rfc();
    if v_receiver is null then
      return '{"outcome": "receiver_missing"}'::jsonb;
    end if;
    if not p_issuer_matches then
      v_refusal := 'issuer_mismatch';
    elsif (p_facts ->> 'issuer_regime') is distinct from v_profile.regime then
      v_refusal := 'regime_mismatch';
    elsif pg_catalog.upper(p_facts ->> 'receiver_rfc') is distinct from v_receiver then
      v_refusal := 'receiver_mismatch';
    end if;
  end if;
  if v_refusal is null then
    v_fields := pg_catalog.array_remove(array[
      case when (p_facts ->> 'subtotal_cents')::bigint <> v_pay.subtotal_cents then 'subtotal_cents' end,
      case when (p_facts ->> 'vat_cents')::bigint <> v_pay.vat_cents then 'vat_cents' end,
      case when (p_facts ->> 'income_tax_withheld_cents')::bigint <> v_pay.income_tax_withheld_cents then 'income_tax_withheld_cents' end,
      case when (p_facts ->> 'vat_withheld_cents')::bigint <> v_pay.vat_withheld_cents then 'vat_withheld_cents' end,
      case when (p_facts ->> 'total_cents')::bigint <> v_pay.net_cents then 'total_cents' end], null);
    if pg_catalog.cardinality(v_fields) > 0 then
      delete from private.teacher_invoices i where i.id = p_invoice;
      return pg_catalog.jsonb_build_object('outcome', 'amounts_mismatch', 'fields', pg_catalog.to_jsonb(v_fields));
    end if;
    if exists (select 1 from private.teacher_invoices i where i.cfdi_uuid = v_uuid and i.status in ('in_review', 'accepted')) then
      v_refusal := 'duplicate_cfdi';
    end if;
  end if;
  if v_refusal is not null then
    delete from private.teacher_invoices i where i.id = p_invoice;
    return pg_catalog.jsonb_build_object('outcome', v_refusal);
  end if;

  begin
    update private.teacher_invoices i set
      status = 'in_review', pdf_object_id = v_object, pdf_object_version = v_version, pdf_bytes = v_size, xml_enc = p_xml, xml_sha256 = p_sha256,
      cfdi_uuid = v_uuid, cfdi_series = p_facts ->> 'series', cfdi_folio = p_facts ->> 'folio', issued_at = v_issued, stamped_at = v_stamped,
      issuer_regime = p_facts ->> 'issuer_regime', issuer_profile_version = p_profile_version, receiver_rfc = pg_catalog.upper(p_facts ->> 'receiver_rfc'),
      receiver_regime = p_facts ->> 'receiver_regime', cfdi_use = p_facts ->> 'use', payment_method = p_facts ->> 'payment_method',
      subtotal_cents = (p_facts ->> 'subtotal_cents')::bigint, vat_cents = (p_facts ->> 'vat_cents')::bigint,
      income_tax_withheld_cents = (p_facts ->> 'income_tax_withheld_cents')::bigint, vat_withheld_cents = (p_facts ->> 'vat_withheld_cents')::bigint,
      total_cents = (p_facts ->> 'total_cents')::bigint
    where i.id = p_invoice;
  exception when unique_violation then
    -- El mismo folio fiscal, subido a la vez para otra liquidación: ganó la otra.
    delete from private.teacher_invoices i where i.id = p_invoice;
    return '{"outcome": "duplicate_cfdi"}'::jsonb;
  end;
  update public.payouts y set status = 'invoice_in_review' where y.id = v_payout;
  return pg_catalog.jsonb_build_object('outcome', 'submitted', 'invoice_id', p_invoice);
end
$$;
revoke all on function private.invoice_submit(uuid, bytea, bytea, jsonb, boolean, integer, boolean) from public;
grant execute on function private.invoice_submit(uuid, bytea, bytea, jsonb, boolean, integer, boolean) to app_service;

-- A dónde subió su maestro: el servidor lee el principio del PDF antes de subir, y la ruta no se la cree al navegador. Con su estado: un reintento después
-- de una respuesta perdida sabe que ya se subió, en vez de oír que no existe; y una subida vencida lo dice antes de que se abran sus datos fiscales.
create function private.invoice_upload(p_invoice uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select pg_catalog.jsonb_build_object('outcome', 'ok', 'path', i.pdf_path, 'payout_id', i.payout_id,
                                          'status', case when i.status = 'uploading' and i.expires_at <= pg_catalog.now() then 'expired' else i.status end)
     from private.teacher_invoices i where i.id = p_invoice and i.teacher_id = private.actor_teacher_id()),
    '{"outcome": "not_found"}'::jsonb)
$$;
revoke all on function private.invoice_upload(uuid) from public;
grant execute on function private.invoice_upload(uuid) to app_service;

-- Cancelar una subida propia.
create function private.invoice_cancel(p_invoice uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.actor_teacher_id();
  v_status text;
begin
  if v_teacher is null then
    return '{"outcome": "not_teacher"}'::jsonb;
  end if;
  select i.status into v_status from private.teacher_invoices i where i.id = p_invoice and i.teacher_id = v_teacher for update;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  elsif v_status <> 'uploading' then
    return '{"outcome": "not_uploading"}'::jsonb;
  end if;
  delete from private.teacher_invoices i where i.id = p_invoice;
  return '{"outcome": "cancelled"}'::jsonb;
end
$$;
revoke all on function private.invoice_cancel(uuid) from public;
grant execute on function private.invoice_cancel(uuid) to app_service;

-- ---------------------------------------------------------------------------------------
-- Aceptar y rechazar: finanzas, con su puerta y su código reciente, sin sobre sí. La factura se lee sin candado para saber su liquidación, y después se
-- toman periodo, liquidación y factura, en ese orden, como las demás de finanzas. Retenida, se dice y no se toca.

create function private.invoice_review(p_invoice uuid, p_accept boolean, p_reason text) returns jsonb
language plpgsql set search_path = ''
as $$
declare
  v_gate text := private.finance_change_gate();
  v_payout uuid;
  v_teacher uuid;
  v_period public.period_id;
  v_pay public.payouts;
  v_row private.teacher_invoices;
begin
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if not p_accept and (p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) not between 1 and 500) then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select i.payout_id, i.teacher_id into v_payout, v_teacher from private.teacher_invoices i where i.id = p_invoice;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if private.actor_owns_teacher(v_teacher) then
    return '{"outcome": "self"}'::jsonb;
  end if;
  select y.period_id into v_period from public.payouts y where y.id = v_payout;
  perform 1 from public.payout_periods p where p.period_id = v_period for update;
  select * into v_pay from public.payouts y where y.id = v_payout for update;
  select * into v_row from private.teacher_invoices i where i.id = p_invoice for update;
  if not found or v_row.status <> 'in_review' then
    return '{"outcome": "not_in_review"}'::jsonb;
  elsif v_pay.status = 'on_hold' then
    return '{"outcome": "on_hold"}'::jsonb;
  elsif v_pay.status <> 'invoice_in_review' then
    return '{"outcome": "changed"}'::jsonb;
  end if;
  if p_accept then
    -- El receptor, el vigente al aceptar (decisión 4 de Sergio del 2026-11-03).
    if v_row.receiver_rfc is distinct from private.invoice_receiver_rfc() then
      return '{"outcome": "receiver_changed"}'::jsonb;
    end if;
    update private.teacher_invoices i set status = 'accepted' where i.id = p_invoice;
    update public.payouts y set status = 'ready_to_pay' where y.id = v_payout;
    return '{"outcome": "accepted"}'::jsonb;
  end if;
  update private.teacher_invoices i set status = 'rejected', rejection_reason = pg_catalog.btrim(p_reason) where i.id = p_invoice;
  update public.payouts y set status = 'invoice_rejected' where y.id = v_payout;
  return '{"outcome": "rejected"}'::jsonb;
end
$$;
revoke all on function private.invoice_review(uuid, boolean, text) from public;

create function private.invoice_accept(p_invoice uuid) returns jsonb
language sql security definer set search_path = ''
as $$ select private.invoice_review(p_invoice, true, null) $$;
revoke all on function private.invoice_accept(uuid) from public;
grant execute on function private.invoice_accept(uuid) to app_service;

create function private.invoice_reject(p_invoice uuid, p_reason text) returns jsonb
language sql security definer set search_path = ''
as $$ select private.invoice_review(p_invoice, false, p_reason) $$;
revoke all on function private.invoice_reject(uuid, text) from public;
grant execute on function private.invoice_reject(uuid, text) to app_service;

-- ---------------------------------------------------------------------------------------
-- Bajar el PDF o el XML: su maestro, o finanzas sin sobre sí, con su puerta y su código reciente como al abrir la cuenta (traen RFC, nombre y régimen), y
-- dejando la lectura en la auditoría. El XML sale cifrado: lo abre el servidor. Un PDF que ya no es el que se subió no se entrega (`file_changed`).

create function private.invoice_file(p_invoice uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row private.teacher_invoices;
  v_gate text;
begin
  if p_kind is null or p_kind not in ('pdf', 'xml') then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select * into v_row from private.teacher_invoices i where i.id = p_invoice and i.status <> 'uploading';
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if private.actor_teacher_id() is distinct from v_row.teacher_id then
    if not private.actor_has_capability('finance') then
      return '{"outcome": "not_found"}'::jsonb;
    end if;
    v_gate := private.finance_change_gate();
    if v_gate is not null then
      return pg_catalog.jsonb_build_object('outcome', v_gate);
    end if;
    if private.actor_owns_teacher(v_row.teacher_id) then
      return '{"outcome": "self"}'::jsonb;
    end if;
  end if;
  if p_kind = 'pdf' and not exists (select 1 from storage.objects o where o.bucket_id = 'teacher-invoices' and o.name = v_row.pdf_path
                                                                     and o.id = v_row.pdf_object_id and o.version = v_row.pdf_object_version) then
    return '{"outcome": "file_changed"}'::jsonb;
  end if;
  if private.actor_teacher_id() is distinct from v_row.teacher_id then
    insert into public.audit_log (actor_id, actor_kind, category, action, entity_table, entity_id, new_value, reason, request_id)
    values (private.actor_id(), 'user', 'privacy', 'invoice.read', 'private.teacher_invoices', v_row.id::text,
            pg_catalog.jsonb_build_object('teacher_id', v_row.teacher_id, 'payout_id', v_row.payout_id, 'kind', p_kind),
            nullif(pg_catalog.current_setting('app.reason', true), ''), nullif(pg_catalog.current_setting('app.request_id', true), ''));
  end if;
  if p_kind = 'pdf' then
    return pg_catalog.jsonb_build_object('outcome', 'ok', 'path', v_row.pdf_path, 'object_version', v_row.pdf_object_version);
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'ok', 'teacher_id', v_row.teacher_id,
                                       'xml', pg_catalog.translate(pg_catalog.encode(v_row.xml_enc, 'base64'), E'\n', ''));
end
$$;
revoke all on function private.invoice_file(uuid, text) from public;
grant execute on function private.invoice_file(uuid, text) to app_service;

-- ---------------------------------------------------------------------------------------
-- Lo que sobra en la cubeta. Un PDF que ninguna fila nombra sobra, tenga la edad que tenga: la fila nace antes que el objeto. Por liquidación, para el
-- servidor después de cancelar o de un rechazo al subir; y de toda la cubeta, para quien opera.

create function private.invoice_unused_objects(p_payout uuid) returns table (path text)
language sql stable security definer set search_path = ''
as $$
  select o.name from storage.objects o
  join public.payouts y on y.id = p_payout
  where o.bucket_id = 'teacher-invoices' and o.name like y.teacher_id || '/' || y.id || '/%'
    and not exists (select 1 from private.teacher_invoices i where i.pdf_path = o.name)
$$;
revoke all on function private.invoice_unused_objects(uuid) from public;
grant execute on function private.invoice_unused_objects(uuid) to app_service;

create function private.invoice_sweep() returns table (path text)
language sql stable set search_path = ''
as $$
  select o.name from storage.objects o
  where o.bucket_id = 'teacher-invoices' and not exists (select 1 from private.teacher_invoices i where i.pdf_path = o.name)
$$;
revoke all on function private.invoice_sweep() from public;

-- Las subidas vencidas, cada hora, como el sistema.
create function private.invoice_expire() returns integer
language plpgsql set search_path = ''
as $$
declare
  v_kind text := pg_catalog.current_setting('app.actor_kind', true);
  v_count integer;
begin
  perform pg_catalog.set_config('app.actor_kind', 'system', true);
  delete from private.teacher_invoices i where i.status = 'uploading' and i.expires_at <= pg_catalog.now();
  get diagnostics v_count = row_count;
  perform pg_catalog.set_config('app.actor_kind', coalesce(v_kind, ''), true);
  return v_count;
end
$$;
revoke all on function private.invoice_expire() from public;
select cron.schedule('invoice_expire', '17 * * * *', 'select private.invoice_expire()');

-- ---------------------------------------------------------------------------------------
-- El guardián de la liquidación, entero: lo de `t604_libro_de_pagos`, más los tres pasos de la factura. A revisión solo la sube su maestro, con una factura
-- en revisión; a lista para pago solo se llega aceptándola, y a rechazada, rechazándola, por alguien que no es su maestro.

create or replace function private.guard_payout() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_period record;
  v_total bigint;
begin
  if tg_op = 'INSERT' then
    -- Con el IVA en 0, las retenciones también (el neto es el subtotal).
    if new.pool_cents < 0 or new.adjustments_cents <> 0 or new.balance_applied_cents <> 0 or new.vat_cents <> 0
       or new.subtotal_cents <> new.pool_cents or new.net_cents <> new.pool_cents
       or pg_catalog.num_nonnulls(new.released_at, new.released_by, new.held_from_status, new.held_at, new.held_by,
                                  new.hold_reason, new.anomaly_alert_id, new.withholding_rule_id, new.withholding_profile_version, new.hold_kind,
                                  new.invoice_due_on, new.invoice_overdue_at) > 0 then
      raise exception '%.%: a payout is born calculated, with its share of the pool and nothing else', tg_table_schema, tg_table_name
        using errcode = '23514';
    end if;
    select p.status, p.close_run_id, p.payouts_released_at into v_period
    from public.payout_periods p where p.period_id = new.period_id;
    if v_period.status = 'closing' then
      if not exists (select 1 from public.close_runs r
                     where r.id = new.close_run_id and r.period_id = new.period_id and r.kind = 'close') then
        raise exception '%.%: period % is not being closed', tg_table_schema, tg_table_name, new.period_id using errcode = '55000';
      end if;
    elsif v_period.status = 'closed' and v_period.payouts_released_at is null then
      select t.total_cents into v_total
      from public.payout_teacher_totals t where t.period_id = new.period_id and t.teacher_id = new.teacher_id;
      if new.close_run_id is distinct from v_period.close_run_id or new.pool_cents <> coalesce(v_total, 0) then
        raise exception '%.%: a payout of period % carries its close run and what the teacher got from the pool',
          tg_table_schema, tg_table_name, new.period_id using errcode = '23514';
      end if;
    else
      raise exception '%.%: period % takes no new payouts', tg_table_schema, tg_table_name, new.period_id using errcode = '55000';
    end if;
    new.created_at := pg_catalog.now();
    new.updated_at := pg_catalog.now();
    return new;
  end if;

  if pg_catalog.to_jsonb(new) is not distinct from pg_catalog.to_jsonb(old) then
    return new;
  end if;
  if (new.id, new.period_id, new.teacher_id, new.close_run_id, new.pool_cents, new.created_at)
     is distinct from (old.id, old.period_id, old.teacher_id, old.close_run_id, old.pool_cents, old.created_at) then
    raise exception '%.%: payout %: its period, teacher, close run and share of the pool do not change', tg_table_schema,
      tg_table_name, old.id using errcode = '23514';
  end if;
  new.updated_at := pg_catalog.now();

  -- Liberar. La que espera factura sabe desde aquí el día en que vence.
  if old.status = 'calculated' and new.status in ('awaiting_invoice', 'carried_forward') then
    if pg_catalog.num_nonnulls(new.held_from_status, new.held_at, new.held_by, new.hold_reason, new.anomaly_alert_id, new.invoice_overdue_at) > 0 then
      raise exception '%.%: payout % is released without a hold', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    -- Solo la que se va a pagar lleva impuestos, y con su regla. Que sean los de esa regla lo revisa `assert_payout_released` al confirmar.
    if new.status = 'carried_forward' and (new.vat_cents <> 0 or new.income_tax_withheld_cents <> 0 or new.vat_withheld_cents <> 0
                                           or new.net_cents <> new.subtotal_cents or new.withholding_rule_id is not null) then
      raise exception '%.%: payout % is carried forward without taxes', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    if new.status = 'awaiting_invoice' and new.withholding_rule_id is null then
      raise exception '%.%: payout % waits for its invoice with its withholding rule', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    if private.actor_id() is null then
      raise exception '%.%: payout % is released by someone', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    new.released_at := pg_catalog.now();
    new.released_by := private.actor_id();
    new.invoice_due_on := case when new.status = 'awaiting_invoice' then private.invoice_due_on(new.period_id, private.release_day()) end;
    return new;
  end if;

  if (new.bonuses_cents, new.adjustments_cents, new.balance_applied_cents, new.subtotal_cents, new.vat_cents,
      new.income_tax_withheld_cents, new.vat_withheld_cents, new.net_cents, new.released_at, new.released_by,
      new.withholding_rule_id, new.withholding_profile_version, new.invoice_due_on)
     is distinct from
     (old.bonuses_cents, old.adjustments_cents, old.balance_applied_cents, old.subtotal_cents, old.vat_cents,
      old.income_tax_withheld_cents, old.vat_withheld_cents, old.net_cents, old.released_at, old.released_by,
      old.withholding_rule_id, old.withholding_profile_version, old.invoice_due_on) then
    raise exception '%.%: payout %: its amounts change only when it is released (RF-505)', tg_table_schema, tg_table_name, old.id
      using errcode = '23514';
  end if;

  -- Vencida de factura (RF-501): la marca el trabajo de cada noche, una vez, sola, y no se borra.
  if new.invoice_overdue_at is distinct from old.invoice_overdue_at then
    if old.invoice_overdue_at is not null or new.invoice_overdue_at is null
       or (pg_catalog.to_jsonb(new) - array['invoice_overdue_at', 'updated_at']) is distinct from (pg_catalog.to_jsonb(old) - array['invoice_overdue_at', 'updated_at']) then
      raise exception '%.%: payout % is marked overdue once, alone, and it stays', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    if not private.actor_is_system() or old.status not in ('awaiting_invoice', 'invoice_rejected')
       or old.invoice_due_on is null or old.invoice_due_on >= private.release_day() then
      raise exception '%.%: payout % is marked overdue by the nightly job, past its day', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    new.invoice_overdue_at := pg_catalog.now();
    return new;
  end if;

  -- Una retención por datos pasa a investigación si aparece otra causa: esa sí detiene la purga. Solo en ese sentido.
  if old.status = 'on_hold' and new.status = 'on_hold' then
    if old.hold_kind = 'tax_data' and new.hold_kind = 'investigation' and new.held_from_status is not distinct from old.held_from_status
       and private.actor_id() is not null then
      new.held_at := pg_catalog.now();
      new.held_by := private.actor_id();
      return new;
    end if;
    raise exception '%.%: payout % stays on hold as it is', tg_table_schema, tg_table_name, old.id using errcode = '23514';
  end if;

  -- Retener (RN-17): también una devuelta, para que un fraude no tenga que pasar por lista para pago.
  if new.status = 'on_hold'
     and old.status in ('calculated', 'awaiting_invoice', 'invoice_in_review', 'invoice_rejected', 'ready_to_pay', 'payment_returned') then
    if private.actor_id() is null then
      raise exception '%.%: payout % is held by someone', tg_table_schema, tg_table_name, old.id using errcode = '23514';
    end if;
    new.hold_kind := coalesce(new.hold_kind, 'investigation');
    new.held_from_status := old.status;
    new.held_at := pg_catalog.now();
    new.held_by := private.actor_id();
    return new;
  end if;

  -- Soltar: vuelve al estado en que estaba, o a pagada si tiene un pago vivo (la comprobación al confirmar lo exige).
  if old.status = 'on_hold'
     and (new.status = old.held_from_status or (new.status = 'paid' and old.held_from_status in ('ready_to_pay', 'payment_returned'))) then
    new.hold_kind := null;
    new.held_from_status := null;
    new.held_at := null;
    new.held_by := null;
    new.hold_reason := null;
    new.anomaly_alert_id := null;
    return new;
  end if;

  -- Pagar, devolver y reabrir: con una persona, y con el libro de pagos que lo respalde al confirmar.
  if (old.status = 'ready_to_pay' and new.status = 'paid') or (old.status = 'paid' and new.status = 'payment_returned')
     or (old.status = 'payment_returned' and new.status = 'ready_to_pay') then
    if private.actor_id() is null then
      raise exception '%.%: payout % changes to % by someone', tg_table_schema, tg_table_name, old.id, new.status using errcode = '23514';
    end if;
    return new;
  end if;

  -- La factura. Lo que no cumple cae al final, con su paso en el mensaje.
  if old.status in ('awaiting_invoice', 'invoice_rejected') and new.status = 'invoice_in_review'
     and private.actor_teacher_id() is not distinct from old.teacher_id
     and exists (select 1 from private.teacher_invoices i where i.payout_id = old.id and i.status = 'in_review') then
    return new;
  end if;
  if old.status = 'invoice_in_review' and new.status = 'ready_to_pay'
     and private.actor_id() is not null and not private.actor_owns_teacher(old.teacher_id)
     and exists (select 1 from private.teacher_invoices i where i.payout_id = old.id and i.status = 'accepted') then
    return new;
  end if;
  if old.status = 'invoice_in_review' and new.status = 'invoice_rejected'
     and private.actor_id() is not null and not private.actor_owns_teacher(old.teacher_id)
     and not exists (select 1 from private.teacher_invoices i where i.payout_id = old.id and i.status in ('in_review', 'accepted')) then
    return new;
  end if;

  raise exception '%.%: payout % does not go from % to %', tg_table_schema, tg_table_name, old.id, old.status, new.status using errcode = '23514';
end
$$;

-- Una pagada tiene un pago vivo y su factura aceptada; una lista para pago o devuelta, ningún pago vivo. Al confirmar, porque pagar y devolver escriben
-- en dos tablas. Solo se llega a lista para pago aceptando la factura, y la factura aceptada no cambia: esto cubre lo que se fuerce a mano.
create or replace function private.assert_payout_payments(p_payout uuid) returns void
language plpgsql stable set search_path = ''
as $$
declare
  v_status public.payout_status;
  v_live bigint;
begin
  select y.status into v_status from public.payouts y where y.id = p_payout;
  v_live := private.payout_live_payments(p_payout);
  if v_status = 'paid' and v_live = 0 then
    raise exception 'payout % is paid without a live payment', p_payout using errcode = '23514';
  end if;
  if v_status = 'paid' and not exists (select 1 from private.teacher_invoices i where i.payout_id = p_payout and i.status = 'accepted') then
    raise exception 'payout % is paid without an accepted invoice', p_payout using errcode = '23514';
  end if;
  if v_status in ('ready_to_pay', 'payment_returned') and v_live > 0 then
    raise exception 'payout % is % with a live payment', p_payout, v_status using errcode = '23514';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------
-- El vigilante de las liquidaciones, entero: lo de `t604_libro_de_pagos`, más la factura (su tabla, sus funciones, sus disparadores, su trabajo, su
-- cubeta, el periodo primero al subir y al revisar, y la auditoría sin montos).

create or replace function private.schema_violations_payouts()
 returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  payout_tables (table_name) as (
    values ('public.payouts'), ('public.payout_status_events'), ('public.bonuses'), ('public.payout_adjustments'),
           ('public.teacher_balance_entries'), ('private.payout_account_reads'), ('private.payout_account_calls'), ('private.payout_payments'),
           ('private.payout_requests'), ('private.payout_account_read_voids'), ('private.teacher_invoices')),
  payout_functions (name, definer, server, fixed_path) as (
    values ('founder_bonus', false, false, true), ('close_founder_bonuses', false, false, true),
           ('guard_payout', false, false, true), ('guard_bonus', false, false, true), ('log_payout_status', false, false, true),
           ('guard_payout_adjustment', false, false, true), ('guard_balance_entry', false, false, true),
           ('teacher_balance', false, false, true), ('payout_pending_teachers', false, false, true),
           ('first_unreleased_period', false, false, true), ('ensure_payout', false, false, true),
           ('settle_period', false, false, true), ('release_payout', false, false, true), ('minimum_payout', false, false, true),
           ('assert_payout_released', false, false, true), ('check_payout_released', true, false, true),
           ('release_payouts', true, true, true), ('hold_payout', true, true, true), ('unhold_payout', true, true, true),
           ('capture_bonus', true, false, true), ('confirm_founder_bonus', true, true, true), ('void_bonus', true, true, true),
           ('capture_adjustment', true, false, true), ('purge_watch_partition', false, false, true),
           ('purge_playback_sessions', false, false, true), ('release_preview', false, false, true),
           ('unhold_preview', false, false, true), ('finance_payouts', true, true, true),
           ('compute_withholdings', false, false, true), ('payout_tax_row', false, false, true), ('release_day', false, false, true),
           ('hold_payout_for_tax_data', true, true, true), ('payout_under_investigation', false, false, true),
           ('raw_retention', false, false, false), ('business_days_add', false, false, true), ('invoice_due_on', false, false, true),
           ('period_settled', false, false, true), ('payout_live_payments', false, false, true), ('payout_under_review', false, false, true),
           ('payout_fraud_decided', false, false, true), ('assert_payout_payments', false, false, true), ('check_payout_payments', true, false, true),
           ('guard_payout_request', false, false, true), ('invoice_deadline', false, false, true), ('payout_account_open', true, true, true),
           ('payout_account_call', true, true, true), ('payout_mark_paid', true, true, true), ('payout_return_payment', true, true, true),
           ('payout_withdraw_request', true, true, true), ('payout_reopen', true, true, true), ('payout_account_void_read', true, true, true),
           ('payout_ready_since', false, false, true), ('payout_open_read', false, false, true), ('payout_call_ok', false, false, true),
           ('payout_account_first_time', false, false, true),
           ('invoice_receiver_rfc', false, false, true), ('guard_teacher_invoice', false, false, true), ('invoice_facts_ok', false, false, true),
           ('invoice_begin', true, true, true), ('invoice_submit', true, true, true), ('invoice_cancel', true, true, true), ('invoice_upload', true, true, true),
           ('invoice_review', false, false, true), ('invoice_accept', true, true, true), ('invoice_reject', true, true, true),
           ('invoice_file', true, true, true), ('invoice_unused_objects', true, true, true), ('invoice_sweep', false, false, true),
           ('invoice_expire', false, false, true)),
  found as (
    select f.name, f.definer, f.server, f.fixed_path, p.oid, p.prosecdef, p.proconfig
    from payout_functions f
    join pg_catalog.pg_proc p on p.proname = f.name
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private'),
  payout_triggers (table_name, trigger_name, function_name, deferred) as (
    values ('public.payouts', 'payouts_guard', 'guard_payout', false),
           ('public.payouts', 'payouts_no_delete', 'reject_mutation', false),
           ('public.payouts', 'payouts_no_truncate', 'reject_mutation', false),
           ('public.payouts', 'payouts_log_status', 'log_payout_status', false),
           ('public.payouts', 'audit_changes', 'audit_row_change', false),
           ('public.payouts', 'payouts_released', 'check_payout_released', true),
           ('public.payout_status_events', 'ledger_no_update_delete', 'reject_mutation', false),
           ('public.payout_status_events', 'ledger_no_truncate', 'reject_mutation', false),
           ('public.bonuses', 'bonuses_guard', 'guard_bonus', false),
           ('public.bonuses', 'bonuses_no_delete', 'reject_mutation', false),
           ('public.bonuses', 'bonuses_no_truncate', 'reject_mutation', false),
           ('public.bonuses', 'audit_changes', 'audit_row_change', false),
           ('public.payout_adjustments', 'payout_adjustments_guard', 'guard_payout_adjustment', false),
           ('public.payout_adjustments', 'ledger_no_update_delete', 'reject_mutation', false),
           ('public.payout_adjustments', 'ledger_no_truncate', 'reject_mutation', false),
           ('public.payout_adjustments', 'audit_changes', 'audit_row_change', false),
           ('public.teacher_balance_entries', 'teacher_balance_entries_guard', 'guard_balance_entry', false),
           ('public.teacher_balance_entries', 'ledger_no_update_delete', 'reject_mutation', false),
           ('public.teacher_balance_entries', 'ledger_no_truncate', 'reject_mutation', false),
           ('public.payouts', 'payouts_payments', 'check_payout_payments', true),
           ('private.payout_account_reads', 'ledger_no_update_delete', 'reject_mutation', false),
           ('private.payout_account_reads', 'ledger_no_truncate', 'reject_mutation', false),
           ('private.payout_account_calls', 'ledger_no_update_delete', 'reject_mutation', false),
           ('private.payout_account_calls', 'ledger_no_truncate', 'reject_mutation', false),
           ('private.payout_account_calls', 'audit_changes', 'audit_row_change', false),
           ('private.payout_payments', 'ledger_no_update_delete', 'reject_mutation', false),
           ('private.payout_payments', 'ledger_no_truncate', 'reject_mutation', false),
           ('private.payout_payments', 'audit_changes', 'audit_row_change', false),
           ('private.payout_payments', 'payout_payments_payments', 'check_payout_payments', true),
           ('private.payout_requests', 'payout_requests_guard', 'guard_payout_request', false),
           ('private.payout_requests', 'ledger_no_truncate', 'reject_mutation', false),
           ('private.payout_requests', 'audit_changes', 'audit_row_change', false),
           ('private.payout_requests', 'payout_requests_payments', 'check_payout_payments', true),
           ('private.payout_account_read_voids', 'ledger_no_update_delete', 'reject_mutation', false),
           ('private.payout_account_read_voids', 'ledger_no_truncate', 'reject_mutation', false),
           ('private.teacher_invoices', 'teacher_invoices_guard', 'guard_teacher_invoice', false),
           ('private.teacher_invoices', 'teacher_invoices_no_truncate', 'reject_mutation', false),
           ('private.teacher_invoices', 'audit_changes', 'audit_row_change', false))
  select 'payouts table reachable by ' || r.rolname, t.table_name
  from app_roles r cross join payout_tables t
  where pg_catalog.to_regclass(t.table_name) is not null
    and (pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
         or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER'))
  union all
  select 'payouts table without row level security: ' || t.table_name, t.table_name
  from (values ('private.teacher_invoices')) t (table_name)
  where not exists (select 1 from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass(t.table_name) and c.relrowsecurity)
  union all
  select 'payouts function missing', 'private.' || f.name
  from payout_functions f
  where not exists (select 1 from found where found.name = f.name)
  union all
  select 'payouts function executable by ' || r.rolname, found.oid::regprocedure::text
  from app_roles r cross join found
  where pg_catalog.has_function_privilege(r.rolname::name, found.oid, 'EXECUTE')
    and not (found.server and r.rolname = 'app_service')
  union all
  select 'payouts function not executable by app_service', found.oid::regprocedure::text
  from found
  where found.server and not pg_catalog.has_function_privilege('app_service', found.oid, 'EXECUTE')
  union all
  select 'payouts function security definer or without fixed search_path', found.oid::regprocedure::text
  from found
  where (found.prosecdef and not found.definer)
     or (found.fixed_path and not coalesce(found.proconfig, '{}') @> array['search_path=""'])
  union all
  select 'payouts function not security definer', found.oid::regprocedure::text
  from found
  where found.definer and not found.prosecdef
  union all
  select 'payouts type usable by ' || r.rolname, t.type_name
  from app_roles r
  cross join (values ('public.payout_status'), ('public.bonus_kind'), ('public.bonus_status'), ('public.balance_entry_kind'))
       as t (type_name)
  where pg_catalog.has_type_privilege(r.rolname::name, t.type_name, 'USAGE')
  union all
  select 'payouts trigger missing or disabled: ' || g.trigger_name, g.table_name
  from payout_triggers g
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = pg_catalog.to_regclass(g.table_name) and tg.tgname = g.trigger_name and tg.tgenabled in ('O', 'A')
      and n.nspname = 'private' and p.proname = g.function_name)
  union all
  select 'payouts trigger not deferred: ' || g.trigger_name, g.table_name
  from payout_triggers g
  join pg_catalog.pg_trigger tg on tg.tgrelid = pg_catalog.to_regclass(g.table_name) and tg.tgname = g.trigger_name
  where g.deferred and (tg.tgconstraint = 0 or not tg.tgdeferrable or not tg.tginitdeferred)
  union all
  select 'payouts job not scheduled: ' || k.jobname, 'cron.job'
  from (values ('raw_retention', 'call private.raw_retention()'), ('invoice_deadline', 'select private.invoice_deadline()'),
               ('invoice_expire', 'select private.invoice_expire()')) k (jobname, command)
  where not exists (select 1 from cron.job j where j.jobname = k.jobname and j.active and j.command = k.command)
  union all
  -- La cubeta de las facturas: privada, solo PDF y hasta 5 MB.
  select 'payouts bucket not private, PDF only and 5 MB: teacher-invoices', 'storage.buckets'
  where not exists (select 1 from storage.buckets b where b.id = 'teacher-invoices' and not b.public and b.file_size_limit = 5242880
                      and b.allowed_mime_types = array['application/pdf'])
  union all
  -- Abrir, marcar, devolver, reabrir, retener, soltar, subir la factura y revisarla toman el periodo para escribir antes que la liquidación: con «para
  -- compartir» que después sube a escribir, dos marcas se interbloquearían con la transferencia ya hecha.
  select 'payouts function without the period lock', k.name
  from (values ('payout_account_open'), ('payout_mark_paid'), ('payout_return_payment'), ('payout_reopen'), ('hold_payout'), ('unhold_payout'),
               ('payout_account_void_read'), ('invoice_submit'), ('invoice_review')) k (name)
  where not exists (select 1 from found where found.name = k.name
                      and pg_catalog.pg_get_functiondef(found.oid) ~ 'from public\.payout_periods [a-z]+ where [a-z]+\.period_id = v_period(_id)? for update;')
  union all
  -- Abrir, marcar y devolver toman el candado de las cuentas del maestro: sin él, una devolución de otro periodo se cuela entre mirar la primera vez y escribir.
  select 'payouts function without the teacher account lock', k.name
  from (values ('payout_account_open'), ('payout_mark_paid'), ('payout_return_payment')) k (name)
  where not exists (select 1 from found where found.name = k.name and pg_catalog.pg_get_functiondef(found.oid) like '%''payout_account:'' || y.teacher_id%')
  union all
  -- La auditoría de los pagos no lleva el monto (con el bruto diría el régimen), la de las llamadas con quién se habló, la de las propuestas su huella ni sus
  -- notas, y la de las facturas lo cifrado, los montos, el régimen ni el motivo.
  select 'payouts audit names what it must not: ' || k.table_name, k.table_name
  from (values ('private.payout_payments', '%audit_row_change(''money'', ''amount_cents'')%'),
               ('private.payout_account_calls', '%audit_row_change(''money'', ''spoke_with'')%'),
               ('private.payout_requests', '%audit_row_change(''money'', ''fingerprint'', ''note'', ''decision_note'')%'),
               ('private.teacher_invoices', '%audit_row_change(''money'', ''xml_enc'', ''xml_sha256'', ''issuer_regime'', ''receiver_regime'', ''cfdi_use'', '
                                            '''payment_method'', ''subtotal_cents'', ''vat_cents'', ''income_tax_withheld_cents'', ''vat_withheld_cents'', '
                                            '''total_cents'', ''rejection_reason'')%')) k (table_name, pattern)
  where not exists (select 1 from pg_catalog.pg_trigger tg where tg.tgrelid = pg_catalog.to_regclass(k.table_name) and tg.tgname = 'audit_changes'
                      and pg_catalog.pg_get_triggerdef(tg.oid) like k.pattern)
$$;
