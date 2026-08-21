import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app import config, db
from app.api import auth as auth_api
from app.api import chat, meetings
from app.services import auth, embedding
from scripts import migrate

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
templates = Jinja2Templates(directory=str(config.BASE_DIR / "app" / "templates"))

# Everything else needs a session. Listing the exceptions rather than decorating
# the protected routes means a new endpoint is closed by default.
PUBLIC_PATHS = {"/health", "/login", "/api/auth/login"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup never creates or alters a table. Schema is a deployment step
    # (`python -m scripts.migrate`); this only refuses to serve without it.
    migrate.verify(embedding.dimension())
    db.init_pool()
    logging.getLogger("minutes").info(
        "ready: whisper=%s/%s embed=%s(dim=%s)",
        config.WHISPER_MODEL,
        config.resolve_device(config.WHISPER_DEVICE),
        config.EMBEDDING_MODEL,
        embedding.dimension(),
    )
    yield


app = FastAPI(title="Minutes", lifespan=lifespan)
app.include_router(auth_api.router)
app.include_router(meetings.router)
app.include_router(chat.router)
app.mount("/static", StaticFiles(directory=str(config.BASE_DIR / "app" / "static")), name="static")


@app.middleware("http")
async def require_login(request: Request, call_next):
    """The auth boundary, enforced server-side for every request.

    An anonymous API call is a 401 and an anonymous page is a redirect — the UI
    never decides who may call what.
    """
    path = request.url.path
    if path in PUBLIC_PATHS or path.startswith("/static/"):
        return await call_next(request)
    user = auth.resolve_session(request.cookies.get(auth.COOKIE_NAME))
    if not user:
        if path.startswith("/api/"):
            return JSONResponse({"detail": "로그인이 필요합니다."}, status_code=401)
        return RedirectResponse("/login", status_code=303)
    request.state.user = user
    return await call_next(request)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse(request, "login.html")


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(request, "index.html", {"user": request.state.user})


@app.get("/meetings/{meeting_id}", response_class=HTMLResponse)
def meeting_page(request: Request, meeting_id: int):
    return templates.TemplateResponse(
        request, "meeting.html", {"meeting_id": meeting_id, "user": request.state.user}
    )


@app.get("/chat", response_class=HTMLResponse)
def chat_page(request: Request):
    return templates.TemplateResponse(request, "chat.html", {"user": request.state.user})
