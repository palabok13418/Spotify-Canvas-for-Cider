<p align="center">
  <img src="logo.png" alt="Canvas for Cider logo" width="180" />
</p>

<h1 align="center">Canvas for Cider</h1>

<p align="center">
  Spotify Canvas video support for Cider, with a persistent portal, quick settings, and selectable placement.
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#how-it-works">How it works</a> •
  <a href="#settings">Settings</a> •
  <a href="#project-structure">Project structure</a> •
  <a href="#development">Development</a>
</p>

---

## About

**Canvas for Cider** is a Cider PluginKit v4 plugin that brings Spotify Canvas loops into Cider using the user's own Spotify web session.

The plugin is designed around one important requirement: **Cider's UI can rebuild its Lyrics, Navigation, and Mini Player surfaces while a song or view changes.** Instead of permanently inserting the Canvas into those disposable DOM trees, the plugin owns its Canvas portal under the document body and synchronizes that portal with the currently visible Cider surface.

The result is a Canvas layer that can survive Cider DOM replacement while remaining visually attached to the selected part of the interface.

## Features

- 🎬 Spotify Canvas MP4 playback inside Cider
- 🔁 Persistent Canvas portal that survives Cider UI replacement
- 🧭 Three placement modes:
  - **Lyrics**
  - **Navigation**
  - **Mini Player**
- 🎛️ Quick-settings button beside the Lyrics control
- 🔐 `sp_dc` session-token entry with an explicit **Save** button
- 🧠 Positive Canvas-result caching to avoid unnecessary repeat searches
- ⚡ Stale-request cancellation when the current track changes
- ♻️ Immediate relatching/retry behavior when the target surface is rebuilt
- ▶️ Playback recovery for pause, ended, waiting, and stalled states
- 🌫️ Canvas blending/fading with the surrounding Cider UI
- 🖱️ Canvas layers do not intercept clicks intended for Cider controls
- ♿ Reduced-motion protection for users who prefer reduced motion
- 🧩 Plugin-owned UI that is independent from Cider's disposable content nodes

## How it works

### 1. Identify the current track

Canvas for Cider reads the currently playing Apple Music/Cider track information and creates a stable identity using available identifiers such as catalog ID, ISRC, URI, or a normalized title/artist/album fallback.

### 2. Resolve a Spotify Canvas

When a Canvas is needed, the plugin uses the configured Spotify web session (`sp_dc`) to authenticate and search Spotify's internal services for a matching Canvas.

The search logic considers track information such as title, artist, album, ISRC, duration, year, track/disc information, and related match signals before selecting a Canvas URL.

The project includes BitChord-derived authentication/Canvas implementation files for this purpose. See `BITCHORD-NOTICE.txt` for the corresponding notice.

### 3. Keep the Canvas outside Cider's disposable DOM

The Canvas element is owned by the plugin and mounted under `<body>` instead of being permanently embedded inside a Cider-managed Lyrics/Navigation/Mini Player component.

Conceptually:

```text
<body>
  Cider UI
  ...
  Canvas for Cider portal
</body>
```

When Cider rebuilds a target surface, the plugin finds the new surface and synchronizes the existing portal to it instead of losing the Canvas element with the old DOM node.

This is the architecture that fixed the recurring **first song works, later song has no Canvas** problem during development.

### 4. Match the target's real screen geometry

The portal uses the selected target surface's live `getBoundingClientRect()` values to determine its on-screen position and size.

The placement system has separate target finders for:

```text
Lyrics        → find the concrete right-side Lyrics surface
Navigation    → find the visible Navigation surface
Mini Player   → find the bottom playback surface
```

The portal is then positioned against the target's current geometry and continuously re-synchronized when Cider changes layout, resizes the window, or replaces the target node.

### 5. Keep the Canvas behind the Cider UI

The Canvas layer is intentionally non-interactive and uses controlled stacking so Cider's text, buttons, and controls remain usable above it.

The tested portal behavior uses a deliberately lower stacking position instead of placing the Canvas above native controls.

The visual layer also uses controlled opacity and blending so Canvas behaves like a background visual rather than a replacement for Cider's UI.

### 6. Recover from Cider and browser lifecycle changes

When a Canvas URL is available, the plugin can immediately begin attaching it to the selected target and retry until the attachment is verified.

Playback recovery watches for media lifecycle events and can re-attempt playback when a Canvas unexpectedly pauses, ends, waits, or stalls.

## Settings

Canvas for Cider provides the same configuration from both the plugin settings page and its quick-settings popup.

### Spotify session

Paste your own Spotify `sp_dc` value into the token field and press **Save**. The value is stored in the plugin's configuration instead of requiring source-code edits.

The token is treated as a secret value:

- it is not intentionally printed to the console
- it is not embedded into the repository
- users should never commit their personal token to Git

### Canvas placement

Choose where the Canvas portal should synchronize:

| Option | Purpose |
|---|---|
| **Lyrics** | Right-side Lyrics area of the main Cider window |
| **Navigation** | Navigation/sidebar surface |
| **Mini Player** | Mini Player playback surface |

Only one Canvas portal is used at a time; the same plugin-owned architecture is reused across placement modes, while each mode has its own target-detection logic.

## Quick-settings button

A Canvas button is inserted directly beside Cider's Lyrics button when that control is available.

The button opens a small plugin-owned popup containing the same settings as the main plugin settings screen.

The plugin's SVG artwork is embedded/bundled with the plugin rather than depending on an application-root asset URL. This avoids host-origin/path issues that can occur when a plugin tries to load `/logo.svg` as if it belonged to Cider itself.

## Project structure

```text
Canvas for Cider/
├── public/
│   ├── icon.svg
│   ├── logo.svg
│   └── ...
├── src/
│   ├── components/
│   │   ├── CanvasSettingsPanel.vue
│   │   ├── LyricsCanvasButton.vue
│   │   ├── LyricCanvas.vue
│   │   ├── Overlay.vue
│   │   ├── QuickSettings.vue
│   │   └── Settings.vue
│   ├── core/
│   │   └── currentTrack.ts
│   ├── server/
│   │   ├── bitchord-auth.js
│   │   ├── bitchord-canvas.js
│   │   └── spotify.ts
│   ├── boot.ts
│   ├── cider.ts
│   ├── config.ts
│   ├── main.ts
│   ├── plugin.config.ts
│   └── search-plan.ts
├── scripts/
│   ├── pack.mjs
│   └── sanity.mjs
├── BITCHORD-NOTICE.txt
├── GPL-3.0.txt
├── index.html
├── package.json
└── vite.config.ts
```

### Main source files

**`src/components/LyricCanvas.vue`**

Contains the Canvas portal renderer, target discovery, placement logic, geometry synchronization, stacking behavior, fade/blending layers, and playback recovery.

**`src/components/LyricsCanvasButton.vue`**

Adds the Canvas quick-settings button beside Cider's Lyrics control and opens the plugin-owned settings popup.

**`src/components/QuickSettings.vue`** and **`CanvasSettingsPanel.vue`**

Provide the compact settings experience and shared configuration controls.

**`src/config.ts`**

Defines the plugin configuration and persistence helpers, including `spDc` and Canvas placement.

**`src/components/Overlay.vue`**

Coordinates current-track changes, Canvas resolution, caching, stale request cancellation, and plugin lifecycle events.

**`src/server/bitchord-auth.js`** / **`bitchord-canvas.js`**

Handle Spotify session authentication and Canvas retrieval using the project's BitChord-derived implementation.

**`vite.config.ts`**

Builds the plugin bundle and generates the plugin metadata used by the packaged Cider extension.

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

The project uses:

```text
127.0.0.1:3058
```

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

## Debugging and diagnostics

When working on a new placement, test the target before testing the real video.

A useful diagnostic technique is to replace the Canvas video with a highly visible solid-color layer. That separates:

```text
Target discovery / portal attachment
                from
Canvas URL / video playback
```

For example:

```text
magenta layer missing
→ target detection/attachment problem

magenta layer appears, video missing
→ video loading/playback problem

layer covers native controls
→ stacking-context problem
```

Keep diagnostic UI out of production releases. Development-only messages such as “Finding Canvas” or “Found Canvas” should remain console diagnostics rather than user-facing notifications.

## Design principles

Canvas for Cider is built around a few rules:

1. **Own persistent overlays from the plugin side.**
2. **Do not trust one fragile Cider selector.** Combine stable attributes, semantic selectors, visibility, and geometry.
3. **Verify that a Canvas is actually attached before considering the operation successful.**
4. **Cache positive results and cancel stale searches.**
5. **Keep native Cider controls above the Canvas.**
6. **Do not watch every DOM attribute when a child-list observer is sufficient.**
7. **Never put real user secrets into source control or logs.**
8. **Separate diagnostic test builds from versioned releases.**

## Credits and notices

Canvas retrieval/authentication includes code derived from the BitChord approach. See `BITCHORD-NOTICE.txt` for the applicable attribution/notice information.

The plugin is intended to work with the user's own Spotify web session. Spotify's internal Canvas services are not a stable public API and may change independently of this project.

## License

This project is distributed under the license included in `GPL-3.0.txt`.

---

<p align="center">
  <sub>Canvas for Cider • PluginKit v4 • Built with TypeScript, Vue, and Vite</sub>
</p>
