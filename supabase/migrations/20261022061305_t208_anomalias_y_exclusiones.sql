-- T-208 · Alertas de anomalía, exclusiones de consumo y el procedimiento de fraude (RF-404, RF-406,
-- RN-08, RN-17; 05 §5.4, §8.2 y §13). Decisiones de Sergio del 2026-10-21:
--   · alcance: la base y PA-68 mínima (esta migración es la base); la alerta del bote sin consumo
--     espera al bote (T-407), las dos firmas para suspender a un maestro a PA-66 (T-401), y el
--     aviso al maestro a T-408;
--   · la alerta de lecciones imposibles es una red de seguridad, tal cual el PRD;
--   · la de salto de puntos compara el mes terminado contra el anterior, con un piso de medios
--     puntos en el mes de comparación (parámetro nuevo `ALERTA_SALTO_MINIMO_MEDIOS_PUNTOS`);
--   · toda exclusión la crea finanzas, con su código reciente y un motivo escrito; la de fraude
--     exige una alerta decidida como fraude; una cuenta suspendida por fraude pierde todo su
--     consumo de los periodos abiertos.
--
-- Una exclusión es una regla, no un borrado: el latido no se toca (RF-404). La consolidación la
-- aplica en `private.rollup_pair()`, y crearla o revertirla marca los pares que cambian para la
-- corrida siguiente. Las alertas las abre la corrida de cada noche al final de cada periodo, una
-- sola vez por periodo, tipo y sujeto.
--
-- Lo que cambia respecto del esquema escrito (05):
--   · nadie de la aplicación lee ni escribe las dos tablas: el servidor llega por funciones de la
--     base con la puerta de finanzas (el 05 le daba al servidor leer, insertar y actualizar, y a
--     finanzas leer por políticas); las abre la corrida, que no sale de la base (T-207);
--   · `period_id` sin clave foránea a `payout_periods`, ni el congelado al cerrar (T-601, T-602):
--     hasta entonces, un periodo se toca solo mientras recibe latidos (`rollup_window()`);
--   · la marca `suspended_for_fraud` ya no la escribe el servidor: la prende solo una decisión de
--     fraude de finanzas sobre esa cuenta (con T-307, que suspende), no la casilla de soporte que
--     dibuja PA-71; cambiarla marca los pares de la cuenta;
--   · las respuestas del maestro (columnas `teacher_*`) nacen sin uso hasta T-408.

-- ---------------------------------------------------------------------------------------
-- Las tablas (05 §5.4).

create type public.exclusion_scope as enum ('account', 'session', 'interval');
create type public.anomaly_kind as enum ('teacher_points_jump', 'impossible_completion', 'unconsumed_pool_ratio');
create type public.alert_status as enum ('open', 'reviewed');

-- Las alertas de RF-406 con su atención. Una alerta conserva su historia: la decisión de excluir y
-- su reversa son filas de `consumption_exclusions` ligadas a ella.
create table public.anomaly_alerts (
  id uuid primary key default gen_random_uuid(),
  period_id public.period_id not null,
  kind public.anomaly_kind not null,
  teacher_id uuid references public.teachers (id),
  profile_id uuid references public.profiles (id),
  metric_value numeric not null,              -- lo medido
  threshold_value numeric not null,           -- el umbral vigente al detectar
  details jsonb not null default '{}'::jsonb, -- cifras del periodo y del anterior. Nunca correos ni títulos
  status public.alert_status not null default 'open',
  detected_at timestamptz not null default now(),
  review_note text,
  evidence text,                              -- obligatoria para decidir un fraude (RN-17)
  is_fraud boolean,                           -- nulo hasta que finanzas decide
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  teacher_notified_at timestamptz,            -- el aviso al maestro y su respuesta: T-408
  teacher_response_due_at timestamptz,
  teacher_response text,
  teacher_response_at timestamptz,
  teacher_response_recorded_by uuid references public.profiles (id),
  constraint anomaly_alerts_subject check (
    (kind = 'teacher_points_jump' and teacher_id is not null and profile_id is null)
    or (kind = 'impossible_completion' and profile_id is not null and teacher_id is null)
    or (kind = 'unconsumed_pool_ratio' and teacher_id is null and profile_id is null)),
  constraint anomaly_alerts_review_consistent check (
    (status = 'reviewed') = (reviewed_at is not null)
    and (status = 'reviewed') = (reviewed_by is not null)
    and (status <> 'reviewed' or review_note is not null)),
  constraint anomaly_alerts_fraud_needs_evidence check (is_fraud is not true or evidence is not null),
  constraint anomaly_alerts_text_lengths check (
    pg_catalog.length(coalesce(review_note, '')) <= 4000 and pg_catalog.length(coalesce(evidence, '')) <= 4000)
);
comment on table public.anomaly_alerts is 'Alertas de RF-406 con su atención (T-208). Las abre la corrida nocturna; las revisa finanzas por sus funciones.';
-- La corrida corre cada noche: no abre dos veces la misma alerta.
create unique index anomaly_alerts_teacher_uq
  on public.anomaly_alerts (period_id, kind, teacher_id) where teacher_id is not null;
create unique index anomaly_alerts_profile_uq
  on public.anomaly_alerts (period_id, kind, profile_id) where profile_id is not null;
create unique index anomaly_alerts_period_uq
  on public.anomaly_alerts (period_id, kind) where teacher_id is null and profile_id is null;
-- Precondición del cierre (T-601): no hay alertas sin revisar.
create index anomaly_alerts_open_idx on public.anomaly_alerts (period_id) where status = 'open';
alter table public.anomaly_alerts enable row level security;
revoke all on public.anomaly_alerts from public, anon, authenticated, service_role, app_service;

-- Las reglas de corrección (RF-404): por cuenta, por reproducción o por tramo de una lección, con
-- autor y motivo. Revertir es llenar la revocación; nada se borra.
create table public.consumption_exclusions (
  id uuid primary key default gen_random_uuid(),
  period_id public.period_id not null,
  scope public.exclusion_scope not null,
  profile_id uuid not null references public.profiles (id),   -- la cuenta cuyo consumo se excluye
  playback_session_id uuid,                   -- sin clave foránea: la reproducción se purga con los latidos
  lesson_id uuid references public.published_lessons (id),
  from_second integer,
  to_second integer,
  reason_code text not null,
  reason text not null,
  anomaly_alert_id uuid references public.anomaly_alerts (id),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id),
  revoke_reason text,
  constraint consumption_exclusions_reason_known
    check (reason_code in ('fraud', 'technical_error', 'test_account', 'other')),
  constraint consumption_exclusions_scope_fields check (
    (scope = 'account' and playback_session_id is null and lesson_id is null
       and from_second is null and to_second is null)
    or (scope = 'session' and playback_session_id is not null and lesson_id is null
       and from_second is null and to_second is null)
    or (scope = 'interval' and playback_session_id is null and lesson_id is not null
       and from_second >= 0 and to_second > from_second)),
  constraint consumption_exclusions_fraud_has_alert check (reason_code <> 'fraud' or anomaly_alert_id is not null),
  constraint consumption_exclusions_revocation_consistent check (
    (revoked_at is null) = (revoked_by is null) and (revoked_at is null) = (revoke_reason is null)),
  constraint consumption_exclusions_text_lengths check (
    pg_catalog.length(reason) <= 2000 and pg_catalog.length(coalesce(revoke_reason, '')) <= 2000)
);
comment on table public.consumption_exclusions is 'Reglas de corrección del consumo (RF-404, RN-17; T-208). La consolidación resta las vigentes; las escribe finanzas por sus funciones.';
-- La consolidación busca las vigentes de cada par.
create index consumption_exclusions_period_idx
  on public.consumption_exclusions (period_id, profile_id) where revoked_at is null;
alter table public.consumption_exclusions enable row level security;
revoke all on public.consumption_exclusions from public, anon, authenticated, service_role, app_service;

-- ---------------------------------------------------------------------------------------
-- La puerta de finanzas. Nulo si pasa.
--   forbidden         quien actúa no tiene finanzas (o no hay quien actúe)
--   needs_fresh_code  la tiene, pero su sesión no pasa la puerta del equipo o su código no es
--                     reciente: que dé su código otra vez
-- La misma que la de Contenido (T-106), con finanzas: una decisión que mueve dinero no la toma una
-- sesión robada durante las horas de la puerta.

create function private.finance_change_gate() returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
begin
  if v_actor is null or not exists (
      select 1 from public.admin_capabilities c
      where c.profile_id = v_actor and c.capability = 'finance' and c.revoked_at is null) then
    return 'forbidden';
  end if;
  if not private.actor_has_capability('finance')
     or not private.fresh_code(v_actor, private.actor_session()) then
    return 'needs_fresh_code';
  end if;
  return null;
end
$$;
revoke all on function private.finance_change_gate() from public;

-- ---------------------------------------------------------------------------------------
-- Los guardianes. No son security definer: miran quién ejecuta. Escribe solo el dueño de la tabla
-- (las funciones de abajo), y nada se borra ni se vacía (`truncate` no pasa por los disparadores de
-- cada fila: el mismo guardián lo cierra aparte).

-- Las exclusiones: solo a nombre de quien pasa la puerta de finanzas; de una que existe cambia solo
-- la revocación, una vez.
create function private.guard_consumption_exclusions() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
begin
  if tg_op = 'TRUNCATE' then
    raise exception '%.%: exclusions are revoked, not deleted', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner from pg_catalog.pg_class c where c.oid = tg_relid;
  if current_user::name <> v_owner or private.finance_change_gate() is not null then
    raise exception '%.%: only the finance functions write exclusions', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception '%.%: exclusions are revoked, not deleted', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
       old.revoked_at is not null
       or (pg_catalog.to_jsonb(new) - array['revoked_at', 'revoked_by', 'revoke_reason'])
          is distinct from (pg_catalog.to_jsonb(old) - array['revoked_at', 'revoked_by', 'revoke_reason'])) then
    raise exception '%.%: only the revocation changes, once', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger exclusions_guard before insert or update or delete on public.consumption_exclusions
  for each row execute function private.guard_consumption_exclusions();
create trigger exclusions_no_truncate before truncate on public.consumption_exclusions
  for each statement execute function private.guard_consumption_exclusions();
create trigger audit_changes after insert or update or delete on public.consumption_exclusions
  for each row execute function private.audit_row_change('money');

-- Las alertas: las abre solo el dueño declarado sistema (la corrida); las cambia solo finanzas, y
-- solo su atención: la revisión una vez, y la decisión de fraude, que se puede tomar después de
-- revisar (la respuesta del maestro llega después del cierre) y no se deshace. Lo medido, el sujeto
-- y las cifras no cambian; la respuesta del maestro, tampoco hasta T-408.
create function private.guard_anomaly_alerts() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner name;
begin
  if tg_op = 'TRUNCATE' then
    raise exception '%.%: alerts are reviewed, not deleted', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner from pg_catalog.pg_class c where c.oid = tg_relid;
  if current_user::name <> v_owner then
    raise exception '%.%: only the detection and the finance functions write alerts', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception '%.%: alerts are reviewed, not deleted', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if not private.actor_is_system() or new.status <> 'open' or new.reviewed_at is not null or new.is_fraud is not null
       or new.evidence is not null or new.teacher_notified_at is not null then
      raise exception '%.%: only the nightly detection opens alerts', tg_table_schema, tg_table_name using errcode = '42501';
    end if;
    return new;
  end if;
  if private.finance_change_gate() is not null
     or (pg_catalog.to_jsonb(new) - array['status', 'review_note', 'reviewed_by', 'reviewed_at', 'evidence', 'is_fraud'])
        is distinct from (pg_catalog.to_jsonb(old) - array['status', 'review_note', 'reviewed_by', 'reviewed_at', 'evidence', 'is_fraud'])
     or (old.status = 'reviewed' and (new.status, new.review_note, new.reviewed_by, new.reviewed_at)
                                     is distinct from (old.status, old.review_note, old.reviewed_by, old.reviewed_at))
     or (old.is_fraud is true and new.is_fraud is not true)
     or (old.evidence is not null and new.evidence is distinct from old.evidence) then
    raise exception '%.%: only the review changes, once; a fraud decision stays', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger alerts_guard before insert or update or delete on public.anomaly_alerts
  for each row execute function private.guard_anomaly_alerts();
create trigger alerts_no_truncate before truncate on public.anomaly_alerts
  for each statement execute function private.guard_anomaly_alerts();
create trigger audit_changes after insert or update or delete on public.anomaly_alerts
  for each row execute function private.audit_row_change('money');

-- ---------------------------------------------------------------------------------------
-- Marcar pares para la corrida siguiente. Los pares salen del libro (los tramos que cuentan) y del
-- consolidado: así revertir una exclusión restaura lo que ella ya había borrado. Con `p_lesson`,
-- solo esa lección; con `p_session`, solo las lecciones de esa reproducción. Una marca que ya
-- existía se renueva con la hora de ahora, en la misma transacción que la decisión: un paso que la
-- leyó antes ya no la borra (borra solo las que siguen como las leyó). En orden de lección: dos
-- decisiones a la vez no se esperan en cruz. Devuelve cuántas marcó.

create function private.mark_pairs_for(p_profile uuid, p_period public.period_id, p_lesson uuid, p_session uuid)
returns integer
language sql volatile set search_path = ''
as $$
  with pairs as (
    select e.lesson_id from public.watch_events e
    where e.period_id = p_period and e.profile_id = p_profile and e.counts_for_payout
      and (p_lesson is null or e.lesson_id = p_lesson)
      and (p_session is null or e.playback_session_id = p_session)
    union
    select w.lesson_id from public.watch_rollup w
    where p_session is null and w.period_id = p_period and w.profile_id = p_profile
      and (p_lesson is null or w.lesson_id = p_lesson)
  ), marked as (
    insert into private.rollup_dirty (period_id, profile_id, lesson_id, touched_at)
    select p_period, p_profile, p.lesson_id, pg_catalog.clock_timestamp() from pairs p order by p.lesson_id
    on conflict (period_id, profile_id, lesson_id) do update set touched_at = excluded.touched_at
    returning 1
  )
  select pg_catalog.count(*)::integer from marked
$$;
revoke all on function private.mark_pairs_for(uuid, public.period_id, uuid, uuid) from public;

-- ---------------------------------------------------------------------------------------
-- Consolidar un par, ya con las exclusiones (05 §8.2). Lo de T-207 no cambia; se agrega, en la
-- misma sentencia que lee los tramos (todo sale del mismo instante):
--   · nada de una cuenta suspendida por fraude, ni de una con una exclusión vigente de la cuenta
--     en el periodo;
--   · nada de una reproducción con una exclusión vigente de esa reproducción en el periodo;
--   · menos los tramos excluidos de esa lección en el periodo, sea cual sea el video.
-- Un video cuyos tramos quedan vacíos no compite; si no queda ninguno, la fila se borra.

create or replace function private.rollup_pair(p_period public.period_id, p_profile uuid, p_lesson uuid, p_run uuid,
                                               p_half_bps integer, p_full_bps integer)
returns integer
language plpgsql volatile set search_path = ''
as $$
declare
  v_video uuid;
  v_duration integer;
  v_covered integer;
  v_points smallint;
  v_written integer;
begin
  select c.video_asset_id, c.duration, c.covered, private.half_points(c.covered, c.duration, p_half_bps, p_full_bps)
  into v_video, v_duration, v_covered, v_points
  from (
    select v0.video_asset_id, v0.duration, v0.spans - x.excluded as spans
    from (
      select s.video_asset_id, pg_catalog.min(s.lesson_duration_seconds) as duration,
             pg_catalog.range_agg(pg_catalog.int4range(e.from_second, e.to_second)) as spans
      from public.watch_events e
      join public.playback_sessions s on s.id = e.playback_session_id
      where e.period_id = p_period and e.profile_id = p_profile and e.lesson_id = p_lesson and e.counts_for_payout
        and not exists (select 1 from public.profiles p where p.id = p_profile and p.suspended_for_fraud)
        and not exists (
          select 1 from public.consumption_exclusions x
          where x.period_id = p_period and x.profile_id = p_profile and x.revoked_at is null
            and (x.scope = 'account' or (x.scope = 'session' and x.playback_session_id = e.playback_session_id)))
      group by s.video_asset_id
    ) v0
    cross join (
      select coalesce(pg_catalog.range_agg(pg_catalog.int4range(x.from_second, x.to_second)), '{}'::int4multirange) as excluded
      from public.consumption_exclusions x
      where x.period_id = p_period and x.profile_id = p_profile and x.scope = 'interval' and x.lesson_id = p_lesson
        and x.revoked_at is null
    ) x
  ) v
  -- Lo que cae dentro de la duración, no un total recortado: [20, 100) contra 80 s son 60.
  cross join lateral (select v.video_asset_id, v.duration,
                             private.span_seconds(v.spans * pg_catalog.int4multirange(pg_catalog.int4range(0, v.duration))) as covered) c
  left join public.published_lessons l on l.id = p_lesson
  where not pg_catalog.isempty(v.spans)
  order by private.half_points(c.covered, c.duration, p_half_bps, p_full_bps) desc, c.covered desc,
           (c.video_asset_id = l.video_asset_id) desc, c.video_asset_id
  limit 1;

  if v_video is null then
    delete from public.watch_rollup w where w.period_id = p_period and w.profile_id = p_profile and w.lesson_id = p_lesson;
    get diagnostics v_written = row_count;
    return v_written;
  end if;

  insert into public.watch_rollup as w (
    period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id, lesson_duration_seconds,
    covered_seconds, half_points, computed_at, job_run_id)
  select p_period, p_profile, l.id, l.course_id, l.teacher_id, v_video, v_duration, v_covered, v_points, pg_catalog.now(), p_run
  from public.published_lessons l where l.id = p_lesson
  on conflict (period_id, profile_id, lesson_id) do update
  set course_id = excluded.course_id, teacher_id = excluded.teacher_id, video_asset_id = excluded.video_asset_id,
      lesson_duration_seconds = excluded.lesson_duration_seconds, covered_seconds = excluded.covered_seconds,
      half_points = excluded.half_points, computed_at = excluded.computed_at, job_run_id = excluded.job_run_id
  where (w.course_id, w.teacher_id, w.video_asset_id, w.lesson_duration_seconds, w.covered_seconds, w.half_points)
        is distinct from
        (excluded.course_id, excluded.teacher_id, excluded.video_asset_id, excluded.lesson_duration_seconds,
         excluded.covered_seconds, excluded.half_points);
  get diagnostics v_written = row_count;
  return v_written;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Las decisiones de finanzas (RN-17, FL-64). Las llama el servidor a nombre de quien pide, como
-- `approve_course`: `security definer`, sin permisos para nadie más. Cada una pasa por la puerta de
-- finanzas y contesta con una lista cerrada. Exigen read committed, y las de una misma cuenta van
-- una tras otra (un candado por cuenta): dos personas decidiendo a la vez no se pisan.

-- Excluir consumo. Contesta:
--   {outcome: 'excluded', ids}       las exclusiones creadas (una por periodo: una reproducción que
--                                    cruzó de mes deja una en cada uno)
--   forbidden | needs_fresh_code     la puerta
--   malformed                        lo que llega no tiene forma (alcance y campos, motivo escrito)
--   not_found                        la cuenta, la reproducción (de esa cuenta), la lección o la alerta
--   outside_window                   el periodo ya no recibe latidos: no se toca (con T-601 y T-602,
--                                    el periodo cerrado; mientras tanto, el mes anterior sigue en la
--                                    ventana aunque se haya cerrado el día 1)
--   needs_fraud_decision             por fraude, sin una alerta de ese periodo decidida como fraude
--   not_related                      por fraude, una cuenta que no provocó esa alerta
--   already_excluded                 ya hay una vigente igual (con el mismo motivo y la misma alerta:
--                                    una exclusión por otra causa no impide decidir el fraude)
-- Una reproducción se excluye en los periodos que ya tocó: si sigue viva y cruza de mes después,
-- lo nuevo no queda excluido (revocar reproducciones por fraude llega con T-307).
create function private.exclude_consumption(p_scope public.exclusion_scope, p_period public.period_id, p_profile uuid,
                                            p_session uuid, p_lesson uuid, p_from integer, p_to integer,
                                            p_reason_code text, p_reason text, p_alert uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_actor uuid;
  v_reason text := pg_catalog.btrim(p_reason);
  v_alert public.anomaly_alerts;
  v_window public.period_id[];
  v_periods public.period_id[];
  v_period public.period_id;
  v_id uuid;
  v_ids uuid[] := '{}';
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'finance decisions run in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  v_actor := private.actor_id();
  if p_scope is null or p_profile is null or p_reason_code is null
     or p_reason_code not in ('fraud', 'technical_error', 'test_account', 'other')
     or v_reason is null or v_reason = '' or pg_catalog.length(v_reason) > 2000
     or (p_scope = 'account' and (p_period is null or p_session is not null or p_lesson is not null
                                  or p_from is not null or p_to is not null))
     or (p_scope = 'session' and (p_session is null or p_lesson is not null or p_from is not null or p_to is not null))
     or (p_scope = 'interval' and (p_period is null or p_session is not null or p_lesson is null
                                   or p_from is null or p_to is null or p_from < 0 or p_to <= p_from)) then
    return '{"outcome": "malformed"}'::jsonb;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exclusions:' || p_profile::text, 0));
  if not exists (select 1 from public.profiles p where p.id = p_profile) then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  v_window := array(select private.rollup_window());
  if p_scope = 'session' then
    if not exists (select 1 from public.playback_sessions s where s.id = p_session and s.profile_id = p_profile) then
      return '{"outcome": "not_found"}'::jsonb;
    end if;
    v_periods := array(select distinct e.period_id from public.watch_events e
                       where e.playback_session_id = p_session and e.period_id = any (v_window) order by 1);
    if pg_catalog.cardinality(v_periods) = 0 then
      return '{"outcome": "outside_window"}'::jsonb;
    end if;
  else
    if not p_period = any (v_window) then
      return '{"outcome": "outside_window"}'::jsonb;
    end if;
    if p_scope = 'interval' and not exists (select 1 from public.published_lessons l where l.id = p_lesson) then
      return '{"outcome": "not_found"}'::jsonb;
    end if;
    v_periods := array[p_period];
  end if;

  if p_alert is not null then
    select * into v_alert from public.anomaly_alerts a where a.id = p_alert for update;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', case when p_reason_code = 'fraud' then 'needs_fraud_decision' else 'not_found' end);
    end if;
  end if;
  if p_reason_code = 'fraud' then
    -- RN-17: decide finanzas, con la evidencia escrita en la alerta; solo el periodo de la alerta.
    if v_alert.id is null or v_alert.is_fraud is not true or not v_alert.period_id = any (v_periods) then
      return '{"outcome": "needs_fraud_decision"}'::jsonb;
    end if;
    v_periods := array[v_alert.period_id];
    if not (
        (v_alert.kind = 'impossible_completion' and v_alert.profile_id = p_profile)
        or (v_alert.kind = 'teacher_points_jump' and (
              exists (select 1 from public.watch_rollup w
                      where w.period_id = v_alert.period_id and w.profile_id = p_profile and w.teacher_id = v_alert.teacher_id)
              or exists (select 1 from public.watch_events e join public.published_lessons l on l.id = e.lesson_id
                         where e.period_id = v_alert.period_id and e.profile_id = p_profile and l.teacher_id = v_alert.teacher_id))
            -- Por tramo o por reproducción, solo lo de ese maestro.
            and (p_scope <> 'interval' or exists (select 1 from public.published_lessons l
                                                  where l.id = p_lesson and l.teacher_id = v_alert.teacher_id))
            and (p_scope <> 'session' or exists (select 1 from public.playback_sessions s join public.published_lessons l on l.id = s.lesson_id
                                                 where s.id = p_session and l.teacher_id = v_alert.teacher_id)))) then
      return '{"outcome": "not_related"}'::jsonb;
    end if;
  end if;

  foreach v_period in array v_periods loop
    continue when exists (
      select 1 from public.consumption_exclusions x
      where x.period_id = v_period and x.profile_id = p_profile and x.scope = p_scope and x.revoked_at is null
        and x.playback_session_id is not distinct from p_session and x.lesson_id is not distinct from p_lesson
        and x.from_second is not distinct from p_from and x.to_second is not distinct from p_to
        and x.reason_code = p_reason_code and x.anomaly_alert_id is not distinct from p_alert);
    insert into public.consumption_exclusions (period_id, scope, profile_id, playback_session_id, lesson_id, from_second, to_second,
                                               reason_code, reason, anomaly_alert_id, created_by)
    values (v_period, p_scope, p_profile, p_session, p_lesson, p_from, p_to, p_reason_code, v_reason, p_alert, v_actor)
    returning id into v_id;
    v_ids := v_ids || v_id;
    perform private.mark_pairs_for(p_profile, v_period, p_lesson, p_session);
  end loop;
  if pg_catalog.cardinality(v_ids) = 0 then
    return '{"outcome": "already_excluded"}'::jsonb;
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'excluded', 'ids', pg_catalog.to_jsonb(v_ids));
end
$$;
revoke all on function private.exclude_consumption(public.exclusion_scope, public.period_id, uuid, uuid, uuid, integer, integer, text, text, uuid) from public;
grant execute on function private.exclude_consumption(public.exclusion_scope, public.period_id, uuid, uuid, uuid, integer, integer, text, text, uuid) to app_service;

-- Revertir una exclusión. Contesta `revoked`, la puerta, `malformed` (sin motivo), `not_found`,
-- `already_revoked` u `outside_window`. Revertir no devuelve nada mientras la cuenta siga suspendida
-- por fraude: esa marca manda.
create function private.revoke_exclusion(p_exclusion uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_reason text := pg_catalog.btrim(p_reason);
  v_profile uuid;
  v_row public.consumption_exclusions;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'finance decisions run in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_exclusion is null or v_reason is null or v_reason = '' or pg_catalog.length(v_reason) > 2000 then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select x.profile_id into v_profile from public.consumption_exclusions x where x.id = p_exclusion;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('exclusions:' || v_profile::text, 0));
  select * into v_row from public.consumption_exclusions x where x.id = p_exclusion for update;
  if v_row.revoked_at is not null then
    return '{"outcome": "already_revoked"}'::jsonb;
  end if;
  if not v_row.period_id = any (array(select private.rollup_window())) then
    return '{"outcome": "outside_window"}'::jsonb;
  end if;
  update public.consumption_exclusions x
  set revoked_at = pg_catalog.now(), revoked_by = private.actor_id(), revoke_reason = v_reason
  where x.id = p_exclusion;
  perform private.mark_pairs_for(v_row.profile_id, v_row.period_id, v_row.lesson_id, v_row.playback_session_id);
  return '{"outcome": "revoked"}'::jsonb;
end
$$;
revoke all on function private.revoke_exclusion(uuid, text) from public;
grant execute on function private.revoke_exclusion(uuid, text) to app_service;

-- Revisar una alerta (RF-406): con una nota. Decidirla como fraude (RN-17) pide además la evidencia
-- escrita, y se puede hacer al revisarla o después (FL-64: la respuesta del maestro llega después del
-- cierre). Una decisión de fraude no se deshace. Contesta `reviewed`, `marked_fraud`,
-- `already_reviewed`, la puerta, `malformed` o `not_found`.
create function private.review_alert(p_alert uuid, p_note text, p_is_fraud boolean, p_evidence text) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_note text := pg_catalog.btrim(p_note);
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
  if p_alert is null or v_note is null or v_note = '' or pg_catalog.length(v_note) > 4000
     or (p_is_fraud is true and (v_evidence is null or pg_catalog.length(v_evidence) > 4000)) then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  select * into v_row from public.anomaly_alerts a where a.id = p_alert for update;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  if v_row.status = 'open' then
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
revoke all on function private.review_alert(uuid, text, boolean, text) from public;
grant execute on function private.review_alert(uuid, text, boolean, text) to app_service;

-- ---------------------------------------------------------------------------------------
-- La detección (05 §8.2, paso 7).

-- La velocidad máxima de un periodo: la que rige desde ese periodo, como los umbrales de los puntos
-- (afecta al reparto). Lanza si falta o no es un número positivo: no se adivina.
create function private.max_speed(p_period public.period_id) returns numeric
language plpgsql stable set search_path = ''
as $$
declare
  v_value text;
begin
  select b.value #>> '{}' into v_value from public.business_parameters b
  where b.key = 'VELOCIDAD_MAX' and b.canceled_at is null and b.effective_period_id <= p_period
  order by b.effective_period_id desc, b.effective_from desc limit 1;
  if v_value is null or v_value !~ '^[0-9]+(\.[0-9]+)?$' or v_value::numeric <= 0 then
    raise exception 'VELOCIDAD_MAX is not set for period %', p_period using errcode = 'P0001';
  end if;
  return v_value::numeric;
end
$$;
revoke all on function private.max_speed(public.period_id) from public;

-- Detecta las alertas de un periodo de la ventana a la hora `p_now`, y abre las que falten (una
-- sola vez por periodo, tipo y sujeto: una revisada no se reabre aunque empeore). Corre como el
-- sistema (la auditoría lo exige; el guardián exige además que escriba el dueño), y deja el ajuste
-- como estaba. Devuelve {alerts_opened}.
--   · Lecciones imposibles (red de seguridad, para cada periodo): las lecciones que una cuenta
--     terminó en el periodo (el consolidado con 2 medios puntos, ya sin lo excluido), con sus
--     segundos cubiertos a `VELOCIDAD_MAX`, piden más tiempo que el que pasó desde el inicio del
--     periodo en `ZONA_HORARIA_PERIODO` hasta `p_now` (o el fin del periodo). Con
--     `SESIONES_SIMULTANEAS` en 1 y el reloj de T-205 no debería pasar nunca: si pasa, es un error
--     o alguien se saltó el reloj.
--   · Salto de puntos (solo el mes anterior terminado, el más viejo de la ventana): un maestro
--     cuyos medios puntos del mes subieron más de `ALERTA_SALTO_MAESTRO_PCT` sobre los del mes que le
--     precede, si en ese mes tenía al menos `ALERTA_SALTO_MINIMO_MEDIOS_PUNTOS` (un maestro nuevo o
--     pequeño no dispara con cualquier subida). Los dos umbrales no afectan al reparto: se leen al
--     detectar y quedan en la alerta.
-- Lanza si falta un parámetro: la corrida lo anota y termina fallida.
create function private.detect_anomalies(p_period public.period_id, p_now timestamptz default pg_catalog.now())
returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_kind text := pg_catalog.current_setting('app.actor_kind', true);
  v_window public.period_id[] := array(select private.rollup_window());
  v_zone text := private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}';
  v_month timestamp := pg_catalog.to_date(p_period::text || '01', 'YYYYMMDD')::timestamp;
  v_start timestamptz;
  v_end timestamptz;
  v_elapsed numeric;
  v_speed numeric;
  v_bps text;
  v_floor text;
  v_previous public.period_id;
  v_count integer;
  v_opened integer := 0;
begin
  if v_zone is null then
    raise exception 'ZONA_HORARIA_PERIODO is not set' using errcode = 'P0001';
  end if;
  if not p_period = any (v_window) then
    return pg_catalog.jsonb_build_object('alerts_opened', 0);
  end if;
  perform pg_catalog.set_config('app.actor_kind', 'system', true);

  v_start := pg_catalog.timezone(v_zone, v_month);
  v_end := pg_catalog.timezone(v_zone, v_month + interval '1 month');
  v_elapsed := extract(epoch from (least(p_now, v_end) - v_start));
  -- Los parámetros se leen solo si hay algo que evaluar: un periodo sin consumo (el anterior al
  -- arranque, que no tiene parámetros) no los necesita.
  if v_elapsed > 0 and exists (select 1 from public.watch_rollup w where w.period_id = p_period and w.half_points = 2) then
    v_speed := private.max_speed(p_period);
    insert into public.anomaly_alerts (period_id, kind, profile_id, metric_value, threshold_value, details)
    select p_period, 'impossible_completion', c.profile_id, pg_catalog.round(c.seconds / v_speed, 3), v_elapsed,
           pg_catalog.jsonb_build_object('lessons', c.lessons, 'covered_seconds', c.seconds, 'speed', v_speed,
                                         'from', v_start, 'until', least(p_now, v_end))
    from (select w.profile_id, pg_catalog.count(*) as lessons, pg_catalog.sum(w.covered_seconds) as seconds
          from public.watch_rollup w where w.period_id = p_period and w.half_points = 2
          group by w.profile_id) c
    where c.seconds / v_speed > v_elapsed
    on conflict do nothing;
    get diagnostics v_count = row_count;
    v_opened := v_opened + v_count;
  end if;

  v_previous := pg_catalog.to_char(v_month - interval '1 month', 'YYYYMM')::integer;
  if p_period = (select pg_catalog.min(p) from pg_catalog.unnest(v_window) as p)
     and exists (select 1 from public.watch_rollup w where w.period_id = v_previous)
     and exists (select 1 from public.watch_rollup w where w.period_id = p_period) then
    v_bps := private.parameter_value('ALERTA_SALTO_MAESTRO_PCT', p_now) #>> '{}';
    v_floor := private.parameter_value('ALERTA_SALTO_MINIMO_MEDIOS_PUNTOS', p_now) #>> '{}';
    if v_bps is null or v_bps !~ '^[1-9][0-9]{0,6}$' or v_floor is null or v_floor !~ '^[0-9]{1,9}$' then
      raise exception 'teacher points jump thresholds are not set' using errcode = 'P0001';
    end if;
    insert into public.anomaly_alerts (period_id, kind, teacher_id, metric_value, threshold_value, details)
    select p_period, 'teacher_points_jump', a.teacher_id, pg_catalog.round((a.points - b.points) * 10000.0 / b.points, 3),
           v_bps::integer,
           pg_catalog.jsonb_build_object('before', b.points, 'after', a.points, 'students_before', b.students,
                                         'students_after', a.students, 'floor', v_floor::integer)
    from (select w.teacher_id, pg_catalog.sum(w.half_points) as points, pg_catalog.count(distinct w.profile_id) as students
          from public.watch_rollup w where w.period_id = p_period group by w.teacher_id) a
    join (select w.teacher_id, pg_catalog.sum(w.half_points) as points, pg_catalog.count(distinct w.profile_id) as students
          from public.watch_rollup w where w.period_id = v_previous group by w.teacher_id) b on b.teacher_id = a.teacher_id
    where b.points > 0 and b.points >= v_floor::integer
      and (a.points - b.points) * 10000 > v_bps::bigint * b.points
    on conflict do nothing;
    get diagnostics v_count = row_count;
    v_opened := v_opened + v_count;
  end if;

  perform pg_catalog.set_config('app.actor_kind', coalesce(v_kind, ''), true);
  return pg_catalog.jsonb_build_object('alerts_opened', v_opened);
end
$$;
revoke all on function private.detect_anomalies(public.period_id, timestamptz) from public;

-- La corrida de cada noche, con la detección (paso 7): al final de cada periodo de la ventana que
-- terminó sin error, en su propio bloque. Lo que abrió, o por qué falló, queda en la corrida
-- (`alerts_opened` o `anomalies_failed`), y si falló, la corrida termina fallida: hasta producción
-- es la única señal. Lo demás no cambia (T-207).
create or replace procedure private.nightly_rollup(p_full boolean default false, p_period integer default null)
language plpgsql
as $$
declare
  v_start timestamptz := pg_catalog.clock_timestamp();
  v_path text := pg_catalog.current_setting('search_path');
  v_window integer[];
  v_periods integer[];
  v_period integer;
  v_run uuid;
  v_step jsonb;
  v_error text;
  v_anomalies jsonb;
  v_after_profile uuid;
  v_after_lesson uuid;
begin
  v_window := array(select private.rollup_window());
  v_periods := v_window;
  if p_period is not null then
    if not p_period = any (v_periods) then
      raise exception 'period % no longer receives heartbeats', p_period using errcode = '22023';
    end if;
    v_periods := array[p_period];
  elsif not p_full then
    v_periods := array(select p from (select pg_catalog.unnest(v_periods) as p
                                      union select d.period_id from private.rollup_dirty d) s order by p);
  end if;
  -- De la sesión y no de la transacción: un ajuste local se iría con el primer `commit`. Se
  -- devuelve al terminar; si algo lanza a la mitad, la sesión se queda sin él (pg_cron y
  -- `db:rollup` cierran la conexión).
  perform pg_catalog.set_config('search_path', '', false);

  foreach v_period in array v_periods loop
    v_run := private.open_job_run('nightly_rollup', v_period, case when p_full then 'full' else 'dirty' end);
    commit;
    continue when v_run is null;
    v_error := null;
    v_anomalies := null;
    v_after_profile := null;
    v_after_lesson := null;
    loop
      begin
        v_step := private.rollup_step(v_run, v_start, v_after_profile, v_after_lesson);
      exception when others then
        v_error := sqlstate || ': ' || pg_catalog.left(sqlerrm, 200);
      end;
      commit;
      exit when v_error is not null or (v_step ->> 'read')::integer = 0;
      v_after_profile := (v_step ->> 'last_profile')::uuid;
      v_after_lesson := (v_step ->> 'last_lesson')::uuid;
    end loop;
    if v_error is null and v_period = any (v_window) then
      begin
        v_anomalies := private.detect_anomalies(v_period, pg_catalog.clock_timestamp());
      exception when others then
        v_anomalies := pg_catalog.jsonb_build_object('anomalies_failed', sqlstate || ': ' || pg_catalog.left(sqlerrm, 200));
      end;
      update public.job_runs j set details = j.details || v_anomalies where j.id = v_run;
      commit;
    end if;
    perform private.close_job_run(v_run, coalesce(v_error,
      case when v_anomalies ? 'anomalies_failed' then 'anomalies failed: ' || (v_anomalies ->> 'anomalies_failed') end));
    commit;
  end loop;
  perform pg_catalog.set_config('search_path', v_path, false);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Una cuenta suspendida por fraude (RN-08). La marca ya no la escribe el servidor: la prende solo
-- una decisión de fraude de finanzas sobre esa cuenta, con la función que llega con T-307 (que
-- suspende cuentas); PA-71 no la decide (RN-17). Cambiarla, en cualquier sentido, marca todos los
-- pares de la cuenta en los periodos que todavía reciben latidos: la corrida siguiente la aplica.

revoke update (suspended_for_fraud) on public.profiles from app_service;

create function private.mark_fraud_suspension() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_period public.period_id;
begin
  for v_period in select private.rollup_window() loop
    perform private.mark_pairs_for(new.id, v_period, null, null);
  end loop;
  return null;
end
$$;
revoke all on function private.mark_fraud_suspension() from public;

create trigger mark_fraud_suspension after update of suspended_for_fraud on public.profiles
  for each row when (old.suspended_for_fraud is distinct from new.suspended_for_fraud)
  execute function private.mark_fraud_suspension();

-- ---------------------------------------------------------------------------------------
-- El piso del salto de puntos (00 §4, RF-406). Su valor de arranque va en la semilla.

insert into public.parameter_definitions (key, description, value_type, unit, group_name, affects_payout) values
  ('ALERTA_SALTO_MINIMO_MEDIOS_PUNTOS', 'Medios puntos que un maestro debe tener en el mes de comparación para vigilar su salto',
   'integer', 'medios puntos', 'measurement', false);

-- ---------------------------------------------------------------------------------------
-- El vigilante: un área nueva, sin tocar las demás.

create function private.schema_violations_anomalies()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service'))
  -- Las alertas y las exclusiones no las toca ningún rol de la aplicación, ni para leer: el
  -- servidor llega por las funciones de finanzas (T-208).
  select 'anomalies table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.anomaly_alerts'), ('public.consumption_exclusions')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Lo que corre solo el dueño de la base: detectar, marcar pares y leer la velocidad del periodo.
  select 'system function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.detect_anomalies(public.period_id, timestamptz)'),
                     ('private.mark_pairs_for(uuid, public.period_id, uuid, uuid)'),
                     ('private.max_speed(public.period_id)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
  union all
  -- Las decisiones de finanzas las llama solo el servidor, a nombre de quien pasa la puerta.
  select 'finance function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.exclude_consumption(public.exclusion_scope, public.period_id, uuid, uuid, uuid, integer, integer, text, text, uuid)'),
                     ('private.revoke_exclusion(uuid, text)'),
                     ('private.review_alert(uuid, text, boolean, text)')) as f (signature)
  where r.rolname <> 'app_service'
    and pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
  union all
  -- La marca de fraude de una cuenta la prende solo una decisión de finanzas (RN-17).
  select 'suspended_for_fraud writable by ' || r.rolname, 'public.profiles'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.profiles'::regclass, 'suspended_for_fraud', 'UPDATE')
$$;
revoke all on function private.schema_violations_anomalies() from public;
