from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from app.services import auth

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
def login(body: LoginRequest, response: Response):
    user = auth.authenticate(body.username.strip(), body.password)
    if not user:
        # One message for both causes, so the response does not reveal which
        # usernames exist.
        raise HTTPException(401, "아이디 또는 비밀번호가 올바르지 않습니다.")
    # No `secure`: the deployment is plain HTTP today. See the HTTPS limitation
    # in AGENTS.md — this cookie is an identity boundary, not transport security.
    response.set_cookie(
        auth.COOKIE_NAME, auth.create_session(user["id"]),
        httponly=True, samesite="lax", max_age=auth.SESSION_DAYS * 86400, path="/",
    )
    return {"username": user["username"], "display_name": user["display_name"]}


@router.post("/logout")
def logout(request: Request, response: Response):
    auth.delete_session(request.cookies.get(auth.COOKIE_NAME))
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    return {"ok": True}
