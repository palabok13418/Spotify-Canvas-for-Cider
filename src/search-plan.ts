import type { CurrentTrack } from "./core/currentTrack";

function clean(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function quoted(value: string) {
  return '"' + clean(value).replace(/"/g, '\\"') + '"';
}

export function buildSpotifySearchQueries(track: CurrentTrack): string[] {
  const title = clean(track.title);
  const artist = clean(track.artist);
  const album = clean(track.album);
  const albumArtist = clean(track.albumArtist);
  const queries: string[] = [];

  const add = (query: string) => {
    if (query && !queries.includes(query)) queries.push(query);
  };

  if (track.isrc) {
    const isrc = track.isrc.replace(/[^A-Za-z0-9]/g, "");
    if (isrc) {
      add("isrc:" + isrc);
      add(isrc);
    }
  }

  if (artist && album) {
    add("artist:" + quoted(artist) + " album:" + quoted(album));
    add(quoted(artist) + " " + quoted(album));
  }

  if (artist && albumArtist && albumArtist !== artist && album) {
    add(quoted(artist) + " " + quoted(albumArtist) + " " + quoted(album));
  }

  if (title && artist) {
    add("track:" + quoted(title) + " artist:" + quoted(artist));
    add(quoted(title) + " " + quoted(artist));
  }

  if (artist) {
    add("artist:" + quoted(artist));
    add(quoted(artist));
  }

  if (title && album) add(quoted(title) + " " + quoted(album));

  return queries.slice(0, 10);
}
