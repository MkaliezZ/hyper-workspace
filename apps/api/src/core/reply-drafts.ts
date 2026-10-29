import { NotFoundException } from "@nestjs/common";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { ProjectAccess } from "./project-access.js";

/** Personal message preparations. Ownership never expands to project peers or admins. */
export class ReplyDraftService {
  constructor(private db: Database) {}
  async get(s: Subject, id: string) {
    const access = new ProjectAccess(this.db);
    const target = (
      await this.db.pool.query(
        "SELECT project_id FROM cw_communication_drafts WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!target) throw new NotFoundException("回复草稿不存在或无权访问。");
    const source = await access.assert(s, target.project_id);
    if (!source) throw new NotFoundException("回复草稿的来源不可用。");
    const result = (
      await this.db.pool.query(
        `SELECT d.id,d.content,d.source_run_id AS "runId",d.source_message_ids AS "sourceMessageIds",d.created_at AS "createdAt",
           sent.state AS "sendState",sent.id AS "sendId" FROM cw_communication_drafts d
           LEFT JOIN LATERAL (SELECT id,state FROM cw_communication_sends WHERE draft_id=d.id ORDER BY (state IN ('sending','succeeded','recovery_required')) DESC,created_at DESC,id LIMIT 1) sent ON true
           WHERE d.id=$1 AND d.workspace_id=$2 AND d.actor_id=$3`,
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    return { ...result, roomId: source.roomId, roomName: source.name };
  }
  async list(s: Subject, roomId: string) {
    const scope = await new ProjectAccess(this.db).room(s, roomId);
    return (
      await this.db.pool.query(
        `SELECT d.id,d.source_run_id AS "runId",d.created_at AS "createdAt",r.engine,
       sent.state AS "sendState",sent.id AS "sendId"
       FROM cw_communication_drafts d JOIN cw_project_sources x ON x.project_id=d.project_id
       JOIN cw_runs r ON r.id=d.source_run_id
       LEFT JOIN LATERAL (SELECT id,state FROM cw_communication_sends WHERE draft_id=d.id ORDER BY (state IN ('sending','succeeded','recovery_required')) DESC,created_at DESC,id LIMIT 1) sent ON true
       WHERE d.workspace_id=$1 AND d.actor_id=$2 AND x.provider_key=$3 AND x.conversation_ref=$4
       ORDER BY d.created_at DESC,d.id LIMIT 10`,
        [s.workspaceId, s.id, scope.providerKey, roomId],
      )
    ).rows;
  }
}
