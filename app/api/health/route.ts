export async function GET() { return Response.json({ ok: true, service: 'leadmelo', version: '18.0.0' }, { headers: { 'Cache-Control': 'no-store' } }); }
