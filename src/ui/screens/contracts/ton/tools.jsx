// TON tools of the Contracts home: the cell reader (paste a BoC, see it field by field: operation, query id, text,
// addresses, references).
import { useState } from 'preact/hooks';
import { Sheet } from '../../../components.jsx';
import { t } from '../../../../shared/i18n.js';
import { describeCell, parseBoc } from '../../../../shared/ton/cells.js';
import { CellTree } from './parts.jsx';
import { errText } from './write.jsx';

export function TonCellSheet({ onClose }) {
  const [boc, setBoc] = useState('');
  const [tree, setTree] = useState(null);
  const [err, setErr] = useState('');
  const read = () => {
    setErr(''); setTree(null);
    try { setTree(describeCell(parseBoc(boc))); } catch (e) { setErr(errText(e)); }
  };
  return (
    <Sheet title={t('tonc.inspect.cellReader')} onClose={onClose}>
      <span class="small muted">{t('tonc.inspect.cellReaderHint')}</span>
      <textarea class="input mono" rows={4} value={boc} placeholder={t('tonc.ft.bocHint')} spellcheck={false} autocapitalize="off" onInput={(e) => setBoc(e.target.value)} />
      <button class="btn secondary sm" disabled={!boc.trim()} onClick={read}>{t('tonc.cell.read')}</button>
      {err && <div class="error">{err}</div>}
      {tree && <CellTree node={tree} />}
    </Sheet>
  );
}
