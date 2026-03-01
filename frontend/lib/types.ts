export interface ChatLogRow {
  id: string;
  unit_id: string;
  timestamp: string;
  encrypted_payload: string;
  threat_flag: boolean;
  match_count: number;
  ngram_hash_sample: string[] | null;
  created_at: string;
  severity?: string;
}

export interface ThreatEvent extends ChatLogRow {
  animating?: boolean;
}

export type SystemStatus = "NOMINAL" | "ELEVATED" | "CRITICAL" | "OFFLINE";

export type SeverityLevel = "CLEAR" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface InterceptionNodeInfo {
  node_id: string;
  match_count: number;
  matched_hashes: string[];
  false_positive_rate: number;
}

export interface ThreatAnalysis {
  is_threat: boolean;
  match_count: number;
  max_false_positive_rate: number;
  hashes_generated: number;
  severity: SeverityLevel;
  intercepting_nodes: InterceptionNodeInfo[];
}

export interface ThreatFeedEntry {
  id: string;
  unit_id: string;
  timestamp: string;
  encrypted_preview: string;
  match_count: number;
  severity: SeverityLevel;
  ngram_hash_sample: string[];
}

export interface ThreatFeedResponse {
  total_intercepted: number;
  total_threats: number;
  threats: ThreatFeedEntry[];
  severity_breakdown: Record<string, number>;
}
