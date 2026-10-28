import { Database, seedDemo } from "./database.js";
const db = new Database();
try {
  if (process.argv[2] === "migrate") {
    await db.migrate();
    console.log("Migrations applied.");
  } else if (process.argv[2] === "seed") {
    if (process.env.DEMO_MODE !== "true")
      throw new Error(
        "Set DEMO_MODE=true to create explicitly labelled sample data.",
      );
    await seedDemo(db);
    console.log("Demo data seeded. No company sources connected.");
  } else throw new Error("Expected migrate or seed");
} finally {
  await db.close();
}
