import type { CurrentTrack } from './core/currentTrack';

const API_BASE = 'https://spotify-canvas-for-cider-api.vercel.app';

export interface CanvasResolveResult {
  spotifyTrackId: string | null;
  canvasUrl: string | null;
  matchedTitle?: string;
  matchedArtist?: string;
  score?: number;
  reason?: string;
}

export function getCanvasApiBase(): string {
  return API_BASE;
}

export async function resolveCanvasRemote(track: CurrentTrack, signal?: AbortSignal): Promise<CanvasResolveResult> {
  const response = await fetch(`${API_BASE}/api/resolve-canvas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: track.title,
      artist: track.artist,
      album: track.album,
      albumArtist: track.albumArtist,
      composer: track.composer,
      genre: track.genre,
      contentRating: track.contentRating,
      catalogId: track.catalogId,
      durationMs: track.durationMs,
      isrc: track.isrc,
      releaseYear: track.releaseYear,
      trackNumber: track.trackNumber,
      discNumber: track.discNumber,
      artworkUrl: track.artworkUrl,
    }),
    signal,
  });

  const text = await response.text();
  let data: CanvasResolveResult & { reason?: string };
  try {
    data = JSON.parse(text) as CanvasResolveResult & { reason?: string };
  } catch {
    throw new Error(`Canvas API returned invalid JSON (${response.status})`);
  }

  if (!response.ok) {
    throw new Error(data.reason || `Canvas API ${response.status}`);
  }

  return data;
}
