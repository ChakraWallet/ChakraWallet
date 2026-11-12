// Solidity in the app (Android only): contract templates on OpenZeppelin, compiler version from the pragma,
// imports resolved from npm (jsDelivr) / URLs, standard JSON input, compiler output, artifacts from other tools,
// library linking and Sourcify verification. No UI and no compiler here (see ui/solcWorker.js).
import { getAddress, isAddress, parseUnits } from 'ethers';
import { getJson } from './http.js';

export const OZ_VERSION = '5.6.1'; // @openzeppelin/contracts used by the templates (same as the tests)
export const DEFAULT_DEPS = { '@openzeppelin/contracts': OZ_VERSION, '@openzeppelin/contracts-upgradeable': OZ_VERSION };
export const EVM_VERSIONS = ['osaka', 'prague', 'cancun', 'shanghai', 'paris', 'london', 'berlin', 'istanbul'];
export const DEFAULT_EVM = 'cancun'; // supported by every chain of the app; newer targets may use opcodes some chains lack
export const MAX_RUNTIME = 24576; // EIP-170
export const MAX_INITCODE = 49152; // EIP-3860

// ------------------------------------------------------------ templates
/** Contract name from a token name: "My Token 2" -> "MyToken2" (a valid Solidity identifier). */
export function identifier(name, fallback = 'MyContract') {
  const words = String(name || '').normalize('NFKD').replace(/[^\w\s]/g, ' ').split(/[\s_]+/).filter(Boolean);
  let id = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  if (!id) id = fallback;
  if (/^\d/.test(id)) id = '_' + id;
  return id;
}
const str = (s) => JSON.stringify(String(s ?? '')); // Solidity string literal (same escaping rules for what we allow)

const OZ = (p) => `@openzeppelin/contracts/${p}`;
const overrides = (list) => (list.length > 1 ? `override(${list.join(', ')})` : 'override');

/** Template kinds and their options (defaults). */
export const TEMPLATES = {
  erc20: { name: 'MyToken', symbol: 'MTK', premint: '1000000', decimals: 18, mintable: true, burnable: true, pausable: false, permit: true },
  erc721: { name: 'MyNFT', symbol: 'MNFT', baseUri: '', mintable: true, autoIncrement: true, burnable: true, pausable: false, enumerable: false, uriStorage: true },
  erc1155: { name: 'MyItems', uri: '', mintable: true, burnable: true, pausable: false, supply: true, updatableUri: true },
  empty: { name: 'MyContract' },
};

/** Generates the source of a template: { fileName, contractName, source }. */
export function generate(kind, o) {
  o = { ...TEMPLATES[kind], ...o };
  const name = identifier(o.name, kind === 'erc20' ? 'MyToken' : kind === 'erc721' ? 'MyNFT' : kind === 'erc1155' ? 'MyItems' : 'MyContract');
  const gen = { erc20, erc721, erc1155, empty }[kind];
  if (!gen) throw new Error(`unknown template ${kind}`);
  return { fileName: `${name}.sol`, contractName: name, source: gen(name, o) };
}

const head = (imports) => `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.27;\n\n${imports.map(([n, p]) => `import {${n}} from "${OZ(p)}";`).join('\n')}${imports.length ? '\n\n' : ''}`;

function empty(name) {
  return `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.27;\n\ncontract ${name} {\n    uint256 public value;\n\n    event ValueChanged(uint256 newValue);\n\n    function setValue(uint256 newValue) external {\n        value = newValue;\n        emit ValueChanged(newValue);\n    }\n}\n`;
}

function erc20(name, o) {
  const owned = o.mintable || o.pausable;
  const imports = [['ERC20', 'token/ERC20/ERC20.sol']];
  if (o.burnable) imports.push(['ERC20Burnable', 'token/ERC20/extensions/ERC20Burnable.sol']);
  if (o.pausable) imports.push(['ERC20Pausable', 'token/ERC20/extensions/ERC20Pausable.sol']);
  if (o.permit) imports.push(['ERC20Permit', 'token/ERC20/extensions/ERC20Permit.sol']);
  if (owned) imports.push(['Ownable', 'access/Ownable.sol']);
  const bases = ['ERC20', o.burnable && 'ERC20Burnable', o.pausable && 'ERC20Pausable', owned && 'Ownable', o.permit && 'ERC20Permit'].filter(Boolean);
  const dec = Number(o.decimals ?? 18);
  if (!Number.isInteger(dec) || dec < 0 || dec > 36) throw new Error('decimals');
  const ctor = [`ERC20(${str(o.name)}, ${str(o.symbol)})`, owned && 'Ownable(msg.sender)', o.permit && `ERC20Permit(${str(o.name)})`].filter(Boolean);
  let premint = '';
  const amount = String(o.premint ?? '').trim();
  if (amount && amount !== '0') {
    const raw = parseUnits(amount, dec); // validates
    premint = /^\d+$/.test(amount) ? `        _mint(msg.sender, ${amount} * 10 ** decimals());\n` : `        _mint(msg.sender, ${raw});\n`;
  }
  let body = `    constructor()\n        ${ctor.join('\n        ')}\n    {\n${premint}    }\n`;
  if (dec !== 18) body += `\n    function decimals() public pure override returns (uint8) {\n        return ${dec};\n    }\n`;
  if (o.pausable) body += `\n    function pause() public onlyOwner {\n        _pause();\n    }\n\n    function unpause() public onlyOwner {\n        _unpause();\n    }\n`;
  if (o.mintable) body += `\n    function mint(address to, uint256 amount) public onlyOwner {\n        _mint(to, amount);\n    }\n`;
  if (o.pausable) body += `\n    // Required by Solidity: both parents define _update.\n    function _update(address from, address to, uint256 value) internal ${overrides(['ERC20', 'ERC20Pausable'])} {\n        super._update(from, to, value);\n    }\n`;
  return `${head(imports)}contract ${name} is ${bases.join(', ')} {\n${body}}\n`;
}

function erc721(name, o) {
  const owned = o.mintable || o.pausable;
  const imports = [['ERC721', 'token/ERC721/ERC721.sol']];
  if (o.enumerable) imports.push(['ERC721Enumerable', 'token/ERC721/extensions/ERC721Enumerable.sol']);
  if (o.uriStorage) imports.push(['ERC721URIStorage', 'token/ERC721/extensions/ERC721URIStorage.sol']);
  if (o.pausable) imports.push(['ERC721Pausable', 'token/ERC721/extensions/ERC721Pausable.sol']);
  if (o.burnable) imports.push(['ERC721Burnable', 'token/ERC721/extensions/ERC721Burnable.sol']);
  if (owned) imports.push(['Ownable', 'access/Ownable.sol']);
  const bases = ['ERC721', o.enumerable && 'ERC721Enumerable', o.uriStorage && 'ERC721URIStorage', o.pausable && 'ERC721Pausable', owned && 'Ownable', o.burnable && 'ERC721Burnable'].filter(Boolean);
  const ctor = [`ERC721(${str(o.name)}, ${str(o.symbol)})`, owned && 'Ownable(msg.sender)'].filter(Boolean);
  let body = '';
  if (o.mintable && o.autoIncrement) body += '    uint256 private _nextTokenId;\n\n';
  body += `    constructor()\n        ${ctor.join('\n        ')}\n    {}\n`;
  if (o.baseUri) body += `\n    function _baseURI() internal pure override returns (string memory) {\n        return ${str(o.baseUri)};\n    }\n`;
  if (o.pausable) body += `\n    function pause() public onlyOwner {\n        _pause();\n    }\n\n    function unpause() public onlyOwner {\n        _unpause();\n    }\n`;
  if (o.mintable) {
    const uriArg = o.uriStorage ? ', string memory uri' : '';
    const setUri = o.uriStorage ? '        _setTokenURI(tokenId, uri);\n' : '';
    body += o.autoIncrement
      ? `\n    function safeMint(address to${uriArg}) public onlyOwner returns (uint256) {\n        uint256 tokenId = _nextTokenId++;\n        _safeMint(to, tokenId);\n${setUri}        return tokenId;\n    }\n`
      : `\n    function safeMint(address to, uint256 tokenId${uriArg}) public onlyOwner {\n        _safeMint(to, tokenId);\n${setUri}    }\n`;
  }
  const upd = ['ERC721', o.enumerable && 'ERC721Enumerable', o.pausable && 'ERC721Pausable'].filter(Boolean);
  const notes = [];
  if (upd.length > 1) notes.push(`\n    function _update(address to, uint256 tokenId, address auth)\n        internal\n        ${overrides(upd)}\n        returns (address)\n    {\n        return super._update(to, tokenId, auth);\n    }\n`);
  if (o.enumerable) notes.push(`\n    function _increaseBalance(address account, uint128 value) internal ${overrides(['ERC721', 'ERC721Enumerable'])} {\n        super._increaseBalance(account, value);\n    }\n`);
  if (o.uriStorage) notes.push(`\n    function tokenURI(uint256 tokenId) public view ${overrides(['ERC721', 'ERC721URIStorage'])} returns (string memory) {\n        return super.tokenURI(tokenId);\n    }\n`);
  const si = ['ERC721', o.enumerable && 'ERC721Enumerable', o.uriStorage && 'ERC721URIStorage'].filter(Boolean);
  if (si.length > 1) notes.push(`\n    function supportsInterface(bytes4 interfaceId) public view ${overrides(si)} returns (bool) {\n        return super.supportsInterface(interfaceId);\n    }\n`);
  if (notes.length) body += `\n    // The following functions are overrides required by Solidity.\n${notes.join('')}`;
  return `${head(imports)}contract ${name} is ${bases.join(', ')} {\n${body}}\n`;
}

function erc1155(name, o) {
  const owned = o.mintable || o.pausable || o.updatableUri;
  const imports = [['ERC1155', 'token/ERC1155/ERC1155.sol']];
  if (o.pausable) imports.push(['ERC1155Pausable', 'token/ERC1155/extensions/ERC1155Pausable.sol']);
  if (o.burnable) imports.push(['ERC1155Burnable', 'token/ERC1155/extensions/ERC1155Burnable.sol']);
  if (o.supply) imports.push(['ERC1155Supply', 'token/ERC1155/extensions/ERC1155Supply.sol']);
  if (owned) imports.push(['Ownable', 'access/Ownable.sol']);
  const bases = ['ERC1155', owned && 'Ownable', o.pausable && 'ERC1155Pausable', o.burnable && 'ERC1155Burnable', o.supply && 'ERC1155Supply'].filter(Boolean);
  const ctor = [`ERC1155(${str(o.uri)})`, owned && 'Ownable(msg.sender)'].filter(Boolean);
  let body = `    constructor()\n        ${ctor.join('\n        ')}\n    {}\n`;
  if (o.updatableUri) body += `\n    function setURI(string memory newuri) public onlyOwner {\n        _setURI(newuri);\n    }\n`;
  if (o.pausable) body += `\n    function pause() public onlyOwner {\n        _pause();\n    }\n\n    function unpause() public onlyOwner {\n        _unpause();\n    }\n`;
  if (o.mintable) body += `\n    function mint(address account, uint256 id, uint256 amount, bytes memory data) public onlyOwner {\n        _mint(account, id, amount, data);\n    }\n\n    function mintBatch(address to, uint256[] memory ids, uint256[] memory amounts, bytes memory data)\n        public\n        onlyOwner\n    {\n        _mintBatch(to, ids, amounts, data);\n    }\n`;
  const upd = ['ERC1155', o.pausable && 'ERC1155Pausable', o.supply && 'ERC1155Supply'].filter(Boolean);
  if (upd.length > 1) body += `\n    // Required by Solidity: several parents define _update.\n    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)\n        internal\n        ${overrides(upd)}\n    {\n        super._update(from, to, ids, values);\n    }\n`;
  return `${head(imports)}contract ${name} is ${bases.join(', ')} {\n${body}}\n`;
}

// ------------------------------------------------------------ compiler versions
/** Compiler builds: { latest, releases: [{ version, file, long, sha256 }] } newest first. */
export async function compilerList() {
  const r = await getJson('https://binaries.soliditylang.org/wasm/list.json', { label: 'solc', timeout: 20000 });
  const byPath = new Map((r.builds || []).map((b) => [b.path, b]));
  const releases = Object.entries(r.releases || {}).map(([version, file]) => {
    const b = byPath.get(file) || {};
    return { version, file, long: b.longVersion || version, sha256: b.sha256 || null };
  }).sort((a, b) => cmp(b.version, a.version));
  return { latest: r.latestRelease, releases };
}

const parseV = (v) => String(v).split('.').map((x) => parseInt(x, 10) || 0);
export function cmp(a, b) {
  const x = parseV(a), y = parseV(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** One comparator set ("^0.8.20", ">=0.8.0 <0.9.0", "0.8.24", "~0.8.1") -> [[op, version]]. */
function comparators(range) {
  const out = [];
  const toks = range.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
  for (const tk of toks) {
    const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?)$/.exec(tk);
    if (!m) throw new Error(`bad pragma: ${tk}`);
    const op = m[1] || '=', parts = m[2].split('.');
    const [maj, min, pat] = [parts[0], parts[1], parts[2]].map((x) => (x == null || x === 'x' || x === '*' ? null : Number(x)));
    if (op === '^') {
      const lo = `${maj}.${min ?? 0}.${pat ?? 0}`;
      const hi = maj > 0 ? `${maj + 1}.0.0` : min != null && min > 0 ? `0.${min + 1}.0` : `0.0.${(pat ?? 0) + 1}`;
      out.push(['>=', lo], ['<', hi]);
    } else if (op === '~') {
      out.push(['>=', `${maj}.${min ?? 0}.${pat ?? 0}`], ['<', min == null ? `${maj + 1}.0.0` : `${maj}.${min + 1}.0`]);
    } else if (op === '=' && (min == null || pat == null)) {
      out.push(['>=', `${maj}.${min ?? 0}.0`], ['<', min == null ? `${maj + 1}.0.0` : `${maj}.${min + 1}.0`]);
    } else out.push([op, `${maj}.${min ?? 0}.${pat ?? 0}`]);
  }
  return out;
}

/** Does `version` satisfy a pragma range (with || alternatives)? */
export function satisfies(version, range) {
  return range.split('||').some((alt) => comparators(alt).every(([op, v]) => {
    const c = cmp(version, v);
    return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0;
  }));
}

/** `pragma solidity ...;` ranges of a source (comments removed). */
export function pragmas(source) {
  const clean = String(source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...clean.matchAll(/pragma\s+solidity\s+([^;]+);/g)].map((m) => m[1].trim());
}

/** Newest release satisfying every pragma of every file (null if none). */
export function pickVersion(releases, sources) {
  const ranges = Object.values(sources).flatMap((s) => pragmas(s.content ?? s));
  return releases.find((r) => ranges.every((rg) => { try { return satisfies(r.version, rg); } catch { return true; } }))?.version || null;
}

// ------------------------------------------------------------ imports
/** Import paths of a source (comments removed). */
export function importsOf(source) {
  const clean = String(source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...clean.matchAll(/\bimport\s+(?:[^"';]*?\bfrom\s+)?["']([^"']+)["']/g)].map((m) => m[1]);
}

/** Resolves an import as seen from `from`: relative paths are joined, others stay as they are. */
export function resolvePath(from, imp) {
  if (!imp.startsWith('./') && !imp.startsWith('../')) return imp;
  const parts = from.split('/').slice(0, -1);
  for (const seg of imp.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}

/** Remapping lines "prefix=target" -> [[prefix, target]] (longest prefix first). */
export function parseRemappings(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
    .sort((a, b) => b[0].length - a[0].length);
}

const LOCAL_DIRS = new Set(['contracts', 'src', 'lib', 'libs', 'libraries', 'interfaces', 'test', 'tests', 'script', 'scripts', 'utils', 'mocks']);

/** Where to download a source path: URL (jsDelivr for npm packages), or null for project files. */
export function urlFor(path, { deps = {}, remappings = [] } = {}) {
  for (const [prefix, target] of remappings) {
    if (path.startsWith(prefix)) return urlFor(target + path.slice(prefix.length), { deps });
  }
  if (/^https?:\/\//.test(path)) {
    const gh = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(path);
    return gh ? `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}` : path;
  }
  if (path.startsWith('npm:')) path = path.slice(4);
  const m = /^(@[^/]+\/[^/@]+|[^/@.][^/@]*)(@[^/]+)?\/(.+)$/.exec(path);
  if (!m || LOCAL_DIRS.has(m[1])) return null; // a project folder, not an npm package
  const pkg = m[1], ver = m[2] ? m[2].slice(1) : deps[pkg] || DEFAULT_DEPS[pkg] || 'latest';
  return `https://cdn.jsdelivr.net/npm/${pkg}@${ver}/${m[3]}`;
}

/**
 * Collects every source needed by the project files: { sources: {path: {content}}, missing: [path], fetched: n }.
 * fetchText(url) -> string. Downloaded files are cached by URL in `cache` (a Map) across compilations.
 */
export async function collectSources(files, { deps, remappings, fetchText, cache = new Map(), onFetch }) {
  const sources = {};
  const missing = [];
  for (const [p, content] of Object.entries(files)) sources[p] = { content };
  const queue = Object.keys(sources);
  const seen = new Set(queue);
  let fetched = 0;
  while (queue.length) {
    const p = queue.shift();
    for (const imp of importsOf(sources[p].content)) {
      const target = resolvePath(p, imp);
      if (seen.has(target)) continue;
      seen.add(target);
      if (files[target] != null) continue;
      const url = urlFor(target, { deps, remappings });
      if (!url) { missing.push(target); continue; }
      let text = cache.get(url);
      if (text == null) {
        onFetch?.(target);
        try { text = await fetchText(url); } catch { missing.push(target); continue; }
        cache.set(url, text);
        fetched++;
      }
      sources[target] = { content: text };
      queue.push(target);
    }
  }
  return { sources, missing, fetched };
}

// ------------------------------------------------------------ compiler input / output
export function standardInput(sources, { optimizer = true, runs = 200, evmVersion = DEFAULT_EVM, viaIR = false } = {}) {
  return {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: !!optimizer, runs: Number(runs) || 200 },
      ...(evmVersion ? { evmVersion } : {}),
      ...(viaIR ? { viaIR: true } : {}),
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences', 'evm.deployedBytecode.object', 'metadata', 'devdoc', 'userdoc'] } },
    },
  };
}

/** The compiler counts UTF-8 bytes; the editor counts characters. */
export function charOffset(content, byteOffset) {
  if (content == null || byteOffset == null || byteOffset < 0) return byteOffset;
  if (/^[\x00-\x7f]*$/.test(content)) return byteOffset;
  return new TextDecoder().decode(new TextEncoder().encode(content).slice(0, byteOffset)).length;
}

function lineCol(content, offset) {
  if (content == null || offset == null || offset < 0) return {};
  const before = content.slice(0, offset);
  const line = before.split('\n').length;
  return { line, col: offset - before.lastIndexOf('\n') };
}

/**
 * Compiler output -> { errors: [{ severity, type, message, formatted, file, start, end, line, col }], contracts: [...] }.
 * contracts: { file, name, id: 'file:Name', abi, bytecode, runtimeSize, initSize, linkReferences, metadata, devdoc, userdoc }
 * (interfaces and abstract contracts, which have no bytecode, are left out).
 */
export function parseOutput(out, sources) {
  const errors = (out.errors || []).map((e) => {
    const loc = e.sourceLocation, content = sources[loc?.file]?.content;
    const start = charOffset(content, loc?.start ?? null), end = charOffset(content, loc?.end ?? null);
    return {
      severity: e.severity, type: e.type, message: e.message, formatted: e.formattedMessage || e.message,
      file: loc?.file || null, start, end, ...lineCol(content, start),
    };
  });
  const contracts = [];
  for (const [file, byName] of Object.entries(out.contracts || {})) {
    for (const [name, c] of Object.entries(byName)) {
      const bytecode = c.evm?.bytecode?.object || '';
      if (!bytecode) continue;
      contracts.push({
        file, name, id: `${file}:${name}`, abi: c.abi || [], bytecode: '0x' + bytecode, linkReferences: c.evm?.bytecode?.linkReferences || {},
        initSize: bytecode.length / 2, runtimeSize: (c.evm?.deployedBytecode?.object || '').length / 2,
        metadata: c.metadata || null, devdoc: c.devdoc || null, userdoc: c.userdoc || null,
      });
    }
  }
  return { errors, contracts };
}

/** Library placeholders still in the bytecode: [{ file, name, key }] (key = 'file:Name'). */
export function librariesOf(linkReferences) {
  return Object.entries(linkReferences || {}).flatMap(([file, libs]) => Object.keys(libs).map((name) => ({ file, name, key: `${file}:${name}` })));
}

/** Writes library addresses into the bytecode at the offsets given by the compiler. addresses: { 'file:Name': '0x...' } */
export function linkBytecode(bytecode, linkReferences, addresses) {
  let hex = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
  for (const [file, libs] of Object.entries(linkReferences || {})) {
    for (const [name, refs] of Object.entries(libs)) {
      const a = addresses[`${file}:${name}`];
      if (!a || !isAddress(a)) throw new Error(`library ${name}`);
      const addr = getAddress(a).slice(2).toLowerCase();
      for (const r of refs) hex = hex.slice(0, r.start * 2) + addr + hex.slice((r.start + r.length) * 2);
    }
  }
  return '0x' + hex;
}

// ------------------------------------------------------------ artifacts from other tools
/**
 * JSON artifact (Remix, Hardhat, Foundry, Truffle, or { abi, bytecode }) -> { name, abi, bytecode, linkReferences }.
 * Throws if there is no deployable bytecode.
 */
export function parseArtifact(text) {
  const j = typeof text === 'string' ? JSON.parse(text) : text;
  const abi = j.abi || j.output?.abi || [];
  const bc = j.bytecode?.object ?? j.bytecode ?? j.data?.bytecode?.object ?? j.evm?.bytecode?.object ?? j.deployedBytecode?.object;
  const links = j.bytecode?.linkReferences || j.linkReferences || j.data?.bytecode?.linkReferences || j.evm?.bytecode?.linkReferences || {};
  let hex = typeof bc === 'string' ? bc.trim() : '';
  if (hex && !hex.startsWith('0x')) hex = '0x' + hex;
  if (!Array.isArray(abi)) throw new Error('abi');
  if (!/^0x[0-9a-fA-F_$]{2,}$/.test(hex)) throw new Error('bytecode');
  return { name: j.contractName || j.name || j.contract_name || null, abi, bytecode: hex, linkReferences: links };
}

// ------------------------------------------------------------ Sourcify verification
const SOURCIFY = 'https://sourcify.dev/server';
/**
 * Verifies a deployed contract on Sourcify (v2 API): starts the job, then polls it.
 * -> { status: 'verified' | 'already' | 'failed', match?, message? }
 */
export async function verifySourcify({ chainId, address, input, compilerVersion, contractId, txHash, timeoutMs = 120000 }) {
  const res = await fetch(`${SOURCIFY}/v2/verify/${chainId}/${address}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stdJsonInput: input, compilerVersion, contractIdentifier: contractId, ...(txHash ? { creationTransactionHash: txHash } : {}) }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 409) return { status: 'already' };
  if (res.status !== 202 || !body.verificationId) return { status: 'failed', message: body.message || `HTTP ${res.status}` };
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2500));
    const j = await getJson(`${SOURCIFY}/v2/verify/${body.verificationId}`, { label: 'Sourcify', timeout: 20000 }).catch(() => null);
    if (!j?.isJobCompleted) continue;
    if (j.error) return { status: 'failed', message: j.error.message };
    return { status: 'verified', match: j.contract?.match || j.contract?.runtimeMatch || null };
  }
  return { status: 'failed', message: 'timeout' };
}
