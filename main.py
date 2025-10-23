# main.py
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import or_

from routes import auth_routes, user_routes, message_routes
from core.config import settings
from db.database import Base, engine, SessionLocal
from db.models import User

log = logging.getLogger("uvicorn.error")

app = FastAPI(title="Auth + Chat Backend (No OTP)", version="1.0")


# ------------------------- CORS -------------------------
def _parse_origins(raw: str | None) -> list[str]:
    if not raw:
        return ["*"]
    vals = [x.strip() for x in raw.split(",")]
    return [v for v in vals if v]

allow_origins = _parse_origins(getattr(settings, "CORS_ALLOW_ORIGINS", "*"))
# If wildcard, credentials must be False per browser spec
allow_credentials = False if allow_origins == ["*"] else True

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ------------------------- DB bootstrap -------------------------
# NOTE: Prefer Alembic for production migrations
Base.metadata.create_all(bind=engine)


# ------------------------- Routers -------------------------
app.include_router(auth_routes.router, prefix="/auth", tags=["Auth"])
app.include_router(user_routes.router, prefix="/user", tags=["User"])
app.include_router(message_routes.router, tags=["Chat"])


# ------------------------- Health / Diag -------------------------
@app.get("/")
def root():
    return {"status": "ok", "message": "Server up"}

@app.get("/health")
def health():
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}

@app.get("/_diag/env")
def diag_env():
    return {
        "cors_allow_origins": allow_origins,
        "cors_allow_credentials": allow_credentials,
        "account_delete_after_logout_days": settings.ACCOUNT_DELETE_AFTER_LOGOUT_DAYS,
    }


# ------------------------- Cleanup task -------------------------
# Delete accounts that logged out and never logged back in before cutoff.
# Conditions:
#   last_logout_at IS NOT NULL
#   AND (last_login_at IS NULL OR last_login_at <= last_logout_at)
#   AND last_logout_at < cutoff
async def _janitor_loop():
    interval = 24 * 60 * 60  # once per day
    while True:
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(
                days=settings.ACCOUNT_DELETE_AFTER_LOGOUT_DAYS
            )
            db = SessionLocal()
            stale: list[User] = (
                db.query(User)
                .filter(
                    User.last_logout_at.isnot(None),
                    or_(User.last_login_at.is_(None), User.last_login_at <= User.last_logout_at),
                    User.last_logout_at < cutoff,
                )
                .all()
            )
            if stale:
                ids = [u.id for u in stale]
                for u in stale:
                    db.delete(u)
                db.commit()
                log.info("Janitor: deleted %d user(s): %s", len(stale), ids)
            else:
                log.info("Janitor: nothing to delete")
        except Exception as e:
            log.exception("Janitor error: %s", e)
        finally:
            try:
                db.close()
            except Exception:
                pass
        await asyncio.sleep(interval)

_bg: Optional[asyncio.Task] = None

@app.on_event("startup")
async def on_startup():
    global _bg
    _bg = asyncio.create_task(_janitor_loop())
    log.info("Startup OK. CORS origins=%s credentials=%s", allow_origins, allow_credentials)

@app.on_event("shutdown")
async def on_shutdown():
    global _bg
    if _bg and not _bg.done():
        _bg.cancel()
        try:
            await _bg
        except asyncio.CancelledError:
            pass
    log.info("Shutdown complete.")