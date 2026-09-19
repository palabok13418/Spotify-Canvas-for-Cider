import { ref, watch, type Ref } from "vue";

export type PAPIEvent =
  | "app:ready"
  | "shell:layout_type_changed"
  | "immersive:opened"
  | "immersive:closed"
  | "miniplayer:opened"
  | "miniplayer:closed"
  | "browser:page_changed"
  | "player:state_changed"
  | "playback:state_changed";

export interface PluginDefinition {
  setup(): void;
  name: string;
  identifier: string;
  ce_prefix?: string;
  description: string;
  version: string;
  author: string;
  repo: string;
  SettingsElement?: string;
  CustomElements?: Record<string, unknown>;
  pluginKitVersion?: string | number;
}

function getCider(): any {
  const cider = (globalThis as any).CiderApp;
  if (!cider) throw new Error("CiderApp is unavailable.");
  return cider;
}

export function saveConfig(): Promise<void> {
  const result = getCider()?.config?.saveConfig?.();
  return result && typeof result.then === "function" ? result : Promise.resolve();
}

export function subscribeEvent<T = unknown>(event: PAPIEvent, cb: (detail: T) => void): () => void {
  const papi = (globalThis as any).__PLUGINSYS__?.PAPIInstance;
  if (!papi || typeof papi.addEventListener !== "function") throw new Error("Cider Plugin API is unavailable.");
  const wrapped = (e: CustomEvent<T>) => cb(e?.detail);
  papi.addEventListener(event, wrapped);
  return () => {
    try { papi.removeEventListener?.(event, wrapped); } catch {}
  };
}

export const AppleMusic = {
  get nowPlayingItem(): unknown {
    return (globalThis as any).__PLUGINSYS__?.Stores?.appleMusicStore?.nowPlayingItem ?? null;
  }
};

export function definePluginContext(options: PluginDefinition) {
  const plugin = { ...options, pluginKitVersion: 4 } as PluginDefinition;
  const customElementName = (name: string) => `${options.ce_prefix ?? options.identifier}-${name}`;

  function setupConfig<T extends Record<string, any>>(defaults: T): Ref<T> {
    const cider = getCider();
    if (!cider.config) throw new Error("Cider configuration API is unavailable.");
    const configRoot = cider.config.getRef ? cider.config.getRef() : cider.config;
    configRoot.plugins ??= {};

    // Cider's config root can be a reactive/proxied object containing host
    // references (including Window). Never structuredClone the whole plugin
    // config object because Window/DOM objects trigger DataCloneError.
    // Copy only the primitive/plain values that this plugin actually declares.
    const existing = configRoot.plugins[options.identifier];
    const initial = { ...defaults } as T;
    if (existing && typeof existing === "object") {
      for (const key of Object.keys(defaults) as Array<keyof T>) {
        const value = (existing as any)[key as string];
        const fallback = defaults[key];
        if (value === null || value === undefined) continue;
        if (typeof fallback === "string" && typeof value === "string") (initial[key] as any) = value;
        else if (typeof fallback === "boolean" && typeof value === "boolean") (initial[key] as any) = value;
        else if (typeof fallback === "number" && typeof value === "number" && Number.isFinite(value)) (initial[key] as any) = value;
      }
    }

    configRoot.plugins[options.identifier] = { ...initial };
    const cfgRef = ref(initial) as Ref<T>;

    watch(cfgRef, value => {
      // Persist only declared primitive/plain values, never the Vue proxy or
      // arbitrary properties a host may have attached to its config object.
      const next: Record<string, any> = {};
      for (const key of Object.keys(defaults)) {
        const current = (value as any)[key];
        const fallback = (defaults as any)[key];
        if (typeof fallback === "string" && typeof current === "string") next[key] = current;
        else if (typeof fallback === "boolean" && typeof current === "boolean") next[key] = current;
        else if (typeof fallback === "number" && typeof current === "number" && Number.isFinite(current)) next[key] = current;
        else next[key] = fallback;
      }
      configRoot.plugins[options.identifier] = next;
    }, { deep: true });
    return cfgRef;
  }

  return {
    plugin,
    customElementName,
    setupConfig,
    useCPlugin: () => plugin
  };
}


export interface CustomImmersiveLayout {
  name: string;
  identifier: string;
  component: string;
  type?: "normal" | "portrait";
}

export function addImmersiveLayout(layout: CustomImmersiveLayout) {
  const manager = (globalThis as any).__PLUGINSYS__?.Components?.ImmersiveLayouts;
  if (!manager || typeof manager.addLayout !== "function") {
    throw new Error("Cider Immersive Layout API is unavailable.");
  }
  return manager.addLayout(layout);
}
