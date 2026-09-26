import { clearAuth, loadAuth, saveAuth } from './storage';
import { listDevices, pausePlayback, playTrack, refreshSpotifyToken, searchTracks, spotifyApi, type SpotifyDevice, type SpotifyTrack } from './musApi';

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
let busy = false;
let timer = 0;

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
  emit(
    value
      ? currentSnapshot
      : { status: 'disabled', message: 'Spotify mirroring is paused.' }
  );
}

export function isEnabled() {
  return enabled;
}

function emit(snapshot: BridgeSnapshot) {
  currentSnapshot = snapshot;
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {}
  }
}

async function ensureToken() {
  if (accessToken && tokenExpMs > Date.now() + 30_000) return accessToken;

  const stored = loadAuth();
  if (!stored?.refreshToken) throw new Error('Spotify is not linked');

  refreshToken = stored.refreshToken;
  const token = await refreshSpotifyToken(refreshToken);

  accessToken = token.accessToken;
  tokenExpMs = token.tokenExpMs;
  refreshToken = token.refreshToken || refreshToken;

  saveAuth({
    refreshToken,
    scope: token.scope || stored.scope,
    savedAt: Date.now()
  });

  return accessToken;
}

function getCiderTrack() {
  const store = (globalThis as any).__PLUGINSYS__?.Stores?.appleMusicStore;
  if (!store) return null;

  const item = store.nowPlayingItem ?? null;
  if (!item) return null;

  const attrs = item.attributes ?? item;
  const title = String(attrs.name || attrs.title || attrs.trackName || '').trim();
  const artist = String(attrs.artistName || attrs.artist || '').trim();
  const album = String(attrs.albumName || attrs.album || '').trim();

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

  const playing =
    typeof store.isPlaying === 'boolean'
      ? store.isPlaying
      : typeof store.audioElement?.paused === 'boolean'
        ? !store.audioElement.paused
        : false;

  if (!title || !artist) return null;

  const key = [
    id,
    title,
    artist,
    album,
    durationMs || 0
  ].map((value) => String(value).trim().toLowerCase()).join('|');

  return {
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

function normalize(value: string) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(feat\.?|ft\.?)\b.*$/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTrack(
  candidate: SpotifyTrack,
  cider: { title: string; artist: string; album: string; durationMs: number }
) {
  const wantedTitle = normalize(cider.title);
  const wantedArtist = normalize(cider.artist);
  const wantedAlbum = normalize(cider.album);

  const candidateTitle = normalize(candidate.name);
  const candidateArtist = normalize(candidate.artists[0] || candidate.artists.join(', '));
  const candidateAlbum = normalize(candidate.album);

  let score = 0;

  if (wantedTitle && candidateTitle === wantedTitle) score += 55;
  else if (wantedTitle && (candidateTitle.includes(wantedTitle) || wantedTitle.includes(candidateTitle))) score += 35;

  if (wantedArtist && candidateArtist === wantedArtist) score += 35;
  else if (wantedArtist && (candidateArtist.includes(wantedArtist) || wantedArtist.includes(candidateArtist))) score += 20;

  if (wantedAlbum && candidateAlbum === wantedAlbum) score += 8;
  else if (wantedAlbum && (candidateAlbum.includes(wantedAlbum) || wantedAlbum.includes(candidateAlbum))) score += 4;

  if (cider.durationMs && candidate.durationMs) {
    const delta = Math.abs(candidate.durationMs - cider.durationMs);
    if (delta <= 1500) score += 7;
    else if (delta <= 5000) score += 3;
  }

  return score;
}

async function findSpotifyTrack(token: string, cider: {
  title: string;
  artist: string;
  album: string;
  isrc: string;
  durationMs: number;
}) {
  const queries = [
    ...(cider.isrc ? [`isrc:${cider.isrc}`] : []),
    `track:"${cider.title.replace(/"/g, '')}" artist:"${cider.artist.replace(/"/g, '')}" album:"${cider.album.replace(/"/g, '')}"`,
    `track:"${cider.title.replace(/"/g, '')}" artist:"${cider.artist.replace(/"/g, '')}"`,
    [cider.title, cider.artist, cider.album].filter(Boolean).join(' ')
  ];

  const candidates: SpotifyTrack[] = [];

  for (const query of queries) {
    const tracks = await searchTracks(token, query);

    for (const track of tracks) {
      if (!candidates.some((existing) => existing.id === track.id)) {
        candidates.push(track);
      }
    }

    if (candidates.length >= 30) break;
  }

  if (!candidates.length) return null;

  return candidates
    .map((track) => ({
      track,
      score: scoreTrack(track, cider)
    }))
    .sort((a, b) => b.score - a.score)[0]
    ?.track || null;
}

async function getPhone(force = false): Promise<SpotifyDevice | null> {
  const now = Date.now();

  if (!force && phoneDevice && now - phoneCheckedAt < 8_000) {
    return phoneDevice;
  }

  const token = await ensureToken();
  const devices = await listDevices(token);

  const preferredName = String(
    loadAuth()?.scope && '' // keeps this module compatible with the existing storage shape
      ? ''
      : ''
  );

  const phones = devices.filter(
    (device) =>
      device.type.toLowerCase() === 'smartphone' &&
      !device.isRestricted
  );

  phoneDevice =
    phones.find((device) => preferredName && device.name.toLowerCase() === preferredName.toLowerCase()) ||
    phones.find((device) => device.isActive) ||
    phones[0] ||
    null;

  phoneCheckedAt = now;
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
    !cider.key || lastCiderKey === ''
      ? false
      : cider.playing &&
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
      emit({
        status: 'syncing',
        message: `Finding “${cider.title}” on Spotify…`,
        ciderTitle: cider.title,
        ciderArtist: cider.artist,
        phoneDevice
      });

      currentResolvedTrack = await findSpotifyTrack(token, cider);

      if (!currentResolvedTrack) {
        emit({
          status: 'error',
          message: `Spotify match not found for “${cider.title}” by ${cider.artist}.`,
          ciderTitle: cider.title,
          ciderArtist: cider.artist
        });
        return;
      }

      if (!cider.playing) {
        lastCiderKey = cider.key;
        lastSpotifyUri = currentResolvedTrack.uri;
        lastPlaying = false;

        emit({
          status: 'ready',
          message: `Matched “${currentResolvedTrack.name}”. Cider is paused.`,
          ciderTitle: cider.title,
          ciderArtist: cider.artist,
          spotifyTrack: currentResolvedTrack
        });
        return;
      }

      let phone = await getPhone();

      if (!phone) {
        emit({
          status: 'spotify-required',
          message: 'Open Spotify on your phone so it appears as a playback device.',
          ciderTitle: cider.title,
          ciderArtist: cider.artist
        });
        return;
      }

      try {
        await playTrack(token, phone.id, currentResolvedTrack.uri, cider.positionMs);
      } catch (error: any) {
        if (Number(error?.status) === 404 || Number(error?.status) === 502) {
          phone = await getPhone(true);
          if (!phone) throw new Error('Your Spotify phone disappeared from the device list.');
          await playTrack(token, phone.id, currentResolvedTrack.uri, cider.positionMs);
        } else {
          throw error;
        }
      }

      phoneDevice = phone;
      lastCiderKey = cider.key;
      lastSpotifyUri = currentResolvedTrack.uri;
      lastPlaying = true;
      lastPositionSyncAt = Date.now();

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

    if (transportChanged) {
      const phone = phoneDevice || await getPhone();

      if (!phone) {
        emit({
          status: 'spotify-required',
          message: 'Open Spotify on your phone so it appears as a playback device.',
          ciderTitle: cider.title,
          ciderArtist: cider.artist
        });
        return;
      }

      if (!lastSpotifyUri) {
        currentResolvedTrack = await findSpotifyTrack(token, cider);
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

      return;
    }

    if (seekDetected) {
      const phone = phoneDevice || await getPhone();
      if (phone) {
        phoneDevice = phone;
        try {
          await seekOnPhone(cider.positionMs);
          emit({
            status: 'ready',
            message: `Seeked Spotify to ${formatTime(cider.positionMs)} on ${phone.name}.`,
            ciderTitle: cider.title,
            ciderArtist: cider.artist,
            spotifyTrack: currentResolvedTrack,
            phoneDevice: phone
          });
        } catch {}
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

    accessToken = '';
    tokenExpMs = 0;

    if (status === 401) {
      emit({
        status: 'link-required',
        message: 'Spotify authorization expired. Relink Spotify through Mus-API.',
        ciderTitle: cider.title,
        ciderArtist: cider.artist
      });
    } else if (status === 403) {
      emit({
        status: 'error',
        message: 'Spotify rejected playback control. Check that the account can use Spotify Connect playback.',
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

export function startBridge() {
  if (timer) return;
  timer = window.setInterval(() => {
    void syncOnce();
  }, 1_200);
  void syncOnce();
}

export function stopBridge() {
  if (timer) window.clearInterval(timer);
  timer = 0;
}

export function handleOAuthMessage(data: any) {
  if (!data?.ok || !data.accessToken) return false;

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

  phoneDevice = null;
  phoneCheckedAt = 0;
  lastCiderKey = '';
  lastSpotifyUri = '';
  currentResolvedTrack = null;
  lastPlaying = false;
  lastCiderPositionMs = 0;
  lastObservedAt = 0;
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
