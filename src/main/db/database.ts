import Database from 'better-sqlite3'
import { app } from 'electron'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, renameSync, unlinkSync } from 'fs'

let db: Database.Database | null = null

export function databasePathFor(userDataPath: string): string {
  return join(userDataPath, 'data', 'anything-register.db')
}

/**
 * Get or initialize the SQLite database connection.
 * Database file is stored in the app's user data directory.
 */
export function getDatabase(): Database.Database {
  if (db) return db

  const userDataPath = app.getPath('userData')
  const dbDir = join(userDataPath, 'data')

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  const dbPath = databasePathFor(userDataPath)

  db = new Database(dbPath)

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  return db
}

/** Import a consistent SQLite snapshot without copying WAL/SHM sidecars. */
export async function importDatabaseSnapshot(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  if (!existsSync(sourcePath)) throw new Error('Source database does not exist')
  if (existsSync(destinationPath)) {
    throw new Error('Destination database already exists')
  }

  const destinationDir = dirname(destinationPath)
  mkdirSync(destinationDir, { recursive: true })
  const temporaryPath = `${destinationPath}.importing-${process.pid}`
  if (existsSync(temporaryPath)) unlinkSync(temporaryPath)

  const source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    await source.backup(temporaryPath)
    renameSync(temporaryPath, destinationPath)
  } finally {
    source.close()
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

/** Back up an existing pre-browser-backend database once before migration 011. */
export async function backupBeforeBrowserMigration(database: Database.Database): Promise<string | null> {
  const hasSessionsTable = Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
  ).get())
  const hasBrowserConfig = Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_browser_config'",
  ).get())
  if (!hasSessionsTable || hasBrowserConfig) return null

  const sessionCount = (database.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count
  if (sessionCount === 0) return null

  const backupDir = join(app.getPath('userData'), 'data', 'backups')
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const destination = join(backupDir, `anything-register-pre-browser-${stamp}.db`)
  await database.backup(destination)
  return destination
}

/**
 * Close the database connection (called on app quit).
 */
export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
