// Zod schemas and inferred types shared by the API and the web app — the single
// source of truth for request/response shapes. Must stay decorator-free so the
// Vite build can consume it from source.
export * from './common';
export * from './identity';
export * from './inventory';
export * from './catalog';
export * from './pricing';
