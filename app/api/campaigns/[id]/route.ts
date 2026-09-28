import { authenticate } from '../../../../lib/auth';
import { endpoint, jsonBody } from '../../../../lib/http';
import { listVersions, updateCampaign, type CampaignPatch } from '../../../../lib/campaignVersions';
import { db } from '../../../../lib/db';
import { HttpError } from '../../../../lib/http';

type Ctx = { params: Promise<{ id: string }> };
export async function GET(req: Request, ctx: Ctx) {
  return endpoint(async r => {
    const user = await authenticate(r);
    const { id } = await ctx.params;
    const campaign = await db.campaign.findFirst({ where: { id, tenantId: user.tenantId }, select: { id: true, version: true } });
    if (!campaign) throw new HttpError(404, 'campaign_not_found');
    return Response.json({ version: campaign.version, versions: await listVersions(user.tenantId, id) });
  })(req);
}
// Partial update. `status`, tenant and enrollment data cannot be changed here.
export async function PUT(req: Request, ctx: Ctx) {
  return endpoint(async r => {
    const user = await authenticate(r, true);
    const { id } = await ctx.params;
    const body = await jsonBody(r) as CampaignPatch;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_body');
    const allowed = new Set(['name', 'icpId', 'offer', 'senderName', 'senderEmail', 'calendlyUrl', 'dailySendCap', 'weeklyProspectCap', 'weeklyAppointmentGoal', 'minScore', 'minAppointmentQualityScore', 'automationMode', 'outcomeType', 'timezone', 'sendStartHour', 'sendEndHour', 'businessDaysOnly', 'holidays', 'sequenceSteps']);
    if (Object.keys(body).some(k => !allowed.has(k))) throw new HttpError(400, 'unknown_field');
    const result = await updateCampaign(user.tenantId, id, user.id, body);
    return Response.json({ version: result.version, material: result.material, changed: result.changed, campaign: result.campaign });
  })(req);
}
