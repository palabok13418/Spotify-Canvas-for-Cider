export interface StoredSpotifyAuth {
  refreshToken: string;
  scope?: string;
  savedAt: number;
}

const KEY = 'cider.spotify-instagram-notes.auth.v1';

export function loadAuth(): StoredSpotifyAuth | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value.refreshToken !== 'string' || !value.refreshToken.trim()) return null;
    return {
      refreshToken: value.refreshToken.trim(),
      scope: typeof value.scope === 'string' ? value.scope : undefined,
      savedAt: Number(value.savedAt) || 0,
    };
  } catch {
    return null;
  }
}

export function saveAuth(auth: StoredSpotifyAuth) {
  localStorage.setItem(KEY, JSON.stringify(auth));
}

export function clearAuth() {
  localStorage.removeItem(KEY);
}
