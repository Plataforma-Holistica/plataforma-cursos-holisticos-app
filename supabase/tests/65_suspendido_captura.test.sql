-- T-409 · Un maestro suspendido, salvo por fraude, captura y cambia sus datos fiscales (decisión de Sergio del 2026-11-01). RF-702 dice que suspenderlo no detiene
-- sus pagos, y sin datos no se le paga; una baja es una suspensión (OP-06), y si su CLABE cierra no tendría cómo corregirla. Con el fraude confirmado sigue en solo lectura.
begin;
\ir _ayuda.psql
select plan(20);

create function pruebas.rosa() returns uuid language sql immutable as $$ select 'a6500000-0000-0000-0000-000000000001'::uuid $$;
create function pruebas.ines() returns uuid language sql immutable as $$ select 'a6500000-0000-0000-0000-000000000002'::uuid $$;
create function pruebas.k1() returns uuid language sql immutable as $$ select 'c6500000-0000-0000-0000-000000000001'::uuid $$;
select pruebas.alta(pruebas.rosa(), 'rosa-65@prueba.test'), pruebas.alta(pruebas.ines(), 'ines-65@prueba.test'), pruebas.alta(pruebas.k1(), 'k1-65@prueba.test');
select pruebas.confirmar(id) from auth.users where email like '%-65@prueba.test';

create function pruebas.sellado(p_largo integer) returns bytea language sql immutable
as $$ select decode('010001' || repeat('ab', 12 + p_largo + 16), 'hex') $$;
create function pruebas.guarda(p_id uuid, p_teacher uuid, p_vista integer default 0) returns text language plpgsql as $$
declare
  v text;
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.tax_profile_save(p_teacher, p_vista, pruebas.sellado(13), pruebas.sellado(20), '612', 'person', pruebas.sellado(18), '7771', 1);
  perform pruebas.limpiar();
  return v;
end
$$;
create function pruebas.estado(p_id uuid) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform pruebas.a_nombre_de(p_id);
  v := private.tax_profile_state();
  perform pruebas.limpiar();
  return v;
end
$$;
grant execute on all functions in schema pruebas to anon, authenticated, app_service;

select pruebas.como_dueno_sistema();
insert into public.teachers (profile_id, status, suspended_at, suspension_reason) values (pruebas.rosa(), 'suspended', now(), 'baja') returning id as rosa_m \gset
insert into public.teachers (profile_id, status, suspended_at, suspension_reason, suspension_approved_by) values (pruebas.ines(), 'suspended', now(), 'fraude', pruebas.k1()) returning id as ines_m \gset
select pruebas.como_dueno();

select is(pruebas.estado(pruebas.rosa()) ->> 'can_save', 'true', 'la pantalla sabe que una suspendida sin fraude puede guardar');
select is(pruebas.estado(pruebas.ines()) ->> 'can_save', 'false', 'y que una suspendida por fraude no');
select is(pruebas.guarda(pruebas.rosa(), :'rosa_m'), 'saved', 'una suspendida sin fraude captura sus datos');
select is(pruebas.guarda(pruebas.rosa(), :'rosa_m', 1), 'saved', 'y los cambia');
select is(pruebas.guarda(pruebas.rosa(), :'rosa_m', 0), 'changed', 'con la versión vista, como cualquiera');
select is((select max(version)::integer from private.teacher_tax_profiles where teacher_id = :'rosa_m'), 2, 'quedan sus dos versiones');
select is(pruebas.guarda(pruebas.rosa(), :'ines_m'), 'changed', 'no guarda a nombre de otra');
select is(pruebas.guarda(pruebas.ines(), :'ines_m'), 'suspended', 'una suspendida por fraude no captura');
select is((select count(*)::integer from private.teacher_tax_profiles where teacher_id = :'ines_m'), 0, 'y no queda nada');

-- Confirmar el fraude después la detiene.
select pruebas.como_dueno_sistema();
update public.teachers set suspension_approved_by = pruebas.k1() where id = :'rosa_m';
select pruebas.como_dueno();
select is(pruebas.guarda(pruebas.rosa(), :'rosa_m', 2), 'suspended', 'si se confirma el fraude, ya no');
select is(pruebas.estado(pruebas.rosa()) ->> 'can_save', 'false', 'y la pantalla lo sabe');

-- Con la cuenta suspendida, no: la cuenta manda.
select pruebas.como_dueno_sistema();
update public.teachers set suspension_approved_by = null where id = :'rosa_m';
select pruebas.como_dueno();
select pruebas.suspender(pruebas.rosa());
select pruebas.como_dueno();
select is(pruebas.guarda(pruebas.rosa(), :'rosa_m', 2), 'not_teacher', 'con la cuenta suspendida no guarda');

select pruebas.como_dueno_sistema();
update public.profiles set status = 'active', suspended_at = null, suspension_reason = null where id = pruebas.rosa();
select pruebas.como_dueno();

-- Quien ya se fue, o quien solo tiene una invitación con cuenta, no guarda.
select pruebas.como_dueno_sistema();
update public.teachers set status = 'left', left_at = now(), suspended_at = null, suspension_reason = null where id = :'rosa_m';
select pruebas.como_dueno();
select is(pruebas.guarda(pruebas.rosa(), :'rosa_m', 2), 'not_teacher', 'quien ya se fue no guarda');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'invited', left_at = null where id = :'rosa_m';
select pruebas.como_dueno();
select is(pruebas.guarda(pruebas.rosa(), :'rosa_m', 2), 'not_teacher', 'quien solo tiene una invitación, tampoco');

-- Con el camino de verdad: suspender no fija nada, confirmar el fraude la detiene, y levantarla la deja seguir.
select pruebas.como_dueno_sistema();
update public.teachers set status = 'suspended', suspended_at = now(), suspension_reason = 'baja' where id = :'rosa_m';
select pruebas.como_dueno();
select is(pruebas.estado(pruebas.rosa()) ->> 'can_save', 'true', 'una suspensión a mano deja guardar');
select pruebas.como_dueno_sistema();
update public.teachers set suspension_approved_by = pruebas.k1() where id = :'rosa_m';
select pruebas.como_dueno();
select is(pruebas.guarda(pruebas.rosa(), :'rosa_m', 2), 'suspended', 'confirmado el fraude, no');
select pruebas.como_dueno_sistema();
update public.teachers set status = 'active', suspended_at = null, suspension_reason = null, suspension_approved_by = null where id = :'rosa_m';
select pruebas.como_dueno();
select is(pruebas.estado(pruebas.rosa()) ->> 'can_save', 'true', 'levantada, vuelve a poder');
select ok(not (select s from (select pruebas.guarda(pruebas.rosa(), :'rosa_m', 2) = 'suspended' as s) x), 'y no contesta que está suspendida');

-- Guardar a nombre de una suspendida toma su fila, para ir uno tras otro con quien la cambia. La carrera, en la integración 83.
select ok(pg_get_functiondef('private.tax_profile_save(uuid, integer, bytea, bytea, text, text, bytea, text, integer)'::regprocedure) like '%for share of t%', 'toma la fila del maestro');
select is((select count(*)::integer from private.schema_violations_tax()), 0, 'el área fiscal, en orden');

select * from finish();
rollback;
