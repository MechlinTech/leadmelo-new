import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAutomation, isAppointmentQualified } from '../lib/appointmentEngine.ts';
test('automation policy blocks paused and unhealthy senders', () => {
  const input = { campaignId:'test', automationMode:'FULLY_AUTOMATIC', deliverabilityStatus:'HEALTHY', dailySendCap:25, weeklyProspectCap:50, minScore:75, minAppointmentQualityScore:80, weeklyAppointmentGoal:5 };
  assert.ok(decideAutomation(input).canSend);
  for (const mode of ['PAUSED','REVIEW_BEFORE_SEND']) assert.ok(!decideAutomation({...input,automationMode:mode}).canSend);
  for (const status of ['BLOCKED','WATCHLIST','THROTTLED']) assert.ok(!decideAutomation({...input,deliverabilityStatus:status}).canSend);
  assert.ok(!isAppointmentQualified(99, 80, true, false));
});
