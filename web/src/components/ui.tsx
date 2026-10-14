import type { ReactNode } from 'react';

// Compact, institutional chrome. Single type family (Montserrat) —
// see DESIGN.md at the project root; that file is the source of truth.

export function PageHeader({ title, sub, right }: { title: string; sub: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 sm:gap-6 mb-8">
      <h1 className="font-display text-[24px] leading-none font-semibold text-paper">{title}</h1>
      {right}
    </div>
  );
}

// Vibrant status fills (arbitrary hex so they hot-reload without a
// tailwind.config change); white text per spec.
const TONES: Record<string, string> = {
  ALLOWED: 'bg-[#4CAF50]',
  APPROVED: 'bg-[#4CAF50]',
  DENIED: 'bg-[#E0522A]',
  REJECTED: 'bg-[#E0522A]',
  EXPIRED: 'bg-[#8A8474]',
  pending: 'bg-[#E8A020]',
  approved: 'bg-[#4CAF50]',
  rejected: 'bg-[#E0522A]',
  approve: 'bg-[#4CAF50]',
  reject: 'bg-[#E0522A]',
  expired: 'bg-[#8A8474]',
};

export function Badge({ value }: { value: string }) {
  const bg = TONES[value] ?? 'bg-[#8A8474]';
  const label = value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  return (
    <span className={`inline-flex items-center px-2 py-1 rounded-md ${bg}`}>
      <span className="font-mono text-[11px] font-medium leading-none tracking-[0.04em] text-black">{label}</span>
    </span>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: 'pending' | 'ok' | 'danger' }) {
  const color = tone === 'pending' ? 'text-[#E8A020]' : tone === 'ok' ? 'text-[#4CAF50]' : tone === 'danger' ? 'text-[#E0522A]' : 'text-paper';
  return (
    <div className="border border-line bg-black px-4 py-3 rounded-lg">
      <p className="font-mono text-[11px] tracking-[0.04em] text-paper mb-1">{label}</p>
      <p className={`font-mono text-xl tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

export function Mono({ children, className = '', title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`min-w-0 font-mono text-[13px] tabular-nums text-paper ${className}`}>
      {children}
    </span>
  );
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}
