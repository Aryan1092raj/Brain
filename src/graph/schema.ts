export const KUZU_DDL = [
  `CREATE NODE TABLE IF NOT EXISTS File(
    path         STRING,
    repo         STRING,
    language     STRING,
    line_count   INT64   DEFAULT 0,
    decay_score  DOUBLE  DEFAULT 1.0,
    stability    DOUBLE  DEFAULT 30.0,
    last_touched TIMESTAMP,
    created_at   TIMESTAMP,
    PRIMARY KEY(path)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Symbol(
    fqn          STRING,
    kind         STRING,
    name         STRING,
    file         STRING,
    line_start   INT64,
    line_end     INT64,
    repo         STRING,
    is_exported  BOOLEAN DEFAULT false,
    decay_score  DOUBLE  DEFAULT 1.0,
    stability    DOUBLE  DEFAULT 14.0,
    velocity     DOUBLE  DEFAULT 0.0,
    last_touched TIMESTAMP,
    created_at   TIMESTAMP,
    PRIMARY KEY(fqn)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Commit(
    sha        STRING,
    repo       STRING,
    author     STRING,
    message    STRING,
    branch     STRING,
    ts         TIMESTAMP,
    file_count INT64 DEFAULT 0,
    PRIMARY KEY(sha)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Module(
    name       STRING,
    repo       STRING,
    owner      STRING DEFAULT '',
    PRIMARY KEY(name)
  )`,

  `CREATE REL TABLE IF NOT EXISTS Calls(
    FROM Symbol TO Symbol,
    call_site_line  INT64,
    is_async        BOOLEAN DEFAULT false
  )`,

  `CREATE REL TABLE IF NOT EXISTS Imports(
    FROM File TO File,
    import_name   STRING,
    is_type_only  BOOLEAN DEFAULT false
  )`,

  `CREATE REL TABLE IF NOT EXISTS Exports(
    FROM File TO Symbol
  )`,

  `CREATE REL TABLE IF NOT EXISTS Touches(
    FROM Commit TO Symbol,
    lines_changed INT64 DEFAULT 0
  )`,

  `CREATE REL TABLE IF NOT EXISTS BelongsTo(
    FROM Symbol TO Module
  )`,

  `CREATE REL TABLE IF NOT EXISTS Contains(
    FROM File TO Symbol
  )`,
]