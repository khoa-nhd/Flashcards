import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { registerServiceWorker } from './lib/offline/service-worker.js';
// Bundled, not fetched: the app keeps working offline, Vietnamese included.
import '@fontsource/public-sans/latin-400.css';
import '@fontsource/public-sans/latin-500.css';
import '@fontsource/public-sans/latin-600.css';
import '@fontsource/public-sans/vietnamese-400.css';
import '@fontsource/public-sans/vietnamese-500.css';
import '@fontsource/public-sans/vietnamese-600.css';
import '@fontsource/source-serif-4/latin-400.css';
import '@fontsource/source-serif-4/latin-600.css';
import '@fontsource/source-serif-4/vietnamese-400.css';
import '@fontsource/source-serif-4/vietnamese-600.css';
import './index.css';

registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
