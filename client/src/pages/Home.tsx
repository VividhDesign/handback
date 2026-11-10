import { Link } from 'react-router-dom';

export function Home() {
  return (
    <div className="page narrow">
      <section className="hero">
        <h1 style={{ fontSize: 40 }}>The AI return desk for rental deposits.</h1>
        <p className="lead">The deposit is a PayPal hold. AI compares the pickup and return photos, then releases the hold in seconds, or shows the owner the evidence for a charge they approve.</p>
        <div className="row" style={{ marginTop: 24 }}>
          <Link className="btn btn-primary" to="/judge">Run the demo</Link>
          <Link className="btn" to="/shop">Open the shop console</Link>
        </div>
      </section>
      <section className="card">
        <h2>Three rules</h2>
        <ol className="rules">
          <li><strong>AI may release money on its own. AI may never take money on its own.</strong></li>
          <li>Deterministic checks first, AI where judgment is needed, a human when the AI is unsure.</li>
          <li>Charges come from a visible rate card and market prices, never from a guess.</li>
        </ol>
        <p className="faint">One booking, one PayPal authorization, one final capture. Clean returns capture only the rental fee and the rest of the hold is released.</p>
      </section>
    </div>
  );
}
