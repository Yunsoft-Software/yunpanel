import { createBrowserRouter, Navigate } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { usePanelSession } from '../panel-session.jsx';
import WorkspaceLayout from './WorkspaceLayout.jsx';
import DashboardPage from './DashboardPage.jsx';
import WebsitesPage from './WebsitesPage.jsx';
import NewWebsitePage from './NewWebsitePage.jsx';
import SiteDetailPage from './SiteDetailPage.jsx';
import ApplicationsPage from './ApplicationsPage.jsx';
import { AdvancedDomainsPage, CapabilityPage, JobsPage, NotFoundPage, ServersPage, SettingsPage } from './OperationsPages.jsx';
import UsersPage from './UsersPage.jsx';

function RouteFailure() {
  return <main className="ws-content"><h1>Sayfa yüklenemedi</h1><p>Beklenmeyen bir arayüz veya veri hatası oluştu. Sayfayı yeniden yükleyin; sorun sürerse API ve web sürümlerini birlikte kontrol edin.</p><button type="button" className="ws-button" onClick={() => window.location.reload()}>Yeniden yükle</button></main>;
}
function ManagementRoute({ children }) {
  const { canManage } = usePanelSession();
  return canManage ? children : <Navigate to="/dashboard" replace />;
}
const manage = (element) => <ManagementRoute>{element}</ManagementRoute>;
function createWorkspaceRouter() {
  return createBrowserRouter([{
    element: <WorkspaceLayout />, errorElement: <RouteFailure />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'websites', element: <WebsitesPage /> },
      { path: 'websites/new', element: manage(<NewWebsitePage />) },
      { path: 'websites/:websiteId/:tab?', element: <SiteDetailPage /> },
      { path: 'applications', element: manage(<ApplicationsPage />) },
      { path: 'applications/new', element: manage(<ApplicationsPage create />) },
      { path: 'domains', element: manage(<AdvancedDomainsPage />) },
      { path: 'servers', element: <ServersPage /> },
      { path: 'jobs', element: manage(<JobsPage />) },
      { path: 'settings', element: manage(<SettingsPage />) },
      { path: 'settings/users', element: manage(<UsersPage />) },
      ...['databases', 'docker', 'mail', 'backups', 'audit'].map((name) => ({ path: name, element: manage(<CapabilityPage name={name} />) })),
      { path: '*', element: <NotFoundPage /> },
    ],
  }]);
}
// This SPA router holds URLs only: there are no route loaders, actions or
// protected data in its state. AuthGate mounts it only after server-derived access is known;
// route guards improve UX while the API remains the authorization boundary.
const router = typeof document === 'undefined' ? null : createWorkspaceRouter();
if (import.meta.hot) import.meta.hot.dispose(() => router?.dispose());
export default function WorkspaceApp() {
  return router ? <RouterProvider router={router} /> : null;
}
