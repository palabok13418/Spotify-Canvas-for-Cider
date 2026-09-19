<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { canvasActive, canvasTransitioning, canvasUrl } from "../state";
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
let currentVideoEl: HTMLVideoElement | null = null;
let incomingVideoEl: HTMLVideoElement | null = null;
let animationTimer: number | null = null;
let immersiveOpenByEvent = false;
let activeImmersiveTarget = false;
let lastRenderedUrl = "";
let lastRenderedPlacement = cfg.placement;
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


const currentRenderUrl = ref("");
const incomingRenderUrl = ref("");
const phase = ref<"idle" | "entering" | "switching" | "immersive-enter" | "immersive-exit" | "leaving">("idle");
const reducedMotionQuery = ref<MediaQueryList | null>(null);

const renderable = computed(() =>
  Boolean((canvasActive.value || canvasTransitioning.value) &&
    (currentRenderUrl.value || incomingRenderUrl.value))
);

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

function startInitialAnimation() {
  return nextTick().then(() => {
    syncVideoRefs();
    void safePlay(currentVideoEl);
    if (cfg.placement === "immersive") setPhase("immersive-enter", 900);
    else setPhase("entering", 760);
  });
}

function setRenderSource(url: string) {
  if (!url) return;
  if (!currentRenderUrl.value) {
    currentRenderUrl.value = url;
    incomingRenderUrl.value = "";
    lastRenderedUrl = url;
    void startInitialAnimation();
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

function clearRenderedCanvas() {
  clearAnimationTimer();
  currentRenderUrl.value = "";
  incomingRenderUrl.value = "";
  lastRenderedUrl = "";
  phase.value = "idle";
}

function startLeavingAnimation() {
  if (!currentRenderUrl.value) return;
  setPhase(cfg.placement === "immersive" ? "immersive-exit" : "leaving", 700);
}

function syncRenderState() {
  if (canvasUrl.value && canvasActive.value) {
    if (canvasUrl.value !== lastRenderedUrl || currentRenderUrl.value !== canvasUrl.value) {
      setRenderSource(canvasUrl.value);
    }
  } else if (canvasUrl.value && canvasTransitioning.value) {
    startLeavingAnimation();
  }
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

function immersiveStyleIsOne(host: HTMLElement | null) {
  if (!host) return false;
  const configured = readImmersiveStyleFromConfig();
  if (configured !== null) return configured;

  const selectors = [
    "[data-immersive-style]",
    "[data-style]",
    "[data-layout]",
    "[data-layout-name]",
    "[aria-label]",
    "[title]",
  ];
  let foundOne = false;
  for (const selector of selectors) {
    for (const el of host.querySelectorAll<HTMLElement>(selector)) {
      const values = [
        el.getAttribute("data-immersive-style"),
        el.getAttribute("data-style"),
        el.getAttribute("data-layout"),
        el.getAttribute("data-layout-name"),
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
      ].filter(Boolean);
      for (const value of values) {
        const mode = normalizeImmersiveMode(value);
        if (mode === "one" || /immersiveone/.test(mode)) foundOne = true;
      }
    }
  }

  const own = [
    host.id,
    typeof host.className === "string" ? host.className : "",
    host.getAttribute("data-immersive-style"),
    host.getAttribute("data-style"),
    host.getAttribute("data-layout"),
  ].filter(Boolean).join(" ").split(/[\s_-]+/).map(normalizeImmersiveMode);

  return foundOne || own.includes("one") || own.includes("immersiveone");
}

function findImmersiveHost(): HTMLElement | null {
  const selectors = [
    '[data-immersive="true"]',
    '[data-mode="immersive"]',
    '[data-view="immersive"]',
    '[sfc-name*="immersive" i]',
    '[data-testid*="immersive" i]',
    '[class*="immersive" i]',
    '[id*="immersive" i]',
    ".fullscreen-view-container",
  ];
  const candidates = new Set<HTMLElement>();
  for (const selector of selectors) {
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
    const areaRatio = (Math.max(0, r.width) * Math.max(0, r.height)) / (vw * vh);
    const name = [
      el.id,
      typeof el.className === "string" ? el.className : "",
      el.getAttribute("sfc-name"),
      el.getAttribute("data-testid"),
      el.getAttribute("data-mode"),
      el.getAttribute("data-view"),
    ].filter(Boolean).join(" ").toLowerCase();
    const exact = /(^|[\s_-])immersive($|[\s_-])/.test(name) ? 5000 : 0;
    const full = Math.abs(r.width - vw) < vw * .08 && Math.abs(r.height - vh) < vh * .08 ? 2200 : 0;
    const score = areaRatio * 1000 + exact + full;
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
  if (!rootEl) rootEl = document.querySelector<HTMLElement>("canvascider-main-canvas");
  if (!rootEl) return false;
  if (rootEl.parentElement !== document.body) document.body.appendChild(rootEl);

  rootEl.style.setProperty("position", "fixed", "important");
  rootEl.style.setProperty("margin", "0", "important");
  rootEl.style.setProperty("padding", "0", "important");
  rootEl.style.setProperty("pointer-events", "none", "important");
  rootEl.style.setProperty("overflow", "visible", "important");
  rootEl.style.setProperty("display", "none", "important");
  rootEl.style.setProperty("box-sizing", "border-box", "important");
  rootEl.style.setProperty("min-width", "0", "important");
  rootEl.style.setProperty("min-height", "0", "important");
  rootEl.dataset.canvasPortalOwner = "canvas-for-cider";
  syncVideoRefs();
  return true;
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
    else if (cfg.placement === "immersive") setPhase("immersive-exit", 700);
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
      left: Math.round(r.left),
      top: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }

  return true;
}

async function syncToLyricsTarget(reason: string) {
  if (syncRunning || reducedMotion.value || !ensurePortalRoot()) return;
  syncRunning = true;

  try {
    syncVideoRefs();
    syncRenderState();

    const hostInfo = cfg.placement === "immersive"
      ? { host: findImmersiveHost(), immersive: true }
      : cfg.placement === "navigation"
        ? { host: findNavigationHost(), immersive: false }
        : { host: findRightLyricsHost(), immersive: false };

    let host = hostInfo.host;
    let immersive = hostInfo.immersive;

    if (cfg.placement === "immersive") {
      immersive = Boolean(
        host &&
        immersiveIsOpen(host) &&
        immersiveStyleIsOne(host)
      );
      if (!immersive) host = null;
    }

    if (!host) {
      rootEl!.style.setProperty("display", "none", "important");
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
  reducedMotionQuery.value?.removeEventListener?.("change", handleMotionChange);
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
  -webkit-mask-image:linear-gradient(to right,transparent 0%,rgba(0,0,0,.12) 24%,#000 58%,rgba(0,0,0,.10) 100%);
  mask-image:linear-gradient(to right,transparent 0%,rgba(0,0,0,.12) 24%,#000 58%,rgba(0,0,0,.10) 100%);
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
