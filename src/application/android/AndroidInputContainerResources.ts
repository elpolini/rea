import type { Dir, Stats } from "node:fs";
import { opendir, type FileHandle } from "node:fs/promises";

import { OwnedDirectoryHandle } from "../../filesystem/OwnedDirectoryHandle.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import {
  openRegularFile,
  RegularFileAdmissionFailure,
} from "../../filesystem/RegularFile.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";

/** One admitted descriptor and the metadata identifying its contents. */
export interface AdmittedContainerFile {
  readonly owner: OwnedFileHandle;
  readonly handle: FileHandle;
  readonly initial: Stats;
}

/** Unresolved cleanup of one container admission. */
export interface ContainerCleanupFailure {
  readonly resources: readonly string[];
  readonly reason: string;
  readonly causes: readonly unknown[];
}

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Descriptors and the private extraction workspace of one container admission.
 * Release closes descriptors before removing the workspace that may contain
 * their files; anything that cannot be released stays owned for a retry.
 */
export class AndroidContainerResources {
  readonly #files = new Map<OwnedFileHandle, string>();
  readonly #directories = new Map<OwnedDirectoryHandle, string>();
  #root: PrivateRuntimeRoot | undefined;
  #rootPromise: Promise<PrivateRuntimeRoot> | undefined;

  /** Allocate the private workspace on first use. */
  async workspace(): Promise<string> {
    this.#rootPromise ??= PrivateRuntimeRoot.create({
      prefix: "rea-android-input-",
    }).then((root) => {
      this.#root = root;
      return root;
    });
    return (await this.#rootPromise).path;
  }

  /** Open one regular file without following a final symlink. */
  async open(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<AdmittedContainerFile> {
    let handle: FileHandle;
    try {
      handle = await openRegularFile(path, { symlinks: "reject", signal });
    } catch (cause: unknown) {
      // An admission failure whose close also failed transfers its owner here.
      if (cause instanceof RegularFileAdmissionFailure)
        this.#files.set(cause.owner, path);
      throw cause;
    }
    const owner = new OwnedFileHandle(handle);
    this.#files.set(owner, path);
    return { owner, handle, initial: await handle.stat() };
  }

  /** Close one descriptor now; a failed close stays owned for release. */
  async close(file: AdmittedContainerFile): Promise<void> {
    await file.owner.close();
    this.#files.delete(file.owner);
  }

  async openDirectory(path: string): Promise<OwnedDirectoryHandle> {
    const directory: Dir = await opendir(path);
    const owner = new OwnedDirectoryHandle(directory);
    this.#directories.set(owner, path);
    return owner;
  }

  async closeDirectory(owner: OwnedDirectoryHandle): Promise<void> {
    await owner.close();
    this.#directories.delete(owner);
  }

  /** Close every remaining descriptor, then remove the workspace. */
  async release(): Promise<ContainerCleanupFailure | undefined> {
    const causes: unknown[] = [];
    const resources: string[] = [];
    for (const [owner, path] of [...this.#files, ...this.#directories]) {
      try {
        await owner.close();
        if (owner instanceof OwnedFileHandle) this.#files.delete(owner);
        else this.#directories.delete(owner);
      } catch (cause: unknown) {
        causes.push(cause);
        resources.push(path);
      }
    }
    // An unsettled allocation still owns the workspace it may create.
    await this.#rootPromise?.catch(() => undefined);
    if (causes.length === 0 && this.#root !== undefined) {
      try {
        await this.#root.close();
        this.#root = undefined;
      } catch (cause: unknown) {
        causes.push(cause);
      }
    }
    if (this.#root !== undefined && causes.length > 0)
      resources.push(this.#root.path);
    return causes.length === 0
      ? undefined
      : {
          resources,
          reason: causes.map(failureMessage).join("; "),
          causes,
        };
  }
}
