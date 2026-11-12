// Minimal `process` for browser bundles of Node-oriented libraries.
const proc = { cwd: () => '/', env: {}, platform: 'browser', argv: [], versions: {}, nextTick: (f, ...a) => Promise.resolve().then(() => f(...a)) };
export const { cwd, env, platform, argv, versions, nextTick } = proc;
export default proc;
