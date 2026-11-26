import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AuthGate from './AuthGate.jsx';
import App from './App.jsx';
// The single design system loads last so it styles the feature files imported above.
import './workspace/design-system/theme.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGate><App /></AuthGate>
  </StrictMode>,
);
