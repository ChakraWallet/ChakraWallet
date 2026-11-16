// The FunC sources shown in the app for the TON templates are really the code it deploys: they compile to the
// pinned code hashes, and the generated module matches the files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Cell } from '@ton/core';
import { compileFunc } from '@ton-community/func-js';
import { CODES } from '../src/shared/ton/templates.js';
import { TEMPLATE_SOURCES as SHIPPED } from '../src/shared/ton/templateSources.js';
import { TEMPLATE_SOURCES, BUILD, SRC, generate } from '../scripts/ton-sources.mjs'; // SRC: from the project folder (cwd)

test('template sources compile to the code the app deploys', async () => {
  assert.deepEqual(Object.keys(TEMPLATE_SOURCES).sort(), Object.keys(CODES).sort());
  for (const [k, s] of Object.entries(TEMPLATE_SOURCES)) {
    const r = await compileFunc({ targets: BUILD[s.dir](s.main), sources: (p) => fs.readFileSync(path.join(SRC, s.dir, p), 'utf8') });
    assert.equal(r.status, 'ok', `${k}: ${r.message}`);
    assert.equal(Cell.fromBase64(r.codeBoc).hash().toString('hex'), CODES[k].hash, k);
  }
});

test('the generated module is up to date (node scripts/ton-sources.mjs)', () => {
  assert.equal(fs.readFileSync(path.join(SRC, '../templateSources.js'), 'utf8'), generate());
  assert.deepEqual(SHIPPED, TEMPLATE_SOURCES);
});
