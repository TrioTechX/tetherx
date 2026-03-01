-- =============================================================================
-- Project Sentinel — Supabase / PostgreSQL Schema
-- Run each section in order inside the Supabase SQL Editor.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- available in Supabase by default


-- ---------------------------------------------------------------------------
-- 1. watchlist
--    Stores encrypted operation names and serialised Bloom filter blobs.
--    Never holds plaintext classified terms.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.watchlist (
    id                   UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    operation_name       TEXT        NOT NULL,   -- AES-256-GCM encrypted hex
    bloom_filter_data    BYTEA       NOT NULL,   -- serialised BloomFilter.to_bytes()
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_watchlist_updated_at ON public.watchlist;
CREATE TRIGGER trg_watchlist_updated_at
    BEFORE UPDATE ON public.watchlist
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Watchlist is admin-only — no public read by default (RLS will lock it down).
ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;

-- Only the service role (backend) may read/write watchlist.
CREATE POLICY "service_role_full_access_watchlist"
    ON public.watchlist
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);


-- ---------------------------------------------------------------------------
-- 2. chat_logs
--    Stores AES-256-GCM encrypted chat payloads + threat flags.
--    Plaintext is NEVER stored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chat_logs (
    id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    unit_id             TEXT        NOT NULL,           -- originating unit identifier
    timestamp           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    encrypted_payload   TEXT        NOT NULL,           -- AES-GCM hex blob
    threat_flag         BOOLEAN     NOT NULL DEFAULT FALSE,
    match_count         INTEGER     NOT NULL DEFAULT 0, -- number of Bloom hits
    ngram_hash_sample   TEXT[],                         -- optional: first 5 hashes (audit)
    ngram_hashes        TEXT[]      DEFAULT '{}',       -- full hashes for SSE search
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_logs_unit_id    ON public.chat_logs (unit_id);
CREATE INDEX IF NOT EXISTS idx_chat_logs_ngram_hashes ON public.chat_logs USING GIN (ngram_hashes);
CREATE INDEX IF NOT EXISTS idx_chat_logs_threat_flag ON public.chat_logs (threat_flag);
CREATE INDEX IF NOT EXISTS idx_chat_logs_timestamp   ON public.chat_logs (timestamp DESC);

ALTER TABLE public.chat_logs ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- 3. Row Level Security — chat_logs
--
--    Authenticated frontend users may only SELECT their own unit's rows.
--    The unit_id is matched against the JWT claim 'unit_id' embedded by the
--    backend when issuing Supabase Auth tokens, OR against a user_metadata
--    field set during signup.
--
--    INSERT / UPDATE / DELETE is reserved for the service_role (backend).
-- ---------------------------------------------------------------------------

-- Frontend users: read rows where unit_id matches their JWT metadata
CREATE POLICY "users_read_own_unit_logs"
    ON public.chat_logs
    FOR SELECT
    TO authenticated
    USING (
        unit_id = (auth.jwt() -> 'user_metadata' ->> 'unit_id')
    );

-- Backend service role: unrestricted access
CREATE POLICY "service_role_full_access_chat_logs"
    ON public.chat_logs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);


-- ---------------------------------------------------------------------------
-- 4. Supabase Realtime Publication
--    Enables frontend clients to subscribe to INSERT events on chat_logs.
-- ---------------------------------------------------------------------------

-- Add chat_logs to the default Supabase realtime publication.
-- If the publication doesn't exist yet, create it first.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
    ) THEN
        CREATE PUBLICATION supabase_realtime FOR TABLE public.chat_logs;
    ELSE
        ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_logs;
    END IF;
END
$$;

-- Ensure Realtime row filtering is set to 'full' so the entire new row
-- (including threat_flag) is sent in the payload.
ALTER TABLE public.chat_logs REPLICA IDENTITY FULL;


-- ---------------------------------------------------------------------------
-- 5. Seed: Sample watchlist entry (for development / demo only)
--    In production, entries are inserted by the backend crypto engine.
--    bloom_filter_data is a placeholder zero-byte blob here.
-- ---------------------------------------------------------------------------
INSERT INTO public.watchlist (operation_name, bloom_filter_data)
VALUES (
    'DEMO_ENCRYPTED_OPERATION_NAME',  -- replace with actual AES-GCM output
    '\x'::bytea                        -- replace with BloomFilter.to_bytes() output
)
ON CONFLICT DO NOTHING;
