import * as fs from 'fs'

const JSONL_READ_CHUNK_BYTES = 1024 * 1024
const JSONL_BOUNDARY_BYTES = 4096
const JSONL_MAX_LINE_BYTES = 16 * 1024 * 1024

/**
 * Read a chunk of bytes from a file at a given offset.
 * Uses try/finally to guarantee the file descriptor is always closed.
 */
export function readFileChunk(filePath: string, offset: number, length: number): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, offset)
    return buffer.toString('utf-8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Read new lines appended to a file since `lastSize` bytes.
 * Returns the new lines, updated file size, and any trailing partial line
 * (bytes past the last newline) as `tail` — pass it back on the next call as
 * `lastTail` to reassemble lines split across reads. If callers ignore `tail`,
 * they silently lose any line that wasn't fully flushed by the writer yet.
 * Handles truncation (file shrunk) by resetting to 0.
 */
export function readNewFileLines(
  filePath: string,
  lastSize: number,
  lastTail = '',
): { lines: string[]; newSize: number; tail: string } | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch { return null /* expected if file was removed */ }

  if (stat.size < lastSize) {
    // File was truncated — reset both size and tail
    return { lines: [], newSize: 0, tail: '' }
  }
  if (stat.size <= lastSize) {
    return null
  }

  const newContent = lastTail + readFileChunk(filePath, lastSize, stat.size - lastSize)
  const parts = newContent.split(/\r?\n/)
  // Last fragment is whatever follows the final newline — empty if the file
  // ended on a newline, otherwise a partial line we need to carry forward.
  const tail = parts.pop() ?? ''
  const lines = parts.filter(Boolean)
  return { lines, newSize: stat.size, tail }
}

/** Result from {@link IncrementalJsonlReader.read}. */
export interface IncrementalJsonlReadResult {
  lines: string[]
  reset: boolean
  droppedLines: number
}

/**
 * Incrementally read newline-delimited UTF-8 without decoding partial code
 * points. Boundary anchors detect truncation and in-place rewrites; callers can
 * suppress replay by entry id when `reset` is true.
 */
export class IncrementalJsonlReader {
  private offset = 0
  private pending = Buffer.alloc(0)
  private prefix = Buffer.alloc(0)
  private boundary = Buffer.alloc(0)
  private dev: number | null = null
  private ino: number | null = null
  private droppingOversizedLine = false

  read(filePath: string): IncrementalJsonlReadResult | null {
    let stat: fs.Stats
    try { stat = fs.statSync(filePath) }
    catch { return null }

    let reset = false
    const identityChanged = this.dev !== null && (this.dev !== stat.dev || this.ino !== stat.ino)
    const anchorsChanged = this.offset > 0 && !this.matchesAnchors(filePath)
    if (identityChanged || stat.size < this.offset || anchorsChanged) {
      this.reset()
      reset = true
    }

    if (stat.size === this.offset) {
      this.rememberIdentity(stat)
      return reset ? { lines: [], reset, droppedLines: 0 } : null
    }

    const lines: string[] = []
    let droppedLines = 0
    let fd: number
    try { fd = fs.openSync(filePath, 'r') } catch { return null }
    try {
      while (this.offset < stat.size) {
        const length = Math.min(JSONL_READ_CHUNK_BYTES, stat.size - this.offset)
        const chunk = Buffer.allocUnsafe(length)
        const bytesRead = fs.readSync(fd, chunk, 0, length, this.offset)
        if (bytesRead <= 0) break
        this.offset += bytesRead
        let data = chunk.subarray(0, bytesRead)

        if (this.droppingOversizedLine) {
          const newline = data.indexOf(0x0a)
          if (newline < 0) continue
          data = data.subarray(newline + 1)
          this.droppingOversizedLine = false
        }

        if (this.pending.length > 0) data = Buffer.concat([this.pending, data])
        let start = 0
        for (;;) {
          const newline = data.indexOf(0x0a, start)
          if (newline < 0) break
          let line = data.subarray(start, newline)
          if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
          if (line.length > JSONL_MAX_LINE_BYTES) droppedLines++
          else if (line.length > 0) lines.push(line.toString('utf8'))
          start = newline + 1
        }

        this.pending = Buffer.from(data.subarray(start))
        if (this.pending.length > JSONL_MAX_LINE_BYTES) {
          this.pending = Buffer.alloc(0)
          this.droppingOversizedLine = true
          droppedLines++
        }
      }
      this.prefix = this.readPrefix(fd)
      this.boundary = this.readBoundary(fd)
    } finally {
      fs.closeSync(fd)
    }
    this.rememberIdentity(stat)
    return { lines, reset, droppedLines }
  }

  private matchesAnchors(filePath: string): boolean {
    if (this.prefix.length === 0 && this.boundary.length === 0) return true
    let fd: number | null = null
    try {
      fd = fs.openSync(filePath, 'r')
      const prefix = readBuffer(fd, 0, this.prefix.length)
      return prefix.equals(this.prefix) && this.readBoundary(fd).equals(this.boundary)
    } catch { return false }
    finally { if (fd !== null) fs.closeSync(fd) }
  }

  private readPrefix(fd: number): Buffer {
    return readBuffer(fd, 0, Math.min(JSONL_BOUNDARY_BYTES, this.offset))
  }

  private readBoundary(fd: number): Buffer {
    const length = Math.min(JSONL_BOUNDARY_BYTES, this.offset)
    if (length === 0) return Buffer.alloc(0)
    const buffer = Buffer.allocUnsafe(length)
    const bytesRead = fs.readSync(fd, buffer, 0, length, this.offset - length)
    return Buffer.from(buffer.subarray(0, bytesRead))
  }

  private rememberIdentity(stat: fs.Stats): void {
    this.dev = stat.dev
    this.ino = stat.ino
  }

  private reset(): void {
    this.offset = 0
    this.pending = Buffer.alloc(0)
    this.prefix = Buffer.alloc(0)
    this.boundary = Buffer.alloc(0)
    this.droppingOversizedLine = false
  }
}

function readBuffer(fd: number, offset: number, length: number): Buffer {
  if (length === 0) return Buffer.alloc(0)
  const buffer = Buffer.allocUnsafe(length)
  const bytesRead = fs.readSync(fd, buffer, 0, length, offset)
  return Buffer.from(buffer.subarray(0, bytesRead))
}

/** Case-fold a path string for comparison on Windows, where the filesystem is
 *  case-insensitive and tools disagree on drive-letter case (VS Code reports
 *  `c:\...`, Claude Code and most shells report `C:\...`). Identity elsewhere. */
export function foldPathCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}
