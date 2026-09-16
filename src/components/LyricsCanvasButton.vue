<script setup lang="ts">
import { onMounted, onUnmounted, ref, nextTick, watch } from "vue";
import QuickSettings from "./QuickSettings.vue";
import iconSvg from "../assets/logo.svg?raw";

const PREFIX = "[Canvas for Cider]";
const open = ref(false);

let observer: MutationObserver | null = null;
let button: HTMLButtonElement | null = null;
let frame: number | null = null;
let removeDismiss: (() => void) | null = null;

const LYRIC_BUTTON_SELECTORS = [
  'button[data-testid="lyrics-button"]',
  '[data-testid="lyrics-button"] button',
  'button[aria-label="Lyrics"]',
  '[aria-label="Lyrics"] button',
  'button[title="Lyrics"]',
];

function visible(el: HTMLElement) {
  const style = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && r.width > 0 && r.height > 0;
}

function findLyricsButton(): HTMLButtonElement | null {
  for (const selector of LYRIC_BUTTON_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (el instanceof HTMLButtonElement && visible(el)) return el;
    }
  }
  return null;
}

function applyNativeButtonShape(lyrics: HTMLButtonElement) {
  if (!button) return;
  button.className = lyrics.className;
  button.style.cssText = [
    "position:relative",
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "overflow:hidden",
  ].join(";");
}

function ensureButton() {
  const lyrics = findLyricsButton();
  if (!lyrics || !lyrics.parentElement) return;

  if (button && (!button.isConnected || button.parentElement !== lyrics.parentElement)) {
    button.remove();
    button = null;
  }

  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.dataset.canvasCiderButton = "true";
    button.setAttribute("aria-label", "Canvas for Cider");
    button.setAttribute("title", "Canvas for Cider");
    button.innerHTML = `<span aria-hidden="true" style="display:inline-flex;width:1.1em;height:1.1em;align-items:center;justify-content:center;pointer-events:none;">${iconSvg}</span>`;
    const inlineIcon = button.querySelector<HTMLElement>("span[aria-hidden=\"true\"]");
    inlineIcon?.querySelector("svg")?.setAttribute("width", "100%");
    inlineIcon?.querySelector("svg")?.setAttribute("height", "100%");
    inlineIcon?.querySelector("svg")?.setAttribute("preserveAspectRatio", "xMidYMid meet");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      open.value = !open.value;
      nextTick(positionPopup);
    });
    lyrics.insertAdjacentElement("afterend", button);
    console.log(PREFIX, "Canvas button attached immediately to the right of Lyrics");
  } else if (lyrics.nextElementSibling !== button) {
    lyrics.insertAdjacentElement("afterend", button);
  }

  applyNativeButtonShape(lyrics);
  positionPopup();
}

function positionPopup() {
  const popup = document.querySelector<HTMLElement>('[data-canvas-cider-quick-popup="true"]');
  if (!popup || !button || !open.value) return;
  const r = button.getBoundingClientRect();
  const width = Math.min(390, window.innerWidth - 24);
  let left = r.right - width;
  left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
  const height = popup.offsetHeight || 320;
  let top = r.bottom + 10;
  if (top + height > window.innerHeight - 12) top = Math.max(12, r.top - height - 10);
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(top)}px`;
  popup.style.width = `${Math.round(width)}px`;
}

function bindDismiss() {
  removeDismiss?.();
  const onMouseDown = (event: MouseEvent) => {
    if (!open.value) return;
    const target = event.target as Node | null;
    const popup = document.querySelector('[data-canvas-cider-quick-popup="true"]');
    if (button?.contains(target) || popup?.contains(target)) return;
    open.value = false;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") open.value = false;
  };
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("keydown", onKeyDown);
  removeDismiss = () => {
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("keydown", onKeyDown);
  };
}

function schedulePosition() {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    positionPopup();
  });
}

watch(open, () => nextTick(positionPopup));

onMounted(() => {
  observer = new MutationObserver(ensureButton);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", schedulePosition);
  window.addEventListener("scroll", schedulePosition, true);
  bindDismiss();
  ensureButton();
});

onUnmounted(() => {
  observer?.disconnect();
  observer = null;
  window.removeEventListener("resize", schedulePosition);
  window.removeEventListener("scroll", schedulePosition, true);
  if (frame !== null) cancelAnimationFrame(frame);
  removeDismiss?.();
  button?.remove();
  button = null;
});
</script>

<template>
  <QuickSettings :open="open" />
</template>
