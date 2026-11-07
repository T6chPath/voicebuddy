from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from ..config import Settings
from ..db import Database, new_id, now
from ..deps import current_user, get_db, get_settings
from ..schemas import LoginIn, RegisterIn, UserOut
from ..security import COOKIE, DUMMY_HASH, hash_password, new_session_token, token_hash, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _start_session(resp: Response, db: Database, s: Settings, user_id: str):
    tok, h = new_session_token()
    db.run("INSERT INTO sessions VALUES (?,?,?,?)", (h, user_id, now(), now() + s.session_days * 86400))
    db.run("DELETE FROM sessions WHERE expires_at < ?", (now(),))
    resp.set_cookie(COOKIE, tok, max_age=s.session_days * 86400, httponly=True, secure=s.cookie_secure,
                    samesite="lax", path="/")


def _client(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post("/register", response_model=UserOut, status_code=201)
def register(body: RegisterIn, request: Request, response: Response, db: Database = Depends(get_db),
             s: Settings = Depends(get_settings)):
    if not s.allow_registration:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Registration is closed.")
    wait = request.app.state.limiter.check("reg:" + _client(request))
    if wait:
        raise HTTPException(429, f"Too many attempts. Try again in {int(wait)} s.", headers={"Retry-After": str(int(wait))})
    if db.one("SELECT 1 FROM users WHERE email = ?", (body.email,)):
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists.")
    uid = new_id("usr")
    db.run("INSERT INTO users VALUES (?,?,?,?,?)", (uid, body.email, body.name, hash_password(body.password), now()))
    _start_session(response, db, s, uid)
    return {"id": uid, "email": body.email, "name": body.name}


@router.post("/login", response_model=UserOut)
def login(body: LoginIn, request: Request, response: Response, db: Database = Depends(get_db),
          s: Settings = Depends(get_settings)):
    lim = request.app.state.limiter
    keys = ("ip:" + _client(request), "email:" + body.email)
    wait = lim.check(*keys)
    if wait:
        raise HTTPException(429, f"Too many sign-in attempts. Try again in {int(wait)} s.", headers={"Retry-After": str(int(wait))})
    u = db.one("SELECT * FROM users WHERE email = ?", (body.email,))
    if not verify_password(body.password, u["password_hash"] if u else DUMMY_HASH) or not u:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Email or password is incorrect.")
    lim.reset("email:" + body.email)
    _start_session(response, db, s, u["id"])
    return {"id": u["id"], "email": u["email"], "name": u["name"]}


@router.post("/logout", status_code=204)
def logout(request: Request, db: Database = Depends(get_db)):
    tok = request.cookies.get(COOKIE)
    if tok:
        db.run("DELETE FROM sessions WHERE token_hash = ?", (token_hash(tok),))
    resp = Response(status_code=204)
    resp.delete_cookie(COOKIE, path="/")
    return resp


@router.get("/me", response_model=UserOut)
def me(user: dict = Depends(current_user)):
    return user
