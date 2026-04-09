import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        'background/service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'sidepanel/app': resolve(__dirname, 'src/sidepanel/app.ts'),
        'quickchat/quickchat': resolve(__dirname, 'src/quickchat/quickchat.ts'),
      },
      output: {
        entryFileNames: '[name].js',
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: 'chrome120',
  },
});
