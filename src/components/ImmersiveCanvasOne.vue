<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { canvasActive, canvasTransitioning, canvasUrl } from "../state";
import { useConfig } from "../config";
import { subscribeEvent } from "../cider";

const cfg = useConfig();

const root = ref<HTMLElement | null>(null);
const currentUrl = ref("");
const incomingUrl = ref("");
const phase = ref<"idle" | "entering" | "switching" | "exiting">("idle");
const reducedMotionQuery = ref<MediaQueryList | null>(null);

let animationTimer: number | null = null;
let watchdog: number | null = null;
let eventCleanup: Array<() => void> = [];

const reducedMotion = computed(() => Boolean(reducedMotionQuery.value?.matches));
const visible = computed(() =>
  Boolean(
    (canvasActive.value || canvasTransitioning.value) &&
    (currentUrl.value || incomingUrl.value)
  )
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

async function play(video: HTMLVideoElement | null) {
  if (!video || reducedMotion.value) return;

  try {
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    await video.play();
  } catch {}
}

async function syncVideos() {
  await nextTick();

  const current = root.value?.querySelector<HTMLVideoElement>(".current-video") || null;
  const incoming = root.value?.querySelector<HTMLVideoElement>(".incoming-video") || null;

  void play(current);
  void play(incoming);
}

function setUrl(url: string) {
  if (!url) return;

  if (!currentUrl.value) {
    currentUrl.value = url;
    incomingUrl.value = "";
    setPhase("entering", 900);
    void syncVideos();
    return;
  }

  if (url === currentUrl.value && !incomingUrl.value) return;
  if (url === incomingUrl.value) return;

  incomingUrl.value = url;
  setPhase("switching", 760);
  void syncVideos();

  clearAnimationTimer();
  animationTimer = window.setTimeout(() => {
    if (!incomingUrl.value) return;

    currentUrl.value = incomingUrl.value;
    incomingUrl.value = "";
    animationTimer = null;
    phase.value = "idle";

    void syncVideos();
  }, 760);
}

watch(
  [canvasUrl, canvasActive, canvasTransitioning],
  ([url, active, transitioning]) => {
    if (url && (active || transitioning)) {
      setUrl(url);
      return;
    }

    if (!url && !active && !transitioning) {
      clearAnimationTimer();
      currentUrl.value = "";
      incomingUrl.value = "";
      phase.value = "idle";
    }
  },
  { flush: "post" }
);

onMounted(() => {
  reducedMotionQuery.value = window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotionQuery.value.addEventListener?.("change", () => {
    if (reducedMotion.value) {
      clearAnimationTimer();
      phase.value = "idle";
    }
  });

  eventCleanup = [
    subscribeEvent("immersive:opened", () => {
      if (canvasUrl.value && canvasActive.value) {
        setPhase("entering", 900);
        void syncVideos();
      }
    }),
    subscribeEvent("immersive:closed", () => {
      if (currentUrl.value) {
        setPhase("exiting", 720);
      }
    }),
  ];

  if (canvasUrl.value && canvasActive.value && !reducedMotion.value) {
    setUrl(canvasUrl.value);
  }

  watchdog = window.setInterval(() => {
    if (!visible.value) return;
    void syncVideos();
  }, 1200);
});

onUnmounted(() => {
  clearAnimationTimer();
  if (watchdog !== null) window.clearInterval(watchdog);
  eventCleanup.forEach(fn => fn());
  eventCleanup = [];
  reducedMotionQuery.value = null;
});
</script>

<template>
  <div
    ref="root"
    class="one-layout"
    :class="[phase, { visible }]"
    :style="{
      opacity: visible
        ? (1 - Math.max(0, Math.min(100, Number(cfg.transparency ?? 50))) / 100)
        : 0
    }"
  >
    <div class="background">
      <div v-if="currentUrl" class="video-shell current-shell">
        <video
          class="background-video current-video"
          :src="currentUrl"
          muted
          loop
          playsinline
          preload="auto"
          :autoplay="!reducedMotion"
        ></video>
      </div>

      <div v-if="incomingUrl" class="video-shell incoming-shell">
        <video
          class="background-video incoming-video"
          :src="incomingUrl"
          muted
          loop
          playsinline
          preload="auto"
          :autoplay="!reducedMotion"
        ></video>
      </div>
    </div>

    <div class="background-vignette"></div>
  </div>
</template>

<style scoped>
.one-layout{
  position:fixed;
  inset:0;
  width:100vw;
  height:100vh;
  min-width:0;
  min-height:0;
  overflow:hidden;
  background:transparent;
  pointer-events:none;
  z-index:0;
}

.background{
  position:absolute;
  inset:0;
  overflow:hidden;
  background:#000;
}

.video-shell{
  position:absolute;
  inset:0;
  overflow:hidden;
}

.current-shell{z-index:1}
.incoming-shell{z-index:2}

.background-video{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  display:block;
  object-fit:cover;
  pointer-events:none;
  background:#000;
  filter:saturate(.96) contrast(1.03) brightness(.72);
  will-change:opacity,filter,transform;
}

.background-vignette{
  position:absolute;
  inset:0;
  z-index:4;
  pointer-events:none;
  background:
    radial-gradient(circle at center,transparent 34%,rgba(0,0,0,.13) 72%,rgba(0,0,0,.38) 100%),
    linear-gradient(to bottom,rgba(0,0,0,.16),transparent 22%,transparent 78%,rgba(0,0,0,.22));
}

@keyframes one-enter{
  from{opacity:0;transform:scale(1.035);filter:blur(8px) saturate(.86) brightness(.58)}
  to{opacity:1;transform:scale(1);filter:blur(0) saturate(.96) brightness(.72)}
}

@keyframes one-incoming{
  from{opacity:0;transform:scale(1.025);filter:blur(6px) brightness(.62)}
  to{opacity:1;transform:scale(1);filter:blur(0) brightness(.72)}
}

@keyframes one-outgoing{
  from{opacity:1;transform:scale(1);filter:blur(0) brightness(.72)}
  to{opacity:0;transform:scale(1.015);filter:blur(6px) brightness(.56)}
}

@keyframes one-exit{
  from{opacity:1;transform:scale(1)}
  to{opacity:0;transform:scale(1.02)}
}

.one-layout.entering .current-video{
  animation:one-enter 900ms cubic-bezier(.18,.78,.2,1) both;
}

.one-layout.switching .incoming-video{
  animation:one-incoming 760ms cubic-bezier(.18,.78,.2,1) both;
}

.one-layout.switching .current-video{
  animation:one-outgoing 760ms cubic-bezier(.18,.72,.2,1) both;
}

.one-layout.exiting .current-video{
  animation:one-exit 720ms cubic-bezier(.2,.75,.2,1) both;
}

@media(prefers-reduced-motion:reduce){
  .one-layout,.current-video,.incoming-video{animation:none!important}
  .current-video,.incoming-video{opacity:1!important;transform:none!important;filter:none!important}
}
</style>
