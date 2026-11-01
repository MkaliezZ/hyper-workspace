import { randomUUID } from "node:crypto";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../../apps/api/src/db/database.js";
import { Vault } from "../../apps/api/src/core/credentials.js";
import { requireNextcloud } from "../../apps/api/src/providers/nextcloud.js";
import { RoomManagementService } from "../../apps/api/src/core/room-management.js";
import { TalkManagementFixture } from "./talk-management.js";
export async function createRoomManagementScope(db: Database) {
  const source = new TalkManagementFixture(),
    base = await source.start(),
    workspaceId = randomUUID();
  const env = {
    NEXTCLOUD_URL: base,
    NEXTCLOUD_INTERNAL_URL: base,
    NEXTCLOUD_WORKSPACE_ID: workspaceId,
    NEXTCLOUD_MEMBER_GROUP: "synthetic-staff",
    NEXTCLOUD_TALK_ENABLED: "true",
    CREDENTIAL_MASTER_KEY: "fe".repeat(32),
  };
  const original = new Map(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  const config = requireNextcloud();
  await db.pool.query(
    "INSERT INTO cw_workspaces(id,name)VALUES($1,'Synthetic communication management')",
    [workspaceId],
  );
  const actors: Subject[] = [];
  for (const uid of ["operator", "peer"]) {
    const actor: Subject = {
        id: randomUUID(),
        workspaceId,
        name: source.users.get(uid)!,
        role: uid === "operator" ? "member" : "admin",
        demo: false,
        identityCredentialId: randomUUID(),
      },
      identityId = randomUUID();
    await db.pool.query("INSERT INTO cw_users(id,name)VALUES($1,$2)", [
      actor.id,
      actor.name,
    ]);
    await db.pool.query(
      "INSERT INTO cw_members(workspace_id,user_id,role)VALUES($1,$2,$3)",
      [workspaceId, actor.id, actor.role],
    );
    await db.pool.query(
      "INSERT INTO cw_external_identities(id,provider_key,remote_uid,user_id,workspace_id)VALUES($1,$2,$3,$4,$5)",
      [identityId, config.providerKey, uid, actor.id, workspaceId],
    );
    await db.pool.query(
      "INSERT INTO cw_identity_credentials(id,identity_id,login_name,credential_enc)VALUES($1,$2,$3,$4)",
      [
        actor.identityCredentialId,
        identityId,
        uid,
        new Vault().encrypt("synthetic-password"),
      ],
    );
    actors.push(actor);
  }
  const actor = actors[0]!,
    peer = actors[1]!,
    room = source.addRoom("合成来源私群"),
    service = new RoomManagementService(db);
  const plan = async (operation: string, extra: any = {}, who = actor) => {
    const view = await service.read(who, room.token);
    return {
      operation,
      bindingRef: view.bindingRef,
      roomId: room.token,
      expected: view.rooms[0]!.expected[operation],
      confirmed: true,
      ...extra,
    };
  };
  const create = async (uids = ["peer"], name = "明确合成群") => ({
    operation: "create_group",
    bindingRef: (await service.read(actor)).bindingRef,
    name,
    uids,
    confirmed: true,
  });
  return {
    source,
    actor,
    peer,
    room,
    service,
    plan,
    create,
    async close() {
      await source.close();
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
