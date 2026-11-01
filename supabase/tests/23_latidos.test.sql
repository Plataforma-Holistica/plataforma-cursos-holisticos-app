-- T-205 · Latidos que miden (RF-401 a RF-404; 05 §5.4, §9.2 y §13.2). Decisiones de Sergio
-- del 2026-10-19: lo último al cerrar la pestaña se manda la próxima vez, y una lección
-- retirada deja de contar desde que se retira.
--
-- El servidor manda los tramos vistos a `private.record_heartbeats()`, a nombre de quien
-- actúa y con la sesión de Auth que declara. La función revisa cada tramo contra la lección y
-- contra el reloj de la reproducción (su tiempo vivo, que suma la presencia, por
-- `VELOCIDAD_MAX`, más 5 segundos), guarda los buenos en el libro `watch_events` en el mes del
-- tope del reloj y cuenta los rechazados. Nunca lanza por un tramo, y lo que falle por otra
-- causa contesta `failed` sin deshacer la presencia. Si un tramo cuenta lo decide la base: lo
-- que dice TypeScript del acceso solo lo baja.
--
-- En una prueba de base todo corre en una transacción, y `now()` no avanza: el paso del tiempo
-- se simula moviendo hacia atrás el último latido de la reproducción.
begin;
\ir _ayuda.psql
select plan(116);

-- El mes anterior, abierto (T-601): sus latidos atrasados entran hasta su día de cierre, y así esta
-- prueba no depende de qué día del mes corre. Sin el guardián, que no deja volver a abierto.
select pruebas.como_dueno_sistema();
alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
insert into public.payout_periods (period_id, starts_at, ends_at, timezone)
select m.p, timezone('America/Mexico_City', to_date(m.p::text || '01', 'YYYYMMDD')::timestamp),
       timezone('America/Mexico_City', to_date(m.p::text || '01', 'YYYYMMDD')::timestamp + interval '1 month'), 'America/Mexico_City'
from (select to_char(date_trunc('month', timezone('America/Mexico_City', now())) - interval '1 month', 'YYYYMM')::integer as p) m
on conflict (period_id) do update set status = 'open', entered_closing_at = null;
alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
select pruebas.limpiar();

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana-late@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto-late@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido-late@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-late@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');

create function pruebas.ana() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.beto() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.computadora() returns uuid language sql immutable as $$ select 'c2000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.telefono() returns uuid language sql immutable as $$ select 'c2000000-0000-0000-0000-000000000002'::uuid $$;

-- El servidor a nombre de una persona, con la sesión de Auth que declara (nula es nula).
create function pruebas.como(p_id uuid, p_session uuid) returns void
language plpgsql as $$
begin
  perform pruebas.a_nombre_de(p_id, p_session);
  perform set_config('app.actor_session', coalesce(p_session::text, ''), true);
end
$$;
create function pruebas.abre(p_session uuid, p_basis text default 'subscription', p_counts boolean default true) returns uuid
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como(pruebas.ana(), p_session);
  select private.open_playback(pruebas.leccion(), 'PlaybackLatecursolatir', p_basis::public.access_basis, p_counts, null) into v;
  perform pruebas.limpiar();
  if v ->> 'outcome' <> 'opened' then
    raise exception 'no abrió: %', v;
  end if;
  return (v ->> 'session_id')::uuid;
end
$$;
create function pruebas.late(p_id uuid, p_session uuid, p_playback uuid) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como(p_id, p_session);
  select private.touch_playback(p_playback) into v;
  perform pruebas.limpiar();
  return v;
end
$$;
-- Como el servidor: con el tope que dio el blanco (o el que se le diga). Sin el progreso, que
-- se prueba en 24_progreso.
create function pruebas.registra(p_id uuid, p_session uuid, p_playback uuid, p_events jsonb, p_counts boolean default true,
                                 p_at timestamptz default null) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como(p_id, p_session);
  select private.record_heartbeats(p_playback, p_events, p_counts,
           coalesce(p_at, (private.heartbeat_target(p_playback) ->> 'at')::timestamptz, now())) into v;
  perform pruebas.limpiar();
  return v - 'progress';
end
$$;
-- La presencia y el lote en la misma transacción, como los manda el servidor.
create function pruebas.late_y_registra(p_id uuid, p_session uuid, p_playback uuid, p_events jsonb) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como(p_id, p_session);
  perform private.touch_playback(p_playback);
  select private.record_heartbeats(p_playback, p_events, true, (private.heartbeat_target(p_playback) ->> 'at')::timestamptz) into v;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.blanco(p_id uuid, p_session uuid, p_playback uuid) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como(p_id, p_session);
  select private.heartbeat_target(p_playback) into v;
  perform pruebas.limpiar();
  return v;
end
$$;
-- Un tramo como lo arma el navegador.
create function pruebas.tramo(p_seq integer, p_from integer, p_to integer, p_rate numeric default 1, p_visible boolean default true) returns jsonb
language sql immutable as $$
  select jsonb_build_object('seq', p_seq, 'from', p_from, 'to', p_to, 'rate', p_rate, 'visible', p_visible)
$$;
-- Deja una reproducción con ese tiempo vivo y su último latido hace tantos segundos.
create function pruebas.ajusta(p_playback uuid, p_live numeric, p_ago integer) returns void
language sql as $$
  update public.playback_sessions
  set live_seconds = p_live, last_heartbeat_at = now() - make_interval(secs => p_ago),
      started_at = now() - interval '2 hours'
  where id = p_playback
$$;
create function pruebas.fila(p_playback uuid) returns public.playback_sessions
language sql as $$ select * from public.playback_sessions where id = p_playback $$;
create function pruebas.latidos(p_playback uuid) returns setof public.watch_events
language sql as $$ select * from public.watch_events where playback_session_id = p_playback order by seq $$;
create function pruebas.rechazos(p_reason text) returns integer
language sql as $$
  select coalesce(sum(rejections), 0)::integer from private.heartbeat_rejection_counts
  where profile_id = pruebas.ana() and reason = p_reason
$$;
create function pruebas.periodo(p_at timestamptz) returns integer
language sql stable as $$ select to_char(p_at at time zone 'America/Mexico_City', 'YYYYMM')::integer $$;
create function pruebas.curso() returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', 'curso-latir', 'title', 'Curso latir', 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', jsonb_build_array(
      jsonb_build_object('title', 'Lección uno', 'video',
        jsonb_build_object('provider', 'mux', 'asset_id', 'AssetLatecursolatir',
                           'playback_id', 'PlaybackLatecursolatir', 'duration_seconds', 356))))))
$$;
create function pruebas.leccion() returns uuid
language sql as $$
  select l.id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id
  where c.slug = 'curso-latir'
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- El curso, aprobado, y las sesiones de Auth de Ana (la computadora y el teléfono) y de Beto.
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
create temporary table maestra as select private.system_add_teacher('Maestra que late', 'maestra-que-late', null) as id;
select private.system_load_course((select id from maestra), pruebas.curso());
select pruebas.limpiar();
select is(pruebas.pide('b0000000-0000-0000-0000-000000000001',
  format('private.approve_course(%L)', course_id)), 'approved', 'se aprueba el curso')
  from public.published_courses where slug = 'curso-latir';
select pruebas.como_dueno();
insert into private.app_sessions (session_id, profile_id) values
  (pruebas.computadora(), pruebas.ana()), (pruebas.telefono(), pruebas.ana()),
  (pruebas.sesion(pruebas.beto()), pruebas.beto());
select is(private.parameter_value('VELOCIDAD_MAX'), '"2"'::jsonb, 'cuenta hasta 2×');
select is(private.parameter_value('ZONA_HORARIA_PERIODO'), '"America/Mexico_City"'::jsonb, 'el periodo se corta en la Ciudad de México');

-- ---------------------------------------------------------------------------------------
-- El libro y quién lo toca.

select is((select relkind::text from pg_class where oid = 'public.watch_events'::regclass), 'p', 'watch_events está particionada');
select is(
  (select partstrat::text || ':' || (select attname from pg_attribute where attrelid = partrelid and attnum = partattrs[0])
   from pg_partitioned_table where partrelid = 'public.watch_events'::regclass),
  'l:period_id', 'por lista, sobre el periodo');
select col_is_pk('public', 'watch_events', array['period_id', 'playback_session_id', 'seq'], 'la clave es periodo, reproducción y consecutivo');
select has_index('public', 'watch_events', 'watch_events_rollup_idx', array['period_id', 'profile_id', 'lesson_id'], 'el índice de la consolidación');
select is((select count(*)::integer from pg_indexes where schemaname = 'public' and tablename = 'watch_events'), 2, 'y ningún otro índice');
select is((select count(*)::integer from pg_constraint where conrelid = 'public.watch_events'::regclass and contype = 'f'), 0, 'sin claves foráneas');
select is(
  (select count(*)::integer from pg_inherits i join pg_class c on c.oid = i.inhrelid
   where i.inhparent = 'public.watch_events'::regclass and pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'),
  0, 'sin partición por omisión');
select ok((select relrowsecurity from pg_class where oid = 'public.watch_events'::regclass), 'con seguridad por fila');
select ok(
  not has_any_column_privilege(r, 'public.watch_events', 'select, insert, update, references')
  and not has_table_privilege(r, 'public.watch_events', 'delete, truncate, trigger'),
  r || ' no lee ni escribe el libro')
from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r;
select ok(
  not has_any_column_privilege(r, format('public.watch_events_%s', pruebas.periodo(now())), 'select, insert, update, references')
  and not has_table_privilege(r, format('public.watch_events_%s', pruebas.periodo(now())), 'delete, truncate, trigger'),
  r || ' tampoco la partición del mes')
from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r;
select ok(
  not has_any_column_privilege(r, 'private.heartbeat_rejection_counts', 'select, insert, update, references')
  and not has_table_privilege(r, 'private.heartbeat_rejection_counts', 'delete, truncate, trigger'),
  r || ' no toca los rechazos')
from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r;
select ok(
  has_column_privilege('authenticated', 'public.playback_sessions', 'accepted_media_seconds', 'select')
  and not has_column_privilege('authenticated', 'public.playback_sessions', 'live_seconds', 'select'),
  'la persona no lee su tiempo vivo: le diría cuánto le sobra del presupuesto');
select is((select count(*)::integer from pg_constraint where conrelid = 'private.heartbeat_rejection_counts'::regclass and contype = 'f'), 0,
  'los rechazos no apuntan a profiles: es una tabla muy escrita');

select ok(
  has_function_privilege('app_service', 'private.heartbeat_target(uuid)', 'execute')
  and has_function_privilege('app_service', 'private.record_heartbeats(uuid, jsonb, boolean, timestamptz)', 'execute'),
  'el servidor pide el blanco y registra');
select ok(
  not has_function_privilege(r, 'private.heartbeat_target(uuid)', 'execute')
  and not has_function_privilege(r, 'private.record_heartbeats(uuid, jsonb, boolean, timestamptz)', 'execute'),
  r || ' no')
from unnest(array['anon', 'authenticated', 'service_role']) as r;
select ok(
  not has_function_privilege(r, 'private.create_watch_partition(public.period_id)', 'execute')
  and not has_function_privilege(r, 'private.ensure_watch_partitions(integer, text)', 'execute'),
  r || ' no crea particiones: es del dueño')
from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) as r;

-- El vigilante: un permiso en una partición, que no sale por nombre en la lista de libros, y
-- una partición sin su seguro contra vaciarla.
select set_config('pruebas.particion', format('public.watch_events_%s', pruebas.periodo(now())), true);
select set_config('pruebas.nombre', format('watch_events_%s', pruebas.periodo(now())), true);
do $$ begin execute format('grant select on %s to app_service', current_setting('pruebas.particion')); end $$;
select is(
  (select array_agg(problem) from private.schema_violations() where object_name = current_setting('pruebas.particion')),
  array['watch ledger reachable by app_service'], 'el vigilante dice si alguien le concede leer una partición');
do $$ begin execute format('revoke select on %s from app_service', current_setting('pruebas.particion')); end $$;
do $$ begin execute format('alter table %s disable trigger ledger_no_truncate', current_setting('pruebas.particion')); end $$;
select is(
  (select array_agg(problem) from private.schema_violations() where object_name = current_setting('pruebas.particion')),
  array['watch partition without truncate guard'], 'y si una partición se queda sin su seguro');
do $$ begin execute format('alter table %s enable trigger ledger_no_truncate', current_setting('pruebas.particion')); end $$;
do $$ begin execute format('alter table %s disable trigger ledger_no_update_delete', current_setting('pruebas.particion')); end $$;
select is(
  (select array_agg(problem) from private.schema_violations() where object_name = current_setting('pruebas.particion')),
  array['watch partition without update guard'], 'o sin el de editar y borrar, que pasa de la madre pero se puede apagar');
do $$ begin execute format('alter table %s enable trigger ledger_no_update_delete', current_setting('pruebas.particion')); end $$;
create table public.watch_events_omision partition of public.watch_events default;
alter table public.watch_events_omision enable row level security;
select is(
  (select array_agg(problem) from private.schema_violations() where object_name = 'public.watch_events_omision' and problem like 'watch default%'),
  array['watch default partition'], 'y si alguien le pone una partición por omisión');
drop table public.watch_events_omision;
select set_config('pruebas.siguiente',
  format('watch_events_%s', to_char(date_trunc('month', now() at time zone 'America/Mexico_City') + interval '1 month', 'YYYYMM')), true);
do $$ begin execute format('alter table public.%I rename to falta', current_setting('pruebas.siguiente')); end $$;
select is(
  (select array_agg(problem) from private.schema_violations() where object_name = 'public.' || current_setting('pruebas.siguiente')),
  array['watch partition missing for next month'], 'y si falta la partición del mes que sigue: pg_cron dejó de correr');
do $$ begin execute format('alter table public.falta rename to %I', current_setting('pruebas.siguiente')); end $$;
grant insert on public.watch_events to app_service;
select ok(
  exists (select 1 from private.schema_violations() where problem = 'watch ledger reachable by app_service' and object_name = 'public.watch_events'),
  'y si alguien le concede escribir en la madre');
revoke insert on public.watch_events from app_service;
grant select on private.heartbeat_rejection_counts to app_service;
select ok(
  exists (select 1 from private.schema_violations() where problem = 'heartbeat rejections reachable by app_service'),
  'y si alguien le concede leer los rechazos');
revoke select on private.heartbeat_rejection_counts from app_service;
select is_empty('select * from private.schema_violations()', 'sin nada concedido, el vigilante no dice nada');

-- ---------------------------------------------------------------------------------------
-- Las particiones.

select ok(
  (select bool_and(to_regclass(format('public.watch_events_%s', to_char(m, 'YYYYMM'))) is not null)
   from generate_series(date_trunc('month', now() at time zone 'UTC') - interval '1 month',
                        date_trunc('month', now() at time zone 'UTC') + interval '2 months', interval '1 month') m),
  'la migración dejó del mes anterior al siguiente del siguiente');
select private.ensure_watch_partitions(2);
select is(private.ensure_watch_partitions(2), 0, 'pedirlas otra vez no crea nada');
select is(private.create_watch_partition(pruebas.periodo(now())), false, 'ni la del mes en curso');
-- Empieza por el mes anterior: lo atrasado del mes pasado tiene dónde caer. Sin la partición
-- del mes pasado, asegurar cero meses adelante la crea (y nada más).
select set_config('pruebas.anterior',
  format('watch_events_%s', to_char(date_trunc('month', now() at time zone 'America/Mexico_City') - interval '1 month', 'YYYYMM')), true);
do $$ begin
  execute format('alter table public.watch_events detach partition public.%I', current_setting('pruebas.anterior'));
  execute format('alter table public.%I rename to apartada', current_setting('pruebas.anterior'));
end $$;
select is(private.ensure_watch_partitions(0), 1, 'asegurar empieza por el mes anterior');
do $$ begin
  execute format('drop table public.%I', current_setting('pruebas.anterior'));
  execute format('alter table public.apartada rename to %I', current_setting('pruebas.anterior'));
  execute format('alter table public.watch_events attach partition public.%I for values in (%s)',
                 current_setting('pruebas.anterior'), substr(current_setting('pruebas.anterior'), 14));
end $$;
-- Aunque alguien les conceda permisos por omisión a las tablas nuevas.
alter default privileges for role postgres in schema public grant select, insert on tables to app_service;
select ok(private.ensure_watch_partitions(4) > 0, 'cuatro meses adelante crea las que faltaban');
alter default privileges for role postgres in schema public revoke select, insert on tables from app_service;
select ok(
  (select c.relrowsecurity
          and exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'ledger_no_truncate')
          and exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'ledger_no_update_delete')
          and not has_table_privilege('app_service', c.oid, 'select, insert')
   from pg_class c
   where c.oid = to_regclass(format('public.watch_events_%s', to_char(date_trunc('month', now() at time zone 'America/Mexico_City') + interval '4 months', 'YYYYMM')))),
  'una partición nueva nace con seguridad por fila, sus dos seguros y sin permisos');
select throws_ok('select private.create_watch_partition(202613)', '23514', null, 'un mes que no existe no es un periodo');
select throws_ok('select private.ensure_watch_partitions(25)', '22023', null, 'ni más de dos años adelante');
select is(
  (select command from cron.job where jobname = 'watch_partitions'),
  'select private.ensure_watch_partitions(2)', 'pg_cron las asegura cada día');

-- ---------------------------------------------------------------------------------------
-- El tiempo vivo: la presencia suma lo que pasó desde el latido anterior, a lo más una ventana
-- (tres LATIDO_SEGUNDOS: 90).

create temporary table r (name text primary key, id uuid);
grant all on r to app_service;
insert into r values ('viva', pruebas.abre(pruebas.computadora()));
select is((pruebas.fila((select id from r where name = 'viva'))).live_seconds, 0::numeric, 'una reproducción nace sin tiempo vivo');
select pruebas.ajusta((select id from r where name = 'viva'), 10, 30);
select is(pruebas.late(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'viva')), '{"outcome": "ok"}'::jsonb, 'late');
select is((pruebas.fila((select id from r where name = 'viva'))).live_seconds, 40::numeric, 'y suma los 30 segundos desde el anterior');
select pruebas.ajusta((select id from r where name = 'viva'), 40, 600);
select pruebas.late(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'viva'));
select is((pruebas.fila((select id from r where name = 'viva'))).live_seconds, 130::numeric,
  'la que venció y vuelve suma solo su última ventana, no los diez minutos que calló');

-- ---------------------------------------------------------------------------------------
-- Registrar: lo nuevo, lo repetido y el mes.

select pruebas.ajusta((select id from r where name = 'viva'), 100, 0);
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'viva'),
    jsonb_build_array(pruebas.tramo(0, 0, 30), pruebas.tramo(1, 30, 60))),
  '{"outcome": "recorded", "accepted": [0, 1], "duplicate": [], "rejected": []}'::jsonb, 'acepta dos tramos');
select results_eq(
  format('select period_id::integer, seq, from_second, to_second, qualifies, counts_for_payout from pruebas.latidos(%L)', (select id from r where name = 'viva')),
  format('values (%s, 0, 0, 30, true, true), (%s, 1, 30, 60, true, true)', pruebas.periodo(now()), pruebas.periodo(now())),
  'en el libro, en el mes de ahora en la zona del periodo, y cuentan');
select is(
  (select row(accepted_media_seconds, seqs_received)::text from public.playback_sessions where id = (select id from r where name = 'viva')),
  row(60, '{[0,2)}'::int4multirange)::text, 'la reproducción suma los segundos y los consecutivos');
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'viva'),
    jsonb_build_array(pruebas.tramo(1, 30, 60), pruebas.tramo(0, 0, 30))),
  '{"outcome": "recorded", "accepted": [], "duplicate": [0, 1], "rejected": []}'::jsonb, 'el mismo lote otra vez: repetido');
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'viva'),
    jsonb_build_array(pruebas.tramo(2, 60, 70), pruebas.tramo(2, 60, 90))),
  '{"outcome": "recorded", "accepted": [2], "duplicate": [2], "rejected": []}'::jsonb, 'repetido dentro del lote: manda el primero');
select is((select to_second from pruebas.latidos((select id from r where name = 'viva')) where seq = 2), 70, 'el primero, no el segundo');
select is((pruebas.fila((select id from r where name = 'viva'))).accepted_media_seconds, 70, 'una sola vez en la suma');
select is(
  (pruebas.fila((select id from r where name = 'viva'))).last_heartbeat_at, now(),
  'registrar no es la presencia: el último latido es el de la presencia');
select is((pruebas.fila((select id from r where name = 'viva'))).live_seconds, 100::numeric, 'ni suma tiempo vivo');
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'viva'), '[]'::jsonb),
  '{"outcome": "recorded", "accepted": [], "duplicate": [], "rejected": []}'::jsonb, 'un lote vacío no hace nada');

-- ---------------------------------------------------------------------------------------
-- La forma: cada tramo imposible se rechaza solo, sin tumbar a los demás.

select set_config('pruebas.antes_fuera', pruebas.rechazos('out_of_range')::text, true);
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'viva'),
    jsonb_build_array(
      pruebas.tramo(3, 100, 100),                                         -- no avanza
      pruebas.tramo(4, 100, 90),                                          -- retrocede
      jsonb_build_object('seq', 5, 'from', 1.5, 'to', 10, 'rate', 1, 'visible', true),   -- no entero
      pruebas.tramo(6, 0, 10, 0),                                         -- velocidad cero
      pruebas.tramo(7, 0, 10, 10),                                        -- más de 9.99
      jsonb_build_object('seq', 8, 'from', 0, 'to', 10, 'rate', 1, 'visible', 'sí'),   -- visibilidad que no es sí o no
      jsonb_build_object('seq', 9, 'from', 0, 'to', 10, 'rate', 1),       -- sin visibilidad
      pruebas.tramo(10, 350, 359),                                        -- más de 2 s después del final
      pruebas.tramo(11, 340, 358),                                        -- 2 s después del final: se recorta
      pruebas.tramo(-1, 0, 10),                                           -- consecutivo negativo
      pruebas.tramo(1000001, 0, 10),                                      -- consecutivo de más
      jsonb_build_object('seq', 'doce', 'from', 0, 'to', 10, 'rate', 1, 'visible', true),
      '"no es un tramo"'::jsonb)),
  jsonb_build_object('outcome', 'recorded', 'accepted', jsonb_build_array(11), 'duplicate', '[]'::jsonb,
    'rejected', jsonb_build_array(
      jsonb_build_object('seq', -1, 'reason', 'out_of_range'), jsonb_build_object('seq', 3, 'reason', 'out_of_range'), jsonb_build_object('seq', 4, 'reason', 'out_of_range'),
      jsonb_build_object('seq', 5, 'reason', 'out_of_range'), jsonb_build_object('seq', 6, 'reason', 'out_of_range'),
      jsonb_build_object('seq', 7, 'reason', 'out_of_range'), jsonb_build_object('seq', 8, 'reason', 'out_of_range'),
      jsonb_build_object('seq', 9, 'reason', 'out_of_range'), jsonb_build_object('seq', 10, 'reason', 'out_of_range'),
      jsonb_build_object('seq', 1000001, 'reason', 'out_of_range'),
      jsonb_build_object('seq', 'doce', 'reason', 'out_of_range'), jsonb_build_object('seq', null, 'reason', 'out_of_range'))),
  'cada tramo imposible se rechaza solo, y el bueno entra');
select is((select to_second from pruebas.latidos((select id from r where name = 'viva')) where seq = 11), 356,
  'el que se pasa 2 s del final se recorta a la duración');
select is((pruebas.fila((select id from r where name = 'viva'))).seqs_received, '{[0,12)}'::int4multirange,
  'los consecutivos rechazados también quedan recibidos: reenviados no se cuentan dos veces');
select is(pruebas.rechazos('out_of_range') - current_setting('pruebas.antes_fuera')::integer, 12, 'y se cuentan por motivo');
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'viva'), jsonb_build_array(pruebas.tramo(3, 100, 130))),
  '{"outcome": "recorded", "accepted": [], "duplicate": [3], "rejected": []}'::jsonb, 'un rechazado reenviado es repetido');
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'viva'),
    (select jsonb_agg(pruebas.tramo(100 + n, 0, 1)) from generate_series(1, 51) n)),
  '{"outcome": "failed", "code": "batch_shape"}'::jsonb, 'más de 50 tramos en un lote: no se registra ninguno');
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'viva'), '{"seq": 0}'::jsonb),
  '{"outcome": "failed", "code": "batch_shape"}'::jsonb, 'ni algo que no es una lista');

-- ---------------------------------------------------------------------------------------
-- El reloj (RF-402): lo aceptado no pasa del tiempo vivo hasta el tope, por VELOCIDAD_MAX,
-- más 5 segundos. Tramo por tramo, en orden.

insert into r values ('reloj', pruebas.abre(pruebas.computadora()));
select pruebas.ajusta((select id from r where name = 'reloj'), 20, 0);   -- 20 × 2 + 5 = 45
select set_config('pruebas.antes_rapido', pruebas.rechazos('faster_than_clock')::text, true);
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'reloj'),
    jsonb_build_array(pruebas.tramo(0, 0, 30), pruebas.tramo(1, 30, 60), pruebas.tramo(2, 60, 75))),
  '{"outcome": "recorded", "accepted": [0, 2], "duplicate": [], "rejected": [{"seq": 1, "reason": "faster_than_clock"}]}'::jsonb,
  'con 20 segundos vivos caben 45: entra el primero, el segundo no cabe y el tercero sí');
select is(pruebas.rechazos('faster_than_clock') - current_setting('pruebas.antes_rapido')::integer, 1, 'el rechazo se cuenta');
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'reloj'), jsonb_build_array(pruebas.tramo(3, 75, 76))),
  '{"outcome": "recorded", "accepted": [], "duplicate": [], "rejected": [{"seq": 3, "reason": "faster_than_clock"}]}'::jsonb,
  'el presupuesto se mide contra lo ya aceptado en lotes anteriores: lleno, ni un segundo más');

-- A3: veinte minutos declarados en una reproducción de cinco segundos.
insert into r values ('a3', pruebas.abre(pruebas.computadora()));
select pruebas.ajusta((select id from r where name = 'a3'), 5, 0);
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a3'),
    (select jsonb_agg(pruebas.tramo(n, 0, 300)) from generate_series(0, 3) n)) -> 'accepted',
  '[]'::jsonb, 'A3: veinte minutos en cinco segundos no entran');

-- A1: un dispositivo deja de latir diez minutos mientras otro ve, y al volver vacía lo suyo.
-- Solo trae su última ventana: lo de los diez minutos no cabe.
insert into r values ('a1', pruebas.abre(pruebas.computadora()));
select pruebas.ajusta((select id from r where name = 'a1'), 30, 600);
select is(pruebas.late(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a1')), '{"outcome": "ok"}'::jsonb,
  'A1: la reproducción que calló vuelve');
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'a1'),
    jsonb_build_array(pruebas.tramo(0, 0, 100), pruebas.tramo(1, 100, 200), pruebas.tramo(2, 200, 300), pruebas.tramo(3, 300, 356))),
  '{"outcome": "recorded", "accepted": [0, 1], "duplicate": [], "rejected": [{"seq": 2, "reason": "faster_than_clock"}, {"seq": 3, "reason": "faster_than_clock"}]}'::jsonb,
  'y de los diez minutos solo caben (30 + 90) × 2 + 5 = 245 segundos');

-- Los topes. En pausa (sin presencia) entra el último tramo: 40 s desde el latido.
insert into r values ('pausa', pruebas.abre(pruebas.computadora()));
select pruebas.ajusta((select id from r where name = 'pausa'), 50, 40);   -- (50 + 40) × 2 + 5 = 185
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'pausa'),
    jsonb_build_array(pruebas.tramo(0, 0, 180), pruebas.tramo(1, 180, 186), pruebas.tramo(2, 180, 185))) -> 'accepted',
  '[0, 2]'::jsonb, 'en pausa cabe lo vivo más lo que pasó desde el último latido');
-- Vencida: el tope es su último latido más una ventana, aunque haya pasado más.
insert into r values ('vencida', pruebas.abre(pruebas.computadora()));
select pruebas.ajusta((select id from r where name = 'vencida'), 50, 600);   -- (50 + 90) × 2 + 5 = 285
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'vencida'),
    jsonb_build_array(pruebas.tramo(0, 0, 280), pruebas.tramo(1, 280, 286), pruebas.tramo(2, 280, 285))) -> 'accepted',
  '[0, 2]'::jsonb, 'vencida, el reloj se detiene una ventana después de su último latido');
select is(
  pruebas.blanco(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'vencida')),
  jsonb_build_object('outcome', 'found', 'lesson_id', pruebas.leccion(),
                     'at', (pruebas.fila((select id from r where name = 'vencida'))).last_heartbeat_at + interval '90 seconds'),
  'el blanco dice la lección y ese tope, la hora con que se decide el acceso');

-- Revocada: lo atrasado entra hasta la revocación, con cualquier motivo.
insert into r values ('revocada', pruebas.abre(pruebas.computadora()));
select pruebas.ajusta((select id from r where name = 'revocada'), 50, 20);
update public.playback_sessions set revoked_at = last_heartbeat_at + interval '5 seconds', revoke_reason = 'session_closed'
where id = (select id from r where name = 'revocada');   -- (50 + 5) × 2 + 5 = 115
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'revocada'),
    jsonb_build_array(pruebas.tramo(0, 0, 110), pruebas.tramo(1, 110, 116), pruebas.tramo(2, 110, 115))) -> 'accepted',
  '[0, 2]'::jsonb, 'revocada, lo de antes de la revocación entra, y nada después');
select is(
  pruebas.blanco(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'revocada')) ->> 'at',
  to_jsonb((pruebas.fila((select id from r where name = 'revocada'))).revoked_at) #>> '{}', 'su blanco tiene el tope en la revocación');

-- La tolerancia nunca pasa del tiempo transcurrido: una reproducción que vivió un segundo no
-- trae 5 de regalo. Abrir en serie desde la misma sesión no junta tolerancias.
insert into r values ('breve', pruebas.abre(pruebas.computadora()));
select pruebas.ajusta((select id from r where name = 'breve'), 0, 1);
update public.playback_sessions set revoked_at = now(), revoke_reason = 'replaced' where id = (select id from r where name = 'breve');
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'breve'),
    jsonb_build_array(pruebas.tramo(0, 0, 3), pruebas.tramo(1, 3, 4))),
  '{"outcome": "recorded", "accepted": [0], "duplicate": [], "rejected": [{"seq": 1, "reason": "faster_than_clock"}]}'::jsonb,
  'un segundo vivo: 1 × 2 + 1 = 3 segundos, no 7');

-- El tope con que se decidió el acceso tiene que ser el de ahora: si otra transacción latió o
-- revocó entre las dos lecturas, no se registra.
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'revocada'),
    jsonb_build_array(pruebas.tramo(9, 200, 210)), true, now() - interval '1 second'),
  '{"outcome": "failed", "code": "clock_moved"}'::jsonb, 'con otro tope, nada: la decisión sería de otra hora');

-- Lo atrasado cuenta en su mes: una reproducción revocada antes de que empezara este mes
-- guarda en el mes anterior, y su consecutivo ya no entra en este.
-- Rehacer la base entre las 00:00 y las 06:00 UTC del día 1 crea las particiones desde el mes en UTC, que ya es el siguiente: falta la del mes anterior en México.
select private.create_watch_partition(to_char(date_trunc('month', timezone('America/Mexico_City', now())) - interval '1 month', 'YYYYMM')::integer);
insert into r values ('mes', pruebas.abre(pruebas.computadora()));
update public.playback_sessions
set live_seconds = 600, last_heartbeat_at = timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '7 hours',
    revoked_at = timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '7 hours', revoke_reason = 'replaced',
    started_at = timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '8 hours'
where id = (select id from r where name = 'mes');
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'mes'), jsonb_build_array(pruebas.tramo(0, 0, 30))) -> 'accepted',
  '[0]'::jsonb, 'lo atrasado de otro mes entra');
select is(
  (select period_id::integer from pruebas.latidos((select id from r where name = 'mes'))),
  pruebas.periodo(timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '7 hours'), 'en el mes de su tope, no en el de llegada');
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'mes'), jsonb_build_array(pruebas.tramo(0, 0, 30))) -> 'duplicate',
  '[0]'::jsonb, 'y reenviado no entra otra vez, aunque la clave del libro no lo atraparía en otro mes');
insert into r values ('vieja', pruebas.abre(pruebas.computadora()));
update public.playback_sessions
set live_seconds = 600, last_heartbeat_at = timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '40 days',
    revoked_at = timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '40 days', revoke_reason = 'replaced',
    started_at = timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '41 days'
where id = (select id from r where name = 'vieja');
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'vieja'), jsonb_build_array(pruebas.tramo(0, 0, 30))),
  '{"outcome": "not_found"}'::jsonb, 'lo de antes del mes pasado ya no entra: ese periodo no cambia');
-- Con el mes anterior en cierre (T-601), su atrasado ya no entra: contesta como un mes viejo.
insert into r values ('cierre', pruebas.abre(pruebas.computadora()));
update public.playback_sessions
set live_seconds = 600, last_heartbeat_at = timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '7 hours',
    revoked_at = timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '7 hours', revoke_reason = 'replaced',
    started_at = timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '8 hours'
where id = (select id from r where name = 'cierre');
select pruebas.como_dueno_sistema();
alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
update public.payout_periods set status = 'closing', entered_closing_at = now()
where period_id = pruebas.periodo(timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '7 hours');
alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'cierre'), jsonb_build_array(pruebas.tramo(0, 0, 30))),
  '{"outcome": "not_found"}'::jsonb, 'con su mes en cierre, lo atrasado ya no entra');
select is((select count(*)::integer from pruebas.latidos((select id from r where name = 'cierre'))), 0, 'y nada queda en el libro');
select pruebas.como_dueno_sistema();
alter table public.payout_periods disable trigger payout_periods_guard, disable trigger payout_periods_balanced;
update public.payout_periods set status = 'open', entered_closing_at = null
where period_id = pruebas.periodo(timezone('America/Mexico_City', date_trunc('month', timezone('America/Mexico_City', now()))) - interval '7 hours');
alter table public.payout_periods enable trigger payout_periods_guard, enable trigger payout_periods_balanced;

-- ---------------------------------------------------------------------------------------
-- Lo que no cuenta (RF-403): la base lo calcula; lo que dice TypeScript solo lo baja.

insert into r values ('cuenta', pruebas.abre(pruebas.computadora()));
select pruebas.ajusta((select id from r where name = 'cuenta'), 300, 0);
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'cuenta'),
  jsonb_build_array(pruebas.tramo(0, 0, 30), pruebas.tramo(1, 30, 60, 1, false), pruebas.tramo(2, 60, 90, 2.5), pruebas.tramo(3, 90, 120, 2)));
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'cuenta'),
  jsonb_build_array(pruebas.tramo(4, 120, 150)), false);
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'cuenta'),
  jsonb_build_array(pruebas.tramo(5, 150, 180)), null);
select results_eq(
  format('select seq, playback_rate, was_visible, qualifies, counts_for_payout from pruebas.latidos(%L)', (select id from r where name = 'cuenta')),
  $$values (0, 1.00, true, true, true), (1, 1.00, false, false, false), (2, 2.50, true, false, false), (3, 2.00, true, true, true),
           (4, 1.00, true, true, false), (5, 1.00, true, true, false)$$,
  'oculta o más rápida que VELOCIDAD_MAX no sirve ni cuenta; sin acceso que cuente (o sin saberlo) sirve y no cuenta');
insert into r values ('cortesia', pruebas.abre(pruebas.computadora(), 'courtesy', false));
select pruebas.ajusta((select id from r where name = 'cortesia'), 300, 0);
select pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'cortesia'), jsonb_build_array(pruebas.tramo(0, 0, 30)), true);
select is(
  (select row(qualifies, counts_for_payout)::text from pruebas.latidos((select id from r where name = 'cortesia'))),
  row(true, false)::text, 'una reproducción que no cuenta (cortesía) no cuenta aunque TypeScript diga que sí');

-- ---------------------------------------------------------------------------------------
-- Quién escribe: la cuenta que la abrió; si sigue viva, desde la misma sesión de Auth.

insert into r values ('ajena', pruebas.abre(pruebas.computadora()));
select pruebas.ajusta((select id from r where name = 'ajena'), 300, 0);
select is(
  pruebas.registra(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'ajena'), jsonb_build_array(pruebas.tramo(0, 0, 30))),
  '{"outcome": "not_found"}'::jsonb, 'otra cuenta no registra en ella');
select is(
  pruebas.blanco(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'ajena')),
  '{"outcome": "not_found"}'::jsonb, 'ni sabe de ella');
select is(
  pruebas.registra(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'ajena'), jsonb_build_array(pruebas.tramo(0, 0, 30))),
  '{"outcome": "not_found"}'::jsonb, 'la misma cuenta desde otro dispositivo no escribe en una viva (su id sale en PA-34)');
select is(
  pruebas.blanco(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'ajena')),
  '{"outcome": "not_found"}'::jsonb, 'ni pide su blanco');
select is(
  pruebas.registra(pruebas.ana(), pruebas.telefono(), gen_random_uuid(), jsonb_build_array(pruebas.tramo(0, 0, 30))),
  '{"outcome": "not_found"}'::jsonb, 'una que no existe contesta igual');
select is(
  pruebas.registra(pruebas.ana(), null, (select id from r where name = 'ajena'), jsonb_build_array(pruebas.tramo(0, 0, 30))),
  null, 'sin sesión declarada, nada');
-- Revocada, lo atrasado entra desde otra sesión: es lo que el navegador guardó.
update public.playback_sessions set revoked_at = now(), revoke_reason = 'closed_by_user' where id = (select id from r where name = 'ajena');
select is(
  pruebas.registra(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'ajena'), jsonb_build_array(pruebas.tramo(0, 0, 30))) -> 'accepted',
  '[0]'::jsonb, 'revocada, la misma cuenta desde otra sesión manda lo atrasado');
select is(
  pruebas.registra(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'ajena'), jsonb_build_array(pruebas.tramo(1, 30, 60))),
  '{"outcome": "not_found"}'::jsonb, 'otra cuenta tampoco en una revocada: lo atrasado es solo de su dueña');
select is(
  pruebas.blanco(pruebas.beto(), pruebas.sesion(pruebas.beto()), (select id from r where name = 'ajena')),
  '{"outcome": "not_found"}'::jsonb, 'ni pide su blanco');
-- Sin revocar, pero su sesión de Auth ya no existe.
insert into r values ('huerfana', pruebas.abre(pruebas.computadora()));
update public.playback_sessions set auth_session_id = gen_random_uuid() where id = (select id from r where name = 'huerfana');
select pruebas.ajusta((select id from r where name = 'huerfana'), 300, 0);
select is(
  pruebas.registra(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'huerfana'), jsonb_build_array(pruebas.tramo(0, 0, 30))) -> 'accepted',
  '[0]'::jsonb, 'y también si la sesión que la abrió ya no existe');
update public.playback_sessions set revoked_at = now(), revoke_reason = 'admin' where id = (select id from r where name = 'huerfana');

-- ---------------------------------------------------------------------------------------
-- Una falla no tumba la presencia: sin la partición del mes, el registro contesta `failed`, no
-- se guarda nada, y el latido de presencia de la misma transacción queda.

insert into r values ('falla', pruebas.abre(pruebas.computadora()));
select pruebas.ajusta((select id from r where name = 'falla'), 300, 30);
select set_config('pruebas.antes_falla', (select count(*) from private.heartbeat_rejection_counts)::text, true);
do $$ begin execute format('alter table public.watch_events detach partition %s', current_setting('pruebas.particion')); end $$;
select is(
  pruebas.late_y_registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'falla'),
    jsonb_build_array(pruebas.tramo(0, 0, 30), pruebas.tramo(1, 30, 30))),
  '{"outcome": "failed", "code": "23514"}'::jsonb, 'sin la partición del mes, el lote falla');
select is(
  (select row(last_heartbeat_at = now(), live_seconds = 330, accepted_media_seconds, seqs_received)::text
   from public.playback_sessions where id = (select id from r where name = 'falla')),
  row(true, true, 0, '{}'::int4multirange)::text,
  'la presencia de la misma transacción queda; del lote, nada');
select is((select count(*) from private.heartbeat_rejection_counts)::text, current_setting('pruebas.antes_falla'),
  'ni sus rechazos');
do $$ begin execute format('alter table public.watch_events attach partition %s for values in (%s)',
                           current_setting('pruebas.particion'), pruebas.periodo(now())); end $$;
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'falla'), jsonb_build_array(pruebas.tramo(0, 0, 30))) -> 'accepted',
  '[0]'::jsonb, 'con la partición de vuelta, el mismo consecutivo entra');
-- Sin un valor vigente, como si entrara en vigor mañana (sus guardianes piden a alguien del equipo).
alter table public.business_parameters disable trigger user;
update public.business_parameters set effective_from = effective_from + interval '100 years' where key = 'VELOCIDAD_MAX';
select is(
  pruebas.registra(pruebas.ana(), pruebas.computadora(), (select id from r where name = 'falla'), jsonb_build_array(pruebas.tramo(1, 30, 60))) ->> 'outcome',
  'failed', 'sin VELOCIDAD_MAX tampoco: no se adivina');
update public.business_parameters set effective_from = effective_from - interval '100 years' where key = 'VELOCIDAD_MAX';
alter table public.business_parameters enable trigger user;

-- ---------------------------------------------------------------------------------------
-- El libro no se edita, no se borra y no se vacía: ni el dueño.

select throws_ok('update public.watch_events set seq = seq', '42501', null, 'el dueño no edita el libro');
select throws_ok('delete from public.watch_events', '42501', null, 'ni lo borra');
select throws_ok('truncate public.watch_events', '42501', null, 'ni lo vacía');
select throws_ok(format('truncate %s', current_setting('pruebas.particion')), '42501', null, 'ni vacía una partición');
select throws_ok(format('delete from %s', current_setting('pruebas.particion')), '42501', null, 'ni borra de ella');
select pruebas.como(pruebas.ana(), pruebas.computadora());
select throws_ok('select 1 from public.watch_events', '42501', null, 'el servidor no lee el libro');
select throws_ok(
  format($$insert into public.watch_events (period_id, playback_session_id, seq, profile_id, lesson_id, from_second, to_second,
          playback_rate, was_visible, qualifies, counts_for_payout) values (%s, gen_random_uuid(), 0, %L, %L, 0, 10, 1, true, true, true)$$,
         pruebas.periodo(now()), pruebas.ana(), pruebas.leccion()),
  '42501', null, 'ni escribe en él: solo la función');
select throws_ok('select 1 from private.heartbeat_rejection_counts', '42501', null, 'ni lee los rechazos');
select pruebas.limpiar();

-- La presencia sigue igual que en T-204 para lo demás: otra sesión no late una viva.
select is(pruebas.late(pruebas.ana(), pruebas.telefono(), (select id from r where name = 'falla')), '{"outcome": "not_found"}'::jsonb,
  'la presencia no cambió sus reglas');

select * from finish();
rollback;
