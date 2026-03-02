import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  const base = 'https://plainvitamins.com';
  const pages = [
    { loc: '/', changefreq: 'weekly', priority: '1.0' },
    { loc: '/supplements/', changefreq: 'weekly', priority: '0.9' },
    { loc: '/ingredients/', changefreq: 'weekly', priority: '0.9' },
    { loc: '/brands/', changefreq: 'weekly', priority: '0.9' },
    { loc: '/rankings/', changefreq: 'weekly', priority: '0.8' },
    { loc: '/rankings/most-common-ingredients', changefreq: 'weekly', priority: '0.7' },
    { loc: '/rankings/top-brands', changefreq: 'weekly', priority: '0.7' },
    { loc: '/rankings/newest', changefreq: 'daily', priority: '0.7' },
    { loc: '/about', changefreq: 'monthly', priority: '0.4' },
    { loc: '/privacy', changefreq: 'monthly', priority: '0.3' },
    { loc: '/terms', changefreq: 'monthly', priority: '0.3' },
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(p => `  <url>
    <loc>${base}${p.loc}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=86400' } });
};
