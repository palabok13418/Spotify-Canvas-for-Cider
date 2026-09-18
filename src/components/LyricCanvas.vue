<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from "vue";
import { canvasActive, canvasUrl } from "../state";
import { useConfig } from "../config";

withDefaults(defineProps<{ mode?: "main" }>(), { mode: "main" });
const cfg = useConfig();

const PREFIX = "[Canvas for Cider]";

// The plugin now owns this canvas element permanently. Cider's Lyrics DOM is
// treated as a moving visual target rather than the parent of our element.
// This avoids Cider destroying the Canvas when its Lyrics component is rebuilt.
const RIGHT_DRAWER_SCOPE = [
  '#app-viewport[right-drawer="true"]',
  '[right-drawer="true"]',
  '.q-drawer--right',
  '[class*="right-drawer"]',
];

const LYRIC_SELECTORS = [
  // Prefer the concrete Lyrics surface itself. Avoid broad lyric-view class
  // matching because it can select a Cider wrapper whose rectangle is larger
  // than the actual right-side Lyrics pane.
  ".lyric-view.apple-desktop-lyrics",
  ".lyric-view-wrapper .lyric-view",
  '[sfc-name="Lyrics"]',
  '[sfc-name="LyricView"]',
  '[sfc-name="LyricsView"]',
];

const LYRIC_CONTENT_SELECTORS = [
  ".lyric-view-content",
  '[class*="lyric-view-content"]',
  '[sfc-name="LyricsContent"]',
  '[sfc-name="LyricContent"]',
];

const NAVIGATION_SELECTORS = [
  'cider-amsidebar',
  'cider-amsidebar-min',
  '[sfc-name="AMSidebar"]',
  '[sfc-name="Sidebar"]',
  '[data-testid*="sidebar"]',
  '[class*="amsidebar"]',
  '[class*="app-sidebar"]',
  '.left-drawer',
  '.q-drawer--left',
];

const MINI_SELECTORS = [
  '[sfc-name="MiniPlayer"]',
  '[data-testid*="mini-player"]',
  '.mini-player',
  '.miniplayer',
  '[class*="mini-player"]',
  '[class*="miniplayer"]',
];

let rootEl: HTMLElement | null = null;
let portalLayer: HTMLElement | null = null;
let videoEl: HTMLVideoElement | null = null;
let observer: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let retryTimer: number | null = null;
let animationFrame: number | null = null;
let playbackWatchdog: number | null = null;
let reducedMotionQuery: MediaQueryList | null = null;
let removePlaybackGuard: (() => void) | null = null;
let guardedVideo: HTMLVideoElement | null = null;
let latchUrl = "";
let latchStartedAt = 0;
let latchAttempts = 0;
let lastTargetHost: HTMLElement | null = null;
let lastRectSignature = "";
let lastNoTargetLogAt = 0;
let lastAppliedUrl = "";
let lastPlaybackTime = 0;
let stalledChecks = 0;
let recoveryCooldownUntil = 0;
let syncRunning = false;
let pendingSync = false;

const reducedMotion = computed(() => Boolean(reducedMotionQuery?.matches));
const canvasOpacity = computed(() => 1 - Math.max(0, Math.min(100, Number(cfg.transparency ?? 50))) / 100);
const canvasOpacity = computed(() => 1 - Math.max(0, Math.min(100, Number(cfg.transparency ?? 50))) / 100);

function log(...args: unknown[]) {
  console.log(PREFIX, ...args);
}

function describe(el: HTMLElement | null) {
  if (!el) return "null";
  const classes = [...el.classList].slice(0, 5).map((name) => `.${name}`).join("");
  const sfc = el.getAttribute("sfc-name");
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${classes}${sfc ? `[sfc-name=${sfc}]` : ""}`;
}

function rectArea(el: HTMLElement | null) {
  if (!el) return 0;
  const r = el.getBoundingClientRect();
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function isDisplayed(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function isMiniContext(el: HTMLElement) {
  let node: HTMLElement | null = el;
  for (let depth = 0; node && depth < 14; depth++) {
    const text = [
      typeof node.className === "string" ? node.className : "",
      node.id,
      node.getAttribute("data-testid"),
      node.getAttribute("aria-label"),
      node.getAttribute("sfc-name"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (/mini.?player|miniplayer|mini-player/.test(text)) return true;
    node = node.parentElement;
  }
  return false;
}

function inRightDrawerScope(el: HTMLElement) {
  return RIGHT_DRAWER_SCOPE.some((selector) => Boolean(el.closest(selector)));
}

function lyricEvidence(el: HTMLElement) {
  const own = [
    ...el.classList,
    el.getAttribute("sfc-name") || "",
    el.getAttribute("aria-label") || "",
    el.getAttribute("data-testid") || "",
  ]
    .join(" ")
    .toLowerCase();
  return /lyric|lyrics/.test(own) ? 1 : 0;
}

function findRightLyricsHost(): HTMLElement | null {
  const candidates = new Map<HTMLElement, number>();

  for (const selector of LYRIC_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (!isDisplayed(el) || isMiniContext(el)) continue;

      const r = el.getBoundingClientRect();
      const viewportW = Math.max(window.innerWidth, 1);
      const viewportH = Math.max(window.innerHeight, 1);
      const rightGap = Math.max(0, viewportW - r.right);
      const leftRatio = r.left / viewportW;
      const widthRatio = r.width / viewportW;
      const heightRatio = r.height / viewportH;
      const rightScoped = inRightDrawerScope(el);
      const evidence = lyricEvidence(el);

      // The target must be the actual visible right-side Lyrics surface, not a
      // broad application wrapper. Keep it tall, right-anchored, and bounded.
      if (r.width < 220 || r.height < 180) continue;
      if (leftRatio < 0.56) continue;
      if (widthRatio < 0.12 || widthRatio > 0.50) continue;
      if (heightRatio < 0.45) continue;
      if (rightGap > Math.max(24, viewportW * 0.045)) continue;

      const contentChild = el.querySelector(LYRIC_CONTENT_SELECTORS.join(","));
      const exactSurface = el.matches(".lyric-view.apple-desktop-lyrics") ? 1 : 0;
      const concreteSurface = el.matches(".lyric-view") ? 1 : 0;

      // Strongly prefer the concrete Lyrics surface. Ancestors/wrappers only
      // serve as fallback when Cider changes the markup.
      const score =
        exactSurface * 7000 +
        concreteSurface * 1800 +
        (rightScoped ? 1800 : 0) +
        evidence * 800 +
        (contentChild ? 450 : 0) +
        leftRatio * 110 +
        heightRatio * 100 -
        rightGap / viewportW * 1000;

      const previous = candidates.get(el);
      if (previous === undefined || score > previous) candidates.set(el, score);
    }
  }

  let best: HTMLElement | null = null;
  let bestScore = -Infinity;
  for (const [el, score] of candidates) {
    const area = rectArea(el);
    const bestArea = rectArea(best);
    if (
      score > bestScore ||
      (Math.abs(score - bestScore) < 0.001 && area > 0 && area < bestArea)
    ) {
      best = el;
      bestScore = score;
    }
  }
  return best;
}

function findNavigationHost(): HTMLElement | null {
  const viewport = getStableViewport();
  let best: HTMLElement | null = null;
  let bestArea = Infinity;
  const seen = new Set<HTMLElement>();
  for (const selector of NAVIGATION_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (seen.has(el) || !isDisplayed(el) || isMiniContext(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 140 || r.height < 220) continue;
      if (r.left > window.innerWidth * 0.45) continue;
      if (r.top > window.innerHeight * 0.2) continue;
      if (r.right > window.innerWidth * 0.50) continue;
      if (r.height < viewport.getBoundingClientRect().height * 0.45) continue;
      const area = rectArea(el);
      if (area > 0 && area < bestArea) { best = el; bestArea = area; }
    }
  }
  return best;
}


function syncNavigationContrast(host: HTMLElement | null) {
  const marked = document.querySelectorAll<HTMLElement>(".canvascider-navigation-contrast");
  for (const el of marked) {
    if (cfg.placement !== "navigation" || el !== host) {
      el.classList.remove("canvascider-navigation-contrast");
    }
  }

  if (cfg.placement === "navigation" && host) {
    host.classList.add("canvascider-navigation-contrast");
  }
}

function isLikelyMiniPlayerRect(rect: DOMRect) {
  const viewportW = Math.max(window.innerWidth, 1);
  const viewportH = Math.max(window.innerHeight, 1);
  const bottomGap = Math.max(0, viewportH - rect.bottom);
  const maxHeight = Math.min(220, viewportH * 0.34);

  // A real Mini Player is bottom-docked and compact. Reject large ancestors or
  // page-level containers so the Canvas cannot accidentally cover the whole UI.
  return (
    rect.width >= Math.min(280, viewportW * 0.35) &&
    rect.height >= 50 &&
    rect.height <= maxHeight &&
    rect.top >= viewportH * 0.60 &&
    bottomGap <= Math.max(36, viewportH * 0.06) &&
    rect.left < viewportW &&
    rect.right > 0
  );
}

function findMiniPlayerHost(): HTMLElement | null {
  const candidates = new Set<HTMLElement>();

  // First consider explicit Mini Player surfaces. These receive the strongest
  // preference and are much safer than matching arbitrary ancestors.
  for (const selector of MINI_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) candidates.add(el);
  }

  // Then consider elements whose own metadata identifies them as a mini player.
  // Do not walk up arbitrary ancestors: large page wrappers are a common false
  // positive and were the source of the oversized Canvas shown in screenshot 3.
  for (const el of document.querySelectorAll<HTMLElement>(
    '[class*="mini" i], [aria-label*="mini" i], [sfc-name*="mini" i], [data-testid*="mini" i]'
  )) {
    candidates.add(el);
  }

  let best: HTMLElement | null = null;
  let bestScore = -Infinity;

  for (const el of candidates) {
    if (!isDisplayed(el) || !isMiniContext(el)) continue;
    const r = el.getBoundingClientRect();
    if (!isLikelyMiniPlayerRect(r)) continue;

    const viewportW = Math.max(window.innerWidth, 1);
    const viewportH = Math.max(window.innerHeight, 1);
    const bottomGap = Math.max(0, viewportH - r.bottom);
    const explicit = MINI_SELECTORS.some((selector) => el.matches(selector)) ? 10000 : 0;

    // Prefer the explicit Mini Player surface, then the largest useful width,
    // while still heavily penalizing distance from the viewport bottom.
    const score =
      explicit +
      (r.width / viewportW) * 500 +
      (r.height / viewportH) * 120 -
      (bottomGap / viewportH) * 1200;

    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}
function findPlacementHost(): HTMLElement | null {
  if (cfg.placement === "navigation") return findNavigationHost();
  if (cfg.placement === "mini") return findMiniPlayerHost();
  return findRightLyricsHost();
}

function getLyricsContent(host: HTMLElement) {
  for (const selector of LYRIC_CONTENT_SELECTORS) {
    const el = host.querySelector<HTMLElement>(selector);
    if (el && el !== rootEl) return el;
  }
  return null;
}

function getStableViewport() {
  return document.querySelector<HTMLElement>('#app-viewport') || document.documentElement;
}

function getPortalZIndex(host: HTMLElement) {
  // Keep Lyrics at the proven one-layer-back position. For Navigation,
  // experimentally place the Canvas one additional stacking layer lower.
  let node: HTMLElement | null = host;
  let best = 1;
  for (let depth = 0; node && depth < 8; depth++) {
    const z = Number.parseInt(getComputedStyle(node).zIndex, 10);
    if (Number.isFinite(z)) best = Math.max(best, Math.min(z + 1, 9999));
    node = node.parentElement;
  }
  const layersBack = cfg.placement === "navigation" ? 2 : 1;
  return String(Math.max(1, Math.min(best - layersBack, 9999)));
}

function scheduleSync(reason: string) {
  if (!canvasActive.value || !canvasUrl.value || reducedMotion.value) return;
  pendingSync = true;
  if (animationFrame !== null) return;
  animationFrame = window.requestAnimationFrame(() => {
    animationFrame = null;
    if (!pendingSync) return;
    pendingSync = false;
    void syncToLyricsTarget(reason);
  });
}

function ensurePortalRoot() {
  if (!rootEl) {
    rootEl = document.querySelector<HTMLElement>("canvascider-main-canvas");
  }
  if (!rootEl) return false;

  // Critical: never move this element into a Cider-managed Lyrics node.
  // It permanently remains plugin-owned under <body>.
  if (rootEl.parentElement !== document.body) {
    document.body.appendChild(rootEl);
  }

  rootEl.style.setProperty("position", "fixed", "important");
  rootEl.style.setProperty("margin", "0", "important");
  rootEl.style.setProperty("padding", "0", "important");
  rootEl.style.setProperty("pointer-events", "none", "important");
  rootEl.style.setProperty("overflow", "hidden", "important");
  rootEl.style.setProperty("display", "none", "important");
  rootEl.style.setProperty("width", "0", "important");
  rootEl.style.setProperty("height", "0", "important");
  rootEl.style.setProperty("inset", "auto", "important");
  rootEl.dataset.canvasPortalOwner = "canvas-for-cider";

  portalLayer = rootEl.querySelector<HTMLElement>(".layer");
  videoEl = rootEl.querySelector<HTMLVideoElement>("video");
  return Boolean(portalLayer && videoEl);
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
    if (reducedMotion.value || !canvasActive.value || !canvasUrl.value || video !== guardedVideo) return;
    if (video.ended) {
      try { video.currentTime = 0; } catch {}
    }
    if (video.paused) void video.play().catch(() => {});
  };

  const recover = () => {
    if (reducedMotion.value || !canvasActive.value || !canvasUrl.value || video !== guardedVideo) return;
    const now = Date.now();
    if (now < recoveryCooldownUntil) return;
    recoveryCooldownUntil = now + 5000;
    void video.play().catch(() => {});
  };

  ["pause", "ended", "canplay", "canplaythrough", "loadeddata", "loadedmetadata"].forEach((event) =>
    video.addEventListener(event, resume)
  );
  ["waiting", "stalled"].forEach((event) => video.addEventListener(event, recover));

  removePlaybackGuard = () => {
    ["pause", "ended", "canplay", "canplaythrough", "loadeddata", "loadedmetadata"].forEach((event) =>
      video.removeEventListener(event, resume)
    );
    ["waiting", "stalled"].forEach((event) => video.removeEventListener(event, recover));
  };
}

function configureVideo(video: HTMLVideoElement) {
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.autoplay = !reducedMotion.value;
  video.playsInline = true;
  video.preload = "auto";
  video.style.visibility = reducedMotion.value ? "hidden" : "visible";
  video.style.opacity = "1";
}

function setVideoSource(url: string, forceReload = false) {
  if (!videoEl || !url) return;

  let absoluteUrl = url;
  try { absoluteUrl = new URL(url, document.baseURI).href; } catch {}

  const current = videoEl.currentSrc || videoEl.src || "";
  const same = current === url || current === absoluteUrl || lastAppliedUrl === url;
  if (same && !forceReload) return;

  try { videoEl.pause(); } catch {}
  videoEl.removeAttribute("src");
  try { videoEl.load(); } catch {}
  videoEl.src = url;
  lastAppliedUrl = url;
  try { videoEl.load(); } catch {}
}

function setPortalRectangle(host: HTMLElement) {
  if (!rootEl || !portalLayer) return false;

  syncNavigationContrast(host);
  const r = host.getBoundingClientRect();
  const visible = r.width > 120 && r.height > 100 && r.bottom > 0 && r.right > 0 &&
    r.left < window.innerWidth && r.top < window.innerHeight;

  if (!visible) {
    rootEl.style.setProperty("display", "none", "important");
    return false;
  }

  // Body-owned portal: exact on-screen rectangle of the concrete right-side
  // Lyrics surface selected by findRightLyricsHost(). No viewport-wide sizing.
  rootEl.style.setProperty("left", `${Math.round(r.left * 100) / 100}px`, "important");
  rootEl.style.setProperty("top", `${Math.round(r.top * 100) / 100}px`, "important");
  rootEl.style.setProperty("width", `${Math.round(r.width * 100) / 100}px`, "important");
  rootEl.style.setProperty("height", `${Math.round(r.height * 100) / 100}px`, "important");
  rootEl.style.setProperty("z-index", getPortalZIndex(host), "important");
  rootEl.style.setProperty("display", "block", "important");
  portalLayer.style.setProperty("position", "absolute", "important");
  portalLayer.style.setProperty("inset", "0", "important");
  portalLayer.style.setProperty("width", "100%", "important");
  portalLayer.style.setProperty("height", "100%", "important");
  portalLayer.style.setProperty("display", "block", "important");
  portalLayer.style.setProperty("pointer-events", "none", "important");
  portalLayer.style.setProperty("background", "transparent", "important");
  portalLayer.style.setProperty("opacity", String(canvasOpacity.value), "important");
  portalLayer.style.setProperty("opacity", String(canvasOpacity.value), "important");

  const signature = [
    describe(host),
    Math.round(r.left),
    Math.round(r.top),
    Math.round(r.width),
    Math.round(r.height),
  ].join("|");

  if (signature !== lastRectSignature || lastTargetHost !== host) {
    lastRectSignature = signature;
    lastTargetHost = host;
    log("Canvas portal latched to current main-window Lyrics pane", {
      host: describe(host),
      left: Math.round(r.left),
      top: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
      portalOwner: "document.body",
    });
  }

  return true;
}

async function syncToLyricsTarget(reason: string) {
  if (syncRunning || !ensurePortalRoot() || !canvasActive.value || !canvasUrl.value || reducedMotion.value) return;
  syncRunning = true;
  try {
    const url = canvasUrl.value;
    configureVideo(videoEl!);
    attachPlaybackGuard(videoEl!);
    setVideoSource(url);

    const host = findPlacementHost();
    if (!host || !setPortalRectangle(host)) {
      rootEl!.style.setProperty("display", "none", "important");
      const now = Date.now();
      if (now - lastNoTargetLogAt > 2500) {
        lastNoTargetLogAt = now;
        log("Lyrics pane not currently available; portal stays alive and continues retrying", {
          reason,
          attempts: latchAttempts,
        });
      }
      startPersistentLatch(url, reason);
      return;
    }

    try { await videoEl!.play(); } catch {}
    startPersistentLatch(url, reason);
  } finally {
    syncRunning = false;
  }
}

function clearLatch() {
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = null;
  latchUrl = "";
  latchStartedAt = 0;
  latchAttempts = 0;
}

function startPersistentLatch(url: string, reason: string) {
  if (!url || !canvasActive.value || reducedMotion.value) return;
  if (latchUrl !== url) {
    clearLatch();
    latchUrl = url;
    latchStartedAt = Date.now();
  }

  const next = () => {
    if (retryTimer !== null) return;
    if (latchUrl !== url || canvasUrl.value !== url || !canvasActive.value || reducedMotion.value) return;

    const elapsed = Date.now() - latchStartedAt;
    if (elapsed > 5 * 60 * 1000) {
      // Do not give up permanently. Cider can replace the Lyrics pane much later.
      latchStartedAt = Date.now();
      latchAttempts = 0;
    }

    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      latchAttempts++;
      scheduleSync(`persistent Lyrics latch: ${reason}`);
      next();
    }, latchAttempts < 250 ? 50 : 180);
  };

  scheduleSync(reason);
  next();
}

function stopPortal() {
  clearLatch();
  lastTargetHost = null;
  if (rootEl) rootEl.style.setProperty("display", "none", "important");
}

function handleMotionChange() {
  if (reducedMotion.value) stopPortal();
  else if (canvasUrl.value && canvasActive.value) startPersistentLatch(canvasUrl.value, "reduced-motion disabled");
}

watch(
  [canvasUrl, canvasActive, () => cfg.placement],
  ([url, active], [oldUrl, oldActive]) => {
    if (!active || !url) {
      lastAppliedUrl = "";
      stopPortal();
      return;
    }

    if (url !== oldUrl || active !== oldActive) {
      latchUrl = url;
      latchStartedAt = Date.now();
      latchAttempts = 0;
      configureVideo(videoEl || rootEl?.querySelector<HTMLVideoElement>("video")!);
      setVideoSource(url, true);
      log("Canvas URL found; starting immediate persistent Lyrics portal latch", {
        urlChanged: url !== oldUrl,
        activeChanged: active !== oldActive,
      });
    }

    startPersistentLatch(url, "Canvas URL found");
  },
  { flush: "post" }
);

onMounted(() => {
  reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotionQuery.addEventListener?.("change", handleMotionChange);

  ensurePortalRoot();
  if (videoEl) {
    configureVideo(videoEl);
    attachPlaybackGuard(videoEl);
  }

  // Observe DOM replacement only. We never observe style/attribute churn.
  observer = new MutationObserver(() => {
    if (!canvasUrl.value || !canvasActive.value || reducedMotion.value) return;
    scheduleSync("Cider DOM changed; searching for current Lyrics pane");
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  resizeObserver = new ResizeObserver(() => {
    if (!canvasUrl.value || !canvasActive.value || reducedMotion.value) return;
    scheduleSync("Lyrics layout resized");
  });
  resizeObserver.observe(getStableViewport());

  window.addEventListener("resize", () => scheduleSync("window resized"));
  window.addEventListener("scroll", () => scheduleSync("scroll changed pane coordinates"), true);

  // Fast lifecycle probe. It updates the portal rectangle but does not move our
  // plugin element into Cider's managed DOM.
  playbackWatchdog = window.setInterval(() => {
    if (!canvasUrl.value || !canvasActive.value || reducedMotion.value || !videoEl) return;

    scheduleSync("Lyrics portal watchdog");
    configureVideo(videoEl);
    attachPlaybackGuard(videoEl);

    const current = videoEl.currentTime;
    const now = Date.now();
    if (!videoEl.paused && !videoEl.ended) {
      if (Math.abs(current - lastPlaybackTime) < 0.01) stalledChecks++;
      else stalledChecks = 0;
      lastPlaybackTime = current;
      if (stalledChecks >= 2 && now >= recoveryCooldownUntil) {
        stalledChecks = 0;
        recoveryCooldownUntil = now + 5000;
        void videoEl.play().catch(() => {});
      }
    } else {
      stalledChecks = 0;
      void videoEl.play().catch(() => {});
    }
  }, 1000);

  if (canvasUrl.value && canvasActive.value && !reducedMotion.value) {
    startPersistentLatch(canvasUrl.value, "initial mount");
  }
});

onUnmounted(() => {
  clearLatch();
  if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
  observer?.disconnect();
  resizeObserver?.disconnect();
  clearPlaybackGuard();
  if (playbackWatchdog !== null) window.clearInterval(playbackWatchdog);
  reducedMotionQuery?.removeEventListener?.("change", handleMotionChange);
  document.querySelectorAll<HTMLElement>(".canvascider-navigation-contrast").forEach((el) => {
    el.classList.remove("canvascider-navigation-contrast");
  });
  rootEl = null;
  portalLayer = null;
  videoEl = null;
});
</script>

<template>
  <div class="layer" aria-hidden="true" :style="{ opacity: canvasOpacity }">
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
  transition:opacity 120ms ease;
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
  -webkit-mask-image:linear-gradient(to bottom,transparent 0%,rgba(0,0,0,.04) 5%,rgba(0,0,0,.32) 12%,#000 23%,#000 77%,rgba(0,0,0,.32) 88%,rgba(0,0,0,.04) 95%,transparent 100%);
  mask-image:linear-gradient(to bottom,transparent 0%,rgba(0,0,0,.04) 5%,rgba(0,0,0,.32) 12%,#000 23%,#000 77%,rgba(0,0,0,.32) 88%,rgba(0,0,0,.04) 95%,transparent 100%);
  -webkit-mask-repeat:no-repeat;
  mask-repeat:no-repeat;
  -webkit-mask-size:100% 100%;
  mask-size:100% 100%;
  mix-blend-mode:screen;
}
.edge-fade{
  position:absolute;
  left:0;
  width:100%;
  height:18%;
  pointer-events:none;
  z-index:1;
}
.edge-fade-top{
  top:0;
  background:linear-gradient(to bottom,rgba(0,0,0,.48) 0%,rgba(0,0,0,.20) 35%,rgba(0,0,0,0) 100%);
  mix-blend-mode:multiply;
}
.edge-fade-bottom{
  bottom:0;
  background:linear-gradient(to top,rgba(0,0,0,.48) 0%,rgba(0,0,0,.20) 35%,rgba(0,0,0,0) 100%);
  mix-blend-mode:multiply;
}
@media (prefers-reduced-motion: reduce){
  .video{visibility:hidden!important;}
}
</style>
