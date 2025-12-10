# File: app/api/v1/routes_auth.py

"""
Auth API routes (placeholder).

We will wire proper login / signup / refresh flows once you approve
the auth approach (JWT vs. session, password hashing, etc.).
"""

from fastapi import APIRouter, HTTPException, status

router = APIRouter()


@router.post("/login", summary="User login (placeholder)")
def login():
    """
    Placeholder login endpoint.

    Currently just raises 501 to avoid implying a working auth system.
    """
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="Authentication not implemented yet.",
    )


@router.post("/register", summary="User registration (placeholder)")
def register():
    """
    Placeholder registration endpoint.
    """
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="User registration not implemented yet.",
    )
