import type { PoolClient } from "pg";
/** Called while the source asset is locked. Retain provenance; redact dependent text. */
export async function invalidateFileDependents(
  c: PoolClient,
  id: string,
  version: string,
) {
  await c.query(
    "UPDATE cw_file_reading_versions SET content='' WHERE reading_id IN (SELECT id FROM cw_file_readings WHERE source_asset_id=$1 AND source_version=$2)",
    [id, version],
  );
  await c.query(
    "UPDATE cw_file_readings SET invalidated_at=COALESCE(invalidated_at,clock_timestamp()) WHERE source_asset_id=$1 AND source_version=$2",
    [id, version],
  );
  await c.query(
    "UPDATE cw_runs SET instruction='',result=NULL,error='文件来源或版本已失效。',state=CASE WHEN state IN ('queued','running','waiting_input','waiting_confirmation') THEN 'failed' ELSE state END,updated_at=clock_timestamp() WHERE source_file_asset_id=$1 AND expected_file_version=$2",
    [id, version],
  );
}
