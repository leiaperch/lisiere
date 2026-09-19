import { defineConfig } from 'vite';

// base relative : le site fonctionne à la racine comme sous /lisiere/ (GitHub Pages)
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
});
