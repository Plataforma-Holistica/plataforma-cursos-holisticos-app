-- T-605 · El panel del periodo, el cierre desde la aplicación y su exportación (RF-705, RF-509, RF-408;
-- 05 §5.5, §5.10, §8.6 y §13.1). Primera de tres solicitudes: la base. Decisiones de Sergio del
-- 2026-10-27:
-- - el CSV del cierre se arma en la base, dentro de la transacción del cierre, y se guarda con su huella
--   en `private.close_exports`, de solo inserción; sin cubeta ni clave secreta. Columnas provisionales
--   hasta LF-14, sin CLABE ni neto (el archivo de pago llega con T-409);
-- - «Recalcular» (PA-79) es un pedido: `private.request_rollup()` lo deja y un trabajo de `pg_cron` de
--   cada minuto lo corre (`private.run_rollup_requests()`);
-- - la conciliación con el proveedor de cobro va en T-303, no aquí.
-- Decisiones mías sin confirmar (PROGRESO, 2026-10-27): el servidor ensaya y cierra síncrono, en su
-- transacción con el tope de 10 s, así que se le abren `rehearse_close` y `close_period`; la exportación
-- la escribe un disparador del paso de en cierre a cerrado (el mismo efecto que escribirla en
-- `close_period`, sin copiar el cierre) y la comprueba la comprobación al confirmar; descargarla pide la
-- puerta de finanzas con el código reciente y queda en la auditoría; el CSV va con marca de UTF-8, fin de
-- línea CRLF y un renglón por maestro en el orden de su identificador. La migración cambia
-- `code_version`: un periodo en cierre al aplicarla contesta `rehearsal_stale` y se ensaya otra vez.

-- ---------------------------------------------------------------------------------------
-- El servidor ensaya y cierra (PA-80).

grant execute on function private.rehearse_close(public.period_id), private.close_period(public.period_id) to app_service;

-- ---------------------------------------------------------------------------------------
-- Las celdas del CSV.

-- Un monto en centavos, en pesos con dos decimales, por aritmética entera.
create function private.csv_money(p_cents bigint) returns text
language sql immutable set search_path = ''
as $$
  select case when p_cents < 0 then '-' else '' end
         || pg_catalog.div(pg_catalog.abs(p_cents::numeric), 100)::text || '.'
         || pg_catalog.lpad((pg_catalog.abs(p_cents::numeric) % 100)::text, 2, '0')
$$;
revoke all on function private.csv_money(bigint) from public;

-- Un texto, entre comillas y con las comillas dobladas. Si empieza como una fórmula de hoja de cálculo
-- (=, +, -, @, tabulador o retorno), se neutraliza con un apóstrofo: un nombre lo escribe una persona.
create function private.csv_text(p_text text) returns text
language sql immutable set search_path = ''
as $$
  select '"' || pg_catalog.replace(
           case when pg_catalog.left(coalesce(p_text, ''), 1) in ('=', '+', '-', '@', pg_catalog.chr(9), pg_catalog.chr(13))
                then '''' || p_text else coalesce(p_text, '') end,
           '"', '""') || '"'
$$;
revoke all on function private.csv_text(text) from public;

-- ---------------------------------------------------------------------------------------
-- La exportación del cierre.

create table private.close_exports (
  close_run_id uuid primary key references public.close_runs (id),
  period_id public.period_id not null references public.payout_periods (period_id),
  format_version integer not null,
  minimum_payout_cents bigint,                -- PAGO_MINIMO del periodo al cerrar; nulo si no estaba
  content text not null,                      -- UTF-8
  sha256 bytea not null,
  row_count integer not null,
  created_at timestamptz not null default now(),
  constraint close_exports_hash check (sha256 = pg_catalog.sha256(pg_catalog.convert_to(content, 'UTF8'))),
  constraint close_exports_rows check (row_count >= 0)
);
comment on table private.close_exports is 'El CSV de cada cierre, con su huella (RF-509). Lo escribe el cierre en su transacción. Solo inserción (T-605).';
alter table private.close_exports enable row level security;
revoke all on private.close_exports from public, anon, authenticated, service_role, app_service;
create trigger ledger_no_update_delete before update or delete on private.close_exports
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.close_exports
  for each statement execute function private.reject_mutation();

-- El CSV de una corrida del cierre, desde lo que congeló: un renglón por maestro con total, en el orden de
-- su identificador. El nombre es el publicado, como está ahora: al cerrar, el disparador lo deja con
-- candado hasta confirmar. «Debajo» compara el total y el bono propuesto contra el mínimo que se le da: es
-- un estimado, porque liberar suma bonos confirmados, ajustes y saldo. Con la misma regla que liberar: un
-- total de 0 o menos también queda debajo.
create function private.close_export_csv(p_run uuid, p_minimum bigint) returns text
language sql stable set search_path = ''
as $$
  select pg_catalog.chr(65279)
         || 'periodo,maestro_id,maestro,reparto,sin_consumo,total,bono_fundador_propuesto,debajo_de_pago_minimo' || E'\r\n'
         || coalesce(pg_catalog.string_agg(
              pg_catalog.concat_ws(',',
                (r.period_id / 100)::text || '-' || pg_catalog.lpad((r.period_id % 100)::text, 2, '0'),
                t.teacher_id::text,
                private.csv_text(pt.display_name),
                private.csv_money(t.assigned_cents),
                private.csv_money(t.unconsumed_cents),
                private.csv_money(t.total_cents),
                private.csv_money(t.founder_bonus_cents),
                case when p_minimum is null then ''
                     when t.total_cents + t.founder_bonus_cents < p_minimum or t.total_cents + t.founder_bonus_cents <= 0 then 'sí'
                     else 'no' end) || E'\r\n',
              '' order by t.teacher_id), '')
  from public.close_runs r
  join public.close_run_teacher_totals t on t.close_run_id = r.id
  left join public.published_teachers pt on pt.teacher_id = t.teacher_id
  where r.id = p_run
$$;
revoke all on function private.close_export_csv(uuid, bigint) from public;

-- Al pasar de en cierre a cerrado con la corrida de un cierre del periodo, en la misma transacción. Un
-- paso forzado a mano (las pruebas, con los guardianes apagados) no trae esa corrida y no exporta: la
-- comprobación al confirmar lo rechaza.
create function private.write_close_export() returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_minimum bigint;
  v_content text;
begin
  if not exists (select 1 from public.close_runs r
                 where r.id = new.close_run_id and r.period_id = new.period_id and r.kind = 'close') then
    return null;
  end if;
  -- Los nombres, como están al cerrar: nadie los cambia hasta confirmar.
  perform 1 from public.published_teachers pt
  where pt.teacher_id in (select t.teacher_id from public.close_run_teacher_totals t where t.close_run_id = new.close_run_id)
  order by pt.teacher_id
  for share;
  v_minimum := private.minimum_payout(new.period_id);
  v_content := private.close_export_csv(new.close_run_id, v_minimum);
  insert into private.close_exports (close_run_id, period_id, format_version, minimum_payout_cents, content, sha256, row_count)
  values (new.close_run_id, new.period_id, 1, v_minimum, v_content,
          pg_catalog.sha256(pg_catalog.convert_to(v_content, 'UTF8')),
          (select pg_catalog.count(*) from public.close_run_teacher_totals t where t.close_run_id = new.close_run_id));
  return null;
end
$$;
revoke all on function private.write_close_export() from public;

create trigger write_close_export after update of status on public.payout_periods
  for each row when (old.status = 'closing' and new.status = 'closed')
  execute function private.write_close_export();

-- La comprobación al confirmar suma la exportación: existe, es de este cierre, su huella es la de su
-- contenido, su mínimo es el del periodo, y su contenido es el que vuelve a armar la base.
create function private.assert_close_export(p_period public.period_id) returns void
language plpgsql stable set search_path = ''
as $$
declare
  p public.payout_periods;
  e private.close_exports;
begin
  select * into strict p from public.payout_periods x where x.period_id = p_period;
  select * into e from private.close_exports x where x.close_run_id = p.close_run_id;
  if not found then
    raise exception 'period %: the close has no export', p_period using errcode = '23514';
  end if;
  if e.period_id is distinct from p_period or e.format_version is distinct from 1 then
    raise exception 'period %: the export is not this close''s', p_period using errcode = '23514';
  end if;
  if e.sha256 is distinct from pg_catalog.sha256(pg_catalog.convert_to(e.content, 'UTF8')) then
    raise exception 'period %: the export hash does not match its content', p_period using errcode = '23514';
  end if;
  if e.minimum_payout_cents is distinct from private.minimum_payout(p_period) then
    raise exception 'period %: the export minimum is not the period''s', p_period using errcode = '23514';
  end if;
  if e.row_count is distinct from (select pg_catalog.count(*)::integer from public.close_run_teacher_totals t
                                   where t.close_run_id = p.close_run_id) then
    raise exception 'period %: the export rows do not match the close', p_period using errcode = '23514';
  end if;
  if e.content is distinct from private.close_export_csv(p.close_run_id, e.minimum_payout_cents) then
    raise exception 'period %: the export does not match the close', p_period using errcode = '23514';
  end if;
end
$$;
revoke all on function private.assert_close_export(public.period_id) from public;

create or replace function private.check_period_balanced() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_period_balanced(new.period_id);
  perform private.assert_close_export(new.period_id);
  return null;
end
$$;
revoke all on function private.check_period_balanced() from public;

-- Descargar (PA-80): con la puerta de finanzas y el código reciente, y a la auditoría en la misma
-- transacción. La puerta va antes que la búsqueda: sin finanzas no se sabe si una corrida existe.
create function private.close_export_download(p_run uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  e private.close_exports;
begin
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  select * into e from private.close_exports x where x.close_run_id = p_run;
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  insert into public.audit_log (actor_id, actor_kind, category, action, entity_table, entity_id, reason, request_id)
  values (private.actor_id(), 'user', 'money', 'close_exports.download', 'private.close_exports', e.close_run_id::text,
          nullif(pg_catalog.current_setting('app.reason', true), ''),
          nullif(pg_catalog.current_setting('app.request_id', true), ''));
  return pg_catalog.jsonb_build_object(
    'outcome', 'ok', 'period_id', e.period_id,
    'filename', 'cierre-' || (e.period_id / 100)::text || '-' || pg_catalog.lpad((e.period_id % 100)::text, 2, '0') || '.csv',
    'rows', e.row_count, 'format_version', e.format_version, 'content', e.content, 'sha256', pg_catalog.encode(e.sha256, 'hex'));
end
$$;
revoke all on function private.close_export_download(uuid) from public;
grant execute on function private.close_export_download(uuid) to app_service;

-- ---------------------------------------------------------------------------------------
-- Las lecturas de finanzas (PA-78 a PA-80). Nulas si quien actúa no tiene finanzas; leer no pide el código
-- reciente, y lo dicen (`fresh_code`). Ninguna da el identificador de un alumno ni recalcula: las cifras
-- salen del cierre o del último ensayo, con su fecha.

-- Los maestros de una corrida, con su nombre publicado, en orden de nombre.
create function private.finance_run_teachers(p_run uuid, p_minimum bigint) returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'teacher_id', t.teacher_id, 'name', pt.display_name, 'assigned_cents', t.assigned_cents,
           'unconsumed_cents', t.unconsumed_cents, 'total_cents', t.total_cents, 'founder_bonus_cents', t.founder_bonus_cents,
           'estimate_cents', coalesce((e ->> 'estimate_cents')::bigint, t.total_cents + t.founder_bonus_cents),
           'below_minimum', case when e is not null then (e ->> 'below_minimum')::boolean
                                 when p_minimum is not null then t.total_cents + t.founder_bonus_cents < p_minimum
                                                                 or t.total_cents + t.founder_bonus_cents <= 0 end)
         order by pt.display_name collate "C", t.teacher_id), '[]'::jsonb)
  from public.close_run_teacher_totals t
  join public.close_runs r on r.id = t.close_run_id
  left join public.published_teachers pt on pt.teacher_id = t.teacher_id
  left join lateral (select x.value from pg_catalog.jsonb_array_elements(r.payout_preview) x
                     where x.value ->> 'teacher_id' = t.teacher_id::text limit 1) as pv (e) on true
  where t.close_run_id = p_run
$$;
revoke all on function private.finance_run_teachers(uuid, bigint) from public;

-- PA-78: todos los periodos, el más reciente primero.
create function private.finance_periods() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.actor_id() is null or not private.actor_has_capability('finance') then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.finance_change_gate() is null,
    'periods', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'period_id', p.period_id, 'status', p.status, 'starts_at', p.starts_at, 'ends_at', p.ends_at,
               'active_students', case when p.status in ('closed', 'paid') then p.active_students else r.active_students end,
               'pool_bps', case when p.status in ('closed', 'paid') then p.pool_bps else r.pool_bps end,
               'pool_cents', case when p.status in ('closed', 'paid') then p.pool_cents else r.pool_cents end,
               'unconsumed_cents', case when p.status in ('closed', 'paid') then p.unconsumed_cents else r.unconsumed_cents end,
               'rehearsed_at', case when p.status in ('closed', 'paid') then null else r.started_at end,
               'payouts', pg_catalog.jsonb_build_object(
                 'total', (select pg_catalog.count(*) from public.payouts y where y.period_id = p.period_id),
                 'paid', (select pg_catalog.count(*) from public.payouts y where y.period_id = p.period_id and y.status = 'paid')))
             order by p.period_id desc)
      from public.payout_periods p
      left join lateral (select c.* from public.close_runs c
                         where c.period_id = p.period_id and c.kind = 'rehearsal' and c.status = 'succeeded'
                         order by c.started_at desc limit 1) r on true), '[]'::jsonb));
end
$$;
revoke all on function private.finance_periods() from public;
grant execute on function private.finance_periods() to app_service;

-- PA-79: el periodo, lo cobrado en él y lo asignado a él, el último ensayo o el cierre, las alertas sin
-- revisar, la última consolidación y el último pedido de recálculo.
create function private.finance_period(p_period public.period_id) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.payout_periods;
begin
  if private.actor_id() is null or not private.actor_has_capability('finance') then
    return null;
  end if;
  select * into p from public.payout_periods x where x.period_id = p_period;
  if not found then
    return pg_catalog.jsonb_build_object('fresh_code', private.finance_change_gate() is null, 'period', null);
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.finance_change_gate() is null,
    'period', pg_catalog.jsonb_build_object(
      'period_id', p.period_id, 'status', p.status, 'starts_at', p.starts_at, 'ends_at', p.ends_at,
      'entered_closing_at', p.entered_closing_at, 'active_students', p.active_students, 'pool_bps', p.pool_bps,
      'carried_in_cents', p.carried_in_cents, 'closed_at', p.closed_at, 'payouts_released_at', p.payouts_released_at,
      'paid_at', p.paid_at),
    'collected', (select pg_catalog.jsonb_build_object(
                    'charges', pg_catalog.count(*), 'gross_mxn_cents', coalesce(pg_catalog.sum(c.gross_mxn_cents), 0),
                    'revenue_net_mxn_cents', coalesce(pg_catalog.sum(c.revenue_net_mxn_cents), 0))
                  from public.charges c where c.period_id = p_period),
    'assigned', (select pg_catalog.jsonb_build_object('students', pg_catalog.count(*), 'base_cents', coalesce(pg_catalog.sum(s.base_cents), 0))
                 from private.close_input_students(p_period) s),
    'close', case when p.status in ('closed', 'paid') then pg_catalog.jsonb_build_object(
               'run_id', p.close_run_id, 'net_revenue_cents', p.net_revenue_cents, 'pool_cents', p.pool_cents,
               'assigned_cents', p.assigned_cents, 'unconsumed_cents', p.unconsumed_cents, 'carried_out_cents', p.carried_out_cents) end,
    'rehearsal', (select pg_catalog.jsonb_build_object(
                    'run_id', r.id, 'at', r.started_at, 'period_status_at_run', r.period_status_at_run,
                    'active_students', r.active_students, 'pool_bps', r.pool_bps, 'net_revenue_cents', r.net_revenue_cents,
                    'pool_cents', r.pool_cents, 'assigned_cents', r.assigned_cents, 'unconsumed_cents', r.unconsumed_cents,
                    'carried_out_cents', r.carried_out_cents)
                  from public.close_runs r
                  where r.period_id = p_period and r.kind = 'rehearsal' and r.status = 'succeeded'
                  order by r.started_at desc limit 1),
    'open_alerts', (select pg_catalog.count(*) from public.anomaly_alerts a where a.period_id = p_period and a.status = 'open'),
    'last_rollup', (select pg_catalog.jsonb_build_object('status', j.status, 'mode', j.details ->> 'mode', 'started_at', j.started_at,
                                                         'finished_at', j.finished_at)
                    from public.job_runs j where j.job = 'nightly_rollup' and j.period_id = p_period
                    order by j.started_at desc limit 1),
    'last_good_rollup', (select pg_catalog.jsonb_build_object('mode', j.details ->> 'mode', 'started_at', j.started_at,
                                                              'finished_at', j.finished_at)
                         from public.job_runs j where j.job = 'nightly_rollup' and j.period_id = p_period and j.status = 'succeeded'
                         order by j.started_at desc limit 1),
    'rollup_request', (select pg_catalog.jsonb_build_object('status', q.status, 'requested_at', q.requested_at,
                                                            'started_at', q.started_at, 'finished_at', q.finished_at)
                       from private.rollup_requests q where q.period_id = p_period
                       order by q.requested_at desc limit 1));
end
$$;
revoke all on function private.finance_period(public.period_id) from public;
grant execute on function private.finance_period(public.period_id) to app_service;

-- PA-80: el último ensayo (bien o fallido, sin el texto del error) con su tabla por maestro; lo que se sabe
-- sin calcular de lo que falta para cerrar (lo que manda es la respuesta de `close_period`); y, cerrado,
-- quién cerró, con qué cifras y su exportación.
create function private.finance_close(p_period public.period_id) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.payout_periods;
  r public.close_runs;
  c public.close_runs;
  e private.close_exports;
begin
  if private.actor_id() is null or not private.actor_has_capability('finance') then
    return null;
  end if;
  select * into p from public.payout_periods x where x.period_id = p_period;
  if not found then
    return pg_catalog.jsonb_build_object('fresh_code', private.finance_change_gate() is null, 'period', null);
  end if;
  select * into r from public.close_runs x where x.period_id = p_period and x.kind = 'rehearsal' order by x.started_at desc limit 1;
  if p.status in ('closed', 'paid') then
    select * into c from public.close_runs x where x.id = p.close_run_id;
    select * into e from private.close_exports x where x.close_run_id = p.close_run_id;
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.finance_change_gate() is null,
    'period', pg_catalog.jsonb_build_object('period_id', p.period_id, 'status', p.status, 'ends_at', p.ends_at,
                                            'entered_closing_at', p.entered_closing_at),
    'checks', pg_catalog.jsonb_build_object(
      'open_alerts', (select pg_catalog.count(*) from public.anomaly_alerts a where a.period_id = p_period and a.status = 'open'),
      'final_rehearsal', exists (select 1 from public.close_runs x where x.period_id = p_period and x.kind = 'rehearsal'
                                 and x.status = 'succeeded' and x.period_status_at_run = 'closing'),
      'last_rollup', (select j.status from public.job_runs j where j.job = 'nightly_rollup' and j.period_id = p_period
                      order by j.started_at desc limit 1),
      'rollup_marks', exists (select 1 from private.rollup_dirty d where d.period_id = p_period)),
    'rehearsal', case when r.id is not null then pg_catalog.jsonb_build_object(
                   'run_id', r.id, 'at', r.started_at, 'status', r.status, 'period_status_at_run', r.period_status_at_run,
                   'pool_bps', r.pool_bps, 'active_students', r.active_students, 'net_revenue_cents', r.net_revenue_cents,
                   'pool_cents', r.pool_cents, 'assigned_cents', r.assigned_cents, 'unconsumed_cents', r.unconsumed_cents,
                   'carried_in_cents', r.carried_in_cents, 'carried_out_cents', r.carried_out_cents,
                   'teachers', private.finance_run_teachers(r.id, null)) end,
    'close', case when c.id is not null then pg_catalog.jsonb_build_object(
               'run_id', c.id, 'at', p.closed_at,
               'closed_by', (select f.display_name from public.profiles f where f.id = p.closed_by),
               'pool_bps', c.pool_bps, 'active_students', c.active_students, 'net_revenue_cents', c.net_revenue_cents,
               'pool_cents', c.pool_cents, 'assigned_cents', c.assigned_cents, 'unconsumed_cents', c.unconsumed_cents,
               'carried_out_cents', c.carried_out_cents,
               'export', case when e.close_run_id is not null then pg_catalog.jsonb_build_object(
                           'rows', e.row_count, 'sha256', pg_catalog.encode(e.sha256, 'hex'), 'created_at', e.created_at) end,
               'teachers', private.finance_run_teachers(c.id, e.minimum_payout_cents)) end);
end
$$;
revoke all on function private.finance_close(public.period_id) from public;
grant execute on function private.finance_close(public.period_id) to app_service;

-- ---------------------------------------------------------------------------------------
-- El pedido de recálculo (RF-408).

create table private.rollup_requests (
  id uuid primary key default gen_random_uuid(),
  period_id public.period_id not null references public.payout_periods (period_id),
  requested_by uuid not null,                 -- sin clave al perfil, como la auditoría
  requested_at timestamptz not null default now(),
  status text not null default 'pending',
  started_at timestamptz,
  finished_at timestamptz,
  job_run_id uuid references public.job_runs (id),
  error text,
  constraint rollup_requests_status_known check (status in ('pending', 'running', 'succeeded', 'failed')),
  constraint rollup_requests_started check ((status = 'pending') = (started_at is null)),
  constraint rollup_requests_finished check ((status in ('succeeded', 'failed')) = (finished_at is not null))
);
comment on table private.rollup_requests is 'Los recálculos pedidos desde PA-79 (RF-408). Uno pendiente o corriendo por periodo. Los corre run_rollup_requests (T-605).';
create unique index rollup_requests_one_open_uq on private.rollup_requests (period_id) where status in ('pending', 'running');
alter table private.rollup_requests enable row level security;
revoke all on private.rollup_requests from public, anon, authenticated, service_role, app_service;
-- Pedir queda en la auditoría; lo que el corredor cambia después no (lo hace el sistema, sin persona).
create trigger audit_changes after insert on private.rollup_requests
  for each row execute function private.audit_row_change('money');

-- Pedir: con la puerta de finanzas, de un periodo abierto o en cierre que la consolidación todavía recorre.
create function private.request_rollup(p_period public.period_id) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_gate text;
  v_id uuid;
begin
  v_gate := private.finance_change_gate();
  if v_gate is not null then
    return pg_catalog.jsonb_build_object('outcome', v_gate);
  end if;
  if p_period is null then
    return '{"outcome": "malformed"}'::jsonb;
  end if;
  if not exists (select 1 from public.payout_periods p where p.period_id = p_period and p.status in ('open', 'closing'))
     or not p_period = any (array(select private.rollup_window())) then
    return '{"outcome": "not_rollable"}'::jsonb;
  end if;
  insert into private.rollup_requests (period_id, requested_by) values (p_period, private.actor_id())
  on conflict (period_id) where status in ('pending', 'running') do nothing
  returning id into v_id;
  if v_id is null then
    -- El que chocó, o, si terminó en este instante, el último del periodo.
    select q.id into v_id from private.rollup_requests q where q.period_id = p_period
    order by (q.status in ('pending', 'running')) desc, q.requested_at desc limit 1;
    return pg_catalog.jsonb_build_object('outcome', 'already_requested', 'request_id', v_id);
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'requested', 'request_id', v_id);
end
$$;
revoke all on function private.request_rollup(public.period_id) from public;
grant execute on function private.request_rollup(public.period_id) to app_service;

-- La pausa antes de la consolidación de cada noche (`pg_cron`, `0 9 * * *` en UTC): un recálculo completo
-- tarda minutos, y si a las 09:00 todavía tiene la corrida de su periodo, la de la noche lo salta y ese
-- periodo no pasa a en cierre esa noche. De las 08:00 a las 09:00 UTC el corredor no empieza nada (la de la
-- noche, mientras corre, también lo detiene). `51_panel_del_periodo` exige el horario de la noche.
create function private.rollup_requests_paused(p_at timestamptz) returns boolean
language sql immutable set search_path = ''
as $$ select pg_catalog.date_part('hour', p_at at time zone 'UTC') = 8 $$;
revoke all on function private.rollup_requests_paused(timestamptz) from public;

-- Correr el pedido más viejo, uno a la vez: `nightly_rollup(true, periodo)`. Como ella, es un procedimiento
-- con `commit` y sin `SET` ni `security definer` (Postgres no los deja juntos), que pone su `search_path`
-- con `set_config` y lo devuelve. Uno a la vez de verdad: un candado consultivo de la sesión, que sobrevive
-- a los `commit`; si otro corredor lo tiene, no hace nada. Tampoco empieza si hay una consolidación viva o
-- en la pausa de antes de la noche. Su corrida es la completa del periodo que se abrió después de marcarlo
-- corriendo; si no hay una terminada (otra corrida del periodo tenía el lugar), el pedido vuelve a
-- pendiente. Si el periodo se cerró mientras tanto, el pedido falla (`closed`): no recalculó nada. Uno que
-- se quedó corriendo sin consolidación viva (la conexión se cayó, o la corrida lanzó) se da por fallido a
-- los 15 minutos (`abandoned`).
create procedure private.run_rollup_requests()
language plpgsql
as $$
declare
  v_path text := pg_catalog.current_setting('search_path');
  v_lock bigint := pg_catalog.hashtextextended('rollup_requests', 0);
  v_id uuid;
  v_period integer;
  v_started timestamptz;
  v_run_id uuid;
  v_run_status public.run_status;
  v_run_error text;
begin
  perform pg_catalog.set_config('search_path', '', false);
  if not pg_catalog.pg_try_advisory_lock(v_lock) then
    perform pg_catalog.set_config('search_path', v_path, false);
    return;
  end if;
  update private.rollup_requests q
  set status = 'failed', finished_at = pg_catalog.clock_timestamp(), error = 'abandoned'
  where q.status = 'running' and q.started_at < pg_catalog.clock_timestamp() - interval '15 minutes'
    and not exists (select 1 from public.job_runs j
                    where j.job = 'nightly_rollup' and j.period_id = q.period_id and j.status = 'running'
                      and j.heartbeat_at >= pg_catalog.clock_timestamp() - interval '15 minutes');
  commit;

  if not private.rollup_requests_paused(pg_catalog.clock_timestamp())
     and not exists (select 1 from private.rollup_requests q where q.status = 'running')
     and not exists (select 1 from public.job_runs j
                     where j.job = 'nightly_rollup' and j.status = 'running'
                       and j.heartbeat_at >= pg_catalog.clock_timestamp() - interval '15 minutes') then
    select q.id, q.period_id into v_id, v_period
    from private.rollup_requests q where q.status = 'pending'
    order by q.requested_at, q.id limit 1;
  end if;
  if v_id is null then
    commit;
    perform pg_catalog.pg_advisory_unlock(v_lock);
    perform pg_catalog.set_config('search_path', v_path, false);
    return;
  end if;
  v_started := pg_catalog.clock_timestamp();
  if not v_period = any (array(select private.rollup_window())) then
    update private.rollup_requests q set status = 'failed', started_at = v_started, finished_at = v_started, error = 'not_rollable'
    where q.id = v_id;
    commit;
    perform pg_catalog.pg_advisory_unlock(v_lock);
    perform pg_catalog.set_config('search_path', v_path, false);
    return;
  end if;
  update private.rollup_requests q set status = 'running', started_at = v_started where q.id = v_id;
  commit;

  call private.nightly_rollup(true, v_period);

  select j.id, j.status, j.error into v_run_id, v_run_status, v_run_error
  from public.job_runs j
  where j.job = 'nightly_rollup' and j.period_id = v_period and j.started_at >= v_started
    and j.details ->> 'mode' = 'full' and j.status <> 'running'
  order by j.started_at limit 1;
  if exists (select 1 from public.payout_periods p where p.period_id = v_period and p.status in ('closed', 'paid')) then
    update private.rollup_requests q
    set status = 'failed', finished_at = pg_catalog.clock_timestamp(), job_run_id = v_run_id, error = 'closed'
    where q.id = v_id;
  elsif v_run_id is null then
    update private.rollup_requests q set status = 'pending', started_at = null where q.id = v_id;
  else
    update private.rollup_requests q
    set status = case when v_run_status = 'succeeded' then 'succeeded' else 'failed' end,
        finished_at = pg_catalog.clock_timestamp(), job_run_id = v_run_id, error = v_run_error
    where q.id = v_id;
  end if;
  commit;
  perform pg_catalog.pg_advisory_unlock(v_lock);
  perform pg_catalog.set_config('search_path', v_path, false);
end
$$;
revoke all on procedure private.run_rollup_requests() from public;

select cron.schedule('rollup_requests', '* * * * *', 'call private.run_rollup_requests()');

-- ---------------------------------------------------------------------------------------
-- El vigilante: el área del cierre, con lo nuevo. El servidor ejecuta el ensayo, el cierre, las lecturas
-- de finanzas, la descarga y el pedido (y tiene que poder); nadie más de la aplicación ejecuta nada del
-- área ni toca sus tablas. El corredor de pedidos es un procedimiento con `commit`: no lleva `search_path`
-- fijo (lo pone al correr).
create or replace function private.schema_violations_close()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  close_tables (table_name) as (
    values ('public.close_runs'), ('public.close_run_teacher_totals'), ('public.payout_student_pools'),
           ('public.payout_shares'), ('public.payout_teacher_totals'), ('private.close_exports'), ('private.rollup_requests')),
  close_functions (name, definer, server, pinned) as (
    values ('code_version', false, false, true), ('close_input', false, false, true), ('close_teacher_totals', false, false, true),
           ('guard_close_run', false, false, true), ('require_period_closing', false, false, true),
           ('assert_period_balanced', false, false, true), ('check_period_balanced', true, false, true),
           ('rehearse_close', true, true, true), ('close_period', true, true, true),
           ('csv_money', false, false, true), ('csv_text', false, false, true), ('close_export_csv', false, false, true),
           ('write_close_export', false, false, true), ('assert_close_export', false, false, true),
           ('close_export_download', true, true, true), ('finance_run_teachers', false, false, true),
           ('finance_periods', true, true, true), ('finance_period', true, true, true), ('finance_close', true, true, true),
           ('request_rollup', true, true, true), ('rollup_requests_paused', false, false, true),
           ('run_rollup_requests', false, false, false)),
  found as (
    select f.name, f.definer, f.server, f.pinned, p.oid, p.prosecdef, p.proconfig
    from close_functions f
    join pg_catalog.pg_proc p on p.proname = f.name
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'private'),
  close_triggers (table_name, trigger_name, function_name, deferred) as (
    select t.table_name, x.trigger_name, 'reject_mutation', false
    from (values ('public.close_runs'), ('public.close_run_teacher_totals'), ('public.payout_student_pools'),
                 ('public.payout_shares'), ('public.payout_teacher_totals'), ('private.close_exports')) t (table_name)
    cross join (values ('ledger_no_update_delete'), ('ledger_no_truncate')) x (trigger_name)
    union all
    values ('public.close_runs', 'close_runs_guard', 'guard_close_run', false),
           ('public.close_runs', 'audit_changes', 'audit_row_change', false),
           ('public.payout_student_pools', 'require_period_closing', 'require_period_closing', false),
           ('public.payout_shares', 'require_period_closing', 'require_period_closing', false),
           ('public.payout_teacher_totals', 'require_period_closing', 'require_period_closing', false),
           ('public.payout_periods', 'payout_periods_balanced', 'check_period_balanced', true),
           ('public.payout_periods', 'write_close_export', 'write_close_export', false),
           ('private.rollup_requests', 'audit_changes', 'audit_row_change', false))
  select 'close table reachable by ' || r.rolname, t.table_name
  from app_roles r cross join close_tables t
  where pg_catalog.to_regclass(t.table_name) is not null
    and (pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
         or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER'))
  union all
  select 'close function missing', 'private.' || f.name
  from close_functions f
  where not exists (select 1 from found where found.name = f.name)
  union all
  select 'close function executable by ' || r.rolname, found.oid::regprocedure::text
  from app_roles r cross join found
  where pg_catalog.has_function_privilege(r.rolname::name, found.oid, 'EXECUTE')
    and not (found.server and r.rolname = 'app_service')
  union all
  select 'close function not executable by app_service', found.oid::regprocedure::text
  from found
  where found.server and not pg_catalog.has_function_privilege('app_service', found.oid, 'EXECUTE')
  union all
  select 'close function security definer or without fixed search_path', found.oid::regprocedure::text
  from found
  where (found.prosecdef and not found.definer)
     or (found.pinned and not coalesce(found.proconfig, '{}') @> array['search_path=""'])
  union all
  select 'close function not security definer', found.oid::regprocedure::text
  from found
  where found.definer and not found.prosecdef
  union all
  select 'close trigger missing or disabled: ' || g.trigger_name, g.table_name
  from close_triggers g
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    join pg_catalog.pg_proc p on p.oid = tg.tgfoid
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where tg.tgrelid = pg_catalog.to_regclass(g.table_name) and tg.tgname = g.trigger_name and tg.tgenabled in ('O', 'A')
      and n.nspname = 'private' and p.proname = g.function_name)
  union all
  select 'close trigger not deferred: ' || g.trigger_name, g.table_name
  from close_triggers g
  join pg_catalog.pg_trigger tg on tg.tgrelid = pg_catalog.to_regclass(g.table_name) and tg.tgname = g.trigger_name
  where g.deferred and (tg.tgconstraint = 0 or not tg.tgdeferrable or not tg.tginitdeferred)
  union all
  -- Sin su trabajo, los pedidos se quedarían pendientes y el índice único negaría los nuevos.
  select 'close job missing or inactive: rollup_requests', 'cron.job'
  where not exists (select 1 from cron.job j where j.jobname = 'rollup_requests' and j.active
                    and j.schedule = '* * * * *' and j.command = 'call private.run_rollup_requests()')
$$;
revoke all on function private.schema_violations_close() from public;
