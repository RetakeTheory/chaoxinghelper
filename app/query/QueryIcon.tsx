import { QUERY_ICON_PATHS, type QueryIconName } from "../../lib/query-icons";

export function QueryIcon({ name, className = "" }: { name: QueryIconName; className?: string }) {
  return <svg className={`cx-query-icon${className ? ` ${className}` : ""}`} data-query-icon={name}
    viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {QUERY_ICON_PATHS[name].map((path, index) => <path key={index} d={path} />)}
  </svg>;
}
