// Code-native SVG paths: no font glyphs, images, external requests or icon fonts.
export const QUERY_ICON_PATHS = {
  check: ["m5 12 4 4L19 6"],
  done: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z", "m7 12 3 3 7-7"],
  info: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z", "M12 11v6", "M12 7h.01"],
  warning: ["M10.3 3.9 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z", "M12 9v4", "M12 17h.01"],
  error: ["M9 2h6l7 7v6l-7 7H9l-7-7V9Z", "M12 7v6", "M12 17h.01"],
  cancellation: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z", "m8.5 8.5 7 7m0-7-7 7"],
  close: ["m6 6 12 12M18 6 6 18"],
  copy: ["M9 9h11v11H9Z", "M15 5V3H3v12h2"],
  loader: ["M20.5 12a8.5 8.5 0 1 1-4.1-7.3"],
} as const;

export type QueryIconName = keyof typeof QUERY_ICON_PATHS;
