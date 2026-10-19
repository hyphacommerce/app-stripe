// The app's few server-rendered pages: plain HTML, no framework.

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
  :root { color-scheme: light dark; --accent: #635bff; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 24px 16px;
         background: Canvas; color: CanvasText; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  h2 { font-size: 17px; margin: 24px 0 8px; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; }
  label > input, label > select { display: block; width: 100%; margin-top: 4px; font-weight: 400; }
  input, select { font: inherit; padding: 8px 10px; border: 1px solid #8886; border-radius: 6px;
                  background: Field; color: FieldText; }
  button { font: inherit; padding: 8px 16px; border: 0; border-radius: 6px; background: var(--accent);
           color: white; cursor: pointer; margin-top: 16px; }
  button[disabled] { opacity: .6; cursor: default; }
  code { font-size: 13px; overflow-wrap: anywhere; }
  .muted, .hint { color: #8a8a8a; font-size: 13px; }
  .error { color: #d92d20; }
  .ok { color: #079455; }
  .box { border: 1px solid #8884; border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
`;

export function page(title: string, body: string, options: { script?: string } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main>${options.script ? `<script type="module" src="${escapeHtml(options.script)}"></script>` : ""}</body>
</html>`;
}
