#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_WORKER_URL = 'https://claude-bridge.workers.dev';

const program = new Command();

program
  .name('claude-bridge')
  .description('E2E encrypted cross-machine Claude Code collaboration tool')
  .version('0.1.0');

// ---------------------------------------------------------------------------
// host
// ---------------------------------------------------------------------------
program
  .command('host')
  .description('Create a new room and display connection instructions')
  .option('--worker-url <url>', 'Worker URL', DEFAULT_WORKER_URL)
  .action(async (opts: { workerUrl: string }) => {
    const workerUrl = opts.workerUrl;

    console.log('Creating room...');

    try {
      const resp = await fetch(`${workerUrl}/room/create`, { method: 'POST' });
      if (!resp.ok) {
        const text = await resp.text();
        console.error(`Failed to create room: ${resp.status} ${text}`);
        process.exit(1);
      }
      const body = (await resp.json()) as { code: string };
      const code = body.code;

      console.log('');
      console.log(`Room created: ${code}`);
      console.log('');
      console.log('To connect from this machine:');
      console.log(`  claude-bridge mcp-install --role host --code ${code}`);
      console.log('');
      console.log('To connect from the other machine:');
      console.log(`  claude-bridge mcp-install --role peer --code ${code}`);
      console.log('');
      console.log('Then restart Claude Code on both machines.');
    } catch (err) {
      console.error(`Failed to connect to worker: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// join <code>
// ---------------------------------------------------------------------------
program
  .command('join <code>')
  .description('Join an existing room')
  .action((code: string) => {
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      console.error(
        `Invalid room code: "${code}". Must be 6 uppercase alphanumeric characters.`,
      );
      process.exit(1);
    }

    console.log('');
    console.log(`Joining room: ${code}`);
    console.log('');
    console.log('Run:');
    console.log(`  claude-bridge mcp-install --role peer --code ${code}`);
    console.log('');
    console.log('Then restart Claude Code.');
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

// ---------------------------------------------------------------------------
// mcp-install
// ---------------------------------------------------------------------------
program
  .command('mcp-install')
  .description(
    'Register the MCP server in Claude Code settings for the current project',
  )
  .requiredOption('--role <role>', 'Role: host or peer')
  .requiredOption('--code <code>', 'Room code (6-char uppercase alphanumeric)')
  .option('--worker-url <url>', 'Worker URL', DEFAULT_WORKER_URL)
  .action(
    (opts: { role: string; code: string; workerUrl: string }) => {
      // Validate role
      if (opts.role !== 'host' && opts.role !== 'peer') {
        console.error(
          `Invalid role: "${opts.role}". Must be "host" or "peer".`,
        );
        process.exit(1);
      }

      // Validate code
      if (!/^[A-Z0-9]{6}$/.test(opts.code)) {
        console.error(
          `Invalid room code: "${opts.code}". Must be 6 uppercase alphanumeric characters.`,
        );
        process.exit(1);
      }

      // Resolve path to dist/mcp/index.js relative to this CLI script
      const mcpEntryPath = resolve(__dirname, 'mcp', 'index.js');
      const hookEntryPath = resolve(__dirname, 'hooks', 'check-inbox.js');

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
          BRIDGE_WORKER_URL: opts.workerUrl,
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

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.log(`Wrote hook config to ${settingsPath}`);

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

      console.log('');
      console.log('Done! Restart Claude Code to activate the bridge.');
      console.log(
        `  Role: ${opts.role}, Room: ${opts.code}, Worker: ${opts.workerUrl}`,
      );
    },
  );

program.parse();
