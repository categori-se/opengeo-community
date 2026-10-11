from typing import Literal

from pydantic import BaseModel, ConfigDict

PROCESSING_REGISTRY_SCHEMA_VERSION = "opengeo.server-processing-registry.1.0.0"


class ProcessingParameter(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str
    type: str
    required: bool
    minimum: int | None = None
    maximum: int | None = None
    values: tuple[str, ...] | None = None


class ProcessingOutput(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["immutable-object"]
    durable: Literal[True]
    lineage: Literal["database-record"]


class ProcessingSoftware(BaseModel):
    model_config = ConfigDict(frozen=True)

    worker_base_image: str
    gdal: str
    tippecanoe: str
    proj_network: Literal["disabled"]


class ServerProcessingTool(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str
    version: str
    title: str
    execution_mode: Literal["activation-only-server-job"]
    deterministic: Literal[True]
    request_schema_version: str
    endpoint: str
    parameters: tuple[ProcessingParameter, ...]
    output: ProcessingOutput
    limits: dict[str, int | bool | str]
    software: ProcessingSoftware
    ordinary_reads_create_work: Literal[False]


class ProcessingRegistryResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: str
    tools: tuple[ServerProcessingTool, ...]


_SOFTWARE = ProcessingSoftware(
    worker_base_image=(
        "ghcr.io/osgeo/gdal:ubuntu-full-3.13.0@"
        "sha256:83d114a6891ae18aa175d81a14c92a96d23944667b36fde9c15c4a10215d8939"
    ),
    gdal="3.13.0",
    tippecanoe="2.79.0",
    proj_network="disabled",
)
_OUTPUT = ProcessingOutput(kind="immutable-object", durable=True, lineage="database-record")

SERVER_PROCESSING_TOOLS = (
    ServerProcessingTool(
        id="vector-to-pmtiles",
        version="1.0.0",
        title="Vector to PMTiles",
        execution_mode="activation-only-server-job",
        deterministic=True,
        request_schema_version="opengeo.pmtiles-derivative-request.1.0.0",
        endpoint=(
            "/projects/{project_id}/datasets/{dataset_id}/versions/"
            "{dataset_version_id}/pmtiles-derivatives"
        ),
        parameters=(
            ProcessingParameter(id="datasetVersionId", type="uuid", required=True),
            ProcessingParameter(id="bounds", type="crs84-bbox", required=True),
            ProcessingParameter(id="minZoom", type="integer", required=True, minimum=0, maximum=22),
            ProcessingParameter(id="maxZoom", type="integer", required=True, minimum=0, maximum=22),
            ProcessingParameter(id="sourceLayer", type="identifier", required=True),
        ),
        output=_OUTPUT,
        limits={
            "maximumSourceBytes": 536_870_912,
            "maximumRetainedJobs": 64,
            "maximumActiveJobs": 4,
            "networkAccess": "disabled",
        },
        software=_SOFTWARE,
        ordinary_reads_create_work=False,
    ),
    ServerProcessingTool(
        id="raster-to-cog",
        version="1.0.0",
        title="Raster to COG",
        execution_mode="activation-only-server-job",
        deterministic=True,
        request_schema_version="opengeo.coverage-derivative-request.2.0.0",
        endpoint=(
            "/projects/{project_id}/spatial-services/{service_id}/coverages/"
            "{coverage_id}/derivatives"
        ),
        parameters=(
            ProcessingParameter(id="coverageId", type="uuid", required=True),
            ProcessingParameter(id="subset", type="source-crs-bbox", required=True),
            ProcessingParameter(id="bands", type="integer-array", required=False),
            ProcessingParameter(id="targetCrs", type="epsg-code", required=False),
            ProcessingParameter(id="size", type="pixel-size", required=False),
            ProcessingParameter(id="resolution", type="source-crs-resolution", required=False),
            ProcessingParameter(
                id="resampling",
                type="choice",
                required=True,
                values=("nearest", "bilinear", "cubic"),
            ),
        ),
        output=_OUTPUT,
        limits={
            "maximumSourceBytes": 536_870_912,
            "maximumAxisPixels": 8_192,
            "maximumPixels": 16_777_216,
            "maximumSamples": 67_108_864,
            "maximumRetainedJobs": 64,
            "maximumActiveJobs": 4,
            "networkAccess": "disabled",
        },
        software=_SOFTWARE,
        ordinary_reads_create_work=False,
    ),
)


def processing_registry() -> ProcessingRegistryResponse:
    return ProcessingRegistryResponse(
        schema_version=PROCESSING_REGISTRY_SCHEMA_VERSION,
        tools=SERVER_PROCESSING_TOOLS,
    )
