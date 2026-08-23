import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from app import config, db
from app.api import auth as auth_api
from app.api import categories, chat, meetings, shares, users, versions
from app.services import auth, embedding, lexical
from scripts import migrate

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

# The React build. Produced by `npm run build` in frontend/ and copied into the
# image by the Dockerfile's first stage; no Node runs in production.
WEB_DIR = config.BASE_DIR / "frontend" / "dist"
INDEX = WEB_DIR / "index.html"

# Login is the one API route an anonymous caller may reach. Everything else
# under /api/ is closed by default, so a new endpoint is protected the moment it
# is written. Pages carry no data of their own — the SPA shell is the same bytes
# for everyone and asks /api/auth/me who it is talking to.
PUBLIC_API = {"/api/auth/login"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup never creates or alters a table. Schema is a deployment step
    # (`python -m scripts.migrate`); this only refuses to serve without it.
    migrate.verify(embedding.dimension())
    db.init_pool()
    # Load the morphological analyzer now, not on the first question. It is a
    # one-off ~0.3s of model reading that the first user would otherwise pay.
    lexemes = lexical.lexemes("검색 색인을 준비합니다")
    logging.getLogger("minutes").info(
        "ready: whisper=%s/%s embed=%s(dim=%s) lexical=%s web=%s",
        config.WHISPER_MODEL,
        config.resolve_device(config.WHISPER_DEVICE),
        config.EMBEDDING_MODEL,
        embedding.dimension(),
        "kiwi" if lexemes else "MISSING",
        "built" if INDEX.is_file() else "MISSING",
    )
    yield


app = FastAPI(title="Minutes", lifespan=lifespan)
app.include_router(auth_api.router)
app.include_router(meetings.router)
# Sub-resources of a meeting, in their own modules because they are their own
# lifecycles. Registered after the meeting router; the paths do not overlap, so
# the order is only about reading the file.
app.include_router(versions.router)
app.include_router(shares.router)
app.include_router(shares.inbox)
app.include_router(users.router)
app.include_router(categories.router)
app.include_router(chat.router)


@app.middleware("http")
async def require_login(request: Request, call_next):
    """The auth boundary, enforced server-side for every API request.

    An anonymous API call is a 401. The UI never decides who may call what — it
    only decides which screen to draw once the server has answered.
    """
    path = request.url.path
    if not path.startswith("/api/") or path in PUBLIC_API:
        return await call_next(request)
    user = auth.resolve_session(request.cookies.get(auth.COOKIE_NAME))
    if not user:
        return JSONResponse({"detail": "로그인이 필요합니다."}, status_code=401)
    request.state.user = user
    return await call_next(request)


@app.get("/health")
def health():
    return {"status": "ok"}


def _asset(rel: str) -> Path | None:
    """A real file inside the build directory, or None.

    `resolve()` plus the containment check is what stops `../` in a URL from
    reaching anything outside the build output.
    """
    root = WEB_DIR.resolve()
    candidate = (root / rel).resolve()
    return candidate if candidate.is_relative_to(root) and candidate.is_file() else None


@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str):
    """Serve the built frontend, and let React Router own the client routes.

    Registered last, so every API route above wins. An unknown `/api/...` is a
    404 rather than a page: an API caller must never be handed index.html and
    have to parse HTML to find out its request was wrong.
    """
    if full_path.startswith("api/"):
        raise HTTPException(404, "Not Found")
    if asset := _asset(full_path):
        return FileResponse(asset)
    if not INDEX.is_file():
        raise HTTPException(
            503, "프런트엔드 빌드가 없습니다. frontend에서 `npm run build`를 실행하세요."
        )
    # Deep links (/meetings/12, /chat/3) and refreshes land here: the shell is
    # returned and the router resolves the path in the browser.
    return FileResponse(INDEX)
