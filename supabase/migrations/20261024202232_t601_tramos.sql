-- T-601 · Los tramos del bote (RN-13, RF-511, RF-707; 05 §5.5, §5.10, §7.3, §8.3 y §8.4). Segunda de
-- dos solicitudes: la primera (los periodos) está en `t601_periodos`. Decisiones de Sergio del
-- 2026-10-23:
--   · los tramos son marginales (cada alumno aporta el porcentaje de su tramo) y el porcentaje
--     efectivo es el promedio, hacia abajo al punto base;
--   · alumno activo es una suscripción pagada vigente al último instante del mes: cuenta la gracia
--     y la cancelada con días pagados; no cuentan cortesías, pendientes ni cuentas suspendidas por
--     fraude;
--   · solo base: la pantalla (PA-85) y sus permisos, después.
--
-- Lo que entra:
--   · `pool_tiers`, que escribe una sola función (`private.set_pool_tiers()`), con el juego entero
--     validado; o la sesión del dueño (la semilla, las pruebas, una corrección a mano);
--   · el tramo de 0 es la única verdad del porcentaje base: `pool_bps` deja de leer `BOTE_PCT_BASE`,
--     y la función de los tramos escribe la versión de `BOTE_PCT_BASE` cuando cambia, para que el
--     panel diga lo mismo;
--   · RF-707 por instante en `business_parameters` y en `pool_tiers`, revisado al confirmar;
--   · los alumnos activos de un instante, y la foto de cada periodo que terminó (sus alumnos y su
--     porcentaje), que la corrida de cada noche toma antes de consolidar; sin ella un periodo no
--     pasa a cierre;
--   · `pool_bps` con los tramos, que no baja respecto del periodo anterior.
--
-- Quién es «la sesión del dueño»: la que entró como el dueño de la tabla (`session_user`) y no
-- cambió de rol (`role` sigue en `none`). Dentro de una función `security definer` `current_user` es
-- el dueño, pero la sesión no: por eso `app_service` no hereda la excepción por llamar a una de
-- ellas, y una prueba con `set role` tampoco.
--
-- Lo que cambia en `business_parameters`, que es común con el carril B: dos disparadores nuevos
-- (el origen de `BOTE_PCT_BASE` y RF-707 por instante), el índice único de una versión deja de
-- contar las canceladas (con `effective_from` atado al inicio del periodo, una versión cancelada
-- impediría volver a programar la del mismo mes), y una cancelación ya no pide persona: la hace
-- también el sistema. `guard_parameter_change` no cambia.

-- ---------------------------------------------------------------------------------------
-- Los parámetros (RF-707): una versión viva por instante, y el sistema también cancela.

alter table public.business_parameters drop constraint business_parameters_version_uq;
create unique index business_parameters_live_version_uq
  on public.business_parameters (key, effective_from) where canceled_at is null;
alter table public.business_parameters
  drop constraint business_parameters_cancel_consistent,
  add constraint business_parameters_cancel_consistent check (canceled_by is null or canceled_at is not null);

update public.parameter_definitions set description = 'Porcentaje base del bote: el del tramo de 0 alumnos activos'
where key = 'BOTE_PCT_BASE';
update public.job_definitions
set description = 'La foto de los periodos que terminaron y su paso a en cierre, en la consolidación nocturna'
where job = 'period_transition';

-- ---------------------------------------------------------------------------------------
-- Las tablas.

create table public.pool_tiers (
  id uuid primary key default gen_random_uuid(),
  effective_period_id public.period_id not null,   -- rige desde este periodo, hasta el juego siguiente
  min_active_students integer not null,            -- desde cuántos alumnos activos; el primero, 0
  pool_bps public.bps not null,                    -- el porcentaje de cada alumno de este tramo
  created_by uuid references public.profiles (id), -- lo llena la base; nulo si fue el sistema
  created_at timestamptz not null default now(),
  canceled_at timestamptz,                         -- lo cancela un juego nuevo del mismo periodo
  canceled_by uuid references public.profiles (id),
  constraint pool_tiers_threshold_positive check (min_active_students >= 0),
  constraint pool_tiers_bps_positive check (pool_bps >= 1),
  constraint pool_tiers_cancel_consistent check (canceled_by is null or canceled_at is not null)
);
comment on table public.pool_tiers is 'Los tramos del bote (RN-13, T-601): el juego vivo de un periodo es el de mayor effective_period_id hasta él. Los escribe private.set_pool_tiers().';
create unique index pool_tiers_live_uq on public.pool_tiers (effective_period_id, min_active_students) where canceled_at is null;
alter table public.pool_tiers enable row level security;
revoke all on public.pool_tiers from public, anon, authenticated, service_role, app_service;

-- El porcentaje que se le aplicó a un periodo (RF-511): lo escribe la foto, con sus alumnos activos.
alter table public.payout_periods
  add column pool_bps public.bps,
  add constraint payout_periods_pool_bps_positive check (pool_bps >= 1),
  add constraint payout_periods_pool_bps_with_students check (pool_bps is null or active_students is not null);
comment on column public.payout_periods.pool_bps is 'El porcentaje del bote del periodo, con sus alumnos activos (RF-511). Nulo si no tenía juego de tramos.';

-- ---------------------------------------------------------------------------------------
-- RF-707 por instante.

-- Dónde empieza un periodo: el instante de su fila o, sin ella, el de su mes en la zona de ahora. Lo
-- único que el disparador de RF-707 necesita saber, y por eso lo único de los periodos que el
-- servidor puede preguntar: corre con el rol de la sesión al confirmar.
create function private.period_start(p_period public.period_id) returns timestamptz
language sql stable security definer set search_path = ''
as $$ select b.starts_at from private.period_bounds(p_period) b $$;
revoke all on function private.period_start(public.period_id) from public;
grant execute on function private.period_start(public.period_id) to app_service;

-- RF-707, para quien no es la sesión del dueño. En `business_parameters`: un parámetro del reparto
-- rige exactamente desde el inicio de su periodo, y ese periodo no ha empezado; ninguno rige hacia
-- atrás (la gracia, por ejemplo, mueve los alumnos activos); y no se cancela una versión que ya rige
-- o cuyo periodo ya empezó. En `pool_tiers`: no se escribe ni se cancela un tramo de un periodo que ya
-- empezó. De una actualización solo mira la cancelación (avisar pasa).
--
-- Es un disparador de restricción diferido y sin `security definer`: corre al confirmar, con el rol de
-- la sesión y con la hora del reloj, así que una transacción abierta a las 23:59 que confirma con el
-- periodo ya empezado se rechaza. El límite: quien escribe puede adelantar la revisión
-- (`set constraints all immediate`), y entonces se revisa con la hora de la sentencia; no puede
-- apagarla ni posponerla.
create function private.guard_payout_timing() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_affects boolean;
begin
  if pg_catalog.current_setting('role') = 'none'
     and session_user = (select pg_catalog.pg_get_userbyid(c.relowner) from pg_catalog.pg_class c where c.oid = tg_relid) then
    return null;
  end if;

  if tg_table_name = 'pool_tiers' then
    if (tg_op = 'INSERT' or (old.canceled_at is null and new.canceled_at is not null))
       and private.period_start(new.effective_period_id) <= v_now then
      raise exception 'pool tiers of period % do not change: the period already started (RF-707)', new.effective_period_id
        using errcode = '23514';
    end if;
    return null;
  end if;

  select d.affects_payout into v_affects from public.parameter_definitions d where d.key = new.key;
  if tg_op = 'INSERT' then
    if v_affects then
      if new.effective_from is distinct from private.period_start(new.effective_period_id) then
        raise exception 'parameter %: a payout parameter takes effect when its period starts (RF-707)', new.key using errcode = '23514';
      end if;
      if new.effective_from <= v_now then
        raise exception 'parameter %: period % already started (RF-707)', new.key, new.effective_period_id using errcode = '23514';
      end if;
    elsif new.effective_from < v_now then
      raise exception 'parameter %: a new value does not take effect in the past (RF-707)', new.key using errcode = '23514';
    end if;
  elsif old.canceled_at is null and new.canceled_at is not null then
    if old.effective_from <= v_now or (v_affects and private.period_start(old.effective_period_id) <= v_now) then
      raise exception 'parameter %: a value already in force is not canceled (RF-707)', new.key using errcode = '23514';
    end if;
  end if;
  return null;
end
$$;
revoke all on function private.guard_payout_timing() from public;

-- El guardián de los tramos. Escribe solo el dueño de la tabla: desde dentro de una función suya (la
-- de los tramos) o la sesión del dueño; nadie de la aplicación tiene privilegios, y esto es la
-- segunda barrera. Un tramo nace vivo, con su autor y su hora puestos por la base; después solo se
-- cancela, una vez (también con autor y hora de la base). No se borra ni se vacía.
create function private.guard_pool_tier() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner text;
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception '%.%: pool tiers are not deleted', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner from pg_catalog.pg_class c where c.oid = tg_relid;
  if current_user <> v_owner and not (session_user = v_owner and pg_catalog.current_setting('role') = 'none') then
    raise exception '%.%: pool tiers are written by private.set_pool_tiers()', tg_table_schema, tg_table_name using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.canceled_at is not null or new.canceled_by is not null then
      raise exception '%.%: a pool tier is not born canceled', tg_table_schema, tg_table_name using errcode = '42501';
    end if;
    new.created_by := private.actor_id();
    new.created_at := pg_catalog.now();
    return new;
  end if;

  if old.canceled_at is not null or new.canceled_at is null
     or (pg_catalog.to_jsonb(new) - array['canceled_at', 'canceled_by'])
        is distinct from (pg_catalog.to_jsonb(old) - array['canceled_at', 'canceled_by']) then
    raise exception '%.%: a pool tier is only canceled, once', tg_table_schema, tg_table_name using errcode = '42501';
  end if;
  new.canceled_at := pg_catalog.now();
  new.canceled_by := private.actor_id();
  return new;
end
$$;
revoke all on function private.guard_pool_tier() from public;

-- El porcentaje base es el tramo de 0: una versión de `BOTE_PCT_BASE` (nueva o cancelada) la escribe
-- la función de los tramos o la sesión del dueño. El servidor, que puede insertar parámetros, no.
create function private.guard_pool_base_origin() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_owner text;
begin
  if new.key <> 'BOTE_PCT_BASE' or (tg_op = 'UPDATE' and new.canceled_at is not distinct from old.canceled_at) then
    return new;
  end if;
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner from pg_catalog.pg_class c where c.oid = tg_relid;
  if current_user <> v_owner and not (session_user = v_owner and pg_catalog.current_setting('role') = 'none') then
    raise exception 'parameter BOTE_PCT_BASE is the zero pool tier: private.set_pool_tiers() writes it' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function private.guard_pool_base_origin() from public;

-- ---------------------------------------------------------------------------------------
-- Los tramos marginales (RN-13).

-- Un juego de tramos que vale: umbrales y porcentajes del mismo largo, sin nulos, el primer umbral
-- en 0, los umbrales crecen, y los porcentajes van de 1 a 10 000 y no bajan al subir el umbral.
create function private.check_pool_tiers(p_thresholds integer[], p_bps integer[]) returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if p_thresholds is null or p_bps is null or pg_catalog.cardinality(p_thresholds) = 0
     or pg_catalog.cardinality(p_thresholds) <> pg_catalog.cardinality(p_bps)
     or pg_catalog.array_ndims(p_thresholds) <> 1 or pg_catalog.array_ndims(p_bps) <> 1 then
    raise exception 'pool tiers need thresholds and percentages of the same length' using errcode = '22023';
  end if;
  if exists (
    select 1
    from (select t.threshold, b.bps, t.o,
                 pg_catalog.lag(t.threshold) over (order by t.o) as previous_threshold,
                 pg_catalog.lag(b.bps) over (order by t.o) as previous_bps
          from pg_catalog.unnest(p_thresholds) with ordinality as t (threshold, o)
          join pg_catalog.unnest(p_bps) with ordinality as b (bps, o2) on b.o2 = t.o) x
    where x.threshold is null or x.bps is null or x.bps < 1 or x.bps > 10000
       or (x.o = 1 and x.threshold <> 0)
       or (x.o > 1 and (x.threshold <= x.previous_threshold or x.bps < x.previous_bps))) then
    raise exception 'pool tiers start at 0 students, with growing thresholds and percentages from 1 to 10000 that do not go down'
      using errcode = '22023';
  end if;
end
$$;
revoke all on function private.check_pool_tiers(integer[], integer[]) from public;

-- El porcentaje efectivo con `p_students` alumnos activos: se numeran del 1 al n, el alumno número u
-- ya va al tramo de umbral u, cada uno aporta el porcentaje de su tramo, y el efectivo es el promedio
-- hacia abajo al punto base (Sergio). Sin alumnos rige el tramo de 0. La suma va en `bigint`.
create function private.marginal_pool_bps(p_thresholds integer[], p_bps integer[], p_students integer) returns integer
language plpgsql immutable set search_path = ''
as $$
declare
  v_sum bigint;
begin
  if p_students is null or p_students < 0 then
    raise exception 'pool tiers need zero or more active students' using errcode = '22023';
  end if;
  perform private.check_pool_tiers(p_thresholds, p_bps);
  if p_students = 0 then
    return (select b.bps from pg_catalog.unnest(p_bps) with ordinality as b (bps, o) order by b.o limit 1);
  end if;
  select pg_catalog.sum(greatest(0::bigint, least(coalesce(x.next_threshold - 1, p_students), p_students)::bigint
                                            - greatest(x.threshold, 1) + 1) * x.bps)
  into v_sum
  from (select t.threshold, b.bps, pg_catalog.lead(t.threshold) over (order by t.o) as next_threshold
        from pg_catalog.unnest(p_thresholds) with ordinality as t (threshold, o)
        join pg_catalog.unnest(p_bps) with ordinality as b (bps, o2) on b.o2 = t.o) x;
  return (v_sum / p_students)::integer;
end
$$;
revoke all on function private.marginal_pool_bps(integer[], integer[], integer) from public;

-- El juego vivo de un periodo: el de mayor `effective_period_id` hasta él, sin los cancelados. Nulos
-- si no hay.
create function private.pool_tiers_for(p_period public.period_id, out thresholds integer[], out bps integer[])
language sql stable set search_path = ''
as $$
  select pg_catalog.array_agg(t.min_active_students order by t.min_active_students),
         pg_catalog.array_agg(t.pool_bps::integer order by t.min_active_students)
  from public.pool_tiers t
  where t.canceled_at is null
    and t.effective_period_id = (select max(x.effective_period_id) from public.pool_tiers x
                                 where x.canceled_at is null and x.effective_period_id <= p_period)
$$;
revoke all on function private.pool_tiers_for(public.period_id) from public;

-- Escribir el juego de un periodo: lo valida entero (y contra `BOTE_PCT_TECHO` de su periodo: sin
-- techo no se adivina), cancela el que hubiera en ese periodo y escribe el nuevo; si el tramo de 0
-- cambia, escribe también la versión de `BOTE_PCT_BASE` del periodo. RF-707: si el periodo ya
-- empezó, lanza, salvo en la sesión del dueño. Un juego a la vez (candado consultivo antes de leer),
-- solo en read committed: el segundo espera al primero y tiene que ver lo que confirmó. Como quien
-- actúa: la base exige configuración o el sistema. Nadie de la aplicación la ejecuta todavía (PA-85).
create function private.set_pool_tiers(p_period public.period_id, p_thresholds integer[], p_bps integer[]) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_start timestamptz;
  v_ceiling jsonb;
  v_zero integer;
  v_owner_session boolean;
begin
  if p_period is null then
    raise exception 'pool tiers need a period' using errcode = '22023';
  end if;
  perform private.check_pool_tiers(p_thresholds, p_bps);
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.set_pool_tiers() needs read committed isolation' using errcode = '25000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('pool_tiers', 0));

  v_owner_session := pg_catalog.current_setting('role') = 'none'
    and session_user = (select pg_catalog.pg_get_userbyid(c.relowner) from pg_catalog.pg_class c where c.oid = 'public.pool_tiers'::regclass);
  v_start := private.period_start(p_period);
  if v_start <= pg_catalog.clock_timestamp() and not v_owner_session then
    raise exception 'pool tiers of period % do not change: the period already started (RF-707)', p_period using errcode = '23514';
  end if;
  v_ceiling := private.period_parameter('BOTE_PCT_TECHO', p_period);
  if pg_catalog.jsonb_typeof(v_ceiling) is distinct from 'number' or (v_ceiling)::text !~ '^[0-9]{1,5}$' then
    raise exception 'BOTE_PCT_TECHO is not set for period %', p_period using errcode = 'P0001';
  end if;
  if exists (select 1 from pg_catalog.unnest(p_bps) b where b > (v_ceiling)::text::integer) then
    raise exception 'pool tiers of period % go above BOTE_PCT_TECHO', p_period using errcode = '22023';
  end if;

  update public.pool_tiers t set canceled_at = pg_catalog.now()
  where t.effective_period_id = p_period and t.canceled_at is null;
  insert into public.pool_tiers (effective_period_id, min_active_students, pool_bps)
  select p_period, t.threshold, b.bps
  from pg_catalog.unnest(p_thresholds) with ordinality as t (threshold, o)
  join pg_catalog.unnest(p_bps) with ordinality as b (bps, o2) on b.o2 = t.o;

  -- El tramo de 0 es el porcentaje base: si no es el que rige en el periodo, la versión de ese
  -- periodo (si la había) se cancela y se escribe la nueva, desde su inicio.
  v_zero := (select b.bps from pg_catalog.unnest(p_bps) with ordinality as b (bps, o) order by b.o limit 1);
  if private.period_parameter('BOTE_PCT_BASE', p_period) is distinct from pg_catalog.to_jsonb(v_zero) then
    update public.business_parameters b set canceled_at = pg_catalog.now(), canceled_by = private.actor_id()
    where b.key = 'BOTE_PCT_BASE' and b.effective_from = v_start and b.canceled_at is null;
    insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
    values ('BOTE_PCT_BASE', pg_catalog.to_jsonb(v_zero), 'decided', v_start, p_period);
  end if;
end
$$;
revoke all on function private.set_pool_tiers(public.period_id, integer[], integer[]) from public;

create trigger pool_tiers_actor before insert or update on public.pool_tiers
  for each row execute function private.guard_config_actor();
create trigger pool_tiers_guard before insert or update or delete on public.pool_tiers
  for each row execute function private.guard_pool_tier();
create trigger pool_tiers_no_truncate before truncate on public.pool_tiers
  for each statement execute function private.guard_pool_tier();
create constraint trigger pool_tiers_timing after insert or update on public.pool_tiers
  deferrable initially deferred for each row execute function private.guard_payout_timing();
-- Cambiar un tramo deja rastro, como cambiar un parámetro.
create trigger audit_changes after insert or update on public.pool_tiers
  for each row execute function private.audit_row_change('config');

-- Los disparadores «before» corren en orden alfabético: el origen va después de quién, qué y el código.
create trigger business_parameters_origin before insert or update on public.business_parameters
  for each row execute function private.guard_pool_base_origin();
create constraint trigger business_parameters_timing after insert or update on public.business_parameters
  deferrable initially deferred for each row execute function private.guard_payout_timing();

-- ---------------------------------------------------------------------------------------
-- Los alumnos activos (RN-13).

-- Las cuentas que en un instante tenían acceso por suscripción o por gracia (RN-01, la lectura de
-- `account-access.ts`): activas y sin suspensión por fraude (una suspendida por otra causa tampoco
-- tiene acceso), con ALGUNA suscripción que no esté pendiente, creada en o antes del instante, que
-- entonces daba acceso. No la sola que elige la regla de acceso, que mira el estado de ahora: en un
-- instante pasado, una suscripción nueva ya vencida taparía a una vieja con días pagados.
--   · Pagada: el instante es anterior a su fin pagado.
--   · En gracia: su renovación falló en o antes del instante, después de un periodo pagado, y el
--     instante está a menos de `GRACIA_COBRO_DIAS` de la falla (el valor de la hora de la falla, en
--     días de 24 horas). Sin ese parámetro no se sabe: lanza (en TypeScript es «no se supo»).
--   · `ended_at` corta las dos. Las cortesías no cuentan.
-- Límite: `subscriptions` y `profiles` guardan el estado de ahora, no el de entonces.
create function private.active_students_at(p_at timestamptz) returns integer
language plpgsql stable set search_path = ''
as $$
declare
  v_count integer;
  v_unknown boolean;
begin
  if p_at is null or not pg_catalog.isfinite(p_at) then
    raise exception 'active students need an instant' using errcode = '22023';
  end if;
  with candidates as (
    select s.profile_id, s.current_period_end, s.ended_at,
           s.last_renewal_failed_at is not null and s.last_renewal_failed_at <= p_at as failed,
           case when s.last_renewal_failed_at <= p_at and pg_catalog.jsonb_typeof(g.days) = 'number' and (g.days)::text ~ '^[0-9]{1,5}$'
                then s.last_renewal_failed_at + pg_catalog.make_interval(hours => 24 * (g.days)::text::integer) end as grace_until
    from public.subscriptions s
    join public.profiles p on p.id = s.profile_id
    cross join lateral (select private.parameter_value('GRACIA_COBRO_DIAS', s.last_renewal_failed_at) as days) g
    where p.status = 'active' and not p.suspended_for_fraud
      and s.status <> 'pending' and s.created_at <= p_at and s.current_period_end is not null)
  select pg_catalog.count(distinct c.profile_id) filter (
           where (p_at < c.current_period_end or p_at < c.grace_until) and (c.ended_at is null or p_at < c.ended_at)),
         coalesce(pg_catalog.bool_or(c.failed and c.grace_until is null), false)
  into v_count, v_unknown
  from candidates c;
  if v_unknown then
    raise exception 'GRACIA_COBRO_DIAS is not set at a renewal failure before %', p_at using errcode = 'P0001';
  end if;
  return v_count;
end
$$;
revoke all on function private.active_students_at(timestamptz) from public;

-- ---------------------------------------------------------------------------------------
-- El porcentaje de un periodo.

-- Con `p_students` alumnos activos: la regla de los tramos y la del sin consumo que este cálculo sigue
-- (otra lanza, no se adivina), los tramos marginales del juego vivo (sin juego, lanza), y no baja
-- (RN-13): si el periodo anterior tiene fila y juego, el mayor entre este y el suyo (casi siempre
-- guardado: un nivel). Lo usan la foto y `pool_bps`.
create function private.effective_pool_bps(p_period public.period_id, p_students integer) returns integer
language plpgsql stable set search_path = ''
as $$
declare
  v_tiers record;
  v_bps integer;
  v_previous public.period_id := private.period_plus(p_period, -1);
begin
  if private.period_parameter('BOTE_REGLA_TRAMO', p_period) is distinct from '"marginal_tiers"'::jsonb then
    raise exception 'pool for period % has an unknown BOTE_REGLA_TRAMO', p_period using errcode = 'P0001';
  end if;
  -- Sin la regla también lanza: nulo es distinto de la que sigue este cálculo (PQ-06).
  if private.period_parameter('BOTE_SIN_CONSUMO', p_period) is distinct from '"proportional_to_assigned_pool"'::jsonb then
    raise exception 'pool for period % has an unknown BOTE_SIN_CONSUMO', p_period using errcode = 'P0001';
  end if;
  select * into v_tiers from private.pool_tiers_for(p_period) t;
  if v_tiers.thresholds is null then
    raise exception 'pool tiers are not set for period %', p_period using errcode = 'P0001';
  end if;
  v_bps := private.marginal_pool_bps(v_tiers.thresholds, v_tiers.bps, p_students);
  if exists (select 1 from public.payout_periods p where p.period_id = v_previous)
     and (select t.thresholds from private.pool_tiers_for(v_previous) t) is not null then
    v_bps := greatest(v_bps, private.pool_bps(v_previous));
  end if;
  return v_bps;
end
$$;
revoke all on function private.effective_pool_bps(public.period_id, integer) from public;

-- El porcentaje del bote de un periodo (RN-13): el guardado por la foto; si no, el de sus alumnos
-- activos, los de la foto o, sin ella, los de ahora o los de su último instante si ya terminó (solo
-- pasa entre el fin del mes y la corrida, o si la foto falló: así el periodo no pasa a cierre). La
-- alerta, el estimado y el cierre leen el mismo número. Reemplaza al de T-407, que leía
-- `BOTE_PCT_BASE`.
create or replace function private.pool_bps(p_period public.period_id) returns integer
language plpgsql stable set search_path = ''
as $$
declare
  v_row record;
  v_end timestamptz;
begin
  select p.pool_bps, p.active_students, p.ends_at into v_row from public.payout_periods p where p.period_id = p_period;
  if found and v_row.pool_bps is not null then
    return v_row.pool_bps;
  end if;
  if found and v_row.active_students is not null then
    return private.effective_pool_bps(p_period, v_row.active_students);
  end if;
  v_end := case when found then v_row.ends_at else (select b.ends_at from private.period_bounds(p_period) b) end;
  return private.effective_pool_bps(p_period, private.active_students_at(least(pg_catalog.now(), v_end - interval '1 microsecond')));
end
$$;

-- ---------------------------------------------------------------------------------------
-- La foto.

-- A cada periodo abierto o en cierre que ya terminó y no la tiene: sus alumnos activos en su último
-- instante y su porcentaje (nulo si no tiene juego de tramos, como los de antes del arranque), en
-- orden y cada uno en su bloque: el porcentaje de uno lee el del anterior. Como el sistema: queda en
-- la auditoría. La llama la corrida de cada noche al empezar. Devuelve {taken} y, si falló alguna,
-- `failed`.
create function private.period_photos() returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_kind text := pg_catalog.current_setting('app.actor_kind', true);
  v_period record;
  v_students integer;
  v_bps integer;
  v_taken integer[] := '{}';
  v_failed jsonb := '{}'::jsonb;
begin
  perform pg_catalog.set_config('app.actor_kind', 'system', true);
  for v_period in
    select p.period_id, p.ends_at from public.payout_periods p
    where p.active_students is null and p.status in ('open', 'closing') and p.ends_at <= pg_catalog.now()
    order by p.period_id
  loop
    begin
      v_students := private.active_students_at(v_period.ends_at - interval '1 microsecond');
      v_bps := case when (select t.thresholds from private.pool_tiers_for(v_period.period_id) t) is not null
                    then private.effective_pool_bps(v_period.period_id, v_students) end;
      update public.payout_periods p set active_students = v_students, pool_bps = v_bps where p.period_id = v_period.period_id;
      v_taken := v_taken || v_period.period_id::integer;
    exception when others then
      v_failed := v_failed || pg_catalog.jsonb_build_object(v_period.period_id::text, sqlstate || ': ' || pg_catalog.left(sqlerrm, 200));
    end;
  end loop;
  perform pg_catalog.set_config('app.actor_kind', coalesce(v_kind, ''), true);
  return pg_catalog.jsonb_build_object('taken', pg_catalog.to_jsonb(v_taken))
    || case when v_failed = '{}'::jsonb then '{}'::jsonb else pg_catalog.jsonb_build_object('failed', v_failed) end;
end
$$;
revoke all on function private.period_photos() from public;

-- El guardián (`t601_periodos`), con la foto: el periodo nace sin ella, y el sistema la escribe una
-- vez, sus alumnos y su porcentaje juntos (el porcentaje puede quedar nulo), a un periodo que ya
-- terminó y sin cambiar su estado. Lo demás no cambia.
create or replace function private.guard_payout_period() returns trigger
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
    if new.status not in ('open', 'closing') or new.carried_in_cents <> 0 or new.active_students is not null or new.pool_bps is not null then
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

-- El paso a cierre (`t601_periodos`), con la foto: un periodo que llegó a su día y se consolidó, pero
-- no tiene foto, se queda abierto y se dice (`photo_missing`): la corrida termina fallida y lo intenta
-- la noche siguiente. Lo demás no cambia.
create or replace function private.period_transition(p_consolidated public.period_id[]) returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_kind text := pg_catalog.current_setting('app.actor_kind', true);
  v_current public.period_id;
  v_month integer;
  v_opened integer[] := '{}';
  v_due integer[];
  v_closing integer[];
  v_missing integer[];
  v_failed jsonb := '{}'::jsonb;
begin
  perform pg_catalog.set_config('app.actor_kind', 'system', true);
  v_due := array(select p.period_id from public.payout_periods p
                 where p.status = 'open' and private.period_reached_closing(p.period_id) order by 1);
  v_missing := array(select p.period_id from public.payout_periods p
                     where p.period_id = any (v_due) and p.period_id = any (p_consolidated) and p.active_students is null order by 1);
  with moved as (
    update public.payout_periods p set status = 'closing'
    where p.status = 'open' and p.period_id = any (v_due) and p.period_id = any (p_consolidated) and p.active_students is not null
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
    || case when v_failed = '{}'::jsonb then '{}'::jsonb else pg_catalog.jsonb_build_object('open_failed', v_failed) end
    || case when pg_catalog.cardinality(v_missing) = 0 then '{}'::jsonb else pg_catalog.jsonb_build_object('photo_missing', pg_catalog.to_jsonb(v_missing)) end;
end
$$;

-- La corrida de cada noche (`t601_periodos`), con la foto: al empezar la corrida completa (no la de un
-- solo periodo), antes de consolidar y de detectar, toma la foto de los periodos que terminaron, y
-- confirma. Lo que hizo va en la corrida del paso a cierre (`photos`), que termina fallida si una foto
-- falló o si un periodo llegó a su día sin ella. Lo demás no cambia.
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
  v_photos jsonb;
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

  -- La foto de los periodos que terminaron, antes de consolidar y de detectar: la alerta y el cierre
  -- leen el mismo porcentaje.
  if p_period is null then
    begin
      v_photos := private.period_photos();
    exception when others then
      v_photos := pg_catalog.jsonb_build_object('photos_failed', sqlstate || ': ' || pg_catalog.left(sqlerrm, 200));
    end;
    commit;
  end if;

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
    v_error := nullif(pg_catalog.array_to_string(array[
      v_error,
      case when v_transition ? 'open_failed' then 'open failed: ' || pg_catalog.left((v_transition -> 'open_failed')::text, 250) end,
      case when v_photos ? 'failed' then 'photos failed: ' || pg_catalog.left((v_photos -> 'failed')::text, 250) end,
      case when v_photos ? 'photos_failed' then 'photos failed: ' || (v_photos ->> 'photos_failed') end,
      case when v_transition ? 'photo_missing' then 'photo missing: ' || (v_transition -> 'photo_missing')::text end], '; '), '');
    insert into public.job_runs (job, status, started_at, heartbeat_at, finished_at, details, error)
    values ('period_transition', case when v_error is null then 'succeeded' else 'failed' end::public.run_status,
            v_transition_start, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
            coalesce(v_transition, '{}'::jsonb) || pg_catalog.jsonb_build_object('photos', v_photos), v_error);
    commit;
  end if;
  perform pg_catalog.set_config('search_path', v_path, false);
end
$$;

-- ---------------------------------------------------------------------------------------
-- El vigilante: el área de los periodos (`t601_periodos`), con los tramos. Nadie de la aplicación
-- toca las dos tablas ni ejecuta sus funciones, salvo `period_start`, que el servidor necesita para
-- RF-707 al confirmar. `security definer` solo `period_start` y `set_pool_tiers`, y todas con el
-- `search_path` fijo. Sus disparadores están y prendidos, y los de RF-707, diferidos.

create or replace function private.schema_violations_periods()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  period_functions (name, definer, server) as (
    values ('month_bounds', false, false), ('period_zone', false, false), ('period_bounds', false, false),
           ('period_closing_at', false, false), ('period_reached_closing', false, false), ('period_status_of', false, false),
           ('open_period', false, false), ('period_transition', false, false), ('allocation_start', false, false),
           ('guard_payout_period', false, false), ('guard_frozen_period', false, false),
           ('period_start', true, true), ('guard_payout_timing', false, false), ('guard_pool_tier', false, false),
           ('guard_pool_base_origin', false, false), ('check_pool_tiers', false, false), ('marginal_pool_bps', false, false),
           ('pool_tiers_for', false, false), ('set_pool_tiers', true, false), ('active_students_at', false, false),
           ('effective_pool_bps', false, false), ('period_photos', false, false)),
  found as (
    select f.name, f.definer, f.server, p.oid, p.prosecdef, p.proconfig
    from period_functions f
    join pg_catalog.pg_proc p on p.proname = f.name
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private'),
  period_triggers (table_name, trigger_name, function_name, deferred) as (
    values ('public.payout_periods', 'payout_periods_guard', 'guard_payout_period', false),
           ('public.payout_periods', 'payout_periods_no_truncate', 'guard_payout_period', false),
           ('public.payout_periods', 'audit_changes', 'audit_row_change', false),
           ('public.charges', 'charges_frozen', 'guard_frozen_period', false),
           ('public.revenue_allocations', 'revenue_allocations_frozen', 'guard_frozen_period', false),
           ('public.consumption_exclusions', 'consumption_exclusions_frozen', 'guard_frozen_period', false),
           ('public.anomaly_alerts', 'anomaly_alerts_frozen', 'guard_frozen_period', false),
           ('public.pool_tiers', 'pool_tiers_actor', 'guard_config_actor', false),
           ('public.pool_tiers', 'pool_tiers_guard', 'guard_pool_tier', false),
           ('public.pool_tiers', 'pool_tiers_no_truncate', 'guard_pool_tier', false),
           ('public.pool_tiers', 'audit_changes', 'audit_row_change', false),
           ('public.pool_tiers', 'pool_tiers_timing', 'guard_payout_timing', true),
           ('public.business_parameters', 'business_parameters_origin', 'guard_pool_base_origin', false),
           ('public.business_parameters', 'business_parameters_timing', 'guard_payout_timing', true))
  select 'period table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.payout_periods'), ('public.pool_tiers')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  select 'period function missing', 'private.' || f.name
  from period_functions f
  where not exists (select 1 from found where found.name = f.name)
  union all
  select 'period function executable by ' || r.rolname, found.oid::regprocedure::text
  from app_roles r cross join found
  where pg_catalog.has_function_privilege(r.rolname::name, found.oid, 'EXECUTE')
    and not (found.server and r.rolname = 'app_service')
  union all
  select 'period function not executable by app_service', found.oid::regprocedure::text
  from found
  where found.server and not pg_catalog.has_function_privilege('app_service', found.oid, 'EXECUTE')
  union all
  select 'period function security definer or without fixed search_path', found.oid::regprocedure::text
  from found
  where (found.prosecdef and not found.definer) or not coalesce(found.proconfig, '{}') @> array['search_path=""']
  union all
  select 'period function not security definer', found.oid::regprocedure::text
  from found
  where found.definer and not found.prosecdef
  union all
  select 'period trigger missing or disabled: ' || g.trigger_name, g.table_name
  from period_triggers g
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = g.table_name::regclass and tg.tgname = g.trigger_name and tg.tgenabled in ('O', 'A')
      and n.nspname = 'private' and p.proname = g.function_name)
  union all
  select 'period trigger not deferred: ' || g.trigger_name, g.table_name
  from period_triggers g
  join pg_catalog.pg_trigger tg on tg.tgrelid = g.table_name::regclass and tg.tgname = g.trigger_name
  where g.deferred and (tg.tgconstraint = 0 or not tg.tgdeferrable or not tg.tginitdeferred)
$$;
