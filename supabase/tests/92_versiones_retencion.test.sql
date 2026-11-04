-- T-405, quinta solicitud · Lo que una versión retira, y cuándo se borra su archivo (decisiones de Sergio del 2026-11-03). La fila se queda siempre. El video en Mux se borra pasados
-- VIDEO_RETIRADO_PROVEEDOR_DIAS desde que se retiró, y el original en la cubeta y el archivo de un recurso pasados ARCHIVO_RETIRADO_DIAS. Lo da `retired_files_due` a quien opera, que
-- borra y lo anota con `retired_file_done`; nada de lo vigente ni de una versión abierta sale. Y el área `versions` del vigilante. Pasa con los borradores legales cargados y sin ellos.
begin;
\ir _ayuda.psql
\ir _versiones.psql
select plan(33);

create function pruebas.vencido(p_kind text) returns text[]
language sql as $$
  select coalesce(array_agg(d.id::text order by d.id), '{}') from private.retired_files_due() d where d.kind = p_kind
    and d.id in (select id from public.video_assets where course_id = pruebas.id('curso') union all select id from public.published_resources where course_id = pruebas.id('curso'))
$$;
create function pruebas.atrasar(p_days text) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno();
  alter table public.video_assets disable trigger user;
  update public.video_assets set retired_at = now() - ((private.parameter_value(p_days))::integer + 1) * interval '1 day'
  where course_id = pruebas.id('curso') and retired_at is not null;
  alter table public.video_assets enable trigger user;
  alter table public.published_resources disable trigger user;
  update public.published_resources set retired_at = now() - ((private.parameter_value(p_days))::integer + 1) * interval '1 day'
  where course_id = pruebas.id('curso') and retired_at is not null;
  alter table public.published_resources enable trigger user;
end
$$;
create function pruebas.vigila_versiones() returns text[]
language sql as $$ select coalesce(array_agg(v.problem order by v.problem), '{}') from private.schema_violations_versions() v $$;
create function pruebas.vigila_envios() returns text[]
language sql as $$ select coalesce(array_agg(v.problem order by v.problem), '{}') from private.schema_violations_submissions() v $$;

-- Una versión que quita «Postura» (con su video y su recurso), y se publica.
select pruebas.abrir(1, 'curso');
select pruebas.r(pruebas.p(1), format('private.draft_delete_lesson(%L, %L, %s)', pruebas.id('curso'), pruebas.id('l1'), pruebas.rev('draft_lessons', 'l1')));
select pruebas.enviar(1, 'curso');
select pruebas.aprobar('curso');
select pruebas.como_dueno();

select is(pruebas.estado('curso'), 'published', 'la versión se publicó');
select is((select retired_at is not null from public.video_assets where id = :'v1'), true, 'el video de «Postura» quedó retirado');
select is(pruebas.vencido('provider') || pruebas.vencido('original') || pruebas.vencido('resource'), '{}', 'recién retirado, nada vence');

-- ---------------------------------------------------------------------------------------
-- Pasado el plazo del proveedor, el video vence en Mux; el original todavía no.

select pruebas.atrasar('VIDEO_RETIRADO_PROVEEDOR_DIAS');
select is(pruebas.vencido('provider'), array[:'v1'], 'pasado su plazo, el video retirado vence en el proveedor');
select is(pruebas.vencido('original'), '{}', 'su original todavía no: su plazo es más largo');
select is((select d.asset from private.retired_files_due() d where d.kind = 'provider' and d.id = :'v1'), 'asset-' || :'v1', 'con su asset, para borrarlo');

-- Una versión abierta cuyo borrador nombrara ese asset lo detiene.
select pruebas.abrir(1, 'curso');
select pruebas.como_dueno();
insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                 provider, provider_asset_id)
values (gen_random_uuid(), pruebas.id('curso'), pruebas.m(1), pruebas.id('l2'), 'processing', false, 'clase.mp4', 'video/mp4', 'otra/ruta/' || gen_random_uuid(), 1000,
        gen_random_uuid(), 'v1', 300, 'mux', 'asset-' || :'v1');
select is(pruebas.vencido('provider'), '{}', 'lo que un borrador nombra no vence en el proveedor');
select pruebas.descartar(1, 'curso');
select pruebas.como_dueno();
delete from private.video_trash where course_id = pruebas.id('curso');
select is(private.retired_file_done('provider', :'v1'), 'done', 'quien opera lo anota después de borrarlo');
select isnt((select provider_deleted_at from public.video_assets where id = :'v1'), null, 'con la fecha');
select is((select retired_at is not null and status = 'ready' and provider_asset_id is not null from public.video_assets where id = :'v1'), true, 'la fila se queda, con su asset');
select is(pruebas.vencido('provider'), '{}', 'y ya no vence');
select is(private.retired_file_done('provider', :'v1'), 'not_due', 'anotarlo dos veces no hace nada');
select is(private.retired_file_done('provider', :'v2'), 'not_due', 'un video vigente nunca se anota');
select is(private.retired_file_done('provider', gen_random_uuid()), 'not_due', 'ni uno que no existe');
select is(private.retired_file_done('otro', :'v1'), 'invalid', 'ni otra cosa');

-- ---------------------------------------------------------------------------------------
-- Pasado el plazo de los archivos, el original y el recurso.

select pruebas.atrasar('ARCHIVO_RETIRADO_DIAS');
select is(pruebas.vencido('original'), array[:'v1'], 'el original vence');
select is((select d.path from private.retired_files_due() d where d.kind = 'original' and d.id = :'v1'),
  (select original_path from public.video_assets where id = :'v1'), 'con su ruta en la cubeta');
select is(pruebas.vencido('resource'), array[:'rl'], 'y el recurso retirado');

-- Una versión abierta que nombrara ese original lo detiene.
select pruebas.abrir(1, 'curso');
select pruebas.como_dueno();
insert into public.draft_videos (id, course_id, teacher_id, lesson_id, state, is_current, file_name, mime, storage_path, size_bytes, object_id, object_version, read_seconds,
                                 provider, provider_asset_id, provider_playback_id, duration_seconds)
select gen_random_uuid(), pruebas.id('curso'), pruebas.m(1), pruebas.id('l2'), 'uploaded', false, 'clase.mp4', 'video/mp4', a.original_path, 1000, a.object_id, 'v1', 300,
       'mux', null, null, null
from public.video_assets a where a.id = :'v1';
insert into public.draft_resources (id, course_id, teacher_id, lesson_id, title, kind, mime, storage_path, size_bytes)
select gen_random_uuid(), pruebas.id('curso'), pruebas.m(1), null, 'Otra vez', 'pdf', 'application/pdf', r.storage_path, 100
from public.published_resources r where r.id = :'rl';
select is(pruebas.vencido('original'), '{}', 'lo que un borrador nombra no vence');
select is(pruebas.vencido('resource'), '{}', 'tampoco el archivo de un recurso');
select is(private.retired_file_done('original', :'v1'), 'not_due', 'ni se anota');
select pruebas.descartar(1, 'curso');
select pruebas.como_dueno();
delete from private.video_trash where course_id = pruebas.id('curso');

select is(private.retired_file_done('original', :'v1'), 'done', 'sin eso, el original se anota');
select is(private.retired_file_done('resource', :'rl'), 'done', 'y el recurso');
select is(
  (select original_deleted_at is not null and original_path is not null from public.video_assets where id = :'v1')
  and (select file_deleted_at is not null and storage_path is not null from public.published_resources where id = :'rl'),
  true, 'las dos filas se quedan, con su ruta y la fecha en que se borró');
select is(pruebas.vencido('provider') || pruebas.vencido('original') || pruebas.vencido('resource'), '{}', 'ya no vence nada');

select pruebas.como_dueno_sistema();
select throws_ok(format($$update public.video_assets set provider_deleted_at = now() where id = %L$$, :'v2'), '23514', null, 'un video vigente no se da por borrado');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- Quién las ejecuta, los parámetros y el vigilante.

select ok(
  (select bool_and(not has_function_privilege(r, f, 'execute'))
   from unnest(array['private.retired_files_due()', 'private.retired_file_done(text, uuid)']) f
   cross join unnest(array['app_service', 'authenticated', 'anon']) r),
  'la retención es de quien opera: nadie de la aplicación la ejecuta');
select is((select count(*)::integer from public.parameter_definitions where key in ('VIDEO_RETIRADO_PROVEEDOR_DIAS', 'ARCHIVO_RETIRADO_DIAS')), 2, 'los dos plazos son parámetros');
select is(pruebas.vigila_versiones(), '{}', 'el área de versiones está limpia');
select is(pruebas.vigila_envios(), '{}', 'y la de envíos');

select pg_get_functiondef('private.course_editable(public.course_state, public.course_version_state)'::regprocedure) as antes \gset
create or replace function private.course_editable(p_state public.course_state, p_pending public.course_version_state) returns boolean
language sql immutable set search_path = '' as $$ select true $$;
select ok('versions helper course_editable answers wrong' = any(pruebas.vigila_versiones()), 'un ayudante que deja editar todo se nota');
select :'antes' \gexec
select pg_get_functiondef('private.course_version_open(uuid)'::regprocedure) as antes \gset
create or replace function private.course_version_open(p_course uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin return null; end $$;
select ok('versions function without its rule current_active_teacher_id' = any(pruebas.vigila_versiones()), 'abrir sin mirar quién actúa se nota');
select :'antes' \gexec
select is(pruebas.vigila_versiones(), '{}', 'y al deshacerlo queda limpia');

select * from finish();
