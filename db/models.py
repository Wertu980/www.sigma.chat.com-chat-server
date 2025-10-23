# models.py
from __future__ import annotations
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy import String, Integer, DateTime, func, Boolean
from typing import Optional

# If you already have Base in db/database.py, import it instead:
# from db.database import Base
class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    mobile: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)  # E.164
    age: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    gender: Mapped[Optional[str]] = mapped_column(String(12), nullable=True)  # 'male' | 'female' | 'other'
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    created_at: Mapped[Optional[str]] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_login_at: Mapped[Optional[str]] = mapped_column(DateTime(timezone=True), nullable=True)

    # soft-delete flags (optional)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    deleted_at: Mapped[Optional[str]] = mapped_column(DateTime(timezone=True), nullable=True)