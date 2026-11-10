import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../lib/api.ts';
import { useAction, useApi } from '../lib/hooks.ts';
import { date, money, duration } from '../lib/format.ts';
import { Button, ErrorNotice, Loading, ModeTag, Notice, StateBadge } from '../components/ui.tsx';
import { PhotoStrip } from '../components/Photos.tsx';
import { FindingRow } from '../components/Findings.tsx';

const SETTLED = ['settled_clean', 'settled_charged', 'contested', 'refunded', 'contest_denied'];

export function Judge() {
  const cfg = useApi<any>('/config');
  const items = useApi<any>('/items');
  const real = useApi<any>('/shop/bookings?sample=0');
  const runs = (real.data?.bookings ?? []).filter((b: any) => SETTLED.includes(b.state)).slice(0, 6);
  const withSamples = useMemo(() => (items.data?.items ?? []).filter((i: any) => i.sampleSets.includes('pickup')), [items.data]);

  return (
    <div className="page narrow stack">
      <div>
        <h1>The 60-second judge path</h1>
        <p className="lead">Everything runs against the PayPal sandbox. Nothing here moves real money.</p>
      </div>

      <div className="card stack-sm">
        <h2>What is live, cached or sample</h2>
        <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
          <li><strong>PayPal:</strong> {cfg.data?.paypalConfigured ? 'live sandbox calls (Orders v2 authorize, capture, void, refund; verified webhooks).' : 'sandbox keys are not configured on this server yet.'}</li>
          <li><strong>AI:</strong> {cfg.data?.liveAi ? `live (${cfg.data.visionModel}); when the daily cap is reached, a recorded result is shown with a "cached" label.` : 'recorded results only, each labelled "cached".'}</li>
          <li><strong>History:</strong> rows marked <em>sample</em> are synthetic and never touched PayPal. Real completed rentals are listed below with their PayPal ids.</li>
        </ul>
      </div>

      <div className="card stack-sm">
        <h2>1. No login (about 60 s)</h2>
        <p className="small muted">Open a real settled rental's evidence page, then run a dry-run inspection on sample photos.</p>
        {real.loading && !real.data ? <Loading /> : runs.length ? (
          <table>
            <tbody>
              {runs.map((b: any) => (
                <tr key={b.id}>
                  <td><strong>{b.code}</strong> <span className="muted small">{b.item_name}</span></td>
                  <td><StateBadge state={b.state} /></td>
                  <td className="small muted">{date(b.end_at)}{b.release_ms != null && b.state === 'settled_clean' ? ` · released in ${duration(b.release_ms)}` : ''}</td>
                  <td className="small">captured {money(b.captured_cents)}</td>
                  <td className="right"><Link to={`/e/${b.public_token}`}>Evidence →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Notice tone="warn">No real sandbox rental is settled on this server yet. They appear here after the first approval session.</Notice>}
        <DryRun items={withSamples} />
      </div>

      <div className="card stack-sm">
        <h2>2. With the sandbox buyer login (about 2 min)</h2>
        <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
          <li><Link to="/rent">Rent</Link> an item and approve the hold in the PayPal sandbox. The buyer login is in the Devpost "Testing instructions" field.</li>
          <li>Open the <Link to="/shop">Desk</Link>, select your booking, press <em>Pickup: sample</em>.</li>
          <li>Press <em>Return: clean</em>. Watch "Deposit released in N s" and the live ledger.</li>
          <li>Open the evidence page. Repeat with <em>Return: damaged</em> to approve a charge as the owner.</li>
        </ol>
      </div>
    </div>
  );
}

function DryRun({ items }: { items: any[] }) {
  const [itemId, setItemId] = useState<number | null>(null);
  const [res, setRes] = useState<any>(null);
  const act = useAction();
  const it = items.find((i) => i.id === itemId) ?? items[0];
  if (!items.length) return <p className="faint">Dry run: sample photos are not on this server yet.</p>;
  const go = (set: string) => act.run(set, async () => setRes(await post('/dry-run/inspect', { itemId: it.id, set })));
  const cmp = res?.ai?.compare;
  return (
    <div className="stack-sm" style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 8 }}>
      <div className="row between">
        <h3>Dry run on sample photos</h3>
        {items.length > 1 && (
          <select style={{ width: 'auto' }} value={it.id} onChange={(e) => { setItemId(Number(e.target.value)); setRes(null); }}>
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        )}
      </div>
      <div className="row">
        {it.sampleSets.includes('return-damaged') && <Button className="btn-primary" busy={act.busy === 'return-damaged'} disabled={!!act.busy} onClick={() => go('return-damaged')}>Dry run: damaged return</Button>}
        {it.sampleSets.includes('return-clean') && <Button busy={act.busy === 'return-clean'} disabled={!!act.busy} onClick={() => go('return-clean')}>Dry run: clean return</Button>}
        {it.sampleSets.includes('return-reupload') && <Button busy={act.busy === 'return-reupload'} disabled={!!act.busy} onClick={() => go('return-reupload')}>Dry run: re-uploaded photos</Button>}
      </div>
      <ErrorNotice error={act.error} />
      {res && (
        <div className="stack-sm">
          <Notice>{res.label}</Notice>
          <div className="row">
            <strong>Decision: {res.decision.replace('_', ' ')}</strong>
            {res.ai && <ModeTag mode={res.ai.mode} model={res.ai.model} cachedAt={res.ai.cachedAt} />}
            {res.ai?.mode === 'live' && <span className="faint">{(res.ai.latencyMs / 1000).toFixed(1)} s</span>}
          </div>
          <p className="small"><strong>PayPal call that would follow:</strong> <span className="mono">{res.wouldCall}</span></p>
          {res.checks.filter((c: any) => !c.passed).map((c: any) => <Notice key={c.name} tone={c.blocking ? 'error' : 'warn'}>Check "{c.name}" failed: {c.detail}</Notice>)}
          {res.photos && (
            <>
              <PhotoStrip title="Pickup (sample)" src={(a) => `${res.photos.pickup}/${a}`} available={[1, 2, 3, 4, 5]}
                marks={(res.ai?.passport?.existing_marks ?? []).map((m: any) => ({ angle: m.photo_index, box: m.box_2d, label: m.description, old: true }))} />
              <PhotoStrip title="Return (sample)" src={(a) => `${res.photos.ret}/${a}`} available={[1, 2, 3, 4, 5]}
                marks={(cmp?.findings ?? []).map((f: any) => ({ angle: f.return_photo_index, box: f.box_2d, label: f.description, old: !!f.existing_mark_id }))} />
            </>
          )}
          {cmp && <p className="small"><strong>AI:</strong> {cmp.overall.summary}</p>}
          {cmp?.findings?.map((f: any, i: number) => <FindingRow key={i} f={{ ...f, photo_index: f.return_photo_index, proposed_cents: null, price_source: 'priced from the rate card in a real return' }} />)}
        </div>
      )}
    </div>
  );
}
