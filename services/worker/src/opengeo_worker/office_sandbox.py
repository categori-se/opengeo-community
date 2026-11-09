"""Fail-closed filesystem and syscall boundaries for an isolated Office child.

Call once in the single-threaded conversion child before exec, never in the
worker. Restrictions survive exec; the caller supplies resource limits, a fresh
profile and no inherited descriptors. This helper never launches a converter.
"""

import ctypes
import errno
import os
import platform
from pathlib import Path

_ALL_FS = (1 << 15) - 1  # Landlock ABI 3: execute through truncate.
_READ_FILE = 1 << 2
_READ = _READ_FILE | (1 << 3)
_WORK = _ALL_FS & ~(1 | (1 << 6) | (1 << 11))  # No exec or device creation.


class _Ruleset(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class _Beneath(ctypes.Structure):
    _layout_ = "ms"
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class _Comparison(ctypes.Structure):
    _fields_ = [
        ("arg", ctypes.c_uint),
        ("op", ctypes.c_int),
        ("datum_a", ctypes.c_uint64),
        ("datum_b", ctypes.c_uint64),
    ]


def _checked(result: int) -> int:
    if result == -1:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))
    return result


def _seccomp() -> tuple[ctypes.CDLL, int]:
    library = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    library.seccomp_init.argtypes = [ctypes.c_uint32]
    library.seccomp_init.restype = ctypes.c_void_p
    library.seccomp_release.argtypes = [ctypes.c_void_p]
    library.seccomp_release.restype = None
    library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    library.seccomp_syscall_resolve_name.restype = ctypes.c_int
    library.seccomp_rule_add_array.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_int,
        ctypes.c_uint,
        ctypes.POINTER(_Comparison),
    ]
    library.seccomp_rule_add_array.restype = ctypes.c_int
    library.seccomp_load.argtypes = [ctypes.c_void_p]
    library.seccomp_load.restype = ctypes.c_int
    context = library.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW.
    if context is None:
        raise RuntimeError("office_seccomp_unavailable")
    try:
        # AF_UNIX is needed for LibreOffice's private profile IPC. All other
        # socket families, including INET/INET6 and NETLINK, receive EPERM.
        comparison = _Comparison(0, 1, 1, 0)  # arg0 != AF_UNIX, SCMP_CMP_NE.
        for name in (
            "socket",
            "socketpair",
            "ptrace",
            "process_vm_readv",
            "process_vm_writev",
            "pidfd_getfd",
            "io_uring_setup",
            "bpf",
            "mount",
            "unshare",
            "setns",
        ):
            number = library.seccomp_syscall_resolve_name(name.encode("ascii"))
            if number < 0:
                raise RuntimeError("office_seccomp_syscall_unavailable")
            socket_call = name in {"socket", "socketpair"}
            result = library.seccomp_rule_add_array(
                context,
                0x00050000 | errno.EPERM,
                number,
                int(socket_call),
                ctypes.byref(comparison) if socket_call else None,
            )
            if result < 0:
                raise OSError(-result, "office_seccomp_rule_failed")
        return library, context
    except BaseException:
        library.seccomp_release(context)
        raise


def restrict_office_process(workdir: Path, *, private_runtime: bool = False) -> None:
    """Restrict this process irreversibly; missing isolation is a hard failure."""
    if platform.machine() not in {"x86_64", "aarch64"}:
        raise RuntimeError("office_sandbox_architecture_unavailable")
    if (
        not workdir.is_absolute()
        or workdir.resolve(strict=True) != workdir
        or not workdir.is_dir()
        or workdir == Path("/tmp")
        or not workdir.is_relative_to(Path("/tmp"))
    ):
        raise ValueError("office_sandbox_workdir_invalid")
    if private_runtime and (workdir != Path("/tmp/job") or os.getpid() != 2):
        raise ValueError("office_private_runtime_invalid")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    libc.prctl.argtypes = [ctypes.c_int, *([ctypes.c_ulong] * 4)]
    libc.prctl.restype = ctypes.c_int
    if _checked(libc.syscall(444, None, 0, 1)) < 3:
        raise RuntimeError("office_landlock_abi_unavailable")
    library, context = _seccomp()  # Load trusted code before restricting reads.
    descriptor = -1
    try:
        rules = _Ruleset(_ALL_FS)
        descriptor = _checked(libc.syscall(444, ctypes.byref(rules), ctypes.sizeof(rules), 0))
        paths = [(path, _READ | 1) for path in ("/usr", "/bin", "/lib", "/lib64")]
        paths += [
            (path, _READ)
            for path in (
                "/etc/fonts",
                "/etc/libreoffice",
                "/etc/dconf",
                "/var/cache/fontconfig",
                "/etc/pki/tls/openssl.d",
            )
        ]
        paths += [
            (f"/etc/{name}", _READ_FILE)
            for name in (
                "ld.so.cache",
                "passwd",
                "group",
                "nsswitch.conf",
                "localtime",
                "host.conf",
                "mime.types",
            )
        ]
        paths += [("/dev/null", _READ_FILE | (1 << 1)), ("/dev/urandom", _READ_FILE)]
        # Runtime crypto initialization and CPU sizing, observed during native
        # startup. Configuration only: no certificate private-key directories.
        paths += [
            (path, _READ_FILE)
            for path in (
                "/etc/pki/tls/openssl.cnf",
                "/etc/crypto-policies/back-ends/opensslcnf.config",
                "/etc/ssl/openssl.cnf",
                "/proc/sys/crypto/fips_enabled",
                "/proc/stat",
                "/sys/devices/system/cpu/online",
            )
        ]
        paths.append((str(workdir), _WORK))
        # LibreOffice ignores TMPDIR for its local IPC pipe. The trusted caller
        # first supplies a private mount/PID namespace and an empty /tmp tmpfs.
        # This whole bounded tmpfs belongs to one job, including native temporary
        # files that ignore TMPDIR. It contains no host temp files or data.
        if private_runtime:
            paths.append(("/tmp", _WORK))
            # The trusted bubblewrap command mounts this PID namespace's proc,
            # exposing only its supervisor and isolated conversion descendants.
            paths.append(("/proc", _READ))
        for path, access in paths:
            try:
                parent = os.open(path, os.O_PATH | os.O_CLOEXEC)
            except FileNotFoundError:
                if path in {"/dev/null", "/dev/urandom", str(workdir)}:
                    raise
                continue  # Distro-specific runtime/configuration paths are optional.
            try:
                rule = _Beneath(access, parent)
                _checked(libc.syscall(445, descriptor, 1, ctypes.byref(rule), 0))
            finally:
                os.close(parent)
        _checked(libc.prctl(38, 1, 0, 0, 0))  # PR_SET_NO_NEW_PRIVS.
        _checked(libc.syscall(446, descriptor, 0))
        result = library.seccomp_load(context)
        if result < 0:
            raise OSError(-result, "office_seccomp_load_failed")
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        library.seccomp_release(context)
