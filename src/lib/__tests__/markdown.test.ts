import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock clipboard API
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

import { renderMarkdown, initCopyButtons } from '../markdown';

describe('renderMarkdown', () => {
  it('should return plain text wrapped in <p>', () => {
    const result = renderMarkdown('hello world');
    expect(result).toContain('<p>hello world</p>');
  });

  it('should render headings', () => {
    const result = renderMarkdown('# Title\n## Subtitle');
    expect(result).toContain('<h1>Title</h1>');
    expect(result).toContain('<h2>Subtitle</h2>');
  });

  it('should render unordered lists', () => {
    const result = renderMarkdown('- item 1\n- item 2');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>item 1</li>');
    expect(result).toContain('<li>item 2</li>');
    expect(result).toContain('</ul>');
  });

  it('should render ordered lists', () => {
    const result = renderMarkdown('1. first\n2. second');
    expect(result).toContain('<ol>');
    expect(result).toContain('<li>first</li>');
    expect(result).toContain('</ol>');
  });

  it('should render code blocks with hljs class and highlighting', () => {
    const result = renderMarkdown('```js\nconst x = 1;\n```');
    expect(result).toContain('<pre>');
    expect(result).toContain('hljs');
    // highlight.js wraps keywords and numbers in spans
    expect(result).toMatch(/hljs-keyword/);
    expect(result).toMatch(/hljs-number/);
  });

  it('should render inline code', () => {
    const result = renderMarkdown('use `console.log()` here');
    expect(result).toContain('<code>console.log()</code>');
  });

  it('should render bold and italic', () => {
    const result = renderMarkdown('**bold** and *italic*');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>italic</em>');
  });

  it('should render links', () => {
    const result = renderMarkdown('[example](https://example.com)');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('>example</a>');
  });

  it('should sanitize XSS scripts', () => {
    const result = renderMarkdown('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
  });

  it('should sanitize XSS in links', () => {
    const result = renderMarkdown('[click](javascript:alert(1))');
    expect(result).not.toContain('javascript:');
  });

  it('should render blockquotes', () => {
    const result = renderMarkdown('> quoted text');
    expect(result).toContain('<blockquote>');
    expect(result).toContain('quoted text');
  });

  it('should render tables', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |';
    const result = renderMarkdown(md);
    expect(result).toContain('<table>');
    expect(result).toContain('<thead>');
    expect(result).toContain('<th>');
    expect(result).toContain('<td>');
  });

  it('should handle empty string', () => {
    const result = renderMarkdown('');
    expect(result).toBe('');
  });
});

describe('initCopyButtons', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  it('should not throw when container has no code blocks', () => {
    expect(() => initCopyButtons(container)).not.toThrow();
  });

  it('should copy code text when copy button is clicked', async () => {
    container.innerHTML = `
      <pre>
        <button class="nb-copy-btn">Copy</button>
        <code>const x = 1;</code>
      </pre>
    `;
    initCopyButtons(container);

    const btn = container.querySelector('.nb-copy-btn')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Wait for clipboard write and button text change
    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const x = 1;');
    });
  });

  it('should not copy when clicking outside copy button', () => {
    container.innerHTML = `
      <pre>
        <button class="nb-copy-btn">Copy</button>
        <code>const x = 1;</code>
      </pre>
    `;
    initCopyButtons(container);

    const pre = container.querySelector('pre')!;
    pre.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});
