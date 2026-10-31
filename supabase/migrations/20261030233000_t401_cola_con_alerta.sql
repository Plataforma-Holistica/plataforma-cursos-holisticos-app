-- T-401 · La cola de las suspensiones por fraude dice de qué alerta sale cada propuesta: PA-68 la pinta en su alerta,
-- y quien la propuso la retira desde ahí. Lo demás, como en t401_aviso_y_firmas.

create or replace function private.fraud_suspension_queue() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_actor uuid := private.actor_id();
begin
  if v_actor is null or not (private.actor_has_capability('content') or private.actor_has_capability('finance')) then
    return null;
  end if;
  return pg_catalog.jsonb_build_object('requests', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'request_id', r.id,
             'alert_id', r.anomaly_alert_id,
             'teacher_id', r.teacher_id,
             'display_name', p.display_name,
             'teacher_status', t.status,
             'reason', r.reason,
             'proposed_at', r.proposed_at,
             'proposed_by_self', r.proposed_by = v_actor,
             'marked_by_self', coalesce(a.fraud_marked_by, a.reviewed_by) is not distinct from v_actor,
             'about_self', t.profile_id is not distinct from v_actor,
             'alert_period', a.period_id,
             'alert_metric', a.metric_value,
             'alert_threshold', a.threshold_value)
           order by r.proposed_at, r.id)
    from private.teacher_suspension_requests r
    join public.teachers t on t.id = r.teacher_id
    left join public.published_teachers p on p.teacher_id = r.teacher_id
    join public.anomaly_alerts a on a.id = r.anomaly_alert_id
    where r.status = 'pending'), '[]'::jsonb));
end
$$;
