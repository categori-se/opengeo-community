from dataclasses import replace
from hashlib import sha256

from opengeo_api.publication_previews import publication_preview
from opengeo_api.site_publications import (
    PublishedMapSnapshot,
    PublishedResourceReference,
    PublishedSite,
)
from test_site_routes import (
    EDITION_ID,
    MAP_RESOURCE_ID,
    MAP_VERSION_ID,
    ORG_ID,
    OUTPUT_OBJECT_ID,
    PROJECT_ID,
    RENDER_JOB_ID,
    MemoryRenderRepository,
    MemorySiteRepository,
    RevokingRenderRepository,
    api_client,
    edition,
    png,
    site,
)


def fixture():
    body = png()
    snapshot = PublishedMapSnapshot(
        RENDER_JOB_ID,
        OUTPUT_OBJECT_ID,
        "s3-version-2",
        "image/png",
        len(body),
        sha256(body).hexdigest(),
        32,
        20,
        (-71.2, 42.2, -71.0, 42.4),
        "EPSG:3857",
    )
    reference = PublishedResourceReference(
        MAP_RESOURCE_ID,
        MAP_VERSION_ID,
        2,
        "map",
        "Retained map",
        None,
        "Reporting team",
        "CC-BY-4.0",
        None,
        None,
        snapshot,
    )
    release = edition()
    repository = MemorySiteRepository()
    repository.release = PublishedSite(
        site(state="published", active_edition=release), release, (reference,)
    )
    return body, repository


def test_retained_publication_preview_keeps_map_terms_and_bounded_exact_read():
    body, repository = fixture()
    preview = publication_preview(repository.release, ORG_ID)
    assert preview["license"] == "CC-BY-4.0"
    assert preview["attribution"] == "Reporting team"
    renders = MemoryRenderRepository(body)
    response = api_client(repository, renders).get(preview["preview_path"])
    assert response.status_code == 200 and response.content == body
    assert response.headers["cache-control"] == "no-store"
    assert len(renders.calls) == 1 and renders.calls[0][-1] == 1024 * 1024
    assert [call[0] for call in repository.calls] == ["public", "public"]


def test_oversized_unlisted_and_missing_publication_previews_do_not_read_storage():
    body, repository = fixture()
    original = repository.release
    reference = original.references[0]
    oversized = replace(reference, snapshot=replace(reference.snapshot, size_bytes=1024 * 1024 + 1))
    variants = [
        replace(original, references=(oversized,)),
        replace(original, references=()),
        replace(original, edition=replace(original.edition, publication_reach="unlisted")),
    ]
    renders = MemoryRenderRepository(body)
    client = api_client(repository, renders)
    path = (
        f"/public/organizations/{ORG_ID}/projects/{PROJECT_ID}/site-editions/"
        f"{EDITION_ID}/previews/{MAP_RESOURCE_ID}.png"
    )
    for publication in variants:
        repository.release = publication
        assert publication_preview(publication, ORG_ID) is None
        assert client.get(path).status_code == 404
    assert not renders.calls


def test_revocation_during_publication_preview_read_prevents_delivery():
    body, repository = fixture()
    path = publication_preview(repository.release, ORG_ID)["preview_path"]
    response = api_client(repository, RevokingRenderRepository(body, repository)).get(path)
    assert response.status_code == 404
