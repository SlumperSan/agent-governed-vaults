// Transient. Extracts the seventeen <article class="qa"> blocks out of
// apps/site/faq.html and prints each child node as a JS template literal, so
// copy.ts is transcribed by a machine rather than by hand.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../../../../site/faq.html');
const html = readFileSync(SRC, 'utf8');

const articles = [...html.matchAll(/<article class="qa">([\s\S]*?)<\/article>/g)].map((m) => m[1]);
console.log(`# articles: ${articles.length}`);

articles.forEach((body, i) => {
  const h2 = body.match(/<h2>([\s\S]*?)<\/h2>/)[1];
  console.log(`\n/* ===== ${i + 1}. ${h2} ===== */`);
  console.log(`QUESTION: ${JSON.stringify(h2)}`);
  for (const m of body.matchAll(/<p(?: class="([^"]*)")?>([\s\S]*?)<\/p>/g)) {
    console.log(`P[class=${m[1] ?? ''}]: \`${m[2]}\``);
  }
});

// Every character that would need escaping inside a backtick literal.
const region = articles.join('\n');
for (const bad of ['`', '${', '\\']) {
  console.log(`# contains ${JSON.stringify(bad)}: ${region.includes(bad)}`);
}
