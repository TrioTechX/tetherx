-- =============================================================================
-- Migration: Add ngram_hashes for SSE search over encrypted chat_logs
-- Run in Supabase SQL Editor if you already have chat_logs without this column.
-- =============================================================================

-- Add column for full list of HMAC n-gram hashes (enables search by trapdoor)
ALTER TABLE public.chat_logs
ADD COLUMN IF NOT EXISTS ngram_hashes TEXT[] DEFAULT '{}';

-- GIN index for fast overlap queries: WHERE ngram_hashes && :query_hashes
CREATE INDEX IF NOT EXISTS idx_chat_logs_ngram_hashes
ON public.chat_logs USING GIN (ngram_hashes);

COMMENT ON COLUMN public.chat_logs.ngram_hashes IS 'Full set of HMAC-SHA256 n-gram hashes for SSE search; never stores plaintext.';
