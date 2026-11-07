// writeOut's two guards: stay inside the working directory, and never clobber
// a previous run's output unless the caller explicitly asked for it.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeOut } from '../scripts/lib.mjs';

let dir;
let cwd;

beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'wpm-writeout-'));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

test('writes under the working directory and creates parent dirs', () => {
  const rel = writeOut('out/inventory.json', '{"ok":true}');
  assert.equal(rel, 'out/inventory.json');
  assert.equal(readFileSync('out/inventory.json', 'utf8'), '{"ok":true}');
});

test('refuses to overwrite an existing file', () => {
  writeOut('out/report.md', 'first');
  assert.throws(() => writeOut('out/report.md', 'second'), /refusing to overwrite/);
  assert.equal(readFileSync('out/report.md', 'utf8'), 'first');
});

test('overwrites only when force is passed', () => {
  writeOut('out/report.md', 'first');
  writeOut('out/report.md', 'second', { force: true });
  assert.equal(readFileSync('out/report.md', 'utf8'), 'second');
});

test('refuses an absolute path', () => {
  const outside = join(tmpdir(), `wpm-escape-${process.pid}.txt`);
  assert.throws(() => writeOut(outside, 'nope'), /outside the working directory/);
  assert.equal(existsSync(outside), false);
});

test('refuses a path that climbs out with ..', () => {
  for (const p of ['../escaped.txt', '../../escaped.txt', 'out/../../escaped.txt']) {
    assert.throws(() => writeOut(p, 'nope'), /outside the working directory/);
  }
  assert.equal(existsSync(join(dir, '..', 'escaped.txt')), false);
});

test('refuses to write to the working directory itself', () => {
  assert.throws(() => writeOut('.', 'nope'), /outside the working directory/);
  assert.throws(() => writeOut('', 'nope'), /outside the working directory/);
});

test('refuses an --out directory that is a symlink pointing outside', () => {
  const target = mkdtempSync(join(tmpdir(), 'wpm-target-'));
  try {
    symlinkSync(target, join(dir, 'out'));
    assert.throws(() => writeOut('out/inventory.json', 'nope'), /outside the working directory/);
    assert.equal(existsSync(join(target, 'inventory.json')), false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('allows a symlinked --out directory that stays inside the tree', () => {
  mkdirSync(join(dir, 'real'));
  symlinkSync(join(dir, 'real'), join(dir, 'out'));
  writeOut('out/inventory.json', 'ok');
  assert.equal(readFileSync(join(dir, 'real', 'inventory.json'), 'utf8'), 'ok');
});

test('refuses to clobber a file that already exists under a nested --out', () => {
  mkdirSync(join(dir, 'deep', 'nested'), { recursive: true });
  writeFileSync(join(dir, 'deep', 'nested', 'x.csv'), 'original');
  assert.throws(() => writeOut('deep/nested/x.csv', 'new'), /refusing to overwrite/);
});
