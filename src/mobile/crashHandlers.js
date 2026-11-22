// Android (and later iOS): background and UI share one page, so errors are caught once for both, before either loads.
// The native side (CrashPlugin.java) hands over the crashes saved before the app last closed.
import { installCrashHandlers } from '../shared/crash.js';

installCrashHandlers('app');
