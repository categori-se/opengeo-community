BEGIN;

ALTER TYPE app.basemap_connection_provider ADD VALUE IF NOT EXISTS 'carto';

COMMENT ON TYPE app.basemap_connection_provider IS
  'Browser-visible basemap providers whose customer-owned API keys are stored through reusable OpenGeo connections.';

COMMIT;
