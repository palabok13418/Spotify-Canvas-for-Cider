import { AppleMusic } from '@ciderapp/pluginkit';
import { clearAuth, loadAuth, saveAuth } from './storage';
import { listDevices, playTrack, refreshSpotifyToken, searchTracks, pausePlayback, type SpotifyDevice, type SpotifyTrack } from './musApi';

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
let selectedPhoneId = '';
let lastCiderKey = '';
let lastSpotifyUri = '';
let lastPlaying = false;
let busy = false;
let timer = 0;
let currentSnapshot: BridgeSnapshot = { status: 'link-required', message: 'Link Spotify in Spotify Notes Bridge.' };

export function getSnapshot() { return currentSnapshot; }
export function onBridgeChange(listener: Listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function setEnabled(value: boolean) { enabled = value; emit(value ? currentSnapshot : { status: 'disabled', message: 'Spotify mirroring is paused.' }); }
export function isEnabled() { return enabled; }

function emit(snapshot: BridgeSnapshot) {
  currentSnapshot = snapshot;
  listeners.forEach((listener) => { try { listener(snapshot); } catch {} });
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
  saveAuth({ refreshToken, scope: token.scope || stored.scope, savedAt: Date.now() });
  return accessToken;
}

function getCiderTrack() {
  const item: any = (AppleMusic as any).nowPlayingItem;
  if (!item) return null;
  const attrs = item.attributes || item;
  const title = String(attrs.name || attrs.title || '').trim();
  const artist = String(attrs.artistName || attrs.artist || '').trim();
  const album = String(attrs.albumName || attrs.album || '').trim();
  const isrc = String(attrs.isrc || '').trim();
  const durationMs = Number(attrs.durationInMillis || attrs.durationMs || 0) || 0;
  const id = String(item.id || attrs.playParams?.id || attrs.playParams?.catalogId || '').trim();
  const playing = Boolean((AppleMusic as any).isPlaying);
  if (!title || !artist) return null;
  return { title, artist, album, isrc, durationMs, id, playing };
}

function norm(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function scoreTrack(candidate: SpotifyTrack, cider: { title: string; artist: string; album: string }) {
  const titleA = norm(cider.title);
  const artistA = norm(cider.artist);
  const albumA = norm(cider.album);
  const titleB = norm(candidate.name);
  const artistB = norm(candidate.artists.join(', '));
  const albumB = norm(candidate.album);
  let score = 0;
  if (titleA === titleB) score += 60; else if (titleB.includes(titleA) || titleA.includes(titleB)) score += 35;
  if (artistA === artistB) score += 30; else if (artistB.includes(artistA) || artistA.includes(artistB)) score += 20;
  if (albumA && albumA === albumB) score += 10;
  return score;
}

async function findExactSpotifyTrack(token: string, cider: { title: string; artist: string; album: string; isrc: string }) {
  const queries = [
    ...(cider.isrc ? [`isrc:${cider.isrc}`] : []),
    `track:${cider.title} artist:${cider.artist} album:${cider.album}`,
    `track:${cider.title} artist:${cider.artist}`,
    `${cider.title} ${cider.artist}`,
  ];
  const candidates: SpotifyTrack[] = [];
  for (const query of queries) {
    const tracks = await searchTracks(token, query);
    for (const track of tracks) if (!candidates.some((x) => x.id === track.id)) candidates.push(track);
    if (candidates.length >= 20) break;
  }
  if (!candidates.length) return null;
  return candidates.sort((a, b) => scoreTrack(b, cider) - scoreTrack(a, cider))[0] || null;
}

async function syncOnce() {
  if (!enabled || busy) return;
  const cider = getCiderTrack();
  if (!cider) return;
  busy = true;
  try {
    const token = await ensureToken();
    const devices = await listDevices(token);
    const phone = devices.find((d) => d.type.toLowerCase() === 'smartphone' && !d.isRestricted) || null;
    if (!phone) {
      emit({ status: 'spotify-required', message: 'Open Spotify on your phone so it appears as a playback device.', ciderTitle: cider.title, ciderArtist: cider.artist });
      return;
    }
    selectedPhoneId = phone.id;
    const key = `${cider.id}|${cider.title}|${cider.artist}|${cider.album}`;
    const needsTrackChange = key !== lastCiderKey;
    const needsPlayState = cider.playing !== lastPlaying;
    if (!needsTrackChange && !needsPlayState) {
      emit({ status: 'ready', message: `Mirroring to ${phone.name}.`, ciderTitle: cider.title, ciderArtist: cider.artist, phoneDevice: phone });
      return;
    }

    if (needsTrackChange) {
      emit({ status: 'syncing', message: `Finding “${cider.title}” on Spotify…`, ciderTitle: cider.title, ciderArtist: cider.artist, phoneDevice: phone });
      const track = await findExactSpotifyTrack(token, cider);
      if (!track) {
        emit({ status: 'error', message: `Spotify match not found for “${cider.title}” by ${cider.artist}.`, ciderTitle: cider.title, ciderArtist: cider.artist, phoneDevice: phone });
        return;
      }
      await playTrack(token, phone.id, track.uri, 0);
      lastCiderKey = key;
      lastSpotifyUri = track.uri;
      lastPlaying = true;
      emit({ status: 'ready', message: `Playing “${track.name}” on ${phone.name}.`, ciderTitle: cider.title, ciderArtist: cider.artist, spotifyTrack: track, phoneDevice: phone });
      return;
    }

    if (cider.playing && !lastPlaying && lastSpotifyUri) {
      await playTrack(token, phone.id, lastSpotifyUri, 0);
      lastPlaying = true;
      emit({ status: 'ready', message: `Resumed Spotify on ${phone.name}.`, ciderTitle: cider.title, ciderArtist: cider.artist, phoneDevice: phone });
      return;
    }

    if (!cider.playing && lastPlaying) {
      await pausePlayback(token, selectedPhoneId);
      lastPlaying = false;
      emit({ status: 'ready', message: `Paused Spotify on ${phone.name}.`, ciderTitle: cider.title, ciderArtist: cider.artist, phoneDevice: phone });
    }
  } catch (error: any) {
    const message = String(error?.message || error || 'Spotify bridge error');
    if (/not linked/i.test(message)) {
      emit({ status: 'link-required', message: 'Link your Spotify account through Mus-API.' });
    } else if (/401|token|authorization/i.test(message)) {
      accessToken = '';
      tokenExpMs = 0;
      clearAuth();
      emit({ status: 'link-required', message: 'Spotify authorization expired. Link Spotify again.' });
    } else {
      emit({ status: 'error', message });
    }
  } finally {
    busy = false;
  }
}

export function startBridge() {
  if (timer) return;
  timer = window.setInterval(() => { void syncOnce(); }, 1200);
  void syncOnce();
}

export function stopBridge() {
  if (timer) window.clearInterval(timer);
  timer = 0;
}

export function handleOAuthMessage(data: any) {
  if (!data?.ok || !data.accessToken) return false;
  accessToken = String(data.accessToken);
  tokenExpMs = Number(data.tokenExpMs) || Date.now() + 3300_000;
  if (data.refreshToken) {
    refreshToken = String(data.refreshToken);
    saveAuth({ refreshToken, scope: data.scope || undefined, savedAt: Date.now() });
  }
  lastCiderKey = '';
  lastSpotifyUri = '';
  lastPlaying = false;
  emit({ status: 'ready', message: 'Spotify linked. Waiting for your next Cider track.' });
  void syncOnce();
  return true;
}
