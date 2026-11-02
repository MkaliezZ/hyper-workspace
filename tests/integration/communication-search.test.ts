import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../../apps/api/src/db/database.js";
import { CommunicationSearchService } from "../../apps/api/src/core/communication-search.js";
import { NextcloudTalkProvider } from "../../apps/api/src/providers/nextcloud-talk.js";
import { requireNextcloud } from "../../apps/api/src/providers/nextcloud.js";
import {
  MessageSearchInput,
  RoomManagementPlan,
} from "@hyper/contracts/room-management";
import { createRoomManagementScope } from "../fixtures/room-management-scope.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Isolated _test database required");
const db = new Database(url);
before(() => db.migrate());
after(() => db.close());
async function setup() {
  const f = await createRoomManagementScope(db);
  const binding = (await f.service.read(f.actor, f.room.token)).bindingRef;
  return { ...f, binding, search: new CommunicationSearchService(db) };
}

test("Source history search reaches messages outside the loaded page, paginates exact IDs and never changes read/notification state", async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 23; i++)
      f.source.message(f.room, "operator", "旧历史目标 " + i);
    for (let i = 0; i < 110; i++)
      f.source.message(f.room, "peer", "近期不相关 " + i);
    const config = requireNextcloud(),
      p = new NextcloudTalkProvider(
        config,
        { loginName: "operator", appPassword: "synthetic-password" },
        "operator",
      );
    assert.ok(
      (await p.messages(f.room.token)).messages.every(
        (m) => !m.content.includes("旧历史目标"),
      ),
    );
    const before = JSON.stringify([...f.room.preferences]);
    const page = await f.search.search(
      f.actor,
      f.room.token,
      { query: "旧历史目标" },
      f.binding,
    );
    assert.equal(page.messages.length, 20);
    assert.equal(page.cursor, "20");
    assert.equal(page.scope, "source-history");
    const second = await f.search.search(
      f.actor,
      f.room.token,
      { query: "旧历史目标", cursor: page.cursor! },
      f.binding,
    );
    assert.equal(second.messages.length, 3);
    const last = await f.search.search(
      f.actor,
      f.room.token,
      { query: "旧历史目标", cursor: second.cursor! },
      f.binding,
    );
    assert.equal(last.complete, true);
    assert.equal(last.cursor, null);
    assert.equal(
      new Set([...page.messages, ...second.messages].map((m) => m.id)).size,
      23,
    );
    assert.equal(JSON.stringify([...f.room.preferences]), before);
    assert.equal(f.source.writes.length, 0);
    assert.ok(
      f.source.searches.every(
        (s) =>
          s.actor === "operator" &&
          s.roomId === f.room.token &&
          s.limit === "20",
      ),
    );
  } finally {
    await f.close();
  }
});
test("Search snippets and links cannot replace exact current message reads; edits, deletion and expiry races are filtered", async () => {
  const f = await setup();
  try {
    f.source.message(f.room, "operator", "目标 old edited");
    f.source.message(f.room, "operator", "目标 delete");
    f.source.message(f.room, "operator", "目标 expire");
    f.source.message(f.room, "operator", "目标 no longer matches");
    f.source.afterSearch = () => {
      const rows = f.room.messages.filter((m) => m.content.startsWith("目标"));
      rows[0]!.content = "目标 current exact text";
      rows[1]!.kind = "comment_deleted";
      rows[2]!.expirationTimestamp = 1;
      rows[3]!.content = "unrelated current body";
    };
    const page = await f.search.search(
      f.actor,
      f.room.token,
      { query: "目标" },
      f.binding,
    );
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0]!.content, "目标 current exact text");
    assert.ok(!JSON.stringify(page).includes("untrusted"));
    assert.equal(f.source.writes.length, 0);
  } finally {
    await f.close();
  }
});
test("Search rejects malformed scope, duplicate IDs and nonadvancing cursors rather than returning a partial trusted-looking result", async () => {
  const f = await setup();
  try {
    f.source.message(f.room, "operator", "安全搜索词");
    for (const transform of [
      (p: any) => ({
        ...p,
        entries: [
          { attributes: { conversation: "otherroom", messageId: "41" } },
        ],
      }),
      (p: any) => ({ ...p, entries: [p.entries[0], p.entries[0]] }),
      (p: any) => ({ ...p, cursor: 0 }),
    ]) {
      f.source.transformSearch = transform;
      await assert.rejects(
        f.search.search(
          f.actor,
          f.room.token,
          { query: "安全搜索词" },
          f.binding,
        ),
        /来源搜索/,
      );
    }
    f.source.transformSearch = (p) => ({
      ...p,
      discardedUntrustedField: "x".repeat(1048577),
    });
    await assert.rejects(
      f.search.search(
        f.actor,
        f.room.token,
        { query: "安全搜索词" },
        f.binding,
      ),
      /企业通信服务返回无效响应/,
    );
  } finally {
    await f.close();
  }
});
test("Current source and product revocation discard history results; a changed binding never sends the search", async () => {
  const f = await setup();
  try {
    f.source.message(f.room, "operator", "权限搜索哨兵");
    await assert.rejects(
      f.search.search(
        f.actor,
        f.room.token,
        { query: "权限搜索哨兵" },
        "f".repeat(64),
      ),
      /来源已变化/,
    );
    assert.equal(f.source.searches.length, 0);
    f.source.afterSearch = () => {
      f.room.people.delete("operator");
    };
    await assert.rejects(
      f.search.search(
        f.actor,
        f.room.token,
        { query: "权限搜索哨兵" },
        f.binding,
      ),
    );
    f.room.people.set("operator", { id: 1, type: 1 });
    f.source.afterSearch = async () => {
      await db.pool.query(
        "UPDATE cw_identity_credentials SET disabled_at=clock_timestamp() WHERE id=$1",
        [f.actor.identityCredentialId],
      );
    };
    await assert.rejects(
      f.search.search(
        f.actor,
        f.room.token,
        { query: "权限搜索哨兵" },
        f.binding,
      ),
    );
    assert.equal(f.source.writes.length, 0);
  } finally {
    await f.close();
  }
});
test("Human and host-bound AI search use the same service, retain only bounded receipt facts, and reject ambiguous or privileged input", async () => {
  const f = await setup();
  try {
    f.source.message(f.room, "peer", "不得进入模型上下文的搜索正文");
    const plan = RoomManagementPlan.parse({
      operation: "read",
      bindingRef: f.binding,
      roomId: f.room.token,
      search: { query: "搜索正文" },
    });
    const receipt = await f.service.execute(f.actor, plan, randomUUID());
    assert.equal(receipt.state, "succeeded");
    assert.equal((receipt as any).resultCount, 1);
    assert.equal((receipt as any).search, true);
    assert.ok(!JSON.stringify(receipt).includes("搜索正文"));
    assert.equal(f.source.writes.length, 0);
    for (const input of [
      { query: "" },
      { query: "x", cursor: "-1" },
      { query: "x", actor: "admin" },
      { query: "x\nsecret" },
    ])
      assert.equal(MessageSearchInput.safeParse(input).success, false);
    assert.equal(
      RoomManagementPlan.safeParse({
        operation: "read",
        bindingRef: f.binding,
        search: { query: "x" },
      }).success,
      false,
    );
  } finally {
    await f.close();
  }
});
