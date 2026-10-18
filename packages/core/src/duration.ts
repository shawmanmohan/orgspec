const S = 1000;
const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;
const UNIT: Record<string, number> = { s: S, m: M, h: H, d: D };

/** `30s`, `2m`, `15m`, `24h`, `1d` → milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(text.trim());
  if (!m?.[1] || !m[2]) throw new Error(`Invalid duration "${text}"; use forms like 30s, 2m, 15m, 24h`);
  return Math.round(Number(m[1]) * (UNIT[m[2]] as number));
}

export function formatDuration(ms: number): string {
  if (ms % D === 0) return `${ms / D}d`;
  if (ms % H === 0) return `${ms / H}h`;
  if (ms % M === 0) return `${ms / M}m`;
  return `${Math.round(ms / 1000)}s`;
}

export const isDuration = (text: string): boolean => {
  try {
    parseDuration(text);
    return true;
  } catch {
    return false;
  }
};

/** `HH:MM` in the given hours window, where the window may cross midnight (19:00–09:00). */
export function inWindow(now: Date, start: string, end: string): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMin = (t: string) => {
    const [h = '0', m = '0'] = t.split(':');
    return Number(h) * 60 + Number(m);
  };
  const s = toMin(start);
  const e = toMin(end);
  return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}
