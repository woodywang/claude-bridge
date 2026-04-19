#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_WORKER_URL = 'https://claude-bridge.woodywang2013.workers.dev';

function validateCode(code: string): void {
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    console.error(
      `Invalid room code: "${code}". Must be 6 uppercase alphanumeric characters.`,
    );
    process.exit(1);
  }
}

function installMcp(opts: {
  role: string;
  code: string;
  secret: string;
  name: string;
  workerUrl: string;
}): void {
  // Resolve paths relative to this CLI script
  const mcpEntryPath = resolve(__dirname, 'mcp', 'index.js');
  const hookEntryPath = resolve(__dirname, 'hooks', 'check-inbox.js');
  const statusLinePath = resolve(__dirname, '..', 'bin', 'bridge-status-line.sh');
  const projectDir = process.cwd();

  // --- Write .mcp.json ---
  const mcpConfigPath = resolve(process.cwd(), '.mcp.json');
  let mcpConfig: Record<string, unknown> = {};

  if (existsSync(mcpConfigPath)) {
    try {
      mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    } catch {
      // Start fresh if parse fails
    }
  }

  const mcpServers = (mcpConfig.mcpServers as Record<string, unknown>) ?? {};
  mcpServers['claude-bridge'] = {
    type: 'stdio',
    command: 'node',
    args: [mcpEntryPath],
    env: {
      BRIDGE_ROLE: opts.role,
      BRIDGE_CODE: opts.code,
      BRIDGE_NAME: opts.name,
      BRIDGE_SECRET: opts.secret,
      BRIDGE_WORKER_URL: opts.workerUrl,
      BRIDGE_PROJECT_DIR: projectDir,
    },
  };
  mcpConfig.mcpServers = mcpServers;

  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');
  console.log(`Wrote MCP config to ${mcpConfigPath}`);

  // --- Write .claude/settings.json with hook ---
  const claudeDir = resolve(process.cwd(), '.claude');
  const settingsPath = resolve(claudeDir, 'settings.json');

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      // Start fresh if parse fails
    }
  }

  const hooks = (settings.hooks as Record<string, unknown>) ?? {};
  hooks['UserPromptSubmit'] = [
    {
      matcher: '',
      hooks: [
        {
          type: 'command',
          command: `node ${hookEntryPath}`,
        },
      ],
    },
  ];
  settings.hooks = hooks;

  // Status line: show unread message count
  settings.statusLine = {
    type: 'command',
    command: `bash ${statusLinePath} ${projectDir}`,
    refreshInterval: 10,
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Wrote hook + status line config to ${settingsPath}`);

  // --- Pre-create counts.json for status line ---
  const bridgeDir = resolve(process.cwd(), '.claude-bridge');
  if (!existsSync(bridgeDir)) {
    mkdirSync(bridgeDir, { recursive: true });
  }
  const countsPath = resolve(bridgeDir, 'counts.json');
  if (!existsSync(countsPath)) {
    writeFileSync(countsPath, '{"unreadChat":0,"pendingTasks":0,"total":0}');
  }
  console.log(`Initialized counts file at ${countsPath}`);
}

const program = new Command();

program
  .name('claude-bridge')
  .description('E2E encrypted cross-machine Claude Code collaboration tool')
  .version('0.1.0');

// ---------------------------------------------------------------------------
// host <code> — room creator installs MCP on their machine
// ---------------------------------------------------------------------------
program
  .command('host <code>')
  .description('Install MCP server as room host (create room on web dashboard first)')
  .requiredOption('--secret <secret>', 'Room join secret (from web dashboard)')
  .requiredOption('--name <name>', 'Display name / alias for this instance')
  .option('--worker-url <url>', 'Worker URL', DEFAULT_WORKER_URL)
  .action((code: string, opts: { secret: string; name: string; workerUrl: string }) => {
    validateCode(code);
    installMcp({ role: 'host', code, ...opts });

    console.log('');
    console.log(`Done! Room: ${code}, Name: ${opts.name}, Role: host`);
    console.log('Restart Claude Code to activate the bridge.');
    console.log('');
    console.log('Share with peers:');
    console.log(`  npx claude-bridge join ${code} --secret ${opts.secret} --name <their-alias>`);
  });

// ---------------------------------------------------------------------------
// join <code> — peer joins an existing room
// ---------------------------------------------------------------------------
program
  .command('join <code>')
  .description('Join an existing room and install MCP server')
  .requiredOption('--secret <secret>', 'Room join secret (from room host)')
  .requiredOption('--name <name>', 'Display name / alias for this instance')
  .option('--worker-url <url>', 'Worker URL', DEFAULT_WORKER_URL)
  .action((code: string, opts: { secret: string; name: string; workerUrl: string }) => {
    validateCode(code);
    installMcp({ role: 'peer', code, ...opts });

    console.log('');
    console.log(`Done! Room: ${code}, Name: ${opts.name}, Role: peer`);
    console.log('Restart Claude Code to activate the bridge.');
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
program
  .command('status')
  .description('Display bridge connection status')
  .action(() => {
    const statusPath = join(homedir(), '.claude-bridge', 'status.json');

    if (!existsSync(statusPath)) {
      console.log('No bridge status found. Bridge has not been started yet.');
      return;
    }

    try {
      const raw = readFileSync(statusPath, 'utf-8');
      const status = JSON.parse(raw) as {
        role?: string;
        roomCode?: string;
        connected?: boolean;
        keyExchangeDone?: boolean;
        pendingMessages?: number;
      };

      console.log('Bridge Status:');
      console.log(`  Role:            ${status.role ?? 'unknown'}`);
      console.log(`  Room Code:       ${status.roomCode ?? 'unknown'}`);
      console.log(
        `  Connection:      ${status.connected ? 'connected' : 'disconnected'}`,
      );
      console.log(
        `  Key Exchange:    ${status.keyExchangeDone ? 'done' : 'pending'}`,
      );
      console.log(
        `  Pending Messages: ${status.pendingMessages ?? 0}`,
      );
    } catch (err) {
      console.error(
        `Failed to read status file: ${(err as Error).message}`,
      );
      process.exit(1);
    }
  });

program.parse();
