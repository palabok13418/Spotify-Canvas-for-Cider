<script setup lang="ts">
import { useConfig } from "../config";
import CanvasSettingsPanel from "./CanvasSettingsPanel.vue";
const cfg = useConfig();
const logoUrl = "/logo.png";
</script>

<template>
  <section class="settings">
    <div class="brand">
      <img class="brand-logo" :src="logoUrl" alt="Canvas for Cider logo" />
      <div>
        <div class="brand-title">Canvas for Cider</div>
        <div class="brand-subtitle">Spotify Canvas for Cider</div>
      </div>
    </div>
    <CanvasSettingsPanel />
    <div class="status">
      Canvas is always active. Choose the Cider area where the Canvas portal should appear.
    </div>
  </section>
</template>

<style scoped>
.settings{padding:18px;max-width:760px;color:inherit}.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}.brand-logo{width:52px;height:52px;border-radius:14px;object-fit:cover}.brand-title{font-weight:750;font-size:18px}.brand-subtitle{opacity:.62;font-size:13px;margin-top:2px}.status{margin-top:16px;opacity:.6;line-height:1.45}
</style>
