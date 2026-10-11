\set ON_ERROR_STOP on
\getenv coordinator_password OPEN_GEO_OBSERVABLE_COORDINATOR_PASSWORD

\if :{?coordinator_password}
  ALTER ROLE opengeo_observable_coordinator PASSWORD :'coordinator_password';
\else
  \echo 'OPEN_GEO_OBSERVABLE_COORDINATOR_PASSWORD is required' >&2
  \quit 1
\endif
