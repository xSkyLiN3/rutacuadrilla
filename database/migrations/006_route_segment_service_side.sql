ALTER TABLE route_revision_segment
  ADD COLUMN service_side text NOT NULL DEFAULT 'BOTH',
  ADD CONSTRAINT route_revision_segment_service_side_check
    CHECK (service_side IN ('LEFT', 'RIGHT', 'BOTH'));

ALTER TABLE route_revision_segment
  ALTER COLUMN service_side DROP DEFAULT;

COMMENT ON COLUMN route_revision_segment.service_side IS
  'Lado atendido por esta revisión: LEFT/RIGHT respecto al orden de coordenadas de cada línea del segmento; BOTH atiende ambos lados. No expresa orientación geográfica.';
