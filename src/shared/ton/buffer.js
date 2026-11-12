// The TON libraries use Node's Buffer: give the browser (Android WebView) one, before they load.
import { Buffer } from 'buffer';

if (!globalThis.Buffer) globalThis.Buffer = Buffer;
export { Buffer };
