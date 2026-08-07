/**
 * Where a copy reads *from* — a port with one implementation, over a directory.
 *
 * ## Why the source is a directory and not the Supabase Storage API
 *
 * The obvious shape for "copy the old bucket into the new one" is a source
 * adapter that speaks Supabase Storage, and it was rejected for a reason that is
 * about the constraint on this work rather than about elegance:
 *
 * - **This session may not copy production bytes and may not add a credential.**
 *   A Supabase-Storage source could therefore be written but never run, and an
 *   unrun transport is exactly the kind of code that turns out to be wrong at
 *   cutover, when there is no time.
 * - **The export already exists as a supported operation.** Supabase's own CLI
 *   and `rclone` both mirror a bucket to a directory, and `S27`'s freeze window
 *   wants the bytes on disk anyway — a copy that streams provider-to-provider
 *   cannot be resumed after a network failure without re-listing both ends, and
 *   cannot be checksummed before the destination is written.
 * - **A directory is the widest possible source.** The same tool copies from a
 *   Supabase export, from an S3 sync, or from a laptop holding a partial
 *   recovery. `ObjectSource` stays a port so a streaming adapter can be added
 *   when someone can actually run it.
 *
 * So the operator exports the bucket with existing tooling, and this reads what
 * came out. What the tool owns is the part nothing else does: the deterministic
 * key mapping, the checksums, and the refusals.
 *
 * ## The refusals, and why they are here rather than at the key builder
 *
 * `keys.ts` refuses a bad *key*. This refuses a bad *path on disk*, which is a
 * different attack surface with the same shape: an export directory is written by
 * tooling nobody in this repository controls, and it can contain a symlink, an
 * absolute path in a listing file, or a name that escapes the root when joined.
 *
 * - **Symlinks are skipped, not followed.** `lstat`, never `stat`. A symlink in
 *   an export is either an artifact of the export tool or an attempt to make the
 *   copy read `/etc/passwd` and upload it into a bucket the dashboard serves to
 *   every team member.
 * - **A path is re-validated on read**, not only during the walk, because
 *   `readObject` is a public method and a caller can pass anything to it. The
 *   check is a containment check on the *resolved* path, so `..`, an absolute
 *   path and a Unicode-normalized separator are all refused without being
 *   enumerated.
 */

import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { DataStoreContractError } from '../data/contracts.js'

export class ObjectSourceError extends DataStoreContractError {
  constructor(message: string) {
    super('OBJECT_SOURCE_INVALID', message)
    this.name = 'ObjectSourceError'
  }
}

export interface SourceObject {
  /** Source-relative path with `/` separators, whatever the platform uses. */
  readonly path: string
  readonly sizeBytes: number
}

export interface ObjectSource {
  /** Recorded in the copy report; never in a manifest. */
  readonly name: string
  /** Every object, sorted by path so a run's order is reproducible. */
  listObjects(): Promise<readonly SourceObject[]>
  readObject(path: string): Promise<Uint8Array>
}

/**
 * Entries a bucket export routinely contains that are not objects.
 *
 * Skipped silently rather than reported as findings: `.DS_Store` in an export
 * from a Mac is noise, and a report whose findings list is mostly noise is a
 * report nobody reads to the end.
 */
const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep'])

export interface FilesystemObjectSourceOptions {
  readonly root: string
  /** Cap on how deep the walk goes. Guards against a cyclic mount, not a layout. */
  readonly maxDepth?: number
}

export class FilesystemObjectSource implements ObjectSource {
  readonly name = 'filesystem'

  private readonly root: string
  private readonly maxDepth: number

  constructor(options: FilesystemObjectSourceOptions) {
    if (!options.root || options.root.trim() === '') {
      throw new ObjectSourceError('A filesystem object source needs a root')
    }
    this.root = resolve(options.root)
    this.maxDepth = options.maxDepth ?? 8
  }

  async listObjects(): Promise<readonly SourceObject[]> {
    const found: SourceObject[] = []
    await this.walk(this.root, 0, found)
    // Sorted here so a caller's manifest, report and progress log all agree, and
    // so a re-run visits the objects in the same order after an interruption.
    found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return found
  }

  async readObject(path: string): Promise<Uint8Array> {
    const absolute = this.resolveInside(path)
    const stat = await lstat(absolute)
    if (!stat.isFile()) {
      throw new ObjectSourceError(
        `${JSON.stringify(path)} is not a regular file in the source`,
      )
    }
    return new Uint8Array(await readFile(absolute))
  }

  /**
   * Turn a source-relative path into an absolute one that is provably inside the
   * root.
   *
   * The containment test is on the *resolved* path and uses the platform
   * separator, so it holds for `../`, for an absolute path, and for the case a
   * prefix comparison gets wrong — a sibling directory whose name starts with
   * the root's name (`/export` vs `/export-old`).
   */
  private resolveInside(path: string): string {
    if (typeof path !== 'string' || path === '' || isAbsolute(path)) {
      throw new ObjectSourceError(
        `A source path must be a non-empty relative path, not ` +
          `${JSON.stringify(path)}`,
      )
    }
    const absolute = resolve(this.root, path)
    const inside = relative(this.root, absolute)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      throw new ObjectSourceError(
        `A source path must stay inside the source root; ` +
          `${JSON.stringify(path)} does not`,
      )
    }
    return absolute
  }

  private async walk(
    directory: string,
    depth: number,
    found: SourceObject[],
  ): Promise<void> {
    if (depth > this.maxDepth) {
      throw new ObjectSourceError(
        `The source tree is deeper than ${this.maxDepth} levels at ` +
          `${JSON.stringify(relative(this.root, directory))}; refusing to walk ` +
          `further rather than following what may be a cycle`,
      )
    }

    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) continue
      const absolute = join(directory, entry.name)

      if (entry.isDirectory()) {
        await this.walk(absolute, depth + 1, found)
        continue
      }

      // **Regular files only, and this line is what refuses a symlink.**
      //
      // `readdir(withFileTypes)` reports the entry's own kind without resolving
      // it, so `isFile()` is false for a symlink however tempting its target
      // looks — a link is skipped rather than followed, which is the property the
      // header argues for. An explicit `isSymbolicLink()` branch stood here
      // first; the mutation pass showed that deleting it reddened nothing,
      // because this check already excluded links. It is gone, so the guard that
      // enforces the rule is the one a test can reach: a mutation that widens
      // this to `!entry.isFile() && !entry.isSymbolicLink()` reddens.
      if (!entry.isFile()) continue

      const stat = await lstat(absolute)
      found.push({
        path: relative(this.root, absolute).split(sep).join('/'),
        sizeBytes: stat.size,
      })
    }
  }
}
