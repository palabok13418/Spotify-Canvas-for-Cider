<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { getSnapshot, isEnabled, onBridgeChange, setEnabled, startBridge } from '../lib/sync';
import { openSpotifyAuth } from '../lib/musApi';

const snapshot = ref(getSnapshot());
const enabled = ref(isEnabled());
let off = () => {};

function linkSpotify() {
  const origin = window.location.origin === 'null' ? '*' : window.location.origin;
  const url = openSpotifyAuth(origin);
  const popup = window.open(url, 'musapi-spotify-auth', 'width=520,height=760,resizable=yes,scrollbars=yes');
  if (!popup) window.location.href = url;
}

function toggle() {
  enabled.value = !enabled.value;
  setEnabled(enabled.value);
}

onMounted(() => {
  off = onBridgeChange((value) => { snapshot.value = value; });
  startBridge();
});

onBeforeUnmount(() => {
  off();
});
</script>

<template>
  <div class="panel">
    <div class="title">Spotify Notes Bridge</div>
    <div class="subtitle">Mirror whatever you play in Cider to Spotify on your phone.</div>

    <div class="status" :class="snapshot.status">
      <span class="dot" />
      <span>{{ snapshot.message }}</span>
    </div>

    <div v-if="snapshot.ciderTitle" class="track">
      <div class="track-title">{{ snapshot.ciderTitle }}</div>
      <div class="track-artist">{{ snapshot.ciderArtist }}</div>
    </div>

    <div class="actions">
      <button v-if="snapshot.status === 'link-required' || !snapshot.spotifyTrack" class="primary" @click="linkSpotify">Log in to Spotify</button>
      <button v-else class="secondary" @click="linkSpotify">Reconnect Spotify</button>
      <button class="secondary" @click="toggle">{{ enabled ? 'Pause mirroring' : 'Resume mirroring' }}</button>
    </div>

    <div class="hint">
      Spotify must be installed/open on your phone and available as a Spotify playback device. Instagram Notes reads the song from Spotify, so Cider itself never talks to Instagram.
    </div>
  </div>
</template>

<style>
.panel{box-sizing:border-box;width:420px;padding:22px;border-radius:18px;background:rgba(18,18,22,.96);color:#fff;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 20px 70px rgba(0,0,0,.35)}
.title{font-size:20px;font-weight:700;letter-spacing:-.02em}.subtitle{margin-top:5px;color:rgba(255,255,255,.62);font-size:13px;line-height:1.45}.status{display:flex;gap:9px;align-items:flex-start;margin-top:18px;padding:11px 12px;border-radius:12px;background:rgba(255,255,255,.06);font-size:13px;line-height:1.4}.dot{width:8px;height:8px;border-radius:50%;background:#777;margin-top:5px;flex:none}.ready .dot{background:#1ed760}.syncing .dot{background:#ffd34d}.spotify-required .dot,.link-required .dot{background:#ff9f43}.error .dot{background:#ff5f56}.disabled .dot{background:#777}.track{margin-top:12px;padding:12px;border-radius:12px;background:rgba(255,255,255,.045)}.track-title{font-weight:650}.track-artist{margin-top:3px;color:rgba(255,255,255,.58);font-size:13px}.actions{display:flex;gap:8px;margin-top:14px}.actions button{border:0;border-radius:10px;padding:10px 12px;font:inherit;font-size:13px;cursor:pointer}.primary{background:#1ed760;color:#08110b;font-weight:700}.secondary{background:rgba(255,255,255,.09);color:#fff}.hint{margin-top:14px;color:rgba(255,255,255,.45);font-size:11px;line-height:1.5}
</style>
