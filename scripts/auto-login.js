#!/usr/bin/env node

/**
 * Alpha8 — Automated Zerodha Daily Login
 *
 * Automates the Kite Connect login flow:
 *   1. Opens Kite login page in headless Chromium (Puppeteer)
 *   2. Enters user ID + password
 *   3. Generates TOTP from secret (via otplib — no phone needed)
 *   4. Submits TOTP → extracts request_token from redirect URL
 *   5. Calls Kite API generateSession() → access_token
 *   6. Stores access_token in Redis with 24hr TTL
 *   7. Sends Telegram alert on success or failure
 *   8. On failure: engages kill switch
 *
 * Usage:
 *   node scripts/auto-login.js          # Run once
 *   npm run login                       # Via package.json script
 *
 * Cron (8:00 AM IST daily):
 *   Configured in src/scheduler or system crontab
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

// ─── Telegram ────────────────────

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
        redis = new Redis(url, {
          keyPrefix: 'alpha8:',
          lazyConnect: true,
          family: 4
        });

        await redis.connect();
        await redis.set(REDIS_KEY, valueToStore, 'EX', REDIS_TTL);
        console.log(`✅ Access token stored in Redis (key: alpha8:${REDIS_KEY}, TTL: 24h)`);
        return; // Success!
      } finally {
        // Always release connection regardless of outcome
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

  // All retries failed — write to fallback file
  console.error('❌ All Redis attempts failed — writing token to fallback file');
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const fallbackPath = path.join(process.cwd(), '.token_fallback');
    await fs.writeFile(fallbackPath, accessToken, 'utf-8');
    console.log(`⚠ Token written to ${fallbackPath} — MANUAL RECOVERY NEEDED`);
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
      redis = new Redis(url, {
        keyPrefix: 'alpha8:',
        lazyConnect: true,
        family: 4
      });

      await redis.connect();
      const killState = JSON.stringify({
        engaged: true,
        reason,
        engagedAt: new Date().toISOString(),
        drawdownPct: 0,
      });
      await redis.set('risk:kill_switch', killState);
      console.log('🛑 Kill switch ENGAGED in Redis');
    } finally {
      // Always release connection regardless of outcome
      if (redis) await redis.quit();
    }
  } catch (err) {
    console.error('Failed to engage kill switch in Redis:', err.message);
  }
}

function classifyLoginError(err) {
  const msg = (err.message || '').toLowerCase();

  if (msg.includes('totp input field') || msg.includes('debug-totp-not-found')) {
    return {
      type: 'UI_CHANGED',
      emoji: '🔧',
      action: 'Zerodha login UI may have changed. Check selector in scripts/auto-login.js browserLogin(). Screenshot saved to scripts/debug-totp-not-found.png',
    };
  }
  if (msg.includes('redirect timed out') || msg.includes('no request_token')) {
    return {
      type: 'UI_CHANGED',
      emoji: '🔧',
      action: 'Login redirect failed. Zerodha UI may have changed. Screenshot saved to scripts/debug-redirect-timeout.png',
    };
  }
  if (msg.includes('invalid') && (msg.includes('totp') || msg.includes('otp'))) {
    return {
      type: 'BAD_CREDENTIALS',
      emoji: '🔑',
      action: 'TOTP is invalid. Check ZERODHA_TOTP_SECRET in .env — it may have changed.',
    };
  }
  if (msg.includes('invalid') || msg.includes('incorrect') || msg.includes('wrong')) {
    return {
      type: 'BAD_CREDENTIALS',
      emoji: '🔑',
      action: 'Credentials rejected. Check ZERODHA_USER_ID and ZERODHA_PASSWORD in .env',
    };
  }
  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('network')) {
    return {
      type: 'TRANSIENT',
      emoji: '🌐',
      action: 'Network/timeout error. Will retry automatically at next scheduled run.',
    };
  }

  return {
    type: 'UNKNOWN',
    emoji: '❓',
    action: 'Unknown failure. Check logs for full stack trace.',
  };
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
    ],
  });

  let requestToken = null;

  try {
    // S3 FIX: Use the default browser context's first page to avoid opening two windows
    // (createBrowserContext() triggers a separate incognito window in non-headless mode)
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    // Set viewport and user-agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // ─── Step 1: Navigate to Kite login ──────────────
    console.log('📄 Opening Kite login page...');
    await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // ─── Step 2: Enter User ID ───────────────────────
    console.log('👤 Entering user ID...');
    await page.waitForSelector('input[type="text"]', { timeout: 10000 });
    await page.type('input[type="text"]', ZERODHA_USER_ID, { delay: 50 });

    // ─── Step 3: Enter Password ──────────────────────
    console.log('🔑 Entering password...');
    await page.type('input[type="password"]', ZERODHA_PASSWORD, { delay: 50 });

    // ─── Step 4: Click Login ─────────────────────────
    console.log('🔘 Clicking login...');
    // S3 FIX: Wrap click in Promise.all to handle navigation reliably
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {
        console.log('   (Navigation wait timed out or skipped — checking for TOTP screen next)');
      }),
      page.click('button[type="submit"]')
    ]);

    // ─── Step 5: Wait for TOTP page ──────────────────────────────
    console.log('⏳ Waiting for TOTP input...');

    await page.waitForFunction(
      () => {
        const inputs = document.querySelectorAll('input[type="text"], input[type="number"], input[autocomplete="one-time-code"]');
        for (const inp of inputs) {
          if (inp.offsetParent !== null && !inp.value) return true;
        }
        return false;
      },
      { timeout: 15000 }
    );

    // Short structural delay — just enough for the input to be interactive
    await new Promise((r) => setTimeout(r, 500));

    // ─── Step 6: Find TOTP input FIRST, then generate code ───────
    // S3 FIX: Use a more atomic evaluation to find the input to avoid context destruction
    const totpSelector = 'input[type="text"], input[type="number"], input[autocomplete="one-time-code"]';
    await page.waitForSelector(totpSelector, { visible: true, timeout: 10000 });

    const totpInput = await page.evaluateHandle((sel) => {
      const inputs = Array.from(document.querySelectorAll(sel));
      return inputs.find(inp => inp.offsetParent !== null && !inp.value);
    }, totpSelector);

    if (!totpInput || !totpInput.asElement()) {
      await page.screenshot({ path: 'scripts/debug-totp-not-found.png', fullPage: true });
      throw new Error('Could not find TOTP input field (screenshot saved to scripts/debug-totp-not-found.png)');
    }

    // S3 FIX: generate TOTP HERE, immediately before typing.
    // At this point the page is fully loaded and the input is found.
    const totpGenerator = new TOTP({ secret: ZERODHA_TOTP_SECRET });
    const totp = totpGenerator.generate();
    console.log(`🔐 Generated TOTP: ${totp.slice(0, 2)}****`);

    await totpInput.type(totp, { delay: 80 });

    // ─── Step 7: Submit TOTP ─────────────────────────────────────
    // Wait for potential auto-submit before clicking button
    await new Promise((r) => setTimeout(r, 800));

    // S3 FIX: check if there's an error before clicking submit.
    // If the code expired (unlikely now but possible), we'll see an error.
    const pageError = await page.evaluate(() => {
      const errorSelectors = ['.error-message', '.alert-danger', '[class*="error"]'];
      for (const sel of errorSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) return el.textContent.trim();
      }
      return null;
    });

    if (pageError && pageError.toLowerCase().includes('otp')) {
      // S3 FIX: TOTP error detected — regenerate and retry once
      console.log(`⚠️ TOTP error detected ("${pageError.slice(0, 50)}") — regenerating and retrying`);
      await new Promise((r) => setTimeout(r, 2000)); // wait for next 30s window

      // Clear the input
      await totpInput.evaluate(el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });

      const retryTotp = totpGenerator.generate();
      console.log(`🔐 Retry TOTP: ${retryTotp.slice(0, 2)}****`);
      await totpInput.type(retryTotp, { delay: 80 });
      await new Promise((r) => setTimeout(r, 800));
    }

    // ─── Step 7: Submit TOTP ─────────────────────────────────────
    console.log('🔘 Submitting TOTP...');
    try {
      const submitBtn = await page.$('button[type="submit"]');
      if (submitBtn) {
        // S3 FIX: Ensure we wait for the navigation triggered by the submit click
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {
            console.log('   (Submit navigation wait timed out — check redirect URL)');
          }),
          submitBtn.click()
        ]);
      }
    } catch (err) {
      console.log(`   (Submit interaction feedback: ${err.message})`);
    }

    // ─── Step 8: Wait for redirect with request_token ─
    console.log('⏳ Waiting for redirect...');

    // Wait for URL to change away from kite.zerodha.com (redirect to API key's redirect URL)
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
    } catch (waitErr) {
      // Capture screenshot for debugging
      await page.screenshot({ path: 'scripts/debug-redirect-timeout.png', fullPage: true });
      const currentUrl = page.url();
      const pageText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
      throw new Error(
        `Redirect timed out.\n` +
        `  Current URL: ${currentUrl}\n` +
        `  Page content: ${pageText.slice(0, 200)}\n` +
        `  Debug screenshot: scripts/debug-redirect-timeout.png`
      );
    }

    const finalUrl = page.url();
    console.log(`🔗 Redirect URL: ${finalUrl.slice(0, 100)}...`);

    // Extract request_token from URL
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
    // Step 1: Browser login → request_token
    const requestToken = await browserLogin();

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
      `❌ Error: ${err.message}\n\n` +
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
    if (!result.success) process.exit(1);
    process.exit(0);
  });
}
