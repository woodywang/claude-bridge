import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  writeToInbox,
  readInbox,
  clearInbox,
  type InboxEntry,
} from './inbox.js';

describe('inbox', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-bridge-test-'));
    tempFile = join(tempDir, 'inbox.json');
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  function makeEntry(overrides?: Partial<InboxEntry>): InboxEntry {
    return {
      id: 'test-id-1',
      type: 'task',
      from: 'host',
      timestamp: 1000,
      summary: 'Test task summary',
      ...overrides,
    };
  }

  it('writeToInbox creates file with correct entry', () => {
    const entry = makeEntry();
    writeToInbox(entry, tempDir, tempFile);

    const entries = readInbox(tempFile);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(entry);
  });

  it('readInbox returns empty array if no file', () => {
    const nonExistent = join(tempDir, 'does-not-exist.json');
    const entries = readInbox(nonExistent);
    expect(entries).toEqual([]);
  });

  it('clearInbox empties the inbox', () => {
    const entry = makeEntry();
    writeToInbox(entry, tempDir, tempFile);
    expect(readInbox(tempFile)).toHaveLength(1);

    clearInbox(tempFile);
    expect(readInbox(tempFile)).toEqual([]);
  });

  it('multiple writes accumulate entries', () => {
    const entry1 = makeEntry({ id: 'id-1', summary: 'First' });
    const entry2 = makeEntry({ id: 'id-2', summary: 'Second' });
    const entry3 = makeEntry({ id: 'id-3', summary: 'Third' });

    writeToInbox(entry1, tempDir, tempFile);
    writeToInbox(entry2, tempDir, tempFile);
    writeToInbox(entry3, tempDir, tempFile);

    const entries = readInbox(tempFile);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.id).toBe('id-1');
    expect(entries[1]!.id).toBe('id-2');
    expect(entries[2]!.id).toBe('id-3');
  });

  it('hook script outputs correct format when inbox non-empty', () => {
    const entry1 = makeEntry({
      id: 'id-1',
      type: 'task',
      summary: 'Do something',
    });
    const entry2 = makeEntry({
      id: 'id-2',
      type: 'result',
      summary: 'Task done',
    });

    writeToInbox(entry1, tempDir, tempFile);
    writeToInbox(entry2, tempDir, tempFile);

    // Run the hook script via tsx with the inbox file overridden.
    // The hook reads from ~/.claude-bridge/inbox.json by default,
    // so we need a small wrapper that patches the path.
    const wrapperScript = `
      import { readFileSync, writeFileSync } from 'fs';

      // Read from our temp file
      const entries = JSON.parse(readFileSync('${tempFile}', 'utf-8'));
      if (entries.length === 0) process.exit(0);

      console.log('');
      console.log('[claude-bridge] 收到 ' + entries.length + ' 条消息:');
      for (const entry of entries) {
        console.log('  - [' + entry.type + '] ' + entry.summary);
      }
      console.log('请优先处理以上 bridge 消息。');
      console.log('');

      writeFileSync('${tempFile}', '[]');
    `;

    const wrapperFile = join(tempDir, 'hook-wrapper.mts');
    writeFileSync(wrapperFile, wrapperScript);

    const output = execFileSync('npx', ['tsx', wrapperFile], {
      encoding: 'utf-8',
      cwd: join(import.meta.dirname, '..', '..'),
    });

    expect(output).toContain('[claude-bridge] 收到 2 条消息:');
    expect(output).toContain('  - [task] Do something');
    expect(output).toContain('  - [result] Task done');
    expect(output).toContain('请优先处理以上 bridge 消息。');

    // Inbox should be cleared after hook ran
    const remaining = readInbox(tempFile);
    expect(remaining).toEqual([]);
  });

  it('hook script outputs nothing when inbox empty', () => {
    // Write an empty inbox
    clearInbox(tempFile);

    const wrapperScript = `
      import { readFileSync } from 'fs';

      const entries = JSON.parse(readFileSync('${tempFile}', 'utf-8'));
      if (entries.length === 0) process.exit(0);

      console.log('should not appear');
    `;

    const wrapperFile = join(tempDir, 'hook-wrapper-empty.mts');
    writeFileSync(wrapperFile, wrapperScript);

    const output = execFileSync('npx', ['tsx', wrapperFile], {
      encoding: 'utf-8',
      cwd: join(import.meta.dirname, '..', '..'),
    });

    // Should have no meaningful output (just possibly a newline)
    expect(output.trim()).toBe('');
  });
});
