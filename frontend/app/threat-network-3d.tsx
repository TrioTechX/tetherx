"use client";

import { useEffect, useState, Suspense } from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import {
    Shield,
    AlertTriangle,
    Activity,
    Filter,
    Download,
    AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

type SeverityLevel = "CLEAR" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

interface ThreatNetworkNode {
    id: string;
    label: string;
    threat_level: SeverityLevel;
    match_count: number;
    message_count: number;
    position: { x: number; y: number; z: number };
}

interface ThreatNetworkEdge {
    source: string;
    target: string;
    weight: number;
    threat_count: number;
    severity: SeverityLevel;
}

interface ThreatNetworkData {
    nodes: ThreatNetworkNode[];
    edges: ThreatNetworkEdge[];
    total_nodes: number;
    total_edges: number;
    network_threat_level: SeverityLevel;
    timestamp: string;
}

const SEVERITY_CONFIG: Record<
    SeverityLevel,
    { color: number; glow: string; intensity: number; dotClass: string }
> = {
    CLEAR: { color: 0x00d9ff, glow: "glow-clear", intensity: 0.5, dotClass: "bg-sentinel-cyan" },
    LOW: { color: 0x4ade80, glow: "glow-green", intensity: 0.7, dotClass: "bg-green-400" },
    MEDIUM: { color: 0xfbbf24, glow: "glow-amber", intensity: 0.9, dotClass: "bg-sentinel-amber" },
    HIGH: { color: 0xff6e40, glow: "glow-orange", intensity: 1.1, dotClass: "bg-orange-400" },
    CRITICAL: { color: 0xff1744, glow: "glow-red", intensity: 1.3, dotClass: "bg-sentinel-red" },
};

// Dynamically import the Canvas renderer - only on client, never on server
const ThreatNetworkCanvasRenderer = dynamic(
    async () => {
        const mod = await import("@/app/threat-network-canvas");
        return mod.ThreatNetworkCanvasRenderer;
    },
    { ssr: false, loading: () => null }
) as any;

export function ThreatNetwork3D({
    apiUrl,
    onClose,
}: {
    apiUrl: string;
    onClose: () => void;
}) {
    const [data, setData] = useState<ThreatNetworkData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedNode, setSelectedNode] = useState<string | null>(null);
    const [filterSeverity, setFilterSeverity] = useState<SeverityLevel>("CLEAR");
    const [filterUnit, setFilterUnit] = useState("");
    const [autoRotate, setAutoRotate] = useState(true);

    // Fetch threat network data
    useEffect(() => {
        async function fetchNetworkData() {
            try {
                const params = new URLSearchParams();
                params.append("min_severity", filterSeverity);
                if (filterUnit) params.append("unit_filter", filterUnit);

                const res = await fetch(`${apiUrl}/api/threat-network?${params}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const networkData = (await res.json()) as ThreatNetworkData;
                setData(networkData);
                setError(null);
            } catch (err) {
                setError(err instanceof Error ? err.message : "Failed to load network data");
            } finally {
                setLoading(false);
            }
        }

        setLoading(true);
        fetchNetworkData();
    }, [apiUrl, filterSeverity, filterUnit]);

    const selectedNodeData = selectedNode
        ? data?.nodes.find((n) => n.id === selectedNode)
        : null;

    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center"
        >
            <motion.div
                className="w-full h-full max-w-6xl max-h-screen bg-gradient-to-b from-slate-950 to-black rounded-2xl border border-sentinel-cyan/30 shadow-2xl flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="bg-gradient-to-r from-slate-900 to-black border-b border-sentinel-cyan/20 px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Shield className="w-6 h-6 text-sentinel-cyan" />
                        <div>
                            <h2 className="text-lg font-bold text-white">3D Threat Network</h2>
                            <p className="text-xs text-slate-400">Interactive operator connections & threat visualization</p>
                        </div>
                    </div>
                    <motion.button
                        whileHover={{ scale: 1.1 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={onClose}
                        className="text-slate-400 hover:text-white transition-colors"
                        aria-label="Close"
                    >
                        ✕
                    </motion.button>
                </div>

                {/* Content */}
                <div className="flex-1 flex gap-4 overflow-hidden p-4">
                    {/* 3D Canvas */}
                    <div className="flex-1 rounded-lg overflow-hidden border border-sentinel-cyan/10 bg-black/50">
                        {loading ? (
                            <div className="w-full h-full flex items-center justify-center text-slate-400">
                                <Activity className="w-6 h-6 animate-spin mr-2" />
                                Loading threat network...
                            </div>
                        ) : error ? (
                            <div className="w-full h-full flex items-center justify-center text-red-400">
                                <AlertCircle className="w-6 h-6 mr-2" />
                                {error}
                            </div>
                        ) : (
                            <Suspense fallback={null}>
                                <ThreatNetworkCanvasRenderer
                                    data={data}
                                    selectedNode={selectedNode}
                                    onSelectNode={setSelectedNode}
                                    autoRotate={autoRotate}
                                />
                            </Suspense>
                        )}
                    </div>

                    {/* Sidebar - Controls & Node Details */}
                    <div className="w-80 flex flex-col gap-4 overflow-y-auto">
                        {/* Network Stats */}
                        <motion.div className="bg-slate-900/50 border border-sentinel-cyan/20 rounded-lg p-4">
                            <div className="space-y-2">
                                <div className="flex justify-between items-center">
                                    <span className="text-xs text-slate-400">Network Threat Level</span>
                                    <span
                                        className={cn(
                                            "text-sm font-bold px-2 py-1 rounded",
                                            data?.network_threat_level === "CRITICAL"
                                                ? "bg-sentinel-red/20 text-sentinel-red"
                                                : data?.network_threat_level === "HIGH"
                                                    ? "bg-red-500/20 text-red-400"
                                                    : data?.network_threat_level === "MEDIUM"
                                                        ? "bg-sentinel-amber/20 text-sentinel-amber"
                                                        : "bg-sentinel-cyan/20 text-sentinel-cyan"
                                        )}
                                    >
                                        {data?.network_threat_level}
                                    </span>
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-xs">
                                    <div className="flex justify-between">
                                        <span className="text-slate-400">Operators:</span>
                                        <span className="text-white font-mono">{data?.total_nodes}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span className="text-slate-400">Connections:</span>
                                        <span className="text-white font-mono">{data?.total_edges}</span>
                                    </div>
                                </div>
                            </div>
                        </motion.div>

                        {/* Filters */}
                        <motion.div className="bg-slate-900/50 border border-sentinel-cyan/20 rounded-lg p-4 space-y-3">
                            <div className="flex items-center gap-2 text-sm font-semibold text-white">
                                <Filter className="w-4 h-4" />
                                Filters
                            </div>

                            <div>
                                <label htmlFor="severity-filter" className="text-xs text-slate-400 block mb-1">
                                    Min Severity
                                </label>
                                <select
                                    id="severity-filter"
                                    value={filterSeverity}
                                    onChange={(e) => setFilterSeverity(e.target.value as SeverityLevel)}
                                    className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white"
                                    title="Minimum severity level"
                                >
                                    <option value="CLEAR">Clear</option>
                                    <option value="LOW">Low</option>
                                    <option value="MEDIUM">Medium</option>
                                    <option value="HIGH">High</option>
                                    <option value="CRITICAL">Critical</option>
                                </select>
                            </div>

                            <div>
                                <label htmlFor="unit-filter" className="text-xs text-slate-400 block mb-1">
                                    Unit Filter
                                </label>
                                <input
                                    id="unit-filter"
                                    type="text"
                                    value={filterUnit}
                                    onChange={(e) => setFilterUnit(e.target.value)}
                                    placeholder="Search unit..."
                                    className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white placeholder-slate-500"
                                />
                            </div>

                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id="autoRotate"
                                    checked={autoRotate}
                                    onChange={(e) => setAutoRotate(e.target.checked)}
                                    className="w-4 h-4"
                                />
                                <label htmlFor="autoRotate" className="text-xs text-slate-300">
                                    Auto Rotate
                                </label>
                            </div>
                        </motion.div>

                        {/* Selected Node Details */}
                        <AnimatePresence>
                            {selectedNodeData && (
                                <motion.div
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: 10 }}
                                    className="bg-slate-900/50 border border-sentinel-cyan/20 rounded-lg p-4 space-y-3"
                                >
                                    <div className="flex items-start justify-between">
                                        <div>
                                            <h3 className="font-bold text-white text-sm">{selectedNodeData.label}</h3>
                                            <p className="text-xs text-slate-400 font-mono">{selectedNodeData.id}</p>
                                        </div>
                                        <span
                                            className={cn(
                                                "text-xs font-bold px-2 py-1 rounded",
                                                selectedNodeData.threat_level === "CRITICAL"
                                                    ? "bg-sentinel-red/20 text-sentinel-red"
                                                    : selectedNodeData.threat_level === "HIGH"
                                                        ? "bg-red-500/20 text-red-400"
                                                        : selectedNodeData.threat_level === "MEDIUM"
                                                            ? "bg-sentinel-amber/20 text-sentinel-amber"
                                                            : selectedNodeData.threat_level === "LOW"
                                                                ? "bg-green-500/20 text-green-400"
                                                                : "bg-blue-500/20 text-blue-400"
                                            )}
                                        >
                                            {selectedNodeData.threat_level}
                                        </span>
                                    </div>

                                    <div className="space-y-2 text-xs">
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Messages:</span>
                                            <span className="text-white font-mono">{selectedNodeData.message_count}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Threat Matches:</span>
                                            <span className="text-white font-mono">{selectedNodeData.match_count}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400">Position:</span>
                                            <span className="text-white font-mono text-[10px]">
                                                ({selectedNodeData.position.x}, {selectedNodeData.position.y}, {selectedNodeData.position.z})
                                            </span>
                                        </div>
                                    </div>

                                    <motion.button
                                        whileHover={{ scale: 1.05 }}
                                        whileTap={{ scale: 0.95 }}
                                        className="w-full bg-gradient-to-r from-sentinel-cyan/20 to-blue-500/20 border border-sentinel-cyan/40 rounded px-3 py-2 text-xs font-semibold text-sentinel-cyan hover:from-sentinel-cyan/30 hover:to-blue-500/30 transition-all"
                                    >
                                        View Message History
                                    </motion.button>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* Legend */}
                        <motion.div className="bg-slate-900/50 border border-sentinel-cyan/20 rounded-lg p-3 space-y-2">
                            <h4 className="text-xs font-semibold text-slate-300">Threat Levels</h4>
                            <div className="space-y-1 text-xs">
                                {(["CLEAR", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as SeverityLevel[]).map(
                                    (level) => (
                                        <div key={level} className="flex items-center gap-2">
                                            <div
                                                className={cn("w-2.5 h-2.5 rounded-full", SEVERITY_CONFIG[level].dotClass)}
                                            />
                                            <span className="text-slate-400">{level}</span>
                                        </div>
                                    )
                                )}
                            </div>
                        </motion.div>

                        {/* Controls */}
                        <div className="flex gap-2">
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={() => setSelectedNode(null)}
                                className="flex-1 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded px-3 py-2 text-xs font-semibold text-white transition-all"
                            >
                                Clear Selection
                            </motion.button>
                            <motion.button
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                onClick={() => {
                                    const canvas = document.querySelector("canvas");
                                    if (canvas) {
                                        const link = document.createElement("a");
                                        link.href = canvas.toDataURL();
                                        link.download = "threat-network.png";
                                        link.click();
                                    }
                                }}
                                className="flex-1 bg-sentinel-cyan/10 hover:bg-sentinel-cyan/20 border border-sentinel-cyan/40 rounded px-3 py-2 text-xs font-semibold text-sentinel-cyan transition-all flex items-center justify-center gap-1"
                            >
                                <Download className="w-3 h-3" />
                                Export
                            </motion.button>
                        </div>
                    </div>
                </div>
            </motion.div>
        </motion.div>
    );
}
