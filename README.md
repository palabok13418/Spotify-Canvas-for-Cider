<p align="center">
  <img src="logo.png" alt="Canvas for Cider" width="180">
</p>

<h1 align="center">Canvas for Cider</h1>

<p align="center"><strong>Bring Spotify Canvas visuals to your Apple Music playback in Cider.</strong></p>
<p align="center">A Cider PluginKit v4 plugin with Lyrics, Navigation, and Mini Player placement.</p>

<p align="center">
  <a href="https://github.com/palabok13418/Spotify-Canvas-for-Cider/releases">Releases</a>
  · <a href="https://github.com/palabok13418/Spotify-Canvas-for-Cider/issues">Issues</a>
  · <a href="https://github.com/palabok13418/Spotify-Canvas-for-Cider-API">Canvas API</a>
</p>

---

## 🎵 What is Canvas for Cider?

**Canvas for Cider** is a plugin for [Cider](https://cider.sh/) that shows short, looping **Spotify Canvas videos** while you listen to music from Apple Music.

Instead of opening Canvas in a separate window, the plugin places it directly into Cider’s interface. You can choose where it appears:

| Placement | What it does |
| --- | --- |
| **Lyrics** | Displays Canvas behind the main Lyrics area |
| **Navigation** | Displays Canvas in the left navigation area |
| **Mini Player** | Displays Canvas around the bottom Mini Player |

The plugin is designed to stay attached to Cider even when Cider rebuilds or replaces parts of its interface.

### 🔐 Do I need a Spotify token?

**No.**

The Cider plugin does **not** ask you to enter an sp_dc token or Spotify login information.

The plugin sends the current song’s metadata to the project’s managed Canvas API. Spotify authentication and Canvas lookup happen on the server side.

> **Your Spotify session credential is not part of the Cider plugin bundle or its settings.**

---

## ✨ Features

- 🎬 **Spotify Canvas MP4 playback** inside Cider
- 📝 **Lyrics placement** for a background-style Canvas effect
- 🧭 **Navigation placement** for the Cider sidebar
- 🎛️ **Mini Player placement** for the bottom playback area
- 🔄 **Persistent Canvas portal** that survives Cider UI replacement
- ⚡ **Automatic track detection** when the playing song changes
- 🧠 **Positive-result caching** to reduce repeated lookups
- 🛑 **Stale-request cancellation** so an old song cannot replace the new song’s Canvas
- 🌫️ **Blending and fading** so Canvas behaves like a visual layer rather than covering controls
- 🖱️ **Non-interactive Canvas layer** so normal Cider controls remain clickable
- ♿ **Reduced-motion support** for users who prefer less animation
- 🎛️ **Quick settings** available from the Canvas button beside Cider’s Lyrics control

---

## 🖥️ What happens when you play a song?

    You play a song in Cider
            │
            ▼
    Canvas for Cider reads the song information
            │
            ▼
    Managed Canvas API finds the matching Spotify track
            │
            ▼
    Spotify Canvas is requested
            │
            ▼
    Canvas URL is returned to Cider
            │
            ▼
    Canvas is displayed in your selected Cider location

The plugin can use information such as:

- Song title
- Artist
- Album
- Album artist
- ISRC
- Duration
- Release year
- Track number
- Disc number
- Artwork URL

The plugin itself does **not** send a Spotify credential with this metadata.

---

## ⚙️ Settings

Canvas for Cider keeps its settings intentionally simple.

### Canvas placement

Choose one of:

**Lyrics** · **Navigation** · **Mini Player**

Your selection is saved through Cider’s plugin configuration.

### Quick settings

A small Canvas button is placed beside Cider’s Lyrics control when that control is available.

Clicking it opens a compact placement menu without needing to open the full plugin settings page.

---

# 🧑‍💻 For developers

Canvas for Cider is built with **TypeScript, Vue, and Vite** and targets **Cider PluginKit v4**.

The Cider plugin is intentionally separated from Spotify authentication:

    ┌─────────────────────────────┐
    │            Cider            │
    │                             │
    │  Current Apple Music track  │
    └──────────────┬──────────────┘
                   │ metadata only
                   ▼
    ┌─────────────────────────────┐
    │     Managed Canvas API      │
    │          Vercel             │
    │                             │
    │  Server-side Spotify auth   │
    │  Track matching             │
    │  Canvas retrieval           │
    └──────────────┬──────────────┘
                   │ Canvas MP4 URL
                   ▼
    ┌─────────────────────────────┐
    │      Canvas for Cider       │
    │                             │
    │  Persistent portal          │
    │  Lyrics / Navigation / Mini │
    └─────────────────────────────┘

### Repository layout

    Canvas for Cider/
    ├── public/
    │   ├── icon.png
    │   ├── logo.png
    │   └── logo.svg
    ├── src/
    │   ├── assets/
    │   │   └── logo.svg
    │   ├── components/
    │   │   ├── CanvasSettingsPanel.vue
    │   │   ├── LyricsCanvasButton.vue
    │   │   ├── LyricCanvas.vue
    │   │   ├── Overlay.vue
    │   │   ├── QuickSettings.vue
    │   │   └── Settings.vue
    │   ├── core/
    │   │   └── currentTrack.ts
    │   ├── boot.ts
    │   ├── canvas-api.ts
    │   ├── cider.ts
    │   ├── config.ts
    │   ├── main.ts
    │   ├── plugin.config.ts
    │   ├── search-plan.ts
    │   └── state.ts
    ├── scripts/
    │   ├── pack.mjs
    │   └── sanity.mjs
    ├── BITCHORD-NOTICE.txt
    ├── GPL-3.0.txt
    ├── index.html
    ├── package.json
    ├── tsconfig.app.json
    ├── tsconfig.json
    └── vite.config.ts

### Important source files

| File | Purpose |
| --- | --- |
| <code>src/main.ts</code> | Plugin entry point and custom-element registration |
| <code>src/components/Overlay.vue</code> | Current-track detection, Canvas lookup, caching, and request lifecycle |
| <code>src/components/LyricCanvas.vue</code> | Persistent Canvas portal, placement detection, positioning, layering, and playback recovery |
| <code>src/components/LyricsCanvasButton.vue</code> | Adds the Canvas quick-settings button beside Lyrics |
| <code>src/components/CanvasSettingsPanel.vue</code> | Placement settings |
| <code>src/components/QuickSettings.vue</code> | Quick-settings popup |
| <code>src/components/Settings.vue</code> | Main plugin settings screen |
| <code>src/canvas-api.ts</code> | Client for the managed Canvas API |
| <code>src/core/currentTrack.ts</code> | Extracts current Cider/Apple Music metadata |
| <code>src/config.ts</code> | Placement configuration and persistence |
| <code>src/plugin.config.ts</code> | Cider PluginKit metadata |
| <code>vite.config.ts</code> | Vite build and development-server configuration |

---

## 🔧 Local development

### Requirements

- **Node.js 20.19+**
- **npm**
- A Cider installation with PluginKit v4 support

### Install

    npm install

### Start the development server

    npm run dev

The development server runs on:

    127.0.0.1:3058

This local Vite server is for developing the **Cider plugin**. It is **not** the Spotify Canvas backend.

### Type-check

    npm run check

### Build

    npm run build

### Package

    npm run pack

### Sanity checks

    npm run sanity

---

## 🔍 Diagnostics

The plugin writes useful lifecycle information to the browser console, including:

- Current track identity
- Canvas API requests
- Spotify match results
- Canvas URL availability
- Portal placement and attachment
- Track-change cancellation
- Canvas playback recovery

Example log sequence:

    [Canvas for Cider] Player track identity ...
    [Canvas for Cider] Canvas API resolver starting ...
    [Canvas for Cider] Canvas URL received from API ...

Real Spotify session credentials are not intentionally logged by the plugin.

---

## 🌐 Managed Canvas API

The plugin’s production resolver is hosted at:

    https://spotify-canvas-for-cider-api.vercel.app

Primary endpoint:

    POST /api/resolve-canvas

The endpoint accepts track metadata and returns the matched Spotify track information plus a Canvas URL when one is available.

The backend project lives in:

https://github.com/palabok13418/Spotify-Canvas-for-Cider-API

---

## 🧩 Design principles

1. **Keep Spotify credentials off the client.**
2. **Keep the Canvas portal owned by the plugin**, rather than permanently attaching it to Cider’s disposable UI nodes.
3. **Use live geometry** when positioning the Canvas so it follows Cider’s current layout.
4. **Cancel stale lookups** when the current song changes.
5. **Cache successful Canvas results** to avoid unnecessary repeat work.
6. **Keep Canvas non-interactive** so Cider controls continue working normally.
7. **Prefer resilient DOM detection** over depending on one fragile selector.
8. **Keep diagnostic behavior out of the normal user-facing UI.**

---

## ⚠️ Limitations

Canvas retrieval currently depends on Spotify services that are **not a stable public Canvas API**.

That means Spotify can change:

- Internal endpoints
- Response formats
- Authentication behavior
- Track-search behavior
- Canvas availability

Some songs simply won't have a Canvas, and Spotify can also change the behavior this project relies on.

The plugin also requires an active network connection to contact the managed Canvas API.

---

## 📜 Credits & notices

The backend authentication approach is based on the **BitChord** approach for working with a Spotify Web Player session. See <code>BITCHORD-NOTICE.txt</code> for the applicable project notice and attribution.

The Cider plugin itself does not contain the server’s Spotify session credential.

---

## 📄 License

This project is distributed under the **GNU General Public License v3.0**.

See [GPL-3.0.txt](GPL-3.0.txt) for the full license text.

<p align="center"><sub>Canvas for Cider · Cider PluginKit v4 · TypeScript · Vue · Vite</sub></p>
