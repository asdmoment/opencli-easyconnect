/**
 * EasyConnect OpenCLI adapter — login command (self-managed browser mode).
 *
 * Launches its own headless Playwright browser (from the easyconnect-auto
 * project's node_modules) to drive the VPN login portal in the Docker
 * container.  opencli's _page is null for localhost domains, so we manage
 * the browser lifecycle ourselves.
 *
 * SMS codes are read automatically from macOS Messages (chat.db) with polling,
 * or supplied via --sms-code for manual / scripted use.
 *
 * Usage:
 *   opencli easyconnect login
 *   opencli easyconnect login --sms-code 123456
 *   opencli easyconnect login --config ~/my-easyconnect.toml
 *   opencli easyconnect login --visible
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  loadConfig, buildContext, defaultConfigPath, ensureContainerRunning,
  resolvePassword, readSmsCode,
} from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  dismissBlockingClientDialog, acceptPrivacyPolicy, fillField,
  clickLoginButton, clickSmsSubmitButton,
  waitForSmsStage, waitForCompletion,
  selectSmsFieldHandle,
} from './browser.js';

/** Load playwright from this adapter's own node_modules. */
function loadPlaywright() {
  const require = createRequire(import.meta.url);
  return require(path.join(__dirname, 'node_modules', 'playwright'));
}

cli({
  site: 'easyconnect',
  name: 'login',
  description: 'Log in to EasyConnect VPN (headless Playwright, no Chrome extension needed)',
  domain: 'localhost',
  strategy: Strategy.PUBLIC,
  args: [
    { name: 'sms_code', help: 'SMS verification code (skip Messages DB polling)' },
    { name: 'visible', type: 'bool', default: false, help: 'Show browser window' },
    { name: 'config', help: 'Path to easyconnect.toml' },
  ],
  columns: ['step', 'status', 'detail'],

  func: async (_page, kwargs) => {
    const results = [];
    const push = (step, status, detail = '') => results.push({ step, status, detail: String(detail) });

    // 1. Load config and build context
    const configPath = kwargs.config ?? defaultConfigPath();
    const config = loadConfig(configPath);
    const ctx = buildContext(config);

    if (!ctx.loginUrl) {
      push('config', 'error', '[vpn].url not set in config');
      return results;
    }

    // 2. Ensure container is running
    try {
      const name = ensureContainerRunning(ctx);
      push('container', 'ok', name);
    } catch (err) {
      push('container', 'error', err.message);
      return results;
    }

    // 3. Resolve credentials
    if (!ctx.username) {
      push('credentials', 'error', 'username not resolved (set [auth].username or EASYCONNECT_USERNAME)');
      return results;
    }
    const password = resolvePassword(ctx.passwordService, ctx.username);
    if (!password) {
      push('credentials', 'error', 'password not found (set EASYCONNECT_PASSWORD or store in Keychain)');
      return results;
    }
    push('credentials', 'ok', ctx.username);

    // 4. Launch browser
    let playwright;
    try {
      playwright = loadPlaywright();
    } catch (err) {
      push('browser', 'error', `playwright not found in ${projectRoot()}/node_modules: ${err.message}`);
      return results;
    }

    const headless = !kwargs.visible;
    let browser, context, page;
    try {
      browser = await playwright.chromium.launch({ channel: 'chrome', headless }).catch(() =>
        playwright.chromium.launch({ headless })
      );
      context = await browser.newContext({ ignoreHTTPSErrors: true });
      page = await context.newPage();
      push('browser', 'ok', headless ? 'headless' : 'visible');
    } catch (err) {
      push('browser', 'error', err.message);
      return results;
    }

    try {
      // 5. Navigate to VPN portal
      await page.goto(ctx.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1200);
      await dismissBlockingClientDialog(page);
      push('navigate', 'ok', page.url());

      // 6. Fill credentials and submit
      await fillField(page, 'username', ctx.username);
      await fillField(page, 'password', password);
      await dismissBlockingClientDialog(page);
      const acceptedPrivacy = await acceptPrivacyPolicy(page);
      push('privacy', acceptedPrivacy ? 'accepted' : 'skipped', '');
      const clickedLogin = await clickLoginButton(page);
      if (!clickedLogin) await page.keyboard.press('Enter').catch(() => {});
      push('login_click', 'ok', clickedLogin ? 'button clicked' : 'Enter key');

      // 7. Wait for SMS stage or early completion
      const smsStage = await waitForSmsStage(page, ctx.smsWaitSeconds * 1000);

      if (smsStage?.type === 'complete') {
        push('result', 'success', `Login complete (no SMS required) — ${smsStage.completionState?.url ?? ''}`);
        return results;
      }

      push('sms_stage', 'ok', 'SMS verification required');

      // 8. Resolve SMS code
      let smsCode = kwargs.sms_code ?? null;

      if (!smsCode && ctx.messagesDbPath) {
        push('sms_source', 'ok', 'polling macOS Messages DB');
        const deadline = Date.now() + ctx.smsWaitSeconds * 1000;
        while (!smsCode && Date.now() < deadline) {
          smsCode = readSmsCode(ctx.messagesDbPath, ctx.smsKeyword, ctx.smsWindowMinutes);
          if (!smsCode) await new Promise((r) => setTimeout(r, ctx.smsPollSeconds * 1000));
        }
      }

      if (!smsCode) {
        push('sms', 'error', 'SMS code not received. Use --sms-code to provide it manually.');
        return results;
      }
      push('sms', 'ok', `code: ${smsCode}`);

      // 9. Fill SMS and submit
      await fillField(page, 'sms', smsCode);
      const smsFieldHandle = await selectSmsFieldHandle(page);
      const filledValue = await smsFieldHandle?.evaluate((el) => el.value || '').catch(() => '');
      await smsFieldHandle?.dispose().catch(() => {});
      push('sms_fill', filledValue === smsCode ? 'ok' : 'warn', `field value: ${filledValue}`);

      const clickedSubmit = await clickSmsSubmitButton(page);
      if (!clickedSubmit) await page.keyboard.press('Enter').catch(() => {});
      push('sms_submit', 'ok', clickedSubmit ? 'button clicked' : 'Enter key');

      // 10. Wait for completion
      const completionState = await waitForCompletion(page);
      if (completionState?.confirmed) {
        push('result', 'success', `Login complete — ${completionState.url ?? ''}`);
      } else {
        push('result', 'warn', `Login may not have completed — ${completionState?.url ?? ''}`);
      }
    } catch (err) {
      push('error', 'error', err.message);
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }

    return results;
  },
});
