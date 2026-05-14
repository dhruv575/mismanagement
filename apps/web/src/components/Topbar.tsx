import { NavLink } from "react-router-dom";
import { MTSLogo } from "./MTSLogo.js";
import { TopbarLinks } from "./TopbarLinks.js";

export function Topbar() {
  return (
    <header className="topbar">
      <NavLink to="/" className="brand" aria-label="MTS Activist — home">
        <MTSLogo size={26} />
      </NavLink>
      <nav className="nav" aria-label="Primary">
        <NavLink to="/" end className="nav-link">Overview</NavLink>
        <NavLink to="/mismanagement" className="nav-link">Mismanagement</NavLink>
        <NavLink to="/activist-risk" className="nav-link">Activist risk</NavLink>
        <NavLink to="/comp" className="nav-link">Comp</NavLink>
        <NavLink to="/glossary" className="nav-link">Glossary</NavLink>
      </nav>
      <div className="topbar-right">
        <TopbarLinks />
      </div>
    </header>
  );
}
