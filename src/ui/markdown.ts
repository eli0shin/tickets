import { escapeHTML, markdown } from 'bun';

const options = {
  noHtmlBlocks: true,
  noHtmlSpans: true,
  autolinks: true,
} satisfies Bun.markdown.Options;

/** Render only generated markup: no raw HTML, remote images, or unsafe URLs. */
export function renderMarkdown(source: string): string {
  return markdown.render(
    source,
    {
      text: escapeHTML,
      html: escapeHTML,
      heading: (children, { level }) => `<h${level}>${children}</h${level}>`,
      paragraph: (children) => `<p>${children}</p>`,
      blockquote: (children) => `<blockquote>${children}</blockquote>`,
      code: (children) => `<pre><code>${children}</code></pre>`,
      codespan: (children) => `<code>${children}</code>`,
      strong: (children) => `<strong>${children}</strong>`,
      emphasis: (children) => `<em>${children}</em>`,
      strikethrough: (children) => `<del>${children}</del>`,
      list: (children, { ordered, start }) =>
        ordered
          ? `<ol start="${start ?? 1}">${children}</ol>`
          : `<ul>${children}</ul>`,
      listItem: (children, { checked }) =>
        `<li>${checked === undefined ? '' : checked ? '☑ ' : '☐ '}${children}</li>`,
      hr: () => '<hr>',
      table: (children) => `<table>${children}</table>`,
      thead: (children) => `<thead>${children}</thead>`,
      tbody: (children) => `<tbody>${children}</tbody>`,
      tr: (children) => `<tr>${children}</tr>`,
      th: (children) => `<th>${children}</th>`,
      td: (children) => `<td>${children}</td>`,
      link: (children, { href }) =>
        /^(https?:\/\/|mailto:)/i.test(href)
          ? `<a href="${escapeHTML(href)}" target="_blank" rel="noreferrer noopener">${children}</a>`
          : children,
      image: (children) => `<span>${children}</span>`,
    },
    options
  );
}

/** Use a real Markdown H1 (not a heading-looking line inside a code fence). */
export function ticketTitle(body: string, fallback: string): string {
  let title: string | undefined;
  markdown.render(
    body,
    {
      heading: (children, { level }) => {
        if (level === 1 && title === undefined && children.trim()) {
          title = children.trim();
        }
        return children;
      },
    },
    options
  );
  return title ?? fallback;
}
