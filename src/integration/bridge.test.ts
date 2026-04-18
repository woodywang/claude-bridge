import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import WebSocket from 'ws';
import {
  initCrypto,
  generateKeypair,
  computeSharedSecret,
  encrypt,
  decrypt,
  fingerprint,
} from '../shared/crypto.js';
import {
  serializeMessage,
  deserializeMessage,
  createBridgeMessage,
  type BridgeMessage,
} from '../shared/protocol.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORKER_PORT = 8788;
const WORKER_URL = `http://localhost:${WORKER_PORT}`;
const WS_BASE = `ws://localhost:${WORKER_PORT}`;
const WRANGLER_STARTUP_TIMEOUT = 30_000;
const TEST_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createRoom(): Promise<string> {
  const res = await fetch(`${WORKER_URL}/room/create`, { method: 'POST' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { code: string };
  expect(body.code).toMatch(/^[A-Z0-9]{6}$/);
  return body.code;
}

function connectWs(code: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/room/${code}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
    // Timeout after 5s
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket connection timed out'));
    }, 5000);
    ws.on('open', () => clearTimeout(timer));
  });
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error('waitForMessage timed out'));
    }, timeoutMs);

    function handler(data: WebSocket.Data) {
      try {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if (predicate(parsed)) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(parsed);
        }
      } catch {
        // ignore parse errors, keep waiting
      }
    }

    ws.on('message', handler);
  });
}

function collectMessages(ws: WebSocket): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  ws.on('message', (data: WebSocket.Data) => {
    try {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch {
      // ignore
    }
  });
  return messages;
}

function sendRelay(ws: WebSocket, payload: unknown): void {
  ws.send(JSON.stringify({ type: 'relay', payload }));
}

function sendEncryptedMultiParty(
  ws: WebSocket,
  msg: BridgeMessage,
  sharedSecret: Uint8Array,
  fromFp: string,
  toFp: string,
): void {
  const serialized = serializeMessage(msg);
  const encrypted = encrypt(serialized, sharedSecret);
  const b64 = Buffer.from(encrypted).toString('base64');
  sendRelay(ws, {
    dataType: 'encrypted',
    from: fromFp,
    recipients: { [toFp]: b64 },
  });
}

async function doRegister(
  wsA: WebSocket,
  wsB: WebSocket,
  kpA: { publicKey: Uint8Array; privateKey: Uint8Array },
  kpB: { publicKey: Uint8Array; privateKey: Uint8Array },
): Promise<{ secretA: Uint8Array; secretB: Uint8Array; fpA: string; fpB: string }> {
  const fpA = fingerprint(kpA.publicKey);
  const fpB = fingerprint(kpB.publicKey);

  // A registers first and gets the members list back
  const aReceivesMembers = waitForMessage(wsA, (msg) => msg.type === 'members');
  wsA.send(JSON.stringify({
    type: 'register',
    fingerprint: fpA,
    publicKey: Buffer.from(kpA.publicKey).toString('base64'),
    name: 'clientA',
  }));
  await aReceivesMembers;

  // B registers — gets members list (including A), and A gets member_joined
  const bReceivesMembers = waitForMessage(wsB, (msg) => msg.type === 'members');
  const aReceivesJoined = waitForMessage(wsA, (msg) => msg.type === 'member_joined');
  wsB.send(JSON.stringify({
    type: 'register',
    fingerprint: fpB,
    publicKey: Buffer.from(kpB.publicKey).toString('base64'),
    name: 'clientB',
  }));
  const bMembersMsg = await bReceivesMembers;
  await aReceivesJoined;

  // B's members list should contain A's public key
  const bMembers = bMembersMsg.members as Array<{ fingerprint: string; publicKey: string }>;
  const aMemberInB = bMembers.find((m) => m.fingerprint === fpA);
  const pubKeyFromA = new Uint8Array(Buffer.from(aMemberInB!.publicKey, 'base64'));

  // A received member_joined for B — extract B's public key from it
  // (A already has B's key from the member_joined notification)
  // For computing shared secrets, we use the keypair directly
  const secretA = computeSharedSecret(kpB.publicKey, kpA.privateKey);
  const secretB = computeSharedSecret(pubKeyFromA, kpB.privateKey);

  return { secretA, secretB, fpA, fpB };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Bridge Integration Tests', () => {
  let wranglerProcess: ChildProcess;

  beforeAll(async () => {
    // Initialize libsodium
    await initCrypto();

    // Start wrangler dev
    wranglerProcess = spawn(
      'npx',
      ['wrangler', 'dev', '--port', String(WORKER_PORT), '--log-level', 'error'],
      {
        cwd: '/Users/woody/Projects/claude-bridge/.worktrees/feat-implement',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      },
    );

    // Collect stderr for debugging
    let stderrOutput = '';
    wranglerProcess.stderr?.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
    });

    wranglerProcess.stdout?.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
    });

    // Wait for wrangler to be ready by polling the health endpoint
    const startTime = Date.now();
    let ready = false;
    while (Date.now() - startTime < WRANGLER_STARTUP_TIMEOUT) {
      try {
        const res = await fetch(`${WORKER_URL}/`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {
        // Not ready yet
      }
      await sleep(500);
    }

    if (!ready) {
      console.error('Wrangler stderr:', stderrOutput);
      throw new Error(
        `Wrangler dev did not become ready within ${WRANGLER_STARTUP_TIMEOUT}ms`,
      );
    }
  }, WRANGLER_STARTUP_TIMEOUT + 5000);

  afterAll(async () => {
    if (wranglerProcess) {
      // Kill the wrangler process tree
      wranglerProcess.kill('SIGTERM');
      // Give it a moment to clean up, then force kill
      await sleep(1000);
      try {
        wranglerProcess.kill('SIGKILL');
      } catch {
        // Already exited
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test 1: Room creation and joining
  // -----------------------------------------------------------------------
  it(
    'should create a room and allow two WebSocket clients to connect',
    async () => {
      const code = await createRoom();

      const wsA = await connectWs(code);
      const wsB = await connectWs(code);

      expect(wsA.readyState).toBe(WebSocket.OPEN);
      expect(wsB.readyState).toBe(WebSocket.OPEN);

      wsA.close();
      wsB.close();
    },
    TEST_TIMEOUT,
  );

  // -----------------------------------------------------------------------
  // Test 2: Key exchange completes successfully
  // -----------------------------------------------------------------------
  it(
    'should complete registration and derive matching shared secrets',
    async () => {
      const code = await createRoom();
      const wsA = await connectWs(code);
      const wsB = await connectWs(code);

      const kpA = generateKeypair();
      const kpB = generateKeypair();

      const { secretA, secretB } = await doRegister(wsA, wsB, kpA, kpB);

      // Both sides should compute the same shared secret
      expect(Buffer.from(secretA).toString('hex')).toBe(
        Buffer.from(secretB).toString('hex'),
      );

      wsA.close();
      wsB.close();
    },
    TEST_TIMEOUT,
  );

  // -----------------------------------------------------------------------
  // Test 3: Encrypted message send/receive round-trip (multi-party format)
  // -----------------------------------------------------------------------
  it(
    'should encrypt, send, receive, and decrypt messages in both directions',
    async () => {
      const code = await createRoom();
      const wsA = await connectWs(code);
      const wsB = await connectWs(code);

      const kpA = generateKeypair();
      const kpB = generateKeypair();
      const { secretA, secretB, fpA, fpB } = await doRegister(wsA, wsB, kpA, kpB);

      // Side A sends a chat message to side B using multi-party envelope
      const chatMsg = createBridgeMessage('chat', fpA, {
        title: 'Greeting',
        body: 'Hello from A!',
      });

      const bReceives = waitForMessage(wsB, (msg) => msg.type === 'relay');
      sendEncryptedMultiParty(wsA, chatMsg, secretA, fpA, fpB);

      const received = await bReceives;
      const recvPayload = received.payload as Record<string, unknown>;
      expect(recvPayload.from).toBe(fpA);
      expect(recvPayload.dataType).toBe('encrypted');
      const recipients = recvPayload.recipients as Record<string, string>;
      const blob = recipients[fpB];
      expect(blob).toBeTruthy();

      const encryptedBytes = new Uint8Array(Buffer.from(blob, 'base64'));
      const decrypted = decrypt(encryptedBytes, secretB);
      const decoded = deserializeMessage(decrypted);

      expect(decoded.type).toBe('chat');
      expect(decoded.from).toBe(fpA);
      expect((decoded.payload as { title: string; body: string }).title).toBe('Greeting');
      expect((decoded.payload as { title: string; body: string }).body).toBe('Hello from A!');

      // Round-trip: side B sends back to side A
      const replyMsg = createBridgeMessage('chat', fpB, {
        title: 'Re: Greeting',
        body: 'Hello from B!',
        replyTo: chatMsg.id,
      });

      const aReceives = waitForMessage(wsA, (msg) => msg.type === 'relay');
      sendEncryptedMultiParty(wsB, replyMsg, secretB, fpB, fpA);

      const receivedReply = await aReceives;
      const replyPayload = receivedReply.payload as Record<string, unknown>;
      const replyRecipients = replyPayload.recipients as Record<string, string>;
      const replyBlob = replyRecipients[fpA];
      expect(replyBlob).toBeTruthy();

      const replyEncrypted = new Uint8Array(Buffer.from(replyBlob, 'base64'));
      const replyDecrypted = decrypt(replyEncrypted, secretA);
      const replyDecoded = deserializeMessage(replyDecrypted);

      expect(replyDecoded.type).toBe('chat');
      expect(replyDecoded.from).toBe(fpB);
      expect((replyDecoded.payload as { title: string; body: string; replyTo?: string }).body).toBe(
        'Hello from B!',
      );
      expect(
        (replyDecoded.payload as { title: string; body: string; replyTo?: string }).replyTo,
      ).toBe(chatMsg.id);

      wsA.close();
      wsB.close();
    },
    TEST_TIMEOUT,
  );

  // -----------------------------------------------------------------------
  // Test 4: Task dispatch flow (multi-party format)
  // -----------------------------------------------------------------------
  it(
    'should handle task dispatch and result acknowledgement',
    async () => {
      const code = await createRoom();
      const wsA = await connectWs(code);
      const wsB = await connectWs(code);

      const kpA = generateKeypair();
      const kpB = generateKeypair();
      const { secretA, secretB, fpA, fpB } = await doRegister(wsA, wsB, kpA, kpB);

      // Side A sends a task to side B
      const taskMsg = createBridgeMessage('task', fpA, {
        description: 'Refactor the widget module',
        context: 'The widget module has grown too large',
        priority: 'high' as const,
      });

      const bReceivesTask = waitForMessage(wsB, (msg) => msg.type === 'relay');
      sendEncryptedMultiParty(wsA, taskMsg, secretA, fpA, fpB);

      const received = await bReceivesTask;
      const recvPayload = received.payload as Record<string, unknown>;
      const recvRecipients = recvPayload.recipients as Record<string, string>;
      const taskBlob = recvRecipients[fpB];
      const decrypted = deserializeMessage(
        decrypt(
          new Uint8Array(Buffer.from(taskBlob, 'base64')),
          secretB,
        ),
      );

      expect(decrypted.type).toBe('task');
      expect((decrypted.payload as { description: string }).description).toBe(
        'Refactor the widget module',
      );

      // Side B sends ack result back to side A
      const ackMsg = createBridgeMessage('result', fpB, {
        taskId: taskMsg.id,
        status: 'ack' as const,
        summary: 'Task received, starting work',
      });

      const aReceivesAck = waitForMessage(wsA, (msg) => msg.type === 'relay');
      sendEncryptedMultiParty(wsB, ackMsg, secretB, fpB, fpA);

      const ackReceived = await aReceivesAck;
      const ackPayload = ackReceived.payload as Record<string, unknown>;
      const ackRecipients = ackPayload.recipients as Record<string, string>;
      const ackBlob = ackRecipients[fpA];
      const ackDecrypted = deserializeMessage(
        decrypt(
          new Uint8Array(Buffer.from(ackBlob, 'base64')),
          secretA,
        ),
      );

      expect(ackDecrypted.type).toBe('result');
      expect(
        (ackDecrypted.payload as { taskId: string; status: string }).taskId,
      ).toBe(taskMsg.id);
      expect(
        (ackDecrypted.payload as { taskId: string; status: string }).status,
      ).toBe('ack');

      wsA.close();
      wsB.close();
    },
    TEST_TIMEOUT,
  );

  // -----------------------------------------------------------------------
  // Test 5: Sync replay after reconnection (multi-party format)
  // -----------------------------------------------------------------------
  it(
    'should replay missed messages after reconnection via sync',
    async () => {
      const code = await createRoom();
      const wsA = await connectWs(code);
      const wsB = await connectWs(code);

      const kpA = generateKeypair();
      const kpB = generateKeypair();
      const { secretA, secretB, fpA, fpB } = await doRegister(wsA, wsB, kpA, kpB);

      // Side A sends a message while B is connected
      const msg1 = createBridgeMessage('chat', fpA, { title: 'First', body: 'Message 1' });
      const bReceivesMsg1 = waitForMessage(wsB, (msg) => msg.type === 'relay');
      sendEncryptedMultiParty(wsA, msg1, secretA, fpA, fpB);

      const received1 = await bReceivesMsg1;
      const lastSeenId = received1.seqId as string;
      expect(lastSeenId).toBeTruthy();

      // Side B disconnects
      wsB.close();
      await sleep(500); // Give time for close to propagate

      // Side A sends another message while B is offline (multi-party format)
      const msg2 = createBridgeMessage('chat', fpA, { title: 'Second', body: 'Message 2 (while B offline)' });
      const serialized2 = serializeMessage(msg2);
      const encrypted2 = encrypt(serialized2, secretA);
      const b64_2 = Buffer.from(encrypted2).toString('base64');
      sendRelay(wsA, {
        dataType: 'encrypted',
        from: fpA,
        recipients: { [fpB]: b64_2 },
      });

      await sleep(200); // Give time for the message to be stored

      // Side B reconnects
      const wsB2 = await connectWs(code);

      // Side B sends sync with lastSeenId
      const replayedMessages: Record<string, unknown>[] = collectMessages(wsB2);
      wsB2.send(JSON.stringify({ type: 'sync', lastSeenId }));

      // Wait for replay messages to arrive
      await sleep(1000);

      // Should have received the missed message (msg2)
      const relayMessages = replayedMessages.filter((m) => m.type === 'relay');
      expect(relayMessages.length).toBeGreaterThanOrEqual(1);

      // Decrypt and verify the missed message using multi-party format
      const missedRelay = relayMessages[relayMessages.length - 1];
      const missedPayload = missedRelay.payload as Record<string, unknown>;
      const missedRecipients = missedPayload.recipients as Record<string, string>;
      const missedBlob = missedRecipients[fpB];
      const missedDecrypted = deserializeMessage(
        decrypt(
          new Uint8Array(Buffer.from(missedBlob, 'base64')),
          secretB,
        ),
      );

      expect(missedDecrypted.type).toBe('chat');
      expect((missedDecrypted.payload as { title: string; body: string }).body).toBe(
        'Message 2 (while B offline)',
      );

      wsA.close();
      wsB2.close();
    },
    TEST_TIMEOUT,
  );

  // -----------------------------------------------------------------------
  // Test 6: Multi-party — three clients register and see each other
  // -----------------------------------------------------------------------
  it(
    'should allow three clients to register and see each other via members list',
    async () => {
      const code = await createRoom();
      const wsA = await connectWs(code);
      const wsB = await connectWs(code);
      const wsC = await connectWs(code);

      const kpA = generateKeypair();
      const kpB = generateKeypair();
      const kpC = generateKeypair();
      const fpA = fingerprint(kpA.publicKey);
      const fpB = fingerprint(kpB.publicKey);
      const fpC = fingerprint(kpC.publicKey);

      // A registers first
      const aMembersPromise = waitForMessage(wsA, (msg) => msg.type === 'members');
      wsA.send(JSON.stringify({
        type: 'register',
        fingerprint: fpA,
        publicKey: Buffer.from(kpA.publicKey).toString('base64'),
        name: 'A',
      }));
      const aMembers = await aMembersPromise;
      expect((aMembers.members as unknown[]).length).toBe(1); // only self

      // B registers — should see A in members list
      const bMembersPromise = waitForMessage(wsB, (msg) => msg.type === 'members');
      wsB.send(JSON.stringify({
        type: 'register',
        fingerprint: fpB,
        publicKey: Buffer.from(kpB.publicKey).toString('base64'),
        name: 'B',
      }));
      const bMembers = await bMembersPromise;
      const bMemberList = bMembers.members as Array<{ fingerprint: string }>;
      expect(bMemberList.length).toBe(2);
      expect(bMemberList.map((m) => m.fingerprint).sort()).toEqual([fpA, fpB].sort());

      // C registers — should see A and B in members list
      const cMembersPromise = waitForMessage(wsC, (msg) => msg.type === 'members');
      wsC.send(JSON.stringify({
        type: 'register',
        fingerprint: fpC,
        publicKey: Buffer.from(kpC.publicKey).toString('base64'),
        name: 'C',
      }));
      const cMembers = await cMembersPromise;
      const cMemberList = cMembers.members as Array<{ fingerprint: string }>;
      expect(cMemberList.length).toBe(3);
      expect(cMemberList.map((m) => m.fingerprint).sort()).toEqual([fpA, fpB, fpC].sort());

      wsA.close();
      wsB.close();
      wsC.close();
    },
    TEST_TIMEOUT,
  );

  // -----------------------------------------------------------------------
  // Test 7: Invalid room code handling
  // -----------------------------------------------------------------------
  it(
    'should handle connection to a non-existent room code',
    async () => {
      // A room code that was never created via /room/create
      // The DO is created on demand based on the code, so the connection
      // succeeds but the room is empty (no peers)
      const fakeCode = 'ZZZZZ1';
      const ws = await connectWs(fakeCode);

      // Connection should succeed (DO created on demand)
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    },
    TEST_TIMEOUT,
  );
});
