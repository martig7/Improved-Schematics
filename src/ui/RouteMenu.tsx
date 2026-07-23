/**
 * RouteMenu — the overlay that opens from the top-bar Routes button. Covers the map
 * with a grid of route tiles, each rendered in the user's current station design;
 * tapping a tile opens a per-route detail view whose only control (for now) is a
 * Show-on-map toggle. Changes are staged (they dirty the appearance settings) and
 * applied by the shared Save changes action, so both modes re-render on Save and
 * smoothed regenerates. Presentational: all data and actions come through props.
 */

import { useState, type ReactNode, type CSSProperties } from 'react';
import { renderStationPreview, routeToExample, type StationDesign } from '../render/stations';
import { SIMPLIFIED_STYLES, DEFAULT_SIMPLIFIED_STYLE, getSimplifiedStyle, paramsFor, settingsOf, shadeHex, asSetting, type SimplifiedSetting } from '../render/simplify';
import { Icon } from './icons';

interface MenuRoute { id: string; name?: string; bullet?: string; color?: string; textColor?: string }

export function RouteMenu(props: {
  routes: MenuRoute[];
  design: StationDesign;
  dark: boolean;
  disabled: string[];
  /** Per-route simplified display: route id -> style id. Absent = not simplified. */
  simplified: Record<string, string | SimplifiedSetting>;
  dirty: boolean;
  atDefaults: boolean;
  onToggle: (routeId: string) => void;
  /** Set or clear a route's simplified style (null clears). */
  onSetSimplified: (routeId: string, next: SimplifiedSetting | null) => void;
  onSave: () => void;
  onReset: () => void;
  /** Back: close the overlay and reopen the settings popover it came from. */
  onBack: () => void;
  onClose: () => void;
}) {
  const { routes, design, dark, disabled, simplified, dirty, atDefaults, onToggle, onSetSimplified, onSave, onReset, onBack, onClose } = props;
  const [selected, setSelected] = useState<string | null>(null);
  // Which shade picker is open, by setting key. Closes when the route changes.
  const [shadeOpen, setShadeOpen] = useState<string | null>(null);
  const simpOf = (id: string): string | SimplifiedSetting | undefined => simplified[id];
  const bg = dark ? '#18181b' : '#ffffff';
  const text = dark ? '#e4e4e7' : '#1a1a1a';
  const muted = dark ? '#a1a1aa' : '#6b7280';
  const border = 'rgba(136,136,136,0.35)';
  const tileBg = dark ? '#2a2d34' : '#f5f2ea';
  const hidden = new Set(disabled);
  const row: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px', border: `0.5px solid ${border}`, borderRadius: 8, cursor: 'pointer' };
  // An unnamed, unbulleted route reads as BLANK, not as its internal id: the id
  // is storage detail the player never chose and cannot act on.
  const label = (r: MenuRoute) => r.name || r.bullet || '';

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
    // Resolved view of this route's simplified display: the style it named (or
    // the fallback) and its settings with defaults filled in, so the controls
    // always have a concrete value to show.
    const cur = asSetting(simpOf(sel.id));
    const style = getSimplifiedStyle(cur?.style);
    const params = paramsFor(style, cur?.params);
    return shell(
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button onClick={() => { setSelected(null); setShadeOpen(null); }} aria-label="Back" style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: text, cursor: 'pointer', fontSize: 15, fontWeight: 600, padding: 0 }}>
          <Icon name="chevronLeft" size={18} /> Routes
        </button>
        {closeBtn}
      </div>,
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {preview(sel, 64)}
          <div style={{ fontSize: 16, fontWeight: 600 }}>{label(sel)}</div>
        </div>
        <label style={row}>
          <span style={{ fontSize: 14 }}>Show on map</span>
          <input type="checkbox" checked={on} onChange={() => onToggle(sel.id)} />
        </label>
        <label style={row}>
          <span style={{ fontSize: 14 }}>Simplify</span>
          <input
            type="checkbox"
            checked={cur !== undefined}
            onChange={(e) => onSetSimplified(sel.id, e.target.checked ? { style: DEFAULT_SIMPLIFIED_STYLE } : null)}
          />
        </label>
        <label style={{ ...row, cursor: cur ? 'pointer' : 'default', opacity: cur ? 1 : 0.45 }}>
          <span style={{ fontSize: 14 }}>Style</span>
          <select
            value={style.id}
            disabled={cur === undefined}
            onChange={(e) => onSetSimplified(sel.id, { style: e.target.value })}
            style={{ fontSize: 13, padding: '4px 6px', borderRadius: 6, background: 'transparent', color: 'inherit', border: `1px solid ${border}` }}
          >
            {SIMPLIFIED_STYLES.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        {/* Whatever the chosen style exposes. Data-driven, so a new style's
            controls appear here with no change to this component. */}
        {cur && settingsOf(style).map((spec) => {
          const set = (patch: Record<string, number>) =>
            onSetSimplified(sel.id, { style: style.id, params: { ...params, ...patch } });
          // A 'shade' setting is one row: a checkbox that switches it on, and a
          // swatch of the current shade that opens the picker.
          if (spec.control === 'shade') {
            const on = !!params[spec.enableKey!];
            const hex = shadeHex(params[spec.key]);
            const open = shadeOpen === spec.key;
            return (
              <div key={spec.key} style={{ ...row, position: 'relative', cursor: 'default' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                  <input type="checkbox" checked={on} onChange={(e) => set({ [spec.enableKey!]: e.target.checked ? 1 : 0 })} />
                  <span style={{ fontSize: 14 }}>{spec.label}</span>
                </label>
                <button
                  type="button"
                  aria-label={`${spec.label} shade`}
                  disabled={!on}
                  onClick={() => setShadeOpen(open ? null : spec.key)}
                  style={{
                    width: 30, height: 20, padding: 0, borderRadius: 4, background: hex,
                    // Black outer ring, white inner ring, so the swatch reads at
                    // either end of the scale and against either theme.
                    border: '1px solid #000000', boxShadow: 'inset 0 0 0 1px #ffffff',
                    cursor: on ? 'pointer' : 'default', opacity: on ? 1 : 0.4,
                  }}
                />
                {open && on && (
                  <div
                    style={{
                      position: 'absolute', top: '100%', right: 8, zIndex: 30, marginTop: 6,
                      display: 'flex', flexDirection: 'column', gap: 8, width: 190,
                      padding: 10, borderRadius: 8, background: bg, color: text,
                      border: `0.5px solid ${border}`, boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
                    }}
                  >
                    <div style={{ height: 14, borderRadius: 3, border: `0.5px solid ${border}`, background: 'linear-gradient(to right, #000000, #ffffff)' }} />
                    <input
                      type="range"
                      min={spec.min}
                      max={spec.max}
                      step={spec.step}
                      value={params[spec.key]}
                      onChange={(e) => set({ [spec.key]: parseFloat(e.target.value) })}
                      style={{ width: '100%', cursor: 'pointer', accentColor: hex }}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, opacity: 0.7 }}>
                      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{params[spec.key]}{spec.unit ?? ''}</span>
                      <button
                        type="button"
                        onClick={() => setShadeOpen(null)}
                        style={{ fontSize: 12, padding: '2px 8px', borderRadius: 5, background: 'transparent', color: 'inherit', border: `1px solid ${border}`, cursor: 'pointer' }}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          }
          return (
            <label key={spec.key} style={{ ...row, gap: 10 }}>
              <span style={{ fontSize: 14, whiteSpace: 'nowrap' }}>{spec.label}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end' }}>
                <input
                  type="range"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={params[spec.key]}
                  onChange={(e) => set({ [spec.key]: parseFloat(e.target.value) })}
                  style={{ flex: 1, minWidth: 80, cursor: 'pointer', accentColor: '#2563eb' }}
                />
                <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7, minWidth: 42, textAlign: 'right' }}>
                  {params[spec.key]}{spec.unit ?? ''}
                </span>
              </span>
            </label>
          );
        })}
      </div>,
    );
  }

  return shell(
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <button onClick={onBack} aria-label="Back" style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: text, cursor: 'pointer', fontSize: 15, fontWeight: 600, padding: 0 }}>
        <Icon name="chevronLeft" size={18} /> Routes
      </button>
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
