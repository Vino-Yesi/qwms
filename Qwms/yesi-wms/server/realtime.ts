/**
 * Authenticated realtime channel.
 *
 * A single-use 30-second ticket (issued over the session-authenticated REST
 * API) authenticates the upgrade. Clients then receive a sequence-numbered
 * event stream, replayed from their last cursor, filtered by role. The client
 * treats a gap or `resync` as a signal to refetch the REST snapshot, so a lost
 * socket can never leave stale state behind.
 */
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { consumeWsTicket } from './auth.js';
import { db, many } from './db/index.js';
import { onEvent, type DomainEvent } from './bus.js';
import { config, can, type Role } from './config.js';
import { metrics } from './metrics.js';

const MAX_BUFFER = 2 * 1024 * 1024;
const REPLAY_LIMIT = 500;

export function eventVisible(topic: string, role: string): boolean {
  if (topic.startsWith('finance.') || topic.startsWith('erp.')) return role === 'admin' || role === 'finance';
  if (topic.startsWith('audit.')) return role === 'admin';
  return can(role, 'read');
}

type ClientState = { ws: WebSocket; role: Role; userId: string; alive: boolean; cursor: number };

export function attachRealtime(app: FastifyInstance) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set<ClientState>();

  const send = (client: ClientState, message: unknown) => {
    if (client.ws.readyState !== client.ws.OPEN) return;
    if (client.ws.bufferedAmount > MAX_BUFFER) {
      client.ws.close(1013, 'backpressure');
      return;
    }
    client.ws.send(JSON.stringify(message));
    metrics.wsEvents.inc();
  };

  const unsubscribe = onEvent((event: DomainEvent) => {
    for (const client of clients) {
      if (!eventVisible(event.topic, client.role)) continue;
      client.cursor = Math.max(client.cursor, event.seq);
      send(client, {
        type: 'event',
        seq: event.seq,
        id: event.id,
        topic: event.topic,
        aggregate_type: event.aggregate_type,
        aggregate_id: event.aggregate_id,
        payload: event.payload,
        created_at: event.created_at,
      });
    }
  });

  app.server.on('upgrade', (request, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(request.url || '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    if (origin && config.appOrigin && origin !== config.appOrigin) {
      try {
        const incoming = new URL(origin);
        const expected = new URL(config.appOrigin);
        if (incoming.host !== expected.host && !(config.development && /\.e2b\.app$/.test(incoming.hostname))) {
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (ws: WebSocket) => {
    let state: ClientState | null = null;
    const timer = setTimeout(() => {
      if (!state) ws.close(4001, 'authentication timeout');
    }, 5_000);

    ws.on('message', async (raw) => {
      let message: any;
      try {
        message = JSON.parse(String(raw));
      } catch {
        ws.close(4002, 'invalid message');
        return;
      }
      if (!state) {
        if (message.type !== 'authenticate' || typeof message.ticket !== 'string') {
          ws.close(4001, 'ticket required');
          return;
        }
        clearTimeout(timer);
        const identity = await consumeWsTicket(message.ticket);
        if (!identity) {
          ws.close(4001, 'invalid ticket');
          return;
        }
        const lastSeq = Number.isInteger(message.last_seq) ? Math.max(0, message.last_seq) : 0;
        state = { ws, role: identity.role as Role, userId: identity.user_id, alive: true, cursor: lastSeq };
        clients.add(state);
        metrics.wsConnections.set(clients.size);

        const head = await many<{ seq: number }>(db, 'SELECT coalesce(max(seq),0)::int AS seq FROM outbox');
        const sequence = Number(head[0]?.seq || 0);
        if (sequence - lastSeq > REPLAY_LIMIT) {
          send(state, { type: 'resync', sequence });
        } else {
          const replay = await many<any>(
            db,
            `SELECT seq, id, topic, aggregate_type, aggregate_id, payload, created_at
             FROM outbox WHERE seq > $1 ORDER BY seq LIMIT ${REPLAY_LIMIT}`,
            [lastSeq],
          );
          for (const event of replay) {
            if (!eventVisible(event.topic, identity.role)) continue;
            send(state, {
              type: 'event',
              seq: Number(event.seq),
              id: event.id,
              topic: event.topic,
              aggregate_type: event.aggregate_type,
              aggregate_id: event.aggregate_id,
              payload: event.payload,
              created_at: new Date(event.created_at).toISOString(),
            });
          }
        }
        state.cursor = Math.max(state.cursor, sequence);
        send(state, { type: 'ready', sequence, role: identity.role, user_id: identity.user_id });
        return;
      }
      if (message.type === 'ping') {
        state.alive = true;
        send(state, { type: 'pong', sequence: state.cursor });
      }
    });

    ws.on('pong', () => {
      if (state) state.alive = true;
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (state) {
        clients.delete(state);
        metrics.wsConnections.set(clients.size);
      }
    });

    ws.on('error', () => ws.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate();
        clients.delete(client);
        continue;
      }
      client.alive = false;
      try {
        client.ws.ping();
      } catch {
        client.ws.terminate();
      }
    }
    metrics.wsConnections.set(clients.size);
  }, 30_000);

  const close = async () => {
    clearInterval(heartbeat);
    unsubscribe();
    for (const client of clients) client.ws.close(1001, 'server shutting down');
    clients.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };

  app.addHook('onClose', close);
  return { clients: () => clients.size, close };
}
