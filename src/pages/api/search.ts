import type { APIRoute } from 'astro';
import { searchProducts, searchBrands } from '../../lib/db';

export const GET: APIRoute = async ({ request, locals }) => {
  const db = (locals as any).runtime.env.DB;
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim() || '';

  if (q.length < 2) {
    return new Response(JSON.stringify({ products: [], brands: [] }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    });
  }

  const [products, brands] = await Promise.all([
    searchProducts(db, q, 10),
    searchBrands(db, q, 5),
  ]);

  return new Response(JSON.stringify({ products, brands }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
};
