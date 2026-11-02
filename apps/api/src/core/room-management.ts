import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { RoomManagementPlan } from "@hyper/contracts/room-management";
import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { sourceConnection } from "./source-connection.js";
import { stableDigest } from "./credentials.js";
import { OrganizationService } from "./organization.js";
import {
  NextcloudRoomManagementProvider,
  type ManagedRoom,
  type ManagedParticipant,
} from "../providers/nextcloud-room-management.js";
import { NextcloudTalkProvider } from "../providers/nextcloud-talk.js";
import { SourceRejected } from "../providers/nextcloud-talk.js";
import { ExecutionPolicyService } from "./execution-policy.js";
import {
  CommunicationSearchService,
  communicationBinding,
} from "./communication-search.js";
type RunExecution = {
  row: any;
  lease: string;
  contextBytes: number;
  actionCount: number;
  signal?: AbortSignal;
};
type RoomPlan = RoomManagementPlan;
type RoomOperation = RoomPlan["operation"];
const groupOperations = new Set<RoomOperation>([
  "rename",
  "add_member",
  "remove_member",
  "moderator",
  "delete",
]);
const membershipOperations = new Set<RoomOperation>([
  ...groupOperations,
  "leave",
]);
const requiredCapability: Partial<Record<RoomOperation, string>> = {
  notify: "notification-levels",
  favorite: "favorites",
  mark_read: "chat-read-marker",
  mark_unread: "chat-unread",
};
/** The source has no revision/CAS API. These tokens protect the product confirmation, followed by fresh checks and actual source readback. */
function expectedRoom(
  bindingRef: string,
  room: ManagedRoom,
  operation: RoomOperation,
  people: ManagedParticipant[],
) {
  const specific =
    operation === "notify"
      ? { level: room.notificationLevel }
      : operation === "favorite"
        ? { favorite: room.favorite }
        : operation === "mark_read" || operation === "mark_unread"
          ? { lastReadMessage: room.lastReadMessage }
          : membershipOperations.has(operation)
            ? {
                name: room.name,
                canLeave: room.canLeave,
                canDelete: room.canDelete,
                hasCall: room.hasCall,
                breakoutRoomMode: room.breakoutRoomMode,
                people: people.map((p) => ({
                  uid: p.uid,
                  attendeeId: p.attendeeId,
                  participantType: p.participantType,
                })),
              }
            : {};
  return stableDigest({
    bindingRef,
    roomId: room.id,
    type: room.type,
    objectType: room.objectType,
    actorRole: room.participantType,
    operation,
    ...specific,
  });
}
export class RoomManagementService {
  constructor(readonly db: Database) {}
  private async connection(s: Subject) {
    if (process.env.NEXTCLOUD_TALK_ENABLED !== "true")
      throw new ServiceUnavailableException("企业通信管理尚未启用。");
    const source = await sourceConnection(this.db, s);
    const directoryBinding = stableDigest({
      provider: source.config.providerKey,
      transportUrl: source.config.transportUrl,
      workspaceId: source.config.workspaceId,
      group: source.config.memberGroup,
    });
    return {
      ...source,
      directoryBinding,
      bindingRef: communicationBinding(source),
      provider: new NextcloudRoomManagementProvider(
        source.config,
        source.credentials,
        source.remoteUid,
      ),
      talk: new NextcloudTalkProvider(
        source.config,
        source.credentials,
        source.remoteUid,
      ),
    };
  }
  async assertReceiptScope(s: Subject, run: any) {
    const source = await this.connection(s);
    const plan = RoomManagementPlan.parse(run.room_management_plan);
    if (
      source.bindingRef !== plan.bindingRef ||
      source.config.providerKey !== run.room_management_provider_key
    )
      throw new ForbiddenException("通信执行来源已变化。");
  }
  async assertRunScope(s: Subject, run: any) {
    await this.assertReceiptScope(s, run);
    const plan = RoomManagementPlan.parse(run.room_management_plan);
    const intent = (
      await this.db.pool.query(
        "SELECT * FROM cw_room_commands WHERE source_run_id=$1 AND workspace_id=$2 AND actor_id=$3 ORDER BY created_at LIMIT 1",
        [run.id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (intent) {
      // Own safe receipts remain readable after an intentional leave/delete.
      // The original mutation hash must not reject its own already-applied change.
      await this.metadata(s, intent);
    } else await this.prepare(s, plan);
  }
  /** Stored receipts retain audit facts, but cannot restore a source room ID after current access is lost. */
  async publicRunMetadata(s: Subject, value: any) {
    const plain = (v: any) =>
      v !== null &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype;
    const ids = new Set<string>();
    function collect(v: any) {
      if (Array.isArray(v)) {
        for (const item of v) collect(item);
      } else if (plain(v)) {
        if (typeof v.roomId === "string") ids.add(v.roomId);
        for (const item of Object.values(v)) collect(item);
      }
    }
    collect(value);
    if (!ids.size) return value;
    const source = await this.connection(s);
    const visible = new Set(
      (await source.provider.rooms()).map((room) => room.id),
    );
    const fresh = await this.connection(s);
    if (source.bindingRef !== fresh.bindingRef)
      throw new ForbiddenException("通信回执来源已变化。");
    function filter(v: any): any {
      if (Array.isArray(v)) return v.map(filter);
      if (!plain(v)) return v;
      const out = Object.fromEntries(
        Object.entries(v).map(([key, item]) => [key, filter(item)]),
      );
      if (typeof v.roomId === "string" && !visible.has(v.roomId)) {
        out.roomId = null;
        if ("scopeAvailable" in out) out.scopeAvailable = false;
      }
      return out;
    }
    return filter(value);
  }
  async read(s: Subject, roomId?: string) {
    const source = await this.connection(s);
    const [features, rooms, participants] = await Promise.all([
      source.provider.capabilities(),
      roomId
        ? source.provider.room(roomId).then((r) => [r])
        : source.provider.rooms(),
      roomId
        ? source.provider.participants(roomId)
        : Promise.resolve(undefined),
    ]);
    const fresh = await this.connection(s);
    if (source.bindingRef !== fresh.bindingRef)
      throw new ConflictException("通信来源已变化，请重新读取。");
    const current = roomId
      ? [await fresh.provider.room(roomId)]
      : await fresh.provider.rooms();
    const allowed = new Set(current.map((r) => r.id));
    return {
      bindingRef: source.bindingRef,
      actorUid: source.remoteUid,
      checkedAt: new Date().toISOString(),
      features,
      rooms: rooms
        .filter((room) => allowed.has(room.id))
        .map((room) => ({
          ...room,
          expected: Object.fromEntries(
            (
              [
                "notify",
                "favorite",
                "mark_read",
                "mark_unread",
                ...(participants ? [...membershipOperations] : []),
              ] as RoomOperation[]
            ).map((operation) => [
              operation,
              expectedRoom(
                source.bindingRef,
                room,
                operation,
                participants?.rows ?? [],
              ),
            ]),
          ),
        })),
      participants: participants ?? null,
    };
  }
  async prepare(s: Subject, raw: unknown) {
    const plan = RoomManagementPlan.parse(raw),
      source = await this.connection(s);
    if (plan.bindingRef !== source.bindingRef)
      throw new ConflictException("通信来源已变化，请重新读取后确认。");
    if (plan.operation === "read") {
      if (plan.roomId) await source.provider.room(plan.roomId);
      return {
        plan,
        source,
        room: undefined,
        people: undefined,
        noOp: false,
        actions: 1,
      };
    }
    if (
      plan.operation === "create_direct" ||
      plan.operation === "create_group"
    ) {
      const uids = plan.operation === "create_direct" ? [plan.uid] : plan.uids;
      if (uids.includes(source.remoteUid))
        throw new BadRequestException("创建者会自动加入，请只选择其他员工。");
      const proof = await new OrganizationService(this.db).eligibleUids(
        s,
        uids,
      );
      if (proof.bindingKey !== source.directoryBinding)
        throw new ConflictException("企业成员来源已变化，请重新选择。");
      return {
        plan,
        source,
        room: undefined,
        people: undefined,
        noOp: false,
        actions: plan.operation === "create_group" ? 1 + uids.length : 1,
      };
    }
    const [room, features, people] = await Promise.all([
      source.provider.room(plan.roomId),
      source.provider.capabilities(),
      membershipOperations.has(plan.operation)
        ? source.provider.participants(plan.roomId)
        : Promise.resolve(undefined),
    ]);
    if (
      plan.expected !==
      expectedRoom(source.bindingRef, room, plan.operation, people?.rows ?? [])
    )
      throw new ConflictException(
        "会话状态、成员或权限已变化，请重新读取后确认。",
      );
    if (membershipOperations.has(plan.operation) && people?.unsupported)
      throw new BadRequestException(
        "会话包含不支持的成员类型，请在来源客户端管理。",
      );
    const capability = requiredCapability[plan.operation];
    if (capability && !features.includes(capability))
      throw new BadRequestException("当前来源未声明此通信能力。");
    if (groupOperations.has(plan.operation)) {
      if (
        room.type !== 2 ||
        room.objectType !== "" ||
        room.breakoutRoomMode !== 0
      )
        throw new BadRequestException(
          "此入口只管理普通私有群，不修改公共、关联对象或分组讨论室。",
        );
      if (![1, 2].includes(room.participantType))
        throw new ForbiddenException(
          "只有当前来源群主或群管理员可以执行此操作；产品管理员身份不能替代来源权限。",
        );
    }
    if (
      plan.operation === "delete" &&
      (room.canDelete !== true ||
        room.hasCall !== false ||
        room.breakoutRoomMode !== 0)
    )
      throw new BadRequestException(
        "当前群不能解散，或存在通话/分组讨论室，请先在来源核对。",
      );
    if (plan.operation === "leave" && room.canLeave !== true)
      throw new BadRequestException(
        "来源当前不允许退出；不能留下没有管理员的群。",
      );
    if (plan.operation === "add_member") {
      const proof = await new OrganizationService(this.db).eligibleUids(s, [
        plan.uid,
      ]);
      if (proof.bindingKey !== source.directoryBinding)
        throw new ConflictException("邀请成员来源已变化。");
    }
    if (plan.operation === "remove_member" || plan.operation === "moderator") {
      const target = people!.rows.find(
        (p) => p.uid === plan.uid && p.attendeeId === plan.attendeeId,
      );
      if (
        !target ||
        target.uid === source.remoteUid ||
        target.participantType === 1
      )
        throw new BadRequestException(
          "目标成员身份已变化；不能用此操作修改本人或群主。",
        );
      if (plan.operation === "remove_member" && target.participantType !== 3)
        throw new BadRequestException(
          "请先明确撤销该成员的群管理员身份，再移出普通成员。",
        );
      if (
        plan.operation === "moderator" &&
        target.participantType !== (plan.enabled ? 3 : 2)
      )
        throw new ConflictException("群管理员身份已变化，请重新核对。");
    }
    if (plan.operation === "mark_read") {
      const message = await source.talk.find(room.id, plan.messageId);
      if (
        !message ||
        message.kind === "deleted" ||
        (message.expiresAt && Date.parse(message.expiresAt) <= Date.now())
      )
        throw new BadRequestException("所选已显示消息已变化，请重新打开会话。");
    }
    if (
      (plan.operation === "notify" && room.notificationLevel === null) ||
      (plan.operation === "favorite" && room.favorite === null) ||
      (["mark_read", "mark_unread"].includes(plan.operation) &&
        room.lastReadMessage === null)
    )
      throw new BadRequestException("来源没有返回此操作所需的当前状态。");
    const noOp =
      plan.operation === "notify"
        ? room.notificationLevel === plan.level
        : plan.operation === "favorite"
          ? room.favorite === plan.enabled
          : plan.operation === "mark_read"
            ? BigInt(room.lastReadMessage!) >= BigInt(plan.messageId)
            : plan.operation === "mark_unread"
              ? (room.unreadMessages ?? 0) > 0 ||
                BigInt(room.lastReadMessage!) < 0
              : plan.operation === "add_member"
                ? people!.rows.some((p) => p.uid === plan.uid)
                : plan.operation === "rename"
                  ? room.name === plan.name
                  : false;
    const fresh = await this.connection(s);
    if (fresh.bindingRef !== source.bindingRef)
      throw new ConflictException("通信来源已变化，请重新读取。");
    return { plan, source, room, people, noOp, actions: 1 };
  }
  private async actorLock(c: PoolClient, s: Subject, credentialId: string) {
    if (
      !(
        await c.query(
          "SELECT user_id FROM cw_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [s.workspaceId, s.id],
        )
      ).rowCount
    )
      throw new ForbiddenException("工作区权限已撤销。");
    if (
      !(
        await c.query(
          "SELECT c.id FROM cw_identity_credentials c JOIN cw_external_identities i ON i.id=c.identity_id WHERE c.id=$1 AND c.disabled_at IS NULL AND i.workspace_id=$2 AND i.user_id=$3 FOR SHARE OF c,i",
          [credentialId, s.workspaceId, s.id],
        )
      ).rowCount
    )
      throw new ForbiddenException("当前来源登录已失效。");
  }
  private async checkRun(
    c: PoolClient,
    s: Subject,
    execution: RunExecution | undefined,
    actions: number,
  ) {
    if (!execution) return;
    execution.signal?.throwIfAborted();
    const current = (
      await c.query(
        "SELECT state,lease_owner FROM cw_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 FOR UPDATE",
        [execution.row.id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (current?.state !== "running" || current.lease_owner !== execution.lease)
      throw new ConflictException("AI 执行已停止，未派发下一项来源操作。");
    await new ExecutionPolicyService(this.db).check(
      c,
      s,
      execution.row,
      execution.contextBytes,
      execution.actionCount + actions - 1,
    );
  }
  private async row(s: Subject, id: string) {
    const row = (
      await this.db.pool.query(
        "SELECT * FROM cw_room_commands WHERE id=$1 AND workspace_id=$2 AND actor_id=$3",
        [id, s.workspaceId, s.id],
      )
    ).rows[0];
    if (!row) throw new BadRequestException("通信管理回执不存在。");
    return row;
  }
  private async metadata(s: Subject, row: any) {
    const source = await this.connection(s);
    if (
      source.bindingRef !== row.binding_ref ||
      source.config.providerKey !== row.provider_key ||
      source.remoteUid !== row.remote_uid
    )
      throw new ForbiddenException("此回执的通信来源已变化。");
    if (
      row.state === "dispatching" &&
      Date.now() - new Date(row.updated_at).getTime() > 45000
    ) {
      await this.db.pool.query(
        "UPDATE cw_room_commands SET state='recovery_required',outcome='dispatch_unknown',updated_at=clock_timestamp() WHERE id=$1 AND state='dispatching' AND updated_at<clock_timestamp()-interval '45 seconds'",
        [row.id],
      );
      row = await this.row(s, row.id);
    }
    const steps = (
      await this.db.pool.query(
        "SELECT sequence,operation,state,http_status FROM cw_room_command_steps WHERE command_id=$1 ORDER BY sequence",
        [row.id],
      )
    ).rows;
    let roomVisible = false;
    if (row.source_room_ref)
      roomVisible = (await source.provider.rooms()).some(
        (room) => room.id === row.source_room_ref,
      );
    const fresh = await this.connection(s);
    if (fresh.bindingRef !== source.bindingRef)
      throw new ForbiddenException("此回执的通信来源已变化。");
    return this.publicMetadata(row, steps, roomVisible);
  }
  private publicMetadata(row: any, steps: any[], roomVisible: boolean) {
    return {
      id: row.id,
      requestKey: row.idempotency_key,
      operation: row.operation,
      state: row.state,
      outcome: row.outcome ?? null,
      sourceRoomDisposition: ["create_direct", "create_group"].includes(
        row.operation,
      )
        ? steps[0]?.http_status === 201
          ? "created"
          : steps[0]?.http_status === 200
            ? "existing"
            : null
        : null,
      roomId: roomVisible ? row.source_room_ref : null,
      scopeAvailable: roomVisible,
      acknowledgedAt: row.acknowledged_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sourceRunId: row.source_run_id ?? null,
      steps,
      completedSteps: steps.filter((step) => step.state === "observed").length,
      totalSteps: steps.length,
    };
  }
  async receipt(s: Subject, id: string) {
    return this.metadata(s, await this.row(s, id));
  }
  async activity(s: Subject) {
    const source = await this.connection(s);
    await this.db.pool.query(
      "UPDATE cw_room_commands SET state='recovery_required',outcome='dispatch_unknown',updated_at=clock_timestamp() WHERE workspace_id=$1 AND actor_id=$2 AND binding_ref=$3 AND state='dispatching' AND updated_at<clock_timestamp()-interval '45 seconds'",
      [s.workspaceId, s.id, source.bindingRef],
    );
    const rows = (
      await this.db.pool.query(
        "SELECT * FROM cw_room_commands WHERE workspace_id=$1 AND actor_id=$2 AND binding_ref=$3 ORDER BY created_at DESC,id DESC LIMIT 20",
        [s.workspaceId, s.id, source.bindingRef],
      )
    ).rows;
    const steps = (
      await this.db.pool.query(
        "SELECT command_id,sequence,operation,state,http_status FROM cw_room_command_steps WHERE command_id=ANY($1::uuid[]) ORDER BY command_id,sequence",
        [rows.map((row) => row.id)],
      )
    ).rows;
    const rooms = await source.provider.rooms(),
      fresh = await this.connection(s);
    if (source.bindingRef !== fresh.bindingRef)
      throw new ForbiddenException("通信来源已变化。");
    const visible = new Set(rooms.map((room) => room.id));
    return rows.map((row) =>
      this.publicMetadata(
        row,
        steps
          .filter((step) => step.command_id === row.id)
          .map(({ command_id, ...step }) => step),
        visible.has(row.source_room_ref),
      ),
    );
  }
  private steps(plan: RoomPlan) {
    if (plan.operation === "read") return [];
    if (plan.operation === "create_group")
      return [
        { operation: "create_group", target: null },
        ...plan.uids.map((uid) => ({ operation: "add_member", target: uid })),
      ];
    return [
      {
        operation: plan.operation,
        target:
          "uid" in plan
            ? plan.uid
            : "messageId" in plan
              ? plan.messageId
              : null,
      },
    ];
  }
  async execute(
    s: Subject,
    raw: unknown,
    key: string,
    execution?: RunExecution,
  ) {
    const plan = RoomManagementPlan.parse(raw);
    if (plan.operation === "read") {
      const read = await this.read(s, plan.roomId);
      if (read.bindingRef !== plan.bindingRef)
        throw new ConflictException("通信查询来源已变化。");
      if (plan.search && plan.roomId) {
        const result = await new CommunicationSearchService(this.db).search(
          s,
          plan.roomId,
          plan.search,
          plan.bindingRef,
        );
        const fresh = await this.connection(s);
        if (fresh.bindingRef !== plan.bindingRef)
          throw new ConflictException("搜索来源已变化。");
        return {
          tool: "communication.manage",
          operation: "read",
          search: true,
          state: "succeeded",
          roomId: plan.roomId,
          checkedAt: new Date().toISOString(),
          resultCount: result.messages.length,
          hasMore: result.cursor !== null,
          scope: result.scope,
        };
      }
      return {
        tool: "communication.manage",
        operation: "read",
        state: "succeeded",
        checkedAt: read.checkedAt,
        roomCount: read.rooms.length,
        knownUnreadMessages: read.rooms.reduce(
          (n, r) => n + (r.unreadMessages ?? 0),
          0,
        ),
        unknownUnreadRooms: read.rooms.filter((r) => r.unreadMessages === null)
          .length,
        mentionedRooms: read.rooms.filter((r) => r.unreadMention === true)
          .length,
      };
    }
    const connection = await this.connection(s),
      hash = stableDigest(plan);
    const previous = (
      await this.db.pool.query(
        "SELECT * FROM cw_room_commands WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
        [s.workspaceId, s.id, key],
      )
    ).rows[0];
    if (previous) {
      if (previous.params_hash !== hash)
        throw new ConflictException("相同通信操作键不能更换目标或参数。");
      return {
        tool: "communication.manage",
        ...(await this.metadata(s, previous)),
      };
    }
    let prepared: Awaited<ReturnType<RoomManagementService["prepare"]>>;
    try {
      prepared = await this.prepare(s, plan);
    } catch (error) {
      // A concurrent owner may already have changed the source after our first lookup.
      // Reuse only its exact durable intent, never issue another source mutation.
      const concurrent = (
        await this.db.pool.query(
          "SELECT * FROM cw_room_commands WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, key],
        )
      ).rows[0];
      if (!concurrent) throw error;
      if (concurrent.params_hash !== hash)
        throw new ConflictException("相同通信操作键不能更换目标或参数。");
      return {
        tool: "communication.manage",
        ...(await this.metadata(s, concurrent)),
      };
    }
    const id = randomUUID(),
      steps = this.steps(plan),
      target = "roomId" in plan ? plan.roomId : null,
      creation =
        plan.operation === "create_direct" || plan.operation === "create_group";
    if (prepared.source.bindingRef !== connection.bindingRef)
      throw new ConflictException("通信来源已变化。");
    const inserted = await this.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "room-command:" +
          s.workspaceId +
          ":" +
          s.id +
          ":" +
          connection.bindingRef +
          ":" +
          (creation ? "creation" : target),
      ]);
      await this.checkRun(c, s, execution, prepared.actions);
      await this.actorLock(c, s, s.identityCredentialId!);
      const prior = (
        await c.query(
          "SELECT * FROM cw_room_commands WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [s.workspaceId, s.id, key],
        )
      ).rows[0];
      if (prior) {
        if (prior.params_hash !== hash)
          throw new ConflictException("相同通信操作键不能更换目标或参数。");
        return { row: prior, owned: false };
      }
      const queued = (
        await c.query(
          "SELECT id FROM cw_runs WHERE workspace_id=$1 AND actor_id=$2 AND workflow='manage_communication' AND room_management_provider_key=$3 AND id<>COALESCE($6::uuid,'00000000-0000-0000-0000-000000000000'::uuid) AND state IN ('queued','running') AND (($4::boolean AND room_management_plan->>'operation' IN ('create_direct','create_group')) OR (NOT $4 AND room_management_plan->>'roomId'=$5)) LIMIT 1",
          [
            s.workspaceId,
            s.id,
            connection.config.providerKey,
            creation,
            target,
            execution?.row.id ?? null,
          ],
        )
      ).rowCount;
      if (queued)
        throw new ConflictException(
          "此范围已有通信 AI 任务，未另行派发来源写入。",
        );
      const pending = (
        await c.query(
          "SELECT id FROM cw_room_commands WHERE workspace_id=$1 AND actor_id=$2 AND binding_ref=$3 AND state IN ('dispatching','recovery_required') AND acknowledged_at IS NULL AND (($4::boolean AND operation IN ('create_direct','create_group')) OR (NOT $4 AND source_room_ref=$5)) LIMIT 1",
          [s.workspaceId, s.id, connection.bindingRef, creation, target],
        )
      ).rows[0];
      if (pending)
        throw new ConflictException(
          "此范围已有通信操作待核对，请先查看原回执，不要重复操作。",
        );
      const state = prepared.noOp ? "succeeded" : "dispatching";
      const row = (
        await c.query(
          "INSERT INTO cw_room_commands(id,workspace_id,actor_id,identity_credential_id,provider_key,binding_ref,remote_uid,source_run_id,operation,plan,params_hash,idempotency_key,source_room_ref,state,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *",
          [
            id,
            s.workspaceId,
            s.id,
            s.identityCredentialId,
            connection.config.providerKey,
            connection.bindingRef,
            connection.remoteUid,
            execution?.row.id ?? null,
            plan.operation,
            plan,
            hash,
            key,
            target,
            state,
            prepared.noOp ? "already_effective" : null,
          ],
        )
      ).rows[0];
      for (const [sequence, step] of steps.entries())
        await c.query(
          "INSERT INTO cw_room_command_steps(command_id,sequence,operation,target_ref,state,settled_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $5='observed' THEN clock_timestamp() ELSE NULL END)",
          [
            id,
            sequence,
            step.operation,
            step.target,
            prepared.noOp ? "observed" : "ready",
          ],
        );
      return { row, owned: !prepared.noOp };
    });
    if (!inserted.owned)
      return {
        tool: "communication.manage",
        ...(await this.metadata(s, inserted.row)),
      };
    let sourceRoomId = target;
    const deadline = Date.now() + 300000;
    const heartbeat = setInterval(() => {
      void this.db.pool
        .query(
          "UPDATE cw_room_commands SET updated_at=clock_timestamp() WHERE id=$1 AND state='dispatching'",
          [id],
        )
        .catch(() => {});
    }, 5000);
    heartbeat.unref();
    try {
      for (const [sequence, step] of steps.entries()) {
        let dispatched = false;
        try {
          execution?.signal?.throwIfAborted();
          if (Date.now() > deadline)
            throw new BadRequestException(
              "通信操作已达到时间上限，未派发下一项来源操作。",
            );
          const fresh = await this.connection(s);
          if (
            fresh.bindingRef !== connection.bindingRef ||
            s.identityCredentialId !== inserted.row.identity_credential_id
          )
            throw new ForbiddenException("通信来源或执行设备已变化。");
          if (sequence === 0) await this.prepare(s, plan);
          else {
            const room = await fresh.provider.room(sourceRoomId!),
              members = await fresh.provider.participants(sourceRoomId!);
            if (
              plan.operation !== "create_group" ||
              room.type !== 2 ||
              room.objectType !== "" ||
              room.breakoutRoomMode !== 0 ||
              room.name !== plan.name ||
              ![1, 2].includes(room.participantType) ||
              members.unsupported ||
              members.rows.some(
                (p) => p.uid !== fresh.remoteUid && !plan.uids.includes(p.uid),
              )
            )
              throw new ConflictException(
                "新群范围已变化，未继续邀请后续员工。",
              );
            const proof = await new OrganizationService(this.db).eligibleUids(
              s,
              [step.target!],
            );
            if (proof.bindingKey !== fresh.directoryBinding)
              throw new ConflictException("邀请员工来源已变化。");
          }
          if (Date.now() > deadline)
            throw new BadRequestException(
              "通信操作已达到时间上限，未派发下一项来源操作。",
            );
          await this.db.tx(async (c) => {
            await ExecutionPolicyService.lock(c, s.workspaceId);
            await this.checkRun(c, s, execution, prepared.actions);
            await this.actorLock(c, s, s.identityCredentialId!);
            const current = (
              await c.query(
                "SELECT state FROM cw_room_commands WHERE id=$1 FOR UPDATE",
                [id],
              )
            ).rows[0];
            if (current?.state !== "dispatching")
              throw new ConflictException(
                "原派发状态已变化，不能再次发起来源写入。",
              );
            execution?.signal?.throwIfAborted();
            const result = await c.query(
              "UPDATE cw_room_command_steps SET state='dispatching',dispatched_at=clock_timestamp() WHERE command_id=$1 AND sequence=$2 AND state='ready' RETURNING sequence",
              [id, sequence],
            );
            if (!result.rowCount)
              throw new ConflictException(
                "此来源步骤已有派发记录，未自动重发。",
              );
            await c.query(
              "UPDATE cw_room_commands SET updated_at=clock_timestamp() WHERE id=$1",
              [id],
            );
          });
          execution?.signal?.throwIfAborted();
          dispatched = true;
          let status: number;
          if (
            sequence === 0 &&
            (plan.operation === "create_direct" ||
              plan.operation === "create_group")
          ) {
            const created = await fresh.provider.create(
              plan.operation === "create_direct" ? "direct" : "group",
              plan.operation === "create_direct" ? plan.uid : plan.name,
            );
            sourceRoomId = created.room.id;
            status = created.status;
            // A group can be reported newly created only by the source's 201 receipt.
            if (plan.operation === "create_group" && !created.created) {
              await this.db.pool.query(
                "UPDATE cw_room_commands SET source_room_ref=$2 WHERE id=$1",
                [id, sourceRoomId],
              );
              throw new Error("Group creation was not confirmed by source");
            }
          } else {
            const command =
              sequence > 0
                ? {
                    operation: "add_member" as const,
                    roomId: sourceRoomId!,
                    uid: step.target!,
                  }
                : plan;
            if (!("roomId" in command)) throw new Error("Invalid source step");
            status = (await fresh.provider.change(command)).status;
          }
          await this.db.tx(async (c) => {
            await c.query(
              "UPDATE cw_room_command_steps SET state='acknowledged',http_status=$3,source_ref=$4,settled_at=clock_timestamp() WHERE command_id=$1 AND sequence=$2 AND state='dispatching'",
              [id, sequence, status, sourceRoomId],
            );
            await c.query(
              "UPDATE cw_room_commands SET source_room_ref=$2,updated_at=clock_timestamp() WHERE id=$1",
              [id, sourceRoomId],
            );
          });
          if (
            !(await this.observed(
              s,
              plan,
              sourceRoomId!,
              step.operation,
              step.target,
            ))
          )
            throw new Error("Source state did not match requested state");
          await this.db.pool.query(
            "UPDATE cw_room_command_steps SET state='observed',settled_at=clock_timestamp() WHERE command_id=$1 AND sequence=$2 AND state='acknowledged'",
            [id, sequence],
          );
        } catch (error) {
          const rejected = dispatched && error instanceof SourceRejected;
          await this.db.tx(async (c) => {
            const fact = (
              await c.query(
                "SELECT state FROM cw_room_command_steps WHERE command_id=$1 AND sequence=$2 FOR UPDATE",
                [id, sequence],
              )
            ).rows[0];
            if (fact?.state === "dispatching")
              await c.query(
                "UPDATE cw_room_command_steps SET state=$3,settled_at=clock_timestamp() WHERE command_id=$1 AND sequence=$2",
                [
                  id,
                  sequence,
                  !dispatched || rejected ? "rejected" : "unknown",
                ],
              );
            const anyEffect = (
              await c.query(
                "SELECT 1 FROM cw_room_command_steps WHERE command_id=$1 AND state IN ('unknown','acknowledged','observed') LIMIT 1",
                [id],
              )
            ).rowCount;
            const state = anyEffect ? "recovery_required" : "failed";
            await c.query(
              "UPDATE cw_room_commands SET state=$2,outcome=$3,updated_at=clock_timestamp() WHERE id=$1 AND state='dispatching'",
              [
                id,
                state,
                anyEffect
                  ? "source_result_requires_review"
                  : rejected
                    ? "source_rejected"
                    : "scope_or_execution_stopped",
              ],
            );
          });
          break;
        }
      }
      await this.db.pool.query(
        "UPDATE cw_room_commands SET state='succeeded',outcome='source_acknowledged_and_observed',updated_at=clock_timestamp() WHERE id=$1 AND state='dispatching' AND NOT EXISTS(SELECT 1 FROM cw_room_command_steps WHERE command_id=$1 AND state<>'observed')",
        [id],
      );
      return { tool: "communication.manage", ...(await this.receipt(s, id)) };
    } finally {
      clearInterval(heartbeat);
    }
  }
  private async observed(
    s: Subject,
    plan: RoomPlan,
    id: string,
    operation: string,
    target: string | null,
  ) {
    const source = await this.connection(s);
    if (source.bindingRef !== plan.bindingRef)
      throw new ForbiddenException("通信来源已变化。");
    if (operation === "leave" || operation === "delete")
      return !(await source.provider.rooms()).some((r) => r.id === id);
    const room = await source.provider.room(id);
    if (operation === "create_group")
      return (
        plan.operation === "create_group" &&
        room.type === 2 &&
        room.name === plan.name &&
        room.participantType === 1
      );
    if (operation === "create_direct") {
      const members = await source.provider.participants(id);
      return (
        plan.operation === "create_direct" &&
        room.type === 1 &&
        !members.unsupported &&
        members.rows.length === 2 &&
        members.rows.some((p) => p.uid === plan.uid) &&
        members.rows.some((p) => p.uid === source.remoteUid)
      );
    }
    if (operation === "notify")
      return (
        plan.operation === "notify" && room.notificationLevel === plan.level
      );
    if (operation === "favorite")
      return plan.operation === "favorite" && room.favorite === plan.enabled;
    if (operation === "mark_read")
      return (
        plan.operation === "mark_read" &&
        room.lastReadMessage !== null &&
        BigInt(room.lastReadMessage) >= BigInt(plan.messageId)
      );
    if (operation === "mark_unread")
      return (
        (room.unreadMessages ?? 0) > 0 ||
        (room.lastReadMessage !== null && BigInt(room.lastReadMessage) < 0)
      );
    if (operation === "rename")
      return plan.operation === "rename" && room.name === plan.name;
    const people = await source.provider.participants(id);
    if (operation === "add_member")
      return people.rows.some((p) => p.uid === target);
    if (operation === "remove_member")
      return (
        plan.operation === "remove_member" &&
        !people.rows.some((p) => p.uid === plan.uid)
      );
    if (operation === "moderator")
      return (
        plan.operation === "moderator" &&
        people.rows.some(
          (p) =>
            p.uid === plan.uid &&
            p.attendeeId === plan.attendeeId &&
            p.participantType === (plan.enabled ? 2 : 3),
        )
      );
    return false;
  }
  async reconcile(s: Subject, id: string) {
    const row = await this.row(s, id),
      before = await this.metadata(s, row);
    if (before.state !== "recovery_required") return before;
    if (!row.source_room_ref) return before; // No correlation token for an unknown group POST: never guess by name or recreate.
    const plan = RoomManagementPlan.parse(row.plan);
    const steps = (
      await this.db.pool.query(
        "SELECT * FROM cw_room_command_steps WHERE command_id=$1 ORDER BY sequence",
        [id],
      )
    ).rows;
    for (const step of steps) {
      if (step.state !== "acknowledged") continue; // Observation cannot invent a lost source acknowledgement.
      if (
        await this.observed(
          s,
          plan,
          row.source_room_ref,
          step.operation,
          step.target_ref,
        )
      )
        await this.db.pool.query(
          "UPDATE cw_room_command_steps SET state='observed',settled_at=clock_timestamp() WHERE command_id=$1 AND sequence=$2 AND state='acknowledged'",
          [id, step.sequence],
        );
    }
    await this.db.pool.query(
      "UPDATE cw_room_commands SET state='succeeded',outcome='source_acknowledged_and_observed',updated_at=clock_timestamp() WHERE id=$1 AND state='recovery_required' AND NOT EXISTS(SELECT 1 FROM cw_room_command_steps WHERE command_id=$1 AND state<>'observed')",
      [id],
    );
    return this.receipt(s, id);
  }
  async stop(s: Subject, id: string) {
    // Stopping only narrows an owned operation. A source outage must not prevent cancellation.
    await this.row(s, id);
    await this.db.tx(async (c) => {
      await ExecutionPolicyService.lock(c, s.workspaceId);
      await this.actorLock(c, s, s.identityCredentialId!);
      const row = (
        await c.query(
          "SELECT state FROM cw_room_commands WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 FOR UPDATE",
          [id, s.workspaceId, s.id],
        )
      ).rows[0];
      if (row?.state !== "dispatching") return;
      const dispatched = !!(
        await c.query(
          "SELECT 1 FROM cw_room_command_steps WHERE command_id=$1 AND state<>'ready' LIMIT 1",
          [id],
        )
      ).rowCount;
      await c.query(
        "UPDATE cw_room_commands SET state=$2,outcome=$3,updated_at=clock_timestamp() WHERE id=$1",
        [
          id,
          dispatched ? "recovery_required" : "failed",
          dispatched ? "stopped_after_dispatch" : "stopped_before_dispatch",
        ],
      );
    });
    const stopped = await this.row(s, id);
    return { id: stopped.id, state: stopped.state };
  }
  async acknowledge(s: Subject, id: string) {
    const current = await this.receipt(s, id);
    if (current.state !== "recovery_required")
      throw new ConflictException(
        "此操作仍在执行或已有明确结果，无需人工继续。",
      );
    await this.db.pool.query(
      "UPDATE cw_room_commands SET acknowledged_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND state='recovery_required'",
      [id, s.workspaceId, s.id],
    );
    return this.receipt(s, id);
  }
}
