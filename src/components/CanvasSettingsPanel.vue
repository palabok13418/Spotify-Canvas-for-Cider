<script setup lang="ts">
import { persistConfig, useConfig, type CanvasPlacement } from "../config";

const cfg = useConfig();

async function selectPlacement(value: CanvasPlacement) {
  cfg.placement = value;
  try {
    await persistConfig();
  } catch (error) {
    console.error("[Canvas for Cider] Failed to save Canvas placement", error);
  }
}
</script>

<template>
  <div class="panel">
    <div class="field">
      <span>Canvas placement</span>
      <div class="placement-grid" role="radiogroup" aria-label="Canvas placement">
        <button
          v-for="option in [
            ['lyrics', 'Lyrics'],
            ['navigation', 'Navigation'],
            ['mini', 'Mini Player'],
          ] as const"
          :key="option[0]"
          type="button"
          class="placement-option"
          :class="{ active: cfg.placement === option[0] }"
          role="radio"
          :aria-checked="cfg.placement === option[0]"
          @click="selectPlacement(option[0])"
        >
          {{ option[1] }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel{display:grid;gap:18px}
.field{display:grid;gap:8px}
.field>span{font-weight:650}
.placement-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.placement-option{border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:color-mix(in srgb,currentColor 7%,transparent);color:inherit;border-radius:11px;padding:10px 14px;min-height:42px;font:inherit;font-weight:650;cursor:pointer}
.placement-option:hover{background:color-mix(in srgb,currentColor 12%,transparent)}
.placement-option.active{outline:2px solid currentColor;outline-offset:1px;background:color-mix(in srgb,currentColor 14%,transparent)}
@media(max-width:520px){.placement-grid{grid-template-columns:1fr}}
</style>
