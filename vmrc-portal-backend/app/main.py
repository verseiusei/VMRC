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
    origins = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
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
