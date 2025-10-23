# routes/auth_routes.py
from __future__ import annotations

import os
import re
import jwt
from datetime import datetime, timedelta, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from passlib.context import CryptContext

from models import User
from db.database import get_db  # <-- your existing dependency

# ------------------------------------------------------------------------------
# Settings (falls back to env if you don't have a settings module)
# ------------------------------------------------------------------------------
SECRET_KEY = os.getenv("SECRET_KEY", "change-this-secret")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "15"))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "7"))
JWT_ALG = "HS256"

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
E164 = re.compile(r"^\+\d{8,15}$")

# ------------------------------------------------------------------------------
# Pydantic Schemas
# ------------------------------------------------------------------------------
class RegisterRequest(BaseModel):
    name: str
    mobile: str
    age: Optional[int] = None
    gender: Optional[str] = None
    password: str

    @field_validator("mobile")
    @classmethod
    def valid_e164(cls, v: str) -> str:
        v = v.strip()
        if not E164.match(v):
            raise ValueError("mobile must be E.164 like +14155552671")
        return v

    @field_validator("gender")
    @classmethod
    def gender_ok(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        g = v.lower()
        if g not in {"male", "female", "other"}:
            raise ValueError("gender must be male|female|other")
        return g

    @field_validator("password")
    @classmethod
    def strong_enough(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("password must be at least 6 chars")
        return v


class LoginRequest(BaseModel):
    mobile: str
    password: str
    confirm_password: str

    @field_validator("mobile")
    @classmethod
    def valid_e164(cls, v: str) -> str:
        v = v.strip()
        if not E164.match(v):
            raise ValueError("mobile must be E.164 like +14155552671")
        return v

    @field_validator("confirm_password")
    @classmethod
    def confirm_match(cls, v: str, info) -> str:
        pwd = info.data.get("password")
        if pwd is not None and v != pwd:
            raise ValueError("confirm_password must match password")
        return v


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class UserPublic(BaseModel):
    id: int
    name: str
    mobile: str


# ------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------
def hash_password(plain: str) -> str:
    return pwd_ctx.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)


def make_access_token(sub: str) -> str:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": sub, "type": "access", "iat": int(now.timestamp()), "exp": int(exp.timestamp())}
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALG)


def make_refresh_token(sub: str) -> str:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {"sub": sub, "type": "refresh", "iat": int(now.timestamp()), "exp": int(exp.timestamp())}
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALG)


# ------------------------------------------------------------------------------
# Router
# ------------------------------------------------------------------------------
router = APIRouter(prefix="/auth", tags=["auth"])

@router.post("/register", response_model=UserPublic, status_code=201)
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_db)):
    # existing?
    exists = (await db.execute(select(User).where(User.mobile == payload.mobile))).scalar_one_or_none()
    if exists:
        raise HTTPException(status_code=409, detail="Mobile already registered")

    user = User(
        name=payload.name.strip(),
        mobile=payload.mobile.strip(),
        age=payload.age,
        gender=(payload.gender or None),
        password_hash=hash_password(payload.password),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return UserPublic(id=user.id, name=user.name, mobile=user.mobile)


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)):
    # find user
    user = (await db.execute(select(User).where(User.mobile == payload.mobile))).scalar_one_or_none()
    if not user or not verify_password(payload.password, user.password_hash):
        # avoid user enumeration
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # update last_login
    await db.execute(
        update(User).where(User.id == user.id).values(last_login_at=datetime.now(timezone.utc))
    )
    await db.commit()

    access = make_access_token(str(user.id))
    refresh = make_refresh_token(str(user.id))
    return TokenResponse(access_token=access, refresh_token=refresh)


# Optional: very small preflight helpers (sometimes handy on certain hosts)
@router.options("/login")
async def options_login():
    return {"ok": True}

@router.options("/register")
async def options_register():
    return {"ok": True}


# ------------------------------------------------------------------------------
# Users list (for AddChat.jsx)
# ------------------------------------------------------------------------------
users_router = APIRouter(prefix="/users", tags=["users"])

@users_router.get("", response_model=List[UserPublic])
async def list_users(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.is_deleted == False))  # noqa: E712
    rows = result.scalars().all()
    return [UserPublic(id=u.id, name=u.name, mobile=u.mobile) for u in rows]