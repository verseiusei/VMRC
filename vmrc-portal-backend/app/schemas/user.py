# File: app/schemas/user.py

from typing import Optional

from pydantic import BaseModel, EmailStr


class UserBase(BaseModel):
    email: EmailStr


class UserCreate(UserBase):
    password: str


class UserRead(UserBase):
    id: int

    class Config:
        from_attributes = True  # Pydantic v2: replaces orm_mode
