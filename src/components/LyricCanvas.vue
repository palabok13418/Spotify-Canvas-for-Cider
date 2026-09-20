<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { canvasActive, canvasUrl, canvasAnalysisPending, canvasSuppressedForAppleArtwork } from "../state";
import { useConfig } from "../config";

withDefaults(defineProps<{ mode?: "main" }>(), { mode: "main" });
const cfg = useConfig();

const PREFIX = "[Canvas for Cider]";
const RIGHT_DRAWER_SCOPE = [
  '#app-viewport[right-drawer="true"]',
  '[right-drawer="true"]',
  '.q-drawer--right',
  '[class*="right-drawer"]',
];

const LYRIC_SELECTORS = [
  ".lyric-view.apple-desktop-lyrics",
  ".lyric-view-wrapper .lyric-view",
  '[sfc-name="Lyrics"]',
  '[sfc-name="LyricView"]',
  '[sfc-name="LyricsView"]',
];

const NAVIGATION_SELECTORS = [
  "cider-amsidebar",
  "cider-amsidebar-min",
  '[sfc-name="AMSidebar"]',
  '[sfc-name="Sidebar"]',
  '[data-testid*="sidebar"]',
  '[class*="amsidebar"]',
  '[class*="app-sidebar"]',
  ".left-drawer",
  ".q-drawer--left",
];

const IMMERSIVE_SELECTORS = [
  ".fullscreen-view-container",
  ".fullscreen-view",
  '[sfc-name*="Immersive" i]',
  '[data-testid*="immersive" i]',
  '[class*="immersive" i]',
];

const reducedMotionQuery = ref<MediaQueryList | null>(null);
const transitionState = ref<"idle" | "enter" | "switch" | "exit">("idle");
const transitionKey = ref(0);

let rootEl: HTMLElement | null = null;
let portalLayer: HTMLElement | null = null;
let videoEl: HTMLVideoElement | null = null;
let observer: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let watchdog: number | null = null;
let retryTimer: number | null = null;
let animationFrame: number | null = null;
let removePlaybackGuard: (() => void) | null = null;
let guardedVideo: HTMLVideoElement | null = null;
let activeAbort = false;
let lastTargetHost: HTMLElement | null = null;
let lastRectSignature = "";
let lastAppliedUrl = "";
let latchUrl = "";
let latchStartedAt = 0;
let latchAttempts = 0;
let pendingSync = false;
let syncing = false;
let lastPlacement: string = cfg.placement;

const reducedMotion = computed(() => Boolean(reducedMotionQuery.value?.matches));
const canvasOpacity = computed(() => 1 - Math.max(0, Math.min(100, Number(cfg.transparency ?? 50))) / 100);
const shouldRender = computed(() =>
  Boolean(canvasActive.value && canvasUrl.value && !canvasAnalysisPending.value && !canvasSuppressedForAppleArtwork.value && !reducedMotion.value)
);

function log(...args: unknown[]) {
  console.log(PREFIX, ...args);
}

function isDisplayed(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function rectArea(el: HTMLElement | null) {
  if (!el) return 0;
  const r = el.getBoundingClientRect();
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function isMiniContext(el: HTMLElement) {
  let node: HTMLElement | null = el;
  for (let i = 0; node && i < 12; i++, node = node.parentElement) {
    const text = [
      typeof node.className === "string" ? node.className : "",
      node.id,
      node.getAttribute("data-testid"),
      node.getAttribute("aria-label"),
      node.getAttribute("sfc-name"),
    ].filter(Boolean).join(" ").toLowerCase();
    if (/mini.?player|miniplayer/.test(text)) return true;
  }
  return false;
}

function inRightDrawerScope(el: HTMLElement) {
  return RIGHT_DRAWER_SCOPE.some(selector => Boolean(el.closest(selector)));
}

function findRightLyricsHost(): HTMLElement | null {
  const candidates = new Map<HTMLElement, number>();
  for (const selector of LYRIC_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (!isDisplayed(el) || isMiniContext(el)) continue;
      const r = el.getBoundingClientRect();
      const vw = Math.max(window.innerWidth, 1);
      const vh = Math.max(window.innerHeight, 1);
      const rightGap = Math.max(0, vw - r.right);
      const leftRatio = r.left / vw;
      const widthRatio = r.width / vw;
      const heightRatio = r.height / vh;
      if (r.width < 220 || r.height < 180) continue;
      if (leftRatio < 0.56 || widthRatio < 0.12 || widthRatio > 0.50 || heightRatio < 0.45) continue;
      if (rightGap > Math.max(24, vw * 0.045)) continue;
      const exact = el.matches(".lyric-view.apple-desktop-lyrics") ? 7000 : 0;
      const concrete = el.matches(".lyric-view") ? 1800 : 0;
      const scoped = inRightDrawerScope(el) ? 1800 : 0;
      const ownText = [...el.classList, el.getAttribute("sfc-name") || "", el.getAttribute("aria-label") || "", el.getAttribute("data-testid") || ""].join(" ").toLowerCase();
      const evidence = /lyric|lyrics/.test(ownText) ? 800 : 0;
      const score = exact + concrete + scoped + evidence + leftRatio * 110 + heightRatio * 100 - rightGap / vw * 1000;
      candidates.set(el, score);
    }
  }
  let best: HTMLElement | null = null;
  let bestScore = -Infinity;
  let bestArea = Infinity;
  for (const [el, score] of candidates) {
    const area = rectArea(el);
    if (score > bestScore || (Math.abs(score - bestScore) < 0.001 && area > 0 && area < bestArea)) {
      best = el;
      bestScore = score;
      bestArea = area;
    }
  }
  return best;
}

function findNavigationHost(): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestArea = Infinity;
  for (const selector of NAVIGATION_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (!isDisplayed(el) || isMiniContext(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 140 || r.height < 220) continue;
      if (r.left > window.innerWidth * 0.45 || r.top > window.innerHeight * 0.2 || r.right > window.innerWidth * 0.50) continue;
      const area = rectArea(el);
      if (area > 0 && area < bestArea) {
        best = el;
        bestArea = area;
      }
    }
  }
  return best;
}

function looksLikeImmersiveOne(host: HTMLElement) {
  const values = [
    host.className,
    host.id,
    host.getAttribute("sfc-name"),
    host.getAttribute("data-testid"),
    host.getAttribute("aria-label"),
    host.getAttribute("data-style"),
    host.getAttribute("data-mode"),
    host.getAttribute("style-name"),
    host.getAttribute("immersive-style"),
  ].filter(Boolean).join(" ");
  const text = host.textContent?.replace(/\s+/g, " ").trim() || "";
  return /(^|\W)one(\W|$)/i.test(values) || /(?:immersive\s*)?style\s*one/i.test(text);
}

function findImmersiveHost(): HTMLElement | null {
  const candidates: HTMLElement[] = [];
  for (const selector of IMMERSIVE_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (!isDisplayed(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 300 || r.height < 250) continue;
      candidates.push(el);
    }
  }

  const fullscreen = document.querySelector<HTMLElement>(".fullscreen-view-container");
  if (fullscreen && isDisplayed(fullscreen)) candidates.push(fullscreen);

  const unique = [...new Set(candidates)];
  const one = unique.filter(looksLikeImmersiveOne);
  if (one.length) {
    one.sort((a, b) => rectArea(b) - rectArea(a));
    return one[0];
  }

  // Cider-2/older builds can expose only a fullscreen surface without a style
  // label. In that case we stay fail-closed instead of drawing into the wrong
  // immersive variant.
  return null;
}

function findPlacementHost() {
  if (cfg.placement === "navigation") return findNavigationHost();
  if (cfg.placement === "immersive") return findImmersiveHost();
  return findRightLyricsHost();
}

function placementIsLocal() {
  return cfg.placement === "lyrics" || cfg.placement === "navigation";
}

function ensureRoot(host: HTMLElement | null) {
  rootEl ??= document.querySelector<HTMLElement>("canvascider-main-canvas");
  if (!rootEl) return false;

  if (placementIsLocal() && host) {
    if (rootEl.parentElement !== host) host.insertBefore(rootEl, host.firstChild);
  } else if (rootEl.parentElement !== document.body) {
    document.body.appendChild(rootEl);
  }

  rootEl.style.setProperty("position", placementIsLocal() ? "absolute" : "fixed", "important");
  rootEl.style.setProperty("margin", "0", "important");
  rootEl.style.setProperty("padding", "0", "important");
  rootEl.style.setProperty("pointer-events", "none", "important");
  rootEl.style.setProperty("overflow", "hidden", "important");
  rootEl.style.setProperty("box-sizing", "border-box", "important");
  rootEl.style.setProperty("display", shouldRender.value ? "block" : "none", "important");
  rootEl.style.setProperty("transform", "none", "important");
  rootEl.style.setProperty("min-width", "0", "important");
  rootEl.style.setProperty("min-height", "0", "important");
  rootEl.style.setProperty("max-width", "none", "important");
  rootEl.style.setProperty("max-height", "none", "important");
  rootEl.dataset.canvasPlacement = cfg.placement;

  portalLayer = rootEl.querySelector<HTMLElement>(".layer");
  videoEl = rootEl.querySelector<HTMLVideoElement>("video");
  return Boolean(portalLayer && videoEl);
}

function configureVideo(video: HTMLVideoElement) {
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.autoplay = !reducedMotion.value;
  video.playsInline = true;
  video.preload = "auto";
  video.style.visibility = shouldRender.value ? "visible" : "hidden";
}

function clearPlaybackGuard() {
  removePlaybackGuard?.();
  removePlaybackGuard = null;
  guardedVideo = null;
}

function attachPlaybackGuard(video: HTMLVideoElement) {
  if (guardedVideo === video) return;
  clearPlaybackGuard();
  guardedVideo = video;
  const resume = () => {
    if (!shouldRender.value || video !== guardedVideo) return;
    if (video.ended) {
      try { video.currentTime = 0; } catch {}
    }
    if (video.paused) void video.play().catch(() => {});
  };
  ["pause", "ended", "canplay", "loadeddata", "loadedmetadata"].forEach(e => video.addEventListener(e, resume));
  removePlaybackGuard = () => ["pause", "ended", "canplay", "loadeddata", "loadedmetadata"].forEach(e => video.removeEventListener(e, resume));
}

function applyTransition(kind: "enter" | "switch" | "exit") {
  if (reducedMotion.value) {
    transitionState.value = "idle";
    return;
  }
  transitionKey.value++;
  transitionState.value = kind;
  window.setTimeout(() => {
    if (transitionState.value === kind) transitionState.value = "idle";
  }, kind === "switch" ? 800 : 650);
}

function setVideoSource(url: string, forceReload = false) {
  if (!videoEl || !url) return;
  let absolute = url;
  try { absolute = new URL(url, document.baseURI).href; } catch {}
  const current = videoEl.currentSrc || videoEl.src || "";
  if (!forceReload && (current === url || current === absolute || lastAppliedUrl === url)) return;
  const hadPrevious = Boolean(lastAppliedUrl);
  try { videoEl.pause(); } catch {}
  if (hadPrevious) applyTransition("switch");
  videoEl.removeAttribute("src");
  try { videoEl.load(); } catch {}
  videoEl.src = url;
  lastAppliedUrl = url;
  try { videoEl.load(); } catch {}
}

function syncNavigationContrast(host: HTMLElement | null) {
  document.querySelectorAll<HTMLElement>(".canvascider-navigation-contrast").forEach(el => {
    if (cfg.placement !== "navigation" || el !== host) el.classList.remove("canvascider-navigation-contrast");
  });
  if (cfg.placement === "navigation" && host) host.classList.add("canvascider-navigation-contrast");
}

function setRectangle(host: HTMLElement) {
  if (!rootEl || !portalLayer) return false;
  syncNavigationContrast(host);
  const r = host.getBoundingClientRect();
  const visible = r.width > 120 && r.height > 100 && r.bottom > 0 && r.right > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
  if (!visible) {
    rootEl.style.setProperty("display", "none", "important");
    return false;
  }

  if (placementIsLocal()) {
    rootEl.style.setProperty("left", "0", "important");
    rootEl.style.setProperty("top", "0", "important");
    rootEl.style.setProperty("width", "100%", "important");
    rootEl.style.setProperty("height", "100%", "important");
    rootEl.style.setProperty("z-index", "0", "important");
  } else {
    rootEl.style.setProperty("left", `${Math.round(r.left * 100) / 100}px`, "important");
    rootEl.style.setProperty("top", `${Math.round(r.top * 100) / 100}px`, "important");
    rootEl.style.setProperty("width", `${Math.round(r.width * 100) / 100}px`, "important");
    rootEl.style.setProperty("height", `${Math.round(r.height * 100) / 100}px`, "important");
    rootEl.style.setProperty("z-index", "1", "important");
  }

  rootEl.style.setProperty("display", shouldRender.value ? "block" : "none", "important");
  portalLayer.style.setProperty("position", "absolute", "important");
  portalLayer.style.setProperty("inset", "0", "important");
  portalLayer.style.setProperty("width", "100%", "important");
  portalLayer.style.setProperty("height", "100%", "important");
  portalLayer.style.setProperty("pointer-events", "none", "important");
  portalLayer.style.setProperty("background", "transparent", "important");
  portalLayer.style.setProperty("opacity", String(canvasOpacity.value), "important");
  portalLayer.dataset.transition = transitionState.value;
  portalLayer.dataset.transitionKey = String(transitionKey.value);

  const signature = [cfg.placement, host.tagName, host.className, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join("|");
  if (signature !== lastRectSignature || host !== lastTargetHost) {
    lastRectSignature = signature;
    lastTargetHost = host;
    log("Canvas portal latched", { placement: cfg.placement, host: host.className || host.tagName });
  }

  return true;
}

function scheduleSync(reason: string) {
  if (!canvasUrl.value || !canvasActive.value || canvasAnalysisPending.value || canvasSuppressedForAppleArtwork.value) return;
  pendingSync = true;
  if (animationFrame !== null) return;
  animationFrame = window.requestAnimationFrame(() => {
    animationFrame = null;
    if (!pendingSync || syncing) return;
    pendingSync = false;
    void sync(reason);
  });
}

async function sync(reason: string) {
  if (syncing || activeAbort || !canvasUrl.value || !canvasActive.value || canvasAnalysisPending.value || canvasSuppressedForAppleArtwork.value || reducedMotion.value) return;
  syncing = true;
  try {
    const host = findPlacementHost();
    if (!host || !ensureRoot(host)) {
      rootEl?.style.setProperty("display", "none", "important");
      return;
    }
    configureVideo(videoEl!);
    attachPlaybackGuard(videoEl!);
    if (canvasUrl.value !== lastAppliedUrl) setVideoSource(canvasUrl.value);
    if (!setRectangle(host)) return;
    try { await videoEl!.play(); } catch {}
    if (lastPlacement !== cfg.placement) {
      applyTransition(cfg.placement === "immersive" ? "enter" : "exit");
      lastPlacement = cfg.placement;
    }
  } finally {
    syncing = false;
  }
  if (canvasUrl.value) startLatch(canvasUrl.value, reason);
}

function clearLatch() {
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = null;
  latchUrl = "";
  latchStartedAt = 0;
  latchAttempts = 0;
}

function startLatch(url: string, reason: string) {
  if (!url || !canvasActive.value || reducedMotion.value) return;
  if (latchUrl !== url) {
    clearLatch();
    latchUrl = url;
    latchStartedAt = Date.now();
  }
  if (retryTimer !== null) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    latchAttempts++;
    scheduleSync(`latch: ${reason}`);
    startLatch(url, reason);
  }, latchAttempts < 120 ? 120 : 300);
}

function stopPortal() {
  clearLatch();
  lastTargetHost = null;
  if (rootEl) rootEl.style.setProperty("display", "none", "important");
  transitionState.value = "idle";
}

function handleMotionChange() {
  if (reducedMotion.value) stopPortal();
  else if (canvasActive.value && canvasUrl.value) {
    applyTransition("enter");
    scheduleSync("reduced motion disabled");
  }
}

watch(
  [canvasUrl, canvasActive, canvasAnalysisPending, canvasSuppressedForAppleArtwork, () => cfg.placement, () => cfg.transparency],
  ([url, active, pending, suppressed, placement], [oldUrl, oldActive, oldPending, oldSuppressed, oldPlacement]) => {
    if (!active || !url || pending || suppressed) {
      stopPortal();
      lastAppliedUrl = "";
      return;
    }

    if (placement !== oldPlacement) {
      applyTransition(placement === "immersive" ? "enter" : "exit");
      lastPlacement = placement;
    }

    if (url !== oldUrl || active !== oldActive || pending !== oldPending || suppressed !== oldSuppressed) {
      setVideoSource(url, Boolean(lastAppliedUrl && url !== oldUrl));
      if (!reducedMotion.value) applyTransition(lastAppliedUrl && url !== oldUrl ? "switch" : "enter");
    }

    scheduleSync("Canvas state changed");
  },
  { flush: "post" }
);

onMounted(() => {
  reducedMotionQuery.value = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotionQuery.value.addEventListener?.("change", handleMotionChange);
  ensureRoot(null);

  observer = new MutationObserver(() => scheduleSync("Cider DOM changed"));
  observer.observe(document.documentElement, { childList: true, subtree: true });

  resizeObserver = new ResizeObserver(() => scheduleSync("layout resized"));
  const viewport = document.querySelector<HTMLElement>("#app-viewport");
  if (viewport) resizeObserver.observe(viewport);
  else resizeObserver.observe(document.documentElement);

  const resize = () => scheduleSync("window resized");
  window.addEventListener("resize", resize);
  window.addEventListener("scroll", resize, true);

  watchdog = window.setInterval(() => {
    scheduleSync("Canvas watchdog");
    if (videoEl && shouldRender.value) {
      configureVideo(videoEl);
      attachPlaybackGuard(videoEl);
      if (videoEl.paused) void videoEl.play().catch(() => {});
    }
  }, 1000);
});

onUnmounted(() => {
  activeAbort = true;
  clearLatch();
  if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
  observer?.disconnect();
  resizeObserver?.disconnect();
  clearPlaybackGuard();
  if (watchdog !== null) window.clearInterval(watchdog);
  reducedMotionQuery.value?.removeEventListener?.("change", handleMotionChange);
  document.querySelectorAll<HTMLElement>(".canvascider-navigation-contrast").forEach(el => el.classList.remove("canvascider-navigation-contrast"));
  rootEl = null;
  portalLayer = null;
  videoEl = null;
});
</script>

<template>
  <div
    class="layer"
    aria-hidden="true"
    :class="{
      'canvas-transition-enter': transitionState === 'enter',
      'canvas-transition-switch': transitionState === 'switch',
      'canvas-transition-exit': transitionState === 'exit'
    }"
    :data-transition-key="transitionKey"
    :style="{ opacity: shouldRender ? canvasOpacity : 0 }"
  >
    <video
      class="video"
      :src="canvasUrl || undefined"
      muted
      loop
      playsinline
      preload="auto"
      :autoplay="!reducedMotion"
    ></video>
    <div class="edge-fade edge-fade-top"></div>
    <div class="edge-fade edge-fade-bottom"></div>
  </div>
</template>

<style>
.canvascider-navigation-contrast,
.canvascider-navigation-contrast *{
  color:#fff!important;
}

canvascider-main-canvas{
  box-sizing:border-box!important;
  position:fixed!important;
  pointer-events:none!important;
  overflow:hidden!important;
  margin:0!important;
  padding:0!important;
  min-width:0!important;
  min-height:0!important;
  max-width:none!important;
  max-height:none!important;
  transform:none!important;
  contain:layout paint style!important;
  isolation:isolate!important;
  background:transparent!important;
}

.layer{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  overflow:hidden;
  pointer-events:none;
  z-index:0;
  background:transparent;
  opacity:1;
  transition:opacity 140ms ease;
  --fade: 14%;
}

.video{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  object-fit:cover;
  object-position:center center;
  opacity:1;
  max-width:none;
  max-height:none;
  transform:none;
  filter:saturate(.88) contrast(1.02) brightness(.78);
  mix-blend-mode:screen;
}

.edge-fade{
  position:absolute;
  pointer-events:none;
  z-index:1;
  mix-blend-mode:multiply;
}

.edge-fade-top{
  top:0;
  left:0;
  width:100%;
  height:var(--fade);
  background:linear-gradient(to bottom,rgba(0,0,0,.56),rgba(0,0,0,0));
}
.edge-fade-bottom{
  bottom:0;
  left:0;
  width:100%;
  height:var(--fade);
  background:linear-gradient(to top,rgba(0,0,0,.56),rgba(0,0,0,0));
}

.canvas-transition-enter{
  -webkit-clip-path:polygon(50% 50%,50% 50%,50% 50%,50% 50%);
  clip-path:polygon(50% 50%,50% 50%,50% 50%,50% 50%);
  animation:canvas-star-open 620ms cubic-bezier(.2,.78,.2,1) forwards;
}
.canvas-transition-switch{
  animation:canvas-automix-switch 760ms cubic-bezier(.24,.74,.22,1) both;
}
.canvas-transition-exit{
  animation:canvas-star-close-spin 650ms cubic-bezier(.65,.05,.22,1) both;
}

@keyframes canvas-star-open{
  0%{
    transform:scale(.88) rotate(-8deg);
    -webkit-clip-path:polygon(50% 49%,51% 50%,50% 51%,49% 50%);
    clip-path:polygon(50% 49%,51% 50%,50% 51%,49% 50%);
    opacity:0;
  }
  45%{
    transform:scale(.98) rotate(0deg);
    -webkit-clip-path:polygon(50% 6%,58% 42%,94% 50%,58% 58%,50% 94%,42% 58%,6% 50%,42% 42%);
    clip-path:polygon(50% 6%,58% 42%,94% 50%,58% 58%,50% 94%,42% 58%,6% 50%,42% 42%);
    opacity:1;
  }
  100%{
    transform:scale(1) rotate(0);
    -webkit-clip-path:polygon(0 0,100% 0,100% 100%,0 100%);
    clip-path:polygon(0 0,100% 0,100% 100%,0 100%);
    opacity:1;
  }
}

@keyframes canvas-automix-switch{
  0%{opacity:0;transform:scale(.985);filter:blur(8px) saturate(.92);}
  35%{opacity:1;transform:scale(1.012);filter:blur(2px) saturate(1);}
  100%{opacity:1;transform:scale(1);filter:blur(0) saturate(1);}
}

@keyframes canvas-star-close-spin{
  0%{
    opacity:1;
    transform:scale(1) rotate(0);
    -webkit-clip-path:polygon(0 0,100% 0,100% 100%,0 100%);
    clip-path:polygon(0 0,100% 0,100% 100%,0 100%);
  }
  52%{
    opacity:1;
    transform:scale(.98) rotate(360deg);
    -webkit-clip-path:polygon(50% 6%,58% 42%,94% 50%,58% 58%,50% 94%,42% 58%,6% 50%,42% 42%);
    clip-path:polygon(50% 6%,58% 42%,94% 50%,58% 58%,50% 94%,42% 58%,6% 50%,42% 42%);
  }
  100%{
    opacity:0;
    transform:scale(.82) rotate(540deg);
    -webkit-clip-path:polygon(50% 49%,51% 50%,50% 51%,49% 50%);
    clip-path:polygon(50% 49%,51% 50%,50% 51%,49% 50%);
  }
}

canvascider-main-canvas[data-canvas-placement="lyrics"] .layer::after{
  content:"";
  position:absolute;
  top:0;
  bottom:0;
  left:-14%;
  width:42%;
  pointer-events:none;
  background:radial-gradient(ellipse at center,rgba(255,255,255,.14),rgba(255,255,255,0) 72%);
  filter:blur(28px);
  opacity:.68;
  mix-blend-mode:screen;
}

canvascider-main-canvas[data-canvas-placement="immersive"] .layer{
  --fade: 24%;
  -webkit-mask-image:linear-gradient(to right,transparent 0%,rgba(0,0,0,.32) 11%,#000 24%,#000 76%,rgba(0,0,0,.32) 89%,transparent 100%),
    linear-gradient(to bottom,transparent 0%,rgba(0,0,0,.22) 10%,#000 22%,#000 78%,rgba(0,0,0,.22) 90%,transparent 100%);
  mask-image:linear-gradient(to right,transparent 0%,rgba(0,0,0,.32) 11%,#000 24%,#000 76%,rgba(0,0,0,.32) 89%,transparent 100%),
    linear-gradient(to bottom,transparent 0%,rgba(0,0,0,.22) 10%,#000 22%,#000 78%,rgba(0,0,0,.22) 90%,transparent 100%);
  -webkit-mask-composite:source-in;
  mask-composite:intersect;
}

@media (prefers-reduced-motion: reduce){
  .canvas-transition-enter,
  .canvas-transition-switch,
  .canvas-transition-exit{
    animation:none!important;
    clip-path:none!important;
  }
  .video{visibility:hidden!important;}
}
</style>
