// Regenerates data/is-ip-ranges.json from the RIPE NCC delegation statistics.
//
// The site defaults to Icelandic for visitors on Icelandic IPs. Behind a CDN the
// country arrives in a header and this file is never consulted; without one, the
// address has to be matched locally. A GeoIP lookup service would mean an
// external call on every cold visitor, so instead the authoritative allocation
// list is compiled to a compact sorted array once, here.
//
//   node scripts/build-geo.mjs
//
// Worth re-running occasionally — allocations do change.
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = 'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-latest';
const CC = 'IS';

const v4ToInt = (s) => s.split('.').reduce((a, o) => a * 256 + Number(o), 0);

// Expand a v6 prefix to the BigInt of its first address.
function v6ToBig(prefix) {
  let [head, tail = ''] = prefix.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n);
}

const res = await fetch(SRC, { signal: AbortSignal.timeout(120000) });
if (!res.ok) throw new Error('RIPE ' + res.status);
const text = await res.text();

const v4 = [], v6 = [];
let serial = null;
for (const line of text.split('\n')) {
  if (!serial && line.startsWith('2|ripencc|')) serial = line.split('|')[2];
  if (!line.includes('|' + CC + '|')) continue;
  const f = line.split('|');
  // registry|cc|type|start|value|date|status
  if (f[1] !== CC || (f[6] !== 'allocated' && f[6] !== 'assigned')) continue;
  if (f[2] === 'ipv4') {
    const start = v4ToInt(f[3]);
    v4.push([start, start + Number(f[4]) - 1]);
  } else if (f[2] === 'ipv6') {
    const start = v6ToBig(f[3]);
    const size = 1n << (128n - BigInt(f[4]));
    v6.push([start.toString(), (start + size - 1n).toString()]);
  }
}

// Sort and merge touching ranges so lookup is a clean binary search.
const merge = (arr, toKey) => {
  arr.sort((a, b) => (toKey(a[0]) < toKey(b[0]) ? -1 : toKey(a[0]) > toKey(b[0]) ? 1 : 0));
  const out = [];
  for (const r of arr) {
    const last = out.at(-1);
    if (last && toKey(r[0]) <= toKey(last[1]) + 1n) {
      if (toKey(r[1]) > toKey(last[1])) last[1] = r[1];
    } else out.push([...r]);
  }
  return out;
};

const v4m = merge(v4, (x) => BigInt(x));
const v6m = merge(v6, (x) => BigInt(x));

const payload = {
  country: CC,
  source: SRC,
  serial,
  built: new Date().toISOString(),
  v4: v4m,                       // [[startInt, endInt], …]
  v6: v6m,                       // [[startStr, endStr], …] — BigInt as decimal strings
};

await mkdir(join(ROOT, 'data'), { recursive: true });
await writeFile(join(ROOT, 'data', 'is-ip-ranges.json'), JSON.stringify(payload));

const v4count = v4m.reduce((a, [s, e]) => a + (e - s + 1), 0);
console.log(`${CC}: ${v4m.length} IPv4 ranges (${v4count.toLocaleString('en-US')} addresses), ${v6m.length} IPv6 ranges`);
console.log('serial', serial, '→ data/is-ip-ranges.json');
