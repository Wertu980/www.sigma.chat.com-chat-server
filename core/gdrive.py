from __future__ import annotations
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from core.config import settings
import io

SCOPES = ["https://www.googleapis.com/auth/drive.file"]

def _svc():
    if not settings.GDRIVE_SERVICE_ACCOUNT_FILE:
        raise RuntimeError("GDRIVE_SERVICE_ACCOUNT_FILE not set")
    creds = service_account.Credentials.from_service_account_file(
        settings.GDRIVE_SERVICE_ACCOUNT_FILE, scopes=SCOPES
    )
    return build("drive", "v3", credentials=creds, cache_discovery=False)

def upload_bytes_to_drive(filename: str, data: bytes, mime_type: str, folder_id: str | None = None) -> dict:
    drive = _svc()
    meta = {"name": filename}
    parent = folder_id or settings.GDRIVE_FOLDER_ID
    if parent:
        meta["parents"] = [parent]
    media = MediaIoBaseUpload(io.BytesIO(data), mimetype=mime_type, resumable=False)
    file = drive.files().create(body=meta, media_body=media, fields="id,name,webViewLink,webContentLink,mimeType").execute()
    if settings.GDRIVE_SHARE_PUBLIC:
        try:
            drive.permissions().create(fileId=file["id"], body={"role":"reader","type":"anyone"}).execute()
            file = drive.files().get(fileId=file["id"], fields="id,name,webViewLink,webContentLink,mimeType").execute()
        except Exception:
            pass
    return file