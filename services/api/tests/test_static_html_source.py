from uuid import uuid4

import pytest
from pydantic import ValidationError

from opengeo_api.observable_source_routes import CreateObservableSourceRevisionRequest


def payload(paths, entry="index.html", lockfile=None):
    return dict(
        expected_revision=0,
        title="Static map",
        entry_path=entry,
        lockfile_path=lockfile,
        change_summary="Import map HTML",
        files=[dict(relative_path=path, upload_id=str(uuid4())) for path in sorted(paths)],
    )


def test_static_html_entry_uses_existing_revision_request():
    request = CreateObservableSourceRevisionRequest.model_validate(
        payload(["index.html", "map.js"])
    )
    assert request.entry_path == "index.html"
    assert request.lockfile_path is None


@pytest.mark.parametrize(
    "paths,entry,lockfile",
    [
        (["page.html"], "page.html", None),
        (["private.txt", "site/index.html"], "site/index.html", None),
        (["index.html", "README.md"], "index.html", None),
        (["index.html", "package.json", "package-lock.json"], "index.html", "package-lock.json"),
        (["index.html", "observablehq.config.js"], "index.html", None),
    ],
)
def test_static_html_rejects_build_configuration_and_files_outside_public_root(
    paths, entry, lockfile
):
    with pytest.raises(ValidationError):
        CreateObservableSourceRevisionRequest.model_validate(payload(paths, entry, lockfile))
