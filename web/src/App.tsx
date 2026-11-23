import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, getToken, setToken, setUnauthorizedHandler } from './api';
import { AppContext, MANAGER_ROLES } from './context';
import type { Meta, TaskSummary, User } from './types';
import { TasksPage } from './pages/Tasks';
import { SupplyQualityPage } from './pages/SupplyQuality';
import { SupplyUploadPage } from './pages/SupplyUpload';
import { SupplyCompensationPage } from './pages/SupplyCompensation';
import { SupplyCompensationCscPage } from './pages/SupplyCompensationCsc';
import { CommercialCompensationPage } from './pages/CommercialCompensation';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { PendingPage } from './pages/Pending';
import { RequestsPage } from './pages/Requests';
import { NewRequestPage, lodgeableServices } from './pages/NewRequest';
import { RequestDetailPage } from './pages/RequestDetail';
import { ReportsPage } from './pages/Reports';
import { AdminPage } from './pages/Admin';

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [booting, setBooting] = useState(true);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setMeta(null);
  }, []);

  const reloadMeta = useCallback(async () => {
    setMeta(await api<Meta>('/meta'));
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!getToken()) {
      setBooting(false);
      return;
    }
    Promise.all([api<User>('/auth/me'), api<Meta>('/meta')])
      .then(([u, m]) => {
        setUser(u);
        setMeta(m);
      })
      .catch(() => logout())
      .finally(() => setBooting(false));
  }, [logout]);

  // Task counter in the sidebar: refreshed every minute and after any task change.
  const [taskSummary, setTaskSummary] = useState<TaskSummary | null>(null);
  const refreshTasks = useCallback(() => {
    api<TaskSummary>('/tasks/summary').then(setTaskSummary).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!user) return;
    refreshTasks();
    const t = setInterval(refreshTasks, 60_000);
    return () => clearInterval(t);
  }, [user, refreshTasks]);

  if (booting) return <div className="boot">Loading...</div>;
  if (!user || !meta) {
    return (
      <LoginPage
        onLogin={async (token, u) => {
          setToken(token);
          setMeta(await api<Meta>('/meta'));
          setUser(u);
        }}
      />
    );
  }

  const isManager = MANAGER_ROLES.includes(user.role) || user.role === 'BE';
  const roleLabel = meta.roles.find((r) => r.code === user.role)?.label ?? user.role;
  const canUploadSupply = ['ADMIN', 'CE', 'HENG', 'SDM'].includes(user.role);
  const canSeeSupply = isManager || canUploadSupply || user.role === 'CSS';
  const canSeeCompensation = ['ADMIN', 'GM', 'HENG', 'SDM', 'CE'].includes(user.role);
  const canSeeSupplyByCsc = canSeeCompensation || user.role === 'BM';

  return (
    <AppContext.Provider value={{ user, meta, logout, reloadMeta }}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark" aria-hidden>
              <svg viewBox="0 0 24 24" width="22" height="22"><path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor" /></svg>
            </div>
            <div>
              <div className="brand-title">LECO</div>
              <div className="brand-sub">Performance Standards</div>
            </div>
          </div>
          <nav>
            <div className="nav-section">Commercial quality</div>
            <NavLink to="/tasks" className="nav-tasks">
              My tasks
              {taskSummary && taskSummary.actionable > 0 && (
                <span className={`nav-count ${taskSummary.urgent ? 'urgent' : ''}`} title={`${taskSummary.urgent} urgent of ${taskSummary.actionable}`}>
                  {taskSummary.urgent || taskSummary.actionable}
                </span>
              )}
            </NavLink>
            <NavLink to="/dashboard">Dashboard</NavLink>
            <NavLink to="/pending">Pending services</NavLink>
            <NavLink to="/requests">Service requests</NavLink>
            {lodgeableServices(meta.services, user.role).length > 0 && <NavLink to="/requests/new">New request</NavLink>}
            {isManager && <NavLink to="/reports">Reports</NavLink>}
            {isManager && <NavLink to="/compensation">Compensation by CSC</NavLink>}
            {canSeeSupply && (
              <>
                <div className="nav-section">Supply quality</div>
                <NavLink to="/supply" end>SAIDI / SAIFI</NavLink>
                {canSeeCompensation && <NavLink to="/supply/compensation" end>Compensation</NavLink>}
                {canSeeSupplyByCsc && <NavLink to="/supply/compensation-by-csc">Compensation by CSC</NavLink>}
                {canUploadSupply && <NavLink to="/supply/upload">Data upload</NavLink>}
              </>
            )}
            {(user.role === 'ADMIN' || isManager) && (
              <>
                <div className="nav-section">Administration</div>
                <NavLink to="/admin">Targets &amp; setup</NavLink>
              </>
            )}
          </nav>
          <div className="sidebar-user">
            <div className="who">{user.fullName}</div>
            <div className="muted small">
              {roleLabel}
              {user.cscName ? ` - ${user.cscName}` : user.branchName ? ` - ${user.branchName}` : ''}
            </div>
            <button className="link" onClick={logout}>
              Sign out
            </button>
          </div>
        </aside>
        <main className="content">
          <Routes>
            <Route path="/" element={<Navigate to={isManager ? '/dashboard' : '/tasks'} replace />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/tasks" element={<TasksPage onChanged={refreshTasks} />} />
            <Route path="/pending" element={<PendingPage />} />
            <Route path="/requests" element={<RequestsPage />} />
            <Route path="/requests/new" element={<NewRequestPage />} />
            <Route path="/requests/:id" element={<RequestDetailPage onChanged={refreshTasks} />} />
            <Route path="/reports" element={isManager ? <ReportsPage /> : <Navigate to="/" />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/supply" element={canSeeSupply ? <SupplyQualityPage /> : <Navigate to="/" />} />
            <Route path="/supply/upload" element={canUploadSupply ? <SupplyUploadPage /> : <Navigate to="/" />} />
            <Route path="/supply/compensation" element={canSeeCompensation ? <SupplyCompensationPage /> : <Navigate to="/" />} />
            <Route path="/supply/compensation-by-csc" element={canSeeSupplyByCsc ? <SupplyCompensationCscPage /> : <Navigate to="/" />} />
            <Route path="/compensation" element={isManager ? <CommercialCompensationPage /> : <Navigate to="/" />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </AppContext.Provider>
  );
}
