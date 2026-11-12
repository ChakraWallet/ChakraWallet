// Minimal browser globals the Android shim touches at load time.
globalThis.window = globalThis;
globalThis.document ??= { addEventListener() {} };
window.addEventListener ??= () => {};
window.dispatchEvent ??= () => {};
globalThis.CustomEvent ??= class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };
globalThis.Event ??= class { constructor(t) { this.type = t; } };
