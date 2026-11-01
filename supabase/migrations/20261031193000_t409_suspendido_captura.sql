-- T-409: un maestro suspendido, salvo por fraude, captura y cambia sus datos fiscales (decisión de Sergio del 2026-11-01). RF-702 dice que suspenderlo no detiene sus
-- pagos, y sin datos no se le paga; una baja es una suspensión (OP-06), y si su CLABE cierra no tendría cómo corregirla. Con el fraude confirmado
-- (`suspension_approved_by`) sigue en solo lectura. A una suspendida no se le pide el aviso del maestro: su portal no la lleva a aceptarlo (decisión mía sin confirmar).

create or replace function private.tax_profile_save(
  p_teacher uuid, p_seen_version integer, p_rfc bytea, p_legal_name bytea, p_regime text, p_payee text, p_clabe bytea, p_last4 text, p_key_version integer)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_active uuid;
  v_status public.teacher_status;
  v_approved uuid;
  v_teacher uuid;
  v_current integer;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'tax profile changes need read committed isolation' using errcode = '25000';
  end if;
  v_active := private.current_active_teacher_id();
  if v_active is null then
    -- Su fila, para ir uno tras otro con quien la cambia: confirmar un fraude toma la misma. La cuenta también tiene que estar activa.
    select t.id, t.status, t.suspension_approved_by into v_teacher, v_status, v_approved
    from public.teachers t join public.profiles p on p.id = t.profile_id
    where t.profile_id = private.actor_id() and p.status = 'active'
    for share of t;
    if v_status = 'suspended' and v_approved is not null then
      return 'suspended';
    end if;
    if v_status = 'active' and private.teacher_notice_pending(private.actor_id()) then
      return 'needs_notice';
    end if;
    if v_status is distinct from 'suspended' then
      return 'not_teacher';
    end if;
    -- Suspendido sin fraude: RF-702 dice que sus pagos siguen, y sin datos no se le paga.
    v_active := v_teacher;
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

create or replace function private.tax_profile_state() returns jsonb
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
  return pg_catalog.jsonb_build_object(
    'outcome', 'ok', 'version', coalesce(v_version, 0), 'updated_at', v_at,
    'can_save', exists (select 1 from public.teachers t where t.id = v_teacher and (t.status = 'active' or t.suspension_approved_by is null)));
end
$$;

create or replace function private.schema_violations_tax()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  tax_functions (name, signature, reads) as (
    values ('tax_profile_save', 'private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer)', false),
           ('tax_profile_state', 'private.tax_profile_state()', false),
           ('tax_profile_mine', 'private.tax_profile_mine()', true),
           ('tax_profile_for_payout', 'private.tax_profile_for_payout(uuid)', true)),
  -- Las que nombran la tabla sin leer lo cifrado: la lista de PA-65 solo dice si hay una fila, y el vigilante la vigila.
  tax_known (oid) as (
    select pg_catalog.to_regprocedure(f.signature)::oid from tax_functions f
    union all
    select pg_catalog.to_regprocedure(k.signature)::oid
    from (values ('private.teacher_roster()'), ('private.schema_violations_tax()'), ('private.schema_violations_ledgers()')) k (signature))
  -- Ningún rol de la aplicación toca la tabla, ni por columna: una lectura directa no quedaría en la auditoría.
  select 'tax table privilege for ' || r.rolname, 'private.teacher_tax_profiles'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'private.teacher_tax_profiles'::regclass, 'select, insert, update, delete, truncate, references, trigger')
     or pg_catalog.has_any_column_privilege(r.rolname::name, 'private.teacher_tax_profiles'::regclass, 'select, insert, update, references')
  union all
  select 'tax table privilege for ' || r.rolname, 'public.withholding_rules'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'public.withholding_rules'::regclass, 'select, insert, update, delete, truncate, references, trigger')
  union all
  -- Toda función nombrada existe, es del dueño y solo la ejecuta el servidor.
  select 'tax function missing or wrong: ' || f.signature, f.name
  from tax_functions f
  where pg_catalog.to_regprocedure(f.signature) is null
     or not coalesce((select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(f.signature)), false)
     or not pg_catalog.has_function_privilege('app_service', f.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', f.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', f.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', f.signature, 'execute')
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
  -- Y la fila del maestro, para ir uno tras otro con quien confirma un fraude: un candado que se mueva de sentencia dejaría escribir después de confirmado.
  select 'tax save without the teacher row', 'tax_profile_save'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer)')) like '%from public.teachers t join public.profiles p on p.id = t.profile_id%for share of t%', false)
  union all
  -- El estado y la lista de PA-65 no leen lo que hay en la tabla: no quedan en la auditoría.
  select 'tax data out of its doors: ' || d.name, d.name
  from (values ('tax_profile_state', 'private.tax_profile_state()'), ('teacher_roster', 'private.teacher_roster()')) d (name, signature)
  where coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(d.signature)), '') ~ '(rfc_enc|legal_name_enc|clabe_enc|clabe_last4|tax_regime_code|payee_kind)'
  union all
  -- Toda otra función que nombre la tabla es una puerta nueva, aunque se llame igual en otro esquema o con otra firma.
  select 'tax function not in the list', p.proname::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and coalesce(p.prosrc, '') || coalesce(pg_catalog.pg_get_function_sqlbody(p.oid), '') like '%teacher_tax_profiles%'
    and p.oid not in (select k.oid from tax_known k where k.oid is not null)
  union all
  -- Una vista corre como su dueño: saltaría los permisos y la auditoría.
  select 'tax table read by a view', c.relname::text
  from pg_catalog.pg_depend d
  join pg_catalog.pg_rewrite w on w.oid = d.objid
  join pg_catalog.pg_class c on c.oid = w.ev_class
  where d.classid = 'pg_catalog.pg_rewrite'::regclass and d.refclassid = 'pg_catalog.pg_class'::regclass
    and d.refobjid = 'private.teacher_tax_profiles'::regclass
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
  select 'tax rules trigger missing: ' || t.name, 'public.withholding_rules'
  from (values ('audit_changes', '%audit_row_change%'), ('withholding_rules_guard', '%guard_withholding_rule%')) t (name, pattern)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'public.withholding_rules'::regclass and tg.tgname = t.name
      and tg.tgenabled in ('O', 'A') and pg_catalog.pg_get_triggerdef(tg.oid) like t.pattern)
  union all
  -- Toda columna cifrada queda fuera de la auditoría.
  select 'tax column not redacted in the audit: ' || a.attname, 'private.teacher_tax_profiles'
  from pg_catalog.pg_attribute a
  where a.attrelid = 'private.teacher_tax_profiles'::regclass and a.attnum > 0 and not a.attisdropped and a.attname like '%\_enc'
    and not coalesce((select pg_catalog.pg_get_triggerdef(tg.oid) like '%' || a.attname || '%' from pg_catalog.pg_trigger tg
                      where tg.tgrelid = 'private.teacher_tax_profiles'::regclass and tg.tgname = 'audit_changes'), false)
  union all
  -- La forma de lo cifrado se revisa por lo que dice, no por su nombre. Sin los últimos cuatro, la CLABE entera cabría en claro.
  select 'tax table constraint missing: ' || c.name, 'private.teacher_tax_profiles'
  from (values ('teacher_tax_profiles_rfc_sealed', '%get_byte(rfc_enc%'), ('teacher_tax_profiles_legal_name_sealed', '%get_byte(legal_name_enc%'),
               ('teacher_tax_profiles_clabe_sealed', '%octet_length(clabe_enc) = 49%'), ('teacher_tax_profiles_last4_form', '%[0-9]{4}%')) c (name, pattern)
  where not exists (
    select 1 from pg_catalog.pg_constraint k
    where k.conrelid = 'private.teacher_tax_profiles'::regclass and k.conname = c.name and k.convalidated
      and pg_catalog.pg_get_constraintdef(k.oid) like c.pattern)
$$;
