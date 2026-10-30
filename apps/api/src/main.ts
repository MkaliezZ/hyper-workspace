import "reflect-metadata";
import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Req,
  Res,
  Module,
  HttpException,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  UseFilters,
  Catch,
  type ExceptionFilter,
  type ArgumentsHost,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applicationConfig } from "./core/application-config.js";
import { z, ZodError } from "zod";
import {
  RunInput,
  NewMessage,
  TaskInput,
  TaskPatch,
  ArtifactRevision,
  ModelInput,
  CommunicationSendInput,
  FollowUpConfiguration,
  ArtifactReviewInput,
  MethodActionInput,
  ExecutionPolicyInput,
} from "@hyper/contracts";
import { Database, DEMO } from "./db/database.js";
import { authenticate, issueSession } from "./core/security.js";
import { digest } from "./core/credentials.js";
import { WorkspaceService } from "./core/workspace.js";
import { RunProcessor } from "./core/processor.js";
import { engineRegistry } from "./engines/adapters.js";
import { ModelService } from "./core/models.js";
import { ModelUsageService } from "./core/model-usage.js";
import { KnowledgeService } from "./core/knowledge.js";
import { CommunicationService } from "./core/communication.js";
import { ReplyDraftService } from "./core/reply-drafts.js";
import { SourceFileService } from "./core/source-files.js";
import {
  FilePath,
  FileReadingInput,
  FileReadingRevision,
  FileReadingRevisionInput,
} from "@hyper/contracts";
import { FileReadingService } from "./core/file-readings.js";
import { FollowUpScheduleService } from "./core/follow-up-schedules.js";
import { ArtifactReviewService } from "./core/artifact-reviews.js";
import { MethodsService } from "./core/methods.js";
import { ExecutionPolicyService } from "./core/execution-policy.js";
import { TalkToken, TalkCursor } from "./providers/nextcloud-talk.js";
import { IdentityService } from "./core/identity.js";
import { nextcloudConfig } from "./providers/nextcloud.js";
const config = applicationConfig();
const db = new Database();
const service = new WorkspaceService(db, engineRegistry());
const queue = new RunProcessor(service);
const identity = new IdentityService(db);
const communication = new CommunicationService(db);
const followUpSchedules = new FollowUpScheduleService(service);
const sessionCookie = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: config.secureCookie,
  maxAge: 12 * 60 * 60 * 1000,
  path: "/",
};
const flowCookie = {
  ...sessionCookie,
  maxAge: 10 * 60 * 1000,
  path: "/api/auth/nextcloud",
};
function cookie(req: Request, name: string) {
  return req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1);
}
function loginOrigin(req: Request) {
  if (!process.env.APP_ORIGIN || req.headers.origin !== process.env.APP_ORIGIN)
    throw new ForbiddenException("请从工作区页面发起企业登录。");
}
const uuid = (v: string) => z.uuid().parse(v);
function token(req: Request) {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const cookie = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("hyper_session="))
    ?.slice(14);
  return bearer ?? cookie;
}
const subject = (req: Request) => authenticate(db, token(req));
@Catch()
class ApiErrors implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (e instanceof ZodError)
      return res.status(400).json({
        message: "输入格式有误。",
        issues: e.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    if (e instanceof HttpException)
      return res.status(e.getStatus()).json({ message: e.message });
    console.error(
      "Unhandled API error:",
      e instanceof Error ? e.name : "unknown",
    );
    return res.status(500).json({ message: "服务暂时无法完成此操作。" });
  }
}
@Controller("api")
@UseFilters(ApiErrors)
class ApiController {
  @Get("health") async health() {
    await db.pool.query("SELECT 1");
    return { status: "ok", service: "Hyper Workspace", version: "0.1.0" };
  }
  @Get("auth/status") status() {
    return {
      demoEnabled: process.env.DEMO_MODE === "true",
      nextcloudConfigured: !!nextcloudConfig(),
      filesEnabled:
        process.env.NEXTCLOUD_FILES_ENABLED === "true" && !!nextcloudConfig(),
    };
  }
  @Post("auth/nextcloud/start") async startLogin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    loginOrigin(req);
    const { binding, ...flow } = await identity.start(
      cookie(req, "hyper_login"),
    );
    res.cookie("hyper_login", binding, flowCookie);
    return flow;
  }
  @Post("auth/nextcloud/poll") async pollLogin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    loginOrigin(req);
    const input = z.object({ flowId: z.uuid() }).strict().parse(body);
    const result = await identity.poll(
      input.flowId,
      cookie(req, "hyper_login"),
    );
    if (result.state === "complete")
      res.cookie("hyper_session", result.session, sessionCookie);
    return { state: result.state };
  }
  @Post("auth/nextcloud/cancel") async cancelLogin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    loginOrigin(req);
    const input = z.object({ flowId: z.uuid() }).strict().parse(body);
    const cancelledSession = await identity.cancel(
      input.flowId,
      cookie(req, "hyper_login"),
    );
    if (
      cancelledSession &&
      token(req) &&
      digest(token(req)!) === cancelledSession
    )
      res.clearCookie("hyper_session", { path: "/" });
    return { ok: true };
  }
  @Post("auth/demo") async demo(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (process.env.DEMO_MODE !== "true")
      throw new ForbiddenException("演示登录未开启。");
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
      req.socket.remoteAddress ?? "",
    );
    if (!loopback) throw new ForbiddenException("演示登录仅限本机访问。");
    const session = await issueSession(db, DEMO.user, DEMO.workspace, true);
    res.cookie("hyper_session", session, sessionCookie);
    return { ok: true, evidence: "fixture" };
  }
  @Post("auth/logout") async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const t = token(req);
    if (t)
      await db.tx(async (c) => {
        const session = (
          await c.query(
            "DELETE FROM cw_sessions WHERE token_hash=$1 RETURNING identity_credential_id",
            [digest(t)],
          )
        ).rows[0];
        if (session?.identity_credential_id)
          await c.query(
            "UPDATE cw_identity_credentials SET disabled_at=now(),credential_enc='' WHERE id=$1",
            [session.identity_credential_id],
          );
      });
    res.clearCookie("hyper_session", { path: "/" });
    return { ok: true };
  }
  @Get("workspace") async workspace(
    @Req() req: Request,
    @Query("projectId") pid?: string,
  ) {
    return service.view(await subject(req), pid ? uuid(pid) : undefined);
  }
  @Get("projects/:id/methods") async listMethods(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new MethodsService(db).list(await subject(req), uuid(id));
  }
  @Get("methods/:id") async getMethod(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new MethodsService(db).get(await subject(req), uuid(id));
  }
  @Post("projects/:id/methods/actions") async methodAction(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return new MethodsService(db).record(
      await subject(req),
      uuid(id),
      MethodActionInput.parse(body),
    );
  }
  @Post("projects") async project(@Req() req: Request, @Body() body: unknown) {
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        goal: z.string().trim().min(1).max(1000),
      })
      .strict()
      .parse(body);
    return service.createProject(await subject(req), input.name, input.goal);
  }
  @Get("talk/rooms/:token/project") async talkProject(
    @Req() req: Request,
    @Param("token") token: string,
  ) {
    return {
      project: await service.talkProject(
        await subject(req),
        TalkToken.parse(token),
      ),
    };
  }
  @Post("projects/from-talk") async projectFromTalk(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        roomId: TalkToken,
        name: z.string().trim().min(1).max(100),
        goal: z.string().trim().min(1).max(1000),
      })
      .strict()
      .parse(body);
    return service.createTalkProject(
      await subject(req),
      input.roomId,
      input.name,
      input.goal,
    );
  }
  @Post("conversations/:id/messages") async message(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = NewMessage.parse(body);
    return service.message(await subject(req), uuid(id), input.content);
  }
  @Post("conversations/:id/tasks") async task(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return service.createTask(
      await subject(req),
      uuid(id),
      TaskInput.parse(body),
    );
  }
  @Get("conversations/:id/follow-ups") async scheduledFollowUps(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return followUpSchedules.list(await subject(req), uuid(id));
  }
  @Post("conversations/:id/follow-ups") async configureFollowUp(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return followUpSchedules.configure(
      await subject(req),
      uuid(id),
      FollowUpConfiguration.parse(body),
    );
  }
  @Get("tasks/:id") async getTask(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return service.task(await subject(req), uuid(id));
  }
  @Patch("tasks/:id") async patchTask(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return service.patchTask(
      await subject(req),
      uuid(id),
      TaskPatch.parse(body),
    );
  }
  @Get("artifacts/:id") async artifact(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return service.artifact(await subject(req), uuid(id));
  }
  @Post("artifacts/:id/reviews") async reviewArtifact(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return new ArtifactReviewService(db).record(
      await subject(req),
      uuid(id),
      ArtifactReviewInput.parse(body),
    );
  }
  @Post("artifacts/:id/revisions") async revise(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return service.revise(
      await subject(req),
      uuid(id),
      ArtifactRevision.parse(body),
    );
  }
  @Get("knowledge") async knowledge(@Req() req: Request, @Query("q") q = "") {
    return service.search(await subject(req), q.slice(0, 500));
  }
  @Post("files/imports/:id/readings") async readFile(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const r = await service.startFileRun(
      await subject(req),
      uuid(id),
      FileReadingInput.parse(body),
    );
    await queue.enqueue(r.id);
    return r;
  }
  @Get("files/imports/:id/readings") async fileReadings(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new FileReadingService(db).list(await subject(req), uuid(id));
  }
  @Get("files/readings/:id") async fileReading(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new FileReadingService(db).get(await subject(req), uuid(id));
  }
  @Patch("files/readings/:id") async reviseFileReading(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return new FileReadingService(db).revise(
      await subject(req),
      uuid(id),
      FileReadingRevision.parse(body),
    );
  }
  @Post("files/readings/:id/revisions") async aiReviseFileReading(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const r = await service.startFileReadingRevision(
      await subject(req),
      uuid(id),
      FileReadingRevisionInput.parse(body),
    );
    await queue.enqueue(r.id);
    return r;
  }
  @Post("files/list") async sourceFiles(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z.object({ path: FilePath }).strict().parse(body);
    return new SourceFileService(db).list(await subject(req), input.path);
  }
  @Post("files/import") async importFile(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        path: FilePath,
        expectedId: z.string().regex(/^[1-9]\d{0,19}$/),
        expectedEtag: z.string().min(1).max(256),
      })
      .strict()
      .parse(body);
    return new SourceFileService(db).import(
      await subject(req),
      input.path,
      input.expectedId,
      input.expectedEtag,
    );
  }
  @Get("files/imports") async importedFiles(@Req() req: Request) {
    return new SourceFileService(db).imported(await subject(req));
  }
  @Get("files/imports/:id") async importedFile(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new SourceFileService(db).get(await subject(req), uuid(id));
  }
  @Post("files/imports/:id/refresh") async refreshFile(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    z.object({}).strict().parse(body);
    return new SourceFileService(db).refresh(await subject(req), uuid(id));
  }
  @Post("knowledge/index") async indexKnowledge(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        assetIds: z.array(z.uuid()).min(1).max(20),
        modelProfileId: z.uuid().optional(),
      })
      .strict()
      .parse(body);
    return new KnowledgeService(db).index(
      await subject(req),
      input.assetIds,
      input.modelProfileId,
    );
  }
  @Post("knowledge/semantic") async semanticKnowledge(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        query: z.string().trim().min(1).max(500),
        modelProfileId: z.uuid().optional(),
      })
      .strict()
      .parse(body);
    return new KnowledgeService(db).semantic(
      await subject(req),
      input.query,
      input.modelProfileId,
    );
  }
  @Get("talk/rooms") async talkRooms(@Req() req: Request) {
    return communication.rooms(await subject(req));
  }
  @Get("talk/rooms/:token/drafts") async replyDrafts(
    @Req() req: Request,
    @Param("token") token: string,
  ) {
    return new ReplyDraftService(db).list(
      await subject(req),
      TalkToken.parse(token),
    );
  }
  @Get("talk/drafts/:id") async replyDraft(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new ReplyDraftService(db).get(await subject(req), uuid(id));
  }
  @Get("talk/rooms/:token/messages") async talkMessages(
    @Req() req: Request,
    @Param("token") token: string,
    @Query("before") before?: string,
  ) {
    return communication.messages(
      await subject(req),
      TalkToken.parse(token),
      before ? TalkCursor.parse(before) : undefined,
    );
  }
  @Post("talk/rooms/:token/messages") async sendTalk(
    @Req() req: Request,
    @Param("token") token: string,
    @Body() body: unknown,
  ) {
    const input = CommunicationSendInput.parse(body);
    return communication.send(
      await subject(req),
      TalkToken.parse(token),
      input.content,
      input.idempotencyKey,
      input.draftId,
    );
  }
  @Get("talk/rooms/:token/sends") async pendingTalk(
    @Req() req: Request,
    @Param("token") token: string,
  ) {
    return communication.pending(await subject(req), TalkToken.parse(token));
  }
  @Post("talk/sends/:id/acknowledge") async acknowledgeTalk(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return communication.acknowledge(await subject(req), uuid(id));
  }
  @Get("talk/sends/:id") async talkReceipt(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return communication.receipt(await subject(req), uuid(id));
  }
  @Post("talk/sends/:id/reconcile") async reconcileTalk(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return communication.reconcile(await subject(req), uuid(id));
  }
  @Get("projects/:id/execution-policy") async executionPolicy(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new ExecutionPolicyService(db).view(await subject(req), uuid(id));
  }
  @Post("projects/:id/execution-policy") async saveExecutionPolicy(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { idempotencyKey, ...plan } = ExecutionPolicyInput.parse(body);
    return new ExecutionPolicyService(db).save(
      await subject(req),
      uuid(id),
      plan,
      idempotencyKey,
    );
  }
  @Get("models") async models(@Req() req: Request) {
    return service.models(await subject(req));
  }
  @Get("model-usage") async modelUsage(@Req() req: Request) {
    return new ModelUsageService(db).view(await subject(req));
  }
  @Post("models") async saveModel(@Req() req: Request, @Body() body: unknown) {
    return service.saveModel(await subject(req), ModelInput.parse(body));
  }
  @Post("models/:id/verify") async verifyModel(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return new ModelService(db).verify(await subject(req), uuid(id));
  }
  @Post("runs") async run(@Req() req: Request, @Body() body: unknown) {
    const r = await service.startRun(await subject(req), RunInput.parse(body));
    await queue.enqueue(r.id);
    return r;
  }
  @Get("runs/:id") async runStatus(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return service.getRun(await subject(req), uuid(id));
  }
  @Post("runs/:id/cancel") async cancel(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    return service.cancel(await subject(req), uuid(id));
  }
  @Get("runs/:id/events") async events(
    @Req() req: Request,
    @Res() res: Response,
    @Param("id") id: string,
    @Query("after") after = "0",
  ) {
    const s = await subject(req);
    uuid(id);
    const since = Number(after);
    if (!Number.isSafeInteger(since) || since < 0)
      throw new BadRequestException("无效事件游标。");
    await service.getRun(s, id);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    let cursor = since,
      busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const event of await service.events(s, id, cursor)) {
          cursor = event.sequence;
          res.write(
            "id: " +
              cursor +
              "\nevent: run-event\ndata: " +
              JSON.stringify(event) +
              "\n\n",
          );
        }
        res.write(": heartbeat\n\n");
      } catch {
        res.end();
        clearInterval(timer);
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), 700);
    req.on("close", () => clearInterval(timer));
    await tick();
  }
}
@Module({ controllers: [ApiController] })
class AppModule {}
const app = await NestFactory.create(AppModule, {
  logger: ["error", "warn", "log"],
});
app.use((req: Request, res: Response, next: NextFunction) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin &&
    req.headers.origin !== process.env.APP_ORIGIN
  ) {
    res.status(403).json({ message: "请求来源不被允许。" });
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  next();
});
if (config.serveWeb) {
  const directory = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (!existsSync(directory + "/index.html"))
    throw new Error("Build the web application before enabling SERVE_WEB.");
  app.use(
    express.static(directory, {
      dotfiles: "deny",
      setHeaders(res, path) {
        res.setHeader(
          "Cache-Control",
          path.endsWith("/index.html")
            ? "no-store"
            : "public, max-age=31536000, immutable",
        );
      },
    }),
  );
}
await queue.start(false);
app.enableShutdownHooks();
await app.listen(config.port, config.host);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => {
    void queue
      .stop()
      .then(() => app.close())
      .then(() => db.close())
      .then(() => process.exit(0));
  });
