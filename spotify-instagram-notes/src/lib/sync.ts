import { loadAuth, saveAuth } from './storage';
import { listDevices, pausePlayback, playTrack, refreshSpotifyToken, resolveSpotifyTrack, spotifyApi, MUS_API_BASE, type SpotifyDevice, type SpotifyTrack } from './musApi';

export type BridgeStatus = 'disabled' | 'link-required' | 'spotify-required' | 'ready' | 'syncing' | 'error';

export interface BridgeSnapshot {
  status: BridgeStatus;
  message: string;
  ciderTitle?: string;
  ciderArtist?: string;
  spotifyTrack?: SpotifyTrack | null;
  phoneDevice?: SpotifyDevice | null;
}

type Listener = (snapshot: BridgeSnapshot) => void;
const listeners = new Set<Listener>();

let enabled = true;
let accessToken = '';
let tokenExpMs = 0;
let refreshToken = '';
let phoneDevice: SpotifyDevice | null = null;
let phoneCheckedAt = 0;

let lastCiderKey = '';
let lastSpotifyUri = '';
let lastPlaying = false;
let lastCiderPositionMs = 0;
let lastObservedAt = 0;
let lastPositionSyncAt = 0;

let currentResolvedTrack: SpotifyTrack | null = null;
let lastMatchAttemptKey = '';
let lastMatchAttemptAt = 0;

let busy = false;
let timer = 0;
let loginWindowOpened = false;
let eventListenersInstalled = false;
const eventCleanup: Array<() => void> = [];
let controlBlockedUntil = 0;
let lastLoggedCiderKey = '';
let lastLoggedStatus = '';

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
    controlBlockedUntil = 0;
    promptSpotifyLogin();
    emit(
      loadAuth()
        ? currentSnapshot
        : { status: 'link-required', message: 'Spotify login required. A Spotify login window has been opened.' }
    );
    void syncOnce();
    return;
  }

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
      phone: snapshot.phoneDevice?.name || null,
    });
  }
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {}
  }
}

async function ensureToken() {
  if (accessToken && tokenExpMs > Date.now() + 30_000) {
    return accessToken;
  }

  const stored = loadAuth();
  if (!stored?.refreshToken) {
    warn('no stored Spotify OAuth refresh token');
    throw new Error('Spotify is not linked');
  }

  refreshToken = stored.refreshToken;
  log('refreshing Spotify OAuth access token');
  const token = await refreshSpotifyToken(refreshToken);

  accessToken = token.accessToken;
  tokenExpMs = token.tokenExpMs;
  refreshToken = token.refreshToken || refreshToken;

  saveAuth({
    refreshToken,
    scope: token.scope || stored.scope,
    savedAt: Date.now()
  });

  log('Spotify OAuth token ready', {
    scope: token.scope || stored.scope || null,
    expiresInSeconds: Math.max(0, Math.floor((tokenExpMs - Date.now()) / 1000)),
  });

  return accessToken;
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
async function getPhone(force = false): Promise<SpotifyDevice | null> {
  const now = Date.now();

  if (!force && phoneDevice && now - phoneCheckedAt < 8_000) {
    return phoneDevice;
  }

  const token = await ensureToken();
  log('requesting Spotify Connect devices');

  const devices = await listDevices(token);

  log('Spotify Connect devices received', {
    count: devices.length,
    devices: devices.map((device) => ({
      id: device.id,
      name: device.name,
      type: device.type,
      active: device.isActive,
      restricted: device.isRestricted,
    })),
  });

  const phones = devices.filter(
    (device) =>
      device.type.toLowerCase() === 'smartphone' &&
      !device.isRestricted
  );

  phoneDevice =
    phones.find((device) => device.isActive) ||
    phones[0] ||
    null;

  phoneCheckedAt = now;

  log('phone device selection', {
    selected: phoneDevice
      ? {
          id: phoneDevice.id,
          name: phoneDevice.name,
          type: phoneDevice.type,
          active: phoneDevice.isActive,
          restricted: phoneDevice.isRestricted,
        }
      : null,
  });

  return phoneDevice;
}

async function seekOnPhone(positionMs: number) {
  if (!phoneDevice || !lastSpotifyUri) return;

  const token = await ensureToken();

  await spotifyApi(
    token,
    `/me/player/seek?position_ms=${Math.max(0, Math.floor(positionMs))}&device_id=${encodeURIComponent(phoneDevice.id)}`,
    'PUT'
  );

  lastPositionSyncAt = Date.now();
}

async function playResolvedOnPhone(token: string, track: SpotifyTrack, positionMs: number) {
  let phone = await getPhone();

  if (!phone) {
    warn('no smartphone Spotify device is available');
    return null;
  }

  log('sending playback command to phone', {
    phone: phone.name,
    deviceId: phone.id,
    uri: track.uri,
    positionMs,
  });

  try {
    await playTrack(token, phone.id, track.uri, positionMs);
    log('phone playback command succeeded', {
      phone: phone.name,
      uri: track.uri,
    });
  } catch (error: any) {
    if (Number(error?.status) !== 404 && Number(error?.status) !== 502) {
      throw error;
    }

    phone = await getPhone(true);
    if (!phone) return null;

    log('retrying playback command after stale device response', {
      phone: phone.name,
      deviceId: phone.id,
    });

    await playTrack(token, phone.id, track.uri, positionMs);
    log('phone playback retry succeeded', {
      phone: phone.name,
      uri: track.uri,
    });
  }

  phoneDevice = phone;
  lastPositionSyncAt = Date.now();
  return phone;
}

async function syncOnce() {
  if (!enabled || busy) return;

  if (Date.now() < controlBlockedUntil) return;

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

  busy = true;

  try {
    const token = await ensureToken();
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
          phoneDevice
        });

        currentResolvedTrack = await findSpotifyTrack(cider);
      }

      if (!currentResolvedTrack) {
        emit({
          status: 'error',
          message: `Spotify match not found for “${cider.title}” by ${cider.artist}.`,
          ciderTitle: cider.title,
          ciderArtist: cider.artist
        });
        return;
      }

      lastCiderKey = cider.key;
      lastSpotifyUri = currentResolvedTrack.uri;
      lastPlaying = cider.playing;

      if (!cider.playing) {
        emit({
          status: 'ready',
          message: `Matched “${currentResolvedTrack.name}”. Cider is paused.`,
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
          spotifyTrack: currentResolvedTrack,
          phoneDevice
        });
        return;
      }

      const phone = await playResolvedOnPhone(
        token,
        currentResolvedTrack,
        cider.positionMs
      );

      if (!phone) {
        emit({
          status: 'spotify-required',
          message: 'Open Spotify on your phone so it appears as a playback device.',
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
          spotifyTrack: currentResolvedTrack
        });
        return;
      }

      emit({
        status: 'ready',
        message: `Playing “${currentResolvedTrack.name}” on ${phone.name}.`,
        ciderTitle: cider.title,
        ciderArtist: cider.artist,
        spotifyTrack: currentResolvedTrack,
        phoneDevice: phone
      });

      return;
    }

    if (cider.playing && lastSpotifyUri && !phoneDevice && now - phoneCheckedAt >= 8_000) {
      const phone = await playResolvedOnPhone(
        token,
        currentResolvedTrack || {
          id: '',
          uri: lastSpotifyUri,
          name: cider.title,
          artists: [cider.artist],
          album: cider.album,
          durationMs: cider.durationMs
        },
        cider.positionMs
      );

      if (phone) {
        lastPlaying = true;
        emit({
          status: 'ready',
          message: `Playing Spotify on ${phone.name}.`,
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
          spotifyTrack: currentResolvedTrack,
          phoneDevice: phone
        });
      }

      return;
    }

    if (transportChanged) {
      const phone = phoneDevice || await getPhone();

      if (!phone) {
        emit({
          status: 'spotify-required',
          message: 'Open Spotify on your phone so it appears as a playback device.',
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
          spotifyTrack: currentResolvedTrack
        });
        return;
      }

      if (!lastSpotifyUri) {
        currentResolvedTrack = await findSpotifyTrack(cider);
        lastSpotifyUri = currentResolvedTrack?.uri || '';
      }

      if (!lastSpotifyUri) {
        emit({
          status: 'error',
          message: `Spotify match not found for “${cider.title}”.`,
          ciderTitle: cider.title,
          ciderArtist: cider.artist
        });
        return;
      }

      if (cider.playing) {
        await playTrack(token, phone.id, lastSpotifyUri, cider.positionMs);
        lastPlaying = true;
        lastPositionSyncAt = Date.now();

        emit({
          status: 'ready',
          message: `Resumed Spotify on ${phone.name}.`,
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
          spotifyTrack: currentResolvedTrack,
          phoneDevice: phone
        });
      } else {
        await pausePlayback(token, phone.id);
        lastPlaying = false;

        emit({
          status: 'ready',
          message: `Paused Spotify on ${phone.name}.`,
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
          spotifyTrack: currentResolvedTrack,
          phoneDevice: phone
        });
      }

      phoneDevice = phone;
      return;
    }

    if (seekDetected) {
      await seekOnPhone(cider.positionMs);

      if (phoneDevice) {
        emit({
          status: 'ready',
          message: `Seeked Spotify to ${formatTime(cider.positionMs)} on ${phoneDevice.name}.`,
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
          spotifyTrack: currentResolvedTrack,
          phoneDevice
        });
      }
    } else {
      emit({
        status: phoneDevice ? 'ready' : 'spotify-required',
        message: phoneDevice
          ? `Mirroring to ${phoneDevice.name}.`
          : 'Open Spotify on your phone so it appears as a playback device.',
        ciderTitle: cider.title,
        ciderArtist: cider.artist,
        spotifyTrack: currentResolvedTrack,
        phoneDevice
      });
    }
  } catch (error: any) {
    const status = Number(error?.status || 0);
    const message = String(error?.message || error || 'Spotify bridge error');
    const detail = String(error?.detail || '').trim();
    const endpoint = String(error?.spotifyPath || '').trim();

    errorLog('sync operation failed', {
      status,
      message,
      detail: detail || null,
      endpoint: endpoint || null,
      cider: {
        title: cider.title,
        artist: cider.artist,
        album: cider.album || null,
        playing: cider.playing,
      },
    });

    if (status === 401) {
      accessToken = '';
      tokenExpMs = 0;
      controlBlockedUntil = 0;
      emit({
        status: 'link-required',
        message: 'Spotify authorization expired. Relink Spotify through Mus-API.',
        ciderTitle: cider.title,
        ciderArtist: cider.artist
      });
    } else if (status === 403) {
      // A 403 does not mean the OAuth token is expired. Keep it and back off
      // briefly so we don't refresh the same valid token over and over.
      controlBlockedUntil = Date.now() + 15_000;

      if (cider.key === lastCiderKey) {
        lastCiderKey = '';
        lastSpotifyUri = '';
        currentResolvedTrack = null;
      }

      emit({
        status: 'error',
        message: endpoint
          ? `Spotify rejected ${endpoint} with HTTP 403.`
          : 'Spotify rejected the playback request with HTTP 403.',
        ciderTitle: cider.title,
        ciderArtist: cider.artist
      });
    } else if (/not linked/i.test(message) || /refresh/i.test(message)) {
      emit({
        status: 'link-required',
        message: 'Link Spotify through Mus-API before mirroring playback.',
        ciderTitle: cider.title,
        ciderArtist: cider.artist
      });
    } else {
      emit({
        status: 'error',
        message,
        ciderTitle: cider.title,
        ciderArtist: cider.artist
      });
    }
  } finally {
    lastPlaying = cider.playing;
    busy = false;
  }
}

export function promptSpotifyLogin() {
  if (!enabled || loadAuth() || loginWindowOpened) return false;

  log('opening Spotify OAuth login popup through Mus-API');

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

  log('bridge starting', {
    enabled,
    hasStoredAuth: Boolean(loadAuth()),
    musApiBase: MUS_API_BASE,
    syncIntervalMs: 1200,
  });

  if (!loadAuth()) {
    promptSpotifyLogin();
  } else {
    log('stored Spotify OAuth refresh token found');
  }

  installPlaybackEventListeners();

  timer = window.setInterval(() => {
    void syncOnce();
  }, 1_200);
  void syncOnce();
}

export function stopBridge() {
  if (timer) window.clearInterval(timer);
  timer = 0;
  removePlaybackEventListeners();
  log('bridge stopped');
}

export function handleOAuthMessage(data: any) {
  if (!data?.ok || !data.accessToken) {
    warn('received an invalid Spotify OAuth callback payload');
    return false;
  }

  log('Spotify OAuth callback received', {
    scope: data.scope || null,
    hasRefreshToken: Boolean(data.refreshToken),
    tokenExpMs: Number(data.tokenExpMs) || null,
  });

  accessToken = String(data.accessToken);
  tokenExpMs = Number(data.tokenExpMs) || Date.now() + 3_300_000;

  if (data.refreshToken) {
    refreshToken = String(data.refreshToken);
    saveAuth({
      refreshToken,
      scope: data.scope || undefined,
      savedAt: Date.now()
    });
  }

  controlBlockedUntil = 0;
  phoneDevice = null;
  phoneCheckedAt = 0;
  lastCiderKey = '';
  lastSpotifyUri = '';
  currentResolvedTrack = null;
  lastMatchAttemptKey = '';
  lastMatchAttemptAt = 0;
  lastPlaying = false;
  lastCiderPositionMs = 0;
  lastObservedAt = 0;

  loginWindowOpened = false;

  emit({
    status: 'ready',
    message: 'Spotify linked. Waiting for your current Cider track.'
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
