"""
Project Sentinel — Auth: Cookie-based JWT session management.

Endpoints:
  POST /api/auth/login   — validate credentials, set HttpOnly sentinel_auth cookie
  GET  /api/me           — return current session claims (reads cookie)
  POST /api/auth/logout  — clear the sentinel_auth cookie
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import Annotated

import jwt
import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import COOKIE_NAME, OperatorClaims, get_current_operator
from config.settings import get_settings
from models.database import get_db

logger = logging.getLogger("sentinel.auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Second router for top-level /api endpoints (e.g. /api/me)
api_router = APIRouter(prefix="/api", tags=["auth"])

# Valid healthcare roles
VALID_ROLES = frozenset({"doctor", "nurse", "admin", "patient", "auditor"})

# Roles that receive an assigned_patient_ids list in their JWT
_ASSIGNED_ROLES = frozenset({"doctor", "nurse"})


# ─────────────────────────────────────────────────────────────────────────────
# Request / Response schemas
# ─────────────────────────────────────────────────────────────────────────────


class LoginRequest(BaseModel):
    uuid: str = Field(..., description="Operator UUID (pre-provisioned identifier)")
    password: str = Field(..., min_length=1, description="Operator password")


class LoginResponse(BaseModel):
    """
    Returns session identity info so the frontend can hydrate auth state
    immediately after login without reading the HttpOnly cookie.
    The JWT itself is NOT returned — it lives in the HttpOnly cookie only.
    """
    role: str
    assigned_patient_ids: list[str] = []
    department: str | None = None
    branch: str | None = None
    clearance_level: int = 1


class MeResponse(BaseModel):
    """Current session claims, populated from the HttpOnly cookie."""
    sub: str
    role: str
    assigned_patient_ids: list[str] = []
    department: str | None = None
    branch: str | None = None
    clearance_level: int = 1


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/auth/login
# ─────────────────────────────────────────────────────────────────────────────


@router.post("/login", response_model=LoginResponse)
async def login(
    body: LoginRequest,
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> LoginResponse:
    """
    Authenticate operator and set an HttpOnly session cookie.

    Cookie properties:
      Name:     sentinel_auth
      HttpOnly: True   — invisible to JavaScript
      Secure:   configurable (True in prod, False for local HTTP dev)
      SameSite: strict  — CSRF protection
      Max-Age:  JWT_EXPIRE_MINUTES * 60  (default 24 h)

    The JWT token is NOT returned in the response body.
    """
    raw_uuid = body.uuid.strip()
    if not raw_uuid:
        raise HTTPException(status_code=400, detail="UUID is required")

    # Try the full query first (with context columns from migration_context_engine.sql).
    # Fall back to the base 3-column query if those columns don't exist yet —
    # this keeps login working before the migration has been run in Supabase.
    _context_cols_present = True
    try:
        result = await db.execute(
            text(
                "SELECT operator_uuid, password_hash, role, "
                "department, branch, clearance_level, shift_start, shift_end "
                "FROM public.operators WHERE operator_uuid = :uuid"
            ),
            {"uuid": raw_uuid},
        )
        row = next(result.mappings(), None)
    except Exception as col_exc:
        if "column" in str(col_exc).lower() or "does not exist" in str(col_exc).lower():
            logger.warning(
                "Context columns not found in operators table — "
                "run migration_context_engine.sql. Falling back to base query. (%s)",
                col_exc,
            )
            _context_cols_present = False
            await db.rollback()
            result = await db.execute(
                text(
                    "SELECT operator_uuid, password_hash, role "
                    "FROM public.operators WHERE operator_uuid = :uuid"
                ),
                {"uuid": raw_uuid},
            )
            row = next(result.mappings(), None)
        else:
            raise

    if not row:
        raise HTTPException(status_code=401, detail="Invalid operator UUID or password")

    stored_hash = row["password_hash"]
    if isinstance(stored_hash, str):
        stored_hash = stored_hash.encode("utf-8")
    if not bcrypt.checkpw(body.password.encode("utf-8"), stored_hash):
        raise HTTPException(status_code=401, detail="Invalid operator UUID or password")

    role = str(row["role"])
    if role not in VALID_ROLES:
        raise HTTPException(status_code=500, detail="Invalid role in database")

    # ── Extract contextual identity fields (safe defaults if columns absent) ──
    if _context_cols_present:
        department: str | None = row.get("department") or None
        branch: str | None = row.get("branch") or None
        clearance_level: int = int(row.get("clearance_level") or 1)
        shift_start_raw = row.get("shift_start")
        shift_end_raw = row.get("shift_end")
        shift_start: str | None = str(shift_start_raw) if shift_start_raw is not None else None
        shift_end: str | None = str(shift_end_raw) if shift_end_raw is not None else None
    else:
        department = None
        branch = None
        clearance_level = 1
        shift_start = None
        shift_end = None

    # ── Fetch assigned patient IDs for doctor / nurse roles ──────────────────
    assigned_patient_ids: list[str] = []
    if role in _ASSIGNED_ROLES:
        try:
            map_result = await db.execute(
                text(
                    "SELECT patient_id FROM public.doctor_patient_map "
                    "WHERE doctor_id = :doctor_id"
                ),
                {"doctor_id": raw_uuid},
            )
            assigned_patient_ids = [str(r["patient_id"]) for r in map_result.mappings()]
        except Exception as exc:
            logger.warning("Could not fetch assigned patients for %s: %s", raw_uuid, exc)

    # ── Build JWT ─────────────────────────────────────────────────────────────
    settings = get_settings()
    expires = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {
        "sub": raw_uuid,
        "role": role,
        "assigned_patient_ids": assigned_patient_ids,
        # Contextual identity — embedded so OperatorClaims is fully populated
        # on every request without an extra DB round-trip.
        "department": department,
        "branch": branch,
        "clearance_level": clearance_level,
        "shift_start": shift_start,
        "shift_end": shift_end,
        "exp": expires,
        "iat": datetime.now(timezone.utc),
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    if isinstance(token, bytes):
        token = token.decode("utf-8")

    # ── Set HttpOnly cookie — JWT never exposed to JavaScript ─────────────────
    max_age = settings.jwt_expire_minutes * 60
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=max_age,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_same_site,
        path="/",
    )

    logger.info("Login OK | uuid=%s role=%s department=%s branch=%s", raw_uuid, role, department, branch)

    return LoginResponse(
        role=role,
        assigned_patient_ids=assigned_patient_ids,
        department=department,
        branch=branch,
        clearance_level=clearance_level,
    )


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/me — return current session from cookie
# ─────────────────────────────────────────────────────────────────────────────


@api_router.get("/me", response_model=MeResponse)
async def me(
    operator: Annotated[OperatorClaims, Depends(get_current_operator)],
) -> MeResponse:
    """
    Return the current operator's session claims decoded from the HttpOnly cookie.
    Used by the frontend on app load to hydrate auth state without storing the JWT.
    Returns 401 if the cookie is absent or expired.
    """
    return MeResponse(
        sub=operator.sub,
        role=operator.role,
        assigned_patient_ids=operator.assigned_patient_ids,
        department=operator.department,
        branch=operator.branch,
        clearance_level=operator.clearance_level,
    )


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/auth/logout — clear the session cookie
# ─────────────────────────────────────────────────────────────────────────────


@router.post("/logout", tags=["auth"])
async def logout(response: Response) -> dict:
    """
    Clear the sentinel_auth HttpOnly cookie, ending the session.
    Safe to call even when not logged in.
    """
    response.delete_cookie(
        key=COOKIE_NAME,
        path="/",
        httponly=True,
        secure=get_settings().cookie_secure,
        samesite=get_settings().cookie_same_site,
    )
    return {"message": "Logged out successfully"}
