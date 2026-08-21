-- Korean lexical retrieval, and the chunk-level provenance it made measurable.
--
-- Dense retrieval over BGE-M3 stays exactly as it is. This adds the second axis:
-- Kiwi cuts each chunk and each fact down to its searchable morphemes (see
-- app/services/lexical.py), PostgreSQL indexes that string as a tsvector, and
-- app/services/rag.py fuses the two rankings with RRF.
--
-- No OpenSearch, no Elasticsearch. `tsvector` + GIN is the same inverted index
-- those products are built on, it is already in this database, and the corpus is
-- one organisation's meetings.

-- `lexemes` is written by the same code that writes the embedding — index_transcript
-- for a chunk, intelligence.build for a fact — so it can never describe a
-- different revision of the text than the vector does. It is an index, not
-- content: nothing renders it, and the transcript is untouched.
--
-- lexeme_tsv is GENERATED, so the tsvector cannot drift out of sync with the
-- string it came from, and no application code may write it. Only the two-argument
-- to_tsvector(regconfig, text) is IMMUTABLE, which is why 'simple' is spelled out;
-- 'simple' is also the only correct choice, because the stemming was already done
-- by Kiwi and no built-in configuration knows Korean.
ALTER TABLE {{SCHEMA}}.chunks
    ADD COLUMN IF NOT EXISTS lexemes TEXT;
ALTER TABLE {{SCHEMA}}.chunks
    ADD COLUMN IF NOT EXISTS lexeme_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('simple', coalesce(lexemes, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_chunks_lexeme_tsv
    ON {{SCHEMA}}.chunks USING gin (lexeme_tsv);

ALTER TABLE {{SCHEMA}}.meeting_facts
    ADD COLUMN IF NOT EXISTS lexemes TEXT;
ALTER TABLE {{SCHEMA}}.meeting_facts
    ADD COLUMN IF NOT EXISTS lexeme_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('simple', coalesce(lexemes, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_facts_lexeme_tsv
    ON {{SCHEMA}}.meeting_facts USING gin (lexeme_tsv);

-- Which transcript segments a chunk was built from.
--
-- meeting_facts has carried this since 004 and chunks never did: a chunk's
-- provenance was its meeting plus a time range, which is enough to show a reader
-- but not enough to state which approved utterance an answer rests on. Retrieval
-- quality could not be measured at the segment level either — Hit@K needs to
-- compare a retrieved chunk against an expected utterance id.
--
-- Nullable and no CHECK, unlike meeting_facts.source_segment_ids: rows written
-- before this migration have no ids to fill in, and inventing them would be
-- worse than leaving them absent. Re-indexing a meeting fills it.
ALTER TABLE {{SCHEMA}}.chunks
    ADD COLUMN IF NOT EXISTS source_segment_ids BIGINT[];
