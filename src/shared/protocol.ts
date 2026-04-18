import { randomUUID } from 'crypto';
import { MAX_MESSAGE_SIZE } from './crypto.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Control Plane types (unencrypted, DO can read)
// ---------------------------------------------------------------------------

export type ControlMessage =
  | { type: 'sync'; lastSeenId: string }
  | { type: 'key_exchange'; publicKey: string }
  | { type: 'room_status'; status: 'ready' | 'paired' | 'closed' };

// ---------------------------------------------------------------------------
// Data Plane types (encrypted)
// ---------------------------------------------------------------------------

export type TaskPayload = {
  description: string;
  context: string;
  priority: 'low' | 'normal' | 'high';
};

export type ContextPayload = {
  key: string;
  value: string;
  operation: 'set' | 'append' | 'delete';
};

export type ResultPayload = {
  taskId: string;
  status: 'ack' | 'in_progress' | 'done' | 'failed';
  summary?: string;
  details?: string;
};

export type ChatPayload = {
  title: string;
  body: string;
  replyTo?: string;  // message ID being replied to
};

export type BridgeMessageType = 'task' | 'context' | 'result' | 'chat';

export type BridgeMessage = {
  id: string;
  protocolVersion: 1;
  type: BridgeMessageType;
  from: string;
  timestamp: number;
  payload: TaskPayload | ContextPayload | ResultPayload | ChatPayload;
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_BRIDGE_TYPES = new Set<string>(['task', 'context', 'result', 'chat']);
const VALID_CONTROL_TYPES = new Set<string>(['sync', 'key_exchange', 'room_status']);
const VALID_ROOM_STATUSES = new Set<string>(['ready', 'paired', 'closed']);

function assertIsObject(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
}

function assertString(obj: Record<string, unknown>, field: string): void {
  if (typeof obj[field] !== 'string') {
    throw new Error(`Missing or invalid required field: ${field}`);
  }
}

function assertNumber(obj: Record<string, unknown>, field: string): void {
  if (typeof obj[field] !== 'number') {
    throw new Error(`Missing or invalid required field: ${field}`);
  }
}

function validateBridgeMessage(obj: Record<string, unknown>): void {
  // Protocol version
  if (obj.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `Protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${obj.protocolVersion}`,
    );
  }

  // Required top-level fields
  assertString(obj, 'id');
  assertString(obj, 'type');
  assertString(obj, 'from');
  assertNumber(obj, 'timestamp');

  if (!VALID_BRIDGE_TYPES.has(obj.type as string)) {
    throw new Error(`Invalid message type: ${obj.type}`);
  }

  if (obj.payload === undefined || obj.payload === null || typeof obj.payload !== 'object') {
    throw new Error('Missing or invalid required field: payload');
  }
}

function validateControlMessage(obj: Record<string, unknown>): void {
  assertString(obj, 'type');

  const type = obj.type as string;
  if (!VALID_CONTROL_TYPES.has(type)) {
    throw new Error(`Invalid control message type: ${type}`);
  }

  switch (type) {
    case 'sync':
      assertString(obj, 'lastSeenId');
      break;
    case 'key_exchange':
      assertString(obj, 'publicKey');
      break;
    case 'room_status':
      assertString(obj, 'status');
      if (!VALID_ROOM_STATUSES.has(obj.status as string)) {
        throw new Error(`Invalid room status: ${obj.status}`);
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// Serialization — Data Plane
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Serialize a BridgeMessage to Uint8Array (JSON -> UTF-8 bytes).
 * Throws if the serialized output exceeds MAX_MESSAGE_SIZE.
 */
export function serializeMessage(msg: BridgeMessage): Uint8Array {
  const json = JSON.stringify(msg);
  const bytes = encoder.encode(json);

  if (bytes.byteLength > MAX_MESSAGE_SIZE) {
    throw new Error(
      `Serialized message size ${bytes.byteLength} exceeds maximum ${MAX_MESSAGE_SIZE} bytes`,
    );
  }

  return bytes;
}

/**
 * Deserialize a Uint8Array back into a BridgeMessage.
 * Validates protocol version, required fields, and message type.
 */
export function deserializeMessage(data: Uint8Array): BridgeMessage {
  let json: string;
  try {
    json = decoder.decode(data);
  } catch {
    throw new Error('Failed to decode message bytes as UTF-8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Failed to parse message as JSON');
  }

  assertIsObject(parsed);
  validateBridgeMessage(parsed);

  return parsed as BridgeMessage;
}

// ---------------------------------------------------------------------------
// Serialization — Control Plane
// ---------------------------------------------------------------------------

/**
 * Serialize a ControlMessage to a JSON string.
 */
export function serializeControl(msg: ControlMessage): string {
  return JSON.stringify(msg);
}

/**
 * Deserialize a JSON string into a ControlMessage.
 * Validates type and required fields per control message type.
 */
export function deserializeControl(data: string): ControlMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error('Failed to parse control message as JSON');
  }

  assertIsObject(parsed);
  validateControlMessage(parsed);

  return parsed as ControlMessage;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new BridgeMessage with auto-generated id and timestamp.
 */
export function createBridgeMessage(
  type: BridgeMessageType,
  from: string,
  payload: TaskPayload | ContextPayload | ResultPayload | ChatPayload,
): BridgeMessage {
  return {
    id: randomUUID(),
    protocolVersion: PROTOCOL_VERSION,
    type,
    from,
    timestamp: Date.now(),
    payload,
  };
}
