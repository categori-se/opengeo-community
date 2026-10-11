"""Authenticated dataset-scoped WFS 2.0 and single-operation WFS-T routes."""

from __future__ import annotations

import re
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response

from opengeo_api.auth_models import AuthSession
from opengeo_api.auth_routes import current_session
from opengeo_api.feature_routes import repository_from_request
from opengeo_api.features import (
    FeatureAccessDenied,
    FeatureConflict,
    FeatureInvalid,
    FeatureNotFound,
    FeaturePage,
    FeatureQueryStep,
    FeatureRepository,
    FeatureStoreUnavailable,
    feature_draft,
    normalize_properties,
)
from opengeo_api.logging import get_request_id
from opengeo_api.resource_routes import tenant_context
from opengeo_api.wfs import (
    MAX_GET_FEATURE_BYTES,
    MAX_TRANSACTION_BYTES,
    OPENGEO_NAMESPACE,
    WFS_1_1_EPSG4326,
    WFS_1_1_SRS_NAMES,
    WFS_1_1_VERSION,
    WFS_CRS84,
    WFS_CRS84_ALIASES,
    WFS_GET_FEATURE_BY_ID_IDS,
    WFS_VERSION,
    InsertCommand,
    UpdateCommand,
    WfsRequestError,
    capabilities_document,
    describe_feature_type_document,
    describe_stored_queries_document,
    exception_report,
    feature_collection_geojson,
    feature_collection_gml,
    feature_collection_gml2,
    feature_gml,
    feature_type_name,
    list_stored_queries_document,
    parse_bbox,
    parse_get_feature_request,
    parse_resource_id,
    parse_transaction,
    parse_wfs_1_1_bbox,
    transaction_response,
    xml_request_operation,
)

router = APIRouter(tags=["WFS 2.0 compatibility"])
WFS_MEDIA_TYPE = "application/gml+xml; version=3.2"
WFS_XML_MEDIA_TYPE = "application/xml"
_PRIVATE_HEADERS = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Vary": "Authorization, X-OpenGeo-Organization, Accept",
}
_KVP_NAMES = frozenset(
    {
        "service",
        "request",
        "version",
        "acceptversions",
        "typenames",
        "typename",
        "outputformat",
        "count",
        "maxfeatures",
        "namespaces",
        "startindex",
        "bbox",
        "resourceid",
        "srsname",
        "resulttype",
        "storedquery_id",
        "id",
    }
)


@router.get("/projects/{project_id}/datasets/{dataset_id}/wfs")
async def wfs_get(
    project_id: UUID,
    dataset_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> Response:
    try:
        parameters = _parameters(request)
        _require_service(parameters)
        operation = parameters.get("request", "GetCapabilities").casefold()
        if operation == "getcapabilities":
            _require_capabilities_version(parameters)
            collection = (
                await _list(repository, session, project_id, dataset_id, limit=1)
            ).collection
            return _xml(
                capabilities_document(
                    str(request.url_for("wfs_get", project_id=project_id, dataset_id=dataset_id)),
                    project_id,
                    dataset_id,
                    collection,
                )
            )
        if operation == "getfeature":
            _require_read_version(parameters)
            if "storedquery_id" not in parameters:
                _require_type_name(parameters)
            return await _get_feature(repository, session, project_id, dataset_id, parameters)
        _require_version(parameters)
        if operation == "describefeaturetype":
            _require_type_name(parameters, required=False)
            collection = (
                await _list(repository, session, project_id, dataset_id, limit=1)
            ).collection
            return _xml(
                describe_feature_type_document(project_id, dataset_id, collection),
                media_type="application/xml",
            )
        if operation == "liststoredqueries":
            _require_only(
                parameters,
                {"service", "request", "version"},
                "ListStoredQueries",
            )
            await _list(repository, session, project_id, dataset_id, limit=1)
            return _xml(list_stored_queries_document())
        if operation == "describestoredqueries":
            _require_only(
                parameters,
                {"service", "request", "version", "storedquery_id"},
                "DescribeStoredQueries",
            )
            await _list(repository, session, project_id, dataset_id, limit=1)
            return _xml(
                describe_stored_queries_document(
                    _stored_query_ids(parameters.get("storedquery_id"))
                )
            )
        raise WfsRequestError(
            "OperationNotSupported",
            "request",
            "supported GET operations are GetCapabilities, DescribeFeatureType, "
            "ListStoredQueries, DescribeStoredQueries, and GetFeature",
        )
    except WfsRequestError as error:
        return _error(error)
    except Exception as error:
        return _feature_error(error)


@router.post("/projects/{project_id}/datasets/{dataset_id}/wfs")
async def wfs_post(
    project_id: UUID,
    dataset_id: UUID,
    request: Request,
    session: Annotated[AuthSession, Depends(current_session)],
    repository: Annotated[FeatureRepository, Depends(repository_from_request)],
) -> Response:
    try:
        if request.query_params:
            parameters = _parameters(request)
            _require_service(parameters)
            if parameters.get("request", "").casefold() not in {"", "transaction"}:
                raise WfsRequestError(
                    "OperationNotSupported", "request", "POST supports WFS Transaction only"
                )
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type not in {"application/xml", "text/xml", "application/gml+xml"}:
            raise WfsRequestError(
                "InvalidParameterValue",
                "Content-Type",
                "transaction content type must be XML",
                status_code=415,
            )
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                declared_length = int(content_length)
            except ValueError as error:
                raise WfsRequestError(
                    "InvalidParameterValue", "Content-Length", "content length is invalid"
                ) from error
            if declared_length < 1 or declared_length > MAX_TRANSACTION_BYTES:
                raise WfsRequestError(
                    "OperationParsingFailed",
                    "body",
                    "transaction body is empty or too large",
                    status_code=413,
                )
        body = await request.body()
        if xml_request_operation(body) == "GetFeature":
            if len(body) > MAX_GET_FEATURE_BYTES:
                raise WfsRequestError(
                    "OperationParsingFailed",
                    "body",
                    "GetFeature body is empty or too large",
                    status_code=413,
                )
            collection = (
                await _list(repository, session, project_id, dataset_id, limit=1)
            ).collection
            parsed = parse_get_feature_request(body, collection)
            return await _get_feature(
                repository,
                session,
                project_id,
                dataset_id,
                parsed.parameters,
                query_steps=parsed.query_steps,
            )
        page = await _list(repository, session, project_id, dataset_id, limit=1)
        command = parse_transaction(body, page.collection)
        context = tenant_context(session)
        request_id = get_request_id()
        if isinstance(command, InsertCommand):
            mutation = await repository.create_feature(
                context,
                project_id,
                dataset_id,
                command.draft,
                f"WFS {command.version} Transaction insert",
                request_id,
            )
            response = transaction_response(
                command,
                feature_id=mutation.feature.feature_id,
                collection_generation=mutation.collection.generation,
                feature_version=mutation.feature.version_number,
            )
        elif isinstance(command, UpdateCommand):
            current = await repository.get_feature(
                context, project_id, dataset_id, command.feature_id
            )
            expected_version = command.expected_version or current.version_number
            properties = normalize_properties(
                {**current.properties, **command.properties}, page.collection.fields
            )
            draft = feature_draft(
                current.geometry if command.geometry is None else command.geometry,
                properties,
                page.collection.fields,
                command.feature_id,
            )
            mutation = await repository.update_feature(
                context,
                project_id,
                dataset_id,
                command.feature_id,
                expected_version,
                draft,
                f"WFS {command.version} Transaction update",
                request_id,
            )
            response = transaction_response(
                command,
                feature_id=mutation.feature.feature_id,
                collection_generation=mutation.collection.generation,
                feature_version=mutation.feature.version_number,
            )
        else:
            current = await repository.get_feature(
                context, project_id, dataset_id, command.feature_id
            )
            deletion = await repository.delete_feature(
                context,
                project_id,
                dataset_id,
                command.feature_id,
                command.expected_version or current.version_number,
                f"WFS {command.version} Transaction delete",
                request_id,
            )
            response = transaction_response(
                command,
                feature_id=deletion.feature_id,
                collection_generation=deletion.collection_generation,
                feature_version=deletion.deleted_version,
            )
        return _xml(response)
    except WfsRequestError as error:
        return _error(error)
    except Exception as error:
        return _feature_error(error)


async def _get_feature(
    repository: FeatureRepository,
    session: AuthSession,
    project_id: UUID,
    dataset_id: UUID,
    parameters: dict[str, str],
    *,
    query_steps: tuple[FeatureQueryStep, ...] = (),
) -> Response:
    version = parameters.get("version")
    legacy = version == WFS_1_1_VERSION
    srs_name = parameters.get("srsname", WFS_1_1_EPSG4326 if legacy else WFS_CRS84)
    allowed_srs_names = WFS_1_1_SRS_NAMES if legacy else WFS_CRS84_ALIASES
    if srs_name not in allowed_srs_names:
        message = "WFS 1.1 requires EPSG:4326 or EPSG:3857" if legacy else "only CRS84 is supported"
        raise WfsRequestError("InvalidParameterValue", "srsName", message)
    if parameters.get("resulttype", "results").casefold() != "results":
        raise WfsRequestError("OptionNotSupported", "resultType", "resultType must be results")
    stored_query_id = parameters.get("storedquery_id")
    if legacy and stored_query_id is not None:
        raise WfsRequestError(
            "OptionNotSupported", "storedquery_id", "stored queries require WFS 2.0"
        )
    if stored_query_id is None:
        _require_only(
            parameters,
            {
                "service",
                "request",
                "version",
                "typenames",
                "typename",
                "namespaces",
                "outputformat",
                "maxfeatures" if legacy else "count",
                "bbox",
                "srsname",
                "resulttype",
                *(() if legacy else ("startindex", "resourceid")),
            },
            "WFS 1.1 GetFeature" if legacy else "WFS 2.0 GetFeature",
        )
    if stored_query_id is not None:
        if stored_query_id not in WFS_GET_FEATURE_BY_ID_IDS:
            raise WfsRequestError(
                "InvalidParameterValue",
                "storedquery_id",
                "stored query identifier is not supported",
            )
        _require_only(
            parameters,
            {
                "service",
                "request",
                "version",
                "storedquery_id",
                "id",
                "outputformat",
                "count",
                "startindex",
                "srsname",
                "resulttype",
            },
            "GetFeatureById",
        )
        if not parameters.get("id"):
            raise WfsRequestError(
                "MissingParameterValue", "id", "GetFeatureById requires one feature id"
            )
    elif "id" in parameters:
        raise WfsRequestError(
            "InvalidParameterValue", "id", "id requires the GetFeatureById stored query"
        )
    if "count" in parameters and "maxfeatures" in parameters:
        raise WfsRequestError(
            "InvalidParameterValue", "count", "count and maxFeatures cannot be combined"
        )
    count = _integer(
        parameters.get("maxfeatures") if legacy else parameters.get("count"),
        "count",
        default=1 if stored_query_id else 20,
        minimum=1,
        maximum=100,
    )
    if legacy and "startindex" in parameters:
        raise WfsRequestError(
            "OptionNotSupported", "startIndex", "the bounded WFS 1.1 profile does not page"
        )
    start_index = _integer(
        parameters.get("startindex"), "startIndex", default=0, minimum=0, maximum=10_000
    )
    if stored_query_id is not None and start_index != 0:
        raise WfsRequestError(
            "InvalidParameterValue",
            "startIndex",
            "GetFeatureById startIndex must be zero",
        )
    resource_id = parameters.get("id") if stored_query_id else parameters.get("resourceid")
    if query_steps and resource_id is not None:
        raise WfsRequestError(
            "InvalidParameterValue", "filter", "ResourceId cannot be combined with query predicates"
        )
    if resource_id is not None:
        if parameters.get("bbox") is not None or start_index:
            raise WfsRequestError(
                "InvalidParameterValue",
                "resourceId",
                "resourceId cannot be combined with bbox or startIndex",
            )
        record = await repository.get_feature(
            tenant_context(session), project_id, dataset_id, parse_resource_id(resource_id)
        )
        collection = (await _list(repository, session, project_id, dataset_id, limit=1)).collection
        page = FeaturePage(collection, (record,), 1, count, 0)
    elif query_steps:
        if parameters.get("bbox") is not None:
            raise WfsRequestError(
                "InvalidParameterValue", "bbox", "bbox cannot be combined with XML predicates"
            )
        page = await repository.query_features(
            tenant_context(session),
            project_id,
            dataset_id,
            steps=query_steps,
            limit=count,
            offset=start_index,
        )
    else:
        page = await _list(
            repository,
            session,
            project_id,
            dataset_id,
            bbox=(
                parse_wfs_1_1_bbox(parameters.get("bbox"), srs_name)
                if legacy
                else parse_bbox(parameters.get("bbox"))
            ),
            limit=count,
            offset=start_index,
        )
    output_format = parameters.get(
        "outputformat",
        "text/xml; subtype=gml/2.1.2" if legacy else WFS_MEDIA_TYPE,
    ).casefold()
    if output_format in {"application/json", "application/geo+json", "json"}:
        return JSONResponse(
            feature_collection_geojson(page),
            media_type="application/geo+json",
            headers=_PRIVATE_HEADERS,
        )
    if legacy:
        if output_format not in {
            "text/xml; subtype=gml/2.1.2",
            'text/xml; subtype="gml/2.1.2"',
            "gml2",
        }:
            raise WfsRequestError(
                "InvalidParameterValue",
                "outputFormat",
                "WFS 1.1 output format must be GML 2.1.2 or GeoJSON",
            )
        return _xml(
            feature_collection_gml2(
                page,
                srs_name=srs_name,
            ),
            media_type="text/xml; subtype=gml/2.1.2",
        )
    if output_format not in {
        WFS_MEDIA_TYPE.casefold(),
        "text/xml; subtype=gml/3.2.1",
        "gml32",
    }:
        raise WfsRequestError(
            "InvalidParameterValue", "outputFormat", "output format must be GML 3.2 or GeoJSON"
        )
    if stored_query_id is not None:
        return _xml(feature_gml(page.features[0]), media_type=WFS_MEDIA_TYPE)
    return _xml(feature_collection_gml(project_id, dataset_id, page), media_type=WFS_MEDIA_TYPE)


async def _list(
    repository: FeatureRepository,
    session: AuthSession,
    project_id: UUID,
    dataset_id: UUID,
    *,
    bbox: tuple[float, float, float, float] | None = None,
    limit: int,
    offset: int = 0,
) -> FeaturePage:
    return await repository.list_features(
        tenant_context(session),
        project_id,
        dataset_id,
        bbox=bbox,
        limit=limit,
        offset=offset,
    )


def _parameters(request: Request) -> dict[str, str]:
    if len(request.query_params.multi_items()) > 20:
        raise WfsRequestError("InvalidParameterValue", "query", "too many query parameters")
    parameters: dict[str, str] = {}
    for raw_name, value in request.query_params.multi_items():
        name = raw_name.casefold()
        if name not in _KVP_NAMES:
            raise WfsRequestError(
                "InvalidParameterValue", raw_name[:100], "query parameter is unsupported"
            )
        if name in parameters:
            raise WfsRequestError(
                "InvalidParameterValue", raw_name[:100], "query parameter is duplicated"
            )
        if len(raw_name) > 100 or len(value) > 1_000:
            raise WfsRequestError(
                "InvalidParameterValue", raw_name[:100], "query parameter is too large"
            )
        parameters[name] = value
    return parameters


def _require_service(parameters: dict[str, str]) -> None:
    if "service" not in parameters:
        raise WfsRequestError("MissingParameterValue", "service", "service is required")
    if parameters["service"].upper() != "WFS":
        raise WfsRequestError("InvalidParameterValue", "service", "service must be WFS")


def _require_capabilities_version(parameters: dict[str, str]) -> None:
    versions = parameters.get("acceptversions")
    if versions is not None and WFS_VERSION not in versions.split(","):
        raise WfsRequestError("VersionNegotiationFailed", "acceptVersions", "WFS 2.0.0 is required")
    version = parameters.get("version")
    if version is not None and version != WFS_VERSION:
        raise WfsRequestError("VersionNegotiationFailed", "version", "WFS 2.0.0 is required")


def _require_version(parameters: dict[str, str]) -> None:
    if parameters.get("version") != WFS_VERSION:
        raise WfsRequestError("VersionNegotiationFailed", "version", "WFS version must be 2.0.0")


def _require_read_version(parameters: dict[str, str]) -> None:
    if parameters.get("version") not in {WFS_VERSION, WFS_1_1_VERSION}:
        raise WfsRequestError(
            "VersionNegotiationFailed",
            "version",
            "GetFeature requires WFS 2.0.0 or the bounded GeoMoose WFS 1.1.0 profile",
        )


def _require_type_name(parameters: dict[str, str], *, required: bool = True) -> None:
    if "typenames" in parameters and "typename" in parameters:
        raise WfsRequestError(
            "InvalidParameterValue",
            "typeNames",
            "typeName and typeNames cannot be combined",
        )
    value = parameters.get("typenames") or parameters.get("typename")
    if value is None and not required:
        return
    if value in {"features", feature_type_name()}:
        return
    prefix, separator, local_name = (value or "").partition(":")
    bindings = _namespace_bindings(parameters.get("namespaces"))
    if not separator or local_name != "features" or bindings.get(prefix) != OPENGEO_NAMESPACE:
        raise WfsRequestError(
            "InvalidParameterValue", "typeNames", "typeNames must be opengeo:features"
        )


_NAMESPACE_DECLARATION = re.compile(r"xmlns\(([A-Za-z_][A-Za-z0-9_.-]*),([^(),\s]+)\)")


def _namespace_bindings(value: str | None) -> dict[str, str]:
    """Parse the bounded WFS 2.0 NAMESPACES KVP without expanding authority."""
    if value is None:
        return {}
    bindings: dict[str, str] = {}
    position = 0
    while position < len(value):
        match = _NAMESPACE_DECLARATION.match(value, position)
        if match is None:
            raise WfsRequestError(
                "InvalidParameterValue", "namespaces", "namespace declaration is invalid"
            )
        prefix, namespace = match.groups()
        if prefix in bindings:
            raise WfsRequestError(
                "InvalidParameterValue", "namespaces", "namespace prefix is duplicated"
            )
        bindings[prefix] = namespace
        if len(bindings) > 16:
            raise WfsRequestError(
                "InvalidParameterValue", "namespaces", "too many namespace declarations"
            )
        position = match.end()
        if position == len(value):
            break
        if value[position] != ",":
            raise WfsRequestError(
                "InvalidParameterValue", "namespaces", "namespace separator is invalid"
            )
        position += 1
    if not bindings:
        raise WfsRequestError(
            "InvalidParameterValue", "namespaces", "namespace declaration is empty"
        )
    return bindings


def _require_only(parameters: dict[str, str], allowed: set[str], operation: str) -> None:
    unsupported = sorted(set(parameters) - allowed)
    if unsupported:
        raise WfsRequestError(
            "InvalidParameterValue",
            unsupported[0],
            f"{unsupported[0]} is not valid for {operation}",
        )


def _stored_query_ids(value: str | None) -> tuple[str, ...]:
    if value is None:
        return ()
    identifiers = tuple(item.strip() for item in value.split(","))
    if not identifiers or len(identifiers) > 8 or any(not item for item in identifiers):
        raise WfsRequestError(
            "InvalidParameterValue",
            "storedquery_id",
            "stored query identifiers are invalid",
        )
    if len(set(identifiers)) != len(identifiers):
        raise WfsRequestError(
            "InvalidParameterValue",
            "storedquery_id",
            "stored query identifiers must be unique",
        )
    return identifiers


def _integer(
    value: str | None,
    locator: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError as error:
        raise WfsRequestError(
            "InvalidParameterValue", locator, "value must be an integer"
        ) from error
    if str(parsed) != value or not minimum <= parsed <= maximum:
        raise WfsRequestError("InvalidParameterValue", locator, "integer is outside bounds")
    return parsed


def _xml(body: bytes, *, media_type: str = WFS_XML_MEDIA_TYPE, status_code: int = 200) -> Response:
    return Response(body, status_code=status_code, media_type=media_type, headers=_PRIVATE_HEADERS)


def _error(error: WfsRequestError) -> Response:
    return _xml(
        exception_report(error.code, error.locator, error.message),
        status_code=error.status_code,
    )


def _feature_error(error: Exception) -> Response:
    if isinstance(error, FeatureAccessDenied):
        return _error(
            WfsRequestError(
                "OperationProcessingFailed", "authorization", "action is forbidden", status_code=403
            )
        )
    if isinstance(error, FeatureNotFound):
        return _error(
            WfsRequestError(
                "InvalidParameterValue",
                error.resource,
                "feature resource was not found",
                status_code=404,
            )
        )
    if isinstance(error, FeatureConflict):
        message = error.code
        if error.current_version is not None:
            message = f"{message}; current version is {error.current_version}"
        return _error(
            WfsRequestError("OperationProcessingFailed", "Transaction", message, status_code=409)
        )
    if isinstance(error, FeatureInvalid):
        return _error(
            WfsRequestError("InvalidParameterValue", "feature", str(error), status_code=422)
        )
    if isinstance(error, FeatureStoreUnavailable):
        return _error(
            WfsRequestError(
                "NoApplicableCode", "store", "feature store is unavailable", status_code=503
            )
        )
    raise error
