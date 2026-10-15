-- T-107, segunda solicitud · «En uso» (FL-58 E1, RF-709). Esquema §6.2.
-- Una práctica o un nivel que usa un curso no se desactiva. Cuenta todo curso que no esté
-- retirado: en revisión, publicado o con cambios pendientes (FL-58 E1 dice «algún curso
-- usa»; y un curso en revisión no debe quedarse con su práctica desactivada, porque hasta
-- T-402 no hay con qué reasignarlo). Los borradores cuentan desde T-402.
--
-- Sin carrera con publicar: desactivar mira dentro del candado de su lista, que es el mismo
-- que toman cargar y aprobar (primero prácticas, después niveles, después el curso). Todo
-- camino que liste un curso o le cambie la práctica o el nivel tiene que tomar esos mismos
-- candados y comprobar que estén activas.

-- Cuántos cursos sin retirar usan esa práctica o ese nivel.
create function private.catalog_in_use(p_list public.catalog_list, p_id uuid) returns integer
language sql stable set search_path = ''
as $$
  select pg_catalog.count(*)::integer
  from public.published_courses c
  join public.course_registry r on r.course_id = c.course_id
  where r.state <> 'withdrawn'
    and case p_list when 'practices' then c.practice_id = p_id else c.level_id = p_id end
$$;

-- Desactivar se niega con `in_use` (después de `unchanged`: una que ya está inactiva sigue
-- contestando eso). El resto, igual que en T-106.
create or replace function private.catalog_set_active(p_list public.catalog_list, p_id uuid, p_active boolean) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_gate text;
  v_table text := private.catalog_table(p_list);
  v_active boolean;
begin
  perform private.catalog_lock(p_list);
  v_gate := private.content_change_gate();
  if v_gate is not null then
    return v_gate;
  end if;
  if v_table is null or p_active is null then
    return 'invalid';
  end if;
  execute pg_catalog.format('select is_active from public.%I where id = $1 for no key update', v_table) into v_active using p_id;
  if v_active is null then
    return 'not_found';
  end if;
  if v_active = p_active then
    return 'unchanged';
  end if;
  if not p_active and private.catalog_in_use(p_list, p_id) > 0 then
    return 'in_use';
  end if;
  execute pg_catalog.format('update public.%I set is_active = $2 where id = $1', v_table) using p_id, p_active;
  return case when p_active then 'reactivated' else 'deactivated' end;
end
$$;

-- Las dos listas para PA-67, ahora con cuántos cursos usan cada fila.
create or replace function private.catalog_lists() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.actor_id() is null or not private.actor_has_capability('content') then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'fresh_code', private.content_change_gate() is null,
    'practices', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', p.id, 'slug', p.slug, 'name', p.name, 'position', p.position,
               'is_active', p.is_active, 'cover_tone', p.cover_tone,
               'in_use', private.catalog_in_use('practices', p.id)) order by p.position)
      from public.practices p), '[]'::jsonb),
    'levels', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', l.id, 'slug', l.slug, 'name', l.name, 'position', l.position,
               'is_active', l.is_active,
               'in_use', private.catalog_in_use('levels', l.id)) order by l.position)
      from public.levels l), '[]'::jsonb));
end
$$;
