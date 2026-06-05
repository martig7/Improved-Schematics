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
  useCallback,
  useMemo,
  useRef,
  useReducer,
  useContext,
  createContext,
  createElement,
  Fragment,
} = React;

// JSX runtime exports for the automatic JSX transform
export const jsx = React.createElement;
export const jsxs = React.createElement;
export const jsxDEV = React.createElement;
