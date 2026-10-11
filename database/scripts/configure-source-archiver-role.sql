\set ON_ERROR_STOP on
\getenv source_archiver_password OPEN_GEO_SOURCE_ARCHIVER_PASSWORD

\if :{?source_archiver_password}
  ALTER ROLE opengeo_source_archiver PASSWORD :'source_archiver_password';
\else
  \echo 'OPEN_GEO_SOURCE_ARCHIVER_PASSWORD must be set'
  \quit 1
\endif
