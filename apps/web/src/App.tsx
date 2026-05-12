import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { Topbar } from "./components/Topbar.js";
import { HomePage } from "./pages/HomePage.js";
import { MismanagementPage } from "./pages/MismanagementPage.js";
import { ScreenPage } from "./pages/ScreenPage.js";
import { CompanyPage } from "./pages/CompanyPage.js";
import { CompPage } from "./pages/CompPage.js";
import { GlossaryPage } from "./pages/GlossaryPage.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";

function ShellLayout() {
  return (
    <div className="shell">
      <Topbar />
      <main className="main">
        <Outlet />
      </main>
      <footer className="site-foot">
        <span>
          Sources: SEC EDGAR, Yahoo Finance. The schema captures{" "}
          <em>facts</em>; characterization is the reader's job.
        </span>
        <span>
          Built by{" "}
          <a href="https://www.mts.now/" target="_blank" rel="noopener noreferrer">MTS</a>
        </span>
      </footer>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<ShellLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/mismanagement" element={<MismanagementPage />} />
        {/* Old /screen route -> /mismanagement so bookmarks redirect. */}
        <Route path="/screen" element={<Navigate to="/mismanagement" replace />} />
        <Route path="/screen-raw" element={<ScreenPage />} />
        <Route path="/company/:ticker" element={<CompanyPage />} />
        <Route path="/comp" element={<CompPage />} />
        <Route path="/glossary" element={<GlossaryPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
