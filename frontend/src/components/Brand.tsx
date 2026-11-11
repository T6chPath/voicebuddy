/** The zenvqo mark: a peacock-feather eye (peacock teal rings around a marigold centre). */
export function Eye({ big = false, className = "" }: { big?: boolean; className?: string }) {
  return (
    <svg className={`eye${big ? " eye-big" : ""}${className ? " " + className : ""}`} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path d="M32 3C46 13 56 26 56 39a24 24 0 0 1-48 0C8 26 18 13 32 3z" fill="var(--accent)" />
      <ellipse cx="32" cy="39" rx="15" ry="16" fill="var(--bg-elev)" opacity=".92" />
      <ellipse cx="32" cy="40" rx="11" ry="12" fill="#1f4e8c" />
      <ellipse cx="32" cy="41" rx="6.5" ry="7.5" fill="var(--marigold)" />
      <ellipse cx="30" cy="38.5" rx="2" ry="2.4" fill="#fff" opacity=".85" />
    </svg>
  );
}
