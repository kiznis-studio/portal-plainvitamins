import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';
import sentry from '@sentry/astro';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  site: 'https://plainvitamins.com',
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [
    sentry({
      dsn: 'https://a076459e27c9fbfc29a834d089c114ee@o4510827630231552.ingest.de.sentry.io/4511031099916369',
      sourceMapsUploadOptions: {
        enabled: false,
      },
    }),
  ],
});
