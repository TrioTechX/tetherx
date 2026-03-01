"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ThreatAnalysis } from "@/lib/types";

// ─────────────────────────────────────────────────────────────────────────────
// Message types mirroring the backend broadcast schema
// ─────────────────────────────────────────────────────────────────────────────

export interface WsConnectedMessage {
  type: "CONNECTED";
  client_id: string;
  role: string;
  message: string;
  connected_clients: number;
  receiver_count: number;
  sender_count: number;
}

export interface WsStatusMessage {
  type: "STATUS";
  connected_clients: number;
  receiver_count: number;
  sender_count: number;
}

export interface WsHeartbeatMessage {
  type: "HEARTBEAT";
  ts: string;
  connected_clients: number;
  receiver_count: number;
  sender_count: number;
}

export interface WsIngestMessage {
  type: "INGEST";
  log_id: string;
  unit_id: string;
  timestamp: string;
  encrypted_payload_full: string;
  threat_analysis: ThreatAnalysis;
  ngram_hash_sample: string[];
  database_persisted: boolean;
}

export type WsMessage =
  | WsConnectedMessage
  | WsStatusMessage
  | WsHeartbeatMessage
  | WsIngestMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Utility — derive ws:// or wss:// URL from the API base URL
// ─────────────────────────────────────────────────────────────────────────────

export function getWsUrl(apiUrl: string, role: "sender" | "receiver"): string {
  const base = apiUrl.replace(/^http/, (m) => (m === "https" ? "wss" : "ws"));
  return `${base}/api/ws?role=${role}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

interface UseWebSocketOptions {
  apiUrl: string;
  role: "sender" | "receiver";
  onMessage: (msg: WsMessage) => void;
  enabled?: boolean;
}

export interface WebSocketState {
  connected: boolean;
  receiverCount: number;
  senderCount: number;
  totalClients: number;
}

export function useWebSocket({
  apiUrl,
  role,
  onMessage,
  enabled = true,
}: UseWebSocketOptions): WebSocketState {
  const [connected, setConnected] = useState(false);
  const [receiverCount, setReceiverCount] = useState(0);
  const [senderCount, setSenderCount] = useState(0);
  const [totalClients, setTotalClients] = useState(0);

  // Use a ref so onMessage changes never restart the connection
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  });

  const mountedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(1500); // ms, doubles on each failed attempt
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPing = () => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  };

  const scheduleReconnect = useCallback((connectFn: () => void) => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    const delay = backoffRef.current;
    backoffRef.current = Math.min(delay * 1.8, 30_000);
    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current) connectFn();
    }, delay);
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current || !enabled) return;

    const url = getWsUrl(apiUrl, role);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect(connect);
      return;
    }

    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      setConnected(true);
      backoffRef.current = 1500; // reset backoff on success

      // Send ping every 18 s to keep the connection alive through proxies
      clearPing();
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 18_000);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      if (!mountedRef.current) return;
      let msg: WsMessage;
      try {
        msg = JSON.parse(event.data) as WsMessage;
      } catch {
        return;
      }

      // Sync presence counts from any message that carries them
      // (CONNECTED, STATUS, and HEARTBEAT all now carry these)
      const m = msg as unknown as Record<string, unknown>;
      if (typeof m.receiver_count === "number") setReceiverCount(m.receiver_count as number);
      if (typeof m.sender_count === "number") setSenderCount(m.sender_count as number);
      if (typeof m.connected_clients === "number") setTotalClients(m.connected_clients as number);

      // Forward non-heartbeat messages to the caller
      if (msg.type !== "HEARTBEAT") {
        onMessageRef.current(msg);
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      clearPing();
      wsRef.current = null;
      scheduleReconnect(connect);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [apiUrl, role, enabled, scheduleReconnect]);

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) connect();

    return () => {
      mountedRef.current = false;
      clearPing();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close(1000, "component unmounted");
        wsRef.current = null;
      }
    };
    // connect is memoised; apiUrl/role/enabled changes re-create it cleanly
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect]);

  return { connected, receiverCount, senderCount, totalClients };
}
