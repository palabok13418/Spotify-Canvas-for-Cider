<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { canvasActive, canvasUrl } from "../state";
import { useConfig } from "../config";
import { subscribeEvent } from "../cider";

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
let immersiveHost: HTMLElement | null = null;
let animationTimer: number | null = null;
let immersiveEventCleanup: Array<() => void> = [];
const previousCanvasUrl = ref("");
const animationState = ref<"idle" | "enter" | "switch" | "immersive-enter" | "immersive-exit">("idle");

const reducedMotion = computed(() => Boolean(reducedMotionQuery?.matches));
const animationClasses = computed(() => ({
  "canvas-entering": animationState.value === "enter",
  "canvas-switching": animationState.value === "switch",
  "canvas-immersive-entering": animationState.value === "immersive-enter",
  "canvas-immersive-exiting": animationState.value === "immersive-exit",
}));
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

function findImmersiveHost(): HTMLElement | null {
  // Cider's "One" immersive layout uses the artwork column as the stable host.
  const fullscreen = document.querySelector<HTMLElement>(".fullscreen-view");
  if (!fullscreen || !isDisplayed(fullscreen)) return null;

  const host = fullscreen.querySelector<HTMLElement>(".artwork-col");
  const artwork = host?.querySelector<HTMLElement>(".artwork");
  if (!host || !artwork || !isDisplayed(host) || !isDisplayed(artwork)) return null;

  return host;
}

function findPlacementHost(): HTMLElement | null {
  if (cfg.placement === "navigation") return findNavigationHost();
  if (cfg.placement === "immersive") return findImmersiveHost();
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

  // Keep the plugin element under <body> so Cider can rebuild Immersive without
  // taking the plugin's root element with the old fullscreen DOM.
  if (rootEl.parentElement !== document.body) {
    document.body.appendChild(rootEl);
  }

  rootEl.style.setProperty("position", "fixed", "important");
  rootEl.style.setProperty("margin", "0", "important");
  rootEl.style.setProperty("padding", "0", "important");
  rootEl.style.setProperty("pointer-events", "none", "important");
  rootEl.style.setProperty("overflow", "visible", "important");
  rootEl.style.setProperty("display", "none", "important");
  rootEl.style.setProperty("width", "0", "important");
  rootEl.style.setProperty("height", "0", "important");
  rootEl.style.setProperty("inset", "auto", "important");
  rootEl.dataset.canvasPortalOwner = "canvas-for-cider";

  portalLayer = rootEl.querySelector<HTMLElement>(".layer");
  videoEl = rootEl.querySelector<HTMLVideoElement>(".video-current");
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

function getImmersiveArtwork(host: HTMLElement) {
  return host.querySelector<HTMLElement>(".artwork");
}

function setPortalRectangle(host: HTMLElement) {
  if (!rootEl || !portalLayer) return false;

  syncNavigationContrast(host);
  const immersive = cfg.placement === "immersive";
  const target = immersive ? getImmersiveArtwork(host) : host;
  if (!target) return false;

  const r = target.getBoundingClientRect();
  const visible = r.width > 120 && r.height > 100 && r.bottom > 0 && r.right > 0 &&
    r.left < window.innerWidth && r.top < window.innerHeight;
  if (!visible) {
    rootEl.style.setProperty("display", "none", "important");
    return false;
  }

  if (immersive) {
    // Give the immersive artwork a soft halo so the Canvas does not have a hard
    // rectangular edge against Cider's fullscreen background.
    const bleed = Math.max(18, Math.min(r.width, r.height) * 0.10);
    rootEl.style.setProperty("left", `${Math.round((r.left - bleed) * 100) / 100}px`, "important");
    rootEl.style.setProperty("top", `${Math.round((r.top - bleed) * 100) / 100}px`, "important");
    rootEl.style.setProperty("width", `${Math.round((r.width + bleed * 2) * 100) / 100}px`, "important");
    rootEl.style.setProperty("height", `${Math.round((r.height + bleed * 2) * 100) / 100}px`, "important");
    rootEl.style.setProperty("z-index", "1", "important");
  } else {
    rootEl.style.setProperty("left", `${Math.round(r.left * 100) / 100}px`, "important");
    rootEl.style.setProperty("top", `${Math.round(r.top * 100) / 100}px`, "important");
    rootEl.style.setProperty("width", `${Math.round(r.width * 100) / 100}px`, "important");
    rootEl.style.setProperty("height", `${Math.round(r.height * 100) / 100}px`, "important");
    rootEl.style.setProperty("z-index", getPortalZIndex(host), "important");
  }

  rootEl.style.setProperty("display", "block", "important");
  portalLayer.style.setProperty("position", "absolute", "important");
  portalLayer.style.setProperty("inset", "0", "important");
  portalLayer.style.setProperty("width", "100%", "important");
  portalLayer.style.setProperty("height", "100%", "important");
  portalLayer.style.setProperty("display", "block", "important");
  portalLayer.style.setProperty("pointer-events", "none", "important");
  portalLayer.style.setProperty("background", "transparent", "important");
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
    log("Canvas portal latched", {
      host: describe(host),
      placement: cfg.placement,
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
  if (syncRunning || !canvasActive.value || !canvasUrl.value || reducedMotion.value) return;
  syncRunning = true;
  try {
    const url = canvasUrl.value;
    const host = findPlacementHost();

    if (!host) {
      rootEl?.style.setProperty("display", "none", "important");
      startPersistentLatch(url, reason);
      return;
    }

    if (!ensurePortalRoot()) return;
    configureVideo(videoEl!);
    attachPlaybackGuard(videoEl!);
    setVideoSource(url);

    if (!setPortalRectangle(host)) {
      rootEl!.style.setProperty("display", "none", "important");
      const now = Date.now();
      if (now - lastNoTargetLogAt > 2500) {
        lastNoTargetLogAt = now;
        log("Canvas target not currently available; portal stays alive and continues retrying", {
          reason,
          placement: cfg.placement,
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
  previousCanvasUrl.value = "";
  animationState.value = "idle";
}

function handleMotionChange() {
  if (reducedMotion.value) stopPortal();
  else if (canvasUrl.value && canvasActive.value) startPersistentLatch(canvasUrl.value, "reduced-motion disabled");
}

function triggerAnimation(kind: "enter" | "switch" | "immersive-enter" | "immersive-exit") {
  if (reducedMotion.value) return;
  animationState.value = kind;
  if (animationTimer !== null) window.clearTimeout(animationTimer);
  animationTimer = window.setTimeout(() => {
    animationState.value = "idle";
    previousCanvasUrl.value = "";
  }, kind === "switch" ? 900 : 820);
}

watch(
  [canvasUrl, canvasActive, () => cfg.placement],
  ([url, active, placement], [oldUrl, oldActive, oldPlacement]) => {
    if (!active || !url) {
      lastAppliedUrl = "";
      if (oldPlacement === "immersive" && placement !== "immersive" && oldActive) {
        triggerAnimation("immersive-exit");
      }
      stopPortal();
      return;
    }

    if (url !== oldUrl || active !== oldActive || placement !== oldPlacement) {
      if (url && oldUrl && url !== oldUrl) {
        previousCanvasUrl.value = oldUrl;
        triggerAnimation("switch");
      } else if (placement === "immersive" && oldPlacement !== "immersive") {
        triggerAnimation("immersive-enter");
      } else if (!oldActive && active) {
        triggerAnimation("enter");
      }

      latchUrl = url;
      latchStartedAt = Date.now();
      latchAttempts = 0;
      const currentVideo = videoEl || rootEl?.querySelector<HTMLVideoElement>(".video-current");
      if (currentVideo) {
        configureVideo(currentVideo);
        setVideoSource(url, true);
      }
      log("Canvas URL found; starting immediate persistent Canvas portal latch", {
        urlChanged: url !== oldUrl,
        activeChanged: active !== oldActive,
        placement,
      });
    }

    startPersistentLatch(url, "Canvas URL found");
  },
  { flush: "post" }
);

onMounted(() => {
  reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  immersiveEventCleanup = [
    subscribeEvent("immersive:opened", () => {
      if (cfg.placement === "immersive" && canvasActive.value && canvasUrl.value) {
        triggerAnimation("immersive-enter");
      }
      scheduleSync("Cider Immersive opened");
    }),
    subscribeEvent("immersive:closed", () => {
      if (cfg.placement === "immersive" && canvasActive.value && canvasUrl.value) {
        triggerAnimation("immersive-exit");
        window.setTimeout(() => {
          if (!findImmersiveHost()) stopPortal();
        }, 420);
      } else {
        scheduleSync("Cider Immersive closed");
      }
    }),
  ];
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
  if (animationTimer !== null) window.clearTimeout(animationTimer);
  immersiveEventCleanup.forEach(fn => fn());
  immersiveEventCleanup = [];
  document.querySelectorAll<HTMLElement>(".canvascider-navigation-contrast").forEach((el) => {
    el.classList.remove("canvascider-navigation-contrast");
  });
  rootEl = null;
  portalLayer = null;
  videoEl = null;
});
</script>

<template>
  <div class="layer" :class="animationClasses" aria-hidden="true" :style="{ opacity: canvasOpacity }">
    <video
      v-if="previousCanvasUrl"
      class="video video-previous"
      :src="previousCanvasUrl"
      muted
      loop
      playsinline
      preload="auto"
      autoplay
    ></video>

    <div v-if="cfg.placement === 'lyrics'" class="lyrics-ambience" aria-hidden="true">
      <video
        class="ambient-video"
        :src="canvasUrl || undefined"
        muted
        loop
        playsinline
        preload="auto"
        :autoplay="!reducedMotion"
      ></video>
    </div>

    <div v-if="cfg.placement === 'immersive'" class="immersive-ambience" aria-hidden="true">
      <video
        class="ambient-video"
        :src="canvasUrl || undefined"
        muted
        loop
        playsinline
        preload="auto"
        :autoplay="!reducedMotion"
      ></video>
    </div>

    <video
      class="video video-current"
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

.canvascider-immersive-host{
  position:relative!important;
}

canvascider-main-canvas{
  box-sizing:border-box!important;
  position:fixed!important;
  pointer-events:none!important;
  overflow:visible!important;
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
.layer.canvas-entering,
.layer.canvas-switching,
.layer.canvas-immersive-entering,
.layer.canvas-immersive-exiting{
  will-change:clip-path,transform,opacity,filter;
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
.video-previous{opacity:1;}
.video-current{z-index:2;}
.layer.canvas-switching .video-current{animation:canvasSwitchCurrent 900ms cubic-bezier(.22,.61,.36,1) both;}
.layer.canvas-switching .video-previous{animation:canvasSwitchPrevious 900ms cubic-bezier(.22,.61,.36,1) both;}
.layer.canvas-entering,
.layer.canvas-immersive-entering{
  clip-path:polygon(50% 46%,54% 49%,58% 50%,54% 51%,50% 54%,46% 51%,42% 50%,46% 49%);
  animation:canvasStarReveal 820ms cubic-bezier(.16,1,.3,1) forwards;
}
.layer.canvas-immersive-entering .video-current{
  animation:canvasImmersiveSpin 820ms cubic-bezier(.12,.72,.22,1) both;
}
.layer.canvas-immersive-exiting{
  animation:canvasStarReverse 650ms cubic-bezier(.65,0,.84,.15) both;
}
.lyrics-ambience,
.immersive-ambience{
  position:absolute;
  pointer-events:none;
  z-index:0;
  overflow:hidden;
}
.lyrics-ambience{
  left:-18%;
  top:-8%;
  width:60%;
  height:116%;
  opacity:.28;
  filter:blur(32px) saturate(1.18) contrast(1.04);
  transform:scale(1.08);
  transform-origin:center right;
  mask-image:linear-gradient(to right,transparent 0%,#000 28%,#000 78%,transparent 100%);
  -webkit-mask-image:linear-gradient(to right,transparent 0%,#000 28%,#000 78%,transparent 100%);
}
.immersive-ambience{
  inset:-18%;
  opacity:.34;
  filter:blur(34px) saturate(1.2) contrast(1.03);
  transform:scale(1.08);
  mask-image:radial-gradient(ellipse at center,#000 42%,rgba(0,0,0,.72) 58%,transparent 88%);
  -webkit-mask-image:radial-gradient(ellipse at center,#000 42%,rgba(0,0,0,.72) 58%,transparent 88%);
}
.ambient-video{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  object-fit:cover;
  opacity:1;
  mix-blend-mode:screen;
}
@keyframes canvasStarReveal{
  from{clip-path:polygon(50% 46%,54% 49%,58% 50%,54% 51%,50% 54%,46% 51%,42% 50%,46% 49%);}
  to{clip-path:polygon(0% 0%,100% 0%,100% 50%,100% 100%,0% 100%,0% 50%,0% 50%,0% 0%);}
}
@keyframes canvasStarReverse{
  from{
    clip-path:polygon(0% 0%,100% 0%,100% 50%,100% 100%,0% 100%,0% 50%,0% 50%,0% 0%);
    transform:scale(1) rotate(0deg);
  }
  to{
    clip-path:polygon(50% 46%,54% 49%,58% 50%,54% 51%,50% 54%,46% 51%,42% 50%,46% 49%);
    transform:scale(.86) rotate(360deg);
  }
}
@keyframes canvasImmersiveSpin{
  0%{transform:scale(.84) rotate(-360deg);filter:saturate(.75) contrast(1) brightness(.72);}
  64%{transform:scale(1.015) rotate(12deg);filter:saturate(.88) contrast(1.02) brightness(.78);}
  100%{transform:scale(1) rotate(0deg);filter:saturate(.88) contrast(1.02) brightness(.78);}
}
@keyframes canvasSwitchCurrent{
  0%{opacity:0;transform:scale(1.035);filter:blur(10px) saturate(.72) brightness(.72);}
  55%{opacity:1;transform:scale(1.005);filter:blur(1.5px) saturate(.88) brightness(.78);}
  100%{opacity:1;transform:scale(1);filter:blur(0) saturate(.88) contrast(1.02) brightness(.78);}
}
@keyframes canvasSwitchPrevious{
  0%{opacity:1;transform:scale(1);filter:blur(0);}
  45%{opacity:.72;transform:scale(.99);filter:blur(1px);}
  100%{opacity:0;transform:scale(.975);filter:blur(8px);}
}

@media (prefers-reduced-motion: reduce){
  .video{visibility:hidden!important;}
}
</style>
