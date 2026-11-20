import { useEffect, useRef, useState } from "react";
import { backoffDelay, type EventEnvelope, type ServerMessage } from "@pass/shared";

export type LinkStatus = "connecting" | "live" | "degraded" | "offline";

export interface RealtimeOptions {
  channels: string[];
  /** Sequence of the snapshot the page already shows. */
  since: number;
  onEvent: (event: EventEnvelope) => void;
  /** Reload the snapshot and return its seq. Called when replay is not possible. */
  onResync: () => Promise<number>;
  onStatus?: (status: LinkStatus) => void;
  onForbidden?: () => void;
}

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

/**
 * One resumable subscription. Reconnects with full jitter backoff (NFR-8),
 * resumes from the last applied seq (NFR-7), and detects dead connections
 * with an application ping.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private lastSeq: number;
  private stopped = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;

  constructor(private readonly o: RealtimeOptions) {
    this.lastSeq = o.since;
  }

  start(): void {
    window.addEventListener("online", this.reconnectNow);
    this.open();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener("online", this.reconnectNow);
    for (const t of this.timers) clearTimeout(t);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  /** A fresh snapshot with a newer seq makes older replays unnecessary. */
  advanceTo(seq: number): void {
    if (seq > this.lastSeq) this.lastSeq = seq;
  }

  private status(s: LinkStatus) {
    this.o.onStatus?.(s);
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private reconnectNow = () => {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.attempt = 0;
    this.open();
  };

  private subscribe() {
    this.ws?.send(
      JSON.stringify({ op: "subscribe", channels: this.o.channels, since: this.lastSeq }),
    );
  }

  private open() {
    if (this.stopped) return;
    this.status(navigator.onLine ? "connecting" : "offline");
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    this.lastMessageAt = Date.now();

    ws.onopen = () => this.subscribe();
    ws.onmessage = (m) => {
      this.lastMessageAt = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return;
      }
      switch (msg.op) {
        case "event":
          if (msg.seq > this.lastSeq) {
            this.lastSeq = msg.seq;
            this.o.onEvent(msg);
          }
          break;
        case "subscribed":
          this.attempt = 0;
          this.status(msg.live ? "live" : "degraded");
          break;
        case "degraded":
          this.status("degraded");
          break;
        case "live":
          this.status("live");
          break;
        case "resync":
          void this.o
            .onResync()
            .then((seq) => {
              this.lastSeq = seq;
              this.subscribe();
            })
            .catch(() => ws.close());
          break;
        case "draining":
          this.attempt = 0;
          ws.onclose = null;
          ws.close();
          this.status("connecting");
          this.later(() => this.open(), msg.reconnectInMs);
          break;
        case "error":
          if (msg.code === "forbidden") {
            this.stopped = true;
            this.o.onForbidden?.();
          }
          break;
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return;
      this.status(navigator.onLine ? "connecting" : "offline");
      this.later(() => this.open(), backoffDelay(this.attempt++));
    };

    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastMessageAt > 45_000) {
        ws.close(); // Silent connection: assume it is dead and reconnect.
        return;
      }
      ws.send(JSON.stringify({ op: "ping" }));
    }, 20_000);
  }
}

/** Ticks every `ms` so ages and clocks re-render. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Keeps the latest value in a ref, so long-lived callbacks never read stale state. */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
