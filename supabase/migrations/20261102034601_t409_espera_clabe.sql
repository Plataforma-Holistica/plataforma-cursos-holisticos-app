-- T-409, quinta solicitud: la espera antes de que rija una CLABE nueva (decisiones de Sergio del 2026-11-01; FL-31, A1). Dura `ESPERA_CLABE_HORAS`, también en la primera
-- captura. Durante la espera finanzas no recibe ningún dato: no se paga a ninguna cuenta, aunque pase de `DIA_PAGO`, y nadie la adelanta. Cambiar el RFC, la razón social o el
-- régimen no la toca, y rige de inmediato. Liberar y las retenciones no miran la CLABE: un reloj que vence cambiaría sus huellas sin que nada cambiara.
--
-- Decisiones mías sin confirmar: una sola tabla y el mismo formulario. La base no puede comparar dos CLABE, porque lo cifrado no se repite, así que el servidor abre la vigente,
-- compara y lo dice; si no abre, dice que cambió, y si no lo dice o los últimos cuatro no cuadran, la base lo cuenta como cambio. Solo cuenta la última versión: nunca hace falta
-- leer una CLABE anterior. Volver a una anterior es otro cambio, sin botón de cancelar. Una contraseña cambiada o un fraude confirmado dentro de la espera la anulan para siempre,
-- y se vuelve a capturar. Con una propuesta de fraude pendiente no madura, y el maestro ve lo mismo que sin ella.

-- Lo de antes de esta regla rige desde siempre; una fila escrita sin sus fechas, nunca.
alter table private.teacher_tax_profiles
  add column clabe_changed_at timestamptz not null default '-infinity',
  add column clabe_effective_from timestamptz not null default '-infinity';
alter table private.teacher_tax_profiles
  alter column clabe_changed_at set default 'infinity',
  alter column clabe_effective_from set default 'infinity',
  add constraint teacher_tax_profiles_clabe_dates check (clabe_effective_from >= clabe_changed_at);

insert into public.parameter_definitions (key, description, value_type, unit, group_name, affects_payout) values
  ('ESPERA_CLABE_HORAS', 'Horas entre guardar una CLABE nueva y que se le pueda pagar a esa cuenta', 'integer', 'horas', 'payout', false);

-- Las horas que van a esperar, o un error: sin un valor válido, una CLABE nueva no se guarda.
create function private.tax_clabe_wait() returns interval
language plpgsql stable set search_path = ''
as $$
declare
  v_value jsonb := private.parameter_value('ESPERA_CLABE_HORAS');
begin
  if v_value is null or pg_catalog.jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}')::numeric < 1 or (v_value #>> '{}')::numeric % 1 <> 0 then
    raise exception 'ESPERA_CLABE_HORAS is missing or not an integer from 1 up' using errcode = 'P0001';
  end if;
  return pg_catalog.make_interval(hours => (v_value #>> '{}')::integer);
end
$$;
revoke all on function private.tax_clabe_wait() from public;

-- La única definición de si una CLABE rige. `dead` no vuelve: se captura otra vez. No nombra la tabla: recibe las fechas de la fila que se pregunta. Una propuesta hecha antes de
-- la fecha alarga la espera hasta que se decida: confirmada, la anula aunque ya pasara la fecha, y una contraseña cambiada mientras tanto, también.
create function private.tax_clabe_standing(p_teacher uuid, p_changed timestamptz, p_effective timestamptz) returns text
language sql stable set search_path = ''
as $$
  select case
    when exists (
        select 1 from private.teacher_suspension_requests r
        where r.teacher_id = p_teacher and r.status = 'confirmed' and r.decided_at > p_changed and r.proposed_at < p_effective)
      or exists (
        select 1 from public.teachers t join private.account_security s on s.profile_id = t.profile_id
        where t.id = p_teacher and s.password_changed_at > p_changed and (
          s.password_changed_at < p_effective
          or exists (
            select 1 from private.teacher_suspension_requests r
            where r.teacher_id = p_teacher and r.proposed_at < p_effective and (r.status = 'pending' or r.decided_at > s.password_changed_at)))) then 'dead'
    when exists (
        select 1 from private.teacher_suspension_requests r
        where r.teacher_id = p_teacher and r.status = 'pending' and r.proposed_at < p_effective) then 'held'
    when pg_catalog.now() < p_effective then 'waiting'
    else 'in_force'
  end
$$;
revoke all on function private.tax_clabe_standing(uuid, timestamptz, timestamptz) from public;

drop function private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer);
create function private.tax_profile_save(
  p_teacher uuid, p_seen_version integer, p_rfc bytea, p_legal_name bytea, p_regime text, p_payee text, p_clabe bytea, p_last4 text, p_key_version integer, p_clabe_changed boolean default true)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_active uuid;
  v_status public.teacher_status;
  v_approved uuid;
  v_teacher uuid;
  v_current integer;
  v_before private.teacher_tax_profiles;
  v_changed timestamptz;
  v_effective timestamptz;
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
  select x.* into v_before from private.teacher_tax_profiles x where x.teacher_id = v_active order by x.version desc limit 1;
  v_current := coalesce(v_before.version, 0);
  if p_seen_version is distinct from v_current then
    return 'changed';
  end if;
  -- Lo que ya espera o ya rige se hereda solo si el servidor dice que es la misma, y los últimos cuatro no lo desmienten. Lo anulado no se hereda, aunque sea la misma.
  if v_before.id is not null and p_clabe_changed is false and v_before.clabe_last4 = p_last4
     and private.tax_clabe_standing(v_active, v_before.clabe_changed_at, v_before.clabe_effective_from) <> 'dead' then
    v_changed := v_before.clabe_changed_at;
    v_effective := v_before.clabe_effective_from;
  else
    -- Con el reloj y ya con los candados: la hora de la transacción la acortaría por lo que se esperó.
    v_changed := pg_catalog.clock_timestamp();
    v_effective := v_changed + private.tax_clabe_wait();
  end if;
  begin
    insert into private.teacher_tax_profiles (
      teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version, created_by, clabe_changed_at, clabe_effective_from)
    values (v_active, v_current + 1, p_rfc, p_legal_name, p_regime, p_payee, p_clabe, p_last4, p_key_version, private.actor_id(), v_changed, v_effective);
  exception when check_violation or not_null_violation or numeric_value_out_of_range then
    return 'invalid';
  end;
  return 'saved';
end
$$;
revoke all on function private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer, boolean) from public;
grant execute on function private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer, boolean) to app_service;

create or replace function private.tax_profile_state() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.actor_teacher_id();
  v_version integer;
  v_at timestamptz;
  v_changed timestamptz;
  v_effective timestamptz;
begin
  if v_teacher is null then
    return '{"outcome": "not_teacher"}'::jsonb;
  end if;
  select x.version, x.created_at, x.clabe_changed_at, x.clabe_effective_from into v_version, v_at, v_changed, v_effective from private.teacher_tax_profiles x
  where x.teacher_id = v_teacher order by x.version desc limit 1;
  return pg_catalog.jsonb_build_object(
    'outcome', 'ok', 'version', coalesce(v_version, 0), 'updated_at', v_at,
    -- Con una propuesta pendiente dice lo mismo que sin ella: la fecha, y cuando pasa, nada.
    'clabe_waits_until', case when v_version is not null and pg_catalog.now() < v_effective and private.tax_clabe_standing(v_teacher, v_changed, v_effective) <> 'dead' then v_effective end,
    'clabe_recapture', v_version is not null and private.tax_clabe_standing(v_teacher, v_changed, v_effective) = 'dead',
    'can_save', exists (select 1 from public.teachers t where t.id = v_teacher and (t.status = 'active' or t.suspension_approved_by is null)));
end
$$;
create or replace function private.tax_profile_for_payout(p_payout uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_teacher uuid;
  p private.teacher_tax_profiles;
  v_standing text;
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
  -- Antes de la auditoría: sin datos, no hay lectura.
  v_standing := private.tax_clabe_standing(p.teacher_id, p.clabe_changed_at, p.clabe_effective_from);
  if v_standing = 'dead' then
    return '{"outcome": "clabe_recapture"}'::jsonb;
  end if;
  if v_standing = 'held' then
    return '{"outcome": "clabe_held"}'::jsonb;
  end if;
  if v_standing = 'waiting' then
    return pg_catalog.jsonb_build_object('outcome', 'clabe_waiting', 'until', p.clabe_effective_from);
  end if;
  insert into public.audit_log (actor_id, actor_kind, category, action, entity_table, entity_id, new_value, reason, request_id)
  values (private.actor_id(), 'user', 'privacy', 'tax_profile.read', 'private.teacher_tax_profiles', p.id::text, pg_catalog.jsonb_build_object('teacher_id', p.teacher_id, 'payout_id', p_payout),
          nullif(pg_catalog.current_setting('app.reason', true), ''),
          nullif(pg_catalog.current_setting('app.request_id', true), ''));
  return private.tax_profile_payload(p);
end
$$;
create or replace function private.schema_violations_tax()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  tax_functions (name, signature, reads) as (
    values ('tax_profile_save', 'private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer, boolean)', false),
           ('tax_profile_state', 'private.tax_profile_state()', false),
           ('tax_profile_mine', 'private.tax_profile_mine()', true),
           ('tax_profile_for_payout', 'private.tax_profile_for_payout(uuid)', true)),
  -- Las que nombran la tabla sin leer lo cifrado: la lista de PA-65 solo dice si hay una fila, y el vigilante la vigila.
  tax_known (oid) as (
    select pg_catalog.to_regprocedure(f.signature)::oid from tax_functions f
    union all
    select pg_catalog.to_regprocedure(k.signature)::oid
    from (values ('private.teacher_roster()'), ('private.tax_profile_fiscal(uuid, integer)'), ('private.schema_violations_tax()'), ('private.schema_violations_ledgers()')) k (signature))
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
  select 'tax save without the clabe wait', 'tax_profile_save'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer, boolean)')) like '%tax_clabe_standing%tax_clabe_wait%clabe_effective_from%', false)
  union all
  select 'tax finance read without the clabe wait', 'tax_profile_for_payout'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_for_payout(uuid)')) like '%tax_clabe_standing%clabe_waiting%audit_log%', false)
  union all
  select k.name || ' reachable', k.name
  from (values ('tax_clabe_standing', 'private.tax_clabe_standing(uuid, timestamptz, timestamptz)'), ('tax_clabe_wait', 'private.tax_clabe_wait()')) k (name, signature)
  where pg_catalog.to_regprocedure(k.signature) is null
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(k.signature))
     or pg_catalog.has_function_privilege('app_service', k.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', k.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', k.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', k.signature, 'execute')
  union all
  select 'tax save without the balance lock', 'tax_profile_save'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer, boolean)')) like '%teacher_balance:%', false)
  union all
  -- Y la fila del maestro, para ir uno tras otro con quien confirma un fraude: un candado que se mueva de sentencia dejaría escribir después de confirmado.
  select 'tax save without the teacher row', 'tax_profile_save'
  where not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer, boolean)')) like '%from public.teachers t join public.profiles p on p.id = t.profile_id%for share of t%', false)
  union all
  -- El estado y la lista de PA-65 no leen lo que hay en la tabla: no quedan en la auditoría.
  select 'tax data out of its doors: ' || d.name, d.name
  from (values ('tax_profile_state', 'private.tax_profile_state()'), ('teacher_roster', 'private.teacher_roster()')) d (name, signature)
  where coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(d.signature)), '') ~ '(rfc_enc|legal_name_enc|clabe_enc|clabe_last4|tax_regime_code|payee_kind)'
  union all
  -- Lo fiscal en claro lee el régimen y el tipo de persona, porque el dinero los necesita; lo cifrado y los últimos cuatro, no.
  select 'tax data out of its doors: tax_profile_fiscal', 'tax_profile_fiscal'
  where coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.tax_profile_fiscal(uuid, integer)')), '') ~ '(rfc_enc|legal_name_enc|clabe_enc|clabe_last4)'
  union all
  -- Y no es de nadie más que del dueño: sin auditoría, entregaría el régimen de cada maestro.
  select 'tax_profile_fiscal reachable', 'tax_profile_fiscal'
  where pg_catalog.to_regprocedure('private.tax_profile_fiscal(uuid, integer)') is null
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('private.tax_profile_fiscal(uuid, integer)'))
     or pg_catalog.has_function_privilege('app_service', 'private.tax_profile_fiscal(uuid, integer)', 'execute')
     or pg_catalog.has_function_privilege('authenticated', 'private.tax_profile_fiscal(uuid, integer)', 'execute')
     or pg_catalog.has_function_privilege('anon', 'private.tax_profile_fiscal(uuid, integer)', 'execute')
     or pg_catalog.has_function_privilege('service_role', 'private.tax_profile_fiscal(uuid, integer)', 'execute')
  union all
  -- Lo que garantiza que el neto sea positivo, y que regla y versión vayan juntas.
  select 'tax constraint missing: ' || c.name, c.name
  from (values ('withholding_rules_something_left', 'public.withholding_rules'), ('payouts_withholding_together', 'public.payouts'),
               ('payouts_hold_kind_when_held', 'public.payouts'), ('payouts_hold_kind_known', 'public.payouts')) c (name, table_name)
  where not exists (select 1 from pg_catalog.pg_constraint k where k.conname = c.name and k.conrelid = c.table_name::regclass and k.convalidated)
  union all
  -- La auditoría de las liquidaciones no dice con qué regla ni con qué impuestos: configuración la lee, y las reglas dicen el régimen.
  select 'payouts audit names the withholding rule', 'public.payouts'
  where not exists (select 1 from pg_catalog.pg_trigger tg where tg.tgrelid = 'public.payouts'::regclass and tg.tgname = 'audit_changes'
                      and pg_catalog.pg_get_triggerdef(tg.oid) like '%withholding_rule_id%vat_cents%income_tax_withheld_cents%vat_withheld_cents%net_cents%')
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
               ('teacher_tax_profiles_clabe_sealed', '%octet_length(clabe_enc) = 49%'), ('teacher_tax_profiles_last4_form', '%[0-9]{4}%'),
               ('teacher_tax_profiles_clabe_dates', '%clabe_effective_from%clabe_changed_at%')) c (name, pattern)
  where not exists (
    select 1 from pg_catalog.pg_constraint k
    where k.conrelid = 'private.teacher_tax_profiles'::regclass and k.conname = c.name and k.convalidated
      and pg_catalog.pg_get_constraintdef(k.oid) like c.pattern)
$$;