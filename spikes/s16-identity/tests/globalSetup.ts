/**
 * One clean-room container for the whole clean-room suite.
 *
 * Per-file containers would cost ~15 s each and prove nothing extra: the
 * baseline is applied identically every time. Files run serially
 * (`fileParallelism: false`) so they cannot race on the shared schema.
 */

import type { TestProject } from 'vitest/node'

import { startCleanRoom, type CleanRoom } from '../src/cleanRoom.js'

let room: CleanRoom | null = null

export async function setup(project: TestProject): Promise<void> {
  room = await startCleanRoom()
  // Localhost connection strings for an ephemeral container. They exist only
  // in this process's memory and are never written to a file.
  project.provide('runtimeUrl', room.runtimeUrl)
  project.provide('ownerUrl', room.ownerUrl)
  project.provide('identityStoreUrl', room.identityStoreUrl)
}

export async function teardown(): Promise<void> {
  await room?.stop()
  room = null
}

declare module 'vitest' {
  interface ProvidedContext {
    runtimeUrl: string
    ownerUrl: string
    identityStoreUrl: string
  }
}
