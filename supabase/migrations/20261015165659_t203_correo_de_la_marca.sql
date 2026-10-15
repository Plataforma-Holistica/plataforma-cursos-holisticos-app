-- T-203 · El correo de la marca de agua, en los hechos de la puerta de medios (RF-305; 03 §5.4;
-- TRD §6.1). El reproductor pinta encima del video el correo de quien lo ve, y lo entrega el
-- servidor junto con el permiso.
--
-- Sale de `auth.users`, en la misma lectura que decide y firma: es la misma foto, y cuando
-- exista el cambio de correo (T-310) la marca dirá el de ahora, no el del token de la sesión.
-- Solo de quien actúa (`private.actor_id()`), nunca de otro. La forma de la respuesta crece en
-- `viewer.email`; nada más cambia, y los permisos se quedan como estaban (`create or replace`
-- los conserva): solo el servidor la ejecuta.
--
-- Forma de `viewer` desde aquí: {suspended, email_verified, teacher_id, email}.

create or replace function private.media_facts(p_lesson uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
  v_viewer jsonb;
  v_subscription jsonb;
  v_courtesy jsonb;
  v_lesson jsonb;
begin
  if v_actor is null then
    return null;
  end if;

  select pg_catalog.jsonb_build_object(
           'suspended', p.status <> 'active',
           'email_verified', coalesce(u.email_confirmed_at is not null, false),
           'teacher_id', (select t.id from public.teachers t
                          where t.profile_id = v_actor and t.status in ('active', 'suspended')),
           'email', u.email)
    into v_viewer
  from public.profiles p
  left join auth.users u on u.id = p.id
  where p.id = v_actor;
  if v_viewer is null then
    return null;
  end if;

  select pg_catalog.jsonb_build_object(
           'paid_through', s.current_period_end,
           'failed_at', s.last_renewal_failed_at,
           'ended_at', s.ended_at,
           'refunded', s.status = 'refunded',
           'grace_days', case when s.last_renewal_failed_at is not null
                              then private.parameter_value('GRACIA_COBRO_DIAS', s.last_renewal_failed_at) end)
    into v_subscription
  from public.subscriptions s
  where s.profile_id = v_actor and s.status <> 'pending'
  order by s.status in ('active', 'in_grace') desc, s.created_at desc, s.id desc
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('from', g.starts_at, 'until', g.ends_at)
                                       order by g.starts_at, g.id), '[]'::jsonb)
    into v_courtesy
  from public.courtesy_grants g
  where g.profile_id = v_actor and g.revoked_at is null;

  select pg_catalog.jsonb_build_object(
           'is_current', l.is_current,
           'provider', v.provider,
           'ready', v.status = 'ready',
           'duration_seconds', l.duration_seconds,
           'teacher_id', l.teacher_id,
           'course_state', r.state,
           'listed', c.is_listed,
           'is_open', r.is_open)
    into v_lesson
  from public.published_lessons l
  join public.published_courses c on c.course_id = l.course_id
  join public.course_registry r on r.course_id = l.course_id
  join public.video_assets v on v.id = l.video_asset_id
  where l.id = p_lesson;

  return pg_catalog.jsonb_build_object(
    'now', pg_catalog.now(),
    'viewer', v_viewer,
    'subscription', v_subscription,
    'courtesy', v_courtesy,
    'lesson', v_lesson);
end
$$;
