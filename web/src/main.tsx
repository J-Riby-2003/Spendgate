import { useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import DecidePage from './pages/Decide';
import { LangProvider } from './lib/i18n';
import './index.css';

const match = location.pathname.match(/^\/decide\/(.+)$/);
createRoot(document.getElementById('root')!).render(
  <LangProvider>
    {match ? <DecidePage token={decodeURIComponent(match[1])} /> : <App />}
  </LangProvider>,
);

