import type { ReactNode } from 'react';

/**
 * Shared table chrome: bordered rounded wrapper + styled header row, so
 * every table in the app looks and behaves identically.
 */
export function DataTable({
  columns,
  children,
}: {
  columns: { label: string; align?: 'left' | 'right' }[];
  children: ReactNode;
}) {
  return (
    <div className="border border-line rounded-xl overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse">
        <thead>
          <tr className="bg-black">
            {columns.map((c, i) => (
              <th
                key={i}
                className={`border-b border-line px-4 py-2.5 font-mono text-[11px] font-medium tracking-[0.04em] text-paper ${
                  c.align === 'right' ? 'text-right' : 'text-left'
                }`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Standard body cell — left variant. */
export function Td({ className = '', children }: { className?: string; children: ReactNode }) {
  return <td className={`border-l border-line px-4 py-2.5 text-[13px] text-paper ${className}`}>{children}</td>;
}

/** Standard body cell — right-aligned numeric variant. */
export function TdRight({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <td className={`border-l border-line px-4 py-2.5 text-right font-mono text-[13px] tabular-nums text-paper whitespace-nowrap ${className}`}>
      {children}
    </td>
  );
}
