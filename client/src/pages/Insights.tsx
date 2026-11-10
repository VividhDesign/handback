import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgStudio, createWidgets, AgLoadingOverlay, AgNoDataOverlay, AgIncompleteDataMappingOverlay } from 'ag-studio-react';
import { studioTheme } from 'ag-studio';
import { api } from '../lib/api.ts';

/**
 * Insights (AG Studio). Four sources from /api/shop/insights, a default layout with built-in
 * widgets plus three Handback widgets, layout saved per browser, and a "real sandbox runs only" chip.
 */
type Row = Record<string, any>;
type Sources = { bookings: Row[]; findings: Row[]; payments: Row[]; utilisation: Row[] };

const LAYOUT_KEY = 'handback.insights.layout.v2';
const readLayout = () => { try { const s = localStorage.getItem(LAYOUT_KEY); return s ? JSON.parse(s) : null; } catch { return null; } };
const writeLayout = (s: unknown) => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(s)); } catch { /* private window */ } };
const clearLayout = () => { try { localStorage.removeItem(LAYOUT_KEY); } catch { /* ignore */ } };

const theme = studioTheme.withParams({
  accentColor: '#1f4fd8',
  backgroundColor: '#ffffff',
  foregroundColor: '#16181d',
  fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  borderRadius: 8,
} as any);

const OUTCOME_COLOR: Record<string, string> = {
  Released: '#177a43', Charged: '#6b3fc4', Refunded: '#a35c00', Voided: '#6b7280', Holding: '#1f5fd0', 'No hold': '#b8bdc7',
};

// ---- data helper shared by the three custom widgets ------------------------------------------
/** Runs the widget's query for the mapped fields and returns rows keyed by mapping key. */
function useWidgetRows(params: any, keys: string[]) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const mapping = params.dataMapping ?? {};
  const fields = keys.flatMap((k) => (mapping[k] ?? []).map((f: any) => ({ k, f })));
  const complete = keys.every((k) => (mapping[k] ?? []).length > 0);
  const sig = JSON.stringify(fields.map(({ f }) => [f.key, f.aggregation]));

  useEffect(() => {
    if (!complete) return;
    let live = true;
    const toRows = (resp: any) => {
      if (!live || resp?.replaced) return;
      const raw: Row[] = resp?.results?.rows ?? [];
      setRows(raw.map((r) => Object.fromEntries(fields.map(({ k, f }) => [k, r[f.key]]))));
    };
    params.widgetApi.getData({ fields: fields.map(({ f }) => f) }, { queryId: 'main', onDataUpdated: toRows }).then(toRows).catch(() => live && setRows([]));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, complete]);

  return { rows, complete };
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="hbw"><div className="hbw-title">{title}</div>{children}</div>;
}

function gate(complete: boolean, rows: Row[] | null) {
  if (!complete) return <AgIncompleteDataMappingOverlay />;
  if (rows == null) return <AgLoadingOverlay />;
  if (rows.length === 0) return <AgNoDataOverlay />;
  return null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const dur = (s: number | null) => (s == null ? '—' : s < 90 ? `${s.toFixed(1)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

// ---- 1. Deposit release time ------------------------------------------------------------------
function ReleaseTime(params: any) {
  const { rows, complete } = useWidgetRows(params, ['booking', 'outcome', 'seconds', 'day']);
  const g = gate(complete, rows);
  if (g) return g;
  const timed = rows!.filter((r) => r.seconds != null);
  const done = timed.filter((r) => r.outcome === 'Released');
  const auto = done.map((r) => Number(r.seconds));
  const reviewed = timed.filter((r) => r.outcome !== 'Released').map((r) => Number(r.seconds));
  const byDay = new Map<string, number[]>();
  for (const r of done) { const d = String(r.day ?? ''); if (d) byDay.set(d, [...(byDay.get(d) ?? []), Number(r.seconds)]); }
  const trend = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, xs]) => ({ d, m: median(xs)! }));
  const max = Math.max(1, ...trend.map((t) => Math.log10(1 + t.m)));
  return (
    <Frame title="Deposit release time">
      <div className="hbw-kpis">
        <div><div className="hbw-big">{dur(median(auto))}</div><div className="hbw-sub">median, clean return (auto release) · {auto.length}</div></div>
        <div><div className="hbw-big hbw-muted">{dur(median(reviewed))}</div><div className="hbw-sub">median, owner reviewed (charge settled) · {reviewed.length}</div></div>
      </div>
      {trend.length > 1 && (
        <svg className="hbw-spark" viewBox={`0 0 ${trend.length * 20} 40`} preserveAspectRatio="none" aria-label="Median release time by day (log scale)">
          {trend.map((t, i) => { const h = Math.max(2, (Math.log10(1 + t.m) / max) * 36); return <rect key={t.d} x={i * 20 + 3} y={40 - h} width={14} height={h} rx={2} fill="#177a43"><title>{`${t.d}: ${dur(t.m)}`}</title></rect>; })}
        </svg>
      )}
      <div className="hbw-sub">Trend: median per settle day (log scale). Time from return check-in to settlement on PayPal (fee captured, rest of the hold released).</div>
    </Frame>
  );
}

// ---- 2. Hold funnel ---------------------------------------------------------------------------
function HoldFunnel(params: any) {
  const { rows, complete } = useWidgetRows(params, ['outcome', 'count']);
  const g = gate(complete, rows);
  if (g) return g;
  const c = new Map<string, number>();
  for (const r of rows!) c.set(String(r.outcome), (c.get(String(r.outcome)) ?? 0) + Number(r.count ?? 0));
  const held = [...c.entries()].filter(([k]) => k !== 'No hold').reduce((a, [, n]) => a + n, 0);
  const steps = ['Released', 'Charged', 'Voided', 'Refunded', 'Holding'];
  return (
    <Frame title="Hold funnel">
      <div className="hbw-row"><span>Authorized (PayPal hold placed)</span><b>{held}</b></div>
      <div className="hbw-bar"><i style={{ width: '100%', background: '#1f4fd8' }} /></div>
      {steps.map((s) => {
        const n = c.get(s) ?? 0;
        return (
          <div key={s}>
            <div className="hbw-row"><span>→ {s}</span><b>{n} <small className="hbw-muted">{held ? Math.round((n / held) * 100) : 0}%</small></b></div>
            <div className="hbw-bar"><i style={{ width: `${held ? (n / held) * 100 : 0}%`, background: OUTCOME_COLOR[s] }} /></div>
          </div>
        );
      })}
    </Frame>
  );
}

// ---- 3. AI vs owner ---------------------------------------------------------------------------
function AiVsOwner(params: any) {
  const { rows, complete } = useWidgetRows(params, ['decision', 'count']);
  const g = gate(complete, rows);
  if (g) return g;
  const c = new Map<string, number>();
  for (const r of rows!) c.set(String(r.decision ?? 'pending'), (c.get(String(r.decision ?? 'pending')) ?? 0) + Number(r.count ?? 0));
  const total = [...c.values()].reduce((a, b) => a + b, 0);
  const decided = total - (c.get('pending') ?? 0) - (c.get('null') ?? 0);
  const approved = c.get('approved') ?? 0;
  const share = decided ? Math.round((approved / decided) * 100) : 0;
  return (
    <Frame title="AI vs owner">
      <div className="hbw-big">{decided ? `${share}%` : '—'}</div>
      <div className="hbw-sub">of AI findings the owner approved ({approved} of {decided} decided)</div>
      <div className="hbw-stack">
        {[...c.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => (
          <i key={k} title={`${k}: ${n}`} style={{ flex: n, background: k === 'approved' ? '#177a43' : k === 'waived' ? '#a35c00' : k === 'edited' ? '#1f5fd0' : '#b8bdc7' }} />
        ))}
      </div>
      <div className="hbw-sub">{[...c.entries()].map(([k, n]) => `${k} ${n}`).join(' · ')}</div>
    </Frame>
  );
}

const f = (supportedRoles: string[], required = true) => ({ type: 'field', supportedRoles, required });
const form = (items: [string, string][]) => (p: any) => p.createDefaults({ dataMappingItems: items.map(([key, label]) => ({ key, label })) });
const custom: any[] = [
  { id: 'hb-release-time', label: 'Deposit release time', comp: ReleaseTime, defaultSize: { width: 8, height: 5 }, minSize: { width: 5, height: 4 },
    dataMapping: { booking: f(['category']), outcome: f(['category']), seconds: f(['numeric']), day: f(['category', 'temporal']) },
    form: form([['booking', 'Booking'], ['outcome', 'Hold outcome'], ['seconds', 'Release seconds'], ['day', 'Settle day']]) },
  { id: 'hb-hold-funnel', label: 'Hold funnel', comp: HoldFunnel, defaultSize: { width: 8, height: 7 }, minSize: { width: 5, height: 5 },
    dataMapping: { outcome: f(['category']), count: f(['numeric']) },
    form: form([['outcome', 'Hold outcome'], ['count', 'Count']]) },
  { id: 'hb-ai-vs-owner', label: 'AI vs owner', comp: AiVsOwner, defaultSize: { width: 8, height: 5 }, minSize: { width: 5, height: 4 },
    dataMapping: { decision: f(['category']), count: f(['numeric']) },
    form: form([['decision', 'Owner decision'], ['count', 'Count']]) },
];

const widgets = createWidgets({ additionalTypes: custom, menu: [{ label: 'Handback', widgetIds: custom.map((c) => c.id) }] } as any);

const id = (s: string, aggregation?: string) => (aggregation ? { id: s, aggregation } : { id: s });
const DEFAULT_STATE = {
  selectedPageId: 'overview',
  pages: [{
    id: 'overview',
    name: 'Overview',
    widgets: {
      '1': { type: 'hb-release-time', dataMapping: { booking: [id('bookings.code')], outcome: [id('bookings.hold_outcome')], seconds: [id('bookings.release_seconds')], day: [id('bookings.settled_day')] } },
      '2': { type: 'hb-hold-funnel', dataMapping: { outcome: [id('bookings.hold_outcome')], count: [id('bookings.code', 'count')] } },
      '3': { type: 'hb-ai-vs-owner', dataMapping: { decision: [id('findings.owner_decision')], count: [id('findings.type', 'count')] } },
      '4': { type: 'column-chart-grouped', format: { title: { enabled: true, text: 'Booked days by item' } }, dataMapping: { categoryKey: [id('utilisation.item')], valueKey: [id('utilisation.booked_days', 'sum')] } },
      '5': { type: 'column-chart-grouped', format: { title: { enabled: true, text: 'PayPal amounts by call type (USD)' } }, dataMapping: { categoryKey: [id('payments.kind')], valueKey: [id('payments.amount_usd', 'sum')] } },
      '6': { type: 'grid', format: { title: { enabled: true, text: 'Bookings' } }, dataMapping: { cols: ['code', 'item', 'state', 'hold_outcome', 'hold_usd', 'captured_usd', 'released_usd', 'release_seconds', 'run'].map((c) => id(`bookings.${c}`)) } },
    },
    widgetLayout: {
      '1': { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 16 },
      '2': { xTrack: 8, yTrack: 0, xSpan: 8, ySpan: 16 },
      '3': { xTrack: 16, yTrack: 0, xSpan: 8, ySpan: 16 },
      '4': { xTrack: 0, yTrack: 16, xSpan: 12, ySpan: 18 },
      '5': { xTrack: 12, yTrack: 16, xSpan: 12, ySpan: 18 },
      '6': { xTrack: 0, yTrack: 34, xSpan: 24, ySpan: 24 },
    },
  }],
};

export function Insights() {
  const [data, setData] = useState<Sources | null>(null);
  const [realOnly, setRealOnly] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mountKey, setMountKey] = useState(0);
  const saved = useRef(readLayout());
  const studio = useRef<any>(null);
  const save = () => { try { const st = studio.current?.getState?.(); if (st) { saved.current = st; writeLayout(st); } } catch { /* ignore */ } };

  const load = useCallback(async () => {
    setData(null);
    try { setData(await api<Sources>(`/shop/insights${realOnly ? '?real=1' : ''}`)); } catch (e: any) { setError(e.message); }
  }, [realOnly]);
  useEffect(() => { void load(); }, [load]);

  const studioData = useMemo(() => data && ({
    sources: (['bookings', 'findings', 'payments', 'utilisation'] as const).map((s) => ({ id: s, data: data[s] })),
  }), [data]);

  const reset = () => { clearLayout(); saved.current = null; setMountKey((k) => k + 1); };
  const samples = data ? data.bookings.filter((b) => b.run === 'Sample').length : 0;

  return (
    <div className="page stack">
      <div className="row between">
        <div>
          <h1>Insights</h1>
          <p className="muted">Holds, releases, charges and AI findings. Built with AG Studio. Switch to edit mode to move, resize or add widgets; your layout is saved in this browser.</p>
        </div>
        <div className="row">
          <button className={`chip ${realOnly ? 'chip-on' : ''}`} aria-pressed={realOnly} onClick={() => setRealOnly((v) => !v)}>Real sandbox runs only</button>
          <button className="btn btn-sm" onClick={() => { if (editing) save(); setEditing((v) => !v); }}>{editing ? 'Done editing' : 'Edit layout'}</button>
          <button className="btn btn-sm" onClick={reset}>Reset layout</button>
        </div>
      </div>
      {data && (
        <p className="muted" style={{ fontSize: 13 }}>
          {realOnly ? `Showing ${data.bookings.length} real sandbox bookings only.` : `Showing ${data.bookings.length} bookings, of which ${samples} are labelled sample rows (column "run").`}
        </p>
      )}
      {error && <div className="notice notice-error">{error}</div>}
      <div className="insights-box">
        {!studioData ? <p className="muted" style={{ padding: 16 }}>Loading insights…</p> : (
          <AgStudio
            key={`${mountKey}-${realOnly}`}
            data={studioData as any}
            initialState={(saved.current ?? DEFAULT_STATE) as any}
            mode={editing ? 'edit' : 'view'}
            widgets={widgets as any}
            theme={theme as any}
            onApiReady={(e: any) => { studio.current = e?.api ?? e; }}
            onStateUpdated={(e: any) => { if (e?.durable !== false && e?.state) { saved.current = e.state; writeLayout(e.state); } }}
            style={{ height: '100%' }}
          />
        )}
      </div>
    </div>
  );
}
