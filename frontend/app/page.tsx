"use client";

import { useEffect } from "react";
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

// Role → destination after login
const ROLE_REDIRECT: Record<string, string> = {
  doctor: "/command-center",
  nurse: "/command-center",
  admin: "/command-center",
  patient: "/command-center",
  auditor: "/command-center",
};

const ROLES = [
  {
    id: "doctor",
    label: "Doctor",
    description: "Decrypt and manage assigned patient records.",
    icon: Stethoscope,
    color: "teal",
    accent: "border-sentinel-teal/40 hover:border-sentinel-teal/70 hover:shadow-[0_0_30px_rgba(0,255,255,0.08)]",
    iconClass: "text-sentinel-teal",
    headingClass: "text-sentinel-teal",
    arrowClass: "text-sentinel-teal/80",
  },
  {
    id: "nurse",
    label: "Nurse",
    description: "View patient record metadata. No decryption access.",
    icon: HeartPulse,
    color: "green",
    accent: "border-sentinel-green/40 hover:border-sentinel-green/70 hover:shadow-[0_0_30px_rgba(0,255,65,0.08)]",
    iconClass: "text-sentinel-green",
    headingClass: "text-sentinel-green",
    arrowClass: "text-sentinel-green/80",
  },
  {
    id: "admin",
    label: "Admin",
    description: "Manage operator assignments and system configuration.",
    icon: Settings,
    color: "amber",
    accent: "border-sentinel-amber/40 hover:border-sentinel-amber/70 hover:shadow-[0_0_30px_rgba(255,170,0,0.08)]",
    iconClass: "text-sentinel-amber",
    headingClass: "text-sentinel-amber",
    arrowClass: "text-sentinel-amber/80",
  },
  {
    id: "patient",
    label: "Patient",
    description: "Decrypt your own medical records only.",
    icon: User,
    color: "teal",
    accent: "border-blue-400/40 hover:border-blue-400/70 hover:shadow-[0_0_30px_rgba(96,165,250,0.08)]",
    iconClass: "text-blue-400",
    headingClass: "text-blue-400",
    arrowClass: "text-blue-400/80",
  },
  {
    id: "auditor",
    label: "Auditor",
    description: "Read-only access to audit logs. No decryption.",
    icon: ClipboardList,
    color: "red",
    accent: "border-sentinel-red/40 hover:border-sentinel-red/70 hover:shadow-[0_0_30px_rgba(255,34,34,0.08)]",
    iconClass: "text-sentinel-red",
    headingClass: "text-sentinel-red",
    arrowClass: "text-sentinel-red/80",
  },
];

export default function LandingPage() {
  const { user, role, loading } = useAuth();

  useEffect(() => {
    if (loading || !user || !role) return;
    const dest = ROLE_REDIRECT[role] ?? "/command-center";
    window.location.href = dest;
  }, [user, role, loading]);

  if (loading) {
    return (
      <div className="min-h-screen bg-sentinel-black text-sentinel-text font-mono hex-bg flex items-center justify-center">
        <span className="text-sentinel-green animate-pulse">LOADING…</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-sentinel-black text-sentinel-text font-mono hex-bg flex flex-col items-center justify-center px-4 py-12">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center max-w-3xl mx-auto w-full"
      >
        {/* Header */}
        <div className="flex items-center justify-center gap-3 mb-4">
          <Shield size={36} className="text-sentinel-green text-glow-green" />
          <h1 className="text-xl font-bold tracking-[0.25em] text-sentinel-green">
            PROJECT SENTINEL
          </h1>
        </div>
        <p className="text-sentinel-text-dim text-sm tracking-wide mb-2">
          Healthcare Records Management — Encrypted &amp; Audited
        </p>
        <p className="text-[11px] text-sentinel-text-dim/80 mb-10">
          Access is restricted to pre-provisioned operators. Select your role to sign in.
        </p>

        {/* Role grid: 3 top + 2 bottom */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          {ROLES.slice(0, 3).map((r) => (
            <RoleCard key={r.id} role={r} />
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-xl mx-auto">
          {ROLES.slice(3).map((r) => (
            <RoleCard key={r.id} role={r} />
          ))}
        </div>

        <p className="mt-10 text-[9px] text-sentinel-text-dim tracking-widest">
          CLASSIFICATION: RESTRICTED · ACCOUNTS PRE-PROVISIONED · NO SELF-REGISTRATION
        </p>
      </motion.div>
    </div>
  );
}

function RoleCard({ role: r }: { role: (typeof ROLES)[0] }) {
  const Icon = r.icon;
  return (
    <Link href={`/login/${r.id}`}>
      <motion.div
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className={cn(
          "border rounded-xl p-6 flex flex-col items-center gap-3 text-center",
          "bg-sentinel-surface transition-all",
          r.accent
        )}
      >
        <Icon size={36} className={r.iconClass} />
        <h2 className={cn("text-sm font-bold tracking-[0.2em] uppercase", r.headingClass)}>
          {r.label}
        </h2>
        <p className="text-[11px] text-sentinel-text-dim leading-relaxed">{r.description}</p>
        <span className={cn("text-[10px] tracking-widest", r.arrowClass)}>
          Sign in as {r.label} →
        </span>
      </motion.div>
    </Link>
  );
}
