import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { hashPassword } from '../lib/passwords.mjs';

// Produces a salted hash only. The entered password is never printed or written.
let password;
if (process.stdin.isTTY) {
  const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output: silent, terminal: true });
  process.stdout.write('Tijdelijk wachtwoord (minimaal 12 tekens; invoer verborgen): ');
  password = await input.question(''); input.close(); process.stdout.write('\n');
} else {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
try { process.stdout.write(`${await hashPassword(password)}\n`); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
