-- ============================================================================
-- Project Sentinel — Governance Refactor Migration
-- Run in Supabase SQL Editor AFTER healthcare_schema.sql and dual_auth_schema.sql
-- ============================================================================
-- Adds department, branch, and record_type columns to patient_records.
-- sensitivity_level already exists (added by dual_auth_schema.sql).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Step 1: Add governance metadata columns to patient_records
-- ----------------------------------------------------------------------------
ALTER TABLE public.patient_records
  ADD COLUMN IF NOT EXISTS department  TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS branch      TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS record_type TEXT NOT NULL DEFAULT 'GENERAL';

COMMENT ON COLUMN public.patient_records.department  IS 'Hospital department that created this record (e.g. Cardiology, Radiology)';
COMMENT ON COLUMN public.patient_records.branch      IS 'Hospital branch or facility location';
COMMENT ON COLUMN public.patient_records.record_type IS 'Category of record (e.g. LAB_RESULT, PRESCRIPTION, NOTE, IMAGING, GENERAL)';


-- ----------------------------------------------------------------------------
-- Step 2: Indexes for new columns
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_patient_records_department
  ON public.patient_records (department);

CREATE INDEX IF NOT EXISTS idx_patient_records_record_type
  ON public.patient_records (record_type);

CREATE INDEX IF NOT EXISTS idx_patient_records_branch
  ON public.patient_records (branch);


-- ----------------------------------------------------------------------------
-- Step 3: Verify final schema shape
-- ----------------------------------------------------------------------------
-- Expected columns after all migrations:
--   id                UUID        PRIMARY KEY
--   patient_id        UUID        NOT NULL
--   department        TEXT        NOT NULL DEFAULT ''
--   branch            TEXT        NOT NULL DEFAULT ''
--   record_type       TEXT        NOT NULL DEFAULT 'GENERAL'
--   sensitivity_level TEXT        NOT NULL DEFAULT 'LOW'  (from dual_auth_schema.sql)
--   encrypted_payload TEXT        NOT NULL
--   ngram_hashes      TEXT[]
--   created_by        UUID        NOT NULL
--   created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
