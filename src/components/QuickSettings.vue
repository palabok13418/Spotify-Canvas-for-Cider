<script setup lang="ts">
import CanvasSettingsPanel from "./CanvasSettingsPanel.vue";
import { useConfig } from "../config";

defineProps<{ open: boolean }>();
const cfg = useConfig();
</script>

<template>
  <div v-if="open" class="popover" data-canvas-cider-quick-popup="true" role="dialog" aria-label="Canvas for Cider settings">
    <div class="popover-header">
      <div class="title">Canvas Settings</div>
      <div class="placement-label">{{ cfg.placement === 'lyrics' ? 'Lyrics' : cfg.placement === 'navigation' ? 'Navigation' : 'Mini Player' }}</div>
    </div>
    <CanvasSettingsPanel />
  </div>
</template>

<style scoped>
.popover{position:fixed;z-index:2147483000;box-sizing:border-box;width:390px;padding:16px;border-radius:16px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);background:rgba(22,22,24,.94);backdrop-filter:blur(20px) saturate(1.15);-webkit-backdrop-filter:blur(20px) saturate(1.15);box-shadow:0 14px 38px rgba(0,0,0,.38);color:#f7f7f7;overflow:hidden}
.popover-header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px}
.title{font-weight:760;font-size:15px}.placement-label{font-size:12px;opacity:.62;white-space:nowrap}
</style>
