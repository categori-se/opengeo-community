from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from opengeo_api.body_limit import RequestBodyLimitMiddleware
from opengeo_api.middleware import RequestContextMiddleware


def configure_http_boundary(app: FastAPI) -> None:
    """Use the same redaction, body limits and request context in every API factory."""

    @app.exception_handler(RequestValidationError)
    async def redacted_validation_error(
        request: Request, error: RequestValidationError
    ) -> JSONResponse:
        del request
        details = [
            {key: value for key, value in item.items() if key not in {"input", "ctx"}}
            for item in error.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": details})

    app.add_middleware(RequestBodyLimitMiddleware)
    app.add_middleware(RequestContextMiddleware)
