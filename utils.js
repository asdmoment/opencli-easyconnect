/**
 * EasyConnect OpenCLI adapter — shared utilities.
 *
 * Docker CLI wrappers, TOML config loading, SMS code reading from macOS
 * Messages (chat.db), and credential resolution.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Docker CLI ──────────────────────────────────────────────────────────

function detectDockerCli() {
  if (process.platform === 'darwin') {
    const orbstack = '/Applications/OrbStack.app/Contents/MacOS/xbin/docker';
    if (fs.existsSync(orbstack)) return orbstack;
  }
  try {
    return execFileSync('which', ['docker'], { encoding: 'utf-8', timeout: 5000 }).trim() || 'docker';
  } catch {
    return 'docker';
  }
}

const DOCKER = detectDockerCli();

export function docker(...args) {
  try {
    return execFileSync(DOCKER, args, { encoding: 'utf-8', timeout: 30_000 });
  } catch (err) {
    return err.stdout ?? '';
  }
}

export function dockerCheck(...args) {
  return execFileSync(DOCKER, args, { encoding: 'utf-8', timeout: 30_000 });
}

// ── TOML config ─────────────────────────────────────────────────────────

function parseTomlValue(raw) {
  const v = raw.trim();
  if (!v) return '';
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    const items = [];
    let buf = '', inStr = false;
    for (const ch of inner) {
      if (inStr) { if (ch === '"') { inStr = false; continue; } buf += ch; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === ',') { const t = buf.trim(); if (t) items.push(t); buf = ''; continue; }
      buf += ch;
    }
    const last = buf.trim();
    if (last) items.push(last);
    return items.map(i => parseTomlValue(`"${i}"`));
  }
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

function parseBasicToml(text) {
  const root = {};
  let current = root;
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    let line = lines[i].trim();
    i++;
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      current = root;
      for (const part of line.slice(1, -1).split('.')) {
        const key = part.trim();
        current[key] ??= {};
        current = current[key];
      }
      continue;
    }
    if (!line.includes('=')) continue;
    let [key, ...rest] = line.split('=');
    key = key.trim();
    let value = rest.join('=').trim();
    if (value.startsWith('[') && !value.endsWith(']')) {
      while (i < lines.length) {
        const next = lines[i].trim();
        i++;
        if (!next || next.startsWith('#')) continue;
        value += ' ' + next;
        if (next.endsWith(']')) break;
      }
    }
    current[key] = parseTomlValue(value);
  }
  return root;
}

export function loadConfig(configPath) {
  if (!configPath) configPath = defaultConfigPath();
  const resolved = configPath.replace(/^~/, os.homedir());
  if (!fs.existsSync(resolved)) return {};
  return parseBasicToml(fs.readFileSync(resolved, 'utf-8'));
}

export function defaultConfigPath() {
  // XDG-style: ~/.config/easyconnect/config.toml
  return path.join(os.homedir(), '.config', 'easyconnect', 'config.toml');
}

// ── Runtime context ─────────────────────────────────────────────────────

const DEFAULT_ECDATA_ROOT = path.join(os.homedir(), '.ecdata');
const DEFAULT_CONTAINER_IMAGE = 'hagb/docker-easyconnect:7.6.7';
const DEFAULT_CONTAINER_PORTS = [
  '127.0.0.1:5901:5901',
  '127.0.0.1:10800:1080',
  '127.0.0.1:18888:8888',
  '127.0.0.1:54530:54530',
];
const DEFAULT_VNC_PASSWORD = 'change-me-local-vnc-password';

export function buildContext(config, overrides = {}) {
  const vpn = config.vpn ?? {};
  const auth = config.auth ?? {};
  const container = config.container ?? {};
  const paths = config.paths ?? {};
  const sms = config.sms ?? {};

  const ecdataRoot = (overrides.ecdataRoot ?? paths.ecdata_root ?? DEFAULT_ECDATA_ROOT).replace(/^~/, os.homedir());
  const containerName = overrides.container ?? vpn.container ?? 'easyconnect';
  const containerImage = container.image ?? DEFAULT_CONTAINER_IMAGE;
  const containerPorts = container.ports ?? DEFAULT_CONTAINER_PORTS;
  const vpnUrl = vpn.url ?? '';
  // Use || (not ??) so empty strings fall through to the next source, matching Python's `or` behavior
  const username = overrides.username || auth.username || resolveUsernameFromEcdata(ecdataRoot) || process.env.EASYCONNECT_USERNAME || '';
  const passwordService = auth.password_service ?? 'easyconnect';

  const openUrlsPath = path.join(ecdataRoot, 'open-urls');
  const loginUrl = resolveLoginUrl(openUrlsPath, vpnUrl);

  return {
    vpnUrl,
    loginUrl,
    containerName,
    containerImage,
    containerPorts,
    containerAutoCreate: container.auto_create !== false,
    vncPassword: container.vnc_password ?? DEFAULT_VNC_PASSWORD,
    socksTimeoutSeconds: parseInt(container.socks_timeout_seconds ?? 600, 10),
    ecdataRoot,
    username,
    passwordService,
    smsKeyword: sms.keyword ?? '验证码',
    smsSenderHint: sms.sender_hint ?? '',
    smsWindowMinutes: parseInt(sms.window_minutes ?? 15, 10),
    smsPollSeconds: parseInt(sms.poll_seconds ?? 2, 10),
    smsWaitSeconds: parseInt(sms.wait_seconds ?? 40, 10),
    messagesDbPath: resolveMessagesDbPath(paths.messages_db_path),
    onlineWaitSeconds: parseInt((config.runtime ?? {}).online_wait_seconds ?? 12, 10),
  };
}

function resolveUsernameFromEcdata(ecdataRoot) {
  const settingRoot = path.join(ecdataRoot, 'conf', 'setting_root.json');
  if (!fs.existsSync(settingRoot)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(settingRoot, 'utf-8'));
    return findNestedUsername(data);
  } catch { return null; }
}

function findNestedUsername(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const loginInfo = value.loginInfo;
    if (loginInfo?.userName) return loginInfo.userName.trim() || null;
    for (const v of Object.values(value)) {
      const found = findNestedUsername(v);
      if (found) return found;
    }
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findNestedUsername(v);
      if (found) return found;
    }
  }
  return null;
}

function resolveLoginUrl(openUrlsPath, fallbackUrl) {
  if (!fs.existsSync(openUrlsPath)) return fallbackUrl;
  try {
    const lines = fs.readFileSync(openUrlsPath, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
    const hostname = fallbackUrl ? new URL(fallbackUrl).hostname : '';
    if (!hostname) return fallbackUrl;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes(hostname) && !/installclient/i.test(lines[i])) return lines[i];
    }
  } catch { /* ignore */ }
  return fallbackUrl;
}

function resolveMessagesDbPath(configured) {
  if (process.platform !== 'darwin') return null;
  const p = (configured ?? '~/Library/Messages/chat.db').replace(/^~/, os.homedir());
  return fs.existsSync(p) ? p : null;
}

// ── Container management ────────────────────────────────────────────────

export function containerStatus(name) {
  const out = docker('ps', '-a', '--filter', `name=${name}`, '--format', '{{.Status}}');
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
  return lines[0] ?? null;
}

export function isRunning(statusText) {
  return statusText ? statusText.startsWith('Up') : false;
}

export function listContainers() {
  const out = docker('ps', '-a', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}');
  return out.split('\n').filter(l => l.trim()).map(line => {
    const [name, image, status] = line.split('\t').map(s => s?.trim() ?? '');
    return { name, image, status };
  }).filter(c => c.name);
}

export function ensureContainerRunning(ctx) {
  let status = containerStatus(ctx.containerName);
  if (isRunning(status)) return ctx.containerName;

  const containers = listContainers();
  let resolved = containers.find(c => c.name === ctx.containerName)?.name
    ?? containers.find(c => /easyconnect/i.test(c.name) || /easyconnect/i.test(c.image))?.name;

  if (!resolved) {
    if (ctx.containerAutoCreate) {
      const args = buildContainerRunArgs(ctx);
      dockerCheck(...args);
      return ctx.containerName;
    }
    throw new Error(`EasyConnect container '${ctx.containerName}' not found. Create it or enable auto_create.`);
  }

  status = containerStatus(resolved);
  if (isRunning(status)) return resolved;

  dockerCheck('start', resolved);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    status = containerStatus(resolved);
    if (isRunning(status)) return resolved;
    // Brief pause via synchronous approach without shell
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  throw new Error(`Container ${resolved} did not reach running state`);
}

function buildContainerRunArgs(ctx) {
  const args = ['run', '--rm', '--detach', '--name', ctx.containerName];
  if (process.platform !== 'win32') args.push('--device', '/dev/net/tun');
  args.push('--cap-add', 'NET_ADMIN');
  for (const p of ctx.containerPorts) { args.push('-p', p); }
  args.push('-v', `${ctx.ecdataRoot}:/root`);
  args.push('-e', `PASSWORD=${ctx.vncPassword}`);
  args.push('-e', 'URLWIN=1');
  args.push('-e', 'DISABLE_PKG_VERSION_XML=1');
  args.push('-e', `CLIP_TEXT=${ctx.vpnUrl}`);
  args.push(ctx.containerImage);
  return args;
}

// ── Log reading ─────────────────────────────────────────────────────────

const CONTAINER_LOG_PATH = '/usr/share/sangfor/EasyConnect/resources/logs';

export function readLogsViaDocker(containerName, lines = 80) {
  const text = docker(
    'exec', containerName, 'sh', '-c',
    `for f in $(ls -t ${CONTAINER_LOG_PATH}/EasyConnect_root*.log 2>/dev/null | head -1) ` +
    `${CONTAINER_LOG_PATH}/L3VPN.log; do cat "$f" 2>/dev/null; done`
  );
  const all = text.split('\n').filter(l => l.trim());
  return all.slice(-lines);
}

export function readNamedLogViaDocker(containerName, filename) {
  return docker('exec', containerName, 'sh', '-lc',
    `cat "${CONTAINER_LOG_PATH}/${filename}" 2>/dev/null || true`
  );
}

export function readNamedLogMtimeViaDocker(containerName, filename) {
  const raw = docker('exec', containerName, 'sh', '-lc',
    `stat -c %Y "${CONTAINER_LOG_PATH}/${filename}" 2>/dev/null ` +
    `|| stat -f %m "${CONTAINER_LOG_PATH}/${filename}" 2>/dev/null || true`
  ).trim();
  return raw ? parseFloat(raw) : null;
}

// ── Runtime health checks ───────────────────────────────────────────────

export function parseOnlineState(logText) {
  return logText.includes('current login state: online');
}

export function parseL3vpnTunnelReady(logText) {
  return logText.includes('MakeCmdTunnel success')
    && logText.includes('MakeTunnel type 5 OK')
    && logText.includes('MakeTunnel type 6 OK');
}

export function runtimeTunnelHealthy(l3vpnText, logMtime, heartbeatTimeoutSeconds = 90) {
  if (!parseL3vpnTunnelReady(l3vpnText)) return false;
  const lines = l3vpnText.split('\n').slice(-20).join('\n');
  if (!lines.includes('TcpRecvThread::recv heartbeat')) return false;
  const lastHb = lines.lastIndexOf('TcpRecvThread::recv heartbeat');
  const trailing = lines.slice(lastHb);
  const disconnectMarkers = ['Recv() failed or finished', 'SHUTDOWN', 'MakeCmdTunnel failed', 'SERVER_RESET'];
  if (disconnectMarkers.some(m => trailing.includes(m))) return false;
  if (logMtime == null) return false;
  const age = Date.now() / 1000 - logMtime;
  return age >= 0 && age <= Math.max(heartbeatTimeoutSeconds, 1);
}

// ── Credential resolution ───────────────────────────────────────────────

export function resolvePassword(serviceName, accountName) {
  const envPw = process.env.EASYCONNECT_PASSWORD;
  if (envPw) return envPw;

  if (process.platform === 'darwin') {
    try {
      const args = ['find-generic-password', '-s', serviceName];
      if (accountName) args.push('-a', accountName);
      args.push('-w');
      return execFileSync('security', args, { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch { /* not found */ }
  }

  return null;
}

// ── SMS reading (macOS Messages.db) ─────────────────────────────────────

export function readSmsCode(dbPath, keyword = '验证码', sinceMinutes = 15) {
  if (!dbPath || process.platform !== 'darwin') return null;

  const appleEpochOffset = 978307200;
  const cutoffUnix = Date.now() / 1000 - sinceMinutes * 60;
  const cutoffApple = (cutoffUnix - appleEpochOffset) * 1e9;

  const query = `SELECT message.text FROM message WHERE message.date > ${Math.floor(cutoffApple)} ORDER BY message.date DESC LIMIT 50;`;

  try {
    const result = execFileSync('sqlite3', [dbPath, query], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    for (const line of result.split('\n')) {
      const text = line.trim();
      if (!text || !text.includes(keyword)) continue;
      const match = text.match(/(?<!\d)(\d{6})(?!\d)/);
      if (match) return match[1];
    }
  } catch { /* DB access denied or not available */ }

  return null;
}

// ── Proxy health ────────────────────────────────────────────────────────

export function containerExposesSocks(ports) {
  return ports.some(p => String(p).split(':').pop() === '1080');
}

export function collectProxyHealthMetrics(containerName) {
  const procText = docker('exec', containerName, 'sh', '-lc',
    'for p in /proc/[0-9]*; do cmd=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null); ' +
    'case "$cmd" in *danted:*) printf "%s\\n" "$cmd";; esac; done'
  );
  const socketText = docker('exec', containerName, 'sh', '-lc',
    '(ss -tanp 2>/dev/null || netstat -tanp 2>/dev/null || true)'
  );
  const ioChildren = (procText.match(/danted: io-child/g) ?? []).length;
  const closeWait = socketText.split('\n').filter(l => l.trim().startsWith('CLOSE-WAIT') && l.includes(':1080')).length;
  return { danted_io_children: ioChildren, proxy_close_wait: closeWait };
}
