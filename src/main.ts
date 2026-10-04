import { defineCustomElement } from "vue";
import { bootDiagnostics } from "./boot";
import { definePluginContext } from "./cider";
import { persistConfig as savePluginConfig, bindConfig } from "./config";
import PluginConfig from "./plugin.config";
import Settings from "./components/Settings.vue";
import Overlay from "./components/Overlay.vue";
import LyricCanvas from "./components/LyricCanvas.vue";
import LyricsCanvasButton from "./components/LyricsCanvasButton.vue";

const PREFIX = "[Canvas for Cider]";
const CANVAS_API = "https://spotify-canvas-for-cider-api.vercel.app";

bootDiagnostics();

console.log(PREFIX, "plugin entry executing", {
  version: PluginConfig.version,
  identifier: PluginConfig.identifier,
  href: globalThis.location?.href ?? null,
  canvasApi: CANVAS_API,
});

const SettingsElement = defineCustomElement(Settings, { shadowRoot: false });
const OverlayElement = defineCustomElement(Overlay, { shadowRoot: false });
const MainCanvasElement = defineCustomElement(LyricCanvas, { shadowRoot: false });
const LyricsCanvasButtonElement = defineCustomElement(LyricsCanvasButton, { shadowRoot: false });

export const CustomElements = {
  settings: SettingsElement,
  overlay: OverlayElement,
  "main-canvas": MainCanvasElement,
  "lyrics-button": LyricsCanvasButtonElement,
};

function ciderReady() {
  return Boolean((globalThis as any).CiderApp && (globalThis as any).__PLUGINSYS__);
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
      console.log(PREFIX, "configuration initialized", {
        placement: currentConfig.placement,
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

      mountElement(overlayName, OverlayElement);
      mountElement(mainCanvasName, MainCanvasElement);
      document.querySelector<HTMLElement>(mainCanvasName)?.setAttribute("mode", "main");
      mountElement(lyricsButtonName, LyricsCanvasButtonElement);

      plugin.SettingsElement = settingsName;
      plugin.CustomElements = CustomElements;

      console.log(PREFIX, "runtime initialized", {
        settingsName,
        overlayName,
        mainCanvasName,
        lyricsButtonName,
        mediaSessionAvailable: Boolean(navigator.mediaSession),
        resolver: `${CANVAS_API}/api/resolve-canvas`,
        spotifyCredentialSource: "managed-api-server",
      });
    } catch (error) {
      console.error(PREFIX, "plugin setup failed", error);
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
