-- T-108 · La velocidad mínima del reproductor, para la vida de una dirección firmada
-- (ADR-27): duración de la lección entre la velocidad mínima, más diez minutos, siempre
-- menos de una hora. El diseño fija el menú de velocidades desde 0.75× (03, sección 5);
-- el valor se transcribe de 00-fundamentos.md §4 en la semilla.

insert into public.parameter_definitions (key, description, value_type, unit, group_name, affects_payout) values
  ('VELOCIDAD_MIN', 'Velocidad mínima del reproductor', 'decimal', null, 'measurement', false);
