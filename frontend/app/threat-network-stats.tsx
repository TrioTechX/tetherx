"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Globe, Zap, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

type SeverityLevel = "CLEAR" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

interface StatsState {
    nodes: number;
    edges: number;
    threatLevel: SeverityLevel;
}

interface ThreatNetworkStatsProps {
    apiUrl: string;
    onOpenGraph: () => void;
    isOpen: boolean;
}

export function ThreatNetworkStats({
    apiUrl,
    onOpenGraph,
    isOpen,
}: ThreatNetworkStatsProps) {
    const [stats, setStats] = useState<StatsState>({
        nodes: 0,
        edges: 0,
        threatLevel: "CLEAR",
    });

    // Fetch quick stats (could be optimized with WebSocket)
    const refreshStats = async () => {
        if (!apiUrl) {
            console.warn("API URL not configured");
            return;
        }
        try {
            const res = await fetch(`${apiUrl}/api/threat-network`);
            if (res.ok) {
                const data = await res.json();
                setStats({
                    nodes: data.total_nodes,
                    edges: data.total_edges,
                    threatLevel: data.network_threat_level,
                });
            }
        } catch (err) {
            console.error("Failed to fetch threat network stats:", err);
        }
    };

    // Fetch stats on component mount
    useEffect(() => {
        refreshStats();
    }, [apiUrl]);

    return (
        <motion.div
            whileHover={{ scale: 1.02 }}
            onClick={() => {
                refreshStats();
                onOpenGraph();
            }}
            className={cn(
                "p-4 rounded-lg border cursor-pointer transition-all",
                isOpen
                    ? "bg-sentinel-cyan/20 border-sentinel-cyan/50 shadow-lg shadow-sentinel-cyan/20"
                    : "bg-slate-900/50 border-sentinel-cyan/20 hover:bg-slate-800/50 hover:border-sentinel-cyan/40"
            )}
        >
            <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                    <Globe className="w-5 h-5 text-sentinel-cyan" />
                    <h3 className="font-bold text-white text-sm">Threat Network</h3>
                </div>
                <Zap className="w-4 h-4 text-sentinel-cyan/60" />
            </div>

            <div className="grid grid-cols-2 gap-2 mb-3">
                <div>
                    <p className="text-xs text-slate-400">Operators</p>
                    <p className="text-lg font-bold text-sentinel-cyan">{stats.nodes}</p>
                </div>
                <div>
                    <p className="text-xs text-slate-400">Connections</p>
                    <p className="text-lg font-bold text-sentinel-cyan">{stats.edges}</p>
                </div>
            </div>

            <div className="flex items-center gap-2 text-xs">
                <AlertTriangle className="w-4 h-4" />
                <span className="text-slate-300">
                    Network Level:{" "}
                    <span
                        className={cn(
                            "font-bold",
                            stats.threatLevel === "CRITICAL"
                                ? "text-sentinel-red"
                                : stats.threatLevel === "HIGH"
                                    ? "text-red-400"
                                    : stats.threatLevel === "MEDIUM"
                                        ? "text-sentinel-amber"
                                        : "text-sentinel-cyan"
                        )}
                    >
                        {stats.threatLevel}
                    </span>
                </span>
            </div>

            <p className="text-xs text-slate-500 mt-2 italic">
                Click to explore 3D visualization
            </p>
        </motion.div>
    );
}
