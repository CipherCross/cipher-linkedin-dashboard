import { OpsError } from "./errors.js";
import type {
  CatalogResolver,
  CatalogSnapshot,
} from "./types.js";

export class InMemoryCatalogResolver implements CatalogResolver {
  readonly #catalogs = new Map<string, CatalogSnapshot>();

  constructor(catalogs: readonly CatalogSnapshot[]) {
    for (const catalog of catalogs) {
      const key = this.#key(catalog.catalog_kind, catalog.catalog_version);
      if (this.#catalogs.has(key)) {
        throw new OpsError("catalog_invalid", `Duplicate catalog ${key}`);
      }
      this.#catalogs.set(key, catalog);
    }
  }

  getCatalog(
    kind: CatalogSnapshot["catalog_kind"],
    version: string,
  ): CatalogSnapshot | undefined {
    return this.#catalogs.get(this.#key(kind, version));
  }

  #key(kind: CatalogSnapshot["catalog_kind"], version: string): string {
    return `${kind}:${version}`;
  }
}
