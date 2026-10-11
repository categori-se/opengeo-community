\set ON_ERROR_STOP on
\getenv runtime_password OPEN_GEO_RUNTIME_PASSWORD

\if :{?runtime_password}
  ALTER ROLE opengeo_runtime PASSWORD :'runtime_password';
\else
  \echo 'OPEN_GEO_RUNTIME_PASSWORD must be set'
  \quit 1
\endif
