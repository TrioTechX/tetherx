"use client";

/**
 * Healthcare Dashboard — role-aware UI for all 5 healthcare operators.
 *
 * Doctor  → Create/decrypt records + CRITICAL approval panel
 * Nurse   → Metadata-only view (no decrypt)
 * Admin   → Assign doctors to patients + audit log
 * Patient → Decrypt own records
 * Auditor → Audit log + search
 */

import {
    useState,
    useEffect,
    useCallback,
    type ReactNode,
} from "react";

import { motion, AnimatePresence } from "framer-motion";
import {
    Shield,
    Stethoscope,
    HeartPulse,
    Settings,
    User,
    ClipboardList,
    LogOut,
    Lock,
    Unlock,
    Search,
    Plus,
    Eye,
    ShieldAlert,
    ShieldCheck,
    RefreshCw,
    X,
    Clock,
    FileText,
    UserPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AuthRole } from "@/app/auth-context";
import { PendingApprovalsPanel, CriticalLockBadge } from "@/components/PendingApprovalsPanel";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getApiUrl() {
    return typeof window !== "undefined"
        ? (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000")
        : "http://localhost:8000";
}

function apiFetch(path: string, init: RequestInit = {}) {
    return fetch(`${getApiUrl()}${path}`, {
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
        ...init,
    });
}

/**
 * Normalise FastAPI error responses to a single display string.
 *
 * FastAPI returns two shapes:
 *   • { detail: "some string" }          — HTTPException / custom errors
 *   • { detail: [{loc, msg, type, input}, …] }  — 422 Pydantic validation errors
 *
 * Passing the array directly to React as a child crashes with:
 *   "Objects are not valid as a React child"
 */
function extractErrorMessage(data: Record<string, unknown> | null | undefined, fallback = "Request failed"): string {
    if (!data) return fallback;
    const detail = data.detail;
    if (!detail) return fallback;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
        // Each item has { msg: string, loc: string[] }
        return detail
            .map((e: unknown) => {
                if (typeof e === "object" && e !== null) {
                    const err = e as Record<string, unknown>;
                    const loc = Array.isArray(err.loc) ? (err.loc as string[]).slice(1).join(".") : "";
                    const msg = typeof err.msg === "string" ? err.msg : JSON.stringify(err);
                    return loc ? `${loc}: ${msg}` : msg;
                }
                return String(e);
            })
            .join(" · ");
    }
    return String(detail);
}


function relativeTime(iso: string) {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    return `${Math.floor(diff / 3_600_000)}h ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// UI atoms
// ─────────────────────────────────────────────────────────────────────────────

function SectionCard({ title, icon: Icon, children, accent = "teal" }: {
    title: string;
    icon: React.ElementType;
    children: ReactNode;
    accent?: "teal" | "green" | "amber" | "red" | "blue";
}) {
    const colors: Record<string, string> = {
        teal: "text-sentinel-teal border-sentinel-teal/30",
        green: "text-sentinel-green border-sentinel-green/30",
        amber: "text-sentinel-amber border-sentinel-amber/30",
        red: "text-sentinel-red border-sentinel-red/30",
        blue: "text-blue-400 border-blue-400/30",
    };
    return (
        <div className={cn("bg-sentinel-surface border rounded-lg p-4 font-mono", colors[accent].split(" ")[1])}>
            <div className={cn("flex items-center gap-2 mb-4 text-[10px] tracking-widest uppercase font-semibold", colors[accent].split(" ")[0])}>
                <Icon size={13} />
                {title}
            </div>
            {children}
        </div>
    );
}

function InputField({ label, value, onChange, placeholder, type = "text", disabled = false }: {
    label: string; value: string; onChange: (v: string) => void;
    placeholder?: string; type?: string; disabled?: boolean;
}) {
    return (
        <div>
            <label className="block text-[10px] text-sentinel-text-dim uppercase tracking-wider mb-1">{label}</label>
            <input
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                className="w-full bg-sentinel-deep border border-sentinel-border rounded px-3 py-2 text-sm text-sentinel-green placeholder-sentinel-text-dim/50 focus:outline-none focus:border-sentinel-teal/50 font-mono disabled:opacity-40"
            />
        </div>
    );
}

function Btn({ children, onClick, disabled, variant = "teal", className }: {
    children: ReactNode; onClick?: () => void; disabled?: boolean;
    variant?: "teal" | "green" | "red" | "amber" | "blue"; className?: string;
}) {
    const colors: Record<string, string> = {
        teal: "border-sentinel-teal/50 text-sentinel-teal bg-sentinel-teal/10 hover:bg-sentinel-teal/20",
        green: "border-sentinel-green/50 text-sentinel-green bg-sentinel-green/10 hover:bg-sentinel-green/20",
        red: "border-sentinel-red/40 text-sentinel-red bg-sentinel-red/5 hover:bg-sentinel-red/15",
        amber: "border-sentinel-amber/50 text-sentinel-amber bg-sentinel-amber/10 hover:bg-sentinel-amber/20",
        blue: "border-blue-400/50 text-blue-400 bg-blue-400/10 hover:bg-blue-400/20",
    };
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "px-4 py-2 rounded text-[11px] font-bold tracking-widest border transition-all",
                colors[variant],
                "disabled:opacity-40 disabled:cursor-not-allowed",
                className
            )}
        >
            {children}
        </button>
    );
}

function Toast({ message, type }: { message: string; type: "ok" | "err" }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            className={cn(
                "fixed top-4 right-4 z-50 text-[11px] font-mono font-bold px-3 py-2 rounded border shadow-lg",
                type === "ok"
                    ? "border-sentinel-green/40 bg-sentinel-surface text-sentinel-green"
                    : "border-sentinel-red/40 bg-sentinel-surface text-sentinel-red"
            )}
        >{message}</motion.div>
    );
}

function useToast() {
    const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
    const show = useCallback((msg: string, type: "ok" | "err") => {
        setToast({ msg, type });
        setTimeout(() => setToast(null), 3500);
    }, []);
    return { toast, show };
}

// ─────────────────────────────────────────────────────────────────────────────
// Role header strip
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
    doctor: { label: "DOCTOR", icon: Stethoscope, color: "text-sentinel-teal" },
    nurse: { label: "NURSE", icon: HeartPulse, color: "text-sentinel-green" },
    admin: { label: "ADMIN", icon: Settings, color: "text-sentinel-amber" },
    patient: { label: "PATIENT", icon: User, color: "text-blue-400" },
    auditor: { label: "AUDITOR", icon: ClipboardList, color: "text-sentinel-red" },
};

function Header({ role, uuid, onSignOut }: { role: string; uuid: string; onSignOut: () => void }) {
    const meta = ROLE_META[role] ?? { label: role.toUpperCase(), icon: Shield, color: "text-sentinel-green" };
    const Icon = meta.icon;
    return (
        <header className="border-b border-sentinel-border bg-sentinel-surface/80 backdrop-blur px-6 py-3">
            <div className="max-w-7xl mx-auto flex items-center gap-4">
                <Shield size={20} className="text-sentinel-green text-glow-green" />
                <span className="text-sentinel-green font-bold tracking-[0.2em] text-sm">PROJECT SENTINEL</span>
                <span className="text-sentinel-border">|</span>
                <div className={cn("flex items-center gap-1.5 text-[11px] font-bold tracking-widest", meta.color)}>
                    <Icon size={13} />
                    {meta.label} CONSOLE
                </div>
                <div className="ml-auto flex items-center gap-4">
                    <span className="text-[9px] text-sentinel-text-dim font-mono tracking-widest hidden sm:block">
                        {uuid.slice(0, 16)}…
                    </span>
                    <button
                        onClick={onSignOut}
                        className="flex items-center gap-1.5 text-[10px] text-sentinel-text-dim hover:text-sentinel-red transition-colors"
                    >
                        <LogOut size={12} /> SIGN OUT
                    </button>
                </div>
            </div>
        </header>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create Patient Record panel (doctor / nurse)
// ─────────────────────────────────────────────────────────────────────────────

function CreateRecordPanel() {
    const [patientId, setPatientId] = useState("");
    const [plaintext, setPlaintext] = useState("");
    const [sensitivity, setSensitivity] = useState("LOW");
    const [busy, setBusy] = useState(false);
    const [lastRecord, setLastRecord] = useState<{ record_id: string; sensitivity_level: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const { toast, show } = useToast();

    const submit = async () => {
        if (!patientId.trim() || !plaintext.trim()) { show("Fill all fields", "err"); return; }
        setBusy(true);
        setLastRecord(null);
        try {
            const res = await apiFetch("/api/patients/records", {
                method: "POST",
                body: JSON.stringify({ patient_id: patientId.trim(), plaintext_record: plaintext, sensitivity_level: sensitivity }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setLastRecord({ record_id: data.record_id, sensitivity_level: data.sensitivity_level });
                show("✓ Record encrypted & saved", "ok");
                setPlaintext("");
            } else {
                show(extractErrorMessage(data, "Failed to create record"), "err");
            }
        } catch {
            show("Network error", "err");
        } finally {
            setBusy(false);
        }
    };

    const copyId = () => {
        if (!lastRecord) return;
        navigator.clipboard.writeText(lastRecord.record_id).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    return (
        <SectionCard title="Create Patient Record" icon={Plus} accent="teal">
            <AnimatePresence>{toast && <Toast message={toast.msg} type={toast.type} />}</AnimatePresence>
            <div className="space-y-3">
                <InputField label="Patient UUID" value={patientId} onChange={setPatientId} placeholder="550e8400-…" />
                <div>
                    <label className="block text-[10px] text-sentinel-text-dim uppercase tracking-wider mb-1">Sensitivity</label>
                    <select
                        value={sensitivity}
                        onChange={(e) => setSensitivity(e.target.value)}
                        className="w-full bg-sentinel-deep border border-sentinel-border rounded px-3 py-2 text-sm text-sentinel-green focus:outline-none focus:border-sentinel-teal/50 font-mono"
                    >
                        {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((s) => (
                            <option key={s} value={s}>{s}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label className="block text-[10px] text-sentinel-text-dim uppercase tracking-wider mb-1">Medical Record Text</label>
                    <textarea
                        value={plaintext}
                        onChange={(e) => setPlaintext(e.target.value)}
                        rows={4}
                        placeholder="Patient has hypertension, prescribed lisinopril 10mg…"
                        className="w-full bg-sentinel-deep border border-sentinel-border rounded px-3 py-2 text-sm text-sentinel-green placeholder-sentinel-text-dim/50 focus:outline-none focus:border-sentinel-teal/50 font-mono resize-none"
                    />
                </div>
                <Btn onClick={submit} disabled={busy} variant="teal" className="w-full">
                    {busy ? "ENCRYPTING…" : "ENCRYPT & SAVE"}
                </Btn>

                {/* ── Created record result — stays visible for copy ─── */}
                <AnimatePresence>
                    {lastRecord && (
                        <motion.div
                            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                            className="border border-sentinel-teal/30 rounded p-3 bg-sentinel-teal/5 space-y-2"
                        >
                            <div className="flex items-center gap-2">
                                <ShieldCheck size={12} className="text-sentinel-teal shrink-0" />
                                <span className="text-[10px] text-sentinel-teal font-bold tracking-widest">RECORD CREATED</span>
                                <span className="ml-auto text-[9px] text-sentinel-text-dim">{lastRecord.sensitivity_level}</span>
                            </div>
                            <div>
                                <p className="text-[9px] text-sentinel-text-dim uppercase tracking-wider mb-1">Record ID — copy this to decrypt</p>
                                <div className="flex items-center gap-2">
                                    <code className="flex-1 bg-sentinel-deep rounded px-2 py-1.5 text-[10px] text-sentinel-green font-mono break-all">
                                        {lastRecord.record_id}
                                    </code>
                                    <button
                                        onClick={copyId}
                                        className="shrink-0 px-2 py-1.5 rounded border border-sentinel-teal/40 text-[9px] text-sentinel-teal hover:bg-sentinel-teal/10 transition-all font-mono tracking-wider"
                                    >
                                        {copied ? "✓ COPIED" : "COPY"}
                                    </button>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </SectionCard>
    );
}


// ─────────────────────────────────────────────────────────────────────────────
// Decrypt Record panel (doctor / patient)
// ─────────────────────────────────────────────────────────────────────────────

interface DecryptResult {
    record_id: string;
    patient_id: string;
    sensitivity_level: string;
    plaintext: string | null;
    requires_approval: boolean;
    pending_request_id: string | null;
    role_accessed_as: string;
}

function DecryptPanel({ initialRecordId }: { initialRecordId?: string } = {}) {
    const [recordId, setRecordId] = useState(initialRecordId ?? "");
    const [result, setResult] = useState<DecryptResult | null>(null);
    const [busy, setBusy] = useState(false);
    const { toast, show } = useToast();

    const decrypt = async () => {
        if (!recordId.trim()) { show("Enter a Record UUID", "err"); return; }
        setBusy(true);
        setResult(null);
        try {
            const res = await apiFetch("/api/patients/decrypt", {
                method: "POST",
                body: JSON.stringify({ record_id: recordId.trim() }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setResult(data as DecryptResult);
                if (data.requires_approval) {
                    show("CRITICAL record — awaiting second doctor approval", "err");
                } else {
                    show("✓ Decrypted", "ok");
                }
            } else {
                show(extractErrorMessage(data, "Decryption failed"), "err");
            }
        } catch {
            show("Network error", "err");
        } finally {
            setBusy(false);
        }
    };

    return (
        <SectionCard title="Decrypt Patient Record" icon={Unlock} accent="green">
            <AnimatePresence>{toast && <Toast message={toast.msg} type={toast.type} />}</AnimatePresence>
            <div className="space-y-3">
                <InputField label="Record UUID" value={recordId} onChange={setRecordId} placeholder="UUID of the patient record" />
                <Btn onClick={decrypt} disabled={busy} variant="green" className="w-full">
                    {busy ? "DECRYPTING…" : "DECRYPT"}
                </Btn>

                <AnimatePresence>
                    {result && (
                        <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="space-y-2 mt-2">
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-sentinel-text-dim">SENSITIVITY:</span>
                                {result.sensitivity_level === "CRITICAL"
                                    ? <CriticalLockBadge />
                                    : <span className="text-[10px] text-sentinel-amber font-bold">{result.sensitivity_level}</span>
                                }
                            </div>

                            {result.requires_approval ? (
                                <div className="border border-sentinel-amber/40 rounded p-3 bg-sentinel-amber/5">
                                    <div className="flex items-center gap-2 mb-1">
                                        <Clock size={12} className="text-sentinel-amber" />
                                        <span className="text-[11px] text-sentinel-amber font-bold">AWAITING SECOND DOCTOR APPROVAL</span>
                                    </div>
                                    <p className="text-[10px] text-sentinel-text-dim">
                                        Request ID: <span className="text-sentinel-teal">{result.pending_request_id}</span>
                                    </p>
                                    <p className="text-[10px] text-sentinel-text-dim mt-1">
                                        A second authorized doctor must approve via the Pending Approvals panel before you can decrypt this CRITICAL record.
                                    </p>
                                </div>
                            ) : result.plaintext ? (
                                <div className="border border-sentinel-green/30 rounded p-3 bg-sentinel-green/5">
                                    <div className="flex items-center gap-2 mb-2">
                                        <ShieldCheck size={12} className="text-sentinel-green" />
                                        <span className="text-[10px] text-sentinel-green font-bold">DECRYPTED RECORD</span>
                                    </div>
                                    <p className="text-sm text-sentinel-green font-mono whitespace-pre-wrap">{result.plaintext}</p>
                                </div>
                            ) : null}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </SectionCard>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient Metadata panel (nurse)
// ─────────────────────────────────────────────────────────────────────────────

function PatientMetadataPanel() {
    const [patientId, setPatientId] = useState("");
    const [records, setRecords] = useState<{ record_id: string; created_at: string; encrypted_preview: string }[]>([]);
    const [busy, setBusy] = useState(false);
    const { toast, show } = useToast();

    const load = async () => {
        if (!patientId.trim()) { show("Enter a Patient UUID", "err"); return; }
        setBusy(true);
        try {
            const res = await apiFetch(`/api/patients/${patientId.trim()}/records`);
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setRecords(data);
                show(`${data.length} records found`, "ok");
            } else {
                show(extractErrorMessage(data, "Error loading records"), "err");
            }
        } catch {
            show("Network error", "err");
        } finally {
            setBusy(false);
        }
    };

    return (
        <SectionCard title="Patient Record Metadata (Nurse View)" icon={Eye} accent="green">
            <AnimatePresence>{toast && <Toast message={toast.msg} type={toast.type} />}</AnimatePresence>
            <div className="space-y-3">
                <InputField label="Patient UUID" value={patientId} onChange={setPatientId} placeholder="550e8400-…" />
                <Btn onClick={load} disabled={busy} variant="green" className="w-full">
                    {busy ? "LOADING…" : "LOAD METADATA"}
                </Btn>
                <div className="space-y-2 max-h-72 overflow-y-auto">
                    {records.map((r) => (
                        <div key={r.record_id} className="border border-sentinel-green/20 rounded p-2 text-[10px] font-mono">
                            <div className="flex items-center gap-2 mb-1">
                                <Lock size={9} className="text-sentinel-text-dim" />
                                <span className="text-sentinel-text-dim">ENCRYPTED</span>
                                <span className="ml-auto text-sentinel-text-dim">{relativeTime(r.created_at)}</span>
                            </div>
                            <p className="text-sentinel-green/60 truncate">{r.encrypted_preview}</p>
                            <p className="text-sentinel-text-dim/60 mt-1">ID: {r.record_id.slice(0, 16)}…</p>
                        </div>
                    ))}
                </div>
            </div>
        </SectionCard>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Search panel (doctor / nurse / auditor)
// ─────────────────────────────────────────────────────────────────────────────

function SearchPanel() {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<{ id: string; patient_id: string; encrypted_preview: string; created_at: string }[]>([]);
    const [busy, setBusy] = useState(false);
    const { toast, show } = useToast();

    const search = async () => {
        if (!query.trim()) return;
        setBusy(true);
        try {
            const res = await apiFetch("/api/patients/search", {
                method: "POST",
                body: JSON.stringify({ query }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setResults(data.matches ?? []);
                show(`${data.matches?.length ?? 0} matches (SSE trapdoor)`, "ok");
            } else {
                show(extractErrorMessage(data, "Search failed"), "err");
            }
        } catch {
            show("Network error", "err");
        } finally {
            setBusy(false);
        }
    };

    return (
        <SectionCard title="Encrypted Record Search (SSE Trapdoor)" icon={Search} accent="teal">
            <AnimatePresence>{toast && <Toast message={toast.msg} type={toast.type} />}</AnimatePresence>
            <div className="space-y-3">
                <div className="flex gap-2">
                    <InputField label="Search query" value={query} onChange={setQuery} placeholder="hypertension, diabetes…" />
                </div>
                <Btn onClick={search} disabled={busy} variant="teal" className="w-full">
                    {busy ? "SEARCHING…" : "SEARCH (NO DECRYPT)"}
                </Btn>
                <p className="text-[9px] text-sentinel-text-dim">Query is hashed via HMAC; records never decrypted during search.</p>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                    {results.map((r) => (
                        <div key={r.id} className="border border-sentinel-teal/20 rounded p-2 text-[10px] font-mono">
                            <div className="flex justify-between text-sentinel-text-dim mb-1">
                                <span>Record: {r.id.slice(0, 12)}…</span>
                                <span>{relativeTime(r.created_at)}</span>
                            </div>
                            <p className="text-sentinel-green/60 truncate">Patient: {r.patient_id.slice(0, 12)}…</p>
                        </div>
                    ))}
                </div>
            </div>
        </SectionCard>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit Log panel (admin / auditor)
// ─────────────────────────────────────────────────────────────────────────────

function AuditLogPanel() {
    const [entries, setEntries] = useState<{ id: string; operator_id: string; patient_id: string | null; action: string; timestamp: string; ip_address: string | null }[]>([]);
    const [loading, setLoading] = useState(false);
    const { toast, show } = useToast();

    const load = async () => {
        setLoading(true);
        try {
            const res = await apiFetch("/api/audit-log");
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setEntries(data);
                show(`${data.length} entries loaded`, "ok");
            } else {
                show(extractErrorMessage(data, "Failed to load audit log"), "err");
            }
        } catch {
            show("Network error", "err");
        } finally {
            setLoading(false);
        }
    };

    const ACTION_COLORS: Record<string, string> = {
        DECRYPT_SUCCESS: "text-sentinel-green",
        CRITICAL_ACCESS_APPROVED: "text-sentinel-green",
        METADATA_VIEW_SUCCESS: "text-sentinel-teal",
        CRITICAL_ACCESS_REQUESTED: "text-sentinel-amber",
        DECRYPT_DENIED_ROLE_PROHIBITED: "text-sentinel-red",
        DECRYPT_FAILED_CRYPTO_ERROR: "text-sentinel-red",
        CRITICAL_ACCESS_DENIED: "text-sentinel-red",
    };

    return (
        <SectionCard title="Access Audit Log" icon={FileText} accent="red">
            <AnimatePresence>{toast && <Toast message={toast.msg} type={toast.type} />}</AnimatePresence>
            <div className="flex items-center justify-between mb-3">
                <Btn onClick={load} disabled={loading} variant="red">
                    {loading ? <RefreshCw size={10} className="animate-spin inline" /> : "LOAD LOG"}
                </Btn>
                <span className="text-[10px] text-sentinel-text-dim">{entries.length} entries</span>
            </div>
            <div className="space-y-1 max-h-96 overflow-y-auto">
                {entries.map((e) => (
                    <div key={e.id} className="border border-sentinel-border/30 rounded px-2 py-1.5 text-[10px] font-mono hover:bg-sentinel-muted/10">
                        <div className="flex items-center justify-between gap-2">
                            <span className={cn("font-bold truncate", ACTION_COLORS[e.action] ?? "text-sentinel-text")}>
                                {e.action}
                            </span>
                            <span className="text-sentinel-text-dim shrink-0">{relativeTime(e.timestamp)}</span>
                        </div>
                        <div className="text-sentinel-text-dim mt-0.5">
                            <span className="text-sentinel-teal">{e.operator_id.slice(0, 12)}…</span>
                            {e.patient_id && <span className="ml-2">patient:{e.patient_id.slice(0, 8)}…</span>}
                            {e.ip_address && <span className="ml-2 opacity-50">{e.ip_address}</span>}
                        </div>
                    </div>
                ))}
            </div>
        </SectionCard>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin — Assign doctor/nurse to patient
// ─────────────────────────────────────────────────────────────────────────────

function AssignDoctorPanel() {
    const [doctorId, setDoctorId] = useState("");
    const [patientId, setPatientId] = useState("");
    const [busy, setBusy] = useState(false);
    const { toast, show } = useToast();

    const assign = async () => {
        if (!doctorId.trim() || !patientId.trim()) { show("Fill both fields", "err"); return; }
        setBusy(true);
        try {
            const res = await apiFetch("/api/doctor-patient-map", {
                method: "POST",
                body: JSON.stringify({ doctor_id: doctorId.trim(), patient_id: patientId.trim() }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                show("✓ Assignment created", "ok");
                setDoctorId(""); setPatientId("");
            } else {
                show(extractErrorMessage(data, "Assignment failed"), "err");
            }
        } catch {
            show("Network error", "err");
        } finally {
            setBusy(false);
        }
    };

    return (
        <SectionCard title="Assign Doctor / Nurse to Patient" icon={UserPlus} accent="amber">
            <AnimatePresence>{toast && <Toast message={toast.msg} type={toast.type} />}</AnimatePresence>
            <div className="space-y-3">
                <InputField label="Doctor or Nurse UUID" value={doctorId} onChange={setDoctorId} placeholder="550e8400-…" />
                <InputField label="Patient UUID" value={patientId} onChange={setPatientId} placeholder="550e8400-…" />
                <Btn onClick={assign} disabled={busy} variant="amber" className="w-full">
                    {busy ? "ASSIGNING…" : "CREATE ASSIGNMENT"}
                </Btn>
            </div>
        </SectionCard>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// My Created Records — metadata history (zero-exposure: no payload returned)
// ─────────────────────────────────────────────────────────────────────────────

interface MyRecord {
    record_id: string;
    patient_id: string;
    record_type: string;
    sensitivity_level: string;
    department: string;
    branch: string;
    created_at: string;
}

const SENSITIVITY_COLORS: Record<string, string> = {
    LOW: "text-sentinel-green  border-sentinel-green/30  bg-sentinel-green/5",
    MEDIUM: "text-sentinel-amber  border-sentinel-amber/30  bg-sentinel-amber/5",
    HIGH: "text-orange-400      border-orange-400/30      bg-orange-400/5",
    CRITICAL: "text-sentinel-red    border-sentinel-red/30    bg-sentinel-red/5",
};

function MyRecordsPanel({ onDecrypt }: { onDecrypt?: (id: string) => void }) {
    const [records, setRecords] = useState<MyRecord[]>([]);
    const [loading, setLoading] = useState(false);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const { toast, show } = useToast();

    const load = async () => {
        setLoading(true);
        try {
            const res = await apiFetch("/api/patients/my-records");
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setRecords(data as MyRecord[]);
                show(`${(data as MyRecord[]).length} records loaded`, "ok");
            } else {
                show(extractErrorMessage(data, "Failed to load records"), "err");
            }
        } catch {
            show("Network error", "err");
        } finally {
            setLoading(false);
        }
    };

    const copyId = (id: string) => {
        navigator.clipboard.writeText(id).then(() => {
            setCopiedId(id);
            setTimeout(() => setCopiedId(null), 2000);
        });
    };

    return (
        <SectionCard title="Records I Created" icon={FileText} accent="teal">
            <AnimatePresence>{toast && <Toast message={toast.msg} type={toast.type} />}</AnimatePresence>
            <div className="flex items-center justify-between mb-3">
                <Btn onClick={load} disabled={loading} variant="teal">
                    {loading ? <RefreshCw size={10} className="animate-spin inline" /> : "LOAD MY RECORDS"}
                </Btn>
                <span className="text-[10px] text-sentinel-text-dim">{records.length} records · metadata only</span>
            </div>

            {records.length === 0 && !loading && (
                <p className="text-[10px] text-sentinel-text-dim text-center py-4">
                    No records yet. Click "LOAD MY RECORDS" to fetch.
                </p>
            )}

            <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                {records.map((r) => (
                    <motion.div
                        key={r.record_id}
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        className="border border-sentinel-border/30 rounded p-3 text-[10px] font-mono hover:bg-sentinel-muted/10 transition-colors"
                    >
                        {/* Top row: type + sensitivity badge + time */}
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-sentinel-teal font-bold">{r.record_type}</span>
                            <span className={`px-1.5 py-0.5 rounded border text-[9px] font-bold ${SENSITIVITY_COLORS[r.sensitivity_level] ?? ""}`}>
                                {r.sensitivity_level}
                            </span>
                            <span className="ml-auto text-sentinel-text-dim">{relativeTime(r.created_at)}</span>
                        </div>

                        {/* Patient */}
                        <p className="text-sentinel-text-dim mb-1">
                            Patient: <span className="text-sentinel-green">{r.patient_id}</span>
                        </p>

                        {/* Full Record ID row */}
                        <div className="flex items-center gap-1.5 mt-2">
                            <code className="flex-1 bg-sentinel-deep rounded px-2 py-1 text-[9px] text-sentinel-green break-all">
                                {r.record_id}
                            </code>
                            <button
                                onClick={() => copyId(r.record_id)}
                                title="Copy record ID"
                                className="shrink-0 px-2 py-1 rounded border border-sentinel-border/40 text-[9px] text-sentinel-text-dim hover:text-sentinel-teal hover:border-sentinel-teal/40 transition-all"
                            >
                                {copiedId === r.record_id ? "✓" : "COPY"}
                            </button>
                            {onDecrypt && (
                                <button
                                    onClick={() => onDecrypt(r.record_id)}
                                    title="Open in decrypt panel"
                                    className="shrink-0 px-2 py-1 rounded border border-sentinel-green/40 text-[9px] text-sentinel-green hover:bg-sentinel-green/10 transition-all"
                                >
                                    DECRYPT →
                                </button>
                            )}
                        </div>
                    </motion.div>
                ))}
            </div>
        </SectionCard>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// My Pending Requests (doctor — own requests waiting for approval)
// ─────────────────────────────────────────────────────────────────────────────


function MyRequestsPanel() {
    const [requests, setRequests] = useState<{ id: string; record_id: string; status: string; created_at: string }[]>([]);
    const [loading, setLoading] = useState(false);
    const { toast, show } = useToast();

    const load = async () => {
        setLoading(true);
        try {
            const res = await apiFetch("/api/access/my-requests");
            const data = await res.json().catch(() => ({}));
            if (res.ok) { setRequests(data); }
            else { show(extractErrorMessage(data, "Error loading requests"), "err"); }
        } catch {
            show("Network error", "err");
        } finally {
            setLoading(false);
        }
    };

    const STATUS_COLORS: Record<string, string> = {
        PENDING: "text-sentinel-amber",
        APPROVED: "text-sentinel-green",
        DENIED: "text-sentinel-red",
    };

    return (
        <SectionCard title="My CRITICAL Access Requests" icon={ShieldAlert} accent="amber">
            <AnimatePresence>{toast && <Toast message={toast.msg} type={toast.type} />}</AnimatePresence>
            <Btn onClick={load} disabled={loading} variant="amber" className="mb-3">
                {loading ? "LOADING…" : "REFRESH"}
            </Btn>
            {requests.length === 0 && !loading && (
                <p className="text-[10px] text-sentinel-text-dim">No access requests yet.</p>
            )}
            <div className="space-y-1 max-h-60 overflow-y-auto">
                {requests.map((r) => (
                    <div key={r.id} className="border border-sentinel-border/30 rounded px-2 py-1.5 text-[10px] font-mono">
                        <div className="flex justify-between">
                            <span className={cn("font-bold", STATUS_COLORS[r.status] ?? "")}>{r.status}</span>
                            <span className="text-sentinel-text-dim">{relativeTime(r.created_at)}</span>
                        </div>
                        <p className="text-sentinel-text-dim">Record: {r.record_id.slice(0, 16)}…</p>
                    </div>
                ))}
            </div>
        </SectionCard>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Patient Self-Service Panel — auto-loads own records, no UUID entry needed
// ─────────────────────────────────────────────────────────────────────────────

function PatientSelfPanel({ patientUuid }: { patientUuid: string }) {
    const [records, setRecords] = useState<{ record_id: string; created_at: string; encrypted_preview: string }[]>([]);
    const [loading, setLoading] = useState(true);
    const [decrypted, setDecrypted] = useState<Record<string, string | null>>({});
    const [decryptBusy, setDecryptBusy] = useState<string | null>(null);
    const { toast, show } = useToast();

    // Auto-load on mount — patient UUID comes from the JWT, not user input
    const load = async () => {
        setLoading(true);
        try {
            const res = await apiFetch(`/api/patients/${patientUuid}/records`);
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setRecords(data);
            } else {
                show(extractErrorMessage(data, "Could not load your records"), "err");
            }
        } catch {
            show("Network error", "err");
        } finally {
            setLoading(false);
        }
    };

    // Auto-load on mount — patient UUID comes from the JWT, not user input
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { load(); }, []);


    const decrypt = async (recordId: string) => {
        setDecryptBusy(recordId);
        try {
            const res = await apiFetch("/api/patients/decrypt", {
                method: "POST",
                body: JSON.stringify({ record_id: recordId }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.plaintext) {
                setDecrypted((prev) => ({ ...prev, [recordId]: data.plaintext }));
                show("✓ Decrypted", "ok");
            } else if (res.ok && data.requires_approval) {
                show("CRITICAL record — awaiting second doctor approval", "err");
            } else {
                show(extractErrorMessage(data, "Decryption failed"), "err");
            }
        } catch {
            show("Network error", "err");
        } finally {
            setDecryptBusy(null);
        }
    };

    return (
        <SectionCard title="My Medical Records" icon={FileText} accent="blue">
            <AnimatePresence>{toast && <Toast message={toast.msg} type={toast.type} />}</AnimatePresence>

            <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] text-sentinel-text-dim">
                    {loading ? "Loading…" : `${records.length} record${records.length !== 1 ? "s" : ""} on file`}
                </span>
                <button
                    onClick={load}
                    disabled={loading}
                    className="flex items-center gap-1 text-[9px] text-sentinel-text-dim hover:text-blue-400 transition-colors"
                >
                    <RefreshCw size={9} className={loading ? "animate-spin" : ""} />
                    Refresh
                </button>
            </div>

            {!loading && records.length === 0 && (
                <p className="text-[10px] text-sentinel-text-dim text-center py-8">
                    No records found for your account.
                </p>
            )}

            <div className="space-y-3">
                {records.map((r) => (
                    <motion.div
                        key={r.record_id}
                        initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                        className="border border-blue-400/20 rounded-lg p-3 bg-blue-400/5 font-mono"
                    >
                        {/* Header row */}
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                                <Lock size={10} className="text-blue-400/60" />
                                <span className="text-[9px] text-sentinel-text-dim">ENCRYPTED</span>
                            </div>
                            <span className="text-[9px] text-sentinel-text-dim">{relativeTime(r.created_at)}</span>
                        </div>

                        {/* Record ID (read-only, for reference) */}
                        <p className="text-[9px] text-sentinel-text-dim/60 truncate mb-2">
                            ID: <span className="text-blue-400/70">{r.record_id}</span>
                        </p>

                        {/* Decrypted content (shown after decrypt) */}
                        <AnimatePresence>
                            {decrypted[r.record_id] !== undefined && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                                    className="border border-sentinel-green/30 rounded p-2 bg-sentinel-green/5 mb-2"
                                >
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <ShieldCheck size={10} className="text-sentinel-green" />
                                        <span className="text-[9px] text-sentinel-green font-bold">DECRYPTED</span>
                                    </div>
                                    <p className="text-sm text-sentinel-green whitespace-pre-wrap">
                                        {decrypted[r.record_id]}
                                    </p>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* Decrypt button */}
                        {decrypted[r.record_id] === undefined && (
                            <Btn
                                onClick={() => decrypt(r.record_id)}
                                disabled={decryptBusy === r.record_id}
                                variant="blue"
                                className="w-full mt-1"
                            >
                                {decryptBusy === r.record_id ? "DECRYPTING…" : "🔓 DECRYPT MY RECORD"}
                            </Btn>
                        )}
                    </motion.div>
                ))}
            </div>
        </SectionCard>
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Healthcare Dashboard
// ─────────────────────────────────────────────────────────────────────────────


export function HealthcareDashboard({
    role,
    uuid,
    onSignOut,
}: {
    role: AuthRole;
    uuid: string;
    onSignOut: () => void;
}) {
    const apiUrl = getApiUrl();
    // Lifted state: DecryptPanel record_id, set by MyRecordsPanel DECRYPT → button
    const [decryptId, setDecryptId] = useState("");
    const [decryptKey, setDecryptKey] = useState(0); // force re-render on same ID

    const handleDecrypt = (id: string) => {
        setDecryptId(id);
        setDecryptKey((k) => k + 1); // re-trigger even if same ID
        // Scroll to decrypt panel
        setTimeout(() => document.getElementById("decrypt-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    };

    return (
        <div className="min-h-screen bg-sentinel-black text-sentinel-text font-mono">
            <Header role={role ?? "unknown"} uuid={uuid} onSignOut={onSignOut} />

            <main className="max-w-7xl mx-auto px-4 py-6">
                {/* Role badge */}
                <div className="mb-6 flex items-center gap-3">
                    <Shield size={14} className="text-sentinel-green/60" />
                    <span className="text-[9px] text-sentinel-text-dim tracking-widest uppercase">
                        Logged in as <span className="text-sentinel-green font-bold">{role?.toUpperCase()}</span>
                        <span className="ml-2 opacity-50">{uuid.slice(0, 8)}…</span>
                    </span>
                </div>

                {/* ─── DOCTOR ── */}
                {role === "doctor" && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                        <div className="space-y-5">
                            <PendingApprovalsPanel apiUrl={apiUrl} />
                            <MyRequestsPanel />
                            <MyRecordsPanel onDecrypt={handleDecrypt} />
                        </div>
                        <div className="space-y-5">
                            <div id="decrypt-panel">
                                <DecryptPanel key={decryptKey} initialRecordId={decryptId} />
                            </div>
                            <CreateRecordPanel />
                            <SearchPanel />
                        </div>
                    </div>
                )}

                {/* ─── NURSE ─── */}
                {role === "nurse" && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                        <PatientMetadataPanel />
                        <SearchPanel />
                    </div>
                )}

                {/* ─── ADMIN ─── */}
                {role === "admin" && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                        <AssignDoctorPanel />
                        <AuditLogPanel />
                    </div>
                )}

                {/* ─── PATIENT ─── */}
                {role === "patient" && (
                    <div className="max-w-2xl mx-auto">
                        <PatientSelfPanel patientUuid={uuid} />
                    </div>
                )}


                {/* ─── AUDITOR ─── */}
                {role === "auditor" && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                        <AuditLogPanel />
                        <SearchPanel />
                    </div>
                )}

                {/* Unknown role fallback */}
                {role && !["doctor", "nurse", "admin", "patient", "auditor"].includes(role) && (
                    <div className="flex flex-col items-center gap-4 py-20">
                        <Shield size={32} className="text-sentinel-text-dim" />
                        <p className="text-sentinel-text-dim text-sm">Unknown role: {role}</p>
                    </div>
                )}
            </main>

            <footer className="border-t border-sentinel-border mt-8 py-4 px-4">
                <div className="max-w-7xl mx-auto text-center text-[9px] text-sentinel-text-dim tracking-widest">
                    PROJECT SENTINEL — HEALTHCARE COMMAND CENTER · ALL ACCESS LOGGED
                </div>
            </footer>
        </div>
    );
}
