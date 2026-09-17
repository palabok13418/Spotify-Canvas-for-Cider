<p align="center">
  <img src="logo.png" alt="Canvas for Cider logo" width="180" />
</p>

<h1 align="center">Canvas for Cider</h1>

<p align="center">
  Spotify Canvas video support for Cider, with a persistent portal, quick settings, and selectable placement.
</p>

## About

Canvas for Cider is a Cider PluginKit v4 plugin that displays Spotify Canvas videos for the currently playing Apple Music track. The Cider plugin itself is credential-free: it sends track metadata to the managed Canvas API and receives a Canvas video URL.

The Spotify session used for Canvas discovery is kept entirely on the backend. A Cider user does not enter, store, or transmit an `sp_dc` token through the plugin.

## Features

- 🎬 Spotify Canvas MP4 playback inside Cider
- 🔁 Persistent Canvas portal that survives Cider UI replacement
- 🧭 Lyrics, Navigation, and Mini Player placement modes
- 🎛️ Quick-settings button beside the Lyrics control
- 🧠 Positive Canvas-result caching
- ⚡ Stale-request cancellation when the current track changes
- ♻️ Recovery when Cider rebuilds a target surface
- 🌫️ Canvas blending/fading with the surrounding Cider UI
- 🖱️ Canvas layers do not intercept Cider controls
- ♿ Reduced-motion protection

## How it works

### 1. Identify the current track

Canvas for Cider reads the current Cider/Apple Music track and collects metadata such as title, artist, album, album artist, ISRC, duration, release year, track number, disc number, and artwork URL.

### 2. Send metadata to the managed API

The plugin sends that metadata to:

```text
https://spotify-canvas-for-cider-api.vercel.app/api/resolve-canvas
```

No Spotify credential is included in this request.

### 3. Backend Spotify lookup

The managed API uses its server-side Spotify session to authenticate with Spotify, search Spotify's internal services for the best matching track, and request the Canvas protobuf payload. The backend then returns the Canvas URL to Cider.

### 4. Render in Cider

The returned Canvas URL is attached to the persistent plugin-owned Canvas portal. The placement logic keeps the video synchronized with the selected Lyrics, Navigation, or Mini Player surface.

## Settings

Canvas settings contain only the display/placement controls. There is no Spotify token textbox and no user `sp_dc` configuration.

The backend Spotify credential is intentionally not part of the plugin source or plugin configuration.

## Quick-settings button

A Canvas button is inserted beside Cider's Lyrics control when available. It opens the plugin-owned placement settings popup.

## Project structure

```text
Canvas for Cider/
├── public/
├── src/
│   ├── components/
│   ├── core/
│   ├── boot.ts
│   ├── canvas-api.ts
│   ├── cider.ts
│   ├── config.ts
│   ├── main.ts
│   ├── plugin.config.ts
│   └── search-plan.ts
├── scripts/
├── BITCHORD-NOTICE.txt
├── GPL-3.0.txt
├── index.html
├── package.json
└── vite.config.ts
```

The previous local Spotify/BitChord server implementation is no longer part of the Cider plugin. Spotify authentication and Canvas discovery live on the managed API instead.

## Development

### Requirements

- Node.js **20.19+**
- npm
- Cider with PluginKit v4 support

### Install

```bash
npm install
```

### Start the development server

```bash
npm run dev
```

Development uses Vite on:

```text
127.0.0.1:3058
```

The Vite development server only serves the plugin during development. It is not the Spotify Canvas backend.

### Type-check

```bash
npm run check
```

### Production build

```bash
npm run build
```

### Package

```bash
npm run pack
```

### Sanity checks

```bash
npm run sanity
```

## Diagnostics

The browser console logs the current track identity, Canvas API requests, match results, and Canvas attachment lifecycle. Real Spotify session values are never intentionally logged by the plugin.

## Architecture

```text
Cider
  │
  │ track metadata only
  ▼
Managed Canvas API
  │
  │ server-side Spotify session
  ▼
Spotify internal search + Canvas
  │
  │ Canvas MP4 URL
  ▼
Cider Canvas portal
```

## Credits and notices

The backend authentication design is based on the BitChord approach of using a real Spotify Web Player session with an `sp_dc` cookie and capturing the logged-in token Spotify issues to that session. The Cider plugin does not contain the user's Spotify credential.

Spotify's internal Canvas services are not a stable public API and may change independently of this project.

## License

This project is distributed under the license included in `GPL-3.0.txt`.
