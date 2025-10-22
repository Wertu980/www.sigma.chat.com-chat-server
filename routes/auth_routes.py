from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from typing import Annotated
from datetime import datetime, timedelta
import uuid

from db.database import get_db
from db.models import User, RefreshToken
from db.schemas import RegisterIn, LoginIn, TokenPair, RefreshIn, UserOut
from core.security import hash_password, verify_password, create_access_token, create_refresh_token, decode_token
from core.config import settings
from utils.mobile_utils import normalize_mobile

router = APIRouter()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

def get_user_by_mobile(db: Session, mobile: str) -> User | None:
    return db.query(User).filter(User.mobile == mobile).first()

async def get_current_user(token: Annotated[str, Depends(oauth2_scheme)], db: Session = Depends(get_db)) -> User:
    try:
        payload = decode_token(token)
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
        sub = payload.get("sub")
        user = get_user_by_mobile(db, sub)
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        user.last_activity_at = datetime.utcnow()
        db.add(user); db.commit()
        return user
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

@router.post("/register", response_model=UserOut, status_code=201)
def register(body: RegisterIn, db: Session = Depends(get_db)):
    mobile = normalize_mobile(body.mobile)
    if get_user_by_mobile(db, mobile):
        raise HTTPException(status_code=409, detail="Mobile already registered")
    user = User(
        name=body.name,
        mobile=mobile,
        age=body.age,
        gender=body.gender,
        password_hash=hash_password(body.password),
    )
    db.add(user); db.commit(); db.refresh(user)
    return user

@router.post("/login", response_model=TokenPair)
def login(body: LoginIn, db: Session = Depends(get_db)):
    mobile = normalize_mobile(body.mobile)
    user = get_user_by_mobile(db, mobile)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if body.password != body.confirm_password:
        raise HTTPException(status_code=400, detail="Passwords do not match")
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    user.last_login_at = datetime.utcnow()
    user.last_activity_at = datetime.utcnow()
    user.last_logout_at = None
    db.add(user)

    access = create_access_token(sub=mobile)
    refresh, jti, _ = create_refresh_token(sub=mobile)
    rt = RefreshToken(
        jti=jti,
        token=refresh,
        user_id=user.id,
        expires_at=datetime.utcnow() + timedelta(days=settings.REFRESH_INACTIVITY_DAYS),
        session_id=str(uuid.uuid4()),
        parent_jti=None,
    )
    db.add(rt); db.commit()
    return TokenPair(access_token=access, refresh_token=refresh)

@router.post("/token/refresh", response_model=TokenPair)
def refresh_token(body: RefreshIn, db: Session = Depends(get_db)):
    try:
        payload = decode_token(body.refresh_token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Not a refresh token")

    jti = payload.get("jti")
    sub = payload.get("sub")
    now = datetime.utcnow()

    rt = db.query(RefreshToken).filter(RefreshToken.jti == jti).first()
    if not rt or rt.revoked:
        raise HTTPException(status_code=401, detail="Refresh token revoked or unknown")
    if rt.expires_at < now:
        raise HTTPException(status_code=401, detail="Refresh token expired")

    # Rotate and extend sliding window
    rt.revoked = True
    rt.last_used_at = now
    db.add(rt)

    new_refresh, new_jti, _ = create_refresh_token(sub=sub)
    rotated = RefreshToken(
        jti=new_jti,
        token=new_refresh,
        user_id=rt.user_id,
        expires_at=now + timedelta(days=settings.REFRESH_INACTIVITY_DAYS),
        session_id=rt.session_id,
        parent_jti=rt.jti,
        issued_at=now,
        last_used_at=now,
    )
    db.add(rotated)

    # Bump user activity
    user = db.query(User).filter(User.id == rt.user_id).first()
    if user:
        user.last_activity_at = now
        db.add(user)

    new_access = create_access_token(sub=sub)
    db.commit()
    return TokenPair(access_token=new_access, refresh_token=new_refresh)

@router.post("/logout")
def logout(body: RefreshIn, db: Session = Depends(get_db)):
    try:
        payload = decode_token(body.refresh_token)
        if payload.get("type") != "refresh":
            raise HTTPException(status_code=400, detail="Bad token type")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid token")

    jti = payload.get("jti")
    rt = db.query(RefreshToken).filter(RefreshToken.jti == jti).first()
    if rt:
        # revoke entire session chain
        db.query(RefreshToken).filter(
            RefreshToken.session_id == rt.session_id
        ).update({RefreshToken.revoked: True})
        # stamp logout time
        user = db.query(User).filter(User.id == rt.user_id).first()
        if user:
            user.last_logout_at = datetime.utcnow()
            db.add(user)
        db.commit()
    return {"detail": "Logged out"}