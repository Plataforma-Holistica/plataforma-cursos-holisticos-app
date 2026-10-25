-- T-601 · Los periodos (RF-501, RN-13; 05 §5.10, §7.3, §8.1 y §8.3). Primera de dos solicitudes: los
-- periodos y sus estados; los tramos del bote van en la segunda. Decisiones de Sergio del 2026-10-23:
--   · el mes M pasa a «en cierre» el día `DIA_CIERRE` (3) de M+1, en la corrida de esa noche: hasta
--     entonces entran sus latidos atrasados y sus cobros; cerrarlo es de finanzas (T-602);
--   · un cobro que llega cuando su mes ya cerró va al primer periodo abierto, con registro;
--   · todo en la base, con `pg_cron` (T-207), y el reparto también (T-407).
--
-- La migración no escribe filas: la zona de los periodos llega con la semilla, después. Un mes sin
-- fila toma su estado del reloj (`private.period_status_of()`): abierto hasta su día de cierre y en
-- cierre después (así llega solo un mes de antes del arranque: nadie lo cierra). Cerrado y pagado
-- solo existen con fila. Las filas las abren el paso a cierre de cada noche (el mes en curso y los
-- dos siguientes) y el primer cobro de un mes.
--
-- Lo que cambia respecto del esquema escrito (05):
--   · `payout_periods` nace solo con lo de T-601 (instantes, zona, estado, la hora de en cierre, los
--     alumnos activos y lo arrastrado); las cifras del cierre las agrega T-602 con sus restricciones,
--     y el guardián solo deja pasar de abierto a en cierre hasta entonces;
--   · `charges.period_id` sigue siendo el mes del cobro, sin clave foránea (un cobro de un mes de antes
--     del arranque no tiene fila), y una columna nueva, `allocation_start_period_id`, dice en qué
--     periodo empiezan sus partes, con su clave foránea: es otro si el cobro es tardío (05 §17.3
--     decía que se rechazaba);
--   · `revenue_allocations.period_id` sigue sin clave foránea: una parte puede caer en un periodo
--     futuro, que todavía no tiene fila;
--   · el congelado de lo cerrado (no entra un cobro, una parte, una alerta ni una exclusión, ni se
--     revierte una) está desde ya, aunque nada cierre todavía; congelar `watch_rollup`, sellar y
--     purgar las particiones, y las claves foráneas de `watch_rollup`, `anomaly_alerts` y
--     `consumption_exclusions` a los periodos, llegan con T-602;
--   · la ventana de la consolidación crece: además del mes anterior y el en curso por reloj, los
--     periodos abiertos o en cierre que ya empezaron, sin los cerrados ni los pagados. Todo lo que la
--     lee (las exclusiones, revertirlas, la suspensión por fraude, la lectura de alertas,
--     `close_job_run`, `pnpm db:rollup`) sigue igual y gana que un periodo en cierre se pueda corregir.

-- ---------------------------------------------------------------------------------------
-- La tabla.

create type public.period_status as enum ('open', 'closing', 'closed', 'paid');

create table public.payout_periods (
  period_id public.period_id primary key,
  starts_at timestamptz not null,             -- primer instante del mes en su zona
  ends_at timestamptz not null,               -- primer instante del mes siguiente
  timezone text not null,                     -- ZONA_HORARIA_PERIODO al abrirlo
  status public.period_status not null default 'open',
  entered_closing_at timestamptz,             -- la pone la base al pasar a en cierre
  active_students integer,                    -- al último instante del periodo (RN-13): la segunda solicitud
  carried_in_cents bigint not null default 0, -- bote recibido del periodo anterior (RN-06): lo escribe T-602
  created_at timestamptz not null default now(),
  constraint payout_periods_order check (ends_at > starts_at),
  constraint payout_periods_closing_consistent check ((status = 'open') = (entered_closing_at is null)),
  constraint payout_periods_active_students_positive check (active_students >= 0),
  constraint payout_periods_carried_in_positive check (carried_in_cents >= 0),
  -- Dos periodos no se enciman, aunque tengan zonas distintas.
  constraint payout_periods_no_overlap exclude using gist (pg_catalog.tstzrange(starts_at, ends_at) with operator(pg_catalog.&&))
);
comment on table public.payout_periods is 'Los periodos de pago y su estado (RF-501, T-601). Un mes sin fila toma su estado del reloj; no se borra ninguno.';
alter table public.payout_periods enable row level security;
revoke all on public.payout_periods from public, anon, authenticated, service_role, app_service;

-- Los instantes de un mes en una zona.
create function private.month_bounds(p_period public.period_id, p_zone text, out starts_at timestamptz, out ends_at timestamptz)
language sql stable set search_path = ''
as $$
  select pg_catalog.timezone(p_zone, m.local_start), pg_catalog.timezone(p_zone, m.local_start + interval '1 month')
  from (select pg_catalog.to_date(p_period::text || '01', 'YYYYMMDD')::timestamp as local_start) m
$$;
revoke all on function private.month_bounds(public.period_id, text) from public;

-- La zona de los periodos de ahora. Sin ella no se adivina.
create function private.period_zone() returns text
language plpgsql stable set search_path = ''
as $$
declare
  v_zone text := private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}';
begin
  if v_zone is null then
    raise exception 'ZONA_HORARIA_PERIODO is not set' using errcode = 'P0001';
  end if;
  return v_zone;
end
$$;
revoke all on function private.period_zone() from public;

-- Los instantes y la zona de un periodo: los de su fila; sin fila, los de su mes en la zona de ahora.
create function private.period_bounds(p_period public.period_id, out starts_at timestamptz, out ends_at timestamptz, out timezone text)
language plpgsql stable set search_path = ''
as $$
begin
  select p.starts_at, p.ends_at, p.timezone into starts_at, ends_at, timezone
  from public.payout_periods p where p.period_id = p_period;
  if not found then
    timezone := private.period_zone();
    select b.starts_at, b.ends_at into starts_at, ends_at from private.month_bounds(p_period, timezone) b;
  end if;
end
$$;
revoke all on function private.period_bounds(public.period_id) from public;

-- Desde cuándo un mes pasa a en cierre: las 00:00 del día `DIA_CIERRE` del mes siguiente, en la zona
-- del periodo (los días se suman en hora local). El día es el que rige al terminar el mes, del 1 al
-- 28: el 29 no lo tienen todos los meses. Sin él no se adivina.
create function private.period_closing_at(p_period public.period_id) returns timestamptz
language plpgsql stable set search_path = ''
as $$
declare
  v_bounds record;
  v_day jsonb;
begin
  select * into v_bounds from private.period_bounds(p_period) b;
  v_day := private.parameter_value('DIA_CIERRE', v_bounds.ends_at);
  if v_day is null or (v_day)::text !~ '^[0-9]{1,2}$'
     or (v_day)::text::integer not between 1 and 28 then
    raise exception 'DIA_CIERRE is not a day from 1 to 28 for period %', p_period using errcode = 'P0001';
  end if;
  return pg_catalog.timezone(v_bounds.timezone,
    pg_catalog.timezone(v_bounds.timezone, v_bounds.ends_at) + pg_catalog.make_interval(days => (v_day)::text::integer - 1));
end
$$;
revoke all on function private.period_closing_at(public.period_id) from public;

-- Si un mes ya llegó a su día de cierre. Pasados 27 días de su fin ya llegó con cualquier día que
-- valga, sin leerlo: un mes de antes del arranque no tiene el parámetro.
create function private.period_reached_closing(p_period public.period_id) returns boolean
language plpgsql stable set search_path = ''
as $$
declare
  v_bounds record;
begin
  select * into v_bounds from private.period_bounds(p_period) b;
  if pg_catalog.now() < v_bounds.ends_at then
    return false;
  end if;
  if pg_catalog.now() >= pg_catalog.timezone(v_bounds.timezone,
                           pg_catalog.timezone(v_bounds.timezone, v_bounds.ends_at) + interval '27 days') then
    return true;
  end if;
  return pg_catalog.now() >= private.period_closing_at(p_period);
end
$$;
revoke all on function private.period_reached_closing(public.period_id) from public;

-- El estado de un periodo: el de su fila; sin fila, del reloj (abierto hasta su día de cierre).
create function private.period_status_of(p_period public.period_id) returns public.period_status
language plpgsql stable set search_path = ''
as $$
declare
  v_status public.period_status;
begin
  select p.status into v_status from public.payout_periods p where p.period_id = p_period;
  if found then
    return v_status;
  end if;
  return case when private.period_reached_closing(p_period) then 'closing' else 'open' end::public.period_status;
end
$$;
revoke all on function private.period_status_of(public.period_id) from public;

-- El periodo de un instante: el de la fila que lo contiene; sin fila, el mes en la zona de ahora
-- (como el latido y la consolidación). Una sola verdad de dónde empieza un mes.
create or replace function private.period_of(p_at timestamptz) returns public.period_id
language plpgsql stable set search_path = ''
as $$
declare
  v_period public.period_id;
begin
  select p.period_id into v_period from public.payout_periods p where p.starts_at <= p_at and p.ends_at > p_at;
  if found then
    return v_period;
  end if;
  return pg_catalog.to_char(pg_catalog.timezone(private.period_zone(), p_at), 'YYYYMM')::integer;
end
$$;

-- Abre la fila de un periodo, con los instantes de su mes en la zona de ahora y el estado que le da
-- el reloj. Devuelve si la abrió. Sin quien actúe, la abre el sistema (la auditoría pide autor).
create function private.open_period(p_period public.period_id) returns boolean
language plpgsql volatile set search_path = ''
as $$
declare
  v_kind text := pg_catalog.current_setting('app.actor_kind', true);
  v_zone text;
  v_bounds record;
  v_created boolean;
begin
  if exists (select 1 from public.payout_periods p where p.period_id = p_period) then
    return false;
  end if;
  v_zone := private.period_zone();
  select * into v_bounds from private.month_bounds(p_period, v_zone) b;
  if private.actor_id() is null then
    perform pg_catalog.set_config('app.actor_kind', 'system', true);
  end if;
  insert into public.payout_periods (period_id, starts_at, ends_at, timezone, status)
  values (p_period, v_bounds.starts_at, v_bounds.ends_at, v_zone, private.period_status_of(p_period))
  on conflict (period_id) do nothing;
  v_created := found;
  perform pg_catalog.set_config('app.actor_kind', coalesce(v_kind, ''), true);
  return v_created;
end
$$;
revoke all on function private.open_period(public.period_id) from public;

-- El guardián. Al insertar: los instantes de su mes en una zona con nombre de lugar, abierto o en
-- cierre, sin cifras. Después solo avanza el estado, de abierto a en cierre por ahora (cerrar y pagar
-- llegan con T-602). En cierre solo un mes que ya llegó a su día: un error aquí taparía los latidos.
-- La hora de en cierre la pone la base. No se borra ni se vacía. Que dos periodos no se encimen (solo
-- puede pasar si cambió la zona) lo cuida la restricción de exclusión de la tabla. Escribe solo el
-- dueño: nadie de la aplicación tiene privilegios sobre la tabla.
create function private.guard_payout_period() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_bounds record;
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception '%.%: periods are not deleted', tg_table_schema, tg_table_name using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.timezone is null or new.timezone !~ '^(UTC|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2})$' then
      raise exception '%.%: period % needs a named time zone', tg_table_schema, tg_table_name, new.period_id using errcode = '23514';
    end if;
    begin
      perform pg_catalog.timezone(new.timezone, pg_catalog.now());
    exception when others then
      raise exception '%.%: unknown time zone %', tg_table_schema, tg_table_name, new.timezone using errcode = '23514';
    end;
    select * into v_bounds from private.month_bounds(new.period_id, new.timezone) b;
    if new.starts_at is distinct from v_bounds.starts_at or new.ends_at is distinct from v_bounds.ends_at then
      raise exception '%.%: period % needs the instants of its month in %', tg_table_schema, tg_table_name, new.period_id, new.timezone
        using errcode = '23514';
    end if;
    if new.status not in ('open', 'closing') or new.carried_in_cents <> 0 or new.active_students is not null then
      raise exception '%.%: period % starts open or closing, without figures', tg_table_schema, tg_table_name, new.period_id
        using errcode = '23514';
    end if;
    if new.status = 'closing' and not private.period_reached_closing(new.period_id) then
      raise exception '%.%: period % has not reached its closing day', tg_table_schema, tg_table_name, new.period_id
        using errcode = '23514';
    end if;
    new.entered_closing_at := case when new.status = 'closing' then pg_catalog.now() end;
    new.created_at := pg_catalog.now();
    return new;
  end if;

  if (pg_catalog.to_jsonb(new) - array['status', 'entered_closing_at'])
     is distinct from (pg_catalog.to_jsonb(old) - array['status', 'entered_closing_at']) then
    raise exception '%.%: only the status of period % changes', tg_table_schema, tg_table_name, old.period_id using errcode = '23514';
  end if;
  if new.status = old.status then
    if new.entered_closing_at is distinct from old.entered_closing_at then
      raise exception '%.%: the closing time of period % does not change', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    return new;
  end if;
  if not (old.status = 'open' and new.status = 'closing') then
    raise exception '%.%: period % goes only from open to closing (closing it comes with T-602)', tg_table_schema, tg_table_name,
      old.period_id using errcode = '23514';
  end if;
  if not private.period_reached_closing(old.period_id) then
    raise exception '%.%: period % has not reached its closing day', tg_table_schema, tg_table_name, old.period_id
      using errcode = '23514';
  end if;
  new.entered_closing_at := pg_catalog.now();
  return new;
end
$$;
revoke all on function private.guard_payout_period() from public;

create trigger payout_periods_guard before insert or update or delete on public.payout_periods
  for each row execute function private.guard_payout_period();
create trigger payout_periods_no_truncate before truncate on public.payout_periods
  for each statement execute function private.guard_payout_period();
-- Cada periodo que se abre y cada cambio de estado: dinero.
create trigger audit_changes after insert or update on public.payout_periods
  for each row execute function private.audit_row_change('money');

-- ---------------------------------------------------------------------------------------
-- La ventana: lo que se consolida cada noche.

-- Los periodos que se consolidan: el anterior y el en curso por reloj, en la zona de los periodos
-- (como hasta T-601), más los abiertos o en cierre que ya empezaron (uno en cierre se sigue
-- pudiendo corregir hasta que finanzas lo cierre), menos los cerrados y los pagados. En orden.
create or replace function private.rollup_window() returns setof public.period_id
language sql stable set search_path = ''
as $$
  select w.period_id
  from (select private.period_plus(private.period_of(pg_catalog.now()), -1) as period_id
        union select private.period_of(pg_catalog.now())
        union select p.period_id from public.payout_periods p
              where p.status in ('open', 'closing') and p.starts_at <= pg_catalog.now()) w
  where not exists (select 1 from public.payout_periods c where c.period_id = w.period_id and c.status in ('closed', 'paid'))
  order by w.period_id
$$;

-- ---------------------------------------------------------------------------------------
-- El paso a cierre.

insert into public.job_definitions (job, description, schedule, expected_every, alert_after) values
  ('period_transition', 'Paso de los periodos a en cierre, al final de la consolidación nocturna', '0 9 * * *',
   interval '1 day', interval '150 minutes');

update public.parameter_definitions set description = 'Día del mes siguiente en que el mes pasa a en cierre'
where key = 'DIA_CIERRE';

-- Lo llama la corrida de cada noche al terminar (`private.nightly_rollup()`), con los periodos que
-- consolidó sin error de paso (las anomalías no frenan el cierre). Pasa a en cierre cada periodo
-- abierto que ya llegó a su día de cierre, si se consolidó; el que llegó y no se consolidó se queda
-- abierto (`held_open`) hasta la noche siguiente. Después abre las filas del mes en curso y los dos
-- siguientes, cada una en su propio bloque: si una no se puede abrir (`open_failed`), el paso a
-- cierre ya quedó y la corrida termina fallida. Como el sistema: lo que cambia queda en la auditoría.
-- Devuelve {entered_closing, held_open, opened} y, si falló alguna, `open_failed`.
create function private.period_transition(p_consolidated public.period_id[]) returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_kind text := pg_catalog.current_setting('app.actor_kind', true);
  v_current public.period_id;
  v_month integer;
  v_opened integer[] := '{}';
  v_due integer[];
  v_closing integer[];
  v_failed jsonb := '{}'::jsonb;
begin
  perform pg_catalog.set_config('app.actor_kind', 'system', true);
  v_due := array(select p.period_id from public.payout_periods p
                 where p.status = 'open' and private.period_reached_closing(p.period_id) order by 1);
  with moved as (
    update public.payout_periods p set status = 'closing'
    where p.status = 'open' and p.period_id = any (v_due) and p.period_id = any (p_consolidated)
    returning p.period_id)
  select coalesce(pg_catalog.array_agg(m.period_id order by m.period_id), '{}') into v_closing from moved m;

  v_current := private.period_of(pg_catalog.now());
  foreach v_month in array array[v_current, private.period_plus(v_current, 1), private.period_plus(v_current, 2)] loop
    begin
      if private.open_period(v_month) then
        v_opened := v_opened || v_month;
      end if;
    exception when others then
      v_failed := v_failed || pg_catalog.jsonb_build_object(v_month::text, sqlstate || ': ' || pg_catalog.left(sqlerrm, 200));
    end;
  end loop;

  perform pg_catalog.set_config('app.actor_kind', coalesce(v_kind, ''), true);
  return pg_catalog.jsonb_build_object(
    'entered_closing', pg_catalog.to_jsonb(v_closing),
    'held_open', pg_catalog.to_jsonb(array(select d from pg_catalog.unnest(v_due) d where not d = any (v_closing) order by 1)),
    'opened', pg_catalog.to_jsonb(v_opened))
    || case when v_failed = '{}'::jsonb then '{}'::jsonb else pg_catalog.jsonb_build_object('open_failed', v_failed) end;
end
$$;
revoke all on function private.period_transition(public.period_id[]) from public;

-- La corrida de cada noche (T-207, con la detección de T-208), con lo de T-601: no consolida un
-- periodo con marcas que ya está cerrado o pagado, y al terminar llama al paso a cierre con los
-- periodos que consolidó sin error de paso. El paso es su propia corrida (`period_transition`), con
-- lo que hizo o por qué falló. Con `p_period` no corre: es un recálculo a mano de un solo periodo.
-- Lo demás no cambia.
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
  v_consolidated integer[] := '{}';
  v_transition jsonb;
  v_transition_start timestamptz;
begin
  v_window := array(select private.rollup_window());
  v_periods := v_window;
  if p_period is not null then
    if not p_period = any (v_periods) then
      raise exception 'period % is not in the consolidation window', p_period using errcode = '22023';
    end if;
    v_periods := array[p_period];
  elsif not p_full then
    v_periods := array(select p from (select pg_catalog.unnest(v_periods) as p
                                      union select d.period_id from private.rollup_dirty d) s
                       where not exists (select 1 from public.payout_periods c
                                         where c.period_id = s.p and c.status in ('closed', 'paid'))
                       order by p);
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
    if v_error is null then
      v_consolidated := v_consolidated || v_period;
    end if;
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

  if p_period is null then
    v_transition_start := pg_catalog.clock_timestamp();
    v_error := null;
    v_transition := null;
    begin
      v_transition := private.period_transition(v_consolidated);
    exception when others then
      v_error := sqlstate || ': ' || pg_catalog.left(sqlerrm, 200);
    end;
    if v_transition ? 'open_failed' then
      v_error := 'open failed: ' || pg_catalog.left((v_transition -> 'open_failed')::text, 250);
    end if;
    insert into public.job_runs (job, status, started_at, heartbeat_at, finished_at, details, error)
    values ('period_transition', case when v_error is null then 'succeeded' else 'failed' end::public.run_status,
            v_transition_start, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
            coalesce(v_transition, '{}'::jsonb), v_error);
    commit;
  end if;
  perform pg_catalog.set_config('search_path', v_path, false);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Los latidos: solo un periodo abierto los recibe. Lo demás no cambia (T-205 a T-207).

create or replace function private.record_heartbeats(p_session uuid, p_events jsonb, p_access_counts boolean, p_at timestamptz)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_auth uuid := private.actor_session();
  v_row public.playback_sessions%rowtype;
  v_window interval;
  v_top timestamptz;
  v_max_rate numeric;
  v_zone text;
  v_period integer;
  v_elapsed numeric;
  v_budget numeric;
  v_media integer := 0;
  v_seen int4multirange;
  v_item record;
  v_event jsonb;
  v_seq integer;
  v_from integer;
  v_to integer;
  v_rate numeric;
  v_visible boolean;
  v_qualifies boolean;
  v_counts boolean;
  v_reason text;
  v_inserted integer;
  v_accepted integer[] := '{}';
  v_duplicate integer[] := '{}';
  v_rejected jsonb := '[]';
  v_out_of_range integer := 0;
  v_too_fast integer := 0;
  v_spans int4multirange;
  v_last_seq integer;
  v_last_to integer;
  v_progress jsonb;
  v_counted boolean := false;
  v_practice integer := 0;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.record_heartbeats() needs read committed isolation' using errcode = '25000';
  end if;
  if v_actor is null or v_auth is null then
    return null;
  end if;
  -- El candado de la cuenta, como la presencia: los lotes de una cuenta, de uno en uno.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('playback:' || v_actor::text, 0));

  -- Todo lo que sigue se deshace solo, sin tocar lo que ya hizo la transacción (la presencia).
  begin
    if p_events is null or pg_catalog.jsonb_typeof(p_events) <> 'array' or pg_catalog.jsonb_array_length(p_events) > 50 then
      return pg_catalog.jsonb_build_object('outcome', 'failed', 'code', 'batch_shape');
    end if;

    v_window := pg_catalog.make_interval(secs => 3 * (private.playback_limits()).heartbeat_seconds);
    select * into v_row from public.playback_sessions s
    where s.id = p_session and s.profile_id = v_actor
      and (s.auth_session_id = v_auth or s.revoked_at is not null
           or not exists (select 1 from private.app_sessions a where a.session_id = s.auth_session_id))
    for update;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;

    v_max_rate := (private.parameter_value('VELOCIDAD_MAX') #>> '{}')::numeric;
    v_zone := private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}';
    if v_max_rate is null or v_max_rate <= 0 or v_zone is null then
      raise exception 'VELOCIDAD_MAX or ZONA_HORARIA_PERIODO is not set' using errcode = 'P0001';
    end if;

    v_top := least(pg_catalog.now(), v_row.revoked_at, v_row.last_heartbeat_at + v_window);
    if v_top is distinct from p_at then
      return pg_catalog.jsonb_build_object('outcome', 'failed', 'code', 'clock_moved');
    end if;
    -- El periodo del tope, y solo uno abierto recibe latidos (T-601): en cierre, cerrado o pagado
    -- contesta como antes un mes viejo. Sin candado sobre la fila, que es muy concurrida: un lote que
    -- lee «abierto» justo antes del paso a cierre entra, y la consolidación lo cuenta.
    v_period := private.period_of(v_top);
    if private.period_status_of(v_period) <> 'open' then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    v_elapsed := v_row.live_seconds + greatest(extract(epoch from v_top - v_row.last_heartbeat_at), 0);
    v_budget := v_elapsed * v_max_rate + least(5, v_elapsed);
    v_seen := v_row.seqs_received;

    for v_item in
      select e.value as event
      from pg_catalog.jsonb_array_elements(p_events) with ordinality e
      order by case when pg_catalog.jsonb_typeof(e.value -> 'seq') = 'number' then (e.value ->> 'seq')::numeric end nulls last,
               e.ordinality
    loop
      v_event := v_item.event;
      v_reason := null;
      v_seq := null;

      -- La forma. Un número que no es entero no es un consecutivo ni un segundo.
      if pg_catalog.jsonb_typeof(v_event) <> 'object'
         or pg_catalog.jsonb_typeof(v_event -> 'seq') is distinct from 'number'
         or (v_event ->> 'seq') !~ '^[0-9]{1,7}$' or (v_event ->> 'seq')::integer > 1000000 then
        v_reason := 'out_of_range';
      else
        v_seq := (v_event ->> 'seq')::integer;
        if v_seen @> v_seq then
          v_duplicate := v_duplicate || v_seq;
          continue;
        end if;
        v_seen := v_seen + pg_catalog.int4multirange(pg_catalog.int4range(v_seq, v_seq + 1));

        if pg_catalog.jsonb_typeof(v_event -> 'from') is distinct from 'number'
           or pg_catalog.jsonb_typeof(v_event -> 'to') is distinct from 'number'
           or pg_catalog.jsonb_typeof(v_event -> 'rate') is distinct from 'number'
           or pg_catalog.jsonb_typeof(v_event -> 'visible') is distinct from 'boolean'
           or (v_event ->> 'from') !~ '^[0-9]{1,7}$' or (v_event ->> 'to') !~ '^[0-9]{1,7}$' then
          v_reason := 'out_of_range';
        else
          v_from := (v_event ->> 'from')::integer;
          v_to := (v_event ->> 'to')::integer;
          v_rate := pg_catalog.round((v_event ->> 'rate')::numeric, 2);
          v_visible := (v_event ->> 'visible')::boolean;
          if v_to > v_row.lesson_duration_seconds and v_to <= v_row.lesson_duration_seconds + 2 then
            v_to := v_row.lesson_duration_seconds;
          end if;
          if v_to <= v_from or v_to > v_row.lesson_duration_seconds or v_rate <= 0 or v_rate > 9.99 then
            v_reason := 'out_of_range';
          elsif v_media + (v_to - v_from) > v_budget - v_row.accepted_media_seconds then
            v_reason := 'faster_than_clock';
          end if;
        end if;
      end if;

      if v_reason is not null then
        v_rejected := v_rejected || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('seq', coalesce(pg_catalog.to_jsonb(v_seq), v_event -> 'seq'), 'reason', v_reason));
        if v_reason = 'out_of_range' then
          v_out_of_range := v_out_of_range + 1;
        else
          v_too_fast := v_too_fast + 1;
        end if;
        continue;
      end if;

      v_qualifies := v_visible and v_rate <= v_max_rate;
      v_counts := v_qualifies and v_row.counts_for_payout and coalesce(p_access_counts, false);
      insert into public.watch_events (
        period_id, playback_session_id, seq, profile_id, lesson_id, from_second, to_second,
        playback_rate, was_visible, qualifies, counts_for_payout)
      values (
        v_period, p_session, v_seq, v_row.profile_id, v_row.lesson_id, v_from, v_to,
        v_rate, v_visible, v_qualifies, v_counts)
      on conflict (period_id, playback_session_id, seq) do nothing;
      get diagnostics v_inserted = row_count;
      if v_inserted = 0 then
        -- Ya estaba, aunque `seqs_received` no lo dijera: la clave es la segunda defensa.
        v_duplicate := v_duplicate || v_seq;
      else
        v_accepted := v_accepted || v_seq;
        v_media := v_media + (v_to - v_from);
        -- Para la consolidación y los días de práctica (T-207).
        v_counted := v_counted or v_counts;
        if v_visible then
          v_practice := v_practice + (v_to - v_from);
        end if;
        -- Para el progreso (T-206): el último aceptado mueve la posición, sirva o no; solo lo que
        -- sirve se funde. El bucle va en orden de consecutivo: el último es el mayor.
        v_last_seq := v_seq;
        v_last_to := v_to;
        if v_qualifies then
          v_spans := coalesce(v_spans, '{}'::int4multirange) + pg_catalog.int4multirange(pg_catalog.int4range(v_from, v_to));
        end if;
      end if;
    end loop;

    update public.playback_sessions s
    set accepted_media_seconds = s.accepted_media_seconds + v_media,
        seqs_received = v_seen
    where s.id = p_session;

    if v_out_of_range > 0 or v_too_fast > 0 then
      insert into private.heartbeat_rejection_counts as h (day, profile_id, reason, rejections)
      select pg_catalog.timezone(v_zone, pg_catalog.now())::date, v_row.profile_id, r.reason, r.n
      from (values ('out_of_range', v_out_of_range), ('faster_than_clock', v_too_fast)) as r (reason, n)
      where r.n > 0
      on conflict (day, profile_id, reason) do update set rejections = h.rejections + excluded.rejections;
    end if;

    -- La marca del par para la consolidación (T-207), en el bloque del lote: si falla, el lote
    -- no entra y el navegador lo reintenta, porque perderla perdería consumo. La hora es la del
    -- reloj, no la de la transacción: la corrida borra una marca solo si sigue como la leyó, y un
    -- lote que llega mientras consolida su par tiene que cambiarla.
    if v_counted then
      insert into private.rollup_dirty (period_id, profile_id, lesson_id, touched_at)
      values (v_period, v_row.profile_id, v_row.lesson_id, pg_catalog.clock_timestamp())
      on conflict (period_id, profile_id, lesson_id) do update set touched_at = excluded.touched_at;
    end if;

    -- El día de práctica (T-207; decisión de Sergio del 2026-10-21): lo visible aceptado, a
    -- cualquier velocidad, en el día del tope. En su propio bloque: si falla, el lote se queda y
    -- esos segundos se pierden (aceptado), con un aviso en el registro de la base, sin datos de
    -- nadie. La vista previa del dueño no es práctica.
    if v_practice > 0 and v_row.access_basis <> 'owner_preview' then
      begin
        insert into public.practice_days as p (profile_id, day, seconds)
        values (v_row.profile_id, pg_catalog.timezone(v_zone, v_top)::date, v_practice)
        on conflict (profile_id, day) do update set seconds = p.seconds + excluded.seconds;
      exception when others then
        raise warning 'practice day not recorded (%)', sqlstate;
      end;
    end if;

    -- El progreso (T-206), en su propio bloque: si falla, el libro y lo demás se quedan, y el
    -- progreso se rehace después desde el libro (decisión de Sergio del 2026-10-20). La vista
    -- previa del dueño no deja progreso.
    if v_row.access_basis <> 'owner_preview' then
      begin
        v_progress := private.merge_progress(v_row, v_spans, v_last_seq, v_last_to, v_top);
      exception when others then
        v_progress := pg_catalog.jsonb_build_object('outcome', 'failed', 'code', sqlstate);
        insert into private.progress_rebuilds (profile_id, lesson_id, code)
        values (v_row.profile_id, v_row.lesson_id, sqlstate)
        on conflict (profile_id, lesson_id) do update set failed_at = excluded.failed_at, code = excluded.code;
      end;
    end if;

    return pg_catalog.jsonb_build_object('outcome', 'recorded', 'accepted', pg_catalog.to_jsonb(v_accepted),
                                         'duplicate', pg_catalog.to_jsonb(v_duplicate), 'rejected', v_rejected,
                                         'progress', v_progress);
  exception when others then
    return pg_catalog.jsonb_build_object('outcome', 'failed', 'code', sqlstate);
  end;
end
$$;

-- ---------------------------------------------------------------------------------------
-- Los cobros: el que llega tarde.

alter table public.charges add column allocation_start_period_id public.period_id not null;
comment on column public.charges.allocation_start_period_id is 'Dónde empiezan las partes del cobro: su mes, o el primer periodo abierto si llegó con su mes cerrado (T-601).';
alter table public.charges
  add constraint charges_allocation_start_not_before check (allocation_start_period_id >= period_id),
  add constraint charges_allocation_period_fk foreign key (allocation_start_period_id) references public.payout_periods (period_id);
alter table public.revenue_allocations
  drop constraint revenue_allocations_rule_known,
  add constraint revenue_allocations_rule_known check (rule in ('charge_date_v1', 'service_days_v1', 'late_charge_v1'));

-- Dónde empiezan las partes de un cobro de un mes. En su mes si está abierto o en cierre (si no
-- tiene fila y no es de antes de la ventana, la abre); si está cerrado o pagado, o es de antes de la
-- ventana sin fila, el cobro es tardío: en el primer periodo abierto después del suyo (si no hay
-- ninguno, el en curso, abriéndolo). Puede ser uno viejo que se quedó abierto porque no se consolidó. Deja la fila con candado compartido hasta el final de la transacción:
-- el paso a cierre espera a que el cobro se escriba. Uno que pasó a cierre entre leerlo y tomar el
-- candado ya no sirve para un tardío: se busca el siguiente.
create function private.allocation_start(p_period public.period_id) returns public.period_id
language plpgsql volatile set search_path = ''
as $$
declare
  v_status public.period_status;
  v_start public.period_id;
begin
  if p_period >= private.period_plus(private.period_of(pg_catalog.now()), -1) then
    perform private.open_period(p_period);
  end if;
  select p.status into v_status from public.payout_periods p where p.period_id = p_period for share;
  if v_status in ('open', 'closing') then
    return p_period;
  end if;
  for i in 1..3 loop
    select p.period_id into v_start from public.payout_periods p
    where p.status = 'open' and p.period_id > p_period order by p.period_id limit 1;
    if v_start is null then
      v_start := private.period_of(pg_catalog.now());
      perform private.open_period(v_start);
    end if;
    select p.status into v_status from public.payout_periods p where p.period_id = v_start for share;
    if v_status = 'open' then
      return v_start;
    end if;
    v_start := null;
  end loop;
  raise exception 'no open period for a late charge of period %', p_period using errcode = 'P0001';
end
$$;
revoke all on function private.allocation_start(public.period_id) from public;

-- Las partes de un cobro, al confirmar: como en T-301, desde donde empiezan (no desde su mes), y con
-- la regla del cobro tardío solo si lo es.
create or replace function private.check_revenue_parts() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_ok boolean;
begin
  select coalesce(sum(a.base_cents), 0) = c.revenue_net_mxn_cents
         and count(a.id) = case c.plan when 'monthly' then 1 else 12 end
         and bool_and(a.parts_total = case c.plan when 'monthly' then 1 else 12 end)
         and bool_and(a.period_id = private.period_plus(c.allocation_start_period_id, a.part_no - 1))
         and bool_and((a.rule = 'late_charge_v1') = (c.allocation_start_period_id <> c.period_id))
    into v_ok
  from public.charges c
  join public.revenue_allocations a on a.charge_id = c.id and a.kind = 'charge'
  where c.id = new.charge_id
  group by c.id, c.revenue_net_mxn_cents, c.plan, c.allocation_start_period_id, c.period_id;
  if v_ok is distinct from true then
    raise exception 'revenue parts of charge % do not match it', new.charge_id using errcode = '23514';
  end if;
  return null;
end
$$;

-- Registrar un cobro (T-301), con su periodo de inicio: un cobro tardío contesta además
-- `"late": true` y sus partes llevan la regla `late_charge_v1`; la tasa de IVA y la comisión son las
-- de su propio mes. Lo demás no cambia.
create or replace function private.record_charge(
  p_profile uuid, p_subscription uuid, p_provider text, p_provider_charge_id text, p_provider_invoice_id text,
  p_plan public.subscription_plan, p_charged_at timestamptz, p_currency text, p_gross_cents bigint,
  p_provider_fee_cents bigint, p_provider_net_cents bigint, p_payment_method text, p_country_code text,
  p_receipt_url text)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_found public.charges;
  v_period public.period_id;
  v_iva integer;
  v_fee integer;
  v_rule text;
  v_net_of_tax bigint;
  v_net bigint;
  v_start public.period_id;
begin
  -- Si dos llegan a la vez, la segunda espera a la primera y tiene que ver su cobro ya confirmado.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.record_charge() needs read committed isolation' using errcode = '25000';
  end if;

  if p_profile is null or p_subscription is null or p_plan is null or p_charged_at is null
     or p_provider is null or p_provider not in ('stripe', 'mercadopago', 'manual')
     or p_provider_charge_id is null or p_provider_charge_id !~ '^[!-~]{1,255}$'
     or p_provider_invoice_id !~ '^[!-~]{1,255}$'
     or p_currency is null or p_currency !~ '^[A-Z]{3}$'
     or p_gross_cents is null or p_gross_cents not between 1 and 1000000000
     or p_provider_fee_cents < 0 or p_provider_net_cents < 0
     or p_payment_method not in ('card', 'oxxo', 'bank_transfer', 'other')
     or p_country_code !~ '^[A-Z]{2}$'
     or p_receipt_url !~ '^https://' or length(p_receipt_url) > 2048
     or p_charged_at > pg_catalog.now() + interval '5 minutes'
     or p_charged_at < timestamptz '2020-01-01 00:00Z' then
    return jsonb_build_object('outcome', 'malformed', 'charge_id', null::uuid);
  end if;
  if p_currency <> 'MXN' then
    return jsonb_build_object('outcome', 'unsupported_currency', 'charge_id', null::uuid);
  end if;
  -- Con candado: que no cambie de cuenta ni de proveedor antes de escribir el cobro.
  perform 1 from public.subscriptions s
  where s.id = p_subscription and s.profile_id = p_profile and s.provider = p_provider
  for key share;
  if not found then
    return jsonb_build_object('outcome', 'not_found', 'charge_id', null::uuid);
  end if;

  select * into v_found from public.charges c
  where c.provider = p_provider and c.provider_charge_id = p_provider_charge_id;
  if not found then
    v_period := private.period_of(p_charged_at);
    select r.iva_bps, r.fee_bps, r.rule into v_iva, v_fee, v_rule from private.revenue_rule(v_period) r;
    select m.net_of_tax_cents, m.revenue_net_cents into v_net_of_tax, v_net from private.revenue_amounts(p_gross_cents, v_iva, v_fee) m;
    v_start := private.allocation_start(v_period);

    insert into public.charges (
      profile_id, subscription_id, provider, provider_charge_id, provider_invoice_id, plan, charged_at, period_id,
      allocation_start_period_id, currency, gross_cents, tax_cents, provider_fee_cents, provider_net_cents, fx_rate_to_mxn, fx_source,
      gross_mxn_cents, net_of_tax_mxn_cents, iva_bps, fee_bps, revenue_net_mxn_cents, payment_method, country_code,
      receipt_url)
    values (
      p_profile, p_subscription, p_provider, p_provider_charge_id, p_provider_invoice_id, p_plan, p_charged_at, v_period,
      v_start, p_currency, p_gross_cents, p_gross_cents - v_net_of_tax, p_provider_fee_cents, p_provider_net_cents, 1, 'same_currency',
      p_gross_cents, v_net_of_tax, v_iva, v_fee, v_net, p_payment_method, p_country_code, p_receipt_url)
    on conflict on constraint charges_provider_uq do nothing
    returning id into v_id;

    if v_id is not null then
      insert into public.revenue_allocations (charge_id, profile_id, period_id, kind, part_no, parts_total, base_cents, fee_bps, rule)
      select v_id, p_profile, p.period_id, 'charge', p.part_no, p.parts_total, p.base_cents, v_fee,
             case when v_start <> v_period then 'late_charge_v1' else v_rule end
      from private.revenue_parts(v_net, p_plan, v_start) p;
      -- La red del criterio: las partes suman exactamente el ingreso neto.
      if (select sum(a.base_cents) from public.revenue_allocations a where a.charge_id = v_id) is distinct from v_net then
        raise exception 'revenue parts of charge % do not add up', v_id using errcode = 'P0001';
      end if;
      return jsonb_build_object('outcome', 'recorded', 'charge_id', v_id)
             || case when v_start <> v_period then '{"late": true}'::jsonb else '{}'::jsonb end;
    end if;

    -- Otro lo registró mientras tanto; ya confirmado, se ve.
    select * into v_found from public.charges c
    where c.provider = p_provider and c.provider_charge_id = p_provider_charge_id;
  end if;

  if v_found.profile_id = p_profile and v_found.subscription_id = p_subscription and v_found.plan = p_plan
     and v_found.charged_at = p_charged_at and v_found.currency = p_currency and v_found.gross_cents = p_gross_cents then
    return jsonb_build_object('outcome', 'already_recorded', 'charge_id', v_found.id);
  end if;
  return jsonb_build_object('outcome', 'conflict', 'charge_id', null::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------
-- Lo que se congela con un periodo cerrado o pagado: no entra un cobro que empiece ahí, ni una parte,
-- ni se abre una alerta, ni se crea o se revierte una exclusión. Revisar una alerta sigue (FL-64: la
-- respuesta del maestro llega después del cierre). El primer argumento es la columna del periodo (en
-- una exclusión que se revierte no cambia: su guardián solo deja cambiar la revocación).
create function private.guard_frozen_period() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_period integer := (pg_catalog.to_jsonb(new) ->> tg_argv[0])::integer;
begin
  if exists (select 1 from public.payout_periods p where p.period_id = v_period and p.status in ('closed', 'paid')) then
    raise exception '%.%: period % is closed', tg_table_schema, tg_table_name, v_period using errcode = '55000';
  end if;
  return new;
end
$$;
revoke all on function private.guard_frozen_period() from public;

create trigger charges_frozen before insert on public.charges
  for each row execute function private.guard_frozen_period('allocation_start_period_id');
create trigger revenue_allocations_frozen before insert on public.revenue_allocations
  for each row execute function private.guard_frozen_period('period_id');
-- Antes que su guardián (los disparadores corren en orden alfabético).
create trigger consumption_exclusions_frozen before insert or update on public.consumption_exclusions
  for each row execute function private.guard_frozen_period('period_id');
create trigger anomaly_alerts_frozen before insert on public.anomaly_alerts
  for each row execute function private.guard_frozen_period('period_id');

-- ---------------------------------------------------------------------------------------
-- La detección de cada noche (T-208, con la alerta de T-407): cada periodo de la ventana con sus
-- instantes (los de su fila), y el salto de puntos y el bote sin consumo en todo periodo de la
-- ventana que ya terminó, no solo en el anterior por reloj (uno en cierre sigue en la ventana). Lo
-- demás no cambia.
create or replace function private.detect_anomalies(p_period public.period_id, p_now timestamptz default pg_catalog.now())
returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_kind text := pg_catalog.current_setting('app.actor_kind', true);
  v_window public.period_id[] := array(select private.rollup_window());
  v_zone text := private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}';
  v_start timestamptz;
  v_end timestamptz;
  v_ended boolean;
  v_elapsed numeric;
  v_speed numeric;
  v_bps text;
  v_floor text;
  v_previous public.period_id;
  v_count integer;
  v_opened integer := 0;
  v_unconsumed_bps text;
  v_pool bigint;
  v_assigned bigint;
  v_students integer;
  v_without integer;
  v_failed text;
begin
  if v_zone is null then
    raise exception 'ZONA_HORARIA_PERIODO is not set' using errcode = 'P0001';
  end if;
  if not p_period = any (v_window) then
    return pg_catalog.jsonb_build_object('alerts_opened', 0);
  end if;
  perform pg_catalog.set_config('app.actor_kind', 'system', true);

  select b.starts_at, b.ends_at into v_start, v_end from private.period_bounds(p_period) b;
  -- Por el reloj, no por `p_now`: lo que ya terminó (T-601; antes, solo el anterior por reloj).
  v_ended := v_end <= pg_catalog.now();
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

  v_previous := private.period_plus(p_period, -1);
  if v_ended
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

  -- El bote sin consumo (T-407): solo un mes que terminó, y solo si tiene bases. En su propio
  -- bloque: lo de arriba ya quedó, falle o no.
  if v_ended
     and exists (select 1 from public.revenue_allocations a where a.period_id = p_period) then
    begin
      v_unconsumed_bps := private.parameter_value('ALERTA_SIN_CONSUMO_PCT', p_now) #>> '{}';
      if v_unconsumed_bps is null or v_unconsumed_bps !~ '^[1-9][0-9]{0,4}$' or v_unconsumed_bps::integer > 10000 then
        raise exception 'unconsumed pool threshold is not set' using errcode = 'P0001';
      end if;
      select coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'student_pool'), 0),
             coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'share'), 0),
             pg_catalog.count(*) filter (where l.kind = 'student_pool'),
             pg_catalog.count(*) filter (where l.kind = 'student_pool' and l.half_points = 0)
      into v_pool, v_assigned, v_students, v_without
      from private.payout_for_period(p_period, 0) l;
      -- Con el bote en 0, el sin consumo también es 0 y no se abre: no se divide entre cero.
      if (v_pool - v_assigned) * 10000 > v_unconsumed_bps::bigint * v_pool then
        insert into public.anomaly_alerts (period_id, kind, metric_value, threshold_value, details)
        values (p_period, 'unconsumed_pool_ratio', pg_catalog.round((v_pool - v_assigned) * 10000.0 / v_pool, 3),
                v_unconsumed_bps::integer,
                pg_catalog.jsonb_build_object('pool_cents', v_pool, 'assigned_cents', v_assigned,
                                              'unconsumed_cents', v_pool - v_assigned, 'pool_bps', private.pool_bps(p_period),
                                              'students', v_students, 'students_without_points', v_without))
        on conflict do nothing;
        get diagnostics v_count = row_count;
        v_opened := v_opened + v_count;
      end if;
    exception when others then
      v_failed := sqlstate || ': ' || pg_catalog.left(sqlerrm, 200);
    end;
  end if;

  perform pg_catalog.set_config('app.actor_kind', coalesce(v_kind, ''), true);
  return pg_catalog.jsonb_build_object('alerts_opened', v_opened)
         || case when v_failed is null then '{}'::jsonb else pg_catalog.jsonb_build_object('anomalies_failed', v_failed) end;
end
$$;

-- ---------------------------------------------------------------------------------------
-- El vigilante: el área de los periodos (de este carril). Nadie de la aplicación toca la tabla ni
-- ejecuta sus funciones, ninguna es `security definer`, todas con el `search_path` fijo, y sus
-- disparadores (el guardián, la auditoría y los congelados) están y prendidos.

create function private.schema_violations_periods()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  period_functions (name) as (
    values ('month_bounds'), ('period_zone'), ('period_bounds'), ('period_closing_at'), ('period_reached_closing'),
           ('period_status_of'), ('open_period'), ('period_transition'), ('allocation_start'), ('guard_payout_period'),
           ('guard_frozen_period')),
  found as (
    select f.name, p.oid, p.prosecdef, p.proconfig
    from period_functions f
    join pg_catalog.pg_proc p on p.proname = f.name
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private')
  select 'period table reachable by ' || r.rolname, 'public.payout_periods'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.payout_periods'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.payout_periods'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  select 'period function missing', 'private.' || f.name
  from period_functions f
  where not exists (select 1 from found where found.name = f.name)
  union all
  select 'period function executable by ' || r.rolname, found.oid::regprocedure::text
  from app_roles r cross join found
  where pg_catalog.has_function_privilege(r.rolname::name, found.oid, 'EXECUTE')
  union all
  select 'period function security definer or without fixed search_path', found.oid::regprocedure::text
  from found
  where found.prosecdef or not coalesce(found.proconfig, '{}') @> array['search_path=""']
  union all
  select 'period trigger missing or disabled: ' || g.trigger_name, g.table_name
  from (values ('public.payout_periods', 'payout_periods_guard', 'guard_payout_period'),
               ('public.payout_periods', 'payout_periods_no_truncate', 'guard_payout_period'),
               ('public.payout_periods', 'audit_changes', 'audit_row_change'),
               ('public.charges', 'charges_frozen', 'guard_frozen_period'),
               ('public.revenue_allocations', 'revenue_allocations_frozen', 'guard_frozen_period'),
               ('public.consumption_exclusions', 'consumption_exclusions_frozen', 'guard_frozen_period'),
               ('public.anomaly_alerts', 'anomaly_alerts_frozen', 'guard_frozen_period'))
       as g (table_name, trigger_name, function_name)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = g.table_name::regclass and tg.tgname = g.trigger_name and tg.tgenabled in ('O', 'A')
      and n.nspname = 'private' and p.proname = g.function_name)
$$;
revoke all on function private.schema_violations_periods() from public;
