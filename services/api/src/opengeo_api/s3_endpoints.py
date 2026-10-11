from urllib.parse import quote


def regional_s3_host(region: str) -> str:
    """Return a TLS-safe regional host that never embeds a dotted bucket name."""

    return f"s3.{region}.amazonaws.com"


def bucket_path(bucket: str) -> str:
    return f"/{quote(bucket, safe='-_.~')}"


def object_path(bucket: str, key: str) -> str:
    return f"{bucket_path(bucket)}/{quote(key, safe='/-_.~')}"
