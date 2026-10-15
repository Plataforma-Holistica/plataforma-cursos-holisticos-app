-- T-108 · La cola de revisión (PA-61 y PA-62 mínimas; FL-45; RF-701). Decisiones de Sergio del
-- 2026-10-14: una sola pantalla en administración, reproducir sin código reciente y aprobar
-- con él (`private.approve_course()`, que existe desde T-107).
--
-- Lo que la pantalla lee es una sola función, como `private.catalog_lists()` y
-- `private.team_roster()`: nula para quien no pasa la puerta de Contenido, así «no pasas» y
-- «no hay cursos» no se confunden. Dice además si el código de quien mira es reciente, que
-- es lo que decide si se ofrece aprobar.
--
-- Nunca devuelve el playback id ni el asset id del proveedor: el video sale solo por la
-- función única de medios (`getMediaGrant`), que lee la lección como la persona.

create function private.review_queue() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.actor_id() is null or not private.actor_has_capability('content') then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.content_change_gate() is null,
    'courses', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'course_id', c.course_id,
               'title', c.title,
               'teacher_name', c.teacher_name,
               'teacher_listed', coalesce(t.is_listed, false),
               'practice', p.name,
               'level', l.name,
               'lesson_count', c.lesson_count,
               'total_duration_seconds', c.total_duration_seconds,
               'loaded_at', r.created_at,
               'lessons', coalesce((
                 select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                          'lesson_id', pl.id,
                          'module_id', m.id,
                          'module', m.title,
                          'title', pl.title,
                          'duration_seconds', pl.duration_seconds,
                          -- Un mapa cerrado: lo que la pantalla dice de cada video.
                          'video', case
                            when v.provider <> 'mux' then 'test'
                            when v.status = 'ready' then 'playable'
                            when v.status = 'errored' then 'errored'
                            else 'processing'
                          end) order by pl.position)
                 from public.published_lessons pl
                 join public.published_modules m on m.id = pl.module_id
                 join public.video_assets v on v.id = pl.video_asset_id
                 where pl.course_id = c.course_id and pl.is_current and m.is_current), '[]'::jsonb))
             order by r.created_at, c.course_id)
      from public.course_registry r
      join public.published_courses c on c.course_id = r.course_id
      left join public.published_teachers t on t.teacher_id = r.teacher_id
      left join public.practices p on p.id = c.practice_id
      left join public.levels l on l.id = c.level_id
      where r.state = 'in_review'), '[]'::jsonb));
end
$$;

revoke all on function private.review_queue() from public;
grant execute on function private.review_queue() to app_service;
