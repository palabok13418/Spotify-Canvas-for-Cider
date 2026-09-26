<script setup lang="ts">
import { ref } from 'vue';
import { isEnabled, setEnabled } from '../lib/sync';

const enabled = ref(isEnabled());

function toggle() {
  enabled.value = !enabled.value;
  setEnabled(enabled.value);
}
</script>

<template>
  <div class="panel">
    <button class="toggle" @click="toggle">
      {{ enabled ? 'Pause mirroring' : 'Resume mirroring' }}
    </button>
  </div>
</template>

<style>
.panel {
  box-sizing: border-box;
  width: 260px;
  padding: 16px;
  border-radius: 14px;
  background: rgba(18,18,22,.96);
  color: #fff;
  font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  box-shadow: 0 20px 70px rgba(0,0,0,.35);
}

.toggle {
  width: 100%;
  border: 0;
  border-radius: 10px;
  padding: 10px 12px;
  background: rgba(255,255,255,.09);
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
</style>
