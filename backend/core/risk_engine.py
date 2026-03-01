"""
Project Sentinel — Risk Scoring Engine

Pure, synchronous risk scoring — no I/O, no HTTP, no authorization side-effects.

Classes:
    AccessDecision  — frozen result: risk_score, action, reasons, flagged
    RiskScoringEngine — evaluate(ctx, access_frequency) -> AccessDecision

Risk rules (additive):
    +30  operator not assigned to patient (doctor/nurse roles only)
    +20  cross-branch access
    +25  sensitivity == HIGH
    +40  sensitivity == CRITICAL
    +15  access outside shift hours
    +10  access frequency in last hour > 5

Thresholds:
    < 40  → AUTO_APPROVE
    40–69 → REQUIRE_JUSTIFICATION
    70–89 → REQUIRE_SECOND_APPROVAL
    ≥ 90  → DENY (flagged = True)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger("sentinel.risk_engine")

# ---------------------------------------------------------------------------
# Actions & thresholds
# ---------------------------------------------------------------------------

ACTION_AUTO_APPROVE            = "AUTO_APPROVE"
ACTION_REQUIRE_JUSTIFICATION   = "REQUIRE_JUSTIFICATION"
ACTION_REQUIRE_SECOND_APPROVAL = "REQUIRE_SECOND_APPROVAL"
ACTION_DENY                    = "DENY"

_THRESHOLD_JUSTIFICATION    = 40
_THRESHOLD_SECOND_APPROVAL  = 70
_THRESHOLD_DENY             = 90

# Roles for which the assignment check is meaningful
_ASSIGNABLE_ROLES = frozenset({"doctor", "nurse"})


# ---------------------------------------------------------------------------
# AccessDecision
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AccessDecision:
    """
    Immutable result of a risk evaluation.

    Fields
    ------
    risk_score : int
        Cumulative numeric risk score (0+). Higher = riskier.
    action : str
        One of: AUTO_APPROVE, REQUIRE_JUSTIFICATION,
        REQUIRE_SECOND_APPROVAL, DENY.
    reasons : list[str]
        Human-readable list of risk factors that contributed to the score.
        Empty when risk_score == 0.
    flagged : bool
        True only when action is DENY. Signals that the access attempt
        should be recorded in a security flag log by the calling layer.
    """

    risk_score: int
    action: str
    reasons: list[str]
    flagged: bool


# ---------------------------------------------------------------------------
# RiskScoringEngine
# ---------------------------------------------------------------------------


class RiskScoringEngine:
    """
    Stateless, pure risk scorer.

    Usage
    -----
        engine = RiskScoringEngine()
        decision = engine.evaluate(ctx, access_frequency=3)

    The engine does NOT perform any I/O, raise HTTP exceptions, or make
    authorization decisions in the sense of persisting state.  It is the
    caller's responsibility to act on the returned AccessDecision.
    """

    def evaluate(
        self,
        ctx: "AccessContext",  # type: ignore[name-defined]  # forward-ref
        access_frequency: int,
    ) -> AccessDecision:
        """
        Compute a risk score from the provided context and recent access count.

        Parameters
        ----------
        ctx : AccessContext
            Fully populated context from ContextEngine.build_context().
        access_frequency : int
            Number of record-access requests made by this operator in the
            last 60 minutes (inclusive of the current attempt).

        Returns
        -------
        AccessDecision
            Frozen dataclass with risk_score, action, reasons, flagged.
        """
        score = 0
        reasons: list[str] = []

        # ── Rule 1: unassigned doctor/nurse accessing a patient record ────────
        if ctx.role in _ASSIGNABLE_ROLES and not ctx.assigned:
            score += 30
            reasons.append("Operator not assigned to requested patient (+30)")

        # ── Rule 2: cross-branch access ───────────────────────────────────────
        if ctx.cross_branch:
            score += 20
            reasons.append("Cross-branch access detected (+20)")

        # ── Rule 3/4: record sensitivity ─────────────────────────────────────
        if ctx.sensitivity == "CRITICAL":
            score += 40
            reasons.append("Record sensitivity is CRITICAL (+40)")
        elif ctx.sensitivity == "HIGH":
            score += 25
            reasons.append("Record sensitivity is HIGH (+25)")

        # ── Rule 5: outside shift hours ───────────────────────────────────────
        if ctx.after_hours:
            score += 15
            reasons.append("Access outside configured shift hours (+15)")

        # ── Rule 6: high access frequency ─────────────────────────────────────
        if access_frequency > 5:
            score += 10
            reasons.append(
                f"High access frequency: {access_frequency} requests in last hour (+10)"
            )

        # ── Threshold classification ──────────────────────────────────────────
        action, flagged = self._classify(score)

        decision = AccessDecision(
            risk_score=score,
            action=action,
            reasons=reasons,
            flagged=flagged,
        )

        logger.info(
            "RiskEval | role=%s sensitivity=%s score=%d action=%s flagged=%s",
            ctx.role,
            ctx.sensitivity,
            score,
            action,
            flagged,
        )

        return decision

    # ── Private ──────────────────────────────────────────────────────────────

    @staticmethod
    def _classify(score: int) -> tuple[str, bool]:
        """Map a numeric score to an (action, flagged) pair."""
        if score >= _THRESHOLD_DENY:
            return ACTION_DENY, True
        if score >= _THRESHOLD_SECOND_APPROVAL:
            return ACTION_REQUIRE_SECOND_APPROVAL, False
        if score >= _THRESHOLD_JUSTIFICATION:
            return ACTION_REQUIRE_JUSTIFICATION, False
        return ACTION_AUTO_APPROVE, False
