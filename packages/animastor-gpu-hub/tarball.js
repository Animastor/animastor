// ======================================================
// GPU Hub — deterministic tar.gz builder (ustar)
// ======================================================
// Pure-JS, dependency-free ustar writer + gzip. Used to serve the worker
// bundle and installer package as single downloadable artifacts.
//
// Determinism contract: entries are written in the given order with a fixed
// mtime (0), uid/gid 0 and fixed modes, so the same input files always
// produce the same sha256 — the checksum published by the setup contract
// stays stable across rebuilds of the same content.

"use strict";

const zlib = require("zlib");

const BLOCK = 512;

function octal(value, length) {
  // Classic tar: zero-padded octal, NUL-terminated.
  const s = value.toString(8);
  if (s.length > length - 1) throw new Error(`tar: value ${value} does not fit in ${length - 1} octal digits`);
  return s.padStart(length - 1, "0") + "\0";
}

function splitName(name) {
  if (Buffer.byteLength(name, "utf8") <= 100) return { prefix: "", name };
  // ustar prefix field: split on a '/' boundary (prefix <= 155, name <= 100).
  const parts = name.split("/");
  let prefix = "";
  let rest = name;
  for (let i = 1; i < parts.length; i += 1) {
    const candidatePrefix = parts.slice(0, i).join("/");
    const candidateRest = parts.slice(i).join("/");
    if (Buffer.byteLength(candidatePrefix, "utf8") <= 155 && Buffer.byteLength(candidateRest, "utf8") <= 100) {
      prefix = candidatePrefix;
      rest = candidateRest;
    }
  }
  if (!prefix || Buffer.byteLength(rest, "utf8") > 100) {
    throw new Error(`tar: entry name too long for ustar: ${name}`);
  }
  return { prefix, name: rest };
}

function headerBlock({ name, size, mode, mtime, type }) {
  const { prefix, name: shortName } = splitName(name);
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(shortName, 0, 100, "utf8");
  buf.write(octal(mode, 8), 100, 8, "utf8");
  buf.write(octal(0, 8), 108, 8, "utf8"); // uid
  buf.write(octal(0, 8), 116, 8, "utf8"); // gid
  buf.write(octal(size, 12), 124, 12, "utf8");
  buf.write(octal(mtime, 12), 136, 12, "utf8");
  buf.write("        ", 148, 8, "utf8"); // checksum placeholder (spaces)
  buf.write(type, 156, 1, "utf8");
  buf.write("ustar\0", 257, 6, "utf8");
  buf.write("00", 263, 2, "utf8");
  buf.write("animastor", 265, 32, "utf8"); // uname
  buf.write("animastor", 297, 32, "utf8"); // gname
  buf.write(prefix, 345, 155, "utf8");

  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf8");
  return buf;
}

/**
 * Build a gzip-compressed ustar archive.
 * @param {Array<{name: string, data: Buffer|string, mode?: number}>} files
 *   Entry names must be relative paths (no leading '/'); directories are
 *   implied by the names.
 * @returns {Buffer} tar.gz bytes (deterministic for identical input)
 */
function buildTarGz(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("tar: at least one file is required");
  }
  const chunks = [];
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), "utf8");
    const name = String(f.name).replace(/^\/+/, "");
    if (!name || name.includes("\0")) throw new Error(`tar: invalid entry name "${f.name}"`);
    chunks.push(headerBlock({ name, size: data.length, mode: f.mode || 0o644, mtime: 0, type: "0" }));
    if (data.length > 0) {
      chunks.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0)); // end-of-archive marker
  const tar = Buffer.concat(chunks);
  return zlib.gzipSync(tar, { level: 9 });
}

/** Collect regular files under dir (recursive), relative POSIX paths. */
function walkDir(fs, dir, base = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const abs = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      out.push(...walkDir(fs, abs, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

module.exports = { buildTarGz, walkDir };
