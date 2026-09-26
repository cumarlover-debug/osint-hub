import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://osinthub.pages.dev',
  // Emit tools/sherlock.html rather than tools/sherlock/index.html: Cloudflare Pages serves it at
  // /tools/sherlock, which is how every internal link is written, so no trailing-slash redirect.
  trailingSlash: 'never',
  build: { format: 'file' },
});
