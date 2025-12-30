# File: app/api/v1/routes_project.py

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas.project import ProjectCreate, ProjectRead

router = APIRouter()


@router.get(
    "/",
    response_model=list[ProjectRead],
    summary="List projects (placeholder)",
)
def list_projects(db: Session = Depends(get_db)):
    """
    Placeholder implementation returning an empty list.

    Later this will:
      - Query Project table (scoped by user / org if needed)
    """
    return []


@router.post(
    "/",
    response_model=ProjectRead,
    status_code=status.HTTP_201_CREATED,
    summary="Create project (placeholder)",
)
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
):
    """
    Placeholder for creating a project.

    For now, we just echo back the input with a fake id.
    """
    return ProjectRead(id=1, **payload.model_dump())
