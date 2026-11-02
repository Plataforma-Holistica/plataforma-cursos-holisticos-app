-- T-403, cuarta solicitud · Cuándo se borra un video que no se procesó, y lo que el repaso necesita (RF-604, FL-33).
--
-- Decisión de Sergio del 2026-11-01: un video detenido dice en pantalla la fecha exacta en que se borra, y si lo detiene el tope de minutos, el original se guarda hasta
-- 7 días después de que empiece el mes siguiente. Un tope que se libera solo no debe costarle a nadie una subida de horas. Lo que otra cosa detiene sigue con sus 7 días.
--
--   · `deletes_at` es una columna calculada, y la lee `video_expire` igual que la pantalla: lo que se dice es lo que se cumple. Los días se suman en UTC porque una columna
--     calculada no admite la suma que depende de la zona de la sesión.
--   · `minutes_hold_until` no se limpia al reclamar: si Mux rechaza un video ya en el mes nuevo, vuelve a recibido, y sin eso su fecha ya habría pasado y se borraría en la
--     siguiente hora. Un rechazo pasajero no debe costarle el archivo.
--   · Si en el mes siguiente sigue sin caber, el reclamo vuelve a mover la fecha. Eso solo pasa con el editor abierto.
--   · `video_claim` contesta `held` solo cuando la fecha cambió: es lo que le dice a la pantalla que vuelva a leer, sin pedir la página cada minuto.
--   · `claimed_at` se le da a su maestro para decir «está tardando», sin otra columna.
--   · `video_preview` da el correo de quien mira, para la marca de agua de la vista previa (diseño, sección 5.4).
--   · `video_sweep` espera los mismos 5 minutos que `video_trash_due`, y dice desde cuándo buscar: un asset recién creado puede no aparecer todavía en la lista de Mux, y
--     sacar el renglón sin encontrarlo lo dejaría pagado y sin nombre.

alter table public.draft_videos
  add column minutes_hold_until timestamptz,       -- lo detuvo el tope de minutos: se guarda hasta aquí
  add column deletes_at timestamptz generated always as (
    case state
      when 'uploading'::public.draft_video_state then (created_at at time zone 'UTC' + interval '48 hours') at time zone 'UTC'
      when 'uploaded'::public.draft_video_state then greatest((created_at at time zone 'UTC' + interval '7 days') at time zone 'UTC', minutes_hold_until)
      when 'errored'::public.draft_video_state then (settled_at at time zone 'UTC' + interval '7 days') at time zone 'UTC'
    end
  ) stored;

grant select (deletes_at, claimed_at) on public.draft_videos to authenticated;

create or replace function private.video_expire() returns void
language sql security definer set search_path = ''
as $$
  delete from public.draft_videos v where v.deletes_at <= now()
$$;

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
  v_until timestamptz;
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
    if v_minutes <= v_minutes_cap then
      insert into private.video_usage as u (teacher_id, month, minutes)
      values (v_teacher, v_month, v_minutes)
      on conflict (teacher_id, month) do update set minutes = u.minutes + v_minutes where u.minutes + v_minutes <= v_minutes_cap
      returning u.minutes into v_used;
    end if;
    if v_used is null then
      v_until := (v_month + interval '1 month 7 days') at time zone private.period_zone();
      if v_row.minutes_hold_until is distinct from v_until then
        update public.draft_videos set minutes_hold_until = v_until where id = p_video;
        return pg_catalog.jsonb_build_object('answer', 'over_minutes', 'held', true);
      end if;
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

drop function private.video_sweep();
create function private.video_sweep() returns table (kind text, path text, video uuid, asset text, provider text, trash_id bigint, claimed_since timestamptz)
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.video_expire();
  delete from private.video_trash x
   where exists (select 1 from public.video_assets a
                 where (x.provider_asset_id is not null and a.provider_asset_id = x.provider_asset_id)
                    or (x.storage_path is not null and a.original_path = x.storage_path));
  return query
    select 'trash'::text, x.storage_path, x.video_id, x.provider_asset_id, x.provider, x.id, x.claimed_since from private.video_trash x
    where x.claimed_since is null or x.created_at <= now() - interval '5 minutes'
    union all
    select 'orphan'::text, o.name, null::uuid, null::text, null::text, null::bigint, null::timestamptz from storage.objects o
    where o.bucket_id = 'video-originals'
      and not exists (select 1 from public.draft_videos v where v.storage_path = o.name)
      and not exists (select 1 from private.video_trash x where x.storage_path = o.name)
      and not exists (select 1 from public.video_assets a where a.original_path = o.name)
    union all
    select 'stuck'::text, v.storage_path, v.id, v.provider_asset_id, v.provider, null::bigint, null::timestamptz from public.draft_videos v
    where v.state in ('creating', 'processing') and coalesce(v.claimed_at, v.created_at) <= now() - interval '1 day';
end
$$;
revoke all on function private.video_sweep() from public;

create or replace function private.video_preview(p_course uuid, p_lesson uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_row public.draft_videos;
  v_owner boolean := exists (
    select 1 from public.course_drafts d join public.teachers t on t.id = d.teacher_id
    where d.course_id = p_course and t.profile_id = private.actor_id() and t.status in ('active', 'suspended'));
begin
  if not v_owner and not private.actor_has_capability('content'::public.capability) then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  select * into v_row from public.draft_videos where lesson_id = p_lesson and course_id = p_course and is_current;
  if v_row.id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  return pg_catalog.jsonb_build_object('answer', 'ok', 'playback', v_row.provider_playback_id, 'provider', v_row.provider, 'seconds', v_row.duration_seconds,
                                       'email', (select u.email from auth.users u where u.id = private.actor_id()));
end
$$;
