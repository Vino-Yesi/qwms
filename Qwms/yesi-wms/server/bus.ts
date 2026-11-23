/**
 * Realtime event bus.
 *
 * Events are published after their transaction commits (see `tx` in db/index).
 * The in-process emitter serves the embedded build; PostgreSQL LISTEN/NOTIFY
 * fans out to every API instance in a clustered deployment.
 */
import { EventEmitter } from 'node:events';

export type DomainEvent = {
  seq: number;
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  headers: Record<string, unknown>;
  created_at: string;
};

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const seen = new Set<string>();
const order: string[] = [];

/** Idempotent fan-out: an event may arrive both locally and via LISTEN. */
export function publishEvent(event: DomainEvent): void {
  if (seen.has(event.id)) return;
  seen.add(event.id);
  order.push(event.id);
  if (order.length > 5000) {
    const oldest = order.shift();
    if (oldest) seen.delete(oldest);
  }
  emitter.emit('event', event);
}

export function onEvent(handler: (event: DomainEvent) => void): () => void {
  emitter.on('event', handler);
  return () => emitter.off('event', handler);
}
