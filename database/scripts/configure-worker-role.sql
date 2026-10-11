\set ON_ERROR_STOP on
\getenv worker_password OPEN_GEO_WORKER_PASSWORD

\if :{?worker_password}
  ALTER ROLE opengeo_worker PASSWORD :'worker_password';
\else
  \echo 'OPEN_GEO_WORKER_PASSWORD must be set'
  \quit 1
\endif
