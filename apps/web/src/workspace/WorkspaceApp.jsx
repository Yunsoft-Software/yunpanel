import { createBrowserRouter, Navigate } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { usePanelSession } from '../panel-session.jsx';
import WorkspaceLayout from './WorkspaceLayout.jsx';
import DashboardPage from './DashboardPage.jsx';
import WebsitesPage from './WebsitesPage.jsx';
import NewWebsitePage from './NewWebsitePage.jsx';
import SiteDetailPage from './SiteDetailPage.jsx';
import FilesPage from './FilesPage.jsx';
import SiteToolEntryPage from './SiteToolEntryPage.jsx';
import ToolsSettingsPage from './ToolsSettingsPage.jsx';
import ApplicationsPage from './ApplicationsPage.jsx';
import AuditPage from './AuditPage.jsx';
import DatabasesPage from './DatabasesPage.jsx';
import DockerProjectsPage from './DockerProjectsPage.jsx';
import MailDomainsPage from './MailDomainsPage.jsx';
import ReadOnlyDashboardPage from './ReadOnlyDashboardPage.jsx';
import ReadOnlyWebsitesPage from './ReadOnlyWebsitesPage.jsx';
import ReadOnlySitePage from './ReadOnlySitePage.jsx';
import ReadOnlyServersPage from './ReadOnlyServersPage.jsx';
import { AdvancedDomainsPage, CapabilityPage, JobsPage, NotFoundPage, ServersPage, SettingsPage } from './OperationsPages.jsx';
import UsersPage from './UsersPage.jsx';
import ResellerCustomersPage from './ResellerCustomersPage.jsx';

function RouteFailure() {
  return <main className="ws-content"><h1>Sayfa yüklenemedi</h1><p>Beklenmeyen bir arayüz veya veri hatası oluştu. Sayfayı yeniden yükleyin; sorun sürerse API ve web sürümlerini birlikte kontrol edin.</p><button type="button" className="ws-button" onClick={() => window.location.reload()}>Yeniden yükle</button></main>;
}
function OwnerRoute({ children }) {
  const { isOwner } = usePanelSession();
  return isOwner ? children : <Navigate to="/websites" replace />;
}
function ResellerRoute({ children }) {
  const { isReseller } = usePanelSession();
  return isReseller ? children : <Navigate to="/websites" replace />;
}
function ManagementRoute({ children }) {
  const { canManage } = usePanelSession();
  return canManage ? children : <Navigate to="/dashboard" replace />;
}
function ScopedRoute({ management, readOnly }) {
  const { canManage } = usePanelSession();
  return canManage ? management : readOnly;
}
function GlobalSiteTool({ tool, ownerView }) {
  const { isOwner } = usePanelSession();
  // The site account enters its existing scoped tool, not the host-wide console.
  return isOwner ? ownerView : <SiteToolEntryPage tool={tool} />;
}
const owner = (element) => <OwnerRoute>{element}</OwnerRoute>;
const reseller = (element) => <ResellerRoute>{element}</ResellerRoute>;
const manage = (element) => <ManagementRoute>{element}</ManagementRoute>;
const scoped = (management, readOnly) => <ScopedRoute management={management} readOnly={readOnly} />;
function createWorkspaceRouter() {
  return createBrowserRouter([{
    element: <WorkspaceLayout />, errorElement: <RouteFailure />,
    children: [
      { index: true, element: <Navigate to="/websites" replace /> },
      { path: 'dashboard', element: scoped(<DashboardPage />, <ReadOnlyDashboardPage />) },
      { path: 'websites', element: scoped(<WebsitesPage />, <ReadOnlyWebsitesPage />) },
      { path: 'customers', element: reseller(<ResellerCustomersPage />) },
      { path: 'websites/new', element: manage(<NewWebsitePage />) },
      { path: 'websites/:websiteId/:tab?', element: scoped(<SiteDetailPage />, <ReadOnlySitePage />) },
      { path: 'files', element: manage(<FilesPage />) },
      { path: 'tools-settings', element: owner(<ToolsSettingsPage />) },
      { path: 'applications', element: owner(<ApplicationsPage />) },
      { path: 'applications/new', element: owner(<ApplicationsPage create />) },
      { path: 'domains', element: owner(<AdvancedDomainsPage />) },
      { path: 'servers', element: owner(<ServersPage />) },
      { path: 'databases', element: manage(<GlobalSiteTool tool="databases" ownerView={<DatabasesPage />} />) },
      { path: 'docker', element: manage(<DockerProjectsPage />) },
      { path: 'docker/:dockerProjectId', element: manage(<DockerProjectsPage />) },
      { path: 'mail', element: manage(<GlobalSiteTool tool="mail" ownerView={<MailDomainsPage />} />) },
      { path: 'mail/:mailDomainId', element: manage(<MailDomainsPage />) },
      { path: 'jobs', element: manage(<JobsPage />) },
      { path: 'audit', element: manage(<AuditPage />) },
      { path: 'settings', element: owner(<SettingsPage />) },
      { path: 'settings/users', element: owner(<UsersPage />) },
      { path: 'backups', element: owner(<CapabilityPage name="backups" />) },
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
