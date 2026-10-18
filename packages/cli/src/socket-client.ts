import { connect } from 'node:net';
import { localPaths } from '@orgspec/core/paths';

/** Thin-client hook: forwards the tool call to the warm daemon over its Unix socket. */
export async function hookViaSocket(io: { out: (s: string) => void; err: (s: string) => void }): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const input = Buffer.concat(chunks).toString('utf8').replace(/\n/g, ' ');
  const answer = await new Promise<string>((resolve, reject) => {
    const sock = connect(localPaths().socket);
    let buf = '';
    sock.setTimeout(2000, () => sock.destroy(new Error('daemon did not answer')));
    sock.on('data', (d) => {
      buf += d.toString();
    });
    sock.on('end', () => resolve(buf.trim()));
    sock.on('error', reject);
    sock.write(`${input}\n`);
  }).catch(async () => {
    // Daemon unavailable: evaluate in-process instead of failing open.
    const { preToolUse } = await import('@orgspec/app/hook');
    const out = preToolUse(JSON.parse(input || '{}'));
    return out ? JSON.stringify(out) : '';
  });
  if (answer && !answer.startsWith('{"error"')) io.out(`${answer}\n`);
  return 0;
}
