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
    tippecanoe: str | None
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
_PMTILES_V2_SOFTWARE = ProcessingSoftware(
    worker_base_image=(
        "ghcr.io/osgeo/gdal:ubuntu-small-3.13.1@"
        "sha256:836d1646ff9ab30d7db947c7b9690de55f34c2fd7cc5af6086a0854ccb378f59"
    ),
    gdal="3.13.1",
    tippecanoe=None,
    proj_network="disabled",
)

SERVER_PROCESSING_TOOLS = (
    ServerProcessingTool(
        id="vector-to-pmtiles",
        version="1.1.0",
        title="Vector to PMTiles",
        execution_mode="activation-only-server-job",
        deterministic=True,
        request_schema_version="opengeo.pmtiles-derivative-request.1.1.0",
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
            ProcessingParameter(id="options", type="closed-pmtiles-v2-options", required=True),
        ),
        output=_OUTPUT,
        limits={
            "maximumSourceBytes": 536_870_912,
            "maximumRetainedJobs": 64,
            "maximumActiveJobs": 4,
            "networkAccess": "disabled",
            "recipe": "gdal-pmtiles-v2",
            "adaptiveGeneralization": True,
            "runtimeImagePin": "immutable-per-job",
        },
        software=_PMTILES_V2_SOFTWARE,
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


def processing_registry(
    *,
    pmtiles_input_formats: frozenset[str] = frozenset({"geojson"}),
    pmtiles_admission: dict[str, bool | str] | None = None,
) -> ProcessingRegistryResponse:
    admission = pmtiles_admission or {"ready": False, "reason": "runtime_not_configured"}
    return ProcessingRegistryResponse(
        schema_version=PROCESSING_REGISTRY_SCHEMA_VERSION,
        tools=tuple(
            tool.model_copy(
                update={
                    "limits": {
                        **tool.limits,
                        "inputFormats": ",".join(sorted(pmtiles_input_formats)),
                        "admissionReady": admission["ready"],
                        "admissionReason": admission["reason"],
                    }
                }
            )
            if tool.id == "vector-to-pmtiles"
            else tool
            for tool in SERVER_PROCESSING_TOOLS
        ),
    )
