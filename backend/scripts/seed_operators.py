"""
Seed pre-existing operators for Project Sentinel — Healthcare RBAC.
Run after applying models/healthcare_schema.sql in Supabase.
Uses SUPABASE_DB_URL from .env (sync URL; script uses sync psycopg2 for simplicity).

Seeded credentials (change passwords for any production deployment):

  Role      UUID                                    Password
  --------  --------------------------------------  -----------------------
  doctor    550e8400-e29b-41d4-a716-446655440010    sentinel-doctor-01
  nurse     550e8400-e29b-41d4-a716-446655440011    sentinel-nurse-01
  admin     550e8400-e29b-41d4-a716-446655440012    sentinel-admin-01
  patient   550e8400-e29b-41d4-a716-446655440013    sentinel-patient-01
  auditor   550e8400-e29b-41d4-a716-446655440014    sentinel-auditor-01
"""

from __future__ import annotations

import os
import sys

# Add backend root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

import bcrypt
import psycopg

# ──────────────────────────────────────────────────────────────────────────────
# Healthcare operator credentials (pre-provisioned; never self-registered)
# ──────────────────────────────────────────────────────────────────────────────

OPERATORS = [
    # ── Doctors ───────────────────────────────────────────────────────────────
    {
        "operator_uuid": "550e8400-e29b-41d4-a716-446655440010",
        "password": "sentinel-doctor-01",
        "role": "doctor",
    },
    # ── Nurses ────────────────────────────────────────────────────────────────
    {
        "operator_uuid": "550e8400-e29b-41d4-a716-446655440011",
        "password": "sentinel-nurse-01",
        "role": "nurse",
    },
    # ── Admins (manage operators & assignments; no medical record access) ──────
    {
        "operator_uuid": "550e8400-e29b-41d4-a716-446655440012",
        "password": "sentinel-admin-01",
        "role": "admin",
    },
    # ── Patients (decrypt own records only) ───────────────────────────────────
    {
        "operator_uuid": "550e8400-e29b-41d4-a716-446655440013",
        "password": "sentinel-patient-01",
        "role": "patient",
    },
    # ── Auditors (view audit logs + SSE search; no decryption) ────────────────
    {
        "operator_uuid": "550e8400-e29b-41d4-a716-446655440014",
        "password": "sentinel-auditor-01",
        "role": "auditor",
    },
]

# Sample doctor → patient assignment seeded alongside operators
DOCTOR_PATIENT_ASSIGNMENTS = [
    {
        "doctor_id": "550e8400-e29b-41d4-a716-446655440010",   # doctor-01
        "patient_id": "550e8400-e29b-41d4-a716-446655440013",  # patient-01
    },
    {
        "doctor_id": "550e8400-e29b-41d4-a716-446655440011",   # nurse-01 — also assigned
        "patient_id": "550e8400-e29b-41d4-a716-446655440013",  # patient-01
    },
]


def main() -> None:
    url = os.environ.get("SUPABASE_DB_URL")
    if not url:
        print("ERROR: SUPABASE_DB_URL not set in .env")
        sys.exit(1)

    conn = psycopg.connect(url)
    try:
        # ── Seed operators ─────────────────────────────────────────────────────
        for op in OPERATORS:
            pw_hash = bcrypt.hashpw(
                op["password"].encode("utf-8"),
                bcrypt.gensalt(),
            ).decode("utf-8")
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.operators (operator_uuid, password_hash, role)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (operator_uuid) DO UPDATE
                    SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
                    """,
                    (op["operator_uuid"], pw_hash, op["role"]),
                )
        conn.commit()
        print("✓ Operators seeded.")

        # ── Seed doctor-patient assignments ───────────────────────────────────
        for assignment in DOCTOR_PATIENT_ASSIGNMENTS:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.doctor_patient_map (doctor_id, patient_id)
                    VALUES (%s, %s)
                    ON CONFLICT (doctor_id, patient_id) DO NOTHING
                    """,
                    (assignment["doctor_id"], assignment["patient_id"]),
                )
        conn.commit()
        print("✓ Doctor-patient assignments seeded.")

        # ── Print summary ──────────────────────────────────────────────────────
        print()
        print("─" * 80)
        print(" Healthcare Operator Credentials")
        print("─" * 80)
        print(f"{'Role':<10} {'UUID':<40} {'Password'}")
        print("─" * 80)
        for op in OPERATORS:
            print(f"{op['role']:<10} {op['operator_uuid']:<40} {op['password']}")
        print()
        print("Sample doctor-patient assignment: doctor-01 → patient-01 (and nurse-01 → patient-01)")
        print("─" * 80)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
