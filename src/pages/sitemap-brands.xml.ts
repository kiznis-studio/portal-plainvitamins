import type { APIRoute } from 'astro';
import { getAllBrandSlugs } from '../lib/db';

export const GET: APIRoute = async ({ locals }) => {
  const db = (locals as any).runtime.env.DB;
  const slugs = await getAllBrandSlugs(db);
  const base = 'https://plainvitamins.com';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${slugs.map(s => `  <url><loc>${base}/brand/${s}</loc><changefreq>monthly</changefreq></url>`).join('\n')}
</urlset>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=86400' } });
};
