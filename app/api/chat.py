from fastapi import APIRouter
from pydantic import BaseModel

from app.services import rag

router = APIRouter(prefix="/api", tags=["chat"])


class ChatRequest(BaseModel):
    question: str
    meeting_id: int | None = None
    top_k: int = 6


@router.post("/chat")
def chat(body: ChatRequest):
    result = rag.answer(body.question.strip(), body.meeting_id, min(max(body.top_k, 1), 12))
    return {"answer": result["answer"], "sources": rag.serialize_sources(result["sources"])}
