-- T-409 · Las retenciones al liberar (RF-505, RF-510; 05 §10; ADR-16). Cuarta de cuatro solicitudes. Decisiones de Sergio del 2026-10-31: el freno pasa a
-- datos (sin regla, `withholding_rules_missing`), y sin datos fiscales liberar avisa (`tax_data_missing`) para que finanzas retenga a esos maestros y
-- libere a los demás; al soltar se calcula con lo vigente; quien no llega al mínimo no necesita datos ni regla, y el mínimo se mide contra el bruto.
--
-- El escenario es el de `46_liberar`: octubre de 2026, con M3 fundador y `PAGO_MINIMO` de 100 MXN. M1 y M2 se pagan, M3 se acumula, M4 no tiene nada.
begin;
\ir _ayuda.psql
select plan(119);

create function pruebas.al(p_n integer) returns uuid language sql immutable
as $$ select ('a6400000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
create function pruebas.finanzas() returns uuid language sql immutable as $$ select 'b6400000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.contenido() returns uuid language sql immutable as $$ select 'b6400000-0000-0000-0000-000000000002'::uuid $$;
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
-- Libera, cambia lo escrito con la sesión en réplica y adelanta la comprobación de lo liberado; si
-- cuadra, lanza P0002 para deshacerlo todo.
create function pruebas.descuadra(p_period integer, p_sql text) returns void language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  v := private.release_payouts(p_period, pruebas.vista(p_period));
  if v ->> 'outcome' <> 'released' then
    raise exception 'no liberó: %', v;
  end if;
  if p_sql is not null then
    set local session_replication_role = replica;
    execute p_sql;
    set local session_replication_role = origin;
  end if;
  set constraints payouts_released immediate;
  raise exception 'cuadra' using errcode = 'P0002';
end
$$;
create function pruebas.o(p jsonb) returns text language sql immutable as $$ select p ->> 'outcome' $$;
-- Desde PA-81 (T-605, cuarta solicitud) liberar lleva la huella de lo que se vio, y retener el estado que se vio.
create function pruebas.vista(p_period integer) returns text language sql stable
as $$ select private.release_preview(p_period) ->> 'fingerprint' $$;
create function pruebas.estado_y(p_id uuid) returns text language sql stable as $$ select status::text from public.payouts where id = p_id $$;
-- Una sentencia a mano como finanzas, con la comprobación de lo liberado adelantada; si pasa, lanza P0002
-- para deshacerla.
create function pruebas.a_mano(p_sql text) returns void language plpgsql as $$
begin
  perform pruebas.como_finanzas();
  execute p_sql;
  set constraints payouts_released immediate;
  raise exception 'cuadra' using errcode = 'P0002';
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
  select private.record_charge(pruebas.al(p_n), ('c6400000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid, 'manual',
                               'cobro-ret-' || p_n || '-' || p_gross, null,
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
-- La liquidación de un maestro en un periodo, y lo que dice en palabras.
create function pruebas.y(p_et text, p_period integer) returns uuid language sql stable
as $$ select id from public.payouts where teacher_id = pruebas.id(p_et) and period_id = p_period $$;
create function pruebas.liq(p_period integer) returns text[] language sql stable as $$
  select array(select format('%s %s pool=%s bonos=%s ajustes=%s saldo=%s bruto=%s', pruebas.et(teacher_id), status, pool_cents,
                             bonuses_cents, adjustments_cents, balance_applied_cents, subtotal_cents)
               from public.payouts where period_id = p_period order by pruebas.et(teacher_id))
$$;
create function pruebas.saldo(p_et text) returns bigint language sql stable
as $$ select coalesce(sum(amount_cents), 0)::bigint from public.teacher_balance_entries where teacher_id = pruebas.id(p_et) $$;
create function pruebas.estado(p_period integer) returns text language sql stable
as $$ select status::text from public.payout_periods where period_id = p_period $$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

delete from public.job_runs where period_id between 202609 and 202712;

-- Las cuentas, los maestros (M4 sin consumo) y M3 fundador, como en `45_liquidaciones`.
select pruebas.alta(pruebas.al(n), format('alumno%s-ret@prueba.test', n)) from generate_series(1, 4) n;
select pruebas.alta(pruebas.finanzas(), 'finanzas-ret@prueba.test');
select pruebas.alta(pruebas.contenido(), 'contenido-ret@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-ret@prueba.test';
select pruebas.dar_capacidad(pruebas.finanzas(), 'finance');
select pruebas.equipar(pruebas.finanzas());
select pruebas.dar_capacidad(pruebas.contenido(), 'content');
select pruebas.equipar(pruebas.contenido());
select pruebas.como_dueno_sistema();
select set_config('app.local_courses', 'on', true);
select private.system_catalog_add('practices', 'Naturaleza'), private.system_catalog_add('levels', 'Principiante');
select private.system_load_course(private.system_add_teacher('Maestra ' || s, 'maestra-' || s, null), pruebas.curso(s))
from unnest(array['ret-m1', 'ret-m2', 'ret-m3', 'ret-m4']) with ordinality as x (s, n) order by n;
select pruebas.como_dueno();
insert into pruebas.etiquetas select teacher_id, 'M' || right(slug, 1) from public.published_courses where slug like 'ret-m%';
select pruebas.como_dueno_sistema();
update public.teachers set is_founder = true, founder_since = '2026-10-01' where id = pruebas.id('M3');
select pruebas.como_dueno();
select pruebas.abierto(202610);
insert into public.subscriptions (id, profile_id, provider, provider_subscription_id, plan, status, currency)
select ('c6400000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, pruebas.al(n), 'manual', 'sus-ret-' || n,
       case when n = 3 then 'annual' else 'monthly' end::public.subscription_plan, 'pending', 'MXN'
from generate_series(1, 4) n;
select is(array[pruebas.cobra(1, '2026-10-05 12:00-06', 34900), pruebas.cobra(2, '2026-10-06 12:00-06', 34900),
                pruebas.cobra(3, '2026-10-07 12:00-06', 299000), pruebas.cobra(4, '2026-10-08 12:00-06', 34900)],
  array['recorded', 'recorded', 'recorded', 'recorded'], 'los cuatro cobros del ejemplo');
select pruebas.fila(202610, pruebas.al(1), 'ret-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres', 'Cuatro']) t;
select pruebas.fila(202610, pruebas.al(1), 'ret-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(1), 'ret-m2', 'Dos', 2),
       pruebas.fila(202610, pruebas.al(1), 'ret-m2', 'Tres', 1);
select pruebas.fila(202610, pruebas.al(2), 'ret-m2', 'Uno', 1);
select pruebas.fila(202610, pruebas.al(3), 'ret-m1', t, 2) from unnest(array['Uno', 'Dos', 'Tres']) t;
select pruebas.fila(202610, pruebas.al(3), 'ret-m2', 'Uno', 2), pruebas.fila(202610, pruebas.al(3), 'ret-m3', 'Uno', 2);
select pruebas.abierto(202611);
select pruebas.abierto(202612);
select pruebas.abierto(202702);


-- Un perfil en la base, sin cifrar nada: la base solo ve la forma. Y una regla.
create function pruebas.sellado(p_largo integer) returns bytea language sql immutable
as $$ select decode('01' || lpad(to_hex(1), 4, '0') || repeat('ab', 12 + p_largo + 16), 'hex') $$;
create function pruebas.perfil(p_et text, p_regimen text default '612', p_tipo text default 'person') returns void language plpgsql as $$
begin
  perform pruebas.como_dueno_sistema();
  insert into private.teacher_tax_profiles (teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version, created_by)
  select pruebas.id(p_et), coalesce((select max(version) from private.teacher_tax_profiles where teacher_id = pruebas.id(p_et)), 0) + 1,
         pruebas.sellado(13), pruebas.sellado(20), p_regimen, p_tipo, pruebas.sellado(18), '7771', 1, pruebas.finanzas();
  perform pruebas.como_dueno();
end
$$;
create function pruebas.regla(p_regimen text, p_tipo text, p_iva numeric, p_isr numeric, p_iva_ret numeric, p_desde date default '2020-01-01') returns uuid language plpgsql as $$
declare
  v uuid;
begin
  perform pruebas.como_dueno_sistema();
  insert into public.withholding_rules (tax_regime_code, payee_kind, vat_rate, income_tax_withholding_rate, vat_withholding_rate, effective_from, note)
  values (p_regimen, p_tipo, p_iva, p_isr, p_iva_ret, p_desde, 'prueba') returning id into v;
  perform pruebas.como_dueno();
  return v;
end
$$;
create function pruebas.libera(p_period integer) returns jsonb language sql as $$
  select pruebas.hace(format('private.release_payouts(%s, %L)', p_period, pruebas.vista(p_period)));
$$;
create function pruebas.suelta(p_et text, p_period integer) returns jsonb language sql as $$
  select pruebas.hace(format('private.unhold_payout(%L, null, %L)', pruebas.y(p_et, p_period), private.unhold_preview(pruebas.y(p_et, p_period)) ->> 'fingerprint'));
$$;
create function pruebas.retiene(p_et text, p_period integer) returns text language sql as $$
  select pruebas.o(pruebas.hace(format('private.hold_payout(%L, %L, %L)', pruebas.y(p_et, p_period), 'sin datos', pruebas.estado_y(pruebas.y(p_et, p_period)))));
$$;
create function pruebas.ids(p jsonb) returns text[] language sql stable as $$
  select array(select pruebas.et(x::uuid) from jsonb_array_elements_text(p -> 'teachers') x order by 1)
$$;
create function pruebas.calc(p_sub bigint, p_iva numeric, p_isr numeric, p_iva_ret numeric) returns bigint[] language sql immutable as $$
  select array[(v ->> 'vat_cents')::bigint, (v ->> 'income_tax_withheld_cents')::bigint, (v ->> 'vat_withheld_cents')::bigint, (v ->> 'net_cents')::bigint]
  from private.compute_withholdings(p_sub, p_iva, p_isr, p_iva_ret) v
$$;
-- Lo que PA-81 lee de un maestro.
create function pruebas.fila81(p_et text, p_period integer) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.como_finanzas();
  select x into v from jsonb_array_elements(private.finance_payouts(p_period) -> 'payouts') x where (x ->> 'teacher_id')::uuid = pruebas.id(p_et);
  perform pruebas.limpiar();
  return v;
end
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

-- ---------------------------------------------------------------------------------------
-- El cálculo.

select is(pruebas.calc(100000, 0, 0, 0), array[0, 0, 0, 100000]::bigint[], 'una regla en 0 conserva las cifras');
select is(pruebas.calc(100000, 0.16, 0.10, 0.106667), array[16000, 10000, 10666, 95334]::bigint[], 'honorarios: 16 % de IVA, 10 % de ISR y dos tercios del IVA');
select is(pruebas.calc(100000, 0, 0.0125, 0), array[0, 1250, 0, 98750]::bigint[], 'RESICO: 1.25 % de ISR');
select is(pruebas.calc(1, 0.16, 0.10, 0.106667), array[0, 0, 0, 1]::bigint[], 'un centavo no se retiene ni se come el neto');
select is(pruebas.calc(4, 0.125, 0, 0), array[1, 0, 0, 5]::bigint[], 'medio centavo de IVA sube');
select is(pruebas.calc(99, 0, 0.5, 0.49), array[0, 49, 48, 2]::bigint[], 'lo retenido va hacia abajo: nunca se come el bruto, aun casi completo');
select is(
  (select count(*)::integer from generate_series(1, 3000) n
   cross join lateral (select round(random()::numeric, 6) as i, round(random()::numeric * 0.5, 6) as r, round(random()::numeric * 0.499, 6) as v, (1 + floor(random() * 500000))::bigint as s, n) x
   where (private.compute_withholdings(x.s, x.i, x.r, x.v) ->> 'net_cents')::bigint <= 0), 0,
  'con lo retenido debajo de 1, el neto nunca llega a 0, sea cual sea el bruto');
select is((select provolatile from pg_proc where oid = 'private.compute_withholdings(bigint, numeric, numeric, numeric)'::regprocedure), 'i'::"char", 'el cálculo es puro');
select throws_ok($$select pruebas.regla('612', 'person', 0, 0.6, 0.4)$$, '23514', null, 'una regla que retiene todo no entra: el neto llegaría a 0');
select lives_ok($$select pruebas.regla('605', 'person', 0, 0.6, 0.3, '2090-01-01')$$, 'una que retiene casi todo, sí (esta rige en 2090: aquí no cuenta)');

-- El mínimo se mide contra el bruto, y lo que no llega no necesita nada.
select is(private.payout_tax_row(pruebas.id('M1'), 9999, 10000), '{"tax_state": "not_needed", "subtotal_cents": 9999, "profile_version": null, "rule_id": null, "vat_cents": 0, "income_tax_withheld_cents": 0, "vat_withheld_cents": 0, "net_cents": 9999}'::jsonb, 'debajo del mínimo no hay impuestos');
select is(private.payout_tax_row(pruebas.id('M1'), 0, 0) ->> 'tax_state', 'not_needed', 'en 0, aunque el mínimo sea 0');
select is(private.payout_tax_row(pruebas.id('M1'), -5, 0) ->> 'net_cents', '-5', 'un saldo en contra tampoco');
select is(private.payout_tax_row(pruebas.id('M1'), 500, null) ->> 'tax_state', 'not_needed', 'sin mínimo no se puede decir: liberar lo detiene antes');
select is(private.payout_tax_row(pruebas.id('M1'), 10000, 10000) ->> 'tax_state', 'no_data', 'en el mínimo ya pide datos');

-- ---------------------------------------------------------------------------------------
-- El escenario.

select pruebas.en_cierre(202610);
select is(pruebas.o(pruebas.cierra(202610)), 'closed', 'octubre se cierra');
create temporary table semilla as
  select id from public.business_parameters where key = 'PAGO_MINIMO' and canceled_at is null and effective_period_id = 202610;
select pruebas.como_dueno_sistema();
update public.business_parameters set canceled_at = now() where id in (select id from semilla);
select pruebas.parametro('PAGO_MINIMO', '10000', 202610);
select pruebas.como_dueno();
select is(pruebas.o(pruebas.hace(format('private.confirm_founder_bonus(%L)', (select id from public.bonuses where period_id = 202610 and kind = 'founder')))), 'confirmed', 'el bono de M3, confirmado');

-- ---------------------------------------------------------------------------------------
-- Sin ninguna regla: el freno.

select is(pruebas.o(pruebas.libera(202610)), 'withholding_rules_missing', 'sin ninguna regla vigente no se libera, aunque también falten los datos');
select is(pruebas.ids(pruebas.libera(202610)), array['M1', 'M2'], 'y dice a quién detiene: M3 no llega al mínimo');
select is((select payouts_released_at from public.payout_periods where period_id = 202610), null, 'el periodo sigue sin liberar');
select is((select count(*)::integer from public.payouts where period_id = 202610 and status <> 'calculated'), 0, 'ninguna liquidación se movió');

-- El freno detiene a quien cobraría (decisión de Sergio del 2026-11-01): si todos los que llegan están retenidos, se libera, sin que salga dinero. Se deshace.
create function pruebas.libera_y_deshace(p_sql text) returns void language plpgsql as $f$
declare
  v jsonb;
begin
  execute p_sql;
  v := pruebas.libera(202610);
  raise exception 'liberar contestó %', v ->> 'outcome' using errcode = 'P0002';
end
$f$;
select throws_like($$select pruebas.libera_y_deshace('select pruebas.retiene(''M1'', 202610), pruebas.retiene(''M2'', 202610)')$$, '%contestó released%', 'sin reglas y con los que llegan retenidos, se libera');
select throws_like($$select pruebas.libera_y_deshace('select pruebas.parametro(''PAGO_MINIMO'', ''999999999'', 202610), pruebas.como_dueno()')$$, '%contestó released%', 'sin reglas y sin nadie que llegue al mínimo, también');

-- Con datos, y con una regla de su régimen que todavía no rige.
select pruebas.perfil('M1', '605', 'person');
select is(pruebas.o(pruebas.libera(202610)), 'withholding_rules_missing', 'una regla que empieza después no sirve');
select is(pruebas.fila81('M1', 202610) ->> 'tax_state', 'no_rule', 'PA-81 lo dice en su fila');
select is(pruebas.fila81('M1', 202610) ->> 'has_tax_data', 'true', 'y que ya tiene datos');
select is(pruebas.fila81('M2', 202610) ->> 'has_tax_data', 'false', 'de quien no tiene, también');

-- ---------------------------------------------------------------------------------------
-- Con la regla: quien no tiene datos detiene, y se retiene.

create temporary table antes as select pruebas.vista(202610) as huella;
create temporary table regla as select pruebas.regla('612', 'person', 0.16, 0.10, 0.106667) as id;
select pruebas.perfil('M1', '612', 'person');
select isnt(pruebas.vista(202610), (select huella from antes), 'la regla y el perfil nuevos entran a lo que se ve');
select is(pruebas.o(pruebas.hace(format('private.release_payouts(202610, %L)', (select huella from antes)))), 'preview_changed', 'liberar lo que se vio antes no pasa');
select is(pruebas.o(pruebas.libera(202610)), 'tax_data_missing', 'hay regla y a M2 le faltan los datos');
select is(pruebas.ids(pruebas.libera(202610)), array['M2'], 'dice a quién');
select is(pruebas.fila81('M1', 202610) ->> 'tax_state', 'ready', 'M1 está listo');
select is(pruebas.fila81('M1', 202610) ->> 'vat_cents', round((pruebas.fila81('M1', 202610) ->> 'subtotal_cents')::numeric * 0.16)::bigint::text, 'y PA-81 ya estima su IVA');
select is(pruebas.fila81('M2', 202610) ->> 'tax_state', 'no_data', 'M2 no');
select is(pruebas.fila81('M2', 202610) ->> 'net_cents', null, 'y sin neto: no se puede saber');
select is(pruebas.fila81('M3', 202610) ->> 'tax_state', 'not_needed', 'M3 no llega al mínimo: no necesita nada');
create function pruebas.retiene_por_datos(p_et text, p_period integer, p_seen text default 'calculated') returns jsonb language sql as $$
  select pruebas.hace(format('private.hold_payout_for_tax_data(%L, %L)', pruebas.y(p_et, p_period), p_seen));
$$;
select is(pruebas.o(pruebas.retiene_por_datos('M1', 202610)), 'has_tax_data', 'quien tiene sus datos y su regla no se retiene por eso');
select is(pruebas.o(pruebas.retiene_por_datos('M2', 202610, 'on_hold')), 'changed', 'con otro estado a la vista, no');
select is(pruebas.o(pruebas.retiene_por_datos('M2', 202610)), 'held', 'finanzas retiene a M2 porque le faltan sus datos');
select is((select hold_kind from public.payouts where id = pruebas.y('M2', 202610)), 'tax_data', 'y queda dicho por qué');
select is((select btrim(hold_reason) <> '' from public.payouts where id = pruebas.y('M2', 202610)), true, 'con su motivo');
select is(pruebas.o(pruebas.retiene_por_datos('M2', 202610, 'on_hold')), 'already_held', 'ya está');
select is(pruebas.o(pruebas.hace(format('private.hold_payout_for_tax_data(%L, %L)', '00000000-0000-4000-8000-000000000009', 'calculated'))), 'not_found', 'una que no existe');
-- Una investigación es la que detiene la purga, y una retención por datos pasa a ella.
select is((select hold_kind from public.payouts where id = pruebas.y('M1', 202610)), null, 'sin retener no hay tipo');
select throws_ok($$select pruebas.a_mano(format('update public.payouts set hold_kind = %L where id = %L', 'investigation', pruebas.y('M1', 202610)))$$, '23514', null, 'el tipo no se pone sin retener');
select pruebas.como_dueno_sistema();

-- El día que rige: el último de una regla ya no cuenta, el primero sí, y es el día en la zona de los periodos.
select is(private.release_day(), (now() at time zone 'America/Mexico_City')::date, 'el día es el de la zona de los periodos, no el de UTC');
select ok(pg_get_functiondef('private.release_day()'::regprocedure) like '%private.period_zone()%', 'y lo saca del parámetro: fuera del día 1 los dos coinciden casi todo el día');
select pruebas.regla('616', 'person', 0, 0, 0, private.release_day());
select pruebas.perfil('M4', '616', 'person');
select is(private.payout_tax_row(pruebas.id('M4'), 10000, 1) ->> 'tax_state', 'ready', 'una regla rige desde su primer día');
select pruebas.como_dueno_sistema();
update public.withholding_rules set effective_to = private.release_day() + 1 where tax_regime_code = '616';
select pruebas.como_dueno();
select is(private.payout_tax_row(pruebas.id('M4'), 10000, 1) ->> 'tax_state', 'ready', 'y hasta el día antes de su fin');
select pruebas.como_dueno_sistema();
set local session_replication_role = replica;
update public.withholding_rules set effective_from = private.release_day() - 5, effective_to = private.release_day() where tax_regime_code = '616';
set local session_replication_role = origin;
select pruebas.como_dueno();
select is(private.payout_tax_row(pruebas.id('M4'), 10000, 1) ->> 'tax_state', 'no_rule', 'el día de su fin ya no cuenta');
-- El tipo de persona: el 626 es de los dos.
select pruebas.regla('626', 'company', 0, 0, 0);
select pruebas.perfil('M4', '626', 'person');
select is(private.payout_tax_row(pruebas.id('M4'), 10000, 1) ->> 'tax_state', 'no_rule', 'la regla de una persona moral no le sirve a una física con el mismo régimen');
select pruebas.regla('626', 'person', 0, 0, 0);
select is(private.payout_tax_row(pruebas.id('M4'), 10000, 1) ->> 'tax_state', 'ready', 'la suya sí');

-- ---------------------------------------------------------------------------------------
-- Lo liberado se comprueba al confirmar. Cada caso libera, rompe algo y se deshace.

select throws_ok($$select pruebas.descuadra(202610, null)$$, 'P0002', null, 'sin tocar nada, cuadra');
select throws_ok($$select pruebas.descuadra(202610, format($s$
  insert into private.teacher_tax_profiles (teacher_id, version, rfc_enc, legal_name_enc, tax_regime_code, payee_kind, clabe_enc, clabe_last4, key_version, created_by)
  values (%L, 9, pruebas.sellado(13), pruebas.sellado(20), '626', 'person', pruebas.sellado(18), '7771', 1, pruebas.finanzas());
  update public.payouts set withholding_rule_id = (select id from public.withholding_rules where tax_regime_code = '626' and payee_kind = 'company'), withholding_profile_version = 9,
    vat_cents = 0, income_tax_withheld_cents = 0, vat_withheld_cents = 0, net_cents = subtotal_cents where id = %L$s$, pruebas.id('M1'), pruebas.y('M1', 202610)))$$, '23514', null, 'con la regla del mismo régimen y de otro tipo de persona');
select throws_ok($$select pruebas.descuadra(202610, format('update public.payouts set vat_cents = vat_cents + 1, net_cents = net_cents + 1 where id = %L', pruebas.y('M1', 202610)))$$, '23514', null, 'un centavo de más de IVA');
select throws_ok($$select pruebas.descuadra(202610, format('update public.payouts set income_tax_withheld_cents = income_tax_withheld_cents + 1, net_cents = net_cents - 1 where id = %L', pruebas.y('M1', 202610)))$$, '23514', null, 'de ISR');
select throws_ok($$select pruebas.descuadra(202610, format('update public.payouts set vat_withheld_cents = vat_withheld_cents - 1, net_cents = net_cents + 1 where id = %L', pruebas.y('M1', 202610)))$$, '23514', null, 'de IVA retenido');
-- Con el neto compensado: la restricción de la tabla no lo ve, y cada columna se revisa contra su regla. Quitar una sola de esas tres revisiones no cambia nada, porque otra lo atrapa o la tabla exige que el neto cuadre.
select throws_ok($$select pruebas.descuadra(202610, format('update public.payouts set vat_cents = vat_cents + 1, income_tax_withheld_cents = income_tax_withheld_cents + 1 where id = %L', pruebas.y('M1', 202610)))$$, '23514', null, 'el IVA y el ISR movidos sin que cambie el neto');
select throws_ok($$select pruebas.descuadra(202610, format('update public.payouts set withholding_rule_id = (select id from public.withholding_rules where tax_regime_code = %L), vat_cents = 0, income_tax_withheld_cents = 0, vat_withheld_cents = 0, net_cents = subtotal_cents where id = %L', '605', pruebas.y('M1', 202610)))$$, '23514', null, 'con una regla de otro régimen, que además no rige ese día');
select throws_ok($$select pruebas.descuadra(202610, format('update public.payouts set withholding_profile_version = 1 where id = %L', pruebas.y('M1', 202610)))$$, '23514', null, 'con una versión de sus datos que tenía otro régimen');
select throws_ok($$select pruebas.descuadra(202610, format('update public.payouts set withholding_profile_version = 99 where id = %L', pruebas.y('M1', 202610)))$$, '23514', null, 'con una versión que no existe');
select throws_ok($$select pruebas.descuadra(202610, format('update public.payouts set withholding_rule_id = null, withholding_profile_version = null where id = %L', pruebas.y('M1', 202610)))$$, '23514', null, 'en espera de factura sin regla');
select throws_ok($$select pruebas.descuadra(202610, format('update public.payouts set vat_cents = 1, net_cents = net_cents + 1 where id = %L', pruebas.y('M3', 202610)))$$, '23514', null, 'acumulada con impuestos');
select throws_ok($$select pruebas.descuadra(202610, format('update public.payouts set withholding_rule_id = (select id from regla), withholding_profile_version = 1 where id = %L', pruebas.y('M3', 202610)))$$, '23514', null, 'acumulada con regla');
select throws_ok($$select pruebas.descuadra(202610, $s$update public.withholding_rules set effective_from = '2090-06-01' where tax_regime_code = '612'$s$)$$, '23514', null, 'con una regla que no regía ese día');

-- El guardián.
select throws_like($$select pruebas.a_mano(format('update public.payouts set status = %L, released_at = now(), released_by = private.actor_id() where id = %L', 'awaiting_invoice', pruebas.y('M1', 202610)))$$, '%with its withholding rule%', 'a mano, en espera de factura sin regla no pasa: lo detiene el guardián');
select throws_ok($$select pruebas.a_mano(format('update public.payouts set withholding_rule_id = (select id from regla) where id = %L', pruebas.y('M1', 202610)))$$, '23514', null, 'la regla no se escribe fuera de liberar');
select throws_like($$select pruebas.a_mano(format('update public.payouts set status = %L, vat_cents = 1, net_cents = subtotal_cents + 1 where id = %L', 'carried_forward', pruebas.y('M1', 202610)))$$, '%carried forward without taxes%', 'acumulada con impuestos, tampoco: lo detiene el guardián');
-- Liberar escribe lo que se comparó: si no es eso, no sigue.
create function pruebas.libera_con(p_tax jsonb) returns text language plpgsql as $f$
declare
  v text;
begin
  perform pruebas.como_finanzas();
  v := private.release_payout(pruebas.y('M1', 202610), 10000, p_tax)::text;
  raise exception 'liberó: %', v using errcode = 'P0002';
end
$f$;
select throws_like(format($$select pruebas.libera_con(%L)$$, jsonb_build_object('subtotal_cents', -1, 'tax_state', 'ready')), '%what was compared%', 'con otro bruto, no');
select throws_like(format($$select pruebas.libera_con(%L)$$, jsonb_build_object('subtotal_cents', (private.release_preview(202610) -> 'rows' -> 0 -> 'tax' ->> 'subtotal_cents')::bigint, 'tax_state', 'no_data')), '%what was compared%', 'sin el estado que se comparó, no');
select pruebas.como_dueno();

-- ---------------------------------------------------------------------------------------
-- Liberar. Noviembre se cierra antes: así M3 acumula después de ese cierre, y en noviembre llega solo por su saldo, sin liquidación.

select pruebas.en_cierre(202611);
select is(pruebas.o(pruebas.cierra(202611)), 'closed', 'noviembre se cierra');
select is(pruebas.o(pruebas.libera(202610)), 'released', 'con M2 retenida, se libera');
select is((select status::text from public.payouts where id = pruebas.y('M1', 202610)), 'awaiting_invoice', 'M1, en espera de factura');
select ok((select vat_cents = round(subtotal_cents * 0.16)::bigint and income_tax_withheld_cents = floor(subtotal_cents * 0.10)::bigint
                  and vat_withheld_cents = floor(subtotal_cents * 0.106667)::bigint and vat_cents > 0
           from public.payouts where id = pruebas.y('M1', 202610)), 'con sus impuestos');
select ok((select net_cents = subtotal_cents + vat_cents - income_tax_withheld_cents - vat_withheld_cents from public.payouts where id = pruebas.y('M1', 202610)), 'y su neto');
select is((select withholding_rule_id from public.payouts where id = pruebas.y('M1', 202610)), (select id from regla), 'dice con qué regla');
select is((select withholding_profile_version::integer from public.payouts where id = pruebas.y('M1', 202610)), 2, 'y con qué versión de sus datos');
select is((select array[vat_cents, income_tax_withheld_cents, vat_withheld_cents] from public.payouts where id = pruebas.y('M3', 202610)), array[0, 0, 0]::bigint[], 'M3, acumulada, sin impuestos');
select is((select withholding_rule_id is null and withholding_profile_version is null and net_cents = subtotal_cents from public.payouts where id = pruebas.y('M3', 202610)), true, 'y sin regla');
select is((select status::text from public.payouts where id = pruebas.y('M2', 202610)), 'on_hold', 'M2 sigue retenida');
select is((pruebas.fila81('M1', 202610) ->> 'net_cents')::bigint, (select net_cents from public.payouts where id = pruebas.y('M1', 202610)), 'PA-81 lee lo liberado');
select is((select count(*)::integer from public.audit_log a where a.entity_table like '%payouts' and (a.new_value ? 'withholding_rule_id' or a.old_value ? 'withholding_rule_id')), 0,
  'la auditoría no dice con qué regla: configuración la lee, y la regla dice el régimen');
select ok((select count(*) > 0 from public.audit_log a where a.entity_table like '%payouts' and a.new_value ->> 'status' = 'awaiting_invoice' and a.new_value ? 'net_cents'), 'y sí las cifras');
set constraints payouts_released immediate;
set constraints payouts_released deferred;

-- ---------------------------------------------------------------------------------------
-- Soltar calcula con lo vigente, y sin datos o sin regla no sale.

select is(pruebas.o(pruebas.suelta('M2', 202610)), 'tax_data_missing', 'sin datos no se suelta');
select is(pruebas.estado_y(pruebas.y('M2', 202610)), 'on_hold', 'y sigue retenida');
select is(pruebas.fila81('M2', 202610) ->> 'tax_state', 'no_data', 'PA-81 lo dice en su fila, también ya liberado el mes');
select is(pruebas.fila81('M2', 202610) ->> 'hold_kind', 'tax_data', 'y por qué está retenida');
-- La purga: una retención por datos no la detiene, y una investigación sí. Con el mes pasado de plazo; se deshace.
create function pruebas.purga_y_deshace(p_sql text) returns void language plpgsql as $f$
declare
  v text;
begin
  execute p_sql;
  perform pruebas.como_dueno_sistema();
  alter table public.payout_periods disable trigger payout_periods_guard;
  update public.payout_periods set closed_at = now() - interval '4000 days' where period_id = 202610;
  alter table public.payout_periods enable trigger payout_periods_guard;
  v := private.purge_watch_partition(202610);
  raise exception 'la purga contestó %', v using errcode = 'P0002';
end
$f$;
select throws_matching($$select pruebas.purga_y_deshace('select 1')$$, 'contestó (purged|no_partition|progress_pending)', 'una retención por datos no detiene la purga');
select is(pruebas.o(pruebas.hace(format('private.hold_payout(%L, %L, %L)', pruebas.y('M2', 202610), 'Se investiga.', 'on_hold'))), 'held', 'si aparece otra causa, pasa a investigación');
select is((select hold_kind from public.payouts where id = pruebas.y('M2', 202610)), 'investigation', 'con su tipo');
select throws_matching($$select pruebas.purga_y_deshace('select 1')$$, 'contestó on_hold', 'y esa sí detiene la purga');
select is(pruebas.o(pruebas.hace(format('private.hold_payout(%L, %L, %L)', pruebas.y('M2', 202610), 'Otra vez.', 'on_hold'))), 'already_held', 'una investigación ya no cambia');
select throws_ok($$select pruebas.a_mano(format('update public.payouts set hold_kind = %L where id = %L', 'tax_data', pruebas.y('M2', 202610)))$$, '23514', null, 'ni vuelve a ser por datos');
create temporary table vista_m2 as select private.unhold_preview(pruebas.y('M2', 202610)) ->> 'fingerprint' as huella;
select pruebas.perfil('M2', '605', 'person');
select isnt(private.unhold_preview(pruebas.y('M2', 202610)) ->> 'fingerprint', (select huella from vista_m2), 'capturar sus datos cambia lo que se ve');
select is(pruebas.o(pruebas.hace(format('private.unhold_payout(%L, null, %L)', pruebas.y('M2', 202610), (select huella from vista_m2)))), 'changed', 'un formulario de antes contesta que cambió');
select is(pruebas.o(pruebas.suelta('M2', 202610)), 'withholding_rules_missing', 'con un régimen sin regla vigente, tampoco');
select is(pruebas.estado_y(pruebas.y('M2', 202610)), 'on_hold', 'y sigue retenida');
select pruebas.perfil('M2', '612', 'person');
select is(pruebas.o(pruebas.suelta('M2', 202610)), 'released_from_hold', 'con los datos de ahora, sale');
select is((select array[status::text, withholding_profile_version::text] from public.payouts where id = pruebas.y('M2', 202610)), array['awaiting_invoice', '2'], 'en espera de factura, con su versión vigente');
select ok((select vat_cents = round(subtotal_cents * 0.16)::bigint and vat_cents > 0 from public.payouts where id = pruebas.y('M2', 202610)), 'y con sus impuestos');
set constraints payouts_released immediate;
set constraints payouts_released deferred;
-- Cambiar los datos después no cambia lo liberado.
create temporary table m2 as select net_cents, withholding_profile_version from public.payouts where id = pruebas.y('M2', 202610);
select pruebas.perfil('M2', '612', 'person');
select is((select withholding_profile_version from public.payouts where id = pruebas.y('M2', 202610)), (select withholding_profile_version from m2), 'lo liberado no sigue a los datos');
-- Y una liquidación ya liberada que se retiene y se suelta vuelve igual, sin preguntar por nada.
select is(pruebas.retiene('M2', 202610), 'held', 'se retiene ya liberada');
select is(pruebas.o(pruebas.suelta('M2', 202610)), 'released_from_hold', 'y se suelta');
select is((select net_cents from public.payouts where id = pruebas.y('M2', 202610)), (select net_cents from m2), 'con el mismo neto');

-- ---------------------------------------------------------------------------------------
-- Quien llega por su saldo no tiene liquidación: para poder retenerlo, liberar se la deja lista.

select pruebas.parametro('PAGO_MINIMO', '1', 202611);
select pruebas.como_dueno();
select is(pruebas.y('M3', 202611), null, 'M3 no tiene liquidación en noviembre');
select is(pruebas.o(pruebas.libera(202611)), 'tax_data_missing', 'su saldo llega al mínimo, y no tiene datos');
select isnt(pruebas.y('M3', 202611), null, 'ya tiene liquidación');
select is(pruebas.retiene('M3', 202611), 'held', 'y se puede retener');

-- ---------------------------------------------------------------------------------------
-- Las puertas.

select is((select count(*)::integer from private.schema_violations_payouts()), 0, 'el área de las liquidaciones, en orden');
select is((select count(*)::integer from private.schema_violations_tax()), 0, 'el área fiscal, en orden');
select ok(not has_function_privilege('app_service', 'private.compute_withholdings(bigint, numeric, numeric, numeric)', 'execute'), 'la aplicación no llama al cálculo');
select ok(not has_function_privilege('app_service', 'private.payout_tax_row(uuid, bigint, bigint)', 'execute'), 'ni a la fila de impuestos');
select ok(not has_function_privilege('app_service', 'private.tax_profile_fiscal(uuid, integer)', 'execute'), 'ni a lo fiscal en claro');
alter function private.tax_profile_fiscal(uuid, integer) security definer;
select is((select count(*)::integer from private.schema_violations_tax() where problem = 'tax_profile_fiscal reachable'), 1, 'el vigilante ve si lo fiscal en claro se abre');
alter function private.tax_profile_fiscal(uuid, integer) security invoker;
alter table public.withholding_rules drop constraint withholding_rules_something_left;
select is((select count(*)::integer from private.schema_violations_tax() where problem like 'tax constraint missing%'), 1, 'y si falta lo que garantiza un neto positivo');
select ok(pg_get_functiondef('private.tax_profile_fiscal(uuid, integer)'::regprocedure) !~ '_enc', 'lo fiscal en claro no toca lo cifrado');
select ok(pg_get_functiondef('private.tax_profile_fiscal(uuid, integer)'::regprocedure) !~ 'clabe', 'ni los últimos cuatro');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'release_payout'), 1, 'liberar una liquidación tiene una sola firma');

select * from finish();
rollback;
