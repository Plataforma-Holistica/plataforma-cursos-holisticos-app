-- T-601 · La gracia es del reparto (RF-707, RN-13; 05 §5.5). Decisión de Sergio del 2026-10-25, de
-- la revisión del diff de la segunda solicitud de T-601 (`t601_tramos`): `GRACIA_COBRO_DIAS` decide
-- quién cuenta como alumno activo (`private.active_students_at()`), y con varios tramos, el
-- porcentaje del bote del mes. Un cambio suyo a medio mes movía los alumnos activos del mes en curso.
-- Desde aquí es un parámetro del reparto: exige su periodo (`guard_parameter_change`) y rige desde el
-- inicio de un periodo que no ha empezado (`guard_payout_timing`, al confirmar). Solo la sesión del
-- dueño lo escribe a medio mes, como cualquier parámetro del reparto.
--
-- Lo que no cambia: cómo se lee. `private.parameter_value()` no mira la marca, y la regla de acceso
-- (`private.media_facts()`) y los alumnos activos siguen leyendo el valor de la hora de la falla. Lo
-- que cambia para el alumno es que un cambio de gracia le llega el día 1 siguiente.
--
-- Sin el aviso de 30 días a los maestros (`AVISO_CAMBIO_REPARTO_DIAS`, CO-16): la gracia no cambia la
-- regla del reparto, solo quién cuenta. La base no revisa el aviso; lo hará la pantalla (PA-85).

update public.parameter_definitions set affects_payout = true where key = 'GRACIA_COBRO_DIAS';

-- Una base con la semilla ya cargada tiene versiones de la gracia sin periodo, que
-- `private.period_parameter()` no vería. Cada versión viva que empieza justo en el inicio de un periodo
-- se cancela y se vuelve a escribir con su periodo, como el sistema: queda en la auditoría. Una que
-- empiece a medio mes no se adivina. Tras `pnpm db:reset` no hay ninguna: la semilla corre después y
-- ya le pone su periodo. Como la semilla, depende de correr en la sesión del dueño, que RF-707 por
-- instante (`guard_payout_timing`) no revisa: con otro rol que entre y haga `set role`, la versión
-- vigente no se cancela y la migración falla con 23514. La fila nueva no copia `reason` ni
-- `announced_at`, y su autor es el sistema; lo de antes queda en la cancelada y en la auditoría.
-- Probado a mano sobre una base sembrada el 2026-10-25.
do $$
declare
  v record;
begin
  perform pg_catalog.set_config('app.actor_kind', 'system', true);
  for v in
    select b.id, b.value, b.status, b.effective_from, private.period_of(b.effective_from) as period
    from public.business_parameters b
    where b.key = 'GRACIA_COBRO_DIAS' and b.effective_period_id is null and b.canceled_at is null
    order by b.effective_from
  loop
    if v.effective_from <> private.period_start(v.period) then
      raise exception 'GRACIA_COBRO_DIAS version % starts at %, not at the start of a period', v.id, v.effective_from
        using hint = 'decide its period by hand before this migration';
    end if;
    update public.business_parameters set canceled_at = pg_catalog.now() where id = v.id;
    insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
    values ('GRACIA_COBRO_DIAS', v.value, v.status, v.effective_from, v.period);
  end loop;
  perform pg_catalog.set_config('app.actor_kind', '', true);
end
$$;
