import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("expire collaboration presence", { minutes: 2 }, internal.collaboration.cleanupPresence);
crons.interval("expire simulation controllers", { minutes: 1 }, internal.simulation.cleanupExpired);
crons.interval("remove old upload grants", { hours: 6 }, internal.assets.cleanupUploadGrants);
crons.daily("remove expired analytics", { hourUTC: 3, minuteUTC: 15 }, internal.analytics.cleanupOld);

export default crons;
