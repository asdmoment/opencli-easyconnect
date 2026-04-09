/**
 * EasyConnect OpenCLI adapter — container + runtime status.
 *
 * Usage: opencli easyconnect status [--config PATH]
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  loadConfig, buildContext, containerStatus, isRunning,
  readNamedLogViaDocker, readNamedLogMtimeViaDocker,
  parseOnlineState, runtimeTunnelHealthy,
  containerExposesSocks, collectProxyHealthMetrics,
} from './utils.js';

cli({
  site: 'easyconnect',
  name: 'status',
  description: 'Show EasyConnect container and runtime status',
  domain: 'localhost',
  strategy: Strategy.PUBLIC,
  args: [
    { name: 'config', help: 'Path to easyconnect.toml' },
  ],
  columns: ['key', 'value'],

  func: async (_page, kwargs) => {
    const config = loadConfig(kwargs.config);
    const ctx = buildContext(config);
    const rows = [];
    const push = (key, value) => rows.push({ key, value: String(value ?? '') });

    const name = ctx.containerName;
    const status = containerStatus(name);

    push('container', name);
    push('status', status ?? 'missing');
    push('vpn_url', ctx.vpnUrl);
    push('login_url', ctx.loginUrl);
    push('username', ctx.username || '(not resolved)');

    if (ctx.messagesDbPath) {
      push('messages_db', 'configured');
    } else {
      push('messages_db', process.platform === 'darwin' ? 'unavailable' : 'n/a');
    }

    if (status && isRunning(status)) {
      // Read runtime logs
      const logText = readNamedLogViaDocker(name, 'EasyConnect_root_0.log')
        + '\n' + readNamedLogViaDocker(name, 'L3VPN.log');
      const l3vpnText = readNamedLogViaDocker(name, 'L3VPN.log');
      const l3vpnMtime = readNamedLogMtimeViaDocker(name, 'L3VPN.log');

      const healthy = runtimeTunnelHealthy(l3vpnText, l3vpnMtime, 90);
      const online = parseOnlineState(logText);

      push('runtime_online', online || healthy ? 'yes' : 'no');
      push('runtime_heartbeat', healthy ? 'yes' : 'no');
      push('runtime_tunnel_ready', healthy ? 'yes' : 'no');

      // Proxy health
      if (containerExposesSocks(ctx.containerPorts)) {
        const metrics = collectProxyHealthMetrics(name);
        push('danted_io_children', metrics.danted_io_children);
        push('proxy_close_wait', metrics.proxy_close_wait);
        const unhealthy = metrics.danted_io_children >= 256 || metrics.proxy_close_wait >= 128;
        push('proxy_health', unhealthy ? 'recycle-recommended' : 'ok');
      }
    }

    return rows;
  },
});
