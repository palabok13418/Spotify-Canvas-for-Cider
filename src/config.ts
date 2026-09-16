import { type Ref } from "vue";
import { saveConfig } from "./cider";

export type CanvasPlacement = "lyrics" | "navigation" | "mini";

export interface PluginConfig {
  spDc: string;
  placement: CanvasPlacement;
}

export const HARDCODED_SP_DC = "";

export const defaults: PluginConfig = {
  spDc: "",
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

export function getEffectiveSpDc(config?: Partial<PluginConfig>): string {
  const configured = typeof config?.spDc === "string" ? config.spDc.trim() : "";
  return configured || HARDCODED_SP_DC.trim();
}
