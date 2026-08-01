import type Database from 'better-sqlite3';

interface Migration {
  readonly version: number;
  readonly sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        state TEXT NOT NULL,
        session_json TEXT NOT NULL
      );
      CREATE TABLE plans (
        task_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        plan_hash TEXT,
        markdown TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        PRIMARY KEY (task_id, version),
        FOREIGN KEY (task_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE plan_approvals (
        task_id TEXT NOT NULL,
        plan_version INTEGER NOT NULL,
        plan_hash TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        PRIMARY KEY (task_id, plan_version),
        FOREIGN KEY (task_id, plan_version) REFERENCES plans(task_id, version) ON DELETE RESTRICT
      );
      CREATE TABLE workflow_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        previous_state TEXT NOT NULL,
        next_state TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        audit_exported INTEGER NOT NULL DEFAULT 0 CHECK (audit_exported IN (0, 1)),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX workflow_events_session_time ON workflow_events(session_id, timestamp);
      CREATE TABLE provider_executions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        provider_session_id TEXT,
        request_hash TEXT,
        result_json TEXT,
        error_code TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX provider_executions_session_time ON provider_executions(session_id, started_at);
      CREATE TABLE worker_iterations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        kind TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        result_json TEXT,
        diff_hash TEXT,
        provider_response_hash TEXT,
        UNIQUE (session_id, iteration, kind),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE review_decisions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        phase TEXT NOT NULL,
        verdict TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE review_findings (
        session_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        status TEXT NOT NULL,
        severity TEXT NOT NULL,
        first_seen_iteration INTEGER NOT NULL,
        last_seen_iteration INTEGER NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 1,
        finding_json TEXT NOT NULL,
        PRIMARY KEY (session_id, finding_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE quality_gate_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        iteration INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        report_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE workspace_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        path TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        workspace_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE user_decisions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE token_usage (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        provider_execution_id TEXT,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (provider_execution_id) REFERENCES provider_executions(id) ON DELETE SET NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE approval_challenges (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('PLAN', 'APPLY')),
        subject_hash TEXT NOT NULL,
        plan_version INTEGER,
        source_baseline TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONSUMED', 'EXPIRED', 'CANCELLED')),
        consumed_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX approval_challenges_session_purpose
        ON approval_challenges(session_id, purpose, created_at);
      CREATE UNIQUE INDEX approval_challenges_one_pending
        ON approval_challenges(session_id, purpose) WHERE status = 'PENDING';
    `,
  },
  {
    version: 3,
    sql: `
      UPDATE provider_executions
      SET status = 'FAILED',
          completed_at = COALESCE(
            (SELECT sessions.updated_at FROM sessions WHERE sessions.id = provider_executions.session_id),
            started_at
          ),
          error_code = 'AF_PERSISTENCE_STARTUP'
      WHERE role = 'worker'
        AND status = 'STARTED'
        AND EXISTS (
          SELECT 1 FROM sessions
          WHERE sessions.id = provider_executions.session_id
            AND sessions.state = 'PAUSED'
        )
        AND NOT EXISTS (
          SELECT 1 FROM worker_iterations
          WHERE worker_iterations.session_id = provider_executions.session_id
            AND worker_iterations.started_at = provider_executions.started_at
        );
    `,
  },
];

export const runMigrations = (database: Database.Database): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const rows = database.prepare('SELECT version FROM schema_migrations').all() as readonly {
    version: number;
  }[];
  const applied = new Set(rows.map((row) => row.version));
  const apply = database.transaction((migration: Migration): void => {
    database.exec(migration.sql);
    database
      .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(migration.version, new Date().toISOString());
  });
  for (const migration of migrations) {
    if (!applied.has(migration.version)) apply.immediate(migration);
  }
};
