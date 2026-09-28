import { db } from '../../../lib/db';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    const worker = await db.workerHeartbeat.findFirst({ where: { updatedAt: { gt: new Date(Date.now() - 120000) } } });
    if (!worker) throw new Error('worker_unavailable');
    return Response.json({ ready: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ ready: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
