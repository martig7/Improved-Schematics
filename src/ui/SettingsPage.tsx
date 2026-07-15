/**
 * SettingsPage — a plain full-area overlay for a group of settings, matching the
 * Station design / Routes picker chrome: a back chevron (returns to the settings
 * popover), a close X, the settings as children, and an optional footer (e.g. the
 * shared Save/Reset). No internal subheaders. Presentational.
 */

import type { ReactNode } from 'react';
import { Icon } from './icons';

export function SettingsPage(props: {
  title: string;
  dark: boolean;
  onBack: () => void;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { title, dark, onBack, onClose, footer, children } = props;
  const bg = dark ? '#18181b' : '#ffffff';
  const text = dark ? '#e4e4e7' : '#1a1a1a';
  const muted = dark ? '#a1a1aa' : '#6b7280';
  return (
    <div
      role="dialog"
      aria-label={title}
      style={{ position: 'absolute', inset: 0, zIndex: 20, background: bg, color: text, display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 16px', overflowY: 'auto' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button onClick={onBack} aria-label="Back" style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: text, cursor: 'pointer', fontSize: 15, fontWeight: 600, padding: 0 }}>
          <Icon name="chevronLeft" size={18} /> {title}
        </button>
        <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', display: 'inline-flex' }}>
          <Icon name="x" />
        </button>
      </div>
      {children}
      {footer}
    </div>
  );
}
