const t = await (await fetch('http://127.0.0.1:3000/')).text();
console.log('len', t.length);
console.log('boot', t.includes('leadmelo-boot.js'));
console.log('csshref', t.includes('leadmelo.css'));
console.log('chunks', [...t.matchAll(/\/_next\/static\/chunks\/[^"']+/g)].map((m) => m[0]).join('\n'));
const i = t.indexOf('leadmelo-boot');
console.log('boot-idx', i);
if (i >= 0) console.log(t.slice(Math.max(0, i - 40), i + 90));
