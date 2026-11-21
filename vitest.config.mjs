import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // Blank out anything a developer's .env.local might inject so tests are hermetic.
      miniflare: { bindings: { TURNSTILE_SECRET: '', ALLOWED_ORIGINS: '' } },
    }),
  ],
});
