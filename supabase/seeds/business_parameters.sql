-- Valores de arranque de los parámetros de negocio (RF-707).
--
-- Fuente única: ../planeacion/00-fundamentos.md §4, leída el 2026-10-06. Este archivo se
-- transcribe de ahí a mano: si cambia un valor allá, se cambia aquí en el mismo trabajo.
-- En una base que ya corre, un parámetro no se cambia editando este archivo: se inserta un
-- valor nuevo, que es lo que deja rastro.
--
-- Unidades, las de su definición (supabase/migrations/..._t103_parametros.sql):
--   cents    centavos enteros            349 MXN        -> 34900
--   bps      puntos base                 60 %           -> 6000
--   integer  en la unidad que diga       20 minutos     -> 1200 (segundos)
--   decimal  como texto                  18.5           -> "18.5"
--   text     un código corto en inglés
--   json     un objeto con nombres en inglés; sus cantidades siguen las reglas de arriba
--
-- Estado: decided, to_confirm, proposed u open, como en 00-fundamentos.md. Lo que el 00
-- marca como «Ley» va como decided. Las constantes de producto son todas proposed.
--
-- Todos rigen desde el 1 de octubre de 2026 a las 00:00 de la Ciudad de México, y los que
-- afectan al reparto, desde el periodo 202610.

begin;

-- Lo carga el sistema, no una persona: queda así en la auditoría.
select set_config('app.actor_kind', 'system', true);

insert into public.business_parameters (key, value, status, effective_from, effective_period_id)
select v.key, v.value::jsonb, v.status::public.parameter_status,
       timestamptz '2026-10-01 06:00:00+00',
       case when d.affects_payout then 202610 end
from (values
  -- Precio y planes
  ('PRECIO_MENSUAL',            '34900',                'to_confirm'),
  ('PRECIO_ANUAL',              '299000',               'to_confirm'),
  ('PRECIO_USD',                '1900',                 'to_confirm'),
  ('PRECIO_EUR',                '1700',                 'to_confirm'),
  ('MODELO_COBRO',              '"subscription_only"',  'decided'),
  ('PRUEBA_GRATIS',             '"one_open_course"',    'proposed'),
  ('IVA_EN_PRECIO',             'true',                 'decided'),
  ('IVA_PCT',                   '1600',                 'decided'),
  ('GRACIA_COBRO_DIAS',         '7',                    'proposed'),
  ('VENTANA_REEMBOLSO_DIAS',    '7',                    'proposed'),
  ('AVISO_RENOVACION_DIAS',     '5',                    'to_confirm'),
  ('EDAD_MINIMA',               '18',                   'decided'),
  -- Bote
  ('BOTE_PCT_BASE',             '6000',                 'decided'),
  ('BOTE_PCT_TECHO',            '7500',                 'to_confirm'),
  ('BOTE_REGLA_TRAMO',          '"marginal_tiers"',     'proposed'),
  ('COMISION_COBRO_PCT',        '500',                  'to_confirm'),
  ('RESERVA_PCT',               '500',                  'to_confirm'),
  ('AVISO_CAMBIO_REPARTO_DIAS', '30',                   'proposed'),
  ('DOBLE_TARIFA',              'false',                'decided'),
  ('BOTE_SIN_CONSUMO',          '"proportional_to_assigned_pool"', 'proposed'),
  ('BASE_COMISION',             '"fixed_rate"',         'proposed'),
  ('INGRESO_POR_PERIODO',       '"monthly_when_charged_annual_in_twelfths"', 'proposed'),
  -- Medición
  ('DURACION_LECCION',          '1200',                 'decided'),
  ('TOLERANCIA_LECCION',        '{"min_seconds": 900, "max_seconds": 1500}', 'proposed'),
  ('LATIDO_SEGUNDOS',           '30',                   'proposed'),
  ('UMBRAL_MEDIO_PCT',          '2500',                 'decided'),
  ('UMBRAL_COMPLETO_PCT',       '9000',                 'to_confirm'),
  ('VELOCIDAD_MAX',             '"2"',                  'decided'),
  ('SESIONES_SIMULTANEAS',      '2',                    'proposed'),
  ('RETENCION_LATIDOS',         '90',                   'decided'),
  ('ZONA_HORARIA_PERIODO',      '"America/Mexico_City"', 'proposed'),
  ('ALERTA_SALTO_MAESTRO_PCT',  '5000',                 'proposed'),
  ('ALERTA_SIN_CONSUMO_PCT',    '4000',                 'proposed'),
  -- Pago a maestros
  ('DIA_CIERRE',                '1',                    'proposed'),
  ('DIA_PAGO',                  '10',                   'proposed'),
  ('PAGO_MINIMO',               '50000',                'proposed'),
  ('FUNDADOR_MULTIPLICADOR',    '{"multiplier": "1.15", "months": 24}', 'to_confirm'),
  ('BONOS_PRESUPUESTO_PCT',     '{"min_bps": 500, "max_bps": 800}', 'to_confirm'),
  ('UMBRAL_DISPERSION_API',     '15',                   'to_confirm'),
  ('LICENCIA_ANIOS',            '10',                   'decided'),
  ('LIMITE_FACTURA',            '3',                    'proposed'),
  ('RESPUESTA_FRAUDE',          '5',                    'proposed'),
  -- Operación y escala
  ('TIPO_CAMBIO',               '"18.5"',               'to_confirm'),
  ('META_ANIO_1',               '1000',                 'to_confirm'),
  ('HORIZONTE_ESCALA',          '13000',                'decided'),
  ('UMBRAL_MODERACION',         '{"comments_per_day": 30, "active_students": 800}', 'to_confirm'),
  ('REPORTES_PARA_OCULTAR',     '3',                    'proposed'),
  ('ARCO_DIAS_HABILES',         '{"respond": 20, "execute": 15}', 'decided'),
  ('REINCIDENCIA_COMENTARIOS',  '3',                    'proposed'),
  ('RESPUESTA_SOPORTE',         '1',                    'proposed'),
  ('COMENTARIOS_ABIERTOS',      'false',                'proposed'),
  -- Constantes de producto
  ('INTENTOS_ANTES_DE_FRENO',   '5',                    'proposed'),
  ('VIGENCIA_ENLACE_CONTRASENA', '60',                  'proposed'),
  ('VIGENCIA_INVITACION_DIAS',  '7',                    'proposed'),
  ('TOLERANCIA_CONCILIACION_PCT', '500',                'proposed'),
  ('RECURSO_TAMANO_MAX',        '52428800',             'proposed')
) as v (key, value, status)
join public.parameter_definitions d on d.key = v.key
on conflict (key, effective_from) do nothing;

commit;
