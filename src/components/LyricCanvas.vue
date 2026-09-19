<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { canvasActive, canvasTransitioning, canvasUrl } from "../state";
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
let lastPlaybackTime = 0;
let stalledChecks = 0;
let recoveryCooldownUntil = 0;
let syncRunning = false;
let pendingSync = false;

const currentRenderUrl = ref("");
const incomingRenderUrl = ref("");
const phase = ref<"idle" | "entering" | "switching" | "leaving">("idle");
const reducedMotionQuery = ref<MediaQueryList | null>(null);

const reducedMotion = computed(() => Boolean(reducedMotionQuery.value?.matches));
const canvasOpacity = computed(() =>
  1 - Math.max(0, Math.min(100, Number(cfg.transparency ?? 50))) / 100
);
const renderable = computed(() =>
  Boolean(
    (canvasActive.value || canvasTransitioning.value) &&
    (currentRenderUrl.value || incomingRenderUrl.value)
  )
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

function findPlacementHost() {
  if (cfg.placement === "navigation") return findNavigationHost();
  return findRightLyricsHost();
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

function getPortalZIndex(host: HTMLElement) {
  let node: HTMLElement | null = host;
  let best = 1;

  for (let depth = 0; node && depth < 8; depth++) {
    const z = Number.parseInt(getComputedStyle(node).zIndex, 10);
    if (Number.isFinite(z)) {
      best = Math.max(best, Math.min(z + 1, 9999));
    }
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

async function playVideo(video: HTMLVideoElement | null) {
  if (!video || reducedMotion.value) return;

  try {
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    await video.play();
  } catch {}
}

async function syncVideoElements() {
  await nextTick();
  if (!rootEl) return;

  currentVideoEl = rootEl.querySelector<HTMLVideoElement>(".current-video");
  incomingVideoEl = rootEl.querySelector<HTMLVideoElement>(".incoming-video");

  void playVideo(currentVideoEl);
  void playVideo(incomingVideoEl);
}

function beginCanvasSwitch(url: string) {
  if (!url) return;

  if (!currentRenderUrl.value) {
    currentRenderUrl.value = url;
    incomingRenderUrl.value = "";
    lastRenderedUrl = url;
    void nextTick().then(() => {
      void syncVideoElements();
      setPhase("entering", 820);
    });
    return;
  }

  if (currentRenderUrl.value === url && !incomingRenderUrl.value) return;
  if (incomingRenderUrl.value === url) return;

  clearAnimationTimer();
  incomingRenderUrl.value = url;
  setPhase("switching", 780);

  void nextTick().then(() => {
    void syncVideoElements();

    animationTimer = window.setTimeout(() => {
      if (!incomingRenderUrl.value) return;

      currentRenderUrl.value = incomingRenderUrl.value;
      incomingRenderUrl.value = "";
      lastRenderedUrl = currentRenderUrl.value;
      animationTimer = null;
      phase.value = "idle";

      void nextTick().then(() => {
        void syncVideoElements();
      });
    }, 780);
  });
}

function clearRenderedCanvas() {
  clearAnimationTimer();
  currentRenderUrl.value = "";
  incomingRenderUrl.value = "";
  lastRenderedUrl = "";
  phase.value = "idle";
}

function syncRenderState() {
  if (canvasUrl.value && canvasActive.value) {
    if (canvasUrl.value !== lastRenderedUrl || currentRenderUrl.value !== canvasUrl.value) {
      beginCanvasSwitch(canvasUrl.value);
    }
    return;
  }

  // During lookup/analysis the last rendered Canvas remains untouched.
  if (!canvasUrl.value && !canvasTransitioning.value && !canvasActive.value) {
    clearRenderedCanvas();
  }
}

function scheduleSync(reason: string) {
  if (
    !canvasUrl.value ||
    (!canvasActive.value && !canvasTransitioning.value) ||
    reducedMotion.value ||
    cfg.placement === "immersive"
  ) {
    return;
  }

  pendingSync = true;
  if (animationFrame !== null) return;

  animationFrame = window.requestAnimationFrame(() => {
    animationFrame = null;
    if (!pendingSync) return;
    pendingSync = false;
    void syncToTarget(reason);
  });
}

function ensurePortalRoot() {
  if (!rootEl) {
    rootEl = document.querySelector<HTMLElement>("canvascider-main-canvas");
  }

  if (!rootEl) return false;

  if (rootEl.parentElement !== document.body) {
    document.body.appendChild(rootEl);
  }

  rootEl.style.setProperty("position", "fixed", "important");
  rootEl.style.setProperty("margin", "0", "important");
  rootEl.style.setProperty("padding", "0", "important");
  rootEl.style.setProperty("pointer-events", "none", "important");
  rootEl.style.setProperty("overflow", "visible", "important");
  rootEl.style.setProperty("box-sizing", "border-box", "important");
  rootEl.style.setProperty("min-width", "0", "important");
  rootEl.style.setProperty("min-height", "0", "important");
  rootEl.dataset.canvasPortalOwner = "canvas-for-cider";

  return true;
}

function setPortalRectangle(host: HTMLElement) {
  if (!rootEl) return false;

  const r = host.getBoundingClientRect();
  const visible =
    r.width > 120 &&
    r.height > 100 &&
    r.bottom > 0 &&
    r.right > 0 &&
    r.left < window.innerWidth &&
    r.top < window.innerHeight;

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

  syncNavigationContrast(host);

  const signature = [
    describe(host),
    Math.round(r.left),
    Math.round(r.top),
    Math.round(r.width),
    Math.round(r.height),
    cfg.placement,
  ].join("|");

  if (signature !== lastRectSignature || lastTargetHost !== host) {
    lastRectSignature = signature;
    lastTargetHost = host;

    log("Canvas target synchronized", {
      host: describe(host),
      placement: cfg.placement,
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }

  return true;
}

async function syncToTarget(reason: string) {
  if (syncRunning || reducedMotion.value || !ensurePortalRoot()) return;

  syncRunning = true;

  try {
    syncRenderState();

    if (cfg.placement === "immersive") {
      rootEl.style.setProperty("display", "none", "important");
      return;
    }

    const host = findPlacementHost();

    if (!host || !setPortalRectangle(host)) {
      rootEl.style.setProperty("display", "none", "important");
      return;
    }

    await syncVideoElements();

    if (canvasActive.value) {
      await playVideo(currentVideoEl);
      await playVideo(incomingVideoEl);
    }
  } finally {
    syncRunning = false;
  }

  if (reason) {
    lastNoTargetLogAt = Date.now();
  }
}

function clearLatch() {
  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = null;
}

function startPersistentLatch() {
  clearLatch();

  const tick = () => {
    if (
      !canvasUrl.value ||
      (!canvasActive.value && !canvasTransitioning.value) ||
      reducedMotion.value ||
      cfg.placement === "immersive"
    ) {
      return;
    }

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
    if (cfg.placement === "immersive") {
      if (!url && !active && !transitioning) clearRenderedCanvas();
      return;
    }

    if (url && active) {
      if (url !== oldUrl || (!oldActive && active)) {
        beginCanvasSwitch(url);
      }
      startPersistentLatch();
      scheduleSync("Canvas state changed");
      return;
    }

    if (url && transitioning) {
      startPersistentLatch();
      scheduleSync("Canvas replacement pending");
      return;
    }

    if (!active && !transitioning && !url) {
      clearLatch();
      clearRenderedCanvas();
      if (rootEl) rootEl.style.setProperty("display", "none", "important");
    }
  },
  { flush: "post" }
);

watch(
  () => cfg.placement,
  (next, previous) => {
    if (next === previous) return;

    clearAnimationTimer();
    phase.value = "idle";
    lastRenderedPlacement = next;

    if (rootEl) {
      rootEl.style.setProperty("display", "none", "important");
    }

    if (next === "immersive") {
      clearLatch();
      return;
    }

    if (canvasUrl.value && (canvasActive.value || canvasTransitioning.value)) {
      startPersistentLatch();
      scheduleSync("Canvas placement changed");
    }
  }
);

onMounted(() => {
  reducedMotionQuery.value = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotionQuery.value.addEventListener?.("change", handleMotionChange);

  observer = new MutationObserver(() => {
    if (
      !canvasUrl.value ||
      (!canvasActive.value && !canvasTransitioning.value) ||
      reducedMotion.value ||
      cfg.placement === "immersive"
    ) {
      return;
    }

    scheduleSync("Cider DOM changed");
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  resizeObserver = new ResizeObserver(() => {
    if (
      !canvasUrl.value ||
      (!canvasActive.value && !canvasTransitioning.value) ||
      reducedMotion.value ||
      cfg.placement === "immersive"
    ) {
      return;
    }

    scheduleSync("Canvas target resized");
  });

  const viewport = document.querySelector<HTMLElement>("#app-viewport");
  if (viewport) resizeObserver.observe(viewport);

  window.addEventListener("resize", () => scheduleSync("window resized"));
  window.addEventListener("scroll", () => scheduleSync("window scrolled"), true);

  playbackWatchdog = window.setInterval(() => {
    if (
      !canvasUrl.value ||
      (!canvasActive.value && !canvasTransitioning.value) ||
      reducedMotion.value ||
      cfg.placement === "immersive"
    ) {
      return;
    }

    scheduleSync("Canvas watchdog");
    void syncVideoElements();

    const video = currentVideoEl;
    if (!video) return;

    void playVideo(video);

    const now = Date.now();

    if (!video.paused && !video.ended) {
      if (Math.abs(video.currentTime - lastPlaybackTime) < 0.01) {
        stalledChecks++;
      } else {
        stalledChecks = 0;
      }

      lastPlaybackTime = video.currentTime;

      if (stalledChecks >= 2 && now >= recoveryCooldownUntil) {
        stalledChecks = 0;
        recoveryCooldownUntil = now + 5000;
        void playVideo(video);
      }
    } else {
      stalledChecks = 0;
    }
  }, 1000);

  if (
    canvasUrl.value &&
    (canvasActive.value || canvasTransitioning.value) &&
    !reducedMotion.value &&
    cfg.placement !== "immersive"
  ) {
    beginCanvasSwitch(canvasUrl.value);
    startPersistentLatch();
    scheduleSync("initial mount");
  }
});

onUnmounted(() => {
  clearLatch();
  clearAnimationTimer();

  if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
  observer?.disconnect();
  resizeObserver?.disconnect();

  if (playbackWatchdog !== null) window.clearInterval(playbackWatchdog);

  reducedMotionQuery.value?.removeEventListener?.("change", handleMotionChange);

  document.querySelectorAll<HTMLElement>(".canvascider-navigation-contrast").forEach(el => {
    el.classList.remove("canvascider-navigation-contrast");
  });

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
    :style="{ opacity: renderable ? canvasOpacity : 0 }"
    aria-hidden="true"
  >
    <!-- Lyrics ambience is a separate blurred copy that lives strictly to the
         LEFT of the Canvas rectangle. The main Canvas is never blended. -->
    <div v-if="cfg.placement === 'lyrics'" class="ambient-left">
      <video
        class="ambient-video"
        :src="currentRenderUrl || undefined"
        muted
        loop
        playsinline
        preload="auto"
        :autoplay="!reducedMotion"
      ></video>
    </div>

    <div class="stage">
      <div v-if="currentRenderUrl" class="canvas-frame current-frame">
        <video
          class="canvas-video current-video"
          :src="currentRenderUrl"
          muted
          loop
          playsinline
          preload="auto"
          :autoplay="!reducedMotion"
        ></video>
      </div>

      <div v-if="incomingRenderUrl" class="canvas-frame incoming-frame">
        <video
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
  isolation:isolate;
}

.stage{
  position:absolute;
  inset:0;
  overflow:hidden;
  pointer-events:none;
}

.canvas-frame{
  position:absolute;
  inset:0;
  overflow:hidden;
  pointer-events:none;
  background:transparent;
}

.canvas-video{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  display:block;
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
}

.current-frame{z-index:2}
.incoming-frame{z-index:3}
.current-video{opacity:1}
.incoming-video{opacity:1}

.ambient-left{
  position:absolute;
  right:100%;
  top:4%;
  width:58%;
  height:92%;
  overflow:hidden;
  pointer-events:none;
  z-index:1;
  opacity:.28;
  -webkit-mask-image:linear-gradient(
    to right,
    transparent 0%,
    rgba(0,0,0,.06) 18%,
    rgba(0,0,0,.36) 58%,
    #000 92%,
    transparent 100%
  );
  mask-image:linear-gradient(
    to right,
    transparent 0%,
    rgba(0,0,0,.06) 18%,
    rgba(0,0,0,.36) 58%,
    #000 92%,
    transparent 100%
  );
}

.ambient-video{
  position:absolute;
  inset:-14%;
  width:128%;
  height:128%;
  object-fit:cover;
  object-position:center;
  filter:blur(42px) saturate(1.20) brightness(.60);
  transform:scale(1.08);
  pointer-events:none;
}

@keyframes canvas-star-open{
  0%{
    clip-path:polygon(
      50% 42%,52% 49%,75% 50%,52% 51%,
      50% 58%,48% 51%,25% 50%,48% 49%
    );
    opacity:0;
  }
  28%{
    clip-path:polygon(
      50% 24%,54% 47%,78% 50%,54% 53%,
      50% 76%,46% 53%,22% 50%,46% 47%
    );
    opacity:.48;
  }
  58%{
    clip-path:polygon(
      50% 4%,55% 45%,96% 50%,55% 55%,
      50% 96%,45% 55%,4% 50%,45% 45%
    );
    opacity:.90;
  }
  100%{
    clip-path:inset(0 0 0 0 round 0);
    opacity:1;
  }
}

@keyframes canvas-switch-in{
  0%{
    clip-path:polygon(
      50% 42%,52% 49%,75% 50%,52% 51%,
      50% 58%,48% 51%,25% 50%,48% 49%
    );
    opacity:0;
  }
  38%{
    clip-path:polygon(
      50% 21%,54% 46%,82% 50%,54% 54%,
      50% 79%,46% 54%,18% 50%,46% 46%
    );
    opacity:.56;
  }
  100%{
    clip-path:inset(0 0 0 0 round 0);
    opacity:1;
  }
}

@keyframes canvas-switch-out{
  0%{opacity:1;filter:saturate(.90) contrast(1.02) brightness(.78)}
  55%{opacity:.42;filter:blur(2px) saturate(.88) brightness(.75)}
  100%{opacity:0;filter:blur(6px) saturate(.84) brightness(.70)}
}

@keyframes canvas-leave{
  0%{
    clip-path:inset(0 0 0 0 round 0);
    opacity:1;
  }
  100%{
    clip-path:polygon(
      50% 42%,52% 49%,75% 50%,52% 51%,
      50% 58%,48% 51%,25% 50%,48% 49%
    );
    opacity:0;
  }
}

.canvas-shell.entering .current-video{
  animation:canvas-star-open 820ms cubic-bezier(.16,.76,.18,1) both;
}

.canvas-shell.switching .incoming-video{
  animation:canvas-switch-in 780ms cubic-bezier(.18,.78,.20,1) both;
}

.canvas-shell.switching .current-video{
  animation:canvas-switch-out 780ms cubic-bezier(.20,.72,.18,1) both;
}

.canvas-shell.leaving .current-video{
  animation:canvas-leave 700ms cubic-bezier(.20,.72,.18,1) both;
}

@media (prefers-reduced-motion:reduce){
  .canvas-shell,.canvas-video,.ambient-left{animation:none!important;transition:none!important}
  .canvas-video{opacity:1!important;filter:saturate(.90) contrast(1.02) brightness(.78)!important}
}
</style>
