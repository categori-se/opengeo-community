import os
import signal
import subprocess
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from opengeo_worker.models import TransientFailure, ValidationFailure


@dataclass(frozen=True, slots=True)
class CommandResult:
    stdout: str
    stderr: str
    return_code: int = 0


class CommandRunner:
    """Execute only fixed GIS binaries with resource and output bounds."""

    def __init__(
        self,
        workspace_root: Path,
        *,
        timeout_seconds: int,
        output_bytes: int,
        executable_paths: Mapping[str, str] | None = None,
    ) -> None:
        self._workspace_root = workspace_root.resolve()
        self._timeout_seconds = timeout_seconds
        self._output_bytes = output_bytes
        self._executables = dict(
            executable_paths
            or {
                "gdalinfo": "/usr/bin/gdalinfo",
                "gdalsrsinfo": "/usr/bin/gdalsrsinfo",
                "gdal_translate": "/usr/bin/gdal_translate",
                "gdalwarp": "/usr/bin/gdalwarp",
                "clamscan": "/usr/bin/clamscan",
                "ogrinfo": "/usr/bin/ogrinfo",
                "ogr2ogr": "/usr/bin/ogr2ogr",
                "pdfdetach": "/usr/bin/pdfdetach",
                "pdfinfo": "/usr/bin/pdfinfo",
                "pdftoppm": "/usr/bin/pdftoppm",
                "pdftotext": "/usr/bin/pdftotext",
                "tesseract": "/usr/bin/tesseract",
            }
        )
        self._prlimit = Path("/usr/bin/prlimit")

    def run(
        self,
        program: str,
        arguments: Sequence[str],
        *,
        cwd: Path,
        allowed_return_codes: frozenset[int] = frozenset({0}),
        maximum_file_bytes: int = 5_368_709_120,
    ) -> CommandResult:
        executable = self._executables.get(program)
        resolved_cwd = cwd.resolve()
        if executable is None or not self._inside_workspace(resolved_cwd):
            raise ValueError("command is outside the worker boundary")
        if (
            not allowed_return_codes
            or any(code < 0 or code > 255 for code in allowed_return_codes)
            or not 1 <= maximum_file_bytes <= 5_368_709_120
            or len(arguments) > 256
            or any(
                not isinstance(argument, str) or "\x00" in argument or len(argument.encode()) > 8192
                for argument in arguments
            )
        ):
            raise ValueError("command arguments exceed the worker boundary")

        command = [executable, *arguments]
        if self._prlimit.is_file():
            command = [
                str(self._prlimit),
                "--cpu=300",
                "--as=4294967296",
                f"--fsize={maximum_file_bytes}",
                "--nproc=64",
                "--nofile=256",
                "--",
                *command,
            ]
        environment = {
            "PATH": "/usr/bin:/bin",
            "HOME": str(resolved_cwd),
            "TMPDIR": str(resolved_cwd),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "OMP_THREAD_LIMIT": "1",
            "TESSDATA_PREFIX": "/usr/share/tesseract-ocr/5/tessdata",
            "PROJ_NETWORK": "OFF",
            "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": "",
            "CPL_CURL_ENABLE_VSIMEM": "NO",
            "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
            "OGR_SQLITE_PRAGMA": "trusted_schema=OFF",
        }
        try:
            with (
                tempfile.TemporaryFile(dir=resolved_cwd) as stdout_file,
                tempfile.TemporaryFile(dir=resolved_cwd) as stderr_file,
            ):
                process = subprocess.Popen(
                    command,
                    cwd=resolved_cwd,
                    env=environment,
                    stdin=subprocess.DEVNULL,
                    stdout=stdout_file,
                    stderr=stderr_file,
                    start_new_session=True,
                    close_fds=True,
                )
                try:
                    return_code = process.wait(timeout=self._timeout_seconds)
                except subprocess.TimeoutExpired as error:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    raise ValidationFailure("gis_command_timeout") from error
                stdout = self._read_bounded(stdout_file)
                stderr = self._read_bounded(stderr_file)
        except ValidationFailure:
            raise
        except OSError as error:
            raise TransientFailure("gis_runtime_unavailable") from error
        if return_code not in allowed_return_codes:
            raise ValidationFailure(
                "gis_dataset_invalid",
                quality_results={
                    "valid": False,
                    "errors": [{"code": "gis_dataset_invalid"}],
                    "warnings": [],
                },
            )
        return CommandResult(stdout=stdout, stderr=stderr, return_code=return_code)

    def _read_bounded(self, stream: BinaryIO) -> str:
        stream.seek(0)
        content = stream.read(self._output_bytes + 1)
        if len(content) > self._output_bytes:
            raise ValidationFailure("gis_command_output_too_large")
        return content.decode("utf-8", errors="replace")

    def _inside_workspace(self, path: Path) -> bool:
        try:
            path.relative_to(self._workspace_root)
            return True
        except ValueError:
            return False
