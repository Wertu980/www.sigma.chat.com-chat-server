from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routes import auth_routes, user_routes, message_routes
from db.database import Base, engine, SessionLocal
from core.config import settings
from db.models import User
from datetime import datetime, timedelta
import asyncio

app = FastAPI(title="Auth+Chat Backend (No OTP)", version="1.0")

allow_origins = [o.strip() for o in settings.CORS_ALLOW_ORIGINS.split(",")] if settings.CORS_ALLOW_ORIGINS else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auto-create tables (use Alembic migrations for production)
Base.metadata.create_all(bind=engine)

# Routers
app.include_router(auth_routes.router, prefix="/auth", tags=["Auth"])
app.include_router(user_routes.router, prefix="/user", tags=["User"])
app.include_router(message_routes.router, tags=["Chat"])

@app.get("/")
def root():
    return {"status": "ok", "message": "Server up"}

# ---- Background job: delete accounts that logged out & never came back in N days ----
async def delete_accounts_logged_out_over_cutoff_loop():
    while True:
        try:
            db = SessionLocal()
            cutoff = datetime.utcnow() - timedelta(days=settings.ACCOUNT_DELETE_AFTER_LOGOUT_DAYS)
            to_delete = db.query(User).filter(
                User.last_logout_at.isnot(None),
                User.last_login_at <= User.last_logout_at,
                User.last_logout_at < cutoff
            ).all()
            for u in to_delete:
                db.delete(u)
            if to_delete:
                db.commit()
        except Exception:
            pass
        finally:
            try: db.close()
            except: pass
        await asyncio.sleep(24 * 60 * 60)  # run daily

@app.on_event("startup")
async def on_startup():
    asyncio.create_task(delete_accounts_logged_out_over_cutoff_loop())