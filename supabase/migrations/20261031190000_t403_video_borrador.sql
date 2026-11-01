-- T-403, primera solicitud · Los videos del borrador (RF-604, FL-33, PA-43). Esquema §5.2 y §12.
--
-- Decisiones de Sergio del 2026-10-31: el original sube primero a Supabase y Mux lo descarga de ahí (Mux no guarda el archivo
-- exacto, y RF-604 pide conservarlo); 5 GB y 2 h por video, 10 videos por hora y 1 500 minutos al mes por maestro, más un interruptor;
-- calidad basic en 1080p; subtítulos automáticos en español, y revisarlos es otra tarea.
--
-- Decisiones que él confirmó al aprobar el plan: sin webhook ni Inngest (el editor pregunta y el servidor repara); una tabla propia y
-- no `video_assets`, que es de lo publicado; MP4 y MOV, y un archivo sin duración legible se rechaza; lo nunca publicado se borra al
-- quitarlo, un error a los 7 días y una subida sin terminar a las 48 h.
--
-- Por qué es así:
--   · Cada video cuesta dinero. Crear en Mux se reclama bajo candado de fila (`video_claim`): dos pestañas o un reintento no pagan dos
--     veces. Los topes se cuentan ahí, y no al empezar: el costo depende de la duración, que recién se sabe al confirmar. Lo gastado en el
--     mes vive en `private.video_usage`, que sobrevive a una caída; `rate_limit_counters` no, y solo sirve para contar una hora. Una cabecera
--     puede mentir: al asentar manda lo que midió Mux, se cobra la diferencia, y lo que pasa del tope no se vuelve lista.
--   · Un archivo que tardó horas no se pierde por una falla de Mux: `uploaded` espera y se reintenta. Un `creating` vencido avisa
--     (`retry`), también después de una falla de Mux, que pudo haberlo creado: hay que buscar por `passthrough` antes de crear otro.
--   · Mux no tiene una lista que se pueda consultar como `storage.objects`: lo que una fila deja de nombrar, también por cascada, va a
--     `private.video_trash`, y un asset que sobra también (`video_created`). Lo que `video_assets` nombra nunca sale de ahí como borrable: T-405
--     compartirá ruta y asset con lo publicado. La vacía su maestro al abrir el editor, y lo que no alcance, el repaso de quien opera
--     (`video_sweep`), que ve todos los cursos.
--   · Lo que quedó listo con el curso en revisión no se pierde: de vuelta en borrador se promueve (`video_promote`), porque ya se pagó.
--   · Asentar lo que dice Mux (`video_settle`) no pasa por `draft_open` ni sube revisiones: el curso puede estar en revisión y el maestro
--     suspendido, y a quien está escribiendo no se le debe contestar «cambió». Solo cambia de vigente con el curso en `draft`: lo que se
--     revisa es lo que se publica.
--   · La dirección de subida vive hasta 24 h en Storage: una subida sin terminar vive 48 h.
--
-- `draft_videos.id` será el `video_assets.id` al publicar (T-405 y T-406). Por eso viaja como `passthrough`.
-- El proveedor `test` solo entra con la marca de `private.local_flags`, que pone el guion local (`db:login`): en producción nadie la pone,
-- y ningún rol de la aplicación la puede escribir.
-- El orden de candados es el del borrador: la fila del maestro, después el curso (`draft_open`), después la fila del video.

create type public.draft_video_state as enum ('uploading', 'uploaded', 'creating', 'processing', 'ready', 'errored');

insert into public.parameter_definitions (key, description, value_type, unit, group_name, affects_payout) values
  ('VIDEO_TAMANO_MAX', 'Tamaño máximo del archivo de un video de lección', 'integer', 'bytes', 'product', false),
  ('VIDEO_DURACION_MAX', 'Duración máxima de un video de lección: frena el gasto, y la tolerancia sigue siendo un aviso', 'integer', 'segundos', 'product', false),
  ('VIDEOS_POR_HORA_MAX', 'Videos que un maestro puede crear en una hora', 'integer', null, 'product', false),
  ('VIDEO_MINUTOS_MES_MAX', 'Minutos de video que un maestro puede crear en un mes', 'integer', 'minutos', 'product', false),
  ('VIDEO_SUBIDA_ABIERTA', 'El interruptor global: si se puede empezar a subir y crear videos', 'boolean', null, 'product', false);

-- ---------------------------------------------------------------------------------------
-- La cubeta. Privada, con su lista exacta y su tope. Ninguna política: solo el servidor firma.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('video-originals', 'video-originals', false, 5368709120, array['video/mp4', 'video/quicktime']);

-- Lo que solo una base local tiene. Sin permisos para nadie: la escribe el dueño, desde el guion local.
create table private.local_flags (flag text primary key);
alter table private.local_flags enable row level security;
revoke all on private.local_flags from public;

-- ---------------------------------------------------------------------------------------
-- La tabla.

create table public.draft_videos (
  id uuid primary key,
  course_id uuid not null,
  teacher_id uuid not null,
  lesson_id uuid not null,
  state public.draft_video_state not null default 'uploading',
  is_current boolean not null default false,       -- la que cuenta para la lección; solo una lista
  file_name text not null,                         -- para decir cuál elegir al reanudar
  mime text not null,
  storage_path text not null,                      -- la pone la base
  size_bytes bigint not null,                      -- el declarado, y al confirmar el de verdad
  object_id uuid,                                  -- el objeto de Storage al confirmar
  object_version text,
  read_seconds integer,                            -- la leída del archivo: es la que cuenta en el tope
  provider text not null default 'mux',
  provider_asset_id text,
  provider_playback_id text,
  duration_seconds integer,                        -- la que mide el proveedor
  captions_ready boolean not null default false,
  error_code text,
  claimed_at timestamptz,
  checked_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint draft_videos_course_fk foreign key (course_id, teacher_id)
    references public.course_drafts (course_id, teacher_id) on delete cascade,
  constraint draft_videos_lesson_fk foreign key (lesson_id, course_id)
    references public.draft_lessons (id, course_id) on delete cascade,
  constraint draft_videos_path_uq unique (storage_path),
  constraint draft_videos_name_ok check (private.draft_text_ok(file_name, 255, false)),
  constraint draft_videos_mime_ok check (mime in ('video/mp4', 'video/quicktime')),
  constraint draft_videos_size_positive check (size_bytes > 0),
  constraint draft_videos_provider_known check (provider in ('mux', 'test')),
  constraint draft_videos_current_is_ready check (not is_current or state = 'ready'),
  constraint draft_videos_confirmed check (
    state = 'uploading' or (object_id is not null and object_version is not null and read_seconds > 0)),
  constraint draft_videos_ready_is_complete check (
    state <> 'ready' or (provider_asset_id is not null and provider_playback_id is not null and duration_seconds > 0))
);
comment on table public.draft_videos is 'Los videos del borrador de un curso (RF-604, T-403). Los escriben solo las funciones private.video_*; su maestro lee, sin la ruta ni los identificadores del proveedor.';
-- Una vigente por lección, y una sola en camino o con error. Un asset no se liga a dos filas.
create unique index draft_videos_current_uq on public.draft_videos (lesson_id) where is_current;
create unique index draft_videos_other_uq on public.draft_videos (lesson_id) where not is_current;
create unique index draft_videos_asset_uq on public.draft_videos (provider, provider_asset_id) where provider_asset_id is not null;
create index draft_videos_course_idx on public.draft_videos (course_id, teacher_id);

alter table public.draft_videos enable row level security;
grant select (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, size_bytes, duration_seconds, captions_ready, error_code, created_at)
  on public.draft_videos to authenticated;
create policy draft_videos_teacher_select on public.draft_videos
  for select to authenticated using (teacher_id = (select private.current_teacher_id()));

create trigger draft_videos_guard before insert or update or delete on public.draft_videos
  for each row execute function private.guard_draft();
create trigger draft_videos_no_truncate before truncate on public.draft_videos
  for each statement execute function private.guard_draft();

-- Lo gastado por maestro y mes: dinero, no un freno de una hora. El mes es el de la zona de los periodos.
create table private.video_usage (
  teacher_id uuid not null,
  month date not null,
  minutes integer not null default 0,
  primary key (teacher_id, month),
  constraint video_usage_minutes_ok check (minutes >= 0)
);
alter table private.video_usage enable row level security;
revoke all on private.video_usage from public;

-- La papelera. Nadie de la aplicación la lee: pasa por `video_trash_due`.
create table private.video_trash (
  id bigint generated always as identity primary key,
  teacher_id uuid not null,
  course_id uuid not null,
  video_id uuid,                                   -- el `passthrough`: un reclamo sin asset anotado se busca con esto
  provider text,
  provider_asset_id text,
  storage_path text,
  created_at timestamptz not null default now()
);
create index video_trash_teacher_idx on private.video_trash (teacher_id, course_id);
alter table private.video_trash enable row level security;
revoke all on private.video_trash from public;

-- Lo que una fila deja de nombrar se anota antes de que se vaya, también por cascada.
create function private.video_to_trash() returns trigger
language plpgsql set search_path = ''
as $$
begin
  insert into private.video_trash (teacher_id, course_id, video_id, provider, provider_asset_id, storage_path)
  values (old.teacher_id, old.course_id, old.id, old.provider, old.provider_asset_id, old.storage_path);
  return old;
end
$$;
revoke all on function private.video_to_trash() from public;
create trigger draft_videos_to_trash before delete on public.draft_videos
  for each row execute function private.video_to_trash();

-- ---------------------------------------------------------------------------------------
-- Las funciones del servidor. Ninguna recibe quién actúa. Contestan {answer}:
--   started, resumed, pending, busy, uploaded, rejected, expired, not_uploaded, claimed, done, processing, mismatch, ready, errored,
--   deleted, invalid, too_large, throttled, over_minutes, closed, unavailable, not_found, not_editable, suspended, not_teacher

-- El contenido del curso cambió para quien lleva lo que vio al borrarlo. No sube la revisión de la lección: «Guardar» no debe chocar.
create function private.video_touch(p_course uuid) returns void
language sql security definer set search_path = ''
as $$
  update public.course_drafts set updated_at = now(), content_revision = content_revision + 1 where course_id = p_course
$$;
revoke all on function private.video_touch(uuid) from public;

-- El maestro dueño de un video (también suspendido), o nulo. Para lo que no le da nada a quien lo llama.
create function private.video_owned(p_video uuid) returns public.draft_videos
language sql stable security definer set search_path = ''
as $$
  select v.* from public.draft_videos v
  join public.teachers t on t.id = v.teacher_id
  where v.id = p_video and t.profile_id = private.actor_id() and t.status in ('active', 'suspended')
$$;
revoke all on function private.video_owned(uuid) from public;

-- Si hay una lista que no es la vigente y el curso está en borrador, pasa a ser la vigente. Ya se pagó: no se pierde.
create function private.video_promote(p_lesson uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_video uuid;
begin
  select v.id into v_video
  from public.draft_videos v join public.course_registry r on r.course_id = v.course_id
  where v.lesson_id = p_lesson and not v.is_current and v.state = 'ready' and r.state = 'draft'
  for update of v for share of r;
  if v_video is not null then
    delete from public.draft_videos where lesson_id = p_lesson and is_current;
    update public.draft_videos set is_current = true where id = v_video;
  end if;
end
$$;
revoke all on function private.video_promote(uuid) from public;

-- Empezar: reserva la fila y la ruta. El mismo archivo con una subida a medias la reanuda. Uno con error lo reemplaza, y una lista no se
-- pierde: se promueve. El mismo tope por hora, sin otra cifra: cada subida es espacio pagado aunque nunca llegue a Mux.
create function private.video_begin(p_course uuid, p_lesson uuid, p_file_name text, p_mime text, p_size bigint) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_other public.draft_videos;
  v_max bigint := (private.parameter_value('VIDEO_TAMANO_MAX'))::bigint;
  v_cap integer := (private.parameter_value('VIDEOS_POR_HORA_MAX'))::integer;
  v_open boolean := (private.parameter_value('VIDEO_SUBIDA_ABIERTA'))::boolean;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_hits integer;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  if not exists (select 1 from public.draft_lessons where id = p_lesson and course_id = p_course) then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_max is null or v_cap is null or v_cap < 1 or v_open is null then
    return pg_catalog.jsonb_build_object('answer', 'unavailable');
  end if;
  if not v_open then
    return pg_catalog.jsonb_build_object('answer', 'closed');
  end if;
  if p_mime is null or p_mime not in ('video/mp4', 'video/quicktime')
     or not private.draft_text_ok(p_file_name, 255, false) or p_size is null or p_size < 1 then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  if p_size > v_max then
    return pg_catalog.jsonb_build_object('answer', 'too_large');
  end if;
  select * into v_other from public.draft_videos where lesson_id = p_lesson and not is_current for update;
  if v_other.id is not null and v_other.state = 'uploading' and v_other.created_at > now() - interval '48 hours' then
    if v_other.file_name = p_file_name and v_other.size_bytes = p_size and v_other.mime = p_mime then
      return pg_catalog.jsonb_build_object('answer', 'resumed', 'video', v_other.id, 'path', v_other.storage_path);
    end if;
    return pg_catalog.jsonb_build_object('answer', 'pending', 'video', v_other.id, 'file_name', v_other.file_name);
  end if;
  if v_other.id is not null and v_other.state in ('uploaded', 'creating', 'processing') then
    return pg_catalog.jsonb_build_object('answer', 'busy');
  end if;
  if v_other.state = 'ready' then
    perform private.video_promote(p_lesson);
    v_other := null;
  end if;
  insert into private.rate_limit_counters as c (bucket, window_start, hits)
  values ('video_begin:' || v_teacher, pg_catalog.date_trunc('hour', now()), 1)
  on conflict (bucket, window_start) do update set hits = c.hits + 1 where c.hits < v_cap
  returning c.hits into v_hits;
  if v_hits is null then
    return pg_catalog.jsonb_build_object('answer', 'throttled');
  end if;
  if v_other.id is not null then
    delete from public.draft_videos where id = v_other.id;
  end if;
  v_path := v_teacher || '/' || p_course || '/' || v_id;
  insert into public.draft_videos (id, course_id, teacher_id, lesson_id, file_name, mime, storage_path, size_bytes)
  values (v_id, p_course, v_teacher, p_lesson, p_file_name, p_mime, v_path, p_size);
  return pg_catalog.jsonb_build_object('answer', 'started', 'video', v_id, 'path', v_path);
end
$$;

-- La ruta, para firmar o renovar la subida, y para leer sus primeros bytes. Solo el maestro activo, y solo mientras sube.
create function private.video_file(p_course uuid, p_video uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_row public.draft_videos;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select * into v_row from public.draft_videos where id = p_video and course_id = p_course;
  if v_row.id is null or v_row.state <> 'uploading' or v_row.created_at <= now() - interval '48 hours' then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  return pg_catalog.jsonb_build_object('answer', 'ok', 'path', v_row.storage_path, 'mime', v_row.mime);
end
$$;

-- Confirmar: compara lo que Storage guardó. `p_content_ok` y `p_seconds` son lo que el servidor leyó en el archivo; nulo si no pudo leer.
create function private.video_confirm(p_course uuid, p_video uuid, p_content_ok boolean, p_seconds integer) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_row public.draft_videos;
  v_object uuid;
  v_version text;
  v_size_text text;
  v_size bigint;
  v_mime text;
  v_reason text;
  v_max bigint := (private.parameter_value('VIDEO_TAMANO_MAX'))::bigint;
  v_max_seconds integer := (private.parameter_value('VIDEO_DURACION_MAX'))::integer;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select * into v_row from public.draft_videos where id = p_video and course_id = p_course for update;
  if v_row.id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_row.state <> 'uploading' then
    return pg_catalog.jsonb_build_object('answer', 'uploaded');
  end if;
  if v_row.created_at <= now() - interval '48 hours' then
    delete from public.draft_videos where id = p_video;
    return pg_catalog.jsonb_build_object('answer', 'expired');
  end if;
  select o.id, o.version, o.metadata ->> 'size', o.metadata ->> 'mimetype' into v_object, v_version, v_size_text, v_mime
  from storage.objects o where o.bucket_id = 'video-originals' and o.name = v_row.storage_path;
  if v_object is null or v_version is null then
    return pg_catalog.jsonb_build_object('answer', 'not_uploaded');
  end if;
  v_size := case when v_size_text ~ '^[0-9]{1,18}$' then v_size_text::bigint end;
  if v_max is null or v_max_seconds is null then
    return pg_catalog.jsonb_build_object('answer', 'unavailable');
  end if;
  v_reason := case
    when v_mime is distinct from v_row.mime then 'type'
    when v_size is null or v_size < 1 or v_size > v_max then 'size'
  end;
  if v_reason is null and p_content_ok is null then
    return pg_catalog.jsonb_build_object('answer', 'unavailable');
  end if;
  if v_reason is null then
    v_reason := case
      when not p_content_ok then 'content'
      when p_seconds is null or p_seconds < 1 then 'duration'
      when p_seconds > v_max_seconds then 'too_long'
    end;
  end if;
  if v_reason is not null then
    delete from public.draft_videos where id = p_video;
    return pg_catalog.jsonb_build_object('answer', 'rejected', 'reason', v_reason);
  end if;
  update public.draft_videos
     set state = 'uploaded', object_id = v_object, object_version = v_version, size_bytes = v_size, read_seconds = p_seconds
   where id = p_video;
  perform private.video_touch(p_course);
  return pg_catalog.jsonb_build_object('answer', 'uploaded');
end
$$;

-- Reclamar: el paso que gasta. Bajo candado de fila, y aquí se cuentan los topes, una sola vez por video. `claim` identifica este reclamo:
-- una sesión vieja no revierte el de otra. `retry` avisa que Mux pudo haberlo creado: hay que buscar antes de crear.
create function private.video_claim(p_course uuid, p_video uuid, p_provider text) returns jsonb
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
                                       'retry', v_row.claimed_at is not null, 'claim', extract(epoch from now())::text);
end
$$;

-- Mux contestó que no: vuelve a `uploaded`, para reintentar. Sigue reclamado (`claimed_at`): sus topes no se cuentan otra vez, y el siguiente
-- reclamo avisa que hay que buscar antes de crear, porque un 5xx o un corte no dicen que no lo haya creado.
create function private.video_create_failed(p_video uuid, p_claim text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.draft_videos := private.video_owned(p_video);
begin
  if v_row.id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  update public.draft_videos set state = 'uploaded'
   where id = p_video and state = 'creating' and extract(epoch from claimed_at)::text = p_claim;
  return pg_catalog.jsonb_build_object('answer', case when found then 'uploaded' else 'stale' end);
end
$$;

-- Anotar el asset. Uno que sobra (`gone`, si la fila se fue mientras Mux lo creaba; `mismatch`, si ya tiene otro) queda en la papelera en esta misma
-- transacción: nada pagado se queda sin nombre, aunque el servidor falle después. Sin fila no hay de dónde sacar el curso, y por eso se recibe: uno
-- falso solo ensucia la papelera de quien llama, y lo que hay ahí es suyo.
create function private.video_created(p_course uuid, p_video uuid, p_provider text, p_asset text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := (select t.id from public.teachers t where t.profile_id = private.actor_id() and t.status in ('active', 'suspended'));
  v_row public.draft_videos;
begin
  if v_teacher is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if p_asset is null or p_asset = '' or p_provider is null or p_provider not in ('mux', 'test') then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  select * into v_row from public.draft_videos where id = p_video for update;
  if v_row.id is null then
    insert into private.video_trash (teacher_id, course_id, video_id, provider, provider_asset_id)
    values (v_teacher, p_course, p_video, p_provider, p_asset);
    return pg_catalog.jsonb_build_object('answer', 'gone');
  end if;
  if v_row.teacher_id <> v_teacher or v_row.course_id <> p_course then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if v_row.provider_asset_id = p_asset then
    return pg_catalog.jsonb_build_object('answer', 'processing');
  end if;
  if v_row.provider_asset_id is not null or v_row.state <> 'creating' then
    insert into private.video_trash (teacher_id, course_id, video_id, provider, provider_asset_id)
    values (v_row.teacher_id, v_row.course_id, v_row.id, p_provider, p_asset);
    return pg_catalog.jsonb_build_object('answer', 'mismatch');
  end if;
  update public.draft_videos set state = 'processing', provider_asset_id = p_asset, checked_at = null where id = p_video;
  return pg_catalog.jsonb_build_object('answer', 'processing');
end
$$;

-- Asentar lo que dijo Mux. Solo estados terminales, para que una respuesta vieja no pise; sin `draft_open` ni revisiones. Lo llama quien
-- lee el editor, o quien revisa. Se vuelve la vigente solo con el curso en borrador. Lo que midió Mux manda: se cobra lo que la cabecera no
-- declaró, y lo que pasa del tope queda con error.
create function private.video_settle(p_video uuid, p_state text, p_playback text, p_seconds integer, p_captions boolean, p_error text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.draft_videos := private.video_owned(p_video);
  v_max_seconds integer := (private.parameter_value('VIDEO_DURACION_MAX'))::integer;
  v_extra integer;
begin
  if v_row.id is null and not private.actor_has_capability('content'::public.capability) then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  select * into v_row from public.draft_videos where id = p_video for update;
  if v_row.id is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  if p_state is null or p_state not in ('ready', 'errored')
     or (p_state = 'ready' and (coalesce(p_playback, '') = '' or p_seconds is null or p_seconds < 1)) then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  if v_row.state in ('ready', 'errored') then
    if v_row.state = 'ready' and coalesce(p_captions, false) and not v_row.captions_ready then
      update public.draft_videos set captions_ready = true where id = p_video;
    end if;
    perform private.video_promote(v_row.lesson_id);
    return pg_catalog.jsonb_build_object('answer', v_row.state);
  end if;
  if v_row.state <> 'processing' then
    return pg_catalog.jsonb_build_object('answer', 'invalid');
  end if;
  if p_state = 'errored' then
    update public.draft_videos set state = 'errored', error_code = left(coalesce(p_error, 'unknown'), 100), settled_at = now(), checked_at = now() where id = p_video;
    return pg_catalog.jsonb_build_object('answer', 'errored');
  end if;
  -- Sin el parámetro no se sabe: la fila sigue procesando, y nada se cobra ni se da por malo.
  if v_max_seconds is null then
    return pg_catalog.jsonb_build_object('answer', 'unavailable');
  end if;
  -- Al mes de ahora, y sin tope: lo que Mux procesó ya se gastó. El mes del reclamo puede no tener fila.
  v_extra := pg_catalog.ceil(p_seconds / 60.0)::integer - pg_catalog.ceil(v_row.read_seconds / 60.0)::integer;
  if v_extra > 0 then
    insert into private.video_usage as u (teacher_id, month, minutes)
    values (v_row.teacher_id, pg_catalog.date_trunc('month', now() at time zone private.period_zone())::date, v_extra)
    on conflict (teacher_id, month) do update set minutes = u.minutes + v_extra;
  end if;
  -- Lo que pasa del tope no se queda en Mux 7 días más: a la papelera, ya.
  if p_seconds > v_max_seconds then
    insert into private.video_trash (teacher_id, course_id, video_id, provider, provider_asset_id)
    values (v_row.teacher_id, v_row.course_id, v_row.id, v_row.provider, v_row.provider_asset_id);
    update public.draft_videos set state = 'errored', error_code = 'too_long', provider_asset_id = null, settled_at = now(), checked_at = now() where id = p_video;
    return pg_catalog.jsonb_build_object('answer', 'errored');
  end if;
  update public.draft_videos
     set state = 'ready', provider_playback_id = p_playback, duration_seconds = p_seconds,
         captions_ready = coalesce(p_captions, false), settled_at = now(), checked_at = now()
   where id = p_video;
  perform private.video_promote(v_row.lesson_id);
  return pg_catalog.jsonb_build_object('answer', 'ready');
end
$$;

-- Lo que toca preguntarle a Mux, reintentar o promover en un curso, y lo marca: una pestaña de más no multiplica las llamadas. Preguntar lo ve el
-- maestro dueño, también suspendido, y quien tiene Contenido; lo que gasta o cambia la vigente, solo el dueño activo con el curso en borrador. Los
-- subtítulos se preguntan aparte, porque Mux los termina después de `ready`: pasadas 6 h, una vez por hora, pero no se deja de preguntar.
create function private.video_due(p_course uuid) returns jsonb
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
    returning v.id, v.state, v.provider, v.provider_asset_id)
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('video', due.id, 'state', due.state, 'provider', due.provider, 'asset', due.provider_asset_id)), '[]'::jsonb)
    into v_result from due;
  return v_result;
end
$$;

-- Quitar o cancelar: la fila se va, y lo que nombraba queda en la papelera.
create function private.video_remove(p_course uuid, p_video uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.current_active_teacher_id();
  v_answer text;
  v_lesson uuid;
begin
  if v_teacher is null then
    return private.draft_refusal();
  end if;
  v_answer := private.draft_open(p_course, v_teacher);
  if v_answer is not null then
    return pg_catalog.jsonb_build_object('answer', v_answer);
  end if;
  select lesson_id into v_lesson from public.draft_videos where id = p_video and course_id = p_course;
  if v_lesson is null then
    return pg_catalog.jsonb_build_object('answer', 'not_found');
  end if;
  delete from public.draft_videos where id = p_video;
  perform private.video_promote(v_lesson);
  perform private.video_touch(p_course);
  return pg_catalog.jsonb_build_object('answer', 'deleted');
end
$$;

-- Lo que el servidor debe borrar de Mux y de la cubeta. Lo que `video_assets` nombra no se borra: se comparte con lo publicado, y sale
-- de la papelera sin tocar nada. Su maestro también suspendido: limpiar no le da nada.
create function private.video_trash_due(p_course uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := (select t.id from public.teachers t where t.profile_id = private.actor_id() and t.status in ('active', 'suspended'));
  v_result jsonb;
begin
  delete from private.video_trash x
   where x.teacher_id = v_teacher and x.course_id = p_course
     and exists (select 1 from public.video_assets a
                 where (x.provider_asset_id is not null and a.provider_asset_id = x.provider_asset_id)
                    or (x.storage_path is not null and a.original_path = x.storage_path));
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', x.id, 'provider', x.provider, 'asset', x.provider_asset_id, 'path', x.storage_path)), '[]'::jsonb)
    into v_result
  from (select * from private.video_trash y where y.teacher_id = v_teacher and y.course_id = p_course order by y.id limit 20) x;
  return v_result;
end
$$;

create function private.video_trash_done(p_course uuid, p_id bigint) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := (select t.id from public.teachers t where t.profile_id = private.actor_id() and t.status in ('active', 'suspended'));
begin
  delete from private.video_trash where id = p_id and teacher_id = v_teacher and course_id = p_course;
  return pg_catalog.jsonb_build_object('answer', case when found then 'done' else 'not_found' end);
end
$$;

-- Para ver lo que subió: su maestro (también suspendido) o Contenido. La vigente: lo que se revisa es lo que se publica.
create function private.video_preview(p_course uuid, p_lesson uuid) returns jsonb
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
  return pg_catalog.jsonb_build_object('answer', 'ok', 'playback', v_row.provider_playback_id, 'provider', v_row.provider, 'seconds', v_row.duration_seconds);
end
$$;

-- Lo que se vence. Solo filas: los objetos y los assets van a la papelera, que vacía el servidor o el repaso de quien opera.
create function private.video_expire() returns void
language sql security definer set search_path = ''
as $$
  delete from public.draft_videos v
   where (v.state = 'uploading' and v.created_at <= now() - interval '48 hours')
      or (v.state = 'uploaded' and v.created_at <= now() - interval '7 days')
      or (v.state = 'errored' and v.settled_at <= now() - interval '7 days')
$$;
revoke all on function private.video_expire() from public;
select cron.schedule('video_expire', '23 * * * *', 'select private.video_expire()');

-- El repaso, de quien opera. `trash`: lo que la papelera tiene, de cualquier curso y aunque el maestro ya no vuelva, con el video para buscar por
-- `passthrough` lo que no tiene asset. `orphan`: lo que sobra en la cubeta. `stuck`: lo que lleva más de un día creándose o procesándose, que nadie
-- está mirando y sigue nombrado: se decide a mano. Lo que lo publicado nombra sale de la papelera sin tocar nada. La aplicación no lo llama.
create function private.video_sweep() returns table (kind text, path text, video uuid, asset text, provider text, trash_id bigint)
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.video_expire();
  delete from private.video_trash x
   where exists (select 1 from public.video_assets a
                 where (x.provider_asset_id is not null and a.provider_asset_id = x.provider_asset_id)
                    or (x.storage_path is not null and a.original_path = x.storage_path));
  return query
    select 'trash'::text, x.storage_path, x.video_id, x.provider_asset_id, x.provider, x.id from private.video_trash x
    union all
    select 'orphan'::text, o.name, null::uuid, null::text, null::text, null::bigint from storage.objects o
    where o.bucket_id = 'video-originals'
      and not exists (select 1 from public.draft_videos v where v.storage_path = o.name)
      and not exists (select 1 from private.video_trash x where x.storage_path = o.name)
      and not exists (select 1 from public.video_assets a where a.original_path = o.name)
    union all
    select 'stuck'::text, v.storage_path, v.id, v.provider_asset_id, v.provider, null::bigint from public.draft_videos v
    where v.state in ('creating', 'processing') and coalesce(v.claimed_at, v.created_at) <= now() - interval '1 day';
end
$$;
revoke all on function private.video_sweep() from public;

do $$
declare f text;
begin
  foreach f in array array[
    'private.video_begin(uuid, uuid, text, text, bigint)',
    'private.video_file(uuid, uuid)',
    'private.video_confirm(uuid, uuid, boolean, integer)',
    'private.video_claim(uuid, uuid, text)',
    'private.video_create_failed(uuid, text)',
    'private.video_created(uuid, uuid, text, text)',
    'private.video_settle(uuid, text, text, integer, boolean, text)',
    'private.video_due(uuid)',
    'private.video_remove(uuid, uuid)',
    'private.video_trash_due(uuid)',
    'private.video_trash_done(uuid, bigint)',
    'private.video_preview(uuid, uuid)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to app_service', f);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------
-- El área `videos` del vigilante (carril B).

create function private.schema_violations_videos()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  video_functions (signature, server) as (
    values ('private.video_begin(uuid, uuid, text, text, bigint)', true),
           ('private.video_file(uuid, uuid)', true),
           ('private.video_confirm(uuid, uuid, boolean, integer)', true),
           ('private.video_claim(uuid, uuid, text)', true),
           ('private.video_create_failed(uuid, text)', true),
           ('private.video_created(uuid, uuid, text, text)', true),
           ('private.video_settle(uuid, text, text, integer, boolean, text)', true),
           ('private.video_due(uuid)', true),
           ('private.video_remove(uuid, uuid)', true),
           ('private.video_trash_due(uuid)', true),
           ('private.video_trash_done(uuid, bigint)', true),
           ('private.video_preview(uuid, uuid)', true),
           ('private.video_expire()', false),
           ('private.video_sweep()', false),
           ('private.video_touch(uuid)', false),
           ('private.video_owned(uuid)', false),
           ('private.video_promote(uuid)', false),
           ('private.video_to_trash()', false)),
  found as (
    select f.signature, f.server, p.oid, p.prosecdef, p.proconfig
    from video_functions f
    left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(f.signature)),
  bucket as (
    select b.public, b.file_size_limit, b.allowed_mime_types from storage.buckets b where b.id = 'video-originals')
  select 'video bucket missing', 'video-originals'
  where not exists (select 1 from bucket)
  union all
  select 'video bucket is public', 'video-originals' from bucket b where b.public is distinct from false
  union all
  select 'video bucket mime types differ', 'video-originals' from bucket b
  where b.allowed_mime_types is distinct from array['video/mp4', 'video/quicktime']
  union all
  select 'video bucket limit differs from the parameter', 'video-originals' from bucket b
  where b.file_size_limit is distinct from (private.parameter_value('VIDEO_TAMANO_MAX'))::bigint
  union all
  select 'video table writable by ' || r.rolname, 'public.draft_videos'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.draft_videos', 'INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.draft_videos', 'DELETE, TRUNCATE, TRIGGER')
  union all
  select 'video table readable by ' || r.rolname, 'public.draft_videos'
  from app_roles r
  where r.rolname <> 'authenticated'
    and pg_catalog.has_any_column_privilege(r.rolname::name, 'public.draft_videos', 'SELECT')
  union all
  select 'video path readable by ' || r.rolname, 'public.draft_videos'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.draft_videos', 'storage_path', 'SELECT')
     or pg_catalog.has_column_privilege(r.rolname::name, 'public.draft_videos', 'object_id', 'SELECT')
     or pg_catalog.has_column_privilege(r.rolname::name, 'public.draft_videos', 'object_version', 'SELECT')
     or pg_catalog.has_column_privilege(r.rolname::name, 'public.draft_videos', 'provider_asset_id', 'SELECT')
     or pg_catalog.has_column_privilege(r.rolname::name, 'public.draft_videos', 'provider_playback_id', 'SELECT')
  union all
  select 'video table without row level security', 'public.draft_videos'
  from pg_catalog.pg_class c where c.oid = 'public.draft_videos'::regclass and not c.relrowsecurity
  union all
  select 'video policy other than teacher read', p.polname::text
  from pg_catalog.pg_policy p
  where p.polrelid = 'public.draft_videos'::regclass
    and not (p.polname = 'draft_videos_teacher_select' and p.polcmd = 'r' and p.polpermissive
             and p.polroles = array['authenticated'::regrole]::oid[]
             and pg_catalog.pg_get_expr(p.polqual, p.polrelid) = '(teacher_id = ( SELECT private.current_teacher_id() AS current_teacher_id))')
  union all
  select 'video table without its teacher read policy', 'public.draft_videos'
  where not exists (select 1 from pg_catalog.pg_policy p where p.polrelid = 'public.draft_videos'::regclass and p.polname = 'draft_videos_teacher_select')
  union all
  select 'video table without guard', g.name
  from (values ('draft_videos_guard', 31, 'private.guard_draft()'), ('draft_videos_no_truncate', 34, 'private.guard_draft()'),
               ('draft_videos_to_trash', 11, 'private.video_to_trash()')) as g (name, kind, fn)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'public.draft_videos'::regclass and tg.tgname = g.name
      and tg.tgfoid = g.fn::regprocedure and tg.tgtype = g.kind and tg.tgenabled in ('O', 'A'))
  union all
  select 'video table with a foreign trigger', tg.tgname::text
  from pg_catalog.pg_trigger tg
  where tg.tgrelid = 'public.draft_videos'::regclass and not tg.tgisinternal
    and tg.tgname not in ('draft_videos_guard', 'draft_videos_no_truncate', 'draft_videos_to_trash')
  union all
  select 'video table without constraint ' || c.name, 'public.draft_videos'
  from (values
      ('draft_videos_course_fk', 'FOREIGN KEY (course_id, teacher_id) REFERENCES public.course_drafts(course_id, teacher_id) ON DELETE CASCADE'),
      ('draft_videos_lesson_fk', 'FOREIGN KEY (lesson_id, course_id) REFERENCES public.draft_lessons(id, course_id) ON DELETE CASCADE'),
      ('draft_videos_path_uq', 'UNIQUE (storage_path)'),
      ('draft_videos_current_is_ready', 'CHECK (((NOT is_current) OR (state = ''ready''::public.draft_video_state)))'),
      ('draft_videos_provider_known', 'CHECK ((provider = ANY (ARRAY[''mux''::text, ''test''::text])))'),
      ('draft_videos_confirmed', 'CHECK (((state = ''uploading''::public.draft_video_state) OR ((object_id IS NOT NULL) AND (object_version IS NOT NULL) AND (read_seconds > 0))))'),
      ('draft_videos_ready_is_complete', 'CHECK (((state <> ''ready''::public.draft_video_state) OR ((provider_asset_id IS NOT NULL) AND (provider_playback_id IS NOT NULL) AND (duration_seconds > 0))))')
    ) as c (name, definition)
  where not exists (
    select 1 from pg_catalog.pg_constraint k
    where k.conrelid = 'public.draft_videos'::regclass and k.conname = c.name and k.convalidated
      and pg_catalog.pg_get_constraintdef(k.oid) = c.definition)
  union all
  select 'video index differs ' || i.name, 'public.draft_videos'
  from (values
      ('public.draft_videos_current_uq', 'CREATE UNIQUE INDEX draft_videos_current_uq ON public.draft_videos USING btree (lesson_id) WHERE is_current'),
      ('public.draft_videos_other_uq', 'CREATE UNIQUE INDEX draft_videos_other_uq ON public.draft_videos USING btree (lesson_id) WHERE (NOT is_current)'),
      ('public.draft_videos_asset_uq', 'CREATE UNIQUE INDEX draft_videos_asset_uq ON public.draft_videos USING btree (provider, provider_asset_id) WHERE (provider_asset_id IS NOT NULL)')
    ) as i (name, definition)
  where pg_catalog.to_regclass(i.name) is null or pg_catalog.pg_get_indexdef(pg_catalog.to_regclass(i.name)) is distinct from i.definition
  union all
  select 'video trash readable by ' || r.rolname, 'private.video_trash'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'private.video_trash', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
  union all
  select 'video flags open to ' || r.rolname, 'private.local_flags'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'private.local_flags', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
  union all
  select 'video usage readable by ' || r.rolname, 'private.video_usage'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'private.video_usage', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
  union all
  select 'video job not scheduled', 'video_expire'
  where not exists (select 1 from cron.job j where j.jobname = 'video_expire' and j.active and j.command = 'select private.video_expire()')
  union all
  select 'video function missing', f.signature from found f where f.oid is null
  union all
  select 'video function not in the watchdog area', p.oid::regprocedure::text
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname in ('private', 'public')
  where p.proname like 'video\_%' and not exists (select 1 from found f where f.oid = p.oid)
  union all
  select 'video function executable by ' || r.rolname, f.signature
  from found f cross join app_roles r
  where f.oid is not null and (not f.server or r.rolname <> 'app_service')
    and pg_catalog.has_function_privilege(r.rolname::name, f.oid, 'EXECUTE')
  union all
  select 'video function not executable by app_service', f.signature
  from found f
  where f.oid is not null and f.server and not pg_catalog.has_function_privilege('app_service', f.oid, 'EXECUTE')
  union all
  select 'video function not security definer', f.signature
  from found f
  where f.oid is not null and f.signature <> 'private.video_to_trash()' and not f.prosecdef
  union all
  select 'video function without search path', f.signature
  from found f
  where f.oid is not null and not coalesce(f.proconfig, '{}') @> array['search_path=""']
$$;
revoke all on function private.schema_violations_videos() from public;
