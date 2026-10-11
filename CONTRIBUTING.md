# Contributing to OpenGeo Community

Contributions should improve a concrete user workflow or fix a demonstrated
problem. Start with the [roadmap](ROADMAP.md), the affected source and its existing
checks. Discuss large changes in an issue before building another subsystem.

First-party contributions are Apache-2.0, inbound equals outbound. Contributors
retain copyright; no CLA or copyright assignment is required. Existing upstream
files retain their original terms. Preserve source links, LICENSE/NOTICE files,
attribution, provenance and applicable change notices.

Each commit must include a `Signed-off-by` trailer certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/).
Read the certificate before using `git commit -s`. Use a contact identity you
are willing to publish. Sign-off is not a transfer of copyright.

Keep credentials, private data, deployment outputs and local state out of Git.
Never weaken resource authorization or publish a private dataset to make a
development check pass. Authentication and storage substitutes are local only.
Public sample data needs explicit redistribution rights.

Run focused checks for changed behavior and `git diff --check`. Dependency changes
also require `npm run foundations:check`, lockfiles, attribution and security review.
Use the existing integration runner for representative connected workflows.
Documentation-only changes need link/whitespace review, not builds or cloud calls.
Preserve existing security and data-preservation checks; report their limits.

Explain the problem, resulting behavior, validation and remaining limits in the
pull request. Keep optional feature breadth separate from core workflow repairs.
New dependencies need a reason, version pin, source/license evidence and an update
to `governance/open-source-foundations.json` and the readable foundation inventory.

Report security issues using [SECURITY.md](SECURITY.md). See the
[licensing policy](docs/community-licensing.md) for origin and distribution details.
