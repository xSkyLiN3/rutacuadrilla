CREATE TABLE system_lock (
  id text PRIMARY KEY,
  purpose text NOT NULL,
  CHECK (id = 'INITIAL_ADMIN_PROVISION')
);

INSERT INTO system_lock (id, purpose)
VALUES ('INITIAL_ADMIN_PROVISION', 'Serializa el bootstrap de la primera administración');
