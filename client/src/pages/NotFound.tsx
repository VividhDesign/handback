import { Link } from 'react-router-dom';
export function NotFound() {
  return (
    <div className="page narrow">
      <div className="card empty-state">
        <h2>Page not found</h2>
        <p>The link may be mistyped or expired.</p>
        <Link className="btn" to="/">Go home</Link>
      </div>
    </div>
  );
}
