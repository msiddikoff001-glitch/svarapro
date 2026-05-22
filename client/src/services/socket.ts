/**
 * Socket.IO client.
 *
 * The svarapro backend exposes its real-time API via socket.io (see
 * `server/src/modules/rooms/rooms.gateway.ts` and `game.gateway.ts`).
 * This module is the single entry point the client uses to talk to it.
 *
 * Behaviour:
 *   - `connect(options)`       — establish (or re-establish) the socket.
 *                                `options.token` is the JWT issued by
 *                                `/auth/login`. `options.telegramId` /
 *                                `options.userData` are forwarded in
 *                                the socket.io `auth` payload because
 *                                the legacy GameGateway reads them
 *                                from `client.handshake.auth.telegramId`
 *                                / `userData`.
 *   - `disconnect()`           — tear down the socket.
 *   - `on(event, handler)`     — subscribe; returns an unsubscriber.
 *   - `emit(event, payload)`   — fire-and-forget send; buffers silently
 *                                if the socket isn't connected yet.
 *
 * Reconnection is handled by socket.io itself (default exponential
 * backoff). Connection lifecycle is mirrored into `connectionStore`
 * so React components can show a status badge.
 *
 * When `VITE_SOCKET_URL` is unset, `connect` is a no-op — the lobby
 * still works via REST polling, just without push updates.
 */

import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';

import { CONNECTION_STATUS, useConnectionStore } from '../store/connectionStore';

export interface SocketUserData {
  username: string;
  avatar: string;
}

export interface ConnectSocketOptions {
  token?: string | null;
  /** Telegram user id (string). Required by the GameGateway handshake. */
  telegramId?: string | null;
  /** Cosmetic profile for `sit_down` — forwarded in the handshake. */
  userData?: SocketUserData | null;
}

type SocketHandler<P = unknown> = (payload: P) => void;
type SocketUnsubscribe = () => void;

const SOCKET_URL: string = import.meta.env?.VITE_SOCKET_URL ?? '';

/**
 * Resolve the socket-target URL. When `VITE_SOCKET_URL` is empty (the
 * default in production where nginx proxies `/socket.io/` on the same
 * origin as the static bundle), fall back to `window.location.origin`.
 * Without this, `io('')` would short-circuit and the multiplayer flow
 * (room snapshots + tick updates) would never reach the client.
 */
const resolveSocketUrl = (): string | null => {
  if (SOCKET_URL && SOCKET_URL !== '/') return SOCKET_URL;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return null;
};

let socket: Socket | null = null;
/** Listeners registered before the socket exists are replayed on connect. */
const pendingListeners = new Map<string, Set<SocketHandler>>();

const setStatus = (status: (typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS]): void => {
  useConnectionStore.getState().setStatus(status);
};

const replayPendingListeners = (s: Socket): void => {
  pendingListeners.forEach((handlers, event) => {
    handlers.forEach((handler) => s.on(event, handler));
  });
};

/**
 * Backwards-compatible overload: `connectSocket(token)` keeps working for
 * the Stage-2 lobby bootstrap that didn't pass `telegramId` yet.
 */
export function connectSocket(token: string | null): void;
export function connectSocket(options: ConnectSocketOptions): void;
export function connectSocket(
  arg: string | null | ConnectSocketOptions,
): void {
  const target = resolveSocketUrl();
  if (!target) return;
  if (socket?.connected) return;

  const options: ConnectSocketOptions =
    arg === null || typeof arg === 'string' ? { token: arg } : arg;

  const auth: Record<string, unknown> = {};
  if (options.token) auth.token = options.token;
  if (options.telegramId) auth.telegramId = options.telegramId;
  if (options.userData) auth.userData = options.userData;

  setStatus(CONNECTION_STATUS.connecting);
  socket = io(target, {
    transports: ['websocket'],
    auth: Object.keys(auth).length > 0 ? auth : undefined,
    reconnection: true,
  });

  socket.on('connect', () => setStatus(CONNECTION_STATUS.open));
  socket.on('disconnect', () => setStatus(CONNECTION_STATUS.closed));
  socket.on('connect_error', () => setStatus(CONNECTION_STATUS.closed));

  replayPendingListeners(socket);
}

export const disconnectSocket = (): void => {
  if (!socket) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  setStatus(CONNECTION_STATUS.closed);
};

export const onSocketEvent = <P = unknown>(
  event: string,
  handler: SocketHandler<P>,
): SocketUnsubscribe => {
  const typedHandler = handler as SocketHandler;

  if (socket) {
    socket.on(event, typedHandler);
  }

  // Always track pending so reconnects re-attach the listener.
  const bucket = pendingListeners.get(event) ?? new Set<SocketHandler>();
  bucket.add(typedHandler);
  pendingListeners.set(event, bucket);

  return () => {
    socket?.off(event, typedHandler);
    bucket.delete(typedHandler);
    if (bucket.size === 0) pendingListeners.delete(event);
  };
};

export const emitSocketEvent = <P = unknown>(event: string, payload?: P): void => {
  socket?.emit(event, payload);
};

export const isSocketConnected = (): boolean => Boolean(socket?.connected);

/** Internal helpers exposed for tests only. */
export const __testing__ = {
  resetSocket: (): void => {
    socket?.removeAllListeners();
    socket?.disconnect();
    socket = null;
    pendingListeners.clear();
  },
};
