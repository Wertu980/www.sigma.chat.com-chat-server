from fastapi import APIRouter, Depends
from typing import Annotated
from sqlalchemy.orm import Session
from db.database import get_db
from db.schemas import UserOut
from db.models import User
from routes.auth_routes import get_current_user

router = APIRouter()

@router.get("/me", response_model=UserOut)
def me(current_user: Annotated[User, Depends(get_current_user)], db: Session = Depends(get_db)):
    return current_user