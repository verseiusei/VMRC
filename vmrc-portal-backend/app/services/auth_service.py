# File: app/services/auth_service.py

"""
Authentication service placeholder.

This will contain:
  - User lookup
  - Password verification
  - Token generation

Right now it's a minimal stub so we don't commit to a specific auth
strategy before you approve it.
"""

from typing import Optional

from sqlalchemy.orm import Session


def authenticate_user(
    db: Session,
    *,
    email: str,
    password: str,
) -> Optional[object]:
    """
    Placeholder for authenticating a user.

    Returns None for now. Implementation will:
      - Look up user by email
      - Verify password hash
    """
    return None
