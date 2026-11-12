// Predictions the user saved to keep an eye on: per account, kept only on this device. Saving also tells the
// "Per te" feed what the user cares about.
import { useEffect, useState } from 'preact/hooks';
import { ext, local } from '../shared/ext.js';
import { signal } from './predictTaste.js';

const key = (address) => `predictSaved:${String(address || '').toLowerCase()}`;
const MAX = 200;

/** [{ id, slug, title, image, at }] newest first */
export const savedList = (address) => local.get(key(address), []);

export async function toggleSaved(address, ev) {
  let added = false;
  await local.update(key(address), [], (l) => {
    if (l.some((x) => x.id === ev.id)) return l.filter((x) => x.id !== ev.id);
    added = true;
    return [{ id: ev.id, slug: ev.slug, title: ev.title, image: ev.image, at: Date.now() }, ...l].slice(0, MAX);
  });
  signal(address, ev, added ? 'save' : 'unsave');
  return added;
}

/** The saved list of the account, kept up to date (it changes from the feed, the event page...). */
export function useSaved(address) {
  const [list, setList] = useState([]);
  useEffect(() => {
    const k = key(address);
    savedList(address).then(setList);
    const f = (changes, area) => { if (area === 'local' && changes[k]) setList(changes[k].newValue || []); };
    ext.storage.onChanged.addListener(f);
    return () => ext.storage.onChanged.removeListener(f);
  }, [address]);
  return list;
}
