import type { CustomImmersiveLayout } from "./types";

declare const __PLUGINSYS__: any;

export type { CustomImmersiveLayout };

export function addImmersiveLayout(layout: CustomImmersiveLayout) {
  const manager = (globalThis as any).__PLUGINSYS__?.Components?.ImmersiveLayouts;
  if (!manager || typeof manager.addLayout !== "function") {
    throw new Error("Cider Immersive Layout API is unavailable.");
  }
  return manager.addLayout(layout);
}

export function removeImmersiveLayout(layout: CustomImmersiveLayout) {
  const manager = (globalThis as any).__PLUGINSYS__?.Components?.ImmersiveLayouts;
  if (!manager || typeof manager.removeLayout !== "function") return;
  return manager.removeLayout(layout);
}
