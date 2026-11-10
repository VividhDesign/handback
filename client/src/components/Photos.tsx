type Box = number[] | null | undefined;
export type Mark = { angle: number; box: Box; label?: string; old?: boolean };

/** box is [ymin, xmin, ymax, xmax] on a 0-1000 scale (Gemini convention). */
function BoxEl({ box, label, old }: { box: number[]; label?: string; old?: boolean }) {
  const [y0, x0, y1, x1] = box;
  return <div className={`box${old ? ' old' : ''}`} title={label} style={{ top: `${y0 / 10}%`, left: `${x0 / 10}%`, height: `${(y1 - y0) / 10}%`, width: `${(x1 - x0) / 10}%` }} />;
}

const ANGLES = ['Front', 'Back', 'Left', 'Right', 'Accessories'];

export function PhotoStrip({ src, available, marks = [], title }: { src: (angle: number) => string; available: number[]; marks?: Mark[]; title?: string }) {
  return (
    <div>
      {title && <h3>{title}</h3>}
      <div className="photo-strip">
        {[1, 2, 3, 4, 5].map((a) => (
          <div key={a} className={`photo${available.includes(a) ? '' : ' empty'}`}>
            {available.includes(a) ? (
              <>
                <img src={src(a)} alt={`${title ?? 'Photo'}: ${ANGLES[a - 1]}`} loading="lazy" />
                {marks.filter((m) => m.angle === a && m.box?.length === 4).map((m, i) => <BoxEl key={i} box={m.box as number[]} label={m.label} old={m.old} />)}
              </>
            ) : (
              <span>{ANGLES[a - 1]}</span>
            )}
            <span className="angle">{a} · {ANGLES[a - 1]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Pickup and return side by side, with finding boxes on the return set and passport marks on the pickup set. */
export function PhotoCompare({ token, photos, findings, passport }: { token: string; photos: any[]; findings: any[]; passport?: any }) {
  const have = (phase: string) => photos.filter((p) => p.phase === phase).map((p) => p.angle);
  const v = (phase: string) => photos.find((p) => p.phase === phase)?.received_at ?? '';
  const src = (phase: string) => (a: number) => `/api/p/${token}/${phase}/${a}?v=${encodeURIComponent(v(phase))}`;
  const retMarks: Mark[] = findings.filter((f) => f.photo_index && f.box).map((f) => ({ angle: f.photo_index, box: f.box, label: f.description, old: !!f.existing_mark_id }));
  const pickMarks: Mark[] = [
    ...(passport?.existing_marks ?? []).map((m: any) => ({ angle: m.photo_index, box: m.box_2d, label: `${m.id}: ${m.description}`, old: true })),
  ];
  return (
    <div className="stack">
      {have('pickup').length > 0 && <PhotoStrip title="Pickup" src={src('pickup')} available={have('pickup')} marks={pickMarks} />}
      {have('return').length > 0 && <PhotoStrip title="Return" src={src('return')} available={have('return')} marks={retMarks} />}
    </div>
  );
}
