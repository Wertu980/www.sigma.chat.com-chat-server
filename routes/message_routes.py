from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session
from typing import Optional
from datetime import datetime

from db.database import get_db
from db.models import Message, User
from db.schemas import MessageOut
from core.security import decode_token
from sockets.chat_manager import ConnectionManager
from core.gdrive import upload_bytes_to_drive

router = APIRouter()
manager = ConnectionManager()

def user_from_token(token: str, db: Session) -> User:
    try:
        payload = decode_token(token)
        if payload.get("type") != "access":
            raise Exception()
        sub = payload["sub"]
        user = db.query(User).filter(User.mobile == sub).first()
        if not user:
            raise Exception()
        # bump activity
        user.last_activity_at = datetime.utcnow()
        db.add(user); db.commit()
        return user
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

@router.post("/messages/upload_gdrive")
async def upload_gdrive(token: str = Form(...), file: UploadFile = File(...), db: Session = Depends(get_db)):
    _ = user_from_token(token, db)
    data = await file.read()
    meta = upload_bytes_to_drive(filename=file.filename or "upload", data=data, mime_type=file.content_type or "application/octet-stream")
    return {
        "file_id": meta.get("id"),
        "webViewLink": meta.get("webViewLink"),
        "webContentLink": meta.get("webContentLink"),
        "mimeType": meta.get("mimeType"),
    }

@router.post("/messages/send", response_model=MessageOut)
async def send_message(
    token: str = Form(...),
    receiver_id: int = Form(...),
    content: Optional[str] = Form(None),
    drive_file_id: Optional[str] = Form(None),
    drive_web_view: Optional[str] = Form(None),
    drive_web_content: Optional[str] = Form(None),
    media_type: Optional[str] = Form(None),
    media_mime: Optional[str] = Form(None),
    media_size: Optional[int] = Form(None),
    db: Session = Depends(get_db),
):
    user = user_from_token(token, db)
    if not content and not drive_file_id:
        raise HTTPException(status_code=400, detail="Provide content or drive_file_id")

    msg = Message(
        sender_id=user.id, receiver_id=receiver_id, content=content,
        drive_file_id=drive_file_id, drive_web_view=drive_web_view, drive_web_content=drive_web_content,
        media_type=media_type, media_mime=media_mime, media_size=media_size
    )
    db.add(msg); db.commit(); db.refresh(msg)

    await manager.send_personal(receiver_id, {
        "id": msg.id, "from": user.id, "content": content,
        "drive_file_id": drive_file_id, "drive_web_view": drive_web_view, "drive_web_content": drive_web_content,
        "media_type": media_type, "media_mime": media_mime, "media_size": media_size,
        "timestamp": msg.created_at.isoformat()
    })
    return msg

@router.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket, token: str, db: Session = Depends(get_db)):
    try:
        user = user_from_token(token, db)
    except HTTPException:
        await websocket.close(code=4001); return

    user_id = user.id
    await manager.connect(websocket, user_id)

    try:
        while True:
            data = await websocket.receive_json()
            receiver_id = data.get("receiver_id")
            content = data.get("content")
            drive_file_id = data.get("drive_file_id")
            drive_web_view = data.get("drive_web_view")
            drive_web_content = data.get("drive_web_content")
            media_type = data.get("media_type")
            media_mime = data.get("media_mime")
            media_size = data.get("media_size")

            if not receiver_id or (not content and not drive_file_id):
                await websocket.send_json({"error": "receiver_id and (content or drive_file_id) required"})
                continue

            msg = Message(
                sender_id=user_id, receiver_id=receiver_id, content=content,
                drive_file_id=drive_file_id, drive_web_view=drive_web_view, drive_web_content=drive_web_content,
                media_type=media_type, media_mime=media_mime, media_size=media_size
            )
            db.add(msg); db.commit(); db.refresh(msg)

            await manager.send_personal(receiver_id, {
                "id": msg.id, "from": user_id, "content": content,
                "drive_file_id": drive_file_id, "drive_web_view": drive_web_view, "drive_web_content": drive_web_content,
                "media_type": media_type, "media_mime": media_mime, "media_size": media_size,
                "timestamp": msg.created_at.isoformat()
            })
            await websocket.send_json({"status": "sent", "id": msg.id})
    except WebSocketDisconnect:
        manager.disconnect(user_id)