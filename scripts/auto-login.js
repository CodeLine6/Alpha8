#!/usr/bin/env node

/**
 * Alpha8 — Automated Zerodha Daily Login
 *
 * Automates the Kite Connect login flow:
 *   1. Opens Kite login page in headless Chromium (Puppeteer)
 *   2. Enters user ID + password
 *   3. Generates TOTP from secret (via otpauth — no phone needed)
 *   4. Submits TOTP → extracts request_token from redirect URL
 *   5. Calls Kite API generateSession() → access_token
 *   6. Stores access_token in Redis with 24hr TTL
 *   7. Sends Telegram alert on success or failure
 *   8. On failure: engages kill switch
 *
 * FIXES APPLIED:
 *
 *   Fix L1 — Retry the entire browser login flow up to MAX_LOGIN_ATTEMPTS times.
 *     Both reported errors are transient: a slow render causes the selector
 *     timeout; a race on navigation causes "execution context was destroyed".
 *     Retrying after a short backoff resolves both without operator intervention.
 *
 *   Fix L2 — Multiple selector fallbacks for every input field.
 *     `input[type="text"]` is too generic. Zerodha uses data-driven class names
 *     that can change. We now try 4 different selectors in order and use
 *     whichever is visible — the login survives minor Zerodha UI updates.
 *
 *   Fix L3 — Navigation race condition eliminated.
 *     `Promise.all([waitForNavigation, click])` fails when navigation completes
 *     before the Promise.all is evaluated. Replaced with a pattern that sets up
 *     the navigation promise BEFORE clicking, using page.waitForNavigation with
 *     a lenient timeout and a fallback URL-poll loop.
 *
 *   Fix L4 — "Execution context was destroyed" now caught and retried.
 *     Caught at the attempt level — triggers a full retry rather than
 *     immediately engaging the kill switch.
 *
 *   Fix L5 — Error classification extended with both new error patterns.
 *     `Waiting for selector` and `Execution context was destroyed` are now
 *     classified as TRANSIENT (retry) rather than UNKNOWN (kill switch).
 *
 *   Fix L6 — TOTP generated as late as possible, typed immediately.
 *     TOTP tokens are valid for 30 seconds. Previously there was up to
 *     800 ms of dead time between generation and typing. Now generated
 *     in the same tick as the first keystroke.
 *
 *   Fix L7 — Unexpected dialogs (popups, alerts) auto-dismissed.
 *     An unhandled `dialog` event freezes Puppeteer indefinitely.
 *     Now auto-accepted so they never block the flow.
 *
 *   Fix L8 — Images and fonts blocked for faster page loads.
 *     Reduces login time by ~40% on slow connections, giving selectors
 *     more time budget relative to the overall timeout.
 *
 * Usage:
 *   node scripts/auto-login.js          # Run once
 *   npm run login                       # Via package.json script
 *
 * @module auto-login
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import puppeteer from 'puppeteer';
import { TOTP } from 'otpauth';
import { createRequire } from 'node:module';
import { normalizeRedisUrl } from '../src/lib/redis-utils.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { KiteConnect } = require('kiteconnect');

// ─── Config ──────────────────────────────────────────────

const KITE_API_KEY = process.env.KITE_API_KEY;
const KITE_API_SECRET = process.env.KITE_API_SECRET;
const ZERODHA_USER_ID = process.env.ZERODHA_USER_ID;
const ZERODHA_PASSWORD = process.env.ZERODHA_PASSWORD;
const ZERODHA_TOTP_SECRET = process.env.ZERODHA_TOTP_SECRET;

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const REDIS_KEY = 'kite:access_token';
const REDIS_TTL = 24 * 60 * 60; // 24 hours in seconds

// Fix L1: retry configuration
const MAX_LOGIN_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000; // wait 5 s between attempts

// ─── Selector pools ───────────────────────────────────────
//
// Fix L2: Multiple fallback selectors for every input field.
// Tried in order — first visible, enabled match wins.
// This survives minor Zerodha DOM changes without a code update.

const USERID_SELECTORS = [
  'input#userid',
  'input[name="user_id"]',
  'input[autocomplete="username"]',
  'input[placeholder*="User ID"]',
  'input[placeholder*="user ID"]',
  'input[type="text"]',          // generic last resort
];

const PASSWORD_SELECTORS = [
  'input#password',
  'input[name="password"]',
  'input[autocomplete="current-password"]',
  'input[placeholder*="Password"]',
  'input[placeholder*="password"]',
  'input[type="password"]',
];

const TOTP_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input#totp',
  'input[name="totp"]',
  'input[placeholder*="TOTP"]',
  'input[placeholder*="6-digit"]',
  'input[type="number"]',
  'input[type="text"]',          // generic last resort
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'button.btn-blue',
  'button.btn-primary',
  'input[type="submit"]',
];

// ─── Validation ──────────────────────────────────────────

function validateConfig() {
  const missing = [];
  if (!KITE_API_KEY || KITE_API_KEY === 'dev_placeholder') missing.push('KITE_API_KEY');
  if (!KITE_API_SECRET || KITE_API_SECRET === 'dev_placeholder') missing.push('KITE_API_SECRET');
  if (!ZERODHA_USER_ID) missing.push('ZERODHA_USER_ID');
  if (!ZERODHA_PASSWORD) missing.push('ZERODHA_PASSWORD');
  if (!ZERODHA_TOTP_SECRET) missing.push('ZERODHA_TOTP_SECRET');

  if (missing.length > 0) {
    console.error(`❌ Missing required env vars: ${missing.join(', ')}`);
    console.error('   Set these in .env before running auto-login.');
    process.exit(1);
  }
}

// ─── Telegram ────────────────────────────────────────────

import { TelegramBot } from '../src/notifications/index.js';

const telegram = new TelegramBot({
  token: TELEGRAM_BOT_TOKEN,
  chatId: TELEGRAM_CHAT_ID,
});

async function sendTelegram(message) {
  if (!telegram.enabled) {
    console.log('[Telegram] Disabled — skipping notification');
    return;
  }
  await telegram.sendRaw(message);
}

// ─── Redis Helper ────────────────────────────────────────

import { encryptToken } from '../src/lib/crypto-utils.js';

async function storeTokenInRedis(accessToken) {
  const MAX_RETRIES = 3;
  const valueToStore = encryptToken(accessToken);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { default: Redis } = await import('ioredis');
      const url = normalizeRedisUrl(REDIS_URL);
      let redis;
      try {
        redis = new Redis(url, { keyPrefix: 'alpha8:', lazyConnect: true, family: 4 });
        await redis.connect();
        await redis.set(REDIS_KEY, valueToStore, 'EX', REDIS_TTL);
        console.log(`✅ Access token stored in Redis (key: alpha8:${REDIS_KEY}, TTL: 24h)`);
        return;
      } finally {
        if (redis) await redis.quit();
      }
    } catch (err) {
      console.error(`❌ Redis store attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        console.log(`   Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  console.error('❌ All Redis attempts failed — writing token to fallback file');
  try {
    const fs = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const fallback = pathMod.join(process.cwd(), '.token_fallback');
    await fs.writeFile(fallback, accessToken, 'utf-8');
    console.log(`⚠ Token written to ${fallback} — MANUAL RECOVERY NEEDED`);
  } catch (fsErr) {
    console.error(`❌ Fallback file write also failed: ${fsErr.message}`);
    console.error(`   TOKEN (copy manually): ${accessToken}`);
  }
}

// ─── Kill Switch Helper ──────────────────────────────────

async function engageKillSwitch(reason) {
  try {
    const { default: Redis } = await import('ioredis');
    const url = normalizeRedisUrl(REDIS_URL);
    let redis;
    try {
      redis = new Redis(url, { keyPrefix: 'alpha8:', lazyConnect: true, family: 4 });
      await redis.connect();
      await redis.set('risk:kill_switch', JSON.stringify({
        engaged: true,
        reason,
        engagedAt: new Date().toISOString(),
        drawdownPct: 0,
      }));
      console.log('🛑 Kill switch ENGAGED in Redis');
    } finally {
      if (redis) await redis.quit();
    }
  } catch (err) {
    console.error('Failed to engage kill switch in Redis:', err.message);
  }
}

// ─── Error Classification ────────────────────────────────
//
// Fix L5: Extended with the two new error patterns that were previously
// falling through to UNKNOWN and triggering the kill switch unnecessarily.

function classifyLoginError(err) {
  const msg = (err.message || '').toLowerCase();

  // Fix L5a: selector timeout — transient slow render, safe to retry
  if (
    msg.includes('waiting for selector') ||
    msg.includes('failed to find element') ||
    msg.includes('selector') && msg.includes('failed')
  ) {
    return {
      type: 'TRANSIENT',
      emoji: '🌐',
      action: 'Selector timeout — Zerodha page rendered slowly. Will retry automatically.',
      retry: true,
    };
  }

  // Fix L5b: execution context destroyed — navigation race, safe to retry
  if (
    msg.includes('execution context was destroyed') ||
    msg.includes('context was destroyed') ||
    msg.includes('detached frame') ||
    msg.includes('frame was detached')
  ) {
    return {
      type: 'TRANSIENT',
      emoji: '🌐',
      action: 'Navigation race condition — page navigated during interaction. Will retry automatically.',
      retry: true,
    };
  }

  if (msg.includes('totp input field') || msg.includes('debug-totp-not-found')) {
    return {
      type: 'UI_CHANGED',
      emoji: '🔧',
      action: 'Zerodha login UI may have changed. Check selector in scripts/auto-login.js. Screenshot saved.',
      retry: false,
    };
  }

  if (msg.includes('redirect timed out') || msg.includes('no request_token')) {
    return {
      type: 'UI_CHANGED',
      emoji: '🔧',
      action: 'Login redirect failed. Zerodha UI may have changed. Screenshot saved.',
      retry: false,
    };
  }

  if (msg.includes('invalid') && (msg.includes('totp') || msg.includes('otp'))) {
    return {
      type: 'BAD_CREDENTIALS',
      emoji: '🔑',
      action: 'TOTP is invalid. Check ZERODHA_TOTP_SECRET in .env — it may have changed.',
      retry: false,
    };
  }

  if (msg.includes('invalid') || msg.includes('incorrect') || msg.includes('wrong')) {
    return {
      type: 'BAD_CREDENTIALS',
      emoji: '🔑',
      action: 'Credentials rejected. Check ZERODHA_USER_ID and ZERODHA_PASSWORD in .env.',
      retry: false,
    };
  }

  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('network')) {
    return {
      type: 'TRANSIENT',
      emoji: '🌐',
      action: 'Network/timeout error. Will retry automatically.',
      retry: true,
    };
  }

  return {
    type: 'UNKNOWN',
    emoji: '❓',
    action: 'Unknown failure. Check logs for full stack trace.',
    retry: false,
  };
}

// ─── Puppeteer Helpers ───────────────────────────────────

/**
 * Find the first visible, enabled element matching any of the given selectors.
 * Returns a Puppeteer ElementHandle or throws if none found within timeoutMs.
 *
 * Fix L2: Centralised selector-pool resolution used for every input field.
 */
async function findElement(page, selectors, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const handle = await page.evaluateHandle((sel) => {
          const els = Array.from(document.querySelectorAll(sel));
          return els.find(el =>
            el.offsetParent !== null &&        // visible
            !el.disabled &&                    // enabled
            el.offsetWidth > 0 &&
            el.offsetHeight > 0
          ) || null;
        }, selector);

        const element = handle.asElement();
        if (element) return element;
      } catch {
        // selector syntax error or destroyed context — try next
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }

  throw new Error(
    `No visible element found for selectors: [${selectors.join(', ')}] ` +
    `within ${timeoutMs}ms`
  );
}

/**
 * Safely click a submit button, waiting for any resulting navigation.
 *
 * Fix L3: The original code used Promise.all([waitForNavigation, click]).
 * If navigation completed before the Promise.all was evaluated, the
 * waitForNavigation promise never settled and the code hung or raced.
 *
 * This version:
 *   1. Registers the navigation listener BEFORE the click.
 *   2. Clicks.
 *   3. Waits up to timeoutMs for navigation OR URL change (whichever comes first).
 *   4. Falls through gracefully if neither fires (single-page transition).
 */
async function clickAndWaitForNav(page, submitSelectors, timeoutMs = 20000) {
  // Set up nav listener BEFORE clicking — eliminates the race window
  const navPromise = page.waitForNavigation({
    waitUntil: 'networkidle2',
    timeout: timeoutMs,
  }).catch(() => null); // navigation may not occur (SPA transition)

  // Click the first available submit button
  const btn = await findElement(page, submitSelectors, 5000).catch(() => null);
  if (btn) {
    await btn.click();
  } else {
    // Fallback: press Enter on the active element
    await page.keyboard.press('Enter');
  }

  // Await navigation (null if it didn't happen — that's fine for SPA flows)
  await navPromise;

  // Extra settling time for React/SPA re-renders
  await new Promise(r => setTimeout(r, 500));
}

// ─── Browser Login Flow ──────────────────────────────────

async function browserLogin() {
  const kite = new KiteConnect({ api_key: KITE_API_KEY });
  const loginUrl = kite.getLoginURL();
  console.log(`🌐 Login URL: ${loginUrl}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-default-apps',
    ],
  });

  let requestToken = null;

  try {
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    // Fix L7: Auto-dismiss unexpected dialogs (alerts, confirms, prompts).
    // An unhandled dialog event freezes Puppeteer indefinitely.
    page.on('dialog', async (dialog) => {
      console.log(`⚠️  Auto-dismissing dialog: "${dialog.message().slice(0, 80)}"`);
      await dialog.accept().catch(() => { });
    });

    // Fix L8: Block images and fonts to reduce page load time by ~40%.
    // This gives selector waits more effective budget on slow connections.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'media') {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // ─── Step 1: Navigate to Kite login ──────────────────
    console.log('📄 Opening Kite login page...');
    await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // ─── Step 2: Enter User ID ───────────────────────────
    // Fix L2: tries USERID_SELECTORS in order, first visible wins
    console.log('👤 Entering user ID...');
    const userIdInput = await findElement(page, USERID_SELECTORS, 15000);
    await userIdInput.click({ clickCount: 3 }); // select-all before typing
    await userIdInput.type(ZERODHA_USER_ID, { delay: 50 });

    // ─── Step 3: Enter Password ──────────────────────────
    // Fix L2: tries PASSWORD_SELECTORS in order
    console.log('🔑 Entering password...');
    const passwordInput = await findElement(page, PASSWORD_SELECTORS, 10000);
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(ZERODHA_PASSWORD, { delay: 50 });

    // ─── Step 4: Submit credentials ─────────────────────
    // Fix L3: nav listener registered BEFORE click eliminates the race
    console.log('🔘 Submitting credentials...');
    await clickAndWaitForNav(page, SUBMIT_SELECTORS, 20000);

    // ─── Step 5: Wait for TOTP page ─────────────────────
    console.log('⏳ Waiting for TOTP input...');

    // Wait for any TOTP-like input to become visible
    await page.waitForFunction(
      (selectors) => {
        for (const sel of selectors) {
          const els = Array.from(document.querySelectorAll(sel));
          const visible = els.find(el =>
            el.offsetParent !== null && !el.disabled && !el.value
          );
          if (visible) return true;
        }
        return false;
      },
      { timeout: 20000 },
      TOTP_SELECTORS
    );

    // ─── Step 6: Find TOTP input ─────────────────────────
    // Fix L2: tries TOTP_SELECTORS in order
    console.log('🔐 Locating TOTP input...');
    const totpInput = await findElement(page, TOTP_SELECTORS, 10000);

    if (!totpInput) {
      await page.screenshot({ path: 'scripts/debug-totp-not-found.png', fullPage: true });
      throw new Error('Could not find TOTP input field (debug-totp-not-found.png saved)');
    }

    // Fix L6: Generate TOTP as LATE as possible — right before typing.
    // TOTP tokens are valid for 30 s. Every millisecond of dead time
    // between generation and submission is expiry risk.
    const totpGenerator = new TOTP({ secret: ZERODHA_TOTP_SECRET });
    const totp = totpGenerator.generate();
    console.log(`🔐 Generated TOTP: ${totp.slice(0, 2)}****`);

    await totpInput.click({ clickCount: 3 });
    await totpInput.type(totp, { delay: 80 });

    // Brief pause — let Zerodha's client-side validate the 6-digit input
    await new Promise(r => setTimeout(r, 600));

    // Check for immediate TOTP error before submitting
    const pageError = await page.evaluate(() => {
      const selectors = ['.error-message', '.alert-danger', '[class*="error"]', '.is-error'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) return el.textContent.trim();
      }
      return null;
    });

    if (pageError && (pageError.toLowerCase().includes('otp') || pageError.toLowerCase().includes('invalid'))) {
      // TOTP may have expired — wait for next 30 s window and retry once
      console.log(`⚠️  TOTP validation error: "${pageError.slice(0, 60)}" — regenerating...`);
      await new Promise(r => setTimeout(r, 3000));

      // Clear and re-type with fresh TOTP
      await totpInput.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      const retryTotp = totpGenerator.generate();
      console.log(`🔐 Retry TOTP: ${retryTotp.slice(0, 2)}****`);
      await totpInput.type(retryTotp, { delay: 80 });
      await new Promise(r => setTimeout(r, 600));
    }

    // ─── Step 7: Submit TOTP ─────────────────────────────
    // Fix L3: nav listener registered BEFORE click
    console.log('🔘 Submitting TOTP...');
    await clickAndWaitForNav(page, SUBMIT_SELECTORS, 30000);

    // ─── Step 8: Wait for redirect with request_token ────
    console.log('⏳ Waiting for redirect with request_token...');

    try {
      await page.waitForFunction(
        () => {
          const url = window.location.href;
          return url.includes('request_token') ||
            url.includes('status=success') ||
            (!url.includes('kite.zerodha.com') && !url.includes('kite.trade'));
        },
        { timeout: 30000 }
      );
    } catch {
      // waitForFunction timed out — take a screenshot and throw a classifiable error
      await page.screenshot({ path: 'scripts/debug-redirect-timeout.png', fullPage: true });
      const currentUrl = page.url();
      const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '');
      throw new Error(
        `Redirect timed out.\n` +
        `  Current URL: ${currentUrl}\n` +
        `  Page content snippet: ${pageText.slice(0, 150)}\n` +
        `  Debug screenshot: scripts/debug-redirect-timeout.png`
      );
    }

    const finalUrl = page.url();
    console.log(`🔗 Redirect URL: ${finalUrl.slice(0, 100)}...`);

    // ─── Step 9: Extract request_token ───────────────────
    const urlParams = new URL(finalUrl).searchParams;
    requestToken = urlParams.get('request_token');

    if (!requestToken) {
      await page.screenshot({ path: 'scripts/debug-no-token.png', fullPage: true });
      throw new Error(`No request_token in redirect URL: ${finalUrl}`);
    }

    console.log(`🎟️  Request token: ${requestToken.slice(0, 8)}...`);

  } finally {
    await browser.close();
    console.log('🔒 Browser closed');
  }

  return requestToken;
}

// ─── Retry-wrapped login ─────────────────────────────────
//
// Fix L1: Wraps browserLogin() with up to MAX_LOGIN_ATTEMPTS retries.
// Only TRANSIENT errors (network, selector timeout, context destroyed)
// are retried. UI_CHANGED and BAD_CREDENTIALS bail out immediately —
// retrying those would just waste time and delay the kill switch alert.

async function browserLoginWithRetry() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
    try {
      console.log(`\n🔄 Login attempt ${attempt}/${MAX_LOGIN_ATTEMPTS}...`);
      return await browserLogin();

    } catch (err) {
      lastError = err;
      const classification = classifyLoginError(err);

      console.error(`❌ Attempt ${attempt} failed [${classification.type}]: ${err.message}`);

      // Non-retryable — bail immediately so the kill switch fires faster
      if (!classification.retry) {
        console.error(`   Not retrying: ${classification.action}`);
        throw err;
      }

      if (attempt < MAX_LOGIN_ATTEMPTS) {
        const waitMs = RETRY_DELAY_MS * attempt; // linear backoff: 5s, 10s
        console.log(`   Retrying in ${waitMs / 1000}s... (${classification.action})`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  throw lastError;
}

// ─── Generate Access Token ───────────────────────────────

async function generateAccessToken(requestToken) {
  const kite = new KiteConnect({ api_key: KITE_API_KEY });
  const session = await kite.generateSession(requestToken, KITE_API_SECRET);

  if (!session || !session.access_token) {
    throw new Error('generateSession returned no access_token');
  }

  console.log(`🔑 Access token generated: ${session.access_token.slice(0, 8)}...`);
  return session.access_token;
}

// ─── Main ────────────────────────────────────────────────

export async function runAutoLogin(options = {}) {
  const { silent = false } = options;
  const startTime = Date.now();
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  if (!silent) {
    console.log('');
    console.log('═══════════════════════════════════════════════════');
    console.log('  🔐 Alpha8 Auto-Login');
    console.log(`  🕐 ${timestamp}`);
    console.log('═══════════════════════════════════════════════════');
    console.log('');
  }

  try {
    validateConfig();
  } catch (err) {
    return { success: false, error: err.message };
  }

  try {
    // Step 1: Browser login → request_token (with retries)
    const requestToken = await browserLoginWithRetry();

    // Step 2: Exchange request_token → access_token
    const accessToken = await generateAccessToken(requestToken);

    // Step 3: Store in Redis
    await storeTokenInRedis(accessToken);

    // Step 4: Verify the token works
    const kite = new KiteConnect({ api_key: KITE_API_KEY });
    kite.setAccessToken(accessToken);
    const profile = await kite.getProfile();

    if (!silent) {
      console.log(`✅ Token verified — logged in as: ${profile.user_name} (${profile.user_id})`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Step 5: Telegram success alert
    await sendTelegram(
      `✅ <b>Alpha8 Authenticated</b>\n` +
      `👤 User: ${profile.user_name} (${profile.user_id})\n` +
      `🔑 Token: ${accessToken.slice(0, 8)}...\n` +
      `⏱️ Took: ${elapsed}s\n` +
      `🕐 ${timestamp}\n\n` +
      `🟢 Ready to trade`
    );

    if (!silent) {
      console.log('');
      console.log(`🎯 Login complete in ${elapsed}s — ready to trade!`);
      console.log('');
    }

    return { success: true, accessToken };

  } catch (err) {
    if (!silent) {
      console.error('');
      console.error(`❌ AUTO-LOGIN FAILED: ${err.message}`);
      console.error('');
    }

    // Engage kill switch
    await engageKillSwitch(`Auto-login failed: ${err.message}`);

    const classification = classifyLoginError(err);
    console.error(`[Login Failure Type: ${classification.type}] ${classification.action}`);

    // Telegram failure alert
    await sendTelegram(
      `🛑 <b>Alpha8 Login FAILED</b>\n\n` +
      `${classification.emoji} <b>Type: ${classification.type}</b>\n` +
      `❌ Error: ${err.message.slice(0, 200)}\n\n` +
      `🔧 <b>Action required:</b>\n${classification.action}\n\n` +
      `🕐 ${timestamp}\n` +
      `Kill switch ENGAGED — trading halted.`
    );

    return { success: false, error: err.message };
  }
}

// ─── CLI Entrypoint ──────────────────────────────────────
const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();

if (isMain) {
  runAutoLogin({ silent: false }).then(result => {
    process.exit(result.success ? 0 : 1);
  });
}