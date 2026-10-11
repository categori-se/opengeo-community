from dataclasses import replace

import pytest

from opengeo_api.rendering import RenderAccessDenied, RenderConflict, RenderSubmission
from opengeo_api.saved_map_rendering import SavedMapRenderUnsupported
from test_render_routes import (
    IDEMPOTENCY_ID,
    JOB_ID,
    PROJECT_ID,
    RESOURCE_ID,
    RESOURCE_VERSION_ID,
    Dispatcher,
    FakeRepository,
    client,
    headers,
    job,
)

BASE = f"/projects/{PROJECT_ID}/resources/{RESOURCE_ID}"
SNAPSHOT = {
    "resource_version_id": str(RESOURCE_VERSION_ID),
    "resource_version_number": 3,
    "map_id": "60000000-0000-4000-8000-000000000001",
    "map_version": 4,
    "definition_checksum_sha256": "a" * 64,
    "recipe_checksum_sha256": "b" * 64,
}


class SavedMapRepository(FakeRepository):
    failure = None
    dispatch_required = True

    async def request_saved_map_render(self, context, project_id, resource_id, request, request_id):
        self.calls.append(("saved-map", project_id, resource_id, request))
        if self.failure:
            raise self.failure
        return RenderSubmission(
            replace(
                job(output_format="png", width=request.width, height=request.height),
                saved_map_snapshot=SNAPSHOT,
            ),
            self.dispatch_required,
        )

    async def list_resource_renders(self, context, project_id, resource_id):
        self.calls.append(("list-images", project_id, resource_id))
        return [replace(job("completed", output_format="png"), saved_map_snapshot=SNAPSHOT)]


def payload():
    return {
        "idempotency_key": str(IDEMPOTENCY_ID),
        "expected_resource_version": 3,
        "expected_map_version": 4,
        "width": 320,
        "height": 240,
        "format": "png",
    }


def test_saved_map_render_posts_exact_revision_and_dispatches_only_created_job():
    repository, dispatcher = SavedMapRepository(), Dispatcher()
    response = client(repository, dispatcher).post(
        f"{BASE}/saved-map-renders", headers=headers(), json=payload()
    )
    assert response.status_code == 202
    assert response.json()["saved_map_snapshot"] == SNAPSHOT
    request = repository.calls[0][3]
    assert request.expected_map_version == 4
    assert request.expected_resource_version == 3
    assert request.idempotency_key == IDEMPOTENCY_ID
    assert dispatcher.jobs == [JOB_ID]
    repository.dispatch_required = False
    response = client(repository, dispatcher).post(
        f"{BASE}/saved-map-renders", headers=headers(), json=payload()
    )
    assert response.status_code == 202
    assert dispatcher.jobs == [JOB_ID]


@pytest.mark.parametrize(
    "key,value",
    [
        ("width", True),
        ("height", "240"),
        ("width", 63),
        ("height", 2049),
        ("expected_resource_version", True),
        ("expected_map_version", 0),
        ("expected_map_version", 9_007_199_254_740_992),
        ("format", "svg"),
        ("bbox", [0, 0, 1, 1]),
        ("background_color", "#ffffff"),
    ],
)
def test_saved_map_request_rejects_unsupported_or_ambiguous_fields_before_dispatch(key, value):
    repository, dispatcher = SavedMapRepository(), Dispatcher()
    response = client(repository, dispatcher).post(
        f"{BASE}/saved-map-renders", headers=headers(), json={**payload(), key: value}
    )
    assert response.status_code == 422
    assert repository.calls == []
    assert dispatcher.jobs == []


@pytest.mark.parametrize(
    "failure,status,code",
    [
        (RenderAccessDenied("denied"), 403, "action_forbidden"),
        (RenderConflict("map_version_conflict"), 409, "map_version_conflict"),
        (
            SavedMapRenderUnsupported(
                "saved_map_source_unavailable", "Choose a ready saved layer."
            ),
            409,
            "saved_map_source_unavailable",
        ),
    ],
)
def test_saved_map_errors_are_actionable_and_do_not_dispatch(failure, status, code):
    repository, dispatcher = SavedMapRepository(), Dispatcher()
    repository.failure = failure
    response = client(repository, dispatcher).post(
        f"{BASE}/saved-map-renders", headers=headers(), json=payload()
    )
    assert response.status_code == status
    detail = response.json()["detail"]
    assert (detail["code"] if isinstance(detail, dict) else detail) == code
    if isinstance(failure, SavedMapRenderUnsupported):
        assert detail["message"] == "Choose a ready saved layer."
    assert dispatcher.jobs == []


def test_image_discovery_is_read_only_and_exposes_the_saved_revision():
    repository, dispatcher = SavedMapRepository(), Dispatcher()
    response = client(repository, dispatcher).get(f"{BASE}/renders", headers=headers())
    assert response.status_code == 200
    assert response.json()[0]["saved_map_snapshot"] == SNAPSHOT
    assert repository.calls == [("list-images", PROJECT_ID, RESOURCE_ID)]
    assert dispatcher.jobs == []


def test_saved_map_render_requires_authentication():
    repository, dispatcher = SavedMapRepository(), Dispatcher()
    response = client(repository, dispatcher).post(f"{BASE}/saved-map-renders", json=payload())
    assert response.status_code == 401
    assert repository.calls == []
    assert dispatcher.jobs == []
