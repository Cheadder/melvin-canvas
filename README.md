# melvin-canvas

A static, data-free Telegram Mini App that renders one small JSON page description and sends the answers back through Telegram (`WebApp.sendData`).

- **No data lives here.** Each page's content travels in the URL fragment (`#v1.<nonce>.<compressed JSON>`). Browsers never send the fragment to this site, so the host never sees it.
- **No third-party code.** There are no CDNs, web fonts, analytics or remote images. A strict Content-Security-Policy blocks network requests. The Telegram bridge (`tg.js`) uses Telegram's documented Mini App event protocol directly.
- **Text is never parsed as HTML.** Everything is rendered with `textContent`, and images must be small `data:image/...` URIs.
- `#demo` shows every building block with made-up content.

Files: `index.html`, `canvas.css`, `canvas.js`, `tg.js`, `.nojekyll`. There is no build step.
