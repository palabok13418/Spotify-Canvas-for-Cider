export interface StoredSpotifyAuth {
  sessionTicket?: string;
  // Legacy migration only. New sessions must use sessionTicket.
  refreshToken?: string;
  scope?: string;
  savedAt: number;
}

const KEY = 'cider.spotify-instagram-notes.auth.v2';
const LEGACY_KEY = 'cider.spotify-instagram-notes.auth.v1';

function read(raw: string | null): StoredSpotifyAuth | null {
  if (!raw) return null;

  try {
    const value = JSON.parse(raw);

    const rawSessionTicket =
      typeof value?.sessionTicket === 'string' ? value.sessionTicket.trim() : '';
    const sessionTicket = rawSessionTicket.length <= 16 * 1024 &&
      /^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(rawSessionTicket)
      ? rawSessionTicket
      : '';

    const rawRefreshToken =
      typeof value?.refreshToken === 'string' ? value.refreshToken.trim() : '';
    const refreshToken = rawRefreshToken.length <= 8192 ? rawRefreshToken : '';

    if (!sessionTicket && !refreshToken) return null;

    return {
      ...(sessionTicket ? { sessionTicket } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      scope: typeof value?.scope === 'string' ? value.scope : undefined,
      savedAt: Number(value?.savedAt) || 0,
    };
  } catch {
    return null;
  }
}

export function loadAuth(): StoredSpotifyAuth | null {
  try {
    const current = read(localStorage.getItem(KEY));
    if (current?.sessionTicket) return current;

    const legacy = read(localStorage.getItem(LEGACY_KEY));
    if (legacy) {
      // Return the legacy token only in memory for one migration attempt. Do not
      // keep a raw Spotify refresh token persisted when migration fails offline.
      try { localStorage.removeItem(LEGACY_KEY); } catch {}
      return legacy;
    }

    return current;
  } catch {
    return null;
  }
}

export function saveAuth(auth: {
  sessionTicket: string;
  scope?: string;
  savedAt?: number;
}) {
  const sessionTicket = String(auth.sessionTicket || '').trim();
  if (
    !sessionTicket ||
    sessionTicket.length > 16 * 1024 ||
    !/^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(sessionTicket)
  ) {
    throw new Error('SPOTIFY_SESSION_TICKET_INVALID');
  }

  localStorage.setItem(KEY, JSON.stringify({
    sessionTicket,
    scope: typeof auth.scope === 'string' ? auth.scope : undefined,
    savedAt: Number(auth.savedAt) || Date.now(),
  }));

  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {}
}

export function clearAuth() {
  try { localStorage.removeItem(KEY); } catch {}
  try { localStorage.removeItem(LEGACY_KEY); } catch {}
}
