"""
Project Sentinel — FastAPI Application Entry Point
"""

from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager
from typing import AsyncIterator, Callable

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from api.routes.auth import router as auth_router, api_router as auth_api_router
from api.routes.access import router as access_router
from api.routes.healthcare import router as healthcare_router
from api.routes.monitor import router as monitor_router
from config.settings import get_settings

# ──────────────────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("sentinel")


# ──────────────────────────────────────────────────────────────────────────────
# Lifespan
# ──────────────────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logger.info("Project Sentinel initialising — Bloom size=%d, k=%d",
                settings.bloom_filter_size, settings.bloom_hash_count)
    yield
    logger.info("Project Sentinel shutting down")


# ──────────────────────────────────────────────────────────────────────────────
# App
# ──────────────────────────────────────────────────────────────────────────────

# Allowed origins for CORS (browser requests from frontend)
CORS_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    # LAN — Machine A (this machine — backend + frontend)
    "http://10.53.222.69:3000",
    "http://10.53.222.69:3001",
    # LAN — Machine B (receiver laptop)
    "http://10.53.222.108:3000",
    "http://10.53.222.108:3001",
]

app = FastAPI(
    title="Project Sentinel",
    description=(
        "Zero-Exposure Threat Detection System for military communications. "
        "Detects classified keyword leaks via SSE and Bloom Filters without "
        "ever decrypting message content."
    ),
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)


class EnsureCORSHeadersMiddleware(BaseHTTPMiddleware):
    """Add CORS headers to every response so errors (e.g. 500) still allow browser to read them."""

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        response = await call_next(request)
        origin = request.headers.get("origin")
        if origin and origin in CORS_ORIGINS:
            response.headers.setdefault("Access-Control-Allow-Origin", origin)
        response.headers.setdefault("Access-Control-Allow-Credentials", "true")
        response.headers.setdefault("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE")
        response.headers.setdefault("Access-Control-Allow-Headers", "*")
        return response


app.add_middleware(EnsureCORSHeadersMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

app.include_router(auth_router)
app.include_router(auth_api_router)
app.include_router(access_router)
app.include_router(monitor_router)
app.include_router(healthcare_router)


# ──────────────────────────────────────────────────────────────────────────────
# Exception handler so 500s still return CORS headers
# ──────────────────────────────────────────────────────────────────────────────

from starlette.exceptions import HTTPException as StarletteHTTPException

@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail} if isinstance(exc.detail, str) else {"detail": exc.detail},
    )

@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled exception: %s", exc)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


# ──────────────────────────────────────────────────────────────────────────────
# Health check
# ──────────────────────────────────────────────────────────────────────────────


@app.get("/health", tags=["ops"])
async def health() -> JSONResponse:
    return JSONResponse({"status": "OPERATIONAL", "system": "Project Sentinel"})


# ──────────────────────────────────────────────────────────────────────────────
# Dev entry point
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
