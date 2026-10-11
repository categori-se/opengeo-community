\set ON_ERROR_STOP on
\getenv connector_password OPEN_GEO_CONNECTOR_PASSWORD

\if :{?connector_password}
  ALTER ROLE opengeo_connector PASSWORD :'connector_password';
\else
  \echo 'OPEN_GEO_CONNECTOR_PASSWORD is required' >&2
  \quit 1
\endif
