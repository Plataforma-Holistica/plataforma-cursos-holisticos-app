-- T-206 · Progreso al momento (RF-307; 05 §5.7 y §9.2; TRD §5.2). Decisiones de Sergio del
-- 2026-10-20: si el progreso falla, el libro se guarda igual y el progreso se rehace después
-- desde `watch_events`.
--
-- `lesson_progress` guarda, por cuenta y lección, lo visto que sirve como multirrango (la unión de
-- todas las visitas), la posición y si la terminó. La escribe solo `private.record_heartbeats()`,
-- en la transacción del libro, como T-205 decide ahí si un tramo cuenta: el umbral y el fundido
-- viven una sola vez, en la base. La persona lee lo suyo; el servidor no lo lee entero, solo
-- pregunta dónde se quedó quien actúa (`private.lesson_position()`).
--
-- Cuatro cosas cambian respecto del esquema escrito (05 §5.7 y el bloque de §9.2):
--   · el orden y la posición se mueven con la hora en que se vio (el tope del lote) y, dentro de
--     una reproducción, con el consecutivo: la cola del navegador manda tarde lo de reproducciones
--     viejas, y no debe regresar a nadie a donde estaba hace días. Los tramos se funden siempre;
--   · un lote de un video que la lección ya no tiene no toca el progreso: reiniciaría los tramos
--     del video nuevo con los del viejo (en el libro sí queda);
--   · `covered_seconds` es una columna calculada de `covered`: no se desfasa;
--   · nadie de la aplicación escribe la tabla (el 05 le daba al servidor insertar, cambiar y
--     borrar).
-- Los días de práctica, el alias y la marca para la consolidación quedan para T-207.

-- ---------------------------------------------------------------------------------------
-- La tabla.

-- Los segundos que cubre un multirrango de segundos enteros.
create function private.span_seconds(p_spans int4multirange) returns integer
language sql immutable parallel safe set search_path = ''
as $$
  select coalesce(sum(pg_catalog.upper(r) - pg_catalog.lower(r)), 0)::integer from pg_catalog.unnest(p_spans) as r
$$;
revoke all on function private.span_seconds(int4multirange) from public;

create table public.lesson_progress (
  profile_id uuid not null references public.profiles (id),
  lesson_id uuid not null references public.published_lessons (id),
  course_id uuid not null references public.course_registry (course_id),
  video_asset_id uuid not null references public.video_assets (id),   -- los tramos son de este video
  last_position_seconds integer not null,
  covered int4multirange not null default '{}',   -- lo visto que sirve, ya fundido, de toda la vida de la cuenta
  covered_seconds integer not null generated always as (private.span_seconds(covered)) stored,
  completed_at timestamptz,                         -- una vez puesto, no se quita (RF-307)
  first_watched_at timestamptz not null,
  last_watched_at timestamptz not null,             -- la hora del tope del lote que movió la posición
  last_playback_session_id uuid not null,           -- sin clave foránea: las reproducciones se purgan
  last_seq integer not null,
  updated_at timestamptz not null default now(),
  primary key (profile_id, lesson_id),
  constraint lesson_progress_position_positive check (last_position_seconds >= 0 and last_seq >= 0),
  constraint lesson_progress_covered_positive check (pg_catalog.lower(covered) is null or pg_catalog.lower(covered) >= 0)
)
-- Se actualiza con cada lote: con espacio libre en cada página y sin índices sobre lo que
-- cambia, la actualización se queda en la misma página (HOT).
with (fillfactor = 80);
comment on table public.lesson_progress is 'El progreso de cada cuenta en cada lección (RF-307, T-206). Histórico: no se reinicia y lo terminado no se desmarca. La escribe solo private.record_heartbeats().';

-- Avance de un alumno en un curso: temario, ficha y constancia (RF-307, RF-805). «Continuar
-- viendo» agrupa las filas de la cuenta, y le basta el principio de la clave primaria. Sin índice
-- sobre `last_watched_at` (lo mueve cada lote), y el de una lección para el maestro (RF-613) llega
-- con quien lo lea.
create index lesson_progress_course_idx on public.lesson_progress (profile_id, course_id);

create trigger touch_updated_at before update on public.lesson_progress
  for each row execute function private.touch_updated_at();

alter table public.lesson_progress enable row level security;

-- La persona lee su avance, sin los tramos ni de qué reproducción vino. Nadie de la aplicación
-- escribe, y el servidor no lee la tabla.
grant select (profile_id, lesson_id, course_id, video_asset_id, last_position_seconds, covered_seconds, completed_at,
              first_watched_at, last_watched_at, updated_at)
  on public.lesson_progress to authenticated;
create policy lesson_progress_self_select on public.lesson_progress
  for select to authenticated using (profile_id = (select auth.uid()));

-- Las lecciones cuyo progreso falló al registrar un lote (decisión de Sergio del 2026-10-20: el
-- libro se guarda igual). El lote quedó en el libro; el progreso de ese par se rehace desde ahí
-- (pendiente: la consolidación de T-207, antes de que se purguen las reproducciones, que dicen de
-- qué video era cada tramo). Nadie de la aplicación la toca.
create table private.progress_rebuilds (
  profile_id uuid not null,
  lesson_id uuid not null,
  failed_at timestamptz not null default now(),
  code text not null,
  primary key (profile_id, lesson_id)
);
alter table private.progress_rebuilds enable row level security;
revoke all on private.progress_rebuilds from public, anon, authenticated, service_role, app_service;

-- ---------------------------------------------------------------------------------------
-- Fundir un lote en el progreso. La llama solo private.record_heartbeats(), bajo el candado de
-- la cuenta y con la fila de la reproducción ya tomada: no es security definer (corre con los
-- permisos de quien la llama) y no tiene permisos para nadie.
--
-- `p_spans`: lo aceptado del lote que sirve (visible y dentro de VELOCIDAD_MAX), o nulo.
-- `p_last_seq` y `p_last_to`: el consecutivo y el final del último aceptado, sirva o no; nulos si
-- no se aceptó nada. `p_top`: la hora en que se vio (el tope del reloj de la reproducción).
--
-- Contesta el estado de la lección después del lote, también si no se aceptó nada (un reenvío
-- cuya respuesta se perdió tiene que enterarse de que la lección quedó terminada):
--   {outcome: 'tracked', lesson_id, covered_seconds, completed, just_completed}
-- o nulo si la reproducción es de un video que la lección ya no tiene. Lanza si falta
-- UMBRAL_COMPLETO_PCT o no es un entero de 1 a 10 000: no se adivina.

create function private.merge_progress(p_row public.playback_sessions, p_spans int4multirange, p_last_seq integer,
                                       p_last_to integer, p_top timestamptz)
returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_video uuid;
  v_bps jsonb := private.parameter_value('UMBRAL_COMPLETO_PCT');
  v_needed integer;
  v_saved public.lesson_progress%rowtype;
  v_moves boolean;
  v_completed integer;
begin
  select l.video_asset_id into v_video from public.published_lessons l where l.id = p_row.lesson_id;
  if v_video is distinct from p_row.video_asset_id then
    return null;
  end if;
  if pg_catalog.jsonb_typeof(v_bps) is distinct from 'number' or (v_bps)::text !~ '^[1-9][0-9]{0,4}$'
     or (v_bps)::text::integer > 10000 then
    raise exception 'UMBRAL_COMPLETO_PCT is not set' using errcode = 'P0001';
  end if;
  v_needed := pg_catalog.ceil(p_row.lesson_duration_seconds * (v_bps)::text::integer / 10000.0)::integer;

  if p_last_seq is not null then
    select * into v_saved from public.lesson_progress lp
    where lp.profile_id = p_row.profile_id and lp.lesson_id = p_row.lesson_id
    for update;
    if not found then
      insert into public.lesson_progress (
        profile_id, lesson_id, course_id, video_asset_id, last_position_seconds, covered,
        first_watched_at, last_watched_at, last_playback_session_id, last_seq)
      values (
        p_row.profile_id, p_row.lesson_id, p_row.course_id, p_row.video_asset_id, p_last_to, coalesce(p_spans, '{}'),
        p_top, p_top, p_row.id, p_last_seq);
    elsif v_saved.video_asset_id <> p_row.video_asset_id then
      -- Un video nuevo: los tramos del anterior ya no dicen nada. Terminada se queda terminada.
      -- El orden de «continuar viendo» no regresa: un video que volvió a ser el de la lección puede
      -- traer lo atrasado de una reproducción vieja.
      update public.lesson_progress lp
      set video_asset_id = p_row.video_asset_id, covered = coalesce(p_spans, '{}'), last_position_seconds = p_last_to,
          last_watched_at = greatest(lp.last_watched_at, p_top), last_playback_session_id = p_row.id, last_seq = p_last_seq
      where lp.profile_id = p_row.profile_id and lp.lesson_id = p_row.lesson_id;
    else
      -- Lo atrasado se funde (la unión no depende del orden), pero solo mueve la posición y el
      -- orden si es más nuevo: de la misma reproducción, un consecutivo mayor; de otra, un tope
      -- más nuevo.
      v_moves := case when v_saved.last_playback_session_id = p_row.id then p_last_seq > v_saved.last_seq
                      else p_top > v_saved.last_watched_at end;
      update public.lesson_progress lp
      set covered = lp.covered + coalesce(p_spans, '{}'),
          first_watched_at = least(lp.first_watched_at, p_top),
          last_position_seconds = case when v_moves then p_last_to else lp.last_position_seconds end,
          last_watched_at = case when v_moves then p_top else lp.last_watched_at end,
          last_playback_session_id = case when v_moves then p_row.id else lp.last_playback_session_id end,
          last_seq = case when v_moves then p_last_seq else lp.last_seq end
      where lp.profile_id = p_row.profile_id and lp.lesson_id = p_row.lesson_id;
    end if;
  end if;

  -- Terminada al llegar al umbral, una sola vez, y solo con lo visto de este video: si la lección
  -- cambió y el primer lote del nuevo salió rechazado, lo guardado sigue siendo del anterior.
  -- También sin nada nuevo: si el umbral bajó, la lección que ya lo pasa se termina con su
  -- siguiente lote. La hora es la en que se vio lo último: un lote atrasado que completa no la
  -- pone antes.
  update public.lesson_progress lp
  set completed_at = greatest(p_top, lp.last_watched_at)
  where lp.profile_id = p_row.profile_id and lp.lesson_id = p_row.lesson_id
    and lp.video_asset_id = p_row.video_asset_id
    and lp.completed_at is null and lp.covered_seconds >= v_needed;
  get diagnostics v_completed = row_count;

  select * into v_saved from public.lesson_progress lp
  where lp.profile_id = p_row.profile_id and lp.lesson_id = p_row.lesson_id;
  return pg_catalog.jsonb_build_object(
    'outcome', 'tracked', 'lesson_id', p_row.lesson_id,
    'covered_seconds', case when v_saved.video_asset_id = p_row.video_asset_id then v_saved.covered_seconds else 0 end,
    'completed', v_saved.completed_at is not null,
    'just_completed', v_completed > 0);
end
$$;
revoke all on function private.merge_progress(public.playback_sessions, int4multirange, integer, integer, timestamptz) from public;

-- Dónde se quedó quien actúa en una lección, para arrancar ahí (FL-12 paso 5): la posición si
-- sus tramos son del video que la lección tiene hoy, o nula. Nula sin quien actúe o sin su sesión
-- declarada. La llama el servidor al dar la dirección del video, en la transacción que abre la
-- reproducción.
create function private.lesson_position(p_lesson uuid) returns integer
language sql stable security definer set search_path = ''
as $$
  select lp.last_position_seconds
  from public.lesson_progress lp
  join public.published_lessons l on l.id = lp.lesson_id and l.video_asset_id = lp.video_asset_id
  where lp.profile_id = private.actor_id() and lp.lesson_id = p_lesson and private.actor_session() is not null
$$;
revoke all on function private.lesson_position(uuid) from public;
grant execute on function private.lesson_position(uuid) to app_service;

-- ---------------------------------------------------------------------------------------
-- Los latidos, con el progreso. Lo demás no cambia (T-205).

-- Registrar un lote (05 §9.2). `p_events` es un arreglo de a lo más 50 tramos
-- `{seq, from, to, rate, visible}`; `p_access_counts`, si el acceso de la cuenta a esa hora
-- cuenta para el reparto, como lo decidió TypeScript (nunca sube lo que la reproducción ya dice);
-- `p_at`, el tope con que lo decidió (el de `heartbeat_target`). Si el tope ya es otro (otra
-- transacción latió o revocó entre las dos lecturas), no registra: la decisión sería de otra
-- hora, y quizá de otro mes.
--
-- Cada tramo, en orden de consecutivo (si se repite en el lote, manda el primero):
--   · ya recibido: repetido;
--   · forma imposible (consecutivo fuera de 0 a 10⁶, segundos que no son enteros o no avanzan,
--     velocidad fuera de (0, 9.99], visibilidad que no es sí o no): `out_of_range`;
--   · más allá de la duración: hasta 2 s se recorta (el redondeo de la duración); más, `out_of_range`;
--   · lo aceptado más el tramo no cabe en el presupuesto: `faster_than_clock`. El presupuesto es
--     el tiempo transcurrido de la reproducción por VELOCIDAD_MAX, más 5 s de tolerancia que nunca
--     pasan del tiempo transcurrido: abrir reproducciones en serie no junta tolerancias;
--   · si no, se guarda en el mes del tope.
-- Todo consecutivo visto, aceptado o no, queda recibido: un rechazo reenviado no se cuenta dos
-- veces. No toca la presencia (`last_heartbeat_at`, `live_seconds`): ya corrió antes.
--
-- Contesta (nula si no hay quien actúe o no declaró su sesión):
--   {outcome: 'recorded', accepted: [seq], duplicate: [seq], rejected: [{seq, reason}], progress}
--   {outcome: 'not_found'}             no existe, no la puede escribir quien actúa, o su tope es
--                                      de un periodo anterior al pasado
--   {outcome: 'failed', code}          nada se registró (el tope cambió, falta la partición, un
--                                      parámetro…)
--
-- `progress` (T-206) es el estado de la lección después del lote, de `private.merge_progress()`:
-- nulo si la reproducción es la vista previa del dueño o es de un video que la lección ya no
-- tiene; `{outcome: 'failed', code}` si el progreso falló y el lote sí se registró.
--
-- Lo que no ataja el bloque de excepción: una consulta cancelada (`statement_timeout`) aborta la
-- transacción entera. El servicio lo sabe y repite la presencia sola.

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
    v_period := pg_catalog.to_char(pg_catalog.timezone(v_zone, v_top), 'YYYYMM')::integer;
    if v_period < pg_catalog.to_char(pg_catalog.date_trunc('month', pg_catalog.timezone(v_zone, pg_catalog.now())) - interval '1 month',
                                      'YYYYMM')::integer then
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
-- El vigilante aprende el progreso: nadie de la aplicación lo escribe, y solo la persona lo lee.

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
  -- El seguro de editar y borrar sí pasa de la madre, pero se puede apagar en una partición.
  select 'watch partition without update guard', 'public.' || c.relname
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.watch_events'::regclass
    and not exists (
      select 1 from pg_catalog.pg_trigger t
      where t.tgrelid = c.oid and t.tgname = 'ledger_no_update_delete' and t.tgenabled <> 'D')
  union all
  -- Sin partición por omisión: un tramo sin su mes no entra.
  select 'watch default partition', 'public.' || c.relname
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.watch_events'::regclass and c.relpartbound is not null
    and pg_catalog.pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
  union all
  -- La partición del mes que sigue ya existe: si pg_cron dejó de correr, se sabe antes de que
  -- los latidos empiecen a fallar.
  select 'watch partition missing for next month', 'public.watch_events_' || m.period
  from (select pg_catalog.to_char(
                 pg_catalog.date_trunc('month', pg_catalog.timezone(
                   coalesce(private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}', 'UTC'), pg_catalog.now()))
                 + interval '1 month', 'YYYYMM') as period) m
  where pg_catalog.to_regclass('public.watch_events_' || m.period) is null
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
  union all
  -- El progreso solo lo escribe private.record_heartbeats() (T-206), y el servidor no lo lee
  -- entero: pregunta dónde se quedó quien actúa con private.lesson_position().
  select 'progress writable by ' || r.rolname, 'public.lesson_progress'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.lesson_progress'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.lesson_progress'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  select 'progress readable by ' || r.rolname, 'public.lesson_progress'
  from app_roles r
  where r.rolname <> 'authenticated'
    and pg_catalog.has_any_column_privilege(r.rolname::name, 'public.lesson_progress'::regclass, 'SELECT')
  union all
  -- La persona lee su avance, no los tramos ni de qué reproducción vino.
  select 'progress spans readable by authenticated', 'public.lesson_progress'
  where pg_catalog.has_column_privilege('authenticated', 'public.lesson_progress'::regclass, 'covered', 'SELECT')
     or pg_catalog.has_column_privilege('authenticated', 'public.lesson_progress'::regclass, 'last_playback_session_id', 'SELECT')
     or pg_catalog.has_column_privilege('authenticated', 'public.lesson_progress'::regclass, 'last_seq', 'SELECT')
  union all
  -- Lo que falta rehacer no lo toca nadie de la aplicación.
  select 'progress rebuilds reachable by ' || r.rolname, 'private.progress_rebuilds'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'private.progress_rebuilds'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, 'private.progress_rebuilds'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Dónde se quedó alguien lo pregunta solo el servidor, y fundir no lo ejecuta nadie.
  select 'progress function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.lesson_position(uuid)'),
                     ('private.merge_progress(public.playback_sessions, int4multirange, integer, integer, timestamptz)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
    and not (r.rolname = 'app_service' and f.signature = 'private.lesson_position(uuid)')
$$;
