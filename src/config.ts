import { type Ref } from "vue";
import { saveConfig } from "./cider";

export type CanvasPlacement = "lyrics" | "navigation" | "mini";

export interface PluginConfig {
  placement: CanvasPlacement;
  transparency: number;
}

export const defaults: PluginConfig = {
  placement: "lyrics",
  // 0% = fully visible, 100% = fully transparent.
  transparency: 50,
};

let configRef: Ref<PluginConfig> | null = null;

export function bindConfig(
  setupConfig: (defaults: PluginConfig) => Ref<PluginConfig>
): Ref<PluginConfig> {
  if (!configRef) {
    const configured = setupConfig(defaults);
    const transparency = Number(configured.value.transparency);
    configured.value.transparency = Number.isFinite(transparency)
      ? Math.max(0, Math.min(100, transparency))
      : defaults.transparency;
    configRef = configured;
  }
  return configRef;
}

export function useConfig(): PluginConfig {
  if (!configRef) throw new Error("Plugin config has not been initialized.");
  return configRef.value;
}

export async function persistConfig() {
  await saveConfig();
}
