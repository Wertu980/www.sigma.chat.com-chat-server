from datetime import datetime, timedelta
import jwt
from jwt import ExpiredSignatureError, InvalidTokenError
from passlib.context import CryptContext
from core.config import settings
import uuid

ALGORITHM = "HS256"
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def hash_password(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)

def create_access_token(sub: str) -> str:
    exp = datetime.utcnow() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": sub, "type": "access", "exp": exp, "iat": datetime.utcnow()}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)

def create_refresh_token(sub: str):
    """Returns (token, jti, exp). Payload exp is informational; sliding expiry is enforced in DB."""
    jti = str(uuid.uuid4())
    exp = datetime.utcnow() + timedelta(days=settings.REFRESH_INACTIVITY_DAYS)
    payload = {"sub": sub, "type": "refresh", "jti": jti, "exp": exp, "iat": datetime.utcnow()}
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm=ALGORITHM)
    return token, jti, exp

def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
    except ExpiredSignatureError:
        raise ValueError("Expired token")
    except InvalidTokenError:
        raise ValueError("Invalid token")