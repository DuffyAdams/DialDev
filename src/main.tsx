/// <reference types="vite/client" />
import { createRoot } from 'react-dom/client';
import App from './App';
import { phone } from './lib/phone';
import './styles.css';
document.documentElement.dataset.platform = window.desktop?.platform ?? 'web';
// Development builds expose the engine for driving simulated calls from the console.
if (import.meta.env.DEV) Object.assign(window, { dialdev: phone });
createRoot(document.getElementById('root')!).render(<App />);
