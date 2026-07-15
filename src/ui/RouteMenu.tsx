/**
 * RouteMenu — the overlay that opens from the top-bar Routes button. Covers the map
 * with a grid of route tiles, each rendered in the user's current station design;
 * tapping a tile opens a per-route detail view whose only control (for now) is a
 * Show-on-map toggle. Changes are staged (they dirty the appearance settings) and
 * applied by the shared Save changes action, so both modes re-render on Save and
 * smoothed regenerates. Presentational: all data and actions come through props.
 */

import { useState, type ReactNode } from 'react';
import { renderStationPreview, routeToExample, type StationDesign } from '../render/stations';
import { Icon } from './icons';

interface MenuRoute { id: string; name?: string; bullet?: string; color?: string; textColor?: string }

export function RouteMenu(props: {
  routes: MenuRoute[];
  design: StationDesign;
  dark: boolean;
  disabled: string[];
  dirty: boolean;
  atDefaults: boolean;
  onToggle: (routeId: string) => void;
  onSave: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const { routes, design, dark, disabled, dirty, atDefaults, onToggle, onSave, onReset, onClose } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const bg = dark ? '#18181b' : '#ffffff';
  const text = dark ? '#e4e4e7' : '#1a1a1a';
  const muted = dark ? '#a1a1aa' : '#6b7280';
  const border = 'rgba(136,136,136,0.35)';
  const tileBg = dark ? '#2a2d34' : '#f5f2ea';
  const hidden = new Set(disabled);
  const label = (r: MenuRoute) => r.name || r.bullet || r.id;

  const preview = (r: MenuRoute, px: number) => (
    <span
      style={{ width: px, height: px, display: 'flex', alignItems: 'center', justifyContent: 'center', background: tileBg, borderRadius: 8 }}
      dangerouslySetInnerHTML={{ __html: renderStationPreview(design, routeToExample(r), dark) }}
    />
  );

  const closeBtn = (
    <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', display: 'inline-flex' }}>
      <Icon name="x" />
    </button>
  );

  const footer = (
    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
      <button
        onClick={onReset}
        disabled={atDefaults}
        style={{ fontSize: 13, fontWeight: 600, padding: '6px 10px', borderRadius: 6, cursor: atDefaults ? 'default' : 'pointer', opacity: atDefaults ? 0.5 : 1, background: 'transparent', color: 'inherit', border: '1px solid rgba(136,136,136,0.5)' }}
      >
        Reset
      </button>
      <button
        onClick={onSave}
        disabled={!dirty}
        style={{ flex: 1, fontSize: 13, fontWeight: 600, padding: '6px 10px', borderRadius: 6, border: 'none', cursor: dirty ? 'pointer' : 'default', opacity: dirty ? 1 : 0.5, background: '#2563eb', color: '#ffffff' }}
      >
        {dirty ? 'Save changes' : 'Saved'}
      </button>
    </div>
  );

  const shell = (header: ReactNode, body: ReactNode) => (
    <div
      role="dialog"
      aria-label="Routes"
      style={{ position: 'absolute', inset: 0, zIndex: 20, background: bg, color: text, display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 16px', overflowY: 'auto' }}
    >
      {header}
      {body}
      {footer}
    </div>
  );

  const sel = selected != null ? routes.find((x) => x.id === selected) : undefined;

  if (sel) {
    const on = !hidden.has(sel.id);
    return shell(
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button onClick={() => setSelected(null)} aria-label="Back" style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: text, cursor: 'pointer', fontSize: 15, fontWeight: 600, padding: 0 }}>
          <Icon name="chevronLeft" size={18} /> Routes
        </button>
        {closeBtn}
      </div>,
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {preview(sel, 64)}
          <div style={{ fontSize: 16, fontWeight: 600 }}>{label(sel)}</div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', border: `0.5px solid ${border}`, borderRadius: 8, cursor: 'pointer' }}>
          <span style={{ fontSize: 14 }}>Show on map</span>
          <input type="checkbox" checked={on} onChange={() => onToggle(sel.id)} />
        </label>
      </div>,
    );
  }

  return shell(
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 15, fontWeight: 600 }}>Routes</span>
      {closeBtn}
    </div>,
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: 12 }}>
      {routes.map((r) => {
        const on = !hidden.has(r.id);
        return (
          <button
            key={r.id}
            onClick={() => setSelected(r.id)}
            style={{ border: `0.5px solid ${border}`, background: 'transparent', color: text, borderRadius: 10, padding: '10px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, cursor: 'pointer', opacity: on ? 1 : 0.4 }}
          >
            {preview(r, 44)}
            <span style={{ fontSize: 12, fontWeight: 600, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label(r)}</span>
          </button>
        );
      })}
    </div>,
  );
}
