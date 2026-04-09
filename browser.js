/**
 * EasyConnect OpenCLI adapter — browser interaction helpers.
 *
 * All functions accept a Playwright `page` as their first argument and are
 * designed to work with any page source (opencli _page, standalone Playwright,
 * etc.).  No stdin/stdout communication — callers handle I/O.
 */

// ── Field selection ──────────────────────────────────────────────────────

export async function selectFieldHandle(page, kind) {
  const handle = await page.evaluateHandle((fieldKind) => {
    const patterns = {
      username: [/用户名/i, /账号/i, /account/i, /user/i, /login/i, /邮箱/i],
      password: [/密码/i, /password/i],
      sms: [/验证码/i, /verification/i, /sms/i, /otp/i, /code/i],
    };
    const extraPatterns = {
      username: [/username/i],
      password: [/password/i, /loginpwd/i, /passwd/i, /pwd/i],
      sms: [/verification code/i, /sms code/i, /otp/i],
    };

    function collectTextHints(element) {
      const hints = [];
      const push = (value) => {
        if (typeof value === 'string') {
          const text = value.trim();
          if (text) hints.push(text.slice(0, 240));
        }
      };
      push(element.getAttribute('aria-label'));
      push(element.getAttribute('placeholder'));
      push(element.getAttribute('name'));
      push(element.id);
      push(element.getAttribute('value'));
      push(element.type);
      push(element.className);
      push(element.closest('label')?.innerText);
      push(element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.innerText : '');
      let node = element;
      for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
        push(node.innerText);
        push(node.textContent);
      }
      push(element.previousElementSibling?.innerText);
      push(element.previousElementSibling?.textContent);
      return hints.join(' ');
    }

    function scoreElement(element) {
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return -Infinity;
      const text = collectTextHints(element);
      let score = 0;
      let matchedPattern = false;
      for (const pattern of patterns[fieldKind] || []) {
        if (pattern.test(text)) { score += 18; matchedPattern = true; }
      }
      for (const pattern of extraPatterns[fieldKind] || []) {
        if (pattern.test(text)) { score += 12; matchedPattern = true; }
      }
      if (fieldKind === 'password' && element.type === 'password') score += 80;
      if (fieldKind === 'password' && element.id === 'loginPwd') score += 120;
      if (fieldKind === 'password' && /pwd|password|pass/i.test(`${element.id} ${element.getAttribute('name')} ${element.className}`)) score += 35;
      if (fieldKind === 'username' && ['text', 'email', 'search', 'tel'].includes(element.type)) score += 8;
      if (fieldKind === 'sms' && ['text', 'email', 'tel', 'number'].includes(element.type)) score += 8;
      if (fieldKind === 'username' && /user|account|login/i.test(`${element.id} ${element.getAttribute('name')} ${element.className}`)) score += 18;
      if (fieldKind === 'sms' && /sms|otp|code|verify/i.test(`${element.id} ${element.getAttribute('name')} ${element.className}`)) score += 18;
      if (/input-txt/i.test(`${element.id} ${element.className}`)) score += 8;
      if (rect.width >= 160) score += 8;
      if (rect.height >= 24) score += 8;
      score += Math.min(rect.width / 28, 10);
      score += Math.min(rect.height / 4, 8);
      score += Math.min(rect.width * rect.height / 1000, 16);
      if (rect.y <= 12) score -= 14;
      if (rect.width < 100 || rect.height < 18) score -= 12;
      if (fieldKind === 'sms' && !matchedPattern) return -Infinity;
      return score;
    }

    const candidates = Array.from(document.querySelectorAll('input, textarea')).filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const inputType = typeof element.type === 'string' ? element.type.toLowerCase() : '';
      return (
        style &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        !element.disabled &&
        !element.readOnly &&
        !['hidden', 'checkbox', 'radio', 'submit', 'button', 'image', 'reset'].includes(inputType) &&
        rect.width > 0 &&
        rect.height > 0
      );
    });

    let bestCandidate = null;
    let bestScore = -Infinity;
    candidates.forEach((element) => {
      const score = scoreElement(element);
      if (score > bestScore) { bestScore = score; bestCandidate = element; }
    });
    return bestCandidate;
  }, kind);

  return handle.asElement();
}


export async function selectSmsFieldHandle(page) {
  const directSelectors = [
    'input[id*="sms" i]',
    'input[name*="sms" i]',
    'input[id*="otp" i]',
    'input[name*="otp" i]',
    'input[id*="code" i]',
    'input[name*="code" i]',
    'input[placeholder*="验证码"]',
    'input[placeholder*="code" i]',
    'input[aria-label*="验证码"]',
    'input[aria-label*="code" i]',
  ];

  for (const selector of directSelectors) {
    const locator = page.locator(selector);
    const count = Math.min(await locator.count(), 8);
    for (let index = 0; index < count; index++) {
      const candidate = locator.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      const handle = await candidate.elementHandle();
      if (handle) return handle;
    }
  }

  return selectFieldHandle(page, 'sms');
}


export async function fillField(page, kind, value, required = true) {
  const field = kind === 'sms' ? await selectSmsFieldHandle(page) : await selectFieldHandle(page, kind);
  if (!field) {
    if (required) throw new Error(`could not find ${kind} field`);
    return false;
  }
  await field.click({ timeout: 5000 }).catch(() => {});
  await field.fill(value);
  await field.dispose().catch(() => {});
  return true;
}

// ── Dialog / privacy ─────────────────────────────────────────────────────

export async function dismissBlockingClientDialog(page) {
  return page.evaluate(() => {
    const container = document.querySelector('#app_dialog_container');
    if (!(container instanceof HTMLElement)) return false;

    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };

    const blockingDialog = Array.from(container.querySelectorAll('.dialog, .down-client')).find((element) => {
      if (!isVisible(element)) return false;
      const text = `${element.innerText || ''} ${element.textContent || ''}`;
      return /download client/i.test(text) && /(client not installed|version incorrect|re-install)/i.test(text);
    });

    if (!(blockingDialog instanceof HTMLElement)) return false;

    container.style.display = 'none';
    container.style.pointerEvents = 'none';
    container.setAttribute('aria-hidden', 'true');
    for (const element of Array.from(container.querySelectorAll('*'))) {
      if (element instanceof HTMLElement) element.style.pointerEvents = 'none';
    }
    return true;
  });
}


export async function acceptPrivacyPolicy(page) {
  const directSelectors = [
    '.include-box__privacy input[type="checkbox"]',
    '.checkbox__input',
  ];

  for (const selector of directSelectors) {
    const input = page.locator(selector).first();
    if (!(await input.count())) continue;

    const visible = await input.evaluate((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const wrapper = element.closest('.include-box__privacy, .checkbox, label') || element;
      if (!(wrapper instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(wrapper);
      const rect = wrapper.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }).catch(() => false);

    if (!visible) continue;

    const checked = await input.isChecked().catch(() => false);
    if (!checked) {
      await input.check({ force: true }).catch(async () => {
        await input.evaluate((element) => {
          if (!(element instanceof HTMLInputElement)) return;
          element.checked = true;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
    }
    return input.isChecked().catch(() => true);
  }

  return page.evaluate(() => {
    const patterns = [/privacy policy/i, /read and accept/i, /accept the privacy/i, /已阅读/i, /阅读并同意/i, /隐私政策/i];
    const bodyText = document.body?.innerText || '';
    if (!patterns.some((pattern) => pattern.test(bodyText))) return false;

    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };

    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter((element) => {
      if (!(element instanceof HTMLInputElement)) return false;
      const wrapper = element.closest('.include-box__privacy, .checkbox, label') || element;
      return isVisible(wrapper);
    });

    if (checkboxes.length === 0) return false;

    for (const input of checkboxes) {
      if (input.checked) continue;
      input.click();
      if (!input.checked) input.checked = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return checkboxes.every((input) => input.checked);
  });
}

// ── Button clicks ─────────────────────────────────────────────────────────

async function clickPrimaryButton(page) {
  const selector = 'button, input[type="submit"], input[type="button"], [role="button"], a[role="button"]';
  const handle = await page.evaluateHandle((buttonSelector) => {
    const patterns = [/登录/i, /log in/i, /login/i, /sign in/i, /submit/i, /确定/i, /下一步/i, /continue/i];
    const extraPatterns = [/log in/i];

    function collectText(element) {
      const hints = [];
      const push = (value) => {
        if (typeof value === 'string') {
          const text = value.trim();
          if (text) hints.push(text.slice(0, 240));
        }
      };
      push(element.textContent);
      push(element.getAttribute('value'));
      push(element.getAttribute('aria-label'));
      push(element.getAttribute('title'));
      push(element.className);
      let node = element;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) push(node.innerText);
      return hints.join(' ');
    }

    function scoreButton(element) {
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return -Infinity;
      const text = collectText(element);
      let score = 0;
      for (const pattern of patterns) { if (pattern.test(text)) score += 20; }
      for (const pattern of extraPatterns) { if (pattern.test(text)) score += 10; }
      score += Math.min(rect.width / 30, 12);
      score += Math.min(rect.height / 6, 8);
      score += Math.min(rect.width * rect.height / 1200, 12);
      if (rect.y <= 12) score -= 8;
      return score;
    }

    const candidates = Array.from(document.querySelectorAll(buttonSelector)).filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style && style.display !== 'none' && style.visibility !== 'hidden' && !element.disabled && rect.width > 0 && rect.height > 0;
    });

    let bestCandidate = null;
    let bestScore = -Infinity;
    candidates.forEach((element) => {
      const score = scoreButton(element);
      if (score > bestScore) { bestScore = score; bestCandidate = element; }
    });
    return bestCandidate;
  }, selector);

  const button = handle.asElement();
  if (!button) return false;

  try {
    await button.click({ timeout: 5000 });
  } catch {
    await page.evaluate((element) => element.click(), button);
  }
  await button.dispose().catch(() => {});
  return true;
}


export async function clickLoginButton(page) {
  const locators = [
    page.getByRole('button', { name: /log in|login|登录/i }),
    page.locator('button:has-text("Log In"), button:has-text("Login"), button:has-text("登录")'),
    page.locator('input[type="submit"][value*="Log"], input[type="submit"][value*="login"], input[type="submit"][value*="登录"]'),
  ];

  for (const locator of locators) {
    if (!(await locator.count())) continue;
    const button = locator.first();
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;
    try {
      await button.click({ force: true });
      return true;
    } catch {
      continue;
    }
  }

  return clickPrimaryButton(page);
}


export async function clickSmsSubmitButton(page) {
  const locators = [
    page.locator('#sms-submit, button[id*="sms" i], button[id*="code" i], input[type="submit"][value*="Continue"], input[type="submit"][value*="Submit"]'),
    page.getByRole('button', { name: /continue|submit|verify|next|确定|提交|下一步/i }),
    page.locator('button:has-text("Continue"), button:has-text("Submit"), button:has-text("Verify"), button:has-text("Next"), button:has-text("确定"), button:has-text("提交"), button:has-text("下一步")'),
  ];

  for (const locator of locators) {
    if (!(await locator.count())) continue;
    const button = locator.first();
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;
    try {
      await button.click({ force: true });
      return true;
    } catch {
      continue;
    }
  }

  return clickPrimaryButton(page);
}

// ── State detection ──────────────────────────────────────────────────────

export async function evaluateCompletionState(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };

    const hasVisiblePasswordField = Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible);
    const hasVisibleSmsField = Array.from(document.querySelectorAll('input, textarea')).some((element) => {
      if (!(element instanceof HTMLElement) || !isVisible(element)) return false;
      const hints = [
        element.getAttribute('id'),
        element.getAttribute('name'),
        element.getAttribute('placeholder'),
        element.getAttribute('aria-label'),
        element.className,
        element.previousElementSibling?.textContent,
        element.closest('label')?.textContent,
      ].filter(Boolean).join(' ');
      return /验证码|verification|sms|otp|code/i.test(hints);
    });
    const hasVisibleLoginButton = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a[role="button"]')).some((element) => {
      if (!(element instanceof HTMLElement) || !isVisible(element)) return false;
      const hints = [element.textContent, element.getAttribute('value'), element.getAttribute('aria-label'), element.getAttribute('title')].filter(Boolean).join(' ');
      return /log in|login|登录|sign in/i.test(hints);
    });

    const url = window.location.href;
    const title = document.title || '';
    const bodyText = document.body?.innerText || '';
    const datasetJson = JSON.stringify(document.body?.dataset || {});
    const hasSuccessMarker =
      /logout|disconnect|connected|success|already logged in|resource page|vpn_openresource|已连接|断开|退出|注销|成功/i.test(`${url} ${title} ${bodyText}`) ||
      /"complete":"true"|"status":"done"/i.test(datasetJson) ||
      /^done$/i.test(title.trim());
    const confirmed = hasSuccessMarker || (!hasVisibleSmsField && !hasVisiblePasswordField && !hasVisibleLoginButton && !/login/i.test(url));

    return { confirmed, url, title, bodyText: bodyText.slice(0, 400), hasVisibleSmsField, hasVisiblePasswordField, hasVisibleLoginButton };
  });
}


export async function waitForSmsStage(page, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const field = await selectSmsFieldHandle(page);
    if (field) {
      await field.dispose().catch(() => {});
      return { type: 'sms' };
    }
    const completionState = await evaluateCompletionState(page).catch(() => null);
    if (completionState?.confirmed) return { type: 'complete', completionState };
    await page.waitForTimeout(500);
  }

  const finalState = await evaluateCompletionState(page).catch(() => ({}));
  if (finalState?.confirmed) return { type: 'complete', completionState: finalState };
  const bodyText = await page.locator('body').innerText().catch(() => '');
  throw new Error(`timed out waiting for SMS verification step: ${JSON.stringify({ ...finalState, bodyText: bodyText.slice(0, 400) })}`);
}


export async function waitForCompletion(page, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = await evaluateCompletionState(page);

  while (Date.now() < deadline) {
    if (lastState.confirmed) return lastState;
    await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(500);
    lastState = await evaluateCompletionState(page);
  }

  return lastState;
}
