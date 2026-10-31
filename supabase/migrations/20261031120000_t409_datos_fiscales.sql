-- T-409 · Los datos fiscales y bancarios del maestro (RF-510; 05 §10; decisiones de Sergio del 2026-10-31).
--   · RFC, razón social y CLABE llegan cifrados por la aplicación: la base no tiene la llave. El régimen y el tipo de persona van en claro,
--     porque el cálculo de retenciones vive en la base, sin permisos para nadie de la aplicación y ocultos en la auditoría.
--   · Ningún rol de la aplicación toca la tabla: solo estas funciones. Así, ninguna lectura de lo cifrado se salta la auditoría, que se escribe en la
--     misma transacción y antes de devolver. La aplicación abre el dato ya confirmada la transacción: un registro sin dato visto es aceptable; un
--     dato visto sin registro, no.
--   · Finanzas lee por una liquidación: «hasta que exista una liquidación» queda aquí, y no en un manual.
--   · La base no ve el texto, pero sí la forma: encabezado, versión de la llave y, en la CLABE, el largo exacto. Una CLABE en claro no entra.
--   · `withholding_rules` nace sin filas: hasta que conteste el contador (LF-02, LF-03), liberar no calcula nada (T-409, cuarta solicitud). Fracciones
--     y no `bps`: dos tercios de 16 % no caben en un entero.

-- ¿Ese régimen del catálogo del SAT (`c_RegimenFiscal`) aplica a ese tipo de persona? La misma lista de `src/domain/fiscal/regime.ts`.
create function private.tax_regime_ok(p_regime text, p_payee text) returns boolean
language sql immutable set search_path = ''
as $$
  select case p_payee
    when 'person' then p_regime in ('605', '606', '607', '608', '610', '611', '612', '614', '615', '616', '621', '625', '626')
    when 'company' then p_regime in ('601', '603', '610', '620', '622', '623', '624', '626')
    else false
  end
$$;
revoke all on function private.tax_regime_ok(text, text) from public;

create table private.teacher_tax_profiles (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.teachers (id),
  version smallint not null,
  rfc_enc bytea not null,
  legal_name_enc bytea not null,
  tax_regime_code text not null,
  payee_kind text not null,
  clabe_enc bytea not null,
  clabe_last4 text not null,
  key_version smallint not null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint teacher_tax_profiles_version_uq unique (teacher_id, version),
  constraint teacher_tax_profiles_version_positive check (version >= 1),
  constraint teacher_tax_profiles_key_version_positive check (key_version >= 1),
  constraint teacher_tax_profiles_regime_known check (private.tax_regime_ok(tax_regime_code, payee_kind)),
  constraint teacher_tax_profiles_last4_form check (clabe_last4 ~ '^[0-9]{4}$'),
  constraint teacher_tax_profiles_rfc_sealed check (rfc_enc is not null and pg_catalog.octet_length(rfc_enc) >= 32 and pg_catalog.get_byte(rfc_enc, 0) = 1
    and pg_catalog.get_byte(rfc_enc, 1) * 256 + pg_catalog.get_byte(rfc_enc, 2) = key_version),
  constraint teacher_tax_profiles_legal_name_sealed check (legal_name_enc is not null and pg_catalog.octet_length(legal_name_enc) >= 32 and pg_catalog.get_byte(legal_name_enc, 0) = 1
    and pg_catalog.get_byte(legal_name_enc, 1) * 256 + pg_catalog.get_byte(legal_name_enc, 2) = key_version),
  -- Formato, versión y vector (15), 18 dígitos, y etiqueta (16): GCM no cambia el largo.
  constraint teacher_tax_profiles_clabe_sealed check (clabe_enc is not null and pg_catalog.octet_length(clabe_enc) >= 32 and pg_catalog.get_byte(clabe_enc, 0) = 1
    and pg_catalog.get_byte(clabe_enc, 1) * 256 + pg_catalog.get_byte(clabe_enc, 2) = key_version and pg_catalog.octet_length(clabe_enc) = 49)
);
comment on table private.teacher_tax_profiles is 'De solo inserción: la versión vigente de un maestro es la mayor. Sin permisos para ningún rol de la aplicación: solo tax_profile_save, tax_profile_state, tax_profile_mine y tax_profile_for_payout.';
alter table private.teacher_tax_profiles enable row level security;
revoke all on private.teacher_tax_profiles from public, anon, authenticated, service_role, app_service;
create trigger ledger_no_update_delete before update or delete on private.teacher_tax_profiles
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.teacher_tax_profiles
  for each statement execute function private.reject_mutation();
-- Configuración lee la auditoría y no ve datos fiscales: se quedan fuera lo cifrado, los últimos cuatro y el régimen.
create trigger audit_changes after insert on private.teacher_tax_profiles
  for each row execute function private.audit_row_change('privacy', 'rfc_enc', 'legal_name_enc', 'clabe_enc', 'clabe_last4', 'tax_regime_code', 'payee_kind');

create table public.withholding_rules (
  id uuid primary key default gen_random_uuid(),
  tax_regime_code text not null,
  payee_kind text not null,
  vat_rate numeric(8, 6) not null,
  income_tax_withholding_rate numeric(8, 6) not null,
  vat_withholding_rate numeric(8, 6) not null,
  issues_withholding_certificate boolean not null default false,
  effective_from date not null,
  effective_to date,
  note text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint withholding_rules_uq unique (tax_regime_code, payee_kind, effective_from),
  constraint withholding_rules_regime_known check (private.tax_regime_ok(tax_regime_code, payee_kind)),
  constraint withholding_rules_rates_fraction check (
    vat_rate between 0 and 1 and income_tax_withholding_rate between 0 and 1 and vat_withholding_rate between 0 and 1),
  constraint withholding_rules_validity check (effective_to is null or effective_to > effective_from)
);
comment on table public.withholding_rules is 'RETENCIONES_FISCALES. Sin filas hasta que conteste el contador (LF-02, LF-03). Las carga quien opera la base, con su referencia a la respuesta escrita.';
alter table public.withholding_rules enable row level security;
revoke all on public.withholding_rules from public, anon, authenticated, service_role, app_service;
create trigger audit_changes after insert or update or delete on public.withholding_rules
  for each row execute function private.audit_row_change('money');

-- ---------------------------------------------------------------------------------------
-- Guardar. El identificador y la versión entran a los datos asociados de lo cifrado: la aplicación los conoce antes de cifrar, así que
-- los dice, y la base contesta `changed` si ya no son. La fila del maestro y el candado del saldo van primero: liberar lee este perfil.
--   saved | changed | invalid | not_teacher | suspended | needs_notice

create function private.tax_profile_save(
  p_teacher uuid, p_seen_version integer, p_rfc bytea, p_legal_name bytea, p_regime text, p_payee text, p_clabe bytea, p_last4 text, p_key_version integer)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_active uuid;
  v_status public.teacher_status;
  v_current integer;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'tax profile changes need read committed isolation' using errcode = '25000';
  end if;
  v_active := private.current_active_teacher_id();
  if v_active is null then
    select t.status into v_status from public.teachers t where t.profile_id = private.actor_id();
    return case
      when v_status is null then 'not_teacher'
      when v_status = 'suspended' then 'suspended'
      when v_status = 'active' and private.teacher_notice_pending(private.actor_id()) then 'needs_notice'
      else 'not_teacher'
    end;
  end if;
  if p_teacher is distinct from v_active then
    return 'changed';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('teacher_balance:' || v_active::text, 0));
  select coalesce(max(x.version), 0) into v_current from private.teacher_tax_profiles x where x.teacher_id = v_active;
  if p_seen_version is distinct from v_current then
    return 'changed';
  end if;
  begin
    insert into private.teacher_tax_profiles (
      teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version, created_by)
    values (v_active, v_current + 1, p_rfc, p_legal_name, p_regime, p_payee, p_clabe, p_last4, p_key_version, private.actor_id());
  exception when check_violation or not_null_violation or numeric_value_out_of_range then
    return 'invalid';
  end;
  return 'saved';
end
$$;
revoke all on function private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer) from public;
grant execute on function private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer) to app_service;

-- Lo cifrado de una fila, para que lo abra la aplicación, con lo que hace falta para abrirlo.
create function private.tax_profile_payload(p private.teacher_tax_profiles) returns jsonb
language sql stable set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'outcome', 'ok',
    'teacher_id', p.teacher_id,
    'version', p.version,
    'key_version', p.key_version,
    'rfc', pg_catalog.encode(p.rfc_enc, 'base64'),
    'legal_name', pg_catalog.encode(p.legal_name_enc, 'base64'),
    'tax_regime_code', p.tax_regime_code,
    'payee_kind', p.payee_kind,
    'clabe', pg_catalog.encode(p.clabe_enc, 'base64'),
    'clabe_last4', p.clabe_last4,
    'updated_at', p.created_at)
$$;
revoke all on function private.tax_profile_payload(private.teacher_tax_profiles) from public;

-- El maestro de quien actúa, activo o suspendido, también por el servidor: current_teacher_id mira la sesión de Auth, que el servidor no tiene.
create function private.actor_teacher_id() returns uuid
language sql stable security definer set search_path = ''
as $$
  select t.id from public.teachers t where t.profile_id = private.actor_id() and t.status in ('active', 'suspended')
$$;
revoke all on function private.actor_teacher_id() from public;

-- Si ya los capturó y qué versión tiene, sin lo cifrado: no es una lectura. Lo que guardar necesita saber.
create function private.tax_profile_state() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.actor_teacher_id();
  v_version integer;
  v_at timestamptz;
begin
  if v_teacher is null then
    return '{"outcome": "not_teacher"}'::jsonb;
  end if;
  select x.version, x.created_at into v_version, v_at from private.teacher_tax_profiles x
  where x.teacher_id = v_teacher order by x.version desc limit 1;
  return pg_catalog.jsonb_build_object('outcome', 'ok', 'version', coalesce(v_version, 0), 'updated_at', v_at);
end
$$;
revoke all on function private.tax_profile_state() from public;
grant execute on function private.tax_profile_state() to app_service;

-- Lo suyo, para el maestro, también suspendido: en solo lectura, sigue viendo sus datos (FL-31, A2). Con su auditoría.
create function private.tax_profile_mine() returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.actor_teacher_id();
  p private.teacher_tax_profiles;
begin
  if v_teacher is null then
    return '{"outcome": "not_teacher"}'::jsonb;
  end if;
  select x.* into p from private.teacher_tax_profiles x where x.teacher_id = v_teacher order by x.version desc limit 1;
  if p.id is null then
    return '{"outcome": "no_profile"}'::jsonb;
  end if;
  insert into public.audit_log (actor_id, actor_kind, category, action, entity_table, entity_id, reason, request_id)
  values (private.actor_id(), 'user', 'privacy', 'tax_profile.read', 'private.teacher_tax_profiles', p.id::text,
          nullif(pg_catalog.current_setting('app.reason', true), ''),
          nullif(pg_catalog.current_setting('app.request_id', true), ''));
  return private.tax_profile_payload(p);
end
$$;
revoke all on function private.tax_profile_mine() from public;
grant execute on function private.tax_profile_mine() to app_service;

-- Para finanzas, por una liquidación: la puerta primero, después de quién es, y nunca sobre sí. Con su auditoría.
--   ok | forbidden | needs_fresh_code | not_found | self | no_profile
create function private.tax_profile_for_payout(p_payout uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_teacher uuid;
  p private.teacher_tax_profiles;
begin
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  select y.teacher_id into v_teacher from public.payouts y where y.id = p_payout;
  if v_teacher is null then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if private.actor_owns_teacher(v_teacher) then
    return '{"outcome": "self"}'::jsonb;
  end if;
  select x.* into p from private.teacher_tax_profiles x where x.teacher_id = v_teacher order by x.version desc limit 1;
  if p.id is null then
    return '{"outcome": "no_profile"}'::jsonb;
  end if;
  insert into public.audit_log (actor_id, actor_kind, category, action, entity_table, entity_id, reason, request_id)
  values (private.actor_id(), 'user', 'privacy', 'tax_profile.read', 'private.teacher_tax_profiles', p.id::text,
          nullif(pg_catalog.current_setting('app.reason', true), ''),
          nullif(pg_catalog.current_setting('app.request_id', true), ''));
  return private.tax_profile_payload(p);
end
$$;
revoke all on function private.tax_profile_for_payout(uuid) from public;
grant execute on function private.tax_profile_for_payout(uuid) to app_service;

-- ---------------------------------------------------------------------------------------
-- La lista de PA-65: si ya capturó sus datos, sin verlos, para que Contenido se los pida (cierra HO-25). Lo demás, como en t401_cola_con_alerta.

create or replace function private.teacher_roster() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if v_actor is null or not private.actor_has_capability('content') then
    return null;
  end if;
  return pg_catalog.jsonb_build_object('fresh_code', private.content_change_gate() is null, 'teachers', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'teacher_id', t.id,
             'display_name', p.display_name,
             'slug', p.slug,
             'status', t.status,
             'is_founder', t.is_founder,
             'founder_since', t.founder_since,
             'email', coalesce(pg_catalog.lower(u.email), l.email),
             'invitation', case
                             when l.id is null then 'none'
                             when l.accepted_at is not null then 'accepted'
                             when l.revoked_at is not null then 'revoked'
                             when l.expires_at <= v_now then 'expired'
                             else 'pending'
                           end,
             'invited_at', l.created_at,
             'expires_at', l.expires_at,
             'suspension', case
                             when private.actor_owns_teacher(t.id) then null
                             when t.status <> 'suspended' then null
                             when t.suspension_approved_by is not null then 'fraud'
                             else 'manual'
                           end,
             'suspended_at', t.suspended_at,
             'suspension_reason', case when private.actor_owns_teacher(t.id) then null else t.suspension_reason end,
             'suspension_notice', t.suspension_notice,
             'fraud_pending', not private.actor_owns_teacher(t.id) and exists (
               select 1 from private.teacher_suspension_requests r where r.teacher_id = t.id and r.status = 'pending'),
             'has_tax_data', exists (select 1 from private.teacher_tax_profiles x where x.teacher_id = t.id),
             'is_self', private.actor_owns_teacher(t.id))
           order by p.display_name, t.id)
    from public.teachers t
    left join public.published_teachers p on p.teacher_id = t.id
    left join auth.users u on u.id = t.profile_id
    left join lateral (
      select i.* from private.teacher_invitations i
      where i.teacher_id = t.id order by i.created_at desc limit 1) as l on true), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------------------
-- El área `tax` del vigilante. Las áreas `base` y `ledgers` están congeladas y ya vigilan parte de esto; aquí, lo propio.

create function private.schema_violations_tax()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  tax_functions (name, signature, reads) as (
    values ('tax_profile_save', 'private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer)', false),
           ('tax_profile_state', 'private.tax_profile_state()', false),
           ('tax_profile_mine', 'private.tax_profile_mine()', true),
           ('tax_profile_for_payout', 'private.tax_profile_for_payout(uuid)', true))
  -- Ningún rol de la aplicación toca la tabla, ni por columna: una lectura directa no quedaría en la auditoría.
  select 'tax table privilege for ' || r.rolname, 'private.teacher_tax_profiles'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'private.teacher_tax_profiles'::regclass, 'select, insert, update, delete, truncate, references, trigger')
     or pg_catalog.has_any_column_privilege(r.rolname::name, 'private.teacher_tax_profiles'::regclass, 'select, insert, update, references')
  union all
  select 'tax table privilege for ' || r.rolname, 'public.withholding_rules'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'public.withholding_rules'::regclass, 'insert, update, delete, truncate, references, trigger')
  union all
  -- Toda función nombrada existe, es del dueño y solo la ejecuta el servidor.
  select 'tax function missing or wrong: ' || f.signature, f.name
  from tax_functions f
  where pg_catalog.to_regprocedure(f.signature) is null
     or not coalesce((select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(f.signature)), false)
     or not pg_catalog.has_function_privilege('app_service', f.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', f.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', f.signature, 'execute')
  union all
  -- Quien lee lo cifrado, audita.
  select 'tax read without audit: ' || f.signature, f.name
  from tax_functions f
  where f.reads and not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(f.signature)) like '%''tax_profile.read''%', false)
  union all
  -- Finanzas lee con su puerta, y nunca sobre sí.
  select 'tax finance read without its gate', 'tax_profile_for_payout'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_for_payout(uuid)')) like '%finance_change_gate%actor_owns_teacher%', false)
  union all
  -- Guardar toma el candado del saldo: liberar lee este perfil, y la carrera no se ve en una prueba de una sola conexión.
  select 'tax save without the balance lock', 'tax_profile_save'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer)')) like '%teacher_balance:%', false)
  union all
  -- Toda otra función que nombre la tabla es una puerta nueva: se agrega a la lista, con su auditoría, o no existe.
  select 'tax function not in the list', p.proname::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.prosrc like '%teacher_tax_profiles%'
    and p.proname::text not in (select f.name from tax_functions f)
    -- Solo dice si existe una fila, y el vigilante la nombra para vigilarla.
    and p.proname not in ('teacher_roster', 'schema_violations_tax', 'schema_violations_ledgers')
  union all
  -- Los disparadores: de solo inserción, y la auditoría sin lo que hay en la tabla.
  select 'tax table trigger missing: ' || t.name, 'private.teacher_tax_profiles'
  from (values ('ledger_no_update_delete', '%reject_mutation%'), ('ledger_no_truncate', '%reject_mutation%'),
               ('audit_changes', '%rfc_enc%legal_name_enc%clabe_enc%clabe_last4%tax_regime_code%payee_kind%')) t (name, pattern)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'private.teacher_tax_profiles'::regclass and tg.tgname = t.name
      and tg.tgenabled in ('O', 'A') and pg_catalog.pg_get_triggerdef(tg.oid) like t.pattern)
  union all
  -- La forma de lo cifrado: sin esto, una CLABE en claro entra.
  select 'tax table constraint missing: ' || c.name, 'private.teacher_tax_profiles'
  from (values ('teacher_tax_profiles_rfc_sealed'), ('teacher_tax_profiles_legal_name_sealed'), ('teacher_tax_profiles_clabe_sealed')) c (name)
  where not exists (
    select 1 from pg_catalog.pg_constraint k where k.conrelid = 'private.teacher_tax_profiles'::regclass and k.conname = c.name)
$$;
revoke all on function private.schema_violations_tax() from public;
