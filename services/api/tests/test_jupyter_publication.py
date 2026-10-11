from dataclasses import replace
from uuid import uuid4

import pytest
from pydantic import ValidationError

from opengeo_api.observable_source_routes import CreateObservableSourceRevisionRequest
from opengeo_api.observable_sources import (
    ObservableRevisionUpload,
    ObservableSourceConflict,
    ObservableSourceRevisionDraft,
    PostgresObservableSourceRepository,
    validate_observable_source_file,
)


def test_native_notebook_source_media():
    validate_observable_source_file("src/analysis.ipynb", "application/x-ipynb+json", 200)
    validate_observable_source_file("src/analysis.ipynb", "application/json", 200)
    for path, media, size in [
        ("src/analysis.ipynb", "text/html", 200),
        ("../analysis.ipynb", "application/x-ipynb+json", 200),
        ("src/analysis.ipynb", "application/x-ipynb+json", 4_194_305),
    ]:
        with pytest.raises(ObservableSourceConflict):
            validate_observable_source_file(path, media, size)


def test_native_notebook_entry_contract_matches_repository():
    upload = uuid4()
    body = dict(
        expected_revision=0,
        title="Analysis",
        rights_status="unreviewed",
        entry_path="src/analysis.ipynb",
        lockfile_path=None,
        change_summary="Import notebook",
        files=[dict(upload_id=upload, relative_path="src/analysis.ipynb")],
    )
    request = CreateObservableSourceRevisionRequest(**body)
    draft = ObservableSourceRevisionDraft(
        expected_revision=0,
        title=request.title,
        rights_status=request.rights_status,
        entry_path=request.entry_path,
        lockfile_path=None,
        change_summary=request.change_summary,
        files=(ObservableRevisionUpload(upload, request.entry_path),),
    )
    PostgresObservableSourceRepository._validate_revision_draft(draft)
    for extra in [
        dict(lockfile_path="package-lock.json"),
        dict(entry_path="src/missing.ipynb"),
        dict(files=[dict(upload_id=uuid4(), relative_path="private.txt"), *body["files"]]),
    ]:
        with pytest.raises(ValidationError):
            CreateObservableSourceRevisionRequest(**(body | extra))
    with pytest.raises(ObservableSourceConflict):
        PostgresObservableSourceRepository._validate_revision_draft(
            replace(draft, lockfile_path="package-lock.json")
        )
    with pytest.raises(ObservableSourceConflict):
        PostgresObservableSourceRepository._validate_revision_draft(
            replace(draft, files=(ObservableRevisionUpload(uuid4(), "private.txt"), *draft.files))
        )
