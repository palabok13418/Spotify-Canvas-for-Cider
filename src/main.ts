import { defineCustomElement } from "vue";
import { bootDiagnostics } from "./boot";
import { definePluginContext } from "./cider";
import { persistConfig as savePluginConfig, bindConfig, getEffectiveSpDc } from "./config";
import PluginConfig from "./plugin.config";
import Settings from "./components/Settings.vue";
import Overlay from "./components/Overlay.vue";
import LyricCanvas from "./components/LyricCanvas.vue";
import LyricsCanvasButton from "./components/LyricsCanvasButton.vue";

const PREFIX = "[Canvas for Cider]";

// This log is intentionally at module evaluation time. If this is missing,
// Cider loaded the plugin entry but the entry itself did not execute.
bootDiagnostics();

console.log(PREFIX, "plugin entry executing", {
  version: PluginConfig.version,
  identifier: PluginConfig.identifier,
  href: globalThis.location?.href ?? null,
});

const SettingsElement = defineCustomElement(Settings, { shadowRoot: false });
const OverlayElement = defineCustomElement(Overlay, { shadowRoot: false });
const MainCanvasElement = defineCustomElement(LyricCanvas, { shadowRoot: false });
const LyricsCanvasButtonElement = defineCustomElement(LyricsCanvasButton, { shadowRoot: false });

// Register custom elements through the plugin metadata as well as locally.
// Cider 3.x uses the CustomElements map to expose plugin settings, while Cider 4
// also accepts the SettingsElement metadata. Keeping both paths makes the same
// settings component available across the two plugin hosts.
export const CustomElements = {
  settings: SettingsElement,
  overlay: OverlayElement,
  "main-canvas": MainCanvasElement,
  "lyrics-button": LyricsCanvasButtonElement,
};

function ciderReady() {
  return Boolean((globalThis as any).CiderApp && (globalThis as any).__PLUGINSYS__);
}

let startupSpDcCheckInFlight = false;

async function checkSpDcAtStartup(spDc: string) {
  if (startupSpDcCheckInFlight) return;
  startupSpDcCheckInFlight = true;
  const endpoint = "http://127.0.0.1:3058/api/canvas/check-spdc";
  try {
    if (!spDc) {
      console.log(PREFIX, "sp_dc startup check: not configured");
      return;
    }
    console.log(PREFIX, "sp_dc startup check: validating with Spotify");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spDc })
    });
    const data = await response.json().catch(() => ({}));
    console.log(PREFIX, "sp_dc startup check result", {
      status: response.status,
      ok: response.ok && data.valid === true,
      reason: data.reason || null,
      message: data.message || null
    });
    if (data.valid !== true) {
      if (data.reason === "sp_dc-invalid" || data.reason === "spotify-authentication-failed") {
        console.warn(PREFIX, "sp_dc is invalid or Spotify authentication failed");
      } else if (data.reason === "spotify-premium-or-access-required") {
        console.warn(PREFIX, "Spotify Premium or additional Spotify access may be required for this Canvas request");
      }
    }
  } catch (error) {
    console.warn(PREFIX, "sp_dc startup check failed", { endpoint, error: String(error) });
  } finally {
    startupSpDcCheckInFlight = false;
  }
}

function mountElement(name: string, ctor: CustomElementConstructor) {
  if (!customElements.get(name)) {
    customElements.define(name, ctor);
    console.log(PREFIX, "custom element registered", name);
  }
  if (!document.querySelector(name)) {
    document.body.appendChild(document.createElement(name));
    console.log(PREFIX, "custom element mounted", name);
  }
}

const { plugin, setupConfig, customElementName } = definePluginContext({
  CustomElements,
  ...PluginConfig,
  setup() {
    console.log(PREFIX, "plugin setup() called", {
      ciderReady: ciderReady(),
      hasCiderApp: Boolean((globalThis as any).CiderApp),
      hasPluginSys: Boolean((globalThis as any).__PLUGINSYS__),
    });

    try {
      const currentConfig = bindConfig(setupConfig).value;
      const effectiveSpDc = getEffectiveSpDc(currentConfig);
      console.log(PREFIX, "configuration initialized", {
        placement: currentConfig.placement,
        hasSpDc: Boolean(effectiveSpDc),
        spDcSource: currentConfig.spDc?.trim() ? "cider-config" : (effectiveSpDc ? "local-fallback" : "none")
      });

      const settingsName = customElementName("settings");
      const overlayName = customElementName("overlay");
      const mainCanvasName = customElementName("main-canvas");
      const lyricsButtonName = customElementName("lyrics-button");

      for (const [key, ctor] of Object.entries(CustomElements)) {
        const name = customElementName(key);
        if (!customElements.get(name)) {
          customElements.define(name, ctor);
          console.log(PREFIX, "legacy-compatible custom element registered", name);
        }
      }

      // Do not mount the settings element into Cider's main document body.
      // Cider owns and renders SettingsElement inside the plugin Settings UI.
      // Mounting it here made the settings controls/status leak into the main app UI.
      mountElement(overlayName, OverlayElement);
      mountElement(mainCanvasName, MainCanvasElement);
      document.querySelector<HTMLElement>(mainCanvasName)?.setAttribute("mode", "main");
      mountElement(lyricsButtonName, LyricsCanvasButtonElement);

      // SettingsElement is also declared in plugin.config.ts so Cider can expose
      // the Settings button before/while plugin setup completes.
      plugin.SettingsElement = settingsName;
      plugin.CustomElements = CustomElements;

      console.log(PREFIX, "runtime initialized", {
        settingsName,
        overlayName,
        mainCanvasName,
        lyricsButtonName,
        mediaSessionAvailable: Boolean(navigator.mediaSession),
        resolver: "http://127.0.0.1:3058/api/canvas/resolve",
      });

      void checkSpDcAtStartup(effectiveSpDc);
    } catch (error) {
      console.error(PREFIX, "plugin setup failed", error);
      // Retry once Cider's APIs are available rather than silently dying during
      // the initial plugin load race.
      window.setTimeout(() => {
        console.log(PREFIX, "retrying plugin setup", { ciderReady: ciderReady() });
        if (ciderReady()) plugin.setup();
      }, 1500);
    }
  }
});

export async function persistConfig() {
  await savePluginConfig();
}

export default plugin;
