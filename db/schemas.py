from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime

class RegisterIn(BaseModel):
    name: str = Field(min_length=3)
    mobile: str = Field(min_length=10)
    age: Optional[int] = None
    gender: Optional[str] = None
    password: str = Field(min_length=8)

class LoginIn(BaseModel):
    mobile: str
    password: str
    confirm_password: str

class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"

class RefreshIn(BaseModel):
    refresh_token: str

class UserOut(BaseModel):
    id: int
    name: str
    mobile: str
    age: Optional[int] = None
    gender: Optional[str] = None
    created_at: datetime
    model_config = {"from_attributes": True}

class MessageOut(BaseModel):
    id: int
    sender_id: int
    receiver_id: int
    content: Optional[str] = None
    drive_file_id: Optional[str] = None
    drive_web_view: Optional[str] = None
    drive_web_content: Optional[str] = None
    media_type: Optional[str] = None
    media_mime: Optional[str] = None
    media_size: Optional[int] = None
    created_at: datetime
    model_config = {"from_attributes": True}