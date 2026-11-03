-- T-604, tercera solicitud: la factura del maestro, sin pantalla (RF-512, FL-40; plan en `~/.claude/plans/t604-pago-plan.md` y diseño en
-- `~/.claude/plans/t604-factura-diseno.md`). Trae además que nadie apruebe el curso de un maestro cuya invitación es suya (decisión de Sergio
-- del 2026-11-03).

-- ---------------------------------------------------------------------------------------
-- Aprobar: «sobre sí» como las demás funciones, con `actor_owns_teacher`, que cuenta también la invitación al correo propio. Lo demás, como en
-- `t401_fundador_y_suspension`.

create or replace function private.approve_course(p_course uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_state public.course_state;
  v_teacher uuid;
  v_practice uuid;
  v_level uuid;
begin
  perform private.catalog_lock('practices');
  perform private.catalog_lock('levels');
  perform private.course_lock(p_course);
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;

  select state, teacher_id into v_state, v_teacher from public.course_registry where course_id = p_course for no key update;
  if v_state is null then
    return 'not_found';
  elsif v_state <> 'in_review' then
    return 'not_pending';
  end if;
  if private.actor_owns_teacher(v_teacher) then
    return 'self';
  end if;
  select practice_id, level_id into v_practice, v_level from public.published_courses where course_id = p_course;
  if v_practice is null or v_level is null then
    return 'incomplete';
  end if;
  if not exists (select 1 from public.practices where id = v_practice and is_active) then
    return 'practice_inactive';
  end if;
  if not exists (select 1 from public.levels where id = v_level and is_active) then
    return 'level_inactive';
  end if;
  if exists (
    select 1 from public.published_lessons l join public.video_assets v on v.id = l.video_asset_id
    where l.course_id = p_course and l.is_current and v.status <> 'ready') then
    return 'videos_not_ready';
  end if;

  update public.course_registry set state = 'published', first_published_at = coalesce(first_published_at, now())
  where course_id = p_course;
  update public.published_courses set is_listed = true, published_at = now() where course_id = p_course;
  -- Y la ficha de su maestro, si todavía no estaba listada.
  update public.published_teachers set is_listed = true
  where teacher_id = v_teacher and not is_listed;
  return 'approved';
end
$$;

-- ---------------------------------------------------------------------------------------
-- Las retenciones se redondean al centavo más cercano, como el IVA y como el facturador del maestro (decisión de Sergio del 2026-11-03): con
-- «sin tolerancia» al subir la factura, redondear hacia abajo rechazaría cerca de la mitad de las legítimas. Lo confirma el contador.
-- Redondeado, lo retenido ya no queda siempre debajo de lo retenido exacto: con las dos tasas debajo de la mitad, lo redondeado queda debajo del
-- bruto para todo bruto positivo (a lo más medio centavo de más por cada una), y el neto sigue positivo.

create or replace function private.compute_withholdings(p_subtotal bigint, p_vat numeric, p_income numeric, p_vat_withheld numeric) returns jsonb
language sql immutable set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'vat_cents', v.vat, 'income_tax_withheld_cents', v.income, 'vat_withheld_cents', v.vat_withheld,
    'net_cents', p_subtotal + v.vat - v.income - v.vat_withheld)
  from (select pg_catalog.round(p_subtotal * p_vat)::bigint as vat,
               pg_catalog.round(p_subtotal * p_income)::bigint as income,
               pg_catalog.round(p_subtotal * p_vat_withheld)::bigint as vat_withheld) v
$$;
revoke all on function private.compute_withholdings(bigint, numeric, numeric, numeric) from public;

alter table public.withholding_rules
  drop constraint withholding_rules_something_left,
  add constraint withholding_rules_something_left check (income_tax_withholding_rate + vat_withholding_rate < 0.5);
