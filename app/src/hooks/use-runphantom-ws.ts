import { useEffect, useRef, useState } from "react";

type Listener<T = unknown> = (data: T) => void;
type ReplayableMessage = object & { type?: unknown };

interface RunPhantomEnvelope {
  event?: string;
  data?: unknown;
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";

const HANDSHAKE_TIMEOUT_MS = 10_000;

interface Broker {
  ws: WebSocket | null;
  status: ConnectionStatus;
  listeners: Map<string, Set<Listener>>;
  messageListeners: Set<Listener>;
  connectionListeners: Set<(status: ConnectionStatus) => void>;
  replayOnConnect: Map<string, object>;
  subscribe<T>(event: string, fn: Listener<T>): () => void;
  subscribeMessage<T>(fn: Listener<T>): () => void;
  send(msg: object): void;
}

let singleton: Broker | null = null;

function isRunPhantomEnvelope(value: unknown): value is RunPhantomEnvelope {
  return !!value && typeof value === "object";
}

function getBroker(): Broker {
  if (singleton) return singleton;

  const listeners = new Map<string, Set<Listener>>();
  const messageListeners = new Set<Listener>();
  const connectionListeners = new Set<(status: ConnectionStatus) => void>();
  const replayOnConnect = new Map<string, object>();

  const broker: Broker = {
    ws: null,
    status: "connecting",
    listeners,
    messageListeners,
    connectionListeners,
    replayOnConnect,
    subscribe<T>(event: string, fn: Listener<T>) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      const listener: Listener = (data) => fn(data as T);
      listeners.get(event)?.add(listener);
      return () => listeners.get(event)?.delete(listener);
    },
    subscribeMessage<T>(fn: Listener<T>) {
      const listener: Listener = (data) => fn(data as T);
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    send(msg) {
      const type = (msg as ReplayableMessage).type;
      if (typeof type === "string") replayOnConnect.set(type, msg);
      const ws = broker.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(msg));
        } catch {}
      }
    },
  };

  let reconnectTimer: number | null = null;

  function setStatus(status: ConnectionStatus) {
    broker.status = status;
    for (const listener of connectionListeners) listener(status);
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2000);
  }

  function connect() {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
    if (broker.ws) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      setStatus("disconnected");
      scheduleReconnect();
      return;
    }
    broker.ws = ws;
    // Only the first attempt gets a connecting state; retries stay offline until open.
    const handshakeTimer = window.setTimeout(disconnect, HANDSHAKE_TIMEOUT_MS);

    function disconnect() {
      if (broker.ws !== ws) return;
      window.clearTimeout(handshakeTimer);
      broker.ws = null;
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      setStatus("disconnected");
      try {
        ws.close();
      } catch {}
      scheduleReconnect();
    }

    ws.onopen = () => {
      if (broker.ws !== ws) return;
      window.clearTimeout(handshakeTimer);
      setStatus("connected");
      for (const message of replayOnConnect.values()) {
        try {
          ws.send(JSON.stringify(message));
        } catch {}
      }
    };

    ws.onclose = disconnect;
    ws.onerror = disconnect;

    ws.onmessage = (event) => {
      if (broker.ws !== ws) return;
      try {
        const payload: unknown = JSON.parse(event.data);
        for (const listener of messageListeners) listener(payload);
        if (!isRunPhantomEnvelope(payload) || typeof payload.event !== "string") return;
        const handlers = listeners.get(payload.event);
        if (!handlers) return;
        for (const handler of handlers) handler(payload.data);
      } catch {}
    };
  }

  connect();
  singleton = broker;
  return broker;
}

export function useRunPhantomMessage<T = unknown>(handler: Listener<T>) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const broker = getBroker();
    return broker.subscribeMessage<T>((data) => handlerRef.current(data));
  }, []);
}

export function useRunPhantomEvent<T = unknown>(event: string, handler: Listener<T>) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const broker = getBroker();
    return broker.subscribe<T>(event, (data) => handlerRef.current(data));
  }, [event]);
}

export function useRunPhantomConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState(() => getBroker().status);

  useEffect(() => {
    const broker = getBroker();
    broker.connectionListeners.add(setStatus);
    setStatus(broker.status);
    return () => {
      broker.connectionListeners.delete(setStatus);
    };
  }, []);

  return status;
}

export function useRunPhantomConnected(): boolean {
  return useRunPhantomConnectionStatus() === "connected";
}

export function sendRunPhantomMessage(message: object): void {
  getBroker().send(message);
}
