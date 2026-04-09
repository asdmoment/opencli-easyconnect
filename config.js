/**
 * EasyConnect OpenCLI adapter — show configuration.
 *
 * Usage: opencli easyconnect config [--config PATH]
 */
import { cli, Strategy } from '@jackwener/opencli/registry';
import { loadConfig, defaultConfigPath } from './utils.js';

cli({
  site: 'easyconnect',
  name: 'config',
  description: 'Show EasyConnect configuration',
  domain: 'localhost',
  strategy: Strategy.PUBLIC,
  args: [
    { name: 'config', help: 'Path to easyconnect.toml' },
  ],
  columns: ['section', 'key', 'value'],

  func: async (_page, kwargs) => {
    const configPath = kwargs.config ?? defaultConfigPath();
    const config = loadConfig(configPath);
    const rows = [];

    for (const [section, values] of Object.entries(config)) {
      if (typeof values !== 'object' || values === null) {
        rows.push({ section: '', key: section, value: String(values) });
        continue;
      }
      for (const [key, val] of Object.entries(values)) {
        const display = Array.isArray(val) ? val.join(', ') : String(val);
        // Mask password-like values
        const masked = /password/i.test(key) && display ? '****' : display;
        rows.push({ section, key, value: masked });
      }
    }

    if (!rows.length) {
      rows.push({ section: '', key: 'config_path', value: configPath });
      rows.push({ section: '', key: 'note', value: 'Config file not found or empty' });
    }

    return rows;
  },
});
