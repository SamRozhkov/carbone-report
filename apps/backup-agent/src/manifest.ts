export const MANIFEST_FILES = ['db.dump', 'storage.tar.gz'] as const;
export type ManifestFileName = (typeof MANIFEST_FILES)[number];

export interface ManifestFile {
  size: number;
  sha256: string;
}

export interface Manifest {
  createdUtc: string | null;
  /** Хеш последней миграции drizzle; null — backup.sh записал «?» или строки нет. */
  lastMigration: string | null;
  files: Record<ManifestFileName, ManifestFile>;
}

/** manifest.txt из backup.sh: created_utc=…, last_migration=…, «<файл> size=N sha256=…». */
export function parseManifest(text: string): Manifest {
  let createdUtc: string | null = null;
  let lastMigration: string | null = null;
  const files: Partial<Record<ManifestFileName, ManifestFile>> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^created_utc=(.+)$/.exec(line))) createdUtc = m[1]!;
    else if ((m = /^last_migration=(.*)$/.exec(line)))
      lastMigration = m[1] && m[1] !== '?' ? m[1] : null;
    else if ((m = /^(db\.dump|storage\.tar\.gz) size=(\d+) sha256=([0-9a-f]{64})$/.exec(line)))
      files[m[1] as ManifestFileName] = { size: Number(m[2]), sha256: m[3]! };
  }
  for (const f of MANIFEST_FILES) if (!files[f]) throw new Error(`manifest.txt: нет строки ${f}`);
  return { createdUtc, lastMigration, files: files as Record<ManifestFileName, ManifestFile> };
}
