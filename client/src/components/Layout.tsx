import { NavLink, Link, Outlet, useLocation } from 'react-router-dom';
import { Assistant } from './Assistant.tsx';

export function Layout() {
  const shop = useLocation().pathname.startsWith('/shop');
  return (
    <>
      <div className="banner">Sandbox demo. No real money.</div>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="wordmark">Handback</Link>
          <nav className="nav" aria-label="Main">
            <NavLink to="/rent">Rent</NavLink>
            <NavLink to="/shop" end>Desk</NavLink>
            <NavLink to="/shop/schedule">Schedule</NavLink>
            <NavLink to="/shop/insights">Insights</NavLink>
            <NavLink to="/shop/inventory">Inventory</NavLink>
            <NavLink to="/judge">Judge path</NavLink>
          </nav>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
      {shop && <Assistant />}
    </>
  );
}
