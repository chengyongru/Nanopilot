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
      return `<pre><code class="hljs${language ? ` language-${language}` : ''}">${highlighted}</code></pre>`;
    },
  },
});

// Allow hljs classes through DOMPurify
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'class' && data.tagName === 'code') {
    (node as Element).setAttribute('class', (data.attrValue as string) || '');
  }
});

/**
 * Render a raw markdown string to sanitized HTML.
 */
export function renderMarkdown(raw: string): string {
  const html = marked.parse(raw) as string;
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ADD_ATTR: ['class'],
  });
}

/**
 * Add copy buttons to all code blocks inside `container` using event delegation.
 */
export function initCopyButtons(container: HTMLElement): void {
  container.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const btn = target.closest('.nb-copy-btn') as HTMLElement | null;
    if (!btn) return;

    const pre = btn.closest('pre');
    if (!pre) return;

    const code = pre.querySelector('code');
    if (!code) return;

    void navigator.clipboard.writeText(code.textContent || '').then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  });
}
