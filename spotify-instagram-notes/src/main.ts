import { defineCustomElement } from 'vue';
import { addCustomButton, addMainMenuEntry, createModal, definePluginContext } from '@ciderapp/pluginkit';
import SpotifyNotesPanel from './components/SpotifyNotesPanel.vue';
import PluginConfig from './plugin.config';
import { handleOAuthMessage, startBridge } from './lib/sync';

const PanelElement = defineCustomElement(SpotifyNotesPanel, { shadowRoot: false });

export const CustomElements = {
  'spotify-notes-panel': PanelElement,
};

function openPanel(customElementName: (name: string) => string) {
  const { closeDialog, openDialog, dialogElement } = createModal({ escClose: true });
  const element = document.createElement(customElementName('spotify-notes-panel'));
  dialogElement.appendChild(element);
  openDialog();
  return closeDialog;
}

const { plugin, customElementName } = definePluginContext({
  ...PluginConfig,
  CustomElements,
  setup() {
    const panelName = customElementName('spotify-notes-panel');
    if (!customElements.get(panelName)) customElements.define(panelName, PanelElement);

    addMainMenuEntry({
      label: 'Spotify Notes Bridge',
      onClick: () => openPanel(customElementName),
    });

    addCustomButton({
      element: '♫',
      location: 'chrome-top/right',
      title: 'Spotify Notes Bridge',
      onClick: () => openPanel(customElementName),
    });

    window.addEventListener('message', (event) => {
      if (event.data?.type === 'musaudio_spotify_oauth') handleOAuthMessage(event.data.data);
    });

    // The bridge is intentionally started at plugin boot, not when the panel opens.
    // That way a linked account mirrors playback without requiring the user to keep the UI open.
    startBridge();
  },
});

export default plugin;
