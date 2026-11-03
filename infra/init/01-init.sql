-- Схема создаётся приложением (electron/lib/infra.js), здесь — базовая инициализация.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS mai_artifacts (
  project text NOT NULL,
  id text NOT NULL,
  kind text NOT NULL,
  name text NOT NULL,
  title text,
  current integer NOT NULL DEFAULT 0,
  hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project, id)
);

CREATE TABLE IF NOT EXISTS mai_artifact_versions (
  project text NOT NULL,
  id text NOT NULL,
  version integer NOT NULL,
  hash text NOT NULL,
  content text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  embedding vector(1024),
  PRIMARY KEY (project, id, version)
);

CREATE INDEX IF NOT EXISTS mai_versions_fts
  ON mai_artifact_versions USING gin (to_tsvector('simple', content));
