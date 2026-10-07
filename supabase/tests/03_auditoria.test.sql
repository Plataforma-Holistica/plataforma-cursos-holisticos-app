-- T-103 · El libro de auditoría (RF-706): no se puede editar ni borrar, con ningún rol,
-- y solo lo lee quien tiene la capacidad de configuración.
begin;
\ir _ayuda.psql
select plan(29);

select pruebas.alta('a0000000-0000-0000-0000-000000000001', 'ana@prueba.test');      -- alumna
select pruebas.alta('c0000000-0000-0000-0000-000000000001', 'config1@prueba.test');  -- configuración
select pruebas.alta('c0000000-0000-0000-0000-000000000002', 'config2@prueba.test');  -- configuración
select pruebas.alta('f0000000-0000-0000-0000-000000000001', 'finanzas@prueba.test'); -- finanzas
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000001', 'config');
select pruebas.dar_capacidad('c0000000-0000-0000-0000-000000000002', 'config');
select pruebas.dar_capacidad('f0000000-0000-0000-0000-000000000001', 'finance');

-- Un cambio hecho por una persona, con motivo y con la liga al registro técnico.
select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001');
select set_config('app.reason', 'Entra al equipo de soporte', true);
select set_config('app.request_id', 'req-prueba-1', true);
insert into public.admin_capabilities (profile_id, capability, granted_by)
values ('a0000000-0000-0000-0000-000000000001', 'support', 'c0000000-0000-0000-0000-000000000001');

select is(
  private.actor_id(), 'c0000000-0000-0000-0000-000000000001'::uuid,
  'por el camino de servicio, el autor es el que declaró el servidor');

select pruebas.como_dueno();
select results_eq(
  $$select actor_id, actor_kind, category::text, action, entity_table, reason, request_id,
           old_value is null, new_value ->> 'capability', new_value ->> 'profile_id'
    from public.audit_log order by id desc limit 1$$,
  $$values ('c0000000-0000-0000-0000-000000000001'::uuid, 'user', 'access',
            'admin_capabilities.insert', 'public.admin_capabilities',
            'Entra al equipo de soporte', 'req-prueba-1',
            true, 'support', 'a0000000-0000-0000-0000-000000000001')$$,
  'el renglón dice quién, qué, sobre qué, con qué valores y por qué');
select ok(
  (select occurred_at = now() from public.audit_log order by id desc limit 1),
  'y cuándo: en la misma transacción que el cambio');
select is(
  (select entity_id from public.audit_log order by id desc limit 1),
  (select id::text from public.admin_capabilities
   where profile_id = 'a0000000-0000-0000-0000-000000000001'),
  'y apunta a la fila que cambió');
select results_eq(
  $$select actor_id is null, actor_kind from public.audit_log order by id asc limit 1$$,
  $$values (true, 'system')$$,
  'un cambio del sistema queda sin persona y marcado como sistema');

-- Sin autor no hay cambio: el registro y el cambio viven o mueren juntos.
select throws_ok(
  $$insert into public.admin_capabilities (profile_id, capability)
    values ('f0000000-0000-0000-0000-000000000001', 'content')$$,
  '42501', null, 'un cambio auditado sin autor declarado se rechaza');

-- Cuántos renglones hay antes de los intentos. Queda en una variable de psql.
select count(*)::int as renglones from public.audit_log \gset

-- ---------------------------------------------------------------------------------------
-- Nadie edita ni borra el libro. Primero el dueño de la tabla, que tiene todos los permisos:
-- lo detiene el disparador.
select throws_ok(
  $$update public.audit_log set reason = 'reescrito'$$,
  '42501', 'append-only ledger public.audit_log: UPDATE is not allowed',
  'el dueño de la tabla no puede actualizar la auditoría');
select throws_ok(
  $$delete from public.audit_log$$,
  '42501', 'append-only ledger public.audit_log: DELETE is not allowed',
  'ni borrarla');
select throws_ok(
  $$truncate public.audit_log$$,
  '42501', 'append-only ledger public.audit_log: TRUNCATE is not allowed',
  'ni vaciarla');

-- El servidor.
select pruebas.como_servicio('c0000000-0000-0000-0000-000000000001');
select throws_ok($$update public.audit_log set reason = 'reescrito'$$, '42501', null,
  'el servidor no puede actualizar la auditoría');
select throws_ok($$delete from public.audit_log$$, '42501', null, 'ni borrarla');
select throws_ok($$truncate public.audit_log$$, '42501', null, 'ni vaciarla');
select throws_ok(
  $$alter table public.audit_log disable trigger ledger_no_update_delete$$,
  '42501', null, 'ni desactivar el disparador que la protege');
select throws_ok(
  $$drop trigger ledger_no_update_delete on public.audit_log$$,
  '42501', null, 'ni quitarlo');

-- Quien tiene configuración, con su sesión.
select pruebas.como_usuario('c0000000-0000-0000-0000-000000000001', 'aal2');
select throws_ok($$update public.audit_log set reason = 'reescrito'$$, '42501', null,
  'configuración no puede actualizar la auditoría');
select throws_ok($$delete from public.audit_log$$, '42501', null, 'ni borrarla');
select throws_ok($$truncate public.audit_log$$, '42501', null, 'ni vaciarla');
select throws_ok(
  $$insert into public.audit_log (actor_kind, category, action, entity_table)
    values ('system', 'config', 'inventado', 'public.nada')$$,
  '42501', null, 'ni escribir renglones a mano');

-- La alumna y el visitante.
select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001', 'aal2');
select throws_ok($$update public.audit_log set reason = 'reescrito'$$, '42501', null,
  'la alumna no puede actualizar la auditoría');
select throws_ok($$delete from public.audit_log$$, '42501', null, 'ni borrarla');
select pruebas.como_visitante();
select throws_ok($$delete from public.audit_log$$, '42501', null, 'el visitante tampoco');

select pruebas.como_dueno();
select is(
  (select count(*)::int from public.audit_log), :renglones,
  'después de todos los intentos, la auditoría tiene los mismos renglones');
select is(
  (select count(*)::int from public.audit_log where reason = 'reescrito'), 0,
  'y ninguno fue reescrito');

-- ---------------------------------------------------------------------------------------
-- Quién la lee: configuración con segundo factor, y nadie más (RF-706).
select pruebas.como_usuario('c0000000-0000-0000-0000-000000000001', 'aal2');
select is(
  (select count(*)::int from public.audit_log), :renglones,
  'configuración con segundo factor lee toda la auditoría');

select pruebas.como_usuario('c0000000-0000-0000-0000-000000000001', 'aal1');
select is((select count(*)::int from public.audit_log), 0, 'sin segundo factor no lee nada');

select pruebas.como_usuario('f0000000-0000-0000-0000-000000000001', 'aal2');
select is((select count(*)::int from public.audit_log), 0, 'finanzas no la lee');

select pruebas.como_usuario('a0000000-0000-0000-0000-000000000001', 'aal2');
select is((select count(*)::int from public.audit_log), 0, 'la alumna no la lee');

select pruebas.como_visitante();
select throws_ok('select count(*) from public.audit_log', '42501', null, 'el visitante no la lee');

-- Los intentos fallidos de arriba no dejaron renglones nuevos.
select pruebas.como_dueno();
select is(
  (select count(*)::int from public.audit_log), :renglones,
  'leer no escribe');

select pruebas.limpiar();
select * from finish();
rollback;
