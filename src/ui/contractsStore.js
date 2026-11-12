// Contracts tab data kept on the device: recently opened contracts, saved ones (favourites and the ones deployed
// here, with their ABI), ABIs given by the user for unverified contracts, and Solidity projects (Android).
import { useEffect, useState } from 'preact/hooks';
import { local } from '../shared/ext.js';

const K = { recent: 'ct:recent', saved: 'ct:saved', abis: 'ct:abis', projects: 'ct:projects' };
const same = (a, chainId, address) => a.chainId === chainId && a.address.toLowerCase() === address.toLowerCase();
const subs = new Set();
const changed = () => subs.forEach((f) => f());

/** Re-renders when the store changes; returns { recent, saved, projects }. */
export function useContractsStore() {
  const [s, setS] = useState({ recent: [], saved: [], projects: [] });
  useEffect(() => {
    const load = async () => setS({ recent: await local.get(K.recent, []), saved: await local.get(K.saved, []), projects: await local.get(K.projects, []) });
    load();
    subs.add(load);
    return () => subs.delete(load);
  }, []);
  return s;
}

export async function addRecent(chainId, address, name) {
  await local.update(K.recent, [], (l) => [{ chainId, address, name: name || null, at: Date.now() }, ...l.filter((x) => !same(x, chainId, address))].slice(0, 20));
  changed();
}
export async function clearRecent() { await local.set(K.recent, []); changed(); }

/** Saved contract: { chainId, address, name, label?, mine?, abi?, txHash?, at }. */
export async function saveContract(entry) {
  await local.update(K.saved, [], (l) => {
    const old = l.find((x) => same(x, entry.chainId, entry.address));
    return [{ ...old, ...entry, at: old?.at || Date.now() }, ...l.filter((x) => !same(x, entry.chainId, entry.address))];
  });
  changed();
}
export async function unsaveContract(chainId, address) { await local.update(K.saved, [], (l) => l.filter((x) => !same(x, chainId, address))); changed(); }
export const savedEntry = async (chainId, address) => (await local.get(K.saved, [])).find((x) => same(x, chainId, address)) || null;

/** ABI for an unverified contract: the one given by the user, else the one kept when it was deployed here. */
export async function customAbi(chainId, address) {
  const m = await local.get(K.abis, {});
  return m[`${chainId}:${address.toLowerCase()}`] || (await savedEntry(chainId, address))?.abi || null;
}
export async function setCustomAbi(chainId, address, abi) {
  await local.update(K.abis, {}, (m) => { const n = { ...m }; const k = `${chainId}:${address.toLowerCase()}`; if (abi) n[k] = abi; else delete n[k]; return n; });
  changed();
}

// ------------------------------------------------------------ projects
/** Project: { id, name, files: { path: content }, main, settings: { version|'auto', optimizer, runs, evmVersion, viaIR, deps, remappings }, updated } */
export const getProject = async (id) => (await local.get(K.projects, [])).find((p) => p.id === id) || null;
export async function putProject(p) {
  const n = { ...p, updated: Date.now() };
  await local.update(K.projects, [], (l) => [n, ...l.filter((x) => x.id !== p.id)]);
  changed();
  return n;
}
export async function deleteProject(id) { await local.update(K.projects, [], (l) => l.filter((x) => x.id !== id)); changed(); }
export const newProjectId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
