# Workspace Contracts

This shared module is licensed under Apache-2.0; see LICENSE and NOTICE. Its application-specific adapters, credentials and hosted operation retain their own boundaries. GitHub source release does not publish an npm or Python registry package.

`@categori/workspace-contracts` is the provider-neutral core shared by the focused workspace, team, review, repository, archive, and document-management tools in this checkout.

It defines the following boundaries:

- collaboration: workspaces, clients, teams, projects, notebooks, explicit grants, inheritance, expiry, revocation, deny overrides, and explainable access decisions;
- repository: self-owned logical repositories, external source references, capture modes, immutable artifact references, checksums, and provenance-safe adapter descriptors.
- demo: immutable seeds, verified UTC visitor partitions, server-authoritative quotas, disposable overlays, no uploads, and a reviewed MassGIS-only public data boundary;
- source manifest: exact MassGIS attribution, official URLs, rights/technical review, limitations, versions or snapshot digests, and an explicit runtime-egress allowlist;
- publication: a neutral alpha name, manifest/digest-bound MassGIS scope, a sanitized-preview state, disabled high-risk public capabilities, digest-bound passing evidence, and separated multi-role release approvals.
- interoperability: authority- and workspace-qualified resource references, explicit immutable versions, legacy adapters, record revisions, aliases, typed relationships and namespaced extensions.
- preservation: explicit immutable fields and append-only record histories;
- identity: verified issuer/subject links, active users/workspaces and scoped member or guest participation;
- working state: classified locations, revision preconditions, immutable checkpoints and pinned promotion requests;
- retained evidence: portable immutable references with full byte digests, resolved by the retaining authority.
- releases: pinned input editions, exact output manifests, separately reviewed public projections and append-only availability events.
- collections: authorized metadata exchange with qualified Collection identity, descriptive owner principal, explicit contexts, audience intent and ordered independently governed target references.
- documents: exact immutable document versions with full-object or fixed-part SHA256 integrity and bounded complete-byte verification.

## Notebook authorship and ownership (alpha.9)

A notebook can retain `creator_id: null` when historical authorship is unknown, but it must have a valid owner. Assigning an owner does not establish the creator. Known creator metadata remains unchanged after transfer; creator metadata alone does not grant access when a different owner is recorded. JavaScript, Python and the schema share this distinction. Malformed declared creator/owner identifiers are rejected.

## Immutable document versions (alpha.8)

`./documents` adds `assertDocumentVersionLink`, `documentVersionKey` and
`verifyDocumentVersionBytes` without changing Archive retained-evidence records.
A document link has exactly `schema_version: 1`, an immutable `document` resource
reference, `size_bytes` (0–128 MiB), a bounded MIME `media_type` including optional
parameters such as charset, and an `integrity` manifest. It contains no routing
endpoint, provider credential, access grant, display title or source bytes.

`FULL_OBJECT` uses lowercase 64-character SHA256 hex of the complete original
bytes. `COMPOSITE` uses canonical padded base64 SHA256 of the concatenated binary
SHA256 hashes of fixed 8 MiB parts, followed by `-<part-count>`. The count must equal
the ceiling of byte length divided by 8 MiB; empty documents require FULL_OBJECT.
The whole-object and composite values have different meanings and are never
treated as interchangeable. The wire schema is exported at
`./schemas/documents.schema.json`; runtime validation additionally checks exact
part count, authority safety and portable-data bounds.

The edition key contains only the qualified immutable reference. Consumers must
reject a conflicting byte manifest for an already recorded version rather than
allocate another edition identity. Complete-byte verification returns an
independent verified byte snapshot, using WebCrypto (optionally `cryptoImpl`), so
caller mutation during an asynchronous digest cannot change verified content.
`documentVersionChunkBytes` supplies the existing 512 KiB transport bound; this
module performs no fetch. The application must recheck its original authorized
context after digest before displaying or persisting bytes. Current authority,
provider access, chunk manifest consistency and destination-write controls remain
app-owned. The contract neither copies an Archive custody identity nor replaces
its current authorization.

## Collection metadata exchange

`./collections` defines a Collection's own identity/revision separately from its
owner principal, organizational context, audience and member references. Ownership
metadata accepts declared User, Team or Organization identities without extending
any app's authorization evaluator. Principals have a qualified authority and opaque
ID; they are not assigned a fabricated home workspace. Context references are
explicit and optional; an account identifier alone does not establish an agency.

Audience intent is `restricted`, `scope` or `public`. Scope audience names the exact
owning security-workspace reference. OpenGeo maps its existing `private`, `account`
and `public` wire values through its app-owned adapter; other apps retain their own
policies. A definition neither grants access to its members nor serves as a public
projection. Current authorization and member-level filtering remain app-owned.

Ordered entries preserve their own IDs and each target's authority, scope and
optional immutable version. An unavailable authoring slot contains only its entry
ID and a null reference. The structural JSON schema is exported separately;
`validateCollectionDefinition` additionally checks exact owning audience scope and
unique entry/reference identities. Folder-purpose profiles, file collections,
protocol collections and archive custody use distinct app profiles.

The package intentionally contains no credentials, signed URLs, cloud-account identifiers, customer data, billing rules, hosted-service endpoints, or deployment-specific super-user identities. A source record may retain an opaque `connection_ref`; the private adapter resolves that reference to credentials at runtime.

The package is temporarily marked `private` so it cannot be published accidentally while repository placement and licensing are decided. The source is structured as a standalone package so a reviewed public release can later replace the vendored copies without changing its API.

## Core hierarchy

```text
workspace (security and collaboration boundary)
  +-- client (business context; never an implicit principal)
  +-- team (membership principal; no implicit cross-workspace membership)
  +-- project (durable work container)
        +-- notebook (creator-owned, independently shareable resource)
              +-- artifact references and source-derived work
```

New standalone notebooks default to `restricted`. An adapter that is migrating a project-embedded notebook may explicitly choose `inherit` to preserve existing project access. The creator becomes the initial owner and cannot be denied through an ordinary grant; ownership changes require a separate, explicit transfer workflow.

## Data ownership

A data repository is logical and user-controlled. External systems such as S3, Google Drive, SharePoint, ESRI services, GitHub, local files, and arbitrary web sources are represented through provider-neutral source references. The contract distinguishes:

- `reference`: keep a pointer and observed version metadata;
- `snapshot`: preserve a content-addressed version in the owned repository;
- `mirror`: synchronize through an explicitly configured adapter.

Application authorization and upstream source ACLs remain separate. Capturing an upstream ACL is provenance; it does not itself grant application access.

## Public release guard

The package version is pre-final, but `private: true` remains set until licensing and sanitization are approved. The publication contract rejects private geospatial branding in the initial candidate, requires a `0.x` alpha version, binds public and MassGIS source manifests by digest, limits public source authority to MassGIS, and requires security, accessibility, privacy/content, data-rights, SBOM, clean-build, and release evidence before a candidate can be marked approved or published.

## Portable references (alpha.2)

`createResourceReference` identifies a resource by authority, owning security workspace, resource type and opaque ID. `version_id` is optional for mutable discovery; require it with `assertResourceReference(ref, {immutable: true})` for retained evidence or release inputs. Record revisions and asset/provider versions are different values. `adaptResourceReference` requires an explicit matching legacy scope; its caller supplies the verified account-to-workspace mapping. The adapter never infers a mapping from a name or email.

`createResourceEnvelope` preserves namespaced domain extensions, including explicit unknown/null values. A relationship or alias describes identity/lineage; it never grants access, proves equivalence or authorizes a cross-workspace read. Resolve such links through the owning authority's current access checks.

The version-1 JSON schema defines wire shape. Runtime validation additionally rejects duplicate alias identities, credentials and signed URLs, cycles/non-JSON data, more than 8,192 values, depth over 24 and serialized UTF-8 size over 64 KiB. These bounds apply to the reference/envelope; large raw evidence belongs in separately retained assets. Existing collaboration and repository wire schemas remain unchanged. Exact alpha versions are pinned; licensing/publication remain pending.

`validatePreservedRecord`/`assertPreservedRecord` compare original fields and append-only histories under an explicit application policy. Object field ordering is ignored; original unknown/null facts and historical entry content remain exact. New entries may be prepended or appended, but existing entries cannot be removed, rewritten or duplicated under an existing ID. This utility does not authorize a write or persist evidence: applications still authenticate, apply revision preconditions and retain immutable bytes/events through their own storage adapters.

## Scoped identity and working state (alpha.3)

Alpha.7 adds `schemas/identity.schema.json`, fixed portable conformance cases in
`conformance/identity.json`, and the native standard-library Python package
`python/categori_workspace_contracts`. JavaScript and Python tests evaluate the
same fixed inputs and expected results. Opaque identifiers now require a strict
whole-string match, rejecting trailing line endings without changing valid IDs.
The Python adapter takes options dictionaries using the JavaScript wire option
names (such as `verifiedIdentity`, `identityLinks`, `parentAccess` and `now`), and
returns independent snake-case result records. Import it from the maintained
package's `python` directory; it invokes no JavaScript subprocess, SDK or provider.
Python constructors use snake-case keyword arguments and allocate no identifiers.

Schema validation checks structure; it does not replace the runtime's portable
data bounds, exact UTC timestamp checks, active-record gates or resource evaluator.
Both runtimes preserve original User/workspace/resource IDs and input records.
Applications supply verified identity and current authoritative records, bind
deployment/storage IDs explicitly, and retain their own conditions, transaction
protocols, provider checks and capability lifetimes. The shared result contains
no access horizon. Portable evaluation times and grant timestamps use ISO date/time
forms; JavaScript's host-dependent non-ISO date parsing is not an exchange format.

Run JavaScript conformance with `node --test test/identity-conformance.test.js`
and native Python conformance with
`python3 -B test/identity-conformance.test.py`. Neither test starts providers.

Identity links use an exact verified issuer and subject pair. Emails are display/contact fields, never identity joins. Applications supply current identity links, user/workspace lifecycle records, participation and resource grants from their own authoritative stores. Guests require explicit resource scope and receive no inherited team, workspace or client access. The identity utility does not verify tokens or provision accounts. Suspension and revocation apply before the existing resource owner/grant rules.

Working-state policies distinguish working, authoritative-source, archival and publication locations. Ordinary saves/checkpoints require a working location, current edit/provider permission and an exact conditional-write precondition; promotion requires a selected immutable checkpoint and current promotion permission. Applications must classify actual storage bindings and enforce provider preconditions. Metadata curation is independent of protected asset bytes.

A retained-evidence link carries the original authority/scope/version, collection reference, SHA-256 and byte length. It contains no endpoint, credentials or cached grant. The retaining application authorizes each read against current state; consumers verify the complete original bytes before displaying them. Saving a link does not create another archival identity or grant access to its target.

## Pinned releases and public projections

The `./releases` module supplies provider-neutral records alongside the existing specialized MassGIS `./publication` guard. `createPublicationRelease` takes an immutable `publication_release` reference, its unversioned publication/collection/package identity, an explicit project reference or `null`, pinned inputs, an exact output manifest, a target location reference, attribution and producer/time. It allocates no new IDs, fetches no source and changes no serving state. All owned identities retain the release authority and workspace; an input can retain another authority/workspace when the application has independently authorized that read.

An input has `input_id`, an immutable `reference`, `role` (`source`, `build`, `configuration` or `evidence`) and a full `sha256` or explicit `null` when its opaque edition is not a content digest. An output manifest has an immutable `reference`, full `sha256`, exact `size_bytes`, JSON `media_type`, `file_count` and `total_bytes`. Large file inventories remain separately retained bytes; they are not squeezed into the contract's 64 KiB bound. A retained evidence bundle can likewise pin a large input history as one reference. Release ID, opaque immutable edition, output SHA, mutable application job revision and provider precondition remain separate values.

`assertPublicationRelease` returns a deeply frozen validated clone. `publicationReleaseBytes` returns deterministic UTF-8 JSON with recursively sorted object keys and preserved array order; `publicationReleaseDigest` computes its full SHA-256 using WebCrypto. Store those exact bytes or validate an equivalent parsed record. Every input reference, attribution statement, target and timestamp participates in the digest. This canonical encoding is specific to this contract; it is not a claim of general JSON canonicalization compliance.

`createPublicReleaseProjection(release, review)` requires an approved, governed disclosure review bound to the exact release reference **and complete release digest**. Public aliases/version/title are selected explicitly. Every internal attribution gets an explicit include/omit decision; omission requires a reason and cannot remove a required credit. Included license statements remain exact. The public object contains only those selected aliases/title, output-manifest fixity/counts and reviewed credit text/links/licenses. Private identities, input IDs/references, paths, client information, reviewer identity and omission reasons stay in the governed release/review. Unknown fields fail validation. This mechanism does not prove publication rights or sanitize the compiled artifact's bytes: the authoring application's current rights, privacy and release controls must approve them separately. An empty attribution array is an explicit absence of recorded credits, not an assertion that the inputs are unrestricted.

`createPublicationAvailabilityEvent` retains a separate immutable event chain. An initial `available` event can be followed by `withdrawn`, renewed availability or terminal `revoked`; exact prior event references and consecutive sequences prevent history replacement. Withdrawal/revocation requires a reason. Events do not perform storage or access changes; serving adapters must enforce them under their own current authorization and provider preconditions. Release contents remain pinned even when availability changes.

The [version-1 release schema](schemas/releases.schema.json) describes strict JSON wire shapes. Runtime validation also enforces matching scope, unique IDs, attribution/input integrity, safe URL parsing, portable-data bounds, exact digest review binding and event-chain continuity. [Shared fixtures](test/releases-fixtures.json) exercise compatible wire/runtime acceptance; semantic tests additionally cover stale reviews, private-lineage disclosure and withdrawal without rewriting history. Applications retain their own compilers, access rules, provider bindings and release decisions. Package placement/licensing remain private pending review.

## Project business context (alpha.5)

`./business-context` shares an explicit project ID, one owning security workspace,
its current storage/home account (or `null`), and up to 20 independently declared
business-account associations. `createProjectBusinessContext` deduplicates exact
IDs in first-seen order and returns a frozen clone. Wire validation requires
unique associations and rejects guessed scope, malformed IDs and extra fields.
The home account is not implicitly added to the business associations.

These IDs are local to the app's known authority. Exchange them only with the
existing authority-qualified resource envelope/reference; matching IDs or email
across apps does not establish common identity. Applications independently
authorize account metadata, resource access and writes. Association metadata does
not create membership, a content grant, organization authority, a storage move or
a billable entitlement. Workspace Management's scoped project factory and ESIA's
server-owned project creation consume this contract. Unscoped legacy Workspace
projects retain their unknown scope; they cannot acquire business associations
until their owning workspace is explicit. Full organization/client lifecycle,
collection contracts and cross-app identity mappings remain to implement.
