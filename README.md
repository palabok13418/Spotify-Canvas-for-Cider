<p align="center">
  <img src="logo.png" alt="Canvas for Cider" width="180">
</p>

<h1 align="center">Canvas for Cider</h1>

<p align="center">
  Spotify Canvas, but inside Cider.
</p>

<p align="center">
  <a href="https://github.com/palabok13418/Spotify-Canvas-for-Cider/releases">Releases</a>
  ·
  <a href="https://github.com/palabok13418/Spotify-Canvas-for-Cider/issues">Issues</a>
  ·
  <a href="https://github.com/palabok13418/Spotify-Canvas-for-Cider-API">Canvas API</a>
</p>

---

## What is Canvas for Cider?

Canvas for Cider is a Cider PluginKit v4 plugin that shows Spotify Canvas while you're listening to Apple Music in Cider.

The plugin follows the track loaded in Cider, asks the hosted Canvas API for the matching Spotify Canvas, and then places the video in the part of Cider you selected.

Current placements:

| Placement | What it does |
| --- | --- |
| **Lyrics** | Places Canvas behind the Lyrics area |
| **Navigation** | Places Canvas in the left navigation area |
| **Immersive (One)** | Uses a dedicated Cider Immersive layout named **One** |

## Do I need a Spotify token?

**No.**

The Cider plugin does not ask for an `sp_dc` token and does not store a Spotify session credential.

Spotify authentication stays on the hosted Canvas API. The plugin only sends the current track metadata that Cider already has.

---

## What it does

- 🎬 Spotify Canvas playback inside Cider
- 📝 Lyrics placement
- 🧭 Navigation placement
- 🖼️ Dedicated Immersive **One** layout
- ✨ Four-point-star Canvas reveal animation
- 🔄 Animated Canvas-to-Canvas switching
- 🌠 Fast-spin Immersive entry and reverse exit animation
- 🧠 Apple Music animated-artwork comparison before showing a duplicate Canvas
- 🌈 Lyrics-only left-side ambiance
- 🌫️ Four-sided Immersive edge blending
- 🎚️ Canvas transparency from visible to transparent
- ⚡ Track-change detection and stale-request cancellation
- 💾 Successful Canvas-result caching
- ▶️ Playback recovery when a Canvas video stalls
- ♿ Reduced-motion support

---

## How it works

The normal flow is:

1. Cider reports the current Apple Music track.
2. The plugin collects title, artist, album, ISRC, duration, release year, and other useful metadata.
3. The plugin sends that metadata to the hosted Canvas API.
4. The API searches Spotify for the best matching track.
5. Spotify Canvas data is requested for that track.
6. Before activation, the plugin checks whether Cider already has matching animated album artwork.
7. When a different Canvas is needed, the renderer animates the old and new videos instead of abruptly replacing the current image.
8. The Canvas is shown in Lyrics, Navigation, or the dedicated Immersive One layout.

---

## Canvas placement

### Lyrics

The main Canvas stays visually unchanged. A separate blurred copy extends **only to the left** of the Canvas rectangle to add a small amount of ambient color to the surrounding main window.

The Canvas itself does not use a whole-video blend mode for this effect.

### Navigation

Canvas is placed in the left navigation area. Navigation text and controls remain interactive.

### Immersive (One)

Immersive placement is implemented as a real Cider custom Immersive layout named **One**, using Cider's PluginKit Immersive Layout API.

This means the plugin does not try to guess an arbitrary fullscreen DOM element and inject Canvas into it.

The Immersive layout has its own centered Canvas surface, a blurred background, and edge blending around all four sides.

---

## Canvas analysis

Some Apple Music releases include tall animated album artwork. Artists can also reuse that artwork as Spotify Canvas.

Canvas for Cider checks for a visible Apple Music animated-artwork video or an animated artwork URL exposed by Cider. It compares sampled video frames with the Spotify Canvas.

When the evidence is strong enough that the two videos are the same artwork, the Spotify Canvas is suppressed so Cider's existing Apple Music artwork does not get duplicated.

The check is deliberately **fail-open**: when the artwork cannot be inspected, normal Canvas playback continues.

---

## Animations

### First appearance

A new Canvas starts as a small four-point star and opens outward until the full Canvas is visible.

### Switching Canvas

When one Canvas changes to another, the incoming Canvas expands from the same star-like shape while the outgoing Canvas fades and softens.

The actual Canvas video is kept separate from the animated reveal mask so the video itself is not zoomed or distorted during the transition.

### Immersive

The dedicated Immersive One layout uses the same four-point-star concept with a fast rotation on entry.

Leaving Immersive reverses that motion by rotating back toward the center while shrinking into the star shape.

---

## Settings

The settings panel currently includes:

- **Lyrics**
- **Navigation**
- **Immersive (One)**

It also includes the **Canvas transparency** slider.

The Immersive option only refers to the plugin's dedicated **One** Immersive layout.

---

## Search improvements

The hosted resolver does not assume that Apple Music and Spotify use the same title.

For example, a track can appear as:

`KYUBI`

on Apple Music and:

`九尾`

on Spotify.

The resolver now uses several identity paths:

- exact ISRC when available
- artist and album
- artist-only fallback
- title + artist variants
- duration
- release year
- track and disc position
- Unicode-aware normalization
- punctuation-safe search values

The resolver also has a secondary Spotify Web API search fallback when the internal Spotify search path does not produce candidates.

This is particularly important for titles written in different scripts.

Punctuation such as:

`- = [ ] \\ ; ' , . / ` ~ ! @ # $ & * ( ) _ + { } | : " < > ?`

is sanitized before it is used to build Spotify search queries.

---

## Hosted Canvas API

Production API:

`https://spotify-canvas-for-cider-api.vercel.app`

Main endpoint:

`POST /api/resolve-canvas`

The backend repository is:

https://github.com/palabok13418/Spotify-Canvas-for-Cider-API

The backend owns Spotify authentication and Canvas retrieval so the client plugin remains credential-free.

---

## For developers 🧑‍💻

The project uses TypeScript, Vue, Vite, and Cider PluginKit v4.

### Important files

| File | Purpose |
| --- | --- |
| `src/main.ts` | Plugin entry point, custom-element registration, and Immersive layout registration |
| `src/components/Overlay.vue` | Track detection, Canvas API requests, caching, analysis, and lifecycle |
| `src/components/LyricCanvas.vue` | Lyrics and Navigation renderer plus Canvas animations |
| `src/components/ImmersiveCanvasOne.vue` | Dedicated Immersive One renderer |
| `src/artwork-analysis.ts` | Apple animated-artwork detection and frame comparison |
| `src/components/CanvasSettingsPanel.vue` | Placement and transparency settings |
| `src/core/currentTrack.ts` | Current Apple Music/Cider metadata |
| `src/canvas-api.ts` | Client for the hosted Canvas API |
| `src/config.ts` | Plugin configuration and persistence |
| `src/plugin.config.ts` | PluginKit metadata |

### Local development

Requirements:

- Node.js 20.19+
- npm
- Cider with PluginKit v4 support

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

The plugin development server uses:

`127.0.0.1:3058`

That port is for the **local plugin development server only**. The production Canvas API is separate.

Useful checks:

```bash
npm run check
npm run build
npm run pack
npm run sanity
```

---

## Debugging

The plugin writes useful diagnostics to the Cider browser console, including track changes, API requests, Canvas matching, analysis results, placement changes, and playback recovery.

The client does not intentionally log the server's Spotify session credential.

---

## Known limitations

Spotify Canvas availability and the services used to retrieve it can change independently of this project.

Not every Spotify track has a Canvas.

Apple animated-artwork analysis is intentionally conservative. It only suppresses Canvas when the visual evidence is strong enough.

The hosted API also depends on Spotify authentication and internal Spotify behavior, so changes on Spotify's side can affect matching or Canvas retrieval.

---

## Credits

### Cider logo

The Cider logo used by this project is credited to **[cryptofyre](https://github.com/cryptofyre)**.

### BitChord

The backend Spotify Web Player authentication approach is based on **[BitChord](https://github.com/kushagrasinghx/BitChord)**.

### Original Canvas API idea

The original Canvas API direction was inspired by **[Paxsenix0/Spotify-Canvas-API](https://github.com/Paxsenix0/Spotify-Canvas-API)**.

### Development

Development and debugging assistance was provided with **[ChatGPT](https://chatgpt.com/)** by OpenAI.

### Cider

This plugin is made for **[Cider](https://cider.sh/)**.

Canvas for Cider is an independent project and is not affiliated with or endorsed by Spotify or Apple.

---

## License

Canvas for Cider is released under the **GNU General Public License v3.0**.

See [GPL-3.0.txt](GPL-3.0.txt) for the full license text.

<p align="center">
  <sub>Canvas for Cider · PluginKit v4 · TypeScript · Vue · Vite</sub>
</p>
