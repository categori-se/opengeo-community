"""Metadata-only selection of retained map images; never compiles a Publication."""

from uuid import UUID

from opengeo_api.site_publications import PublishedSite

MAX_PUBLICATION_PREVIEW_BYTES = 1024 * 1024


def publication_preview(
    publication: PublishedSite, organization_id: UUID
) -> dict[str, str | None] | None:
    # Listing is deliberate publication authority, not inferred from Collection visibility.
    if publication.edition.publication_reach != "listed":
        return None
    for reference in publication.references:
        snapshot = reference.snapshot
        if (
            snapshot is None
            or snapshot.content_type != "image/png"
            or not 0 < snapshot.size_bytes <= MAX_PUBLICATION_PREVIEW_BYTES
        ):
            continue
        return {
            "title": publication.site.title,
            "license": reference.license,
            "attribution": reference.attribution,
            "preview_path": (
                f"/public/organizations/{organization_id}/projects/{publication.site.project_id}"
                f"/site-editions/{publication.edition.edition_id}"
                f"/previews/{reference.resource_id}.png"
            ),
        }
    return None
