// Writes incoming messages to ~/.claude-bridge/inbox.json for hook pickup
// Read by the UserPromptSubmit hook script

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const INBOX_DIR = join(homedir(), '.claude-bridge');
const INBOX_FILE = join(INBOX_DIR, 'inbox.json');

export interface InboxEntry {
  id: string;
  type: string;
  from: string;
  timestamp: number;
  summary: string; // human-readable summary of the message
}

export function getInboxDir(): string {
  return INBOX_DIR;
}

export function getInboxFile(): string {
  return INBOX_FILE;
}

/**
 * Write to inbox, with optional override paths for testing.
 */
export function writeToInbox(
  entry: InboxEntry,
  inboxDir: string = INBOX_DIR,
  inboxFile: string = INBOX_FILE,
): void {
  mkdirSync(inboxDir, { recursive: true });
  const existing = readInbox(inboxFile);
  existing.push(entry);
  writeFileSync(inboxFile, JSON.stringify(existing, null, 2));
}

export function readInbox(inboxFile: string = INBOX_FILE): InboxEntry[] {
  try {
    return JSON.parse(readFileSync(inboxFile, 'utf-8')) as InboxEntry[];
  } catch {
    return [];
  }
}

export function clearInbox(inboxFile: string = INBOX_FILE): void {
  writeFileSync(inboxFile, '[]');
}

/**
 * Atomically read and clear the inbox using rename.
 * Prevents race condition between hook reader and MCP writer.
 */
export function readAndClearInbox(inboxDir?: string): InboxEntry[] {
  const dir = inboxDir ?? INBOX_DIR;
  const file = join(dir, 'inbox.json');
  const processingFile = join(dir, 'inbox.processing.json');

  try {
    // Atomic rename - prevents race with MCP writer
    renameSync(file, processingFile);
  } catch {
    return []; // No inbox file
  }

  try {
    const entries = JSON.parse(readFileSync(processingFile, 'utf-8'));
    unlinkSync(processingFile);
    return entries;
  } catch {
    try { unlinkSync(processingFile); } catch { /* ignore */ }
    return [];
  }
}
