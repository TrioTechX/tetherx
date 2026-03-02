"use client";

import { useEffect, useRef, useState, useCallback, Suspense, lazy } from "react";
import { motion, AnimatePresence, useAnimationControls } from "framer-motion";
import {
  Shield,
  AlertTriangle,
  Activity,
  Lock,
  Radio,
  Eye,
  Cpu,
  Wifi,
  WifiOff,
  ChevronRight,
  Database,
  Zap,
  Unlock,
  Search,
  Send,
  LogOut,
  Target,
  Crosshair,
  ShieldAlert,
  ShieldCheck,
  BarChart3,
  Copy,
  Check,
} from "lucide-react";

// Lazy load React Three Fiber components to prevent early initialization
const ThreatNetwork3D = lazy(() => import("./threat-network-3d").then((mod) => ({ default: mod.ThreatNetwork3D })));
const ThreatNetworkStats = lazy(() => import("./threat-network-stats").then((mod) => ({ default: mod.ThreatNetworkStats })));

import { supabase } from "@/lib/supabase";
import type {
  ChatLogRow,
  SystemStatus,
  SeverityLevel,
  InterceptionNodeInfo,
  ThreatAnalysis,
  ThreatFeedEntry,
  ThreatFeedResponse,
} from "@/lib/types";
import { useWebSocket, type WsMessage } from "@/hooks/useWebSocket";
import { formatEncryptedPreview, relativeTime, glitchString, fetchWithRetry } from "@/lib/utils";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Loading Skeleton Components
// ─────────────────────────────────────────────────────────────────────────────

function SkeletonLine({ className }: { className?: string }) {
  return <div className={cn("skeleton h-3 rounded", className)} />;
}

function SkeletonCard() {
  return (
    <div className="bg-sentinel-surface border border-sentinel-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <SkeletonLine className="w-2/5" />
        <SkeletonLine className="w-1/5" />
      </div>
      <SkeletonLine className="w-4/5" />
      <SkeletonLine className="w-3/5" />
    </div>
  );
}

function SkeletonFeedItem() {
  return (
    <div className="flex items-start gap-2 py-1.5 px-2 rounded border border-sentinel-border/30">
      <SkeletonLine className="w-6" />
      <SkeletonLine className="w-16" />
      <SkeletonLine className="w-20" />
      <SkeletonLine className="flex-1" />
      <SkeletonLine className="w-12" />
    </div>
  );
}

function SkeletonThreatItem() {
  return (
    <div className="rounded border border-sentinel-border/60 p-2 space-y-2">
      <div className="flex items-center justify-between">
        <SkeletonLine className="w-1/3" />
        <SkeletonLine className="w-16" />
      </div>
      <SkeletonLine className="w-11/12" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Presence poll — REST fallback so ONLINE/OFFLINE is accurate even when
// WebSocket STATUS messages are missed (e.g. timing race between machines)
// ─────────────────────────────────────────────────────────────────────────────
function usePresencePoll(apiUrl: string, intervalMs = 5000) {
  const [senderCount, setSenderCount] = useState(0);
  const [receiverCount, setReceiverCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetchWithRetry(`${apiUrl}/api/connections`, {}, 2, 500);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setSenderCount(data.sender_count ?? 0);
          setReceiverCount(data.receiver_count ?? 0);
        }
      } catch { /* network error — keep previous values */ }
    }
    poll();
    const id = setInterval(poll, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [apiUrl, intervalMs]);

  return { senderCount, receiverCount };
}

const MAX_FEED_ITEMS = 50;
const MAX_MATRIX_NODES = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Copy to Clipboard Component
// ─────────────────────────────────────────────────────────────────────────────

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      title={label || `Copy ${text}`}
      className="inline-flex items-center gap-1 text-sentinel-teal/60 hover:text-sentinel-teal transition-colors"
    >
      {copied ? (
        <Check size={10} className="text-sentinel-green" />
      ) : (
        <Copy size={10} />
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Severity helpers
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; border: string; glow?: string }
> = {
  CRITICAL: {
    label: "CRITICAL",
    color: "text-sentinel-red",
    bg: "bg-sentinel-red/10",
    border: "border-sentinel-red/50",
    glow: "text-glow-red",
  },
  HIGH: {
    label: "HIGH",
    color: "text-red-400",
    bg: "bg-red-500/10",
    border: "border-red-400/40",
  },
  MEDIUM: {
    label: "MEDIUM",
    color: "text-sentinel-amber",
    bg: "bg-sentinel-amber/10",
    border: "border-sentinel-amber/40",
  },
  LOW: {
    label: "LOW",
    color: "text-yellow-300",
    bg: "bg-yellow-400/10",
    border: "border-yellow-400/30",
  },
  CLEAR: {
    label: "CLEAR",
    color: "text-sentinel-green",
    bg: "bg-sentinel-green/5",
    border: "border-sentinel-green/20",
  },
};

function SeverityBadge({ severity }: { severity: string }) {
  const cfg = SEVERITY_CONFIG[severity] ?? SEVERITY_CONFIG.CLEAR;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider border",
        cfg.color,
        cfg.bg,
        cfg.border,
        cfg.glow
      )}
    >
      {severity === "CRITICAL" && (
        <motion.span
          animate={{ opacity: [1, 0.3, 1] }}
          transition={{ repeat: Infinity, duration: 0.6 }}
        >
          ●
        </motion.span>
      )}
      {cfg.label}
    </span>
  );
}

function computeSeverity(matchCount: number): SeverityLevel {
  if (matchCount === 0) return "CLEAR";
  if (matchCount >= 8) return "CRITICAL";
  if (matchCount >= 6) return "HIGH";
  if (matchCount >= 3) return "MEDIUM";
  return "LOW";
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function StatusIndicator({ status }: { status: SystemStatus }) {
  const map: Record<SystemStatus, { label: string; color: string; dot: string }> = {
    NOMINAL: {
      label: "NOMINAL",
      color: "text-sentinel-green",
      dot: "bg-sentinel-green shadow-[0_0_8px_rgba(0,255,65,0.8)]",
    },
    ELEVATED: {
      label: "ELEVATED",
      color: "text-sentinel-amber",
      dot: "bg-sentinel-amber shadow-[0_0_8px_rgba(255,170,0,0.8)]",
    },
    CRITICAL: {
      label: "CRITICAL",
      color: "text-sentinel-red text-glow-red",
      dot: "bg-sentinel-red animate-pulse shadow-[0_0_12px_rgba(255,34,34,1)]",
    },
    OFFLINE: {
      label: "OFFLINE",
      color: "text-sentinel-text-dim",
      dot: "bg-sentinel-text-dim",
    },
  };
  const cfg = map[status];
  return (
    <div className="flex items-center gap-2">
      <div className={cn("w-2 h-2 rounded-full", cfg.dot)} />
      <span className={cn("font-mono text-xs tracking-widest font-semibold", cfg.color)}>
        {cfg.label}
      </span>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent = "green",
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  accent?: "green" | "red" | "teal" | "amber";
}) {
  const colors = {
    green: "text-sentinel-green border-sentinel-green/20 shadow-[0_0_20px_rgba(0,255,65,0.05)]",
    red: "text-sentinel-red border-sentinel-red/20 shadow-[0_0_20px_rgba(255,34,34,0.05)]",
    teal: "text-sentinel-teal border-sentinel-teal/20 shadow-[0_0_20px_rgba(0,255,255,0.05)]",
    amber:
      "text-sentinel-amber border-sentinel-amber/20 shadow-[0_0_20px_rgba(255,170,0,0.05)]",
  };
  return (
    <div
      className={cn(
        "bg-sentinel-surface border rounded-lg p-4 flex flex-col gap-2 font-mono",
        colors[accent]
      )}
    >
      <div className="flex items-center gap-2 opacity-70">
        <Icon size={14} />
        <span className="text-[10px] tracking-widest uppercase text-sentinel-text">
          {label}
        </span>
      </div>
      <div className={cn("text-2xl font-bold", colors[accent].split(" ")[0])}>{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Interception Node Visualizer (Sender-side)
// ─────────────────────────────────────────────────────────────────────────────

function InterceptionNodePanel({ nodes }: { nodes: InterceptionNodeInfo[] }) {
  if (nodes.length === 0) return null;

  return (
    <div className="space-y-2 mt-3">
      <div className="flex items-center gap-2 text-[10px] text-sentinel-red tracking-widest uppercase">
        <Crosshair size={12} />
        INTERCEPTED AT {nodes.length} NODE{nodes.length !== 1 ? "S" : ""}
      </div>
      {nodes.map((node) => (
        <motion.div
          key={node.node_id}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          className="border border-sentinel-red/30 rounded p-2 bg-sentinel-red/5"
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] text-sentinel-red font-bold">{node.node_id}</span>
            <span className="text-[9px] text-sentinel-amber">
              {node.match_count} HASH MATCH{node.match_count !== 1 ? "ES" : ""}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {node.matched_hashes.slice(0, 4).map((h, i) => (
              <span
                key={i}
                className="text-[8px] font-mono px-1 py-0.5 rounded bg-sentinel-red/10 border border-sentinel-red/20 text-sentinel-red/70"
              >
                {h.slice(0, 12)}…
              </span>
            ))}
          </div>
          <div className="text-[8px] text-sentinel-text-dim mt-1">
            FPR: {(node.false_positive_rate * 100).toFixed(4)}%
          </div>
        </motion.div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Threat Matrix Visualiser
// ─────────────────────────────────────────────────────────────────────────────

interface MatrixNode {
  id: string;
  hash: string;
  x: number;
  y: number;
  isColliding: boolean;
}

function ThreatMatrixVisualiser({
  latestEntry,
}: {
  latestEntry: ChatLogRow | null;
}) {
  const [nodes, setNodes] = useState<MatrixNode[]>([]);
  const controls = useAnimationControls();

  useEffect(() => {
    if (!latestEntry) return;

    const hashes = latestEntry.ngram_hash_sample ?? [];
    const newNodes: MatrixNode[] = Array.from(
      { length: Math.min(hashes.length || MAX_MATRIX_NODES, MAX_MATRIX_NODES) },
      (_, i) => ({
        id: `${latestEntry.id}-${i}`,
        hash: hashes[i] ? hashes[i].slice(0, 8) : glitchString(8),
        x: 10 + (i % 4) * 22,
        y: i < 4 ? 20 : 65,
        isColliding: latestEntry.threat_flag,
      })
    );

    setNodes(newNodes);
    controls.start("visible");
  }, [latestEntry, controls]);

  const containerVariants = {
    hidden: {},
    visible: { transition: { staggerChildren: 0.08 } },
  };

  const nodeVariants = {
    hidden: { opacity: 0, scale: 0, y: -20 },
    visible: {
      opacity: 1,
      scale: 1,
      y: 0,
      transition: { type: "spring" as const, stiffness: 300, damping: 20 },
    },
  };

  const collisionLineVariants = {
    hidden: { pathLength: 0, opacity: 0 },
    visible: {
      pathLength: 1,
      opacity: 1,
      transition: { duration: 0.6, delay: 0.4 },
    },
  };

  return (
    <div className="bg-sentinel-surface border border-sentinel-border rounded-lg p-4 font-mono">
      <div className="flex items-center gap-2 mb-3">
        <Cpu size={14} className="text-sentinel-teal" />
        <span className="text-[10px] tracking-widest uppercase text-sentinel-text">
          Threat Matrix — Bloom Collision Map
        </span>
        {latestEntry?.threat_flag && (
          <span className="ml-auto text-[10px] text-sentinel-red text-glow-red tracking-widest">
            ● COLLISION DETECTED
          </span>
        )}
      </div>

      <div className="relative h-36 border border-sentinel-border/40 rounded bg-sentinel-deep overflow-hidden hex-bg">
        <div className="absolute left-2 top-2 text-[9px] text-sentinel-text-dim tracking-widest">
          WATCHLIST FILTERS
        </div>
        <div className="absolute right-2 top-2 text-[9px] text-sentinel-text-dim tracking-widest">
          CHAT TOKENS
        </div>

        <motion.div
          className="absolute inset-x-0 h-px bg-sentinel-green/20"
          animate={{ y: ["0%", "100%"] }}
          transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
        />

        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          {latestEntry?.threat_flag &&
            nodes.slice(0, 3).map((node, i) => (
              <motion.line
                key={`line-${node.id}`}
                x1={node.x}
                y1={node.y}
                x2={75}
                y2={30 + i * 20}
                stroke="#ff2222"
                strokeWidth="0.3"
                variants={collisionLineVariants}
                initial="hidden"
                animate="visible"
              />
            ))}
          {!latestEntry?.threat_flag &&
            nodes.slice(0, 3).map((node, i) => (
              <motion.line
                key={`line-ok-${node.id}`}
                x1={node.x}
                y1={node.y}
                x2={75}
                y2={30 + i * 20}
                stroke="#00ff41"
                strokeWidth="0.2"
                strokeOpacity="0.3"
                variants={collisionLineVariants}
                initial="hidden"
                animate="visible"
              />
            ))}
        </svg>

        <motion.div
          className="absolute inset-0"
          variants={containerVariants}
          initial="hidden"
          animate={controls}
        >
          {nodes.map((node) => (
            <motion.div
              key={node.id}
              className={cn(
                "absolute text-[7px] font-mono px-1 py-0.5 rounded border",
                node.isColliding
                  ? "text-sentinel-red border-sentinel-red/50 bg-sentinel-red/10"
                  : "text-sentinel-green-dim border-sentinel-green/30 bg-sentinel-green/5"
              )}
              style={{ left: `${node.x}%`, top: `${node.y}%`, transform: "translate(-50%,-50%)" }}
              variants={nodeVariants}
            >
              {node.hash}
            </motion.div>
          ))}

          {[0, 1, 2].map((i) => (
            <motion.div
              key={`wl-${i}`}
              className="absolute text-[7px] font-mono px-1 py-0.5 rounded border border-sentinel-teal/30 bg-sentinel-teal/5 text-sentinel-teal-dim"
              style={{ left: "75%", top: `${30 + i * 20}%`, transform: "translate(-50%,-50%)" }}
              variants={nodeVariants}
            >
              BF[{i}]
            </motion.div>
          ))}
        </motion.div>

        {!latestEntry && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-sentinel-text-dim text-xs tracking-widest">
              AWAITING INTERCEPT…
            </span>
          </div>
        )}
      </div>

      {latestEntry && (
        <div className="mt-2 flex gap-4 text-[10px] text-sentinel-text-dim">
          <span>
            HASHES:{" "}
            <span className="text-sentinel-teal">{latestEntry.ngram_hash_sample?.length ?? 0}</span>
          </span>
          <span>
            MATCHES:{" "}
            <span className={latestEntry.threat_flag ? "text-sentinel-red" : "text-sentinel-green"}>
              {latestEntry.match_count}
            </span>
          </span>
          <span>
            SEVERITY:{" "}
            <SeverityBadge severity={latestEntry.severity ?? computeSeverity(latestEntry.match_count)} />
          </span>
          <span>
            UNIT:{" "}
            <span className="text-sentinel-green">{latestEntry.unit_id}</span>
          </span>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert Panel (Receiver)
// ─────────────────────────────────────────────────────────────────────────────

function AlertPanel({ threats }: { threats: ChatLogRow[] }) {
  if (threats.length === 0) {
    return (
      <div className="bg-sentinel-surface border border-sentinel-border rounded-lg p-4">
        <div className="flex items-center gap-2 mb-3">
          <Eye size={14} className="text-sentinel-green" />
          <span className="text-[10px] tracking-widest uppercase text-sentinel-text font-mono">
            Alert Status
          </span>
        </div>
        <div className="flex items-center gap-3 py-4">
          <Shield size={24} className="text-sentinel-green" />
          <div>
            <p className="text-sentinel-green font-mono text-sm font-semibold">ALL CLEAR</p>
            <p className="text-sentinel-text-dim text-xs font-mono mt-0.5">
              No threats detected in current session
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-sentinel-surface border border-sentinel-red/40 rounded-lg p-4 border-glow-red">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle size={14} className="text-sentinel-red animate-pulse" />
        <span className="text-[10px] tracking-widest uppercase text-sentinel-red text-glow-red font-mono">
          ACTIVE THREATS — {threats.length} DETECTED
        </span>
      </div>

      <div className="space-y-2 max-h-64 overflow-y-auto">
        <AnimatePresence mode="popLayout">
          {threats.map((t) => {
            const sev = t.severity ?? computeSeverity(t.match_count);
            return (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, x: 20, backgroundColor: "rgba(255,34,34,0.2)" }}
                animate={{ opacity: 1, x: 0, backgroundColor: "rgba(255,34,34,0)" }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.4 }}
                className="border border-sentinel-red/30 rounded p-3 bg-sentinel-red/5 font-mono"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <SeverityBadge severity={sev} />
                      <span className="text-sentinel-red text-[10px] font-bold">
                        POTENTIAL LEAK
                      </span>
                    </div>
                    <p className="text-sentinel-red/80 text-[11px]">
                      UNIT:{" "}
                      <span className="text-sentinel-red font-semibold">[{t.unit_id}]</span>
                    </p>
                    <p className="text-sentinel-text-dim text-[10px] mt-1 truncate">
                      {formatEncryptedPreview(t.encrypted_payload)}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sentinel-red/60 text-[10px]">
                      {relativeTime(t.timestamp)}
                    </p>
                    <p className="text-sentinel-amber text-[10px] mt-0.5">
                      {t.match_count} HIT{t.match_count !== 1 ? "S" : ""}
                    </p>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Live Intercept Feed
// ─────────────────────────────────────────────────────────────────────────────

function InterceptFeed({ entries, loading = false }: { entries: ChatLogRow[]; loading?: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  return (
    <div className="bg-sentinel-surface border border-sentinel-border rounded-lg p-4 flex flex-col font-mono">
      <div className="flex items-center gap-2 mb-3">
        <Radio size={14} className="text-sentinel-green" />
        <span className="text-[10px] tracking-widest uppercase text-sentinel-text">
          Live Intercept Feed
        </span>
        <span className="ml-auto text-[10px] text-sentinel-green/60">{entries.length} records</span>
      </div>

      <div className="flex-1 overflow-y-auto max-h-80 space-y-1 pr-1">
        {entries.length === 0 && !loading && (
          <div className="py-8 text-center text-sentinel-text-dim text-xs tracking-widest cursor-blink">
            MONITORING CHANNEL
          </div>
        )}

        {entries.length === 0 && loading && (
          <div className="space-y-1">
            <SkeletonFeedItem />
            <SkeletonFeedItem />
            <SkeletonFeedItem />
          </div>
        )}

        {entries.length === 0 && loading && (
          <div className="space-y-1">
            <SkeletonFeedItem />
            <SkeletonFeedItem />
            <SkeletonFeedItem />
          </div>
        )}

        <AnimatePresence mode="popLayout">
          {entries.map((entry, idx) => (
            <motion.div
              key={entry.id}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className={cn(
                "flex items-start gap-2 text-[11px] py-1.5 px-2 rounded border",
                entry.threat_flag
                  ? "border-sentinel-red/30 bg-sentinel-red/5 threat-flash"
                  : "border-transparent hover:border-sentinel-border/50 hover:bg-sentinel-muted/20"
              )}
            >
              <span className="text-sentinel-text-dim/40 w-5 text-right shrink-0 select-none">
                {String(idx + 1).padStart(2, "0")}
              </span>
              <span className="text-sentinel-text-dim/60 shrink-0 tabular-nums">
                {new Date(entry.timestamp).toISOString().slice(11, 19)}
              </span>
              <span className="text-sentinel-teal shrink-0">[{entry.unit_id}]</span>
              <span className={cn("flex-1 truncate", entry.threat_flag ? "text-sentinel-red/80" : "text-sentinel-green/70")}>
                {formatEncryptedPreview(entry.encrypted_payload)}
              </span>
              {entry.threat_flag ? (
                <SeverityBadge severity={entry.severity ?? computeSeverity(entry.match_count)} />
              ) : (
                <span className="shrink-0 text-sentinel-green/50 text-[9px] border border-sentinel-green/20 rounded px-1 py-0.5">
                  CLEAR
                </span>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender — Encryption Panel (with interception reporting)
// ─────────────────────────────────────────────────────────────────────────────

const DEMO_MESSAGES = [
  { unit: "ALPHA-7", msg: "Requesting status update on extraction point delta" },
  { unit: "BRAVO-2", msg: "Morning patrol, all clear on grid 4-7" },
  { unit: "CHARLIE-1", msg: "Nuclear override codes transmitted to command" },
  { unit: "DELTA-9", msg: "Resupply convoy ETA 0300 hours" },
  { unit: "ECHO-3", msg: "Launch codes confirmed, operation thunderstrike proceeding" },
  { unit: "FOXTROT-6", msg: "Nothing to report, weather nominal" },
  { unit: "GOLF-4", msg: "Classified coordinates for rally point received" },
];

const DEMO_MESSAGE_LABELS: Record<number, "CLEAR" | "THREAT"> = {
  0: "THREAT",
  1: "CLEAR",
  2: "THREAT",
  3: "CLEAR",
  4: "THREAT",
  5: "CLEAR",
  6: "THREAT",
};

interface IngestResult {
  unit: string;
  threat: boolean;
  severity: string;
  logId: string;
  encryptedPreview: string;
  encryptedFull?: string;
  encryptionSteps?: Record<string, unknown>;
  databasePersisted?: boolean;
  interceptingNodes: InterceptionNodeInfo[];
  matchCount: number;
  hashesGenerated: number;
}

interface IngestResponseForFeed {
  log_id: string;
  unit_id: string;
  timestamp: string;
  encrypted_payload_preview?: string;
  encrypted_payload_full: string;
  threat_analysis: ThreatAnalysis;
  ngram_hash_sample?: string[];
}

// Shared result renderer used by both tabs
function IngestResultView({ result }: { result: IngestResult }) {
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="mt-3 space-y-2">
      {/* Status banner */}
      <div className={cn(
        "p-3 rounded border",
        result.threat ? "border-sentinel-red/40 bg-sentinel-red/5" : "border-sentinel-green/20 bg-sentinel-green/5"
      )}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {result.threat
              ? <ShieldAlert size={16} className="text-sentinel-red" />
              : <ShieldCheck size={16} className="text-sentinel-green" />}
            <span className={cn("text-[11px] font-bold", result.threat ? "text-sentinel-red" : "text-sentinel-green")}>
              {result.threat ? "⚠ THREAT INTERCEPTED" : "✓ TRANSMISSION CLEAR"}
            </span>
          </div>
          <SeverityBadge severity={result.severity} />
        </div>
        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <div>
            <span className="text-sentinel-text-dim">Unit</span>
            <p className="text-sentinel-teal font-bold">[{result.unit}]</p>
          </div>
          <div>
            <span className="text-sentinel-text-dim">Hash Matches</span>
            <p className={result.threat ? "text-sentinel-red font-bold" : "text-sentinel-green"}>{result.matchCount}</p>
          </div>
          <div>
            <span className="text-sentinel-text-dim">Hashes Generated</span>
            <p className="text-sentinel-teal">{result.hashesGenerated}</p>
          </div>
        </div>
      </div>

      {/* Interception nodes */}
      {result.threat && <InterceptionNodePanel nodes={result.interceptingNodes} />}

      {/* Encryption pipeline */}
      <div className="rounded border border-sentinel-teal/30 bg-sentinel-deep/80 p-2 text-[10px]">
        <p className="text-sentinel-teal/80 uppercase tracking-wider mb-1">Encryption Pipeline</p>
        <ul className="list-inside list-disc text-sentinel-text-dim space-y-0.5">
          <li>1. Plaintext received at relay</li>
          <li>2. N-gram HMAC-SHA256 hashes: {String(result.encryptionSteps?.step_2_ngram_hashes_generated ?? "—")}</li>
          <li>3. AES-256-GCM encryption applied</li>
          <li>4. Plaintext zeroed from memory</li>
          <li>5. Bloom filter probe:{" "}
            <span className={result.threat ? "text-sentinel-red" : "text-sentinel-green"}>
              {result.threat ? "MATCH → INTERCEPTED" : "NO MATCH"}
            </span>
          </li>
        </ul>
      </div>

      {/* Ciphertext preview */}
      <div className="rounded border border-sentinel-border p-2 text-[9px] break-all text-sentinel-green/80">
        <span className="text-sentinel-text-dim uppercase">Ciphertext (hex): </span>
        {result.encryptedFull ? `${result.encryptedFull.slice(0, 80)}…` : result.encryptedPreview}
      </div>
      <p className="text-[9px] text-sentinel-text-dim">Log ID: {result.logId}</p>
      {result.databasePersisted === false && (
        <p className="text-[9px] text-sentinel-amber">
          DB offline — encryption and threat check still ran; record not persisted.
        </p>
      )}
    </motion.div>
  );
}

function SenderEncryptionPanel({
  apiUrl,
  onIngestSuccess,
}: {
  apiUrl: string;
  onIngestSuccess?: (data: IngestResponseForFeed) => void;
}) {
  type Tab = "custom" | "demo";
  const [tab, setTab] = useState<Tab>("custom");
  const [loading, setLoading] = useState(false);
  const [lastResult, setLastResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Custom message state
  const [customUnit, setCustomUnit] = useState("OPERATOR-1");
  const [customMsg, setCustomMsg] = useState("");

  // Demo message state
  const [demoIdx, setDemoIdx] = useState(0);
  const nextDemo = DEMO_MESSAGES[demoIdx % DEMO_MESSAGES.length];
  const nextLabel = DEMO_MESSAGE_LABELS[demoIdx % DEMO_MESSAGES.length] ?? "CLEAR";

  // Shared submit logic
  const submitIngest = useCallback(async (unitId: string, message: string) => {
    setLoading(true);
    setLastResult(null);
    setError(null);

    try {
      const res = await fetch(`${apiUrl}/api/ingest-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unit_id: unitId.trim().toUpperCase(), message: message.trim() }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      const ta = data.threat_analysis ?? {};

      const result: IngestResult = {
        unit: unitId.trim().toUpperCase(),
        threat: ta.is_threat ?? false,
        severity: ta.severity ?? "CLEAR",
        logId: data.log_id,
        encryptedPreview: data.encrypted_payload_preview ?? "",
        encryptedFull: data.encrypted_payload_full,
        encryptionSteps: data.encryption_steps,
        databasePersisted: data.database_persisted !== false,
        interceptingNodes: ta.intercepting_nodes ?? [],
        matchCount: ta.match_count ?? 0,
        hashesGenerated: ta.hashes_generated ?? 0,
      };

      setLastResult(result);
      onIngestSuccess?.({
        log_id: data.log_id,
        unit_id: data.unit_id ?? unitId,
        timestamp: data.timestamp,
        encrypted_payload_full: data.encrypted_payload_full ?? data.encrypted_payload_preview ?? "",
        threat_analysis: ta,
        ngram_hash_sample: data.ngram_hash_sample ?? [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Transmission failed");
    } finally {
      setLoading(false);
    }
  }, [apiUrl, onIngestSuccess]);

  const sendCustom = useCallback(() => {
    if (!customMsg.trim()) return;
    submitIngest(customUnit || "OPERATOR-1", customMsg);
  }, [customUnit, customMsg, submitIngest]);

  const sendDemo = useCallback(() => {
    const demo = DEMO_MESSAGES[demoIdx % DEMO_MESSAGES.length];
    setDemoIdx((i) => i + 1);
    submitIngest(demo.unit, demo.msg);
  }, [demoIdx, submitIngest]);

  const tabCls = (t: Tab) =>
    cn(
      "flex-1 py-1.5 text-[10px] font-semibold tracking-widest rounded-sm border transition-colors",
      tab === t
        ? "bg-sentinel-teal/10 border-sentinel-teal/50 text-sentinel-teal"
        : "bg-transparent border-sentinel-border/40 text-sentinel-text-dim hover:text-sentinel-text hover:border-sentinel-border"
    );

  return (
    <div className="bg-sentinel-surface border border-sentinel-border rounded-lg p-4 font-mono">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <Send size={14} className="text-sentinel-teal" />
        <span className="text-[10px] tracking-widest uppercase text-sentinel-text">
          Encrypt & Transmit
        </span>
      </div>

      {/* Tab toggle */}
      <div className="flex gap-1.5 mb-4">
        <button className={tabCls("custom")} onClick={() => { setTab("custom"); setLastResult(null); setError(null); }}>
          ✎ COMPOSE
        </button>
        <button className={tabCls("demo")} onClick={() => { setTab("demo"); setLastResult(null); setError(null); }}>
          ⚡ DEMO
        </button>
      </div>

      {/* ── COMPOSE TAB ── */}
      {tab === "custom" && (
        <div className="space-y-3">
          {/* Unit ID */}
          <div>
            <label className="block text-[9px] text-sentinel-text-dim uppercase tracking-wider mb-1">
              Unit / Callsign
            </label>
            <input
              type="text"
              value={customUnit}
              onChange={(e) => setCustomUnit(e.target.value.toUpperCase().replace(/[^A-Z0-9\-_]/g, ""))}
              maxLength={16}
              placeholder="e.g. ALPHA-7"
              className="w-full bg-sentinel-deep border border-sentinel-border rounded px-2.5 py-1.5 text-[11px] text-sentinel-teal placeholder-sentinel-text-dim/40 focus:outline-none focus:border-sentinel-teal/60 uppercase tracking-wider"
            />
          </div>

          {/* Message */}
          <div>
            <label className="block text-[9px] text-sentinel-text-dim uppercase tracking-wider mb-1">
              Message (plaintext — will be encrypted before transmission)
            </label>
            <textarea
              value={customMsg}
              onChange={(e) => setCustomMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) sendCustom();
              }}
              maxLength={2048}
              rows={3}
              placeholder="Type your confidential message here…"
              className="w-full bg-sentinel-deep border border-sentinel-border rounded px-2.5 py-2 text-[11px] text-sentinel-green placeholder-sentinel-text-dim/40 focus:outline-none focus:border-sentinel-green/50 resize-none leading-relaxed"
            />
            <div className="flex items-center justify-between mt-1">
              <span className="text-[8px] text-sentinel-text-dim">Ctrl+Enter to send</span>
              <span className={cn("text-[8px]", customMsg.length > 1800 ? "text-sentinel-amber" : "text-sentinel-text-dim")}>
                {customMsg.length}/2048
              </span>
            </div>
          </div>

          <button
            onClick={sendCustom}
            disabled={loading || !customMsg.trim()}
            className={cn(
              "w-full py-2.5 px-4 rounded text-xs font-bold tracking-widest border transition-all duration-200 flex items-center justify-center gap-2",
              loading || !customMsg.trim()
                ? "border-sentinel-border text-sentinel-text-dim bg-sentinel-muted cursor-not-allowed opacity-50"
                : "border-sentinel-teal/50 text-sentinel-teal bg-sentinel-teal/5 hover:bg-sentinel-teal/10 hover:border-sentinel-teal/80"
            )}
          >
            {loading ? (
              <>
                <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.8, ease: "linear" }} className="inline-block text-base leading-none">◌</motion.span>
                ENCRYPTING & TRANSMITTING…
              </>
            ) : (
              <>
                <Lock size={12} />
                ENCRYPT & SEND
              </>
            )}
          </button>
        </div>
      )}

      {/* ── DEMO TAB ── */}
      {tab === "demo" && (
        <div className="space-y-3">
          <p className="text-[10px] text-sentinel-text-dim">
            Cycle through pre-loaded messages that cover both classified and non-classified content to demonstrate the detection engine.
          </p>
          <div className="p-3 rounded border border-sentinel-border/60 bg-sentinel-deep/80">
            <p className="text-[9px] text-sentinel-text-dim uppercase tracking-wider mb-1.5">Next message</p>
            <p className="text-[11px] text-sentinel-green/90 break-words leading-relaxed">
              <span className="text-sentinel-teal">[{nextDemo.unit}]</span>{" "}{nextDemo.msg}
            </p>
            <span className={cn(
              "inline-block mt-2 text-[9px] font-bold px-1.5 py-0.5 rounded border",
              nextLabel === "THREAT"
                ? "text-sentinel-red border-sentinel-red/40 bg-sentinel-red/10"
                : "text-sentinel-green border-sentinel-green/30 bg-sentinel-green/10"
            )}>
              Expected: {nextLabel}
            </span>
          </div>

          <button
            onClick={sendDemo}
            disabled={loading}
            className={cn(
              "w-full py-2.5 px-4 rounded text-xs font-bold tracking-widest border transition-all duration-200 flex items-center justify-center gap-2",
              loading
                ? "border-sentinel-border text-sentinel-text-dim bg-sentinel-muted cursor-not-allowed"
                : "border-sentinel-green/40 text-sentinel-green bg-sentinel-green/5 hover:bg-sentinel-green/10 hover:border-sentinel-green/70"
            )}
          >
            {loading ? (
              <>
                <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.8, ease: "linear" }} className="inline-block text-base leading-none">◌</motion.span>
                ENCRYPTING…
              </>
            ) : (
              <>
                <Zap size={12} />
                SEND DEMO MESSAGE
              </>
            )}
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 p-2 rounded border border-sentinel-red/40 bg-sentinel-red/5 text-[10px] text-sentinel-red">
          ⚠ {error}
        </motion.div>
      )}

      {/* Shared result view */}
      {lastResult && <IngestResultView result={lastResult} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Receiver — Decrypt Panel
// ─────────────────────────────────────────────────────────────────────────────

function ReceiverDecryptPanel({ apiUrl }: { apiUrl: string }) {
  const [logId, setLogId] = useState("");
  const [loading, setLoading] = useState(false);
  const [decrypted, setDecrypted] = useState<{ plaintext: string; unit_id: string; timestamp: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decrypt = useCallback(async () => {
    if (!logId.trim()) return;
    setLoading(true);
    setDecrypted(null);
    setError(null);
    try {
      const res = await fetchWithRetry(`${apiUrl}/api/decrypt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ log_id: logId.trim() }),
      }, 2, 1000);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      setDecrypted({ plaintext: data.plaintext, unit_id: data.unit_id, timestamp: data.timestamp });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decryption failed");
    } finally {
      setLoading(false);
    }
  }, [apiUrl, logId]);

  return (
    <div className="bg-sentinel-surface border border-sentinel-border rounded-lg p-4 font-mono">
      <div className="flex items-center gap-2 mb-3">
        <Unlock size={14} className="text-sentinel-amber" />
        <span className="text-[10px] tracking-widest uppercase text-sentinel-text">
          Authorised Decryption
        </span>
      </div>
      <p className="text-[10px] text-sentinel-text-dim mb-2">
        Fetch ciphertext from DB and decrypt with AES key (receiver-only).
      </p>
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          placeholder="Log ID (UUID)"
          value={logId}
          onChange={(e) => setLogId(e.target.value)}
          className="flex-1 bg-sentinel-deep border border-sentinel-border rounded px-2 py-1.5 text-[11px] text-sentinel-green placeholder-sentinel-text-dim/50 focus:outline-none focus:border-sentinel-green/50"
        />
        <button
          onClick={decrypt}
          disabled={loading || !logId.trim()}
          className="px-3 py-1.5 rounded text-[10px] font-semibold border border-sentinel-amber/40 text-sentinel-amber bg-sentinel-amber/5 hover:bg-sentinel-amber/10 disabled:opacity-50"
        >
          {loading ? "…" : "Decrypt"}
        </button>
      </div>
      {error && <p className="text-[10px] text-sentinel-red mb-2">{error}</p>}
      {decrypted && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded border border-sentinel-green/30 bg-sentinel-green/5 p-2 text-[11px]">
          <p className="text-sentinel-text-dim text-[9px] uppercase mb-1">Decrypted at receiver</p>
          <p className="text-sentinel-green break-words">{decrypted.plaintext}</p>
          <div className="flex items-center gap-2 mt-1">
            <div className="flex items-center gap-1">
              <span className="text-sentinel-text-dim text-[9px]">[{decrypted.unit_id}]</span>
              <CopyButton text={decrypted.unit_id} label="Copy unit ID" />
            </div>
            <span className="text-sentinel-text-dim text-[9px]">{decrypted.timestamp}</span>
          </div>
        </motion.div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Search encrypted DB (SSE trapdoor)
// ─────────────────────────────────────────────────────────────────────────────

function SearchEncryptedPanel({ apiUrl }: { apiUrl: string }) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ message: string; trapdoor_hashes_count: number; matches: Array<{ id: string; unit_id: string; encrypted_preview: string; threat_flag: boolean; match_count?: number }> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetchWithRetry(`${apiUrl}/api/search-encrypted`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim() }),
      }, 2, 1000);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      setResult({
        message: data.message,
        trapdoor_hashes_count: data.trapdoor_hashes_count ?? 0,
        matches: data.matches ?? [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, [apiUrl, query]);

  return (
    <div className="bg-sentinel-surface border border-sentinel-border rounded-lg p-4 font-mono">
      <div className="flex items-center gap-2 mb-3">
        <Search size={14} className="text-sentinel-teal" />
        <span className="text-[10px] tracking-widest uppercase text-sentinel-text">
          SSE Encrypted Search
        </span>
      </div>
      <p className="text-[10px] text-sentinel-text-dim mb-2">
        Query → HMAC trapdoors → match stored hashes — no decryption needed.
      </p>
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          placeholder="e.g. classified, thunderstrike, nuclear"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          className="flex-1 bg-sentinel-deep border border-sentinel-border rounded px-2 py-1.5 text-[11px] text-sentinel-green placeholder-sentinel-text-dim/50 focus:outline-none focus:border-sentinel-teal/50"
        />
        <button
          onClick={search}
          disabled={loading || !query.trim()}
          className="px-3 py-1.5 rounded text-[10px] font-semibold border border-sentinel-teal/40 text-sentinel-teal bg-sentinel-teal/5 hover:bg-sentinel-teal/10 disabled:opacity-50"
        >
          {loading ? "…" : "Search"}
        </button>
      </div>
      {error && <p className="text-[10px] text-sentinel-red mb-2">{error}</p>}
      {result && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-2">
          <p className="text-[10px] text-sentinel-teal/90">{result.message}</p>
          <p className="text-[9px] text-sentinel-text-dim">Trapdoor hashes generated: {result.trapdoor_hashes_count}</p>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {result.matches.length === 0 ? (
              <p className="text-[10px] text-sentinel-text-dim">No matches (no overlap with stored hashes).</p>
            ) : (
              result.matches.map((m) => (
                <div key={m.id} className="rounded border border-sentinel-border/60 p-2 text-[10px]">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="flex items-center gap-1">
                      <span className="text-sentinel-green">[{m.unit_id}]</span>
                      <CopyButton text={m.unit_id} label="Copy unit ID" />
                    </div>
                    <span className="text-sentinel-text-dim break-all flex-1">{m.encrypted_preview}</span>
                    {m.threat_flag ? (
                      <SeverityBadge severity={computeSeverity(m.match_count ?? 0)} />
                    ) : (
                      <span className="text-sentinel-green/50 text-[9px]">CLEAR</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[8px] text-sentinel-text-dim">ID: {m.id}</span>
                    <CopyButton text={m.id} label="Copy message ID" />
                  </div>
                </div>
              ))
            )}
          </div>
        </motion.div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Threat Intelligence Panel (Receiver - fetches from /api/threats)
// ─────────────────────────────────────────────────────────────────────────────

function ThreatIntelPanel({ apiUrl }: { apiUrl: string }) {
  const [data, setData] = useState<ThreatFeedResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchThreats = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithRetry(`${apiUrl}/api/threats`, {}, 2, 1000);
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch {
      /* network error */
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    fetchThreats();
    const interval = setInterval(fetchThreats, 15_000);
    return () => clearInterval(interval);
  }, [fetchThreats]);

  if (!data) {
    return (
      <div className="bg-sentinel-surface border border-sentinel-border rounded-lg p-4 font-mono">
        <div className="flex items-center gap-2 mb-3">
          <Target size={14} className="text-sentinel-red" />
          <span className="text-[10px] tracking-widest uppercase text-sentinel-text">
            Threat Intelligence
          </span>
        </div>
        {loading ? (
          <div className="space-y-2">
            <SkeletonThreatItem />
            <SkeletonThreatItem />
            <SkeletonThreatItem />
          </div>
        ) : (
          <p className="text-[10px] text-sentinel-text-dim">Waiting for data…</p>
        )}
      </div>
    );
  }

  const sevBreak = data.severity_breakdown ?? {};

  return (
    <div className="bg-sentinel-surface border border-sentinel-red/20 rounded-lg p-4 font-mono">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Target size={14} className="text-sentinel-red" />
          <span className="text-[10px] tracking-widest uppercase text-sentinel-text">
            Threat Intelligence
          </span>
        </div>
        <button
          onClick={fetchThreats}
          disabled={loading}
          className="text-[9px] text-sentinel-text-dim hover:text-sentinel-teal transition-colors"
        >
          {loading ? "…" : "REFRESH"}
        </button>
      </div>

      {/* Severity breakdown */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((sev) => {
          const cfg = SEVERITY_CONFIG[sev];
          const count = sevBreak[sev] ?? 0;
          return (
            <div key={sev} className={cn("rounded border p-2 text-center", cfg.border, cfg.bg)}>
              <p className={cn("text-lg font-bold", cfg.color)}>{count}</p>
              <p className="text-[8px] tracking-wider text-sentinel-text-dim">{sev}</p>
            </div>
          );
        })}
      </div>

      {/* Threat list */}
      <div className="max-h-56 overflow-y-auto space-y-1.5">
        {data.threats.length === 0 ? (
          <div className="py-4 text-center">
            <ShieldCheck size={20} className="mx-auto text-sentinel-green mb-1" />
            <p className="text-[10px] text-sentinel-green">No threats detected</p>
          </div>
        ) : (
          data.threats.slice(0, 20).map((t) => (
            <div key={t.id} className="rounded border border-sentinel-border/60 p-2 text-[10px]">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={t.severity} />
                  <div className="flex items-center gap-1">
                    <span className="text-sentinel-teal">[{t.unit_id}]</span>
                    <CopyButton text={t.unit_id} label="Copy unit ID" />
                  </div>
                </div>
                <span className="text-sentinel-text-dim text-[9px]">{relativeTime(t.timestamp)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sentinel-text-dim break-all text-[9px]">{t.encrypted_preview}</span>
                <span className="text-sentinel-amber text-[9px] shrink-0 ml-2">
                  {t.match_count} HITS
                </span>
              </div>
              <div className="flex items-center gap-1 mt-1">
                <span className="text-[8px] text-sentinel-text-dim">ID: {t.id}</span>
                <CopyButton text={t.id} label="Copy message ID" />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Receiver Dashboard (full command center — NO message sending)
// ─────────────────────────────────────────────────────────────────────────────

export function ReceiverDashboard({ onSignOut }: { onSignOut?: () => void } = {}) {
  const [entries, setEntries] = useState<ChatLogRow[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatus>("OFFLINE");
  const [threatCount, setThreatCount] = useState(0);
  const [totalIntercepted, setTotalIntercepted] = useState(0);
  const [uptime, setUptime] = useState("00:00:00");
  const [show3DGraph, setShow3DGraph] = useState(false);
  const startTimeRef = useRef(Date.now());
  // Track whether an INGEST came from WS (to suppress Supabase duplicate)
  const wsIngestIds = useRef(new Set<string>());

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "";

  // ── Uptime counter ──────────────────────────────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const h = Math.floor(elapsed / 3_600_000);
      const m = Math.floor((elapsed % 3_600_000) / 60_000);
      const s = Math.floor((elapsed % 60_000) / 1_000);
      setUptime(
        `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // ── Load historical stats from /api/threats ─────────────────────────────────
  useEffect(() => {
    fetch(`${apiUrl}/api/threats?limit=50`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ThreatFeedResponse | null) => {
        if (!data) return;
        setTotalIntercepted(data.total_intercepted);
        setThreatCount(data.total_threats);
        if (data.total_threats > 0) setSystemStatus("ELEVATED");
        else setSystemStatus("NOMINAL");
      })
      .catch(() => {/* network error */ });
  }, [apiUrl]);

  // ── Push a new row into the entries feed ────────────────────────────────────
  const pushEntry = useCallback((row: ChatLogRow) => {
    setEntries((prev) => [row, ...prev].slice(0, MAX_FEED_ITEMS));
    setTotalIntercepted((n) => n + 1);
    if (row.threat_flag) {
      setThreatCount((n) => n + 1);
      setSystemStatus("CRITICAL");
      setTimeout(() => setSystemStatus((s) => (s === "CRITICAL" ? "ELEVATED" : s)), 10_000);
    }
  }, []);

  // ── Primary: WebSocket live feed ────────────────────────────────────────────
  const handleWsMessage = useCallback((msg: WsMessage) => {
    if (msg.type !== "INGEST") return;
    wsIngestIds.current.add(msg.log_id);
    const row: ChatLogRow = {
      id: msg.log_id,
      unit_id: msg.unit_id,
      timestamp: msg.timestamp,
      encrypted_payload: msg.encrypted_payload_full,
      threat_flag: msg.threat_analysis?.is_threat ?? false,
      match_count: msg.threat_analysis?.match_count ?? 0,
      ngram_hash_sample: msg.ngram_hash_sample ?? null,
      created_at: msg.timestamp,
      severity: msg.threat_analysis?.severity ?? "CLEAR",
    };
    pushEntry(row);
  }, [pushEntry]);

  const { connected: wsConnected, senderCount: wsSenderCount } = useWebSocket({
    apiUrl,
    role: "receiver",
    onMessage: handleWsMessage,
  });

  // REST poll as presence fallback — wins if WS STATUS was missed
  const { senderCount: pollSenderCount } = usePresencePoll(apiUrl);
  const senderCount = Math.max(wsSenderCount, pollSenderCount);

  // Update system status based on WS connectivity
  useEffect(() => {
    if (wsConnected) {
      setSystemStatus((prev) => (prev === "OFFLINE" ? "NOMINAL" : prev));
    } else {
      setSystemStatus((prev) => (prev === "NOMINAL" ? "OFFLINE" : prev));
    }
  }, [wsConnected]);

  // ── Fallback: Supabase Realtime (fires if WS missed the row) ───────────────
  useEffect(() => {
    const channel = supabase
      .channel("sentinel-chat-logs-rx")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "chat_logs" },
        (payload: unknown) => {
          const newRow = (payload as { new: ChatLogRow }).new;
          // Skip if WS already delivered this row
          if (wsIngestIds.current.has(newRow.id)) return;
          pushEntry({ ...newRow, severity: computeSeverity(newRow.match_count) });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [pushEntry]);

  const threats = entries.filter((e) => e.threat_flag);
  const latestEntry = entries[0] ?? null;
  const connected = wsConnected;

  return (
    <div className="min-h-screen bg-sentinel-black text-sentinel-text font-mono hex-bg">
      {/* ── Header ── */}
      <header className="sticky top-0 z-50 border-b border-sentinel-border bg-sentinel-black/95 backdrop-blur-sm">
        <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Shield size={22} className="text-sentinel-green text-glow-green" />
              <motion.div
                className="absolute inset-0 rounded-full border border-sentinel-green/30"
                animate={{ scale: [1, 1.6, 1], opacity: [0.5, 0, 0.5] }}
                transition={{ repeat: Infinity, duration: 2.5 }}
              />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-[0.3em] text-sentinel-green text-glow-green">
                PROJECT SENTINEL
              </h1>
              <p className="text-[9px] tracking-[0.2em] text-sentinel-text-dim uppercase">
                Receiver — Threat Detection Command Center
              </p>
            </div>
          </div>

          <div className="h-8 w-px bg-sentinel-border mx-2" />
          <StatusIndicator status={systemStatus} />
          <div className="flex-1" />

          {/* Live channel status */}
          <div className="flex items-center gap-3 text-[10px]">
            {connected ? (
              <div className="flex items-center gap-1.5">
                <motion.span
                  className="inline-block w-1.5 h-1.5 rounded-full bg-sentinel-green"
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ repeat: Infinity, duration: 1.4 }}
                />
                <Wifi size={11} className="text-sentinel-green" />
                <span className="text-sentinel-green">LIVE CHANNEL</span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <WifiOff size={11} className="text-sentinel-text-dim" />
                <span className="text-sentinel-text-dim">CONNECTING…</span>
              </div>
            )}

            <div className="h-4 w-px bg-sentinel-border" />

            {/* Sender online indicator */}
            <div className="flex items-center gap-1.5">
              <Send size={10} className={senderCount > 0 ? "text-sentinel-teal" : "text-sentinel-text-dim/40"} />
              <span className={senderCount > 0 ? "text-sentinel-teal" : "text-sentinel-text-dim/40"}>
                {senderCount > 0 ? `SENDER ONLINE (${senderCount})` : "SENDER OFFLINE"}
              </span>
            </div>
          </div>

          <div className="h-8 w-px bg-sentinel-border mx-2" />
          <div className="text-[10px] text-sentinel-text-dim tabular-nums">
            UPTIME <span className="text-sentinel-green">{uptime}</span>
          </div>

          {onSignOut && (
            <>
              <div className="h-8 w-px bg-sentinel-border mx-2" />
              <button
                type="button"
                onClick={onSignOut}
                className="flex items-center gap-2 text-[10px] text-sentinel-text-dim hover:text-sentinel-red transition-colors"
              >
                <LogOut size={12} />
                SIGN OUT
              </button>
            </>
          )}
        </div>
      </header>

      {/* ── CRITICAL THREAT BANNER ── */}
      <AnimatePresence>
        {systemStatus === "CRITICAL" && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="bg-sentinel-red/10 border-b border-sentinel-red/50 px-4 py-2">
              <div className="max-w-screen-2xl mx-auto flex items-center gap-3">
                <motion.div
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ repeat: Infinity, duration: 0.6 }}
                >
                  <AlertTriangle size={16} className="text-sentinel-red" />
                </motion.div>
                <span className="text-sentinel-red font-bold text-xs tracking-widest text-glow-red">
                  CLASSIFIED KEYWORD LEAK DETECTED — INTERCEPTION PROTOCOL ACTIVE
                </span>
                <span className="ml-auto text-sentinel-red/60 text-[10px]">
                  THREAT COUNT: {threatCount}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Main content ── */}
      <main className="max-w-screen-2xl mx-auto px-4 py-6 space-y-6">
        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={Activity} label="Intercepted" value={totalIntercepted} accent="teal" />
          <StatCard icon={AlertTriangle} label="Threats" value={threatCount} accent={threatCount > 0 ? "red" : "green"} />
          <StatCard icon={Lock} label="Encryption" value="AES-256" accent="green" />
          <StatCard icon={Database} label="Bloom Size" value="10K bits" accent="amber" />
        </div>

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left column: Feed + Matrix */}
          <div className="lg:col-span-2 space-y-4">
            <InterceptFeed entries={entries} />
            <ThreatMatrixVisualiser latestEntry={latestEntry} />
          </div>

          {/* Right column: Threat Intel + Alerts + Decrypt + Search */}
          <div className="space-y-4">
            <ThreatIntelPanel apiUrl={apiUrl} />
            <Suspense fallback={null}>
              <ThreatNetworkStats apiUrl={apiUrl} onOpenGraph={() => setShow3DGraph(true)} isOpen={show3DGraph} />
            </Suspense>
            <AlertPanel threats={threats} />
            <ReceiverDecryptPanel apiUrl={apiUrl} />
            <SearchEncryptedPanel apiUrl={apiUrl} />

            {/* Crypto parameters */}
            <div className="bg-sentinel-surface border border-sentinel-border rounded-lg p-4 text-[10px] space-y-2">
              <div className="flex items-center gap-2 mb-3">
                <Lock size={12} className="text-sentinel-green" />
                <span className="tracking-widest uppercase text-sentinel-text">
                  Crypto Parameters
                </span>
              </div>
              {[
                ["Cipher", "AES-256-GCM"],
                ["Nonce", "96-bit random"],
                ["MAC", "HMAC-SHA256"],
                ["Token Method", "N-gram SSE"],
                ["Filter", "Bloom (k=7)"],
                ["FPR", "~0.008%"],
                ["Key Derivation", "Hex → 32B"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-sentinel-text-dim">{k}</span>
                  <span className="text-sentinel-green">{v}</span>
                </div>
              ))}
            </div>

            {/* Architecture note */}
            <div className="bg-sentinel-surface border border-sentinel-border rounded-lg p-4 text-[10px]">
              <div className="flex items-center gap-2 mb-2">
                <ChevronRight size={10} className="text-sentinel-teal" />
                <span className="tracking-widest uppercase text-sentinel-text">
                  Zero-Exposure Guarantee
                </span>
              </div>
              <p className="text-sentinel-text-dim leading-relaxed">
                Plaintext is hashed in-memory and immediately discarded.
                Only AES-GCM ciphertext reaches the database.
                Detection uses Bloom filter probing — no decryption occurs
                at any stage of the pipeline.
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-sentinel-border mt-8 py-4 px-4">
        <div className="max-w-screen-2xl mx-auto flex items-center justify-between text-[9px] text-sentinel-text-dim tracking-widest">
          <span>PROJECT SENTINEL v1.0 — CLASSIFICATION: UNCLASSIFIED DEMO</span>
          <span>SSE + BLOOM FILTER ENGINE</span>
          <span>POWERED BY FASTAPI + SUPABASE + NEXT.JS 14</span>
        </div>
      </footer>

      {/* 3D Threat Network Modal */}
      <AnimatePresence>
        {show3DGraph && (
          <Suspense fallback={null}>
            <ThreatNetwork3D apiUrl={apiUrl} onClose={() => setShow3DGraph(false)} />
          </Suspense>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender Dashboard (encryption + interception feedback)
// ─────────────────────────────────────────────────────────────────────────────

export function SenderDashboard({ onSignOut }: { onSignOut?: () => void } = {}) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "";

  const [sentMessages, setSentMessages] = useState<ChatLogRow[]>([]);
  const [threatCount, setThreatCount] = useState(0);
  const [totalSent, setTotalSent] = useState(0);

  const handleIngestSuccess = useCallback((data: IngestResponseForFeed) => {
    const row: ChatLogRow = {
      id: data.log_id,
      unit_id: data.unit_id,
      timestamp: data.timestamp,
      encrypted_payload: data.encrypted_payload_full ?? "",
      threat_flag: data.threat_analysis?.is_threat ?? false,
      match_count: data.threat_analysis?.match_count ?? 0,
      ngram_hash_sample: data.ngram_hash_sample ?? null,
      created_at: data.timestamp,
      severity: data.threat_analysis?.severity ?? "CLEAR",
    };
    setSentMessages((prev) => [row, ...prev].slice(0, 20));
    setTotalSent((n) => n + 1);
    if (row.threat_flag) setThreatCount((n) => n + 1);
  }, []);

  // WebSocket — connect as 'sender' to see receiver presence
  const handleWsStatus = useCallback((_msg: WsMessage) => {/* presence counts handled via hook state */ }, []);
  const { connected: wsConnected, receiverCount: wsReceiverCount } = useWebSocket({
    apiUrl,
    role: "sender",
    onMessage: handleWsStatus,
  });

  // REST poll as presence fallback
  const { receiverCount: pollReceiverCount } = usePresencePoll(apiUrl);
  const receiverCount = Math.max(wsReceiverCount, pollReceiverCount);
  const receiverOnline = receiverCount > 0;

  return (
    <div className="min-h-screen bg-sentinel-black text-sentinel-text font-mono hex-bg">
      <header className="sticky top-0 z-50 border-b border-sentinel-border bg-sentinel-black/95 backdrop-blur-sm">
        <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Send size={22} className="text-sentinel-teal" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-[0.3em] text-sentinel-teal">
                SENDER — PROJECT SENTINEL
              </h1>
              <p className="text-[9px] tracking-[0.2em] text-sentinel-text-dim uppercase">
                Encrypt & Transmit — Interception Monitor
              </p>
            </div>
          </div>

          <div className="h-8 w-px bg-sentinel-border mx-2" />

          {/* Receiver presence indicator */}
          <AnimatePresence mode="wait">
            {receiverOnline ? (
              <motion.div
                key="online"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="flex items-center gap-2 px-3 py-1 rounded border border-sentinel-green/40 bg-sentinel-green/5"
              >
                <motion.span
                  className="inline-block w-1.5 h-1.5 rounded-full bg-sentinel-green"
                  animate={{ opacity: [1, 0.2, 1] }}
                  transition={{ repeat: Infinity, duration: 1.2 }}
                />
                <Shield size={11} className="text-sentinel-green" />
                <span className="text-sentinel-green text-[10px] font-bold tracking-wider">
                  RECEIVER ONLINE
                </span>
                {receiverCount > 1 && (
                  <span className="text-sentinel-green/60 text-[9px]">×{receiverCount}</span>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="offline"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 px-3 py-1 rounded border border-sentinel-red/30 bg-sentinel-red/5"
              >
                <WifiOff size={11} className="text-sentinel-red/60" />
                <span className="text-sentinel-red/60 text-[10px] tracking-wider">
                  RECEIVER OFFLINE
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex-1" />

          {/* Stats */}
          <div className="flex items-center gap-4 text-[10px]">
            {wsConnected ? (
              <div className="flex items-center gap-1.5">
                <motion.span
                  className="inline-block w-1.5 h-1.5 rounded-full bg-sentinel-teal"
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ repeat: Infinity, duration: 1.6 }}
                />
                <span className="text-sentinel-teal">CHANNEL LIVE</span>
              </div>
            ) : (
              <span className="text-sentinel-text-dim">CONNECTING…</span>
            )}
            <div className="h-4 w-px bg-sentinel-border" />
            <span className="text-sentinel-text-dim">
              SENT: <span className="text-sentinel-teal font-bold">{totalSent}</span>
            </span>
            <span className="text-sentinel-text-dim">
              INTERCEPTED: <span className={cn("font-bold", threatCount > 0 ? "text-sentinel-red" : "text-sentinel-green")}>{threatCount}</span>
            </span>
          </div>

          {onSignOut && (
            <>
              <div className="h-8 w-px bg-sentinel-border mx-2" />
              <button
                type="button"
                onClick={onSignOut}
                className="flex items-center gap-2 text-[10px] text-sentinel-text-dim hover:text-sentinel-red transition-colors"
              >
                <LogOut size={12} />
                SIGN OUT
              </button>
            </>
          )}
        </div>
      </header>

      {/* Receiver offline warning banner */}
      <AnimatePresence>
        {!receiverOnline && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="bg-sentinel-amber/10 border-b border-sentinel-amber/40 px-4 py-2">
              <div className="max-w-screen-2xl mx-auto flex items-center gap-3">
                <AlertTriangle size={14} className="text-sentinel-amber animate-pulse" />
                <span className="text-sentinel-amber text-[10px] tracking-widest">
                  RECEIVER NOT CONNECTED — Messages will be encrypted and stored but the receiver may not see them in real-time
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="max-w-screen-2xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Left: send panel */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-sentinel-surface border border-sentinel-teal/30 rounded-lg p-4 text-[10px] text-sentinel-text-dim">
              You are logged in as <span className="text-sentinel-teal font-bold">Sender</span>.
              Messages are encrypted and checked against threat watchlists in real-time.
              Interception results appear immediately after transmission.
            </div>
            <SenderEncryptionPanel apiUrl={apiUrl} onIngestSuccess={handleIngestSuccess} />

            {/* Crypto info */}
            <div className="bg-sentinel-surface border border-sentinel-border rounded-lg p-4 text-[10px] space-y-2">
              <div className="flex items-center gap-2 mb-2">
                <Lock size={12} className="text-sentinel-green" />
                <span className="tracking-widest uppercase text-sentinel-text">Pipeline</span>
              </div>
              <p className="text-sentinel-text-dim">AES-256-GCM · N-gram HMAC-SHA256 · Bloom Filter Threat Check</p>
            </div>
          </div>

          {/* Right: transmission log */}
          <div className="lg:col-span-3 space-y-4">
            <div className="bg-sentinel-surface border border-sentinel-border rounded-lg p-4 font-mono">
              <div className="flex items-center gap-2 mb-3">
                <BarChart3 size={14} className="text-sentinel-teal" />
                <span className="text-[10px] tracking-widest uppercase text-sentinel-text">
                  Transmission Log
                </span>
                <span className="ml-auto text-[10px] text-sentinel-text-dim">{sentMessages.length} messages</span>
              </div>

              {sentMessages.length === 0 ? (
                <div className="py-8 text-center text-sentinel-text-dim text-xs tracking-widest">
                  NO TRANSMISSIONS YET — SEND A MESSAGE
                </div>
              ) : (
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  <AnimatePresence mode="popLayout">
                    {sentMessages.map((msg) => (
                      <motion.div
                        key={msg.id}
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className={cn(
                          "rounded border p-3 text-[10px]",
                          msg.threat_flag
                            ? "border-sentinel-red/40 bg-sentinel-red/5"
                            : "border-sentinel-green/20 bg-sentinel-green/5"
                        )}
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            {msg.threat_flag ? (
                              <ShieldAlert size={14} className="text-sentinel-red" />
                            ) : (
                              <ShieldCheck size={14} className="text-sentinel-green" />
                            )}
                            <span className={cn("font-bold", msg.threat_flag ? "text-sentinel-red" : "text-sentinel-green")}>
                              {msg.threat_flag ? "INTERCEPTED" : "CLEAR"}
                            </span>
                            <SeverityBadge severity={msg.severity ?? computeSeverity(msg.match_count)} />
                          </div>
                          <span className="text-sentinel-text-dim text-[9px]">{relativeTime(msg.timestamp)}</span>
                        </div>

                        <div className="flex items-center gap-3 text-[9px]">
                          <span className="text-sentinel-teal">[{msg.unit_id}]</span>
                          <span className="text-sentinel-text-dim break-all flex-1">{formatEncryptedPreview(msg.encrypted_payload)}</span>
                          <span className="text-sentinel-amber shrink-0">{msg.match_count} HITS</span>
                        </div>

                        <div className="flex items-center gap-1 mt-1">
                          <p className="text-[8px] text-sentinel-text-dim">ID: {msg.id}</p>
                          <CopyButton text={msg.id} label="Copy message ID" />
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-sentinel-border mt-8 py-4 px-4">
        <div className="max-w-screen-2xl mx-auto text-center text-[9px] text-sentinel-text-dim tracking-widest">
          PROJECT SENTINEL — HEALTHCARE COMMAND CENTER
        </div>
      </footer>
    </div>
  );
}
