import './helpers/chrome.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import {
  generate, identifier, satisfies, pragmas, pickVersion, importsOf, resolvePath, urlFor, parseRemappings, collectSources,
  standardInput, parseOutput, parseArtifact, librariesOf, linkBytecode, OZ_VERSION, cmp,
} from '../src/shared/solidity.js';

const OZ_DIR = path.resolve('node_modules/@openzeppelin/contracts');

test('the templates use the OpenZeppelin version installed for the tests', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(OZ_DIR, 'package.json'), 'utf8')).version, OZ_VERSION);
});

test('pragma ranges', () => {
  assert.equal(satisfies('0.8.27', '^0.8.20'), true);
  assert.equal(satisfies('0.9.0', '^0.8.20'), false);
  assert.equal(satisfies('0.8.19', '^0.8.20'), false);
  assert.equal(satisfies('0.8.5', '>=0.8.0 <0.9.0'), true);
  assert.equal(satisfies('0.7.6', '>=0.6.0 <0.8.0'), true);
  assert.equal(satisfies('0.8.0', '>=0.6.0 <0.8.0'), false);
  assert.equal(satisfies('0.8.24', '0.8.24'), true);
  assert.equal(satisfies('0.8.25', '0.8.24'), false);
  assert.equal(satisfies('0.6.12', '~0.6.2'), true);
  assert.equal(satisfies('0.7.0', '~0.6.2'), false);
  assert.equal(satisfies('0.5.17', '^0.5.0 || ^0.6.0'), true);
  assert.equal(satisfies('0.8.30', '>= 0.8.0'), true);
  assert.equal(cmp('0.8.10', '0.8.9') > 0, true);
  assert.deepEqual(pragmas('// pragma solidity 0.4.0;\npragma solidity ^0.8.20;\n/* pragma solidity 0.5.0; */'), ['^0.8.20']);
  const releases = ['0.8.38', '0.8.30', '0.8.24', '0.7.6', '0.6.12'].map((version) => ({ version }));
  assert.equal(pickVersion(releases, { a: { content: 'pragma solidity ^0.8.20;' }, b: { content: 'pragma solidity <=0.8.30;' } }), '0.8.30');
  assert.equal(pickVersion(releases, { a: { content: 'pragma solidity >=0.6.0 <0.8.0;' } }), '0.7.6');
  assert.equal(pickVersion(releases, { a: { content: 'pragma solidity ^0.9.0;' } }), null);
});

test('imports and where they are downloaded from', () => {
  const src = `import "./A.sol";\nimport {B, C} from '../lib/B.sol';\nimport * as X from "@openzeppelin/contracts/token/ERC20/ERC20.sol";\n// import "nope.sol";\nimport "solmate/src/tokens/ERC20.sol";`;
  assert.deepEqual(importsOf(src), ['./A.sol', '../lib/B.sol', '@openzeppelin/contracts/token/ERC20/ERC20.sol', 'solmate/src/tokens/ERC20.sol']);
  assert.equal(resolvePath('contracts/token/T.sol', './A.sol'), 'contracts/token/A.sol');
  assert.equal(resolvePath('contracts/token/T.sol', '../lib/B.sol'), 'contracts/lib/B.sol');
  assert.equal(resolvePath('@openzeppelin/contracts/token/ERC20/ERC20.sol', './IERC20.sol'), '@openzeppelin/contracts/token/ERC20/IERC20.sol');
  assert.equal(urlFor('@openzeppelin/contracts/access/Ownable.sol'), `https://cdn.jsdelivr.net/npm/@openzeppelin/contracts@${OZ_VERSION}/access/Ownable.sol`);
  assert.equal(urlFor('@openzeppelin/contracts@4.9.6/access/Ownable.sol'), 'https://cdn.jsdelivr.net/npm/@openzeppelin/contracts@4.9.6/access/Ownable.sol');
  assert.equal(urlFor('solmate/src/tokens/ERC20.sol', { deps: { solmate: '6.2.0' } }), 'https://cdn.jsdelivr.net/npm/solmate@6.2.0/src/tokens/ERC20.sol');
  assert.equal(urlFor('contracts/Lib.sol'), null, 'a project folder is not an npm package');
  assert.equal(urlFor('https://github.com/a/b/blob/main/src/X.sol'), 'https://raw.githubusercontent.com/a/b/main/src/X.sol');
  const rm = parseRemappings('forge-std/=https://github.com/foundry-rs/forge-std/blob/v1.9.4/src/\n# comment\noz/=@openzeppelin/contracts/');
  assert.equal(urlFor('forge-std/Test.sol', { remappings: rm }), 'https://raw.githubusercontent.com/foundry-rs/forge-std/v1.9.4/src/Test.sol');
  assert.equal(urlFor('oz/utils/Context.sol', { remappings: rm }), `https://cdn.jsdelivr.net/npm/@openzeppelin/contracts@${OZ_VERSION}/utils/Context.sol`);
});

test('artifacts from other tools', () => {
  const abi = [{ type: 'function', name: 'x', inputs: [], outputs: [], stateMutability: 'view' }];
  assert.equal(parseArtifact({ abi, bytecode: '0x6080' }).bytecode, '0x6080'); // Hardhat / Truffle
  assert.equal(parseArtifact({ abi, bytecode: { object: '6080' } }).bytecode, '0x6080'); // Foundry
  assert.equal(parseArtifact({ abi, data: { bytecode: { object: '6080' } } }).bytecode, '0x6080'); // Remix
  assert.throws(() => parseArtifact({ abi, bytecode: '0x' }));
  const refs = { 'L.sol': { Lib: [{ start: 1, length: 20 }] } };
  assert.deepEqual(librariesOf(refs), [{ file: 'L.sol', name: 'Lib', key: 'L.sol:Lib' }]);
  const bc = '0x60' + '__$abcdef$__'.padEnd(40, '_') + '00';
  const linked = linkBytecode(bc, refs, { 'L.sol:Lib': '0x' + '11'.repeat(20) });
  assert.equal(linked, '0x60' + '11'.repeat(20) + '00');
});

test('identifiers from names', () => {
  assert.equal(identifier('My Token 2'), 'MyToken2');
  assert.equal(identifier('2cool'), '_2cool');
  assert.equal(identifier('  '), 'MyContract');
  assert.equal(identifier('Città-Coin'), 'CittaCoin');
});

// -------- every template compiles (OpenZeppelin from node_modules, the solc of the tests)
const local = async (url) => {
  const m = /\/npm\/@openzeppelin\/contracts@[^/]+\/(.+)$/.exec(url);
  if (!m) throw new Error(`unexpected download ${url}`);
  return fs.readFileSync(path.join(OZ_DIR, m[1]), 'utf8');
};
const cache = new Map();
async function compile(kind, opts) {
  const { fileName, contractName, source } = generate(kind, opts);
  const { sources, missing } = await collectSources({ [fileName]: source }, { fetchText: local, cache });
  assert.deepEqual(missing, []);
  const input = standardInput(sources, { optimizer: false });
  const out = parseOutput(JSON.parse(solc.compile(JSON.stringify(input))), sources);
  const errs = out.errors.filter((e) => e.severity === 'error');
  assert.deepEqual(errs.map((e) => e.formatted), [], `${kind} ${JSON.stringify(opts)}\n${source}`);
  const c = out.contracts.find((x) => x.name === contractName);
  assert.ok(c, `${contractName} has bytecode`);
  return c;
}
const variants = (base, keys) => [Object.fromEntries(keys.map((k) => [k, true])), Object.fromEntries(keys.map((k) => [k, false])), ...keys.map((k) => ({ ...Object.fromEntries(keys.map((x) => [x, false])), [k]: true }))].map((v) => ({ ...base, ...v }));

test('ERC-20 template compiles with every option', { timeout: 300000 }, async () => {
  for (const v of variants({ name: 'Test Token', symbol: 'TT' }, ['mintable', 'burnable', 'pausable', 'permit'])) await compile('erc20', v);
  const c = await compile('erc20', { name: 'Six', symbol: 'SIX', decimals: 6, premint: '12.5' });
  assert.ok(c.abi.some((f) => f.name === 'decimals'));
});

test('ERC-721 template compiles with every option', { timeout: 300000 }, async () => {
  for (const v of variants({ name: 'Test NFT', symbol: 'TNFT', baseUri: 'ipfs://x/' }, ['mintable', 'burnable', 'pausable', 'enumerable', 'uriStorage'])) await compile('erc721', v);
  await compile('erc721', { mintable: true, autoIncrement: false, uriStorage: false });
});

test('ERC-1155 and empty templates compile', { timeout: 300000 }, async () => {
  for (const v of variants({ name: 'Items', uri: 'https://x/{id}.json' }, ['mintable', 'burnable', 'pausable', 'supply', 'updatableUri'])) await compile('erc1155', v);
  const c = await compile('empty', { name: 'Hello World' });
  assert.equal(c.name, 'HelloWorld');
  assert.ok(c.runtimeSize > 0 && c.initSize > c.runtimeSize);
});

test('error positions in characters, also after accented letters', async () => {
  const { charOffset } = await import('../src/shared/solidity.js');
  const src = '// città\ncontract X { uint x = ; }';
  const byte = Buffer.from(src.slice(0, src.indexOf(';')), 'utf8').length;
  assert.equal(charOffset(src, byte), src.indexOf(';'));
  const out = JSON.parse(solc.compile(JSON.stringify(standardInput({ 'X.sol': { content: 'pragma solidity ^0.8.0;\n' + src } }, { optimizer: false }))));
  const e = parseOutput(out, { 'X.sol': { content: 'pragma solidity ^0.8.0;\n' + src } }).errors.find((x) => x.severity === 'error');
  assert.equal(e.line, 3);
  assert.equal(('pragma solidity ^0.8.0;\n' + src)[e.start], ';');
});
