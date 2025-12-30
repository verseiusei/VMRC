# File: app/core/config.py

import os
from functools import lru_cache
from typing import List, Optional

from pydantic import BaseModel, AnyHttpUrl, field_validator  # BaseSettings not needed

class Settings(BaseModel):
    # Basic app info
    app_name: str = "VMRC Geospatial API"

    # 👇 add these two so main.py stops crashing
    PROJECT_NAME: str = "VMRC Geospatial API"
    VERSION: str = "0.1.0"

    api_v1_prefix: str = "/api/v1"
    debug: bool = True

    # CORS
    backend_cors_origins: List[AnyHttpUrl] = []

    # Database
    database_url: str = "postgresql+psycopg://vmrc:vmrc123@localhost:5432/vmrc_db"

    # Cloud storage placeholders
    aws_s3_bucket: Optional[str] = os.getenv("AWS_S3_BUCKET") or None
    aws_region: Optional[str] = os.getenv("AWS_REGION") or None
    gcs_bucket: Optional[str] = os.getenv("GCS_BUCKET") or None

    # Security / auth placeholders
    secret_key: str = os.getenv("SECRET_KEY", "CHANGE_ME_IN_PRODUCTION")
    access_token_expire_minutes: int = 60 * 24  # 24h
    algorithm: str = "HS256"

    @field_validator("backend_cors_origins", mode="before")
    @classmethod
    def assemble_cors_origins(cls, v):
        if isinstance(v, str):
            return [i.strip() for i in v.split(",") if i.strip()]
        if isinstance(v, list):
            return v
        return []


from functools import lru_cache

@lru_cache
def get_settings() -> Settings:
    return Settings()

settings = get_settings()
