// Inline SVG icons (no icon font, no network). Decorative: always aria-hidden; buttons carry their own labels.
const P: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  menu: "M4 6h16M4 12h16M4 18h16",
  send: "M5 12h14M13 6l6 6-6 6",
  stop: "M7 7h10v10H7z",
  clip: "M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L15 7.5",
  copy: "M9 9h10v10H9zM5 15V5h10",
  check: "M5 12l4 4 10-10",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3",
  pin: "M12 17v5M8 3h8l-1 6 3 3H6l3-3z",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
  file: "M14 3H6v18h12V7zM14 3v4h4",
  close: "M6 6l12 12M18 6L6 18",
  down: "M12 5v14M6 13l6 6 6-6",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  image: "M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9.5a1.5 1.5 0 1 0 0-.01",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  wand: "M15 4V2M15 10V8M12 5h-2M20 5h-2M18 7.5l1.5 1.5M18 2.5L19.5 1M3 21l11-11 2 2L5 23z",
  brush: "M14 4l6 6-8 8H6v-6zM3 21c2 0 3-1 3-3",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  scissors: "M6 9a3 3 0 1 0 0-.01M6 21a3 3 0 1 0 0-.01M8.5 7.5L20 19M8.5 16.5L20 5",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  eraser: "M8 20h12M5 15l9-9 5 5-9 9H8z",
  speaker: "M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11",
  speakerOff: "M4 9v6h4l5 4V5L8 9zM17 10l4 4M21 10l-4 4",
  play: "M7 5l12 7-12 7z",
  pdf: "M14 3H6v18h12V7zM14 3v4h4M8.5 16v-4h1.3a1.2 1.2 0 0 1 0 2.4H8.5M12.5 16v-4h1a2 2 0 0 1 0 4zM16.5 16v-4h2M16.5 14h1.6",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3M9 21h6",
  micOff: "M12 3a3 3 0 0 0-3 3v4M15 9.5V6a3 3 0 0 0-5.2-2M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M9 21h6M3 3l18 18",
  hangup: "M3 15c5-5 13-5 18 0l-2.5 2.5-3-1.5v-2.5a10 10 0 0 0-5 0V16l-3 1.5z",
  replay: "M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5M10.5 9.5l4 2.5-4 2.5z",
  pause: "M8 5v14M16 5v14",
  alert: "M12 8v5M12 16.5v.5M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
};

export function Icon({ name, size = 18 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={P[name] || ""} />
    </svg>
  );
}
