"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import {
    Shield,
    Stethoscope,
    HeartPulse,
    Settings,
    User,
    ClipboardList,
} from "lucide-react";
import { useAuth } from "@/app/auth-context";
import { cn } from "@/lib/utils";
import type { AuthRole } from "@/app/auth-context";

// ─────────────────────────────────────────────────────────────────────────────
// Role config
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_CONFIG: Record<
    string,
    {
        label: string;
        description: string;
        icon: React.ElementType;
        borderClass: string;
        iconClass: string;
        headingClass: string;
        buttonClass: string;
    }
> = {
    doctor: {
        label: "Doctor",
        description: "Decrypt and manage your assigned patient records.",
        icon: Stethoscope,
        borderClass: "border-sentinel-teal/40",
        iconClass: "text-sentinel-teal",
        headingClass: "text-sentinel-teal",
        buttonClass: "border-sentinel-teal/50 text-sentinel-teal bg-sentinel-teal/10 hover:bg-sentinel-teal/20",
    },
    nurse: {
        label: "Nurse",
        description: "View patient record metadata. No decryption access.",
        icon: HeartPulse,
        borderClass: "border-sentinel-green/40",
        iconClass: "text-sentinel-green",
        headingClass: "text-sentinel-green",
        buttonClass: "border-sentinel-green/50 text-sentinel-green bg-sentinel-green/10 hover:bg-sentinel-green/20",
    },
    admin: {
        label: "Admin",
        description: "Manage operator assignments and system settings.",
        icon: Settings,
        borderClass: "border-sentinel-amber/40",
        iconClass: "text-sentinel-amber",
        headingClass: "text-sentinel-amber",
        buttonClass: "border-sentinel-amber/50 text-sentinel-amber bg-sentinel-amber/10 hover:bg-sentinel-amber/20",
    },
    patient: {
        label: "Patient",
        description: "Access and decrypt your own medical records.",
        icon: User,
        borderClass: "border-blue-400/40",
        iconClass: "text-blue-400",
        headingClass: "text-blue-400",
        buttonClass: "border-blue-400/50 text-blue-400 bg-blue-400/10 hover:bg-blue-400/20",
    },
    auditor: {
        label: "Auditor",
        description: "Read-only access to audit logs. No decryption.",
        icon: ClipboardList,
        borderClass: "border-sentinel-red/40",
        iconClass: "text-sentinel-red",
        headingClass: "text-sentinel-red",
        buttonClass: "border-sentinel-red/50 text-sentinel-red bg-sentinel-red/10 hover:bg-sentinel-red/20",
    },
};

const VALID_ROLES = Object.keys(ROLE_CONFIG);

// ─────────────────────────────────────────────────────────────────────────────
// Login Page
// ─────────────────────────────────────────────────────────────────────────────

export default function RoleLoginPage() {
    const params = useParams<{ role: string }>();
    const roleName = params?.role?.toLowerCase() ?? "";
    const cfg = ROLE_CONFIG[roleName];

    const [uuid, setUuid] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const { signIn, user, role, loading: authLoading } = useAuth();
    const router = useRouter();

    // Redirect if already signed in
    useEffect(() => {
        if (!authLoading && user && role) {
            router.replace("/command-center");
        }
    }, [user, role, authLoading, router]);

    // Invalid role slug
    if (!cfg) {
        return (
            <div className="min-h-screen bg-sentinel-black text-sentinel-text font-mono flex flex-col items-center justify-center gap-4">
                <Shield size={32} className="text-sentinel-red" />
                <p className="text-sentinel-red text-sm">Unknown role: <strong>{roleName}</strong></p>
                <Link href="/" className="text-[11px] text-sentinel-teal hover:underline">← Back to landing</Link>
            </div>
        );
    }

    const Icon = cfg.icon;

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setLoading(true);
        try {
            const { error: err } = await signIn(uuid, password, roleName as AuthRole);
            if (err) {
                setError(err.message);
                return;
            }
            router.replace("/command-center");
        } finally {
            setLoading(false);
        }
    };

    if (authLoading || (user && role)) {
        return (
            <div className="min-h-screen bg-sentinel-black flex items-center justify-center">
                <span className="text-sentinel-green animate-pulse font-mono text-sm">LOADING…</span>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-sentinel-black text-sentinel-text font-mono hex-bg flex flex-col items-center justify-center px-4">
            <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                    "w-full max-w-sm border rounded-xl bg-sentinel-surface p-8",
                    cfg.borderClass
                )}
            >
                {/* Header */}
                <div className="flex items-center gap-3 mb-6">
                    <Icon size={28} className={cfg.iconClass} />
                    <div>
                        <h1 className={cn("text-sm font-bold tracking-[0.2em] uppercase", cfg.headingClass)}>
                            {cfg.label} — Operator Login
                        </h1>
                        <p className="text-[10px] text-sentinel-text-dim">{cfg.description}</p>
                    </div>
                </div>

                {/* Form */}
                <form onSubmit={submit} className="space-y-4">
                    <div>
                        <label
                            htmlFor="uuid-input"
                            className="block text-[10px] text-sentinel-text-dim uppercase tracking-wider mb-1"
                        >
                            Operator UUID
                        </label>
                        <input
                            id="uuid-input"
                            type="text"
                            value={uuid}
                            onChange={(e) => setUuid(e.target.value)}
                            required
                            autoComplete="username"
                            className="w-full bg-sentinel-deep border border-sentinel-border rounded px-3 py-2 text-sm text-sentinel-green placeholder-sentinel-text-dim/50 focus:outline-none focus:border-sentinel-teal/50 font-mono"
                            placeholder="550e8400-e29b-41d4-a716-…"
                        />
                    </div>
                    <div>
                        <label
                            htmlFor="password-input"
                            className="block text-[10px] text-sentinel-text-dim uppercase tracking-wider mb-1"
                        >
                            Password
                        </label>
                        <input
                            id="password-input"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            autoComplete="current-password"
                            className="w-full bg-sentinel-deep border border-sentinel-border rounded px-3 py-2 text-sm text-sentinel-green placeholder-sentinel-text-dim/50 focus:outline-none focus:border-sentinel-teal/50"
                            placeholder="••••••••"
                        />
                    </div>

                    {error && (
                        <motion.p
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className="text-[11px] text-sentinel-red"
                        >
                            {error}
                        </motion.p>
                    )}

                    <button
                        id="login-submit"
                        type="submit"
                        disabled={loading}
                        className={cn(
                            "w-full py-2.5 rounded text-xs font-semibold tracking-widest border transition-all",
                            cfg.buttonClass,
                            "disabled:opacity-50 disabled:cursor-not-allowed"
                        )}
                    >
                        {loading ? "VERIFYING…" : "SIGN IN"}
                    </button>
                </form>

                {/* Role switcher */}
                <div className="mt-6 border-t border-sentinel-border/40 pt-4">
                    <p className="text-[9px] text-sentinel-text-dim uppercase tracking-widest mb-2 text-center">
                        Sign in as a different role
                    </p>
                    <div className="flex flex-wrap justify-center gap-2">
                        {VALID_ROLES.filter((r) => r !== roleName).map((r) => (
                            <Link
                                key={r}
                                href={`/login/${r}`}
                                className="text-[9px] text-sentinel-text-dim hover:text-sentinel-teal tracking-widest uppercase border border-sentinel-border/30 rounded px-2 py-0.5 hover:border-sentinel-teal/30 transition-all"
                            >
                                {ROLE_CONFIG[r].label}
                            </Link>
                        ))}
                    </div>
                </div>

                <Link
                    href="/"
                    className="mt-4 inline-block text-[10px] text-sentinel-text-dim hover:text-sentinel-teal"
                >
                    ← Back to landing
                </Link>
            </motion.div>
        </div>
    );
}
