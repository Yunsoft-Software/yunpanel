import WorkspaceApp from './workspace/WorkspaceApp.jsx';
import './workspace/legacy-bridge.css';

// Authentication, MFA enrollment and account sessions remain owned by AuthGate
// in main.jsx. This component contains management UI, not a second auth boundary.
export default function App() {
  return <WorkspaceApp />;
}
