# File: app/core/security.py

"""
Security helpers for the VMRC API.

NOTE:
We are intentionally keeping this minimal for now, per your instruction
to ask before adding full authentication logic. These are just placeholders
and constants that we can flesh out later (JWT, password hashing, etc.).
"""

from datetime import datetime, timedelta
from typing import Any, Optional

from app.core.config import settings


ALGORITHM = settings.algorithm
ACCESS_TOKEN_EXPIRE_MINUTES = settings.access_token_expire_minutes
SECRET_KEY = settings.secret_key


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """
    Placeholder implementation for an access token generator.

    Once you're ready, we can:
      - Pick a JWT library (e.g., python-jose or PyJWT)
      - Implement a signed token with expiry
    For now, this just returns a dummy string so the rest of the code compiles.
    """
    to_encode: dict[str, Any] = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode["exp"] = expire.isoformat()
    # TODO: Implement real JWT (e.g., using python-jose)
    return f"DUMMY_TOKEN_{to_encode.get('sub', 'unknown')}"


def verify_token(token: str) -> bool:
    """
    Placeholder token verification function.

    Later this will:
      - Decode JWT
      - Validate signature and expiry
    """
    return token.startswith("DUMMY_TOKEN_")
