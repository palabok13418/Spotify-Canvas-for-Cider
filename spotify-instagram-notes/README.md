# Spotify Notes Bridge for Cider

A Cider plugin that mirrors the song currently playing in Cider to Spotify so Spotify can expose the same listening state to features such as Instagram Notes.

## Flow

1. Link Spotify through Mus-API.
2. Play a song in Cider.
3. The plugin reads Cider's current Apple Music now-playing item through PluginKit.
4. Mus-API's Spotify proxy searches Spotify using title, artist, album, and ISRC when available.
5. The plugin scores the returned candidates and selects the closest matching track.
6. Mus-API sends playback to the user's available Spotify smartphone device.
7. Spotify becomes the source Instagram can use for its Notes music state.

## Requirements

- Cider with PluginKit v4 support.
- A Spotify account authorized through Mus-API.
- Spotify installed/open on the phone and visible as a Spotify playback device.
- Mus-API's existing Spotify OAuth, refresh, search/proxy, and playback permissions configured on the deployed Mus-API instance.

## Important behavior

The plugin does not automate Instagram and does not access Instagram credentials. Instagram simply sees the user's normal Spotify playback state.

The plugin uses Mus-API as the Spotify networking layer. Access and refresh tokens are not sent to Cider's local RPC server.

## Build

```bash
pnpm install
pnpm build
```

The generated `dist/plugin.js` is the plugin entry configured by `src/plugin.config.ts`.
