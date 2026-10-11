import hashlib
import io
import zipfile
from types import SimpleNamespace

import pytest

from opengeo_api.github_build_logs import MAX_TEXT, download_build_logs, summarize_log_archive
from opengeo_api.github_publications import GitHubPublicationError


def archive(text, name="build/compile.txt"):
    body = io.BytesIO()
    with zipfile.ZipFile(body, "w", zipfile.ZIP_DEFLATED) as output:
        output.writestr(name, text)
    return body.getvalue()


def test_bounded_redacted_excerpt_is_checksummed_without_extracting_paths():
    secret = "ghp_abcdefghijklmnopqrstuvwxyz"
    result = summarize_log_archive(
        archive(
            "\x1b[31mCompiler failed\x1b[0m\n" + secret + "\n"
            "password=hidden\nhttps://example.com/output?signature=private\n"
            "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----\n" + "x" * MAX_TEXT,
            "../../outside.txt",
        )
    )
    assert result["state"] == "retained" and result["truncated"]
    assert len(result["text"].encode()) <= MAX_TEXT
    assert "Compiler failed" in result["text"]
    for hidden in (secret, "hidden", "signature=private", "BEGIN PRIVATE KEY", "\x1b"):
        assert hidden not in result["text"]
    assert result["checksum_sha256"] == hashlib.sha256(result["text"].encode()).hexdigest()


def test_download_pins_attempt_and_never_forwards_token_to_storage(monkeypatch):
    calls = []

    class Response(io.BytesIO):
        def __init__(self, data=b"", status=302, headers=None):
            super().__init__(data)
            self.status, self.headers = status, headers or {}

    def open_request(request, **kwargs):
        calls.append(request)
        if len(calls) == 1:
            return Response(headers={"location": "https://logs.blob.core.windows.net/run?sig=abc"})
        return Response(archive("Compile completed"), status=200)

    monkeypatch.setattr(
        "opengeo_api.github_build_logs.build_opener", lambda *a: SimpleNamespace(open=open_request)
    )
    result = download_build_logs("owner/private", "installation-token", 456, 2)
    assert calls[0].full_url.endswith("/actions/runs/456/attempts/2/logs")
    assert calls[0].get_header("Authorization") == "Bearer installation-token"
    assert calls[1].get_header("Authorization") is None
    assert "Compile completed" in result["text"]


def test_untrusted_redirect_is_not_followed(monkeypatch):
    class Response(io.BytesIO):
        status = 302

        def __init__(self):
            super().__init__()
            self.headers = {"location": "https://attacker.example/logs"}

    calls = []

    def open_request(request, **kwargs):
        calls.append(request)
        return Response()

    monkeypatch.setattr(
        "opengeo_api.github_build_logs.build_opener", lambda *a: SimpleNamespace(open=open_request)
    )
    with pytest.raises(GitHubPublicationError, match="github_log_redirect_invalid"):
        download_build_logs("owner/private", "token", 456, 1)
    assert len(calls) == 1
