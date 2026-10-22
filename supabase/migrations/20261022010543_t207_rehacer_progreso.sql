-- T-207 · Rehacer el progreso que falló (RF-307; 05 §5.7 y §13). Decisión de Sergio del
-- 2026-10-20: si el progreso falla al registrar un lote, el libro se guarda igual, el par queda en
-- `private.progress_rebuilds` (T-206) y el progreso se rehace después desde `watch_events`.
--
-- Cada hora, `pg_cron` llama a `private.rebuild_progress()`, que recorre esa tabla (casi siempre
-- vacía) y rehace cada par con `private.rebuild_pair()`: bajo el candado de la cuenta, vuelve a
-- fundir en `lesson_progress` cada reproducción del par con lo que el libro tiene de ella, con la
-- misma `private.merge_progress()` del latido. Así se reusa la regla entera (lo de un video que la
-- lección ya no tiene no cuenta, los tramos se unen, la posición solo avanza con lo más nuevo y
-- terminada no se desmarca), y rehacer dos veces da lo mismo.
--
-- Exacto en los tramos, la posición y la terminada; aproximado en las horas. El libro no guarda el
-- tope de cada lote, así que el de una reproducción se toma como el último que pudo tener: el menor
-- entre su último lote recibido, su cierre y su último latido más una ventana. Con eso lo de una
-- reproducción vieja no pasa por más nuevo que lo que ya se guardó de otra; y la primera vez que se
-- vio, si el lote que falló era el primero, queda en la hora del último lote de esa reproducción.
--
-- Pendiente para T-601: purgar una partición rehace antes el progreso que falta (o se niega si
-- queda alguno): las reproducciones y sus tramos son lo único que dice de qué video era cada tramo.

comment on table private.progress_rebuilds is 'Pares cuyo progreso falló al registrar un lote (T-206). Los escribe private.record_heartbeats(); private.rebuild_progress() los rehace cada hora desde el libro (T-207).';

insert into public.job_definitions (job, description, schedule, expected_every, alert_after) values
  ('progress_rebuild', 'Rehacer el progreso que falló', '30 * * * *', interval '1 hour', interval '3 hours');

-- ---------------------------------------------------------------------------------------
-- Las corridas, también de este trabajo: el modo `rebuild`, y las marcas fuera de la ventana
-- solo en las de la consolidación.

create or replace function private.open_job_run(p_job text, p_period public.period_id, p_mode text) returns uuid
language plpgsql volatile set search_path = ''
as $$
declare
  v_run uuid;
begin
  if p_mode not in ('dirty', 'full', 'rebuild') then
    raise exception 'unknown mode %', p_mode using errcode = '22023';
  end if;
  update public.job_runs j
  set status = 'failed', finished_at = pg_catalog.clock_timestamp(), error = 'stale'
  where j.job = p_job and j.status = 'running' and j.heartbeat_at < pg_catalog.clock_timestamp() - interval '15 minutes';
  begin
    insert into public.job_runs (job, period_id, started_at, heartbeat_at, details)
    values (p_job, p_period, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
            pg_catalog.jsonb_build_object('mode', p_mode))
    returning id into v_run;
  exception when unique_violation then
    return null;
  end;
  return v_run;
end
$$;

create or replace function private.close_job_run(p_run uuid, p_error text) returns void
language sql volatile set search_path = ''
as $$
  update public.job_runs j
  set status = case when p_error is null and coalesce((j.details ->> 'pairs_failed')::integer, 0) = 0 then 'succeeded'
                    else 'failed' end::public.run_status,
      finished_at = pg_catalog.clock_timestamp(),
      error = pg_catalog.left(coalesce(p_error, case when coalesce((j.details ->> 'pairs_failed')::integer, 0) > 0
        then 'pairs failed: ' || (j.details ->> 'pairs_failed') || ' (' || (j.details ->> 'first_failure') || ')' end), 300),
      details = j.details || case when j.job = 'nightly_rollup' then pg_catalog.jsonb_build_object('marks_outside_window',
        (select pg_catalog.count(*) from private.rollup_dirty d
         where d.period_id <> all (array(select private.rollup_window())))) else '{}'::jsonb end
  where j.id = p_run and j.status = 'running'
$$;

-- ---------------------------------------------------------------------------------------
-- Rehacer un par. `p_failed_at` es la hora de la falla que leyó la corrida: la anotación se borra
-- solo si sigue siendo esa (una falla posterior la cambió, y se rehace en la corrida siguiente).
--
-- Contesta:
--   {outcome: 'rebuilt'}            rehecho; la anotación se borró si no cambió
--   {outcome: 'busy'}               la cuenta tiene un lote en curso: se queda para la hora siguiente
--   {outcome: 'gone'}               la cuenta ya no existe: la anotación se borra
--   {outcome: 'failed', code}       volvió a fallar: se queda, con la hora y el código nuevos, y nada
--                                   del par quedó a medias
--
-- Solo las reproducciones que no son la vista previa del dueño (el latido no les deja progreso) y
-- que tienen algo en el libro (una sin nada no movería nada), en el orden de su tope: como llegaron,
-- y así, si fallaron todas, la terminada lleva la hora de la que la terminó. Sus tramos, de los
-- periodos que pudo tocar: del mes en que empezó al de su último latido más una ventana (el libro
-- va por mes, y así cada partición se lee por su clave).

create function private.rebuild_pair(p_profile uuid, p_lesson uuid, p_failed_at timestamptz) returns jsonb
language plpgsql volatile set search_path = ''
as $$
declare
  v_zone text;
  v_window interval;
  v_item record;
begin
  -- Cada reproducción se lee en una sentencia posterior al candado: tiene que ver lo confirmado.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'private.rebuild_pair() needs read committed isolation' using errcode = '25000';
  end if;
  -- El candado de la cuenta, el del latido: mientras se rehace no entra ningún lote suyo. No se
  -- espera: un lote en curso suelta el candado en milisegundos, y la corrida siguiente lo retoma.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('playback:' || p_profile::text, 0)) then
    return '{"outcome": "busy"}'::jsonb;
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_profile) then
    delete from private.progress_rebuilds r where r.profile_id = p_profile and r.lesson_id = p_lesson;
    return '{"outcome": "gone"}'::jsonb;
  end if;

  begin
    v_zone := private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}';
    if v_zone is null then
      raise exception 'ZONA_HORARIA_PERIODO is not set' using errcode = 'P0001';
    end if;
    v_window := pg_catalog.make_interval(secs => 3 * (private.playback_limits()).heartbeat_seconds);
    for v_item in
      select s as playback, e.spans, e.last_seq, e.last_to,
             least(e.last_received, s.revoked_at, s.last_heartbeat_at + v_window) as top
      from public.playback_sessions s
      cross join lateral (
        -- Lo que sirve se funde; la posición es el final del último consecutivo, sirva o no.
        select pg_catalog.range_agg(pg_catalog.int4range(w.from_second, w.to_second)) filter (where w.qualifies) as spans,
               pg_catalog.max(w.seq) as last_seq,
               (pg_catalog.array_agg(w.to_second order by w.seq desc))[1] as last_to,
               pg_catalog.max(w.received_at) as last_received
        from public.watch_events w
        where w.playback_session_id = s.id
          and w.period_id = any (array(
            select pg_catalog.to_char(m, 'YYYYMM')::integer
            from pg_catalog.generate_series(pg_catalog.date_trunc('month', pg_catalog.timezone(v_zone, s.started_at)),
                                            pg_catalog.timezone(v_zone, s.last_heartbeat_at + v_window),
                                            interval '1 month') as m))) e
      where s.profile_id = p_profile and s.lesson_id = p_lesson and s.access_basis <> 'owner_preview'
        and e.last_seq is not null
      order by top, s.started_at, s.id
    loop
      perform private.merge_progress(v_item.playback, v_item.spans, v_item.last_seq, v_item.last_to, v_item.top);
    end loop;
  exception when others then
    update private.progress_rebuilds r set failed_at = pg_catalog.clock_timestamp(), code = sqlstate
    where r.profile_id = p_profile and r.lesson_id = p_lesson;
    return pg_catalog.jsonb_build_object('outcome', 'failed', 'code', sqlstate);
  end;

  delete from private.progress_rebuilds r
  where r.profile_id = p_profile and r.lesson_id = p_lesson and r.failed_at = p_failed_at;
  return '{"outcome": "rebuilt"}'::jsonb;
end
$$;
revoke all on function private.rebuild_pair(uuid, uuid, timestamptz) from public;

-- La corrida: cada par anotado antes de que empezara, el más viejo primero, con `commit` después de
-- cada uno (el candado de la cuenta se suelta pronto, y un corte no deshace lo rehecho). Lo que
-- vuelve a fallar se anota con la hora nueva y no se relee en esta corrida. Queda en `job_runs`
-- (trabajo `progress_rebuild`, sin periodo): cuántos pares leyó y cuántos rehízo, y en `details`
-- los ocupados, los de cuentas que ya no existen y los que fallaron (con el código del primero:
-- con alguno, la corrida termina fallida). Un procedimiento sin `security definer` ni
-- `set search_path`, por lo mismo que la consolidación; lo corren el dueño de la base y pg_cron.
create procedure private.rebuild_progress()
language plpgsql
as $$
declare
  v_start timestamptz := pg_catalog.clock_timestamp();
  v_path text := pg_catalog.current_setting('search_path');
  v_run uuid;
  v_pair record;
  v_outcome jsonb;
  v_error text;
begin
  -- De la sesión, como en la consolidación: un ajuste local se iría con el primer `commit`.
  perform pg_catalog.set_config('search_path', '', false);
  v_run := private.open_job_run('progress_rebuild', null, 'rebuild');
  commit;
  if v_run is not null then
    for v_pair in
      select r.profile_id, r.lesson_id, r.failed_at from private.progress_rebuilds r
      where r.failed_at < v_start
      order by r.failed_at, r.profile_id, r.lesson_id
    loop
      begin
        v_outcome := private.rebuild_pair(v_pair.profile_id, v_pair.lesson_id, v_pair.failed_at);
      exception when others then
        v_error := sqlstate || ': ' || pg_catalog.left(sqlerrm, 200);
      end;
      if v_error is null then
        update public.job_runs j
        set heartbeat_at = pg_catalog.clock_timestamp(),
            rows_read = j.rows_read + 1,
            rows_written = j.rows_written + case when v_outcome ->> 'outcome' = 'rebuilt' then 1 else 0 end,
            details = j.details || case v_outcome ->> 'outcome'
              when 'busy' then pg_catalog.jsonb_build_object('pairs_busy', coalesce((j.details ->> 'pairs_busy')::integer, 0) + 1)
              when 'gone' then pg_catalog.jsonb_build_object('pairs_gone', coalesce((j.details ->> 'pairs_gone')::integer, 0) + 1)
              when 'failed' then pg_catalog.jsonb_build_object(
                'pairs_failed', coalesce((j.details ->> 'pairs_failed')::integer, 0) + 1,
                'first_failure', coalesce(j.details ->> 'first_failure', v_outcome ->> 'code'))
              else '{}'::jsonb end
        where j.id = v_run;
      end if;
      commit;
      exit when v_error is not null;
    end loop;
    perform private.close_job_run(v_run, v_error);
    commit;
  end if;
  perform pg_catalog.set_config('search_path', v_path, false);
end
$$;
revoke all on procedure private.rebuild_progress() from public;

-- Cada hora, a la media: lejos de la consolidación (09:00) y de las particiones (09:17).
select cron.schedule('progress_rebuild', '30 * * * *', 'call private.rebuild_progress()');

-- ---------------------------------------------------------------------------------------
-- El vigilante aprende las dos funciones nuevas: no las ejecuta nadie de la aplicación.

create or replace function private.schema_violations()
returns table (problem text, object_name text)
language sql stable security definer set search_path = ''
as $$
  with ledgers (table_schema, table_name) as (
    values
      ('public', 'watch_events'), ('public', 'charges'), ('public', 'charge_reversals'),
      ('public', 'revenue_allocations'), ('public', 'payout_student_pools'), ('public', 'payout_shares'),
      ('public', 'payout_teacher_totals'), ('public', 'payout_status_events'),
      ('public', 'payout_adjustments'), ('public', 'teacher_balance_entries'),
      ('public', 'reserve_entries'), ('public', 'legal_documents'), ('public', 'consents'),
      ('public', 'licenses'), ('public', 'audit_log'), ('private', 'teacher_tax_profiles'),
      ('private', 'student_aliases'), ('private', 'moderation_actions'),
      ('private', 'moderation_case_access_log')),
  app_roles (rolname) as (
    values ('anon'), ('authenticated'), ('service_role'), ('app_service')),
  watch_tables (oid) as (
    select 'public.watch_events'::regclass::oid
    union all
    select i.inhrelid from pg_catalog.pg_inherits i where i.inhparent = 'public.watch_events'::regclass)
  -- Tablas propias sin seguridad por fila (RNF-08).
  select 'table without row level security', n.nspname || '.' || c.relname
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'p') and not c.relrowsecurity
  union all
  -- Funciones security definer sin search_path fijo.
  select 'security definer function without a fixed search_path', n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prosecdef
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%')
  union all
  -- Funciones propias que cualquiera puede ejecutar.
  select 'function executable by PUBLIC', n.nspname || '.' || p.proname
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and pg_catalog.has_function_privilege('public', p.oid, 'execute')
  union all
  -- Escrituras a nivel de tabla para roles de usuario, fuera de la única prevista.
  select 'unexpected write privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  where g.grantee in ('anon', 'authenticated')
    and g.table_schema in ('public', 'private')
    and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    and not (g.grantee = 'authenticated' and g.table_name = 'saved_courses'
             and g.privilege_type in ('INSERT', 'DELETE'))
  union all
  -- Lo mismo, columna por columna, que no sale en la consulta de arriba. La única escritura
  -- por columnas prevista es la de la persona sobre sus propios datos de perfil.
  select distinct 'unexpected column write privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.grantee in ('anon', 'authenticated')
    and g.table_schema in ('public', 'private')
    and g.privilege_type in ('INSERT', 'UPDATE')
    and not (g.grantee = 'authenticated' and g.table_schema = 'public' and g.table_name = 'profiles'
             and g.privilege_type = 'UPDATE'
             and g.column_name in ('display_name', 'country_code', 'country_is_self_declared', 'locale'))
    and not (g.grantee = 'authenticated' and g.table_schema = 'public' and g.table_name = 'saved_courses'
             and g.privilege_type = 'INSERT')
  union all
  -- Del esquema privado, ni una columna, ni para leer.
  select distinct 'unexpected column privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.table_schema = 'private' and g.grantee in ('anon', 'authenticated')
  union all
  -- Nada concedido a todos: PUBLIC incluye al visitante y a cualquier rol que llegue después.
  select distinct 'privilege granted to PUBLIC', g.table_schema || '.' || g.table_name
  from information_schema.column_privileges g
  where g.grantee = 'PUBLIC' and g.table_schema in ('public', 'private')
  union all
  -- La clave secreta no toca tablas propias. Ningún rol de usuario toca el esquema privado.
  select 'unexpected privilege for ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  where (g.grantee = 'service_role' and g.table_schema in ('public', 'private'))
     or (g.grantee in ('anon', 'authenticated') and g.table_schema = 'private')
  union all
  -- Ningún rol de la aplicación puede editar ni borrar un libro.
  select 'ledger writable by ' || g.grantee, g.table_schema || '.' || g.table_name
  from information_schema.role_table_grants g
  join ledgers l on l.table_schema = g.table_schema and l.table_name = g.table_name
  where g.grantee in (select r.rolname from app_roles r)
    and g.privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
  union all
  -- Ni editar una sola de sus columnas: el permiso por columna no sale en la consulta de arriba.
  select 'ledger column writable by ' || r.rolname, l.table_schema || '.' || l.table_name
  from ledgers l
  join pg_catalog.pg_namespace n on n.nspname = l.table_schema
  join pg_catalog.pg_class c on c.relnamespace = n.oid and c.relname = l.table_name
  cross join app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, c.oid, 'UPDATE')
  union all
  -- El libro de latidos y cada partición: solo private.record_heartbeats() escribe, y nadie de
  -- la aplicación lee los latidos crudos (T-205).
  select 'watch ledger reachable by ' || r.rolname, 'public.' || c.relname
  from watch_tables w
  join pg_catalog.pg_class c on c.oid = w.oid
  cross join app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, c.oid, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- El seguro contra vaciar no pasa de la madre a las particiones: cada una lleva el suyo.
  select 'watch partition without truncate guard', 'public.' || c.relname
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.watch_events'::regclass
    and not exists (
      select 1 from pg_catalog.pg_trigger t
      where t.tgrelid = c.oid and t.tgname = 'ledger_no_truncate' and t.tgenabled <> 'D')
  union all
  -- El seguro de editar y borrar sí pasa de la madre, pero se puede apagar en una partición.
  select 'watch partition without update guard', 'public.' || c.relname
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.watch_events'::regclass
    and not exists (
      select 1 from pg_catalog.pg_trigger t
      where t.tgrelid = c.oid and t.tgname = 'ledger_no_update_delete' and t.tgenabled <> 'D')
  union all
  -- Sin partición por omisión: un tramo sin su mes no entra.
  select 'watch default partition', 'public.' || c.relname
  from pg_catalog.pg_inherits i
  join pg_catalog.pg_class c on c.oid = i.inhrelid
  where i.inhparent = 'public.watch_events'::regclass and c.relpartbound is not null
    and pg_catalog.pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
  union all
  -- La partición del mes que sigue ya existe: si pg_cron dejó de correr, se sabe antes de que
  -- los latidos empiecen a fallar.
  select 'watch partition missing for next month', 'public.watch_events_' || m.period
  from (select pg_catalog.to_char(
                 pg_catalog.date_trunc('month', pg_catalog.timezone(
                   coalesce(private.parameter_value('ZONA_HORARIA_PERIODO') #>> '{}', 'UTC'), pg_catalog.now()))
                 + interval '1 month', 'YYYYMM') as period) m
  where pg_catalog.to_regclass('public.watch_events_' || m.period) is null
  union all
  -- Los rechazos solo los escribe private.record_heartbeats() (T-205).
  select 'heartbeat rejections reachable by ' || r.rolname, 'private.heartbeat_rejection_counts'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'private.heartbeat_rejection_counts'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, 'private.heartbeat_rejection_counts'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- La marca de contraseña solo la cambia private.claim_account() (TRD 9.2).
  select 'password_reset_required writable by ' || r.rolname, 'public.profiles'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.profiles'::regclass, 'password_reset_required', 'UPDATE')
  union all
  -- Las capacidades solo se escriben con las funciones que cambian el equipo (T-105).
  select 'admin_capabilities writable by ' || r.rolname, 'public.admin_capabilities'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.admin_capabilities'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.admin_capabilities'::regclass, 'DELETE, TRUNCATE')
  union all
  -- Las invitaciones y las ataduras no las toca ningún rol de la aplicación, ni para leer.
  select 'team table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('private.admin_invitations'), ('private.admin_factors')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Las prácticas y los niveles solo los escriben las funciones de las listas (T-106).
  select 'catalog list writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.practices'), ('public.levels')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Lo publicado y lo que lo sostiene solo lo escriben las funciones de cargar y aprobar
  -- (T-107).
  select 'publication table writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.teachers'), ('public.published_teachers'), ('public.course_registry'),
                     ('public.video_assets'), ('public.published_courses'), ('public.published_modules'),
                     ('public.published_lessons')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Los hechos de la cuenta todavía no los escribe nadie de la aplicación (T-202). La
  -- escritura llega con quien la necesita: las suscripciones con T-302 y T-303, la cortesía
  -- con T-307, y cada una la abre aquí.
  select 'account facts table writable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('public.subscriptions'), ('public.courtesy_grants')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- El orden de desempate de un maestro nunca sale de la base (RN-07).
  select 'teachers.tiebreak_rank readable by ' || r.rolname, 'public.teachers'
  from app_roles r
  where pg_catalog.has_column_privilege(r.rolname::name, 'public.teachers'::regclass, 'tiebreak_rank', 'SELECT')
  union all
  -- Lo que solo corre el dueño de la base, declarado sistema, no lo ejecuta nadie más. Las
  -- particiones de latidos las crea el dueño (la migración y pg_cron).
  select 'system function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.system_catalog_add(public.catalog_list, text)'),
                     ('private.system_add_teacher(text, text, text)'),
                     ('private.system_load_course(uuid, jsonb)'),
                     ('private.catalog_place(public.catalog_list, text)'),
                     ('private.create_watch_partition(public.period_id)'),
                     ('private.ensure_watch_partitions(integer, text)'),
                     ('private.half_points(integer, integer, integer, integer)'),
                     ('private.payout_thresholds(public.period_id)'),
                     ('private.rollup_pair(public.period_id, uuid, uuid, uuid, integer, integer)'),
                     ('private.rollup_window()'),
                     ('private.open_job_run(text, public.period_id, text)'),
                     ('private.close_job_run(uuid, text)'),
                     ('private.rollup_step(uuid, timestamptz, uuid, uuid, integer)'),
                     ('private.nightly_rollup(boolean, integer)'),
                     ('private.rebuild_pair(uuid, uuid, timestamptz)'),
                     ('private.rebuild_progress()')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
  union all
  -- Las reproducciones solo las escriben sus funciones (T-204): abrir, latir y, con T-205, los
  -- latidos con medición.
  select 'playback table writable by ' || r.rolname, 'public.playback_sessions'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.playback_sessions'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.playback_sessions'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- El progreso solo lo escribe private.record_heartbeats() (T-206), y el servidor no lo lee
  -- entero: pregunta dónde se quedó quien actúa con private.lesson_position().
  select 'progress writable by ' || r.rolname, 'public.lesson_progress'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'public.lesson_progress'::regclass, 'INSERT, UPDATE')
     or pg_catalog.has_table_privilege(r.rolname::name, 'public.lesson_progress'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  select 'progress readable by ' || r.rolname, 'public.lesson_progress'
  from app_roles r
  where r.rolname <> 'authenticated'
    and pg_catalog.has_any_column_privilege(r.rolname::name, 'public.lesson_progress'::regclass, 'SELECT')
  union all
  -- La persona lee su avance, no los tramos ni de qué reproducción vino.
  select 'progress spans readable by authenticated', 'public.lesson_progress'
  where pg_catalog.has_column_privilege('authenticated', 'public.lesson_progress'::regclass, 'covered', 'SELECT')
     or pg_catalog.has_column_privilege('authenticated', 'public.lesson_progress'::regclass, 'last_playback_session_id', 'SELECT')
     or pg_catalog.has_column_privilege('authenticated', 'public.lesson_progress'::regclass, 'last_seq', 'SELECT')
  union all
  -- Lo que falta rehacer no lo toca nadie de la aplicación.
  select 'progress rebuilds reachable by ' || r.rolname, 'private.progress_rebuilds'
  from app_roles r
  where pg_catalog.has_any_column_privilege(r.rolname::name, 'private.progress_rebuilds'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, 'private.progress_rebuilds'::regclass, 'DELETE, TRUNCATE, TRIGGER')
  union all
  -- Dónde se quedó alguien lo pregunta solo el servidor, y fundir no lo ejecuta nadie.
  select 'progress function executable by ' || r.rolname, f.signature
  from app_roles r
  cross join (values ('private.lesson_position(uuid)'),
                     ('private.merge_progress(public.playback_sessions, int4multirange, integer, integer, timestamptz)')) as f (signature)
  where pg_catalog.has_function_privilege(r.rolname::name, f.signature::regprocedure, 'EXECUTE')
    and not (r.rolname = 'app_service' and f.signature = 'private.lesson_position(uuid)')
  union all
  -- La consolidación (T-207): las marcas, los días, el consolidado y las corridas no los toca
  -- ningún rol de la aplicación, ni para leer. Los escriben private.record_heartbeats() y la
  -- corrida; los días los leerá la persona cuando haya quien los pinte (T-505), y el
  -- consolidado, el maestro y finanzas por sus funciones (T-408, T-605).
  select 'consolidation table reachable by ' || r.rolname, t.table_name
  from app_roles r
  cross join (values ('private.rollup_dirty'), ('public.practice_days'), ('public.watch_rollup'),
                     ('public.job_definitions'), ('public.job_runs')) as t (table_name)
  where pg_catalog.has_any_column_privilege(r.rolname::name, t.table_name::regclass, 'SELECT, INSERT, UPDATE, REFERENCES')
     or pg_catalog.has_table_privilege(r.rolname::name, t.table_name::regclass, 'DELETE, TRUNCATE, TRIGGER')
$$;
