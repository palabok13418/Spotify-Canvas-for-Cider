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
    const nested = data?.data;
    const message =
      data?.error ||
      data?.detail ||
      nested?.error?.message ||
      nested?.message ||
      nested?.error ||
      `Mus-API returned ${response.status}`;

    const error: any = new Error(String(message));
    error.status = response.status;
    error.code = data?.error || nested?.error?.status || nested?.error?.reason || null;
    error.detail = nested?.error?.reason || nested?.error?.message || data?.detail || null;
    throw error;
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
  try {
    return await postJson<T>('/api/spotify/proxy', {
      targetUrl: `https://api.spotify.com/v1${path}`,
      method,
      accessToken,
      body,
    });
  } catch (error: any) {
    error.spotifyPath = path;
    error.spotifyMethod = method;
    throw error;
  }
}

export async function probeSpotifyProfile(accessToken: string) {
  try {
    const result = await spotifyApi<{ ok: boolean; data?: { id?: string } }>(accessToken, '/me');
    return {
      ok: Boolean(result?.ok),
      id: typeof result?.data?.id === 'string' ? result.data.id : null,
    };
  } catch (error: any) {
    return {
      ok: false,
      status: Number(error?.status) || 0,
      message: String(error?.message || error || 'Spotify profile probe failed'),
    };
  }
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

export async function muteSpotifyDevice(accessToken: string, deviceId: string) {
  if (!deviceId) throw new Error('Spotify device ID is missing');

  return spotifyApi(
    accessToken,
    `/me/player/volume?volume_percent=0&device_id=${encodeURIComponent(deviceId)}`,
    'PUT',
  );
}

export interface SpotifyPlaybackState {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  isPlaying: boolean;
  progressMs: number | null;
  timestampMs: number | null;
  trackUri: string | null;
  durationMs: number | null;
}

export async function getSpotifyPlaybackState(accessToken: string): Promise<SpotifyPlaybackState | null> {
  const result = await spotifyApi<{
    ok: boolean;
    data?: {
      device?: {
        id?: string | null;
        name?: string | null;
        type?: string | null;
      } | null;
      is_playing?: boolean;
      progress_ms?: number | null;
      timestamp?: number | null;
      item?: {
        uri?: string | null;
        duration_ms?: number | null;
      } | null;
    };
  }>(accessToken, '/me/player');

  if (!result?.ok || !result.data?.device?.id) return null;

  return {
    deviceId: String(result.data.device.id),
    deviceName: String(result.data.device.name || 'Spotify device'),
    deviceType: String(result.data.device.type || 'Unknown'),
    isPlaying: Boolean(result.data.is_playing),
    progressMs: Number.isFinite(Number(result.data.progress_ms))
      ? Number(result.data.progress_ms)
      : null,
    timestampMs: Number.isFinite(Number(result.data.timestamp))
      ? Number(result.data.timestamp)
      : null,
    trackUri: result.data.item?.uri ? String(result.data.item.uri) : null,
    durationMs: Number.isFinite(Number(result.data.item?.duration_ms))
      ? Number(result.data.item?.duration_ms)
      : null,
  };
}

export async function seekSpotifyPlayback(
  accessToken: string,
  positionMs: number,
  deviceId?: string,
) {
  const suffix = new URLSearchParams();
  suffix.set('position_ms', String(Math.max(0, Math.floor(positionMs))));
  if (deviceId) suffix.set('device_id', deviceId);

  return spotifyApi(
    accessToken,
    `/me/player/seek?${suffix.toString()}`,
    'PUT',
  );
}

export async function muteActiveSpotifyComputer(accessToken: string): Promise<SpotifyDevice | null> {
  const devices = await listDevices(accessToken);

  // The Spotify Web Player reports as a computer device. Prefer an active
  // browser/web-player-looking device so we do not mute a phone or speaker.
  const computers = devices.filter((device) => (
    device.type.toLowerCase() === 'computer' && device.isActive
  ));

  const preferred =
    computers.find((device) => /web player|chrome|edge|cider|browser/i.test(device.name)) ||
    computers[0] ||
    null;

  if (!preferred) return null;

  await muteSpotifyDevice(accessToken, preferred.id);
  return {
    ...preferred,
    volumePercent: 0,
  };
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
    artists: Array.isArray(item.artists) ? item.artists.map((a: any) => String(a?.name || '')).filter(Boolean) : [],
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


export async function resolveSpotifyTrack(input: {
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  isrc?: string;
}): Promise<SpotifyTrack | null> {
  const url = new URL('/api/spotify/search-uri', MUS_API_BASE);
  if (input.title) url.searchParams.set('title', input.title);
  if (input.artist) url.searchParams.set('artist', input.artist);
  if (input.album) url.searchParams.set('album', input.album);
  if (input.durationMs) url.searchParams.set('durationMs', String(input.durationMs));
  if (input.isrc) url.searchParams.set('isrc', input.isrc);

  const response = await fetch(url.toString(), {
    method: 'GET',
    cache: 'no-store',
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error: any = new Error(
      String(data?.detail || data?.error || `Mus-API resolver returned ${response.status}`)
    );
    error.status = response.status;
    error.detail = data?.detail || null;
    throw error;
  }

  if (!data?.ok || !data?.id || !data?.uri) {
    return null;
  }

  return {
    id: String(data.id),
    uri: String(data.uri),
    name: String(data.name || ''),
    artists: Array.isArray(data.artists)
      ? data.artists.map((artist: unknown) => String(artist || '')).filter(Boolean)
      : [],
    album: String(data.album || ''),
    durationMs: Number(data.durationMs) || undefined,
  };
}
