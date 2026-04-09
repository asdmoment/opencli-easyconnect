/**
 * EasyConnect OpenCLI adapter — environment check.
 *
 * Usage: opencli easyconnect doctor [--config PATH]
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { loadConfig, buildContext, defaultConfigPath } from './utils.js';

cli({
  site: 'easyconnect',
  name: 'doctor',
  description: 'Check EasyConnect prerequisites and access',
  domain: 'localhost',
  strategy: Strategy.PUBLIC,
  args: [
    { name: 'config', help: 'Path to easyconnect.toml' },
  ],
  columns: ['check', 'status', 'detail'],

  func: async (_page, kwargs) => {
    const rows = [];
    const push = (check, status, detail = '') => rows.push({ check, status, detail });

    push('platform', 'ok', process.platform);
    push('node', 'ok', process.execPath);
    push('node_version', 'ok', process.version);

    // Docker
    const dockerPaths = [
      '/Applications/OrbStack.app/Contents/MacOS/xbin/docker',
      'docker',
    ];
    let dockerOk = false;
    for (const dp of dockerPaths) {
      if (fs.existsSync(dp)) { dockerOk = true; push('docker_cli', 'ok', dp); break; }
    }
    if (!dockerOk) {
      try {
        execFileSync('which', ['docker'], { encoding: 'utf-8', timeout: 5000 });
        dockerOk = true;
        push('docker_cli', 'ok', 'docker (from PATH)');
      } catch {
        push('docker_cli', 'missing', 'Docker not found');
      }
    }

    // Python
    try {
      const pyVersion = execFileSync('python3', ['--version'], { encoding: 'utf-8', timeout: 5000 }).trim();
      push('python', 'ok', pyVersion);
    } catch {
      push('python', 'missing', 'python3 not found');
    }

    // Config
    const configPath = kwargs.config ?? defaultConfigPath();
    push('config', fs.existsSync(configPath.replace(/^~/, os.homedir())) ? 'ok' : 'missing', configPath);

    // Messages DB (macOS only)
    if (process.platform === 'darwin') {
      const dbPath = os.homedir() + '/Library/Messages/chat.db';
      if (fs.existsSync(dbPath)) {
        // Test read access
        try {
          execFileSync('sqlite3', [dbPath, 'SELECT 1 FROM message LIMIT 1'], {
            encoding: 'utf-8',
            timeout: 5000,
          });
          push('messages_db', 'ok', dbPath);
        } catch (err) {
          push('messages_db', 'denied', err.message?.slice(0, 80) ?? 'access denied');
        }
      } else {
        push('messages_db', 'missing', dbPath);
      }
    } else {
      push('messages_db', 'n/a', 'macOS only');
    }

    // VPN URL from config
    try {
      const config = loadConfig(kwargs.config);
      const ctx = buildContext(config);
      push('vpn_url', ctx.vpnUrl ? 'ok' : 'not set', ctx.vpnUrl || '[vpn].url not configured');
      push('username', ctx.username ? 'ok' : 'not set', ctx.username || 'not resolved');
    } catch (err) {
      push('config_load', 'error', err.message?.slice(0, 80) ?? 'failed');
    }

    return rows;
  },
});
