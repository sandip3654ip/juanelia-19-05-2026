import { useState, useEffect, useRef, useCallback } from "react";

const WS_URL = (() => {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws`;
})();

const RECONNECT_DELAY_MS  = 2_000;
const CONNECT_TIMEOUT_MS  = 8_000; // kill socket stuck in CONNECTING state after 8s

/**
 * Persistent WebSocket connection to /api/ws.
 * Server pushes funding_arb snapshots every 500 ms.
 *
 * Returns:
 *   data        — latest parsed message ({ opportunities, status, ts })
 *   connected   — true when WS is OPEN
 *
 * Note: priceMovements and markets are no longer in the WS payload.
 * Fetch them via REST (/api/scanner/price-movements, /api/markets) on a slower poll.
 */
export function useFundingArbWS() {
  const [data, setData]           = useState(null);
  const [connected, setConnected] = useState(false);
  const wsRef                     = useRef(null);
  const timerRef                  = useRef(null);
  const connectTimerRef           = useRef(null); // timeout for stuck CONNECTING state
  const deadRef                   = useRef(false);

  const connect = useCallback(() => {
    if (deadRef.current) return;

    // If a socket is stuck in CONNECTING (e.g. DNS hang), it will never fire
    // onopen or onclose, leaving the app silently disconnected forever.
    // Kill it and start fresh.
    if (wsRef.current?.readyState === WebSocket.CONNECTING) {
      clearTimeout(connectTimerRef.current);
      const stale = wsRef.current;
      stale.onopen  = null;
      stale.onclose = null; // prevent onclose from scheduling another timer
      stale.onerror = null;
      stale.close();
      wsRef.current = null;
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    // Guard: if the socket doesn't open within CONNECT_TIMEOUT_MS, kill and retry
    connectTimerRef.current = setTimeout(() => {
      if (wsRef.current === ws && ws.readyState === WebSocket.CONNECTING) {
        ws.onclose = null;
        ws.close();
        wsRef.current = null;
        if (!deadRef.current) timerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(connectTimerRef.current);
      setConnected(true);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg && typeof msg === "object" && msg.type === "funding_arb") setData(msg);
      } catch {
        // malformed — ignore
      }
    };

    ws.onerror = () => {};

    ws.onclose = () => {
      clearTimeout(connectTimerRef.current);
      setConnected(false);
      if (!deadRef.current) {
        timerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };
  }, []);

  useEffect(() => {
    deadRef.current = false;
    connect();
    return () => {
      deadRef.current = true;
      clearTimeout(timerRef.current);
      clearTimeout(connectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { data, connected };
}
