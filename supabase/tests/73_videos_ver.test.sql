-- T-403, cuarta solicitud · Cuándo se borra un video que no se procesó (decisión de Sergio del 2026-11-01). Un tope de minutos que se libera solo no debe
-- costarle al maestro una subida de horas: lo que ese tope detiene se guarda hasta 7 días después de que empiece el mes siguiente. Lo que otra cosa detiene sigue con
-- sus 7 días desde que empezó a subirse. La fecha es una sola columna: la que la pantalla dice es la que `video_expire` cumple.
begin;
\ir _ayuda.psql
select plan(32);

create function pruebas.p(p_n integer) returns uuid language sql immutable
as $$ select ('a7300000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.m(p_n integer) returns uuid language sql immutable
as $$ select ('a7300000-0000-0000-0001-' || lpad(p_n::text, 12, '0'))::uuid $$;
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
create function pruebas.fila(p_video uuid) returns public.draft_videos language sql stable
as $$ select * from public.draft_videos where id = p_video $$;
-- Un video recibido en la lección que se diga.
create function pruebas.recibido(p_lesson text, p_k text) returns void
language plpgsql as $$
begin
  perform pruebas.r(pruebas.p(1), format('private.video_begin(%L, %L, %L, %L, 1000)', pruebas.id('curso'), pruebas.id(p_lesson), p_k || '.mp4', 'video/mp4'), p_k);
  insert into storage.objects (bucket_id, name, version, metadata)
  values ('video-originals', (pruebas.fila(pruebas.id(p_k))).storage_path, gen_random_uuid()::text, jsonb_build_object('size', 1000, 'mimetype', 'video/mp4'));
  perform pruebas.r(pruebas.p(1), format('private.video_confirm(%L, %L, true, 600)', pruebas.id('curso'), pruebas.id(p_k)));
end
$$;
create function pruebas.reclamar(p_k text) returns jsonb
language sql as $$ select pruebas.rj(pruebas.p(1), format('private.video_claim(%L, %L, %L)', pruebas.id('curso'), pruebas.id(p_k), 'mux')) $$;
create function pruebas.parametro(p_key text, p_value jsonb) returns void
language plpgsql as $$
begin
  alter table public.business_parameters disable trigger user;
  update public.business_parameters set value = p_value where key = p_key and canceled_at is null;
  alter table public.business_parameters enable trigger user;
end
$$;
-- 7 días después de que empiece el mes siguiente, en la zona de los periodos.
create function pruebas.mes_siguiente() returns timestamptz language sql stable
as $$ select (pg_catalog.date_trunc('month', now() at time zone private.period_zone()) + interval '1 month 7 days') at time zone private.period_zone() $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;
grant select on pruebas.ids to anon, authenticated, app_service;
grant insert, update on pruebas.ids to anon, authenticated, app_service;

select pruebas.alta(pruebas.p(1), 'ver-1@prueba.test');
select pruebas.confirmar(pruebas.p(1));
select pruebas.maestro(1);
select pruebas.r(pruebas.p(1), format('private.draft_create(%L, %L)', gen_random_uuid(), 'Respirar'), 'curso');
select pruebas.r(pruebas.p(1), format('private.draft_add_module(%L, 1, %L)', pruebas.id('curso'), 'Inicio'), 'modulo');
select pruebas.r(pruebas.p(1), format('private.draft_add_lesson(%L, %L, %s, %L)', pruebas.id('curso'), pruebas.id('modulo'), n, 'Lección ' || n), 'l' || n) from generate_series(1, 8) n;

-- ---------------------------------------------------------------------------------------
-- La fecha, según el estado.

select pruebas.r(pruebas.p(1), format('private.video_begin(%L, %L, %L, %L, 1000)', pruebas.id('curso'), pruebas.id('l1'), 'a.mp4', 'video/mp4'), 'subiendo');
select is((pruebas.fila(pruebas.id('subiendo'))).deletes_at, (pruebas.fila(pruebas.id('subiendo'))).created_at + interval '48 hours', 'subiendo: a las 48 h');
select pruebas.recibido('l2', 'recibido');
select is((pruebas.fila(pruebas.id('recibido'))).deletes_at, (pruebas.fila(pruebas.id('recibido'))).created_at + interval '7 days', 'recibido: 7 días desde que empezó a subirse');
select is((pruebas.reclamar('recibido')) ->> 'answer', 'claimed', 'se reclama');
select is((pruebas.fila(pruebas.id('recibido'))).deletes_at, null::timestamptz, 'creándose no se vence');
select pruebas.r(pruebas.p(1), format('private.video_created(%L, %L, %L, %L)', pruebas.id('curso'), pruebas.id('recibido'), 'mux', 'AssetRecibido'));
select is((pruebas.fila(pruebas.id('recibido'))).deletes_at, null::timestamptz, 'procesando, tampoco');
select pruebas.r(pruebas.p(1), format('private.video_settle(%L, %L, %L, 600, false, null)', pruebas.id('recibido'), 'ready', 'Play'));
select is((pruebas.fila(pruebas.id('recibido'))).deletes_at, null::timestamptz, 'listo, tampoco');
select pruebas.recibido('l3', 'malo');
select pruebas.reclamar('malo');
select pruebas.r(pruebas.p(1), format('private.video_created(%L, %L, %L, %L)', pruebas.id('curso'), pruebas.id('malo'), 'mux', 'AssetMalo'));
select pruebas.r(pruebas.p(1), format('private.video_settle(%L, %L, null, null, false, %L)', pruebas.id('malo'), 'errored', 'invalid_input'));
select is((pruebas.fila(pruebas.id('malo'))).deletes_at, (pruebas.fila(pruebas.id('malo'))).settled_at + interval '7 days', 'con error: 7 días desde que falló');

-- ---------------------------------------------------------------------------------------
-- Lo que detiene el tope de minutos se guarda hasta 7 días después de que empiece el mes siguiente.

select pruebas.recibido('l4', 'tope');
update private.video_usage set minutes = 1500 where teacher_id = pruebas.m(1);
select is((pruebas.reclamar('tope')) ->> 'answer', 'over_minutes', 'no caben sus minutos');
select is((pruebas.fila(pruebas.id('tope'))).deletes_at, pruebas.mes_siguiente(), 'y se guarda hasta el día 8 del mes siguiente');
select is((pruebas.fila(pruebas.id('tope'))).state::text, 'uploaded', 'sin dejar de estar recibido');
select is((pruebas.fila(pruebas.id('tope'))).claimed_at, null::timestamptz, 'y sin quedar reclamado: el siguiente intento cuenta');
select is((pruebas.reclamar('tope')) ->> 'held', null, 'la fecha ya era esa: no hay nada nuevo que pintar');
update public.draft_videos set minutes_hold_until = null where id = pruebas.id('tope');
select is((pruebas.reclamar('tope')) ->> 'held', 'true', 'y la primera vez lo dice, para que la pantalla pinte la fecha nueva');

select pruebas.parametro('VIDEO_MINUTOS_MES_MAX', '5');
select pruebas.recibido('l5', 'enorme');
select is((pruebas.reclamar('enorme')) ->> 'answer', 'over_minutes', 'un solo video que no cabe');
select is((pruebas.fila(pruebas.id('enorme'))).deletes_at, pruebas.mes_siguiente(), 'también se guarda: el tope lo puede subir quien opera');
select pruebas.parametro('VIDEO_MINUTOS_MES_MAX', '1500');

update public.draft_videos set minutes_hold_until = now() - interval '1 day' where id = pruebas.id('tope');
select is((pruebas.fila(pruebas.id('tope'))).deletes_at, (pruebas.fila(pruebas.id('tope'))).created_at + interval '7 days', 'manda la fecha más tardía: nunca antes de sus 7 días');
select pruebas.reclamar('tope');

-- Lo demás sigue con sus 7 días.
select pruebas.recibido('l6', 'hora');
update private.video_usage set minutes = 0 where teacher_id = pruebas.m(1);
update private.rate_limit_counters set hits = 10 where bucket = 'video_claim:' || pruebas.m(1);
select is((pruebas.reclamar('hora')) ->> 'answer', 'throttled', 'demasiados en la hora');
select is((pruebas.fila(pruebas.id('hora'))).deletes_at, (pruebas.fila(pruebas.id('hora'))).created_at + interval '7 days', 'sigue con sus 7 días');
update private.rate_limit_counters set hits = 1 where bucket = 'video_claim:' || pruebas.m(1);
select pruebas.parametro('VIDEO_SUBIDA_ABIERTA', 'false');
select is((pruebas.reclamar('hora')) ->> 'answer', 'closed', 'el interruptor apagado');
select is((pruebas.fila(pruebas.id('hora'))).deletes_at, (pruebas.fila(pruebas.id('hora'))).created_at + interval '7 days', 'también');
select pruebas.parametro('VIDEO_SUBIDA_ABIERTA', 'true');

-- ---------------------------------------------------------------------------------------
-- Lo que la pantalla dice es lo que se cumple.

update public.draft_videos set created_at = now() - interval '8 days' where id in (pruebas.id('tope'), pruebas.id('hora'));
update public.draft_videos set minutes_hold_until = now() + interval '1 hour' where id = pruebas.id('tope');
select private.video_expire();
select is((pruebas.fila(pruebas.id('hora'))).id, null::uuid, 'pasados 7 días, lo detenido por otra cosa se va');
select is((pruebas.fila(pruebas.id('tope'))).id, pruebas.id('tope'), 'y lo que el tope detuvo se queda');
select ok(exists (select 1 from private.video_trash where video_id = pruebas.id('hora')), 'lo que se va deja su archivo en la papelera');

-- Mux rechaza en el mes nuevo: la fila vuelve a recibido con su fecha, y no con una que ya pasó.
update private.video_usage set minutes = 0 where teacher_id = pruebas.m(1);
select is((pruebas.reclamar('tope')) ->> 'answer', 'claimed', 'en el mes nuevo se procesa');
select pruebas.r(pruebas.p(1), format('private.video_create_failed(%L, %L)', pruebas.id('tope'), (select extract(epoch from claimed_at)::text from public.draft_videos where id = pruebas.id('tope'))));
select private.video_expire();
select is((pruebas.fila(pruebas.id('tope'))).state::text, 'uploaded', 'si Mux lo rechaza, sigue ahí: un rechazo pasajero no le cuesta el archivo');

update public.draft_videos set minutes_hold_until = now() - interval '1 minute' where id = pruebas.id('tope');
select private.video_expire();
select is((pruebas.fila(pruebas.id('tope'))).id, null::uuid, 'y al pasar su fecha, se va');

-- ---------------------------------------------------------------------------------------
-- El repaso espera lo mismo que la papelera: un asset recién creado puede no aparecer todavía en la lista de Mux.

insert into private.video_trash (teacher_id, course_id, video_id, provider, claimed_since) values (pruebas.m(1), pruebas.id('curso'), pruebas.p(90), 'mux', now());
select ok(not exists (select 1 from private.video_sweep() x where x.video = pruebas.p(90)), 'lo reclamado que se acaba de ir, todavía no');
update private.video_trash set created_at = now() - interval '6 minutes' where video_id = pruebas.p(90);
select ok(exists (select 1 from private.video_sweep() x where x.video = pruebas.p(90) and x.claimed_since = now()), 'a los 5 minutos sí, con desde cuándo buscar');

-- ---------------------------------------------------------------------------------------
-- Lo que lee la persona.

select ok(pg_catalog.has_column_privilege('authenticated', 'public.draft_videos', 'deletes_at', 'SELECT'), 'su maestro lee la fecha');
select ok(pg_catalog.has_column_privilege('authenticated', 'public.draft_videos', 'claimed_at', 'SELECT'), 'y desde cuándo se está procesando');
select ok(not pg_catalog.has_column_privilege('authenticated', 'public.draft_videos', 'minutes_hold_until', 'SELECT'), 'lo demás no le hace falta');
select is_empty('select * from private.schema_violations()', 'el vigilante no dice nada');

select * from finish();
rollback;
