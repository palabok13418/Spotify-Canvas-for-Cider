<script setup lang="ts">
import { ref } from "vue";
import { persistConfig, useConfig, type CanvasPlacement } from "../config";

const cfg = useConfig();
const draftSpDc = ref(cfg.spDc);
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");

async function saveSpDc() {
  saveState.value = "saving";
  cfg.spDc = draftSpDc.value.trim();
  try {
    await persistConfig();
    saveState.value = "saved";
    window.setTimeout(() => {
      if (saveState.value === "saved") saveState.value = "idle";
    }, 1800);
  } catch (error) {
    console.error("[Canvas for Cider] Failed to save sp_dc", error);
    saveState.value = "error";
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
      <span>Spotify Tokeen | <code>sp_dc</code></span>
      <div class="token-row">
        <input
          v-model="draftSpDc"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="paste your sp_dc token"
          @keydown.enter="saveSpDc"
        />
        <button type="button" class="save-button" :disabled="saveState === 'saving'" @click="saveSpDc">
          {{ saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Save" }}
        </button>
      </div>
      <small v-if="saveState === 'error'" class="save-error">Couldn't save the token.</small>
    </div>

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
.field code{opacity:.7}
.token-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:stretch}
.token-row input{min-width:0;box-sizing:border-box;padding:10px 12px;border-radius:11px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:color-mix(in srgb,currentColor 6%,transparent);color:inherit;outline:none}
.token-row input:focus{border-color:color-mix(in srgb,currentColor 45%,transparent)}
.save-button,.placement-option{border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:color-mix(in srgb,currentColor 7%,transparent);color:inherit;border-radius:11px;padding:10px 14px;font:inherit;cursor:pointer}
.save-button:hover,.placement-option:hover{background:color-mix(in srgb,currentColor 12%,transparent)}
.save-button:disabled{opacity:.6;cursor:default}
.save-error{color:#d33}
.placement-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.placement-option{min-height:42px;font-weight:650}
.placement-option.active{outline:2px solid currentColor;outline-offset:1px;background:color-mix(in srgb,currentColor 14%,transparent)}
@media(max-width:520px){.token-row,.placement-grid{grid-template-columns:1fr}}
</style>
