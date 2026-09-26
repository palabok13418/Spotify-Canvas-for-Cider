import { clearAuth, loadAuth, saveAuth } from './storage';
import {
  muteActiveSpotifyComputer,
  refreshSpotifyToken,
  resolveSpotifyTrack,
  MUS_API_BASE,
  type SpotifyTrack
} from './musApi';
import {
  ensureSpotifyWebPlayer,
  getSpotifyWebPlayerState,
  pauseSpotifyWebPlayer,
  playSpotifyWebTrack,
  startSpotifyWebPlayerSession,
  stopSpotifyWebPlayerSession,
} from './spotifyWebPlayer';

export type BridgeStatus = 'disabled' | 'link-required' | 'linked' | 'spotify-required' | 'ready' | 'syncing' | 'error';

export interface BridgeSnapshot {
  status: BridgeStatus;
  message: string;
  ciderTitle?: string;
  ciderArtist?: string;
  spotifyTrack?: SpotifyTrack | null;
}

type Listener = (snapshot: BridgeSnapshot) => void;
const listeners = new Set<Listener>();

let enabled = true;

let lastCiderKey = '';
let lastSpotifyUri = '';
let lastPlaying = false;
let lastCiderPositionMs = 0;
let lastObservedAt = 0;
let lastPositionSyncAt = 0;

let spotifyAccessToken = '';
let spotifyAccessTokenExpiresAt = 0;
let lastDeviceMuteTrack = '';
let lastDeviceMuteAt = 0;
let deviceVolumeControlUnavailableUntil = 0;
let muteGeneration = 0;

let currentResolvedTrack: SpotifyTrack | null = null;
let lastMatchAttemptKey = '';
let lastMatchAttemptAt = 0;

let busy = false;
let timer = 0;
let loginWindowOpened = false;
let eventListenersInstalled = false;
const eventCleanup: Array<() => void> = [];
let lastLoggedCiderKey = '';
let lastLoggedStatus = '';

const RUNTIME_KEY = '__CIDER_SPOTIFY_NOTES_BRIDGE_RUNTIME__';
const runtimeOwner = {};


const PREFIX = '[Spotify Notes Bridge]';
function log(message: string, details?: unknown) {
  if (details === undefined) console.info(PREFIX, message);
  else console.info(PREFIX, message, details);
}

function warn(message: string, details?: unknown) {
  if (details === undefined) console.warn(PREFIX, message);
  else console.warn(PREFIX, message, details);
}

function errorLog(message: string, details?: unknown) {
  if (details === undefined) console.error(PREFIX, message);
  else console.error(PREFIX, message, details);
}

let currentSnapshot: BridgeSnapshot = {
  status: 'link-required',
  message: 'Link Spotify through Mus-API to start mirroring.'
};

export function getSnapshot() {
  return currentSnapshot;
}

export function onBridgeChange(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setEnabled(value: boolean) {
  enabled = value;

  if (value) {
    if (!loadAuth()) {
      promptSpotifyLogin();
      emit({ status: 'link-required', message: 'Spotify login required. A Spotify login window has been opened.' });
    } else {
      startSpotifyWebPlayerSession();
      emit({ status: 'linked', message: 'Spotify login is active. Starting the background Web Player.' });
    }
    void syncOnce();
    return;
  }

  muteGeneration++;
  pauseSpotifyWebPlayer();
  emit({ status: 'disabled', message: 'Spotify mirroring is paused.' });
}

export function isEnabled() {
  return enabled;
}

function emit(snapshot: BridgeSnapshot) {
  currentSnapshot = snapshot;

  const statusKey = `${snapshot.status}|${snapshot.message}`;
  if (statusKey !== lastLoggedStatus) {
    lastLoggedStatus = statusKey;
    log('status', {
      status: snapshot.status,
      message: snapshot.message,
      ciderTitle: snapshot.ciderTitle || null,
      ciderArtist: snapshot.ciderArtist || null,
    });
  }
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {}
  }
}

function ensureSpotifyLinked() {
  if (loadAuth()) return true;
  promptSpotifyLogin();
  emit({
    status: 'link-required',
    message: 'Spotify login is required. A Spotify login window has been opened.',
  });
  return false;
}
function getCiderTrack() {
  const store = (globalThis as any).__PLUGINSYS__?.Stores?.appleMusicStore;
  if (!store) {
    if (lastLoggedStatus !== 'no-store') {
      lastLoggedStatus = 'no-store';
      warn('Cider appleMusicStore is not available yet');
    }
    return null;
  }

  const item = store.nowPlayingItem ?? null;
  if (!item) {
    if (lastLoggedStatus !== 'no-now-playing') {
      lastLoggedStatus = 'no-now-playing';
      log('Cider has no now-playing item yet');
    }
    return null;
  }

  const attrs = item.attributes ?? item;

  const title = String(
    attrs.name ||
    attrs.title ||
    attrs.trackName ||
    item.name ||
    ''
  ).trim();

  const artist = String(
    attrs.artistName ||
    attrs.artist ||
    item.artistName ||
    ''
  ).trim();

  const album = String(
    attrs.albumName ||
    attrs.album ||
    item.albumName ||
    ''
  ).trim();

  const isrc = String(
    attrs.isrc ||
    attrs.isrcCode ||
    attrs.extendedAssetMetadata?.isrc ||
    item.isrc ||
    ''
  ).trim();

  const durationMs = toMs(
    attrs.durationInMillis ??
    attrs.durationMs ??
    item.durationInMillis ??
    item.durationMs
  );

  const id = String(
    item.id ||
    item.playParams?.id ||
    attrs.playParams?.id ||
    attrs.playParams?.catalogId ||
    ''
  ).trim();

  const positionMs = readPositionMs(store, item, attrs);

  const mediaSessionPlaybackState =
    typeof navigator.mediaSession?.playbackState === 'string'
      ? navigator.mediaSession.playbackState
      : '';

  let playingSource = 'none';
  let playing = false;

  if (typeof store.isPlaying === 'boolean') {
    playing = store.isPlaying;
    playingSource = 'appleMusicStore.isPlaying';
  } else if (mediaSessionPlaybackState === 'playing' || mediaSessionPlaybackState === 'paused') {
    playing = mediaSessionPlaybackState === 'playing';
    playingSource = 'navigator.mediaSession.playbackState';
  } else if (typeof store.audioElement?.paused === 'boolean') {
    playing = !store.audioElement.paused;
    playingSource = 'appleMusicStore.audioElement.paused';
  } else if (typeof store.player?.paused === 'boolean') {
    playing = !store.player.paused;
    playingSource = 'appleMusicStore.player.paused';
  }

  if (!title || !artist) {
    warn('Cider now-playing item exists but title/artist could not be read', {
      hasAttributes: Boolean(item.attributes),
      rawId: item.id || item.playParams?.id || null,
    });
    return null;
  }

  const key = [
    id,
    title,
    artist,
    album,
    durationMs || 0
  ].map((value) => String(value).trim().toLowerCase()).join('|');

  const track = {
    key,
    title,
    artist,
    album,
    isrc,
    durationMs,
    id,
    positionMs,
    playing
  };

  if (track.key !== lastLoggedCiderKey) {
    lastLoggedCiderKey = track.key;
    log('Cider track detected', {
      title: track.title,
      artist: track.artist,
      album: track.album || null,
      isrc: track.isrc || null,
      durationMs: track.durationMs || null,
      positionMs: track.positionMs,
      playing: track.playing,
      playingSource,
      mediaSessionPlaybackState: mediaSessionPlaybackState || null,
      id: track.id || null,
    });
  }

  return track;
}

function readPositionMs(store: any, item: any, attrs: any) {
  const candidates = [
    store.currentPlaybackTime,
    store.currentTime,
    store.playbackTime,
    store.player?.currentTime,
    store.audioElement?.currentTime,
    item.currentPlaybackTime,
    item.currentTime,
    item.playbackTime,
    attrs.currentPlaybackTime,
    attrs.currentTime
  ];

  for (const raw of candidates) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) continue;
    return value > 100_000 ? Math.floor(value) : Math.floor(value * 1000);
  }

  return 0;
}

function toMs(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

async function findSpotifyTrack(cider: {
  title: string;
  artist: string;
  album: string;
  isrc: string;
  durationMs: number;
}) {
  // Mus-API is the only track-resolution path. It can use the same
  // stronger matcher as the working Canvas resolver when its local
  // BitChord matcher cannot confidently identify the track.
  log('resolving Cider track through Mus-API', {
    title: cider.title,
    artist: cider.artist,
    album: cider.album || null,
    durationMs: cider.durationMs || null,
    isrc: cider.isrc || null,
  });

  try {
    const result = await resolveSpotifyTrack({
      title: cider.title,
      artist: cider.artist,
      album: cider.album,
      durationMs: cider.durationMs,
      isrc: cider.isrc,
    });

    if (result) {
      log('Spotify track resolved', {
        id: result.id,
        uri: result.uri,
        name: result.name,
        artists: result.artists,
        album: result.album || null,
        durationMs: result.durationMs || null,
      });
    } else {
      warn('Mus-API returned no Spotify track match');
    }

    return result;
  } catch (err: any) {
    warn('Mus-API track resolution failed', {
      status: err?.status || null,
      message: String(err?.message || err || 'unknown error'),
      detail: err?.detail || null,
    });
    return null;
  }
}
async function getSpotifyApiAccessToken(forceRefresh = false) {
  const now = Date.now();

  if (
    !forceRefresh &&
    spotifyAccessToken &&
    spotifyAccessTokenExpiresAt > now + 60_000
  ) {
    return spotifyAccessToken;
  }

  const auth = loadAuth();
  if (!auth?.refreshToken) return null;

  try {
    const refreshed = await refreshSpotifyToken(auth.refreshToken);
    spotifyAccessToken = refreshed.accessToken;
    spotifyAccessTokenExpiresAt = Number(refreshed.tokenExpMs) || now + 3_300_000;

    if (refreshed.refreshToken && refreshed.refreshToken !== auth.refreshToken) {
      saveAuth({
        ...auth,
        refreshToken: refreshed.refreshToken,
      });
    }

    return spotifyAccessToken;
  } catch (error: any) {
    warn('could not refresh Spotify API access for automatic Web Player mute', {
      status: Number(error?.status) || 0,
      message: String(error?.message || error || 'unknown error'),
    });
    return null;
  }
}

async function automaticallyMuteSpotifyWebPlayer(reason: string) {
  const now = Date.now();

  if (!enabled || !lastSpotifyUri || !lastPlaying) return;
  if (now < deviceVolumeControlUnavailableUntil) return;

  if (
    lastDeviceMuteTrack === lastSpotifyUri &&
    now - lastDeviceMuteAt < 2_000
  ) {
    return;
  }

  lastDeviceMuteTrack = lastSpotifyUri;
  lastDeviceMuteAt = now;

  let accessToken = await getSpotifyApiAccessToken();
  if (!accessToken) return;

  try {
    const device = await muteActiveSpotifyComputer(accessToken);

    if (!device) {
      log('Spotify Web Player device was not visible as an active computer yet', {
        reason,
      });
      return;
    }

    log('automatically muted Spotify Web Player device', {
      reason,
      deviceName: device.name,
      deviceId: device.id,
      volumePercent: device.volumePercent,
    });
    return;
  } catch (error: any) {
    const status = Number(error?.status) || 0;

    // A short-lived 401 normally means the cached API token expired. Refresh
    // once and retry the exact same volume-zero operation.
    if (status === 401) {
      accessToken = await getSpotifyApiAccessToken(true);
      if (!accessToken) return;

      try {
        const device = await muteActiveSpotifyComputer(accessToken);
        if (device) {
          log('automatically muted Spotify Web Player device after token refresh', {
            reason,
            deviceName: device.name,
            deviceId: device.id,
            volumePercent: device.volumePercent,
          });
        }
        return;
      } catch (retryError: any) {
        warn('Spotify Web Player automatic mute retry failed', {
          status: Number(retryError?.status) || 0,
          message: String(retryError?.message || retryError || 'unknown error'),
        });
        return;
      }
    }

    if (status === 403) {
      // Do not recreate the old /me/player/devices 403 storm. Mute control is
      // retried later, but only after the Web Player has had time to reconnect.
      deviceVolumeControlUnavailableUntil = now + 60_000;
      warn('Spotify device-volume control is unavailable for this account/session; native WebView2 mute remains the fallback');
      return;
    }

    warn('Spotify Web Player automatic mute failed', {
      status,
      message: String(error?.message || error || 'unknown error'),
    });
  }
}

function scheduleAutomaticSpotifyMute(reason: string) {
  const generation = ++muteGeneration;
  const expectedUri = lastSpotifyUri;

  const attempt = (delayMs: number) => {
    window.setTimeout(() => {
      if (
        generation !== muteGeneration ||
        !enabled ||
        !lastPlaying ||
        lastSpotifyUri !== expectedUri
      ) {
        return;
      }

      void automaticallyMuteSpotifyWebPlayer(reason);
    }, delayMs);
  };

  // The Web Player needs a moment to become the active Connect device after
  // navigation. Try twice without polling the Spotify API continuously.
  attempt(2_500);
  attempt(5_500);
}

async function mirrorTrackInWebPlayer(track: SpotifyTrack, positionMs: number) {
  return playSpotifyWebTrack(track.uri, positionMs);
}

async function syncOnce() {
  if (!enabled || busy) return;

  const cider = getCiderTrack();
  if (!cider) return;

  const now = Date.now();
  const predictedPosition =
    lastObservedAt > 0 && lastPlaying
      ? lastCiderPositionMs + Math.max(0, now - lastObservedAt)
      : lastCiderPositionMs;

  const seekDetected =
    lastCiderKey === cider.key &&
    cider.playing &&
    lastPlaying &&
    Math.abs(cider.positionMs - predictedPosition) > 2_500 &&
    now - lastPositionSyncAt > 1_500;

  lastObservedAt = now;
  lastCiderPositionMs = cider.positionMs;

  if (!ensureSpotifyLinked()) return;

  busy = true;

  try {
    const trackChanged = cider.key !== lastCiderKey;
    const transportChanged = cider.playing !== lastPlaying;

    if (trackChanged) {
      const shouldTryMatch =
        cider.key !== lastMatchAttemptKey ||
        now - lastMatchAttemptAt >= 10_000 ||
        Boolean(currentResolvedTrack);

      if (shouldTryMatch) {
        lastMatchAttemptKey = cider.key;
        lastMatchAttemptAt = now;
        currentResolvedTrack = null;

        emit({
          status: 'syncing',
          message: `Finding “${cider.title}” on Spotify…`,
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
          spotifyTrack: null,
        });

        currentResolvedTrack = await findSpotifyTrack(cider);
      }

      if (!currentResolvedTrack) {
        emit({
          status: 'error',
          message: `Spotify match not found for “${cider.title}” by ${cider.artist}.`,
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
        });
        return;
      }

      lastCiderKey = cider.key;
      lastSpotifyUri = currentResolvedTrack.uri;
      lastPlaying = cider.playing;

      ensureSpotifyWebPlayer();

      if (!cider.playing) {
        pauseSpotifyWebPlayer();
        emit({
          status: 'ready',
          message: `Matched “${currentResolvedTrack.name}”. Cider is paused.`,
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
          spotifyTrack: currentResolvedTrack,
        });
        return;
      }

      const started = await mirrorTrackInWebPlayer(
        currentResolvedTrack,
        cider.positionMs
      );

      if (!started) {
        emit({
          status: 'spotify-required',
          message: 'The Spotify Web Player background window could not be opened.',
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
          spotifyTrack: currentResolvedTrack,
        });
        return;
      }

      emit({
        status: 'ready',
        message: `Playing “${currentResolvedTrack.name}” through Spotify Web Player.`,
        ciderTitle: cider.title,
        ciderArtist: cider.artist,
        spotifyTrack: currentResolvedTrack,
      });

      scheduleAutomaticSpotifyMute('track-start');

      return;
    }

    if (transportChanged) {
      if (cider.playing) {
        if (!lastSpotifyUri) {
          currentResolvedTrack = await findSpotifyTrack(cider);
          lastSpotifyUri = currentResolvedTrack?.uri || '';
        }

        if (!lastSpotifyUri) {
          emit({
            status: 'error',
            message: `Spotify match not found for “${cider.title}”.`,
            ciderTitle: cider.title,
            ciderArtist: cider.artist,
          });
          return;
        }

        const started = playSpotifyWebTrack(
          lastSpotifyUri,
          cider.positionMs
        );
        lastPlaying = true;

        emit({
          status: started ? 'ready' : 'spotify-required',
          message: started
            ? 'Resumed Spotify Web Player playback.'
            : 'The Spotify Web Player background window could not be opened.',
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
          spotifyTrack: currentResolvedTrack,
        });
        if (started) {
          scheduleAutomaticSpotifyMute('resume');
        }
      } else {
        pauseSpotifyWebPlayer();
        lastPlaying = false;

        emit({
          status: 'ready',
          message: 'Paused Spotify Web Player playback.',
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
          spotifyTrack: currentResolvedTrack,
        });
      }

      return;
    }

    if (seekDetected) {
      log('Cider seek detected; Spotify Web Player seek is not exposed to the plugin', {
        positionMs: cider.positionMs,
      });

      lastPositionSyncAt = now;

      emit({
        status: 'ready',
        message: 'Mirroring playback; seek control is not available through the public Spotify Web Player page.',
        ciderTitle: cider.title,
        ciderArtist: cider.artist,
        spotifyTrack: currentResolvedTrack,
      });
    } else {
      const playerState = getSpotifyWebPlayerState();

      emit({
        status: playerState.available ? 'ready' : 'spotify-required',
        message: playerState.available
          ? 'Spotify Web Player background session is active.'
          : 'Spotify Web Player background session is unavailable.',
        ciderTitle: cider.title,
        ciderArtist: cider.artist,
        spotifyTrack: currentResolvedTrack,
      });
    }
  } catch (error: any) {
    const status = Number(error?.status || 0);
    const message = String(error?.message || error || 'Spotify bridge error');

    errorLog('sync operation failed', {
      status,
      message,
      cider: {
        title: cider.title,
        artist: cider.artist,
        album: cider.album || null,
        playing: cider.playing,
      },
    });

    emit({
      status: status === 401 ? 'link-required' : 'error',
      message: status === 401
        ? 'Spotify login session needs to be linked again.'
        : message,
      ciderTitle: cider.title,
      ciderArtist: cider.artist,
      spotifyTrack: currentResolvedTrack,
    });
  } finally {
    lastPlaying = cider.playing;
    busy = false;
  }
}

export function promptSpotifyLogin() {
  if (!enabled || loadAuth() || loginWindowOpened) return false;

  log('opening Spotify Web Player background session and Spotify OAuth login popup through Mus-API');

  startSpotifyWebPlayerSession();
  loginWindowOpened = true;
  const origin = window.location.origin === 'null' ? '*' : window.location.origin;
  const url = new URL('/api/spotify/auth', MUS_API_BASE);
  url.searchParams.set('origin', origin);
  url.searchParams.set('returnTo', window.location.href);
  url.searchParams.set('reason', 'first-run-mirroring');

  const popup = window.open(
    url.toString(),
    'musapi-spotify-auth',
    'width=520,height=760,resizable=yes,scrollbars=yes'
  );

  if (!popup) {
    loginWindowOpened = false;
    emit({
      status: 'link-required',
      message: 'Spotify login is required. Open the Spotify login window from the plugin panel.',
    });
    return false;
  }

  emit({
    status: 'link-required',
    message: 'Log in to Spotify in the new window to enable playback mirroring.',
  });

  return true;
}
function installPlaybackEventListeners() {
  if (eventListenersInstalled) return;

  const papi = (globalThis as any).__PLUGINSYS__?.PAPIInstance;
  if (!papi || typeof papi.addEventListener !== 'function') {
    warn('Cider PAPI event system is not available; using polling fallback only');
    return;
  }

  for (const eventName of ['player:state_changed', 'playback:state_changed']) {
    const listener = () => {
      log('Cider playback event received', { event: eventName });
      void syncOnce();
    };

    papi.addEventListener(eventName, listener);
    eventCleanup.push(() => {
      try { papi.removeEventListener?.(eventName, listener); } catch {}
    });
  }

  eventListenersInstalled = true;
  log('Cider playback event listeners installed');
}

function removePlaybackEventListeners() {
  while (eventCleanup.length) {
    const cleanup = eventCleanup.pop();
    try { cleanup?.(); } catch {}
  }
  eventListenersInstalled = false;
}

export function startBridge() {
  if (timer) {
    log('startBridge() ignored because bridge is already running');
    return;
  }

  const existingRuntime = (globalThis as any)[RUNTIME_KEY];
  if (existingRuntime?.active && existingRuntime.owner !== runtimeOwner) {
    warn('another Spotify Notes Bridge instance is already active', {
      startedAt: existingRuntime.startedAt || null,
    });
    return;
  }

  (globalThis as any)[RUNTIME_KEY] = {
    active: true,
    owner: runtimeOwner,
    startedAt: Date.now(),
  };

  log('bridge starting', {
    enabled,
    hasStoredAuth: Boolean(loadAuth()),
    musApiBase: MUS_API_BASE,
    syncIntervalMs: 1200,
  });

  if (!loadAuth()) {
    promptSpotifyLogin();
  } else {
    log('stored Spotify OAuth link found');
    startSpotifyWebPlayerSession();
  }

  installPlaybackEventListeners();

  timer = window.setInterval(() => {
    void syncOnce();
  }, 1_200);
  void syncOnce();
}

export function stopBridge() {
  muteGeneration++;
  spotifyAccessToken = '';
  spotifyAccessTokenExpiresAt = 0;

  if (timer) window.clearInterval(timer);
  timer = 0;
  removePlaybackEventListeners();
  stopSpotifyWebPlayerSession();

  const runtime = (globalThis as any)[RUNTIME_KEY];
  if (runtime?.owner === runtimeOwner) {
    delete (globalThis as any)[RUNTIME_KEY];
  }

  log('bridge stopped');
}

export function handleOAuthMessage(data: any) {
  if (!data?.ok || !data.accessToken) {
    warn('received an invalid Spotify OAuth callback payload');
    return false;
  }

  log('Spotify OAuth callback received', {
    hasRefreshToken: Boolean(data.refreshToken),
    tokenExpMs: Number(data.tokenExpMs) || null,
  });

  if (data.refreshToken) {
    saveAuth({
      refreshToken: String(data.refreshToken),
      savedAt: Date.now(),
    });
  }

  lastCiderKey = '';
  lastSpotifyUri = '';
  currentResolvedTrack = null;
  lastMatchAttemptKey = '';
  lastMatchAttemptAt = 0;
  lastPlaying = false;
  lastCiderPositionMs = 0;
  lastObservedAt = 0;

  loginWindowOpened = false;

  spotifyAccessToken = String(data.accessToken);
  spotifyAccessTokenExpiresAt =
    Number(data.tokenExpMs) || Date.now() + 3_300_000;

  deviceVolumeControlUnavailableUntil = 0;
  lastDeviceMuteTrack = '';
  lastDeviceMuteAt = 0;

  startSpotifyWebPlayerSession();

  emit({
    status: 'linked',
    message: 'Spotify login succeeded. Background Web Player session started.'
  });

  void syncOnce();
  return true;
}

function formatTime(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}
