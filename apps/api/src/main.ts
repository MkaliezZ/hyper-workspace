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
import { z, ZodError } from "zod";
import {
  RunInput,
  NewMessage,
  TaskInput,
  TaskPatch,
  ArtifactRevision,
  ModelInput,
} from "@hyper/contracts";
import { Database, DEMO } from "./db/database.js";
import { authenticate, issueSession, digest } from "./core/security.js";
import { WorkspaceService } from "./core/workspace.js";
import { RunProcessor } from "./core/processor.js";
import { engineRegistry } from "./engines/adapters.js";
const db = new Database();
const service = new WorkspaceService(db, engineRegistry());
const queue = new RunProcessor(service);
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
      return res
        .status(400)
        .json({
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
      nextcloudConfigured: !!process.env.NEXTCLOUD_URL,
    };
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
    res.cookie("hyper_session", session, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      maxAge: 12 * 60 * 60 * 1000,
      path: "/",
    });
    return { ok: true, evidence: "fixture" };
  }
  @Post("auth/logout") async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const t = token(req);
    if (t)
      await db.pool.query("DELETE FROM cw_sessions WHERE token_hash=$1", [
        digest(t),
      ]);
    res.clearCookie("hyper_session", { path: "/" });
    return { ok: true };
  }
  @Get("workspace") async workspace(
    @Req() req: Request,
    @Query("projectId") pid?: string,
  ) {
    return service.view(await subject(req), pid ? uuid(pid) : undefined);
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
  @Get("models") async models(@Req() req: Request) {
    return service.models(await subject(req));
  }
  @Post("models") async saveModel(@Req() req: Request, @Body() body: unknown) {
    return service.saveModel(await subject(req), ModelInput.parse(body));
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
  next();
});
await queue.start(false);
app.enableShutdownHooks();
await app.listen(Number(process.env.API_PORT ?? 3100), "127.0.0.1");
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => {
    void queue
      .stop()
      .then(() => app.close())
      .then(() => db.close())
      .then(() => process.exit(0));
  });
