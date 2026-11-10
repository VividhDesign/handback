import { money } from '../lib/format.ts';

const TYPE: Record<string, string> = { new_damage: 'New damage', missing_accessory: 'Missing accessory', needs_cleaning: 'Needs cleaning', late: 'Late return' };

export function FindingRow({ f, actions }: { f: any; actions?: React.ReactNode }) {
  const decided = f.decision && f.decision !== 'pending';
  return (
    <div className="finding">
      <div className="row between">
        <div className="row">
          <strong>{TYPE[f.type] ?? f.type}</strong>
          {f.severity && f.type !== 'late' && <span className="badge plain tag-sample">{f.severity}</span>}
          {f.confidence != null && f.type !== 'late' && <span className="faint">confidence {Number(f.confidence).toFixed(2)}</span>}
          {f.photo_index && <span className="faint">photo {f.photo_index}</span>}
        </div>
        <div className="row">
          <span className="amount"><strong>{money(f.proposed_cents)}</strong></span>
          {decided && <span className={`badge ${f.decision === 'approved' ? 's-charged' : 's-released'}`}>{f.decision}</span>}
        </div>
      </div>
      <p style={{ margin: '4px 0' }}>{f.description}{f.accessory_name ? ` (${f.accessory_name})` : ''}</p>
      <div className="row between">
        <span className="faint">Price source: {f.price_source ?? '—'}{f.existing_mark_id ? ' · recorded at pickup, never charged' : ''}{f.decision_note ? ` · note: ${f.decision_note}` : ''}</span>
        {actions}
      </div>
    </div>
  );
}
