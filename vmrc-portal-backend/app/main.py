# app/main.py

import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from app.core.config import settings
from app.api.v1.api import api_router


def create_application() -> FastAPI:
    app = FastAPI(
        title=settings.PROJECT_NAME,
        version=settings.VERSION,
    )

    # ---------- CORS ----------
    # For Cloudflare tunnel support, set ALLOWED_ORIGINS env var (comma-separated)
    allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "")
    if allowed_origins_env:
        origins = [o.strip() for o in allowed_origins_env.split(",") if o.strip()]
    else:
        origins = [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,      # Explicit origins (not "*") - required for allow_credentials=True
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---------- STATIC FILES ----------
    # Serves PNG overlays located in /static/overlays/*
    # Make sure "static" folder exists relative to backend working directory
    app.mount("/static", StaticFiles(directory="static"), name="static")

    # ---------- ROUTERS ----------
    app.include_router(api_router, prefix="/api/v1")

    # =====================================================
    # Serve frontend (Vite build)
    # Repo layout:
    #   VMRC/
    #     vmrc-portal-backend/
    #       app/main.py   <-- this file
    #     vmrc-portal-frontend/
    #       dist/
    # =====================================================
    FRONTEND_DIST = os.path.abspath(
        os.path.join(
            os.path.dirname(__file__),
            "..", "..", "..",          # app -> backend -> VMRC
            "vmrc-portal-frontend",
            "dist",
        )
    )

    if os.path.isdir(FRONTEND_DIST):
        assets_dir = os.path.join(FRONTEND_DIST, "assets")
        if os.path.isdir(assets_dir):
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

        @app.get("/", include_in_schema=False)
        def serve_frontend_root():
            return FileResponse(os.path.join(FRONTEND_DIST, "index.html"))

        # Optional SPA fallback: any unknown path should return index.html
        # (helps React Router if you use it)
        @app.get("/{full_path:path}", include_in_schema=False)
        def serve_frontend_spa(full_path: str):
            candidate = os.path.join(FRONTEND_DIST, full_path)
            if os.path.isfile(candidate):
                return FileResponse(candidate)
            return FileResponse(os.path.join(FRONTEND_DIST, "index.html"))

    return app


app = create_application()
