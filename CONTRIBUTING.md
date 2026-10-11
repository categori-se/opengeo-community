# Contributing to OpenGeo Studio

Contributions should improve a concrete user workflow or fix a demonstrated
problem. Start with the [roadmap](ROADMAP.md), the affected source and its existing
checks. Discuss large changes in an issue before building another subsystem.

## Make a first contribution

GIS practitioners can help with cartographic review, sample projects, workflow
feedback and checks on analytical methods. You do not need to write application
code. Start with the [illustrated workflow](docs/community-workflow.md) and
[example gallery](docs/community-examples.md), then report what helped, what was
unclear and what result you expected. Share only inputs you have permission to
redistribute; synthetic examples are welcome.

Choose one small task below and open an issue before starting so another
contributor can avoid duplicating the work. These are invitations, not claims
that corresponding GitHub issues have already been created.

| Task and user problem | Relevant files | Completion criteria |
| --- | --- | --- |
| Test a clean Linux installation: a new developer needs to know which prerequisites are missing | `docs/community-development.md`, `scripts/run-integrated-studio-local.py`, component Dockerfiles | Record source commit, OS and tool versions, exact commands, first failure or successful save/restart/reopen; redact credentials and distinguish fresh builds from reused images |
| Document one GeoLibre handoff: a practitioner needs to know what survives a conversion | `app/src/lib/geolibreProject.js`, `app/test/geolibre-project.test.mjs`, `docs/community-capabilities.md` | Use one small redistributable project; document preserved fields, disclosed losses and unsupported content; verify the stated round trip without claiming current upstream parity |
| Improve one error message: a user needs a clear next step | `app/src/components/`, `app/src/lib/sourceCapabilityCatalog.js` | Give the trigger and current message, propose a task-specific recovery, and check the affected control and visible-copy expectation |
| Repair one public guide: readers need an unbroken path from a component to its explanation | Component `README.md`, `docs/community-architecture.md` | Replace or explain the missing target; verify the link in the standalone public tree; retain historical evidence without linking private receipts |
| Prepare one practitioner example: readers need to inspect inputs and assumptions | `docs/community-examples.md`, `docs/community-workflow.md` | Include a question, redistributable inputs and terms, dated steps, expected result, uncertainty and observed implementation limits |

Use the repository's [issue templates](https://github.com/categori-se/opengeo-community/issues/new/choose)
for installation reports, workflow feedback or a focused contribution. Include
the source commit and whether you used the anonymous demo, a local installation
or a hosted account. A screenshot of a demo is not evidence of persistent save
or publication acceptance.

## Contribution terms and checks

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

For AWS installer changes, run `npm run community:aws:check`, the affected
infrastructure tests, TypeScript and offline synthesis. For database-runner
changes, run `python3 -m unittest discover -s database/test -p test_apply_migrations.py`
and its offline migration plan. Use [SUPPORT.md](SUPPORT.md) for installation
questions and reproducible reports.
