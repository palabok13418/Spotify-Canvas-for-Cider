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
        <div v-if="currentUrl" class="video-shell current-shell">
          <video
            class="current-video"
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
}

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
    linear-gradient(to right,rgba(0,0,0,.18),transparent 24%,transparent 76%,rgba(0,0,0,.18)),
    linear-gradient(to bottom,rgba(0,0,0,.18),transparent 24%,transparent 76%,rgba(0,0,0,.18));
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
}

.canvas-stage{
  position:absolute;
  inset:0;
  overflow:visible;
  border-radius:inherit;
}

.video-shell{
  position:absolute;
  inset:0;
  overflow:hidden;
  border-radius:inherit;
  isolation:isolate;
}

.current-shell{z-index:2}
.incoming-shell{z-index:3}

.current-video,
.incoming-video{
  position:absolute;
  inset:0;
  width:100%;
  height:100%;
  display:block;
  object-fit:cover;
  border-radius:inherit;
  pointer-events:none;
  background:transparent;
  filter:saturate(.96) contrast(1.02) brightness(.86);
  will-change:clip-path,opacity,filter,transform;
}

.current-video,
.incoming-video{
  opacity:1;
}

.canvas-frame::before{
  content:"";
  position:absolute;
  inset:-16% -20%;
  border-radius:42px;
  pointer-events:none;
  z-index:1;
  background:
    radial-gradient(ellipse at center,rgba(255,255,255,.05),transparent 56%),
    linear-gradient(to right,transparent 0%,rgba(0,0,0,.22) 18%,transparent 32%,transparent 68%,rgba(0,0,0,.22) 82%,transparent 100%),
    linear-gradient(to bottom,transparent 0%,rgba(0,0,0,.22) 18%,transparent 32%,transparent 68%,rgba(0,0,0,.22) 82%,transparent 100%);
  filter:blur(24px);
  mix-blend-mode:multiply;
  opacity:.9;
}

@keyframes one-star-open{
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
    opacity:.50;
  }
  60%{
    clip-path:polygon(
      50% 4%,55% 45%,96% 50%,55% 55%,
      50% 96%,45% 55%,4% 50%,45% 45%
    );
    opacity:.92;
  }
  100%{
    clip-path:inset(0 0 0 0 round 28px);
    opacity:1;
  }
}

@keyframes one-switch-in{
  0%{
    clip-path:polygon(
      50% 42%,52% 49%,75% 50%,52% 51%,
      50% 58%,48% 51%,25% 50%,48% 49%
    );
    opacity:0;
  }
  40%{
    clip-path:polygon(
      50% 22%,54% 46%,82% 50%,54% 54%,
      50% 78%,46% 54%,18% 50%,46% 46%
    );
    opacity:.56;
  }
  100%{
    clip-path:inset(0 0 0 0 round 28px);
    opacity:1;
  }
}

@keyframes one-switch-out{
  0%{opacity:1}
  50%{opacity:.42;filter:blur(2px) saturate(.90) brightness(.78)}
  100%{opacity:0;filter:blur(7px) saturate(.84) brightness(.72)}
}

@keyframes one-exit{
  0%{
    clip-path:inset(0 0 0 0 round 28px);
    transform:rotate(0deg);
    opacity:1;
  }
  36%{
    clip-path:polygon(
      50% 24%,54% 47%,78% 50%,54% 53%,
      50% 76%,46% 53%,22% 50%,46% 47%
    );
    transform:rotate(-360deg);
    opacity:.68;
  }
  72%{
    clip-path:polygon(
      50% 40%,53% 48%,62% 50%,53% 52%,
      50% 60%,47% 52%,38% 50%,47% 48%
    );
    transform:rotate(-620deg);
    opacity:.28;
  }
  100%{
    clip-path:polygon(
      50% 44%,52% 49%,57% 50%,52% 51%,
      50% 56%,48% 51%,43% 50%,48% 49%
    );
    transform:rotate(-720deg) scale(.24);
    opacity:0;
    filter:blur(9px) saturate(.82) brightness(.70);
  }
}

.one-layout.entering .current-video{
  animation:one-star-open 900ms cubic-bezier(.16,.76,.18,1) both;
}

.one-layout.switching .incoming-video{
  animation:one-switch-in 760ms cubic-bezier(.18,.78,.20,1) both;
}

.one-layout.switching .current-video{
  animation:one-switch-out 760ms cubic-bezier(.20,.72,.18,1) both;
}

.one-layout.exiting .current-video{
  animation:one-exit 720ms cubic-bezier(.18,.74,.18,1) both;
}

@media (max-width:900px){
  .canvas-frame{
    width:min(56vw,420px);
    height:min(76vh,746px);
    max-width:66%;
  }
}

@media (prefers-reduced-motion:reduce){
  .one-layout,.current-video,.incoming-video{animation:none!important}
  .current-video,.incoming-video{opacity:1!important}
}
</style>
