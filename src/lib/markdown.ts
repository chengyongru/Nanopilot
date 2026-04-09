import { marked } from 'marked';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

// Configure marked with highlight.js
marked.setOptions({
  gfm: true,
  breaks: true,
});

marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }): string {
      const language = lang && hljs.getLanguage(lang) ? lang : '';
      const highlighted = language
        ? hljs.highlight(text, { language }).value
        : hljs.highlightAuto(text).value;
      return `<pre><button class="nb-copy-btn">Copy</button><code class="hljs${language ? ` language-${language}` : ''}">${highlighted}</code></pre>`;
    },
  },
});

/**
 * Render a raw markdown string to sanitized HTML.
 */
export function renderMarkdown(raw: string): string {
  const html = marked.parse(raw, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['class'],
  });
}

/**
 * Add copy buttons to all code blocks inside `container` using event delegation.
 * Uses a data attribute to prevent duplicate listener registration.
 */
export function initCopyButtons(container: HTMLElement): void {
  if (container.dataset.nbCopyInit === 'true') return;
  container.dataset.nbCopyInit = 'true';

  container.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const btn = target.closest('.nb-copy-btn') as HTMLElement | null;
    if (!btn) return;

    const pre = btn.closest('pre');
    if (!pre) return;

    const code = pre.querySelector('code');
    if (!code) return;

    const text = code.textContent || '';
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
    }
  });
}
