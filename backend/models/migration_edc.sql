-- ============================================================================
-- Project Sentinel — Ephemeral Decryption Capability (EDC) Migration
-- Run in Supabase SQL Editor AFTER healthcare_schema.sql
-- ============================================================================
-- Creates the temporary_access_tokens table used by the EDCEngine to issue
-- short-lived (5-minute), operator-scoped, single-use decryption tokens.
--
-- Plaintext is NEVER stored in this table or anywhere in the DB.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.temporary_access_tokens (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id TEXT        NOT NULL,       -- operator_uuid who holds this token
    patient_id  UUID        NOT NULL,       -- patient the token grants access for
    record_id   UUID        NOT NULL,       -- specific patient_record the token is for
    expires_at  TIMESTAMPTZ NOT NULL,       -- NOW() + 5 minutes at issue time
    approved_by TEXT        DEFAULT NULL,   -- second-approver UUID (nullable)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient operator lookups (token validation path)
CREATE INDEX IF NOT EXISTS idx_tat_operator_id
    ON public.temporary_access_tokens (operator_id);

-- Index for cleanup jobs: delete expired tokens cheaply
CREATE INDEX IF NOT EXISTS idx_tat_expires_at
    ON public.temporary_access_tokens (expires_at);

-- Index for record-scoped lookups
CREATE INDEX IF NOT EXISTS idx_tat_record_id
    ON public.temporary_access_tokens (record_id);

-- RLS: only the service role (backend) manages tokens
ALTER TABLE public.temporary_access_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_tat"
    ON public.temporary_access_tokens
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ── Optional: scheduled cleanup (run via pg_cron or manually) ───────────────
-- DELETE FROM public.temporary_access_tokens WHERE expires_at < NOW();
