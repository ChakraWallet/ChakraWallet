// Stand-in for @capacitor/app. A test can open the app "with a link" (globalThis.__e2eOpenUrl), as Android does.
const urlListeners = [];
globalThis.__e2eOpenUrl = (url) => urlListeners.forEach((fn) => fn({ url }));
export const App = {
  addListener: (event, fn) => { if (event === 'appUrlOpen') urlListeners.push(fn); return Promise.resolve({ remove: () => {} }); },
  getLaunchUrl: () => Promise.resolve(undefined),
  exitApp: () => {},
  getInfo: () => Promise.resolve({ version: '1.0.0', build: '128' }),
};
