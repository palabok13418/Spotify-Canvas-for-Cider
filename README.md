<p align='center'>
  <img src='logo.png' alt='Canvas for Cider' width='180'>
</p>

<h1 align='center'>Canvas for Cider</h1>

<p align='center'>
  Spotify Canvas, but inside Cider.
</p>

<p align='center'>
  <a href='https://github.com/palabok13418/Spotify-Canvas-for-Cider/releases'>Releases</a>
  ·
  <a href='https://github.com/palabok13418/Spotify-Canvas-for-Cider/issues'>Issues</a>
  ·
  <a href='https://github.com/palabok13418/Spotify-Canvas-for-Cider-API'>Canvas API</a>
</p>

---

## What is Canvas for Cider?

Canvas for Cider is a Cider PluginKit v4 plugin that displays Spotify Canvas videos while you're listening to Apple Music in Cider.

The idea is pretty simple: instead of keeping Canvas somewhere else, the video becomes part of the Cider UI.

You can put it in three places:

| Placement | What it does |
| --- | --- |
| **Lyrics** | Shows Canvas behind the Lyrics area |
| **Navigation** | Uses the left navigation area |
| **Mini Player** | Places Canvas around the Mini Player |

The plugin follows the track currently playing in Cider, looks for a matching Spotify track, and loads its Canvas when one is available.

## 🔐 Do I need a Spotify token?

**No.**

You do not enter a Spotify login or an `sp_dc` token into the plugin.

The plugin sends track metadata to the project's hosted Canvas API. Spotify-side authentication and the Canvas lookup happen there instead, keeping the session credential out of the Cider plugin.

---

## What you'll see

A few of the things the plugin currently handles:

- 🎬 Spotify Canvas MP4 playback inside Cider
- 📝 Lyrics placement
- 🧭 Navigation placement
- 🎛️ Mini Player placement
- 🔄 A persistent Canvas layer that survives Cider UI changes
- ⚡ Automatic track-change detection
- 🧠 Successful-result caching
- 🛑 Cancellation of stale Canvas lookups
- 🌫️ Fading and blending so the video doesn't get in the way
- 🖱️ A non-interactive Canvas layer so normal Cider controls still work
- ♿ Reduced-motion support
- ⚙️ Quick placement settings from the Lyrics area

There is also recovery logic for cases where the browser or Cider interrupts Canvas playback.

---

## How it works

You don't really have to think about the internals when you're using it.

Behind the scenes, the plugin does roughly this:

1. Cider tells the plugin what song is playing.
2. The plugin collects the useful track metadata Cider already has.
3. That metadata is sent to the hosted Canvas API.
4. The API finds the best Spotify track match it can.
5. Spotify's Canvas data is requested.
6. The Canvas URL is sent back to Cider.
7. The plugin puts the video wherever you selected.

Depending on what Cider provides, the lookup can use things like:

- song title
- artist
- album
- album artist
- ISRC
- duration
- release year
- track number
- disc number
- artwork URL

No Spotify session credential is sent from the client with that track metadata.

---

## Settings

There isn't a huge settings page. The main choice is simply where you want Canvas to appear.

### Canvas placement

Choose:

**Lyrics** · **Navigation** · **Mini Player**

The selection is saved through Cider's plugin configuration.

### Quick settings

When Cider exposes its Lyrics control, Canvas for Cider adds a small Canvas button beside it. Clicking it opens the placement menu without making you open the full plugin settings page.

---

## For developers 🧑‍💻

The plugin is written in **TypeScript**, **Vue**, and **Vite**, and targets **Cider PluginKit v4**.

The main architectural split is intentional: the Cider plugin handles the UI and track information, while the hosted API handles Spotify authentication and Canvas lookup.

~~~text
┌─────────────────────────────┐
│            Cider            │
│                             │
│  Current Apple Music track  │
└──────────────┬──────────────┘
               │
               │ track metadata
               ▼
┌─────────────────────────────┐
│     Canvas API (Vercel)     │
│                             │
│  Spotify authentication     │
│  Track matching             │
│  Canvas retrieval           │
└──────────────┬──────────────┘
               │
               │ Canvas MP4 URL
               ▼
┌─────────────────────────────┐
│      Canvas for Cider       │
│                             │
│  Lyrics / Navigation / Mini │
└─────────────────────────────┘
~~~

### Project layout

~~~text
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
~~~

### Good places to start

| File | Purpose |
| --- | --- |
| `src/main.ts` | Plugin entry point and registration |
| `src/components/Overlay.vue` | Track detection, Canvas lookup, caching, and request lifecycle |
| `src/components/LyricCanvas.vue` | Canvas portal, placement detection, positioning, layering, and playback recovery |
| `src/components/LyricsCanvasButton.vue` | Adds the Canvas button beside Lyrics |
| `src/components/CanvasSettingsPanel.vue` | Placement settings |
| `src/components/QuickSettings.vue` | Quick-settings popup |
| `src/components/Settings.vue` | Main settings screen |
| `src/canvas-api.ts` | Client for the hosted Canvas API |
| `src/core/currentTrack.ts` | Current Cider/Apple Music metadata |
| `src/config.ts` | Plugin configuration and persistence |
| `src/plugin.config.ts` | PluginKit metadata |

---

## 🛠️ Run it locally

### Requirements

- Node.js 20.19+
- npm
- Cider with PluginKit v4 support

### Install

~~~bash
npm install
~~~

### Start the dev server

~~~bash
npm run dev
~~~

The plugin's development server uses:

~~~text
127.0.0.1:3058
~~~

This is only the **Cider plugin** development server. The Spotify/Canvas backend is hosted separately.

Other useful commands:

~~~bash
npm run check
npm run build
npm run pack
npm run sanity
~~~

---

## 🔎 Debugging

The plugin writes useful information to the browser console while it runs.

Depending on what you're debugging, you may see messages about the current track, Canvas API requests, Spotify matching, Canvas availability, placement, cancelled requests after a track change, and playback recovery.

The plugin does not intentionally log the server's Spotify session credential.

---

## 🌐 Hosted Canvas API

The production API is:

**https://spotify-canvas-for-cider-api.vercel.app**

The main resolver endpoint is:

~~~text
POST /api/resolve-canvas
~~~

The backend has its own repository:

**https://github.com/palabok13418/Spotify-Canvas-for-Cider-API**

Keeping the resolver separate is what allows the public Cider plugin to stay credential-free.

---

## A few things to know

Spotify Canvas is not exposed through a stable public Canvas API that this project controls.

Because this project relies on Spotify services and internal behavior, things can change. Search behavior, authentication, response formats, and Canvas availability may all be affected by changes on Spotify's side.

Also, not every song has a Canvas, so a song having no video is normal.

An internet connection is required for the hosted lookup.

---

## 📜 Credits

### Cider logo

The **Cider logo used as part of the Canvas for Cider plugin logo** is credited to **[cryptofyre](https://github.com/cryptofyre)**.

### BitChord

The backend Spotify Web Player authentication approach is based on the **BitChord** project. The repository includes `BITCHORD-NOTICE.txt` with the relevant notice and attribution.

### Cider

This plugin is made for [Cider](https://cider.sh/), the Apple Music client.

Canvas for Cider is an independent plugin and is not affiliated with or endorsed by Spotify or Apple.

---

## 📄 License

Canvas for Cider is released under the **GNU General Public License v3.0**.

See [GPL-3.0.txt](GPL-3.0.txt) for the full license text.

<p align='center'><sub>Canvas for Cider · Cider PluginKit v4 · TypeScript · Vue · Vite</sub></p>