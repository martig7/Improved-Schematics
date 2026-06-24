/**
 * React shim - provides React from the game's API at runtime.
 * This allows JSX to work in mod files.
 *
 * At build time, Vite aliases 'react' and 'react/jsx-runtime' imports to this file.
 * At runtime, we pull React from the game's API.
 */

// Get React from the game's API
const React = window.SubwayBuilderAPI.utils.React;

export default React;
export const {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
  useReducer,
  useContext,
  createContext,
  createElement,
  Fragment,
} = React;

// JSX runtime shim for the automatic transform. The runtime calls
//   jsx(type, { children, ...props }, key)
// with `children` INSIDE the props object and `key` as a separate third arg —
// which is NOT createElement's (type, config, ...children) shape. Forwarding
// straight to createElement makes the `key` land as the element's only child,
// so any KEYED host element renders its key (e.g. "sel-0") instead of its real
// children. Translate properly: lift children out to trailing args, fold key in.
/* eslint-disable @typescript-eslint/no-explicit-any */
function h(type: any, config: any, maybeKey?: any): any {
  const { children, ...props } = config ?? {};
  if (maybeKey !== undefined) props.key = maybeKey;
  if (children === undefined) return React.createElement(type, props);
  return Array.isArray(children)
    ? React.createElement(type, props, ...children)
    : React.createElement(type, props, children);
}
export const jsx = h;
export const jsxs = h;
export const jsxDEV = h;
