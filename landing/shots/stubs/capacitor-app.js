export const App = {
  addListener: () => Promise.resolve({ remove: () => {} }),
  exitApp: () => {},
  getInfo: () => Promise.resolve({ version: '1.0.0', build: '128' }),
};
