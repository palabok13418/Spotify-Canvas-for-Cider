import { defineCustomElement } from 'vue';
import {
  addCustomButton,
  addMainMenuEntry,
  createModal,
  definePluginContext,
} from './pluginkit';
import SpotifyNotesPanel from './components/SpotifyNotesPanel.vue';
import PluginConfig from './plugin.config';
import { handleOAuthMessage, startBridge } from './lib/sync';
import { MUS_API_BASE, openSpotifyAuth } from './lib/musApi';

const PanelElement = defineCustomElement(SpotifyNotesPanel, { shadowRoot: false });

export const CustomElements = {
  'spotify-notes-panel': PanelElement,
};

function openPanel(customElementName: (name: string) => string) {
  const { openDialog, dialogElement } = createModal({ escClose: true });
  const element = document.createElement(customElementName('spotify-notes-panel'));
  dialogElement.appendChild(element);
  openDialog();
}

function openSpotifyLogin() {
  const origin = window.location.origin === 'null'
    ? '*'
    : window.location.origin;

  const url = openSpotifyAuth(origin);
  const popup = window.open(
    url,
    'musapi-spotify-auth',
    'width=520,height=760,resizable=yes,scrollbars=yes',
  );

  if (!popup) {
    window.location.href = url;
  }
}

function findNotificationButton(): HTMLElement | null {
  const selectors = [
    'button[aria-label*="Notification" i]',
    'button[title*="Notification" i]',
    '[role="button"][aria-label*="Notification" i]',
    '[role="button"][title*="Notification" i]',
    'button[data-tooltip*="Notification" i]',
    '[role="button"][data-tooltip*="Notification" i]',
  ];

  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) return element;
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button,[role="button"]'),
  );

  return candidates.find((element) => {
    const label = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-tooltip'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return label.includes('notification');
  }) ?? null;
}

function findSpotifyLoginButton(): HTMLElement | null {
  const selectors = [
    'button[title="Log in to Spotify"]',
    'button[aria-label="Log in to Spotify"]',
    '[role="button"][title="Log in to Spotify"]',
    '[role="button"][aria-label="Log in to Spotify"]',
  ];

  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) return element;
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button,[role="button"]'),
  );

  return candidates.find((element) => {
    const label = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .trim()
      .toLowerCase();

    return label === 'log in' || label === 'log in to spotify';
  }) ?? null;
}

function moveSpotifyLoginBeforeNotifications() {
  const loginButton = findSpotifyLoginButton();
  const notificationButton = findNotificationButton();

  if (!loginButton || !notificationButton) return false;
  if (loginButton === notificationButton) return true;

  const parent = notificationButton.parentElement;
  if (!parent) return false;

  if (loginButton.parentElement === parent) {
    if (loginButton.nextElementSibling !== notificationButton) {
      parent.insertBefore(loginButton, notificationButton);
    }
    return true;
  }

  parent.insertBefore(loginButton, notificationButton);
  return true;
}

function registerSpotifyLoginButton(customElementName: (name: string) => string) {
  let registered = false;
  let attempts = 0;

  const tryRegister = () => {
    if (registered) return;

    const pluginSys = (globalThis as any).__PLUGINSYS__;
    if (!pluginSys?.Components?.CustomButtons?.addCustomButton) {
      return;
    }

    try {
      addCustomButton({
        element: 'Log in',
        location: 'chrome-top/right',
        title: 'Log in to Spotify',
        onClick: () => openSpotifyLogin(),
      });

      registered = true;
      console.log('[Spotify Notes Bridge] login button registered');
      moveSpotifyLoginBeforeNotifications();
    } catch (error) {
      console.warn('[Spotify Notes Bridge] waiting for Cider CustomButtons API', error);
    }
  };

  tryRegister();

  const registerTimer = window.setInterval(() => {
    tryRegister();

    if (registered) {
      window.clearInterval(registerTimer);
    } else {
      attempts += 1;
      if (attempts >= 80) {
        window.clearInterval(registerTimer);
        console.warn('[Spotify Notes Bridge] could not register login button');
      }
    }
  }, 250);

  const observer = new MutationObserver(() => {
    if (registered) {
      moveSpotifyLoginBeforeNotifications();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  window.setTimeout(() => observer.disconnect(), 30000);

  // Keep this parameter in the signature so the function can be called
  // consistently with the rest of the plugin context.
  void customElementName;
}

const { plugin, customElementName } = definePluginContext({
  ...PluginConfig,
  CustomElements,

  setup() {
    const panelName = customElementName('spotify-notes-panel');

    if (!customElements.get(panelName)) {
      customElements.define(panelName, PanelElement);
    }

    addMainMenuEntry({
      label: 'Spotify Notes Bridge',
      onClick: () => openPanel(customElementName),
    });

    registerSpotifyLoginButton(customElementName);

    const musApiOrigin = new URL(MUS_API_BASE).origin;

    window.addEventListener('message', (event) => {
      if (event.origin !== musApiOrigin) return;
      if (event.data?.type !== 'musaudio_spotify_oauth') return;

      handleOAuthMessage(event.data.data);
    });

    // The bridge starts when the plugin loads. The panel is only a control surface.
    startBridge();
  },
});

export default plugin;
