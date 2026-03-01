"""
Project Sentinel — Operator Provisioning Helper
================================================
Generates a bcrypt-hashed INSERT statement to paste into the Supabase SQL Editor.

Usage:
    python scripts/create_operator.py

No database connection required — output is just a SQL snippet.
"""

import uuid
import bcrypt

VALID_ROLES = ["doctor", "nurse", "admin", "patient", "auditor"]


def main() -> None:
    print("\n=== Project Sentinel — Create Operator ===\n")

    # UUID
    auto_uuid = str(uuid.uuid4())
    raw_uuid = input(f"Operator UUID [press Enter to generate: {auto_uuid}]: ").strip()
    operator_uuid = raw_uuid if raw_uuid else auto_uuid

    # Password
    password = input("Password: ").strip()
    if not password:
        print("Password cannot be empty.")
        return

    # Role
    print(f"Roles: {', '.join(VALID_ROLES)}")
    role = input("Role: ").strip().lower()
    if role not in VALID_ROLES:
        print(f"Invalid role. Choose from: {VALID_ROLES}")
        return

    # Hash
    hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode()

    print("\n--- Copy this into Supabase SQL Editor ---\n")
    print(f"""INSERT INTO public.operators (operator_uuid, password_hash, role)
VALUES (
    '{operator_uuid}',
    '{hashed}',
    '{role}'
);""")
    print(f"\nOperator UUID (use this to log in): {operator_uuid}")
    print("------------------------------------------\n")


if __name__ == "__main__":
    main()
