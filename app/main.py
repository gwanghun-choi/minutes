import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app import config, db
from app.api import chat, meetings
from app.services import embedding

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
templates = Jinja2Templates(directory=str(config.BASE_DIR / "app" / "templates"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    # the embedding model is the source of truth for the vector dimension;
    # DDL must run before the pool opens, since the pool registers the vector type
    db.apply_schema(embedding.dimension())
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
app.include_router(meetings.router)
app.include_router(chat.router)
app.mount("/static", StaticFiles(directory=str(config.BASE_DIR / "app" / "static")), name="static")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/meetings/{meeting_id}", response_class=HTMLResponse)
def meeting_page(request: Request, meeting_id: int):
    return templates.TemplateResponse(request, "meeting.html", {"meeting_id": meeting_id})


@app.get("/chat", response_class=HTMLResponse)
def chat_page(request: Request):
    return templates.TemplateResponse(request, "chat.html")
