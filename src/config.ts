import { type Ref } from "vue";
import { saveConfig } from "./cider";

export type CanvasPlacement = "lyrics" | "navigation" | "mini";

export interface PluginConfig {
  placement: CanvasPlacement;
}

export const defaults: PluginConfig = {
  placement: "lyrics",
};

let configRef: Ref<PluginConfig> | null = null;

export function bindConfig(
  setupConfig: (defaults: PluginConfig) => Ref<PluginConfig>
): Ref<PluginConfig> {
  if (!configRef) configRef = setupConfig(defaults);
  return configRef;
}

export function useConfig(): PluginConfig {
  if (!configRef) throw new Error("Plugin config has not been initialized.");
  return configRef.value;
}

export async function persistConfig() {
  await saveConfig();
}
