<script setup lang="ts">
import { persistConfig, useConfig, type CanvasPlacement } from "../config";

const cfg = useConfig();

function updateTransparency(event: Event) {
  const input = event.target as HTMLInputElement | null;
  if (!input) return;
  const value = Number(input.value);
  cfg.transparency = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 50;
}

async function saveTransparency() {
  try {
    await persistConfig();
  } catch (error) {
    console.error("[Canvas for Cider] Failed to save Canvas transparency", error);
  }
}

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
            ['immersive', 'Immersive (One)'],
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
      <small class="placement-hint">Immersive uses Cider's <strong>One</strong> style only.</small>
    </div>

    <div class="field">
      <div class="field-heading">
        <span>Canvas transparency</span>
        <span class="value">{{ cfg.transparency }}%</span>
      </div>
      <input
        class="transparency-slider"
        type="range"
        min="0"
        max="100"
        step="1"
        :value="cfg.transparency"
        aria-label="Canvas transparency"
        @input="updateTransparency"
        @change="saveTransparency"
      />
      <div class="range-hint">
        <span>Visible</span>
        <span>Transparent</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel{display:grid;gap:18px}
.field{display:grid;gap:8px}
.field>span{font-weight:650}
.field-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.value{font-variant-numeric:tabular-nums;opacity:.72}.transparency-slider{width:100%;margin:2px 0 0;accent-color:currentColor;cursor:pointer}.range-hint{display:flex;justify-content:space-between;font-size:12px;opacity:.60}
.placement-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.placement-option{border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:color-mix(in srgb,currentColor 7%,transparent);color:inherit;border-radius:11px;padding:10px 14px;min-height:42px;font:inherit;font-weight:650;cursor:pointer}
.placement-option:hover{background:color-mix(in srgb,currentColor 12%,transparent)}
.placement-option.active{outline:2px solid currentColor;outline-offset:1px;background:color-mix(in srgb,currentColor 14%,transparent)}
.placement-hint{font-size:12px;opacity:.62;line-height:1.4}
@media(max-width:520px){.placement-grid{grid-template-columns:1fr}}
</style>
