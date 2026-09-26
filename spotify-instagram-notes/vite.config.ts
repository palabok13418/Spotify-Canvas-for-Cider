import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      entry: 'src/main.ts',
      formats: ['iife'],
      fileName: () => 'plugin.js',
    },
    rollupOptions: {
      external: [],
    },
    cssCodeSplit: false,
    minify: true,
  },
});
