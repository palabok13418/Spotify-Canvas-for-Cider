<script setup lang="ts">
let opening = false;

function startLogin() {
  if (opening) return;
  opening = true;

  globalThis.dispatchEvent(
    new CustomEvent('spotify-login-start', {
      bubbles: true,
      composed: true,
    }),
  );
}

function cancel() {
  globalThis.dispatchEvent(
    new CustomEvent('spotify-login-cancel', {
      bubbles: true,
      composed: true,
    }),
  );
}
</script>

<template>
  <div class="login-shell" role="dialog" aria-labelledby="spotify-login-title">
    <div class="glass">
      <div class="eyebrow">SPOTIFY NOTES BRIDGE</div>
      <h2 id="spotify-login-title">Sign in to Spotify</h2>
      <p>
        Spotify login is required before the background mirroring service can
        start. Your account is authenticated through Spotify's own sign-in flow.
      </p>
      <p class="privacy">
        Your Spotify password is entered only on Spotify's authentication page.
        Mus-API receives the OAuth result and the plugin stores only the
        resulting session token needed to keep the connection alive.
      </p>

      <div class="secure-row" aria-label="Secure authentication">
        <span class="secure-dot" aria-hidden="true"></span>
        <span>Spotify authentication · secure handoff</span>
      </div>

      <div class="actions">
        <button class="secondary" type="button" @click="cancel">Not now</button>
        <button class="primary" type="button" :disabled="opening" @click="startLogin">
          {{ opening ? 'Opening Spotify…' : 'Continue with Spotify' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style>
:host {
  display: block;
  width: min(430px, calc(100vw - 32px));
}

.login-shell {
  padding: 8px;
}

.glass {
  border: 1px solid rgba(255,255,255,.18);
  border-radius: 24px;
  padding: 26px;
  color: #fff;
  background:
    linear-gradient(145deg, rgba(255,255,255,.16), rgba(255,255,255,.06)),
    rgba(16,18,24,.72);
  backdrop-filter: blur(28px) saturate(145%);
  -webkit-backdrop-filter: blur(28px) saturate(145%);
  box-shadow:
    0 30px 90px rgba(0,0,0,.38),
    inset 0 1px 0 rgba(255,255,255,.12);
  font-family: system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}

.eyebrow {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .14em;
  opacity: .62;
}

h2 {
  margin: 7px 0 10px;
  font-size: 23px;
  line-height: 1.15;
}

p {
  margin: 0;
  color: rgba(255,255,255,.78);
  font-size: 13px;
  line-height: 1.55;
}

.privacy {
  margin-top: 12px;
  color: rgba(255,255,255,.58);
  font-size: 11px;
}

.secure-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding: 9px 11px;
  border-radius: 12px;
  background: rgba(255,255,255,.06);
  border: 1px solid rgba(255,255,255,.08);
  color: rgba(255,255,255,.66);
  font-size: 10px;
  letter-spacing: .02em;
}

.secure-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: currentColor;
  box-shadow: 0 0 12px currentColor;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  margin-top: 22px;
}

button {
  border: 0;
  border-radius: 12px;
  padding: 10px 14px;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.primary {
  color: #07130b;
  background: rgba(255,255,255,.94);
}

.primary:disabled {
  opacity: .65;
  cursor: wait;
}

.secondary {
  color: rgba(255,255,255,.82);
  background: rgba(255,255,255,.08);
  border: 1px solid rgba(255,255,255,.10);
}
</style>
