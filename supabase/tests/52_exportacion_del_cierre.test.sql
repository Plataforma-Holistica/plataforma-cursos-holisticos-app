-- T-605 · La exportación del cierre (RF-509; 05 §5.5 y §8.6). Decisión de Sergio del 2026-10-27: el CSV
-- se arma en la base, dentro de la transacción del cierre, y se guarda con su huella en
-- `private.close_exports`, de solo inserción, sin cubeta; la comprobación al confirmar lo vuelve a armar.
-- Columnas provisionales hasta LF-14, sin CLABE ni neto. Se descarga con la puerta de finanzas y el
-- código reciente, y cada descarga queda en la auditoría.
--
-- Octubre de 2026 es el ejemplo del PRD, como en `43_cierre`, con M2 fundadora y nombres que ponen a
-- prueba el CSV: un acento, y celdas que una hoja de cálculo leería como fórmula, con coma y comillas.
-- La comprobación al confirmar corre al confirmar y aquí nada confirma: `pruebas.cierra()` la adelanta.
begin;
\ir _ayuda.psql
select plan(50);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a6050000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b6050000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.contenido() returns uuid language sql immutable as $$ select 'b6050000-0000-0000-0000-000000000002'::uuid $$;
create table pruebas.etiquetas (id uuid primary key, et text not null);
create function pruebas.m(p_et text) returns uuid language sql stable as $$ select id from pruebas.etiquetas where et = p_et $$;

create function pruebas.como_finanzas() returns void language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', pruebas.finanzas()::text, true),
         set_config('app.actor_session', pruebas.sesion(pruebas.finanzas())::text, true);
$$;
create function pruebas.ensaya(p_period integer) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  v := private.rehearse_close(p_period);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.cierra(p_period integer) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  v := private.close_period(p_period);
  set constraints payout_periods_balanced immediate;
  set constraints payout_periods_balanced deferred;
  perform pruebas.limpiar();
  return v;
end
$$;
-- Un cierre que se descuadra después de escribirse (como en `43_cierre`): cierra, cambia lo escrito con
-- los disparadores apagados y adelanta la comprobación. Si cuadra, lanza P0002 para deshacerlo todo.
create function pruebas.descuadra(p_period integer, p_sql text) returns void language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  v := private.close_period(p_period);
  if v ->> 'outcome' <> 'closed' then
    raise exception 'no cerró: %', v;
  end if;
  if p_sql is not null then
    set local session_replication_role = replica;
    execute p_sql;
    set local session_replication_role = origin;
  end if;
  set constraints payout_periods_balanced immediate;
  raise exception 'cuadra' using errcode = 'P0002';
end
$$;
create function pruebas.en_cierre(p_period integer, p_students integer default 4, p_bps integer default 6000) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(p_period);
  alter table public.payout_periods disable trigger payout_periods_guard;
  update public.payout_periods set status = 'closing', entered_closing_at = now() - interval '2 days',
         active_students = p_students, pool_bps = p_bps
  where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard;
  perform pruebas.como_dueno();
end
$$;
create function pruebas.abierto(p_period integer) returns void
language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(p_period);
  alter table public.payout_periods disable trigger payout_periods_guard;
  update public.payout_periods set status = 'open', entered_closing_at = null where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard;
  perform pruebas.como_dueno();
end
$$;
create function pruebas.corrida(p_period integer, p_status text, p_mode text, p_started interval) returns uuid language sql as $$
  insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
  values ('nightly_rollup', p_period, p_status::public.run_status, now() + p_started, now() + p_started,
          case when p_status <> 'running' then now() + p_started + interval '1 minute' end, jsonb_build_object('mode', p_mode))
  returning id
$$;
create function pruebas.cobra(p_n integer, p_at timestamptz, p_gross bigint) returns text language sql as $$
  select private.record_charge(pruebas.al(p_n), ('c6050000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid, 'manual',
                               'cobro-exportacion-' || p_n || '-' || p_gross, null,
                               (select plan from public.subscriptions where profile_id = pruebas.al(p_n) limit 1),
                               p_at, 'MXN', p_gross, null, null, 'card', 'MX', null) ->> 'outcome'
$$;
create function pruebas.curso(p_slug text) returns jsonb language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', (
      select jsonb_agg(jsonb_build_object('title', t, 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'Asset' || p_slug || n, 'playback_id', 'Playback' || p_slug || n, 'duration_seconds', 100)) order by n)
      from unnest(array['Uno', 'Dos', 'Tres', 'Cuatro']) with ordinality as l (t, n)))))
$$;
create function pruebas.leccion(p_course text, p_title text) returns uuid language sql as $$
  select l.id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id
  where c.slug = p_course and l.title = p_title
$$;
create function pruebas.fila(p_period integer, p_profile uuid, p_course text, p_title text, p_half_points integer) returns void
language sql as $$
  select private.open_period(p_period);
  insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                   lesson_duration_seconds, covered_seconds, half_points)
  select p_period, p_profile, l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, 50 * p_half_points, p_half_points
  from public.published_lessons l where l.id = pruebas.leccion(p_course, p_title)
$$;
-- La línea de un maestro en el CSV, por su etiqueta.
create function pruebas.linea(p_et text, p_name text, p_rest text) returns text language sql stable
as $$ select '2026-10,' || pruebas.m(p_et) || ',' || p_name || ',' || p_rest $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

delete from public.job_runs where period_id between 202609 and 202712;

-- Las cuentas: cuatro alumnos del ejemplo, finanzas y contenido.
select pruebas.alta(pruebas.al(n), format('alumno%s-exportacion@prueba.test', n)) from generate_series(1, 4) n;
select pruebas.alta(pruebas.finanzas(), 'finanzas-exportacion@prueba.test');
select pruebas.alta(pruebas.contenido(), 'contenido-exportacion@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-exportacion@prueba.test';
select pruebas.dar_capacidad(pruebas.finanzas(), 'finance');
select pruebas.equipar(pruebas.finanzas());
select pruebas.dar_capacidad(pruebas.contenido(), 'content');
select pruebas.equipar(pruebas.contenido());

-- Los maestros, en el orden del ejemplo, con sus nombres de prueba; M2 es fundadora desde octubre.
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher(x.name, 'exportacion-' || x.s, null), pruebas.curso('exportacion-' || x.s))
from (values (1, 'm1', 'Ana Núñez'), (2, 'm2', '=Maestra, "dos"'), (3, 'm3', '@tres')) as x (n, s, name) order by x.n;
select pruebas.como_dueno();
insert into pruebas.etiquetas select teacher_id, 'M' || right(slug, 1) from public.published_courses where slug like 'exportacion-m%';
select pruebas.como_dueno_sistema();
update public.teachers set is_founder = true, founder_since = '2026-10-01' where id = pruebas.m('M2');
select pruebas.como_dueno();

-- Los cobros de octubre: A, B y D mensuales, C anual.
select pruebas.abierto(202610);
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
select ('c6050000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, pruebas.al(n), 'manual', 'sus-exportacion-' || n,
       case when n = 3 then 'annual' else 'monthly' end::public.subscription_plan, 'pending', 'MXN'
from generate_series(1, 4) n;
select is(array[pruebas.cobra(1, '2026-10-05 12:00-06', 34900), pruebas.cobra(2, '2026-10-06 12:00-06', 34900),
                pruebas.cobra(3, '2026-10-07 12:00-06', 299000), pruebas.cobra(4, '2026-10-08 12:00-06', 34900)],
  array['recorded', 'recorded', 'recorded', 'recorded'], 'los cuatro cobros del ejemplo');
select pruebas.fila(202610, pruebas.al(1), 'exportacion-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres', 'Cuatro']) t;
select pruebas.fila(202610, pruebas.al(1), 'exportacion-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(1), 'exportacion-m2', 'Dos', 2),
       pruebas.fila(202610, pruebas.al(1), 'exportacion-m2', 'Tres', 1);
select pruebas.fila(202610, pruebas.al(2), 'exportacion-m2', 'Uno', 1);
select pruebas.fila(202610, pruebas.al(3), 'exportacion-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres']) t;
select pruebas.fila(202610, pruebas.al(3), 'exportacion-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(3), 'exportacion-m3', 'Uno', 2);

-- ---------------------------------------------------------------------------------------
-- La tabla: de solo inserción y sin nadie de la aplicación.

select has_table('private', 'close_exports', 'existe la exportación del cierre');
select ok((select relrowsecurity from pg_class where oid = 'private.close_exports'::regclass), 'con seguridad por fila');
select ok(not exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('app_service')) r (rolname)
                      where has_any_column_privilege(r.rolname, 'private.close_exports', 'SELECT, INSERT, UPDATE, REFERENCES')
                         or has_table_privilege(r.rolname, 'private.close_exports', 'DELETE, TRUNCATE, TRIGGER')),
  'nadie de la aplicación la lee ni la escribe');

-- ---------------------------------------------------------------------------------------
-- Las celdas.

select is(array[private.csv_money(0), private.csv_money(5), private.csv_money(100), private.csv_money(12345), private.csv_money(-5),
                private.csv_money(-12345), private.csv_money(9223372036854775807)],
  array['0.00', '0.05', '1.00', '123.45', '-0.05', '-123.45', '92233720368547758.07'],
  'los montos, en pesos con dos decimales y por aritmética entera');
select is(array[private.csv_text('Ana Núñez'), private.csv_text('a,b'), private.csv_text('a"b'), private.csv_text(E'a\nb'),
                private.csv_text(null), private.csv_text('')],
  array['"Ana Núñez"', '"a,b"', '"a""b"', E'"a\nb"', '""', '""'], 'el texto, entre comillas y con las comillas dobladas');
select is(array[private.csv_text('=1+1'), private.csv_text('+1'), private.csv_text('-1'), private.csv_text('@a'),
                private.csv_text(chr(9) || 'a'), private.csv_text(chr(13) || 'a'), private.csv_text('a=1')],
  array['"''=1+1"', '"''+1"', '"''-1"', '"''@a"', '"''' || chr(9) || 'a"', '"''' || chr(13) || 'a"', '"a=1"'],
  'una celda que una hoja de cálculo leería como fórmula se neutraliza con un apóstrofo; en medio no');

-- ---------------------------------------------------------------------------------------
-- El ensayo no exporta nada.

select pruebas.en_cierre(202610);
select pruebas.corrida(202610, 'succeeded', 'full', interval '-1 hour');
create temporary table ensayo as select pruebas.ensaya(202610) as r;
select is((select r ->> 'outcome' from ensayo), 'rehearsed', 'el ensayo de octubre');
select is((select count(*)::integer from private.close_exports where period_id = 202610), 0, 'y no deja exportación');

-- ---------------------------------------------------------------------------------------
-- La comprobación al confirmar: una exportación que no es la del cierre no se guarda.

select throws_ok($$select pruebas.descuadra(202610, null)$$, 'P0002', 'cuadra', 'el cierre de verdad pasa la comprobación');
select throws_ok($$select pruebas.descuadra(202610, 'delete from private.close_exports where period_id = 202610')$$,
  '23514', null, 'sin exportación, no se cierra');
select throws_ok($$select pruebas.descuadra(202610, $q$update private.close_exports set content = replace(content, '244.94', '244.95'),
                                                       sha256 = sha256(convert_to(replace(content, '244.94', '244.95'), 'UTF8'))
                                                     where period_id = 202610$q$)$$,
  '23514', null, 'con otro contenido, aunque su huella sea la suya, no se cierra');
select throws_ok($$select pruebas.descuadra(202610, $q$update private.close_exports set sha256 = sha256(convert_to('otra', 'UTF8'))
                                                     where period_id = 202610$q$)$$,
  '23514', null, 'con una huella que no es la de su contenido, no se cierra');
select throws_ok($$select pruebas.descuadra(202610, 'update private.close_exports set minimum_payout_cents = 1 where period_id = 202610')$$,
  '23514', null, 'con otro pago mínimo, no se cierra');
select throws_ok($$select pruebas.descuadra(202610, $q$update private.close_exports set minimum_payout_cents = 30000,
                                                       content = private.close_export_csv(close_run_id, 30000),
                                                       sha256 = sha256(convert_to(private.close_export_csv(close_run_id, 30000), 'UTF8'))
                                                     where period_id = 202610$q$)$$,
  '23514', null, 'con otro pago mínimo y el contenido que le corresponde, tampoco: el mínimo es el del periodo');
select throws_ok($$select pruebas.descuadra(202610, 'update private.close_exports set row_count = 2 where period_id = 202610')$$,
  '23514', null, 'con otra cuenta de filas, no se cierra');
select throws_ok($$select pruebas.descuadra(202610, 'update private.close_exports set period_id = 202609 where period_id = 202610')$$,
  '23514', null, 'de otro periodo, no se cierra');
select throws_ok($$select pruebas.descuadra(202610, 'update private.close_exports set format_version = 2 where period_id = 202610')$$,
  '23514', null, 'con otra versión de formato, no se cierra');
select throws_ok($$select pruebas.descuadra(202610, $q$update public.published_teachers set display_name = 'Otra' where teacher_id =
                                                     (select id from pruebas.etiquetas where et = 'M1')$q$)$$,
  '23514', null, 'si el nombre de un maestro cambia antes de confirmar, no se cierra');

-- ---------------------------------------------------------------------------------------
-- El cierre de octubre y su exportación.

create temporary table cierre as select pruebas.cierra(202610) as r;
select is((select r ->> 'outcome' from cierre), 'closed', 'octubre se cierra');
select ok(pg_get_functiondef('private.write_close_export()'::regprocedure) ~* 'for share',
  'la exportación deja los nombres de sus maestros con candado hasta confirmar (lo prueba de verdad la integración 54)');
select is((select founder_bonus_cents from public.close_run_teacher_totals
           where close_run_id = (select (r ->> 'close_run_id')::uuid from cierre) and teacher_id = pruebas.m('M2')),
  5376::bigint, 'el bono de M2: el piso de 358.43 por 0.15');
select is((select count(*)::integer from private.close_exports where period_id = 202610), 1, 'una exportación');
select ok((select close_run_id = (select (r ->> 'close_run_id')::uuid from cierre) and format_version = 1
                  and minimum_payout_cents = 50000 and row_count = 3 and created_at = now()
           from private.close_exports where period_id = 202610),
  'la del cierre, en la versión 1 del formato, con el pago mínimo del periodo y una fila por maestro');
select is((select content from private.close_exports where period_id = 202610),
  chr(65279) || 'periodo,maestro_id,maestro,reparto,sin_consumo,total,bono_fundador_propuesto,debajo_de_pago_minimo' || E'\r\n'
  || (select string_agg(l, E'\r\n' order by id) || E'\r\n' from (values
       (pruebas.m('M1'), pruebas.linea('M1', '"Ana Núñez"', '178.99,65.95,244.94,0.00,sí')),
       (pruebas.m('M2'), pruebas.linea('M2', '"''=Maestra, ""dos"""', '261.92,96.51,358.43,53.76,sí')),
       (pruebas.m('M3'), pruebas.linea('M3', '"''@tres"', '24.48,9.02,33.50,0.00,sí'))) x (id, l)),
  'el CSV, al centavo: UTF-8 con marca, fin de línea CRLF, por maestro, y las celdas de texto neutralizadas');
select is((select sha256 from private.close_exports where period_id = 202610),
  (select sha256(convert_to(content, 'UTF8')) from private.close_exports where period_id = 202610), 'con la huella de su contenido');
create temporary table totales as
  select sum(replace(m[1], '.', '')::bigint)::bigint as total, sum(replace(m[2], '.', '')::bigint)::bigint as bono
  from private.close_exports e,
       regexp_split_to_table(rtrim(e.content, E'\r\n'), E'\r\n') with ordinality as l (line, n),
       regexp_match(l.line, ',(-?[0-9]+\.[0-9]{2}),(-?[0-9]+\.[0-9]{2}),(sí|no)?$') as m
  where e.period_id = 202610 and l.n > 1;
select is((select total from totales), (select sum(total_cents)::bigint from public.payout_teacher_totals where period_id = 202610),
  'la exportación suma lo mismo que el cierre');
select is((select total from totales), (select pool_cents - carried_out_cents from public.payout_periods where period_id = 202610),
  'que es el bote menos lo que pasa al siguiente');
select is((select bono from totales), (select sum(amount_cents)::bigint from public.bonuses where period_id = 202610 and kind = 'founder'),
  'y los bonos propuestos, lo que el cierre propuso');

-- Con otro pago mínimo, o sin él, la última columna cambia: M2 con su bono pasa de 300.00.
select is(private.close_export_csv((select (r ->> 'close_run_id')::uuid from cierre), 30000),
  chr(65279) || 'periodo,maestro_id,maestro,reparto,sin_consumo,total,bono_fundador_propuesto,debajo_de_pago_minimo' || E'\r\n'
  || (select string_agg(l, E'\r\n' order by id) || E'\r\n' from (values
       (pruebas.m('M1'), pruebas.linea('M1', '"Ana Núñez"', '178.99,65.95,244.94,0.00,sí')),
       (pruebas.m('M2'), pruebas.linea('M2', '"''=Maestra, ""dos"""', '261.92,96.51,358.43,53.76,no')),
       (pruebas.m('M3'), pruebas.linea('M3', '"''@tres"', '24.48,9.02,33.50,0.00,sí'))) x (id, l)),
  'con un mínimo de 300.00, M2 no queda debajo');
select ok(private.close_export_csv((select (r ->> 'close_run_id')::uuid from cierre), null) like '%,0.00,' || E'\r\n' || '%',
  'sin pago mínimo, la columna va vacía');
select ok(private.close_export_csv((select (r ->> 'close_run_id')::uuid from cierre), 35843 + 5376) like '%,358.43,53.76,no' || E'\r\n' || '%',
  'quien llega justo al mínimo no queda debajo');

-- Cerrar dos veces es un solo cierre y una sola exportación.
select is((select pruebas.cierra(202610) ->> 'outcome'), 'already_closed', 'cerrar otra vez contesta que ya está cerrado');
select is((select count(*)::integer from private.close_exports where period_id = 202610), 1, 'y no exporta otra vez');

-- Solo inserción.
select throws_ok($$update private.close_exports set row_count = 3 where period_id = 202610$$, '42501', null, 'no se cambia');
select throws_ok($$delete from private.close_exports where period_id = 202610$$, '42501', null, 'no se borra');
select throws_ok($$truncate private.close_exports$$, '42501', null, 'no se vacía');
select throws_ok($$insert into private.close_exports (close_run_id, period_id, format_version, content, sha256, row_count)
                   select close_run_id, period_id, 1, 'x', sha256(convert_to('x', 'UTF8')), 0 from private.close_exports where period_id = 202610$$,
  '23505', null, 'una corrida tiene una sola exportación');

-- ---------------------------------------------------------------------------------------
-- La descarga: por el servidor, con la puerta de finanzas y el código reciente, y a la auditoría.

create function pruebas.descarga(p_actor uuid, p_run uuid, p_request text default null) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  -- A nombre de quien actúa, sin repararle nada (como el servidor).
  if p_actor is null then
    perform pruebas.como_servicio(null);
  else
    perform pruebas.a_nombre_de(p_actor);
  end if;
  perform set_config('app.request_id', coalesce(p_request, ''), true);
  v := private.close_export_download(p_run);
  perform pruebas.limpiar();
  return v;
end
$$;
grant execute on function pruebas.descarga(uuid, uuid, text) to app_service;

select is((select pruebas.descarga(pruebas.contenido(), (select (r ->> 'close_run_id')::uuid from cierre)) ->> 'outcome'), 'forbidden',
  'sin finanzas no se descarga');
select is((select pruebas.descarga(null, (select (r ->> 'close_run_id')::uuid from cierre)) ->> 'outcome'), 'forbidden',
  'sin nadie que actúe tampoco');
select is((select pruebas.descarga(pruebas.contenido(), gen_random_uuid()) ->> 'outcome'), 'forbidden',
  'y sin finanzas no se sabe si una corrida existe: la puerta va primero');
create temporary table auditoria_antes as select count(*) as n from public.audit_log where entity_table = 'private.close_exports';
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '1 hour' where session_id = pruebas.sesion(pruebas.finanzas());
select is((select pruebas.descarga(pruebas.finanzas(), (select (r ->> 'close_run_id')::uuid from cierre)) ->> 'outcome'),
  'needs_fresh_code', 'con finanzas y sin el código reciente, tampoco');
select pruebas.equipar(pruebas.finanzas());
select is((select count(*) from public.audit_log where entity_table = 'private.close_exports'), (select n from auditoria_antes),
  'lo que no se descarga no queda en la auditoría');
select is((select pruebas.descarga(pruebas.finanzas(), (select (r ->> 'run_id')::uuid from ensayo)) ->> 'outcome'), 'not_found',
  'un ensayo no tiene exportación');
select is((select pruebas.descarga(pruebas.finanzas(), null) ->> 'outcome'), 'not_found', 'sin corrida, nada');
create temporary table descarga as
  select pruebas.descarga(pruebas.finanzas(), (select (r ->> 'close_run_id')::uuid from cierre), 'peticion-exportacion') as r;
select is((select r - 'content' - 'sha256' from descarga),
  jsonb_build_object('outcome', 'ok', 'period_id', 202610, 'filename', 'cierre-2026-10.csv', 'rows', 3, 'format_version', 1),
  'con finanzas y el código reciente, la exportación del cierre');
select is((select r ->> 'content' from descarga), (select content from private.close_exports where period_id = 202610), 'su contenido');
select is((select r ->> 'sha256' from descarga), (select encode(sha256, 'hex') from private.close_exports where period_id = 202610),
  'y su huella, para compararla con la copia guardada');
select ok(exists (select 1 from public.audit_log where entity_table = 'private.close_exports' and action = 'close_exports.download'
                  and category = 'money' and actor_kind = 'user' and actor_id = pruebas.finanzas()
                  and entity_id = (select r ->> 'close_run_id' from cierre) and request_id = 'peticion-exportacion'),
  'la descarga queda en la auditoría, con quién y su petición');
select is((select count(*) from public.audit_log where entity_table = 'private.close_exports'), (select n + 1 from auditoria_antes),
  'una vez por descarga');

select * from finish();
rollback;
