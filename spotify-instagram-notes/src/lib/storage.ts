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

    const sessionTicket =
      typeof value?.sessionTicket === 'string' ? value.sessionTicket.trim() : '';

    const refreshToken =
      typeof value?.refreshToken === 'string' ? value.refreshToken.trim() : '';

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
    return read(localStorage.getItem(KEY)) || read(localStorage.getItem(LEGACY_KEY));
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
  if (!sessionTicket) throw new Error('SPOTIFY_SESSION_TICKET_MISSING');

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
