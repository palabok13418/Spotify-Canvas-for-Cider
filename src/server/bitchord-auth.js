import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PREFIX = '[Spotify Canvas Server]';
const WEBPLAYER_URL = 'https://open.spotify.com/';
const CLIENT_TOKEN_URL = 'https://clienttoken.spotify.com/v1/clienttoken';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const AUTH_TIMEOUT_MS = 30000;
const TOKEN_SKEW_MS = 30000;

let cached = null;
let inFlight = null;

function log(...args) { console.log(PREFIX, ...args); }
function warn(...args) { console.warn(PREFIX, ...args); }

function pushCandidate(list, value, source) {
  if (!value) return;
  list.push({ path: value, source });
}

function registryAppPath(executableName) {
  if (process.platform !== 'win32') return [];
  const results = [];
  const queries = [
    ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + executableName, 'HKCU'],
    ['HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + executableName, 'HKLM'],
    ['HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + executableName, 'HKLM-WOW6432'],
  ];
  for (const [key, source] of queries) {
    try {
      const output = execFileSync('reg.exe', ['query', key, '/ve'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const match = output.match(/REG_SZ\s+(.+)$/im);
      if (match?.[1]) results.push({ path: match[1].trim(), source: `registry:${source}` });
    } catch {}
  }
  return results;
}

function findExecutable() {
  const candidates = [];

  if (process.platform === 'win32') {
    // Edge ships with Windows on supported Windows installations. Search the
    // browser itself rather than relying on Chrome being installed.
    const edgeRoots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
      process.env.PROGRAMW6432,
    ].filter(Boolean);
    for (const root of edgeRoots) {
      pushCandidate(candidates, path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'Edge-standard');
    }

    // Edge release channels.
    for (const root of edgeRoots) {
      for (const channel of ['Beta', 'Dev', 'Canary']) {
        pushCandidate(candidates, path.join(root, 'Microsoft', 'Edge', channel, 'Application', 'msedge.exe'), `Edge-${channel}`);
      }
    }

    // Chrome and common Chromium browsers remain fallbacks.
    const chromeRoots = edgeRoots;
    for (const root of chromeRoots) {
      pushCandidate(candidates, path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'Chrome');
      pushCandidate(candidates, path.join(root, 'Chromium', 'Application', 'chrome.exe'), 'Chromium');
      pushCandidate(candidates, path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'Brave');
      pushCandidate(candidates, path.join(root, 'Vivaldi', 'Application', 'vivaldi.exe'), 'Vivaldi');
      pushCandidate(candidates, path.join(root, 'Opera', 'launcher.exe'), 'Opera');
    }

    // App Paths is more reliable than hard-coded paths for per-user installs.
    for (const name of ['msedge.exe', 'chrome.exe', 'brave.exe', 'vivaldi.exe']) {
      candidates.push(...registryAppPath(name));
    }

    // Finally ask Windows' PATH.
    for (const command of ['msedge.exe', 'chrome.exe', 'brave.exe', 'vivaldi.exe']) {
      try {
        const found = execFileSync('where.exe', [command], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        }).split(/\r?\n/).find(Boolean);
        if (found) candidates.push({ path: found.trim(), source: `PATH:${command}` });
      } catch {}
    }
  } else if (process.platform === 'darwin') {
    [
      ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Edge'],
      ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Chrome'],
      ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'Brave'],
      ['/Applications/Vivaldi.app/Contents/MacOS/Vivaldi', 'Vivaldi'],
    ].forEach(([value, source]) => pushCandidate(candidates, value, source));
  } else {
    [
      ['/usr/bin/microsoft-edge', 'Edge'],
      ['/usr/bin/microsoft-edge-stable', 'Edge-stable'],
      ['/usr/bin/google-chrome', 'Chrome'],
      ['/usr/bin/chromium', 'Chromium'],
      ['/usr/bin/chromium-browser', 'Chromium-browser'],
      ['/usr/bin/brave-browser', 'Brave'],
      ['/usr/bin/vivaldi', 'Vivaldi'],
    ].forEach(([value, source]) => pushCandidate(candidates, value, source));
    for (const command of ['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'chromium', 'brave-browser', 'vivaldi']) {
      try {
        const found = execFileSync('which', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).find(Boolean);
        if (found) candidates.push({ path: found.trim(), source: `PATH:${command}` });
      } catch {}
    }
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const value = String(candidate?.path || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (fs.existsSync(value)) return candidate;
  }
  return null;
}

function classifyError(error) {
  const status = error?.status ?? error?.response?.status ?? null;
  const code = error?.code || '';
  if (code === 'BROWSER_UNAVAILABLE') return error;
  if (status === 401) {
    const e = new Error('Spotify rejected the supplied sp_dc session (HTTP 401).');
    e.code = 'INVALID_SP_DC'; e.status = 401; return e;
  }
  if (status === 403) {
    const e = new Error('Spotify rejected the supplied sp_dc session (HTTP 403).');
    e.code = 'SPOTIFY_ACCESS_RESTRICTED'; e.status = 403; return e;
  }
  return error;
}

async function harvest(spDc) {
  const browserCandidate = findExecutable();
  if (!browserCandidate) {
    const e = new Error('No usable Chromium browser was found. Microsoft Edge is checked first, then Chrome/Brave/Vivaldi/Chromium.');
    e.code = 'BROWSER_UNAVAILABLE';
    throw e;
  }

  log('Using browser for Spotify web-player authentication', {
    browser: browserCandidate.source,
    executablePath: browserCandidate.path
  });

  const browser = await chromium.launch({
    executablePath: browserCandidate.path,
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage']
  });

  try {
    const context = await browser.newContext({ userAgent: UA, locale: 'en-US' });
    await context.addCookies([
      { name: 'sp_dc', value: spDc, domain: '.spotify.com', path: '/', secure: true },
      { name: 'sp_dc', value: spDc, domain: 'open.spotify.com', path: '/', secure: true },
    ]);

    let tokenPayload = null;
    let resolveToken;
    const tokenPromise = new Promise(resolve => { resolveToken = resolve; });
    const page = await context.newPage();

    page.on('response', async response => {
      if (!response.url().includes('/api/token')) return;
      try {
        const payload = await response.json();
        if (payload?.accessToken && !payload?.isAnonymous) {
          tokenPayload = payload;
          resolveToken(payload);
        }
      } catch {}
    });

    log('BitChord-style web-player auth: opening Spotify Web Player');
    const response = await page.goto(WEBPLAYER_URL, { waitUntil: 'domcontentloaded', timeout: AUTH_TIMEOUT_MS });
    if (response && response.status() >= 400 && response.status() !== 429) {
      const e = new Error(`Spotify Web Player returned HTTP ${response.status()}`);
      e.status = response.status();
      throw classifyError(e);
    }

    tokenPayload = tokenPayload || await Promise.race([
      tokenPromise,
      page.waitForTimeout(AUTH_TIMEOUT_MS).then(() => null)
    ]);

    if (!tokenPayload?.accessToken) {
      const e = new Error('Spotify Web Player did not mint a logged-in access token from the supplied sp_dc session.');
      e.code = 'INVALID_SP_DC';
      throw e;
    }

    const cookies = await context.cookies([WEBPLAYER_URL]);
    const spT = cookies.find(cookie => cookie.name === 'sp_t')?.value || crypto.randomUUID();
    const html = await page.content();
    const clientVersion = extractClientVersion(html) || '1.2.61.20.g3b4cd5b2';
    const clientId = tokenPayload.clientId || null;

    let clientToken = null;
    if (clientId) {
      clientToken = await mintClientToken({ clientId, clientVersion, deviceId: spT });
    }

    const expiresAt = Number(tokenPayload.accessTokenExpirationTimestampMs) || Date.now() + 3600000;
    log('BitChord-style web-player auth succeeded', {
      expiresAt,
      hasClientToken: Boolean(clientToken),
      clientVersion,
      deviceIdSource: cookies.some(cookie => cookie.name === 'sp_t') ? 'sp_t' : 'generated'
    });

    return { accessToken: tokenPayload.accessToken, clientToken, clientId, clientVersion, deviceId: spT, expiresAt };
  } finally {
    await browser.close();
  }
}

function extractClientVersion(html) {
  const match = html.match(/<script[^>]+id=["']appServerConfig["'][^>]*>([^<]+)<\/script>/i);
  if (!match) return null;
  try {
    const raw = Buffer.from(match[1].trim(), 'base64').toString('utf8');
    const parsed = JSON.parse(raw);
    return parsed?.clientVersion || null;
  } catch {
    return null;
  }
}

async function mintClientToken({ clientId, clientVersion, deviceId }) {
  const body = {
    client_data: {
      client_version: clientVersion,
      client_id: clientId,
      js_sdk_data: {
        device_brand: 'unknown',
        device_model: 'unknown',
        os: process.platform === 'win32' ? 'windows' : process.platform,
        os_version: os.release(),
        device_id: deviceId,
        device_type: 'computer'
      }
    }
  };

  const response = await fetch(CLIENT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    warn('BitChord-style client token request failed', { status: response.status });
    return null;
  }
  if (data?.response_type !== 'RESPONSE_GRANTED_TOKEN_RESPONSE') {
    warn('Spotify client token was not granted', { responseType: data?.response_type || null });
    return null;
  }
  return data?.granted_token?.token || null;
}

export async function getAuth(spDc, { forceRefresh = false } = {}) {
  const cookie = String(spDc || '').trim();
  if (!cookie) {
    const e = new Error('Missing sp_dc');
    e.code = 'MISSING_SP_DC';
    throw e;
  }
  const now = Date.now();
  if (!forceRefresh && cached && cached.spDc === cookie && now < cached.auth.expiresAt - TOKEN_SKEW_MS) return cached.auth;
  if (inFlight) return inFlight;
  inFlight = harvest(cookie)
    .then(auth => {
      cached = { spDc: cookie, auth };
      return auth;
    })
    .catch(error => { throw classifyError(error); })
    .finally(() => { inFlight = null; });
  return inFlight;
}

export async function getToken(spDc, options = {}) {
  const auth = await getAuth(spDc, options);
  return auth.accessToken;
}

export async function getClientToken(spDc, options = {}) {
  const auth = await getAuth(spDc, options);
  return auth.clientToken;
}
