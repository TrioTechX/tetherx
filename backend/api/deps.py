"""
Project Sentinel — Healthcare RBAC Auth Dependencies

Provides reusable FastAPI dependencies for:
  • JWT decoding + operator claims extraction (incl. contextual identity fields)
  • Role-based access control (require_role)
  • Patient-level access control (check_patient_access)
  • Audit log row insertion helper
  • Client IP extraction helper
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request, status

from config.settings import get_settings
from models.database import get_db
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

logger = logging.getLogger("sentinel.deps")

# ──────────────────────────────────────────────────────────────────────────────
# Valid healthcare roles
# ──────────────────────────────────────────────────────────────────────────────

HEALTHCARE_ROLES = frozenset({"doctor", "nurse", "admin", "patient", "auditor"})

# Cookie name used by the backend to store the session JWT
COOKIE_NAME = "sentinel_auth"

# ──────────────────────────────────────────────────────────────────────────────
# Operator claims dataclass (extracted from JWT)
# ──────────────────────────────────────────────────────────────────────────────


@dataclass
class OperatorClaims:
    """
    Decoded JWT claims for an authenticated operator.

    Core identity fields (always present):
        sub   — operator UUID (matches operators.operator_uuid)
        role  — one of HEALTHCARE_ROLES

    Contextual identity fields (populated at login from the operators table;
    safe defaults used for tokens issued before this migration so existing
    sessions continue working without re-login):
        department      — hospital department (e.g. "Cardiology")
        branch          — hospital branch / facility
        clearance_level — int 1–5; controls access to sensitivity tiers
        shift_start     — start of authorised hours, "HH:MM:SS" string or None
        shift_end       — end of authorised hours, "HH:MM:SS" string or None
    """

    sub: str                                         # operator UUID
    role: str                                        # one of HEALTHCARE_ROLES
    assigned_patient_ids: list[str] = field(default_factory=list)

    # Contextual identity — default to None / baseline so old tokens are safe
    department: str | None = None
    branch: str | None = None
    clearance_level: int = 1
    shift_start: str | None = None   # "HH:MM:SS" or None
    shift_end: str | None = None     # "HH:MM:SS" or None


# ──────────────────────────────────────────────────────────────────────────────
# Bearer token extractor
# ──────────────────────────────────────────────────────────────────────────────

def _decode_token(token: str) -> OperatorClaims:
    """Decode and validate a JWT, returning OperatorClaims. Raises 401 on failure."""
    settings = get_settings()
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session expired — please log in again",
        )
    except jwt.InvalidTokenError as exc:
        logger.debug("JWT validation failure: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid session — please log in again",
        )

    sub = payload.get("sub")
    role = payload.get("role")
    if not sub or not role:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Malformed session token",
        )
    if role not in HEALTHCARE_ROLES:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unrecognised role in session token",
        )

    assigned = payload.get("assigned_patient_ids", [])
    if not isinstance(assigned, list):
        assigned = []

    # Contextual identity fields — safe defaults for tokens pre-dating migration
    department = payload.get("department") or None
    branch = payload.get("branch") or None
    clearance_level = int(payload.get("clearance_level") or 1)
    shift_start = payload.get("shift_start") or None
    shift_end = payload.get("shift_end") or None

    return OperatorClaims(
        sub=sub,
        role=role,
        assigned_patient_ids=assigned,
        department=department,
        branch=branch,
        clearance_level=clearance_level,
        shift_start=shift_start,
        shift_end=shift_end,
    )


async def get_current_operator(request: Request) -> OperatorClaims:
    """
    FastAPI dependency — reads the HttpOnly `sentinel_auth` cookie and validates
    the JWT inside it.
    Raises HTTP 401 if the cookie is absent, expired, or invalid.
    """
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated — please log in",
        )
    return _decode_token(token)


# ──────────────────────────────────────────────────────────────────────────────
# Role-based access control
# ──────────────────────────────────────────────────────────────────────────────


def require_role(allowed_roles: list[str]):
    """
    Dependency factory — returns a dependency that raises HTTP 403
    if the current operator's role is not in *allowed_roles*.

    Usage:
        @router.post("/some-endpoint")
        async def handler(
            operator: Annotated[OperatorClaims, Depends(require_role(["doctor", "admin"]))]
        ):
            ...
    """
    allowed = frozenset(allowed_roles)

    async def _check(
        operator: Annotated[OperatorClaims, Depends(get_current_operator)],
    ) -> OperatorClaims:
        if operator.role not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Role '{operator.role}' is not permitted to perform this action. "
                       f"Required: {sorted(allowed)}",
            )
        return operator

    return _check


# ──────────────────────────────────────────────────────────────────────────────
# Patient-level access control
# ──────────────────────────────────────────────────────────────────────────────


async def check_patient_access(
    patient_id: str,
    operator: OperatorClaims,
    db: AsyncSession,
) -> None:
    """
    Enforce per-role patient access rules:

    • doctor  → must appear in doctor_patient_map for this patient_id
    • nurse   → must appear in doctor_patient_map for this patient_id
    • patient → operator.sub must equal patient_id (self-access only)
    • admin   → always denied (admins manage, do not access records)
    • auditor → always denied (auditors view logs, not records)

    Raises HTTP 403 on any access violation.
    """
    role = operator.role

    if role in ("admin", "auditor"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Role '{role}' is not permitted to access patient records.",
        )

    if role == "patient":
        if operator.sub != patient_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Patients may only access their own records.",
            )
        return

    if role in ("doctor", "nurse"):
        # Fast path: JWT already contains assigned list (validated at login)
        if patient_id in operator.assigned_patient_ids:
            return
        # Fallback: re-check DB in case assignments changed since token was issued
        result = await db.execute(
            text(
                "SELECT 1 FROM public.doctor_patient_map "
                "WHERE doctor_id = :doc AND patient_id = :pat LIMIT 1"
            ),
            {"doc": operator.sub, "pat": patient_id},
        )
        if result.first() is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You are not assigned to this patient.",
            )
        return

    # Unknown role — deny
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Access denied.",
    )


# ──────────────────────────────────────────────────────────────────────────────
# Audit log helper
# ──────────────────────────────────────────────────────────────────────────────


async def insert_audit_log(
    db: AsyncSession,
    *,
    operator_id: str,
    patient_id: str | None,
    action: str,
    ip_address: str | None,
) -> None:
    """
    Insert a row in public.access_audit_log.
    Errors are caught and logged — audit failures must not block the primary response.
    """
    try:
        await db.execute(
            text(
                """
                INSERT INTO public.access_audit_log
                    (operator_id, patient_id, action, ip_address)
                VALUES
                    (:operator_id, :patient_id, :action, :ip_address)
                """
            ),
            {
                "operator_id": operator_id,
                "patient_id": patient_id,
                "action": action,
                "ip_address": ip_address,
            },
        )
        await db.commit()
    except Exception as exc:
        logger.error("Audit log write failed (operator=%s action=%s): %s", operator_id, action, exc)
        try:
            await db.rollback()
        except Exception:
            pass


# ──────────────────────────────────────────────────────────────────────────────
# Client IP helper
# ──────────────────────────────────────────────────────────────────────────────


def get_client_ip(request: Request) -> str | None:
    """Extract the real client IP, respecting X-Forwarded-For if behind a proxy."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None
