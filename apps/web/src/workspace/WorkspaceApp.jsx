import { createBrowserRouter, Navigate } from 'react-router';
import { RouterProvider } from 'react-router/dom';
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
function createWorkspaceRouter() {
  return createBrowserRouter([{
    element: <WorkspaceLayout />, errorElement: <RouteFailure />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'websites', element: <WebsitesPage /> },
      { path: 'websites/new', element: <NewWebsitePage /> },
      { path: 'websites/:websiteId/:tab?', element: <SiteDetailPage /> },
      { path: 'applications', element: <ApplicationsPage /> },
      { path: 'applications/new', element: <ApplicationsPage create /> },
      { path: 'domains', element: <AdvancedDomainsPage /> },
      { path: 'servers', element: <ServersPage /> },
      { path: 'jobs', element: <JobsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'settings/users', element: <UsersPage /> },
      ...['databases', 'docker', 'mail', 'backups', 'audit'].map((name) => ({ path: name, element: <CapabilityPage name={name} /> })),
      { path: '*', element: <NotFoundPage /> },
    ],
  }]);
}
// This SPA router holds URLs only: there are no route loaders, actions or
// protected data in its state. AuthGate decides whether RouterProvider mounts;
// the workspace's API effects do not run before authentication/Owner checks.
const router = typeof document === 'undefined' ? null : createWorkspaceRouter();
if (import.meta.hot) import.meta.hot.dispose(() => router?.dispose());
export default function WorkspaceApp() {
  return router ? <RouterProvider router={router} /> : null;
}
