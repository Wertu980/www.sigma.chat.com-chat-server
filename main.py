# main.py
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional, Iterable

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import or_, and_

from routes import auth_routes, user_routes, message_routes
from core.config import settings
from db.database import Base, engine, SessionLocal
from db.models import User

log = logging.getLogger("uvicorn.error")

app = FastAPI(title="Auth + Chat Backend (No OTP)", version="1.0")

# ------------- CORS -------------
def _parse_origins(raw: Optional[str]) -> list[str]:
    if not raw:
        return ["*"]
    # comma-separated string -> list, trimmed & non-empty
    parts = [p.strip() for p in raw.split(",")]
    return [p for p in parts if p]

allow_origins = _parse_origins(settings.CORS_ALLOW_ORIGINS)
# If wildcard, credentials must be False per spec (browsers will reject otherwise)
allow_credentials = False if allow_origins == ["*"] else True

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------- DB bootstrapping -------------
# NOTE: Prefer Alembic migrations for production.
Base.metadata.create_all(bind=engine)

# ------------- Routers -------------
app.include_router(auth_routes.router, prefix="/auth", tags=["Auth"])
app.include_router(user_routes.router, prefix="/user", tags=["User"])
app.include_router(message_routes.router, tags=["Chat"])

# ------------- Health / Diagnostics -------------
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
        "delete_after_logout_days": settings.ACCOUNT_DELETE_AFTER_LOGOUT_DAYS,
    }

# ------------- Account cleanup task -------------
# Delete accounts that logged out and never logged back in for N days.
# Condition:
#   last_logout_at IS NOT NULL
#   AND (last_login_at IS NULL OR last_login_at <= last_logout_at)
#   AND last_logout_at < cutoff
async def _delete_accounts_logged_out_over_cutoff_loop():
    interval_sec = 24 * 60 * 60  # daily
    while True:
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(days=settings.ACCOUNT_DELETE_AFTER_LOGOUT_DAYS)
            db = SessionLocal()
            to_delete: list[User] = (
                db.query(User)
                .filter(
                    User.last_logout_at.isnot(None),
                    or_(User.last_login_at.is_(None), User.last_login_at <= User.last_logout_at),
                    User.last_logout_at < cutoff,
                )
                .all()
            )

            if to_delete:
                ids = [u.id for u in to_delete]
                for u in to_delete:
                    db.delete(u)
                db.commit()
                log.info("Account janitor: deleted %d users (ids=%s)", len(to_delete), ids)
            else:
                log.info("Account janitor: nothing to delete")

        except Exception as e:
            log.exception("Account janitor error: %s", e)
        finally:
            try:
                db.close()
            except Exception:
                pass

        await asyncio.sleep(interval_sec)

_bg_task: Optional[asyncio.Task] = None

@app.on_event("startup")
async def on_startup() -> None:
    global _bg_task
    # Launch background janitor
    _bg_task = asyncio.create_task(_delete_accounts_logged_out_over_cutoff_loop())
    log.info("Startup complete. CORS origins=%s credentials=%s", allow_origins, allow_credentials)

@app.on_event("shutdown")
async def on_shutdown() -> None:
    global _bg_task
    if _bg_task and not _bg_task.done():
        _bg_task.cancel()
        try:
            await _bg_task
        except asyncio.CancelledError:
            pass
    log.info("Shutdown complete.")