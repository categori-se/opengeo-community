"""Apply two upstream security fixes to checksum-pinned source, without network I/O.

This records source remediation, not scan acceptance or deployment approval.
Keep package versions truthful; retain scanner findings until exact-image review.
"""
import argparse
import hashlib
from pathlib import Path

BACKPORTS = {
    "python-tarfile": {
        "cve": "CVE-2026-82049",
        "upstream": "https://github.com/python/cpython/commit/b8f23e307097552eaea2604383a12ab280520d0d",
        "before": "9fedddf7e814c226cb7e1ac0aa603092eda40047367ec00ad740a81484a17d01",
        "after": "7ad04a66bb92373bd6d2552a2f01fce8a4ca95463ebf661612fd574465977929",
        "old": b"                    os.link(tarinfo._link_target, targetpath)",
        "new": b"""                    # Resolve the target so the hard link points to the file
                    # itself. Otherwise os.link() may duplicate a symlink to a
                    # shallower location, where it's relative target escapes the
                    # destination directory. (CVE-2026-82049)
                    os.link(os.path.realpath(tarinfo._link_target), targetpath)""",
    },
    "zlib-gzwrite": {
        "cve": "CVE-2026-85091",
        "upstream": "https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148",
        "before": "2ce783294c688330c716bfe106f43167d3dae5be84994176bc304d205d4f5b04",
        "after": "31d0da140edf382b82b13e2d87a22f59e158d9014ee026459e01cf437d0ab07d",
        "old": b"""            if (ret == -1)
                return state->again ? put - len : 0;""",
        "new": b"""            if (ret == -1) {
                state->strm.avail_in = 0;
                state->strm.next_in = state->in;
                return state->again ? put - len : 0;
            }""",
    },
}


def patched_source(kind: str, body: bytes) -> bytes:
    fix = BACKPORTS[kind]
    if hashlib.sha256(body).hexdigest() != fix["before"]:
        raise ValueError(f"{kind}: source differs from the reviewed input")
    if body.count(fix["old"]) != 1:
        raise ValueError(f"{kind}: upstream patch context differs")
    result = body.replace(fix["old"], fix["new"])
    if hashlib.sha256(result).hexdigest() != fix["after"]:
        raise ValueError(f"{kind}: patched source differs from the reviewed output")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=BACKPORTS)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    if args.source.is_symlink() or not args.source.is_file():
        raise ValueError("Source must be a regular non-symlink file")
    result = patched_source(args.kind, args.source.read_bytes())
    args.source.write_bytes(result)
    print(f"Applied {BACKPORTS[args.kind]['cve']}: {BACKPORTS[args.kind]['after']}")


if __name__ == "__main__":
    main()
