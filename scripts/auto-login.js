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
 * FIXES:
 *
 *   L1 — Retry the entire browser login flow up to MAX_LOGIN_ATTEMPTS times.
 *        Transient failures (slow render, navigation race) recover automatically.
 *
 *   L2 — Multiple selector fallbacks for every input field.
 *        Tried in specificity order — first visible, enabled match wins.
 *        Survives minor Zerodha DOM changes without a code update.
 *
 *   L3 — Navigation race condition eliminated.
 *        waitForNavigation() is registered BEFORE any click or type that
 *        could trigger a page transition.
 *
 *   L3b — Zerodha TOTP auto-submit handled correctly.
 *        Zerodha auto-submits the moment the 6th TOTP digit is typed —
 *        no button click occurs. waitForNavigation must be registered
 *        before typing begins, not after. A 2 s race window detects
 *        auto-submit; manual button click is used only as a fallback.
 *
 *   L4 — "Execution context was destroyed" caught and retried rather than
 *        immediately engaging the kill switch.
 *
 *   L5 — Error classification extended: selector timeout and context
 *        destroyed are classified TRANSIENT (retry) not UNKNOWN (kill switch).
 *
 *   L6 — TOTP generated immediately before type() to minimise expiry risk.
 *
 *   L7 — Unexpected dialogs auto-dismissed so they never freeze Puppeteer.
 *
 *   L8 — Images, fonts, and media blocked for ~40% faster page loads.
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
const REDIS_TTL = 24 * 60 * 60; // 24 hours

// L1: retry config
const MAX_LOGIN_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

// ─── Selector pools (L2) ─────────────────────────────────
//
// Tried in order — first visible + enabled match wins.
// Specific selectors first, generic last-resort at the end.

const USERID_SELECTORS = [
  'input#userid',
  'input[name="user_id"]',
  'input[autocomplete="username"]',
  'input[placeholder*="User ID"]',
  'input[placeholder*="user ID"]',
  'input[type="text"]',
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
  'input[type="text"]',
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

// ─── Redis Helper ─────────────────────────────────────────

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

// ─── Kill Switch Helper ───────────────────────────────────

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

// ─── Error Classification (L5) ───────────────────────────

function classifyLoginError(err) {
  const msg = (err.message || '').toLowerCase();

  // L5a: selector timeout — transient slow render
  if (
    msg.includes('waiting for selector') ||
    msg.includes('failed to find element') ||
    (msg.includes('selector') && msg.includes('failed'))
  ) {
    return {
      type: 'TRANSIENT',
      emoji: '🌐',
      action: 'Selector timeout — Zerodha page rendered slowly. Will retry automatically.',
      retry: true,
    };
  }

  // L5b: execution context destroyed — navigation race
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
      action: 'Zerodha login UI may have changed. Check selectors in scripts/auto-login.js. Screenshot saved.',
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

// ─── Puppeteer Helpers ────────────────────────────────────

/**
 * Find the first visible, enabled element matching any of the given selectors.
 * L2: Centralised selector-pool resolution used for every input field.
 */
async function findElement(page, selectors, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const handle = await page.evaluateHandle((sel) => {
          const els = Array.from(document.querySelectorAll(sel));
          return els.find(el =>
            el.offsetParent !== null &&
            !el.disabled &&
            el.offsetWidth > 0 &&
            el.offsetHeight > 0
          ) || null;
        }, selector);

        const element = handle.asElement();
        if (element) return element;
      } catch {
        // destroyed context or bad selector — try next
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }

  throw new Error(
    `No visible element found for selectors: [${selectors.join(', ')}] within ${timeoutMs}ms`
  );
}

/**
 * Click a submit button and wait for the resulting navigation.
 * L3: Navigation listener registered BEFORE the click.
 */
async function clickAndWaitForNav(page, submitSelectors, timeoutMs = 20000) {
  // Register nav listener BEFORE clicking — eliminates the race window
  const navPromise = page.waitForNavigation({
    waitUntil: 'networkidle2',
    timeout: timeoutMs,
  }).catch(() => null);

  const btn = await findElement(page, submitSelectors, 5000).catch(() => null);
  if (btn) {
    await btn.click();
  } else {
    await page.keyboard.press('Enter');
  }

  await navPromise;
  await new Promise(r => setTimeout(r, 500));
}

// ─── Browser Login Flow ───────────────────────────────────

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

    // L7: Auto-dismiss unexpected dialogs that would freeze Puppeteer
    page.on('dialog', async (dialog) => {
      console.log(`⚠️  Auto-dismissing dialog: "${dialog.message().slice(0, 80)}"`);
      await dialog.accept().catch(() => { });
    });

    // L8: Block images/fonts/media for ~40% faster page loads
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

    // ─── Step 2: Enter User ID ────────────────────────────
    console.log('👤 Entering user ID...');
    const userIdInput = await findElement(page, USERID_SELECTORS, 15000);
    await userIdInput.click({ clickCount: 3 });
    await userIdInput.type(ZERODHA_USER_ID, { delay: 50 });

    // ─── Step 3: Enter Password ───────────────────────────
    console.log('🔑 Entering password...');
    const passwordInput = await findElement(page, PASSWORD_SELECTORS, 10000);
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(ZERODHA_PASSWORD, { delay: 50 });

    // ─── Step 4: Submit credentials ───────────────────────
    // L3: nav listener registered inside clickAndWaitForNav before click
    console.log('🔘 Submitting credentials...');
    await clickAndWaitForNav(page, SUBMIT_SELECTORS, 20000);

    // ─── Step 5: Wait for TOTP page ───────────────────────
    console.log('⏳ Waiting for TOTP input...');
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

    // ─── Step 6: Find TOTP input ──────────────────────────
    console.log('🔐 Locating TOTP input...');
    const totpInput = await findElement(page, TOTP_SELECTORS, 10000);

    if (!totpInput) {
      await page.screenshot({ path: 'scripts/debug-totp-not-found.png', fullPage: true });
      throw new Error('Could not find TOTP input field (debug-totp-not-found.png saved)');
    }

    // ─── Step 7: Type TOTP and handle auto-submit ─────────
    //
    // L3b FIX: Zerodha auto-submits the moment the 6th TOTP digit is
    // entered. The page navigates DURING type() — while Puppeteer is still
    // operating in the same frame. If waitForNavigation is set up after
    // type() the navigation event has already fired and any subsequent
    // page interaction throws "execution context was destroyed".
    //
    // Fix: register waitForNavigation BEFORE the first keystroke so the
    // event is captured regardless of how fast Zerodha's handler fires.
    // Then race the nav promise against a 2 s timeout:
    //   nav resolved  → auto-submit fired, skip button click entirely
    //   timeout fires → auto-submit didn't happen, fall back to manual click

    const totpGenerator = new TOTP({ secret: ZERODHA_TOTP_SECRET });

    /**
     * Type a TOTP code and wait to see whether Zerodha auto-submits.
     * Returns true if auto-submit was detected, false if a manual click
     * will be needed. Throws 'TOTP_INVALID:...' if Zerodha showed an error.
     */
    const typeAndDetectSubmit = async (totpCode) => {
      // MUST register before the first keystroke (L3b)
      const navPromise = page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 30000,
      }).catch(() => null);

      await totpInput.click({ clickCount: 3 });
      await totpInput.type(totpCode, { delay: 80 });

      // Give Zerodha's auto-submit handler up to 2 s to fire
      const autoSubmitted = await Promise.race([
        navPromise.then(() => true),
        new Promise(r => setTimeout(() => r(false), 2000)),
      ]);

      if (autoSubmitted) {
        console.log('✅ TOTP auto-submitted by Zerodha — navigation detected');
        return true;
      }

      // No auto-submit — check whether Zerodha displayed a validation error
      const pageError = await page.evaluate(() => {
        const sels = ['.error-message', '.alert-danger', '[class*="error"]', '.is-error'];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el && el.textContent.trim()) return el.textContent.trim();
        }
        return null;
      }).catch(() => null);

      if (
        pageError &&
        (pageError.toLowerCase().includes('otp') || pageError.toLowerCase().includes('invalid'))
      ) {
        throw new Error(`TOTP_INVALID: ${pageError.slice(0, 80)}`);
      }

      return false; // no error, no auto-submit — caller should click manually
    };

    // L6: generate TOTP immediately before typing
    const totp1 = totpGenerator.generate();
    console.log(`🔐 Generated TOTP: ${totp1.slice(0, 2)}****`);

    let autoSubmitted = false;
    try {
      autoSubmitted = await typeAndDetectSubmit(totp1);
    } catch (err) {
      if (!err.message.startsWith('TOTP_INVALID')) throw err;

      // TOTP rejected — wait for next 30 s window and retry once
      console.log(`⚠️  TOTP rejected: "${err.message.replace('TOTP_INVALID: ', '').slice(0, 60)}" — regenerating...`);
      await new Promise(r => setTimeout(r, 3000));

      await totpInput.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');

      const totp2 = totpGenerator.generate();
      console.log(`🔐 Retry TOTP: ${totp2.slice(0, 2)}****`);
      autoSubmitted = await typeAndDetectSubmit(totp2);
    }

    if (!autoSubmitted) {
      // Zerodha did not auto-submit — click the button manually
      console.log('🔘 Submitting TOTP manually (auto-submit did not fire)...');
      await clickAndWaitForNav(page, SUBMIT_SELECTORS, 30000);
    }

    // ─── Step 8: Wait for redirect with request_token ─────
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
      await page.screenshot({ path: 'scripts/debug-redirect-timeout.png', fullPage: true });
      const currentUrl = page.url();
      const pageText = await page.evaluate(
        () => document.body?.innerText?.slice(0, 300) || ''
      ).catch(() => '');
      throw new Error(
        `Redirect timed out.\n` +
        `  Current URL: ${currentUrl}\n` +
        `  Page snippet: ${pageText.slice(0, 150)}\n` +
        `  Debug screenshot: scripts/debug-redirect-timeout.png`
      );
    }

    const finalUrl = page.url();
    console.log(`🔗 Redirect URL: ${finalUrl.slice(0, 100)}...`);

    // ─── Step 9: Extract request_token ────────────────────
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

// ─── Retry-wrapped login (L1) ─────────────────────────────

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

      if (!classification.retry) {
        console.error(`   Not retrying: ${classification.action}`);
        throw err;
      }

      if (attempt < MAX_LOGIN_ATTEMPTS) {
        const waitMs = RETRY_DELAY_MS * attempt;
        console.log(`   Retrying in ${waitMs / 1000}s... (${classification.action})`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }

  throw lastError;
}

// ─── Generate Access Token ────────────────────────────────

async function generateAccessToken(requestToken) {
  const kite = new KiteConnect({ api_key: KITE_API_KEY });
  const session = await kite.generateSession(requestToken, KITE_API_SECRET);

  if (!session || !session.access_token) {
    throw new Error('generateSession returned no access_token');
  }

  console.log(`🔑 Access token generated: ${session.access_token.slice(0, 8)}...`);
  return session.access_token;
}

// ─── Main ─────────────────────────────────────────────────

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
    const requestToken = await browserLoginWithRetry();
    const accessToken = await generateAccessToken(requestToken);
    await storeTokenInRedis(accessToken);

    const kite = new KiteConnect({ api_key: KITE_API_KEY });
    kite.setAccessToken(accessToken);
    const profile = await kite.getProfile();

    if (!silent) {
      console.log(`✅ Token verified — logged in as: ${profile.user_name} (${profile.user_id})`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

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

    await engageKillSwitch(`Auto-login failed: ${err.message}`);

    const classification = classifyLoginError(err);
    console.error(`[Login Failure Type: ${classification.type}] ${classification.action}`);

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

// ─── CLI Entrypoint ───────────────────────────────────────
const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();

if (isMain) {
  runAutoLogin({ silent: false }).then(result => {
    process.exit(result.success ? 0 : 1);
  });
}