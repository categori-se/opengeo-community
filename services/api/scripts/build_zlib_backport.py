#!/usr/bin/env python3
"""Build the reviewed zlib backport offline. Host builds are never ARM64 acceptance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
from apply_runtime_security_backports import BACKPORTS, patched_source

ARCHIVE_SHA256 = "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--allow-host-check", action="store_true")
    args = parser.parse_args()
    architecture = platform.machine()
    if architecture not in ("aarch64", "arm64") and not args.allow_host_check:
        parser.error("Native ARM64 required; --allow-host-check produces non-release evidence only")
    if args.output.exists():
        parser.error("Output must not exist; retain earlier receipts")
    body = args.archive.read_bytes()
    if hashlib.sha256(body).hexdigest() != ARCHIVE_SHA256:
        parser.error("Archive differs from reviewed source")
    steps = []
    with tempfile.TemporaryDirectory(prefix="opengeo-zlib-") as directory:
        work = Path(directory)
        with tarfile.open(args.archive) as archive:
            archive.extractall(work, filter="data")
        source = work / "zlib-1.3.2"
        def run(command, expected=0):
            result = subprocess.run(command, cwd=source, capture_output=True, text=True, timeout=180)
            steps.append({"command": command, "exitCode": result.returncode, "output": (result.stdout + result.stderr)[-16000:]})
            if result.returncode != expected:
                raise RuntimeError(json.dumps(steps[-1]))
        probe = Path(__file__).with_name("check_zlib_nonblocking.c").resolve()
        # Establish that this compiler/runtime actually reproduces the upstream bug.
        run(["./configure", "--shared"])
        run(["make", "-j2"])
        run(["cc", "-I.", str(probe), "./libz.a", "-o", "nonblocking-check"])
        run(["./nonblocking-check"], expected=1)
        target = source / "gzwrite.c"
        target.write_bytes(patched_source("zlib-gzwrite", target.read_bytes()))
        run(["make", "-j2"])
        run(["make", "check"])
        run(["cc", "-I.", str(probe), "./libz.a", "-o", "nonblocking-check"])
        run(["./nonblocking-check"])
        # Exercise the exact shared object, not only the static test library.
        run(["cc", "-I.", str(probe), "-L.", "-Wl,-rpath,$ORIGIN", "-lz", "-o", "nonblocking-shared-check"])
        run(["./nonblocking-shared-check"])
        args.output.mkdir(parents=True)
        for name in ("libz.so.1.3.2", "zlib.h", "README", "nonblocking-shared-check"):
            shutil.copy2(source / name, args.output / name)
        os.symlink("libz.so.1.3.2", args.output / "libz.so.1")
        receipt = {"status": "passed", "architecture": architecture, "arm64Runtime": architecture in ("aarch64", "arm64"), "nativeExecutionVerified": False,
            "archiveSha256": ARCHIVE_SHA256, "patch": {k:v for k,v in BACKPORTS["zlib-gzwrite"].items() if k not in ("old", "new")},
            "librarySha256": hashlib.sha256((args.output / "libz.so.1.3.2").read_bytes()).hexdigest(),
            "networkCalls": 0, "deploymentApproved": False, "steps": steps}
        (args.output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({k:v for k,v in receipt.items() if k != "steps"}))

if __name__ == "__main__":
    main()
