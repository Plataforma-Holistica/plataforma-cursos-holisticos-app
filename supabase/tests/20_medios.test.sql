-- T-202 · Los hechos de la puerta única de medios (RF-306; RN-01; TRD §5.1). Decisiones de
-- Sergio del 2026-10-15: `subscriptions` y `courtesy_grants` nacen aquí sin nadie de la
-- aplicación que las escriba (T-302, T-303 y T-307 traen a quien escribe).
--
-- Lo que el servidor le pregunta a la base son dos funciones: `private.media_facts()`, los
-- hechos de quien actúa y de la lección, sin el playback id; y `private.lesson_playback()`,
-- el playback id, solo si pasa una condición gruesa (la segunda barrera). RN-01 vive en
-- TypeScript. Quien actúa sale de `private.actor_id()`: bajo el servidor no hay `auth.uid()`.
begin;
\ir _ayuda.psql
select plan(70);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000002', 'beto@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000003', 'maestra@prueba.test');
select pruebas.alta('a0000000-0000-0000-0000-000000000004', 'suspendida@prueba.test');
select pruebas.alta('b0000000-0000-0000-0000-000000000001', 'contenido@prueba.test');
-- Beto no confirmó su correo.
select pruebas.confirmar(id) from auth.users where email like '%@prueba.test' and email <> 'beto@prueba.test';
select pruebas.dar_capacidad('b0000000-0000-0000-0000-000000000001', 'content');
select pruebas.equipar('b0000000-0000-0000-0000-000000000001');
select pruebas.suspender('a0000000-0000-0000-0000-000000000004');

create function pruebas.hechos(p_id uuid, p_lesson uuid) returns jsonb
language sql as $$ select pruebas.pide(p_id, format('private.media_facts(%L)', p_lesson))::jsonb $$;
create function pruebas.playback(p_id uuid, p_lesson uuid) returns text
language sql as $$ select pruebas.pide(p_id, format('private.lesson_playback(%L)', p_lesson)) $$;
-- Un curso de dos lecciones: la primera de Mux, la segunda de prueba.
create function pruebas.curso(p_slug text) returns jsonb
language sql as $$
  select jsonb_build_object(
    'slug', p_slug, 'title', 'Curso ' || p_slug, 'summary', 'Un curso de prueba.',
    'practice', 'naturaleza', 'level', 'principiante',
    'modules', jsonb_build_array(jsonb_build_object('title', 'Módulo uno', 'lessons', jsonb_build_array(
      jsonb_build_object('title', 'Lección uno', 'video',
        jsonb_build_object('provider', 'mux', 'asset_id', 'AssetMedios' || replace(p_slug, '-', ''),
                           'playback_id', 'PlaybackMedios' || replace(p_slug, '-', ''), 'duration_seconds', 356)),
      jsonb_build_object('title', 'Lección dos', 'video',
        jsonb_build_object('provider', 'test', 'asset_id', p_slug || '-a2', 'playback_id', 'prueba:' || p_slug, 'duration_seconds', 409))))))
$$;
-- La primera lección (la de Mux) y la segunda (la de prueba) de un curso, por su slug.
create function pruebas.leccion(p_slug text, p_position integer default 1) returns uuid
language sql as $$
  select l.id from public.published_lessons l join public.published_courses c on c.course_id = l.course_id
  where c.slug = p_slug and l.position = p_position
$$;
-- Una suscripción, escrita por el dueño: nadie de la aplicación puede todavía.
create function pruebas.suscripcion(
  p_profile uuid, p_status text, p_created timestamptz, p_end timestamptz,
  p_failed timestamptz default null, p_ended timestamptz default null) returns void
language sql as $$
  insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status, currency,
                                    current_period_start, current_period_end, last_renewal_failed_at, ended_at, created_at)
  values (p_profile, 'manual', gen_random_uuid()::text, 'monthly', p_status::public.subscription_status, 'MXN',
          p_end - interval '30 days', p_end, p_failed, p_ended, p_created)
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- Las tablas y quién las escribe.

select has_table('public', 'subscriptions', 'existe public.subscriptions');
select has_table('public', 'courtesy_grants', 'existe public.courtesy_grants');
select ok(
  not has_any_column_privilege('app_service', 'public.subscriptions', 'insert, update')
  and not has_table_privilege('app_service', 'public.subscriptions', 'delete, truncate, trigger')
  and not has_any_column_privilege('authenticated', 'public.subscriptions', 'insert, update')
  and not has_any_column_privilege('anon', 'public.subscriptions', 'select, insert, update'),
  'nadie de la aplicación escribe las suscripciones');
select ok(
  not has_any_column_privilege('app_service', 'public.courtesy_grants', 'insert, update')
  and not has_table_privilege('app_service', 'public.courtesy_grants', 'delete, truncate, trigger')
  and not has_any_column_privilege('authenticated', 'public.courtesy_grants', 'insert, update')
  and not has_any_column_privilege('anon', 'public.courtesy_grants', 'select, insert, update'),
  'ni las cortesías');
grant insert on public.subscriptions to app_service;
grant update (revoked_at) on public.courtesy_grants to app_service;
select is(
  (select array_agg(object_name order by object_name) from private.schema_violations()
   where problem like 'account facts table writable by %'),
  array['public.courtesy_grants', 'public.subscriptions'],
  'el vigilante dice si alguien les concede escribir, también por columnas');
revoke insert on public.subscriptions from app_service;
revoke update (revoked_at) on public.courtesy_grants from app_service;

-- Una fecha `infinity` llegaría a la regla como fecha inválida («no se supo»): quien paga se
-- quedaría sin video. Sin fin se escribe nulo.
select throws_ok(format($$insert into public.subscriptions (profile_id, provider, provider_subscription_id, plan, status,
    currency, current_period_start, current_period_end, last_renewal_failed_at, ended_at)
  values ('a0000000-0000-0000-0000-000000000001', 'manual', %L, 'monthly', 'expired', 'MXN', %s)$$, gen_random_uuid(), v.fechas),
  '23514', null, 'una suscripción no acepta ' || v.caso)
  from (values
    ('un inicio de periodo -infinity', $$'-infinity', now(), null, null$$),
    ('un fin de periodo infinity', $$now(), 'infinity', null, null$$),
    ('una falla infinity', $$now(), now() + interval '1 day', 'infinity', null$$),
    ('un fin infinity', $$now(), now() + interval '1 day', null, 'infinity'$$)) as v (caso, fechas);
select throws_ok(format($$insert into public.courtesy_grants (profile_id, reason, starts_at, ends_at, granted_by)
  values ('a0000000-0000-0000-0000-000000000001', 'prueba', %s, 'b0000000-0000-0000-0000-000000000001')$$, v.fechas),
  '23514', null, 'una cortesía no acepta ' || v.caso)
  from (values
    ('un inicio -infinity', $$'-infinity', null$$),
    ('un fin infinity', $$now(), 'infinity'$$)) as v (caso, fechas);

select has_function('private', 'media_facts', array['uuid'], 'existe private.media_facts(uuid)');
select has_function('private', 'lesson_playback', array['uuid'], 'existe private.lesson_playback(uuid)');
select ok(
  has_function_privilege('app_service', 'private.media_facts(uuid)', 'execute')
  and has_function_privilege('app_service', 'private.lesson_playback(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.media_facts(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.lesson_playback(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.lesson_playback(uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.lesson_playback(uuid)', 'execute'),
  'las dos las llama solo el servidor');
select ok(
  (select bool_and(prosecdef and provolatile = 's') from pg_proc
   where oid in ('private.media_facts(uuid)'::regprocedure, 'private.lesson_playback(uuid)'::regprocedure)),
  'las dos son security definer y estables: no escriben');

-- ---------------------------------------------------------------------------------------
-- Los cursos: uno listado, uno en revisión y uno que se retira. Y la maestra, con su cuenta.

select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
create temporary table maestra as select private.system_add_teacher('Maestra de medios', 'maestra-de-medios', null) as id;
update public.teachers set profile_id = 'a0000000-0000-0000-0000-000000000003', status = 'active'
  where id = (select id from maestra);
select private.system_load_course((select id from maestra), pruebas.curso(slug))
  from (values ('curso-listado'), ('curso-revision'), ('curso-retirado')) as v (slug);
select pruebas.limpiar();
select is(pruebas.pide('b0000000-0000-0000-0000-000000000001',
  format('private.approve_course(%L)', course_id)), 'approved', 'se aprueba ' || slug)
  from public.published_courses where slug in ('curso-listado', 'curso-retirado') order by slug;
select pruebas.como_dueno_sistema();
update public.course_registry set state = 'withdrawn', withdrawn_at = now(), withdrawal_reason = 'prueba'
  where course_id = (select course_id from public.published_courses where slug = 'curso-retirado');
update public.published_courses set is_listed = false where slug = 'curso-retirado';
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Quién lee las tablas: cada quien lo suyo.

select pruebas.suscripcion('a0000000-0000-0000-0000-000000000001', 'active', now() - interval '10 days', now() + interval '20 days');
select pruebas.suscripcion('a0000000-0000-0000-0000-000000000002', 'expired', now() - interval '40 days', now() - interval '10 days');
insert into public.courtesy_grants (profile_id, reason, starts_at, ends_at, granted_by)
values ('a0000000-0000-0000-0000-000000000002', 'prueba', now() - interval '1 day', null, 'b0000000-0000-0000-0000-000000000001');
select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001');
select is((select count(*) from public.subscriptions), 1::bigint, 'una cuenta lee solo su suscripción');
select is((select count(*) from public.courtesy_grants), 0::bigint, 'y solo sus cortesías');
select pruebas.limpiar();

-- ---------------------------------------------------------------------------------------
-- Los hechos de quien actúa.

select is((select private.media_facts(pruebas.leccion('curso-listado'))), null, 'sin nadie que actúe: nula');
select is(pruebas.hechos('d0000000-0000-0000-0000-000000000009', pruebas.leccion('curso-listado')), null,
  'quien actúa sin perfil: nula, sin correo de nadie');
create temporary table h as
  select pruebas.hechos('a0000000-0000-0000-0000-000000000001', pruebas.leccion('curso-listado')) as f;
select is((select array_agg(k order by k) from h, jsonb_object_keys(f) as k),
  array['courtesy', 'lesson', 'now', 'subscription', 'viewer'], 'en un solo valor, con estas partes');
select is((select f -> 'viewer' from h),
  '{"suspended": false, "email_verified": true, "teacher_id": null, "email": "ana@prueba.test"}'::jsonb,
  'de la persona: activa, verificada, sin ser maestra, y su correo para la marca de agua (T-203)');
select is(pruebas.hechos('a0000000-0000-0000-0000-000000000002', null) -> 'viewer' ->> 'email', 'beto@prueba.test',
  'el correo es el de quien actúa, nunca el de otro');
select is(pruebas.hechos('b0000000-0000-0000-0000-000000000001', null) -> 'viewer' ->> 'email', 'contenido@prueba.test',
  'también el de alguien del equipo');
select ok((select abs(extract(epoch from (f ->> 'now')::timestamptz - now())) < 1 from h), 'con la hora de la base');
select is((select f -> 'courtesy' from h), '[]'::jsonb, 'sin cortesías: una lista vacía');
select is((select (f -> 'subscription' ->> 'paid_through')::timestamptz from h),
  (select current_period_end from public.subscriptions where profile_id = 'a0000000-0000-0000-0000-000000000001'),
  'paid_through es el fin del periodo de su suscripción');
select is((select array_agg(k order by k) from h, jsonb_object_keys(f -> 'subscription') as k),
  array['ended_at', 'failed_at', 'grace_days', 'paid_through', 'refunded'], 'de la suscripción, los cuatro hechos y la gracia');
select ok((select f -> 'subscription' -> 'failed_at' = 'null'::jsonb and f -> 'subscription' -> 'grace_days' = 'null'::jsonb
                  and f -> 'subscription' -> 'ended_at' = 'null'::jsonb and not (f -> 'subscription' ->> 'refunded')::boolean from h),
  'sin falla, la gracia va nula: no se usa');
drop table h;

select is(pruebas.hechos('a0000000-0000-0000-0000-000000000002', null) -> 'viewer' -> 'email_verified', 'false'::jsonb,
  'el correo sin confirmar se dice');
select is(pruebas.hechos('a0000000-0000-0000-0000-000000000004', null) -> 'viewer' -> 'suspended', 'true'::jsonb,
  'la cuenta suspendida se dice');
select is(pruebas.hechos('a0000000-0000-0000-0000-000000000004', null) -> 'subscription', 'null'::jsonb,
  'sin suscripción: nula');
select is(pruebas.hechos('a0000000-0000-0000-0000-000000000003', null) -> 'viewer' ->> 'teacher_id',
  (select id::text from maestra), 'la maestra, con su id de maestra');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspended_by = 'b0000000-0000-0000-0000-000000000001',
  suspension_reason = 'prueba' where id = (select id from maestra);
select pruebas.limpiar();
select is(pruebas.hechos('a0000000-0000-0000-0000-000000000003', null) -> 'viewer' ->> 'teacher_id',
  (select id::text from maestra), 'suspendida como maestra, lo sigue siendo (RF-702: solo lectura)');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'left', suspended_at = null, suspended_by = null, suspension_reason = null, left_at = now()
  where id = (select id from maestra);
select pruebas.limpiar();
select is(pruebas.hechos('a0000000-0000-0000-0000-000000000003', null) -> 'viewer' -> 'teacher_id', 'null'::jsonb,
  'una maestra que se fue ya no lo es');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'active', left_at = null where id = (select id from maestra);
select pruebas.limpiar();

-- Cuál suscripción: la viva (`active` o `in_grace`, solo puede haber una), y si no hay, la más
-- reciente sin contar las que nunca se pagaron (decisión de Sergio del 2026-10-15).
select pruebas.suscripcion('a0000000-0000-0000-0000-000000000001', 'pending', now() - interval '1 hour', null::timestamptz);
select is((pruebas.hechos('a0000000-0000-0000-0000-000000000001', null) -> 'subscription' ->> 'paid_through')::timestamptz,
  (select current_period_end from public.subscriptions where profile_id = 'a0000000-0000-0000-0000-000000000001' and status = 'active'),
  'una pendiente más nueva no tapa a la que paga');
select pruebas.suscripcion('a0000000-0000-0000-0000-000000000001', 'canceled', now() - interval '30 minutes',
  now() - interval '1 minute', null, now() - interval '1 minute');
select is((pruebas.hechos('a0000000-0000-0000-0000-000000000001', null) -> 'subscription') - 'grace_days',
  (select jsonb_build_object('paid_through', current_period_end, 'failed_at', null, 'ended_at', null, 'refunded', false)
     from public.subscriptions where profile_id = 'a0000000-0000-0000-0000-000000000001' and status = 'active'),
  'una terminada más nueva tampoco: los hechos son todos de la viva');
select pruebas.suscripcion('a0000000-0000-0000-0000-000000000002', 'refunded', now() - interval '1 hour', now() + interval '29 days',
  null, now() - interval '30 minutes');
create temporary table h as select pruebas.hechos('a0000000-0000-0000-0000-000000000002', null) as f;
select ok((select (f -> 'subscription' ->> 'refunded')::boolean from h), 'una reembolsada lo dice');
select ok((select (f -> 'subscription' ->> 'ended_at') is not null from h), 'con su fin, de la misma suscripción');
select is((select (f -> 'subscription' ->> 'paid_through')::timestamptz from h),
  (select current_period_end from public.subscriptions where profile_id = 'a0000000-0000-0000-0000-000000000002' and status = 'refunded'),
  'y los hechos son todos de la más reciente, no de la vieja');
drop table h;

-- La gracia: el parámetro vigente a la hora de la falla.
select pruebas.suscripcion('a0000000-0000-0000-0000-000000000004', 'in_grace', now() - interval '20 days', now() - interval '1 day',
  now() - interval '1 day');
select is(pruebas.hechos('a0000000-0000-0000-0000-000000000004', null) -> 'subscription' -> 'grace_days',
  private.parameter_value('GRACIA_COBRO_DIAS', now() - interval '1 day'), 'con falla, la gracia vigente a esa hora');
select pruebas.suscripcion('a0000000-0000-0000-0000-000000000003', 'expired', now() - interval '10 hours',
  timestamptz '2026-09-01 00:00:00+00', timestamptz '2026-09-01 00:00:00+00');
select is(pruebas.hechos('a0000000-0000-0000-0000-000000000003', null) -> 'subscription' -> 'grace_days', 'null'::jsonb,
  'una falla de antes de que el parámetro existiera: nula, no la de hoy');

-- Las cortesías: las vigentes y las futuras, sin las revocadas.
insert into public.courtesy_grants (profile_id, reason, starts_at, ends_at, granted_by, revoked_at, revoked_by)
values
  ('a0000000-0000-0000-0000-000000000001', 'vigente', now() - interval '1 day', now() + interval '1 day',
   'b0000000-0000-0000-0000-000000000001', null, null),
  ('a0000000-0000-0000-0000-000000000001', 'sin fin', now() + interval '1 day', null,
   'b0000000-0000-0000-0000-000000000001', null, null),
  ('a0000000-0000-0000-0000-000000000001', 'revocada', now() - interval '1 day', null,
   'b0000000-0000-0000-0000-000000000001', now(), 'b0000000-0000-0000-0000-000000000001');
create temporary table h as select pruebas.hechos('a0000000-0000-0000-0000-000000000001', null) as f;
select is((select jsonb_array_length(f -> 'courtesy') from h), 2, 'las cortesías sin revocar');
select is((select array_agg(k order by k) from h, jsonb_object_keys(f -> 'courtesy' -> 0) as k),
  array['from', 'until'], 'cada una, de cuándo a cuándo');
select is((select count(*) from h, jsonb_array_elements(f -> 'courtesy') as c where c -> 'until' = 'null'::jsonb), 1::bigint,
  'la que no tiene fin va con su fin nulo');
drop table h;

-- ---------------------------------------------------------------------------------------
-- Los hechos de la lección.

select is(pruebas.hechos('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000000') -> 'lesson',
  'null'::jsonb, 'una lección que no existe: nula');
select is(pruebas.hechos('a0000000-0000-0000-0000-000000000001', null) -> 'lesson', 'null'::jsonb, 'sin lección: nula');
create temporary table h as
  select pruebas.hechos('a0000000-0000-0000-0000-000000000001', pruebas.leccion('curso-listado')) as f;
select is((select f -> 'lesson' from h), jsonb_build_object(
  'is_current', true, 'provider', 'mux', 'ready', true, 'duration_seconds', 356, 'teacher_id', (select id from maestra),
  'course_state', 'published', 'listed', true, 'is_open', false), 'la lección listada, con su curso');
select ok((select f::text not like '%PlaybackMedios%' and f::text not like '%AssetMedios%' from h),
  'nunca trae el playback id ni el asset id');
drop table h;
select is((pruebas.hechos('a0000000-0000-0000-0000-000000000001', pruebas.leccion('curso-revision')) -> 'lesson')
            - array['is_current', 'provider', 'ready', 'duration_seconds', 'teacher_id'],
  '{"course_state": "in_review", "listed": false, "is_open": false}'::jsonb, 'la de un curso en revisión, sin listar');
select is((pruebas.hechos('a0000000-0000-0000-0000-000000000001', pruebas.leccion('curso-retirado')) -> 'lesson')
            - array['is_current', 'provider', 'ready', 'duration_seconds', 'teacher_id'],
  '{"course_state": "withdrawn", "listed": false, "is_open": false}'::jsonb, 'la de un curso retirado');
select is(pruebas.hechos('a0000000-0000-0000-0000-000000000001', pruebas.leccion('curso-listado', 2)) -> 'lesson' ->> 'provider',
  'test', 'la de prueba dice su proveedor');

-- Abierto lo dice el registro, que tiene sus restricciones; la copia de lo publicado no manda.
select pruebas.como_dueno_sistema();
update public.published_courses set is_open = true where slug = 'curso-listado';
select pruebas.limpiar();
select is(pruebas.hechos('a0000000-0000-0000-0000-000000000001', pruebas.leccion('curso-listado')) -> 'lesson' -> 'is_open',
  'false'::jsonb, 'si la copia dice abierto y el registro no, no está abierto');
select pruebas.como_dueno_sistema();
update public.course_registry set is_open = true, open_since = now()
  where course_id = (select course_id from public.published_courses where slug = 'curso-listado');
select pruebas.limpiar();
select is(pruebas.hechos('a0000000-0000-0000-0000-000000000001', pruebas.leccion('curso-listado')) -> 'lesson' -> 'is_open',
  'true'::jsonb, 'con el registro abierto, abierto');

-- ---------------------------------------------------------------------------------------
-- El playback id: solo con la condición gruesa.

select is(pruebas.playback('a0000000-0000-0000-0000-000000000001', pruebas.leccion('curso-listado')), 'PlaybackMedioscursolistado',
  'de un curso listado y publicado: sí');
select is(pruebas.playback('a0000000-0000-0000-0000-000000000002', pruebas.leccion('curso-revision')), null,
  'de un curso en revisión, a una cuenta común: no');
select is(pruebas.playback('a0000000-0000-0000-0000-000000000002', pruebas.leccion('curso-retirado')), null,
  'de un curso retirado, a una cuenta común: no');
select is(pruebas.playback('a0000000-0000-0000-0000-000000000003', pruebas.leccion('curso-revision')), 'PlaybackMedioscursorevision',
  'a la maestra dueña, en revisión: sí');
select is(pruebas.playback('a0000000-0000-0000-0000-000000000003', pruebas.leccion('curso-retirado')), 'PlaybackMedioscursoretirado',
  'y retirado: sí');
select is(pruebas.playback('b0000000-0000-0000-0000-000000000001', pruebas.leccion('curso-revision')), 'PlaybackMedioscursorevision',
  'a quien tiene Contenido: sí');
select is(pruebas.playback('a0000000-0000-0000-0000-000000000001', pruebas.leccion('curso-listado', 2)), null,
  'un video de prueba: no');
select is((select private.lesson_playback(pruebas.leccion('curso-listado'))), null,
  'sin nadie que actúe, ni de un curso listado y publicado');

-- Cada mitad de «publicado y listado» cuenta por sí sola, y una lección que ya no es la
-- vigente no suelta su video. Cada caso se deshace.
savepoint barrera;
select pruebas.como_dueno_sistema();
update public.published_courses set is_listed = false where slug = 'curso-listado';
select pruebas.limpiar();
select is(pruebas.playback('a0000000-0000-0000-0000-000000000002', pruebas.leccion('curso-listado')), null,
  'de un curso publicado sin listar, a una cuenta común: no');
rollback to savepoint barrera;
select pruebas.como_dueno_sistema();
update public.published_courses set is_listed = true where slug = 'curso-revision';
select pruebas.limpiar();
select is(pruebas.playback('a0000000-0000-0000-0000-000000000002', pruebas.leccion('curso-revision')), null,
  'de un curso listado que no está publicado, a una cuenta común: no');
rollback to savepoint barrera;
select pruebas.como_dueno_sistema();
update public.published_lessons set is_current = false, retired_at = now() where id = pruebas.leccion('curso-listado');
select pruebas.limpiar();
select is(pruebas.playback('a0000000-0000-0000-0000-000000000002', pruebas.leccion('curso-listado')), null,
  'de una lección que ya no es la vigente: no');
rollback to savepoint barrera;
select is(pruebas.playback('a0000000-0000-0000-0000-000000000002', pruebas.leccion('curso-listado')), 'PlaybackMedioscursolistado',
  'deshecho cada caso, el curso listado vuelve a soltar su video');

select pruebas.como_dueno_sistema();
update public.video_assets set status = 'processing' where provider_asset_id = 'AssetMedioscursolistado';
select pruebas.limpiar();
select is(pruebas.playback('a0000000-0000-0000-0000-000000000001', pruebas.leccion('curso-listado')), null,
  'un video sin terminar: no');
select is(pruebas.playback('a0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000000'), null,
  'una lección que no existe: no');

select is_empty('select * from private.schema_violations()', 'private.schema_violations() sigue en cero');

select * from finish();
rollback;
