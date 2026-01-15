# app/main.py

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.api.v1.api import api_router


def create_application() -> FastAPI:
    app = FastAPI(
        title=settings.PROJECT_NAME,
        version=settings.VERSION,
    )

    # ---------- CORS ----------
    # Explicit origins (required when allow_credentials=True)
    # For Cloudflare tunnel support, set ALLOWED_ORIGINS env var (comma-separated)
    import os
    allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "")
    if allowed_origins_env:
        origins = [origin.strip() for origin in allowed_origins_env.split(",") if origin.strip()]
    else:
        origins = [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,      # Explicit origins (not "*") - required for allow_credentials=True
        allow_credentials=True,     # Allow credentials for endpoints that need them
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---------- STATIC FILES ----------
    # This serves your PNG overlays located in /static/overlays/*
    app.mount("/static", StaticFiles(directory="static"), name="static")

    # ---------- ROUTERS ----------
    app.include_router(api_router, prefix="/api/v1")

    return app


app = create_application()
