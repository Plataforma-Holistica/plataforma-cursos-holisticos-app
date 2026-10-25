-- T-602 · El ensayo y el cierre (RF-502, RF-503, RN-09, RNF-04; 05 §5.5, §8.4 a §8.6 y §9.3). Segunda
-- de dos solicitudes: la primera (`t602_congelado`) congela lo cerrado. Decisiones de Sergio del
-- 2026-10-24:
--   · el cierre va en orden: no se cierra un periodo con uno anterior, desde el arranque (el primer
--     periodo con juego de tramos), que tenga fila y no esté cerrado;
--   · exige un recálculo completo correcto desde que el periodo entró en cierre (la corrida de cada
--     noche lo hace sola la primera noche en cierre);
--   · las liquidaciones, el bono del fundador, el pago mínimo y el paso a pagado son de T-603, que
--     amplía el cierre y su comprobación;
--   · las precondiciones de avisos sin procesar (T-303) y de conciliación con el proveedor (T-605) se
--     omiten por ahora: llegan con su tarea.
--
-- Lo que cambia respecto del esquema escrito (05):
--   · `payout_periods` gana las cifras del cierre sin `gross_revenue_cents` (un anual se reparte en
--     doce: el bruto no tiene definición por periodo), sin `payouts_released_*` ni `paid_at` (T-603);
--     que un periodo cerrado tenga todas sus cifras lo exigen su guardián y la comprobación al
--     confirmar, no un `check`;
--   · `close_runs` es de solo inserción: cada corrida nace terminada, bien o fallida, y no lleva el
--     CSV (T-605 agrega sus columnas); un ensayo que falla se anota con su error, un cierre que falla
--     no deja nada;
--   · `close_run_teacher_totals` no lleva `founder_bonus_cents` (T-603);
--   · no hay `close_preconditions` ni `lock_period_for_close`: las precondiciones van dentro de
--     `private.close_period()`, cada una con su respuesta, y el candado es el de la fila del periodo
--     (`for update`), que los congelados toman compartido desde la primera solicitud;
--   · `assert_period_balanced` no comprueba las liquidaciones (la 6 del 05 llega con T-603); sí que lo
--     que pasa al periodo siguiente llegue, y que la corrida del cierre diga las mismas cifras.
--
-- Nadie de la aplicación ensaya ni cierra todavía (PA-80, T-605). Y en la lista de salida: ningún
-- periodo se cierra en producción antes de T-303 y T-603, porque uno cerrado ya no se completa (RN-09).

-- ---------------------------------------------------------------------------------------
-- Las cifras del periodo.

create type public.close_run_kind as enum ('rehearsal', 'close');

alter table public.payout_periods
  add column net_revenue_cents bigint,        -- la suma de las bases de sus alumnos (RN-02)
  add column student_pools_cents bigint,      -- la suma de sus botes (RN-03)
  add column pool_cents bigint,               -- el bote: los de los alumnos más lo recibido
  add column assigned_cents bigint,           -- lo repartido por RN-05
  add column unconsumed_cents bigint,         -- el sin consumo, con lo recibido (RN-06)
  add column carried_out_cents bigint,        -- lo que pasa al periodo siguiente
  add column close_run_id uuid,
  add column closed_at timestamptz,
  add column closed_by uuid references public.profiles (id),
  add constraint payout_periods_close_figures_positive check (
    net_revenue_cents >= 0 and student_pools_cents >= 0 and pool_cents >= 0 and assigned_cents >= 0
    and unconsumed_cents >= 0 and carried_out_cents >= 0),
  add constraint payout_periods_pool_is_sum check (pool_cents = student_pools_cents + carried_in_cents),
  add constraint payout_periods_pool_is_split check (pool_cents = assigned_cents + unconsumed_cents),
  add constraint payout_periods_carry_all_or_nothing
    check (carried_out_cents = 0 or (carried_out_cents = pool_cents and assigned_cents = 0));

-- ---------------------------------------------------------------------------------------
-- Las tablas del cierre. Solo inserción, sin permisos para la aplicación.

create table public.close_runs (
  id uuid primary key default gen_random_uuid(),
  period_id public.period_id not null references public.payout_periods (period_id),
  kind public.close_run_kind not null,
  status public.run_status not null,
  period_status_at_run public.period_status not null,  -- open: ensayo parcial. closing: datos finales
  input_hash bytea,                           -- la huella de la entrada
  result_hash bytea,                          -- la huella de las líneas del reparto, en su orden
  code_version text not null,                 -- la última migración aplicada
  parameters jsonb not null,                  -- lo que entra en la huella además de bases y puntos
  active_students integer,
  pool_bps public.bps,
  carried_in_cents bigint,
  net_revenue_cents bigint,
  student_pools_cents bigint,
  pool_cents bigint,
  assigned_cents bigint,
  unconsumed_cents bigint,
  carried_out_cents bigint,
  started_by uuid not null references public.profiles (id),
  started_at timestamptz not null default now(),
  finished_at timestamptz not null default clock_timestamp(),
  error text,
  constraint close_runs_finished check (status in ('succeeded', 'failed')),
  constraint close_runs_close_needs_final_data check (kind <> 'close' or period_status_at_run = 'closing'),
  constraint close_runs_close_succeeded check (kind <> 'close' or status = 'succeeded'),
  constraint close_runs_period_not_closed check (period_status_at_run in ('open', 'closing')),
  constraint close_runs_success_is_complete check (
    status <> 'succeeded'
    or (input_hash is not null and result_hash is not null and pool_bps is not null and carried_in_cents is not null
        and net_revenue_cents is not null and student_pools_cents is not null and pool_cents is not null
        and assigned_cents is not null and unconsumed_cents is not null and carried_out_cents is not null)),
  constraint close_runs_failure_has_error check (status <> 'failed' or (error is not null and input_hash is null))
);
comment on table public.close_runs is 'Cada ensayo y el cierre de un periodo, con sus huellas, la versión del código y los parámetros (RF-502, RF-503). Solo inserción.';
-- Un periodo tiene un solo cierre, aunque se pida dos veces (05 §9.3).
create unique index close_runs_one_close_uq on public.close_runs (period_id) where kind = 'close';
-- Los ensayos de un periodo, y «existe un ensayo con los datos finales y esta huella».
create index close_runs_period_idx on public.close_runs (period_id, kind, input_hash);

alter table public.payout_periods
  add constraint payout_periods_close_run_fk foreign key (close_run_id) references public.close_runs (id);

create table public.close_run_teacher_totals (
  close_run_id uuid not null references public.close_runs (id),
  teacher_id uuid not null references public.teachers (id),
  half_points integer not null,
  students integer not null,
  assigned_cents bigint not null,
  unconsumed_cents bigint not null,
  total_cents bigint not null,
  primary key (close_run_id, teacher_id),
  constraint close_run_teacher_totals_sum check (total_cents = assigned_cents + unconsumed_cents),
  constraint close_run_teacher_totals_positive check (
    half_points > 0 and students > 0 and assigned_cents >= 0 and unconsumed_cents >= 0)
);
comment on table public.close_run_teacher_totals is 'El total de cada maestro en un ensayo o un cierre: lo que finanzas revisa (RF-503). Solo inserción.';

create table public.payout_student_pools (
  period_id public.period_id not null references public.payout_periods (period_id),
  profile_id uuid not null references public.profiles (id),
  close_run_id uuid not null references public.close_runs (id),
  base_cents bigint not null,                 -- el ingreso neto del alumno en el periodo (RN-02)
  pool_cents bigint not null,                 -- su bote (RN-03), hacia abajo
  half_points integer not null,               -- sus medios puntos en el periodo
  primary key (period_id, profile_id),
  constraint payout_student_pools_positive check (base_cents > 0 and pool_cents >= 0 and half_points >= 0),
  constraint payout_student_pools_within_base check (pool_cents <= base_cents)
);
comment on table public.payout_student_pools is 'El bote de cada alumno de un periodo cerrado, tuviera puntos o no (RN-03, RN-06). Solo inserción, y solo durante el cierre.';

create table public.payout_shares (
  period_id public.period_id not null references public.payout_periods (period_id),
  profile_id uuid not null,                   -- el alumno: su bote, por la clave de abajo
  teacher_id uuid not null references public.teachers (id),
  close_run_id uuid not null references public.close_runs (id),
  half_points integer not null,               -- sus medios puntos con este maestro
  amount_cents bigint not null,               -- su parte para este maestro (RN-05, RN-07)
  primary key (period_id, profile_id, teacher_id),
  constraint payout_shares_positive check (half_points > 0 and amount_cents >= 0),
  constraint payout_shares_student_fk foreign key (period_id, profile_id)
    references public.payout_student_pools (period_id, profile_id)
);
comment on table public.payout_shares is 'El desglose alumno por alumno de RF-504. Solo inserción, y solo durante el cierre.';
-- El reporte del maestro: sus filas de un periodo.
create index payout_shares_teacher_idx on public.payout_shares (period_id, teacher_id);

create table public.payout_teacher_totals (
  period_id public.period_id not null references public.payout_periods (period_id),
  teacher_id uuid not null references public.teachers (id),
  close_run_id uuid not null references public.close_runs (id),
  half_points integer not null,
  students integer not null,
  assigned_cents bigint not null,             -- la suma de sus partes
  unconsumed_cents bigint not null,           -- su parte del sin consumo (RN-06)
  total_cents bigint not null,                -- lo que le tocó del bote
  primary key (period_id, teacher_id),
  constraint payout_teacher_totals_sum check (total_cents = assigned_cents + unconsumed_cents),
  constraint payout_teacher_totals_positive check (
    half_points > 0 and students > 0 and assigned_cents >= 0 and unconsumed_cents >= 0)
);
comment on table public.payout_teacher_totals is 'Por maestro y periodo cerrado: lo asignado, su parte del sin consumo y el total (RF-502, RN-06). Solo inserción.';
-- La serie de periodos en el panel del maestro (RF-601).
create index payout_teacher_totals_teacher_idx on public.payout_teacher_totals (teacher_id, period_id desc);

alter table public.close_runs enable row level security;
alter table public.close_run_teacher_totals enable row level security;
alter table public.payout_student_pools enable row level security;
alter table public.payout_shares enable row level security;
alter table public.payout_teacher_totals enable row level security;
revoke all on public.close_runs, public.close_run_teacher_totals, public.payout_student_pools, public.payout_shares,
              public.payout_teacher_totals
  from public, anon, authenticated, service_role, app_service;

-- ---------------------------------------------------------------------------------------
-- Los guardianes. Sin `security definer`: escriben estas tablas solo funciones del dueño.

-- Una corrida dice con qué estado del periodo corrió, y la corre quien actúa. La base pone cuándo
-- terminó.
create function private.guard_close_run() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_status public.period_status;
begin
  select p.status into v_status from public.payout_periods p where p.period_id = new.period_id;
  if v_status is distinct from new.period_status_at_run then
    raise exception '%.%: a run of period % says it ran with it %, and it is %', tg_table_schema, tg_table_name,
      new.period_id, new.period_status_at_run, v_status using errcode = '23514';
  end if;
  if new.started_by is distinct from private.actor_id() then
    raise exception '%.%: a run is started by whoever acts', tg_table_schema, tg_table_name using errcode = '23514';
  end if;
  new.finished_at := pg_catalog.clock_timestamp();
  return new;
end
$$;
revoke all on function private.guard_close_run() from public;

-- Las tablas del reparto solo aceptan filas de un periodo en cierre, con la corrida de su cierre: un
-- ensayo no escribe aquí (05 §8.5), y un periodo cerrado ya no cambia.
create function private.require_period_closing() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (select p.status from public.payout_periods p where p.period_id = new.period_id) is distinct from 'closing'
     or not exists (select 1 from public.close_runs r
                    where r.id = new.close_run_id and r.period_id = new.period_id and r.kind = 'close') then
    raise exception '%.%: period % is not being closed', tg_table_schema, tg_table_name, new.period_id using errcode = '55000';
  end if;
  return new;
end
$$;
revoke all on function private.require_period_closing() from public;

create trigger close_runs_guard before insert on public.close_runs
  for each row execute function private.guard_close_run();
create trigger require_period_closing before insert on public.payout_student_pools
  for each row execute function private.require_period_closing();
create trigger require_period_closing before insert on public.payout_shares
  for each row execute function private.require_period_closing();
create trigger require_period_closing before insert on public.payout_teacher_totals
  for each row execute function private.require_period_closing();
create trigger ledger_no_update_delete before update or delete on public.close_runs
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on public.close_runs
  for each statement execute function private.reject_mutation();
create trigger ledger_no_update_delete before update or delete on public.close_run_teacher_totals
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on public.close_run_teacher_totals
  for each statement execute function private.reject_mutation();
create trigger ledger_no_update_delete before update or delete on public.payout_student_pools
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on public.payout_student_pools
  for each statement execute function private.reject_mutation();
create trigger ledger_no_update_delete before update or delete on public.payout_shares
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on public.payout_shares
  for each statement execute function private.reject_mutation();
create trigger ledger_no_update_delete before update or delete on public.payout_teacher_totals
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on public.payout_teacher_totals
  for each statement execute function private.reject_mutation();
-- Cada ensayo y cada cierre: dinero. Las filas del reparto no: las dice su corrida.
create trigger audit_changes after insert on public.close_runs
  for each row execute function private.audit_row_change('money');

-- El guardián del periodo (`t601_tramos`), con el cierre y lo arrastrado:
--   · lo arrastrado (`carried_in_cents`) se escribe solo, una vez, de 0 a lo que pasó el periodo
--     anterior ya cerrado, a un periodo abierto o en cierre;
--   · de en cierre a cerrado, una vez, con todas sus cifras y su foto, y nada más cambia en ese paso; la
--     hora y quién lo cerró los pone la base (sin quien actúe, no se cierra);
--   · un periodo cerrado o pagado no cambia; de cerrado a pagado llega con T-603;
--   · lo demás, como estaba: la foto una vez, y de abierto a en cierre.
create or replace function private.guard_payout_period() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_bounds record;
  v_close constant text[] := array['net_revenue_cents', 'student_pools_cents', 'pool_cents', 'assigned_cents',
                                   'unconsumed_cents', 'carried_out_cents', 'close_run_id', 'closed_at', 'closed_by'];
  v_previous record;
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
    if new.status not in ('open', 'closing') or new.carried_in_cents <> 0 or new.active_students is not null or new.pool_bps is not null
       or pg_catalog.num_nonnulls(new.net_revenue_cents, new.student_pools_cents, new.pool_cents, new.assigned_cents,
                                  new.unconsumed_cents, new.carried_out_cents, new.close_run_id, new.closed_at, new.closed_by) > 0 then
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

  if old.status in ('closed', 'paid') then
    if pg_catalog.to_jsonb(new) is distinct from pg_catalog.to_jsonb(old) then
      raise exception '%.%: period % is closed: it does not change (paid comes with T-603)', tg_table_schema, tg_table_name,
        old.period_id using errcode = '23514';
    end if;
    return new;
  end if;

  if new.carried_in_cents is distinct from old.carried_in_cents then
    if (pg_catalog.to_jsonb(new) - 'carried_in_cents') is distinct from (pg_catalog.to_jsonb(old) - 'carried_in_cents')
       or old.carried_in_cents <> 0 then
      raise exception '%.%: what period % receives is written once, alone', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    select p.status, p.carried_out_cents into v_previous
    from public.payout_periods p where p.period_id = private.period_plus(old.period_id, -1);
    if v_previous.status is distinct from 'closed' or v_previous.carried_out_cents is distinct from new.carried_in_cents then
      raise exception '%.%: period % receives only what the closed period before it passes on', tg_table_schema, tg_table_name,
        old.period_id using errcode = '23514';
    end if;
    return new;
  end if;

  if new.status = 'closed' then
    if old.status <> 'closing' then
      raise exception '%.%: period % closes only from closing', tg_table_schema, tg_table_name, old.period_id using errcode = '23514';
    end if;
    if (pg_catalog.to_jsonb(new) - (v_close || 'status'::text)) is distinct from (pg_catalog.to_jsonb(old) - (v_close || 'status'::text)) then
      raise exception '%.%: closing period % writes only its close figures', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    if pg_catalog.num_nulls(new.net_revenue_cents, new.student_pools_cents, new.pool_cents, new.assigned_cents,
                            new.unconsumed_cents, new.carried_out_cents, new.close_run_id) > 0
       or old.active_students is null or old.pool_bps is null then
      raise exception '%.%: period % closes with all its figures and its photo', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    if private.actor_id() is null then
      raise exception '%.%: period % is closed by someone', tg_table_schema, tg_table_name, old.period_id using errcode = '23514';
    end if;
    new.closed_by := private.actor_id();
    new.closed_at := pg_catalog.now();
    return new;
  end if;

  if (pg_catalog.to_jsonb(new) - array['status', 'entered_closing_at', 'active_students', 'pool_bps'])
     is distinct from (pg_catalog.to_jsonb(old) - array['status', 'entered_closing_at', 'active_students', 'pool_bps']) then
    raise exception '%.%: only the status of period % changes', tg_table_schema, tg_table_name, old.period_id using errcode = '23514';
  end if;
  if new.active_students is distinct from old.active_students or new.pool_bps is distinct from old.pool_bps then
    if not private.actor_is_system() then
      raise exception '%.%: the photo of period % is taken by the system', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    if old.active_students is not null or old.pool_bps is not null or new.active_students is null then
      raise exception '%.%: the photo of period % is taken once, with its active students', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    if pg_catalog.now() < old.ends_at then
      raise exception '%.%: period % has not ended: no photo yet', tg_table_schema, tg_table_name, old.period_id using errcode = '23514';
    end if;
    if new.status is distinct from old.status or new.entered_closing_at is distinct from old.entered_closing_at then
      raise exception '%.%: the photo of period % does not change its status', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    return new;
  end if;
  if new.status = old.status then
    if new.entered_closing_at is distinct from old.entered_closing_at then
      raise exception '%.%: the closing time of period % does not change', tg_table_schema, tg_table_name, old.period_id
        using errcode = '23514';
    end if;
    return new;
  end if;
  if not (old.status = 'open' and new.status = 'closing') then
    raise exception '%.%: period % goes only from open to closing, and from closing to closed', tg_table_schema, tg_table_name,
      old.period_id using errcode = '23514';
  end if;
  if old.active_students is null then
    raise exception '%.%: period % needs its photo before closing', tg_table_schema, tg_table_name, old.period_id
      using errcode = '23514';
  end if;
  if not private.period_reached_closing(old.period_id) then
    raise exception '%.%: period % has not reached its closing day', tg_table_schema, tg_table_name, old.period_id
      using errcode = '23514';
  end if;
  new.entered_closing_at := pg_catalog.now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------
-- La entrada, leída una sola vez.

-- La versión del código que calcula: la última migración aplicada.
create function private.code_version() returns text
language sql stable set search_path = ''
as $$
  select coalesce(pg_catalog.max(m.version), 'unknown') from supabase_migrations.schema_migrations m
$$;
revoke all on function private.code_version() from public;

-- Todo lo que entra al reparto de un periodo, en una sola sentencia (una sola foto de la base): las
-- bases y los medios puntos, ordenados; el porcentaje (`pool_bps`: el de la foto si la tiene, y si no, el
-- de ahora, que es el del ensayo parcial; quien llama no ensaya ni cierra en cierre sin porcentaje); lo
-- recibido del periodo anterior; los parámetros que deciden el
-- cálculo; el periodo y la versión del código. La huella es el SHA-256 de su forma canónica: un
-- `jsonb`, que escribe sus llaves siempre en el mismo orden.
create function private.close_input(p_period public.period_id,
  out pool_bps integer, out carried_in_cents bigint, out active_students integer,
  out bases private.payout_base[], out points private.payout_points[],
  out parameters jsonb, out code_version text, out input_hash bytea)
language sql stable set search_path = ''
as $$
  with p as (select x.carried_in_cents, x.active_students from public.payout_periods x where x.period_id = p_period),
  i as (
    select private.pool_bps(p_period) as pool_bps,
           coalesce((select p.carried_in_cents from p), 0)::bigint as carried_in_cents,
           (select p.active_students from p) as active_students,
           array(select row(s.profile_id, s.base_cents)::private.payout_base
                 from private.close_input_students(p_period) s order by s.profile_id) as bases,
           array(select row(x.profile_id, x.teacher_id, x.tiebreak_rank, x.half_points)::private.payout_points
                 from private.close_input_points(p_period) x order by x.profile_id, x.teacher_id) as points,
           (select pg_catalog.jsonb_build_object('thresholds', t.thresholds, 'bps', t.bps) from private.pool_tiers_for(p_period) t) as tiers,
           private.code_version() as code_version),
  k as (
    select i.*, pg_catalog.jsonb_build_object(
             'BOTE_REGLA_TRAMO', private.period_parameter('BOTE_REGLA_TRAMO', p_period),
             'BOTE_SIN_CONSUMO', private.period_parameter('BOTE_SIN_CONSUMO', p_period),
             'tiers', i.tiers, 'active_students', i.active_students) as parameters
    from i)
  select k.pool_bps, k.carried_in_cents, k.active_students, k.bases, k.points, k.parameters, k.code_version,
         pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
           'period', p_period, 'code_version', k.code_version, 'pool_bps', k.pool_bps,
           'carried_in_cents', k.carried_in_cents, 'parameters', k.parameters,
           'bases', pg_catalog.to_jsonb(k.bases), 'points', pg_catalog.to_jsonb(k.points))::text, 'UTF8'))
  from k
$$;
revoke all on function private.close_input(public.period_id) from public;

-- El total de cada maestro con partes, de las líneas del reparto: sus medios puntos, sus alumnos (una
-- parte por alumno y maestro: la red lo exige), lo asignado, su parte del sin consumo y el total. Un
-- maestro con puntos y 0 asignado sale con 0.
create function private.close_teacher_totals(p_lines private.payout_line[])
returns table (teacher_id uuid, half_points integer, students integer, assigned_cents bigint, unconsumed_cents bigint, total_cents bigint)
language sql immutable set search_path = ''
as $$
  with l as (select * from pg_catalog.unnest(p_lines)),
  s as (select l.teacher_id, pg_catalog.sum(l.half_points)::integer as half_points,
               pg_catalog.count(*)::integer as students, pg_catalog.sum(l.cents)::bigint as cents
        from l where l.kind = 'share' group by l.teacher_id),
  u as (select l.teacher_id, pg_catalog.sum(l.cents)::bigint as cents from l where l.kind = 'unconsumed_share' group by l.teacher_id)
  select s.teacher_id, s.half_points, s.students, s.cents, coalesce(u.cents, 0)::bigint, (s.cents + coalesce(u.cents, 0))::bigint
  from s left join u on u.teacher_id = s.teacher_id
  order by s.teacher_id
$$;
revoke all on function private.close_teacher_totals(private.payout_line[]) from public;

-- ---------------------------------------------------------------------------------------
-- El ensayo (RF-503, 05 §8.5): el mismo camino que el cierre, sin escribir el reparto. Con el periodo
-- abierto es parcial; en cierre, con los datos finales; cerrado o pagado, no se ensaya. Escribe su
-- corrida y el total de cada maestro, nada más; un cálculo que lanza queda como corrida fallida, con
-- su error. Toma la fila del periodo con candado compartido: no ensaya uno que se está cerrando, y el
-- cierre espera al ensayo. A un mes que no ha empezado y no tiene fila no se la abre.
create function private.rehearse_close(p_period public.period_id) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_status public.period_status;
  v_row record;
  v_in record;
  v_lines private.payout_line[];
  v_result bytea;
  v_error text;
  v_run uuid;
  v_net bigint;
  v_pools bigint;
  v_assigned bigint;
  v_carried_out bigint;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'rehearsals run in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_period is null then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  if (select t.thresholds from private.pool_tiers_for(p_period) t) is null then
    return '{"outcome": "before_launch"}'::jsonb;
  end if;
  if not exists (select 1 from public.payout_periods p where p.period_id = p_period) then
    if (select b.starts_at from private.period_bounds(p_period) b) > pg_catalog.now() then
      return '{"outcome": "not_started"}'::jsonb;
    end if;
    perform private.open_period(p_period);
  end if;

  select p.status, p.active_students, p.pool_bps, p.close_run_id into v_row
  from public.payout_periods p where p.period_id = p_period for share;
  v_status := v_row.status;
  if v_status in ('closed', 'paid') then
    return pg_catalog.jsonb_build_object('outcome', 'already_closed', 'close_run_id', v_row.close_run_id);
  end if;
  if v_status = 'closing' and v_row.active_students is null then
    return '{"outcome": "photo_missing"}'::jsonb;
  end if;
  if v_status = 'closing' and v_row.pool_bps is null then
    return '{"outcome": "no_pool_bps"}'::jsonb;
  end if;

  begin
    select * into v_in from private.close_input(p_period) i;
    v_lines := array(select row(x.kind, x.profile_id, x.teacher_id, x.tiebreak_rank, x.cents, x.base_cents, x.half_points)::private.payout_line
                     from private.compute_payout(v_in.pool_bps, v_in.carried_in_cents, v_in.bases, v_in.points) with ordinality x
                     order by x.ordinality);
  exception when others then
    v_error := sqlstate || ': ' || pg_catalog.left(sqlerrm, 250);
  end;
  if v_error is not null then
    insert into public.close_runs (period_id, kind, status, period_status_at_run, code_version, parameters, started_by, error)
    values (p_period, 'rehearsal', 'failed', v_status, private.code_version(), '{}'::jsonb, private.actor_id(), v_error)
    returning id into v_run;
    return pg_catalog.jsonb_build_object('outcome', 'failed', 'run_id', v_run, 'error', v_error);
  end if;

  v_result := pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(v_lines)::text, 'UTF8'));
  select coalesce(pg_catalog.sum(l.base_cents) filter (where l.kind = 'student_pool'), 0),
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'student_pool'), 0),
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'share'), 0),
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'carried_over'), 0)
    into v_net, v_pools, v_assigned, v_carried_out
  from pg_catalog.unnest(v_lines) l;

  insert into public.close_runs (period_id, kind, status, period_status_at_run, input_hash, result_hash, code_version, parameters,
                                 active_students, pool_bps, carried_in_cents, net_revenue_cents, student_pools_cents, pool_cents,
                                 assigned_cents, unconsumed_cents, carried_out_cents, started_by)
  values (p_period, 'rehearsal', 'succeeded', v_status, v_in.input_hash, v_result, v_in.code_version, v_in.parameters,
          v_in.active_students, v_in.pool_bps, v_in.carried_in_cents, v_net, v_pools, v_pools + v_in.carried_in_cents,
          v_assigned, v_pools + v_in.carried_in_cents - v_assigned, v_carried_out, private.actor_id())
  returning id into v_run;
  insert into public.close_run_teacher_totals (close_run_id, teacher_id, half_points, students, assigned_cents, unconsumed_cents, total_cents)
  select v_run, t.teacher_id, t.half_points, t.students, t.assigned_cents, t.unconsumed_cents, t.total_cents
  from private.close_teacher_totals(v_lines) t;

  return pg_catalog.jsonb_build_object(
    'outcome', 'rehearsed', 'run_id', v_run, 'period_status_at_run', v_status,
    'input_hash', pg_catalog.encode(v_in.input_hash, 'hex'), 'result_hash', pg_catalog.encode(v_result, 'hex'),
    'pool_bps', v_in.pool_bps, 'carried_in_cents', v_in.carried_in_cents, 'net_revenue_cents', v_net,
    'student_pools_cents', v_pools, 'pool_cents', v_pools + v_in.carried_in_cents, 'assigned_cents', v_assigned,
    'unconsumed_cents', v_pools + v_in.carried_in_cents - v_assigned, 'carried_out_cents', v_carried_out);
end
$$;
revoke all on function private.rehearse_close(public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- El cierre (05 §8.6): una transacción. Toma la fila del periodo para sí (`for update`), que espera a
-- cada escritura en vuelo sobre lo que congela, al ensayo y a otro cierre (el segundo encuentra el
-- periodo cerrado y contesta con el cierre que existe). Revisa las precondiciones en orden, cada una
-- con su respuesta y sin escribir nada; lee la entrada y calcula; escribe la corrida, los botes de los
-- alumnos, las partes y los totales en el orden de las líneas; cierra el periodo con sus cifras; y le
-- pasa al siguiente lo que no se repartió (le abre la fila si no la tiene). Al confirmar, la base
-- comprueba que todo cuadre (`payout_periods_balanced`): si no, nada de esto existe.
create function private.close_period(p_period public.period_id) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_period public.payout_periods;
  v_blocking public.period_id;
  v_last public.run_status;
  v_in record;
  v_lines private.payout_line[];
  v_result bytea;
  v_run uuid;
  v_net bigint;
  v_pools bigint;
  v_assigned bigint;
  v_carried_out bigint;
  v_next public.period_id;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'closes run in read committed' using errcode = '25000';
  end if;
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_period is null then
    return '{"outcome": "malformed"}'::jsonb;
  end if;

  select * into v_period from public.payout_periods p where p.period_id = p_period for update;
  if not found or v_period.status = 'open' then
    return '{"outcome": "not_closing"}'::jsonb;
  end if;
  if v_period.status in ('closed', 'paid') then
    return pg_catalog.jsonb_build_object('outcome', 'already_closed', 'close_run_id', v_period.close_run_id);
  end if;

  -- Las precondiciones.
  if (select t.thresholds from private.pool_tiers_for(p_period) t) is null then
    return '{"outcome": "before_launch"}'::jsonb;
  end if;
  -- En orden, desde el arranque: un periodo anterior con fila y sin cerrar detiene a este. Sin
  -- candado: uno cerrado no regresa, y así dos cierres no se esperan uno al otro.
  select pg_catalog.min(q.period_id) into v_blocking
  from public.payout_periods q
  where q.period_id < p_period and q.status in ('open', 'closing')
    and q.period_id >= (select pg_catalog.min(t.effective_period_id) from public.pool_tiers t where t.canceled_at is null);
  if v_blocking is not null then
    return pg_catalog.jsonb_build_object('outcome', 'previous_not_closed', 'period', v_blocking);
  end if;
  if v_period.active_students is null then
    return '{"outcome": "photo_missing"}'::jsonb;
  end if;
  if v_period.pool_bps is null then
    return '{"outcome": "no_pool_bps"}'::jsonb;
  end if;
  -- Una consolidación del periodo viva (con latido en los últimos 15 minutos) todavía puede cambiar
  -- el consolidado.
  if exists (select 1 from public.job_runs j
             where j.job = 'nightly_rollup' and j.period_id = p_period and j.status = 'running'
               and j.heartbeat_at >= pg_catalog.now() - interval '15 minutes') then
    return '{"outcome": "rollup_running"}'::jsonb;
  end if;
  -- La corrida más reciente desde que entró en cierre: si falló, una detección pudo no abrir sus alertas.
  select j.status into v_last
  from public.job_runs j
  where j.job = 'nightly_rollup' and j.period_id = p_period and j.status <> 'running' and j.started_at >= v_period.entered_closing_at
  order by j.started_at desc
  limit 1;
  if v_last = 'failed' then
    return '{"outcome": "last_rollup_failed"}'::jsonb;
  end if;
  if not exists (select 1 from public.job_runs j
                 where j.job = 'nightly_rollup' and j.period_id = p_period and j.status = 'succeeded'
                   and j.details ->> 'mode' = 'full' and j.started_at >= v_period.entered_closing_at) then
    return '{"outcome": "needs_full_rollup"}'::jsonb;
  end if;
  if exists (select 1 from private.rollup_dirty d where d.period_id = p_period) then
    return '{"outcome": "rollup_marks"}'::jsonb;
  end if;
  if exists (select 1 from public.anomaly_alerts a where a.period_id = p_period and a.status = 'open') then
    return '{"outcome": "open_alerts"}'::jsonb;
  end if;

  select * into v_in from private.close_input(p_period) i;
  if not exists (select 1 from public.close_runs r
                 where r.period_id = p_period and r.kind = 'rehearsal' and r.status = 'succeeded'
                   and r.period_status_at_run = 'closing') then
    return '{"outcome": "rehearsal_missing"}'::jsonb;
  end if;
  if not exists (select 1 from public.close_runs r
                 where r.period_id = p_period and r.kind = 'rehearsal' and r.status = 'succeeded'
                   and r.period_status_at_run = 'closing' and r.input_hash = v_in.input_hash) then
    return '{"outcome": "rehearsal_stale"}'::jsonb;
  end if;

  -- El cálculo, con la misma entrada que el ensayo.
  v_lines := array(select row(x.kind, x.profile_id, x.teacher_id, x.tiebreak_rank, x.cents, x.base_cents, x.half_points)::private.payout_line
                   from private.compute_payout(v_in.pool_bps, v_in.carried_in_cents, v_in.bases, v_in.points) with ordinality x
                   order by x.ordinality);
  v_result := pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(v_lines)::text, 'UTF8'));
  select coalesce(pg_catalog.sum(l.base_cents) filter (where l.kind = 'student_pool'), 0),
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'student_pool'), 0),
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'share'), 0),
         coalesce(pg_catalog.sum(l.cents) filter (where l.kind = 'carried_over'), 0)
    into v_net, v_pools, v_assigned, v_carried_out
  from pg_catalog.unnest(v_lines) l;

  insert into public.close_runs (period_id, kind, status, period_status_at_run, input_hash, result_hash, code_version, parameters,
                                 active_students, pool_bps, carried_in_cents, net_revenue_cents, student_pools_cents, pool_cents,
                                 assigned_cents, unconsumed_cents, carried_out_cents, started_by)
  values (p_period, 'close', 'succeeded', 'closing', v_in.input_hash, v_result, v_in.code_version, v_in.parameters,
          v_in.active_students, v_in.pool_bps, v_in.carried_in_cents, v_net, v_pools, v_pools + v_in.carried_in_cents,
          v_assigned, v_pools + v_in.carried_in_cents - v_assigned, v_carried_out, private.actor_id())
  returning id into v_run;
  insert into public.payout_student_pools (period_id, profile_id, close_run_id, base_cents, pool_cents, half_points)
  select p_period, l.profile_id, v_run, l.base_cents, l.cents, l.half_points
  from pg_catalog.unnest(v_lines) with ordinality l where l.kind = 'student_pool' order by l.ordinality;
  insert into public.payout_shares (period_id, profile_id, teacher_id, close_run_id, half_points, amount_cents)
  select p_period, l.profile_id, l.teacher_id, v_run, l.half_points, l.cents
  from pg_catalog.unnest(v_lines) with ordinality l where l.kind = 'share' order by l.ordinality;
  insert into public.payout_teacher_totals (period_id, teacher_id, close_run_id, half_points, students, assigned_cents,
                                            unconsumed_cents, total_cents)
  select p_period, t.teacher_id, v_run, t.half_points, t.students, t.assigned_cents, t.unconsumed_cents, t.total_cents
  from private.close_teacher_totals(v_lines) t;

  update public.payout_periods p
  set status = 'closed', net_revenue_cents = v_net, student_pools_cents = v_pools, pool_cents = v_pools + v_in.carried_in_cents,
      assigned_cents = v_assigned, unconsumed_cents = v_pools + v_in.carried_in_cents - v_assigned,
      carried_out_cents = v_carried_out, close_run_id = v_run
  where p.period_id = p_period;

  -- Lo que pasa al siguiente (RN-06). Un ensayo que ya tenía queda con otra huella.
  if v_carried_out > 0 then
    v_next := private.period_plus(p_period, 1);
    perform private.open_period(v_next);
    update public.payout_periods p set carried_in_cents = v_carried_out where p.period_id = v_next;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'closed', 'close_run_id', v_run,
    'input_hash', pg_catalog.encode(v_in.input_hash, 'hex'), 'result_hash', pg_catalog.encode(v_result, 'hex'),
    'pool_bps', v_in.pool_bps, 'carried_in_cents', v_in.carried_in_cents, 'net_revenue_cents', v_net,
    'student_pools_cents', v_pools, 'pool_cents', v_pools + v_in.carried_in_cents, 'assigned_cents', v_assigned,
    'unconsumed_cents', v_pools + v_in.carried_in_cents - v_assigned, 'carried_out_cents', v_carried_out,
    'carried_to', v_next);
end
$$;
revoke all on function private.rehearse_close(public.period_id) from public;
revoke all on function private.close_period(public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- La comprobación al confirmar (05 §8.6): RNF-04 como condición para guardar. Corre con el dueño desde
-- el disparador (diferido: corre al confirmar, con el rol de la sesión, y cuando PA-80 le dé el cierre
-- al servidor, que no lee estas tablas, fallaría todo cierre). La 6 del 05 (las liquidaciones) llega
-- con T-603.
create function private.assert_period_balanced(p_period public.period_id) returns void
language plpgsql stable set search_path = ''
as $$
declare
  p public.payout_periods;
  v_pools bigint;
  v_bases bigint;
  v_shares bigint;
  v_totals bigint;
  v_bad integer;
begin
  select * into strict p from public.payout_periods x where x.period_id = p_period;

  -- 1. Los botes de los alumnos suman el del periodo, y sus bases, el ingreso (RN-02, RN-03).
  select coalesce(pg_catalog.sum(s.pool_cents), 0), coalesce(pg_catalog.sum(s.base_cents), 0) into v_pools, v_bases
  from public.payout_student_pools s where s.period_id = p_period;
  if v_pools is distinct from p.student_pools_cents then
    raise exception 'period %: student pools sum % but the period says %', p_period, v_pools, p.student_pools_cents
      using errcode = '23514';
  end if;
  if v_bases is distinct from p.net_revenue_cents then
    raise exception 'period %: student bases sum % but the net revenue says %', p_period, v_bases, p.net_revenue_cents
      using errcode = '23514';
  end if;

  -- 2. Cada alumno con puntos reparte exactamente su bote, con sus medios puntos (RN-05, RN-07).
  select pg_catalog.count(*) into v_bad
  from public.payout_student_pools sp
  left join (select s.profile_id, pg_catalog.sum(s.amount_cents) as shared, pg_catalog.sum(s.half_points) as points
             from public.payout_shares s where s.period_id = p_period group by s.profile_id) x on x.profile_id = sp.profile_id
  where sp.period_id = p_period
    and (coalesce(x.points, 0) <> sp.half_points or (sp.half_points > 0 and coalesce(x.shared, 0) <> sp.pool_cents));
  if v_bad > 0 then
    raise exception 'period %: % students whose shares do not add up to their pool', p_period, v_bad using errcode = '23514';
  end if;

  -- 3. Lo asignado es la suma de las partes.
  select coalesce(pg_catalog.sum(s.amount_cents), 0) into v_shares from public.payout_shares s where s.period_id = p_period;
  if v_shares is distinct from p.assigned_cents then
    raise exception 'period %: shares sum % but assigned says %', p_period, v_shares, p.assigned_cents using errcode = '23514';
  end if;

  -- 4. Cada maestro con partes tiene su total, y sale de sus partes.
  select pg_catalog.count(*) into v_bad
  from (select distinct s.teacher_id from public.payout_shares s where s.period_id = p_period) s
  where not exists (select 1 from public.payout_teacher_totals t where t.period_id = p_period and t.teacher_id = s.teacher_id);
  if v_bad > 0 then
    raise exception 'period %: a teacher with shares has no total (%)', p_period, v_bad using errcode = '23514';
  end if;
  select pg_catalog.count(*) into v_bad
  from public.payout_teacher_totals t
  left join (select s.teacher_id, pg_catalog.sum(s.amount_cents) as cents, pg_catalog.sum(s.half_points) as points,
                    pg_catalog.count(*) as students
             from public.payout_shares s where s.period_id = p_period group by s.teacher_id) s on s.teacher_id = t.teacher_id
  where t.period_id = p_period
    and (s.teacher_id is null or t.assigned_cents <> s.cents or t.half_points <> s.points or t.students <> s.students);
  if v_bad > 0 then
    raise exception 'period %: % teacher totals do not match their shares', p_period, v_bad using errcode = '23514';
  end if;

  -- 5. RNF-04: lo que reciben los maestros, más lo que pasa al periodo siguiente, es el bote. Al centavo.
  select coalesce(pg_catalog.sum(t.total_cents), 0) into v_totals from public.payout_teacher_totals t where t.period_id = p_period;
  if v_totals + p.carried_out_cents is distinct from p.pool_cents then
    raise exception 'period %: teachers get % plus carried out % but the pool is % (RNF-04)',
      p_period, v_totals, p.carried_out_cents, p.pool_cents using errcode = '23514';
  end if;

  -- 6. Lo que pasa al siguiente llega (RN-06).
  if p.carried_out_cents > 0 and not exists (
       select 1 from public.payout_periods n
       where n.period_id = private.period_plus(p_period, 1) and n.carried_in_cents = p.carried_out_cents) then
    raise exception 'period %: the next period did not receive what this one passes on (%)', p_period, p.carried_out_cents
      using errcode = '23514';
  end if;

  -- 7. La corrida del cierre dice las mismas cifras, y le corresponde un ensayo con los datos finales y
  -- la misma entrada (RF-503).
  if not exists (
       select 1 from public.close_runs c
       where c.id = p.close_run_id and c.period_id = p_period and c.kind = 'close' and c.status = 'succeeded'
         and (c.active_students, c.pool_bps, c.carried_in_cents, c.net_revenue_cents, c.student_pools_cents, c.pool_cents,
              c.assigned_cents, c.unconsumed_cents, c.carried_out_cents)
             is not distinct from (p.active_students, p.pool_bps, p.carried_in_cents, p.net_revenue_cents, p.student_pools_cents,
                                   p.pool_cents, p.assigned_cents, p.unconsumed_cents, p.carried_out_cents)) then
    raise exception 'period %: the close run does not match the period', p_period using errcode = '23514';
  end if;
  if not exists (
       select 1 from public.close_runs c
       join public.close_runs r
         on r.period_id = c.period_id and r.kind = 'rehearsal' and r.status = 'succeeded'
        and r.period_status_at_run = 'closing' and r.input_hash = c.input_hash
       where c.id = p.close_run_id) then
    raise exception 'period %: no rehearsal with final data and the same input (RF-503)', p_period using errcode = '23514';
  end if;
end
$$;
revoke all on function private.assert_period_balanced(public.period_id) from public;

create function private.check_period_balanced() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_period_balanced(new.period_id);
  return null;
end
$$;
revoke all on function private.check_period_balanced() from public;

-- Al confirmar la transacción del cierre, cuando ya está todo escrito.
create constraint trigger payout_periods_balanced after update of status on public.payout_periods
  deferrable initially deferred
  for each row when (new.status = 'closed' and old.status = 'closing')
  execute function private.check_period_balanced();

-- ---------------------------------------------------------------------------------------
-- El vigilante: el área del cierre (de este carril). Nadie de la aplicación toca sus tablas ni
-- ejecuta sus funciones (el ensayo y el cierre los abre PA-80); solo el ensayo, el cierre y la
-- comprobación al confirmar corren como el dueño; y sus guardias están prendidas, la comprobación
-- diferida.
create function private.schema_violations_close()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  close_tables (table_name) as (
    values ('public.close_runs'), ('public.close_run_teacher_totals'), ('public.payout_student_pools'),
           ('public.payout_shares'), ('public.payout_teacher_totals')),
  close_functions (name, definer) as (
    values ('code_version', false), ('close_input', false), ('close_teacher_totals', false), ('guard_close_run', false),
           ('require_period_closing', false), ('assert_period_balanced', false), ('check_period_balanced', true),
           ('rehearse_close', true), ('close_period', true)),
  found as (
    select f.name, f.definer, p.oid, p.prosecdef, p.proconfig
    from close_functions f
    join pg_catalog.pg_proc p on p.proname = f.name
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private'),
  close_triggers (table_name, trigger_name, function_name, deferred) as (
    select t.table_name, x.trigger_name, 'reject_mutation', false
    from close_tables t cross join (values ('ledger_no_update_delete'), ('ledger_no_truncate')) x (trigger_name)
    union all
    values ('public.close_runs', 'close_runs_guard', 'guard_close_run', false),
           ('public.close_runs', 'audit_changes', 'audit_row_change', false),
           ('public.payout_student_pools', 'require_period_closing', 'require_period_closing', false),
           ('public.payout_shares', 'require_period_closing', 'require_period_closing', false),
           ('public.payout_teacher_totals', 'require_period_closing', 'require_period_closing', false),
           ('public.payout_periods', 'payout_periods_balanced', 'check_period_balanced', true))
  select 'close table reachable by ' || r.rolname, t.table_name
  from app_roles r cross join close_tables t
  where pg_catalog.to_regclass(t.table_name) is not null
    and (pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
         or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER'))
  union all
  select 'close function missing', 'private.' || f.name
  from close_functions f
  where not exists (select 1 from found where found.name = f.name)
  union all
  select 'close function executable by ' || r.rolname, found.oid::regprocedure::text
  from app_roles r cross join found
  where pg_catalog.has_function_privilege(r.rolname::name, found.oid, 'EXECUTE')
  union all
  select 'close function security definer or without fixed search_path', found.oid::regprocedure::text
  from found
  where (found.prosecdef and not found.definer) or not coalesce(found.proconfig, '{}') @> array['search_path=""']
  union all
  select 'close function not security definer', found.oid::regprocedure::text
  from found
  where found.definer and not found.prosecdef
  union all
  select 'close trigger missing or disabled: ' || g.trigger_name, g.table_name
  from close_triggers g
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = pg_catalog.to_regclass(g.table_name) and tg.tgname = g.trigger_name and tg.tgenabled in ('O', 'A')
      and n.nspname = 'private' and p.proname = g.function_name)
  union all
  select 'close trigger not deferred: ' || g.trigger_name, g.table_name
  from close_triggers g
  join pg_catalog.pg_trigger tg on tg.tgrelid = pg_catalog.to_regclass(g.table_name) and tg.tgname = g.trigger_name
  where g.deferred and (tg.tgconstraint = 0 or not tg.tgdeferrable or not tg.tginitdeferred)
$$;
revoke all on function private.schema_violations_close() from public;
