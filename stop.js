/**
 * EasyConnect OpenCLI adapter — stop container.
 *
 * Usage: opencli easyconnect stop [--config PATH]
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  loadConfig, buildContext, containerStatus, isRunning,
  listContainers, docker,
} from './utils.js';

cli({
  site: 'easyconnect',
  name: 'stop',
  description: 'Stop the EasyConnect Docker container',
  domain: 'localhost',
  strategy: Strategy.PUBLIC,
  args: [
    { name: 'config', help: 'Path to easyconnect.toml' },
  ],
  columns: ['container', 'action'],

  func: async (_page, kwargs) => {
    const config = loadConfig(kwargs.config);
    const ctx = buildContext(config);
    const preferred = ctx.containerName;

    const containers = listContainers();
    // Find the target container
    let target = containers.find(c => c.name === preferred)?.name;
    if (!target) {
      target = containers.find(c =>
        /easyconnect/i.test(c.name) || /easyconnect/i.test(c.image)
      )?.name;
    }

    if (!target) {
      return [{ container: preferred, action: 'already stopped (not found)' }];
    }

    const status = containerStatus(target);
    if (!status || !isRunning(status)) {
      return [{ container: target, action: 'already stopped' }];
    }

    docker('stop', target);
    return [{ container: target, action: 'stopped' }];
  },
});
