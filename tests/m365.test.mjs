import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphClient, mimeMessage, connectionInput } from '../lib/m365/graph.ts';
import { validateDeltaLink } from '../lib/m365/sync.ts';
import { encrypt } from '../lib/crypto.ts';
import { classifyReply } from '../lib/replies.ts';
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32,7).toString('base64');
const config = {directoryId:'11111111-1111-4111-8111-111111111111',clientId:'22222222-2222-4222-8222-222222222222',encryptedSecret:encrypt('test-secret'),mailboxes:['sender@example.com']};
const message = {tenantId:'tenant',campaignId:'campaign',contactId:'contact',from:'sender@example.com',fromName:'Sender',to:'buyer@example.com',subject:'Hello',body:'Hello buyer',headers:{'List-Unsubscribe':'<https://app.example/unsubscribe?token=test>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'},calendlyUrl:'https://calendly.com/test'};
test('Microsoft client rejects foreign hosts and unapproved mailboxes before credentials leave',async()=>{
  let calls=0; const graph=new GraphClient(config,async()=>{calls++;throw new Error('unexpected');});
  await assert.rejects(graph.request('https://evil.example/v1.0/users/sender@example.com/messages'));
  await assert.rejects(graph.request('/v1.0/users/other@example.com/messages'));
  assert.equal(calls,0);
});
test('Microsoft client scopes OAuth and asks for immutable IDs; no redirects or blind HTTP retries',async()=>{
  const calls=[];
  const graph=new GraphClient(config,async(url,options)=>{
    calls.push({url:String(url),options});
    return calls.length===1?Response.json({access_token:'synthetic-token'}):Response.json({value:[]});
  });
  await graph.request('/v1.0/users/sender%40example.com/messages');
  assert.equal(calls[0].options.body.get('scope'),'https://graph.microsoft.com/.default');
  assert.match(calls[1].options.headers.Prefer,/ImmutableId/);
  assert.equal(calls[1].options.redirect,'error');
});
test('MIME includes opt-out headers and rejects header injection',()=>{
  const mime=Buffer.from(mimeMessage(message,'stable-key'),'base64').toString();
  assert.match(mime,/List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.match(mime,/Content-Transfer-Encoding: base64/);
  assert.throws(()=>mimeMessage({...message,subject:'Hi\r\nBcc: other@example.com'},'key'));
});
test('delta cursor cannot escape mailbox or Microsoft origin',()=>{
  assert.ok(validateDeltaLink('https://graph.microsoft.com/v1.0/users/sender%40example.com/mailFolders/inbox/messages/delta?$deltatoken=x','sender@example.com'));
  for(const url of ['https://evil.example/v1.0/users/sender%40example.com/mailFolders/inbox/messages/delta','https://graph.microsoft.com/v1.0/users/victim%40example.com/mailFolders/inbox/messages/delta']) assert.throws(()=>validateDeltaLink(url,'sender@example.com'));
});
test('connection needs explicit mailbox-scope confirmation and questions do not auto-book',()=>{
  assert.ok(!connectionInput.safeParse({directoryId:config.directoryId,clientId:config.clientId,clientSecret:'1234567890123456',mailboxes:config.mailboxes}).success);
  assert.equal(classifyReply('yes please send pricing first'),'OBJECTION');
  assert.equal(classifyReply('not interested, what is the price'),'NEGATIVE');
});
