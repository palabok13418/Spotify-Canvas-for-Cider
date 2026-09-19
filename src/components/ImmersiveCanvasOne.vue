<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { canvasActive, canvasTransitioning, canvasUrl } from "../state";
import { useConfig } from "../config";

const cfg = useConfig();

const root = ref<HTMLElement | null>(null);
const currentUrl = ref("");
const incomingUrl = ref("");
const phase = ref<"idle" | "entering" | "switching">("idle");

let animationTimer: number | null = null;
let watchdog: number | null = null;


const reducedMotionQuery = ref<MediaQueryList | null>(null);
const reducedMotion = computed(() => Boolean(reducedMotionQuery.value?.matches));
const visible = computed(() =>
  Boolean((canvasActive.value || canvasTransitioning.value) &&
    (currentUrl.value || incomingUrl.value))
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

  incomingUrl.value = url;
  setPhase("switching", 760);
  void syncVideos();

  clearAnimationTimer();
  animationTimer = window.setTimeout(() => {
    currentUrl.value = incomingUrl.value;
    incomingUrl.value = "";
    animationTimer = null;
    phase.value = "idle";
    void syncVideos();
  }, 760);
}

watch(
  [canvasUrl, canvasActive],
  ([url, active]) => {
    if (url && active) {
      setUrl(url);
      return;
    }
    if (!active && !canvasTransitioning.value && !url) {
      currentUrl.value = "";
      incomingUrl.value = "";
      lastUrl = "";
      phase.value = "idle";
    }
  },
  { flush: "post" },
);

onMounted(() => {
  reducedMotionQuery.value = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (canvasUrl.value && canvasActive.value && !reducedMotion.value) {
    setUrl(canvasUrl.value);
  }

  watchdog = window.setInterval(() => {
    if (!visible.value) return;
    syncVideos();
  }, 1200);
});

onUnmounted(() => {
  clearAnimationTimer();
  if (watchdog !== null) window.clearInterval(watchdog);
  reducedMotionQuery.value = null;
});
</script>

<template>
  <div ref="root" class="one-layout" :class="[phase, { visible }]" :style="{ opacity: visible ? (1 - Math.max(0, Math.min(100, Number(cfg.transparency ?? 50))) / 100) : 0 }">
    <div class="background">
      <video
        v-if="currentUrl"
        class="background-video"
        :src="currentUrl"
        muted
        loop
        playsinline
        preload="auto"
        :autoplay="!reducedMotion"
      ></video>
    </div>

    <div class="canvas-backdrop"></div>

    <div class="canvas-frame">
      <div class="canvas-stage">
        <video
          v-if="currentUrl"
          class="current-video"
          :src="currentUrl"
          muted
          loop
          playsinline
          preload="auto"
          :autoplay="!reducedMotion"
        ></video>

        <video
          v-if="incomingUrl"
          class="incoming-video"
          :src="incomingUrl"
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

<style scoped>
.one-layout{
  position:relative;
  width:100%;
  height:100%;
  min-width:0;
  min-height:0;
  overflow:hidden;
  background:transparent;
  pointer-events:none;
  opacity:0;
  transition:opacity .2s ease;
}

.one-layout.visible{opacity:1}

.background{
  position:absolute;
  inset:0;
  overflow:hidden;
}

.background-video{
  position:absolute;
  inset:-8%;
  width:116%;
  height:116%;
  object-fit:cover;
  filter:blur(42px) saturate(1.18) brightness(.55);
  transform:scale(1.06);
  opacity:.72;
}

.canvas-backdrop{
  position:absolute;
  inset:0;
  background:
    radial-gradient(ellipse at center,rgba(255,255,255,.05),transparent 46%),
    linear-gradient(to right,rgba(0,0,0,.20),transparent 22%,transparent 78%,rgba(0,0,0,.20)),
    linear-gradient(to bottom,rgba(0,0,0,.22),transparent 22%,transparent 78%,rgba(0,0,0,.22));
}

.canvas-frame{
  position:absolute;
  left:50%;
  top:50%;
  width:min(42vw,420px);
  height:min(78vh,746px);
  max-height:88%;
  max-width:48%;
  transform:translate(-50%,-50%);
  overflow:visible;
  border-radius:28px;
  box-shadow:0 28px 90px rgba(0,0,0,.45);
}

.canvas-stage{
  position:absolute;
  inset:0;
  overflow:hidden;
  border-radius:inherit;
  isolation:isolate;
}

.current-video,
.incoming-video{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  object-fit:cover;
  display:block;
  border-radius:inherit;
  pointer-events:none;
  background:transparent;
  filter:saturate(.96) contrast(1.02) brightness(.86);
  will-change:clip-path,transform,opacity,filter;
}

.current-video{opacity:1}
.incoming-video{opacity:0}

.canvas-frame::before,
.canvas-frame::after{
  content:"";
  position:absolute;
  pointer-events:none;
  z-index:4;
}

.canvas-frame::before{
  inset:-16% -20%;
  border-radius:36px;
  background:
    linear-gradient(to bottom,rgba(0,0,0,.25),transparent 20%,transparent 80%,rgba(0,0,0,.25)),
    linear-gradient(to right,rgba(0,0,0,.24),transparent 18%,transparent 82%,rgba(0,0,0,.24));
  filter:blur(22px);
  opacity:.78;
  mix-blend-mode:multiply;
}

.canvas-frame::after{
  inset:-2px;
  border-radius:30px;
  box-shadow:
    inset 0 0 38px rgba(0,0,0,.26),
    inset 0 0 18px rgba(255,255,255,.04);
}

@keyframes one-star-open{
  0%{
    clip-path:polygon(50% 42%,52% 49%,75% 50%,52% 51%,50% 58%,48% 51%,25% 50%,48% 49%);
    transform:scale(.28) rotate(720deg);
    opacity:0;
    filter:blur(9px) saturate(.84) brightness(.72);
  }
  22%{
    clip-path:polygon(50% 20%,54% 46%,80% 50%,54% 54%,50% 80%,46% 54%,20% 50%,46% 46%);
    transform:scale(.56) rotate(390deg);
    opacity:.34;
    filter:blur(4px) saturate(.90) brightness(.78);
  }
  55%{
    clip-path:polygon(50% 4%,55% 45%,96% 50%,55% 55%,50% 96%,45% 55%,4% 50%,45% 45%);
    transform:scale(.86) rotate(70deg);
    opacity:.82;
    filter:blur(1px) saturate(.94) brightness(.83);
  }
  80%{
    clip-path:inset(0 0 0 0 round 28px);
    transform:scale(1.01) rotate(8deg);
    opacity:.98;
  }
  100%{
    clip-path:inset(0 0 0 0 round 28px);
    transform:scale(1) rotate(0);
    opacity:1;
    filter:saturate(.96) contrast(1.02) brightness(.86);
  }
}

@keyframes one-switch-in{
  0%{
    clip-path:polygon(50% 42%,52% 49%,75% 50%,52% 51%,50% 58%,48% 51%,25% 50%,48% 49%);
    transform:scale(.92);
    opacity:0;
    filter:blur(8px) saturate(.84) brightness(.72);
  }
  45%{
    clip-path:polygon(50% 20%,54% 46%,80% 50%,54% 54%,50% 80%,46% 54%,20% 50%,46% 46%);
    transform:scale(1.012);
    opacity:.70;
    filter:blur(3px) saturate(.90) brightness(.78);
  }
  100%{
    clip-path:inset(0 0 0 0 round 28px);
    transform:scale(1);
    opacity:1;
    filter:saturate(.96) contrast(1.02) brightness(.86);
  }
}

@keyframes one-switch-out{
  0%{opacity:1;transform:scale(1);filter:saturate(.96) contrast(1.02) brightness(.86)}
  50%{opacity:.42;transform:scale(1.02);filter:blur(2px) saturate(.90) brightness(.78)}
  100%{opacity:0;transform:scale(1.035);filter:blur(7px) saturate(.84) brightness(.72)}
}

.one-layout.entering .current-video{
  animation:one-star-open 900ms cubic-bezier(.16,.76,.18,1) both;
}

.one-layout.switching .incoming-video{
  animation:one-switch-in 760ms cubic-bezier(.18,.76,.20,1) both;
  opacity:1;
}

.one-layout.switching .current-video{
  animation:one-switch-out 760ms cubic-bezier(.20,.72,.18,1) both;
}

@media (max-width:900px){
  .canvas-frame{
    width:min(56vw,420px);
    height:min(76vh,746px);
    max-width:66%;
  }
}

@media (prefers-reduced-motion:reduce){
  .one-layout,.current-video,.incoming-video{animation:none!important;transition:none!important}
  .current-video{opacity:1!important}
  .incoming-video{opacity:1!important}
}
</style>
