// Local EVM networks for the end-to-end tests: two Anvil nodes ("Local A" and "Local B") with the test accounts already
// funded (no faucet), and the contracts the simulated services use: a USDC-like token on each, a DEX on A (swaps),
// a bridge deposit contract on each (bridges). Compiled here with solc + OpenZeppelin from node_modules.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JsonRpcProvider, Wallet, NonceManager, ContractFactory, Contract, parseEther, parseUnits, HDNodeWallet, Mnemonic } from 'ethers';

const require = createRequire(import.meta.url);
const solc = require('solc');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '../..');

/** The test recovery phrase (Anvil's default): its accounts are funded at genesis. Public: never use it elsewhere. */
export const MNEMONIC = 'test test test test test test test test test test test junk';
export const NETWORKS = [
  { key: 'a', id: 31337, port: 8545, name: 'Local A' },
  { key: 'b', id: 31338, port: 8546, name: 'Local B' },
];
const DEPLOYER = 9; // the phrase's 10th account deploys and funds the contracts; the wallet under test uses the first ones

function compile() {
  const sources = Object.fromEntries(fs.readdirSync(path.join(HERE, 'contracts')).map((f) => [f, { content: fs.readFileSync(path.join(HERE, 'contracts', f), 'utf8') }]));
  const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const findImports = (p) => { try { return { contents: fs.readFileSync(path.join(ROOT, 'node_modules', p), 'utf8') }; } catch { return { error: `not found: ${p}` }; } };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const art = {};
  for (const file of Object.values(out.contracts)) for (const [name, c] of Object.entries(file)) art[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
  return art;
}

const anvilBin = () => {
  const p = path.join(ROOT, 'node_modules', '@foundry-rs', `anvil-${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`, 'bin', 'anvil');
  if (!fs.existsSync(p)) throw new Error(`anvil not found (${p}): run npm install`);
  return p;
};

/** A node already listening there would be used instead of a fresh one (with state from an earlier run): refuse. */
async function assertFree(port) {
  const busy = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: '{}' }).then(() => true, () => false);
  if (busy) throw new Error(`port ${port} is already in use (an Anvil left running by an earlier run?): stop it and retry`);
}

async function waitRpc(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not start`);
}

/** Starts the two nodes and deploys the contracts. Returns { networks: [{ ...net, rpc, usdc, dex?, bridge }], stop() }. */
export async function startEvm() {
  const art = compile();
  const procs = [];
  const nets = [];
  for (const n of NETWORKS) await assertFree(n.port);
  const stop = () => procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  // the nodes never outlive this process, even when it is interrupted
  process.once('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { stop(); process.exit(130); });
  for (const n of NETWORKS) {
    const p = spawn(anvilBin(), ['--port', String(n.port), '--chain-id', String(n.id), '--mnemonic', MNEMONIC, '--accounts', '10', '--balance', '10000', '--silent'], { stdio: 'ignore' });
    procs.push(p);
    const rpc = `http://127.0.0.1:${n.port}`;
    await waitRpc(rpc);
    const provider = new JsonRpcProvider(rpc, n.id, { staticNetwork: true });
    // one nonce counter for the deployer: Anvil mines at once, faster than ethers re-reads the account's nonce
    const deployer = new NonceManager(new Wallet(HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), `m/44'/60'/0'/0/${DEPLOYER}`).privateKey, provider));
    const deploy = async (name, ...args) => { const c = await new ContractFactory(art[name].abi, art[name].bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; };
    const usdc = await deploy('TestToken', 'USD Coin', 'USDC', 6);
    const bridge = await deploy('TestBridge');
    const net = { ...n, rpc, usdc: (await usdc.getAddress()).toLowerCase(), bridge: (await bridge.getAddress()).toLowerCase() };
    if (n.key === 'a') {
      const dex = await deploy('TestDex');
      const ETH = '0x0000000000000000000000000000000000000000', USDC = net.usdc;
      await (await dex.setRate(ETH, USDC, 3000n * 10n ** 6n)).wait(); // 1 ETH = 3,000 USDC
      await (await dex.setRate(USDC, ETH, (10n ** 30n) / 3000n)).wait(); // 1 USDC = 1/3,000 ETH
      net.dex = (await dex.getAddress()).toLowerCase();
      await (await deployer.sendTransaction({ to: net.dex, value: parseEther('100') })).wait(); // the DEX's liquidity
      await (await usdc.mint(net.dex, parseUnits('1000000', 6))).wait();
    }
    // the wallet under test (the phrase's first account) starts with 1,000 USDC on each network
    const user = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), "m/44'/60'/0'/0/0").address;
    await (await usdc.mint(user, parseUnits('1000', 6))).wait();
    net.abi = { token: art.TestToken.abi, dex: art.TestDex.abi, bridge: art.TestBridge.abi };
    nets.push(net);
  }
  return { networks: nets, deployerIndex: DEPLOYER, stop };
}

export const providerOf = (net) => new JsonRpcProvider(net.rpc, net.id, { staticNetwork: true });
export const tokenOf = (net, address = net.usdc) => new Contract(address, net.abi.token, providerOf(net));
