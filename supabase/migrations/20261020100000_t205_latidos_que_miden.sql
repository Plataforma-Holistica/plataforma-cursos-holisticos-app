-- T-205 · Latidos que miden (RF-401 a RF-404; 05 §5.4, §9.2, §9.5 y §13.2; TRD §5.3 y §6.2).
-- Decisiones de Sergio del 2026-10-19: el último tramo al cerrar la pestaña se guarda en el
-- navegador y sale la próxima vez (sin ruta propia), y una lección retirada a media sesión deja
-- de contar desde que se retira (lo visto se guarda sin puntos). Se monta sobre T-204.
--
-- El reproductor manda tramos vistos con un consecutivo por reproducción. Los recibe una sola
-- función, `private.record_heartbeats()`, que los revisa uno por uno contra la lección y contra
-- el reloj de la reproducción y guarda los buenos en `watch_events`, el libro de solo inserción
-- del que sale el reparto. Nadie de la aplicación toca el libro: ni para escribir ni para leer.
--
-- Tres cosas cambian respecto del esquema escrito (05):
--   · la revisión contra el reloj usa el tiempo vivo de la reproducción (`live_seconds`, que
--     suma la presencia), no el tiempo desde que empezó: un dispositivo que deja de latir
--     mientras otro ve no junta tiempo para vaciarlo después (05 §15 A1);
--   · el veredicto es por tramo y la función nunca lanza por un tramo malo: lanzar abortaría la
--     transacción entera con la presencia, y sin presencia el límite de una a la vez se cae.
--     Cualquier otra falla se ataja en un bloque de excepción y contesta `failed`;
--   · la base calcula si un tramo cuenta (visible y a no más de `VELOCIDAD_MAX`), y lo que
--     dice TypeScript del acceso solo puede bajarlo.

-- ---------------------------------------------------------------------------------------
-- El tiempo vivo de una reproducción: lo que la presencia vio latir. Cada latido de presencia
-- suma lo que pasó desde el anterior, a lo más una ventana (tres `LATIDO_SEGUNDOS`). Es la
-- base del presupuesto de segundos que una reproducción puede declarar.

alter table public.playback_sessions add column live_seconds numeric(12, 3) not null default 0;
alter table public.playback_sessions
  add constraint playback_sessions_live_positive check (live_seconds >= 0);
comment on column public.playback_sessions.live_seconds is 'Segundos vivos (T-205): lo que sumó la presencia, a lo más una ventana por latido. Con VELOCIDAD_MAX, el tope de lo que la reproducción puede declarar visto.';
comment on table public.playback_sessions is 'Una fila por reproducción (RF-107, RF-401). La escriben solo private.open_playback(), private.touch_playback() (T-204) y private.record_heartbeats() (T-205).';
grant select (live_seconds) on public.playback_sessions to authenticated;

-- La presencia de T-204, con el tiempo vivo. Lo demás no cambia.
create or replace function private.touch_playback(p_session uuid)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_auth uuid := private.actor_session();
  v_row public.playback_sessions%rowtype;
  v_limits record;
  v_window interval;
  v_live jsonb;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.touch_playback() needs read committed isolation' using errcode = '25000';
  end if;
  if v_actor is null or v_auth is null then
    return null;
  end if;

  v_limits := private.playback_limits();
  v_window := pg_catalog.make_interval(secs => 3 * v_limits.heartbeat_seconds);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('playback:' || v_actor::text, 0));

  select * into v_row from public.playback_sessions s
  where s.id = p_session and s.profile_id = v_actor and s.auth_session_id = v_auth
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;
  if v_row.revoked_at is not null then
    return pg_catalog.jsonb_build_object('outcome', 'revoked', 'reason', v_row.revoke_reason, 'by', v_row.revoked_by);
  end if;

  -- Vencida (una pausa larga, una pestaña congelada): vuelve a pasar por el cupo.
  if v_row.last_heartbeat_at <= pg_catalog.now() - v_window then
    v_live := private.live_playbacks(v_actor, v_auth, v_window);
    if pg_catalog.jsonb_array_length(v_live) >= v_limits.max_live then
      return pg_catalog.jsonb_build_object('outcome', 'busy', 'live', v_live);
    end if;
  end if;

  -- Lo que pasó desde el latido anterior cuenta como vivo, a lo más una ventana: la que venció
  -- y vuelve solo trae su última ventana, no todo lo que estuvo callada.
  update public.playback_sessions s
  set live_seconds = s.live_seconds + extract(epoch from
        greatest(least(pg_catalog.now() - s.last_heartbeat_at, v_window), interval '0')),
      last_heartbeat_at = pg_catalog.now()
  where s.id = p_session;
  return pg_catalog.jsonb_build_object('outcome', 'ok');
end
$$;

-- ---------------------------------------------------------------------------------------
-- El libro (05 §5.4). Una fila por tramo aceptado, particionada por periodo. Sin claves
-- foráneas: lo escribe una sola función, que ya leyó y bloqueó la reproducción. La clave
-- incluye el periodo (Postgres lo exige en una tabla particionada); lo que manda contra un
-- reenvío es `seqs_received`, que también cubre el que cruza de mes.

create table public.watch_events (
  period_id public.period_id not null,        -- el mes del tope del reloj, en ZONA_HORARIA_PERIODO
  playback_session_id uuid not null,
  seq integer not null,                       -- consecutivo dentro de la reproducción
  profile_id uuid not null,
  lesson_id uuid not null,
  from_second integer not null,               -- tramo reproducido: [from_second, to_second)
  to_second integer not null,
  playback_rate numeric(3, 2) not null,
  was_visible boolean not null,
  qualifies boolean not null,                 -- visible y a no más de VELOCIDAD_MAX: sirve al progreso
  counts_for_payout boolean not null,         -- qualifies, y además la reproducción y el acceso cuentan (RF-403)
  received_at timestamptz not null default now(),
  constraint watch_events_pk primary key (period_id, playback_session_id, seq),
  constraint watch_events_seq_range check (seq between 0 and 1000000),
  constraint watch_events_interval check (from_second >= 0 and to_second > from_second),
  constraint watch_events_rate_positive check (playback_rate > 0),
  constraint watch_events_counts_implies_qualifies check (not counts_for_payout or qualifies)
) partition by list (period_id);
comment on table public.watch_events is 'Libro de latidos (RF-404). Solo inserción, y solo por private.record_heartbeats(). Una partición por periodo (ADR-23).';
-- El único índice además de la clave: lo usará la consolidación (T-207).
create index watch_events_rollup_idx on public.watch_events (period_id, profile_id, lesson_id);

alter table public.watch_events enable row level security;
revoke all on public.watch_events from public, anon, authenticated, service_role, app_service;

-- El disparador por fila pasa solo a cada partición; el de vaciar no, y cada partición lleva el
-- suyo (abajo).
create trigger ledger_no_update_delete before update or delete on public.watch_events
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on public.watch_events
  for each statement execute function private.reject_mutation();

-- ---------------------------------------------------------------------------------------
-- Las particiones (05 §13.2). Una por mes, creada antes de que haga falta. Sin partición por
-- omisión: un tramo sin mes no entra, y la función lo contesta como `failed` sin tumbar nada.
--
-- Crear la tabla suelta y unirla después toma un candado más débil sobre el libro que crearla
-- como partición: no detiene los latidos que estén entrando. Con `lock_timeout`, si algo largo
-- tiene el libro, se rinde y la corrida de mañana lo vuelve a intentar.

create function private.create_watch_partition(p_period public.period_id) returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_name text := 'watch_events_' || p_period::text;
begin
  -- Dos corridas a la vez no crean la misma.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('watch_partitions', 0));
  if exists (
    select 1 from pg_catalog.pg_inherits i
    join pg_catalog.pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.watch_events'::regclass and c.relname = v_name) then
    return false;
  end if;
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  execute pg_catalog.format(
    'create table public.%I (like public.watch_events including defaults including constraints)', v_name);
  execute pg_catalog.format('alter table public.%I enable row level security', v_name);
  execute pg_catalog.format('revoke all on public.%I from public, anon, authenticated, service_role, app_service', v_name);
  execute pg_catalog.format(
    'create trigger ledger_no_truncate before truncate on public.%I for each statement execute function private.reject_mutation()',
    v_name);
  execute pg_catalog.format('alter table public.watch_events attach partition public.%I for values in (%s)',
                            v_name, p_period::integer);
  return true;
end
$$;

-- Del mes anterior a `p_months` adelante, en la zona dada o en ZONA_HORARIA_PERIODO (UTC si
-- no está). Contesta cuántas creó. La migración la llama en UTC, porque los parámetros se
-- siembran después; de ahí en adelante, `pg_cron` cada día.
create function private.ensure_watch_partitions(p_months integer, p_zone text default null) returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_zone text := coalesce(p_zone, private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}', 'UTC');
  v_first date;
  v_created integer := 0;
begin
  if p_months is null or p_months < 0 or p_months > 24 then
    raise exception 'months ahead must be between 0 and 24' using errcode = '22023';
  end if;
  v_first := (pg_catalog.date_trunc('month', pg_catalog.timezone(v_zone, pg_catalog.now())) - interval '1 month')::date;
  for i in 0 .. p_months + 1 loop
    if private.create_watch_partition(
         pg_catalog.to_char(v_first + pg_catalog.make_interval(months => i), 'YYYYMM')::integer) then
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end
$$;

revoke all on function private.create_watch_partition(public.period_id), private.ensure_watch_partitions(integer, text) from public;

select private.ensure_watch_partitions(2, 'UTC');

-- El mantenimiento diario, dentro de la base, hasta que haya trabajos programados (05 §13).
-- Corre como el dueño de la base. Programarlo otra vez con el mismo nombre lo reemplaza.
create extension if not exists pg_cron;
select cron.schedule('watch_partitions', '17 9 * * *', 'select private.ensure_watch_partitions(2)');

-- ---------------------------------------------------------------------------------------
-- Los rechazos: el tramo rechazado no se guarda, se cuenta por cuenta, día y motivo (RF-402,
-- RF-406). Sin clave foránea a `profiles`: es una tabla muy escrita, y quien la escribe ya
-- sabe que la cuenta existe. `session_revoked` queda para cuando el equipo revoque por fraude.

create table private.heartbeat_rejection_counts (
  day date not null,                          -- en ZONA_HORARIA_PERIODO
  profile_id uuid not null,
  reason text not null,
  rejections integer not null,
  constraint heartbeat_rejection_counts_pk primary key (day, profile_id, reason),
  constraint heartbeat_rejection_counts_reason_known
    check (reason in ('out_of_range', 'faster_than_clock', 'session_revoked')),
  constraint heartbeat_rejection_counts_positive check (rejections > 0)
);
comment on table private.heartbeat_rejection_counts is 'Tramos rechazados por cuenta, día y motivo (RF-402, RF-406). La escribe solo private.record_heartbeats().';
alter table private.heartbeat_rejection_counts enable row level security;
revoke all on private.heartbeat_rejection_counts from public, anon, authenticated, service_role, app_service;

-- ---------------------------------------------------------------------------------------
-- Quién escribe en una reproducción: la cuenta que la abrió y, si sigue viva, desde la misma
-- sesión de Auth. Lo atrasado de otra sesión de la misma cuenta entra solo si la reproducción
-- ya terminó (revocada) o su sesión ya no existe: es lo que el navegador guardó y manda al
-- volver a entrar. Así el id de una reproducción viva, que PA-34 le muestra a otro
-- dispositivo, no le sirve para escribir en ella.
--
-- El tope del reloj: ahora, o la revocación, o la última presencia más una ventana, lo que
-- llegue primero. Es la hora con la que se decide el acceso y el mes del tramo.

-- Lo que el servidor necesita antes de registrar: la lección y el tope. Contesta (nula si no
-- hay quien actúe o no declaró su sesión):
--   {outcome: 'found', lesson_id, at}
--   {outcome: 'not_found'}            no existe, o no la puede escribir quien actúa
create function private.heartbeat_target(p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_auth uuid := private.actor_session();
  v_window interval;
  v_row record;
begin
  if v_actor is null or v_auth is null then
    return null;
  end if;
  v_window := pg_catalog.make_interval(secs => 3 * (private.playback_limits()).heartbeat_seconds);
  select s.lesson_id, least(pg_catalog.now(), s.revoked_at, s.last_heartbeat_at + v_window) as top
    into v_row
  from public.playback_sessions s
  where s.id = p_session and s.profile_id = v_actor
    and (s.auth_session_id = v_auth or s.revoked_at is not null
         or not exists (select 1 from private.app_sessions a where a.session_id = s.auth_session_id));
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'found', 'lesson_id', v_row.lesson_id, 'at', v_row.top);
end
$$;

-- Registrar un lote (05 §9.2). `p_events` es un arreglo de a lo más 50 tramos
-- `{seq, from, to, rate, visible}`; `p_access_counts`, si el acceso de la cuenta a esa hora
-- cuenta para el reparto, como lo decidió TypeScript (nunca sube lo que la reproducción ya dice).
--
-- Cada tramo, en orden de consecutivo (si se repite en el lote, manda el primero):
--   · ya recibido: repetido;
--   · forma imposible (consecutivo fuera de 0 a 10⁶, segundos que no son enteros o no avanzan,
--     velocidad fuera de (0, 9.99], visibilidad que no es sí o no): `out_of_range`;
--   · más allá de la duración: hasta 2 s se recorta (el redondeo de la duración); más, `out_of_range`;
--   · lo aceptado más el tramo no cabe en el presupuesto: `faster_than_clock`;
--   · si no, se guarda en el mes del tope.
-- Todo consecutivo visto, aceptado o no, queda recibido: un rechazo reenviado no se cuenta dos
-- veces. No toca la presencia (`last_heartbeat_at`, `live_seconds`): ya corrió antes.
--
-- Contesta (nula si no hay quien actúe o no declaró su sesión):
--   {outcome: 'recorded', accepted: [seq], duplicate: [seq], rejected: [{seq, reason}]}
--   {outcome: 'not_found'}             no existe, o no la puede escribir quien actúa
--   {outcome: 'failed', code}          nada se registró (falta la partición, un parámetro…)

create function private.record_heartbeats(p_session uuid, p_events jsonb, p_access_counts boolean)
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
  v_reason text;
  v_inserted integer;
  v_accepted integer[] := '{}';
  v_duplicate integer[] := '{}';
  v_rejected jsonb := '[]';
  v_out_of_range integer := 0;
  v_too_fast integer := 0;
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
    v_period := pg_catalog.to_char(pg_catalog.timezone(v_zone, v_top), 'YYYYMM')::integer;
    v_budget := (v_row.live_seconds
                 + greatest(extract(epoch from v_top - v_row.last_heartbeat_at), 0)) * v_max_rate + 5;
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
      insert into public.watch_events (
        period_id, playback_session_id, seq, profile_id, lesson_id, from_second, to_second,
        playback_rate, was_visible, qualifies, counts_for_payout)
      values (
        v_period, p_session, v_seq, v_row.profile_id, v_row.lesson_id, v_from, v_to,
        v_rate, v_visible, v_qualifies, v_qualifies and v_row.counts_for_payout and coalesce(p_access_counts, false))
      on conflict (period_id, playback_session_id, seq) do nothing;
      get diagnostics v_inserted = row_count;
      if v_inserted = 0 then
        -- Ya estaba, aunque `seqs_received` no lo dijera: la clave es la segunda defensa.
        v_duplicate := v_duplicate || v_seq;
      else
        v_accepted := v_accepted || v_seq;
        v_media := v_media + (v_to - v_from);
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

    return pg_catalog.jsonb_build_object('outcome', 'recorded', 'accepted', pg_catalog.to_jsonb(v_accepted),
                                         'duplicate', pg_catalog.to_jsonb(v_duplicate), 'rejected', v_rejected);
  exception when others then
    return pg_catalog.jsonb_build_object('outcome', 'failed', 'code', sqlstate);
  end;
end
$$;

revoke all on function private.heartbeat_target(uuid), private.record_heartbeats(uuid, jsonb, boolean) from public;
grant execute on function private.heartbeat_target(uuid), private.record_heartbeats(uuid, jsonb, boolean) to app_service;

-- ---------------------------------------------------------------------------------------
-- El vigilante aprende el libro de latidos: ningún rol de la aplicación lo toca, ni a ninguna
-- de sus particiones (que no salen por nombre en la lista de libros), y cada partición tiene
-- su seguro contra vaciarla. Los rechazos tampoco los toca nadie.

create or replace function private.schema_violations()
returns table (problem text, object_name text)
language sql stable security definer set search_path = ''
as $$
  with ledgers (table_schema, table_name) as (
    values
      ('public', 'watch_events'), ('public', 'charges'), ('public', 'charge_reversals'),
      ('public', 'revenue_allocations'), ('public', 'payout_student_pools'), ('public', 'payout_shares'),
      ('public', 'payout_teacher_totals'), ('public', 'payout_status_events'),
      ('public', 'payout_adjustments'), ('public', 'teacher_balance_entries'),
      ('public', 'reserve_entries'), ('public', 'legal_documents'), ('public', 'consents'),
      ('public', 'licenses'), ('public', 'audit_log'), ('private', 'teacher_tax_profiles'),
      ('private', 'student_aliases'), ('private', 'moderation_actions'),
      ('private', 'moderation_case_access_log')),
  app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  watch_tables (oid) as (
    select 'public.watch_events'::regclass::oid
    union all
    select i.inhrelid from pg_catalog.pg_inherits i where i.inhparent = 'public.watch_events'::regclass)
  -- Tablas propias sin seguridad por fila (RNF-08).
  select 'table without row level security', n.nspname || '.' || c.relname
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and not c.relrowsecurity
  union all
  -- Funciones security definer sin search_path fijo.
  select 'security definer function without a fixed search_path', n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosecdef
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%')
  union all
  -- Funciones propias que cualquiera puede ejecutar.
  select 'function executable by PUBLIC', n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and pg_catalog.has_function_privilege('public', p.oid, 'execute')
  union all
  -- Escrituras a nivel de tabla para roles de usuario, fuera de la única prevista.
  select 'unexpected write privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  where g.grantee in ('anon', 'authenticated')
    and g.table_schema in ('public', 'private')
    and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    and not (g.grantee = 'authenticated' and g.table_name = 'saved_courses'
             and g.privilege_type in ('INSERT', 'DELETE'))
  union all
  -- Lo mismo, columna por columna, que no sale en la consulta de arriba. La única escritura
  -- por columnas prevista es la de la persona sobre sus propios datos de perfil.
  select distinct 'unexpected column write privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.grantee in ('anon', 'authenticated')
    and g.table_schema in ('public', 'private')
    and g.privilege_type in ('INSERT', 'UPDATE')
    and not (g.grantee = 'authenticated' and g.table_schema = 'public' and g.table_name = 'profiles'
             and g.privilege_type = 'UPDATE'
             and g.column_name in ('display_name', 'country_code', 'country_is_self_declared', 'locale'))
    and not (g.grantee = 'authenticated' and g.table_schema = 'public' and g.table_name = 'saved_courses'
             and g.privilege_type = 'INSERT')
  union all
  -- Del esquema privado, ni una columna, ni para leer.
  select distinct 'unexpected column privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.table_schema = 'private' and g.grantee in ('anon', 'authenticated')
  union all
  -- Nada concedido a todos: PUBLIC incluye al visitante y a cualquier rol que llegue después.
  select distinct 'privilege granted to PUBLIC', g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.grantee = 'PUBLIC' and g.table_schema in ('public', 'private')
  union all
  -- La clave secreta no toca tablas propias. Ningún rol de usuario toca el esquema privado.
  select 'unexpected privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  where (g.grantee = 'service_role' and g.table_schema in ('public', 'private'))
     or (g.grantee in ('anon', 'authenticated') and g.table_schema = 'private')
  union all
  -- Ningún rol de la aplicación puede editar ni borrar un libro.
  select 'ledger writable by ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  join ledgers l on l.table_schema = g.table_schema and l.table_name = g.table_name
  where g.grantee in (select r.rolname from app_roles r)
    and g.privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
  union all
  -- Ni editar una sola de sus columnas: el permiso por columna no sale en la consulta de arriba.
  select 'ledger column writable by ' || r.rolname, l.table_schema || '.' || l.table_name
  from ledgers l
  join pg_catalog.pg_namespace n on n.nspname = l.table_schema
  join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = l.table_name
  cross join app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, c.oid, 'UPDATE')
  union all
  -- El libro de latidos y cada partición: solo private.record_heartbeats() escribe, y nadie de
  -- la aplicación lee los latidos crudos (T-205).
  select 'watch ledger reachable by ' || r.rolname, 'public.' || c.relname
  from watch_tables w
  join pg_catalog.pg_class c on c.oid = w.oid
  cross join app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, c.oid, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- El seguro contra vaciar no pasa de la madre a las particiones: cada una lleva el suyo.
  select 'watch partition without truncate guard', 'public.' || c.relname
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.watch_events'::regclass
    and not exists (
      select 1 from pg_catalog.pg_trigger t
      where t.tgrelid = c.oid and t.tgname = 'ledger_no_truncate' and t.tgenabled <> 'D')
  union all
  -- Los rechazos solo los escribe private.record_heartbeats() (T-205).
  select 'heartbeat rejections reachable by ' || r.rolname, 'private.heartbeat_rejection_counts'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'private.heartbeat_rejection_counts'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, 'private.heartbeat_rejection_counts'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- La marca de contraseña solo la cambia private.claim_account() (TRD 9.2).
  select 'password_reset_required writable by ' || r.rolname, 'public.profiles'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.profiles'::regclass, 'password_reset_required', 'UPDATE')
  union all
  -- Las capacidades solo se escriben con las funciones que cambian el equipo (T-105).
  select 'admin_capabilities writable by ' || r.rolname, 'public.admin_capabilities'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.admin_capabilities'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.admin_capabilities'::regclass, 'DELETE, TRUNCATE')
  union all
  -- Las invitaciones y las ataduras no las toca ningún rol de la aplicación, ni para leer.
  select 'team table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('private.admin_invitations'), ('private.admin_factors')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Las prácticas y los niveles solo los escriben las funciones de las listas (T-106).
  select 'catalog list writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.practices'), ('public.levels')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Lo publicado y lo que lo sostiene solo lo escriben las funciones de cargar y aprobar
  -- (T-107).
  select 'publication table writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.teachers'), ('public.published_teachers'), ('public.course_registry'),
                     ('public.video_assets'), ('public.published_courses'), ('public.published_modules'),
                     ('public.published_lessons')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Los hechos de la cuenta todavía no los escribe nadie de la aplicación (T-202). La
  -- escritura llega con quien la necesita: las suscripciones con T-302 y T-303, la cortesía
  -- con T-307, y cada una la abre aquí.
  select 'account facts table writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.subscriptions'), ('public.courtesy_grants')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- El orden de desempate de un maestro nunca sale de la base (RN-07).
  select 'teachers.tiebreak_rank readable by ' || r.rolname, 'public.teachers'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.teachers'::regclass, 'tiebreak_rank', 'SELECT')
  union all
  -- Lo que solo corre el dueño de la base, declarado sistema, no lo ejecuta nadie más. Las
  -- particiones de latidos las crea el dueño (la migración y pg_cron).
  select 'system function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.system_catalog_add(public.catalog_list, text)'),
                     ('private.system_add_teacher(text, text, text)'),
                     ('private.system_load_course(uuid, jsonb)'),
                     ('private.catalog_place(public.catalog_list, text)'),
                     ('private.create_watch_partition(public.period_id)'),
                     ('private.ensure_watch_partitions(integer, text)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
  union all
  -- Las reproducciones solo las escriben sus funciones (T-204): abrir, latir y, con T-205, los
  -- latidos con medición.
  select 'playback table writable by ' || r.rolname, 'public.playback_sessions'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.playback_sessions'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.playback_sessions'::regclass, 'DELETE, TRUNCATE, TRIGGER')
$$;
