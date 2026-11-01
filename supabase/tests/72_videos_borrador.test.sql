-- T-403, primera solicitud · Los videos del borrador (RF-604, FL-33, PA-43). Decisiones de Sergio del 2026-10-31.
-- El original sube primero a la cubeta privada `video-originals`, y Mux lo descarga de ahí. Cada video cuesta dinero: crearlo
-- en Mux se reclama bajo candado (sin doble cobro) y ahí se cuentan los topes, y un archivo que ya subió nunca se pierde por
-- una falla de Mux. Lo que una fila deja de nombrar va a una papelera, porque Mux no tiene una lista que consultar, y nada de lo
-- que lo publicado nombra se borra. Las reglas del área `videos` del vigilante, del carril B, se provocan aquí.
begin;
\ir _ayuda.psql
select plan(141);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a7200000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.m(p_n integer) returns uuid language sql immutable
as $$ select ('a7200000-0000-0000-0001-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.maestro(p_n integer) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  insert into public.teachers (id, profile_id, status) values (pruebas.m(p_n), pruebas.p(p_n), 'active');
  if private.current_legal_document('teacher_privacy_notice') is null then
    insert into public.legal_documents (doc_type, version, title, body, effective_from)
    values ('teacher_privacy_notice', 1, 'Aviso', 'Texto del aviso', now());
  end if;
  perform pruebas.limpiar();
  perform set_config('app.actor_id', pruebas.p(p_n)::text, true);
  insert into public.consents (profile_id, legal_document_id, origin)
  values (pruebas.p(p_n), private.current_legal_document('teacher_privacy_notice'), 'account_settings');
  perform pruebas.limpiar();
end
$$;
create table pruebas.ids (k text primary key, v uuid not null);
create function pruebas.id(p_k text) returns uuid language sql stable
as $$ select v from pruebas.ids where k = p_k $$;
create function pruebas.rj(p_id uuid, p_call text) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_id);
  execute 'select ' || p_call into v;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.r(p_id uuid, p_call text, p_k text default null) returns text
language plpgsql as $$
declare
  v jsonb := pruebas.rj(p_id, p_call);
begin
  if p_k is not null and coalesce(v ->> 'video', v ->> 'course', v ->> 'module', v ->> 'lesson') is not null then
    insert into pruebas.ids values (p_k, coalesce(v ->> 'video', v ->> 'course', v ->> 'module', v ->> 'lesson')::uuid)
    on conflict (k) do update set v = excluded.v;
  end if;
  return v ->> 'answer';
end
$$;
create function pruebas.empezar(p_id uuid, p_course uuid, p_lesson uuid, p_k text, p_name text default 'clase.mp4',
                                p_size bigint default 1000, p_mime text default 'video/mp4') returns text
language sql as $$
  select pruebas.r(p_id, format('private.video_begin(%L, %L, %L, %L, %s)', p_course, p_lesson, p_name, p_mime, p_size), p_k)
$$;
create function pruebas.fila(p_video uuid) returns public.draft_videos language sql stable
as $$ select * from public.draft_videos where id = p_video $$;
create function pruebas.estado(p_video uuid) returns text language sql stable
as $$ select state::text from public.draft_videos where id = p_video $$;
-- Lo que deja Storage al terminar una subida.
create function pruebas.objeto(p_path text, p_size bigint default 1000, p_mime text default 'video/mp4') returns uuid
language sql as $$
  insert into storage.objects (bucket_id, name, version, metadata)
  values ('video-originals', p_path, gen_random_uuid()::text, jsonb_build_object('size', p_size, 'mimetype', p_mime))
  returning id
$$;
create function pruebas.confirmar_video(p_id uuid, p_course uuid, p_video uuid, p_seconds integer default 600) returns text
language plpgsql as $$
begin
  perform pruebas.objeto((pruebas.fila(p_video)).storage_path);
  return pruebas.r(p_id, format('private.video_confirm(%L, %L, true, %s)', p_course, p_video, p_seconds));
end
$$;
create function pruebas.reclamar(p_id uuid, p_course uuid, p_video uuid) returns text
language sql as $$ select pruebas.r(p_id, format('private.video_claim(%L, %L, %L)', p_course, p_video, 'mux')) $$;
create function pruebas.creado(p_id uuid, p_video uuid, p_asset text) returns text
language sql as $$ select pruebas.r(p_id, format('private.video_created(%L, %L)', p_video, p_asset)) $$;
create function pruebas.asentar(p_id uuid, p_video uuid, p_state text, p_playback text default 'Play', p_seconds integer default 600,
                                p_captions boolean default false, p_error text default null) returns text
language sql as $$
  select pruebas.r(p_id, format('private.video_settle(%L, %L, %L, %s, %L, %L)', p_video, p_state, p_playback, coalesce(p_seconds::text, 'null'), p_captions, p_error))
$$;
-- Un video de principio a fin hasta `processing`.
create function pruebas.procesando(p_id uuid, p_course uuid, p_lesson uuid, p_k text, p_asset text) returns void
language plpgsql as $$
begin
  perform pruebas.empezar(p_id, p_course, p_lesson, p_k);
  perform pruebas.confirmar_video(p_id, p_course, pruebas.id(p_k));
  perform pruebas.reclamar(p_id, p_course, pruebas.id(p_k));
  perform pruebas.creado(p_id, pruebas.id(p_k), p_asset);
end
$$;
create function pruebas.basura() returns text[] language sql stable
as $$ select coalesce(array_agg(provider_asset_id order by provider_asset_id), '{}') from private.video_trash where provider_asset_id is not null $$;
create function pruebas.parametro(p_key text, p_value jsonb) returns void
language plpgsql as $$
begin
  alter table public.business_parameters disable trigger user;
  update public.business_parameters set value = p_value where key = p_key and canceled_at is null;
  alter table public.business_parameters enable trigger user;
end
$$;
create function pruebas.vigila() returns text[]
language sql as $$
  select coalesce(array_agg(v.problem order by v.problem), '{}') from private.schema_violations_videos() v
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;
grant select on pruebas.ids to anon, authenticated, app_service;
grant insert, update on pruebas.ids to anon, authenticated, app_service;

-- Ana (1) y Beto (2), maestros; Caro (3), maestra que después se suspende; Dani (4), alumna; Eva (5), de Contenido.
select pruebas.alta(pruebas.p(n), 'videos-' || n || '@prueba.test') from generate_series(1, 5) n;
select pruebas.confirmar(pruebas.p(n)) from generate_series(1, 5) n;
select pruebas.maestro(1), pruebas.maestro(2), pruebas.maestro(3);

select pruebas.r(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), 'Respirar'), 'curso');
select pruebas.r(pruebas.p(2), format('private.draft_create(%L, %L)', gen_random_uuid(), 'De Beto'), 'beto');
select pruebas.r(pruebas.p(3), format('private.draft_create(%L, %L)', gen_random_uuid(), 'De Caro'), 'caro');
select pruebas.r(pruebas.p(1), format('private.draft_add_module(%L, 1, %L)', pruebas.id('curso'), 'Inicio'), 'modulo');
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, 1, %L)', pruebas.id('curso'), pruebas.id('modulo'), 'Una'), 'l1');
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, 2, %L)', pruebas.id('curso'), pruebas.id('modulo'), 'Dos'), 'l2');
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, 3, %L)', pruebas.id('curso'), pruebas.id('modulo'), 'Tres'), 'l3');
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, 4, %L)', pruebas.id('curso'), pruebas.id('modulo'), 'Cuatro'), 'l4');
select pruebas.r(pruebas.p(2), format('private.draft_add_module(%L, 1, %L)', pruebas.id('beto'), 'De Beto'), 'modulo_beto');
select pruebas.r(pruebas.p(2), format('private.draft_add_lesson(%L, %L, 1, %L)', pruebas.id('beto'), pruebas.id('modulo_beto'), 'De Beto'), 'lb');
select pruebas.r(pruebas.p(3), format('private.draft_add_module(%L, 1, %L)', pruebas.id('caro'), 'De Caro'), 'modulo_caro');
select pruebas.r(pruebas.p(3), format('private.draft_add_lesson(%L, %L, 1, %L)', pruebas.id('caro'), pruebas.id('modulo_caro'), 'De Caro'), 'lc');

-- ---------------------------------------------------------------------------------------
-- El vigilante, la cubeta y los parámetros.

select is_empty('select * from private.schema_violations()', 'el vigilante no dice nada');
select ok((select array_agg(function_name) from private.watchdog_areas()) @> array['schema_violations_videos'], 'el área de los videos está entre las áreas');
select is((select public from storage.buckets where id = 'video-originals'), false, 'la cubeta de los originales es privada');
select is((select file_size_limit from storage.buckets where id = 'video-originals'), (private.parameter_value('VIDEO_TAMANO_MAX'))::bigint, 'su tope es el del parámetro');
select is((select allowed_mime_types from storage.buckets where id = 'video-originals'), array['video/mp4', 'video/quicktime'], 'y admite solo MP4 y MOV');
select is((private.parameter_value('VIDEO_TAMANO_MAX'))::bigint, 5368709120::bigint, 'el tope de tamaño: 5 GB (decisión de Sergio)');
select is((private.parameter_value('VIDEO_DURACION_MAX'))::int, 7200, 'de duración: 2 h');
select is((private.parameter_value('VIDEOS_POR_HORA_MAX'))::int, 10, 'por hora: 10');
select is((private.parameter_value('VIDEO_MINUTOS_MES_MAX'))::int, 1500, 'minutos al mes: 1 500');
select is((private.parameter_value('VIDEO_SUBIDA_ABIERTA'))::boolean, true, 'y el interruptor, abierto');

-- ---------------------------------------------------------------------------------------
-- Empezar.

select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('l1'), 'v1'), 'started', 'la maestra empieza en una lección suya');
select is((pruebas.fila(pruebas.id('v1'))).state::text, 'uploading', 'la fila nace subiendo');
select is((pruebas.fila(pruebas.id('v1'))).storage_path, pruebas.m(1) || '/' || pruebas.id('curso') || '/' || pruebas.id('v1'), 'la ruta la pone la base');
select is((pruebas.fila(pruebas.id('v1'))).is_current, false, 'y no es la vigente');
select is(pruebas.rj(pruebas.p(1), format('private.video_begin(%L, %L, %L, %L, 1000)', pruebas.id('curso'), pruebas.id('l1'), 'clase.mp4', 'video/mp4')) ->> 'answer', 'resumed', 'el mismo archivo otra vez: se reanuda');
select is(pruebas.rj(pruebas.p(1), format('private.video_begin(%L, %L, %L, %L, 1000)', pruebas.id('curso'), pruebas.id('l1'), 'clase.mp4', 'video/mp4')) ->> 'video', pruebas.id('v1')::text, 'y es la misma fila');
select is((select count(*)::int from public.draft_videos where lesson_id = pruebas.id('l1')), 1, 'sin una fila nueva');
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('l1'), 'x', 'otra.mp4'), 'pending', 'otro archivo con una subida a medias: se dice, para que la cancele');
select is(pruebas.rj(pruebas.p(1), format('private.video_begin(%L, %L, %L, %L, 1000)', pruebas.id('curso'), pruebas.id('l1'), 'otra.mp4', 'video/mp4')) ->> 'file_name', 'clase.mp4', 'con el nombre del que quedó, para «elige el mismo archivo»');

select is(pruebas.empezar(pruebas.p(2), pruebas.id('curso'), pruebas.id('l2'), 'x'), 'not_found', 'otro maestro no: no se le dice si el curso existe');
select is(pruebas.empezar(pruebas.p(4), pruebas.id('curso'), pruebas.id('l2'), 'x'), 'not_teacher', 'quien no es maestro, tampoco');
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('lb'), 'x'), 'not_found', 'una lección de otro curso, tampoco');
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('l2'), 'x', 'clase.avi', 1000, 'video/x-msvideo'), 'invalid', 'un tipo que no se admite');
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('l2'), 'x', 'clase.mp4', 0), 'invalid', 'un tamaño sin sentido');
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('l2'), 'x', E'cla\nse.mp4'), 'invalid', 'un nombre con un salto de línea');
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('l2'), 'x', 'clase.mp4', 5368709121), 'too_large', 'más que el tope');
select pruebas.parametro('VIDEO_SUBIDA_ABIERTA', 'false');
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('l2'), 'x'), 'closed', 'con el interruptor cerrado no empieza');
select pruebas.parametro('VIDEO_SUBIDA_ABIERTA', 'true');

-- El archivo, para firmar y renovar: solo de quien sube, y solo mientras sube.
select is(pruebas.rj(pruebas.p(1), format('private.video_file(%L, %L)', pruebas.id('curso'), pruebas.id('v1'))) ->> 'path', (pruebas.fila(pruebas.id('v1'))).storage_path, 'su maestra pide la ruta para firmar');
select is(pruebas.r(pruebas.p(2), format('private.video_file(%L, %L)', pruebas.id('curso'), pruebas.id('v1'))), 'not_found', 'otra no');
select is(pruebas.r(pruebas.p(1), format('private.video_file(%L, %L)', pruebas.id('beto'), pruebas.id('v1'))), 'not_found', 'ni pasando por un curso ajeno');

-- ---------------------------------------------------------------------------------------
-- Confirmar: compara lo que Storage guardó.

select is(pruebas.r(pruebas.p(1), format('private.video_confirm(%L, %L, true, 600)', pruebas.id('curso'), pruebas.id('v1'))), 'not_uploaded', 'sin objeto no se confirma');
select pruebas.objeto((pruebas.fila(pruebas.id('v1'))).storage_path);
select is(pruebas.r(pruebas.p(1), format('private.video_confirm(%L, %L, null, null)', pruebas.id('curso'), pruebas.id('v1'))), 'unavailable', 'si no se pudo leer el contenido, «no se supo»');
select is(pruebas.estado(pruebas.id('v1')), 'uploading', 'y la fila se queda');
select is(pruebas.r(pruebas.p(1), format('private.video_confirm(%L, %L, true, 600)', pruebas.id('curso'), pruebas.id('v1'))), 'uploaded', 'con todo en orden, subido');
select is(pruebas.estado(pruebas.id('v1')), 'uploaded', 'cambia de estado');
select is((pruebas.fila(pruebas.id('v1'))).object_id, (select id from storage.objects where bucket_id = 'video-originals' and name = (pruebas.fila(pruebas.id('v1'))).storage_path), 'y recuerda qué objeto confirmó');
select ok((pruebas.fila(pruebas.id('v1'))).object_version is not null, 'con su versión');
select is((pruebas.fila(pruebas.id('v1'))).read_seconds, 600, 'y la duración leída del archivo');
select is(pruebas.r(pruebas.p(1), format('private.video_confirm(%L, %L, true, 600)', pruebas.id('curso'), pruebas.id('v1'))), 'uploaded', 'confirmar otra vez no cambia nada');

create function pruebas.rechazo(p_lesson text, p_size bigint, p_mime text, p_ok boolean, p_seconds integer) returns text
language plpgsql as $$
declare
  v jsonb;
  v_video uuid;
begin
  perform pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id(p_lesson), 'r');
  v_video := pruebas.id('r');
  perform pruebas.objeto((pruebas.fila(v_video)).storage_path, p_size, p_mime);
  v := pruebas.rj(pruebas.p(1), format('private.video_confirm(%L, %L, %L, %s)', pruebas.id('curso'), v_video, p_ok, coalesce(p_seconds::text, 'null')));
  if pruebas.fila(v_video) is not null and (pruebas.fila(v_video)).id is not null then
    return 'la fila se quedó';
  end if;
  return v ->> 'answer' || ':' || (v ->> 'reason');
end
$$;
select is(pruebas.rechazo('l2', 1000, 'video/quicktime', true, 600), 'rejected:type', 'otro tipo del que dijo: se rechaza y la fila se va');
select is(pruebas.rechazo('l2', 5368709121, 'video/mp4', true, 600), 'rejected:size', 'más que el tope, según Storage');
select is(pruebas.rechazo('l2', 1000, 'video/mp4', false, null), 'rejected:content', 'el contenido no corresponde');
select is(pruebas.rechazo('l2', 1000, 'video/mp4', true, null), 'rejected:duration', 'sin duración legible: el tope de minutos no serviría');
select is(pruebas.rechazo('l2', 1000, 'video/mp4', true, 7201), 'rejected:too_long', 'más de 2 h');
select is(pruebas.rechazo('l2', 1000, 'video/mp4', true, 0), 'rejected:duration', 'una duración de 0');

-- ---------------------------------------------------------------------------------------
-- Reclamar: sin doble cobro, y los topes aquí.

select is(pruebas.rj(pruebas.p(1), format('private.video_claim(%L, %L, %L)', pruebas.id('curso'), pruebas.id('v1'), 'mux')) ->> 'answer', 'claimed', 'el primero reclama');
select is(pruebas.estado(pruebas.id('v1')), 'creating', 'y queda creando');
select is(pruebas.reclamar(pruebas.p(1), pruebas.id('curso'), pruebas.id('v1')), 'busy', 'el segundo no: no hay doble cobro');
select is(pruebas.r(pruebas.p(1), format('private.video_create_failed(%L)', pruebas.id('v1'))), 'uploaded', 'si Mux falla, vuelve a subido: el archivo no se pierde');
select is(pruebas.estado(pruebas.id('v1')), 'uploaded', 'y se puede reintentar');
select is(pruebas.reclamar(pruebas.p(1), pruebas.id('curso'), pruebas.id('v1')), 'claimed', 'reclama otra vez');
select is((select hits::int from private.rate_limit_counters where bucket = 'video_claim:' || pruebas.m(1)), 1, 'reintentar no gasta el cupo otra vez');
select is((select hits::int from private.rate_limit_counters where bucket = 'video_minutes:' || pruebas.m(1)), 10, 'ni los minutos: 600 s son 10');
update public.draft_videos set claimed_at = now() - interval '6 minutes' where id = pruebas.id('v1');
select is(pruebas.rj(pruebas.p(1), format('private.video_claim(%L, %L, %L)', pruebas.id('curso'), pruebas.id('v1'), 'mux')) ->> 'retry', 'true', 'un reclamo vencido se retoma, y avisa: hay que buscar en Mux antes de crear');
select is(pruebas.creado(pruebas.p(2), pruebas.id('v1'), 'AssetOtro'), 'not_found', 'otro maestro no le pone asset');
select is(pruebas.creado(pruebas.p(1), pruebas.id('v1'), 'Asset1'), 'processing', 'con el asset, procesando');
select is((pruebas.fila(pruebas.id('v1'))).provider_asset_id, 'Asset1', 'anotado');
select is(pruebas.creado(pruebas.p(1), pruebas.id('v1'), 'Asset1'), 'processing', 'el mismo otra vez, sin cambio');
select is(pruebas.creado(pruebas.p(1), pruebas.id('v1'), 'AssetDos'), 'mismatch', 'otro asset no lo pisa: el servidor debe borrar el que sobra');
select is(pruebas.r(pruebas.p(1), format('private.video_claim(%L, %L, %L)', pruebas.id('curso'), pruebas.id('v1'), 'test')), 'done', 'lo ya creado no se reclama');

-- `test` solo con la marca que pone el guion local. En producción nadie la pone.
select pruebas.empezar(pruebas.p(2), pruebas.id('beto'), pruebas.id('lb'), 'vb');
select pruebas.confirmar_video(pruebas.p(2), pruebas.id('beto'), pruebas.id('vb'));
delete from private.local_flags where flag = 'video_test';
select is(pruebas.r(pruebas.p(2), format('private.video_claim(%L, %L, %L)', pruebas.id('beto'), pruebas.id('vb'), 'test')), 'invalid', 'sin la marca local, el proveedor de prueba no entra');
insert into private.local_flags (flag) values ('video_test');
select is(pruebas.r(pruebas.p(2), format('private.video_claim(%L, %L, %L)', pruebas.id('beto'), pruebas.id('vb'), 'test')), 'claimed', 'con él, sí');
select is((pruebas.fila(pruebas.id('vb'))).provider, 'test', 'y queda anotado');
select is(pruebas.r(pruebas.p(2), format('private.video_claim(%L, %L, %L)', pruebas.id('beto'), pruebas.id('vb'), 'otro')), 'busy', 'mientras tanto, nadie más');

-- Los topes se cuentan al reclamar. Sin correr de verdad diez videos: se llenan los contadores.
select pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('l2'), 'v2');
select pruebas.confirmar_video(pruebas.p(1), pruebas.id('curso'), pruebas.id('v2'));
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('l2'), 'x', 'otra.mp4'), 'busy', 'con uno ya subido no se empieza otro: se perdería lo que tardó horas');
update private.rate_limit_counters set hits = 10 where bucket = 'video_claim:' || pruebas.m(1);
select is(pruebas.reclamar(pruebas.p(1), pruebas.id('curso'), pruebas.id('v2')), 'throttled', 'con diez en la hora, no');
select is(pruebas.estado(pruebas.id('v2')), 'uploaded', 'y queda subido, sin perderse');
update private.rate_limit_counters set hits = 1 where bucket = 'video_claim:' || pruebas.m(1);
update private.rate_limit_counters set hits = 1495 where bucket = 'video_minutes:' || pruebas.m(1);
select is(pruebas.reclamar(pruebas.p(1), pruebas.id('curso'), pruebas.id('v2')), 'over_minutes', 'si no caben sus minutos en el mes, no');
select is((select hits::int from private.rate_limit_counters where bucket = 'video_minutes:' || pruebas.m(1)), 1495, 'y lo gastado sigue como estaba');
select pruebas.parametro('VIDEO_MINUTOS_MES_MAX', '5');
delete from private.rate_limit_counters where bucket = 'video_minutes:' || pruebas.m(1);
select is(pruebas.reclamar(pruebas.p(1), pruebas.id('curso'), pruebas.id('v2')), 'over_minutes', 'un solo video que no cabe, tampoco');
select pruebas.parametro('VIDEO_MINUTOS_MES_MAX', '1500');
select is((select hits::int from private.rate_limit_counters where bucket = 'video_claim:' || pruebas.m(1)), 1, 'y no gasta la hora');
select pruebas.parametro('VIDEO_SUBIDA_ABIERTA', 'false');
select is(pruebas.reclamar(pruebas.p(1), pruebas.id('curso'), pruebas.id('v2')), 'closed', 'con el interruptor cerrado, no se crea en Mux');
select pruebas.parametro('VIDEO_SUBIDA_ABIERTA', 'true');
select is(pruebas.reclamar(pruebas.p(1), pruebas.id('curso'), pruebas.id('v2')), 'claimed', 'abierto, sí');
select pruebas.creado(pruebas.p(1), pruebas.id('v2'), 'Asset2');

-- ---------------------------------------------------------------------------------------
-- Asentar lo que dijo Mux: solo estados terminales, sin revisiones.

create function pruebas.revisiones(p_lesson uuid) returns text language sql stable
as $$ select (select revision from public.draft_lessons where id = p_lesson)::text || '/' ||
             (select content_revision from public.course_drafts c join public.draft_lessons l on l.course_id = c.course_id where l.id = p_lesson)::text $$;
create temporary table antes on commit drop as select pruebas.revisiones(pruebas.id('l1')) as r;
select is(pruebas.asentar(pruebas.p(2), pruebas.id('v1'), 'ready'), 'not_found', 'otro maestro no asienta');
select is(pruebas.asentar(pruebas.p(4), pruebas.id('v1'), 'ready'), 'not_found', 'una alumna tampoco');
select is(pruebas.asentar(pruebas.p(1), pruebas.id('v1'), 'processing'), 'invalid', 'solo lo terminal');
select is(pruebas.asentar(pruebas.p(1), pruebas.id('v1'), 'ready', null, 600), 'invalid', 'listo sin playback, no');
select is(pruebas.asentar(pruebas.p(1), pruebas.id('v1'), 'ready'), 'ready', 'listo');
select is((pruebas.fila(pruebas.id('v1'))).is_current, true, 'y es la vigente');
select is((pruebas.fila(pruebas.id('v1'))).duration_seconds, 600, 'con la duración que mide Mux');
select is(pruebas.revisiones(pruebas.id('l1')), (select r from antes), 'no sube revisiones: a quien escribe no le contesta «cambió»');
select is(pruebas.asentar(pruebas.p(1), pruebas.id('v1'), 'errored', null, null, false, 'tarde'), 'ready', 'una respuesta vieja no pisa lo terminal');
select is(pruebas.asentar(pruebas.p(1), pruebas.id('v1'), 'ready', 'Play', 600, true), 'ready', 'los subtítulos se anotan después');
select is((pruebas.fila(pruebas.id('v1'))).captions_ready, true, 'sin más cambios');

-- Reemplazar: el anterior sigue hasta que el nuevo está listo.
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('l1'), 'v1b', 'nuevo.mp4'), 'started', 'con una vigente se puede empezar otro');
select pruebas.confirmar_video(pruebas.p(1), pruebas.id('curso'), pruebas.id('v1b'));
select pruebas.reclamar(pruebas.p(1), pruebas.id('curso'), pruebas.id('v1b'));
select pruebas.creado(pruebas.p(1), pruebas.id('v1b'), 'Asset1b');
select is((pruebas.fila(pruebas.id('v1'))).is_current, true, 'mientras procesa, sigue la anterior');
select pruebas.asentar(pruebas.p(1), pruebas.id('v1b'), 'ready', 'Play1b');
select is((pruebas.fila(pruebas.id('v1b'))).is_current, true, 'lista, es la vigente');
select is((pruebas.fila(pruebas.id('v1'))).id, null::uuid, 'y la anterior se fue');
select ok('Asset1' = any(pruebas.basura()), 'a la papelera, con su asset');

-- Un curso enviado no cambia de video: lo que se revisa es lo que se publica.
select pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('l1'), 'v1c', 'tercero.mp4');
select pruebas.confirmar_video(pruebas.p(1), pruebas.id('curso'), pruebas.id('v1c'));
select pruebas.reclamar(pruebas.p(1), pruebas.id('curso'), pruebas.id('v1c'));
select pruebas.creado(pruebas.p(1), pruebas.id('v1c'), 'Asset1c');
select pruebas.como_dueno_sistema();
update public.course_registry set state = 'in_review' where course_id = pruebas.id('curso');
select pruebas.limpiar();
select is(pruebas.asentar(pruebas.p(1), pruebas.id('v1c'), 'ready', 'Play1c'), 'ready', 'con el curso en revisión, asentar funciona');
select is((pruebas.fila(pruebas.id('v1c'))).is_current, false, 'pero no se vuelve la vigente');
select is((pruebas.fila(pruebas.id('v1b'))).is_current, true, 'sigue la de antes');
select is(pruebas.rj(pruebas.p(5), format('private.video_preview(%L, %L)', pruebas.id('curso'), pruebas.id('l1'))) ->> 'answer', 'not_found', 'sin Contenido no la ve');
select pruebas.como_dueno_sistema();
update public.course_registry set state = 'draft' where course_id = pruebas.id('curso');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Ver lo suyo.

select is(pruebas.rj(pruebas.p(1), format('private.video_preview(%L, %L)', pruebas.id('curso'), pruebas.id('l1'))) ->> 'playback', 'Play1b', 'su maestra ve la vigente');
select is(pruebas.r(pruebas.p(2), format('private.video_preview(%L, %L)', pruebas.id('curso'), pruebas.id('l1'))), 'not_found', 'otro maestro no');
select is(pruebas.r(pruebas.p(1), format('private.video_preview(%L, %L)', pruebas.id('curso'), pruebas.id('l4'))), 'not_found', 'sin video lista, nada');

-- ---------------------------------------------------------------------------------------
-- Lo que hay que preguntarle a Mux, con límite por fila.

select pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('l3'), 'v3');
select pruebas.confirmar_video(pruebas.p(1), pruebas.id('curso'), pruebas.id('v3'));
select pruebas.reclamar(pruebas.p(1), pruebas.id('curso'), pruebas.id('v3'));
select pruebas.creado(pruebas.p(1), pruebas.id('v3'), 'Asset3');
select ok(pruebas.rj(pruebas.p(1), format('private.video_due(%L)', pruebas.id('curso'))) @> jsonb_build_array(jsonb_build_object('video', pruebas.id('v3'), 'asset', 'Asset3', 'state', 'processing')), 'lo que procesa toca preguntarlo');
select ok(not pruebas.rj(pruebas.p(1), format('private.video_due(%L)', pruebas.id('curso'))) @> jsonb_build_array(jsonb_build_object('video', pruebas.id('v3'))), 'y dentro de 10 s, ya no: una pestaña de más no multiplica las llamadas');
update public.draft_videos set checked_at = now() - interval '11 seconds' where id = pruebas.id('v3');
select ok(pruebas.rj(pruebas.p(1), format('private.video_due(%L)', pruebas.id('curso'))) @> jsonb_build_array(jsonb_build_object('video', pruebas.id('v3'))), 'pasados, otra vez');
update public.draft_videos set checked_at = null where id = pruebas.id('v3');
select is(pruebas.rj(pruebas.p(2), format('private.video_due(%L)', pruebas.id('curso'))), '[]'::jsonb, 'otro maestro no ve nada');
select is((pruebas.fila(pruebas.id('v3'))).checked_at, null::timestamptz, 'y no gasta la vuelta de nadie');

-- ---------------------------------------------------------------------------------------
-- Con error, quitar, y la papelera.

select pruebas.asentar(pruebas.p(1), pruebas.id('v3'), 'errored', null, null, false, 'invalid_input');
select is((pruebas.fila(pruebas.id('v3'))).error_code, 'invalid_input', 'el error queda con su causa');
select is(pruebas.empezar(pruebas.p(1), pruebas.id('curso'), pruebas.id('l3'), 'v3b', 'otro.mp4'), 'started', 'subir otro se lleva el que falló');
select is((pruebas.fila(pruebas.id('v3'))).id, null::uuid, 'su fila se va');
select ok('Asset3' = any(pruebas.basura()), 'y su asset, a la papelera');

select is(pruebas.r(pruebas.p(2), format('private.video_remove(%L, %L)', pruebas.id('curso'), pruebas.id('v3b'))), 'not_found', 'otro maestro no quita');
select is(pruebas.r(pruebas.p(1), format('private.video_remove(%L, %L)', pruebas.id('curso'), pruebas.id('v3b'))), 'deleted', 'su maestra quita o cancela');
select is((select count(*)::int from private.video_trash where storage_path like '%' || pruebas.id('v3b')), 1, 'y la ruta va a la papelera');

-- La cascada también: borrar una lección no deja sin nombre lo que se paga.
select is(pruebas.r(pruebas.p(1), format('private.draft_delete_lesson(%L, %L, %s)', pruebas.id('curso'), pruebas.id('l2'), (select revision from public.draft_lessons where id = pruebas.id('l2')))), 'deleted', 'borrar una lección con video');
select ok('Asset2' = any(pruebas.basura()), 'manda su asset a la papelera');

-- Vaciar la papelera: solo lo suyo. Nada que lo publicado nombre sale de ahí como borrable.
select ok((select bool_or(e ->> 'asset' = 'Asset1') from jsonb_array_elements(pruebas.rj(pruebas.p(1), format('private.video_trash_due(%L)', pruebas.id('curso')))) e), 'su maestra ve qué borrar');
select is(pruebas.rj(pruebas.p(2), format('private.video_trash_due(%L)', pruebas.id('curso'))), '[]'::jsonb, 'otra no');
insert into private.video_trash (teacher_id, course_id, provider_asset_id, storage_path) values (pruebas.m(1), pruebas.id('curso'), 'AssetPublicado', 'x/y/z');
select pruebas.como_dueno_sistema();
alter table public.video_assets disable trigger user;
insert into public.video_assets (course_id, teacher_id, lesson_id, provider, provider_asset_id, provider_playback_id, status, duration_seconds)
values (pruebas.id('curso'), pruebas.m(1), gen_random_uuid(), 'mux', 'AssetPublicado', 'PlayPublicado', 'ready', 60);
alter table public.video_assets enable trigger user;
select pruebas.limpiar();
select is(pruebas.rj(pruebas.p(2), format('private.video_trash_due(%L)', pruebas.id('curso'))), '[]'::jsonb, 'otro maestro no ve esa papelera');
select is((select count(*)::int from private.video_trash where provider_asset_id = 'AssetPublicado'), 1, 'ni la toca');
select ok(not coalesce((select bool_or(e ->> 'asset' = 'AssetPublicado') from jsonb_array_elements(pruebas.rj(pruebas.p(1), format('private.video_trash_due(%L)', pruebas.id('curso')))) e), false), 'lo que lo publicado nombra no se borra');
select is((select count(*)::int from private.video_trash where provider_asset_id = 'AssetPublicado'), 0, 'y sale de la papelera sin tocar nada');
select is(pruebas.r(pruebas.p(1), format('private.video_trash_done(%L, %s)', pruebas.id('curso'), (select id from private.video_trash where provider_asset_id = 'Asset1'))), 'done', 'borrado, se anota');
select is((select count(*)::int from private.video_trash where provider_asset_id = 'Asset1'), 0, 'y se va');

-- ---------------------------------------------------------------------------------------
-- Una maestra suspendida.

select pruebas.empezar(pruebas.p(3), pruebas.id('caro'), pruebas.id('lc'), 'vc');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'prueba', suspension_notice = 'x' where id = pruebas.m(3);
select pruebas.limpiar();
select is(pruebas.empezar(pruebas.p(3), pruebas.id('caro'), pruebas.id('lc'), 'x'), 'suspended', 'no empieza');
select is(pruebas.r(pruebas.p(3), format('private.video_remove(%L, %L)', pruebas.id('caro'), pruebas.id('vc'))), 'suspended', 'ni quita');
select is(pruebas.rj(pruebas.p(3), format('private.video_due(%L)', pruebas.id('caro'))), '[]'::jsonb, 'nada que preguntar');

-- ---------------------------------------------------------------------------------------
-- Lo que se vence.

update public.draft_videos set state = 'errored', error_code = 'x', created_at = now() - interval '8 days', settled_at = now() - interval '8 days' where id = pruebas.id('vb');
select private.video_expire();
select is((pruebas.fila(pruebas.id('vb'))).id, null::uuid, 'con error y sin que nadie lo toque en 7 días, se va');
select is(pruebas.empezar(pruebas.p(2), pruebas.id('beto'), pruebas.id('lb'), 'vx', 'clase.mp4'), 'started', 'y la lección queda libre');
update public.draft_videos set created_at = now() - interval '49 hours' where id = pruebas.id('vx');
select private.video_expire();
select is((pruebas.fila(pruebas.id('vx'))).id, null::uuid, 'una subida sin terminar a las 48 h, también');
select ok(exists (select 1 from cron.job where jobname = 'video_expire' and active), 'lo corre un trabajo programado');

-- ---------------------------------------------------------------------------------------
-- Quién lee y quién escribe.

select pruebas.como_usuario(pruebas.p(1));
select ok((select count(*) from public.draft_videos) > 0, 'su maestra lee los suyos');
select throws_ok('select storage_path from public.draft_videos', '42501', null, 'sin la ruta');
select throws_ok('select provider_asset_id from public.draft_videos', '42501', null, 'ni el asset');
select throws_ok('select provider_playback_id from public.draft_videos', '42501', null, 'ni el playback');
select pruebas.limpiar();
select pruebas.como_usuario(pruebas.p(4));
select is((select count(*)::int from public.draft_videos), 0, 'una alumna, nada');
select pruebas.limpiar();
select pruebas.como_visitante();
select throws_ok('select id from public.draft_videos', '42501', null, 'un visitante, tampoco');
select pruebas.limpiar();
select pruebas.como_dueno();
select throws_ok('truncate public.draft_videos', '42501', 'public.draft_videos: drafts are not truncated', 'no se vacía');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Las reglas del vigilante se provocan.

select is(pruebas.vigila(), '{}', 'el área está limpia');
grant select (storage_path) on public.draft_videos to authenticated;
select ok('video path readable by authenticated' = any(pruebas.vigila()), 'la ruta a la vista se nota');
revoke select (storage_path) on public.draft_videos from authenticated;
grant insert on public.draft_videos to app_service;
select ok('video table writable by app_service' = any(pruebas.vigila()), 'que el servidor escriba se nota');
revoke insert on public.draft_videos from app_service;
create policy abierta on public.draft_videos for select to anon using (true);
select ok('video policy other than teacher read' = any(pruebas.vigila()), 'una política de más se nota');
drop policy abierta on public.draft_videos;
alter table public.draft_videos disable trigger draft_videos_to_trash;
select ok('video table without guard' = any(pruebas.vigila()), 'sin el disparador de la papelera, se nota');
alter table public.draft_videos enable trigger draft_videos_to_trash;
update storage.buckets set public = true where id = 'video-originals';
select ok('video bucket is public' = any(pruebas.vigila()), 'la cubeta pública se nota');
update storage.buckets set public = false where id = 'video-originals';
grant execute on function private.video_claim(uuid, uuid, text) to authenticated;
select ok('video function executable by authenticated' = any(pruebas.vigila()), 'reclamar en manos de la persona se nota');
revoke execute on function private.video_claim(uuid, uuid, text) from authenticated;
grant select on private.video_trash to app_service;
select ok('video trash readable by app_service' = any(pruebas.vigila()), 'la papelera a la vista se nota');
revoke select on private.video_trash from app_service;
select is(pruebas.vigila(), '{}', 'y al deshacerlo queda limpia');

select * from finish();
rollback;
