export const MUS_API_BASE = 'https://mus-api.vercel.app';

export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs?: number;
}

export interface SpotifySession {
  sessionTicket: string | null;
  user: {
    id: string;
    displayName: string;
  };
  product: string | null;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${MUS_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-musaudio-client': 'cider-spotify-notes-bridge/1',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    credentials: 'omit',
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
    throw error;
  }

  return data as T;
}

export async function getSpotifySession(sessionTicket: string): Promise<SpotifySession> {
  return validateSpotifySession({ sessionTicket });
}

export async function completeSpotifyLogin(
  loginTicket: string,
  loginNonce: string,
): Promise<SpotifySession> {
  const data = await validateSpotifySession({ loginTicket, loginNonce });

  if (!data.sessionTicket) {
    const error: any = new Error('Spotify login completed without a secure session ticket');
    error.code = 'SPOTIFY_AUTH_SESSION_EMPTY';
    error.status = 502;
    throw error;
  }

  return data;
}

export async function migrateLegacySpotifySession(refreshToken: string): Promise<SpotifySession> {
  return validateSpotifySession({ refreshToken });
}

async function validateSpotifySession(body: {
  sessionTicket?: string;
  loginTicket?: string;
  loginNonce?: string;
  refreshToken?: string;
}): Promise<SpotifySession> {
  const data = await postJson<{
    ok: boolean;
    sessionTicket?: string | null;
    user?: {
      id?: string;
      displayName?: string;
    };
    product?: string | null;
  }>('/api/spotify/session', body);

  if (!data.ok || !data.user?.id || !data.sessionTicket) {
    const error: any = new Error('Spotify login session could not be validated');
    error.code = 'SPOTIFY_AUTH_INVALID';
    error.status = 401;
    throw error;
  }

  return {
    sessionTicket: String(data.sessionTicket),
    user: {
      id: String(data.user.id),
      displayName: String(data.user.displayName || ''),
    },
    product: data.product == null ? null : String(data.product),
  };
}

export interface SpotifyToken {
  accessToken: string;
  sessionTicket?: string | null;
  tokenExpMs: number;
  scope?: string | null;
}

export async function refreshSpotifyToken(sessionTicket: string): Promise<SpotifyToken> {
  const data = await postJson<{
    ok: boolean;
    accessToken?: string;
    sessionTicket?: string | null;
    tokenExpMs?: number;
    scope?: string | null;
  }>('/api/spotify/refresh', { sessionTicket });

  if (!data.ok || !data.accessToken) {
    const error: any = new Error('Spotify token refresh failed');
    error.code = data?.error || 'SPOTIFY_TOKEN_REFRESH_FAILED';
    error.status = 401;
    throw error;
  }

  return {
    accessToken: String(data.accessToken),
    sessionTicket: data.sessionTicket ?? sessionTicket,
    tokenExpMs: Number(data.tokenExpMs) || Date.now() + 3_300_000,
    scope: data.scope ?? null,
  };
}

export async function spotifyPlayOnDevice(
  sessionTicket: string,
  deviceId: string,
  uri: string,
  positionMs = 0,
) {
  return postJson<{
    ok: boolean;
    sessionTicket?: string | null;
  }>('/api/spotify/play', {
    sessionTicket,
    deviceId,
    uri,
    positionMs: Math.max(0, Math.floor(positionMs)),
  });
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
    credentials: 'omit'
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error: any = new Error(
      String(
        data?.error ||
        `Mus-API resolver returned ${response.status}`
      )
    );
    error.status = response.status;
    error.code = data?.error || 'MUS_API_RESOLVER_ERROR';
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
