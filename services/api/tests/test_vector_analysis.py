from uuid import UUID

import pytest

from opengeo_api.vector_analysis import AnalysisRequest, analysis_statement

ORG = UUID(int=1)
SOURCE = UUID(int=2)
TARGET = UUID(int=3)


@pytest.mark.parametrize(
    "operation", ["buffer", "centroid", "clip", "dissolve", "join", "intersection"]
)
def test_plans_keep_scope_generation_and_limits_in_same_snapshot(operation):
    paired = operation in {"clip", "join", "intersection"}
    request = AnalysisRequest(
        operation,
        7,
        TARGET if paired else None,
        9 if paired else None,
        100 if operation == "buffer" else None,
    )
    sql, parameters = analysis_statement(ORG, SOURCE, request)
    assert sql.count("%s") == len(parameters)
    assert parameters[:4] == (ORG, SOURCE, ORG, TARGET if paired else SOURCE)
    assert parameters[8:10] == (7, 9 if paired else 7)
    assert "source_generation=%s AND target_generation=%s" in sql
    assert sql.count("deleted_at IS NULL") == 2
    assert "LIMIT 1001" in sql and "points<=50000" in sql
    assert "bytes.size<=2097152" in sql
    assert "UPDATE " not in sql and "INSERT " not in sql
    if operation in {"join", "intersection"}:
        assert "'source',a.properties,'target',b.properties" in sql


@pytest.mark.parametrize(
    "case",
    [
        AnalysisRequest("clip", 1),
        AnalysisRequest("centroid", 1, TARGET, 1),
        AnalysisRequest("buffer", 1, distance_meters=float("nan")),
        AnalysisRequest("buffer", 1, distance_meters=-1),
        AnalysisRequest("centroid", 1, distance_meters=100),
        AnalysisRequest("centroid", 0),
    ],
)
def test_invalid_operation_shapes_fail_before_database(case):
    with pytest.raises(ValueError):
        analysis_statement(ORG, SOURCE, case)
