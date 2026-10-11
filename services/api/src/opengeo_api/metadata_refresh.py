"""Retained provider metadata candidate shared by review and atomic acceptance."""

import base64
import copy
from dataclasses import dataclass
from hashlib import sha256
from typing import Any
from uuid import UUID

from opengeo_api.resource_knowledge import validate_knowledge


@dataclass(frozen=True)
class MetadataRefresh:
    project_id: UUID
    job_id: UUID
    source_revision: int
    verified_document: dict[str, Any] | None = None


REFRESH_DOCUMENT_SQL = """
                SELECT job.source_type, job.service_url, job.collection_ref,
                       document.document, revision.version_number
                FROM app.external_source_discovery_jobs job
                JOIN app.source_discovery_documents document
                  ON document.organization_id = job.organization_id
                 AND document.discovery_job_id = job.id
                 AND document.project_id = job.project_id
                JOIN app.external_sources source
                  ON source.organization_id = job.organization_id AND source.dataset_id = %s
                JOIN LATERAL (
                  SELECT version_number, source_url, configuration
                  FROM app.external_source_revisions
                  WHERE organization_id = source.organization_id AND dataset_id = source.dataset_id
                  ORDER BY version_number DESC LIMIT 1
                ) revision ON true
                WHERE job.organization_id = %s AND job.project_id = %s AND job.id = %s
                  AND job.state = 'completed' AND job.discovery_kind = 'collection'
                  AND job.source_type = source.source_type::text
                  AND job.result->'source_definition'->>'url' = revision.source_url
                  AND (job.source_type <> 'wfs'
                       OR job.collection_ref = revision.configuration->>'type_name')
                  AND document.document->>'status' IN ('retained', 'retained_object')
                """


def append_refresh_source(
    document: dict[str, Any],
    row: tuple[Any, ...],
    job_id: UUID,
    *,
    dataset_id: UUID | None = None,
    project_id: UUID | None = None,
    verified_document: dict[str, Any] | None = None,
) -> dict[str, Any]:
    retained = row[3]
    if retained.get("status") not in {"retained", "retained_object"}:
        raise ValueError("Response bytes were not retained")
    if verified_document is not None and retained != verified_document:
        raise ValueError("Reviewed response changed")
    if retained["status"] == "retained":
        encoded = retained.get("body_base64")
        if not isinstance(encoded, str) or len(encoded) > 43_692:
            raise ValueError("Invalid retained response size")
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > 32_768 or len(raw) != retained.get("byte_length"):
            raise ValueError("Retained response size mismatch")
        checksum = sha256(raw).hexdigest()
        if checksum != retained.get("sha256"):
            raise ValueError("Retained response checksum mismatch")
        # UTF-8 preserves BOM/whitespace; unsupported encoding is never replaced.
        payload: dict[str, Any] = {"content": raw.decode("utf-8")}
    else:
        if dataset_id is None or project_id is None or verified_document is None:
            raise ValueError("Stored response requires verified Layer and source binding")
        checksum = retained["sha256"]
        payload = {
            "retainedResponse": {
                "datasetId": str(dataset_id),
                "projectId": str(project_id),
                "discoveryJobId": str(job_id),
                "sourceRevision": row[4],
                "byteLength": retained["byte_length"],
                "sha256": checksum,
            }
        }
    identifier = f"urn:opengeo:discovery:{job_id}:sha256:{checksum}"
    candidate = copy.deepcopy(document)
    if any(item["id"] == identifier for item in candidate["metadata"]["source"]):
        raise ValueError("This response is already retained in knowledge")
    candidate["metadata"]["source"].append(
        {
            "id": identifier,
            **payload,
            "mediaType": "application/json" if row[0] == "arcgis" else "application/xml",
            "sourceUrl": row[1],
            "retrievedAt": retained["retrieved_at"],
        }
    )
    return validate_knowledge(candidate)
