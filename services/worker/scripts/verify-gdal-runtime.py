"""Verify the full base-image driver inventory and the rebuilt OpenEXR plugin."""

import argparse
import ctypes
import json
import math
import struct
import subprocess
import tempfile
from pathlib import Path


def inventory() -> dict:
    from osgeo import gdal

    gdal.UseExceptions()
    drivers = {}
    for index in range(gdal.GetDriverCount()):
        driver = gdal.GetDriver(index)
        metadata = driver.GetMetadata()
        drivers[driver.ShortName] = {
            key: value
            for key, value in sorted(metadata.items())
            if key.startswith("DCAP_") or key == "DMD_LONGNAME"
        }
    return {"gdalVersion": gdal.VersionInfo("RELEASE_NAME"), "drivers": drivers}


def check_inventory(expected: dict, actual: dict) -> None:
    if expected["gdalVersion"] != actual["gdalVersion"]:
        raise RuntimeError("GDAL version changed during the dependency repair")
    if len(expected["drivers"]) < 200 or "EXR" not in expected["drivers"]:
        raise RuntimeError("baseline is not the full GDAL image")
    if expected["drivers"] != actual["drivers"]:
        changed = sorted(
            name
            for name in expected["drivers"].keys() | actual["drivers"].keys()
            if expected["drivers"].get(name) != actual["drivers"].get(name)
        )
        raise RuntimeError(f"GDAL driver capability drift: {changed}")


def check_openexr() -> None:
    # Check the actual library, not a hand-written package version or a symlink
    # pretending that an incompatible ABI has the old library's SONAME.
    library = ctypes.CDLL("/opt/opengeo-openexr/lib/libOpenEXRCore-3_4.so.33")
    library.exr_get_library_version.argtypes = [
        ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_char_p),
    ]
    library.exr_get_library_version.restype = None
    major, minor, patch = ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
    extra = ctypes.c_char_p()
    library.exr_get_library_version(
        ctypes.byref(major), ctypes.byref(minor), ctypes.byref(patch), ctypes.byref(extra)
    )
    if (major.value, minor.value, patch.value) != (3, 4, 15):
        raise RuntimeError("unexpected OpenEXR runtime version")
    package = subprocess.check_output(
        ["dpkg-query", "-W", "-f=${Version}", "opengeo-openexr"], text=True, timeout=30
    )
    if package != "3.4.15-1opengeo1":
        raise RuntimeError("OpenEXR package inventory does not match the actual library")
    old_libraries = list(Path("/usr/lib").glob("**/libOpenEXR*-3_1.so*"))
    if old_libraries:
        raise RuntimeError("unpatched OpenEXR libraries remain in the runtime")
    plugins = list(Path("/usr/lib").glob("*/gdalplugins/gdal_EXR.so"))
    if len(plugins) != 1:
        raise RuntimeError("expected exactly one installed GDAL EXR plugin")
    links = subprocess.run(
        ["ldd", str(plugins[0])], capture_output=True, text=True, check=True, timeout=30
    ).stdout
    if (
        "not found" in links
        or "libOpenEXR-3_4.so.33 => /opt/opengeo-openexr/lib/" not in links
        or "libOpenEXR-3_1" in links
    ):
        raise RuntimeError("GDAL EXR plugin is not linked to the repaired library")


def check_roundtrips(directory: Path) -> int:
    from osgeo import gdal, osr

    gdal.UseExceptions()
    reference = osr.SpatialReference()
    reference.ImportFromEPSG(4326)
    reference.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    transform = (-72.0, 0.01, 0.0, 43.0, 0.0, -0.01)
    cases = 0
    for pixel_type, data_type, encoding in (
        ("HALF", gdal.GDT_Float32, "f"),
        ("FLOAT", gdal.GDT_Float32, "f"),
        ("UINT", gdal.GDT_UInt32, "I"),
    ):
        source = gdal.GetDriverByName("MEM").Create("", 16, 16, 1, data_type)
        source.SetGeoTransform(transform)
        source.SetSpatialRef(reference)
        pixels = struct.pack(f"=256{encoding}", *(index % 16 for index in range(256)))
        source.GetRasterBand(1).WriteRaster(0, 0, 16, 16, pixels, buf_type=data_type)
        for compression in (
            "NONE",
            "RLE",
            "ZIPS",
            "ZIP",
            "PIZ",
            "PXR24",
            "B44",
            "B44A",
            "DWAA",
            "DWAB",
        ):
            for tiled in ("YES", "NO"):
                path = directory / f"{pixel_type}-{compression}-{tiled}.exr"
                dataset = gdal.GetDriverByName("EXR").CreateCopy(
                    str(path),
                    source,
                    options=[
                        f"COMPRESS={compression}",
                        f"PIXEL_TYPE={pixel_type}",
                        f"TILED={tiled}",
                        "AUTO_RESCALE=NO",
                    ],
                )
                dataset.Close()
                with gdal.OpenEx(str(path), allowed_drivers=["EXR"]) as restored:
                    if (
                        (restored.RasterXSize, restored.RasterYSize, restored.RasterCount)
                        != (16, 16, 1)
                        or restored.GetGeoTransform() != transform
                        or not restored.GetSpatialRef().IsSame(reference)
                    ):
                        raise RuntimeError(f"EXR geometry metadata did not roundtrip: {path.name}")
                    decoded = restored.ReadRaster(buf_type=data_type)
                    # Lossy codecs are checked for bounded numeric drift. The
                    # lossless paths must preserve every source byte.
                    if compression in {"B44", "B44A", "DWAA", "DWAB"}:
                        values = struct.unpack(f"=256{encoding}", decoded)
                        if any(
                            not math.isfinite(value) or abs(value - index % 16) > 0.1
                            for index, value in enumerate(values)
                        ):
                            raise RuntimeError(f"EXR lossy pixel drift: {path.name}")
                    elif decoded != pixels:
                        raise RuntimeError(f"EXR lossless pixel drift: {path.name}")
                cases += 1
    return cases


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("snapshot", "verify"))
    parser.add_argument("baseline", type=Path)
    parser.add_argument("--scratch-root", type=Path, default=Path("/tmp"))
    args = parser.parse_args()
    current = inventory()
    if args.mode == "snapshot":
        args.baseline.write_text(json.dumps(current, sort_keys=True, indent=2) + "\n")
        return
    check_inventory(json.loads(args.baseline.read_text()), current)
    check_openexr()
    with tempfile.TemporaryDirectory(prefix="opengeo-exr-", dir=args.scratch_root) as directory:
        cases = check_roundtrips(Path(directory))
    print(
        json.dumps(
            {
                "gdalVersion": current["gdalVersion"],
                "drivers": len(current["drivers"]),
                "openexrVersion": "3.4.15",
                "roundtrips": cases,
                "status": "passed",
            }
        )
    )


if __name__ == "__main__":
    main()
