import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  serializeMessage,
  deserializeMessage,
  serializeControl,
  deserializeControl,
  createBridgeMessage,
  type BridgeMessage,
  type ControlMessage,
  type TaskPayload,
  type ContextPayload,
  type ResultPayload,
  type ChatPayload,
} from './protocol.js';
import { MAX_MESSAGE_SIZE } from './crypto.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  overrides: Partial<BridgeMessage> = {},
): BridgeMessage {
  return {
    id: 'test-uuid-1234',
    protocolVersion: 1,
    type: 'task',
    from: 'fingerprint-abc',
    timestamp: 1700000000000,
    payload: {
      description: 'Do something',
      context: 'Some context',
      priority: 'normal',
    } satisfies TaskPayload,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Data Plane: serialize / deserialize round-trip
// ---------------------------------------------------------------------------

describe('protocol — data plane round-trip', () => {
  it('round-trips a task message', () => {
    const msg = makeMessage({
      type: 'task',
      payload: {
        description: 'Implement feature X',
        context: 'See design doc',
        priority: 'high',
      } satisfies TaskPayload,
    });
    const bytes = serializeMessage(msg);
    const result = deserializeMessage(bytes);
    expect(result).toEqual(msg);
  });

  it('round-trips a context message', () => {
    const msg = makeMessage({
      type: 'context',
      payload: {
        key: 'env',
        value: 'production',
        operation: 'set',
      } satisfies ContextPayload,
    });
    const bytes = serializeMessage(msg);
    const result = deserializeMessage(bytes);
    expect(result).toEqual(msg);
  });

  it('round-trips a result message', () => {
    const msg = makeMessage({
      type: 'result',
      payload: {
        taskId: 'task-123',
        status: 'done',
        summary: 'Completed successfully',
        details: 'All 42 tests pass',
      } satisfies ResultPayload,
    });
    const bytes = serializeMessage(msg);
    const result = deserializeMessage(bytes);
    expect(result).toEqual(msg);
  });

  it('round-trips a result message with optional fields omitted', () => {
    const msg = makeMessage({
      type: 'result',
      payload: {
        taskId: 'task-456',
        status: 'ack',
      } satisfies ResultPayload,
    });
    const bytes = serializeMessage(msg);
    const result = deserializeMessage(bytes);
    expect(result).toEqual(msg);
  });

  it('round-trips a chat message', () => {
    const msg = makeMessage({
      type: 'chat',
      payload: {
        title: 'Hello',
        body: 'Hello from the other side',
        replyTo: 'msg-999',
      } satisfies ChatPayload,
    });
    const bytes = serializeMessage(msg);
    const result = deserializeMessage(bytes);
    expect(result).toEqual(msg);
  });

  it('round-trips a chat message without replyTo', () => {
    const msg = makeMessage({
      type: 'chat',
      payload: {
        title: 'Standalone',
        body: 'Standalone message',
      } satisfies ChatPayload,
    });
    const bytes = serializeMessage(msg);
    const result = deserializeMessage(bytes);
    expect(result).toEqual(msg);
  });
});

// ---------------------------------------------------------------------------
// Data Plane: validation errors
// ---------------------------------------------------------------------------

describe('protocol — data plane validation', () => {
  it('throws on protocol version mismatch', () => {
    const msg = makeMessage();
    (msg as Record<string, unknown>).protocolVersion = 2;
    const bytes = serializeMessage(msg as unknown as BridgeMessage);
    expect(() => deserializeMessage(bytes)).toThrow(/Protocol version mismatch/);
  });

  it('throws on invalid JSON', () => {
    const garbage = new TextEncoder().encode('not json {{{');
    expect(() => deserializeMessage(garbage)).toThrow(/Failed to parse/);
  });

  it('throws on non-object JSON (string)', () => {
    const bytes = new TextEncoder().encode('"just a string"');
    expect(() => deserializeMessage(bytes)).toThrow(/Expected a JSON object/);
  });

  it('throws on non-object JSON (array)', () => {
    const bytes = new TextEncoder().encode('[1, 2, 3]');
    expect(() => deserializeMessage(bytes)).toThrow(/Expected a JSON object/);
  });

  it('throws on non-object JSON (null)', () => {
    const bytes = new TextEncoder().encode('null');
    expect(() => deserializeMessage(bytes)).toThrow(/Expected a JSON object/);
  });

  it('throws when id is missing', () => {
    const msg = makeMessage();
    const raw = JSON.parse(JSON.stringify(msg));
    delete raw.id;
    const bytes = new TextEncoder().encode(JSON.stringify(raw));
    expect(() => deserializeMessage(bytes)).toThrow(/Missing or invalid required field: id/);
  });

  it('throws when type is missing', () => {
    const msg = makeMessage();
    const raw = JSON.parse(JSON.stringify(msg));
    delete raw.type;
    const bytes = new TextEncoder().encode(JSON.stringify(raw));
    expect(() => deserializeMessage(bytes)).toThrow(/Missing or invalid required field: type/);
  });

  it('throws when from is missing', () => {
    const msg = makeMessage();
    const raw = JSON.parse(JSON.stringify(msg));
    delete raw.from;
    const bytes = new TextEncoder().encode(JSON.stringify(raw));
    expect(() => deserializeMessage(bytes)).toThrow(/Missing or invalid required field: from/);
  });

  it('throws when timestamp is missing', () => {
    const msg = makeMessage();
    const raw = JSON.parse(JSON.stringify(msg));
    delete raw.timestamp;
    const bytes = new TextEncoder().encode(JSON.stringify(raw));
    expect(() => deserializeMessage(bytes)).toThrow(
      /Missing or invalid required field: timestamp/,
    );
  });

  it('throws when payload is missing', () => {
    const msg = makeMessage();
    const raw = JSON.parse(JSON.stringify(msg));
    delete raw.payload;
    const bytes = new TextEncoder().encode(JSON.stringify(raw));
    expect(() => deserializeMessage(bytes)).toThrow(
      /Missing or invalid required field: payload/,
    );
  });

  it('throws on invalid message type', () => {
    const msg = makeMessage();
    const raw = JSON.parse(JSON.stringify(msg));
    raw.type = 'invalid_type';
    const bytes = new TextEncoder().encode(JSON.stringify(raw));
    expect(() => deserializeMessage(bytes)).toThrow(/Invalid message type/);
  });
});

// ---------------------------------------------------------------------------
// Data Plane: max size
// ---------------------------------------------------------------------------

describe('protocol — max message size', () => {
  it('allows a message that is exactly MAX_MESSAGE_SIZE bytes', () => {
    // Build a message with a very large payload that serializes to exactly MAX_MESSAGE_SIZE.
    // We overshoot then trim.
    const base = makeMessage({
      type: 'chat',
      payload: { title: 'T', body: '' } satisfies ChatPayload,
    });
    const baseJson = JSON.stringify(base);
    // The body field is "", so we need to fill it to reach MAX_MESSAGE_SIZE.
    // baseJson includes `"body":""`, so adding chars inside the string grows 1:1 in bytes.
    const padding = MAX_MESSAGE_SIZE - new TextEncoder().encode(baseJson).byteLength;
    (base.payload as ChatPayload).body = 'x'.repeat(padding);

    const bytes = serializeMessage(base);
    expect(bytes.byteLength).toBe(MAX_MESSAGE_SIZE);
  });

  it('throws when serialized message exceeds MAX_MESSAGE_SIZE', () => {
    const base = makeMessage({
      type: 'chat',
      payload: { title: 'T', body: '' } satisfies ChatPayload,
    });
    const baseJson = JSON.stringify(base);
    const padding =
      MAX_MESSAGE_SIZE - new TextEncoder().encode(baseJson).byteLength + 1;
    (base.payload as ChatPayload).body = 'x'.repeat(padding);

    expect(() => serializeMessage(base)).toThrow(/exceeds maximum/);
  });
});

// ---------------------------------------------------------------------------
// Control Plane: round-trip
// ---------------------------------------------------------------------------

describe('protocol — control plane round-trip', () => {
  it('round-trips a sync message', () => {
    const msg: ControlMessage = { type: 'sync', lastSeenId: 'msg-42' };
    const json = serializeControl(msg);
    const result = deserializeControl(json);
    expect(result).toEqual(msg);
  });

  it('round-trips a key_exchange message', () => {
    const msg: ControlMessage = {
      type: 'key_exchange',
      publicKey: 'base64encodedkey==',
    };
    const json = serializeControl(msg);
    const result = deserializeControl(json);
    expect(result).toEqual(msg);
  });

  it('round-trips a room_status ready message', () => {
    const msg: ControlMessage = { type: 'room_status', status: 'ready' };
    const json = serializeControl(msg);
    const result = deserializeControl(json);
    expect(result).toEqual(msg);
  });

  it('round-trips a room_status paired message', () => {
    const msg: ControlMessage = { type: 'room_status', status: 'paired' };
    const json = serializeControl(msg);
    const result = deserializeControl(json);
    expect(result).toEqual(msg);
  });

  it('round-trips a room_status closed message', () => {
    const msg: ControlMessage = { type: 'room_status', status: 'closed' };
    const json = serializeControl(msg);
    const result = deserializeControl(json);
    expect(result).toEqual(msg);
  });
});

// ---------------------------------------------------------------------------
// Control Plane: validation errors
// ---------------------------------------------------------------------------

describe('protocol — control plane validation', () => {
  it('throws on invalid JSON', () => {
    expect(() => deserializeControl('not json')).toThrow(/Failed to parse/);
  });

  it('throws on non-object JSON', () => {
    expect(() => deserializeControl('"string"')).toThrow(/Expected a JSON object/);
  });

  it('throws on missing type', () => {
    expect(() => deserializeControl('{}')).toThrow(
      /Missing or invalid required field: type/,
    );
  });

  it('throws on invalid control message type', () => {
    expect(() => deserializeControl('{"type":"unknown"}')).toThrow(
      /Invalid control message type/,
    );
  });

  it('throws when sync is missing lastSeenId', () => {
    expect(() => deserializeControl('{"type":"sync"}')).toThrow(
      /Missing or invalid required field: lastSeenId/,
    );
  });

  it('throws when key_exchange is missing publicKey', () => {
    expect(() => deserializeControl('{"type":"key_exchange"}')).toThrow(
      /Missing or invalid required field: publicKey/,
    );
  });

  it('throws when room_status is missing status', () => {
    expect(() => deserializeControl('{"type":"room_status"}')).toThrow(
      /Missing or invalid required field: status/,
    );
  });

  it('throws on invalid room status value', () => {
    expect(() =>
      deserializeControl('{"type":"room_status","status":"unknown"}'),
    ).toThrow(/Invalid room status/);
  });
});

// ---------------------------------------------------------------------------
// Factory: createBridgeMessage
// ---------------------------------------------------------------------------

describe('protocol — createBridgeMessage factory', () => {
  it('generates a UUID id', () => {
    const msg = createBridgeMessage('task', 'fp-123', {
      description: 'Test',
      context: '',
      priority: 'normal',
    } satisfies TaskPayload);

    // UUID v4 pattern: 8-4-4-4-12 hex chars
    expect(msg.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('sets protocolVersion to PROTOCOL_VERSION', () => {
    const msg = createBridgeMessage('chat', 'fp-abc', {
      title: 'Greeting',
      body: 'hi',
    } satisfies ChatPayload);

    expect(msg.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('sets timestamp to approximately Date.now()', () => {
    const before = Date.now();
    const msg = createBridgeMessage('result', 'fp-xyz', {
      taskId: 't1',
      status: 'ack',
    } satisfies ResultPayload);
    const after = Date.now();

    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });

  it('preserves type, from, and payload', () => {
    const payload: ContextPayload = {
      key: 'config',
      value: '{}',
      operation: 'set',
    };
    const msg = createBridgeMessage('context', 'fp-sender', payload);

    expect(msg.type).toBe('context');
    expect(msg.from).toBe('fp-sender');
    expect(msg.payload).toEqual(payload);
  });

  it('generates unique ids across calls', () => {
    const msg1 = createBridgeMessage('chat', 'fp', { title: 'A', body: 'a' });
    const msg2 = createBridgeMessage('chat', 'fp', { title: 'B', body: 'b' });
    expect(msg1.id).not.toBe(msg2.id);
  });
});

// ---------------------------------------------------------------------------
// PROTOCOL_VERSION constant
// ---------------------------------------------------------------------------

describe('protocol — PROTOCOL_VERSION', () => {
  it('equals 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
