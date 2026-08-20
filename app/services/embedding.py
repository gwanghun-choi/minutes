"""Local sentence-transformers embedding (BGE-M3 by default)."""
from functools import lru_cache

from app import config


@lru_cache(maxsize=1)
def _model():
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(
        config.EMBEDDING_MODEL, device=config.resolve_device(config.EMBEDDING_DEVICE)
    )


@lru_cache(maxsize=1)
def dimension() -> int:
    return int(_model().get_sentence_embedding_dimension())


def encode(texts: list[str]) -> list[list[float]]:
    vecs = _model().encode(
        texts, batch_size=8, normalize_embeddings=True, show_progress_bar=False
    )
    return [v.tolist() for v in vecs]


def encode_one(text: str) -> list[float]:
    return encode([text])[0]
