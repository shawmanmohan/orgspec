const cache = new Map<string, RegExp>();

/**
 * Minimal glob → RegExp: `**` matches across `/`, `*` within one segment, `?` one character.
 * Patterns are matched against forward-slash relative paths.
 */
export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

export const matchesGlob = (path: string, glob: string): boolean => globToRegExp(glob).test(path);

export const matchesAny = (path: string, globs: readonly string[]): boolean => globs.some((g) => matchesGlob(path, g));
