/**
 * StationDesignPicker — the overlay that opens from the Appearance "Change"
 * button. Covers the map area with a grid of design tiles; each tile shows an
 * example station (rendered by the design's own renderPreview) and its name.
 * Presentational: all data comes through props. Selecting a tile applies
 * instantly (draw-time) and closes.
 */

import { getStationDesign, type StationDesign, type ExampleStation } from '../render/stationDesigns';
import { Icon } from './icons';

export function StationDesignPicker(props: {
  designs: StationDesign[];
  current: string;
  example: ExampleStation;
  dark: boolean;
  onSelect: (id: string) => void;
  /** Back: close the picker and reopen the settings popover it came from. */
  onBack: () => void;
  /** Close: close the picker without reopening settings. */
  onClose: () => void;
}) {
  const { designs, current, example, dark, onSelect, onBack, onClose } = props;
  const bg = dark ? '#18181b' : '#ffffff';
  const text = dark ? '#e4e4e7' : '#1a1a1a';
  const muted = dark ? '#a1a1aa' : '#6b7280';
  const border = 'rgba(136,136,136,0.35)';
  const exampleBg = dark ? '#2a2d34' : '#f5f2ea';
  return (
    <div
      role="dialog"
      aria-label="Station design"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        background: bg,
        color: text,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '14px 16px',
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button
          onClick={onBack}
          aria-label="Back"
          style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: text, cursor: 'pointer', fontSize: 15, fontWeight: 600, padding: 0 }}
        >
          <Icon name="chevronLeft" size={18} /> Station design
        </button>
        <button
          onClick={onClose}
          aria-label="Close"
          style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', display: 'inline-flex' }}
        >
          <Icon name="x" />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12 }}>
        {designs.map((d) => {
          const active = d.id === current;
          return (
            <button
              key={d.id}
              onClick={() => { onSelect(d.id); onClose(); }}
              aria-pressed={active}
              style={{
                border: active ? '2px solid #2563eb' : `0.5px solid ${border}`,
                background: active ? (dark ? 'rgba(37,99,235,0.18)' : '#eff4ff') : 'transparent',
                color: text,
                borderRadius: 10,
                padding: '12px 8px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
              }}
            >
              <span
                style={{ width: 56, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', background: exampleBg, borderRadius: 8 }}
                dangerouslySetInnerHTML={{ __html: getStationDesign(d.id).renderPreview(example, dark) }}
              />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{d.name}</span>
              {active && (
                <span style={{ fontSize: 11, color: '#2563eb', display: 'flex', alignItems: 'center', gap: 3 }}>
                  <Icon name="check" size={13} /> Selected
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
