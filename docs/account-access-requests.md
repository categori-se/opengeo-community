# Request access to OpenGeo Studio

Choose **Request access** from Studio sign-in and provide your name, email and
intended use. Submission records a pending request. It creates no sign-in
identity, account membership or Project grant.

The account's designated reviewer opens **People and access** to approve or
decline requests. The reviewer must still be an administrator of the configured
account. Other account administrators cannot read or review this queue.

Approval creates or reuses an account invitation with the `member` role and no
Project grant. A new sign-in identity receives the provider's account setup email.
Someone who already has a provider identity signs in normally to discover and
accept the invitation. Provider sign-in alone does not grant Studio access.
The direct `/login?request=account` route opens the request form without restarting
provider sign-in. If a signed-in identity is not yet registered with Studio or has
no account membership, **No workspace access yet** offers **Request OpenGeo access**
and preserves the intended destination. Use **Check invitations** to recover an
approved invitation that is ready for acceptance.

Access begins after the person signs in and accepts the invitation. Repeated
approval returns the original invitation. Declining a request creates no identity
or grant. A pre-existing invitation with a different role requires a separate
explicit decision and is preserved.

Operators enable intake by applying migration `0180_account_access_requests.sql`
with its preceding migrations and configuring both
`OPEN_GEO_ACCOUNT_REQUEST_ORGANIZATION_ID` and
`OPEN_GEO_ACCOUNT_REQUEST_REVIEWER_USER_ID`. These identify an existing account
and its designated reviewer. Missing configuration disables intake.

Anonymous submission returns the same pending receipt for duplicate requests and
provides no status lookup. A persistent limit permits five attempts per source
IP in an hourly window; duplicates count. The request cannot choose a target
account, reviewer, role or Project. Publication and resource access remain separate
decisions under their existing permissions.
