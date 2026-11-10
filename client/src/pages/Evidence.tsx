import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { post } from '../lib/api.ts';
import { useAction, useApi } from '../lib/hooks.ts';
import { dateTime, duration, money } from '../lib/format.ts';
import { Button, ErrorNotice, Loading, ModeTag, MoneyLine, Notice, PayPalIds, StateBadge } from '../components/ui.tsx';
import { PhotoCompare } from '../components/Photos.tsx';
import { FindingRow } from '../components/Findings.tsx';

export function Evidence() {
  const { token = '' } = useParams();
  const { data, setData, error, loading } = useApi<any>(`/evidence/${token}`);
  const [reason, setReason] = useState('');
  const act = useAction();

  if (loading && !data) return <div className="page"><Loading lines={8} /></div>;
  if (error) return <div className="page narrow"><ErrorNotice error={error} /></div>;
  const { booking: b, item, photos, findings, payments, events, inspections, contests } = data;
  const ret = [...inspections].reverse().find((i: any) => i.phase === 'return');
  const pick = [...inspections].reverse().find((i: any) => i.phase === 'pickup');
  const charged = findings.filter((f: any) => f.decision === 'approved' && !f.existing_mark_id);
  const openContest = contests.find((c: any) => c.state === 'open');

  return (
    <div className="page stack">
      <div className="card">
        <div className="row between">
          <div>
            <div className="faint">Evidence · {b.code}{b.is_sample ? ' · sample row' : ''}</div>
            <h1>{item.name}</h1>
            <p className="muted">{dateTime(b.start_at)} → {dateTime(b.end_at)} · returned {dateTime(b.returned_at)}</p>
          </div>
          <StateBadge state={b.state} />
        </div>
        {b.state === 'settled_clean' && <Notice tone="ok">Clean return. Only the rental fee was captured and the deposit was released{b.release_ms ? ` ${duration(b.release_ms)} after the return` : ''}.</Notice>}
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.7fr) minmax(280px, 1fr)', alignItems: 'start' }}>
        <div className="stack">
          <div className="card stack">
            <div className="row between">
              <h2>Photos</h2>
              <div className="row">{ret && <ModeTag mode={ret.mode} model={ret.model} cachedAt={ret.cached_at} />}</div>
            </div>
            {photos.length ? <PhotoCompare token={token} photos={photos} findings={findings} passport={pick?.result} /> : <p className="faint">No photos stored for this booking.</p>}
            <p className="faint">Red boxes: findings on return. Grey dashed boxes: marks that already existed at pickup.</p>
            {ret?.result?.overall && <p><strong>AI summary:</strong> {ret.result.overall.summary} <span className="faint">({ret.result.overall.verdict}, {Number(ret.result.overall.confidence).toFixed(2)})</span></p>}
            {ret?.checks?.length > 0 && (
              <details>
                <summary>Deterministic checks ({ret.checks.filter((c: any) => c.passed).length}/{ret.checks.length} passed)</summary>
                <ul className="small">{ret.checks.map((c: any) => <li key={c.id ?? c.name}>{c.passed ? '✓' : '✗'} {c.label ?? c.name}{c.detail ? `: ${c.detail}` : ''}</li>)}</ul>
              </details>
            )}
          </div>
          <div className="card">
            <h2>Findings and decisions</h2>
            {findings.length ? findings.map((f: any) => <FindingRow key={f.id} f={f} />) : <p className="muted">No findings. Nothing beyond the rental fee was charged.</p>}
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <h2>Line items</h2>
            <MoneyLine label="Rental fee" cents={b.fee_cents} />
            {charged.map((f: any) => <MoneyLine key={f.id} label={f.description} cents={f.proposed_cents} hint={f.price_source} />)}
            <MoneyLine label="Captured" cents={b.captured_cents} total />
            <MoneyLine label="Released from hold" cents={b.released_cents} />
            {b.excess_cents > 0 && <MoneyLine label="Above the hold (invoice)" cents={b.excess_cents} />}
            {b.refunded_cents > 0 && <MoneyLine label="Refunded" cents={b.refunded_cents} />}
            <p className="faint">Authorized {money(b.authorized_cents)}. One final capture; the remainder was released by PayPal.</p>
          </div>
          {b.state === 'settled_charged' && !b.is_sample && (
            <div className="card stack-sm">
              <h2>Contest this charge</h2>
              <p className="small muted">Tell the shop what is wrong. The owner reviews it with an AI recommendation; a refund goes back to your PayPal account.</p>
              <textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} placeholder="For example: the scratch on the left side was there at pickup." />
              <ErrorNotice error={act.error} />
              <Button className="btn-primary" busy={act.busy === 'contest'} disabled={reason.trim().length < 5} onClick={() => act.run('contest', async () => setData(await post(`/evidence/${token}/contest`, { reason })))}>Send to the shop</Button>
            </div>
          )}
          {contests.map((c: any) => (
            <div key={c.id} className="card stack-sm">
              <div className="row between"><h3>Contest</h3><span className="badge plain tag-sample">{c.state}</span></div>
              <p className="small">"{c.reason}"</p>
              {c.refund_cents > 0 && <p className="small">Refunded {money(c.refund_cents)} on {dateTime(c.resolved_at)}.</p>}
              {openContest?.id === c.id && <p className="faint">Waiting for the shop's decision.</p>}
            </div>
          ))}
          <div className="card">
            <h2>Timeline</h2>
            <ul className="timeline">{events.map((e: any) => <li key={e.id}><span className="faint">{dateTime(e.created_at)}</span> · {e.summary}</li>)}</ul>
          </div>
        </div>
      </div>
      <div className="card">
        <h2>PayPal record</h2>
        <PayPalIds payments={payments} />
      </div>
    </div>
  );
}
