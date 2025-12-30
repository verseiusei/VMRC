# File: app/models/user.py

"""
User model placeholder.

We'll add actual columns (id, email, password hash, etc.) once we lock in
the authentication requirements.
"""

from app.models.base import Base


class User(Base):
    __tablename__ = "users"

    # TODO: Add columns (id, email, hashed_password, roles, etc.)
    # Example:
    # id: Mapped[int] = mapped_column(primary_key=True, index=True)
    # email: Mapped[str] = mapped_column(String, unique=True, index=True)
    # ...
    pass
