import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import PluginConfig from './src/plugin.config';

const manifest = () => [
  `ce_prefix: ${PluginConfig.ce_prefix}`,
  `identifier: ${PluginConfig.identifier}`,
  `name: ${JSON.stringify(PluginConfig.name)}`,
  `description: ${JSON.stringify(PluginConfig.description)}`,
  `version: ${PluginConfig.version}`,
  `author: ${PluginConfig.author}`,
  `repo: ${PluginConfig.repo}`,
  `pluginKitVersion: ${PluginConfig.pluginKitVersion}`,
  'entry:',
  '  plugin.js:',
  '    type: main',
  ''
].join('\n');

const manifestPlugin = (): Plugin => ({
  name: 'cider-plugin-manifest',
  buildStart() {
    this.emitFile({
      fileName: 'plugin.yml',
      type: 'asset',
      source: manifest()
    });
  }
});

export default defineConfig({
  plugins: [vue(), manifestPlugin()],
  build: {
    lib: {
      entry: 'src/main.ts',
      formats: ['es'],
      fileName: () => 'plugin.js'
    },
    rollupOptions: {
      external: []
    },
    cssCodeSplit: false,
    minify: true
  }
});
