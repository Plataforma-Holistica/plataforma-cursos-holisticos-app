-- T-208, segunda solicitud · Lo que lee PA-68 mínima y cómo excluye por la pantalla (RF-406,
-- RN-17; 03 PA-68, 04 FL-64). Decisiones de Sergio del 2026-10-22: una sola dirección
-- (`/admin/alertas`), y de cada cuenta la antigüedad y lo que aporta al maestro por tramos.
--
-- Finanzas no ve a nadie por su nombre ni por su identificador: hasta el alias de T-408, cada
-- cuenta va con una huella por alerta (`private.alert_account_token()`), hecha con una llave de la
-- base para que quien conoce un identificador no pueda comprobar si esa persona es la señalada. La
-- pantalla excluye con esa huella (`private.exclude_alert_account()`), y la base la resuelve contra
-- las cuentas de esa alerta. De lecciones imposibles se ven solo totales; del salto, las cuentas que
-- más aportan a esa maestra, con lo que aportan por tramos, nunca qué más ven.

-- ---------------------------------------------------------------------------------------
-- La huella de una cuenta en una alerta: 12 caracteres de un sha256 con llave. La llave es una
-- sola fila al azar por base, que nadie de la aplicación lee.

create table private.alert_account_key (
  only_row boolean primary key default true,
  key text not null,
  constraint alert_account_key_one_row check (only_row)
);
comment on table private.alert_account_key is 'La llave de las huellas de las cuentas en PA-68 (T-208). Una fila al azar por base; nadie de la aplicación la lee.';
alter table private.alert_account_key enable row level security;
revoke all on private.alert_account_key from public, anon, authenticated, service_role, app_service;
insert into private.alert_account_key (key)
values (pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          gen_random_uuid()::text || gen_random_uuid()::text || pg_catalog.clock_timestamp()::text, 'UTF8')), 'hex'));

create function private.alert_account_token(p_alert uuid, p_profile uuid) returns text
language sql stable set search_path = ''
as $$
  select pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
           k.key || p_alert::text || ':' || p_profile::text, 'UTF8')), 'hex'), 12)
  from private.alert_account_key k
$$;
revoke all on function private.alert_account_token(uuid, uuid) from public;

-- La antigüedad de una cuenta, por tramos: así no se reconoce la misma cuenta en dos alertas.
create function private.account_age_tier(p_profile uuid) returns text
language sql stable set search_path = ''
as $$
  select case when pg_catalog.now() - p.created_at < interval '7 days' then 'under_7'
              when pg_catalog.now() - p.created_at < interval '30 days' then 'under_30'
              when pg_catalog.now() - p.created_at < interval '90 days' then 'under_90'
              else 'over_90' end
  from public.profiles p where p.id = p_profile
$$;
revoke all on function private.account_age_tier(uuid) from public;

-- ---------------------------------------------------------------------------------------
-- Una alerta tal como la ve finanzas. Sin `profile_id`, correos, nombres de alumnas, títulos ni
-- identificadores de maestros, lecciones o reproducciones.
--   · `today`: la cifra de hoy, recalculada del consolidado (lecciones imposibles, con la
--     velocidad que se usó al detectar: la lectura no se cae si falta el parámetro);
--   · `accounts`: de lecciones imposibles, su cuenta con totales; del salto, las diez que más le
--     aportan a esa maestra en el periodo más las ya excluidas por la alerta (`more_accounts`, las
--     que no caben), cada una con sus medios puntos con esa maestra en el mes y en el anterior, sus
--     lecciones con ella, su antigüedad y lo que le aporta, por tramos; del bote sin consumo, ninguna;
--   · `exclusions`: las ligadas a la alerta, vigentes y revertidas, con quién y cuándo, por su
--     nombre visible.

create function private.finance_alert_card(p_alert uuid) returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  a public.anomaly_alerts;
  v_window public.period_id[] := array(select private.rollup_window());
  v_previous public.period_id;
  v_today numeric;
  v_before integer;
  v_after integer;
  v_accounts jsonb := '[]'::jsonb;
  v_more integer := 0;
begin
  select * into a from public.anomaly_alerts x where x.id = p_alert;
  v_previous := pg_catalog.to_char(pg_catalog.to_date(a.period_id::text || '01', 'YYYYMMDD') - interval '1 month', 'YYYYMM')::integer;

  if a.kind = 'impossible_completion' then
    select pg_catalog.round(pg_catalog.sum(w.covered_seconds) / nullif((a.details ->> 'speed')::numeric, 0), 3)
    into v_today
    from public.watch_rollup w where w.period_id = a.period_id and w.profile_id = a.profile_id and w.half_points = 2;
    v_accounts := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'account', private.alert_account_token(a.id, a.profile_id),
      'age', private.account_age_tier(a.profile_id),
      'share', null, 'half_points', null, 'half_points_before', null,
      'lessons', (select pg_catalog.count(*) from public.watch_rollup w
                  where w.period_id = a.period_id and w.profile_id = a.profile_id and w.half_points = 2),
      'covered_seconds', (select coalesce(pg_catalog.sum(w.covered_seconds), 0) from public.watch_rollup w
                          where w.period_id = a.period_id and w.profile_id = a.profile_id and w.half_points = 2),
      'excluded', exists (select 1 from public.consumption_exclusions x
                          where x.anomaly_alert_id = a.id and x.profile_id = a.profile_id and x.revoked_at is null)));
  elsif a.kind = 'teacher_points_jump' then
    select coalesce(pg_catalog.sum(w.half_points), 0) into v_after
    from public.watch_rollup w where w.period_id = a.period_id and w.teacher_id = a.teacher_id;
    select coalesce(pg_catalog.sum(w.half_points), 0) into v_before
    from public.watch_rollup w where w.period_id = v_previous and w.teacher_id = a.teacher_id;
    v_today := case when v_before > 0 then pg_catalog.round((v_after - v_before) * 10000.0 / v_before, 3) end;

    with contributors as (
      select w.profile_id, pg_catalog.sum(w.half_points)::integer as points, pg_catalog.count(*)::integer as lessons
      from public.watch_rollup w where w.period_id = a.period_id and w.teacher_id = a.teacher_id
      group by w.profile_id
    ), ranked as (
      select c.profile_id, pg_catalog.row_number() over (
               order by c.points desc, private.alert_account_token(a.id, c.profile_id)) as rank
      from contributors c
    ), shown as (
      select r.profile_id from ranked r where r.rank <= 10
      union
      select x.profile_id from public.consumption_exclusions x where x.anomaly_alert_id = a.id
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'account', private.alert_account_token(a.id, s.profile_id),
             'age', private.account_age_tier(s.profile_id),
             'share', case when coalesce(t.total, 0) = 0 then null
                           when c.points = t.total then 'only'
                           when c.points * 2 > t.total then 'most'
                           else 'less_than_half' end,
             'half_points', coalesce(c.points, 0),
             'half_points_before', coalesce(b.points, 0),
             'lessons', coalesce(c.lessons, 0),
             'covered_seconds', null,
             'excluded', exists (select 1 from public.consumption_exclusions x
                                 where x.anomaly_alert_id = a.id and x.profile_id = s.profile_id and x.revoked_at is null))
           order by coalesce(c.points, 0) desc, private.alert_account_token(a.id, s.profile_id)), '[]'::jsonb),
           (select pg_catalog.count(*) from contributors cc where cc.profile_id not in (select sh.profile_id from shown sh))
    into v_accounts, v_more
    from shown s
    left join contributors c on c.profile_id = s.profile_id
    left join lateral (select pg_catalog.sum(w.half_points)::integer as total from public.watch_rollup w
                       where w.period_id = a.period_id and w.profile_id = s.profile_id) t on true
    left join lateral (select pg_catalog.sum(w.half_points)::integer as points from public.watch_rollup w
                       where w.period_id = v_previous and w.teacher_id = a.teacher_id and w.profile_id = s.profile_id) b on true;
  end if;

  return pg_catalog.jsonb_build_object(
    'id', a.id, 'period', a.period_id, 'kind', a.kind, 'status', a.status,
    'metric', a.metric_value, 'threshold', a.threshold_value, 'today', v_today,
    'details', a.details - array['from', 'until'], 'detected_at', a.detected_at,
    'review_note', a.review_note, 'is_fraud', a.is_fraud, 'evidence', a.evidence, 'reviewed_at', a.reviewed_at,
    'reviewed_by_name', (select p.display_name from public.profiles p where p.id = a.reviewed_by),
    'teacher_name', (select t.display_name from public.published_teachers t where t.teacher_id = a.teacher_id),
    'can_exclude', a.period_id = any (v_window),
    'accounts', v_accounts, 'more_accounts', v_more,
    'exclusions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', x.id, 'account', private.alert_account_token(a.id, x.profile_id), 'scope', x.scope,
               'reason_code', x.reason_code, 'reason', x.reason,
               'created_by_name', (select p.display_name from public.profiles p where p.id = x.created_by),
               'created_at', x.created_at, 'revoked_at', x.revoked_at,
               'revoked_by_name', (select p.display_name from public.profiles p where p.id = x.revoked_by),
               'revoke_reason', x.revoke_reason) order by x.created_at, x.id)
      from public.consumption_exclusions x where x.anomaly_alert_id = a.id), '[]'::jsonb));
end
$$;
revoke all on function private.finance_alert_card(uuid) from public;

-- Lo que lee PA-68: nulo si quien actúa no pasa la puerta del equipo con finanzas (como
-- `private.review_queue()`); si no, si su código es reciente (`fresh_code`), cuántas alertas hay y
-- hasta 50: las abiertas de cualquier periodo y las revisadas de los periodos que todavía reciben
-- latidos, las abiertas primero y por antigüedad. Leer no pide el código reciente: decidir, sí.
create function private.finance_alerts() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_window public.period_id[];
begin
  if private.actor_id() is null or not private.actor_has_capability('finance') then
    return null;
  end if;
  v_window := array(select private.rollup_window());
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.finance_change_gate() is null,
    'total', (select pg_catalog.count(*) from public.anomaly_alerts a where a.status = 'open' or a.period_id = any (v_window)),
    'alerts', coalesce((
      select pg_catalog.jsonb_agg(private.finance_alert_card(s.id) order by (s.status = 'open') desc, s.detected_at, s.id)
      from (select a.id, a.status, a.detected_at from public.anomaly_alerts a
            where a.status = 'open' or a.period_id = any (v_window)
            order by (a.status = 'open') desc, a.detected_at, a.id limit 50) s), '[]'::jsonb));
end
$$;
revoke all on function private.finance_alerts() from public;
grant execute on function private.finance_alerts() to app_service;

-- Excluir desde la pantalla una cuenta de una alerta, por su huella: en el periodo de la alerta,
-- ligada a ella, con `private.exclude_consumption()` (y sus mismas respuestas). La huella se
-- resuelve contra las cuentas de esa alerta: la de lecciones imposibles; del salto, todas las que
-- vieron a esa maestra en el periodo (no solo las diez que se muestran) y las ya excluidas por la
-- alerta. Si no es de ninguna, o lo fuera de dos, `not_found`. La puerta va antes que la búsqueda:
-- quien no tiene finanzas no puede usarla para saber si una huella existe.
create function private.exclude_alert_account(p_alert uuid, p_account text, p_reason_code text, p_reason text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  a public.anomaly_alerts;
  v_matches uuid[];
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'finance decisions run in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_alert is null or p_account is null or p_account !~ '^[0-9a-f]{12}$' then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select * into a from public.anomaly_alerts x where x.id = p_alert;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  v_matches := array(
    select c.profile_id from (
      select a.profile_id where a.kind = 'impossible_completion'
      union
      select w.profile_id from public.watch_rollup w
      where a.kind = 'teacher_points_jump' and w.period_id = a.period_id and w.teacher_id = a.teacher_id
      union
      select e.profile_id from public.watch_events e join public.published_lessons l on l.id = e.lesson_id
      where a.kind = 'teacher_points_jump' and e.period_id = a.period_id and l.teacher_id = a.teacher_id
      union
      select x.profile_id from public.consumption_exclusions x where x.anomaly_alert_id = a.id
    ) c
    where c.profile_id is not null and private.alert_account_token(a.id, c.profile_id) = p_account);
  if pg_catalog.cardinality(v_matches) <> 1 then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  return private.exclude_consumption('account', a.period_id, v_matches[1], null, null, null, null, p_reason_code, p_reason, a.id);
end
$$;
revoke all on function private.exclude_alert_account(uuid, text, text, text) from public;
grant execute on function private.exclude_alert_account(uuid, text, text, text) to app_service;

-- ---------------------------------------------------------------------------------------
-- Revisar una alerta, con un cambio: decidir fraude con la alerta ya revisada no pide nota (la
-- revisión ya tiene la suya, y no se cambia). Revisarla, sí. Lo demás, como la primera solicitud.

create or replace function private.review_alert(p_alert uuid, p_note text, p_is_fraud boolean, p_evidence text) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_note text := nullif(pg_catalog.btrim(p_note), '');
  v_evidence text := nullif(pg_catalog.btrim(p_evidence), '');
  v_row public.anomaly_alerts;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'finance decisions run in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_alert is null or pg_catalog.length(coalesce(v_note, '')) > 4000
     or (p_is_fraud is true and (v_evidence is null or pg_catalog.length(v_evidence) > 4000)) then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select * into v_row from public.anomaly_alerts a where a.id = p_alert for update;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if v_row.status = 'open' then
    if v_note is null then
      return '{"outcome": "malformed"}'::jsonb;
    end if;
    update public.anomaly_alerts a
    set status = 'reviewed', review_note = v_note, reviewed_by = private.actor_id(), reviewed_at = pg_catalog.now(),
        is_fraud = p_is_fraud, evidence = case when p_is_fraud then v_evidence end
    where a.id = p_alert;
    return '{"outcome": "reviewed"}'::jsonb;
  end if;
  if p_is_fraud is true and v_row.is_fraud is not true then
    update public.anomaly_alerts a set is_fraud = true, evidence = v_evidence where a.id = p_alert;
    return '{"outcome": "marked_fraud"}'::jsonb;
  end if;
  return '{"outcome": "already_reviewed"}'::jsonb;
end
$$;

-- ---------------------------------------------------------------------------------------
-- El vigilante: el área de las anomalías (de este carril) aprende la llave y las funciones nuevas.

create or replace function private.schema_violations_anomalies()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service'))
  -- Las alertas, las exclusiones y la llave de las huellas no las toca ningún rol de la
  -- aplicación, ni para leer: el servidor llega por las funciones de finanzas (T-208).
  select 'anomalies table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.anomaly_alerts'), ('public.consumption_exclusions'), ('private.alert_account_key')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Lo que corre solo el dueño de la base: detectar, marcar pares, la velocidad del periodo, la
  -- huella de una cuenta, su antigüedad y cada tarjeta de PA-68.
  select 'system function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.detect_anomalies(public.period_id, timestamptz)'),
                     ('private.mark_pairs_for(uuid, public.period_id, uuid, uuid)'),
                     ('private.max_speed(public.period_id)'),
                     ('private.alert_account_token(uuid, uuid)'),
                     ('private.account_age_tier(uuid)'),
                     ('private.finance_alert_card(uuid)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
  union all
  -- Las decisiones y la lectura de finanzas las llama solo el servidor, a nombre de quien pasa la
  -- puerta.
  select 'finance function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.exclude_consumption(public.exclusion_scope, public.period_id, uuid, uuid, uuid, integer, integer, text, text, uuid)'),
                     ('private.revoke_exclusion(uuid, text)'),
                     ('private.review_alert(uuid, text, boolean, text)'),
                     ('private.finance_alerts()'),
                     ('private.exclude_alert_account(uuid, text, text, text)')) as f (signature)
  where r.rolname <> 'app_service'
    and pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
  union all
  -- La marca de fraude de una cuenta la prende solo una decisión de finanzas (RN-17).
  select 'suspended_for_fraud writable by ' || r.rolname, 'public.profiles'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.profiles'::regclass, 'suspended_for_fraud', 'UPDATE')
$$;
