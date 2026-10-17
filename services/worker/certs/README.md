The RDS global CA bundle is an immutable build input. Its SHA-256 is
`e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3`
and its length is 165,408 bytes.

It was recovered unchanged from the previously verified worker OCI manifest
`sha256:0bc307dbc25979177a1bfd50bdc4b28f149a5f7ddba45d5d29adfaeddeaa0dda`,
config `sha256:3919b25443ffa4469b94339ec20a22971ba3f5a66563c2c41d0e33a45319a805`,
at `/etc/ssl/certs/aws-rds-global-bundle.pem`. The original source was AWS's
`https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`.
The Dockerfile verifies the preserved checksum in both stages.
