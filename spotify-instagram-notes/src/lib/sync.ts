import { clearAuth, loadAuth, saveAuth } from './storage';
import {
  completeSpotifyLogin,
  getSpotifySession,
  migrateLegacySpotifySession,
  resolveSpotifyTrack,
  MUS_API_BASE,
  type SpotifyTrack
} from './musApi';
import {
  ensureSpotifyWebPlayer,
  getSpotifyWebPlayerPlaybackState,
  getSpotifyWebPlayerState,
  muteSpotifyWebPlayer,
  pauseSpotifyWebPlayer,
  playSpotifyWebTrack,
  seekSpotifyWebPlayer,
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

let lastDeviceMuteTrack = '';
let lastDeviceMuteAt = 0;
let muteGeneration = 0;

let lastSpotifyClockCheckAt = 0;
let spotifyClockRetryUnavailableUntil = 0;

let currentResolvedTrack: SpotifyTrack | null = null;
let lastMatchAttemptKey = '';
let lastMatchAttemptAt = 0;

let busy = false;
let timer = 0;
let eventListenersInstalled = false;
let authValidated = false;
let authValidatedAt = 0;
let authValidationPromise: Promise<boolean> | null = null;
const AUTH_VALIDATION_TTL_MS = 5 * 60 * 1000;
let loginPromptHandler: (() => boolean | void) | null = null;
let loginPromptShown = false;
let lastAuthErrorAt = 0;
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
    loginPromptShown = false;
    void ensureSpotifyLinked();
    void syncOnce();
    return;
  }

  muteGeneration++;
  void pauseSpotifyWebPlayer();
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

async function ensureSpotifyLinked() {
  if (!enabled) return false;
  if (
    authValidated &&
    loadAuth()?.sessionTicket &&
    Date.now() - authValidatedAt < AUTH_VALIDATION_TTL_MS
  ) return true;

  if (authValidationPromise) return authValidationPromise;

  authValidationPromise = (async () => {
    const auth = loadAuth();

    const sessionCredential = auth?.sessionTicket || auth?.refreshToken;

    if (!sessionCredential) {
      authValidated = false;
      reportSpotifyUnauthenticated('no-stored-session');
      promptSpotifyLogin();
      emit({
        status: 'link-required',
        message: 'Spotify login is required.',
      });
      return false;
    }

    try {
      const session = auth?.sessionTicket
        ? await getSpotifySession(auth.sessionTicket)
        : await migrateLegacySpotifySession(sessionCredential);

      if (session.sessionTicket) {
        saveAuth({
          sessionTicket: session.sessionTicket,
          scope: auth?.scope,
          savedAt: Date.now(),
        });
      }

      authValidated = true;
      authValidatedAt = Date.now();

      log('Spotify user authentication detected', {
        authenticated: true,
        userIdPresent: Boolean(session.user?.id),
        product: session.product || null,
      });

      // Do not create/connect the hidden Spotify player until the Mus-API
      // session has been positively validated for this user.
      const playerReady = await startSpotifyWebPlayerSession();
      if (!playerReady) {
        warn('Spotify user is authenticated, but the background Web Player could not be started', {
          code: 'SPOTIFY_BACKGROUND_PLAYER_UNAVAILABLE',
        });
      } else {
        log('validated Spotify session is now attached to the background player');
      }

      return true;
    } catch (error: any) {
      const status = Number(error?.status || 0);
      const code = String(error?.code || '');

      if (status === 401 || code === 'SPOTIFY_AUTH_INVALID') {
        authValidated = false;
        authValidatedAt = 0;
        clearAuth();
        reportSpotifyUnauthenticated('stored-session-invalid', {
          status,
          code,
        });
        promptSpotifyLogin();
        emit({
          status: 'link-required',
          message: 'Spotify login is required.',
        });
        return false;
      }

      warn('could not validate the stored Spotify login session', {
        status,
        code,
        message: String(error?.message || error || 'unknown error'),
      });
      emit({
        status: 'error',
        message: 'Spotify login status could not be verified. Retrying…',
      });
      return false;
    }
  })().finally(() => {
    authValidationPromise = null;
  });

  return authValidationPromise;
}

function reportSpotifyUnauthenticated(reason: string, details: Record<string, unknown> = {}) {
  const now = Date.now();
  if (now - lastAuthErrorAt < 5_000) return;
  lastAuthErrorAt = now;

  errorLog('Spotify user is not authenticated', {
    code: 'SPOTIFY_USER_NOT_AUTHENTICATED',
    reason,
    ...details,
  });
}

export function setSpotifyLoginPromptHandler(handler: (() => boolean | void) | null) {
  loginPromptHandler = handler;
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
async function automaticallyMuteSpotifyWebPlayer(reason: string) {
  if (!enabled || !lastSpotifyUri || !lastPlaying) return;

  const now = Date.now();

  if (
    lastDeviceMuteTrack === lastSpotifyUri &&
    now - lastDeviceMuteAt < 2_000
  ) {
    return;
  }

  lastDeviceMuteTrack = lastSpotifyUri;
  lastDeviceMuteAt = now;

  const muted = await muteSpotifyWebPlayer();

  if (muted) {
    log('automatically muted headless Spotify player', {
      reason,
      deviceId: getSpotifyWebPlayerState().deviceId,
    });
  }
}

async function syncSpotifyClock(reason: string, force = false) {
  const now = Date.now();

  if (!enabled || !lastPlaying || !lastSpotifyUri) return;
  if (!force && now - lastSpotifyClockCheckAt < 1_500) return;
  if (!force && now < spotifyClockRetryUnavailableUntil) return;

  lastSpotifyClockCheckAt = now;

  try {
    const state = await getSpotifyWebPlayerPlaybackState();
    const observedAt = Date.now();

    if (!state) {
      log('headless Spotify player state is not available yet', { reason });
      return;
    }

    const currentUri = String(
      state?.track_window?.current_track?.uri ||
      state?.track_window?.current_track?.id ||
      ''
    ).trim();

    if (!currentUri || (currentUri !== lastSpotifyUri && !currentUri.endsWith(lastSpotifyUri))) {
      log('headless Spotify player is on a different track; waiting', {
        reason,
        spotifyTrackUri: currentUri || null,
        expectedTrackUri: lastSpotifyUri,
      });
      return;
    }

    const rawPosition = Number(state?.position);
    if (!Number.isFinite(rawPosition)) return;

    const spotifyNowMs =
      rawPosition +
      (!state.paused ? Math.max(0, observedAt - Number(state.timestamp || observedAt)) : 0);

    const ciderNowMs =
      lastCiderPositionMs +
      (lastPlaying
        ? Math.max(0, observedAt - lastObservedAt)
        : 0);

    const driftMs = spotifyNowMs - ciderNowMs;

    log('headless Spotify playback clock comparison', {
      reason,
      ciderMs: Math.floor(ciderNowMs),
      spotifyMs: Math.floor(spotifyNowMs),
      driftMs: Math.floor(driftMs),
      deviceId: getSpotifyWebPlayerState().deviceId,
    });

    if (Math.abs(driftMs) < 500) return;

    const targetMs = Math.max(0, Math.floor(ciderNowMs));

    await seekSpotifyWebPlayer(targetMs);

    lastPositionSyncAt = observedAt;

    // The SDK player is permanently muted. Re-assert after a seek because
    // playback state can reconnect/reset the local volume.
    await muteSpotifyWebPlayer();

    log('corrected headless Spotify playback clock', {
      reason,
      targetMs,
      driftMs: Math.floor(driftMs),
    });
  } catch (error: any) {
    warn('headless Spotify playback clock sync failed', {
      reason,
      status: Number(error?.status) || 0,
      message: String(error?.message || error || 'unknown error'),
      code: String(error?.code || ''),
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

  if (!(await ensureSpotifyLinked())) return;

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

      void ensureSpotifyWebPlayer();

      if (!cider.playing) {
        await pauseSpotifyWebPlayer();
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
      void syncSpotifyClock('track-start', true);

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

        const started = await playSpotifyWebTrack(
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
          void syncSpotifyClock('resume', true);
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
      log('Cider seek detected; correcting Spotify playback clock', {
        positionMs: cider.positionMs,
      });
      void syncSpotifyClock('cider-seek', true);

      emit({
        status: 'ready',
        message: 'Mirroring playback and correcting the background Spotify playback clock.',
        ciderTitle: cider.title,
        ciderArtist: cider.artist,
        spotifyTrack: currentResolvedTrack,
      });
    } else {
      void syncSpotifyClock('periodic-drift-check');

      const playerState = getSpotifyWebPlayerState();

      emit({
        status: playerState.available ? 'ready' : 'spotify-required',
        message: playerState.available
          ? 'Spotify Web Player background session is active; playback clock sync is enabled.'
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
  if (!enabled || loadAuth()) return false;

  const now = Date.now();
  if (loginPromptShown) return true;

  errorLog('Spotify login prompt requested because no authenticated user session is available', {
    code: 'SPOTIFY_LOGIN_REQUIRED',
  });

  if (!loginPromptHandler) {
    warn('Spotify login prompt handler is not installed yet');
    return false;
  }

  const opened = loginPromptHandler();
  if (opened !== false) {
    loginPromptShown = true;
    emit({
      status: 'link-required',
      message: 'Log in to Spotify to enable playback mirroring.',
    });
    return true;
  }

  return false;
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

  const hasStoredAuth = Boolean(loadAuth());

  log('bridge starting', {
    enabled,
    hasStoredAuth,
    musApiBase: MUS_API_BASE,
    syncIntervalMs: 1200,
  });

  if (!hasStoredAuth) {
    errorLog('Spotify user is not logged in; mirroring will remain blocked until the in-app Spotify login succeeds', {
      code: 'SPOTIFY_USER_NOT_AUTHENTICATED',
      action: 'OPEN_IN_APP_LOGIN',
    });
    emit({
      status: 'link-required',
      message: 'Spotify login is required before mirroring can start.',
    });
  }

  void ensureSpotifyLinked();

  installPlaybackEventListeners();

  timer = window.setInterval(() => {
    void syncOnce();
  }, 1_200);
  void syncOnce();
}

export function stopBridge() {
  muteGeneration++;
  lastSpotifyClockCheckAt = 0;
  spotifyClockRetryUnavailableUntil = 0;

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

export function handleOAuthMessage(data: any, expectedLoginNonce = '') {
  const loginTicket = String(data?.loginTicket || '').trim();
  const loginNonce = String(data?.loginNonce || expectedLoginNonce || '').trim();

  if (!loginNonce || loginNonce.length > 256) {
    errorLog('rejected Spotify OAuth callback because the login nonce was missing or invalid', {
      code: 'SPOTIFY_LOGIN_NONCE_INVALID',
      hasLoginTicket: Boolean(loginTicket),
      hasLoginNonce: Boolean(loginNonce),
    });
    emit({
      status: 'error',
      message: 'Spotify login returned an invalid secure session handoff.',
    });
    return false;
  }

  if (!data?.ok || !loginTicket) {
    warn('received an invalid Spotify OAuth callback payload', {
      code: 'SPOTIFY_LOGIN_TICKET_MISSING',
    });
    emit({
      status: 'error',
      message: 'Spotify login returned an invalid secure session handoff.',
    });
    return false;
  }

  log('Spotify OAuth callback received a secure encrypted login ticket', {
    authenticated: true,
    hasLoginTicket: true,
    hasLoginNonce: true,
    ticketForwardedToMusApi: true,
  });

  lastCiderKey = '';
  lastSpotifyUri = '';
  currentResolvedTrack = null;
  lastMatchAttemptKey = '';
  lastMatchAttemptAt = 0;
  lastPlaying = false;
  lastCiderPositionMs = 0;
  lastObservedAt = 0;

  authValidated = false;
  authValidatedAt = 0;
  loginPromptShown = false;
  lastAuthErrorAt = 0;

  spotifyClockRetryUnavailableUntil = 0;
  lastSpotifyClockCheckAt = 0;
  lastDeviceMuteTrack = '';
  lastDeviceMuteAt = 0;

  emit({
    status: 'syncing',
    message: 'Securing Spotify session…',
  });

  void completeSpotifyLogin(loginTicket, loginNonce)
    .then((session) => {
      if (!session.sessionTicket) {
        throw Object.assign(
          new Error('Spotify login did not return a secure session ticket'),
          { code: 'SPOTIFY_AUTH_SESSION_EMPTY', status: 502 }
        );
      }

      saveAuth({
        sessionTicket: session.sessionTicket,
        scope: typeof data?.scope === 'string' ? data.scope : undefined,
        savedAt: Date.now(),
      });

      authValidated = true;
      authValidatedAt = Date.now();

      log('Spotify account authenticated through Mus-API secure session handoff', {
        authenticated: true,
        userIdPresent: Boolean(session.user?.id),
        product: session.product || null,
      });

      return startSpotifyWebPlayerSession();
    })
    .then((playerReady) => {
      if (!playerReady || !enabled) {
        if (!playerReady) {
          warn('Spotify account was authenticated, but the background player could not start', {
            code: 'SPOTIFY_BACKGROUND_PLAYER_UNAVAILABLE',
          });
        }
        return;
      }

      emit({
        status: 'linked',
        message: 'Spotify login succeeded. Background Web Player session started.'
      });

      void syncOnce();
    })
    .catch((error: any) => {
      authValidated = false;
      authValidatedAt = 0;

      const status = Number(error?.status || 0);
      const code = String(error?.code || '');

      if (status === 401 || code === 'SPOTIFY_AUTH_INVALID' || code === 'SPOTIFY_LOGIN_TICKET_INVALID') {
        clearAuth();
        reportSpotifyUnauthenticated('secure-login-handoff-rejected', {
          status,
          code,
        });
        promptSpotifyLogin();
        emit({
          status: 'link-required',
          message: 'Spotify login could not be completed securely. Please sign in again.',
        });
        return;
      }

      errorLog('secure Spotify login handoff failed', {
        code: code || 'SPOTIFY_SECURE_LOGIN_FAILED',
        status,
      });
      emit({
        status: 'error',
        message: 'Spotify login could not be completed. Try signing in again.',
      });
    });

  return true;
}

function formatTime(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}
