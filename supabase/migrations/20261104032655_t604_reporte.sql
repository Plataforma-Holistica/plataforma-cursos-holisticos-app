-- T-604, cuarta solicitud · El reporte del maestro y el alias (RF-504, RF-505, RF-506, RF-610, RN-15; PA-46 y PA-47; diseño en
-- ~/.claude/plans/t604-reporte-diseno.md, con la revisión independiente del diseño y dos decisiones de Sergio del 2026-11-03: por alumno solo el alias y
-- los puntos, porque con los pesos de cada fila el maestro deduce cuánto ve el alumno con otros maestros; y la línea de consumo excluido va con T-607).
--
-- El maestro lee lo suyo por tres funciones, sin decir quién es (`actor_teacher_id`, también suspendido): sus liquidaciones (PA-46), el reporte de un
-- periodo (PA-47) y ese reporte en CSV. Lee lo congelado del cierre. Nunca salen el identificador ni la base de un alumno, los pesos por alumno, el motivo de
-- una retención o de un ajuste, ni nada de otro maestro. El alias se crea al leer, nunca en el cierre.

-- ---------------------------------------------------------------------------------------
-- El alias (RN-15; decisión 5 de Sergio del 2026-11-02: «Ceiba 42»). Uno por alumno y maestro, al azar e independiente por maestro: no sale de ninguna
-- huella del perfil, y el mismo alumno se llama distinto con otro maestro. Sobrevive a la lápida de una cuenta borrada.

create table private.student_aliases (
  teacher_id uuid not null references public.teachers (id),
  profile_id uuid not null references public.profiles (id),
  alias text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (teacher_id, profile_id),
  constraint student_aliases_alias_uq unique (teacher_id, alias),
  constraint student_aliases_alias_form check (alias ~ '^[A-Z][a-z]+ [1-9][0-9]{1,2}$')
);
comment on table private.student_aliases is 'El alias de cada alumno con cada maestro (RN-15). Solo inserción, sin auditoría: la auditoría guarda la fila entera, y la lee quien tiene configuración.';

alter table private.student_aliases enable row level security;
revoke all on private.student_aliases from public, anon, authenticated, service_role, app_service;
create trigger ledger_no_update_delete before update or delete on private.student_aliases
  for each row execute function private.reject_mutation();
create trigger ledger_no_truncate before truncate on private.student_aliases
  for each statement execute function private.reject_mutation();

-- Un alias al azar: una de 40 plantas y árboles de México y un número de 10 a 99; pasados 20 choques, de 100 a 999.
create function private.alias_candidate(p_try integer) returns text
language sql volatile set search_path = ''
as $$
  select (array['Ceiba', 'Encino', 'Ahuehuete', 'Fresno', 'Sabino', 'Mezquite', 'Huizache', 'Nogal', 'Cedro', 'Pino',
                'Oyamel', 'Ocote', 'Roble', 'Parota', 'Guanacaste', 'Amate', 'Tabachin', 'Jacaranda', 'Laurel', 'Olivo',
                'Alamo', 'Sauce', 'Copal', 'Guaje', 'Zapote', 'Mamey', 'Tamarindo', 'Guayabo', 'Capulin', 'Tejocote',
                'Nopal', 'Maguey', 'Agave', 'Yuca', 'Salvia', 'Romero', 'Ruda', 'Toronjil', 'Cempasuchil', 'Dalia'])
           [1 + pg_catalog.floor(pg_catalog.random() * 40)::integer]
         || ' ' || case when p_try < 20 then 10 + pg_catalog.floor(pg_catalog.random() * 90)::integer
                        else 100 + pg_catalog.floor(pg_catalog.random() * 900)::integer end
$$;
revoke all on function private.alias_candidate(integer) from public;

-- Que cada alumno del maestro en el periodo tenga su alias. Bajo el candado del maestro: dos lecturas a la vez no chocan en el único. Si no cabe, falla
-- entero: un alumno sin alias desaparecería del reporte.
create function private.ensure_student_aliases(p_teacher uuid, p_period public.period_id) returns void
language plpgsql set search_path = ''
as $$
declare
  v_profile uuid;
  v_try integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('student_aliases:' || p_teacher::text, 0));
  for v_profile in
    select s.profile_id from public.payout_shares s
    where s.period_id = p_period and s.teacher_id = p_teacher
      and not exists (select 1 from private.student_aliases a where a.teacher_id = p_teacher and a.profile_id = s.profile_id)
  loop
    v_try := 0;
    loop
      insert into private.student_aliases (teacher_id, profile_id, alias)
      values (p_teacher, v_profile, private.alias_candidate(v_try))
      on conflict do nothing;
      exit when found;
      v_try := v_try + 1;
      if v_try >= 200 then
        raise exception 'student alias space exhausted' using errcode = 'P0001';
      end if;
    end loop;
  end loop;
end
$$;
revoke all on function private.ensure_student_aliases(uuid, public.period_id) from public;

-- ---------------------------------------------------------------------------------------
-- Lo que ve el maestro.

-- El estado que ve el maestro: el de la liquidación, salvo retenida. Una investigación y un pago que chocó se ven igual, «en revisión», sin motivo
-- (decisión 4 del plan); por datos fiscales se dice qué falta, o que ya los capturó y falta que finanzas suelte.
create function private.payout_teacher_status(p public.payouts) returns text
language sql stable set search_path = ''
as $$
  select case
    when p.status <> 'on_hold' then p.status::text
    when p.hold_kind <> 'tax_data' then 'in_review'
    when exists (select 1 from private.tax_profile_fiscal(p.teacher_id)) then 'tax_data_review'
    else 'tax_data_missing'
  end
$$;
revoke all on function private.payout_teacher_status(public.payouts) from public;

-- La fila de PA-46. Neto solo en lo que se paga y ya se liberó; la acumulada dice lo que pasa al siguiente, con signo. «Subir factura» también vencida: la
-- factura tardía se sube y se paga.
create function private.payout_mine_row(p_period public.period_id, p public.payouts) returns jsonb
language sql stable set search_path = ''
as $$
  select case when p.id is null then
    pg_catalog.jsonb_build_object('period_id', p_period, 'status', 'empty', 'pool_cents', 0, 'bonuses_cents', 0, 'adjustments_cents', 0,
                                  'balance_applied_cents', 0, 'net_cents', null, 'carried_cents', null, 'invoice_due_on', null, 'overdue', false, 'action', null)
  else
    pg_catalog.jsonb_build_object('period_id', p.period_id, 'status', private.payout_teacher_status(p), 'pool_cents', p.pool_cents,
                                  'bonuses_cents', p.bonuses_cents, 'adjustments_cents', p.adjustments_cents, 'balance_applied_cents', p.balance_applied_cents,
                                  'net_cents', case when p.released_at is not null and p.status <> 'carried_forward' then p.net_cents end,
                                  'carried_cents', case when p.status = 'carried_forward' then p.subtotal_cents end,
                                  'invoice_due_on', p.invoice_due_on, 'overdue', p.invoice_overdue_at is not null,
                                  'action', case when p.status in ('awaiting_invoice', 'invoice_rejected') then 'upload_invoice' end)
  end
$$;
revoke all on function private.payout_mine_row(public.period_id, public.payouts) from public;

-- El primer periodo en que el maestro tuvo un curso publicado, también si después lo retiró. Desde ahí, un mes sin liquidación sale en cero.
create function private.teacher_first_period(p_teacher uuid) returns public.period_id
language sql stable set search_path = ''
as $$
  select case when x.first_at is null then null else private.period_of(x.first_at) end
  from (select pg_catalog.min(r.first_published_at) as first_at from public.course_registry r where r.teacher_id = p_teacher) x
$$;
revoke all on function private.teacher_first_period(uuid) from public;

-- PA-46: los periodos cerrados o pagados con liquidación, más los que van en cero desde el primero publicado; y el saldo acumulado, si hay.
create function private.payouts_mine() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.actor_teacher_id();
  v_first public.period_id;
begin
  if v_teacher is null then
    return '{"outcome": "not_teacher"}'::jsonb;
  end if;
  v_first := private.teacher_first_period(v_teacher);
  return pg_catalog.jsonb_build_object(
    'outcome', 'ok',
    'balance_cents', pg_catalog.nullif(private.teacher_balance(v_teacher), 0),
    'periods', coalesce((
      select pg_catalog.jsonb_agg(private.payout_mine_row(q.period_id, y) order by q.period_id desc)
      from public.payout_periods q
      left join public.payouts y on y.period_id = q.period_id and y.teacher_id = v_teacher
      where q.status in ('closed', 'paid') and (y.id is not null or q.period_id >= v_first)), '[]'::jsonb));
end
$$;
revoke all on function private.payouts_mine() from public;
grant execute on function private.payouts_mine() to app_service;

-- Las filas del reporte: alias y medios puntos, de más a menos, y entre iguales por alias (nunca por el perfil, que es el mismo con todos los maestros).
create function private.payout_report_students(p_teacher uuid, p_period public.period_id) returns jsonb
language sql stable set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('alias', a.alias, 'half_points', s.half_points)
                                       order by s.half_points desc, a.alias), '[]'::jsonb)
  from public.payout_shares s
  left join private.student_aliases a on a.teacher_id = s.teacher_id and a.profile_id = s.profile_id
  where s.period_id = p_period and s.teacher_id = p_teacher
$$;
revoke all on function private.payout_report_students(uuid, public.period_id) from public;

-- PA-47: el reporte de un periodo cerrado o pagado. Las cifras son las de la liquidación; el dinero, solo después de liberar.
create function private.payout_report_mine(p_period public.period_id) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_teacher uuid := private.actor_teacher_id();
  v_period public.payout_periods;
  y public.payouts;
  v_totals public.payout_teacher_totals;
  v_first public.period_id;
begin
  if v_teacher is null then
    return '{"outcome": "not_teacher"}'::jsonb;
  end if;
  select * into v_period from public.payout_periods q where q.period_id = p_period and q.status in ('closed', 'paid');
  if not found then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  select * into y from public.payouts x where x.period_id = p_period and x.teacher_id = v_teacher;
  if not found then
    v_first := private.teacher_first_period(v_teacher);
    if v_first is null or p_period < v_first then
      return '{"outcome": "not_found"}'::jsonb;
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'empty', 'period_id', p_period, 'pool_cents', v_period.pool_cents, 'pool_bps', v_period.pool_bps,
                                         'nothing_assigned', v_period.assigned_cents = 0);
  end if;
  perform private.ensure_student_aliases(v_teacher, p_period);
  select * into v_totals from public.payout_teacher_totals t where t.period_id = p_period and t.teacher_id = v_teacher;
  return pg_catalog.jsonb_build_object(
    'outcome', 'ok',
    'period_id', p_period,
    'status', private.payout_teacher_status(y),
    'released', y.released_at is not null,
    'invoice_due_on', y.invoice_due_on,
    'overdue', y.invoice_overdue_at is not null,
    'summary', pg_catalog.jsonb_build_object(
      'pool_cents', v_period.pool_cents, 'pool_bps', v_period.pool_bps, 'nothing_assigned', v_period.assigned_cents = 0,
      'assigned_cents', coalesce(v_totals.assigned_cents, 0), 'unconsumed_cents', coalesce(v_totals.unconsumed_cents, 0),
      'total_cents', coalesce(v_totals.total_cents, 0), 'half_points', coalesce(v_totals.half_points, 0), 'students', coalesce(v_totals.students, 0)),
    'money', case when y.released_at is not null then pg_catalog.jsonb_build_object(
      'pool_cents', y.pool_cents, 'bonuses_cents', y.bonuses_cents, 'adjustments_cents', y.adjustments_cents,
      'balance_applied_cents', y.balance_applied_cents, 'subtotal_cents', y.subtotal_cents, 'vat_cents', y.vat_cents,
      'income_tax_withheld_cents', y.income_tax_withheld_cents, 'vat_withheld_cents', y.vat_withheld_cents, 'net_cents', y.net_cents,
      'bonuses', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', b.kind, 'amount_cents', b.amount_cents) order by b.created_at, b.id)
                           from public.bonuses b where b.period_id = p_period and b.teacher_id = v_teacher and b.status = 'confirmed'), '[]'::jsonb),
      -- Sin el motivo: es texto interno, y puede venir de un fraude.
      'adjustments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('origin_period_id', j.origin_period_id, 'amount_cents', j.amount_cents)
                                                           order by j.origin_period_id, j.created_at, j.id)
                               from public.payout_adjustments j where j.applied_period_id = p_period and j.teacher_id = v_teacher), '[]'::jsonb)) end,
    'invoice', pg_catalog.jsonb_build_object(
      'receiver_rfc', private.invoice_receiver_rfc(),
      'latest', (select pg_catalog.jsonb_build_object('status', i.status, 'submitted_at', i.submitted_at, 'reviewed_at', i.reviewed_at,
                                                      'rejection_reason', i.rejection_reason)
                 from private.teacher_invoices i
                 where i.payout_id = y.id and i.status in ('in_review', 'accepted', 'rejected')
                 order by i.submitted_at desc, i.id
                 limit 1)),
    -- El pago que vale: vivo, y entre los vivos el que no chocó. El monto es el neto de la liquidación, no lo tecleado.
    'payment', case when y.status = 'paid' then (
      select pg_catalog.jsonb_build_object('paid_on', x.paid_on, 'reference', x.reference, 'amount_cents', y.net_cents)
      from private.payout_payments x
      where x.payout_id = y.id
        and not exists (select 1 from private.payout_requests r where r.payment_id = x.id and r.kind = 'payment_return' and r.status = 'confirmed')
      order by (x.conflict is null) desc, x.recorded_at desc, x.id
      limit 1) end,
    'students', private.payout_report_students(v_teacher, p_period));
end
$$;
revoke all on function private.payout_report_mine(public.period_id) from public;
grant execute on function private.payout_report_mine(public.period_id) to app_service;

-- Medios puntos como puntos: 3 es «1.5».
create function private.csv_half_points(p_half integer) returns text
language sql immutable set search_path = ''
as $$
  select (p_half / 2)::text || case when p_half % 2 = 0 then '' else '.5' end
$$;
revoke all on function private.csv_half_points(integer) from public;

-- El reporte en CSV, de la misma lectura: alias y puntos por fila; el bote sin consumo y el total, en pesos. Con la marca de UTF-8 y CRLF, como el cierre.
create function private.payout_report_csv_mine(p_period public.period_id) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_report jsonb;
  v_crlf text := pg_catalog.chr(13) || pg_catalog.chr(10);
begin
  if private.actor_teacher_id() is null then
    return '{"outcome": "not_teacher"}'::jsonb;
  end if;
  v_report := private.payout_report_mine(p_period);
  if v_report ->> 'outcome' <> 'ok' then
    return '{"outcome": "not_found"}'::jsonb;
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'ok', 'period_id', p_period, 'csv',
    pg_catalog.chr(65279) || '"Alumno","Puntos","Pesos"' || v_crlf
    || coalesce((select pg_catalog.string_agg(private.csv_text(x ->> 'alias') || ',' || private.csv_half_points((x ->> 'half_points')::integer) || ',' || v_crlf,
                                              '' order by n)
                 from pg_catalog.jsonb_array_elements(v_report -> 'students') with ordinality as s (x, n)), '')
    || private.csv_text('Bote sin consumo') || ',,' || private.csv_money((v_report -> 'summary' ->> 'unconsumed_cents')::bigint) || v_crlf
    || private.csv_text('Total') || ',' || private.csv_half_points((v_report -> 'summary' ->> 'half_points')::integer) || ','
    || private.csv_money((v_report -> 'summary' ->> 'total_cents')::bigint) || v_crlf);
end
$$;
revoke all on function private.payout_report_csv_mine(public.period_id) from public;
grant execute on function private.payout_report_csv_mine(public.period_id) to app_service;

-- ---------------------------------------------------------------------------------------
-- El vigilante del reporte (área del carril A): los alias sin permisos, de solo inserción y sin auditoría; las tres puertas del maestro y nada más.

create function private.schema_violations_teacher_reports()
returns table (problem text, object_name text)
language sql stable set search_path = ''
as $$
  with app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  doors (name, signature) as (
    values ('payouts_mine', 'private.payouts_mine()'), ('payout_report_mine', 'private.payout_report_mine(public.period_id)'),
           ('payout_report_csv_mine', 'private.payout_report_csv_mine(public.period_id)')),
  helpers (name, signature) as (
    values ('alias_candidate', 'private.alias_candidate(integer)'), ('ensure_student_aliases', 'private.ensure_student_aliases(uuid, public.period_id)'),
           ('payout_teacher_status', 'private.payout_teacher_status(public.payouts)'),
           ('payout_mine_row', 'private.payout_mine_row(public.period_id, public.payouts)'),
           ('teacher_first_period', 'private.teacher_first_period(uuid)'),
           ('payout_report_students', 'private.payout_report_students(uuid, public.period_id)'),
           ('csv_half_points', 'private.csv_half_points(integer)'))
  select 'student aliases privilege for ' || r.rolname, 'private.student_aliases'
  from app_roles r
  where pg_catalog.has_table_privilege(r.rolname::name, 'private.student_aliases'::regclass, 'select, insert, update, delete, truncate, references, trigger')
     or pg_catalog.has_any_column_privilege(r.rolname::name, 'private.student_aliases'::regclass, 'select, insert, update, references')
  union all
  select 'student aliases without row security', 'private.student_aliases'
  where not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'private.student_aliases'::regclass)
  union all
  select 'student aliases audited', 'private.student_aliases'
  where exists (select 1 from pg_catalog.pg_trigger tg where tg.tgrelid = 'private.student_aliases'::regclass
                  and pg_catalog.pg_get_triggerdef(tg.oid) like '%audit_row_change%')
  union all
  select 'teacher report door missing or wrong: ' || d.name, d.name
  from doors d
  where pg_catalog.to_regprocedure(d.signature) is null
     or not coalesce((select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(d.signature)), false)
     or not coalesce(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(d.signature)) like '%actor_teacher_id()%', false)
     or not pg_catalog.has_function_privilege('app_service', d.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', d.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', d.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', d.signature, 'execute')
  union all
  select 'teacher report helper reachable: ' || h.name, h.name
  from helpers h
  where pg_catalog.to_regprocedure(h.signature) is null
     or (select p.prosecdef from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(h.signature))
     or pg_catalog.has_function_privilege('app_service', h.signature, 'execute')
     or pg_catalog.has_function_privilege('authenticated', h.signature, 'execute')
     or pg_catalog.has_function_privilege('anon', h.signature, 'execute')
     or pg_catalog.has_function_privilege('service_role', h.signature, 'execute')
  union all
  select 'teacher report trigger missing: ' || t.name, 'private.student_aliases'
  from (values ('ledger_no_update_delete'), ('ledger_no_truncate')) t (name)
  where not exists (
    select 1 from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'private.student_aliases'::regclass and tg.tgname = t.name
      and tg.tgenabled in ('O', 'A') and pg_catalog.pg_get_triggerdef(tg.oid) like '%reject_mutation%')
$$;
revoke all on function private.schema_violations_teacher_reports() from public;
