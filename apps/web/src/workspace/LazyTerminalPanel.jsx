import { lazy, Suspense } from 'react';
import { Section } from './PanelKit.jsx';

const TerminalPanel = lazy(() => import('./TerminalPanel.jsx'));

export default function LazyTerminalPanel(props) {
  return <Suspense fallback={<Section title={props.title}><div className="ws-loading" role="status"><span className="ws-spinner" />Terminal yükleniyor…</div></Section>}><TerminalPanel {...props} /></Suspense>;
}
