import './styles.css';
import './chains/evm.js'; // the EVM driver (other families register from their platform module)
import { render } from 'preact';
import { App } from './app.jsx';

render(<App />, document.getElementById('app'));
