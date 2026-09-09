import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AuthGate from './AuthGate.jsx';
import './styles.css';
import './server-cards.css';
import './domain-list.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGate><App /></AuthGate>
  </StrictMode>,
);
