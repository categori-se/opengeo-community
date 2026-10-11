"""Enter the fixed local rendering filesystem; never accept an executable from a job.

Called only after package verification, inside new user/mount/PID/network
namespaces. A missing kernel boundary is a hard failure, not a fallback.
The worker's outer cgroup and capability restrictions remain in force.
"""

import ctypes
import errno
import os
import platform
import sys
from pathlib import Path

LIBC = ctypes.CDLL(None, use_errno=True)
MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8
MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE = 32, 4096, 16384, 262144
READ = (1 << 2) | (1 << 3)
EXECUTE = 1
WRITE = (1 << 1) | (1 << 14)
IOCTL = 1 << 15
ALL_FS = (1 << 17) - 1  # ABI 9, including pathname UNIX socket resolution.
WORK = ALL_FS & ~(EXECUTE | (1 << 6) | (1 << 11) | IOCTL)


def checked(result):
    if result == -1:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))
    return result


def mount(source, target, flags):
    checked(
        LIBC.mount(
            os.fsencode(source) if source else None,
            os.fsencode(target),
            None,
            ctypes.c_ulong(flags),
            None,
        )
    )


def bind(source, target, *, readonly, executable=False, device=False):
    mount(source, target, MS_BIND)
    flags = MS_NOSUID
    if readonly:
        flags |= MS_RDONLY
    if not executable:
        flags |= MS_NOEXEC
    if not device:
        flags |= MS_NODEV
    # Only add restrictions: rebuilding remount flags can conflict with locked
    # attributes inherited from the outer read-only, SELinux-labeled mount.
    attributes = MountAttributes(flags, 0, 0, 0)
    checked(
        LIBC.syscall(
            442, -100, os.fsencode(target), 0, ctypes.byref(attributes), ctypes.sizeof(attributes)
        )
    )


class Ruleset(ctypes.Structure):
    _fields_ = [
        ("filesystem", ctypes.c_uint64),
        ("network", ctypes.c_uint64),
        ("scoped", ctypes.c_uint64),
    ]


class Beneath(ctypes.Structure):
    _layout_ = "ms"  # Explicit packed 12-byte kernel path-beneath layout.
    _pack_ = 1
    _fields_ = [("allowed", ctypes.c_uint64), ("parent", ctypes.c_int32)]


class MountAttributes(ctypes.Structure):
    _fields_ = [
        ("set", ctypes.c_uint64),
        ("clear", ctypes.c_uint64),
        ("propagation", ctypes.c_uint64),
        ("userns", ctypes.c_uint64),
    ]


def bind_proc(target):
    # Preserve all inherited masked submounts. A plain bind is refused by the
    # kernel because it would omit those locked restrictions.
    mount("/proc", target, MS_BIND | MS_REC)
    attributes = MountAttributes(15, 0, 0, 0)  # RO, nosuid, nodev, noexec.
    checked(
        LIBC.syscall(
            442,
            -100,
            os.fsencode(target),
            0x8000,
            ctypes.byref(attributes),
            ctypes.sizeof(attributes),
        )
    )


def restrict_filesystem():
    # These syscall numbers are shared by the two admitted native architectures.
    if checked(LIBC.syscall(444, None, 0, 1)) < 9:
        raise RuntimeError("saved_map_gl_landlock_abi_unavailable")
    rules = Ruleset(ALL_FS, 3, 3)  # Deny TCP, external signals and abstract UNIX sockets.
    descriptor = checked(LIBC.syscall(444, ctypes.byref(rules), ctypes.sizeof(rules), 0))
    try:
        paths = [
            ("/runtime", READ | EXECUTE),
            ("/lib64", READ | EXECUTE),
            ("/usr/lib64", READ | EXECUTE),
            ("/proc", READ),
            ("/work", WORK),
            ("/tmp", WORK),
            ("/etc/passwd", 1 << 2),
            ("/etc/group", 1 << 2),
            ("/etc/nsswitch.conf", 1 << 2),
        ]
        paths += [
            (f"/dev/{name}", (1 << 2) | WRITE | IOCTL)
            for name in ("null", "zero", "random", "urandom")
        ]
        for path, access in paths:
            if not os.path.exists(path):
                continue
            parent = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = Beneath(access, parent)
                checked(LIBC.syscall(445, descriptor, 1, ctypes.byref(rule), 0))
            finally:
                os.close(parent)
        checked(LIBC.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS
        checked(LIBC.syscall(446, descriptor, 0))
    finally:
        os.close(descriptor)


class CapabilityHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class CapabilityData(ctypes.Structure):
    _fields_ = [
        ("effective", ctypes.c_uint32),
        ("permitted", ctypes.c_uint32),
        ("inheritable", ctypes.c_uint32),
    ]


def drop_capabilities():
    # Namespace-local setup capabilities must not survive into the renderer.
    for capability in range(64):
        result = LIBC.prctl(24, capability, 0, 0, 0)  # PR_CAPBSET_DROP
        if result == -1 and ctypes.get_errno() != errno.EINVAL:
            checked(result)
    checked(LIBC.prctl(28, 15, 0, 0, 0))  # Lock NOROOT and NO_SETUID_FIXUP.
    header = CapabilityHeader(0x20080522, 0)
    data = (CapabilityData * 2)()
    checked(LIBC.capset(ctypes.byref(header), ctypes.byref(data)))
    checked(LIBC.prctl(38, 1, 0, 0, 0))


def enter(root, work):
    machine = platform.machine()
    if machine not in {"x86_64", "aarch64"} or os.getpid() != 1 or os.getuid() != 0:
        raise RuntimeError("saved_map_gl_namespace_unavailable")
    root, work = Path(root), Path(work)
    for path in (root, work):
        if not path.is_absolute() or path.resolve() != path or not path.is_dir():
            raise ValueError("saved_map_gl_sandbox_path_invalid")
    if root == work or root in work.parents or work in root.parents:
        raise ValueError("saved_map_gl_sandbox_path_invalid")
    mount(None, "/", MS_REC | MS_PRIVATE)
    bind(root, root, readonly=True, executable=True)
    bind(work, root / "work", readonly=False)
    bind(work, root / "tmp", readonly=False)
    # A fresh proc mount is not available under the worker's container policy.
    # Landlock's domain/ptrace restrictions must protect ancestor process files.
    bind_proc(root / "proc")
    for device in ("null", "zero", "random", "urandom"):
        bind(f"/dev/{device}", root / "dev" / device, readonly=False, device=True)
    os.chdir(root)
    checked(LIBC.syscall(155 if machine == "x86_64" else 41, b".", b"oldroot"))
    os.chdir("/")
    checked(LIBC.umount2(b"/oldroot", 2))
    restrict_filesystem()
    drop_capabilities()
    # No descriptors to the old root or worker's credentials cross exec.
    checked(LIBC.syscall(436, ctypes.c_uint(3), ctypes.c_uint(0xFFFFFFFF), 0))
    os.chdir("/work")
    os.execve(
        "/runtime/bin/node",
        [
            "/runtime/bin/node",
            "--max-old-space-size=256",
            "/runtime/render-maplibre.mjs",
            "/work/request.json",
            "/work/result.png",
        ],
        {"PATH": "/runtime/bin", "TMPDIR": "/tmp", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
    )


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("saved_map_gl_sandbox_arguments_invalid")
        enter(*sys.argv[1:])
    except Exception:
        # Keep internal paths, input values and native diagnostics out of job errors.
        sys.stderr.write("saved_map_gl_sandbox_failed\n")
        sys.exit(1)
