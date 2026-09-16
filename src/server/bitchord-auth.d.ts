export interface SpotifyAuth {
  accessToken: string;
  clientToken?: string | null;
  clientId?: string | null;
  clientVersion?: string | null;
  deviceId?: string | null;
  expiresAt: number;
}

export function getAuth(
  spDc: string,
  options?: { forceRefresh?: boolean }
): Promise<SpotifyAuth>;

export function getToken(
  spDc: string,
  options?: { forceRefresh?: boolean }
): Promise<string>;

export function getClientToken(
  spDc: string,
  options?: { forceRefresh?: boolean }
): Promise<string | null | undefined>;
