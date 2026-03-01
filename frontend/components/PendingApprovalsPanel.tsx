"use client";

/**
 * PendingApprovalsPanel — Doctor-role panel for dual-authorization of CRITICAL records.
 *
 * Shows all PENDING access requests that the current doctor can approve/deny.
 * Doctors cannot approve their own requests (enforced backend-side too).
 *
 * Usage:
 *   import { PendingApprovalsPanel } from "@/components/PendingApprovalsPanel";
 *   <PendingApprovalsPanel apiUrl={apiUrl} />
 */

import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldAlert, ShieldCheck, Clock, RefreshCw, X, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingRequest {
    id: string;
    operator_id: string;
    patient_id: string;
    record_id: string;
    status: "PENDING" | "APPROVED" | "DENIED";
    approved_by: string | null;
    created_at: string;
    approved_at: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function shortId(uuid: string): string {
    return uuid.slice(0, 8) + "…";
}

function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    return `${Math.floor(diff / 3_600_000)}h ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Approve / Deny row
// ─────────────────────────────────────────────────────────────────────────────

function RequestRow({
    req,
    onApprove,
    onDeny,
    busy,
}: {
    req: PendingRequest;
    onApprove: (id: string) => void;
    onDeny: (id: string) => void;
    busy: boolean;
}) {
    return (
        <motion.div
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 12 }}
            transition={{ duration: 0.25 }}
            className="border border-sentinel-red/30 rounded-lg p-3 bg-sentinel-red/5 font-mono"
        >
            <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-1.5">
                    <Lock size={11} className="text-sentinel-red shrink-0" />
                    <span className="text-[10px] text-sentinel-red font-bold tracking-widest">
                        CRITICAL ACCESS REQUEST
                    </span>
                </div>
                <span className="text-[9px] text-sentinel-text-dim shrink-0">
                    {relativeTime(req.created_at)}
                </span>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] mb-3">
                <div>
                    <span className="text-sentinel-text-dim">Requester</span>
                    <p className="text-sentinel-teal font-bold">{shortId(req.operator_id)}</p>
                </div>
                <div>
                    <span className="text-sentinel-text-dim">Patient</span>
                    <p className="text-sentinel-amber">{shortId(req.patient_id)}</p>
                </div>
                <div className="col-span-2">
                    <span className="text-sentinel-text-dim">Record</span>
                    <p className="text-sentinel-text/70">{shortId(req.record_id)}</p>
                </div>
            </div>

            <div className="flex gap-2">
                <button
                    id={`approve-${req.id}`}
                    disabled={busy}
                    onClick={() => onApprove(req.id)}
                    className={cn(
                        "flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[10px] font-bold",
                        "border border-sentinel-green/40 text-sentinel-green bg-sentinel-green/10",
                        "hover:bg-sentinel-green/20 hover:border-sentinel-green/60 transition-all",
                        "disabled:opacity-40 disabled:cursor-not-allowed"
                    )}
                >
                    <ShieldCheck size={11} />
                    APPROVE
                </button>
                <button
                    id={`deny-${req.id}`}
                    disabled={busy}
                    onClick={() => onDeny(req.id)}
                    className={cn(
                        "flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[10px] font-bold",
                        "border border-sentinel-red/30 text-sentinel-red bg-sentinel-red/5",
                        "hover:bg-sentinel-red/15 hover:border-sentinel-red/50 transition-all",
                        "disabled:opacity-40 disabled:cursor-not-allowed"
                    )}
                >
                    <X size={11} />
                    DENY
                </button>
            </div>
        </motion.div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast notification
// ─────────────────────────────────────────────────────────────────────────────

function Toast({ message, type }: { message: string; type: "success" | "error" }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className={cn(
                "absolute top-2 right-2 z-10 text-[10px] font-mono font-bold px-2 py-1 rounded border",
                type === "success"
                    ? "border-sentinel-green/40 bg-sentinel-green/10 text-sentinel-green"
                    : "border-sentinel-red/40 bg-sentinel-red/10 text-sentinel-red"
            )}
        >
            {message}
        </motion.div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Panel
// ─────────────────────────────────────────────────────────────────────────────

export function PendingApprovalsPanel({ apiUrl }: { apiUrl: string }) {
    const [requests, setRequests] = useState<PendingRequest[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

    const showToast = (msg: string, type: "success" | "error") => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 3000);
    };

    const fetchPending = useCallback(async () => {
        try {
            const res = await fetch(`${apiUrl}/api/access/pending`, {
                credentials: "include",
            });
            if (res.ok) {
                const data = (await res.json()) as PendingRequest[];
                setRequests(data);
            }
        } catch {
            // network error — keep previous list
        } finally {
            setLoading(false);
        }
    }, [apiUrl]);

    useEffect(() => {
        fetchPending();
        // Poll every 15 s so new requests appear without a manual refresh
        const id = setInterval(fetchPending, 15_000);
        return () => clearInterval(id);
    }, [fetchPending]);

    const handleAction = async (requestId: string, action: "approve" | "deny") => {
        setBusy(true);
        try {
            const res = await fetch(`${apiUrl}/api/access/${action}/${requestId}`, {
                method: "POST",
                credentials: "include",
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                showToast(
                    action === "approve" ? "✓ Access approved" : "✗ Access denied",
                    action === "approve" ? "success" : "error"
                );
                setRequests((prev) => prev.filter((r) => r.id !== requestId));
            } else {
                showToast(data.detail ?? "Action failed", "error");
            }
        } catch {
            showToast("Network error", "error");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="relative bg-sentinel-surface border border-sentinel-red/30 rounded-lg p-4 font-mono">
            {/* Header */}
            <div className="flex items-center gap-2 mb-3">
                <ShieldAlert size={14} className="text-sentinel-red" />
                <span className="text-[10px] tracking-widest uppercase text-sentinel-red font-semibold">
                    Pending Approvals
                </span>
                {requests.length > 0 && (
                    <motion.span
                        animate={{ opacity: [1, 0.3, 1] }}
                        transition={{ repeat: Infinity, duration: 0.8 }}
                        className="ml-1 w-1.5 h-1.5 rounded-full bg-sentinel-red inline-block"
                    />
                )}
                <button
                    id="refresh-pending"
                    onClick={() => { setLoading(true); fetchPending(); }}
                    className="ml-auto text-sentinel-text-dim hover:text-sentinel-teal transition-colors"
                    title="Refresh"
                >
                    <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
                </button>
            </div>

            {/* Toast */}
            <AnimatePresence>
                {toast && <Toast message={toast.msg} type={toast.type} />}
            </AnimatePresence>

            {/* Empty state */}
            {!loading && requests.length === 0 && (
                <div className="flex items-center gap-3 py-4 text-sentinel-text-dim">
                    <Clock size={18} className="shrink-0" />
                    <div>
                        <p className="text-[11px] font-semibold text-sentinel-green">NO PENDING REQUESTS</p>
                        <p className="text-[10px] mt-0.5">All CRITICAL record requests handled</p>
                    </div>
                </div>
            )}

            {/* Loading skeleton */}
            {loading && (
                <div className="space-y-2">
                    {[1, 2].map((i) => (
                        <div key={i} className="h-20 rounded border border-sentinel-border/40 skeleton" />
                    ))}
                </div>
            )}

            {/* Request list */}
            <div className="space-y-2 max-h-96 overflow-y-auto">
                <AnimatePresence mode="popLayout">
                    {requests.map((req) => (
                        <RequestRow
                            key={req.id}
                            req={req}
                            onApprove={(id) => handleAction(id, "approve")}
                            onDeny={(id) => handleAction(id, "deny")}
                            busy={busy}
                        />
                    ))}
                </AnimatePresence>
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// CriticalLockBadge — inline badge for displaying CRITICAL records
// ─────────────────────────────────────────────────────────────────────────────

export function CriticalLockBadge() {
    return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold border border-sentinel-red/50 bg-sentinel-red/10 text-sentinel-red tracking-wider">
            <motion.span
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ repeat: Infinity, duration: 0.6 }}
            >
                <Lock size={8} />
            </motion.span>
            CRITICAL
        </span>
    );
}
