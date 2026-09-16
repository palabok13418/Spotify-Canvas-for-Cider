import { AppleMusic } from "../cider";

export interface CurrentTrack {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  composer: string;
  genre: string;
  contentRating: string;
  appleId: string;
  catalogId: string;
  durationMs: number | null;
  isrc: string;
  releaseYear: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  artworkUrl: string;
  source: "mediasession" | "applemusic" | "merged";
}


/**
 * Cider-side song presence. Playback state is intentionally ignored.
 * A paused song still counts as a loaded song, while an empty player does not.
 */
export function hasCiderTrack(): boolean {
  const item: any = AppleMusic.nowPlayingItem as any;
  if (!item) return false;
  const attrs = item?.attributes || item;
  const id = String(item?.playParams?.id || item?.id || attrs?.playParams?.id || attrs?.catalogId || "").trim();
  const title = String(attrs?.name || attrs?.title || attrs?.trackName || "").trim();
  const artist = String(attrs?.artistName || attrs?.artist || "").trim();
  return Boolean(id || title || artist);
}

function mediaSessionTrack() {
  const metadata = navigator.mediaSession?.metadata;
  if (!metadata) return null;
  const artworkUrl = metadata.artwork?.find(a => a.src)?.src || metadata.artwork?.[metadata.artwork.length - 1]?.src || "";
  return {
    title: String(metadata.title || "").trim(),
    artist: String(metadata.artist || "").trim(),
    album: String(metadata.album || "").trim(),
    artworkUrl: String(artworkUrl || "").trim()
  };
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Track presence is intentionally independent from playback state.
 * The plugin only needs to know whether Cider currently has a song loaded
 * in its player so it can build the best possible Spotify search query.
 */
export function getCurrentTrack(): CurrentTrack {
  const media = mediaSessionTrack();
  const item: any = AppleMusic.nowPlayingItem as any;
  const attrs = item?.attributes || item || {};

  const appleTitle = String(attrs.name || attrs.title || attrs.trackName || "").trim();
  const appleArtist = String(attrs.artistName || attrs.artist || "").trim();
  const appleAlbum = String(attrs.albumName || attrs.album || "").trim();
  const appleAlbumArtist = String(attrs.albumArtistName || attrs.albumArtist || appleArtist).trim();
  const appleComposer = String(attrs.composerName || attrs.composer || "").trim();
  const appleGenre = Array.isArray(attrs.genreNames)
    ? String(attrs.genreNames[0] || "").trim()
    : String(attrs.genreName || attrs.genre || "").trim();
  const appleRating = String(attrs.contentRating || "").trim();
  const appleArtwork = String(
    attrs.artwork?.url || attrs.artworkUrl || attrs.artworkURL || attrs.artwork?.urlTemplate || ""
  ).trim();

  const title = media?.title || appleTitle;
  const artist = media?.artist || appleArtist;
  const album = media?.album || appleAlbum;

  const appleId = String(item?.playParams?.id || item?.id || attrs.playParams?.id || "").trim();
  const catalogId = String(
    item?.playParams?.catalogId ||
    item?.catalogId ||
    attrs.playParams?.catalogId ||
    attrs.catalogId ||
    attrs.reportingId ||
    ""
  ).trim();
  const durationMs = numberOrNull(attrs.durationInMillis ?? attrs.durationMs ?? null);
  const isrc = String(attrs.isrc || attrs.ISRC || attrs.externalIds?.isrc || item?.isrc || "").trim();
  const releaseDate = String(attrs.releaseDate || attrs.release_date || "").trim();
  const releaseYearMatch = /^(\d{4})/.exec(releaseDate);
  const releaseYear = releaseYearMatch ? Number(releaseYearMatch[1]) : null;
  const trackNumber = numberOrNull(attrs.trackNumber ?? attrs.track_number ?? null);
  const discNumber = numberOrNull(attrs.discNumber ?? attrs.disc_number ?? null);

  return {
    title,
    artist,
    album,
    albumArtist: appleAlbumArtist,
    composer: appleComposer,
    genre: appleGenre,
    contentRating: appleRating,
    appleId,
    catalogId,
    durationMs,
    isrc,
    releaseYear,
    trackNumber,
    discNumber,
    artworkUrl: media?.artworkUrl || appleArtwork,
    source: media && (media.title || media.artist || media.album || media.artworkUrl)
      ? (appleTitle || appleArtist || appleAlbum ? "merged" : "mediasession")
      : "applemusic"
  };
}
