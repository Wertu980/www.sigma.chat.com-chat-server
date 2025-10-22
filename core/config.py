from pydantic import BaseModel
from dotenv import load_dotenv
import os

load_dotenv()

class Settings(BaseModel):
    SECRET_KEY: str = os.getenv("SECRET_KEY", "dev-secret")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "15"))
    REFRESH_INACTIVITY_DAYS: int = int(os.getenv("REFRESH_INACTIVITY_DAYS", "30"))
    ACCOUNT_DELETE_AFTER_LOGOUT_DAYS: int = int(os.getenv("ACCOUNT_DELETE_AFTER_LOGOUT_DAYS", "180"))

    DATABASE_URL: str = os.getenv("DATABASE_URL", "")

    CORS_ALLOW_ORIGINS: str = os.getenv("CORS_ALLOW_ORIGINS", "*")

    GDRIVE_SERVICE_ACCOUNT_FILE: str = os.getenv("GDRIVE_SERVICE_ACCOUNT_FILE", "")
    GDRIVE_FOLDER_ID: str = os.getenv("GDRIVE_FOLDER_ID", "")
    GDRIVE_SHARE_PUBLIC: bool = os.getenv("GDRIVE_SHARE_PUBLIC", "false").lower() == "true"

    DEBUG: bool = os.getenv("DEBUG", "false").lower() == "true"

DEFAULT_COUNTRY: str = os.getenv("DEFAULT_COUNTRY", "IN")

settings = Settings()