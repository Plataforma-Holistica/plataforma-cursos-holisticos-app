-- T-103 · Parámetros de negocio con vigencia (RF-707).
-- Esquema de backend §5.5 (tablas), §6.2 (valor vigente), §6.4 y §6.5 (privilegios y
-- políticas), §7.2 y §7.3 (guardianes), §7.4 (auditoría) y §16.2 (definiciones).
--
-- Aquí van las definiciones: qué parámetros existen, de qué tipo y si afectan al reparto.
-- Los valores no: se cargan de supabase/seeds/, que sale de 00-fundamentos.md §4.
-- Los tramos del bote (pool_tiers) y los periodos llegan en T-601.

-- ---------------------------------------------------------------------------------------
-- Tablas (5.5)

create table public.parameter_definitions (
  key text primary key,
  description text not null,
  value_type text not null,
  unit text,
  group_name text not null,
  affects_payout boolean not null default false,   -- un cambio suyo entra al empezar un periodo
  created_at timestamptz not null default now(),
  constraint parameter_definitions_key_format check (key ~ '^[A-Z][A-Z0-9_]*$'),
  constraint parameter_definitions_type_known
    check (value_type in ('integer', 'bps', 'cents', 'decimal', 'text', 'boolean', 'json')),
  constraint parameter_definitions_group_known
    check (group_name in ('pricing', 'pool', 'measurement', 'payout', 'operation', 'product'))
);

create table public.business_parameters (
  id uuid primary key default gen_random_uuid(),
  key text not null references public.parameter_definitions (key),
  value jsonb not null,
  status public.parameter_status not null,    -- el estado de 00-fundamentos.md
  effective_from timestamptz not null,
  effective_period_id public.period_id,       -- obligatorio si afecta al reparto (RF-707)
  previous_value jsonb,                       -- lo llena la base al insertar
  reason text,
  changed_by uuid references public.profiles (id),   -- lo llena la base; nulo si fue el sistema
  changed_at timestamptz not null default now(),
  announced_at timestamptz,                   -- aviso a los maestros (CO-16)
  canceled_at timestamptz,                    -- un cambio programado se puede cancelar antes de regir
  canceled_by uuid references public.profiles (id),
  constraint business_parameters_version_uq unique (key, effective_from),
  constraint business_parameters_cancel_consistent check ((canceled_at is null) = (canceled_by is null))
);
comment on table public.business_parameters is 'Un renglón por valor de un parámetro, con su vigencia (RF-707). Un valor no se edita: se agrega otro.';
-- Valor vigente de un parámetro en una fecha: private.parameter_value().
create index business_parameters_current_idx
  on public.business_parameters (key, effective_from desc) where canceled_at is null;

-- ---------------------------------------------------------------------------------------
-- Valor vigente (6.2)

-- Valor vigente de un parámetro en un instante (RF-707).
create function private.parameter_value(p_key text, p_at timestamptz default now()) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select b.value from public.business_parameters b
  where b.key = p_key and b.effective_from <= p_at and b.canceled_at is null
  order by b.effective_from desc
  limit 1
$$;

grant execute on function private.parameter_value(text, timestamptz) to app_service;

-- ---------------------------------------------------------------------------------------
-- Seguridad por fila y privilegios (6.4)

alter table public.parameter_definitions enable row level security;
alter table public.business_parameters enable row level security;

grant select on public.parameter_definitions, public.business_parameters to authenticated;

-- El servidor inserta valores nuevos; de uno existente solo cambia la cancelación y el aviso.
grant select, insert on public.parameter_definitions, public.business_parameters to app_service;
grant update (canceled_at, canceled_by, announced_at) on public.business_parameters to app_service;

-- ---------------------------------------------------------------------------------------
-- Políticas (6.5): leen configuración y finanzas, siempre con segundo factor.

create policy parameter_definitions_config_select on public.parameter_definitions
  for select to authenticated
  using ((select private.has_capability('config'::public.capability)));
create policy parameter_definitions_finance_select on public.parameter_definitions
  for select to authenticated
  using ((select private.has_capability('finance'::public.capability)));
create policy parameter_definitions_require_aal2 on public.parameter_definitions
  as restrictive for all to authenticated
  using ((select private.is_aal2()));

create policy business_parameters_config_select on public.business_parameters
  for select to authenticated
  using ((select private.has_capability('config'::public.capability)));
create policy business_parameters_finance_select on public.business_parameters
  for select to authenticated
  using ((select private.has_capability('finance'::public.capability)));
create policy business_parameters_require_aal2 on public.business_parameters
  as restrictive for all to authenticated
  using ((select private.is_aal2()));

-- ---------------------------------------------------------------------------------------
-- Guardianes (7.2, 7.3)

-- Solo quien tiene configuración, o un trabajo del sistema, cambia un parámetro. El servidor
-- ya lo comprobó; esto es para que una ruta que lo olvide no pueda escribir.
create function private.guard_config_actor() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.actor_is_system() and not private.actor_has_capability('config') then
    raise exception '%.%: the config capability is required', tg_table_schema, tg_table_name
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- Un valor nuevo: del tipo de su definición, con su periodo si afecta al reparto, y con su
-- autor y su valor anterior escritos por la base, no por quien llama.
create function private.guard_parameter_change() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_type text;
  v_affects boolean;
  v_kind text := jsonb_typeof(new.value);
  v_text text := new.value #>> '{}';
  v_valid boolean;
begin
  select d.value_type, d.affects_payout into v_type, v_affects
  from public.parameter_definitions d where d.key = new.key;
  if not found then
    return new;   -- la clave foránea lo rechaza con su propio error
  end if;

  -- Enteros, centavos y puntos base van como número; un decimal va como texto, para no
  -- perder precisión.
  v_valid := case v_type
    when 'integer' then v_kind = 'number' and v_text ~ '^-?[0-9]+$'
    when 'cents' then v_kind = 'number' and v_text ~ '^[0-9]+$'
    when 'bps' then v_kind = 'number' and v_text ~ '^[0-9]+$' and v_text::numeric <= 10000
    when 'decimal' then v_kind = 'string' and v_text ~ '^[0-9]+(\.[0-9]+)?$'
    when 'text' then v_kind = 'string' and length(v_text) > 0
    when 'boolean' then v_kind = 'boolean'
    when 'json' then v_kind in ('object', 'array')
    else false
  end;
  if not v_valid then
    raise exception 'parameter %: the value is not a valid %', new.key, v_type
      using errcode = '23514';
  end if;

  -- Un cambio que afecta al reparto entra al empezar un periodo (RF-707). Que ese periodo
  -- no haya empezado se comprueba en T-601, cuando existan los periodos.
  if v_affects and new.effective_period_id is null then
    raise exception 'parameter %: a payout parameter needs effective_period_id (RF-707)', new.key
      using errcode = '23514';
  end if;

  new.changed_by := private.actor_id();
  new.changed_at := now();
  new.previous_value := private.parameter_value(new.key, new.effective_from);
  return new;
end
$$;

-- Los disparadores "before" de una tabla corren en orden alfabético: primero quién, después qué.
create trigger business_parameters_actor before insert or update on public.business_parameters
  for each row execute function private.guard_config_actor();
create trigger business_parameters_effective before insert on public.business_parameters
  for each row execute function private.guard_parameter_change();
create trigger business_parameters_guard before update or delete on public.business_parameters
  for each row execute function private.allow_only_columns('canceled_at', 'canceled_by', 'announced_at');

-- ---------------------------------------------------------------------------------------
-- Auditoría (7.4): cambiar un parámetro deja rastro.

create trigger audit_changes after insert or update or delete on public.business_parameters
  for each row execute function private.audit_row_change('config');

-- ---------------------------------------------------------------------------------------
-- Definiciones (16.2). Una fila por parámetro de 00-fundamentos.md §4.
-- No tienen fila, a propósito: PUNTOS_MEDIO, PUNTOS_COMPLETO y TOPE_PUNTOS (son la regla
-- del dominio), BOTE_TRAMOS (vive en pool_tiers) y RETENCIONES_FISCALES (withholding_rules).

insert into public.parameter_definitions (key, description, value_type, unit, group_name, affects_payout) values
  ('PRECIO_MENSUAL', 'Precio del plan mensual', 'cents', 'MXN', 'pricing', false),
  ('PRECIO_ANUAL', 'Precio del plan anual', 'cents', 'MXN', 'pricing', false),
  ('PRECIO_USD', 'Precio mensual en dólares', 'cents', 'USD', 'pricing', false),
  ('PRECIO_EUR', 'Precio mensual en euros', 'cents', 'EUR', 'pricing', false),
  ('MODELO_COBRO', 'Modelo de cobro', 'text', null, 'pricing', false),
  ('PRUEBA_GRATIS', 'Prueba gratis o curso abierto', 'text', null, 'pricing', false),
  ('IVA_EN_PRECIO', 'Si el precio incluye IVA', 'boolean', null, 'pricing', true),
  ('IVA_PCT', 'Tasa de IVA', 'bps', null, 'pricing', true),
  ('GRACIA_COBRO_DIAS', 'Días de acceso tras un cobro fallido', 'integer', 'días', 'pricing', false),
  ('VENTANA_REEMBOLSO_DIAS', 'Días para reembolsar desde el primer cobro', 'integer', 'días', 'pricing', false),
  ('AVISO_RENOVACION_DIAS', 'Días de aviso antes de renovar', 'integer', 'días', 'pricing', false),
  ('EDAD_MINIMA', 'Edad mínima para tener cuenta', 'integer', 'años', 'pricing', false),
  ('BOTE_PCT_BASE', 'Porcentaje base del bote', 'bps', null, 'pool', true),
  ('BOTE_PCT_TECHO', 'Porcentaje máximo del bote', 'bps', null, 'pool', true),
  ('BOTE_REGLA_TRAMO', 'Cómo se aplican los tramos del bote', 'text', null, 'pool', true),
  ('COMISION_COBRO_PCT', 'Comisión fija que se descuenta de cada cobro', 'bps', null, 'pool', true),
  ('RESERVA_PCT', 'Reserva de la Plataforma', 'bps', null, 'pool', false),
  ('AVISO_CAMBIO_REPARTO_DIAS', 'Días de aviso a los maestros antes de un cambio del reparto', 'integer', 'días', 'pool', false),
  ('DOBLE_TARIFA', 'Si se adopta la doble tarifa', 'boolean', null, 'pool', true),
  ('BOTE_SIN_CONSUMO', 'Regla del bote del alumno que no vio nada', 'text', null, 'pool', true),
  ('BASE_COMISION', 'Comisión fija o real', 'text', null, 'pool', true),
  ('INGRESO_POR_PERIODO', 'Regla de asignación de un cobro a periodos', 'text', null, 'pool', true),
  ('DURACION_LECCION', 'Duración de una lección', 'integer', 'segundos', 'measurement', true),
  ('TOLERANCIA_LECCION', 'Rango admitido de duración', 'json', 'segundos', 'measurement', false),
  ('LATIDO_SEGUNDOS', 'Cada cuánto manda un latido el reproductor', 'integer', 'segundos', 'measurement', false),
  ('UMBRAL_MEDIO_PCT', 'Porcentaje visto que da medio punto', 'bps', null, 'measurement', true),
  ('UMBRAL_COMPLETO_PCT', 'Porcentaje visto que da el punto completo', 'bps', null, 'measurement', true),
  ('VELOCIDAD_MAX', 'Velocidad máxima que cuenta', 'decimal', null, 'measurement', true),
  ('SESIONES_SIMULTANEAS', 'Reproducciones simultáneas por cuenta', 'integer', null, 'measurement', false),
  ('RETENCION_LATIDOS', 'Cuánto se conserva el latido crudo', 'integer', 'días', 'measurement', false),
  ('ZONA_HORARIA_PERIODO', 'Zona horaria de los periodos', 'text', null, 'measurement', true),
  ('ALERTA_SALTO_MAESTRO_PCT', 'Salto de puntos de un maestro que dispara alerta', 'bps', null, 'measurement', false),
  ('ALERTA_SIN_CONSUMO_PCT', 'Proporción de bote sin consumo que dispara alerta', 'bps', null, 'measurement', false),
  ('DIA_CIERRE', 'Día del mes en que se cierra', 'integer', null, 'payout', false),
  ('DIA_PAGO', 'Día límite de pago a maestros', 'integer', null, 'payout', false),
  ('PAGO_MINIMO', 'Pago mínimo a un maestro', 'cents', 'MXN', 'payout', true),
  ('FUNDADOR_MULTIPLICADOR', 'Ventaja del maestro fundador y su duración', 'json', null, 'payout', true),
  ('BONOS_PRESUPUESTO_PCT', 'Presupuesto de bonos', 'json', null, 'payout', false),
  ('UMBRAL_DISPERSION_API', 'Maestros a partir de los cuales conviene dispersar por API', 'integer', null, 'payout', false),
  ('LICENCIA_ANIOS', 'Vigencia de la licencia de un curso', 'integer', 'años', 'payout', false),
  ('LIMITE_FACTURA', 'Días hábiles antes de DIA_PAGO para tener las facturas', 'integer', 'días hábiles', 'payout', false),
  ('RESPUESTA_FRAUDE', 'Días hábiles para que un maestro responda a un aviso de fraude', 'integer', 'días hábiles', 'payout', false),
  ('TIPO_CAMBIO', 'Tipo de cambio de referencia', 'decimal', 'MXN por USD', 'operation', false),
  ('META_ANIO_1', 'Meta de alumnos activos del primer año', 'integer', null, 'operation', false),
  ('HORIZONTE_ESCALA', 'Límite de diseño de alumnos activos', 'integer', null, 'operation', false),
  ('UMBRAL_MODERACION', 'Volumen que pide una persona de moderación', 'json', null, 'operation', false),
  ('REPORTES_PARA_OCULTAR', 'Reportes que ocultan un comentario', 'integer', null, 'operation', false),
  ('ARCO_DIAS_HABILES', 'Plazos para atender solicitudes de datos', 'json', 'días hábiles', 'operation', false),
  ('REINCIDENCIA_COMENTARIOS', 'Comentarios ocultos en un periodo que suspenden el derecho a comentar', 'integer', null, 'operation', false),
  ('RESPUESTA_SOPORTE', 'Plazo de la primera respuesta de soporte', 'integer', 'días hábiles', 'operation', false),
  ('COMENTARIOS_ABIERTOS', 'Interruptor que abre los comentarios (RF-804)', 'boolean', null, 'operation', false),
  ('INTENTOS_ANTES_DE_FRENO', 'Intentos fallidos antes de frenar el inicio de sesión', 'integer', null, 'product', false),
  ('VIGENCIA_ENLACE_CONTRASENA', 'Vida del enlace de recuperación', 'integer', 'minutos', 'product', false),
  ('VIGENCIA_INVITACION_DIAS', 'Vida de una invitación', 'integer', 'días', 'product', false),
  ('TOLERANCIA_CONCILIACION_PCT', 'Diferencia admitida con el proveedor de video', 'bps', null, 'product', false),
  ('RECURSO_TAMANO_MAX', 'Tamaño máximo de un recurso', 'integer', 'bytes', 'product', false)
on conflict (key) do nothing;
