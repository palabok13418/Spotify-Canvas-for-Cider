<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { subscribeEvent } from "../cider";
import { getCurrentTrack, hasCiderTrack } from "../core/currentTrack";
import { useConfig } from "../config";
import { resolveCanvasRemote, getCanvasApiBase } from "../canvas-api";
import { canvasUrl as sharedCanvasUrl, canvasActive } from "../state";

interface ResolveResult {
  spotifyTrackId: string | null;
  canvasUrl: string | null;
  matchedTitle?: string;
  matchedArtist?: string;
  score?: number;
  reason?: string;
}

useConfig();
const canvasUrl = sharedCanvasUrl;
const debugPrefix = "[Canvas for Cider]";

const positiveCanvasCache = new Map<string, ResolveResult>();
const CACHE_LIMIT = 48;

function log(...args: any[]) { console.log(debugPrefix, ...args); }
function warn(...args: any[]) { console.warn(debugPrefix, ...args); }
function errorLog(...args: any[]) { console.error(debugPrefix, ...args); }

let observer: MutationObserver | null = null;
let timer: number | null = null;
let loading = false;
let activeTrackIdentity = "";
let sequence = 0;
let cleanupEvents: Array<() => void> = [];
let lastLoggedTrackKey = "";
let scheduledSync: number | null = null;
let activeAbortController: AbortController | null = null;

function stableTrackIdentity(t: ReturnType<typeof getCurrentTrack>) {
  const strong = t.appleId || t.catalogId || t.isrc;
  if (strong) return `id:${strong}`;
  return `meta:${[t.title, t.artist, t.album].map(v => v.trim().toLowerCase()).join("\0")}`;
}

function cachePut(identity: string, result: ResolveResult) {
  if (!result.canvasUrl) return;
  positiveCanvasCache.delete(identity);
  positiveCanvasCache.set(identity, result);
  while (positiveCanvasCache.size > CACHE_LIMIT) {
    const oldest = positiveCanvasCache.keys().next().value;
    if (!oldest) break;
    positiveCanvasCache.delete(oldest);
  }
}

function cacheGet(identity: string) {
  const result = positiveCanvasCache.get(identity);
  if (!result) return null;
  positiveCanvasCache.delete(identity);
  positiveCanvasCache.set(identity, result);
  return result;
}

function clearCanvasForTrackChange(reason: string) {
  sequence++;
  activeAbortController?.abort();
  activeAbortController = null;
  loading = false;
  activeTrackIdentity = "";
  canvasUrl.value = "";
  canvasActive.value = false;
  log("Canvas lifecycle reset", { reason, sequence });
}

function applyCachedResult(track: ReturnType<typeof getCurrentTrack>, identity: string, cached: ResolveResult) {
  if (!cached.canvasUrl) return false;
  activeTrackIdentity = identity;
  canvasUrl.value = cached.canvasUrl;
  canvasActive.value = true;
  log("Canvas cache hit; skipping remote lookup", {
    trackIdentity: identity,
    spotifyTrackId: cached.spotifyTrackId,
    matchedTitle: cached.matchedTitle || track.title,
    matchedArtist: cached.matchedArtist || track.artist,
  });
  return true;
}

async function resolveCanvas(track = getCurrentTrack(), expectedIdentity = stableTrackIdentity(track)) {
  if (!track.title || !track.artist) {
    warn("Track metadata is incomplete; skipping Canvas lookup", track);
    return;
  }

  const cached = cacheGet(expectedIdentity);
  if (cached) {
    applyCachedResult(track, expectedIdentity, cached);
    return;
  }

  if (loading && expectedIdentity === activeTrackIdentity) {
    log("Canvas lookup already in progress for current song", { expectedIdentity });
    return;
  }

  activeAbortController?.abort();
  const controller = new AbortController();
  activeAbortController = controller;

  loading = true;
  const seq = ++sequence;
  activeTrackIdentity = expectedIdentity;
  canvasUrl.value = "";
  canvasActive.value = false;

  log("Canvas API resolver starting", {
    sequence: seq,
    trackIdentity: expectedIdentity,
    title: track.title,
    artist: track.artist,
    album: track.album,
    api: getCanvasApiBase(),
  });

  try {
    const data = await resolveCanvasRemote(track, controller.signal) as ResolveResult;

    const currentIdentity = stableTrackIdentity(getCurrentTrack());
    if (controller.signal.aborted || seq !== sequence || expectedIdentity !== activeTrackIdentity || currentIdentity !== expectedIdentity) {
      warn("Ignoring stale resolver response after track change", {
        seq,
        sequence,
        expectedIdentity,
        activeTrackIdentity,
        currentIdentity
      });
      return;
    }

    if (data.canvasUrl) {
      cachePut(expectedIdentity, data);
      canvasUrl.value = data.canvasUrl;
      canvasActive.value = true;
      log("Canvas URL received from API", {
        spotifyTrackId: data.spotifyTrackId,
        trackIdentity: expectedIdentity,
        hasCanvasUrl: true,
      });
    } else {
      warn("No Canvas URL returned", {
        spotifyTrackId: data.spotifyTrackId,
        reason: data.reason,
      });
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    if (seq === sequence && expectedIdentity === activeTrackIdentity) {
      errorLog("resolveCanvas() failed", error);
    } else {
      warn("Ignoring resolver failure for an old song", { expectedIdentity, error: String(error) });
    }
  } finally {
    if (activeAbortController === controller) activeAbortController = null;
    if (seq === sequence && expectedIdentity === activeTrackIdentity) loading = false;
  }
}

function scheduleSync() {
  if (scheduledSync !== null) return;
  scheduledSync = window.requestAnimationFrame(() => {
    scheduledSync = null;
    sync();
  });
}

function sync() {
  const track = getCurrentTrack();
  const trackPresent = hasCiderTrack();
  const identity = trackPresent ? stableTrackIdentity(track) : "";

  if (!trackPresent) {
    if (activeTrackIdentity || canvasUrl.value || canvasActive.value) {
      clearCanvasForTrackChange("Cider player has no loaded track");
    }
    lastLoggedTrackKey = "";
    return;
  }

  if (identity !== lastLoggedTrackKey) {
    log("Player track identity", {
      previous: lastLoggedTrackKey || null,
      current: identity,
      title: track.title,
      artist: track.artist,
      album: track.album,
      appleId: track.appleId,
      catalogId: track.catalogId,
      isrc: track.isrc
    });
    lastLoggedTrackKey = identity;
  }

  if (identity !== activeTrackIdentity) {
    clearCanvasForTrackChange("song switched");
    void resolveCanvas(track, identity);
  }
}

onMounted(() => {
  log("Plugin overlay mounted", {
    href: location.href,
    userAgent: navigator.userAgent,
    mediaSessionAvailable: Boolean(navigator.mediaSession),
  });

  cleanupEvents = [
    subscribeEvent("miniplayer:opened", () => scheduleSync()),
    subscribeEvent("miniplayer:closed", () => scheduleSync()),
    subscribeEvent("browser:page_changed", () => scheduleSync()),
    subscribeEvent("app:ready", () => scheduleSync()),
    subscribeEvent("player:state_changed", () => scheduleSync()),
    subscribeEvent("playback:state_changed", () => scheduleSync()),
  ];

  observer = new MutationObserver(() => scheduleSync());
  observer.observe(document.documentElement, { subtree: true, childList: true });

  timer = window.setInterval(scheduleSync, 1500);
  scheduleSync();
});

onUnmounted(() => {
  activeAbortController?.abort();
  activeAbortController = null;
  observer?.disconnect();
  observer = null;
  if (timer !== null) window.clearInterval(timer);
  if (scheduledSync !== null) window.cancelAnimationFrame(scheduledSync);
  cleanupEvents.forEach(fn => fn());
});
</script>

<template></template>
