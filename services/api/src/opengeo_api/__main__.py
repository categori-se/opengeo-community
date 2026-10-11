import uvicorn

from opengeo_api.config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "opengeo_api.main:app",
        host=settings.host,
        port=settings.port,
        access_log=False,
        log_config=None,
        server_header=False,
    )


if __name__ == "__main__":
    main()
