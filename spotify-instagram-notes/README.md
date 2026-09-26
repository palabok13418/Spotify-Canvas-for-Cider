# Spotify Notes Bridge for Cider

This folder is the finished Cider plugin that mirrors the track playing in Cider to the user's Spotify phone through Mus-API.

## Runtime flow

1. The user links Spotify from the plugin. OAuth is handled by Mus-API.
2. Cider's Apple Music store supplies the current song details.
3. The plugin resolves the same Spotify track through Mus-API's Spotify proxy/search layer. ISRC is tried when Cider exposes it, then title + artist + album matching is scored.
4. Spotify's available devices are queried and only a `Smartphone` device is accepted.
5. The plugin starts, pauses, resumes, and meaningfully seeks the matched Spotify track on the phone.
6. Instagram is not automated. Spotify remains the source app for any listening-state integration that Instagram supports.

## Microsoft Edge / Windows

Cider's Windows desktop client uses Microsoft Edge WebView2. The plugin runs inside Cider's host webview and uses normal HTTPS requests to Mus-API. It does not scrape `open.spotify.com` and it does not require an undocumented native WebView2 API.

## Requirements

- Cider with PluginKit v4.
- The Mus-API Spotify OAuth/proxy endpoints must be configured.
- Spotify must be installed and online on the phone.
- The phone must appear in Spotify's device list as `Smartphone`.
- Spotify playback control must be available for the account/device.

## Build

```bash
pnpm install
pnpm build
```

The Vite build outputs:

- `dist/plugin.js`
- `dist/plugin.yml`

Cider loads `plugin.js` as an ES module entry from the manifest.

## Security

The plugin stores the OAuth refresh token locally for the Cider plugin. Short-lived access tokens are kept in memory/session state and sent only to Mus-API's Spotify proxy. The OAuth callback is accepted only from the configured Mus-API origin.
