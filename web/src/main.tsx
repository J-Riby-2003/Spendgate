import { useEffect, useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { LangProvider } from './lib/i18n';
import './index.css';

createRoot(document.getElementById('root')!).render(<LangProvider><App /></LangProvider>);
