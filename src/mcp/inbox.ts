// Writes incoming messages to ~/.claude-bridge/inbox.json for hook pickup
// Read by the UserPromptSubmit hook script
// Also writes counts.json to project dir for status line display

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

let dirCreated = false;

export function ensureInboxDir(inboxDir?: string): void {
  if (dirCreated) return;
  mkdirSync(inboxDir ?? INBOX_DIR, { recursive: true });
  dirCreated = true;
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
// ---------------------------------------------------------------------------
// Counts file (written to project dir for status line)
// ---------------------------------------------------------------------------

export interface BridgeCounts {
  unreadChat: number;
  pendingTasks: number;
  total: number;
}

let countsPath: string | null = null;

export function initCounts(projectDir: string): void {
  const dir = join(projectDir, '.claude-bridge');
  mkdirSync(dir, { recursive: true });
  countsPath = join(dir, 'counts.json');
  // Write initial zero counts
  writeCounts({ unreadChat: 0, pendingTasks: 0, total: 0 });
}

export function writeCounts(counts: BridgeCounts): void {
  if (!countsPath) return;
  try {
    writeFileSync(countsPath, JSON.stringify(counts));
  } catch { /* best-effort */ }
}

export function readCounts(projectDir?: string): BridgeCounts {
  const file = projectDir
    ? join(projectDir, '.claude-bridge', 'counts.json')
    : countsPath;
  if (!file) return { unreadChat: 0, pendingTasks: 0, total: 0 };
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as BridgeCounts;
  } catch {
    return { unreadChat: 0, pendingTasks: 0, total: 0 };
  }
}

// ---------------------------------------------------------------------------
// Atomic inbox read+clear
// ---------------------------------------------------------------------------

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
