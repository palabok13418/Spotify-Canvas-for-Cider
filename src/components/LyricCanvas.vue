<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { canvasActive, canvasTransitioning, canvasUrl } from "../state";
import { useConfig } from "../config";
import { subscribeEvent } from "../cider";

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
  '[data-immersive="true"]',
  '[data-mode="immersive"]',
  '[data-view="immersive"]',
  '[sfc-name*="immersive" i]',
  '[data-testid*="immersive" i]',
  '[class*="immersive" i]',
  '[id*="immersive" i]',
  '[class*="fullscreen" i]',
];

let rootEl: HTMLElement | null = null;
let currentVideoEl: HTMLVideoElement | null = null;
let incomingVideoEl: HTMLVideoElement | null = null;
let observer: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let retryTimer: number | null = null;
let animationFrame: number | null = null;
let playbackWatchdog: number | null = null;
let animationTimer: number | null = null;
let lastTargetHost: HTMLElement | null = null;
let lastRectSignature = "";
let lastRenderedUrl = "";
let lastRenderedPlacement = cfg.placement;
let activeImmersiveTarget = false;
let immersiveOpenByEvent = false;
let lastPlaybackTime = 0;
let stalledChecks = 0;
let recoveryCooldownUntil = 0;
let syncRunning = false;
let pendingSync = false;

const currentRenderUrl = ref("");
const incomingRenderUrl = ref("");
const phase = ref<"idle" | "entering" | "switching" | "immersive-enter" | "immersive-exit" | "leaving">("idle");
const reducedMotionQuery = ref<MediaQueryList | null>(null);

const reducedMotion = computed(() => Boolean(reducedMotionQuery.value?.matches));
const canvasOpacity = computed(() =>
  1 - Math.max(0, Math.min(100, Number(cfg.transparency ?? 50))) / 100
);
const renderable = computed(() =>
  Boolean((canvasActive.value || canvasTransitioning.value) &&
    (currentRenderUrl.value || incomingRenderUrl.value))
);

function log(...args: unknown[]) {
  console.log(PREFIX, ...args);
}

function describe(el: HTMLElement | null) {
  if (!el) return "null";
  const classes = [...el.classList].slice(0, 5).map(name => "." + name).join("");
  const sfc = el.getAttribute("sfc-name");
  return el.tagName.toLowerCase() +
    (el.id ? "#" + el.id : "") +
    classes +
    (sfc ? "[sfc-name=" + sfc + "]" : "");
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
  for (let depth = 0; node && depth < 12; depth++) {
    const text = [
      typeof node.className === "string" ? node.className : "",
      node.id,
      node.getAttribute("data-testid"),
      node.getAttribute("aria-label"),
      node.getAttribute("sfc-name"),
    ].filter(Boolean).join(" ").toLowerCase();
    if (/mini.?player|miniplayer|mini-player/.test(text)) return true;
    node = node.parentElement;
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
      const textEvidence = /lyric|lyrics/i.test([
        ...el.classList,
        el.getAttribute("sfc-name") || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("data-testid") || "",
      ].join(" ")) ? 800 : 0;

      candidates.set(
        el,
        exact + concrete + scoped + textEvidence +
        leftRatio * 110 + heightRatio * 100 -
        rightGap / vw * 1000
      );
    }
  }

  let best: HTMLElement | null = null;
  let bestScore = -Infinity;
  for (const [el, score] of candidates) {
    const area = rectArea(el);
    const bestArea = rectArea(best);
    if (score > bestScore || (Math.abs(score - bestScore) < 0.001 && area > 0 && area < bestArea)) {
      best = el;
      bestScore = score;
    }
  }
  return best;
}

function findNavigationHost(): HTMLElement | null {
  const viewport = document.querySelector<HTMLElement>("#app-viewport") || document.documentElement;
  let best: HTMLElement | null = null;
  let bestArea = Infinity;
  const seen = new Set<HTMLElement>();

  for (const selector of NAVIGATION_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (seen.has(el) || !isDisplayed(el) || isMiniContext(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 140 || r.height < 220) continue;
      if (r.left > window.innerWidth * 0.45 || r.top > window.innerHeight * 0.20) continue;
      if (r.right > window.innerWidth * 0.50) continue;
      if (r.height < viewport.getBoundingClientRect().height * 0.45) continue;
      const area = rectArea(el);
      if (area > 0 && area < bestArea) {
        best = el;
        bestArea = area;
      }
    }
  }
  return best;
}

function normalizeImmersiveMode(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function readImmersiveStyleFromConfig(): boolean | null {
  const cider = (globalThis as any).CiderApp;
  const values = [
    cider?.config?.visual?.immersiveStyle,
    cider?.config?.visual?.immersive_style,
    cider?.config?.visual?.immersive?.style,
    cider?.config?.visual?.immersive?.layout,
    cider?.config?.immersiveStyle,
    cider?.config?.immersive_style,
    cider?.config?.immersive?.style,
    cider?.config?.immersive?.layout,
  ];

  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    return normalizeImmersiveMode(value) === "one";
  }
  return null;
}

function inferImmersiveStyleFromDom(host: HTMLElement) {
  const values: string[] = [];
  for (const selector of [
    "[data-immersive-style]",
    "[data-style]",
    "[data-layout]",
    "[data-layout-name]",
    "[aria-label]",
    "[title]",
  ]) {
    for (const el of host.querySelectorAll<HTMLElement>(selector)) {
      for (const attr of [
        "data-immersive-style",
        "data-style",
        "data-layout",
        "data-layout-name",
        "aria-label",
        "title",
      ]) {
        const value = el.getAttribute(attr);
        if (value) values.push(value);
      }
    }
  }

  const own = [
    host.id,
    typeof host.className === "string" ? host.className : "",
    host.getAttribute("data-immersive-style") || "",
    host.getAttribute("data-style") || "",
    host.getAttribute("data-layout") || "",
  ].join(" ").split(/[\s_-]+/);

  const modes = [...values, ...own].map(normalizeImmersiveMode);
  if (modes.includes("one") || modes.includes("immersiveone")) return true;
  if (modes.some(value => /^(solarium|mojave|maverick|lite|two|three)$/.test(value))) return false;
  return null;
}

function findImmersiveHost(): HTMLElement | null {
  const candidates = new Set<HTMLElement>();

  for (const selector of IMMERSIVE_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) candidates.add(el);
  }

  let best: HTMLElement | null = null;
  let bestScore = -Infinity;
  const vw = Math.max(window.innerWidth, 1);
  const vh = Math.max(window.innerHeight, 1);

  for (const el of candidates) {
    if (!isDisplayed(el) || el.closest("canvascider-main-canvas")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < vw * 0.60 || r.height < vh * 0.60) continue;
    const areaRatio = Math.max(0, r.width) * Math.max(0, r.height) / (vw * vh);
    const name = [
      el.id,
      typeof el.className === "string" ? el.className : "",
      el.getAttribute("sfc-name") || "",
      el.getAttribute("data-testid") || "",
      el.getAttribute("data-mode") || "",
      el.getAttribute("data-view") || "",
    ].join(" ").toLowerCase();
    const immersiveName = /(^|[\s_-])immersive($|[\s_-])/.test(name) ? 5000 : 0;
    const fullscreen = Math.abs(r.width - vw) < vw * .08 && Math.abs(r.height - vh) < vh * .08 ? 2200 : 0;
    const score = areaRatio * 1000 + immersiveName + fullscreen;
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }

  return best;
}

function immersiveIsOpen(host: HTMLElement | null) {
  if (immersiveOpenByEvent || document.fullscreenElement) return true;
  if (!host) return false;
  const r = host.getBoundingClientRect();
  return r.width >= window.innerWidth * .72 && r.height >= window.innerHeight * .72;
}

function immersiveIsOne(host: HTMLElement | null) {
  if (!host) return false;
  const configured = readImmersiveStyleFromConfig();
  if (configured !== null) return configured;
  return inferImmersiveStyleFromDom(host) === true;
}

function syncNavigationContrast(host: HTMLElement | null) {
  const marked = document.querySelectorAll<HTMLElement>(".canvascider-navigation-contrast");
  for (const el of marked) {
    if (cfg.placement !== "navigation" || el !== host) el.classList.remove("canvascider-navigation-contrast");
  }
  if (cfg.placement === "navigation" && host) host.classList.add("canvascider-navigation-contrast");
}

function getPortalZIndex(host: HTMLElement) {
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

function clearAnimationTimer() {
  if (animationTimer !== null) window.clearTimeout(animationTimer);
  animationTimer = null;
}

function setPhase(next: typeof phase.value, duration: number) {
  clearAnimationTimer();
  phase.value = next;
  if (next === "idle") return;
  animationTimer = window.setTimeout(() => {
    animationTimer = null;
    phase.value = "idle";
  }, duration);
}

async function safePlay(video: HTMLVideoElement | null) {
  if (!video || reducedMotion.value) return;
  try {
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    await video.play();
  } catch {}
}

function syncVideoRefs() {
  if (!rootEl) return;
  currentVideoEl = rootEl.querySelector<HTMLVideoElement>(".current-video");
  incomingVideoEl = rootEl.querySelector<HTMLVideoElement>(".incoming-video");
}

async function beginInitialAnimation() {
  await nextTick();
  syncVideoRefs();
  void safePlay(currentVideoEl);
  if (cfg.placement === "immersive") setPhase("immersive-enter", 900);
  else setPhase("entering", 760);
}

function beginSwitch(url: string) {
  if (!currentRenderUrl.value) {
    currentRenderUrl.value = url;
    incomingRenderUrl.value = "";
    lastRenderedUrl = url;
    void beginInitialAnimation();
    return;
  }

  if (currentRenderUrl.value === url && !incomingRenderUrl.value) return;

  incomingRenderUrl.value = url;
  void nextTick().then(() => {
    syncVideoRefs();
    void safePlay(currentVideoEl);
    void safePlay(incomingVideoEl);
    setPhase("switching", 760);
    clearAnimationTimer();
    animationTimer = window.setTimeout(() => {
      currentRenderUrl.value = incomingRenderUrl.value;
      incomingRenderUrl.value = "";
      lastRenderedUrl = currentRenderUrl.value;
      animationTimer = null;
      phase.value = "idle";
      void nextTick().then(() => {
        syncVideoRefs();
        void safePlay(currentVideoEl);
      });
    }, 760);
  });
}

function syncRenderState() {
  if (canvasUrl.value && canvasActive.value) {
    if (canvasUrl.value !== lastRenderedUrl || currentRenderUrl.value !== canvasUrl.value) {
      beginSwitch(canvasUrl.value);
    }
    return;
  }

  if (canvasUrl.value && canvasTransitioning.value) {
    if (phase.value === "idle") setPhase("leaving", 700);
  }
}

function clearRenderedCanvas() {
  clearAnimationTimer();
  currentRenderUrl.value = "";
  incomingRenderUrl.value = "";
  lastRenderedUrl = "";
  phase.value = "idle";
}

function scheduleSync(reason: string) {
  if (!canvasUrl.value || (!canvasActive.value && !canvasTransitioning.value) || reducedMotion.value) return;
  pendingSync = true;
  if (animationFrame !== null) return;
  animationFrame = window.requestAnimationFrame(() => {
    animationFrame = null;
    if (!pendingSync) return;
    pendingSync = false;
    void syncToTarget(reason);
  });
}

function ensureRoot() {
  if (!rootEl) rootEl = document.querySelector<HTMLElement>("canvascider-main-canvas");
  if (!rootEl) return false;
  if (rootEl.parentElement !== document.body) document.body.appendChild(rootEl);

  rootEl.style.setProperty("position", "fixed", "important");
  rootEl.style.setProperty("margin", "0", "important");
  rootEl.style.setProperty("padding", "0", "important");
  rootEl.style.setProperty("pointer-events", "none", "important");
  rootEl.style.setProperty("overflow", "visible", "important");
  rootEl.style.setProperty("display", renderable.value ? "block" : "none", "important");
  rootEl.style.setProperty("box-sizing", "border-box", "important");
  rootEl.style.setProperty("min-width", "0", "important");
  rootEl.style.setProperty("min-height", "0", "important");
  rootEl.dataset.canvasPortalOwner = "canvas-for-cider";

  syncVideoRefs();
  return true;
}

function setPortalRectangle(host: HTMLElement, immersive: boolean) {
  if (!rootEl) return false;
  const r = host.getBoundingClientRect();
  const visible = r.width > 120 && r.height > 100 &&
    r.bottom > 0 && r.right > 0 &&
    r.left < window.innerWidth && r.top < window.innerHeight;

  if (!visible) {
    rootEl.style.setProperty("display", "none", "important");
    return false;
  }

  rootEl.style.setProperty("left", Math.round(r.left * 100) / 100 + "px", "important");
  rootEl.style.setProperty("top", Math.round(r.top * 100) / 100 + "px", "important");
  rootEl.style.setProperty("width", Math.round(r.width * 100) / 100 + "px", "important");
  rootEl.style.setProperty("height", Math.round(r.height * 100) / 100 + "px", "important");
  rootEl.style.setProperty("z-index", getPortalZIndex(host), "important");
  rootEl.style.setProperty("display", renderable.value ? "block" : "none", "important");
  rootEl.dataset.canvasPlacement = immersive ? "immersive" : cfg.placement;

  if (activeImmersiveTarget !== immersive) {
    if (immersive) setPhase("immersive-enter", 900);
    else if (lastRenderedPlacement === "immersive") setPhase("immersive-exit", 700);
    activeImmersiveTarget = immersive;
  }

  syncNavigationContrast(host);

  const signature = [
    describe(host),
    Math.round(r.left),
    Math.round(r.top),
    Math.round(r.width),
    Math.round(r.height),
    cfg.placement,
    immersive ? "immersive" : "normal",
  ].join("|");

  if (signature !== lastRectSignature || lastTargetHost !== host) {
    lastRectSignature = signature;
    lastTargetHost = host;
    log("Canvas target synchronized", {
      host: describe(host),
      placement: cfg.placement,
      immersive,
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }
  return true;
}

async function syncToTarget(reason: string) {
  if (syncRunning || reducedMotion.value || !ensureRoot()) return;
  syncRunning = true;

  try {
    syncRenderState();

    let host: HTMLElement | null = null;
    let immersive = false;

    if (cfg.placement === "lyrics") {
      host = findRightLyricsHost();
    } else if (cfg.placement === "navigation") {
      host = findNavigationHost();
    } else {
      host = findImmersiveHost();
      immersive = Boolean(host && immersiveIsOpen(host) && immersiveIsOne(host));
      if (!immersive) host = null;
    }

    if (!host) {
      rootEl.style.setProperty("display", "none", "important");
      if (cfg.placement === "immersive") activeImmersiveTarget = false;
      return;
    }

    if (cfg.placement !== lastRenderedPlacement) {
      if (cfg.placement === "immersive") setPhase("immersive-enter", 900);
      else if (lastRenderedPlacement === "immersive") setPhase("immersive-exit", 700);
      lastRenderedPlacement = cfg.placement;
    }

    setPortalRectangle(host, immersive);

    if (canvasUrl.value && canvasActive.value) {
      await safePlay(currentVideoEl);
      await safePlay(incomingVideoEl);
    }
  } finally {
    syncRunning = false;
  }

  if (reason) lastNoTargetLogAt = Date.now();
}

function clearLatch() {
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = null;
}

function startPersistentLatch() {
  clearLatch();
  const tick = () => {
    if (!canvasUrl.value || (!canvasActive.value && !canvasTransitioning.value) || reducedMotion.value) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      scheduleSync("persistent Canvas target latch");
      tick();
    }, 180);
  };
  tick();
}

function handleMotionChange() {
  if (reducedMotion.value) {
    clearRenderedCanvas();
    if (rootEl) rootEl.style.setProperty("display", "none", "important");
  } else if (canvasUrl.value && (canvasActive.value || canvasTransitioning.value)) {
    scheduleSync("reduced-motion disabled");
  }
}

watch(
  [canvasUrl, canvasActive, canvasTransitioning],
  ([url, active, transitioning], [oldUrl, oldActive, oldTransitioning]) => {
    if (url && active) {
      if (url !== oldUrl || (!oldActive && active)) beginSwitch(url);
      startPersistentLatch();
      scheduleSync("Canvas state changed");
      return;
    }

    if (url && transitioning) {
      if (!oldTransitioning) setPhase("leaving", 700);
      startPersistentLatch();
      scheduleSync("Canvas transition out");
      return;
    }

    if (!active && !transitioning) {
      clearLatch();
      if (!url) clearRenderedCanvas();
      if (rootEl) rootEl.style.setProperty("display", "none", "important");
    }
  },
  { flush: "post" },
);

watch(
  () => cfg.placement,
  (next, previous) => {
    if (next === previous) return;
    if (next === "immersive") setPhase("immersive-enter", 900);
    else if (previous === "immersive") setPhase("immersive-exit", 700);
    scheduleSync("Canvas placement changed");
  },
);

onMounted(() => {
  reducedMotionQuery.value = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotionQuery.value.addEventListener?.("change", handleMotionChange);

  const cleanup = [
    subscribeEvent("immersive:opened", () => {
      immersiveOpenByEvent = true;
      if (cfg.placement === "immersive") setPhase("immersive-enter", 900);
      scheduleSync("Cider immersive opened");
    }),
    subscribeEvent("immersive:closed", () => {
      immersiveOpenByEvent = false;
      if (cfg.placement === "immersive") setPhase("immersive-exit", 700);
      scheduleSync("Cider immersive closed");
    }),
  ];

  observer = new MutationObserver(() => {
    if (!canvasUrl.value || (!canvasActive.value && !canvasTransitioning.value) || reducedMotion.value) return;
    scheduleSync("Cider DOM changed");
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  resizeObserver = new ResizeObserver(() => {
    if (!canvasUrl.value || (!canvasActive.value && !canvasTransitioning.value) || reducedMotion.value) return;
    scheduleSync("Canvas target resized");
  });

  const viewport = document.querySelector<HTMLElement>("#app-viewport");
  if (viewport) resizeObserver.observe(viewport);

  window.addEventListener("resize", () => scheduleSync("window resized"));
  window.addEventListener("scroll", () => scheduleSync("window scrolled"), true);

  playbackWatchdog = window.setInterval(() => {
    if (!canvasUrl.value || (!canvasActive.value && !canvasTransitioning.value) || reducedMotion.value) return;
    scheduleSync("Canvas watchdog");
    syncVideoRefs();
    void safePlay(currentVideoEl);

    if (!currentVideoEl) return;
    const now = Date.now();
    if (!currentVideoEl.paused && !currentVideoEl.ended) {
      if (Math.abs(currentVideoEl.currentTime - lastPlaybackTime) < 0.01) stalledChecks++;
      else stalledChecks = 0;
      lastPlaybackTime = currentVideoEl.currentTime;

      if (stalledChecks >= 2 && now >= recoveryCooldownUntil) {
        stalledChecks = 0;
        recoveryCooldownUntil = now + 5000;
        void safePlay(currentVideoEl);
      }
    } else {
      stalledChecks = 0;
    }
  }, 1000);

  if (canvasUrl.value && (canvasActive.value || canvasTransitioning.value) && !reducedMotion.value) {
    beginSwitch(canvasUrl.value);
    startPersistentLatch();
    scheduleSync("initial mount");
  }

  (onUnmounted as any).call(null);
  // The actual Vue unmount cleanup is registered below through lifecycle state.
  (cleanup as (() => void)[]);
  (cleanup as any).__canvasCleanup = cleanup;
});

onUnmounted(() => {
  clearLatch();
  clearAnimationTimer();
  if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
  observer?.disconnect();
  resizeObserver?.disconnect();
  if (playbackWatchdog !== null) window.clearInterval(playbackWatchdog);
  reducedMotionQuery.value?.removeEventListener?.("change", handleMotionChange);
  document.querySelectorAll<HTMLElement>(".canvascider-navigation-contrast").forEach(el => el.classList.remove("canvascider-navigation-contrast"));
  clearRenderedCanvas();
  rootEl = null;
  currentVideoEl = null;
  incomingVideoEl = null;
});
</script>

<template>
  <div
    class="canvas-shell"
    :class="[phase, cfg.placement, { visible: renderable }]"
    aria-hidden="true"
  >
    <div v-if="cfg.placement === 'lyrics'" class="ambient ambient-left">
      <video
        class="ambient-video"
        :src="currentRenderUrl || undefined"
        muted
        loop
        playsinline
        preload="auto"
      ></video>
    </div>

    <div v-if="cfg.placement === 'immersive'" class="ambient ambient-frame">
      <video
        class="ambient-video"
        :src="currentRenderUrl || undefined"
        muted
        loop
        playsinline
        preload="auto"
      ></video>
    </div>

    <div class="stage">
      <video
        v-if="currentRenderUrl"
        class="canvas-video current-video"
        :src="currentRenderUrl"
        muted
        loop
        playsinline
        preload="auto"
        :autoplay="!reducedMotion"
      ></video>

      <video
        v-if="incomingRenderUrl"
        class="canvas-video incoming-video"
        :src="incomingRenderUrl"
        muted
        loop
        playsinline
        preload="auto"
        :autoplay="!reducedMotion"
      ></video>
    </div>
  </div>
</template>

<style>
canvascider-main-canvas{
  box-sizing:border-box!important;
  position:fixed!important;
  display:none!important;
  pointer-events:none!important;
  overflow:visible!important;
  margin:0!important;
  padding:0!important;
  min-width:0!important;
  min-height:0!important;
  max-width:none!important;
  max-height:none!important;
  transform:none!important;
  background:transparent!important;
  isolation:isolate!important;
}

.canvas-shell{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  overflow:visible;
  pointer-events:none;
  opacity:0;
  transition:opacity 180ms ease;
  isolation:isolate;
}

.canvas-shell.visible{opacity:1}

.stage{
  position:absolute;
  inset:0;
  overflow:hidden;
  pointer-events:none;
  z-index:2;
  background:transparent;
}

.canvas-video{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  object-fit:cover;
  object-position:center;
  max-width:none;
  max-height:none;
  border:0;
  margin:0;
  padding:0;
  pointer-events:none;
  user-select:none;
  background:transparent;
  filter:saturate(.90) contrast(1.02) brightness(.78);
  will-change:clip-path,transform,opacity,filter;
}

.current-video{opacity:1}
.incoming-video{opacity:0}

.ambient{
  position:absolute;
  pointer-events:none;
  overflow:hidden;
  z-index:1;
  opacity:0;
}

.ambient-video{
  position:absolute;
  inset:-10%;
  width:120%;
  height:120%;
  object-fit:cover;
  object-position:center;
  filter:blur(34px) saturate(1.2) brightness(.62);
  transform:scale(1.06);
  pointer-events:none;
}

.ambient-left{
  left:-30%;
  top:8%;
  width:62%;
  height:84%;
  opacity:.30;
  -webkit-mask-image:linear-gradient(to right,transparent 0%,rgba(0,0,0,.10) 24%,#000 58%,rgba(0,0,0,.08) 100%);
  mask-image:linear-gradient(to right,transparent 0%,rgba(0,0,0,.10) 24%,#000 58%,rgba(0,0,0,.08) 100%);
  -webkit-mask-repeat:no-repeat;
  mask-repeat:no-repeat;
  -webkit-mask-size:100% 100%;
  mask-size:100% 100%;
}

.ambient-frame{
  inset:-5%;
  opacity:.42;
  clip-path:polygon(
    0 0,100% 0,100% 18%,84% 18%,84% 82%,100% 82%,
    100% 100%,0 100%,0 82%,16% 82%,16% 18%,0 18%
  );
}

.canvas-shell.immersive.visible .ambient-frame{opacity:.46}

@keyframes canvas-star-open{
  0%{
    clip-path:polygon(50% 42%,54% 48%,59% 50%,54% 52%,50% 58%,46% 52%,41% 50%,46% 48%);
    transform:scale(.72);
    opacity:.18;
    filter:blur(7px) saturate(.86) brightness(.70);
  }
  28%{
    clip-path:polygon(50% 23%,65% 45%,77% 50%,65% 55%,50% 77%,35% 55%,23% 50%,35% 45%);
    transform:scale(.94);
    opacity:.62;
    filter:blur(2.5px) saturate(.88) brightness(.74);
  }
  58%{
    clip-path:polygon(0 0,100% 0,100% 28%,100% 72%,100% 100%,0 100%,0 72%,0 28%);
    transform:scale(1.012);
    opacity:.92;
    filter:blur(.6px) saturate(.90) brightness(.77);
  }
  100%{
    clip-path:polygon(0 0,100% 0,100% 28%,100% 72%,100% 100%,0 100%,0 72%,0 28%);
    transform:scale(1);
    opacity:1;
    filter:saturate(.90) contrast(1.02) brightness(.78);
  }
}

@keyframes canvas-switch-in{
  0%{
    clip-path:polygon(50% 44%,54% 48%,57% 50%,54% 52%,50% 56%,46% 52%,43% 50%,46% 48%);
    opacity:0;
    transform:scale(1.045);
    filter:blur(9px) saturate(.86) brightness(.72);
  }
  42%{
    clip-path:polygon(50% 18%,74% 44%,88% 50%,74% 56%,50% 82%,26% 56%,12% 50%,26% 44%);
    opacity:.68;
    transform:scale(1.018);
    filter:blur(3.2px) saturate(.89) brightness(.76);
  }
  100%{
    clip-path:polygon(0 0,100% 0,100% 28%,100% 72%,100% 100%,0 100%,0 72%,0 28%);
    opacity:1;
    transform:scale(1);
    filter:saturate(.90) contrast(1.02) brightness(.78);
  }
}

@keyframes canvas-switch-out{
  0%{opacity:1;transform:scale(1);filter:saturate(.90) contrast(1.02) brightness(.78)}
  55%{opacity:.45;transform:scale(1.018);filter:blur(2.5px) saturate(.88) brightness(.76)}
  100%{opacity:0;transform:scale(1.035);filter:blur(7px) saturate(.84) brightness(.72)}
}

@keyframes canvas-immersive-enter{
  0%{
    clip-path:polygon(50% 42%,54% 48%,59% 50%,54% 52%,50% 58%,46% 52%,41% 50%,46% 48%);
    transform:scale(.28) rotate(720deg);
    opacity:.10;
    filter:blur(10px) saturate(.80) brightness(.66);
  }
  24%{
    clip-path:polygon(50% 25%,66% 45%,78% 50%,66% 55%,50% 75%,34% 55%,22% 50%,34% 45%);
    transform:scale(.54) rotate(420deg);
    opacity:.42;
    filter:blur(5px) saturate(.84) brightness(.70);
  }
  58%{
    clip-path:polygon(0 0,100% 0,100% 28%,100% 72%,100% 100%,0 100%,0 72%,0 28%);
    transform:scale(1.015) rotate(48deg);
    opacity:.90;
    filter:blur(1.3px) saturate(.89) brightness(.76);
  }
  82%{transform:scale(1.004) rotate(8deg)}
  100%{
    clip-path:polygon(0 0,100% 0,100% 28%,100% 72%,100% 100%,0 100%,0 72%,0 28%);
    transform:scale(1) rotate(0deg);
    opacity:1;
    filter:saturate(.90) contrast(1.02) brightness(.78);
  }
}

@keyframes canvas-immersive-exit{
  0%{
    clip-path:polygon(0 0,100% 0,100% 28%,100% 72%,100% 100%,0 100%,0 72%,0 28%);
    transform:scale(1) rotate(0deg);
    opacity:1;
  }
  24%{transform:scale(1.008) rotate(-45deg);filter:blur(1.2px) saturate(.89) brightness(.76)}
  62%{
    clip-path:polygon(50% 25%,66% 45%,78% 50%,66% 55%,50% 75%,34% 55%,22% 50%,34% 45%);
    transform:scale(.56) rotate(-420deg);
    opacity:.48;
    filter:blur(5px) saturate(.84) brightness(.70);
  }
  100%{
    clip-path:polygon(50% 42%,54% 48%,59% 50%,54% 52%,50% 58%,46% 52%,41% 50%,46% 48%);
    transform:scale(.24) rotate(-720deg);
    opacity:0;
    filter:blur(10px) saturate(.80) brightness(.66);
  }
}

@keyframes canvas-leave{
  0%{
    clip-path:polygon(0 0,100% 0,100% 28%,100% 72%,100% 100%,0 100%,0 72%,0 28%);
    opacity:1;
    transform:scale(1);
  }
  100%{
    clip-path:polygon(50% 42%,54% 48%,59% 50%,54% 52%,50% 58%,46% 52%,41% 50%,46% 48%);
    opacity:0;
    transform:scale(.78);
    filter:blur(6px);
  }
}

.canvas-shell.entering .current-video{animation:canvas-star-open 760ms cubic-bezier(.22,.72,.18,1) both}
.canvas-shell.switching .incoming-video{animation:canvas-switch-in 760ms cubic-bezier(.18,.76,.22,1) both;opacity:1}
.canvas-shell.switching .current-video{animation:canvas-switch-out 760ms cubic-bezier(.22,.72,.2,1) both}
.canvas-shell.immersive-enter .current-video{animation:canvas-immersive-enter 900ms cubic-bezier(.16,.76,.2,1) both}
.canvas-shell.immersive-exit .current-video{animation:canvas-immersive-exit 700ms cubic-bezier(.18,.74,.2,1) both}
.canvas-shell.leaving .current-video{animation:canvas-leave 700ms cubic-bezier(.22,.68,.18,1) both}

@media (prefers-reduced-motion: reduce){
  .canvas-shell,.canvas-video,.ambient{animation:none!important;transition:none!important}
  .canvas-video{opacity:1!important;filter:saturate(.90) contrast(1.02) brightness(.78)!important}
  .canvas-shell{opacity:1!important}
}
</style>
