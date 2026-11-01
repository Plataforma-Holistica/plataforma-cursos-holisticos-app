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
