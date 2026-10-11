"""Mocked launcher ABI/flag regressions, not proof of kernel sandbox behavior."""

import ctypes
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


@pytest.fixture
def launcher(monkeypatch):
    source = Path(__file__).resolve().parents[1] / "scripts/launch-maplibre.py"
    spec = importlib.util.spec_from_file_location("maplibre_local_launcher", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # No native operation is available to these tests, including unexpected ones.
    monkeypatch.setattr(module, "LIBC", SimpleNamespace())
    return module


def capture_mounts(launcher, monkeypatch):
    calls = []
    monkeypatch.setattr(
        launcher,
        "mount",
        lambda source, target, flags: calls.append(("bind", source, target, flags)),
    )

    def syscall(number, directory, target, flags, pointer, size):
        assert number == 442 and directory == -100
        assert size == ctypes.sizeof(launcher.MountAttributes) == 32
        attributes = ctypes.cast(pointer, ctypes.POINTER(launcher.MountAttributes)).contents
        calls.append(
            (
                "attributes",
                target,
                flags,
                attributes.set,
                attributes.clear,
                attributes.propagation,
                attributes.userns,
            )
        )
        return 0

    launcher.LIBC.syscall = syscall
    return calls


def test_root_work_and_device_binds_only_add_required_mount_restrictions(launcher, monkeypatch):
    calls = capture_mounts(launcher, monkeypatch)
    for source, target, options, expected in (
        ("/package/rootfs", "/package/rootfs", {"readonly": True, "executable": True}, 7),
        ("/job", "/package/rootfs/work", {"readonly": False}, 14),
        ("/dev/null", "/package/rootfs/dev/null", {"readonly": False, "device": True}, 10),
    ):
        calls.clear()
        launcher.bind(source, target, **options)
        assert calls == [
            ("bind", source, target, 4096),
            ("attributes", target.encode(), 0, expected, 0, 0, 0),
        ]


def test_proc_retains_submounts_and_adds_all_restrictions_recursively(launcher, monkeypatch):
    calls = capture_mounts(launcher, monkeypatch)
    launcher.bind_proc("/package/rootfs/proc")
    assert calls == [
        ("bind", "/proc", "/package/rootfs/proc", 4096 | 16384),
        ("attributes", b"/package/rootfs/proc", 0x8000, 15, 0, 0, 0),
    ]


def test_old_landlock_abi_fails_before_creating_or_adding_rules(launcher):
    launcher.LIBC.syscall = Mock(return_value=8)
    with pytest.raises(RuntimeError, match="saved_map_gl_landlock_abi_unavailable"):
        launcher.restrict_filesystem()
    launcher.LIBC.syscall.assert_called_once_with(444, None, 0, 1)


def test_path_beneath_rule_has_exact_packed_kernel_layout(launcher):
    assert ctypes.sizeof(launcher.Beneath) == 12
    assert launcher.Beneath.allowed.offset == 0
    assert launcher.Beneath.parent.offset == 8
