import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, post } from '../lib/api.ts';
import { useAction, useApi } from '../lib/hooks.ts';
import { date, dateTime, duration, money, relative } from '../lib/format.ts';
import { stepIndex } from '../lib/states.ts';
import { Button, Empty, ErrorNotice, Loading, ModeTag, MoneyLine, Notice, PayPalIds, SampleTag, StateBadge, Stepper } from '../components/ui.tsx';
import { PhotoCompare } from '../components/Photos.tsx';
import { FindingRow } from '../components/Findings.tsx';
import { Ledger } from '../components/Ledger.tsx';

const ACTIVE = ['pending_approval', 'authorized', 'picked_up', 'inspecting', 'blocked', 'needs_review', 'settling', 'contested'];

export function Desk() {
  const [params, setParams] = useSearchParams();
  const [showSamples, setShowSamples] = useState(false);
  const list = useApi<any>(`/shop/bookings?sample=${showSamples ? 'all' : '0'}`, [showSamples]);
  const selected = Number(params.get('b')) || null;
  const select = (id: number) => setParams({ b: String(id) }, { replace: true });

  useEffect(() => {
    const t = setInterval(list.reload, 8000);
    return () => clearInterval(t);
  }, [list.reload]);

  const rows: any[] = list.data?.bookings ?? [];
  const active = rows.filter((r) => ACTIVE.includes(r.state));
  const done = rows.filter((r) => !ACTIVE.includes(r.state));

  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1>Desk</h1>
          <p className="muted">Pickups, returns and settlements. Demo console: open to everyone, sample rows are read-only.</p>
        </div>
        <label className="row small" style={{ gap: 6, color: 'var(--muted)' }}>
          <input type="checkbox" style={{ width: 16, minHeight: 0 }} checked={showSamples} onChange={(e) => setShowSamples(e.target.checked)} /> Show sample history
        </label>
      </div>
      <div className="grid split split-desk" style={{ marginTop: 16 }}>
        <div className="stack">
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '16px 16px 8px' }}><h3>Open ({active.length})</h3></div>
            {list.loading && !list.data ? <div style={{ padding: 16 }}><Loading /></div> : (
              <BookingTable rows={active} selected={selected} onSelect={select} empty={<>No open bookings. <Link to="/rent">Book an item</Link> to start one.</>} />
            )}
          </div>
          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '16px 16px 8px' }}><h3>Settled and closed ({done.length})</h3></div>
            <BookingTable rows={done} selected={selected} onSelect={select} empty="Nothing settled yet." />
          </div>
        </div>
        <div className="stack">
          {selected ? <BookingPanel key={selected} id={selected} onChange={list.reload} /> : (
            <div className="card"><Empty>Select a booking to run pickup, return and settlement.</Empty></div>
          )}
          <Ledger />
        </div>
      </div>
    </div>
  );
}

function BookingTable({ rows, selected, onSelect, empty }: { rows: any[]; selected: number | null; onSelect: (id: number) => void; empty: React.ReactNode }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div style={{ maxHeight: 440, overflow: 'auto' }}>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`clickable${r.id === selected ? ' selected' : ''}`} onClick={() => onSelect(r.id)}>
              <td>
                <div className="row" style={{ gap: 6 }}><strong>{r.code}</strong>{r.is_sample ? <SampleTag /> : null}</div>
                <div className="small muted">{r.item_name} · {r.customer_name}</div>
              </td>
              <td className="right">
                <StateBadge state={r.state} />
                <div className="faint">{date(r.start_at)}–{date(r.end_at)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BookingPanel({ id, onChange }: { id: number; onChange: () => void }) {
  const { data, setData, error, loading, reload } = useApi<any>(`/shop/bookings/${id}`);
  const act = useAction();

  useEffect(() => {
    if (!['inspecting', 'settling', 'pending_approval'].includes(data?.booking?.state)) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [data?.booking?.state, reload]);

  const step = async (name: string, fn: () => Promise<any>) => {
    const r = await act.run(name, fn);
    if (r) setData(r);
    onChange();
    return r;
  };

  if (loading && !data) return <div className="card"><Loading lines={6} /></div>;
  if (error) return <div className="card"><ErrorNotice error={error} /></div>;
  const { booking: b, item, photos, findings, inspections, payments, settlement, contests, sampleSets } = data;
  const sample = !!b.is_sample;
  const has = (s: string) => sampleSets.includes(s);
  const lastReturn = [...inspections].reverse().find((i: any) => i.phase === 'return');
  const passport = [...inspections].reverse().find((i: any) => i.phase === 'pickup');

  const samplePickup = () => step('pickup', async () => {
    await post(`/shop/bookings/${id}/photos?phase=pickup`, { sampleSet: 'pickup' });
    return post(`/shop/bookings/${id}/pickup`);
  });
  const sampleReturn = (set: string) => step(set, async () => {
    await post(`/shop/bookings/${id}/photos?phase=return`, { sampleSet: set });
    return post(`/shop/bookings/${id}/return`);
  });

  return (
    <div className="stack">
      <div className="card stack-sm">
        <div className="row between">
          <div>
            <div className="faint">{b.code} · {b.customer_name}{b.customer_email ? ` · ${b.customer_email}` : ''}</div>
            <h2>{item.name}</h2>
            <div className="small muted">{dateTime(b.start_at)} → {dateTime(b.end_at)}</div>
          </div>
          <div className="row">{sample && <SampleTag />}<StateBadge state={b.state} /></div>
        </div>
        <Stepper index={stepIndex(b.state)} />
        {sample && <Notice>Sample history row. It never touched PayPal, so money buttons are hidden.</Notice>}
        <ErrorNotice error={act.error} />

        {!sample && b.state === 'pending_approval' && <Notice>Waiting for the customer to approve in PayPal. The slot expires {relative(b.tentative_expires_at)}.</Notice>}

        {!sample && b.state === 'authorized' && (
          <div className="stack-sm">
            <Notice tone="info">Hold of {money(b.authorized_cents)} is in place. Take five photos at pickup; AI writes the condition passport.</Notice>
            <div className="row">
              {has('pickup') && <Button className="btn-primary" busy={act.busy === 'pickup'} disabled={!!act.busy} onClick={samplePickup}>Pickup: sample</Button>}
              <PhotoUpload id={id} phase="pickup" disabled={!!act.busy} onDone={() => step("pickup", () => post(`/shop/bookings/${id}/pickup`))} />
              <Button className="btn-danger" busy={act.busy === 'cancel'} disabled={!!act.busy} onClick={() => confirm('Cancel and void the hold?') && step('cancel', () => post(`/shop/bookings/${id}/cancel`))}>Cancel and void</Button>
            </div>
          </div>
        )}

        {!sample && ['picked_up', 'blocked'].includes(b.state) && (
          <div className="stack-sm">
            {b.state === 'blocked' && <Notice tone="error">A deterministic check failed: {lastReturn?.reasons?.join('; ') || 'photos must be re-shot'}. The hold is unchanged. Re-shoot the return photos.</Notice>}
            <Notice tone="info">Return: plain checks run first, then AI compares pickup and return. A clean, confident return releases the deposit automatically.</Notice>
            <div className="row">
              {has('return-clean') && <Button className="btn-primary" busy={act.busy === 'return-clean'} disabled={!!act.busy} onClick={() => sampleReturn('return-clean')}>Return: clean</Button>}
              {has('return-damaged') && <Button busy={act.busy === 'return-damaged'} disabled={!!act.busy} onClick={() => sampleReturn('return-damaged')}>Return: damaged</Button>}
              {has('return-reupload') && <Button busy={act.busy === 'return-reupload'} disabled={!!act.busy} onClick={() => sampleReturn('return-reupload')}>Return: pickup photos re-uploaded</Button>}
              <PhotoUpload id={id} phase="return" disabled={!!act.busy} onDone={() => step('return', () => post(`/shop/bookings/${id}/return`))} />
            </div>
            {!sampleSets.length && <p className="faint">This item has no sample photos; use your own five photos.</p>}
          </div>
        )}

        {b.state === 'inspecting' && <Notice tone="info">Inspecting the return…</Notice>}
        {b.state === 'settling' && <Notice tone="info">Capturing with PayPal…</Notice>}
        {b.state === 'settled_clean' && (
          <Notice tone="ok"><strong>Deposit released{b.release_ms != null ? ` in ${duration(b.release_ms)}` : ''}.</strong> Captured {money(b.captured_cents)} (rental fee), released {money(b.released_cents)}.</Notice>
        )}
        {b.state === 'settled_charged' && <Notice tone="warn">Captured {money(b.captured_cents)}, released {money(b.released_cents)}.</Notice>}
        {['settled_clean', 'settled_charged', 'contested', 'refunded', 'contest_denied'].includes(b.state) && (
          <div className="row"><Link className="btn" to={`/e/${b.public_token}`}>Evidence page</Link><Link className="btn" to={`/booking/${b.public_token}`}>Customer view</Link></div>
        )}
      </div>

      {(photos.length > 0 || passport) && (
        <div className="card stack">
          <div className="row between">
            <h3>Photos</h3>
            <div className="row">{lastReturn && lastReturn.mode !== 'manual' && <ModeTag mode={lastReturn.mode} model={lastReturn.model} cachedAt={lastReturn.cached_at} />}</div>
          </div>
          {photos.length > 0 && <PhotoCompare token={b.public_token} photos={photos} findings={findings} passport={passport?.result} />}
          {passport?.result && (
            <details>
              <summary>Condition passport: {passport.result.existing_marks?.length ?? 0} existing mark(s), {passport.result.accessories?.filter((a: any) => a.present).length ?? 0} accessories present</summary>
              <ul className="small">
                {passport.result.existing_marks?.map((m: any) => <li key={m.id}><span className="mono">{m.id}</span> {m.part}: {m.description} ({m.severity}, photo {m.photo_index})</li>)}
                {passport.result.accessories?.map((a: any) => <li key={a.name}>{a.present ? '✓' : '✗'} {a.name}</li>)}
              </ul>
              <p className="faint">{passport.result.summary}</p>
            </details>
          )}
          {lastReturn?.result?.overall && <p className="small"><strong>AI:</strong> {lastReturn.result.overall.summary} <span className="faint">({lastReturn.result.overall.verdict} {Number(lastReturn.result.overall.confidence).toFixed(2)}{lastReturn.latency_ms ? `, ${(lastReturn.latency_ms / 1000).toFixed(1)} s` : ''})</span></p>}
          {lastReturn?.reasons?.length > 0 && b.state === 'needs_review' && <p className="small muted">Why review: {lastReturn.reasons.join('; ')}</p>}
        </div>
      )}

      {(findings.length > 0 || b.state === 'needs_review') && (
        <div className="card stack-sm">
          <h3>Findings</h3>
          {findings.map((f: any) => (
            <FindingRow key={f.id} f={f} actions={!sample && b.state === 'needs_review' && !f.existing_mark_id ? (
              <div className="row">
                <Button className={`btn-sm${f.decision === 'approved' ? ' btn-primary' : ''}`} disabled={!!act.busy} onClick={() => step(`f${f.id}`, () => post(`/shop/findings/${f.id}/decision`, { decision: 'approved' }))}>Approve</Button>
                <Button className={`btn-sm${f.decision === 'waived' ? ' btn-primary' : ''}`} disabled={!!act.busy} onClick={() => step(`f${f.id}`, () => post(`/shop/findings/${f.id}/decision`, { decision: 'waived' }))}>Waive</Button>
              </div>
            ) : null} />
          ))}
          {!sample && b.state === 'needs_review' && <ManualFinding item={item} onAdd={(body) => step('manual', () => post(`/shop/bookings/${id}/findings`, body))} busy={act.busy === 'manual'} />}
        </div>
      )}

      {!sample && b.state === 'needs_review' && settlement && (
        <div className="card stack-sm">
          <h3>Settle</h3>
          <MoneyLine label="Rental fee" cents={settlement.feeCents} />
          <MoneyLine label="Approved charges" cents={settlement.chargesCents} />
          <MoneyLine label="Capture now (final)" cents={settlement.captureCents} total />
          <MoneyLine label="Released to the customer" cents={settlement.releasedCents} />
          {settlement.excessCents > 0 && <Notice tone="warn">{money(settlement.excessCents)} is above the hold. After settling, the agent can draft an invoice for it.</Notice>}
          {settlement.pending > 0 && <p className="faint">Approve or waive {settlement.pending} more finding(s) first.</p>}
          <Button className="btn-primary" busy={act.busy === 'settle'} disabled={settlement.pending > 0 || !!act.busy}
            onClick={() => confirm(`Capture ${money(settlement.captureCents)} and release ${money(settlement.releasedCents)}? This is one final capture.`) && step('settle', () => post(`/shop/bookings/${id}/settle`))}>
            Capture {money(settlement.captureCents)} and release {money(settlement.releasedCents)}
          </Button>
        </div>
      )}

      {!sample && b.excess_cents > 0 && <ExcessInvoice id={id} />}
      {contests.filter((c: any) => c.state === 'open').map((c: any) => <ContestPanel key={c.id} c={c} onDone={(d) => { setData(d); onChange(); }} />)}

      <div className="card">
        <h3>PayPal</h3>
        <PayPalIds payments={payments} />
      </div>
    </div>
  );
}

function PhotoUpload({ id, phase, disabled, onDone }: { id: number; phase: 'pickup' | 'return'; disabled?: boolean; onDone: (d: any) => void }) {
  const [files, setFiles] = useState<(File | null)[]>([null, null, null, null, null]);
  const [open, setOpen] = useState(false);
  const act = useAction();
  const labels = ['Front', 'Back', 'Left', 'Right', 'With accessories'];
  const ready = files.every(Boolean);
  async function upload() {
    const fd = new FormData();
    files.forEach((f, i) => { fd.append('photos', f as File); fd.append('angles', String(i + 1)); });
    const d = await act.run('upload', () => api(`/shop/bookings/${id}/photos?phase=${phase}`, { method: 'POST', form: fd }));
    if (d) { setOpen(false); onDone(d); }
  }
  if (!open) return <Button disabled={disabled} onClick={() => setOpen(true)}>Take 5 photos</Button>;
  return (
    <div className="card stack-sm" style={{ width: '100%', boxShadow: 'none' }}>
      <div className="row between"><strong>{phase === 'pickup' ? 'Pickup' : 'Return'} photos</strong><button className="btn btn-sm" onClick={() => setOpen(false)}>Close</button></div>
      <div className="grid grid-3">
        {labels.map((l, i) => (
          <label key={l}>{i + 1}. {l}{files[i] ? ' ✓' : ''}
            <input type="file" accept="image/*" capture="environment" onChange={(e) => setFiles((p) => p.map((x, j) => (j === i ? e.target.files?.[0] ?? null : x)))} />
          </label>
        ))}
      </div>
      <ErrorNotice error={act.error} />
      <Button className="btn-primary" busy={act.busy === 'upload'} disabled={!ready} onClick={upload}>Upload and inspect</Button>
    </div>
  );
}

function ManualFinding({ item, onAdd, busy }: { item: any; onAdd: (b: any) => void; busy: boolean }) {
  const [type, setType] = useState('new_damage');
  const [severity, setSeverity] = useState('minor');
  const [description, setDescription] = useState('');
  const [accessoryId, setAccessoryId] = useState<number | ''>('');
  return (
    <details>
      <summary>Add a finding by hand (priced from the rate card)</summary>
      <div className="grid grid-3" style={{ marginTop: 8 }}>
        <label>Type<select value={type} onChange={(e) => setType(e.target.value)}><option value="new_damage">New damage</option><option value="missing_accessory">Missing accessory</option><option value="needs_cleaning">Needs cleaning</option></select></label>
        <label>Severity<select value={severity} onChange={(e) => setSeverity(e.target.value)}><option>minor</option><option>moderate</option><option>major</option></select></label>
        {type === 'missing_accessory' && (
          <label>Accessory<select value={accessoryId} onChange={(e) => setAccessoryId(e.target.value ? Number(e.target.value) : '')}><option value="">Choose…</option>{item.accessories.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        )}
      </div>
      <label style={{ marginTop: 8 }}>Description<input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></label>
      <Button style={{ marginTop: 8 }} busy={busy} disabled={description.trim().length < 3} onClick={() => { onAdd({ type, severity, description, ...(accessoryId ? { accessoryId } : {}) }); setDescription(''); }}>Add finding</Button>
    </details>
  );
}

function ExcessInvoice({ id }: { id: number }) {
  const [draft, setDraft] = useState<any>(null);
  const act = useAction();
  return (
    <div className="card stack-sm">
      <h3>Charges above the hold</h3>
      {!draft ? (
        <Button busy={act.busy === 'draft'} onClick={() => act.run('draft', async () => setDraft(await post(`/shop/bookings/${id}/excess-invoice`, {})))}>Draft the invoice</Button>
      ) : (
        <>
          <p className="small">To {draft.draft.recipient.name}: {draft.draft.items.map((i: any) => `${i.name} ${money(i.amount_cents)}`).join(', ')}</p>
          <p className="faint">{draft.draft.note}</p>
          <Button className="btn-primary" busy={act.busy === 'send'} onClick={() => act.run('send', async () => setDraft(await post(`/shop/bookings/${id}/excess-invoice`, { confirm: true })))}>Send with PayPal</Button>
        </>
      )}
      <ErrorNotice error={act.error} />
    </div>
  );
}

function ContestPanel({ c, onDone }: { c: any; onDone: (d: any) => void }) {
  const rec = c.recommendation;
  const [cents, setCents] = useState<number>(rec?.refund_cents ?? 0);
  const act = useAction();
  const go = (action: string) => act.run(action, async () => onDone(await post(`/shop/contests/${c.id}/resolve`, { action, refundCents: cents })));
  const label = useMemo(() => money(cents), [cents]);
  return (
    <div className="card stack-sm">
      <h3>Customer contest</h3>
      <p>"{c.reason}"</p>
      {rec && <Notice tone="info"><strong>Agent recommends:</strong> {rec.action} {rec.refund_cents ? money(rec.refund_cents) : ''}. {rec.reason}<span className="faint"> ({rec.source === "ai" ? "AI" : "rules"})</span></Notice>}
      <label>Refund amount (USD)<input type="number" min={0} step={1} value={cents / 100} onChange={(e) => setCents(Math.max(0, Math.round((Number(e.target.value) || 0) * 100)))} /></label>
      <div className="row">
        <Button className="btn-primary" busy={act.busy === 'partial'} disabled={!cents} onClick={() => go('partial')}>Refund {label}</Button>
        <Button busy={act.busy === 'uphold'} onClick={() => go('uphold')}>Refund all charges</Button>
        <Button className="btn-danger" busy={act.busy === 'deny'} onClick={() => go('deny')}>Deny</Button>
      </div>
      <ErrorNotice error={act.error} />
    </div>
  );
}
