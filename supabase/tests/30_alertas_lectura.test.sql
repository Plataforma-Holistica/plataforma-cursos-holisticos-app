-- T-208, segunda solicitud · Lo que lee PA-68 mínima (`/admin/alertas`) y cómo excluye por la
-- pantalla. Decisiones de Sergio del 2026-10-22: una sola dirección, y de cada cuenta la
-- antigüedad y lo que aporta al maestro por tramos.
--
-- `private.finance_alerts()` le da a finanzas las alertas con sus cifras, sin que salga nada que
-- identifique a una persona: cada cuenta va con una huella por alerta, con llave, y la pantalla
-- excluye con esa huella (`private.exclude_alert_account()`), nunca con el identificador.
begin;
\ir _ayuda.psql
select plan(52);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana-alerta@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto-alerta@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000003', 'carla-alerta@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido-alerta@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000002', 'finanzas-alerta@prueba.test');
select pruebas.alta(('a1000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'extra' || n || '-alerta@prueba.test')
from generate_series(1, 11) as n;
select pruebas.confirmar(id) from auth.users where email like '%-alerta@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000002', 'finance');
select pruebas.equipar('b0000000-0000-0000-0000-000000000002');
select pruebas.como_dueno_sistema();
update public.profiles set display_name = 'Ana Señalada' where id = 'a0000000-0000-0000-0000-000000000001';
update public.profiles set display_name = 'Beto Señalado' where id = 'a0000000-0000-0000-0000-000000000002';
update public.profiles set display_name = 'Fina Finanzas' where id = 'b0000000-0000-0000-0000-000000000002';
select pruebas.limpiar();

create function pruebas.ana() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.beto() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.carla() returns uuid language sql immutable as $$ select 'a0000000-0000-0000-0000-000000000003'::uuid $$;
create function pruebas.contenido() returns uuid language sql immutable as $$ select 'b0000000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b0000000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.extra(n integer) returns uuid language sql immutable as $$
  select ('a1000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid $$;
create function pruebas.periodo(p_months_back integer default 0) returns integer
language sql stable as $$
  select to_char(date_trunc('month', timezone('America/Mexico_City', now())) - make_interval(months => p_months_back), 'YYYYMM')::integer
$$;
create function pruebas.inicio(p_period integer) returns timestamptz
language sql stable as $$ select timezone('America/Mexico_City', to_date(p_period::text || '01', 'YYYYMMDD')::timestamp) $$;
create function pruebas.leccion(p_course text, p_title text) returns uuid
language sql as $$
  select l.id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id
  where c.slug = p_course and l.title = p_title
$$;
create function pruebas.maestro(p_course text) returns uuid
language sql as $$ select teacher_id from public.published_courses where slug = p_course $$;
create function pruebas.fila(p_period integer, p_profile uuid, p_lesson uuid, p_covered integer, p_half_points integer) returns void
language sql as $$
  insert into public.watch_rollup (period_id, profile_id, lesson_id, course_id, teacher_id, video_asset_id,
                                   lesson_duration_seconds, covered_seconds, half_points)
  select p_period, p_profile, l.id, l.course_id, l.teacher_id, l.video_asset_id, 100, p_covered, p_half_points
  from public.published_lessons l where l.id = p_lesson
$$;
create function pruebas.completas(p_period integer, p_profile uuid, p_course text, p_n integer) returns void
language sql as $$
  select pruebas.fila(p_period, p_profile, pruebas.leccion(p_course, t), 100, 2)
  from unnest((array['Uno', 'Dos', 'Tres'])[1:p_n]) as t
$$;
-- Lo que lee la pantalla, a nombre de alguien.
create function pruebas.lee(p_actor uuid) returns jsonb
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_actor);
  select private.finance_alerts() into v;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.excluye(p_actor uuid, p_alert uuid, p_account text, p_reason_code text default 'technical_error') returns text
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_actor);
  select private.exclude_alert_account(p_alert, p_account, p_reason_code, 'Una prueba de la plataforma.') into v;
  perform pruebas.limpiar();
  return v ->> 'outcome';
end
$$;
create function pruebas.revisa(p_actor uuid, p_alert uuid, p_note text, p_fraud boolean default null, p_evidence text default null) returns text
language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_actor);
  select private.review_alert(p_alert, p_note, p_fraud, p_evidence) into v;
  perform pruebas.limpiar();
  return v ->> 'outcome';
end
$$;
create function pruebas.alerta_de(p_kind text) returns uuid
language sql as $$ select id from public.anomaly_alerts where kind = p_kind::public.anomaly_kind $$;
-- La alerta tal como la lee la pantalla.
create function pruebas.tarjeta(p_actor uuid, p_kind text) returns jsonb
language sql as $$
  select a from jsonb_array_elements(pruebas.lee(p_actor) -> 'alerts') a where a ->> 'kind' = p_kind
$$;
create function pruebas.token(p_kind text, p_profile uuid) returns text
language sql as $$ select private.alert_account_token(pruebas.alerta_de(p_kind), p_profile) $$;
create function pruebas.curso(p_slug text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', (
      select jsonb_agg(jsonb_build_object('title', t, 'video', jsonb_build_object(
        'provider', 'mux', 'asset_id', 'Asset' || p_slug || n, 'playback_id', 'Playback' || p_slug || n, 'duration_seconds', 100)) order by n)
      from unnest(array['Uno', 'Dos', 'Tres']) with ordinality as l (t, n)))))
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra ' || s, 'maestra-' || s, null), pruebas.curso(s))
from unnest(array['lectura-a', 'lectura-b']) as s;
select pruebas.limpiar();
select is(pruebas.pide(pruebas.contenido(), format('private.approve_course(%L)', course_id)), 'approved', 'se aprueba ' || slug)
from public.published_courses where slug like 'lectura-%';
select pruebas.como_dueno();
alter table public.business_parameters disable trigger user;
insert into public.business_parameters (key, value, status, effective_from)
values ('ALERTA_SALTO_MINIMO_MEDIOS_PUNTOS', '5', 'proposed', now() - interval '1 second');
insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
values ('VELOCIDAD_MAX', '"2"', 'decided', now() - interval '2 seconds', pruebas.periodo(2));

-- Dos alertas: lecciones imposibles de Ana en el mes en curso, y el salto de la maestra A.
select pruebas.completas(pruebas.periodo(), pruebas.ana(), 'lectura-a', 3);
select private.detect_anomalies(pruebas.periodo(), pruebas.inicio(pruebas.periodo()) + interval '10 seconds');
select pruebas.completas(pruebas.periodo(2), pruebas.ana(), 'lectura-a', 3);                    -- A antes: 6
select pruebas.completas(pruebas.periodo(1), pruebas.ana(), 'lectura-a', 3);                    -- Ana: 6 con A
select pruebas.completas(pruebas.periodo(1), pruebas.ana(), 'lectura-b', 3);                    --  y 6 con B: la mitad
select pruebas.completas(pruebas.periodo(1), pruebas.beto(), 'lectura-a', 2);                   -- Beto: solo A
select pruebas.completas(pruebas.periodo(1), pruebas.carla(), 'lectura-a', 2);                  -- Carla: 4 con A
select pruebas.fila(pruebas.periodo(1), pruebas.carla(), pruebas.leccion('lectura-b', 'Uno'), 30, 1);   -- y 1 con B
select private.detect_anomalies(pruebas.periodo(1), now());
select is((select count(*)::integer from public.anomaly_alerts), 2, 'hay dos alertas');
-- Después, once cuentas más que le aportan poco a A: no caben entre las diez que se muestran.
select pruebas.fila(pruebas.periodo(1), pruebas.extra(n), pruebas.leccion('lectura-a', 'Uno'), 30, 1) from generate_series(1, 11) n;

-- ---------------------------------------------------------------------------------------
-- Quién lee y quién ejecuta.

select ok(has_function_privilege('app_service', f, 'execute')
          and not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r where has_function_privilege(r, f, 'execute'))
          and (select prosecdef from pg_proc where oid = f::regprocedure),
  'solo el servidor, security definer: ' || f)
from unnest(array['private.finance_alerts()', 'private.exclude_alert_account(uuid, text, text, text)']) as f;
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) r
                      where has_function_privilege(r, 'private.alert_account_token(uuid, uuid)', 'execute')),
  'la huella, nadie de la aplicación');
select ok(not exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'app_service']) r
                      where has_any_column_privilege(r, 'private.alert_account_key', 'SELECT, INSERT, UPDATE, REFERENCES')),
  'ni la llave');
select is(pruebas.lee(pruebas.ana()), null, 'una alumna no lee nada');
select is(pruebas.lee(pruebas.contenido()), null, 'ni alguien del equipo sin finanzas');
set local role app_service;
select is(private.finance_alerts(), null, 'ni nadie, sin quien actúe');
reset role;

-- ---------------------------------------------------------------------------------------
-- Lo que se lee.

select is((pruebas.lee(pruebas.finanzas()) ->> 'fresh_code')::boolean, true, 'finanzas con su código reciente');
update auth.mfa_amr_claims set updated_at = clock_timestamp() - interval '1 hour'
  where session_id = pruebas.sesion(pruebas.finanzas());
select is((pruebas.lee(pruebas.finanzas()) ->> 'fresh_code')::boolean, false, 'con el código de hace una hora lee igual, pero lo dice');
select pruebas.equipar(pruebas.finanzas());
select is((select array_agg(a ->> 'kind' order by ord) from jsonb_array_elements(pruebas.lee(pruebas.finanzas()) -> 'alerts') with ordinality x (a, ord)),
  (select array_agg(kind::text order by (status = 'open') desc, detected_at, id) from public.anomaly_alerts),
  'las dos, las abiertas primero y por antigüedad');
select is((select array_agg(k order by k) from jsonb_object_keys(pruebas.lee(pruebas.finanzas())) k),
  array['alerts', 'fresh_code', 'total'], 'la respuesta, con sus tres claves');
select is((select array_agg(k order by k) from jsonb_object_keys(pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump')) k),
  array['accounts', 'can_exclude', 'details', 'detected_at', 'evidence', 'exclusions', 'id', 'is_fraud', 'kind', 'metric',
        'more_accounts', 'period', 'review_note', 'reviewed_at', 'reviewed_by_name', 'status', 'teacher_name', 'threshold', 'today'],
  'cada alerta, con sus claves');
select is((select array_agg(k order by k) from jsonb_object_keys(pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') -> 'accounts' -> 0) k),
  array['account', 'age', 'covered_seconds', 'excluded', 'half_points', 'half_points_before', 'lessons', 'share'],
  'cada cuenta, con las suyas');
select is((pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') ->> 'teacher_name'), 'Maestra lectura-a', 'del salto, la maestra por su nombre');
select is(jsonb_array_length(pruebas.tarjeta(pruebas.finanzas(), 'impossible_completion') -> 'accounts'), 1,
  'de lecciones imposibles, solo su cuenta');
select is((pruebas.tarjeta(pruebas.finanzas(), 'impossible_completion') -> 'accounts' -> 0 ->> 'share'), null, 'sin qué aporta a quién');
select is((pruebas.tarjeta(pruebas.finanzas(), 'impossible_completion') ->> 'today')::numeric, 150::numeric,
  'con la cifra de hoy, a la velocidad de la alerta');
select ok((pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') ->> 'today')::numeric
          > (pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') ->> 'metric')::numeric,
  'el salto de hoy, mayor que al detectarlo: llegaron más cuentas');
select is(jsonb_array_length(pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') -> 'accounts'), 10, 'del salto, las diez que más aportan');
select is((pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') ->> 'more_accounts')::integer, 4, 'y cuántas más hay');
create function pruebas.aporta(p_profile uuid) returns text
language sql as $$
  select c ->> 'share' from jsonb_array_elements(pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') -> 'accounts') c
  where c ->> 'account' = pruebas.token('teacher_points_jump', p_profile)
$$;
select is(array[pruebas.aporta(pruebas.ana()), pruebas.aporta(pruebas.beto()), pruebas.aporta(pruebas.carla())],
  array['less_than_half', 'only', 'most'],
  'lo que aporta a esta maestra, por tramos: Ana la mitad, Beto solo a ella, Carla la mayor parte');
select ok((select bool_and(c ->> 'age' = 'under_7') from jsonb_array_elements(pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') -> 'accounts') c),
  'la antigüedad, por tramos');
select ok((select bool_and(c ->> 'account' ~ '^[0-9a-f]{12}$') from jsonb_array_elements(pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') -> 'accounts') c),
  'cada cuenta, con una huella de doce caracteres');
select isnt(pruebas.token('teacher_points_jump', pruebas.ana()), pruebas.token('impossible_completion', pruebas.ana()),
  'la misma cuenta, otra huella en otra alerta');
select isnt(pruebas.token('teacher_points_jump', pruebas.ana()),
  left(encode(sha256(convert_to(pruebas.alerta_de('teacher_points_jump')::text || ':' || pruebas.ana()::text, 'UTF8')), 'hex'), 12),
  'y no es una huella sin llave');
-- Nada que identifique a nadie: ni identificadores, ni correos, ni nombres de alumnas, ni títulos.
select ok(not exists (
  select 1 from (select pruebas.lee(pruebas.finanzas())::text as t) x
  cross join (select id::text as v from public.profiles
              union all select email from auth.users where email like '%-alerta@prueba.test'
              union all values ('Ana Señalada'), ('Beto Señalado'), ('Uno'), ('Dos'), ('Tres'), ('Curso lectura')
              union all select id::text from public.teachers
              union all select id::text from public.published_lessons) s
  where position(s.v in x.t) > 0), 'lo que lee no trae identificadores, correos, nombres de alumnas ni títulos');

-- ---------------------------------------------------------------------------------------
-- Excluir por la pantalla: con la huella, solo de una cuenta de esa alerta.

-- Una de las cuentas que no se muestran (las de un medio punto empatan, y las ordena la huella).
create temporary table oculta as
  select pruebas.extra(n) as id from generate_series(1, 11) n
  where pruebas.token('teacher_points_jump', pruebas.extra(n)) not in (
    select c ->> 'account' from jsonb_array_elements(pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') -> 'accounts') c)
  limit 1;
grant select on oculta to app_service;
create function pruebas.oculta() returns uuid language sql stable as $$ select id from oculta $$;

select is(pruebas.excluye(pruebas.ana(), pruebas.alerta_de('teacher_points_jump'), pruebas.token('teacher_points_jump', pruebas.beto())),
  'forbidden', 'una alumna no excluye, aunque traiga una huella buena');
select is(pruebas.excluye(pruebas.finanzas(), pruebas.alerta_de('teacher_points_jump'), 'no es huella'), 'malformed', 'lo que no es huella, no llega');
select is(pruebas.excluye(pruebas.finanzas(), pruebas.alerta_de('teacher_points_jump'), '0123456789ab'), 'not_found', 'una huella que no es de nadie');
select is(pruebas.excluye(pruebas.finanzas(), pruebas.alerta_de('impossible_completion'), pruebas.token('impossible_completion', pruebas.beto())),
  'not_found', 'de lecciones imposibles, solo la cuenta de la alerta');
select is(pruebas.excluye(pruebas.finanzas(), pruebas.alerta_de('teacher_points_jump'), pruebas.token('teacher_points_jump', pruebas.oculta()), 'fraud'),
  'needs_fraud_decision', 'por fraude, no sin decidirlo');
select is(pruebas.excluye(pruebas.finanzas(), pruebas.alerta_de('teacher_points_jump'), pruebas.token('teacher_points_jump', pruebas.oculta())),
  'excluded', 'una cuenta que no está entre las diez que se muestran, sí');
select is((select count(*)::integer from public.consumption_exclusions
           where profile_id = pruebas.oculta() and period_id = pruebas.periodo(1) and anomaly_alert_id = pruebas.alerta_de('teacher_points_jump')),
  1, 'en el periodo de la alerta, ligada a ella');
select is(jsonb_array_length(pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') -> 'accounts'), 11,
  'y ya se muestra, marcada como excluida');
select is((select (c ->> 'excluded')::boolean from jsonb_array_elements(pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') -> 'accounts') c
           where c ->> 'account' = pruebas.token('teacher_points_jump', pruebas.oculta())), true, 'excluida');
select is((select array_agg(k order by k) from jsonb_object_keys(pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') -> 'exclusions' -> 0) k),
  array['account', 'created_at', 'created_by_name', 'id', 'reason', 'reason_code', 'revoke_reason', 'revoked_at', 'revoked_by_name', 'scope'],
  'su exclusión, con sus claves');
select is((pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') -> 'exclusions' -> 0 ->> 'created_by_name'), 'Fina Finanzas',
  'con quién la decidió, por su nombre');
-- La corrida de la noche borró sus filas del consolidado: la huella todavía se resuelve.
delete from public.watch_rollup where profile_id = pruebas.oculta();
select is(pruebas.excluye(pruebas.finanzas(), pruebas.alerta_de('teacher_points_jump'), pruebas.token('teacher_points_jump', pruebas.oculta()), 'other'),
  'excluded', 'una cuenta que ya no tiene consolidado se resuelve por sus exclusiones de esa alerta');
select is(pruebas.excluye(pruebas.finanzas(), pruebas.alerta_de('impossible_completion'), pruebas.token('impossible_completion', pruebas.ana())),
  'excluded', 'la cuenta de lecciones imposibles, sí');
select is((select row(revoked_at is not null)::text from public.consumption_exclusions where id =
             ((pruebas.tarjeta(pruebas.finanzas(), 'impossible_completion') -> 'exclusions' -> 0 ->> 'id')::uuid)), '(f)',
  'la lectura da el id de cada exclusión, para revertirla');

-- ---------------------------------------------------------------------------------------
-- Decidir fraude después de revisar, sin una nota que no se usaría.

select is(pruebas.revisa(pruebas.finanzas(), pruebas.alerta_de('teacher_points_jump'), 'La revisé.'), 'reviewed', 'se revisa');
select is((select is_fraud from public.anomaly_alerts where id = pruebas.alerta_de('teacher_points_jump')), null,
  'sin decidir fraude: queda nulo');
select is(pruebas.revisa(pruebas.finanzas(), pruebas.alerta_de('teacher_points_jump'), null, true, 'Once cuentas del mismo día.'),
  'marked_fraud', 'después, se decide fraude sin nota');
select is(pruebas.revisa(pruebas.finanzas(), pruebas.alerta_de('impossible_completion'), null), 'malformed',
  'pero revisar, sí la pide');
select is((pruebas.tarjeta(pruebas.finanzas(), 'teacher_points_jump') ->> 'reviewed_by_name'), 'Fina Finanzas', 'quién revisó, por su nombre');

-- ---------------------------------------------------------------------------------------
-- La lectura no se cae por un parámetro que falta.

update public.business_parameters set canceled_at = now(), canceled_by = pruebas.finanzas() where key = 'VELOCIDAD_MAX';
select lives_ok($$select pruebas.lee('b0000000-0000-0000-0000-000000000002')$$, 'sin VELOCIDAD_MAX, la lectura sigue');

-- ---------------------------------------------------------------------------------------
-- El vigilante conoce lo nuevo.

grant select on private.alert_account_key to app_service;
select ok(exists (select 1 from private.schema_violations() where problem = 'anomalies table reachable by app_service'
                  and object_name = 'private.alert_account_key'), 'avisa si alguien le deja al servidor leer la llave');
revoke select on private.alert_account_key from app_service;
grant execute on function private.finance_alerts() to authenticated;
select ok(exists (select 1 from private.schema_violations() where problem = 'finance function executable by authenticated'
                  and object_name = 'private.finance_alerts()'), 'o a una persona leer las alertas');
revoke execute on function private.finance_alerts() from authenticated;
-- Los disparadores de los parámetros, otra vez prendidos: el vigilante de los periodos los mira (T-601).
alter table public.business_parameters enable trigger user;
select is((select count(*)::integer from private.schema_violations()), 0, 'el vigilante no encuentra nada');

select * from finish();
rollback;
