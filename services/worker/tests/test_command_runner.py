from pathlib import Path

import pytest

from opengeo_worker.command_runner import CommandRunner
from opengeo_worker.models import ValidationFailure


def test_runs_only_allowlisted_absolute_executable_with_minimal_environment(tmp_path: Path) -> None:
    runner = CommandRunner(
        tmp_path,
        timeout_seconds=10,
        output_bytes=1000,
        executable_paths={"tool": "/usr/bin/env"},
    )
    result = runner.run("tool", [], cwd=tmp_path)

    assert "PROJ_NETWORK=OFF" in result.stdout
    assert "OMP_THREAD_LIMIT=1" in result.stdout
    assert "TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata" in result.stdout
    assert "AWS_SECRET_ACCESS_KEY" not in result.stdout
    assert "OPEN_GEO_DB_PASSWORD" not in result.stdout


def test_rejects_programs_and_working_directories_outside_boundary(tmp_path: Path) -> None:
    runner = CommandRunner(
        tmp_path,
        timeout_seconds=10,
        output_bytes=100,
        executable_paths={"tool": "/usr/bin/true"},
    )
    with pytest.raises(ValueError, match="outside"):
        runner.run("unknown", [], cwd=tmp_path)
    with pytest.raises(ValueError, match="outside"):
        runner.run("tool", [], cwd=Path("/"))
    with pytest.raises(ValueError, match="boundary"):
        runner.run("tool", [], cwd=tmp_path, maximum_file_bytes=0)


def test_rejects_unbounded_output(tmp_path: Path) -> None:
    runner = CommandRunner(
        tmp_path,
        timeout_seconds=10,
        output_bytes=3,
        executable_paths={"tool": "/usr/bin/printf"},
    )
    with pytest.raises(ValidationFailure, match="gis_command_output_too_large"):
        runner.run("tool", ["four"], cwd=tmp_path)


def test_returns_an_explicit_allowlisted_nonzero_status_for_bounded_scanners(
    tmp_path: Path,
) -> None:
    runner = CommandRunner(
        tmp_path,
        timeout_seconds=10,
        output_bytes=100,
        executable_paths={"tool": "/usr/bin/false"},
    )

    result = runner.run("tool", [], cwd=tmp_path, allowed_return_codes=frozenset({0, 1}))

    assert result.return_code == 1
