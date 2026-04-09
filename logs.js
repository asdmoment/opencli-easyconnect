/**
 * EasyConnect OpenCLI adapter — show runtime logs.
 *
 * Usage: opencli easyconnect logs [--lines 80] [--config PATH]
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  loadConfig, buildContext, containerStatus, isRunning,
  readLogsViaDocker,
} from './utils.js';

cli({
  site: 'easyconnect',
  name: 'logs',
  description: 'Show recent EasyConnect runtime logs',
  domain: 'localhost',
  strategy: Strategy.PUBLIC,
  defaultFormat: 'plain',
  args: [
    { name: 'lines', type: 'int', default: 80, help: 'Number of log lines to show' },
    { name: 'config', help: 'Path to easyconnect.toml' },
  ],
  columns: ['line'],

  func: async (_page, kwargs) => {
    const config = loadConfig(kwargs.config);
    const ctx = buildContext(config);
    const name = ctx.containerName;
    const status = containerStatus(name);

    if (!status || !isRunning(status)) {
      return [{ line: `Container ${name} is not running.` }];
    }

    const lines = readLogsViaDocker(name, kwargs.lines ?? 80);
    return lines.map(l => ({ line: l }));
  },
});
