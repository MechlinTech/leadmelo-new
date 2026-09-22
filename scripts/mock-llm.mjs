// A tiny OpenAI-compatible chat server with canned answers. It is NOT an AI: it exists so you can try the AI assist
// screens and run tests without a model. Usage: node scripts/mock-llm.mjs [port]   (default 11555)
// Then set AI_ALLOWED_HOSTS=127.0.0.1:11555 for the app and use Base URL http://127.0.0.1:11555/v1 in Settings.
import http from 'node:http';

const port = Number(process.argv[2] ?? 11555);
const campaign = {
  name: 'Engineering leaders needing QA capacity', offer: 'Move brittle Selenium suites to Playwright without pausing releases',
  icp: { industries: ['SaaS', 'Fintech'], companySizes: ['50-200', '201-1000'], geographies: ['US', 'Canada'], technologies: ['Selenium', 'Playwright'], buyingSignals: ['Hiring SDET', 'Hiring QA engineers'], buyerTitles: ['VP Engineering', 'QA Director', 'CTO'], exclusionRules: [] },
  steps: [
    { waitBusinessDays: 0, subject: 'A thought on QA at {{company}}', body: 'Hi {{firstName}},\n\nI saw {{company}} is hiring for QA. We help teams move Selenium suites to Playwright without pausing releases.\n\nWorth a 20-minute call? {{calendlyUrl}}\n\n{{senderName}}' },
    { waitBusinessDays: 3, subject: 'Re: QA at {{company}}', body: 'Hi {{firstName}}, a quick follow-up. Teams we work with usually start with their flakiest ten tests. {{calendlyUrl}}\n\n{{senderName}}' },
    { waitBusinessDays: 5, subject: 'Should I close the loop?', body: 'Hi {{firstName}}, I will stop here. If QA capacity becomes a priority, {{calendlyUrl}} is my calendar.\n\n{{senderName}}' }
  ]
};
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
  let raw = ''; req.on('data', d => raw += d);
  req.on('end', () => {
    const prompt = (JSON.parse(raw).messages ?? []).map(m => m.content).join('\n');
    let content;
    if (/prospect_reply/.test(prompt)) {
      const replyText = (prompt.match(/<data name="prospect_reply">([\s\S]*?)<\/data>/) ?? [])[1] ?? '';
      const optOut = /stop emailing|unsubscribe|remove me/i.test(replyText);
      content = optOut ? { intent: 'NEGATIVE', summary: 'The prospect asks not to be contacted.', suggestedReply: '' }
        : { intent: 'POSITIVE', summary: 'The prospect is interested and wants a time.', suggestedReply: 'Thanks {{firstName}}, glad it is useful. Here is my calendar: {{calendlyUrl}}\n\n{{senderName}}' };
    } else if (/single word: ready/.test(prompt)) content = 'ready';
    else content = campaign;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));
  });
});
server.listen(port, '127.0.0.1', () => console.log(`mock LLM listening on http://127.0.0.1:${port}/v1`));
