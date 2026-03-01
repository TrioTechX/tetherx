"""
Project Sentinel — Contextual Access Evaluation Engine

Provides context *gathering* only — no authorization decisions are made here.

Classes:
    AccessContext  — structured output describing all relevant access context
    ContextEngine  — async engine that populates an AccessContext from live data

Usage:
    engine = ContextEngine()
    ctx = await engine.build_context(
        operator=operator_claims,
        requested_patient_id="uuid",
        sensitivity_level="HIGH",
        db=db_session,
    )
    # ctx.assigned, ctx.after_hours, ctx.cross_branch, ... are now populated
    # Authorization decisions are left to the calling layer.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, time, timezone
from typing import TYPE_CHECKING

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

if TYPE_CHECKING:
    from api.deps import OperatorClaims

logger = logging.getLogger("sentinel.context_engine")

# ---------------------------------------------------------------------------
# Sentinel values
# ---------------------------------------------------------------------------

_SENSITIVITY_LEVELS = frozenset({"LOW", "MEDIUM", "HIGH", "CRITICAL"})


# ---------------------------------------------------------------------------
# AccessContext — the structured context object
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AccessContext:
    """
    Immutable snapshot of all context relevant to an access attempt.

    Fields
    ------
    role : str
        The operator's healthcare role (doctor, nurse, admin, patient, auditor).
    department : str | None
        The operator's registered department, or None if not set.
    branch : str | None
        The operator's registered branch / facility, or None if not set.
    assigned : bool
        True when the operator appears in doctor_patient_map for the
        requested patient. Always False for roles that cannot be mapped
        (admin, patient, auditor).
    after_hours : bool
        True when the current UTC time falls outside the operator's
        shift_start / shift_end window. False when shift hours are not
        configured (no restriction signal).
    cross_branch : bool
        True when the operator's branch differs from the branch recorded
        on the patient's most recent record. False when either branch is
        unknown (None) — ambiguity is not treated as a restriction.
    sensitivity : str
        Normalised sensitivity level of the target record
        (LOW | MEDIUM | HIGH | CRITICAL).

    Notes
    -----
    This dataclass carries *facts*, not decisions. No field here represents
    a permit or a deny. Authorization logic lives exclusively in the calling
    layer (e.g. policy engine, route handler).
    """

    role: str
    department: str | None
    branch: str | None
    assigned: bool
    after_hours: bool
    cross_branch: bool
    sensitivity: str


# ---------------------------------------------------------------------------
# ContextEngine
# ---------------------------------------------------------------------------


class ContextEngine:
    """
    Stateless async engine for gathering access context.

    The engine queries the database for facts about the operator and the
    requested patient, then assembles them into an AccessContext.

    It never raises HTTPException and never returns a permit/deny decision.
    """

    # ── Public API ────────────────────────────────────────────────────────────

    async def build_context(
        self,
        *,
        operator: "OperatorClaims",
        requested_patient_id: str,
        sensitivity_level: str,
        db: AsyncSession,
    ) -> AccessContext:
        """
        Gather all contextual facts for an access attempt and return an
        AccessContext.

        Parameters
        ----------
        operator : OperatorClaims
            The decoded JWT claims for the requesting operator.
        requested_patient_id : str
            UUID of the patient whose record is being accessed.
        sensitivity_level : str
            Sensitivity of the target record (LOW/MEDIUM/HIGH/CRITICAL).
            Case-insensitive; will be normalised to upper-case.
        db : AsyncSession
            Active SQLAlchemy async session for DB lookups.

        Returns
        -------
        AccessContext
            Fully populated context snapshot. Never raises.
        """
        normalised_sensitivity = self._normalise_sensitivity(sensitivity_level)
        current_utc_time = datetime.now(timezone.utc).time()

        # Evaluate each context dimension independently so one failure
        # never silently suppresses the others.
        assigned = await self._check_assigned(operator, requested_patient_id, db)
        after_hours = self._check_after_hours(operator, current_utc_time)
        cross_branch = await self._check_cross_branch(
            operator, requested_patient_id, db
        )

        ctx = AccessContext(
            role=operator.role,
            department=operator.department,
            branch=operator.branch,
            assigned=assigned,
            after_hours=after_hours,
            cross_branch=cross_branch,
            sensitivity=normalised_sensitivity,
        )

        logger.debug(
            "AccessContext built | operator=%s patient=%s "
            "assigned=%s after_hours=%s cross_branch=%s sensitivity=%s",
            operator.sub,
            requested_patient_id,
            assigned,
            after_hours,
            cross_branch,
            normalised_sensitivity,
        )

        return ctx

    # ── Internal helpers ──────────────────────────────────────────────────────

    @staticmethod
    def _normalise_sensitivity(raw: str) -> str:
        """Upper-case and validate sensitivity; fall back to LOW on unknown."""
        upper = raw.strip().upper()
        if upper not in _SENSITIVITY_LEVELS:
            logger.warning(
                "Unknown sensitivity level %r — treating as LOW", raw
            )
            return "LOW"
        return upper

    @staticmethod
    def _parse_shift_time(raw: str | None) -> time | None:
        """Parse a 'HH:MM' or 'HH:MM:SS' string into a `datetime.time`.

        Returns None on any parse failure so missing shift data never blocks
        context evaluation.
        """
        if not raw:
            return None
        for fmt in ("%H:%M:%S", "%H:%M"):
            try:
                return datetime.strptime(raw, fmt).time()
            except ValueError:
                continue
        logger.debug("Could not parse shift time %r", raw)
        return None

    # ── Context dimension evaluators ──────────────────────────────────────────

    async def _check_assigned(
        self,
        operator: "OperatorClaims",
        requested_patient_id: str,
        db: AsyncSession,
    ) -> bool:
        """
        Return True if the operator is in doctor_patient_map for this patient.

        Fast-path: if operator.assigned_patient_ids (from the JWT) already
        contains the patient, we skip the DB query.

        Roles that cannot be mapped (admin, auditor, patient) always
        return False — the mapping table is only for doctor/nurse.
        """
        if operator.role not in ("doctor", "nurse"):
            return False

        # Fast path: JWT already carries the assignment list
        if requested_patient_id in operator.assigned_patient_ids:
            return True

        # Fallback: re-check DB in case assignments changed post-login
        try:
            result = await db.execute(
                text(
                    "SELECT 1 FROM public.doctor_patient_map "
                    "WHERE doctor_id = :doc AND patient_id = :pat LIMIT 1"
                ),
                {"doc": operator.sub, "pat": requested_patient_id},
            )
            return result.first() is not None
        except Exception as exc:
            logger.warning(
                "doctor_patient_map lookup failed for operator=%s patient=%s: %s",
                operator.sub,
                requested_patient_id,
                exc,
            )
            return False

    def _check_after_hours(
        self,
        operator: "OperatorClaims",
        current_time: time,
    ) -> bool:
        """
        Return True if *current_time* (UTC) falls outside the operator's
        configured shift window.

        Rules:
        - If shift_start or shift_end is not configured → return False
          (no shift restriction, not treated as after-hours).
        - Handles overnight shifts (shift_end < shift_start) correctly.
        """
        shift_start = self._parse_shift_time(operator.shift_start)
        shift_end = self._parse_shift_time(operator.shift_end)

        if shift_start is None or shift_end is None:
            # No shift configured — cannot determine after-hours status
            return False

        if shift_start <= shift_end:
            # Normal day shift: e.g. 08:00 → 17:00
            in_shift = shift_start <= current_time <= shift_end
        else:
            # Overnight shift: e.g. 22:00 → 06:00
            in_shift = current_time >= shift_start or current_time <= shift_end

        return not in_shift

    async def _check_cross_branch(
        self,
        operator: "OperatorClaims",
        requested_patient_id: str,
        db: AsyncSession,
    ) -> bool:
        """
        Return True when the operator's branch differs from the branch on
        the patient's most recent record.

        Returns False (no cross-branch signal) when:
        - operator.branch is None (operator has no branch configured)
        - The patient has no records yet
        - The patient's record has no branch set
        - Any DB error occurs (fail-open for context, not auth)
        """
        if not operator.branch:
            return False

        try:
            result = await db.execute(
                text(
                    "SELECT branch FROM public.patient_records "
                    "WHERE patient_id = :patient_id "
                    "ORDER BY created_at DESC LIMIT 1"
                ),
                {"patient_id": requested_patient_id},
            )
            row = result.mappings().first()
        except Exception as exc:
            logger.warning(
                "patient_records branch lookup failed for patient=%s: %s",
                requested_patient_id,
                exc,
            )
            return False

        if not row:
            return False

        patient_branch = row.get("branch") or ""
        if not patient_branch:
            return False

        return operator.branch.strip().lower() != patient_branch.strip().lower()
