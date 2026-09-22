import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Legacy/auth base styles must precede the workspace skin.
import './styles.css';
import './server-cards.css';
import './domain-list.css';
import AuthGate from './AuthGate.jsx';
import App from './App.jsx';
import './workspace/ui/console-theme.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGate><App /></AuthGate>
  </StrictMode>,
);
