import './styles.css';
import './chains/evm.js'; // the EVM driver (other families register from their platform module)
import { render } from 'preact';
import { App } from './app.jsx';
import { CrashBoundary } from './crash.jsx';
import { installCrashHandlers } from '../shared/crash.js';

installCrashHandlers('ui'); // Android: already installed by the app entry (src/mobile/index.jsx) for the whole page
render(<CrashBoundary><App /></CrashBoundary>, document.getElementById('app'));
