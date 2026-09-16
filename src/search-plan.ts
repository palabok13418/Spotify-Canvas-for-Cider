import type { CurrentTrack } from "./core/currentTrack";

export function buildSpotifySearchQueries(track: CurrentTrack): string[] {
  const title = track.title.trim();
  const artist = track.artist.trim();
  const album = track.album.trim();
  const queries: string[] = [];
  if (track.isrc) queries.push(`isrc:${track.isrc}`);
  if (title && artist) queries.push(`track:"${title}" artist:"${artist}"`);
  if (title && artist && album) queries.push(`track:"${title}" artist:"${artist}" album:"${album}"`);
  if (title && artist && track.albumArtist && track.albumArtist !== artist) queries.push(`"${title}" "${artist}" "${track.albumArtist}"`);
  if (title && artist) queries.push(`"${title}" "${artist}"`);
  return [...new Set(queries)];
}
