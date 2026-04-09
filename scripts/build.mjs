/**
 * Build script for Nanobot Chrome extension.
 * Runs separate Vite builds for each entry point to produce self-contained IIFE bundles.
 * Then copies static assets (manifest, icons, HTML, CSS) into dist/.
 */
import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const entries = [
  {
    name: 'background/service-worker',
    input: resolve(root, 'src/background/service-worker.ts'),
  },
  {
    name: 'sidepanel/app',
    input: resolve(root, 'src/sidepanel/app.ts'),
  },
  {
    name: 'quickchat/quickchat',
    input: resolve(root, 'src/quickchat/quickchat.ts'),
  },
];

// Clean dist
const distDir = resolve(root, 'dist');
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true });
}

// Build each entry as a self-contained IIFE bundle
for (const entry of entries) {
  console.log(`Building ${entry.name}...`);
  await build({
    root,
    build: {
      rollupOptions: {
        input: entry.input,
        output: {
          entryFileNames: `${entry.name.split('/').pop()}.js`,
          format: 'iife',
        },
      },
      outDir: resolve(distDir, dirname(entry.name)),
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      target: 'chrome120',
      copyPublicDir: false,
    },
    logLevel: 'warn',
  });
}

// Copy static assets
console.log('Copying static assets...');

// manifest.json
copyFileSync(resolve(root, 'manifest.json'), resolve(distDir, 'manifest.json'));

// icons
mkdirSync(resolve(distDir, 'icons'), { recursive: true });
cpSync(resolve(root, 'icons'), resolve(distDir, 'icons'), { recursive: true });

// sidepanel HTML
cpSync(resolve(root, 'src/sidepanel/index.html'), resolve(distDir, 'sidepanel/index.html'));

// sidepanel CSS
cpSync(resolve(root, 'src/sidepanel/style.css'), resolve(distDir, 'sidepanel/style.css'));

// quickchat CSS
cpSync(resolve(root, 'src/quickchat/style.css'), resolve(distDir, 'quickchat/style.css'));

console.log('Build complete!');
