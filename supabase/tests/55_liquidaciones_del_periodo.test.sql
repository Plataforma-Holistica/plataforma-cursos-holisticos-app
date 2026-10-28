-- T-605, cuarta solicitud · PA-81 mínimo: las liquidaciones del periodo, liberar, retener y soltar, y decidir el
-- bono del fundador desde el servidor (RF-505, RF-506, RF-508, RN-12, RN-17; 05 §5.5 y §8.7). Decisiones de Sergio
-- del 2026-10-28: el plan con las huellas de la revisión independiente del diseño, y en producción no se libera
-- hasta T-409 (eso lo frena la aplicación). Como en la 72 con el cierre, nadie libera algo distinto de lo que vio:
-- `private.release_preview()` calcula lo que liberar escribiría y su huella, y `release_payouts(p, huella)` solo
-- libera con la huella de ahora; soltar lleva la huella de su liquidación (`unhold_preview`), porque soltar una
-- calculada de un mes liberado la libera ahí mismo; y retener lleva el estado que se vio.
--
-- Octubre de 2026 es el ejemplo del PRD con M3 fundador, como en `46_liberar`: M1 y M2 se pagan con un mínimo de
-- 100 MXN y M3 se acumula con su bono. Noviembre no tiene consumo. La comprobación de lo liberado corre al
-- confirmar; `pruebas.hace()` la adelanta.
begin;
\ir _ayuda.psql
select plan(70);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a6055000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b6055000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.contenido() returns uuid language sql immutable as $$ select 'b6055000-0000-0000-0000-000000000002'::uuid $$;
create table pruebas.etiquetas (id uuid primary key, et text not null);
create function pruebas.et(p_id uuid) returns text language sql stable as $$ select et from pruebas.etiquetas where id = p_id $$;
create function pruebas.id(p_et text) returns uuid language sql stable as $$ select id from pruebas.etiquetas where et = p_et $$;

create function pruebas.como_finanzas(p_id uuid default null) returns void language sql as $$
  select pruebas.limpiar();
  select set_config('app.actor_id', coalesce(p_id, pruebas.finanzas())::text, true),
         set_config('app.actor_session', pruebas.sesion(coalesce(p_id, pruebas.finanzas()))::text, true);
$$;
-- Una llamada de finanzas, con las comprobaciones de lo liberado adelantadas (como al confirmar).
create function pruebas.hace(p_call text, p_id uuid default null) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas(p_id);
  execute 'select ' || p_call into v;
  set constraints payouts_released immediate;
  set constraints payouts_released deferred;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.o(p jsonb) returns text language sql immutable as $$ select p ->> 'outcome' $$;
-- Lo que finanzas ve antes de liberar, y la huella con la que liberaría.
create function pruebas.vista(p_period integer) returns text language sql stable
as $$ select private.release_preview(p_period) ->> 'fingerprint' $$;
create function pruebas.libera(p_period integer) returns jsonb language sql
as $$ select pruebas.hace(format('private.release_payouts(%s, %L)', p_period, pruebas.vista(p_period))) $$;
-- La liquidación de un maestro en un periodo, su estado y la huella de soltarla.
create function pruebas.y(p_et text, p_period integer) returns uuid language sql stable
as $$ select id from public.payouts where teacher_id = pruebas.id(p_et) and period_id = p_period $$;
create function pruebas.estado_y(p_id uuid) returns text language sql stable as $$ select status::text from public.payouts where id = p_id $$;
create function pruebas.retiene(p_et text, p_period integer, p_reason text) returns jsonb language sql as $$
  select pruebas.hace(format('private.hold_payout(%L, %L, %L)', pruebas.y(p_et, p_period), p_reason,
                             pruebas.estado_y(pruebas.y(p_et, p_period))))
$$;
create function pruebas.suelta(p_et text, p_period integer) returns jsonb language sql as $$
  select pruebas.hace(format('private.unhold_payout(%L, null, %L)', pruebas.y(p_et, p_period),
                             private.unhold_preview(pruebas.y(p_et, p_period)) ->> 'fingerprint'))
$$;
-- Lo que la lectura de PA-81 dice de cada maestro, en palabras.
create function pruebas.filas(p jsonb) returns text[] language sql stable as $$
  select array(select format('%s %s pool=%s fundador=%s bonos=%s ajustes=%s saldo=%s bruto=%s estimado=%s minimo=%s',
                             pruebas.et((r ->> 'teacher_id')::uuid), coalesce(r ->> 'status', 'sin_liquidacion'), r ->> 'pool_cents',
                             coalesce((r -> 'founder_bonus' ->> 'status') || ':' || (r -> 'founder_bonus' ->> 'amount_cents'), '-'),
                             r ->> 'manual_bonuses_cents', r ->> 'adjustments_cents', r ->> 'balance_cents', r ->> 'subtotal_cents',
                             r ->> 'estimated', coalesce(r ->> 'reaches_minimum', '-'))
               from jsonb_array_elements(p -> 'payouts') r order by pruebas.et((r ->> 'teacher_id')::uuid))
$$;
create function pruebas.lee(p_period integer, p_id uuid default null) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas(p_id);
  v := private.finance_payouts(p_period);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.cierra(p_period integer) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  perform private.rehearse_close(p_period);
  v := private.close_period(p_period, private.last_rehearsal(p_period));
  set constraints payout_periods_balanced immediate;
  set constraints payout_periods_balanced deferred;
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.en_cierre(p_period integer) returns void language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(p_period);
  alter table public.payout_periods disable trigger payout_periods_guard;
  update public.payout_periods set status = 'closing', entered_closing_at = now() - interval '2 days',
         active_students = 4, pool_bps = 6000
  where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard;
  perform pruebas.como_dueno();
  insert into public.job_runs (job, period_id, status, started_at, heartbeat_at, finished_at, details)
  values ('nightly_rollup', p_period, 'succeeded', now() - interval '3 minutes', now() - interval '3 minutes',
          now() - interval '2 minutes', '{"mode": "full"}'::jsonb);
end
$$;
create function pruebas.abierto(p_period integer) returns void language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  perform private.open_period(p_period);
  alter table public.payout_periods disable trigger payout_periods_guard;
  update public.payout_periods set status = 'open', entered_closing_at = null where period_id = p_period;
  alter table public.payout_periods enable trigger payout_periods_guard;
  perform pruebas.como_dueno();
end
$$;
create function pruebas.parametro(p_key text, p_value jsonb, p_period integer) returns uuid language sql as $$
  select pruebas.como_dueno_sistema();
  insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
  values (p_key, p_value, 'decided', clock_timestamp() - interval '1 second', p_period) returning id;
$$;
create function pruebas.cobra(p_n integer, p_at timestamptz, p_gross bigint) returns text language sql as $$
  select private.record_charge(pruebas.al(p_n), ('c6055000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid, 'manual',
                               'cobro-liq-' || p_n || '-' || p_gross, null,
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
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

delete from public.job_runs where period_id between 202609 and 202712;

-- Las cuentas, los maestros (M4 sin consumo) y M3 fundador, como en `46_liberar`.
select pruebas.alta(pruebas.al(n), format('alumno%s-liq@prueba.test', n)) from generate_series(1, 4) n;
select pruebas.alta(pruebas.finanzas(), 'finanzas-liq@prueba.test');
select pruebas.alta(pruebas.contenido(), 'contenido-liq@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-liq@prueba.test';
select pruebas.dar_capacidad(pruebas.finanzas(), 'finance');
select pruebas.equipar(pruebas.finanzas());
select pruebas.dar_capacidad(pruebas.contenido(), 'content');
select pruebas.equipar(pruebas.contenido());
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra ' || s, 'maestra-' || s, null), pruebas.curso(s))
from unnest(array['liq-m1', 'liq-m2', 'liq-m3', 'liq-m4']) with ordinality as x (s, n) order by n;
select pruebas.como_dueno();
insert into pruebas.etiquetas select teacher_id, 'M' || right(slug, 1) from public.published_courses where slug like 'liq-m%';
select pruebas.como_dueno_sistema();
update public.teachers set is_founder = true, founder_since = '2026-10-01' where id = pruebas.id('M3');
select pruebas.como_dueno();
select pruebas.abierto(202610);
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
select ('c6055000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, pruebas.al(n), 'manual', 'sus-liq-' || n,
       case when n = 3 then 'annual' else 'monthly' end::public.subscription_plan, 'pending', 'MXN'
from generate_series(1, 4) n;
select is(array[pruebas.cobra(1, '2026-10-05 12:00-06', 34900), pruebas.cobra(2, '2026-10-06 12:00-06', 34900),
                pruebas.cobra(3, '2026-10-07 12:00-06', 299000), pruebas.cobra(4, '2026-10-08 12:00-06', 34900)],
  array['recorded', 'recorded', 'recorded', 'recorded'], 'los cuatro cobros del ejemplo');
select pruebas.fila(202610, pruebas.al(1), 'liq-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres', 'Cuatro']) t;
select pruebas.fila(202610, pruebas.al(1), 'liq-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(1), 'liq-m2', 'Dos', 2),
       pruebas.fila(202610, pruebas.al(1), 'liq-m2', 'Tres', 1);
select pruebas.fila(202610, pruebas.al(2), 'liq-m2', 'Uno', 1);
select pruebas.fila(202610, pruebas.al(3), 'liq-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres']) t;
select pruebas.fila(202610, pruebas.al(3), 'liq-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(3), 'liq-m3', 'Uno', 2);
select pruebas.abierto(202611);

-- ---------------------------------------------------------------------------------------
-- Las piezas: una sola firma de cada función de finanzas, y el servidor ejecuta las de PA-81.

select ok(to_regprocedure('private.release_payouts(public.period_id)') is null
          and to_regprocedure('private.hold_payout(uuid, text, uuid)') is null
          and to_regprocedure('private.unhold_payout(uuid, text)') is null,
  'las firmas de antes ya no existen: liberar, retener y soltar llevan lo que se vio');
select ok(has_function_privilege('app_service', 'private.release_payouts(public.period_id, text)', 'execute')
          and has_function_privilege('app_service', 'private.hold_payout(uuid, text, text, uuid)', 'execute')
          and has_function_privilege('app_service', 'private.unhold_payout(uuid, text, text)', 'execute')
          and has_function_privilege('app_service', 'private.confirm_founder_bonus(uuid)', 'execute')
          and has_function_privilege('app_service', 'private.void_bonus(uuid, text)', 'execute')
          and has_function_privilege('app_service', 'private.finance_payouts(public.period_id)', 'execute'),
  'el servidor libera, retiene, suelta, decide el bono del fundador y lee PA-81');
select ok(not has_function_privilege('app_service', 'private.release_preview(public.period_id)', 'execute')
          and not has_function_privilege('app_service', 'private.unhold_preview(uuid)', 'execute')
          and not has_function_privilege('app_service', 'private.capture_bonus(uuid, text, bigint, public.period_id, text)', 'execute')
          and not has_function_privilege('app_service', 'private.capture_adjustment(uuid, public.period_id, bigint, text, uuid)', 'execute'),
  'pero no calcula las vistas por su cuenta, ni captura bonos ni ajustes (PA-83)');
select ok(not has_function_privilege('authenticated', 'private.release_payouts(public.period_id, text)', 'execute')
          and not has_function_privilege('anon', 'private.finance_payouts(public.period_id)', 'execute')
          and not has_function_privilege('authenticated', 'private.finance_payouts(public.period_id)', 'execute'),
  'nadie más');
select is(array(select p.proname::text || ':' || p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'private' and p.proname in ('release_preview', 'unhold_preview', 'finance_payouts')
                order by p.proname),
  array['finance_payouts:true', 'release_preview:false', 'unhold_preview:false'],
  'la lectura corre como el dueño; las vistas, como quien las llama');

-- ---------------------------------------------------------------------------------------
-- Octubre cerrado, antes de liberar: lo que se ve.

select pruebas.en_cierre(202610);
select is(pruebas.o(pruebas.cierra(202610)), 'closed', 'octubre se cierra');
select is(pruebas.lee(202610, pruebas.contenido()), null, 'sin finanzas la lectura es nula');
select pruebas.limpiar();
select is(private.finance_payouts(202610), null, 'y sin nadie que actúe, también');
select is(pruebas.lee(203601) -> 'period', 'null'::jsonb, 'un mes sin fila no tiene periodo');
select is(pruebas.lee(202611) -> 'payouts', '[]'::jsonb, 'un periodo abierto no tiene liquidaciones');
select is(pruebas.lee(202611) -> 'release', 'null'::jsonb, 'ni qué liberar');
create temporary table antes as select pruebas.lee(202610) as r;
select is((select r ->> 'fresh_code' from antes), 'true', 'dice si el código es reciente');
select is((select r -> 'period' ->> 'status' from antes), 'closed', 'el periodo, cerrado');
select is((select r -> 'period' ->> 'payouts_released_at' from antes), null, 'sin liberar');
select is(pruebas.filas((select r from antes)),
  array['M1 calculated pool=24494 fundador=- bonos=0 ajustes=0 saldo=0 bruto=24494 estimado=true minimo=false',
        'M2 calculated pool=35843 fundador=- bonos=0 ajustes=0 saldo=0 bruto=35843 estimado=true minimo=false',
        'M3 calculated pool=3350 fundador=proposed:502 bonos=0 ajustes=0 saldo=0 bruto=3350 estimado=true minimo=false'],
  'una fila por maestro con liquidación; el bono propuesto no suma todavía, y con el mínimo de 500 MXN nadie llega');
select is((select r -> 'release' ->> 'fingerprint' from antes), pruebas.vista(202610), 'la huella es la de la vista de liberar');
select is((select r -> 'release' ->> 'pending_founder_bonuses' from antes), '1', 'y cuántos bonos del fundador faltan por decidir');
select is((select r -> 'payouts' -> 0 ->> 'name' from antes), 'Maestra liq-m1', 'con el nombre publicado');
select ok((select r::text not like '%' || pruebas.al(1)::text || '%' from antes), 'sin el identificador de ningún alumno');

-- ---------------------------------------------------------------------------------------
-- Liberar exige la huella de lo que se vio.

create temporary table vieja as select pruebas.vista(202610) as h;
select is(pruebas.o(pruebas.hace('private.release_payouts(202610, null)')), 'malformed', 'sin huella no se libera');
select is(pruebas.o(pruebas.hace('private.release_payouts(202610, ''abc'')')), 'founder_bonuses_pending',
  'con el bono del fundador sin decidir, eso se dice primero');
select is(pruebas.o(pruebas.hace(format('private.confirm_founder_bonus(%L)', (select id from public.bonuses where period_id = 202610)))),
  'confirmed', 'finanzas confirma el bono del fundador desde el servidor');
select isnt(pruebas.vista(202610), (select h from vieja), 'confirmar el bono cambia la huella');
create temporary table semilla as
  select id from public.business_parameters where key = 'PAGO_MINIMO' and canceled_at is null and effective_period_id = 202610;
select pruebas.como_dueno_sistema();
update public.business_parameters set canceled_at = now() where id in (select id from semilla);
select pruebas.como_dueno();
select pruebas.parametro('PAGO_MINIMO', '10000', 202610);
select is(pruebas.hace(format('private.release_payouts(202610, %L)', (select h from vieja))), '{"outcome": "preview_changed"}'::jsonb,
  'con la huella de antes de confirmar el bono no se libera');
select is((select count(*)::integer from public.payouts where period_id = 202610 and status <> 'calculated'), 0, 'y no se escribió nada');
delete from vieja;
insert into vieja select pruebas.vista(202610);
select is(pruebas.o(pruebas.retiene('M1', 202610, 'Se revisa.')), 'held', 'alguien retiene a M1 después de ver');
select is(pruebas.o(pruebas.hace(format('private.release_payouts(202610, %L)', (select h from vieja)))), 'preview_changed',
  'retener cambia lo que liberar escribiría');
select is(pruebas.o(pruebas.suelta('M1', 202610)), 'released_from_hold', 'se suelta');
select is(pruebas.vista(202610), (select h from vieja), 'y la vista vuelve a ser la de antes');
-- M3 se queda retenida al liberar: al soltarla en noviembre pasará a tener saldo después de ese cierre.
select is(pruebas.o(pruebas.retiene('M3', 202610, 'Se investiga.')), 'held', 'M3 se retiene antes de liberar');
create temporary table ahora as select pruebas.lee(202610) as r;
select is(pruebas.filas((select r from ahora)),
  array['M1 calculated pool=24494 fundador=- bonos=0 ajustes=0 saldo=0 bruto=24494 estimado=true minimo=true',
        'M2 calculated pool=35843 fundador=- bonos=0 ajustes=0 saldo=0 bruto=35843 estimado=true minimo=true',
        'M3 on_hold pool=3350 fundador=confirmed:502 bonos=0 ajustes=0 saldo=0 bruto=3852 estimado=true minimo=false'],
  'con el bono confirmado y el mínimo de 100 MXN: M1 y M2 llegan; M3, retenida, no llegaría');
select is((select r -> 'release' ->> 'pending_founder_bonuses' from ahora), '0', 'sin bonos por decidir');
create temporary table liberacion as
  select pruebas.hace(format('private.release_payouts(202610, %L)', (select r -> 'release' ->> 'fingerprint' from ahora))) as r;
select is((select r ->> 'outcome' from liberacion), 'released', 'con la huella de lo que se ve, se libera');
select is(array(select format('%s %s %s', pruebas.et(teacher_id), status, subtotal_cents) from public.payouts
                where period_id = 202610 and status <> 'on_hold' order by pruebas.et(teacher_id)),
  (select array(select format('%s %s %s', pruebas.et((x ->> 'teacher_id')::uuid),
                              case when (x ->> 'reaches_minimum')::boolean then 'awaiting_invoice' else 'carried_forward' end,
                              x ->> 'subtotal_cents')
                from jsonb_array_elements(r -> 'payouts') x where x ->> 'status' = 'calculated'
                order by pruebas.et((x ->> 'teacher_id')::uuid)) from ahora),
  'lo que se liberó es lo que la vista decía, fila por fila');
select is(pruebas.libera(202610), '{"outcome": "already_released", "period_id": 202610}'::jsonb, 'liberar otra vez no escribe nada');
select is(pruebas.filas(pruebas.lee(202610)),
  array['M1 awaiting_invoice pool=24494 fundador=- bonos=0 ajustes=0 saldo=0 bruto=24494 estimado=false minimo=true',
        'M2 awaiting_invoice pool=35843 fundador=- bonos=0 ajustes=0 saldo=0 bruto=35843 estimado=false minimo=true',
        'M3 on_hold pool=3350 fundador=confirmed:502 bonos=0 ajustes=0 saldo=0 bruto=3852 estimado=true minimo=false'],
  'liberado, las cifras son las escritas; la retenida sigue estimada: soltarla la liberaría');
select is(pruebas.lee(202610) -> 'release', 'null'::jsonb, 'y ya no hay qué liberar');
select ok((pruebas.lee(202610) -> 'period' ->> 'payouts_released_at') is not null, 'con la fecha en que se liberó');

-- ---------------------------------------------------------------------------------------
-- Retener lleva el estado que se vio.

select is(pruebas.o(pruebas.hace(format('private.hold_payout(%L, %L, null)', pruebas.y('M2', 202610), 'Sin estado.')))
  , 'malformed', 'retener sin el estado que se vio');
select is(pruebas.hace(format('private.hold_payout(%L, %L, %L)', pruebas.y('M2', 202610), 'Antes de liberar.', 'calculated')),
  '{"outcome": "changed", "status": "awaiting_invoice"}'::jsonb,
  'quien vio a M2 calculada y pidió retenerla para frenarla se entera de que ya se liberó');
select is(pruebas.estado_y(pruebas.y('M2', 202610)), 'awaiting_invoice', 'y no se retuvo');
select is(pruebas.retiene('M2', 202610, 'Revisión de su factura.'), '{"outcome": "held", "from": "awaiting_invoice"}'::jsonb,
  'con el estado de ahora, sí');
select is(pruebas.hace(format('private.hold_payout(%L, %L, %L)', pruebas.y('M2', 202610), 'Otra vez.', 'awaiting_invoice')),
  '{"outcome": "already_held"}'::jsonb, 'una retenida otra vez: ya está');
select is((select r ->> 'hold_reason' from jsonb_array_elements(pruebas.lee(202610) -> 'payouts') r
           where (r ->> 'teacher_id')::uuid = pruebas.id('M2')), 'Revisión de su factura.', 'la lectura dice por qué está retenida');

-- ---------------------------------------------------------------------------------------
-- Soltar lleva la huella de su liquidación.

select is(pruebas.o(pruebas.hace(format('private.unhold_payout(%L, null, null)', pruebas.y('M2', 202610))))
  , 'malformed', 'soltar sin huella');
select is(pruebas.hace(format('private.unhold_payout(%L, null, %L)', pruebas.y('M2', 202610), 'abc')),
  '{"outcome": "changed"}'::jsonb, 'con otra huella, no se suelta');
select is((select r ->> 'unhold_fingerprint' from jsonb_array_elements(pruebas.lee(202610) -> 'payouts') r
           where (r ->> 'teacher_id')::uuid = pruebas.id('M2')), private.unhold_preview(pruebas.y('M2', 202610)) ->> 'fingerprint',
  'la lectura trae la huella con la que se suelta');
select is((private.unhold_preview(pruebas.y('M2', 202610)) ->> 'releases')::boolean, false,
  'soltar una en espera de factura no libera nada: vuelve a donde estaba');
select is(pruebas.suelta('M2', 202610), '{"outcome": "released_from_hold", "to": "awaiting_invoice", "period_status": "closed"}'::jsonb,
  'con la huella de ahora, se suelta');
select is(pruebas.o(pruebas.suelta('M2', 202610)), 'not_held', 'soltar otra vez: no está retenida');

-- ---------------------------------------------------------------------------------------
-- Noviembre: un maestro que pasa a tener saldo después del cierre, al soltar en octubre.

select pruebas.en_cierre(202611);
select is(pruebas.o(pruebas.cierra(202611)), 'closed', 'noviembre se cierra');
select is(pruebas.lee(202611) -> 'payouts', '[]'::jsonb, 'sin consumo ni nada pendiente, sin liquidaciones');
-- Retener y soltar a M1 en octubre (en espera de factura) no mueve su saldo: la vista de noviembre se queda.
delete from vieja;
insert into vieja select pruebas.vista(202611);
select is(pruebas.o(pruebas.retiene('M1', 202610, 'Una duda.')), 'held', 'retener en octubre');
select is(pruebas.vista(202611), (select h from vieja), 'no cambia lo que noviembre liberaría');
select is(pruebas.o(pruebas.suelta('M1', 202610)), 'released_from_hold', '(se suelta)');
-- Soltar a M3 en octubre la libera ahí mismo, acumulada: su saldo pasa a noviembre, ya cerrado, sin liquidación ahí.
select is((private.unhold_preview(pruebas.y('M3', 202610)) - 'fingerprint'),
  jsonb_build_object('payout_id', pruebas.y('M3', 202610), 'status', 'on_hold', 'held_from_status', 'calculated', 'releases', true,
                     'pool_cents', 3350, 'bonuses_cents', 502, 'adjustments_cents', 0, 'balance_cents', 0, 'subtotal_cents', 3852,
                     'reaches_minimum', false),
  'soltar a M3 la liberaría con su bono, debajo del mínimo');
select is(pruebas.suelta('M3', 202610), '{"outcome": "released_from_hold", "to": "carried_forward", "period_status": "closed"}'::jsonb,
  'se suelta y se acumula');
select isnt(pruebas.vista(202611), (select h from vieja), 'eso cambia lo que noviembre liberaría');
select is(pruebas.filas(pruebas.lee(202611)),
  array['M3 sin_liquidacion pool=0 fundador=- bonos=0 ajustes=0 saldo=3852 bruto=3852 estimado=true minimo=false'],
  'M3 aparece sin liquidación todavía, con su saldo: liberar se la da');
-- Un ajuste capturado a mano (PA-83 todavía no existe) cae en noviembre y le da su liquidación a M4.
delete from vieja;
insert into vieja select pruebas.vista(202611);
select is((select pruebas.hace(format('private.capture_adjustment(%L, 202610, 5000, %L)', pruebas.id('M4'), 'Un pago que faltó.'))
           ->> 'applied_period_id'), '202611', 'un ajuste a favor de M4 entra a noviembre');
select is(pruebas.o(pruebas.hace(format('private.release_payouts(202611, %L)', (select h from vieja)))), 'preview_changed',
  'con la vista de antes del ajuste, no se libera');
select is(pruebas.o(pruebas.libera(202611)), 'released', 'noviembre se libera con la huella de lo que se ve');
select is(array(select format('%s %s %s', pruebas.et(teacher_id), status, subtotal_cents) from public.payouts
                where period_id = 202611 order by pruebas.et(teacher_id)),
  array['M3 carried_forward 3852', 'M4 carried_forward 5000'], 'liberar le dio su liquidación a M3, y los dos se acumulan');
-- M4 tiene saldo y no tiene liquidación en octubre, ya liberado: octubre no lo muestra (liberado, solo las suyas).
select is(array(select pruebas.et((r ->> 'teacher_id')::uuid) from jsonb_array_elements(pruebas.lee(202610) -> 'payouts') r order by 1),
  array['M1', 'M2', 'M3'], 'un periodo liberado muestra solo sus liquidaciones, no a quien tiene saldo en otro');

-- ---------------------------------------------------------------------------------------
-- El vigilante: la columna del servidor, en los dos sentidos.

select is_empty($$select * from private.schema_violations_payouts()$$, 'en orden');
select pruebas.como_dueno_sistema();
revoke execute on function private.release_payouts(public.period_id, text) from app_service;
select results_eq($$select problem, object_name like 'private.release_payouts(%' from private.schema_violations_payouts()$$,
  $$values ('payouts function not executable by app_service', true)$$, 'liberar fuera del alcance del servidor');
grant execute on function private.release_payouts(public.period_id, text) to app_service;
grant execute on function private.release_preview(public.period_id) to app_service;
select results_eq($$select problem, object_name like 'private.release_preview(%' from private.schema_violations_payouts()$$,
  $$values ('payouts function executable by app_service', true)$$, 'la vista al alcance del servidor');
revoke execute on function private.release_preview(public.period_id) from app_service;
alter function private.finance_payouts(public.period_id) security invoker;
select results_eq($$select problem, object_name like 'private.finance_payouts(%' from private.schema_violations_payouts()$$,
  $$values ('payouts function not security definer', true)$$, 'la lectura sin correr como el dueño');
alter function private.finance_payouts(public.period_id) security definer;
select is_empty($$select * from private.schema_violations_payouts()$$, 'y todo en su lugar otra vez');
select pruebas.como_dueno();

select * from finish();
rollback;
