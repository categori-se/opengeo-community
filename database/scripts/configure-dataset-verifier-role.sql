\set ON_ERROR_STOP on
\getenv dataset_verifier_password OPEN_GEO_DATASET_VERIFIER_PASSWORD

\if :{?dataset_verifier_password}
  ALTER ROLE opengeo_dataset_verifier PASSWORD :'dataset_verifier_password';
\else
  \echo 'OPEN_GEO_DATASET_VERIFIER_PASSWORD is required' >&2
  \quit 1
\endif
