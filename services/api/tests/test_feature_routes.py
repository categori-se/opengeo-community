from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from opengeo_api.app import create_app
from opengeo_api.auth_models import OrganizationMembership, Principal, VerifiedAccessToken
from opengeo_api.config import Settings
from opengeo_api.features import (
    AttributeQueryStep,
    FeatureAccessDenied,
    FeatureCollection,
    FeatureConflict,
    FeatureDeletion,
    FeatureInvalid,
    FeatureLockRecord,
    FeatureLockRelease,
    FeatureMutation,
    FeatureNotFound,
    FeaturePage,
    FeatureRecord,
    FeatureRevision,
    FeatureSharedVertexMutation,
    FeatureStructureMutation,
    FeatureTombstone,
    FeatureTombstonePage,
    SpatialQueryStep,
    TemporalQueryStep,
    cut_multipolygon_drafts,
    merge_multipolygon_draft,
    normalize_cut_line,
    normalize_properties,
    separate_multipolygon_drafts,
)
from opengeo_api.ogc_feature_routes import _parse_bbox as parse_ogc_bbox
from opengeo_api.ogc_features import (
    FEATURE_COLLECTION_ID,
    OGC_CRS84,
    features_api_document,
)

USER_ID = UUID("20000000-0000-4000-8000-000000000121")
ORG_ID = UUID("10000000-0000-4000-8000-000000000121")
PROJECT_ID = UUID("50000000-0000-4000-8000-000000000121")
DATASET_ID = UUID("80000000-0000-4000-8000-000000000121")
FEATURE_ID = UUID("90000000-0000-4000-8000-000000000121")
FEATURE_ID_2 = UUID("90000000-0000-4000-8000-000000000122")
LOCK_TOKEN = UUID("a0000000-0000-4000-8000-000000000121")
OTHER_LOCK_TOKEN = UUID("a0000000-0000-4000-8000-000000000122")
NOW = datetime(2026, 8, 20, 15, tzinfo=UTC)


class PassingProbe:
    async def check(self) -> None:
        pass


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedAccessToken:
        assert token == "valid-token"
        return VerifiedAccessToken("subject", "client", "user", (), ())


class FakePrincipalRepository:
    async def resolve(self, subject: str) -> Principal:
        assert subject == "subject"
        return Principal(
            user_id=USER_ID,
            subject=subject,
            email="editor@example.test",
            display_name="Editor",
            memberships=(OrganizationMembership(ORG_ID, "member"),),
        )


class MemoryFeatureRepository:
    def __init__(self) -> None:
        self.collection: FeatureCollection | None = None
        self.features: dict[UUID, FeatureRecord] = {}
        self.history: dict[UUID, list[FeatureRevision]] = {}
        self.tombstones: dict[UUID, FeatureTombstone] = {}
        self.deleted_heads: dict[UUID, FeatureRecord] = {}
        self.locks: dict[UUID, FeatureLockRecord] = {}
        self.calls: list[tuple] = []

    async def create_collection(
        self, context, project_id, dataset_id, geometry_type, fields, features, request_id
    ):
        self.calls.append(("create_collection", context, project_id, dataset_id, request_id))
        if self.collection is not None:
            raise FeatureConflict("feature_collection_exists")
        self.collection = FeatureCollection(
            dataset_id, geometry_type, fields, 1, len(features), USER_ID, NOW, USER_ID, NOW
        )
        for draft in features:
            properties = normalize_properties(draft.properties, fields)
            record = FeatureRecord(
                draft.feature_id,
                1,
                draft.geometry_type,
                draft.geometry,
                draft.bbox,
                properties,
                USER_ID,
                NOW,
                USER_ID,
                NOW,
            )
            self.features[record.feature_id] = record
            self.history[record.feature_id] = [self._revision(record, "create", request_id)]
        return FeaturePage(self.collection, tuple(self.features.values()), len(features), 100, 0)

    async def list_features(
        self,
        context,
        project_id,
        dataset_id,
        *,
        bbox,
        limit,
        offset,
        expected_generation=None,
        cql2_filter=None,
    ):
        self.calls.append(("list", context, project_id, dataset_id, bbox, limit, offset))
        collection = self._collection()
        if expected_generation is not None and collection.generation != expected_generation:
            raise FeatureConflict("feature_collection_generation_conflict", collection.generation)
        if cql2_filter is not None:
            from opengeo_api.cql2_features import compile_feature_filter

            compile_feature_filter(
                *cql2_filter, {field.name: field.type for field in self.collection.fields}
            )
            self.last_cql2_filter = cql2_filter
        values = list(self.features.values())
        if bbox is not None:
            values = [
                item
                for item in values
                if not (
                    item.bbox[2] < bbox[0]
                    or item.bbox[0] > bbox[2]
                    or item.bbox[3] < bbox[1]
                    or item.bbox[1] > bbox[3]
                )
            ]
        return FeaturePage(
            collection, tuple(values[offset : offset + limit]), len(values), limit, offset
        )

    async def get_feature(
        self, context, project_id, dataset_id, feature_id, *, expected_generation=None
    ):
        del context, project_id, dataset_id
        collection = self._collection()
        if expected_generation is not None and collection.generation != expected_generation:
            raise FeatureConflict("feature_collection_generation_conflict", collection.generation)
        try:
            return self.features[feature_id]
        except KeyError as error:
            raise FeatureNotFound("feature") from error

    async def query_features(
        self,
        context,
        project_id,
        dataset_id,
        *,
        steps,
        limit,
        offset,
        expected_generation=None,
    ):
        self.calls.append(("query", context, project_id, dataset_id, steps, limit, offset))
        collection = self._collection()
        if expected_generation is not None and collection.generation != expected_generation:
            raise FeatureConflict("feature_collection_generation_conflict", collection.generation)
        fields = {field.name for field in collection.fields}
        matches = list(self.features.values())
        for step in steps:
            if isinstance(step, AttributeQueryStep):
                if step.field not in fields:
                    raise FeatureInvalid("feature query field is not in the collection schema")
                matches = [
                    feature
                    for feature in matches
                    if _attribute_matches(feature.properties.get(step.field), step)
                ]
            elif isinstance(step, SpatialQueryStep):
                query_bbox = _geometry_bbox(step.geometry)
                matches = [
                    feature
                    for feature in matches
                    if not (
                        feature.bbox[2] < query_bbox[0]
                        or feature.bbox[0] > query_bbox[2]
                        or feature.bbox[3] < query_bbox[1]
                        or feature.bbox[1] > query_bbox[3]
                    )
                ]
            elif isinstance(step, TemporalQueryStep):
                matches = [
                    feature
                    for feature in matches
                    if step.begin
                    <= (
                        feature.created_at
                        if step.field == "opengeo_created_at"
                        else feature.updated_at
                    )
                    < step.end
                ]
        return FeaturePage(
            collection, tuple(matches[offset : offset + limit]), len(matches), limit, offset
        )

    async def create_feature(
        self, context, project_id, dataset_id, feature, change_message, request_id
    ):
        del context, project_id, dataset_id
        collection = self._collection()
        if feature.feature_id in self.features:
            raise FeatureConflict("feature_id_exists")
        properties = normalize_properties(feature.properties, collection.fields)
        record = FeatureRecord(
            feature.feature_id,
            1,
            feature.geometry_type,
            feature.geometry,
            feature.bbox,
            properties,
            USER_ID,
            NOW,
            USER_ID,
            NOW,
        )
        self.features[feature.feature_id] = record
        self.tombstones.pop(feature.feature_id, None)
        self.deleted_heads.pop(feature.feature_id, None)
        self.history[feature.feature_id] = [
            self._revision(record, "create", request_id, change_message)
        ]
        self.collection = replace(
            collection, generation=collection.generation + 1, feature_count=len(self.features)
        )
        return FeatureMutation(self.collection, record)

    async def update_feature(
        self,
        context,
        project_id,
        dataset_id,
        feature_id,
        expected_version,
        feature,
        change_message,
        request_id,
        lock_token=None,
    ):
        del context, project_id, dataset_id
        current = await self.get_feature(None, None, None, feature_id)
        if current.version_number != expected_version:
            raise FeatureConflict("feature_version_conflict", current.version_number)
        self._require_lock(feature_id, lock_token)
        collection = self._collection()
        record = replace(
            current,
            version_number=current.version_number + 1,
            geometry_type=feature.geometry_type,
            geometry=feature.geometry,
            bbox=feature.bbox,
            properties=normalize_properties(feature.properties, collection.fields),
        )
        self.features[feature_id] = record
        self.history[feature_id].append(
            self._revision(record, "update", request_id, change_message)
        )
        self.collection = replace(collection, generation=collection.generation + 1)
        self._advance_lock(feature_id, record.version_number, lock_token)
        return FeatureMutation(self.collection, record)

    async def delete_feature(
        self,
        context,
        project_id,
        dataset_id,
        feature_id,
        expected_version,
        change_message,
        request_id,
        lock_token=None,
    ):
        del context, project_id, dataset_id
        current = await self.get_feature(None, None, None, feature_id)
        if current.version_number != expected_version:
            raise FeatureConflict("feature_version_conflict", current.version_number)
        self._require_lock(feature_id, lock_token)
        collection = self._collection()
        deleted = replace(current, version_number=current.version_number + 1)
        self.history[feature_id].append(
            self._revision(deleted, "delete", request_id, change_message)
        )
        self.tombstones[feature_id] = FeatureTombstone(
            feature_id, deleted.version_number, USER_ID, NOW, NOW
        )
        self.deleted_heads[feature_id] = deleted
        del self.features[feature_id]
        self.locks.pop(feature_id, None)
        self.collection = replace(
            collection,
            generation=collection.generation + 1,
            feature_count=collection.feature_count - 1,
        )
        return FeatureDeletion(feature_id, deleted.version_number, self.collection.generation)

    async def list_deleted_features(self, context, project_id, dataset_id, *, limit, offset):
        del context, project_id, dataset_id
        self._collection()
        values = sorted(
            self.tombstones.values(),
            key=lambda item: (item.deleted_at, item.feature_id),
            reverse=True,
        )
        return FeatureTombstonePage(
            tuple(values[offset : offset + limit]), len(values), limit, offset
        )

    async def restore_feature(
        self,
        context,
        project_id,
        dataset_id,
        feature_id,
        expected_version,
        revision_version,
        change_message,
        request_id,
    ):
        del context, project_id, dataset_id
        collection = self._collection()
        tombstone = self.tombstones.get(feature_id)
        if tombstone is None:
            current = self.features.get(feature_id)
            if current is not None:
                raise FeatureConflict("feature_not_deleted", current.version_number)
            raise FeatureNotFound("feature")
        if tombstone.deleted_version != expected_version:
            raise FeatureConflict("feature_version_conflict", tombstone.deleted_version)
        if revision_version >= expected_version:
            raise FeatureInvalid("restore revision must predate the current tombstone")
        revision = next(
            (
                item
                for item in self.history[feature_id]
                if item.version_number == revision_version
                and item.operation in {"create", "update", "restore"}
            ),
            None,
        )
        if revision is None:
            raise FeatureNotFound("feature_revision")
        deleted_head = self.deleted_heads[feature_id]
        record = FeatureRecord(
            feature_id,
            expected_version + 1,
            revision.geometry_type,
            revision.geometry,
            _geometry_bbox(revision.geometry),
            normalize_properties(revision.properties, collection.fields),
            deleted_head.created_by,
            deleted_head.created_at,
            USER_ID,
            NOW,
        )
        self.features[feature_id] = record
        self.history[feature_id].append(
            self._revision(record, "restore", request_id, change_message)
        )
        del self.tombstones[feature_id]
        del self.deleted_heads[feature_id]
        self.collection = replace(
            collection,
            generation=collection.generation + 1,
            feature_count=collection.feature_count + 1,
        )
        return FeatureMutation(self.collection, record)

    async def separate_multipolygon_parts(
        self,
        context,
        project_id,
        dataset_id,
        feature_id,
        expected_version,
        retained_part_index,
        change_message,
        request_id,
        lock_token=None,
    ):
        del context, project_id, dataset_id
        current = await self.get_feature(None, None, None, feature_id)
        if current.version_number != expected_version:
            raise FeatureConflict("feature_version_conflict", current.version_number)
        self._require_lock(feature_id, lock_token)
        collection = self._collection()
        if collection.geometry_type != "MultiPolygon":
            raise FeatureInvalid("only MultiPolygon collections can separate polygon parts")
        drafts = separate_multipolygon_drafts(current, collection.fields, retained_part_index)
        retained = replace(
            current,
            version_number=current.version_number + 1,
            geometry=drafts[0].geometry,
            bbox=drafts[0].bbox,
        )
        self.features[feature_id] = retained
        self.history[feature_id].append(
            self._revision(retained, "update", request_id, change_message)
        )
        created = []
        for draft in drafts[1:]:
            record = FeatureRecord(
                draft.feature_id,
                1,
                draft.geometry_type,
                draft.geometry,
                draft.bbox,
                draft.properties,
                USER_ID,
                NOW,
                USER_ID,
                NOW,
            )
            self.features[record.feature_id] = record
            self.history[record.feature_id] = [
                self._revision(record, "create", request_id, change_message)
            ]
            created.append(record)
        self.collection = replace(
            collection,
            generation=collection.generation + 1,
            feature_count=collection.feature_count + len(created),
        )
        self._advance_lock(feature_id, retained.version_number, lock_token)
        return FeatureStructureMutation(self.collection, retained, tuple(created), ())

    async def merge_multipolygon_features(
        self,
        context,
        project_id,
        dataset_id,
        retained_feature_id,
        expected_versions,
        change_message,
        request_id,
        geometry_operation="collect",
    ):
        del context, project_id, dataset_id
        self.calls.append(("merge_geometry_operation", geometry_operation))
        collection = self._collection()
        if collection.geometry_type != "MultiPolygon":
            raise FeatureInvalid("only MultiPolygon collections can merge polygon features")
        records = []
        tokens = {}
        for feature_id, expected_version, lock_token in expected_versions:
            current = await self.get_feature(None, None, None, feature_id)
            if current.version_number != expected_version:
                raise FeatureConflict("feature_version_conflict", current.version_number)
            self._require_lock(feature_id, lock_token)
            tokens[feature_id] = lock_token
            records.append(current)
        retained = next(
            (record for record in records if record.feature_id == retained_feature_id), None
        )
        if retained is None:
            raise FeatureInvalid("retained polygon feature must be included in the merge")
        donors = [record for record in records if record.feature_id != retained_feature_id]
        draft = merge_multipolygon_draft(
            [retained, *donors], collection.fields, retained_feature_id
        )
        merged = replace(
            retained,
            version_number=retained.version_number + 1,
            geometry=draft.geometry,
            bbox=draft.bbox,
        )
        self.features[retained_feature_id] = merged
        self._advance_lock(
            retained_feature_id,
            merged.version_number,
            tokens[retained_feature_id],
        )
        self.history[retained_feature_id].append(
            self._revision(merged, "update", request_id, change_message)
        )
        deleted = []
        generation = collection.generation + 1
        for donor in donors:
            tombstone = replace(donor, version_number=donor.version_number + 1)
            self.history[donor.feature_id].append(
                self._revision(tombstone, "delete", request_id, change_message)
            )
            self.tombstones[donor.feature_id] = FeatureTombstone(
                donor.feature_id, tombstone.version_number, USER_ID, NOW, NOW
            )
            self.deleted_heads[donor.feature_id] = tombstone
            del self.features[donor.feature_id]
            self.locks.pop(donor.feature_id, None)
            deleted.append(FeatureDeletion(donor.feature_id, tombstone.version_number, generation))
        self.collection = replace(
            collection,
            generation=generation,
            feature_count=collection.feature_count - len(deleted),
        )
        return FeatureStructureMutation(self.collection, merged, (), tuple(deleted))

    async def list_feature_locks(self, context, project_id, dataset_id):
        del context, project_id, dataset_id
        self._purge_expired_locks()
        return tuple(
            sorted(self.locks.values(), key=lambda item: (item.expires_at, item.feature_id))
        )[:100]

    async def acquire_feature_lock(
        self,
        context,
        project_id,
        dataset_id,
        feature_id,
        expected_version,
        lock_token,
        lease_seconds,
        request_id,
    ):
        del context, project_id, dataset_id, request_id
        current = await self.get_feature(None, None, None, feature_id)
        if current.version_number != expected_version:
            raise FeatureConflict("feature_version_conflict", current.version_number)
        self._purge_expired_locks()
        active = self.locks.get(feature_id)
        if active is not None and (
            not active.held_by_current_user or active.lock_token != lock_token
        ):
            raise FeatureConflict("feature_locked", current.version_number)
        if active is None and len(self.locks) >= 25:
            raise FeatureConflict("feature_lock_limit_reached")
        acquired_at = datetime.now(UTC)
        feature_lock = FeatureLockRecord(
            feature_id,
            current.version_number,
            lock_token,
            True,
            acquired_at,
            acquired_at + timedelta(seconds=lease_seconds),
        )
        self.locks[feature_id] = feature_lock
        return feature_lock

    async def release_feature_lock(
        self,
        context,
        project_id,
        dataset_id,
        feature_id,
        lock_token,
        request_id,
    ):
        del context, project_id, dataset_id, request_id
        await self.get_feature(None, None, None, feature_id)
        self._purge_expired_locks()
        active = self.locks.get(feature_id)
        if active is None:
            return FeatureLockRelease(feature_id, False)
        if not active.held_by_current_user or active.lock_token != lock_token:
            raise FeatureConflict("feature_locked", active.feature_version)
        del self.locks[feature_id]
        return FeatureLockRelease(feature_id, True)

    async def list_feature_history(
        self, context, project_id, dataset_id, feature_id, limit, offset
    ):
        del context, project_id, dataset_id
        if feature_id not in self.history:
            raise FeatureNotFound("feature")
        return tuple(reversed(self.history[feature_id]))[offset : offset + limit]

    def _collection(self) -> FeatureCollection:
        if self.collection is None:
            raise FeatureNotFound("feature_collection")
        return self.collection

    def _purge_expired_locks(self) -> None:
        current_time = datetime.now(UTC)
        for feature_id, feature_lock in tuple(self.locks.items()):
            if feature_lock.expires_at <= current_time:
                del self.locks[feature_id]

    def _require_lock(self, feature_id, lock_token) -> None:
        self._purge_expired_locks()
        active = self.locks.get(feature_id)
        if active is None:
            return
        if lock_token is None or not active.held_by_current_user or active.lock_token != lock_token:
            raise FeatureConflict("feature_locked", active.feature_version)

    def _advance_lock(self, feature_id, feature_version, lock_token) -> None:
        active = self.locks.get(feature_id)
        if active is not None and active.lock_token == lock_token:
            self.locks[feature_id] = replace(active, feature_version=feature_version)

    @staticmethod
    def _revision(record, operation, request_id, change_message=None):
        return FeatureRevision(
            record.version_number,
            operation,
            record.geometry_type,
            record.geometry,
            record.properties,
            USER_ID,
            change_message,
            request_id,
            NOW,
        )


def _attribute_matches(candidate, step) -> bool:
    if step.operator == "is_null":
        return candidate is None
    if candidate is None:
        return False
    if step.operator in {"contains", "starts_with"}:
        left = str(candidate) if step.case_sensitive else str(candidate).casefold()
        right = str(step.value) if step.case_sensitive else str(step.value).casefold()
        return right in left if step.operator == "contains" else left.startswith(right)
    if step.operator == "equals":
        return candidate == step.value
    if step.operator == "not_equals":
        return candidate != step.value
    if step.operator == "greater_than":
        return candidate > step.value
    if step.operator == "greater_than_or_equal":
        return candidate >= step.value
    if step.operator == "less_than":
        return candidate < step.value
    if step.operator == "less_than_or_equal":
        return candidate <= step.value
    return False


def _geometry_bbox(geometry) -> tuple[float, float, float, float]:
    def positions(value):
        if (
            isinstance(value, list)
            and len(value) == 2
            and all(isinstance(item, int | float) for item in value)
        ):
            return [value]
        return [position for item in value for position in positions(item)]

    coordinates = (
        [position for member in geometry["geometries"] for position in _geometry_positions(member)]
        if geometry["type"] == "GeometryCollection"
        else positions(geometry["coordinates"])
    )
    return (
        min(item[0] for item in coordinates),
        min(item[1] for item in coordinates),
        max(item[0] for item in coordinates),
        max(item[1] for item in coordinates),
    )


def _geometry_positions(geometry):
    if geometry["type"] == "GeometryCollection":
        return [
            position
            for member in geometry["geometries"]
            for position in _geometry_positions(member)
        ]

    def positions(value):
        if (
            isinstance(value, list)
            and len(value) == 2
            and all(isinstance(item, int | float) for item in value)
        ):
            return [value]
        return [position for item in value for position in positions(item)]

    return positions(geometry["coordinates"])


def api_client(repository: MemoryFeatureRepository) -> TestClient:
    return TestClient(
        create_app(
            settings=Settings(env="test", expose_docs=True),
            readiness_probe=PassingProbe(),
            token_verifier=FakeVerifier(),
            principal_repository=FakePrincipalRepository(),
            feature_repository=repository,
        )
    )


def headers() -> dict[str, str]:
    return {
        "Authorization": "Bearer valid-token",
        "X-OpenGeo-Organization": str(ORG_ID),
        "X-Request-ID": "feature-edit-request-123",
    }


def collection_payload() -> dict:
    return {
        "geometry_type": "Point",
        "fields": [
            {
                "name": "name",
                "type": "string",
                "required": True,
                "label": "Station name",
                "description": "Field-visible station label",
                "min_length": 1,
                "max_length": 100,
            },
            {
                "name": "count",
                "type": "integer",
                "required": False,
                "minimum": 0,
                "maximum": 10,
            },
        ],
        "features": [
            {
                "type": "Feature",
                "id": str(FEATURE_ID),
                "geometry": {"type": "Point", "coordinates": [-77.03, 38.9]},
                "properties": {"name": "Station", "count": 2},
            }
        ],
    }


def multipolygon_collection_payload() -> dict:
    return {
        "geometry_type": "MultiPolygon",
        "fields": [{"name": "name", "type": "string", "required": True}],
        "features": [
            {
                "type": "Feature",
                "id": str(FEATURE_ID),
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [
                        [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
                        [[[2, 0], [3, 0], [3, 1], [2, 1], [2, 0]]],
                    ],
                },
                "properties": {"name": "Review area"},
            }
        ],
    }


def test_shared_auth_and_org_scope_protect_feature_routes() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)

    assert client.get(f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features").status_code == 401
    response = client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=collection_payload(),
    )

    assert response.status_code == 201
    assert response.headers["content-type"].startswith("application/geo+json")
    assert response.json()["features"][0]["id"] == str(FEATURE_ID)
    assert response.json()["features"][0]["opengeo:version"] == 1
    assert response.json()["opengeo:collection"]["fields"] == collection_payload()["fields"]
    assert repository.calls[0][1].organization_id == ORG_ID
    assert repository.calls[0][-1] == "feature-edit-request-123"


def test_crud_history_and_stale_writes_are_explicit() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=collection_payload(),
    )
    update_url = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features/{FEATURE_ID}"
    update = {
        "expected_version": 1,
        "geometry": {"type": "Point", "coordinates": [-77.04, 38.91]},
        "properties": {"name": "Station revised", "count": 3},
        "change_message": "Move after field verification",
    }

    changed = client.put(update_url, headers=headers(), json=update)
    stale = client.put(update_url, headers=headers(), json=update)
    history = client.get(f"{update_url}/history", headers=headers())
    deleted = client.delete(
        update_url,
        headers=headers(),
        params={"expected_version": 2, "change_message": "Remove duplicate"},
    )

    assert changed.status_code == 200
    assert changed.json()["opengeo:version"] == 2
    assert changed.json()["opengeo:collectionGeneration"] == 2
    assert stale.status_code == 409
    assert stale.json()["detail"] == {
        "code": "feature_version_conflict",
        "current_version": 2,
    }
    assert [revision["operation"] for revision in history.json()["revisions"]] == [
        "update",
        "create",
    ]
    assert history.json()["revisions"][0]["request_id"] == "feature-edit-request-123"
    assert deleted.json() == {
        "feature_id": str(FEATURE_ID),
        "deleted_version": 3,
        "collection_generation": 3,
    }


def test_deleted_feature_is_listed_and_restored_from_an_immutable_snapshot() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=collection_payload(),
    )
    feature_url = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features/{FEATURE_ID}"
    client.put(
        feature_url,
        headers=headers(),
        json={
            "expected_version": 1,
            "geometry": {"type": "Point", "coordinates": [-77.04, 38.91]},
            "properties": {"name": "Station revised", "count": 3},
        },
    )
    deleted = client.delete(
        feature_url,
        headers=headers(),
        params={"expected_version": 2, "change_message": "Remove duplicate"},
    )

    tombstones = client.get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-tombstones",
        headers=headers(),
    )
    restored = client.post(
        f"{feature_url}/restore",
        headers=headers(),
        json={
            "expected_version": 3,
            "revision_version": 1,
            "change_message": "Recover original field capture",
        },
    )
    history = client.get(f"{feature_url}/history", headers=headers())
    empty_tombstones = client.get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-tombstones",
        headers=headers(),
    )

    assert deleted.status_code == 200
    assert tombstones.status_code == 200
    assert tombstones.json() == {
        "tombstones": [
            {
                "feature_id": str(FEATURE_ID),
                "deleted_version": 3,
                "deleted_by": str(USER_ID),
                "deleted_at": NOW.isoformat(),
                "updated_at": NOW.isoformat(),
            }
        ],
        "number_matched": 1,
        "number_returned": 1,
        "limit": 20,
        "offset": 0,
    }
    assert restored.status_code == 200
    assert restored.json()["id"] == str(FEATURE_ID)
    assert restored.json()["opengeo:version"] == 4
    assert restored.json()["opengeo:collectionGeneration"] == 4
    assert restored.json()["geometry"] == collection_payload()["features"][0]["geometry"]
    assert restored.json()["properties"] == collection_payload()["features"][0]["properties"]
    assert [revision["operation"] for revision in history.json()["revisions"]] == [
        "restore",
        "delete",
        "update",
        "create",
    ]
    assert empty_tombstones.json()["number_matched"] == 0
    assert repository.collection is not None
    assert repository.collection.feature_count == 1


def test_deleted_feature_restore_rejects_stale_or_nonhistorical_targets() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=collection_payload(),
    )
    feature_url = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features/{FEATURE_ID}"
    client.delete(feature_url, headers=headers(), params={"expected_version": 1})

    stale = client.post(
        f"{feature_url}/restore",
        headers=headers(),
        json={"expected_version": 3, "revision_version": 1},
    )
    deletion_revision = client.post(
        f"{feature_url}/restore",
        headers=headers(),
        json={"expected_version": 2, "revision_version": 2},
    )

    assert stale.status_code == 409
    assert stale.json()["detail"] == {
        "code": "feature_version_conflict",
        "current_version": 2,
    }
    assert deletion_revision.status_code == 422
    assert deletion_revision.json()["detail"]["code"] == "feature_validation_failed"


def test_short_feature_lock_lifecycle_is_optional_private_and_version_safe() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=collection_payload(),
    )
    feature_url = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features/{FEATURE_ID}"
    locks_url = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-locks"
    update = {
        "expected_version": 1,
        "geometry": {"type": "Point", "coordinates": [-77.04, 38.91]},
        "properties": {"name": "Station reserved", "count": 3},
    }

    assert client.get(locks_url).status_code == 401
    acquired = client.put(
        f"{feature_url}/lock",
        headers=headers(),
        json={"expected_version": 1, "lock_token": str(LOCK_TOKEN)},
    )
    listed = client.get(locks_url, headers=headers())
    blocked_write = client.put(feature_url, headers=headers(), json=update)
    blocked_takeover = client.put(
        f"{feature_url}/lock",
        headers=headers(),
        json={
            "expected_version": 1,
            "lock_token": str(OTHER_LOCK_TOKEN),
            "lease_seconds": 30,
        },
    )
    renewed = client.put(
        f"{feature_url}/lock",
        headers=headers(),
        json={
            "expected_version": 1,
            "lock_token": str(LOCK_TOKEN),
            "lease_seconds": 300,
        },
    )
    update["lock_token"] = str(LOCK_TOKEN)
    changed = client.put(feature_url, headers=headers(), json=update)
    listed_after_write = client.get(locks_url, headers=headers())
    wrong_release = client.delete(
        f"{feature_url}/lock",
        headers=headers(),
        params={"lock_token": str(OTHER_LOCK_TOKEN)},
    )
    released = client.delete(
        f"{feature_url}/lock",
        headers=headers(),
        params={"lock_token": str(LOCK_TOKEN)},
    )

    assert acquired.status_code == 200
    assert acquired.json()["held_by_current_user"] is True
    assert acquired.json()["lock_token"] == str(LOCK_TOKEN)
    assert listed.json()["number_returned"] == 1
    assert listed.json()["locks"][0]["lock_token"] == str(LOCK_TOKEN)
    assert blocked_write.status_code == 409
    assert blocked_write.json()["detail"] == {
        "code": "feature_locked",
        "current_version": 1,
    }
    assert blocked_takeover.status_code == 409
    assert renewed.status_code == 200
    assert changed.status_code == 200
    assert changed.json()["opengeo:version"] == 2
    assert listed_after_write.json()["locks"][0]["feature_version"] == 2
    assert wrong_release.status_code == 409
    assert released.json() == {"feature_id": str(FEATURE_ID), "released": True}
    assert client.get(locks_url, headers=headers()).json()["locks"] == []

    repository.locks[FEATURE_ID] = FeatureLockRecord(
        FEATURE_ID,
        2,
        None,
        False,
        datetime.now(UTC),
        datetime.now(UTC) + timedelta(seconds=120),
    )
    private_listing = client.get(locks_url, headers=headers()).json()["locks"][0]
    assert private_listing["held_by_current_user"] is False
    assert private_listing["lock_token"] is None


@pytest.mark.parametrize("geometry_type", ["MultiPolygon", "Polygon"])
def test_cut_line_route_auth_contract_conflict_and_structural_receipt(geometry_type) -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    collection_url = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection"
    feature_url = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features"
    initial = multipolygon_collection_payload()
    if geometry_type == "Polygon":
        initial["geometry_type"] = "Polygon"
        geometry = initial["features"][0]["geometry"]
        initial["features"][0]["geometry"] = {
            "type": "Polygon",
            "coordinates": geometry["coordinates"][0],
        }
    client.post(collection_url, headers=headers(), json=initial)
    received = []

    async def cut(
        context,
        project_id,
        dataset_id,
        feature_id,
        expected_version,
        part_index,
        cut_line,
        change_message,
        request_id,
        lock_token=None,
    ):
        received.append(
            (
                context,
                project_id,
                dataset_id,
                feature_id,
                part_index,
                cut_line,
                change_message,
                lock_token,
            )
        )
        current = repository.features[feature_id]
        if current.version_number != expected_version:
            raise FeatureConflict("feature_version_conflict", current.version_number)
        repository._require_lock(feature_id, lock_token)
        normalize_cut_line(cut_line)
        pieces = [
            {"type": "Polygon", "coordinates": [[[0.25, 0], [1, 0], [1, 1], [0.25, 1], [0.25, 0]]]},
            {"type": "Polygon", "coordinates": [[[0, 0], [0.25, 0], [0.25, 1], [0, 1], [0, 0]]]},
        ]
        drafts = cut_multipolygon_drafts(current, repository.collection.fields, part_index, pieces)
        retained = replace(
            current,
            version_number=current.version_number + 1,
            geometry=drafts[0].geometry,
            bbox=drafts[0].bbox,
        )
        created = replace(
            current,
            feature_id=drafts[1].feature_id,
            version_number=1,
            geometry=drafts[1].geometry,
            bbox=drafts[1].bbox,
        )
        repository.features[feature_id] = retained
        collection = replace(repository.collection, generation=2, feature_count=2)
        return FeatureStructureMutation(collection, retained, (created,), ())

    repository.cut_multipolygon_feature = cut
    payload = {
        "feature_id": str(FEATURE_ID),
        "expected_version": 1,
        "part_index": 0,
        "cut_line": {"type": "LineString", "coordinates": [[0.25, -1], [0.25, 2]]},
        "change_message": "Cut surveyed area",
        "lock_token": str(LOCK_TOKEN),
    }
    endpoint = f"{feature_url}/cut-line"
    assert client.post(endpoint, json=payload).status_code == 401
    assert (
        client.post(endpoint, headers=headers(), json={**payload, "unexpected": True}).status_code
        == 422
    )
    assert (
        client.post(endpoint, headers=headers(), json={**payload, "part_index": 256}).status_code
        == 422
    )
    assert received == []
    response = client.post(endpoint, headers=headers(), json=payload)
    assert response.status_code == 200
    receipt = response.json()
    assert receipt["operation"] == "cut_line"
    assert receipt["retained_feature"]["id"] == str(FEATURE_ID)
    assert receipt["retained_feature"]["opengeo:version"] == 2
    assert receipt["retained_feature"]["geometry"]["type"] == geometry_type
    assert receipt["created_features"][0]["geometry"]["type"] == geometry_type
    assert len(receipt["retained_feature"]["geometry"]["coordinates"]) == (
        1 if geometry_type == "Polygon" else 2
    )
    assert receipt["created_features"][0]["properties"] == {"name": "Review area"}
    assert receipt["deleted_features"] == []
    assert (receipt["collection_generation"], receipt["feature_count"]) == (2, 2)
    context, project, dataset, feature, part, line, message, lock = received[-1]
    assert (context.organization_id, context.user_id) == (ORG_ID, USER_ID)
    assert (project, dataset, feature, part, line, message, lock) == (
        PROJECT_ID,
        DATASET_ID,
        FEATURE_ID,
        0,
        payload["cut_line"],
        payload["change_message"],
        LOCK_TOKEN,
    )
    stale = client.post(endpoint, headers=headers(), json=payload)
    assert stale.status_code == 409
    assert stale.json()["detail"] == {"code": "feature_version_conflict", "current_version": 2}


def test_multipolygon_parts_separate_and_merge_atomically_with_exact_versions() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    collection_url = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection"
    feature_url = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features"
    client.post(collection_url, headers=headers(), json=multipolygon_collection_payload())

    assert client.post(f"{feature_url}/separate-parts", json={}).status_code == 401
    separated = client.post(
        f"{feature_url}/separate-parts",
        headers=headers(),
        json={
            "feature_id": str(FEATURE_ID),
            "expected_version": 1,
            "retained_part_index": 1,
            "change_message": "Separate survey areas",
        },
    )

    assert separated.status_code == 200
    receipt = separated.json()
    assert receipt["operation"] == "separate_parts"
    assert receipt["collection_generation"] == 2
    assert receipt["feature_count"] == 2
    assert receipt["retained_feature"]["id"] == str(FEATURE_ID)
    assert receipt["retained_feature"]["opengeo:version"] == 2
    assert receipt["retained_feature"]["geometry"]["coordinates"] == [
        [[[2.0, 0.0], [3.0, 0.0], [3.0, 1.0], [2.0, 1.0], [2.0, 0.0]]]
    ]
    assert len(receipt["created_features"]) == 1
    created = receipt["created_features"][0]
    assert created["opengeo:version"] == 1
    assert receipt["deleted_features"] == []

    stale = client.post(
        f"{feature_url}/merge-parts",
        headers=headers(),
        json={
            "retained_feature_id": str(FEATURE_ID),
            "features": [
                {"feature_id": str(FEATURE_ID), "expected_version": 1},
                {"feature_id": created["id"], "expected_version": 1},
            ],
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"] == {
        "code": "feature_version_conflict",
        "current_version": 2,
    }

    merged = client.post(
        f"{feature_url}/merge-parts",
        headers=headers(),
        json={
            "retained_feature_id": str(FEATURE_ID),
            "features": [
                {"feature_id": str(FEATURE_ID), "expected_version": 2},
                {"feature_id": created["id"], "expected_version": 1},
            ],
            "change_message": "Restore multipart survey feature",
        },
    )

    assert merged.status_code == 200
    merged_receipt = merged.json()
    assert merged_receipt["operation"] == "merge_parts"
    assert merged_receipt["collection_generation"] == 3
    assert merged_receipt["feature_count"] == 1
    assert merged_receipt["retained_feature"]["opengeo:version"] == 3
    assert len(merged_receipt["retained_feature"]["geometry"]["coordinates"]) == 2
    assert merged_receipt["created_features"] == []
    assert merged_receipt["deleted_features"] == [
        {
            "feature_id": created["id"],
            "deleted_version": 2,
            "collection_generation": 3,
        }
    ]
    donor_history = client.get(f"{feature_url}/{created['id']}/history", headers=headers())
    assert [item["operation"] for item in donor_history.json()["revisions"]] == [
        "delete",
        "create",
    ]


def test_dissolve_route_requires_explicit_operation_and_forwards_authenticated_selection() -> None:
    # The memory repository proves route wiring only; native topology is checked
    # separately against the exact production SQL in test_features.py.
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    collection_url = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection"
    feature_url = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features"
    client.post(collection_url, headers=headers(), json=multipolygon_collection_payload())
    separated = client.post(
        f"{feature_url}/separate-parts",
        headers=headers(),
        json={"feature_id": str(FEATURE_ID), "expected_version": 1, "retained_part_index": 0},
    ).json()
    payload = {
        "retained_feature_id": str(FEATURE_ID),
        "geometry_operation": "dissolve",
        "features": [
            {"feature_id": str(FEATURE_ID), "expected_version": 2},
            {"feature_id": separated["created_features"][0]["id"], "expected_version": 1},
        ],
    }
    previous_calls = len(repository.calls)
    assert client.post(f"{feature_url}/merge-parts", json=payload).status_code == 401
    for invalid in ("union", "", None, True):
        rejected = client.post(
            f"{feature_url}/merge-parts",
            headers=headers(),
            json={**payload, "geometry_operation": invalid},
        )
        assert rejected.status_code == 422
    assert len(repository.calls) == previous_calls
    response = client.post(f"{feature_url}/merge-parts", headers=headers(), json=payload)
    assert response.status_code == 200
    assert ("merge_geometry_operation", "dissolve") in repository.calls
    assert response.json()["geometry_operation"] == "dissolve"
    assert response.json()["operation"] == "merge_parts"
    assert response.json()["retained_feature"]["id"] == str(FEATURE_ID)


def test_connected_polygon_dissolve_route_preserves_wire_contract_and_polygon_receipt() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    collection_url = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection"
    endpoint = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features/merge-parts"
    donor_id = UUID("90000000-0000-4000-8000-000000000132")
    initial = multipolygon_collection_payload()
    initial["geometry_type"] = "Polygon"
    initial["features"] = [
        {
            "type": "Feature",
            "id": str(feature_id),
            "properties": {"name": name},
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        }
        for feature_id, name, ring in [
            (FEATURE_ID, "Retained parcel", [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]),
            (donor_id, "Donor parcel", [[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]),
        ]
    ]
    assert client.post(collection_url, headers=headers(), json=initial).status_code == 201
    received = []

    async def dissolve(
        context,
        project_id,
        dataset_id,
        retained_feature_id,
        expected_versions,
        change_message,
        request_id,
        geometry_operation="collect",
    ):
        received.append(
            (
                context,
                project_id,
                dataset_id,
                retained_feature_id,
                expected_versions,
                geometry_operation,
            )
        )
        if geometry_operation != "dissolve":
            raise FeatureInvalid("Polygon collections require explicit dissolve")
        # Route wiring only: actual union and persistence are proved by PostGIS.
        retained = replace(
            repository.features[FEATURE_ID],
            version_number=2,
            geometry={
                "type": "Polygon",
                "coordinates": [
                    [[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]],
                ],
            },
            bbox=(0, 0, 2, 1),
        )
        return FeatureStructureMutation(
            replace(repository.collection, generation=2, feature_count=1),
            retained,
            (),
            (FeatureDeletion(donor_id, 2, 2),),
        )

    repository.merge_multipolygon_features = dissolve
    payload = {
        "retained_feature_id": str(FEATURE_ID),
        "features": [
            {"feature_id": str(FEATURE_ID), "expected_version": 1},
            {"feature_id": str(donor_id), "expected_version": 1},
        ],
    }
    assert client.post(endpoint, json=payload).status_code == 401 and not received
    assert client.post(endpoint, headers=headers(), json=payload).status_code == 422
    response = client.post(
        endpoint, headers=headers(), json={**payload, "geometry_operation": "dissolve"}
    )
    assert response.status_code == 200
    document = response.json()
    assert document["operation"] == "merge_parts" and document["geometry_operation"] == "dissolve"
    assert document["retained_feature"]["geometry"]["type"] == "Polygon"
    assert document["retained_feature"]["properties"] == {"name": "Retained parcel"}
    assert document["created_features"] == [] and document["deleted_features"][0][
        "feature_id"
    ] == str(donor_id)
    context, project, dataset, retained, selected, operation = received[-1]
    assert (context.organization_id, context.user_id, project, dataset, retained, operation) == (
        ORG_ID,
        USER_ID,
        PROJECT_ID,
        DATASET_ID,
        FEATURE_ID,
        "dissolve",
    )
    assert selected == ((FEATURE_ID, 1, None), (donor_id, 1, None))


def test_geometry_schema_properties_and_bbox_are_bounded() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    invalid_schema = collection_payload()
    invalid_schema["fields"][0]["name"] = "not a safe field"
    invalid_geometry = collection_payload()
    invalid_geometry["features"][0]["geometry"]["coordinates"] = [-181, 38.9]

    schema_response = client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=invalid_schema,
    )
    geometry_response = client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=invalid_geometry,
    )
    bbox_response = client.get(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features",
        headers=headers(),
        params={"bbox": "10,20,5,30"},
    )

    assert schema_response.status_code == 422
    assert schema_response.json()["detail"]["code"] == "feature_validation_failed"
    assert geometry_response.status_code == 422
    assert bbox_response.status_code == 422


def test_governed_query_is_chained_generation_bound_and_reproducible() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=collection_payload(),
    )
    endpoint = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-query"
    query = {
        "schema_version": "opengeo.feature-query.1.0.0",
        "combine": "all",
        "steps": [
            {
                "kind": "attribute",
                "field": "name",
                "operator": "contains",
                "value": "station",
                "case_sensitive": False,
            },
            {
                "kind": "attribute",
                "field": "count",
                "operator": "greater_than_or_equal",
                "value": 2,
            },
            {
                "kind": "spatial",
                "relation": "intersects",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[-77.1, 38.8], [-76.9, 38.8], [-76.9, 39.0], [-77.1, 38.8]]],
                },
                "buffer_meters": 25,
            },
        ],
        "limit": 100,
        "offset": 0,
        "expected_generation": 1,
    }

    assert client.post(endpoint, json=query).status_code == 401
    response = client.post(endpoint, headers=headers(), json=query)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/geo+json")
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.json()["numberMatched"] == 1
    assert response.json()["features"][0]["id"] == str(FEATURE_ID)
    assert response.json()["opengeo:collectionGeneration"] == 1
    assert response.json()["opengeo:query"]["sort"] == "feature_id"
    assert response.json()["opengeo:query"]["steps"][2]["buffer_meters"] == 25
    assert len(response.json()["opengeo:querySha256"]) == 64
    assert repository.calls[-1][0] == "query"
    assert repository.calls[-1][1].organization_id == ORG_ID

    multipoint_response = client.post(
        endpoint,
        headers=headers(),
        json={
            "schema_version": "opengeo.feature-query.1.1.0",
            "steps": [
                {
                    "kind": "spatial",
                    "relation": "intersects",
                    "geometry": {
                        "type": "MultiPoint",
                        "coordinates": [[-77.0, 38.9], [-76.8, 39.1]],
                    },
                    "buffer_meters": 0,
                }
            ],
            "expected_generation": 1,
        },
    )
    collection_response = client.post(
        endpoint,
        headers=headers(),
        json={
            "schema_version": "opengeo.feature-query.1.1.0",
            "steps": [
                {
                    "kind": "spatial",
                    "relation": "intersects",
                    "geometry": {
                        "type": "GeometryCollection",
                        "geometries": [
                            {"type": "Point", "coordinates": [-77.0, 38.9]},
                            {
                                "type": "LineString",
                                "coordinates": [[-77.1, 38.8], [-76.9, 39.0]],
                            },
                        ],
                    },
                    "buffer_meters": 50,
                }
            ],
            "expected_generation": 1,
        },
    )

    assert multipoint_response.status_code == 200
    assert multipoint_response.json()["opengeo:query"]["schema_version"] == (
        "opengeo.feature-query.1.1.0"
    )
    assert (
        multipoint_response.json()["opengeo:query"]["steps"][0]["geometry"]["type"] == "MultiPoint"
    )
    assert collection_response.status_code == 200
    assert (
        collection_response.json()["opengeo:query"]["steps"][0]["geometry"]["type"]
        == "GeometryCollection"
    )

    edge_number_query = {
        "schema_version": "opengeo.feature-query.1.0.0",
        "combine": "all",
        "steps": [
            {
                "kind": "spatial",
                "relation": "intersects",
                "geometry": {"type": "Point", "coordinates": [1e-7, -0.0]},
                "buffer_meters": 1e-6,
            }
        ],
        "limit": 25,
        "offset": 0,
        "expected_generation": 1,
    }
    edge_number_response = client.post(endpoint, headers=headers(), json=edge_number_query)
    assert edge_number_response.status_code == 200
    assert edge_number_response.json()["opengeo:querySha256"] == (
        "72fbf961cada051a40821fc8bb35b2289245ff6fa2009d757d33b33d683f7617"
    )

    stale = client.post(endpoint, headers=headers(), json={**query, "expected_generation": 2})
    assert stale.status_code == 409
    assert stale.json()["detail"] == {
        "code": "feature_collection_generation_conflict",
        "current_version": 1,
    }


def test_governed_query_limits_and_schema_fail_closed() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=collection_payload(),
    )
    endpoint = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-query"
    step = {"kind": "attribute", "field": "name", "operator": "equals", "value": "x"}

    too_many = client.post(endpoint, headers=headers(), json={"steps": [step] * 5})
    unknown_field = client.post(
        endpoint,
        headers=headers(),
        json={"steps": [{**step, "field": "secret"}]},
    )
    oversized_buffer = client.post(
        endpoint,
        headers=headers(),
        json={
            "steps": [
                {
                    "kind": "spatial",
                    "relation": "intersects",
                    "geometry": {"type": "Point", "coordinates": [-77, 38]},
                    "buffer_meters": 100_001,
                }
            ]
        },
    )

    assert too_many.status_code == 422
    assert unknown_field.status_code == 422
    assert unknown_field.json()["detail"]["code"] == "feature_validation_failed"
    assert oversized_buffer.status_code == 422


def test_read_only_features_discovery_reuses_shared_auth_and_declines_conformance() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    base = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/ogc/features"

    assert client.get(base).status_code == 401
    client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=collection_payload(),
    )
    landing = client.get(base, headers=headers())
    conformance = client.get(f"{base}/conformance", headers=headers())
    collections = client.get(f"{base}/collections", headers=headers())

    assert landing.status_code == 200
    assert {link["rel"] for link in landing.json()["links"]} == {
        "self",
        "service-desc",
        "conformance",
        "data",
    }
    assert all(link["href"].startswith("http://testserver/") for link in landing.json()["links"])
    assert conformance.json()["conformsTo"] == []
    assert conformance.json()["opengeoStatus"]["readOnly"] is True
    assert "No OGC conformance" in conformance.json()["opengeoStatus"]["claim"]
    collection = collections.json()["collections"][0]
    assert collection["id"] == FEATURE_COLLECTION_ID
    assert collection["crs"] == [OGC_CRS84]
    assert collection["opengeo:generation"] == 1
    assert collection["opengeo:properties"]["name"] == {
        "type": "string",
        "required": True,
    }


def test_read_only_features_items_are_spatially_bounded_versioned_geojson() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=collection_payload(),
    )
    base = (
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/ogc/features"
        f"/collections/{FEATURE_COLLECTION_ID}/items"
    )

    page = client.get(
        base,
        headers=headers(),
        params={"bbox": "-78,38,-76,40", "limit": "1"},
    )
    item = client.get(f"{base}/{FEATURE_ID}", headers=headers())
    empty = client.get(base, headers=headers(), params={"bbox": "0,0,1,1"})

    assert page.status_code == 200
    assert page.headers["content-type"].startswith("application/geo+json")
    assert page.headers["content-crs"] == f"<{OGC_CRS84}>"
    assert page.json()["numberMatched"] == 1
    assert page.json()["numberReturned"] == 1
    assert page.json()["features"][0]["id"] == str(FEATURE_ID)
    assert page.json()["features"][0]["opengeo:version"] == 1
    assert {link["rel"] for link in page.json()["features"][0]["links"]} == {
        "self",
        "collection",
    }
    assert item.json()["geometry"] == {"type": "Point", "coordinates": [-77.03, 38.9]}
    assert empty.json()["numberMatched"] == 0

    exact_page = client.get(base, headers=headers(), params={"expected_generation": 1})
    exact_item = client.get(
        f"{base}/{FEATURE_ID}", headers=headers(), params={"expected_generation": 1}
    )
    stale_page = client.get(base, headers=headers(), params={"expected_generation": 2})
    stale_item = client.get(
        f"{base}/{FEATURE_ID}", headers=headers(), params={"expected_generation": 2}
    )
    assert exact_page.status_code == 200
    assert exact_item.status_code == 200
    assert stale_page.status_code == 409
    assert stale_page.json()["detail"] == {
        "code": "feature_collection_generation_conflict",
        "current_version": 1,
    }
    assert stale_item.status_code == 409


def test_feature_pagination_links_are_absolute_and_retain_exact_query() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    created = client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=collection_payload(),
    )
    assert created.status_code == 201
    repository.features[FEATURE_ID_2] = replace(
        repository.features[FEATURE_ID], feature_id=FEATURE_ID_2
    )
    base = (
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/ogc/features"
        f"/collections/{FEATURE_COLLECTION_ID}/items"
    )
    first = client.get(
        base,
        headers=headers(),
        params={"bbox": "-78,38,-76,40", "limit": 1, "expected_generation": 1},
    )
    assert first.status_code == 200
    next_link = next(link for link in first.json()["links"] if link["rel"] == "next")
    expected = (
        f"http://testserver{base}?bbox=-78%2C38%2C-76%2C40&limit=1&expected_generation=1&offset=1"
    )
    assert next_link == {"href": expected, "rel": "next", "type": "application/geo+json"}
    assert client.get(expected).status_code == 401
    second = client.get(expected, headers=headers())
    assert second.status_code == 200
    assert second.json()["features"][0]["id"] == str(FEATURE_ID_2)
    assert not any(link["rel"] == "next" for link in second.json()["links"])
    previous = next(link for link in second.json()["links"] if link["rel"] == "prev")
    assert previous["href"] == expected.replace("offset=1", "offset=0")
    assert client.get(previous["href"], headers=headers()).json()["features"][0]["id"] == str(
        FEATURE_ID
    )


def test_read_only_features_query_and_collection_fail_closed() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=collection_payload(),
    )
    root = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/ogc/features/collections"
    items = f"{root}/{FEATURE_COLLECTION_ID}/items"

    unknown_collection = client.get(f"{root}/unknown", headers=headers())
    unknown_query = client.get(items, headers=headers(), params={"filter": "DROP TABLE"})
    invalid_bbox = client.get(items, headers=headers(), params={"bbox": "0,0,200,10"})
    invalid_limit = client.get(items, headers=headers(), params={"limit": "01"})

    assert unknown_collection.status_code == 404
    assert unknown_query.status_code == 400
    assert unknown_query.json()["detail"]["code"] == "invalid_cql2_filter"
    assert invalid_bbox.status_code == 400
    assert invalid_limit.status_code == 400
    assert parse_ogc_bbox("-77,38,-10,-76,39,10") == (-77.0, 38.0, -76.0, 39.0)


def test_read_only_features_openapi_is_bounded_and_explicitly_non_claiming() -> None:
    document = features_api_document(PROJECT_ID, DATASET_ID)
    operation = document["paths"]["/collections/{collectionId}/items"]["get"]
    parameters = {parameter["name"]: parameter for parameter in operation["parameters"]}

    assert document["openapi"] == "3.0.3"
    assert document["servers"][0]["url"].endswith(f"/{DATASET_ID}/ogc/features")
    assert set(parameters) == {
        "collectionId",
        "bbox",
        "limit",
        "offset",
        "expected_generation",
        "filter",
        "filter-lang",
    }
    assert parameters["bbox"]["explode"] is False
    assert parameters["limit"]["schema"]["maximum"] == 100
    assert parameters["expected_generation"]["schema"]["minimum"] == 1
    assert document["x-opengeo-read-only"] is True
    assert document["x-opengeo-conformance-claimed"] is False


def test_cql2_route_and_queryables_share_collection_schema():
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=collection_payload(),
    )
    root = (
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/ogc/features/collections/"
        f"{FEATURE_COLLECTION_ID}"
    )
    assert client.get(f"{root}/queryables").status_code == 401
    schema = client.get(f"{root}/queryables", headers=headers())
    assert schema.status_code == 200
    assert schema.json()["properties"]["name"] == {"type": "string"}
    assert schema.headers["cache-control"] == "private, no-store"
    response = client.get(f"{root}/items", headers=headers(), params={"filter": "name = 'Station'"})
    assert response.status_code == 200
    assert repository.last_cql2_filter == ("name = 'Station'", "cql2-text")
    for parameters in ["filter=x&filter=y", "filter-lang=cql2-json", "filter="]:
        assert client.get(f"{root}/items?{parameters}", headers=headers()).status_code == 400
    stale = client.get(f"{root}/queryables?expected_generation=99", headers=headers())
    assert stale.status_code == 409


def shared_vertex_payload() -> dict:
    return {
        "features": [
            {"feature_id": str(FEATURE_ID), "expected_version": 1},
            {
                "feature_id": str(FEATURE_ID_2),
                "expected_version": 3,
                "lock_token": str(LOCK_TOKEN),
            },
        ],
        "from_position": [3, 1.5],
        "to_position": [3.5, 1.5],
        "change_message": "Correct shared survey boundary",
    }


def test_shared_vertex_route_binds_identity_versions_and_every_updated_head() -> None:
    repository = MemoryFeatureRepository()
    client = api_client(repository)
    client.post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/feature-collection",
        headers=headers(),
        json=multipolygon_collection_payload(),
    )
    received = []
    original = repository.features[FEATURE_ID]

    async def move(context, project_id, dataset_id, versions, before, after, message, request_id):
        received.append(
            (context, project_id, dataset_id, versions, before, after, message, request_id)
        )
        return FeatureSharedVertexMutation(
            replace(repository.collection, generation=7, feature_count=2),
            (
                replace(original, version_number=2),
                replace(original, feature_id=FEATURE_ID_2, version_number=4),
            ),
        )

    repository.move_shared_polygon_vertex = move
    url = f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features/shared-vertex"
    assert client.post(url, json=shared_vertex_payload()).status_code == 401
    assert received == []
    response = client.post(url, headers=headers(), json=shared_vertex_payload())
    assert response.status_code == 200
    result = response.json()
    assert result["operation"] == "move_shared_vertex"
    assert result["project_id"] == str(PROJECT_ID)
    assert result["dataset_id"] == str(DATASET_ID)
    assert result["collection_generation"] == 7
    assert result["feature_count"] == 2
    assert result["tombstoned_feature_ids"] == []
    assert [item["id"] for item in result["updated_features"]] == [
        str(FEATURE_ID),
        str(FEATURE_ID_2),
    ]
    assert [item["opengeo:version"] for item in result["updated_features"]] == [2, 4]
    assert received[0][0].organization_id == ORG_ID
    assert received[0][1:] == (
        PROJECT_ID,
        DATASET_ID,
        ((FEATURE_ID, 1, None), (FEATURE_ID_2, 3, LOCK_TOKEN)),
        [3.0, 1.5],
        [3.5, 1.5],
        "Correct shared survey boundary",
        "feature-edit-request-123",
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"features": [{"feature_id": str(FEATURE_ID), "expected_version": 1}]},
        {"features": shared_vertex_payload()["features"] * 11},
        {"from_position": [3]},
        {"from_position": [3, 1.5, 0]},
        {"from_position": [181, 1.5]},
        {"to_position": [3.5, -91]},
        {"to_position": [True, 1.5]},
        {"to_position": [3.5, "1.5"]},
        {"to_position": [3.5, None]},
        {"unexpected": True},
    ],
)
def test_shared_vertex_route_rejects_invalid_bounded_request_before_repository(changes) -> None:
    repository = MemoryFeatureRepository()
    received = []

    async def move(*args):
        received.append(args)
        raise AssertionError("Invalid requests may not reach the repository")

    repository.move_shared_polygon_vertex = move
    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features/shared-vertex",
        headers=headers(),
        json={**shared_vertex_payload(), **changes},
    )
    assert response.status_code == 422
    assert received == []


@pytest.mark.parametrize(
    ("error", "status_code"),
    [(FeatureConflict("feature_version_conflict", 4), 409), (FeatureAccessDenied(), 403)],
)
def test_shared_vertex_route_preserves_repository_authority_and_conflicts(
    error, status_code
) -> None:
    repository = MemoryFeatureRepository()

    async def move(*args):
        raise error

    repository.move_shared_polygon_vertex = move
    response = api_client(repository).post(
        f"/projects/{PROJECT_ID}/datasets/{DATASET_ID}/features/shared-vertex",
        headers=headers(),
        json=shared_vertex_payload(),
    )
    assert response.status_code == status_code
