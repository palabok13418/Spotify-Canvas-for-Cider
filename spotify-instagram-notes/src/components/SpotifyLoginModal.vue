<script setup lang="ts">
function startLogin() {
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
      <h2 id="spotify-login-title">Spotify sign-in required</h2>
      <p>
        A Spotify user session was not detected. Continue to Spotify's official
        sign-in page to link this Cider plugin.
      </p>
      <p class="privacy">
        Your Spotify password stays with Spotify. Mus-API receives the OAuth
        authorization result, not your password.
      </p>

      <div class="actions">
        <button class="secondary" type="button" @click="cancel">Not now</button>
        <button class="primary" type="button" @click="startLogin">
          Continue with Spotify
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

.secondary {
  color: rgba(255,255,255,.82);
  background: rgba(255,255,255,.08);
  border: 1px solid rgba(255,255,255,.10);
}
</style>
