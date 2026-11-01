-- T-403, tercera solicitud · Lo que el servidor necesita para hablar con el proveedor de video (RF-604, FL-33).
--
-- Dos datos más, sin ninguna regla nueva:
--   · `video_claim` contesta `since`, cuándo nació la fila. Buscar en Mux por `passthrough` es recorrer su lista del más nuevo al más viejo (no
--     filtra por él, medido el 2026-11-01), y ninguna fila tiene un asset más viejo que ella: de ahí para atrás no hace falta seguir.
--   · `video_due` contesta `seconds`, los que leyó el servidor (el proveedor de prueba no mide, y los repite), y `current`: una lista que ya es la
--     vigente solo se vuelve a asentar si trae subtítulos; una que no lo es, para promoverla.

create or replace function private.video_claim(p_course uuid, p_video uuid, p_provider text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_row public.draft_videos;
  v_cap integer := (private.parameter_value('VIDEOS_POR_HORA_MAX'))::integer;
  v_minutes_cap integer := (private.parameter_value('VIDEO_MINUTOS_MES_MAX'))::integer;
  v_open boolean := (private.parameter_value('VIDEO_SUBIDA_ABIERTA'))::boolean;
  v_month date;
  v_minutes integer;
  v_used integer;
  v_hits integer;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select * into v_row from public.draft_videos where id = p_video and course_id = p_course for update;
  if v_row.id is null or v_row.state = 'uploading' then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_row.state in ('processing', 'ready', 'errored') then
    return pg_catalog.jsonb_build_object('answer', 'done');
  end if;
  if v_row.state = 'creating' and v_row.claimed_at > now() - interval '5 minutes' then
    return pg_catalog.jsonb_build_object('answer', 'busy');
  end if;
  if p_provider is null or p_provider not in ('mux', 'test')
     or (p_provider = 'test' and not exists (select 1 from private.local_flags where flag = 'video_test')) then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  if v_cap is null or v_cap < 1 or v_minutes_cap is null or v_minutes_cap < 1 or v_open is null then
    return pg_catalog.jsonb_build_object('answer', 'unavailable');
  end if;
  if not v_open then
    return pg_catalog.jsonb_build_object('answer', 'closed');
  end if;
  if v_row.claimed_at is null then
    -- Lo declarado en una cabecera se corrige al asentar, y asentar pide que alguien mire: sin esto, una cabecera falsa encolaría sin fin lo
    -- que Mux cobra de verdad. El mismo tope, sin otra cifra.
    if (select pg_catalog.count(*) from public.draft_videos v
        where v.teacher_id = v_teacher and v.state in ('creating', 'processing')) >= v_cap then
      return pg_catalog.jsonb_build_object('answer', 'throttled');
    end if;
    v_month := pg_catalog.date_trunc('month', now() at time zone private.period_zone())::date;
    v_minutes := pg_catalog.ceil(v_row.read_seconds / 60.0)::integer;
    -- Insertar no compara: un solo video que no cabe se detiene antes. Con el tope, una sola sentencia que no toca la fila.
    if v_minutes > v_minutes_cap then
      return pg_catalog.jsonb_build_object('answer', 'over_minutes');
    end if;
    insert into private.video_usage as u (teacher_id, month, minutes)
    values (v_teacher, v_month, v_minutes)
    on conflict (teacher_id, month) do update set minutes = u.minutes + v_minutes where u.minutes + v_minutes <= v_minutes_cap
    returning u.minutes into v_used;
    if v_used is null then
      return pg_catalog.jsonb_build_object('answer', 'over_minutes');
    end if;
    insert into private.rate_limit_counters as c (bucket, window_start, hits)
    values ('video_claim:' || v_teacher, pg_catalog.date_trunc('hour', now()), 1)
    on conflict (bucket, window_start) do update set hits = c.hits + 1 where c.hits < v_cap
    returning c.hits into v_hits;
    if v_hits is null then
      update private.video_usage set minutes = minutes - v_minutes where teacher_id = v_teacher and month = v_month;
      return pg_catalog.jsonb_build_object('answer', 'throttled');
    end if;
  end if;
  update public.draft_videos set state = 'creating', claimed_at = now(), provider = p_provider where id = p_video;
  return pg_catalog.jsonb_build_object('answer', 'claimed', 'path', v_row.storage_path, 'mime', v_row.mime,
                                       'retry', v_row.claimed_at is not null, 'claim', extract(epoch from now())::text,
                                       'since', extract(epoch from v_row.created_at)::bigint);
end
$$;

create or replace function private.video_due(p_course uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_status public.teacher_status := (
    select t.status from public.course_drafts d join public.teachers t on t.id = d.teacher_id
    where d.course_id = p_course and t.profile_id = private.actor_id());
  v_acts boolean := v_status = 'active'
    and exists (select 1 from public.course_registry r where r.course_id = p_course and r.state = 'draft');
  v_result jsonb;
begin
  if coalesce(v_status not in ('active', 'suspended'), true) and not private.actor_has_capability('content'::public.capability) then
    return '[]'::jsonb;
  end if;
  v_acts := coalesce(v_acts, false);
  with due as (
    update public.draft_videos v set checked_at = now()
     where v.course_id = p_course
       and (v.state = 'processing'
            or (v.state = 'ready' and not v.captions_ready)
            or (v_acts and v.state = 'uploaded')
            or (v_acts and v.state = 'creating' and v.claimed_at <= now() - interval '5 minutes')
            or (v_acts and v.state = 'ready' and not v.is_current))
       and (v.checked_at is null
            or v.checked_at <= now() - case when v.state = 'ready' and v.is_current and v.settled_at <= now() - interval '6 hours'
                                            then interval '1 hour' else interval '10 seconds' end)
    returning v.id, v.state, v.provider, v.provider_asset_id, v.read_seconds, v.is_current)
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('video', due.id, 'state', due.state, 'provider', due.provider, 'asset', due.provider_asset_id, 'seconds', due.read_seconds, 'current', due.is_current)), '[]'::jsonb)
    into v_result from due;
  return v_result;
end
$$;
