import { useState } from 'react';
import { post } from '../lib/api.ts';
import { useAction, useApi } from '../lib/hooks.ts';
import { money } from '../lib/format.ts';
import { Button, ErrorNotice, Loading, Notice } from '../components/ui.tsx';

const dollars = (c: number) => String(c / 100);
const cents = (s: string) => Math.round(Number(s) * 100);

export function Inventory() {
  const { data, error, loading, reload } = useApi<any>('/shop/items');
  if (loading && !data) return <div className="page"><Loading lines={8} /></div>;
  if (error) return <div className="page"><ErrorNotice error={error} /></div>;
  return (
    <div className="page stack">
      <div>
        <h1>Inventory</h1>
        <p className="muted">Prices, deposits and the rate card that every charge is computed from.</p>
      </div>
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Item</th><th>Daily fee</th><th>Deposit hold</th><th>Replacement value</th><th>Accessories</th><th /></tr></thead>
          <tbody>{data.items.map((it: any) => <ItemRow key={it.id} it={it} onSaved={reload} />)}</tbody>
        </table>
      </div>
      <RateCardEditor rc={data.rateCard} onSaved={reload} />
    </div>
  );
}

function ItemRow({ it, onSaved }: { it: any; onSaved: () => void }) {
  const [fee, setFee] = useState(dollars(it.daily_fee_cents));
  const [dep, setDep] = useState(dollars(it.deposit_cents));
  const [rep, setRep] = useState(dollars(it.replacement_value_cents));
  const [hint, setHint] = useState<any>(null);
  const act = useAction();
  const dirty = cents(fee) !== it.daily_fee_cents || cents(dep) !== it.deposit_cents || cents(rep) !== it.replacement_value_cents;
  return (
    <>
      <tr>
        <td><strong>{it.name}</strong><div className="faint">{it.category}{it.has_samples ? ' · has sample photos' : ''}</div></td>
        <td style={{ width: 120 }}><input type="number" min={1} value={fee} onChange={(e) => setFee(e.target.value)} aria-label={`${it.name} daily fee`} /></td>
        <td style={{ width: 130 }}><input type="number" min={20} max={500} value={dep} onChange={(e) => setDep(e.target.value)} aria-label={`${it.name} deposit`} /></td>
        <td style={{ width: 140 }}><input type="number" min={10} value={rep} onChange={(e) => setRep(e.target.value)} aria-label={`${it.name} replacement value`} /></td>
        <td className="small muted">{it.accessories.map((a: any) => `${a.name} (${money(a.list_price_cents)})`).join(', ') || '—'}</td>
        <td className="right" style={{ whiteSpace: 'nowrap' }}>
          <Button className="btn-sm" busy={act.busy === 'suggest'} onClick={() => act.run('suggest', async () => setHint(await post(`/shop/items/${it.id}/suggest`)))}>Suggest price</Button>{' '}
          <Button className="btn-sm btn-primary" disabled={!dirty} busy={act.busy === 'save'} onClick={() => act.run('save', async () => { await post(`/shop/items/${it.id}`, { daily_fee_cents: cents(fee), deposit_cents: cents(dep), replacement_value_cents: cents(rep) }); onSaved(); })}>Save</Button>
        </td>
      </tr>
      {(hint || act.error) && (
        <tr><td colSpan={6}>
          <ErrorNotice error={act.error} />
          {hint && (
            <div className="row small">
              <span>Suggested deposit <strong>{money(hint.depositCents)}</strong> from replacement {money(hint.replacementCents)}.</span>
              <span className="faint">Source: {hint.source}</span>
              <Button className="btn-sm" onClick={() => { setDep(dollars(hint.depositCents)); setRep(dollars(hint.replacementCents)); setHint(null); }}>Use it</Button>
            </div>
          )}
        </td></tr>
      )}
    </>
  );
}

const FIELDS: [string, string, 'pct' | 'cents' | 'int'][] = [
  ['minorPct', 'Minor damage, % of replacement', 'pct'], ['minorMinCents', 'Minor minimum (USD)', 'cents'], ['minorMaxCents', 'Minor maximum (USD)', 'cents'],
  ['moderatePct', 'Moderate damage, %', 'pct'], ['majorPct', 'Major damage, %', 'pct'], ['cleaningCents', 'Cleaning (USD)', 'cents'],
  ['lateGraceMinutes', 'Late grace (minutes)', 'int'], ['lateMaxDays', 'Late fee cap (days)', 'int'],
];

function RateCardEditor({ rc, onSaved }: { rc: any; onSaved: () => void }) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map(([k, , t]) => [k, t === 'cents' ? dollars(rc[k]) : String(rc[k])])));
  const [saved, setSaved] = useState(false);
  const act = useAction();
  const save = () => act.run('save', async () => {
    await post('/shop/rate-card', Object.fromEntries(FIELDS.map(([k, , t]) => [k, t === 'cents' ? cents(v[k]) : Number(v[k])])));
    setSaved(true);
    onSaved();
  });
  return (
    <div className="card stack-sm">
      <h2>Rate card</h2>
      <p className="small muted">Damage is priced from the item's replacement value; missing accessories from market or list price. Charges never exceed the hold.</p>
      <div className="grid grid-3">
        {FIELDS.map(([k, label]) => <label key={k}>{label}<input type="number" min={0} value={v[k]} onChange={(e) => { setSaved(false); setV({ ...v, [k]: e.target.value }); }} /></label>)}
      </div>
      <ErrorNotice error={act.error} />
      {saved && <Notice tone="ok">Rate card saved. New findings use it.</Notice>}
      <div><Button className="btn-primary" busy={act.busy === 'save'} onClick={save}>Save rate card</Button></div>
    </div>
  );
}
