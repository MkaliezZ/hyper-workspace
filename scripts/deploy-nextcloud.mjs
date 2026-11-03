import { Client } from "pg";
const sourceRole = "hyper_nextcloud_source",
  marker = "Hyper Workspace owned Nextcloud source";
async function main() {
  if (!process.argv.slice(2).length) {
    console.log(
      JSON.stringify({
        mode: "preflight",
        databaseRequests: 0,
        execute:
          "--execute inside the dedicated Compose initialize environment",
      }),
    );
    return;
  }
  if (process.argv.length !== 3 || process.argv[2] !== "--execute")
    throw Error("Invalid arguments");
  const url = new URL(process.env.DATABASE_URL ?? ""),
    password = process.env.HYPER_NEXTCLOUD_DB_PASSWORD;
  if (
    url.hostname !== "db" ||
    url.pathname !== "/hyper" ||
    url.username !== "hyper" ||
    !/^[a-f0-9]{64}$/.test(password ?? "") ||
    password === url.password
  )
    throw Error(
      "Use a dedicated Compose database and an independent source password",
    );
  const admin = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 5000,
  });
  await admin.connect();
  try {
    await admin.query("SELECT pg_advisory_lock(246813583)");
    const role = (
      await admin.query(
        "SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,r.rolcanlogin,shobj_description(r.oid,'pg_authid') AS marker,EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS member FROM pg_roles r WHERE r.rolname=$1",
        [sourceRole],
      )
    ).rows[0];
    if (role) {
      if (
        role.marker !== marker ||
        role.rolsuper ||
        role.rolcreatedb ||
        role.rolcreaterole ||
        role.rolreplication ||
        role.rolbypassrls ||
        !role.rolcanlogin ||
        role.member
      )
        throw Error(
          "Existing source role has unexpected ownership or privileges",
        );
    } else {
      await admin.query("BEGIN");
      try {
        await admin.query(
          "CREATE ROLE hyper_nextcloud_source LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '" +
            password +
            "'",
        );
        await admin.query(
          "COMMENT ON ROLE hyper_nextcloud_source IS 'Hyper Workspace owned Nextcloud source'",
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    }
    const sourceUrl = new URL(url);
    sourceUrl.username = sourceRole;
    sourceUrl.password = password;
    sourceUrl.pathname = "/postgres";
    const verify = new Client({
      connectionString: sourceUrl.toString(),
      connectionTimeoutMillis: 5000,
    });
    await verify.connect();
    try {
      await verify.query("SELECT 1");
    } finally {
      await verify.end();
    }
    const database = (
      await admin.query(
        "SELECT pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",
        [sourceRole],
      )
    ).rows[0];
    if (
      database &&
      (database.owner !== sourceRole ||
        (database.marker !== null && database.marker !== marker))
    )
      throw Error("Existing source database belongs to another installation");
    if (!database)
      await admin.query(
        "CREATE DATABASE hyper_nextcloud_source OWNER hyper_nextcloud_source",
      );
    if (!database?.marker)
      await admin.query(
        "COMMENT ON DATABASE hyper_nextcloud_source IS 'Hyper Workspace owned Nextcloud source'",
      );
    await admin.query(
      "REVOKE CONNECT,TEMP ON DATABASE hyper_nextcloud_source FROM PUBLIC",
    );
    sourceUrl.pathname = "/" + sourceRole;
    const source = new Client({
      connectionString: sourceUrl.toString(),
      connectionTimeoutMillis: 5000,
    });
    await source.connect();
    try {
      await source.query("SELECT 1");
    } finally {
      await source.end();
    }
    console.log(
      JSON.stringify({
        status: "ready",
        sourceDatabase: sourceRole,
        administratorRoleGranted: false,
        sourceTablesModified: false,
      }),
    );
  } finally {
    await admin.end();
  }
}
main().catch(() => {
  console.error(
    "Nextcloud database initialization failed; existing source credentials were not rotated and no source tables were changed.",
  );
  process.exitCode = 1;
});
