# File: app/models/base.py

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """
    Base class for all SQLAlchemy models.

    Actual models (User, RasterLayer, Project, etc.) will inherit from this.
    """
    pass
