export const MUS_API_BASE = 'https://mus-api.vercel.app';

export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs?: number;
}

export interface SpotApiPlaybackState {
  activeDeviceId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  deviceType: string | null;
  isPlaying: boolean;
  isPaused: boolean;
  progressMs: number | null;
  timestampMs: number | null;
  trackUri: string | null;
  durationMs: number | null;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${MUS_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || data?.ok === false) {
    const error: any = new Error(
      String(
        data?.detail ||
        data?.error ||
        `Mus-API returned ${response.status}`
      )
    );
    error.status = response.status || Number(data?.status) || 502;
    error.code = data?.error || 'MUS_API_ERROR';
    error.detail = data?.extra || data?.detail || null;
    throw error;
  }

  return data as T;
}

export async function spotApiPlayer<T = any>(action: string, body: Record<string, unknown> = {}) {
  return postJson<T>('/api/spotify/spotapi-player', {
    ...body,
    action
  });
}

export interface SpotifyToken {
  accessToken: string;
  refreshToken: string | null;
  tokenExpMs: number;
  scope?: string | null;
}

export async function refreshSpotifyToken(refreshToken: string): Promise<SpotifyToken> {
  const data = await postJson<{
    ok: boolean;
    accessToken?: string;
    refreshToken?: string | null;
    tokenExpMs?: number;
    scope?: string | null;
  }>('/api/spotify/refresh', { refreshToken });

  if (!data.ok || !data.accessToken) {
    throw new Error('Spotify token refresh failed');
  }

  return {
    accessToken: String(data.accessToken),
    refreshToken: data.refreshToken ?? refreshToken,
    tokenExpMs: Number(data.tokenExpMs) || Date.now() + 3_300_000,
    scope: data.scope ?? null,
  };
}

export async function spotifyPlayOnDevice(
  accessToken: string,
  deviceId: string,
  uri: string,
  positionMs = 0,
) {
  return postJson<{
    ok: boolean;
    data?: unknown;
  }>('/api/spotify/proxy', {
    targetUrl:
      `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
    method: 'PUT',
    accessToken,
    body: {
      uris: [uri],
      position_ms: Math.max(0, Math.floor(positionMs)),
    },
  });
}

export async function muteSpotifyWebPlayer() {
  return spotApiPlayer<{
    ok: boolean;
    action: 'mute';
    deviceId: string;
    deviceName: string;
    volume: number;
  }>('mute');
}

export async function getSpotifyPlaybackState(): Promise<SpotApiPlaybackState | null> {
  const result = await spotApiPlayer<{
    ok: boolean;
    activeDeviceId?: string | null;
    activeDevice?: {
      id?: string | null;
      name?: string | null;
      type?: string | null;
      volume?: number | null;
    } | null;
    isPlaying?: boolean;
    isPaused?: boolean;
    progressMs?: number | null;
    timestampMs?: number | null;
    trackUri?: string | null;
    durationMs?: number | null;
  }>('state');

  if (!result?.ok) return null;

  return {
    activeDeviceId: result.activeDeviceId ?? result.activeDevice?.id ?? null,
    deviceId: result.activeDeviceId ?? result.activeDevice?.id ?? null,
    deviceName: result.activeDevice?.name ?? null,
    deviceType: result.activeDevice?.type ?? null,
    isPlaying: Boolean(result.isPlaying),
    isPaused: Boolean(result.isPaused),
    progressMs:
      result.progressMs == null ? null : Number(result.progressMs),
    timestampMs:
      result.timestampMs == null ? null : Number(result.timestampMs),
    trackUri: result.trackUri ?? null,
    durationMs:
      result.durationMs == null ? null : Number(result.durationMs)
  };
}

export async function seekSpotifyPlayback(positionMs: number) {
  return spotApiPlayer('seek', {
    positionMs: Math.max(0, Math.floor(positionMs))
  });
}

export async function pauseSpotifyPlayback() {
  return spotApiPlayer('pause');
}

export async function resumeSpotifyPlayback() {
  return spotApiPlayer('resume');
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
    cache: 'no-store'
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error: any = new Error(
      String(
        data?.detail ||
        data?.error ||
        `Mus-API resolver returned ${response.status}`
      )
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
    durationMs: Number(data.durationMs) || undefined
  };
}
