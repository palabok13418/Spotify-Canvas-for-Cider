export const MUS_API_BASE = 'https://mus-api.vercel.app';

export interface SpotifyToken {
  accessToken: string;
  refreshToken: string | null;
  tokenExpMs: number;
  scope?: string | null;
}

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted?: boolean;
  volumePercent?: number | null;
}

export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs?: number;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${MUS_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error || data?.detail || `Mus-API returned ${response.status}`;
    throw new Error(String(message));
  }
  return data as T;
}

export function openSpotifyAuth(origin: string) {
  const url = new URL(`${MUS_API_BASE}/api/spotify/auth`);
  url.searchParams.set('origin', origin);
  url.searchParams.set('returnTo', window.location.href);
  return url.toString();
}

export async function refreshSpotifyToken(refreshToken: string): Promise<SpotifyToken> {
  const data = await postJson<{
    ok: boolean;
    accessToken?: string;
    refreshToken?: string | null;
    tokenExpMs?: number;
    scope?: string | null;
  }>('/api/spotify/refresh', { refreshToken });

  if (!data.ok || !data.accessToken) throw new Error('Spotify token refresh failed');
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken ?? refreshToken,
    tokenExpMs: Number(data.tokenExpMs) || Date.now() + 3300_000,
    scope: data.scope,
  };
}

export async function spotifyApi<T>(accessToken: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  return postJson<T>('/api/spotify/proxy', {
    targetUrl: `https://api.spotify.com/v1${path}`,
    method,
    accessToken,
    body,
  });
}

export async function listDevices(accessToken: string): Promise<SpotifyDevice[]> {
  const result = await spotifyApi<{ ok: boolean; data?: { devices?: Array<any> } }>(accessToken, '/me/player/devices');
  if (!result?.ok) throw new Error('Unable to read Spotify devices');
  return (result.data?.devices || []).map((d) => ({
    id: String(d.id || ''),
    name: String(d.name || 'Spotify device'),
    type: String(d.type || 'Unknown'),
    isActive: !!d.is_active,
    isRestricted: !!d.is_restricted,
    volumePercent: d.volume_percent == null ? null : Number(d.volume_percent),
  })).filter((d) => d.id);
}

export async function searchTracks(accessToken: string, query: string): Promise<SpotifyTrack[]> {
  const result = await spotifyApi<{ ok: boolean; data?: { tracks?: { items?: Array<any> } } }>(
    accessToken,
    `/search?type=track&limit=10&q=${encodeURIComponent(query)}`,
  );
  if (!result?.ok) throw new Error('Spotify search failed');
  return (result.data?.tracks?.items || []).map((item) => ({
    id: String(item.id || ''),
    uri: String(item.uri || ''),
    name: String(item.name || ''),
    artists: Array.isArray(item.artists) ? item.artists.map((a) => String(a?.name || '')).filter(Boolean) : [],
    album: String(item.album?.name || ''),
    durationMs: Number(item.duration_ms) || undefined,
  })).filter((track) => track.uri);
}

export async function playTrack(accessToken: string, deviceId: string, uri: string, positionMs = 0) {
  return spotifyApi(accessToken, `/me/player/play?device_id=${encodeURIComponent(deviceId)}`, 'PUT', {
    uris: [uri],
    position_ms: Math.max(0, Math.floor(positionMs)),
  });
}

export async function pausePlayback(accessToken: string, deviceId?: string) {
  const suffix = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  return spotifyApi(accessToken, `/me/player/pause${suffix}`, 'PUT');
}
