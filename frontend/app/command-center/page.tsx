"use client";

import { useEffect } from "react";
import { useAuth } from "@/app/auth-context";
import { HealthcareDashboard } from "@/app/healthcare-dashboard";

const VALID_ROLES = ["doctor", "nurse", "admin", "patient", "auditor"];

export default function CommandCenterPage() {
    const { user, role, loading, signOut } = useAuth();

    useEffect(() => {
        if (loading) return;
        if (!user || !role || !VALID_ROLES.includes(role)) {
            window.location.href = "/";
        }
    }, [user, role, loading]);

    if (loading || !user || !role) {
        return (
            <div className="min-h-screen bg-sentinel-black flex items-center justify-center">
                <span className="text-sentinel-green animate-pulse font-mono text-sm">LOADING…</span>
            </div>
        );
    }

    return (
        <HealthcareDashboard
            role={role}
            uuid={user.uuid}
            onSignOut={signOut}
        />
    );
}
