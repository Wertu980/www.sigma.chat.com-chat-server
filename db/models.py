# db/models.py
from datetime import datetime
from sqlalchemy import Column, Integer, String, Boolean, DateTime
from db.database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    mobile = Column(String(32), unique=True, nullable=False)
    age = Column(Integer, nullable=True)
    gender = Column(String(16), nullable=True)
    password_hash = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login_at = Column(DateTime, nullable=True)
    last_logout_at = Column(DateTime, nullable=True)
    is_deleted = Column(Boolean, default=False)