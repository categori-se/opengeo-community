"""Operator-configured delivery targets, never browser-supplied AWS authority."""

import json
import re
from dataclasses import dataclass
from typing import Any

from opengeo_api.framework_publication_aws import CloudFrontPublicationEdge, S3PublicationStorage
from opengeo_api.framework_publisher import PublicationConflict

PROTECTED_STUDIO_HOSTS = (
    "studio.opengeo.tools",
    "preview.studio.opengeo.tools",
    "maps-preview.studio.opengeo.tools",
    "demo.studio.opengeo.tools",
)


def configured_destination_router(aws: Any, settings: Any) -> Any:
    """Load only deployment configuration; retain the legacy path when unset."""
    raw = settings.framework_publication_destinations
    if raw is None:
        return None
    try:
        records = json.loads(raw)
        protected = json.loads(settings.framework_publication_protected_hosts or "[]")
        if (
            not isinstance(records, list)
            or not 1 <= len(records) <= 12
            or not isinstance(protected, list)
            or len(protected) > 32
            or any(type(host) is not str or not host for host in protected)
        ):
            raise ValueError()
        fields = {"hostname", "bucket", "distribution_id", "origin_id"}
        if any(
            not isinstance(item, dict)
            or not fields <= set(item)
            or set(item) - fields - {"origin_access_control_id"}
            or any(type(value) is not str for value in item.values())
            for item in records
        ):
            raise ValueError()
        destinations = tuple(PublicationDestination(**item) for item in records)
        # Existing queued jobs must keep their explicitly configured delivery target.
        if not any(
            item.bucket == settings.framework_publication_public_bucket
            and item.distribution_id == settings.framework_publication_distribution_id
            for item in destinations
        ):
            raise ValueError()
        return PublicationDestinationRouter(
            aws,
            settings.application_bucket,
            destinations,
            protected_hosts=(*PROTECTED_STUDIO_HOSTS, *protected),
        )
    except (ValueError, TypeError, KeyError) as error:
        raise ValueError("Invalid publication destination configuration") from error


@dataclass(frozen=True)
class PublicationDestination:
    hostname: str
    bucket: str
    distribution_id: str
    origin_id: str
    origin_access_control_id: str = ""


class PublicationDestinationRouter:
    """Match the complete claimed origin to a small, explicit deployment allowlist.

    This does not provision hosting or grant IAM access. The worker deployment
    must separately authorize exactly these resources. Never construct this
    allowlist from a queue message, source file, or mutable publication draft.
    """

    def __init__(
        self,
        aws: Any,
        source_bucket: str,
        destinations: tuple[PublicationDestination, ...],
        *,
        protected_hosts: tuple[str, ...],
    ) -> None:
        if not 1 <= len(destinations) <= 12 or not protected_hosts:
            raise ValueError("Invalid publication destination configuration")
        self._targets = {}
        hosts = set()
        distributions = set()
        for destination in destinations:
            if (
                not re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)*", destination.hostname)
                or "." not in destination.hostname
                or destination.hostname in protected_hosts
                or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", destination.bucket)
                or destination.bucket == source_bucket
                or not re.fullmatch(r"[A-Z0-9]{1,32}", destination.distribution_id)
                or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", destination.origin_id)
                or (
                    destination.origin_access_control_id
                    and not re.fullmatch(r"[A-Z0-9]{1,32}", destination.origin_access_control_id)
                )
                or destination.hostname in hosts
                or destination.distribution_id in distributions
            ):
                raise ValueError("Invalid publication destination configuration")
            hosts.add(destination.hostname)
            distributions.add(destination.distribution_id)
            key = (
                destination.hostname,
                destination.bucket,
                destination.distribution_id,
                destination.origin_id,
            )
            self._targets[key] = (
                destination.bucket,
                S3PublicationStorage(
                    aws,
                    source_bucket,
                    destination.bucket,
                    private_origin=bool(destination.origin_access_control_id),
                ),
                CloudFrontPublicationEdge(
                    aws,
                    destination.distribution_id,
                    origin_access_control_id=destination.origin_access_control_id,
                ),
            )

    def resolve(self, origin: dict[str, Any]) -> tuple[str, Any, Any]:
        keys = ("hostname", "bucket", "distribution_id", "origin_id")
        if not isinstance(origin, dict) or any(type(origin.get(key)) is not str for key in keys):
            raise PublicationConflict("publication_destination_scope_invalid")
        target = self._targets.get(tuple(origin[key] for key in keys))
        if target is None:
            raise PublicationConflict("publication_destination_scope_invalid")
        return target
