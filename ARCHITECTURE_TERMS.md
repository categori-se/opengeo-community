# Application resource model

| Resource | Meaning |
| --- | --- |
| Catalog | An inventory of known resources and their source, custody and rights |
| Layer | Independently identified spatial data; reusable across Projects |
| Style | Reusable versioned cartographic definition |
| Project | A saved composition of Layers, Styles and configuration |
| Artifact | Versioned compiled output from a Project or source |
| Publication | Independent narrative or analytical work, consuming Layers or Artifacts |
| Collection | An account-scoped ordered grouping of Project/Publication references |
| Account | Membership and organizational context; distinct from ownership |
| Geographic tag | Optional reusable geographic context, never an access grant |

Catalog inspection opens only the selected Layer in a temporary map. Adding a
Layer to a Project and saving that composition are deliberate separate actions.
Inspection never copies source data or grants access.

Referenced, hosted, cached, mirrored, derived and locally created custody stay
explicit. Preserve source, normalized, curated and inferred metadata separately,
including evidence, uncertainty and attribution. License, access rights, provider
terms, application permissions and ownership are separate concepts.

Collections do not grant access to their members. A resource-side tag requires
resource edit authority and never grants access. Existing legacy access-container
tables and URLs remain compatibility storage; they are not automatically product
Projects or Collections. Use forward migrations and retain persistent identities.

The implementation uses Studio under `app/`, APIs under `services/api/`, versioned
PostgreSQL/PostGIS schema under `database/`, processing under `services/worker/`
and isolated publication compilation under `services/observable-builder/`.
The [community roadmap](ROADMAP.md) owns release sequencing and open acceptance.
Standards and upstream references are retained in [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md).
