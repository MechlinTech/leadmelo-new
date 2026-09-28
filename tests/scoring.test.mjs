import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreLead } from '../lib/scoring.ts';
test('legacy QA scoring stays bounded', () => {
  assert.equal(scoreLead({qaJobs:8,automation:true,performance:true,playwright:true,selenium:true,funding:true,decisionMaker:true}),100);
  assert.equal(scoreLead({qaJobs:0,automation:false,performance:false,playwright:false,selenium:false,funding:false,decisionMaker:false}),0);
});
