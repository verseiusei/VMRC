"""
Database initialization helpers.

We only wire up the metadata here. Models will be imported so their
tables get registered on Base.metadata.
"""

from sqlalchemy.orm import Session

from app.db.session import engine
from app.models.base import Base

# ⭐ IMPORTANT: import only models that have a proper primary key
from app.models import raster_layer  # noqa: F401


def init_db() -> None:
    """
    Create all tables based on SQLAlchemy models.
    """
    Base.metadata.create_all(bind=engine)


def seed_initial_data(db: Session) -> None:
    """
    Placeholder for seeding initial data (e.g., default users, demo projects).
    """
    pass
