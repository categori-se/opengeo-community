\set ON_ERROR_STOP on
\getenv repository_copier_password OPEN_GEO_REPOSITORY_COPIER_PASSWORD

\if :{?repository_copier_password}
  ALTER ROLE opengeo_repository_copier PASSWORD :'repository_copier_password';
\else
  \echo 'OPEN_GEO_REPOSITORY_COPIER_PASSWORD must be set'
  \quit 1
\endif
