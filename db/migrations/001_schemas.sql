-- Two schemas in one database (docs/adr/0002): `commerce` for the business
-- domain, `ai` for the agent harness. Splitting them later is a connection-string
-- change, not a data migration.
CREATE SCHEMA IF NOT EXISTS commerce;
CREATE SCHEMA IF NOT EXISTS ai;

-- Extensions live in `public`, which stays on every connection's search_path.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;  -- embeddings (ai schema)
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;  -- case-insensitive email
