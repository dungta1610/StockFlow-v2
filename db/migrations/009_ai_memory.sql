-- The agent harness's own storage, ported from AI-Harness (db/init/001..005) into
-- the `ai` schema with three changes the ported version could not have:
--
--  1. `chat_sessions` carries a tenant and an owner. The original had four columns
--     and no notion of who a conversation belongs to, so any caller holding a
--     session id could read any transcript. Tenancy is not a role check: it is a
--     column, and every read path filters on it.
--  2. `embedding_cache` keys on the input type as well as the content and model.
--     Cohere Embed v3 is asymmetric — the same sentence embeds differently as a
--     document than as a query — so a key without it returns the wrong vector
--     silently, and the calibrated 0.28 score floor stops meaning anything.
--  3. Everything is schema-qualified. The API pool runs with
--     `search_path=commerce,public`, so an unqualified `memories` here would land
--     in the commerce schema.
--
-- Embeddings are vector(1024): Cohere Embed Multilingual v3 behind the
-- `default-embed` alias. Changing the model behind that alias means changing this
-- column type AND re-embedding every row — see docs/adr/0003. The dimension is
-- asserted against the configured gateway dimension by
-- test/harness/embedding-dimension-matches-migration.spec.ts.

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

-- Lexical half of hybrid search. 'simple' tokenises without language-specific
-- stemming, which suits a multilingual corpus — but on its own it does not fold
-- diacritics, so "Khanh" fails to match "Khánh". Folding through unaccent fixes
-- exactly the exact-name lookups hybrid search exists to catch.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'simple_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION public.simple_unaccent ( COPY = pg_catalog.simple );
    ALTER TEXT SEARCH CONFIGURATION public.simple_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH public.unaccent, simple;
  END IF;
END $$;

-- ── Sessions ────────────────────────────────────────────────────────────────
-- `tenant_id` and `owner_user_id` are plain uuids with no foreign key: the harness
-- is a domain-agnostic package and must not depend on commerce.organizations
-- existing. The application supplies them from the authenticated actor.
CREATE TABLE IF NOT EXISTS ai.chat_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name           text NOT NULL,
  tenant_id            uuid NOT NULL,
  owner_user_id        uuid NOT NULL,
  -- Newest chat_messages.id already handed to a consolidation pass. The marker
  -- moves forward before the pass runs, so a failed pass is not retried on every
  -- following turn; nothing is lost because the next pass re-reads the whole
  -- transcript.
  consolidated_through bigint NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_tenant
  ON ai.chat_sessions (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai.chat_messages (
  id         bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES ai.chat_sessions(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('user', 'assistant')),
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session
  ON ai.chat_messages (session_id, created_at, id);

-- Running summary of the turns that have aged out of the replay window.
-- `covered_through` records the newest message already folded in, so each pass
-- only reads what arrived since.
CREATE TABLE IF NOT EXISTS ai.session_summaries (
  session_id      uuid PRIMARY KEY REFERENCES ai.chat_sessions(id) ON DELETE CASCADE,
  summary         text NOT NULL,
  covered_through bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Long-term memory ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai.memories (
  id             bigserial PRIMARY KEY,
  -- Scope key. Every statement in MemoryStore filters on it — that WHERE clause,
  -- not a method parameter, is what keeps one tenant's memory out of another's.
  namespace      text NOT NULL,
  content        text NOT NULL,
  metadata       jsonb NOT NULL DEFAULT '{}',
  embedding      vector(1024) NOT NULL,
  -- Retrieval weight for facts that matter more than others.
  importance     real NOT NULL DEFAULT 0.5,
  -- Set when a newer memory replaces this one. Read paths skip superseded rows,
  -- so a wrong supersede stays auditable and recoverable instead of being deleted.
  superseded_at  timestamptz,
  -- The conversation this was extracted from; null when written directly.
  source_session uuid REFERENCES ai.chat_sessions(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- The two-argument to_tsvector is IMMUTABLE, so it works in a generated column
  -- even though the configuration routes through unaccent (the one-argument form
  -- depends on a session setting and does not).
  content_tsv    tsvector GENERATED ALWAYS AS (to_tsvector('public.simple_unaccent', content)) STORED
);

CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw
  ON ai.memories USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_memories_content_tsv
  ON ai.memories USING gin (content_tsv);

-- Every read path filters `superseded_at IS NULL`, so index only the live rows.
CREATE INDEX IF NOT EXISTS idx_memories_live_namespace
  ON ai.memories (namespace) WHERE superseded_at IS NULL;

-- ── Embedding cache ─────────────────────────────────────────────────────────
-- `input_type` is part of the key, not a detail: an asymmetric embedding model
-- returns a different vector for the same string depending on whether it is being
-- stored or searched with. Keyed without it, the cache would hand back the wrong
-- half of the pair and every similarity number downstream would quietly shift.
CREATE TABLE IF NOT EXISTS ai.embedding_cache (
  content_hash text NOT NULL,
  model        text NOT NULL,
  input_type   text NOT NULL,
  embedding    vector(1024) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, model, input_type)
);
