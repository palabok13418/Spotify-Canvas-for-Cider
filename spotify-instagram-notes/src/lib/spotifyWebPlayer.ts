import { loadAuth } from './storage';
import { refreshSpotifyToken, spotifyPlayOnDevice } from './musApi';

const PREFIX = '[Spotify Notes Bridge]';
const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const PLAYER_NAME = 'Cider Spotify Notes Bridge';
const HOST_ID = 'cider-spotify-notes-background-player';

type SpotifySdkPlayer = {
  connect: () => Promise<boolean>;
  disconnect: () => Promise<void>;
  pause: () => Promise<void>;
  togglePlay: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  getCurrentState: () => Promise<any>;
  activateElement?: () => Promise<void>;
  addListener: (event: string, callback: (data: any) => void) => void;
  removeListener?: (event: string, callback: (data: any) => void) => void;
};

declare global {
  interface Window {
    Spotify?: {
      Player: new (options: {
        name: string;
        volume?: number;
        enableMediaSession?: boolean;
        getOAuthToken: (callback: (token: string) => void) => void;
      }) => SpotifySdkPlayer;
    };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

let sdkPromise: Promise<void> | null = null;
let player: SpotifySdkPlayer | null = null;
let deviceId = '';
let connected = false;
let currentTrackId = '';
let currentPlaying = false;
let lastState: any = null;
let accessToken = '';
let accessTokenExpiresAt = 0;
let hostElement: HTMLDivElement | null = null;

function log(message: string, details?: unknown) {
  if (details === undefined) console.info(PREFIX, message);
  else console.info(PREFIX, message, details);
}

function warn(message: string, details?: unknown) {
  if (details === undefined) console.warn(PREFIX, message);
  else console.warn(PREFIX, message, details);
}

async function getAccessToken(forceRefresh = false) {
  const auth = loadAuth();
  if (!auth?.refreshToken) return null;

  const now = Date.now();

  if (!forceRefresh && accessToken && accessTokenExpiresAt > now + 60_000) {
    return accessToken;
  }

  try {
    const token = await refreshSpotifyToken(auth.refreshToken);
    accessToken = token.accessToken;
    accessTokenExpiresAt = Number(token.tokenExpMs) || now + 3_300_000;
    return accessToken;
  } catch (error) {
    warn('could not refresh Spotify Web Playback SDK token', error);
    accessToken = '';
    accessTokenExpiresAt = 0;
    return null;
  }
}

function ensureHiddenHost() {
  if (hostElement?.isConnected) return hostElement;

  const existing = document.getElementById(HOST_ID) as HTMLDivElement | null;
  if (existing) {
    hostElement = existing;
    return existing;
  }

  const element = document.createElement('div');
  element.id = HOST_ID;
  element.setAttribute('aria-hidden', 'true');
  element.setAttribute('data-cider-background-player', 'true');

  Object.assign(element.style, {
    position: 'fixed',
    left: '-100000px',
    top: '-100000px',
    width: '1px',
    height: '1px',
    minWidth: '1px',
    minHeight: '1px',
    maxWidth: '1px',
    maxHeight: '1px',
    opacity: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
    visibility: 'hidden',
    zIndex: '-2147483648',
  });

  document.body.appendChild(element);
  hostElement = element;
  return element;
}

function loadSdk() {
  if (window.Spotify?.Player) return Promise.resolve();
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-cider-spotify-web-playback-sdk="true"]',
    );

    if (existing) {
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
      const timeout = window.setTimeout(() => {
        if (!window.Spotify?.Player) {
          reject(new Error('Spotify Web Playback SDK load timed out'));
        }
      }, 15000);
      existing.addEventListener('load', () => {
        window.clearTimeout(timeout);
        if (window.Spotify?.Player) resolve();
      }, { once: true });
      existing.addEventListener('error', () => {
        window.clearTimeout(timeout);
        reject(new Error('Spotify Web Playback SDK failed to load'));
      }, { once: true });
      return;
    }

    window.onSpotifyWebPlaybackSDKReady = () => resolve();

    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.dataset.ciderSpotifyWebPlaybackSdk = 'true';
    script.addEventListener('error', () => {
      reject(new Error('Spotify Web Playback SDK failed to load'));
    }, { once: true });

    document.head.appendChild(script);

    window.setTimeout(() => {
      if (!window.Spotify?.Player) {
        reject(new Error('Spotify Web Playback SDK load timed out'));
      }
    }, 15000);
  }).catch((error) => {
    sdkPromise = null;
    throw error;
  });

  return sdkPromise;
}

async function waitForPlayerReady() {
  if (!player || connected) return Boolean(player && deviceId);

  const connectedResult = await player.connect();
  connected = Boolean(connectedResult);

  if (!connected) {
    warn('Spotify Web Playback SDK failed to connect');
    return false;
  }

  return Boolean(deviceId);
}

async function createPlayer() {
  if (player) return waitForPlayerReady();

  const token = await getAccessToken();
  if (!token) {
    warn('Spotify Web Playback SDK cannot start without a Spotify token');
    return false;
  }

  ensureHiddenHost();
  await loadSdk();

  if (!window.Spotify?.Player) {
    warn('Spotify Web Playback SDK did not expose Spotify.Player');
    return false;
  }

  player = new window.Spotify.Player({
    name: PLAYER_NAME,
    getOAuthToken: async (callback) => {
      const nextToken = await getAccessToken();
      callback(nextToken || '');
    },
    volume: 0,
    enableMediaSession: false,
  });

  player.addListener('ready', ({ device_id }) => {
    deviceId = String(device_id || '');
    connected = true;

    void player?.setVolume(0).catch(() => undefined);

    log('headless Spotify player is ready', {
      deviceId,
      volume: 0,
    });
  });

  player.addListener('not_ready', ({ device_id }) => {
    if (String(device_id || '') === deviceId) {
      connected = false;
    }

    warn('headless Spotify player went offline', {
      deviceId: String(device_id || deviceId || ''),
    });
  });

  player.addListener('initialization_error', ({ message }) => {
    warn('Spotify Web Playback SDK initialization error', { message });
  });

  player.addListener('authentication_error', ({ message }) => {
    accessToken = '';
    accessTokenExpiresAt = 0;
    warn('Spotify Web Playback SDK authentication error', { message });
  });

  player.addListener('account_error', ({ message }) => {
    warn('Spotify Web Playback SDK account error', { message });
  });

  player.addListener('player_state_changed', (state) => {
    lastState = state;
    currentPlaying = Boolean(state && !state.paused);
  });

  return waitForPlayerReady();
}

export function isSpotifyWebPlayerAvailable() {
  return Boolean(player && connected && deviceId);
}

export async function ensureSpotifyWebPlayer() {
  return createPlayer();
}

export async function startSpotifyWebPlayerSession() {
  return createPlayer();
}

export async function playSpotifyWebTrack(uri: string, positionMs = 0) {
  const match = String(uri || '').match(/^spotify:track:([A-Za-z0-9]+)$/);
  const trackId = match?.[1] || '';

  if (!trackId) {
    warn('cannot start Spotify background player because the Spotify URI is invalid', { uri });
    return false;
  }

  const ready = await createPlayer();
  if (!ready || !player || !deviceId) return false;

  const token = await getAccessToken();
  if (!token) return false;

  currentTrackId = trackId;
  currentPlaying = true;

  try {
    // Keep the SDK locally silent. The player still exists as a Spotify
    // Connect device, but it contributes no audible output to Cider.
    await player.setVolume(0);

    const started = await spotifyPlayOnDevice(
      token,
      deviceId,
      uri,
      Math.max(0, Math.floor(positionMs)),
    );

    if (!started) {
      warn('Spotify refused playback on the headless SDK device', {
        deviceId,
        trackId,
      });
      return false;
    }

    log('started Spotify track on headless background player', {
      trackId,
      deviceId,
      positionMs: Math.max(0, Math.floor(positionMs)),
      volume: 0,
    });

    return true;
  } catch (error) {
    warn('failed to start Spotify track on headless background player', error);
    currentPlaying = false;
    return false;
  }
}

export async function muteSpotifyWebPlayer() {
  if (!player) return false;

  try {
    await player.setVolume(0);
    return true;
  } catch (error) {
    warn('failed to mute headless Spotify player', error);
    return false;
  }
}

export async function pauseSpotifyWebPlayer() {
  if (!player) {
    currentPlaying = false;
    return false;
  }

  try {
    await player.pause();
    currentPlaying = false;
    return true;
  } catch (error) {
    warn('failed to pause headless Spotify player', error);
    return false;
  }
}

export async function resumeSpotifyWebPlayer() {
  if (!player) return false;

  try {
    await player.togglePlay();
    currentPlaying = true;
    return true;
  } catch (error) {
    warn('failed to resume headless Spotify player', error);
    return false;
  }
}

export async function seekSpotifyWebPlayer(positionMs: number) {
  if (!player) return false;

  try {
    await player.seek(Math.max(0, Math.floor(positionMs)));
    return true;
  } catch (error) {
    warn('failed to seek headless Spotify player', error);
    return false;
  }
}

export async function getSpotifyWebPlayerPlaybackState() {
  if (!player) return null;

  try {
    const state = await player.getCurrentState();
    if (state) {
      lastState = state;
      currentPlaying = !state.paused;
    }
    return state;
  } catch (error) {
    warn('failed to read headless Spotify player state', error);
    return lastState;
  }
}

export function stopSpotifyWebPlayerSession() {
  if (player) {
    void player.disconnect().catch(() => undefined);
  }

  player = null;
  connected = false;
  deviceId = '';
  currentTrackId = '';
  currentPlaying = false;
  lastState = null;

  if (hostElement?.isConnected) {
    hostElement.remove();
  }

  hostElement = null;
  sdkPromise = null;
  log('headless Spotify background player stopped');
}

export function getSpotifyWebPlayerState() {
  return {
    available: isSpotifyWebPlayerAvailable(),
    trackId: currentTrackId || null,
    playing: currentPlaying,
    deviceId: deviceId || null,
  };
}
