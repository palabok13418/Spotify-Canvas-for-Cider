import { getAuth as getBitChordAuth, getToken as repoGetToken } from "./bitchord-auth.js";
import { getCanvases as repoGetCanvases } from "./bitchord-canvas.js";

interface SearchInput {
  spDc: string;
  title: string;
  artist: string;
  album?: string;
  albumArtist?: string;
  composer?: string;
  genre?: string;
  contentRating?: string;
  catalogId?: string;
  durationMs?: number | null;
  isrc?: string;
  releaseYear?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  artworkUrl?: string;
}
interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  artists?: Array<{ name: string }>;
  album?: { name?: string; release_date?: string; release_date_precision?: string };
  external_ids?: { isrc?: string };
  is_playable?: boolean;
  track_number?: number;
  disc_number?: number;
}

function normalize(value: string) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(feat\.?|ft\.?)\b.*$/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const SERVER_PREFIX = "[Canvas for Cider Server]";
function slog(...args: any[]) { console.log(SERVER_PREFIX, ...args); }
function swarn(...args: any[]) { console.warn(SERVER_PREFIX, ...args); }
function serror(...args: any[]) { console.error(SERVER_PREFIX, ...args); }

function tokens(value: string) {
  return new Set(normalize(value).split(" ").filter(Boolean));
}

function artistList(candidate: SpotifyTrack) {
  return (candidate.artists || []).map(a => a.name).filter(Boolean);
}

function titleVariants(value: string) {
  const base = normalize(value);
  const simplified = base
    .replace(/\b(remaster|remastered|radio edit|single version|album version|edit|mix|version|explicit|clean)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return new Set([base, simplified]);
}

function scoreTrack(candidate: SpotifyTrack, input: SearchInput) {
  const inputTitles = titleVariants(input.title);
  const candidateTitles = titleVariants(candidate.name);
  const inputArtists = [input.artist, ...(input.albumArtist ? [input.albumArtist] : [])].map(normalize).filter(Boolean);
  const candidateArtists = artistList(candidate).map(normalize);
  const inputAlbum = normalize(input.album || "");
  const candidateAlbum = normalize(candidate.album?.name || "");

  let score = 0;

  const exactTitle = [...candidateTitles].some(v => inputTitles.has(v));
  if (exactTitle) score += 50;
  else {
    const inputTitle = normalize(input.title);
    const candTitle = normalize(candidate.name);
    const a = tokens(inputTitle);
    const b = tokens(candTitle);
    const overlap = [...a].filter(t => b.has(t)).length / Math.max(1, a.size);
    score += Math.round(overlap * 28);
  }

  const primaryArtist = normalize(input.artist);
  const artistExact = candidateArtists.some(a => a === primaryArtist);
  const artistLoose = candidateArtists.some(a => a.includes(primaryArtist) || primaryArtist.includes(a));
  if (artistExact) score += 30;
  else if (artistLoose) score += 18;

  if (input.album && candidate.album?.name) {
    if (candidateAlbum === inputAlbum) score += 12;
    else if (candidateAlbum.includes(inputAlbum) || inputAlbum.includes(candidateAlbum)) score += 6;
  }

  if (input.albumArtist) {
    const aa = normalize(input.albumArtist);
    if (candidateArtists.some(a => a === aa)) score += 4;
  }

  const candidateIsrc = candidate.external_ids?.isrc?.toUpperCase();
  const inputIsrc = input.isrc?.toUpperCase();
  if (inputIsrc && candidateIsrc) {
    if (candidateIsrc === inputIsrc) score += 45;
  }

  if (input.durationMs && candidate.duration_ms) {
    const delta = Math.abs(candidate.duration_ms - input.durationMs);
    if (delta <= 750) score += 14;
    else if (delta <= 1500) score += 10;
    else if (delta <= 3000) score += 6;
    else if (delta <= 6000) score += 2;
    else score -= Math.min(12, Math.floor(delta / 3000));
  }

  const year = candidate.album?.release_date ? Number(candidate.album.release_date.slice(0, 4)) : null;
  if (input.releaseYear && year) {
    const diff = Math.abs(year - input.releaseYear);
    if (diff === 0) score += 5;
    else if (diff === 1) score += 2;
    else if (diff >= 3) score -= 2;
  }

  if (input.trackNumber && candidate.track_number) {
    if (input.trackNumber === candidate.track_number) score += 2;
  }
  if (input.discNumber && candidate.disc_number) {
    if (input.discNumber === candidate.disc_number) score += 1;
  }

  if (candidate.is_playable === false) score -= 10;
  return score;
}

const PARTNER_SEARCH_HASHES = [
  // Current WebPlayer searchTracks persisted query used by community clients.
  'bc1ca2fcd0ba1013a0fc88e6cc4f190af501851e3dafd3e1ef85840297694428',
  // Older searchDesktop persisted query kept as a compatibility fallback.
  '75bbf6bfcfdf85b8fc828417bfad92b7cd66bf7f556d85670f4da8292373ebec',
];

function flattenPartnerTrackData(node: any, output: any[] = [], seen = new Set<any>()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return output;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const child of node) flattenPartnerTrackData(child, output, seen);
    return output;
  }

  const uri = typeof node.uri === 'string' ? node.uri : '';
  const id = typeof node.id === 'string' ? node.id : (uri.match(/^spotify:track:([A-Za-z0-9]+)$/)?.[1] || null);
  const name = node.name || node.title || null;
  const artists = node.artists?.items || node.artists || node.artist?.items || node.artist || [];
  const artistNames = Array.isArray(artists)
    ? artists.map((a: any) => a?.profile?.name || a?.name).filter(Boolean)
    : [];
  const albumObj = node.albumOfTrack || node.album || node.release || {};
  const albumName = albumObj?.name || albumObj?.profile?.name || null;
  const releaseDate = albumObj?.date?.isoString || albumObj?.release_date || albumObj?.releaseDate || null;
  const durationMs = Number(node.duration?.totalMilliseconds ?? node.duration_ms ?? node.durationMs ?? node.duration?.milliseconds ?? 0) || 0;
  const trackNumber = Number(node.trackNumber ?? node.track_number ?? 0) || 0;
  const discNumber = Number(node.discNumber ?? node.disc_number ?? 0) || 0;
  const isrc = node.externalIds?.isrc?.[0] || node.external_ids?.isrc || node.isrc || null;
  const playable = node.restrictions ? node.restrictions?.every?.((r: any) => !String(r?.type || '').toLowerCase().includes('streaming')) : true;

  if (id && name && artistNames.length) {
    output.push({
      id,
      name,
      duration_ms: durationMs,
      artists: artistNames.map((x: string) => ({ name: x })),
      album: { name: albumName || undefined, release_date: releaseDate || undefined },
      external_ids: isrc ? { isrc } : undefined,
      is_playable: playable,
      track_number: trackNumber || undefined,
      disc_number: discNumber || undefined,
    });
  }

  for (const value of Object.values(node)) flattenPartnerTrackData(value, output, seen);
  return output;
}

async function partnerSearch(accessToken: string, clientToken: string | null, query: string, operationName: string, hash: string) {
  const endpoint = 'https://api-partner.spotify.com/pathfinder/v1/query';
  const variables = {
    searchTerm: query,
    offset: 0,
    limit: 20,
    numberOfTopResults: 20,
    includeAudiobooks: false,
    includePreReleases: false,
  };
  const extensions = { persistedQuery: { version: 1, sha256Hash: hash } };
  slog('Spotify internal WebPlayer search', { operationName, query });
  const url = new URL(endpoint);
  url.searchParams.set('operationName', operationName);
  url.searchParams.set('variables', JSON.stringify(variables));
  url.searchParams.set('extensions', JSON.stringify(extensions));
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(clientToken ? { 'Client-Token': clientToken } : {}),
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'App-Platform': 'WebPlayer',
      'Spotify-App-Version': '1.2.61.20.g3b4cd5b2',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    }
  });
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const error: any = new Error(`Spotify internal search failed: ${response.status}`);
    error.status = response.status;
    error.body = text.slice(0, 180);
    throw error;
  }
  const tracks = flattenPartnerTrackData(data?.data || data);
  const unique = [...new Map(tracks.map((track: any) => [track.id, track])).values()];
  slog('Spotify internal search returned', { query, count: unique.length });
  return unique;
}

async function spotifySearch(accessToken: string, clientToken: string | null, query: string) {
  let firstError: any = null;
  for (const [index, hash] of PARTNER_SEARCH_HASHES.entries()) {
    try {
      const operationName = index === 0 ? 'searchTracks' : 'searchDesktop';
      const tracks = await partnerSearch(accessToken, clientToken, query, operationName, hash);
      if (tracks.length) return tracks;
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
  return [];
}

function cleanSearchValue(value: string) {
  return String(value || "")
    .replace(/[\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteSearch(value: string) {
  return `"${cleanSearchValue(value).replace(/"/g, "\\\"")}"`;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map(cleanSearchValue).filter(Boolean))];
}

function artistVariants(value: string) {
  const raw = cleanSearchValue(value);
  const normalized = normalize(raw);
  const withoutParens = raw.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  const beforeFeaturing = raw.replace(/\s*(?:feat\.?|ft\.?|with)\s+.*$/i, "").trim();
  return uniqueStrings([raw, withoutParens, beforeFeaturing, normalized]);
}

function titleVariantsForSearch(value: string) {
  const raw = cleanSearchValue(value);
  const base = raw
    .replace(/\s*[-–—:]\s*(?:remaster(?:ed)?|radio edit|single version|album version|edit|mix|version|explicit|clean).*$/i, "")
    .trim();
  const noBracket = raw.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  const noFeatured = raw.replace(/\s*(?:feat\.?|ft\.?|with)\s+.*$/i, "").trim();
  return uniqueStrings([raw, base, noBracket, noFeatured]);
}

function buildSearchQueries(input: SearchInput) {
  const titles = titleVariantsForSearch(input.title);
  const artists = artistVariants(input.artist);
  const album = cleanSearchValue(input.album || "");
  const albumArtist = cleanSearchValue(input.albumArtist || "");
  const queries: string[] = [];

  if (input.isrc) queries.push(`isrc:${cleanSearchValue(input.isrc)}`);

  for (const title of titles.slice(0, 3)) {
    for (const artist of artists.slice(0, 2)) {
      queries.push(`track:${quoteSearch(title)} artist:${quoteSearch(artist)}`);
      if (album) queries.push(`track:${quoteSearch(title)} artist:${quoteSearch(artist)} album:${quoteSearch(album)}`);
    }
  }

  if (albumArtist && albumArtist !== input.artist) {
    const title = titles[0] || input.title;
    queries.push(`${quoteSearch(title)} ${quoteSearch(input.artist)} ${quoteSearch(albumArtist)}`);
  }

  queries.push(...[
    `${quoteSearch(input.title)} ${quoteSearch(input.artist)}`,
    album ? `${quoteSearch(input.title)} ${quoteSearch(input.artist)} ${quoteSearch(album)}` : `${input.title} ${input.artist}`,
    ...titles.slice(0, 2).map(t => `${t} ${input.artist}`)
  ]);

  return [...new Set(queries)].slice(0, 12);
}

async function searchSpotifyTrack(input: SearchInput) {
  slog("Spotify track matching started", {
    title: input.title,
    artist: input.artist,
    album: input.album,
    albumArtist: input.albumArtist,
    composer: input.composer || null,
    genre: input.genre || null,
    contentRating: input.contentRating || null,
    catalogId: input.catalogId || null,
    durationMs: input.durationMs,
    isrc: input.isrc || null,
    releaseYear: input.releaseYear,
    trackNumber: input.trackNumber,
    discNumber: input.discNumber,
    artworkUrl: input.artworkUrl || null
  });

  const auth = await getBitChordAuth(input.spDc);
  const accessToken = auth.accessToken;
  const clientToken = auth.clientToken ?? null;
  const queries = buildSearchQueries(input);
  slog("Generated Spotify search plan", queries);

  const all = new Map<string, SpotifyTrack>();
  let firstSearchError: unknown = null;
  for (const q of queries) {
    try {
      const data = await spotifySearch(accessToken, clientToken ?? null, q);
      for (const item of data || []) {
        if (item?.id) all.set(item.id, item);
      }
      // More candidates are useful for alternate/remaster cases, but cap the set
      // so a huge response can never turn this into an expensive ranking pass.
      if (all.size >= 80) break;
    } catch (error) {
      firstSearchError ??= error;
    }
  }

  if (!all.size && firstSearchError) throw firstSearchError;

  const ranked = [...all.values()]
    .map(track => ({ track, score: scoreTrack(track, input) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ad = input.durationMs && a.track.duration_ms ? Math.abs(a.track.duration_ms - input.durationMs) : Number.MAX_SAFE_INTEGER;
      const bd = input.durationMs && b.track.duration_ms ? Math.abs(b.track.duration_ms - input.durationMs) : Number.MAX_SAFE_INTEGER;
      return ad - bd;
    });

  slog("Ranked Spotify candidates", ranked.slice(0, 10).map(x => ({
    id: x.track.id,
    name: x.track.name,
    artists: x.track.artists?.map(a => a.name),
    album: x.track.album?.name,
    score: x.score,
    durationMs: x.track.duration_ms,
    isrc: x.track.external_ids?.isrc || null
  })));

  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < 65) {
    swarn("No Spotify match passed confidence threshold", { bestScore: best?.score ?? null });
    return null;
  }
  if (second && best.score < 90 && best.score - second.score < 4) {
    swarn("Spotify match rejected as ambiguous", { bestScore: best.score, secondScore: second.score, gap: best.score - second.score });
    return null;
  }

  slog("Spotify match selected", {
    id: best.track.id,
    name: best.track.name,
    artists: best.track.artists?.map(a => a.name),
    album: best.track.album?.name,
    score: best.score
  });
  return best;
}

async function getCanvas(spDc: string, trackId: string) {
  const trackUri = `spotify:track:${trackId}`;
  slog("Canvas lookup via Paxsenix0/Spotify-Canvas-API v2.0.5", { trackId, trackUri });
  const response = await repoGetCanvases(spDc, trackUri);
  const canvases = response?.canvasesList || [];
  const exact = canvases.find((canvas: any) => canvas?.trackUri === trackUri) || canvases[0];
  const canvasUrl = exact?.canvasUrl || null;
  slog("Repo Canvas response", { trackId, count: canvases.length, canvasUrl, canvas: exact || null });
  return canvasUrl;
}

export async function resolveCanvas(input: SearchInput) {
  slog("Resolver request received", { title: input.title, artist: input.artist, album: input.album, albumArtist: input.albumArtist, durationMs: input.durationMs, isrc: input.isrc || null, releaseYear: input.releaseYear, trackNumber: input.trackNumber, discNumber: input.discNumber, hasSpDc: Boolean(input.spDc), spDcLength: input.spDc?.length ?? 0 });
  if (!input.spDc || !input.title || !input.artist) {
    throw new Error("spDc, title and artist are required");
  }

  const match = await searchSpotifyTrack(input);
  if (!match) {
    swarn("Spotify track could not be matched");
    return { spotifyTrackId: null, canvasUrl: null, reason: "spotify-track-not-found" };
  }

  const canvasUrl = await getCanvas(input.spDc, match.track.id);
  slog("Resolver completed", { spotifyTrackId: match.track.id, canvasUrl, score: match.score });
  return {
    spotifyTrackId: match.track.id,
    canvasUrl,
    score: match.score,
    matchedTitle: match.track.name,
    matchedArtist: match.track.artists?.[0]?.name || "",
    reason: canvasUrl ? "ok" : "spotify-track-has-no-canvas"
  };
}
